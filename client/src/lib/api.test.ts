import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  captureSnapshot,
  fetchEvents,
  getCameras,
  getDetectionConfig,
  getEventCountsByDay,
  getMe,
  getStatus,
  getTimelapseManifest,
  getVapidPublicKey,
  HttpError,
  listTimelapses,
  login,
  logout,
  patchDetectionConfig,
  rebootJetson,
  refresh,
  searchEvents,
  sendTestPushReq,
  subscribePush,
  toggleDetection,
  getServerVersion,
  listBackups,
  triggerBackup,
  triggerRestore,
  triggerTimelapse,
  triggerUpdate,
  unsubscribePush,
} from './api'

type FetchMock = ReturnType<typeof vi.fn>

function asMock(): FetchMock {
  return globalThis.fetch as unknown as FetchMock
}

function mockJson(data: unknown, status = 200) {
  asMock().mockResolvedValueOnce(
    new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
}

function mockStatus(status: number) {
  asMock().mockResolvedValueOnce(new Response('', { status }))
}

describe('lib/api', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('getStatus GETs /api/status with JSON content type', async () => {
    mockJson({
      ok: true,
      uptime_s: 12,
      camera: 'ok',
      detection_active: false,
      cpu_temp_c: null,
      fps: 0,
    })
    const s = await getStatus()
    expect(s.ok).toBe(true)
    expect(asMock()).toHaveBeenCalledWith(
      '/api/status',
      expect.objectContaining({
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      }),
    )
  })

  it('fetchEvents passes the limit through to the URL', async () => {
    mockJson([])
    await fetchEvents(50)
    expect(asMock()).toHaveBeenCalledWith('/api/events?limit=50', expect.any(Object))
  })

  it('fetchEvents defaults limit to 100', async () => {
    mockJson([])
    await fetchEvents()
    expect(asMock()).toHaveBeenCalledWith('/api/events?limit=100', expect.any(Object))
  })

  it('captureSnapshot uses POST and returns the URL', async () => {
    mockJson({ url: '/snapshots/snap_1.txt' })
    const r = await captureSnapshot()
    expect(r.url).toBe('/snapshots/snap_1.txt')
    expect(asMock()).toHaveBeenCalledWith(
      '/api/capture',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('rebootJetson POSTs', async () => {
    mockJson({ ok: true })
    await rebootJetson()
    expect(asMock()).toHaveBeenCalledWith(
      '/api/system/reboot',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('triggerBackup POSTs /api/system/backup (iter-211)', async () => {
    // iter-211 (Feature #10 slice 2): mirror of rebootJetson; same
    // POST shape, optional `note` when stubbed.
    mockJson({ ok: true, note: 'scaffold: backup is stubbed' })
    const r = await triggerBackup()
    expect(r.ok).toBe(true)
    expect(r.note).toMatch(/stub/i)
    expect(asMock()).toHaveBeenCalledWith(
      '/api/system/backup',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('listBackups GETs /api/system/backups (iter-239)', async () => {
    mockJson({
      items: [
        { filename: 'snap.tar.gz', size_bytes: 100, mtime_s: 1700000000 },
      ],
    })
    const r = await listBackups()
    expect(r.items).toHaveLength(1)
    expect(r.items[0].filename).toBe('snap.tar.gz')
    expect(asMock()).toHaveBeenCalledWith(
      '/api/system/backups',
      expect.any(Object),
    )
    expect(asMock().mock.calls[0][1].method).toBeUndefined()
  })

  it('triggerRestore POSTs /api/system/restore with backup_path body (iter-237)', async () => {
    mockJson({
      ok: true,
      note: 'scaffold: restore is stubbed',
      backup_path: 'snap-2026-05-01.tar.gz',
    })
    const r = await triggerRestore('snap-2026-05-01.tar.gz')
    expect(r.ok).toBe(true)
    expect(r.backup_path).toBe('snap-2026-05-01.tar.gz')
    const call = asMock().mock.calls[0]
    expect(call[0]).toBe('/api/system/restore')
    expect(call[1].method).toBe('POST')
    expect(JSON.parse(call[1].body as string)).toEqual({
      backup_path: 'snap-2026-05-01.tar.gz',
    })
  })

  it('triggerUpdate POSTs /api/system/update (iter-231)', async () => {
    // iter-231 (Feature #12 OTA slice 2): mirror of triggerBackup.
    mockJson({ ok: true, note: 'scaffold: update is stubbed' })
    const r = await triggerUpdate()
    expect(r.ok).toBe(true)
    expect(r.note).toMatch(/stub/i)
    expect(asMock()).toHaveBeenCalledWith(
      '/api/system/update',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('changePassword POSTs /api/auth/change_password with both fields (iter-264)', async () => {
    mockJson({ ok: true })
    const { changePassword } = await import('./api')
    const r = await changePassword('old', 'newpass1')
    expect(r.ok).toBe(true)
    expect(asMock()).toHaveBeenCalledWith(
      '/api/auth/change_password',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ current_password: 'old', new_password: 'newpass1' }),
      }),
    )
  })

  it('adminResetPassword POSTs /api/auth/admin/reset_password with username + new_password (iter-264)', async () => {
    mockJson({ ok: true })
    const { adminResetPassword } = await import('./api')
    const r = await adminResetPassword('Babage', 'newpass1')
    expect(r.ok).toBe(true)
    expect(asMock()).toHaveBeenCalledWith(
      '/api/auth/admin/reset_password',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ username: 'Babage', new_password: 'newpass1' }),
      }),
    )
  })

  it('adminListUsers GETs /api/auth/admin/users and returns the rows (iter-265)', async () => {
    mockJson({
      users: [
        { username: 'Israel', role: 'owner', created_at: 1714000000 },
        { username: 'Babage', role: 'family', created_at: 1714000100 },
      ],
    })
    const { adminListUsers } = await import('./api')
    const r = await adminListUsers()
    expect(r.users.length).toBe(2)
    expect(r.users[0].username).toBe('Israel')
    expect(r.users[1].role).toBe('family')
    expect(asMock()).toHaveBeenCalledWith(
      '/api/auth/admin/users',
      expect.objectContaining({
        credentials: 'include',
      }),
    )
  })

  it('adminCreateUser POSTs /api/auth/admin/users with username + password + role (iter-265)', async () => {
    mockJson({ ok: true, username: 'kid', role: 'family' }, 201)
    const { adminCreateUser } = await import('./api')
    const r = await adminCreateUser('kid', 'kidpass1', 'family')
    expect(r.ok).toBe(true)
    expect(r.username).toBe('kid')
    expect(asMock()).toHaveBeenCalledWith(
      '/api/auth/admin/users',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          username: 'kid',
          password: 'kidpass1',
          role: 'family',
        }),
      }),
    )
  })

  it('adminCreateUser surfaces a 409 conflict as HttpError with status 409 (iter-265)', async () => {
    asMock().mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: 'username already exists' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const { adminCreateUser, HttpError } = await import('./api')
    let caught: unknown
    try {
      await adminCreateUser('exists', 'kidpass1', 'family')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(HttpError)
    expect((caught as InstanceType<typeof HttpError>).status).toBe(409)
  })

  it('adminDeleteUser POSTs /api/auth/admin/delete_user with the username (iter-265)', async () => {
    mockJson({ ok: true })
    const { adminDeleteUser } = await import('./api')
    const r = await adminDeleteUser('Babage')
    expect(r.ok).toBe(true)
    expect(asMock()).toHaveBeenCalledWith(
      '/api/auth/admin/delete_user',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ username: 'Babage' }),
      }),
    )
  })

  it('getUnreadCount GETs /api/events/unread_count (iter-248)', async () => {
    mockJson({ count: 7 })
    const { getUnreadCount } = await import('./api')
    const r = await getUnreadCount()
    expect(r.count).toBe(7)
    expect(asMock()).toHaveBeenCalledWith(
      '/api/events/unread_count',
      expect.any(Object),
    )
  })

  it('markEventSeen POSTs /api/events/<id>/seen (iter-248)', async () => {
    mockJson({ flipped: true })
    const { markEventSeen } = await import('./api')
    const r = await markEventSeen('abc123')
    expect(r.flipped).toBe(true)
    expect(asMock()).toHaveBeenCalledWith(
      '/api/events/abc123/seen',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('markAllEventsSeen POSTs /api/events/seen_all (iter-248)', async () => {
    mockJson({ flipped: 5 })
    const { markAllEventsSeen } = await import('./api')
    const r = await markAllEventsSeen()
    expect(r.flipped).toBe(5)
    expect(asMock()).toHaveBeenCalledWith(
      '/api/events/seen_all',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('getServerVersion GETs /api/system/version (iter-234)', async () => {
    mockJson({ version: '0.1.0' })
    const r = await getServerVersion()
    expect(r.version).toBe('0.1.0')
    expect(asMock()).toHaveBeenCalledWith(
      '/api/system/version',
      expect.any(Object),
    )
    // GET — no method override.
    expect(asMock().mock.calls[0][1].method).toBeUndefined()
  })

  it('triggerTimelapse POSTs /api/system/timelapse with date body (iter-214)', async () => {
    mockJson({
      ok: true,
      note: 'scaffold: timelapse is stubbed',
      date: '2026-04-30',
      url: '/timelapses/2026-04-30.mp4',
    })
    const r = await triggerTimelapse('2026-04-30')
    expect(r.ok).toBe(true)
    expect(r.url).toBe('/timelapses/2026-04-30.mp4')
    const call = asMock().mock.calls[0]
    expect(call[0]).toBe('/api/system/timelapse')
    expect(call[1].method).toBe('POST')
    expect(JSON.parse(call[1].body as string)).toEqual({ date: '2026-04-30' })
  })

  it('searchEvents GETs /api/events/search with no params when no filters (iter-220)', async () => {
    mockJson({ items: [], next_cursor: null })
    await searchEvents()
    expect(asMock()).toHaveBeenCalledWith(
      '/api/events/search',
      expect.any(Object),
    )
  })

  it('searchEvents serializes filters as query params (iter-220)', async () => {
    mockJson({ items: [], next_cursor: null })
    await searchEvents({
      camera_id: 'cam1',
      person_name: 'alice',
      label: 'person',
      since_ts: 100,
      until_ts: 200,
      before_ts: 150,
      limit: 25,
    })
    const call = asMock().mock.calls[0]
    const url = call[0] as string
    expect(url).toMatch(/^\/api\/events\/search\?/)
    // Ordering of params doesn't matter; check each one is present.
    expect(url).toContain('camera_id=cam1')
    expect(url).toContain('person_name=alice')
    expect(url).toContain('label=person')
    expect(url).toContain('since_ts=100')
    expect(url).toContain('until_ts=200')
    expect(url).toContain('before_ts=150')
    expect(url).toContain('limit=25')
  })

  it('searchEvents forwards face_unrecognized as query param (iter-228)', async () => {
    mockJson({ items: [], next_cursor: null })
    await searchEvents({ face_unrecognized: true })
    expect((asMock().mock.calls[0][0] as string)).toContain(
      'face_unrecognized=true',
    )
    asMock().mockReset()
    mockJson({ items: [], next_cursor: null })
    await searchEvents({ face_unrecognized: false })
    expect((asMock().mock.calls[0][0] as string)).toContain(
      'face_unrecognized=false',
    )
  })

  it('getEventCountsByDay forwards face_unrecognized (iter-228)', async () => {
    mockJson({ counts: {} })
    await getEventCountsByDay({ face_unrecognized: true })
    expect((asMock().mock.calls[0][0] as string)).toContain(
      'face_unrecognized=true',
    )
  })

  it('searchEvents returns items + next_cursor (iter-220)', async () => {
    mockJson({
      items: [
        {
          v: 1, type: 'detection', id: 'a',
          ts: 100, camera_id: 'cam1',
          label: 'person', score: 0.9, boxes: [],
        },
      ],
      next_cursor: 100,
    })
    const r = await searchEvents({ limit: 1 })
    expect(r.items).toHaveLength(1)
    expect(r.next_cursor).toBe(100)
  })

  // Multicam contract (docs/multicam_contract.md, 2026-07-07) —
  // wire-contract-sync mirrors of server/tests/test_cameras.py +
  // test_events.py.

  it('Given the camera registry route, When getCameras is called, Then it GETs /api/cameras and returns the {cameras: [{id,name,path}]} shape (multicam contract)', async () => {
    // arrange — the server's default single-camera registry.
    mockJson({
      cameras: [{ id: 'front_door', name: 'Front Door', path: 'cam' }],
    })

    // act
    const r = await getCameras()

    // assert — pins the exact wire fields the UI consumes.
    expect(asMock()).toHaveBeenCalledWith('/api/cameras', expect.any(Object))
    expect(asMock().mock.calls[0][1].method).toBeUndefined()
    expect(r.cameras).toHaveLength(1)
    expect(r.cameras[0]).toEqual({
      id: 'front_door',
      name: 'Front Door',
      path: 'cam',
    })
  })

  it('Given a camera filter, When searchEvents is called, Then it forwards the blessed camera= query param (multicam contract)', async () => {
    // arrange
    mockJson({ items: [], next_cursor: null })

    // act
    await searchEvents({ camera: 'back_yard' })

    // assert
    expect(asMock().mock.calls[0][0] as string).toContain('camera=back_yard')
  })

  it('Given an event row from the server, When searchEvents resolves, Then the item carries camera_id (multicam contract)', async () => {
    // arrange — camera_id is NOT optional on the wire; the server
    // defaults it to front_door and always emits it.
    mockJson({
      items: [
        {
          v: 1, type: 'detection', id: 'a',
          ts: 100, camera_id: 'front_door',
          label: 'person', score: 0.9, boxes: [],
        },
      ],
      next_cursor: null,
    })

    // act
    const r = await searchEvents({ limit: 1 })

    // assert
    expect(r.items[0].camera_id).toBe('front_door')
  })

  it('getEventCountsByDay GETs /api/events/count_by_day (iter-223)', async () => {
    mockJson({ counts: { '2026-04-30': 3, '2026-04-29': 1 } })
    const r = await getEventCountsByDay()
    expect(r.counts['2026-04-30']).toBe(3)
    expect(asMock()).toHaveBeenCalledWith(
      '/api/events/count_by_day',
      expect.any(Object),
    )
  })

  it('getEventCountsByDay forwards filters as query params (iter-223)', async () => {
    mockJson({ counts: {} })
    await getEventCountsByDay({
      camera_id: 'cam1',
      person_name: 'alice',
      label: 'person',
      since_ts: 100,
      until_ts: 200,
    })
    const call = asMock().mock.calls[0]
    const url = call[0] as string
    expect(url).toMatch(/^\/api\/events\/count_by_day\?/)
    expect(url).toContain('camera_id=cam1')
    expect(url).toContain('person_name=alice')
    expect(url).toContain('label=person')
    expect(url).toContain('since_ts=100')
    expect(url).toContain('until_ts=200')
  })

  it('listTimelapses GETs /api/system/timelapses (iter-214)', async () => {
    mockJson({
      items: [
        { date: '2026-04-30', url: '/timelapses/2026-04-30.mp4', size_bytes: 1234 },
      ],
    })
    const r = await listTimelapses()
    expect(r.items).toHaveLength(1)
    expect(r.items[0].date).toBe('2026-04-30')
    expect(asMock()).toHaveBeenCalledWith(
      '/api/system/timelapses',
      expect.any(Object),
    )
    // GET — no method override.
    expect(asMock().mock.calls[0][1].method).toBeUndefined()
  })

  it('listTimelapses surfaces a per-item manifest_url for the overlay sidecar', async () => {
    // arrange — the de-overlap builder advertises the sidecar URL per row.
    mockJson({
      items: [
        {
          date: '2026-06-18',
          url: '/api/timelapses/2026-06-18.mp4',
          size_bytes: 10,
          manifest_url: '/api/timelapses/2026-06-18.json',
        },
      ],
    })
    // act
    const r = await listTimelapses()
    // assert
    expect(r.items[0].manifest_url).toBe('/api/timelapses/2026-06-18.json')
  })

  it('getTimelapseManifest GETs the sidecar url and returns the segment map', async () => {
    // arrange
    mockJson({
      v: 1,
      date: '2026-06-18',
      segments: [{ offset_s: 0, capture_ts: 1718000000 }],
    })
    // act
    const m = await getTimelapseManifest('/api/timelapses/2026-06-18.json')
    // assert — wire shape the overlay depends on.
    expect(m.v).toBe(1)
    expect(m.segments[0]).toEqual({ offset_s: 0, capture_ts: 1718000000 })
    expect(asMock()).toHaveBeenCalledWith(
      '/api/timelapses/2026-06-18.json',
      expect.any(Object),
    )
    expect(asMock().mock.calls[0][1].method).toBeUndefined()
  })

  it('toggleDetection returns the new active state', async () => {
    mockJson({ active: true })
    const r = await toggleDetection()
    expect(r.active).toBe(true)
    expect(asMock()).toHaveBeenCalledWith(
      '/api/detection/toggle',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('subscribePush serializes the PushSubscription and POSTs', async () => {
    mockJson({ ok: true })
    const sub = {
      toJSON: () => ({
        endpoint: 'https://push.example/x',
        keys: { p256dh: 'a', auth: 'b' },
      }),
    } as unknown as PushSubscription
    await subscribePush(sub)
    const call = asMock().mock.calls[0]
    expect(call[0]).toBe('/api/push/subscribe')
    expect(call[1].method).toBe('POST')
    expect(JSON.parse(call[1].body as string)).toEqual({
      endpoint: 'https://push.example/x',
      keys: { p256dh: 'a', auth: 'b' },
    })
  })

  it('sendTestPushReq POSTs /api/push/test and returns sent count', async () => {
    mockJson({ ok: true, sent: 2 })
    const r = await sendTestPushReq()
    expect(asMock()).toHaveBeenCalledWith(
      '/api/push/test',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(r).toEqual({ ok: true, sent: 2 })
  })

  it('unsubscribePush POSTs the endpoint to /api/push/unsubscribe', async () => {
    mockJson({ ok: true })
    await unsubscribePush('https://push.example/x')
    const call = asMock().mock.calls[0]
    expect(call[0]).toBe('/api/push/unsubscribe')
    expect(call[1].method).toBe('POST')
    expect(JSON.parse(call[1].body as string)).toEqual({
      endpoint: 'https://push.example/x',
    })
  })

  it('getVapidPublicKey returns the key field', async () => {
    mockJson({ key: 'BPubKeyBase64' })
    const r = await getVapidPublicKey()
    expect(r.key).toBe('BPubKeyBase64')
  })

  // iter-164: pin getDetectionConfig / patchDetectionConfig wire shape.
  // Pre-iter-164 these two were the only `lib/api.ts` exports without
  // direct tests — exercised only transitively through Settings.test.tsx
  // which mocks `'../lib/api'` out wholesale, so a route rename, PATCH→PUT
  // swap, or body-shape regression would have failed no client test.
  // Charter Risk #1 (wire-boundary drift) — closes the most-exposed gap.

  it('getDetectionConfig GETs /api/detection/config and returns the parsed body', async () => {
    const cfg = {
      threshold: 0.55,
      cooldown_s: 5,
      enabled: true,
      schedule_off_start: null,
      schedule_off_end: null,
      classes: ['person', 'car'],
    }
    mockJson(cfg)
    const r = await getDetectionConfig()
    expect(r).toEqual(cfg)
    expect(asMock()).toHaveBeenCalledWith(
      '/api/detection/config',
      expect.objectContaining({
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      }),
    )
    // GET — no method override means default GET. Confirm by absence.
    expect(asMock().mock.calls[0][1].method).toBeUndefined()
  })

  it('patchDetectionConfig PATCHes /api/detection/config with serialized body', async () => {
    mockJson({
      threshold: 0.7,
      cooldown_s: 10,
      enabled: true,
      schedule_off_start: null,
      schedule_off_end: null,
      classes: ['person'],
    })
    await patchDetectionConfig({ threshold: 0.7, cooldown_s: 10 })
    const call = asMock().mock.calls[0]
    expect(call[0]).toBe('/api/detection/config')
    expect(call[1].method).toBe('PATCH')
    expect(JSON.parse(call[1].body as string)).toEqual({
      threshold: 0.7,
      cooldown_s: 10,
    })
  })

  it('patchDetectionConfig returns the updated config from the server', async () => {
    const updated = {
      threshold: 0.4,
      cooldown_s: 0,
      enabled: false,
      schedule_off_start: '22:00',
      schedule_off_end: '07:00',
      classes: ['person', 'cat', 'dog'],
    }
    mockJson(updated)
    const r = await patchDetectionConfig({
      enabled: false,
      schedule_off_start: '22:00',
      schedule_off_end: '07:00',
    })
    expect(r).toEqual(updated)
  })

  it('patchDetectionConfig accepts an empty Partial without crashing', async () => {
    // No-op patch (e.g. user clicked Save without changing anything).
    // Server will return the current config unchanged. Pin that this
    // doesn't error in the wrapper.
    mockJson({
      threshold: 0.55,
      cooldown_s: 5,
      enabled: true,
      schedule_off_start: null,
      schedule_off_end: null,
      classes: ['person'],
    })
    await patchDetectionConfig({})
    const call = asMock().mock.calls[0]
    expect(call[1].method).toBe('PATCH')
    expect(JSON.parse(call[1].body as string)).toEqual({})
  })

  it('throws when the response is not ok, including the path and status', async () => {
    mockStatus(500)
    await expect(getStatus()).rejects.toThrow(/\/api\/status 500/)
  })

  it('throws a typed HttpError with the status code', async () => {
    mockStatus(503)
    try {
      await getStatus()
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError)
      expect((e as HttpError).status).toBe(503)
      expect((e as HttpError).path).toBe('/api/status')
      // Message format unchanged from pre-iter-122 — existing
      // String(err)-checking callers still work.
      expect((e as HttpError).message).toMatch(/\/api\/status 503/)
    }
  })

  it('includes the response body detail in the error when present', async () => {
    asMock().mockResolvedValueOnce(
      new Response('VAPID keys not generated', { status: 500 }),
    )
    await expect(getStatus()).rejects.toThrow(/VAPID keys not generated/)
  })

  it('truncates very long error bodies', async () => {
    const longBody = 'x'.repeat(500)
    asMock().mockResolvedValueOnce(new Response(longBody, { status: 500 }))
    try {
      await getStatus()
      throw new Error('expected throw')
    } catch (e) {
      const msg = String(e)
      // 200 char cap on body excerpt + path prefix
      expect(msg.length).toBeLessThan(300)
    }
  })

  // iter-181 (Auth Plan Phase 3): pin the 4 auth wrappers + the silent
  // refresh-and-retry layer. Routes are LIVE on the server but the rest
  // of /api/* is NOT yet gated (Phase 5 / iter-183 does that). The
  // wrapper shape here is the contract; the server side is pinned in
  // server/tests/test_auth_routes.py.

  it('login POSTs LoginRequest body to /api/auth/login and returns user', async () => {
    mockJson({ user: { username: 'alice', role: 'admin' } })
    const r = await login({ username: 'alice', password: 'hunter2' })
    expect(r.user).toEqual({ username: 'alice', role: 'admin' })
    const call = asMock().mock.calls[0]
    expect(call[0]).toBe('/api/auth/login')
    expect(call[1].method).toBe('POST')
    expect(JSON.parse(call[1].body as string)).toEqual({
      username: 'alice',
      password: 'hunter2',
    })
  })

  it('login forwards credentials: include so HttpOnly cookies flow', async () => {
    mockJson({ user: { username: 'a', role: 'admin' } })
    await login({ username: 'a', password: 'p' })
    expect(asMock().mock.calls[0][1].credentials).toBe('include')
  })

  it('logout POSTs /api/auth/logout and returns ok', async () => {
    mockJson({ ok: true })
    const r = await logout()
    expect(r.ok).toBe(true)
    expect(asMock()).toHaveBeenCalledWith(
      '/api/auth/logout',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('refresh POSTs /api/auth/refresh and returns the user', async () => {
    mockJson({ user: { username: 'alice', role: 'admin' } })
    const r = await refresh()
    expect(r.user.username).toBe('alice')
    expect(asMock()).toHaveBeenCalledWith(
      '/api/auth/refresh',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('getMe GETs /api/auth/me and returns the user', async () => {
    mockJson({ user: { username: 'alice', role: 'admin' } })
    const r = await getMe()
    expect(r.user.username).toBe('alice')
    expect(asMock()).toHaveBeenCalledWith(
      '/api/auth/me',
      expect.any(Object),
    )
    // GET — no method override.
    expect(asMock().mock.calls[0][1].method).toBeUndefined()
  })

  it('a 401 on a non-auth route triggers /api/auth/refresh and retries', async () => {
    asMock()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ user: { username: 'a', role: 'admin' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, fps: 5 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    const result = await getStatus()
    expect((result as { ok: boolean }).ok).toBe(true)
    expect(asMock().mock.calls[0][0]).toBe('/api/status')
    expect(asMock().mock.calls[1][0]).toBe('/api/auth/refresh')
    expect(asMock().mock.calls[2][0]).toBe('/api/status')
  })

  it('a 401 on /api/auth/me does NOT attempt refresh (would loop)', async () => {
    asMock().mockResolvedValueOnce(new Response('', { status: 401 }))
    await expect(getMe()).rejects.toThrow()
    // Exactly one fetch — no silent refresh.
    expect(asMock()).toHaveBeenCalledTimes(1)
  })

  it('a 401 with a failing refresh surfaces the original 401', async () => {
    asMock()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response('', { status: 401 }))
    await expect(getStatus()).rejects.toThrow(HttpError)
    expect(asMock()).toHaveBeenCalledTimes(2)
  })

  it('a refresh-401 dispatches homecam:session-expired (iter-186)', async () => {
    // Sequence: GET /api/status → 401, POST /api/auth/refresh → 401
    asMock()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response('', { status: 401 }))
    const seen: string[] = []
    const handler = () => seen.push('session-expired')
    window.addEventListener('homecam:session-expired', handler)
    try {
      await expect(getStatus()).rejects.toThrow(HttpError)
      expect(seen).toEqual(['session-expired'])
    } finally {
      window.removeEventListener('homecam:session-expired', handler)
    }
  })

  // iter-208 (Feature #4 slice 3b): per-user push filter management.

  it('getMyPushFilters GETs /api/push/filters', async () => {
    mockJson({ filters: null })
    const r = await (await import('./api')).getMyPushFilters()
    expect(r).toEqual({ filters: null })
    expect(asMock()).toHaveBeenCalledWith(
      '/api/push/filters',
      expect.any(Object),
    )
  })

  it('setMyPushFilters PUTs the filters body', async () => {
    // iter-209: PushFilters now requires `schedule_window` (null
    // when no time gating). Pin the wire shape end-to-end.
    mockJson({
      filters: {
        cameras: ['cam1'],
        person_names: ['israel'],
        schedule_window: null,
      },
    })
    const { setMyPushFilters } = await import('./api')
    const r = await setMyPushFilters({
      cameras: ['cam1'],
      person_names: ['israel'],
      schedule_window: null,
    })
    expect(r.filters).toEqual({
      cameras: ['cam1'],
      person_names: ['israel'],
      schedule_window: null,
    })
    const call = asMock().mock.calls[0]
    expect(call[0]).toBe('/api/push/filters')
    expect(call[1].method).toBe('PUT')
    expect(JSON.parse(call[1].body as string)).toEqual({
      filters: {
        cameras: ['cam1'],
        person_names: ['israel'],
        schedule_window: null,
      },
    })
  })

  it('setMyPushFilters serializes schedule_window when set (iter-209)', async () => {
    mockJson({
      filters: {
        cameras: null,
        person_names: null,
        schedule_window: { start: '22:00', end: '07:00' },
      },
    })
    const { setMyPushFilters } = await import('./api')
    await setMyPushFilters({
      cameras: null,
      person_names: null,
      schedule_window: { start: '22:00', end: '07:00' },
    })
    const call = asMock().mock.calls[0]
    expect(JSON.parse(call[1].body as string)).toEqual({
      filters: {
        cameras: null,
        person_names: null,
        schedule_window: { start: '22:00', end: '07:00' },
      },
    })
  })

  it('setMyPushFilters with null resets to match-all', async () => {
    mockJson({ filters: null })
    const { setMyPushFilters } = await import('./api')
    await setMyPushFilters(null)
    const call = asMock().mock.calls[0]
    expect(JSON.parse(call[1].body as string)).toEqual({ filters: null })
  })

  // iter-319 (test-coverage-auditor D-1, D-2, D-3): wire-contract
  // tests for the iter-303 / iter-307 / iter-309 client wrappers.
  // Server-side tests already exist; these pin the client URL +
  // method shape so a future server-route rename can't drift.

  it('given an event id, when deleteEvent called, then DELETEs /api/events/<id> (iter-307)', async () => {
    // arrange
    mockJson({ deleted: true })
    const { deleteEvent } = await import('./api')

    // act
    await deleteEvent('evt-abc-123')

    // assert
    const call = asMock().mock.calls[0]
    expect(call[0]).toBe('/api/events/evt-abc-123')
    expect((call[1] as RequestInit).method).toBe('DELETE')
  })

  it('given a day, when deleteEventsByDay called, then DELETEs /api/events?day=YYYY-MM-DD (iter-307)', async () => {
    // arrange
    mockJson({ deleted: 5 })
    const { deleteEventsByDay } = await import('./api')

    // act
    await deleteEventsByDay('2026-04-30')

    // assert
    const call = asMock().mock.calls[0]
    expect(call[0]).toBe('/api/events?day=2026-04-30')
    expect((call[1] as RequestInit).method).toBe('DELETE')
  })

  it('when getKnownFilterOptions called, then GETs /api/push/known_filter_options + parses cameras + person_names (iter-303)', async () => {
    // arrange
    mockJson({ cameras: ['cam1'], person_names: ['alice', 'bob'] })
    const { getKnownFilterOptions } = await import('./api')

    // act
    const r = await getKnownFilterOptions()

    // assert
    const call = asMock().mock.calls[0]
    expect(call[0]).toBe('/api/push/known_filter_options')
    expect(r).toEqual({ cameras: ['cam1'], person_names: ['alice', 'bob'] })
  })

  it('given a date, when deleteTimelapse called, then DELETEs /api/system/timelapse?date=YYYY-MM-DD (iter-309)', async () => {
    // arrange
    mockJson({ deleted: true, date: '2026-04-30' })
    const { deleteTimelapse } = await import('./api')

    // act
    await deleteTimelapse('2026-04-30')

    // assert
    const call = asMock().mock.calls[0]
    expect(call[0]).toBe('/api/system/timelapse?date=2026-04-30')
    expect((call[1] as RequestInit).method).toBe('DELETE')
  })

  it('given listPeople called with no opts, when fetch resolves, then GET /api/people returns the items + total wire shape (iter-338: closes test-coverage D1)', async () => {
    // arrange (iter-326 wire contract: response shape is
    // {items: PersonSummary[], total: number}). Pre-iter-338 the
    // wrapper had ZERO coverage in api.test.ts even though the
    // server route had thorough tests. Both test-coverage and
    // test-integrity auditors flagged the gap iter-333.
    mockJson({
      items: [
        {
          name: 'Alice',
          count: 3,
          last_seen_ts: 1700000000,
          first_seen_ts: 1699000000,
          last_clip_url: '/api/events/abc/clip',
          last_thumb_url: '/snapshots/thumb_x.jpg',
        },
      ],
      total: 1,
    })
    const { listPeople } = await import('./api')

    // act
    const r = await listPeople()

    // assert
    const call = asMock().mock.calls[0]
    expect(call[0]).toBe('/api/people')
    expect(r.total).toBe(1)
    expect(r.items[0].name).toBe('Alice')
    expect(r.items[0].count).toBe(3)
  })

  it('given listPeople called with limit option, when fetched, then ?limit=N is appended to the URL (iter-328 + iter-338)', async () => {
    // arrange
    mockJson({ items: [], total: 0 })
    const { listPeople } = await import('./api')

    // act
    await listPeople({ limit: 5 })

    // assert
    expect(asMock().mock.calls[0][0]).toBe('/api/people?limit=5')
  })

  it('given listPeople called twice, when the server returns 200 then 304, then the second call returns the CACHED body without re-parsing (iter-340: client If-None-Match echo)', async () => {
    // arrange — first response: 200 + ETag + body. Second: 304
    // (no body). The client's per-URL ETag cache returns the
    // cached body on 304 so the caller never sees the absence.
    const body1 = { items: [{ name: 'Alice', count: 1, last_seen_ts: 1700000000, first_seen_ts: 1700000000, last_clip_url: null, last_thumb_url: null }], total: 1 }
    asMock()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(body1), {
          status: 200,
          headers: { 'content-type': 'application/json', ETag: '"abc123"' },
        }),
      )
      .mockResolvedValueOnce(
        // Response constructor refuses status 304 with a non-null
        // body; use null. Real fetch() returns 304 with no body.
        new Response(null, { status: 304, headers: { ETag: '"abc123"' } }),
      )
    const { listPeople } = await import('./api')

    // act — first call populates cache; second call should hit 304.
    const r1 = await listPeople()
    const r2 = await listPeople()

    // assert — second call returned the SAME body the first did.
    expect(r1).toEqual(body1)
    expect(r2).toEqual(body1)
    // Second fetch carried If-None-Match header.
    const secondCall = asMock().mock.calls[1]
    const headers = (secondCall[1] as RequestInit).headers as
      | Record<string, string>
      | undefined
    expect(headers?.['If-None-Match']).toBe('"abc123"')
  })

  it('given listPeople and a 401 response, when fetched, then HttpError with status 401 is thrown (iter-338)', async () => {
    // arrange
    asMock().mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response('', { status: 401 }))
    const { listPeople, HttpError } = await import('./api')

    // act / assert
    try {
      await listPeople()
      throw new Error('expected listPeople to reject')
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError)
      expect((e as HttpError).status).toBe(401)
    }
  })

  it('given exportEvents called with one id, when fetch resolves, then POST /api/events/export carries event_ids JSON body (iter-330)', async () => {
    // arrange
    const fakeBlob = new Blob(['fake-zip'], { type: 'application/zip' })
    asMock().mockResolvedValueOnce(
      new Response(fakeBlob, {
        status: 200,
        headers: { 'content-type': 'application/zip' },
      }),
    )
    const { exportEvents } = await import('./api')

    // act
    const blob = await exportEvents(['evt-export-1'])

    // assert
    const call = asMock().mock.calls[0]
    expect(call[0]).toBe('/api/events/export')
    const init = call[1] as RequestInit
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({
      event_ids: ['evt-export-1'],
    })
    expect(blob.type).toBe('application/zip')
  })

  it('given exportEvents and a 422 response, when fetch resolves, then HttpError is thrown with the status (iter-330)', async () => {
    // arrange — server-side cap of 50 enforced via Pydantic.
    asMock().mockResolvedValueOnce(
      new Response('Field error', { status: 422 }),
    )
    const { exportEvents } = await import('./api')

    // act / assert
    try {
      await exportEvents(['e1'])
      throw new Error('expected exportEvents to reject')
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError)
      expect((e as HttpError).status).toBe(422)
    }
  })

  it('a refresh-network-error does NOT dispatch session-expired (iter-186)', async () => {
    // Don't fire the signal on transient network failures — only on
    // explicit 401 from /api/auth/refresh.
    asMock()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockRejectedValueOnce(new Error('network down'))
    const seen: string[] = []
    const handler = () => seen.push('session-expired')
    window.addEventListener('homecam:session-expired', handler)
    try {
      await expect(getStatus()).rejects.toThrow()
      expect(seen).toEqual([])
    } finally {
      window.removeEventListener('homecam:session-expired', handler)
    }
  })

  // iter-352 (face-capture-for-retraining, Phase 2): wrapper coverage
  // for the two new face-capture browse endpoints. Pin the URL shape +
  // the response wire contract so a future server-side rename surfaces
  // here instead of in the /training page.

  it('given listFaceCaptureDirs called, when fetch resolves, then GET /api/face/captures returns the dirs wire shape (iter-352)', async () => {
    // arrange
    mockJson({
      dirs: [
        { name: 'alice', count: 12, latest_ts: 1700000000 },
        { name: '__unknown__', count: 3, latest_ts: 1700000060 },
      ],
    })
    const { listFaceCaptureDirs } = await import('./api')

    // act
    const r = await listFaceCaptureDirs()

    // assert
    expect(asMock().mock.calls[0][0]).toBe('/api/face/captures')
    expect(r.dirs).toHaveLength(2)
    expect(r.dirs[0].name).toBe('alice')
    expect(r.dirs[0].count).toBe(12)
    expect(r.dirs[1].name).toBe('__unknown__')
  })

  it('given listFaceCapturesInDir called, when fetch resolves, then GET /api/face/captures/{encoded name} returns the files wire shape (iter-352)', async () => {
    // arrange
    mockJson({
      name: 'alice',
      files: [
        {
          filename: '1700000060000_evt-002.jpg',
          ts_ms: 1700000060000,
          event_id: 'evt-002',
          url: '/api/face/captures/alice/1700000060000_evt-002.jpg',
        },
      ],
    })
    const { listFaceCapturesInDir } = await import('./api')

    // act
    const r = await listFaceCapturesInDir('alice')

    // assert
    expect(asMock().mock.calls[0][0]).toBe('/api/face/captures/alice')
    expect(r.name).toBe('alice')
    expect(r.files).toHaveLength(1)
    expect(r.files[0].event_id).toBe('evt-002')
    expect(r.files[0].ts_ms).toBe(1700000060000)
  })

  it('given listFaceCapturesInDir called with a name that needs URL encoding, when fetched, then encodeURIComponent runs (iter-352)', async () => {
    // arrange — the server regex allows [A-Za-z0-9_-] only, so a
    // legitimate name never needs encoding. But defensive encoding
    // protects against a future loosening + means a malicious
    // injection (e.g. ?name=foo%2Fbar) cannot break the route.
    mockJson({ name: '__unknown__', files: [] })
    const { listFaceCapturesInDir } = await import('./api')

    // act
    await listFaceCapturesInDir('__unknown__')

    // assert — URL-safe; underscore is unreserved.
    expect(asMock().mock.calls[0][0]).toBe('/api/face/captures/__unknown__')
  })

  it('given moveFaceCapture called, when fetch resolves, then POST /api/face/captures/{name}/{file}/move carries target_name body (iter-353)', async () => {
    // arrange
    mockJson({ ok: true, moved_to: 'bob/1700_evt-x.jpg' })
    const { moveFaceCapture } = await import('./api')

    // act
    const r = await moveFaceCapture('alice', '1700_evt-x.jpg', 'bob')

    // assert
    const call = asMock().mock.calls[0]
    expect(call[0]).toBe('/api/face/captures/alice/1700_evt-x.jpg/move')
    const init = call[1] as RequestInit
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ target_name: 'bob' })
    expect(r.moved_to).toBe('bob/1700_evt-x.jpg')
  })

  it('given deleteFaceCapture called, when fetch resolves, then DELETE /api/face/captures/{name}/{file} returns ok (iter-353)', async () => {
    // arrange
    mockJson({ ok: true })
    const { deleteFaceCapture } = await import('./api')

    // act
    const r = await deleteFaceCapture('alice', '1700_evt-x.jpg')

    // assert
    const call = asMock().mock.calls[0]
    expect(call[0]).toBe('/api/face/captures/alice/1700_evt-x.jpg')
    expect((call[1] as RequestInit).method).toBe('DELETE')
    expect(r.ok).toBe(true)
  })

  it('given getReviewQueue called without limit, when fetch resolves, then GET /api/face/review_queue with the iter-355c1 wire shape (iter-356.12)', async () => {
    // arrange
    mockJson({
      items: [
        {
          filename: '1700_evt-x.jpg',
          ts_ms: 1700000000000,
          event_id: 'evt-x',
          predicted_name: 'alice',
          confidence: 0.55,
          current_dir: '__unknown__',
          url: '/api/face/captures/__unknown__/1700_evt-x.jpg',
        },
      ],
      total_uncertain: 1,
      limit: 25,
    })
    const { getReviewQueue } = await import('./api')

    // act
    const r = await getReviewQueue()

    // assert
    const call = asMock().mock.calls[0]
    expect(call[0]).toBe('/api/face/review_queue')
    expect(r.items).toHaveLength(1)
    expect(r.items[0].confidence).toBe(0.55)
    expect(r.items[0].current_dir).toBe('__unknown__')
    expect(r.total_uncertain).toBe(1)
  })

  it('given getReviewQueue called with limit=10, when fetch resolves, then URL carries the ?limit query (iter-356.12)', async () => {
    // arrange
    mockJson({ items: [], total_uncertain: 0, limit: 10 })
    const { getReviewQueue } = await import('./api')

    // act
    await getReviewQueue(10)

    // assert
    expect(asMock().mock.calls[0][0]).toBe('/api/face/review_queue?limit=10')
  })

  it('given listFaceCaptureDirs and a 401 response, when fetched, then HttpError 401 is thrown (iter-352: owner-gated)', async () => {
    // arrange — non-owner user. Two 401s because req() retries once
    // via _attemptRefresh.
    asMock()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response('', { status: 401 }))
    const { listFaceCaptureDirs, HttpError } = await import('./api')

    // act / assert
    try {
      await listFaceCaptureDirs()
      throw new Error('expected listFaceCaptureDirs to reject')
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError)
      expect((e as HttpError).status).toBe(401)
    }
  })

  // iter-356.6X (tiered-inference slice 4): wire tests for the new
  // training-export + per-name purge + consent endpoints. Server
  // routes live in `routes/training.py` + `routes/training_admin.py`.

  it('test_when_get_training_export_called_then_GETs_the_endpoint_with_query_params', async () => {
    // arrange — server streams application/zip; mock with a Blob body.
    const blob = new Blob([new Uint8Array([0x50, 0x4b])], {
      type: 'application/zip',
    })
    asMock().mockResolvedValueOnce(
      new Response(blob, {
        status: 200,
        headers: { 'Content-Type': 'application/zip' },
      }),
    )
    const { getTrainingExport } = await import('./api')

    // act
    const out = await getTrainingExport('face', 224)

    // assert
    const call = asMock().mock.calls[0]
    expect(call[0]).toBe('/api/training/export?kind=face&size=224')
    expect((call[1] as RequestInit).credentials).toBe('include')
    // Node 18 / jsdom mismatch: the Blob the wrapper returns may
    // come from undici's Response, which isn't strictly the same
    // constructor as the global Blob. Pin the duck-typed shape
    // (size + type) instead of identity.
    expect(typeof (out as { size?: number }).size).toBe('number')
    expect((out as { type?: string }).type).toBe('application/zip')
  })

  it('test_given_404_when_get_training_export_then_throws_HttpError', async () => {
    // arrange — server returns 422 on an invalid kind/size; pin the
    // typed throw with a 4xx status so callers can branch on err.status.
    asMock().mockResolvedValueOnce(new Response('not found', { status: 404 }))
    const { getTrainingExport, HttpError } = await import('./api')

    // act / assert
    try {
      await getTrainingExport('person', 640)
      throw new Error('expected getTrainingExport to reject')
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError)
      expect((e as HttpError).status).toBe(404)
    }
  })

  it('test_when_delete_training_captures_called_then_sends_DELETE_with_name_query', async () => {
    // arrange
    mockJson({ ok: true, deleted: 12 })
    const { deleteTrainingCaptures } = await import('./api')

    // act
    const r = await deleteTrainingCaptures('alice')

    // assert
    const call = asMock().mock.calls[0]
    expect(call[0]).toBe('/api/training/captures?name=alice')
    expect((call[1] as RequestInit).method).toBe('DELETE')
    expect(r).toEqual({ ok: true, deleted: 12 })
  })

  it('test_when_set_name_consent_called_then_POSTs_consent_body', async () => {
    // arrange
    const record = {
      granted: true,
      recorded_at_ms: 1700000000000,
      consent_text_version: 'v1',
      recorded_by: 'owner',
    }
    mockJson(record)
    const { setNameConsent } = await import('./api')

    // act
    const r = await setNameConsent('alice', true, 'v1')

    // assert
    const call = asMock().mock.calls[0]
    expect(call[0]).toBe('/api/face/captures/alice/consent')
    const init = call[1] as RequestInit
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({
      granted: true,
      consent_text_version: 'v1',
    })
    expect(r).toEqual(record)
  })

  it('test_when_get_name_consent_called_then_returns_default_record_on_404', async () => {
    // arrange — server returns 200 with the default-deny shape on
    // miss (NOT 404). Pinned by training_admin.py::get_consent so the
    // client doesn't branch on status. This test asserts the
    // contract: client passes through whatever the server returned.
    const defaultDeny = {
      granted: false,
      recorded_at_ms: null,
      consent_text_version: null,
      recorded_by: null,
    }
    mockJson(defaultDeny)
    const { getNameConsent } = await import('./api')

    // act
    const r = await getNameConsent('alice')

    // assert
    const call = asMock().mock.calls[0]
    expect(call[0]).toBe('/api/face/captures/alice/consent')
    expect(r).toEqual(defaultDeny)
  })

  it('test_get_detection_config_includes_face_capture_fields', async () => {
    // arrange — extended DetectionConfig with the slice-4 fields.
    // The client type now requires both fields; pin the wire shape
    // so a server route rename doesn't silently de-sync.
    const cfg = {
      threshold: 0.55,
      cooldown_s: 5,
      enabled: true,
      schedule_off_start: null,
      schedule_off_end: null,
      classes: ['person'],
      zones: [],
      clip_post_roll_s: 5,
      clip_pre_roll_s: 5,
      clip_retention_preset: 'month',
      camera_label: 'Front Door',
      audio_enabled: false,
      face_capture_enabled: true,
      face_capture_retention_days: 30,
      // S5: continuous-capture (visit) knobs — defaults OFF.
      continuous_capture: false,
      max_visit_s: 150,
      absence_finalize_s: 10,
    }
    mockJson(cfg)
    const { getDetectionConfig } = await import('./api')

    // act
    const r = await getDetectionConfig()

    // assert
    expect(r.face_capture_enabled).toBe(true)
    expect(r.face_capture_retention_days).toBe(30)
  })

  it('test_get_detection_config_includes_continuous_capture_fields', async () => {
    // arrange — DetectionConfig with the S5 visit knobs. Pin the wire
    // shape so a server route rename doesn't silently de-sync.
    const cfg = {
      threshold: 0.55,
      cooldown_s: 5,
      enabled: true,
      schedule_off_start: null,
      schedule_off_end: null,
      classes: ['person'],
      zones: [],
      clip_post_roll_s: 5,
      clip_pre_roll_s: 5,
      clip_retention_preset: 'month',
      camera_label: 'Front Door',
      audio_enabled: false,
      face_capture_enabled: true,
      face_capture_retention_days: 30,
      continuous_capture: false,
      max_visit_s: 150,
      absence_finalize_s: 10,
    }
    mockJson(cfg)
    const { getDetectionConfig } = await import('./api')

    // act
    const r = await getDetectionConfig()

    // assert — the worker reads these names verbatim off the poll.
    expect(r.continuous_capture).toBe(false)
    expect(r.max_visit_s).toBe(150)
    expect(r.absence_finalize_s).toBe(10)
  })

  it('test_detection_limits_expose_visit_bounds', async () => {
    // arrange / act — DETECTION_LIMITS mirrors the server MIN/MAX
    // consts; the S6 slider binds its min/max props to these.
    const { DETECTION_LIMITS } = await import('./types')

    // assert
    expect(DETECTION_LIMITS.maxVisitMin).toBe(30)
    expect(DETECTION_LIMITS.maxVisitMax).toBe(600)
    expect(DETECTION_LIMITS.absenceFinalizeMin).toBe(3)
    expect(DETECTION_LIMITS.absenceFinalizeMax).toBe(60)
  })
})

describe('lib/api central failure logging', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('Given a non-2xx response, When a req() call fails, Then log.error fires once with {method, path, status}', async () => {
    // arrange — spy on the log module so we assert the central chokepoint,
    // not each of the 8 (4 swallow) callers.
    const { log } = await import('./log')
    const errSpy = vi.spyOn(log, 'error').mockImplementation(() => {})
    asMock().mockResolvedValueOnce(new Response('nope', { status: 500 }))
    const { getStatus } = await import('./api')

    // act
    await expect(getStatus()).rejects.toThrow()

    // assert — exactly one central error line carrying the express reason.
    const reqFailed = errSpy.mock.calls.filter((c) => c[0] === 'api:request-failed')
    expect(reqFailed).toHaveLength(1)
    expect(reqFailed[0][1]).toMatchObject({
      method: 'GET',
      path: '/api/status',
      status: 500,
    })
  })

  it('Given fetch rejects at the network layer, When a req() call runs, Then log.error fires with the network fields (status absent, online present)', async () => {
    // arrange — a network reject has no `.status`, so it falls through every
    // caller's status branch; the chokepoint is the only place it surfaces.
    const { log } = await import('./log')
    const errSpy = vi.spyOn(log, 'error').mockImplementation(() => {})
    asMock().mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const { getStatus } = await import('./api')

    // act
    await expect(getStatus()).rejects.toThrow(/Failed to fetch/)

    // assert
    const netFail = errSpy.mock.calls.filter((c) => c[0] === 'api:network-fail')
    expect(netFail).toHaveLength(1)
    expect(netFail[0][1]).toMatchObject({ method: 'GET', path: '/api/status' })
    expect('online' in (netFail[0][1] as object)).toBe(true)
    // a network reject has no HTTP status to report
    expect((netFail[0][1] as { status?: unknown }).status).toBeUndefined()
  })

  it('Given the bootstrapFace upload hits the 1MB body cap, When it 413s, Then log.error carries the path + status', async () => {
    // arrange — the multipart path bypasses req()'s central refresh/log,
    // so it logs independently. 413 = the server body-cap rejection.
    const { log } = await import('./log')
    const errSpy = vi.spyOn(log, 'error').mockImplementation(() => {})
    asMock().mockResolvedValueOnce(new Response('too large', { status: 413 }))
    const { bootstrapFace } = await import('./api')
    const file = new File([new Uint8Array(4)], 'face.jpg', { type: 'image/jpeg' })

    // act
    await expect(bootstrapFace('alice', file)).rejects.toThrow()

    // assert
    const reqFailed = errSpy.mock.calls.filter((c) => c[0] === 'api:request-failed')
    expect(reqFailed).toHaveLength(1)
    expect(reqFailed[0][1]).toMatchObject({
      path: '/api/face/bootstrap',
      status: 413,
    })
  })
})
