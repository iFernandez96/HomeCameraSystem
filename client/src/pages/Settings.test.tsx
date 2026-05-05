import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const ensurePushSubscription = vi.fn()
const disablePushSubscription = vi.fn()
const getPushState = vi.fn()
const pushSupported = vi.fn()
const sendTestPush = vi.fn()
const getStatus = vi.fn()
const rebootJetson = vi.fn()
const getDetectionConfig = vi.fn()
const patchDetectionConfig = vi.fn()
const getMyPushFilters = vi.fn()
const setMyPushFilters = vi.fn()
const getKnownFilterOptions = vi.fn()
const triggerBackup = vi.fn()
const triggerRestore = vi.fn()
const triggerTimelapse = vi.fn()
const deleteTimelapse = vi.fn().mockResolvedValue({ deleted: true, date: '' })
const triggerUpdate = vi.fn()
const getServerVersion = vi.fn()
const listBackups = vi.fn()
const listTimelapses = vi.fn()
// iter-264 / iter-265: account-management routes called from Settings.
// changePassword / adminResetPassword are lazy (only fire on form
// submit) so a partial-mock works for them; adminListUsers is fired
// from the iter-265 ManageUsersPanel's useEffect on mount, so its
// mock return value MUST be set in `beforeEach` (see below).
const changePassword = vi.fn()
const adminResetPassword = vi.fn()
const adminListUsers = vi.fn()
const adminCreateUser = vi.fn()
const adminDeleteUser = vi.fn()

vi.mock('../lib/push', () => ({
  ensurePushSubscription: (...a: unknown[]) => ensurePushSubscription(...a),
  disablePushSubscription: (...a: unknown[]) => disablePushSubscription(...a),
  getPushState: (...a: unknown[]) => getPushState(...a),
  pushSupported: (...a: unknown[]) => pushSupported(...a),
  sendTestPush: (...a: unknown[]) => sendTestPush(...a),
}))
// iter-279 (code-scalability-auditor T2): forward the real HttpError
// class through the api mock so consumers' `e instanceof HttpError`
// checks work in tests. Pre-iter-279 the production code path used a
// structural cast `as { status?: number }`; iter-279 tightened that
// to a real instanceof check, so tests need a real HttpError too.
vi.mock('../lib/api', async () => {
  const actual =
    await vi.importActual<typeof import('../lib/api')>('../lib/api')
  return {
    ...actual,
    getStatus: (...a: unknown[]) => getStatus(...a),
    rebootJetson: (...a: unknown[]) => rebootJetson(...a),
    getDetectionConfig: (...a: unknown[]) => getDetectionConfig(...a),
    patchDetectionConfig: (...a: unknown[]) => patchDetectionConfig(...a),
    getMyPushFilters: (...a: unknown[]) => getMyPushFilters(...a),
    setMyPushFilters: (...a: unknown[]) => setMyPushFilters(...a),
    getKnownFilterOptions: (...a: unknown[]) => getKnownFilterOptions(...a),
    triggerBackup: (...a: unknown[]) => triggerBackup(...a),
    triggerRestore: (...a: unknown[]) => triggerRestore(...a),
    triggerTimelapse: (...a: unknown[]) => triggerTimelapse(...a),
    deleteTimelapse: (...a: unknown[]) => deleteTimelapse(...a),
    triggerUpdate: (...a: unknown[]) => triggerUpdate(...a),
    getServerVersion: (...a: unknown[]) => getServerVersion(...a),
    listBackups: (...a: unknown[]) => listBackups(...a),
    listTimelapses: (...a: unknown[]) => listTimelapses(...a),
    changePassword: (...a: unknown[]) => changePassword(...a),
    adminResetPassword: (...a: unknown[]) => adminResetPassword(...a),
    adminListUsers: (...a: unknown[]) => adminListUsers(...a),
    adminCreateUser: (...a: unknown[]) => adminCreateUser(...a),
    adminDeleteUser: (...a: unknown[]) => adminDeleteUser(...a),
  }
})

const confirmFn = vi.fn()
vi.mock('../lib/confirm', () => ({
  useConfirm: () => confirmFn,
}))

const showToast = vi.fn()
vi.mock('../lib/toast', () => ({
  useToast: () => ({ showToast }),
}))

// iter-186: Settings consumes useAuth() for the "Logged in as" row
// + Sign out button. Mock the hook so tests don't need an
// <AuthProvider>. Default to authed/alice; individual tests can
// override `_authUser` / `_authLogout` before render.
let _authUser: { username: string; role: string } | null = {
  username: 'alice',
  role: 'admin',
}
const _authLogout = vi.fn()
vi.mock('../lib/auth', () => ({
  useAuth: () => ({
    state: 'authed',
    user: _authUser,
    login: vi.fn(),
    logout: () => _authLogout(),
  }),
}))


import { Settings } from './Settings'

describe('Settings page', () => {
  beforeEach(() => {
    _authUser = { username: 'alice', role: 'admin' }
    _authLogout.mockReset()
    ensurePushSubscription.mockReset()
    disablePushSubscription.mockReset().mockResolvedValue(undefined)
    getPushState.mockReset().mockResolvedValue(false)
    pushSupported.mockReset().mockReturnValue(true)
    sendTestPush.mockReset().mockResolvedValue(1)
    getStatus.mockReset().mockResolvedValue({
      ok: true,
      uptime_s: 600,
      camera: 'ok',
      detection_active: false,
      cpu_temp_c: 42.5,
      fps: 30,
    })
    rebootJetson.mockReset()
    getDetectionConfig.mockReset().mockResolvedValue({
      threshold: 0.55,
      cooldown_s: 5,
    })
    patchDetectionConfig.mockReset().mockResolvedValue({
      threshold: 0.55,
      cooldown_s: 5,
    })
    getMyPushFilters.mockReset().mockResolvedValue({ filters: null })
    setMyPushFilters.mockReset().mockResolvedValue({ filters: null })
    // iter-303: ToggleSearchList loads known options on every push-
    // enabled mount. Default to empty arrays so the picker renders
    // its "nothing to choose from yet" empty state — individual tests
    // override with concrete options when they want to exercise
    // selection behavior.
    getKnownFilterOptions
      .mockReset()
      .mockResolvedValue({ cameras: [], person_names: [] })
    triggerBackup.mockReset()
    triggerRestore.mockReset()
    triggerTimelapse.mockReset()
    triggerUpdate.mockReset()
    // iter-239 default: one backup available so iter-237 tests
    // (which assume the form is fully usable) keep working. Empty-
    // state + multi-item tests override per-test.
    listBackups.mockReset().mockResolvedValue({
      items: [
        { filename: 'snap.tar.gz', size_bytes: 100, mtime_s: 1700000000 },
      ],
    })
    getServerVersion.mockReset().mockResolvedValue({ version: '0.1.0' })
    listTimelapses.mockReset().mockResolvedValue({ items: [] })
    confirmFn.mockReset().mockResolvedValue(false)
    showToast.mockReset()
    // iter-265: ManageUsersPanel fires adminListUsers on mount when
    // the current user is owner/admin. Default to a single-row
    // result so the panel renders without "Loading…" forever and
    // existing tests don't accidentally hit a network-style hang.
    adminListUsers.mockReset().mockResolvedValue({
      users: [
        { username: 'alice', role: 'admin', created_at: 1714000000 },
      ],
    })
    adminCreateUser.mockReset().mockResolvedValue({
      ok: true,
      username: 'kid',
      role: 'family',
    })
    adminDeleteUser.mockReset().mockResolvedValue({ ok: true })
    changePassword.mockReset().mockResolvedValue({ ok: true })
    adminResetPassword.mockReset().mockResolvedValue({ ok: true })
  })
  afterEach(() => {
    vi.clearAllMocks()
    vi.restoreAllMocks()
  })

  it('renders status fields after the initial fetch', async () => {
    render(<Settings />)
    await waitFor(() => expect(screen.getByText('online')).toBeInTheDocument())
    expect(screen.getByText(/42\.5/)).toBeInTheDocument()
    expect(screen.getByText('30.0')).toBeInTheDocument()
  })

  it('formats a 7325s uptime as "2h 2m"', async () => {
    getStatus.mockResolvedValue({
      ok: true,
      uptime_s: 7325,
      camera: 'ok',
      detection_active: true,
      cpu_temp_c: null,
      fps: 0,
    })
    render(<Settings />)
    await waitFor(() => expect(screen.getByText('2h 2m')).toBeInTheDocument())
  })

  it('formats a sub-minute uptime in seconds', async () => {
    getStatus.mockResolvedValue({
      ok: true,
      uptime_s: 42,
      camera: 'ok',
      detection_active: false,
      cpu_temp_c: null,
      fps: 0,
    })
    render(<Settings />)
    await waitFor(() => expect(screen.getByText('42s')).toBeInTheDocument())
  })

  it('toggling push calls ensurePushSubscription', async () => {
    ensurePushSubscription.mockResolvedValue(true)
    const user = userEvent.setup()
    render(<Settings />)
    const toggle = await screen.findByRole('button', {
      name: /enable push notifications/i,
    })
    await user.click(toggle)
    expect(ensurePushSubscription).toHaveBeenCalledTimes(1)
    await waitFor(() =>
      expect(toggle.getAttribute('aria-pressed')).toBe('true'),
    )
  })

  it('shows "not supported" instead of a toggle when pushSupported is false', async () => {
    pushSupported.mockReturnValue(false)
    render(<Settings />)
    // The "Push to this device" row no longer renders an interactive
    // toggle — instead it shows a status string and an explanation.
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: /enable push notifications/i }),
      ).not.toBeInTheDocument(),
    )
    expect(
      screen.getByLabelText(/push not supported in this browser/i),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/Alerts aren't available in this browser yet/i),
    ).toBeInTheDocument()
    // ensurePushSubscription must NEVER fire when push isn't supported —
    // the alert() inside it would be jarring on mobile.
    expect(ensurePushSubscription).not.toHaveBeenCalled()
  })

  it('toggling push off calls disablePushSubscription', async () => {
    // Start in the "subscribed" state so the toggle is "on" and the
    // first click is a disable action.
    getPushState.mockResolvedValue(true)
    ensurePushSubscription.mockResolvedValue(true)
    const user = userEvent.setup()
    render(<Settings />)
    const toggle = await screen.findByRole('button', {
      name: /enable push notifications/i,
    })
    await waitFor(() =>
      expect(toggle.getAttribute('aria-pressed')).toBe('true'),
    )
    await user.click(toggle)
    expect(disablePushSubscription).toHaveBeenCalledTimes(1)
    await waitFor(() =>
      expect(toggle.getAttribute('aria-pressed')).toBe('false'),
    )
  })

  it('reboot button asks for confirmation and aborts on cancel', async () => {
    confirmFn.mockReset().mockResolvedValue(false)
    const user = userEvent.setup()
    render(<Settings />)
    await user.click(screen.getByRole('button', { name: /restart camera box/i }))
    await waitFor(() => expect(confirmFn).toHaveBeenCalled())
    expect(confirmFn.mock.calls[0][0]).toMatchObject({
      title: expect.stringMatching(/reboot/i),
      destructive: true,
    })
    expect(rebootJetson).not.toHaveBeenCalled()
  })

  it('reboot proceeds when confirmed and emits a toast', async () => {
    confirmFn.mockReset().mockResolvedValue(true)
    rebootJetson.mockResolvedValue({ ok: true })
    const user = userEvent.setup()
    render(<Settings />)
    await user.click(screen.getByRole('button', { name: /restart camera box/i }))
    await waitFor(() => expect(rebootJetson).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.stringMatching(/reboot requested/i),
        'success',
      ),
    )
  })

  it('reboot honestly reports the stubbed-server case', async () => {
    // The server's /api/system/reboot is currently a scaffold and
    // returns `{ ok: true, note: "scaffold: reboot is stubbed" }`.
    // The UI must not claim "Reboot requested" in that case.
    confirmFn.mockReset().mockResolvedValue(true)
    rebootJetson.mockResolvedValue({
      ok: true,
      note: 'scaffold: reboot is stubbed',
    })
    const user = userEvent.setup()
    render(<Settings />)
    await user.click(screen.getByRole('button', { name: /restart camera box/i }))
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.stringMatching(/isn't set up yet/i),
        'info',
      ),
    )
  })

  it('renders an em-dash placeholder when status fetch fails', async () => {
    getStatus.mockRejectedValue(new Error('offline'))
    render(<Settings />)
    await waitFor(() => {
      expect(screen.getAllByText('—').length).toBeGreaterThan(0)
    })
  })

  it('renders the detection threshold + cooldown sliders with current values', async () => {
    render(<Settings />)
    const threshold = await screen.findByRole('slider', {
      name: /detection sensitivity/i,
    })
    expect(threshold).toHaveValue('0.55')
    const cooldown = screen.getByRole('slider', {
      name: /quiet time after a detection/i,
    })
    expect(cooldown).toHaveValue('5')
  })

  it('PATCHes the detection config on slider commit', async () => {
    patchDetectionConfig.mockResolvedValue({ threshold: 0.7, cooldown_s: 5 })
    render(<Settings />)
    const slider = await screen.findByRole('slider', {
      name: /detection sensitivity/i,
    })
    fireEvent.change(slider, { target: { value: '0.7' } })
    // Commit happens on pointer-up (or arrow-key release).
    fireEvent.pointerUp(slider)
    await waitFor(() =>
      expect(patchDetectionConfig).toHaveBeenCalledWith({ threshold: 0.7 }),
    )
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        'Detection settings saved',
        'success',
      ),
    )
  })

  it('does not PATCH on every drag step', async () => {
    render(<Settings />)
    const slider = await screen.findByRole('slider', {
      name: /detection sensitivity/i,
    })
    fireEvent.change(slider, { target: { value: '0.6' } })
    fireEvent.change(slider, { target: { value: '0.7' } })
    fireEvent.change(slider, { target: { value: '0.8' } })
    expect(patchDetectionConfig).not.toHaveBeenCalled()
    fireEvent.pointerUp(slider)
    await waitFor(() =>
      expect(patchDetectionConfig).toHaveBeenCalledTimes(1),
    )
    expect(patchDetectionConfig).toHaveBeenCalledWith({ threshold: 0.8 })
  })

  it('emits an error toast when PATCH fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    patchDetectionConfig.mockRejectedValue(new Error('boom'))
    render(<Settings />)
    const slider = await screen.findByRole('slider', {
      name: /detection sensitivity/i,
    })
    fireEvent.change(slider, { target: { value: '0.9' } })
    fireEvent.pointerUp(slider)
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        'Could not save settings',
        'error',
      ),
    )
    errorSpy.mockRestore()
  })

  // ---- Degraded-status display (Jetson loop list #10) -----------------------
  // These pin the threshold / color logic in the small render components
  // (DroppedFrames, InferenceLatency, StreamRecoveries, CpuFreqPct,
  // FaceRecogStatus). Each component renders inside the Jetson section of
  // Settings; the page test mounts the full tree.

  function statusWith(metrics: Record<string, unknown>, top: Record<string, unknown> = {}) {
    // Keep this in sync with `ServerStatus` so a new field added in
    // a future iter doesn't leave existing tests asserting against a
    // partial shape. The `top` param lets individual tests override
    // any field; metrics merges into `worker_metrics`.
    return {
      ok: true,
      uptime_s: 600,
      camera: 'ok',
      detection_active: true,
      worker_alive: true,
      worker_last_seen_s: 1.5,
      cpu_temp_c: 50,
      gpu_temp_c: 47,
      cpu_freq_pct: 100,
      load_avg: [0.5, 0.6, 0.7],
      memory_used_mb: 1400,
      memory_total_mb: 1979,
      disk_free_gb: 28,
      fps: 5,
      push_subs_count: 0,
      seconds_since_last_frame: null,
      camera_label: 'Front Door',
      audio_enabled: false,
      worker_metrics: { gear: 'idle', frames: 100, ...metrics },
      ...top,
    }
  }

  it('paints inference latency yellow above 80 ms and red above 150 ms', async () => {
    getStatus.mockResolvedValue(statusWith({ infer_ms_recent: 95 }))
    const { unmount } = render(<Settings />)
    await waitFor(() => expect(screen.getByText('95.0 ms')).toBeInTheDocument())
    expect(screen.getByText('95.0 ms')).toHaveClass('text-[var(--color-warning)]')
    unmount()

    getStatus.mockResolvedValue(statusWith({ infer_ms_recent: 175 }))
    render(<Settings />)
    await waitFor(() => expect(screen.getByText('175.0 ms')).toBeInTheDocument())
    expect(screen.getByText('175.0 ms')).toHaveClass('text-[var(--color-danger)]')
  })

  it('uses p95 (not recent) to color the inference row when available', async () => {
    // recent is a brief cold-cache spike; p95 over 20 calls is 39 ms.
    // The neutral color should win — the spike isn't sustained pressure.
    getStatus.mockResolvedValue(
      statusWith({ infer_ms_recent: 200, infer_ms_p95: 39 }),
    )
    render(<Settings />)
    await waitFor(() =>
      expect(screen.getByText('200.0 ms')).toBeInTheDocument(),
    )
    // The container span should be neutral (text-[var(--color-text-secondary)]),
    // not red, because p95 is the basis when present and 39 < 80.
    // iter-356.3d: Mono token migration changed the class name from
    // text-neutral-400 → text-[var(--color-text-secondary)].
    const span = screen.getByText('200.0 ms')
    expect(span).toHaveClass('text-[var(--color-text-secondary)]')
    expect(screen.getByText(/p95 39\.0/)).toBeInTheDocument()
  })

  it('paints dropped-frames percentage yellow at 1% and red at 5%', async () => {
    // 6 dropped of 600 captured ≈ 1% → yellow.
    getStatus.mockResolvedValue(statusWith({ dropped: 6, frames: 594 }))
    const { unmount } = render(<Settings />)
    await waitFor(() => expect(screen.getByText('6')).toBeInTheDocument())
    expect(screen.getByText('6')).toHaveClass('text-[var(--color-warning)]')
    unmount()

    // 60 of 1000 = 6% → red.
    getStatus.mockResolvedValue(statusWith({ dropped: 60, frames: 940 }))
    render(<Settings />)
    await waitFor(() => expect(screen.getByText('60')).toBeInTheDocument())
    expect(screen.getByText('60')).toHaveClass('text-[var(--color-danger)]')
  })

  it('paints stream-recovery count yellow at 1 and red at 3', async () => {
    getStatus.mockResolvedValue(statusWith({ mediamtx_restarts: 2 }))
    const { unmount } = render(<Settings />)
    await waitFor(() => expect(screen.getByText('2')).toBeInTheDocument())
    expect(screen.getByText('2')).toHaveClass('text-[var(--color-warning)]')
    unmount()

    getStatus.mockResolvedValue(statusWith({ mediamtx_restarts: 5 }))
    render(<Settings />)
    await waitFor(() => expect(screen.getByText('5')).toBeInTheDocument())
    expect(screen.getByText('5')).toHaveClass('text-[var(--color-danger)]')
  })

  it('paints CPU clock yellow below 95% and red below 75%', async () => {
    getStatus.mockResolvedValue(statusWith({}, { cpu_freq_pct: 88 }))
    const { unmount } = render(<Settings />)
    await waitFor(() => expect(screen.getByText('88.0 %')).toBeInTheDocument())
    expect(screen.getByText('88.0 %')).toHaveClass('text-[var(--color-warning)]')
    unmount()

    getStatus.mockResolvedValue(statusWith({}, { cpu_freq_pct: 60 }))
    render(<Settings />)
    await waitFor(() => expect(screen.getByText('60.0 %')).toBeInTheDocument())
    expect(screen.getByText('60.0 %')).toHaveClass('text-[var(--color-danger)]')
  })

  it('renders face_recog names as emerald chips when present', async () => {
    getStatus.mockResolvedValue(
      statusWith({ face_recog_names: ['israel', 'sheenal'] }),
    )
    render(<Settings />)
    await waitFor(() => {
      expect(screen.getByText('israel')).toBeInTheDocument()
      expect(screen.getByText('sheenal')).toBeInTheDocument()
    })
  })

  it('shows "disabled" face-recog label when names list is empty', async () => {
    getStatus.mockResolvedValue(statusWith({ face_recog_names: [] }))
    render(<Settings />)
    await waitFor(() => expect(screen.getByText('disabled')).toBeInTheDocument())
  })

  it('toasts the device count on a successful test push', async () => {
    getPushState.mockResolvedValue(true)
    sendTestPush.mockResolvedValue(2)
    const user = userEvent.setup()
    render(<Settings />)
    const send = await screen.findByRole('button', { name: /send test notification/i })
    await user.click(send)
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.stringMatching(/sent to 2 devices/i),
        'success',
      ),
    )
  })

  it('shows the live device-count and a plain-English helper in the Notifications section (iter-155 + iter-296)', async () => {
    // iter-155: ambient surface of /api/status.push_subs_count so the
    // user can verify a subscription registered without sending a test.
    // iter-296: label rewritten from "Subscribed devices" to
    // "Devices getting alerts" + a contextual helper line ("Just this
    // one." vs "this one isn't included yet.") because user reported
    // not understanding the original.

    // arrange
    getStatus.mockResolvedValue(statusWith({}, { push_subs_count: 3 }))

    // act
    render(<Settings />)

    // assert
    const label = await screen.findByText(/devices getting alerts/i)
    expect(label).toBeInTheDocument()
    const row = label.closest('div')?.parentElement
    expect(row?.textContent).toMatch(/Devices getting alerts.*3/i)
  })

  it('given push is enabled and 3 devices, when Notifications renders, then the helper says this device is included (iter-296)', async () => {
    // arrange
    getPushState.mockResolvedValue(true)
    getStatus.mockResolvedValue(statusWith({}, { push_subs_count: 3 }))

    // act
    render(<Settings />)

    // assert
    expect(
      await screen.findByText(/this device, plus 2 others/i),
    ).toBeInTheDocument()
  })

  it('given push is disabled and 1 device, when Notifications renders, then the helper says this device is not included (iter-296)', async () => {
    // arrange
    getPushState.mockResolvedValue(false)
    getStatus.mockResolvedValue(statusWith({}, { push_subs_count: 1 }))

    // act
    render(<Settings />)

    // assert
    expect(
      await screen.findByText(/this one isn't included yet/i),
    ).toBeInTheDocument()
  })

  it('toasts a no-op message when test push lands on zero subscriptions', async () => {
    // iter-141 honest UX: server returns `sent: 0` when no live
    // subs (fresh server, all 410'd). Don't claim "Test push sent"
    // — say so.
    getPushState.mockResolvedValue(true)
    sendTestPush.mockResolvedValue(0)
    const user = userEvent.setup()
    render(<Settings />)
    const send = await screen.findByRole('button', { name: /send test notification/i })
    await user.click(send)
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        // iter-356.56 (Frank S2): copy pivot from "no reachable
        // subscriptions" engineer-voice to actionable plain English.
        expect.stringMatching(/no devices are set up to receive alerts/i),
        'info',
      ),
    )
  })

  it('surfaces classes outside the common pick-list as toggleable chips', async () => {
    // A user (or sysadmin) configured the worker to also detect "horse"
    // — a class outside COMMON_DETECTION_CLASSES. Pre-iter-126 the chip
    // for "horse" wasn't rendered, so the user couldn't see or toggle
    // it. Pin the iter-126 fix: any extra configured class shows up
    // as an enabled chip alongside the curated set.
    getDetectionConfig.mockResolvedValue({
      threshold: 0.55,
      cooldown_s: 5,
      enabled: true,
      schedule_off_start: null,
      schedule_off_end: null,
      classes: ['horse', 'person'],
    })
    render(<Settings />)
    const horse = await screen.findByRole('button', { name: 'horse' })
    expect(horse.getAttribute('aria-pressed')).toBe('true')
    const person = await screen.findByRole('button', { name: 'person' })
    expect(person.getAttribute('aria-pressed')).toBe('true')
  })

  // iter-186 (Auth Plan Phase 7): Account section — "Logged in as
  // <username>" + Sign out button.

  it('shows the logged-in username (iter-186)', async () => {
    _authUser = { username: 'alice', role: 'admin' }
    render(<Settings />)
    // iter-198 (Feature #3 slice 3b) added the role suffix: the
    // rendered text is now "alice (Admin)". Match by substring.
    expect(await screen.findByText(/alice/)).toBeInTheDocument()
  })

  it('falls back to em-dash when user is null', async () => {
    _authUser = null
    render(<Settings />)
    // Multiple em-dashes can appear on the page (LiveStats null
    // fallbacks). Just assert at least one is present and the
    // alice username from the default isn't.
    const dashes = await screen.findAllByText('—')
    expect(dashes.length).toBeGreaterThan(0)
    expect(screen.queryByText('alice')).not.toBeInTheDocument()
  })

  it('Sign out button calls useConfirm and fires logout when user accepts (iter-186 + iter-356.12 Frank #7)', async () => {
    // arrange — mock confirm to resolve true (user accepted).
    confirmFn.mockReset().mockResolvedValue(true)
    render(<Settings />)
    const signOut = await screen.findByRole('button', { name: /sign out/i })

    // act
    fireEvent.click(signOut)

    // assert — confirm was called with the right copy + logout fired.
    await waitFor(() => expect(confirmFn).toHaveBeenCalledTimes(1))
    expect(confirmFn.mock.calls[0][0].title).toMatch(/sign out/i)
    await waitFor(() => expect(_authLogout).toHaveBeenCalledTimes(1))
  })

  it('Sign out cancel keeps the user signed in (iter-356.12 Frank #7)', async () => {
    // arrange — confirm resolves false (user cancelled).
    confirmFn.mockReset().mockResolvedValue(false)
    render(<Settings />)
    const signOut = await screen.findByRole('button', { name: /sign out/i })

    // act
    fireEvent.click(signOut)

    // assert — confirm was called but logout was NOT.
    await waitFor(() => expect(confirmFn).toHaveBeenCalledTimes(1))
    expect(_authLogout).not.toHaveBeenCalled()
  })

  // iter-198 (Feature #3 slice 3b): role-aware UI gating.

  it('shows role label after username (iter-198)', async () => {
    _authUser = { username: 'alice', role: 'owner' }
    render(<Settings />)
    expect(await screen.findByText(/alice \(Owner\)/)).toBeInTheDocument()
  })

  it('title-cases the role label for family role', async () => {
    _authUser = { username: 'mom', role: 'family' }
    render(<Settings />)
    expect(await screen.findByText(/mom \(Family\)/)).toBeInTheDocument()
  })

  it('hides Restart camera box button for non-owner role (iter-198)', async () => {
    _authUser = { username: 'mom', role: 'family' }
    render(<Settings />)
    // Wait for status to load so the page renders fully.
    await screen.findByText(/mom/)
    expect(
      screen.queryByRole('button', { name: /restart camera box/i }),
    ).not.toBeInTheDocument()
  })

  it('shows Restart camera box button for owner role (iter-198)', async () => {
    _authUser = { username: 'alice', role: 'owner' }
    render(<Settings />)
    expect(
      await screen.findByRole('button', { name: /restart camera box/i }),
    ).toBeInTheDocument()
  })

  it('shows Restart camera box button for legacy admin role (iter-198 carve-out)', async () => {
    // iter-197 transitional: server's `require_role("owner")` accepts
    // `admin` via the carve-out for iter-178/179 seeded users. Client
    // mirrors. Drop when the cleanup iter migrates seeded users.
    _authUser = { username: 'alice', role: 'admin' }
    render(<Settings />)
    expect(
      await screen.findByRole('button', { name: /restart camera box/i }),
    ).toBeInTheDocument()
  })

  it('hides Detection sliders section for viewer role (iter-198)', async () => {
    _authUser = { username: 'kid', role: 'viewer' }
    render(<Settings />)
    await screen.findByText(/kid/)
    // The Sensitivity slider is the canonical Detection
    // section control; aria-label was set in iter-141-ish.
    expect(
      screen.queryByLabelText(/detection sensitivity/i),
    ).not.toBeInTheDocument()
  })

  it('shows Detection sliders for owner role (iter-198)', async () => {
    _authUser = { username: 'alice', role: 'owner' }
    render(<Settings />)
    expect(
      await screen.findByLabelText(/detection sensitivity/i),
    ).toBeInTheDocument()
  })

  // iter-208 (Feature #4 slice 3b): per-user notification-filter UI.
  // Hidden until push is enabled (no subs => nothing to filter, and
  // the iter-207 GET 404s in that state). When visible, populates two
  // text inputs from getMyPushFilters and PUTs via setMyPushFilters.

  it('does not load filters until push is enabled (iter-208)', async () => {
    // Default: getPushState resolves false → push toggle is off.
    render(<Settings />)
    await screen.findByRole('button', { name: /enable push notifications/i })
    expect(getMyPushFilters).not.toHaveBeenCalled()
    expect(
      screen.queryByLabelText(/camera filter list/i),
    ).not.toBeInTheDocument()
  })

  it('given push enabled with prior filters, when loaded, then toggle lists reflect the saved selection (iter-303)', async () => {
    // arrange — pre-iter-303 these were free-text inputs; iter-303
    // replaced them with `<ToggleSearchList>` widgets driven by
    // GET /api/push/known_filter_options.
    getPushState.mockResolvedValue(true)
    getMyPushFilters.mockResolvedValue({
      filters: { cameras: ['cam1'], person_names: ['israel'] },
    })
    getKnownFilterOptions.mockResolvedValue({
      cameras: ['cam1', 'cam2'],
      person_names: ['israel', 'alice'],
    })

    // act
    render(<Settings />)

    // assert — the iter-303 ToggleSearchList renders one checkbox
    // per option labeled "Allow {name}" (or "Don't allow"). For the
    // selected ones the checkbox is checked.
    const cam1Toggle = (await screen.findByLabelText(
      /^allow cam1$/i,
    )) as HTMLInputElement
    const israelToggle = (await screen.findByLabelText(
      /^allow israel$/i,
    )) as HTMLInputElement
    expect(cam1Toggle.checked).toBe(true)
    expect(israelToggle.checked).toBe(true)
    // Unselected options render with the "Don't allow" affordance.
    expect(
      (screen.getByLabelText(/^don't allow cam2$/i) as HTMLInputElement)
        .checked,
    ).toBe(false)
    expect(getMyPushFilters).toHaveBeenCalledTimes(1)
    expect(getKnownFilterOptions).toHaveBeenCalledTimes(1)
  })

  it('given push enabled and filters null, when loaded, then no toggles are checked (match-all)', async () => {
    // arrange
    getPushState.mockResolvedValue(true)
    getMyPushFilters.mockResolvedValue({ filters: null })
    getKnownFilterOptions.mockResolvedValue({
      cameras: ['cam1'],
      person_names: ['israel'],
    })

    // act
    render(<Settings />)

    // assert — every option renders with "Don't allow" prefix
    // (unchecked) when match-all is active.
    const cam1 = (await screen.findByLabelText(
      /^don't allow cam1$/i,
    )) as HTMLInputElement
    const israel = (await screen.findByLabelText(
      /^don't allow israel$/i,
    )) as HTMLInputElement
    expect(cam1.checked).toBe(false)
    expect(israel.checked).toBe(false)
  })

  it('given a 404 from getMyPushFilters, when loaded, then the picker still renders for fresh setup (iter-303)', async () => {
    // arrange
    getPushState.mockResolvedValue(true)
    getMyPushFilters.mockRejectedValue(new Error('404'))
    getKnownFilterOptions.mockResolvedValue({
      cameras: [],
      person_names: [],
    })

    // act
    render(<Settings />)

    // assert — Save button enabled (user can write fresh filters)
    // and the empty-state copy shows for both lists.
    const save = await screen.findByRole('button', {
      name: /save notification filters/i,
    })
    expect(save).not.toBeDisabled()
  })

  it('given user toggles a person on, when Save clicked, then setMyPushFilters receives only that name (iter-303)', async () => {
    // arrange
    getPushState.mockResolvedValue(true)
    getMyPushFilters.mockResolvedValue({ filters: null })
    getKnownFilterOptions.mockResolvedValue({
      cameras: ['cam1', 'cam2'],
      person_names: ['israel', 'alice'],
    })
    const user = userEvent.setup()

    // act
    render(<Settings />)
    const israelToggle = await screen.findByLabelText(/^don't allow israel$/i)
    const cam1Toggle = await screen.findByLabelText(/^don't allow cam1$/i)
    await user.click(israelToggle)
    await user.click(cam1Toggle)
    await user.click(
      screen.getByRole('button', { name: /save notification filters/i }),
    )

    // assert
    await waitFor(() => expect(setMyPushFilters).toHaveBeenCalledTimes(1))
    expect(setMyPushFilters).toHaveBeenCalledWith({
      cameras: ['cam1'],
      person_names: ['israel'],
      schedule_window: null,
    })
    expect(showToast).toHaveBeenCalledWith(
      expect.stringMatching(/saved/i),
      'success',
    )
  })

  it('given prior selection and user un-toggles all, when Save clicked, then null is sent (full reset)', async () => {
    // arrange
    getPushState.mockResolvedValue(true)
    getMyPushFilters.mockResolvedValue({
      filters: { cameras: ['cam1'], person_names: ['israel'] },
    })
    getKnownFilterOptions.mockResolvedValue({
      cameras: ['cam1'],
      person_names: ['israel'],
    })
    const user = userEvent.setup()

    // act
    render(<Settings />)
    const cam1 = (await screen.findByLabelText(
      /^allow cam1$/i,
    )) as HTMLInputElement
    const israel = (await screen.findByLabelText(
      /^allow israel$/i,
    )) as HTMLInputElement
    await waitFor(() => expect(cam1.checked).toBe(true))
    await user.click(cam1)
    await user.click(israel)
    await user.click(
      screen.getByRole('button', { name: /save notification filters/i }),
    )

    // assert
    await waitFor(() => expect(setMyPushFilters).toHaveBeenCalledTimes(1))
    // null => the iter-205 wire-shape sentinel for "no filter, match
    // every event" (legacy behaviour). Distinct from `[]` per-field
    // which would mean "match nothing".
    expect(setMyPushFilters).toHaveBeenCalledWith(null)
  })

  it('Save toasts an error message when setMyPushFilters rejects', async () => {
    getPushState.mockResolvedValue(true)
    getMyPushFilters.mockResolvedValue({ filters: null })
    setMyPushFilters.mockRejectedValue(new Error('boom'))
    const user = userEvent.setup()
    render(<Settings />)
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /save notification filters/i }),
      ).not.toBeDisabled(),
    )
    await user.click(
      screen.getByRole('button', { name: /save notification filters/i }),
    )
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.stringMatching(/could not save filters/i),
        'error',
      ),
    )
  })

  // iter-209 (Feature #4 slice 4): time-of-day schedule_window UI.
  // Two HH:MM inputs (From / To); both blank = no time gating.

  it('populates schedule_window inputs from server response (iter-209)', async () => {
    getPushState.mockResolvedValue(true)
    getMyPushFilters.mockResolvedValue({
      filters: {
        cameras: null,
        person_names: null,
        schedule_window: { start: '22:00', end: '07:00' },
      },
    })
    render(<Settings />)
    const startInput = (await screen.findByLabelText(
      /schedule window start time/i,
    )) as HTMLInputElement
    const endInput = (await screen.findByLabelText(
      /schedule window end time/i,
    )) as HTMLInputElement
    await waitFor(() => expect(startInput.value).toBe('22:00'))
    expect(endInput.value).toBe('07:00')
  })

  it('Save sends schedule_window when both bounds are valid HH:MM (iter-209)', async () => {
    getPushState.mockResolvedValue(true)
    getMyPushFilters.mockResolvedValue({ filters: null })
    const user = userEvent.setup()
    render(<Settings />)
    const startInput = await screen.findByLabelText(
      /schedule window start time/i,
    )
    const endInput = await screen.findByLabelText(
      /schedule window end time/i,
    )
    await waitFor(() => expect(startInput).not.toBeDisabled())
    await user.type(startInput, '09:00')
    await user.type(endInput, '17:00')
    await user.click(
      screen.getByRole('button', { name: /save notification filters/i }),
    )
    await waitFor(() => expect(setMyPushFilters).toHaveBeenCalledTimes(1))
    expect(setMyPushFilters).toHaveBeenCalledWith({
      cameras: null,
      person_names: null,
      schedule_window: { start: '09:00', end: '17:00' },
    })
  })

  it('shows a validation error when schedule_window has only one bound (iter-209)', async () => {
    getPushState.mockResolvedValue(true)
    getMyPushFilters.mockResolvedValue({ filters: null })
    const user = userEvent.setup()
    render(<Settings />)
    const startInput = await screen.findByLabelText(
      /schedule window start time/i,
    )
    await waitFor(() => expect(startInput).not.toBeDisabled())
    await user.type(startInput, '09:00')
    // End left blank — Save must be disabled, error shown.
    expect(
      screen.getByLabelText(/schedule window validation error/i),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /save notification filters/i }),
    ).toBeDisabled()
  })

  it('given native time inputs, when only one bound is set, then Save is disabled (iter-209/355ac)', async () => {
    // arrange — iter-355ac (Maya Major): schedule From/To are now
    // <input type="time"> (was type="text" with HH:MM placeholder).
    // Browsers intercept malformed input natively, so the iter-209
    // "type 25:99 → app shows validation error" path is unreachable.
    // The remaining client-side gate that DOES still fire is the
    // both-or-neither rule: setting only one bound disables Save.
    getPushState.mockResolvedValue(true)
    getMyPushFilters.mockResolvedValue({ filters: null })
    const user = userEvent.setup()
    render(<Settings />)
    const startInput = await screen.findByLabelText(
      /schedule window start time/i,
    )
    await waitFor(() => expect(startInput).not.toBeDisabled())

    // act — type a valid time into START only; END stays blank.
    // userEvent.type with HH:MM works on type="time" via fragment
    // entry (jsdom accepts the canonical value).
    await user.type(startInput, '22:00')

    // assert — client-side gate disables Save until END is also set.
    expect(
      screen.getByRole('button', { name: /save notification filters/i }),
    ).toBeDisabled()
    expect(setMyPushFilters).not.toHaveBeenCalled()
  })

  it('given prior cameras + schedule, when user un-toggles + clears times, then null is sent (iter-209/iter-303)', async () => {
    // arrange — iter-208 behavior carries through with iter-209's
    // schedule_window AND iter-303's toggle-list pattern. Empty
    // selection + blank schedule = total reset.
    getPushState.mockResolvedValue(true)
    getMyPushFilters.mockResolvedValue({
      filters: {
        cameras: ['cam1'],
        person_names: null,
        schedule_window: { start: '22:00', end: '07:00' },
      },
    })
    getKnownFilterOptions.mockResolvedValue({
      cameras: ['cam1'],
      person_names: [],
    })
    const user = userEvent.setup()

    // act
    render(<Settings />)
    const cam1 = (await screen.findByLabelText(
      /^allow cam1$/i,
    )) as HTMLInputElement
    const startInput = (await screen.findByLabelText(
      /schedule window start time/i,
    )) as HTMLInputElement
    const endInput = (await screen.findByLabelText(
      /schedule window end time/i,
    )) as HTMLInputElement
    await waitFor(() => expect(cam1.checked).toBe(true))
    await user.click(cam1) // un-toggle
    await user.clear(startInput)
    await user.clear(endInput)
    await user.click(
      screen.getByRole('button', { name: /save notification filters/i }),
    )

    // assert
    await waitFor(() => expect(setMyPushFilters).toHaveBeenCalledTimes(1))
    expect(setMyPushFilters).toHaveBeenCalledWith(null)
  })

  // iter-211 (Feature #10 slice 2): Backup button mirrors the
  // iter-197 Reboot button — confirm-gated, surfaces server's
  // `note` when stubbed instead of pretending success.

  it('backup button asks for confirmation and aborts on cancel (iter-211)', async () => {
    confirmFn.mockReset().mockResolvedValue(false)
    const user = userEvent.setup()
    render(<Settings />)
    await user.click(
      screen.getByRole('button', { name: /back up server state/i }),
    )
    await waitFor(() => expect(confirmFn).toHaveBeenCalled())
    expect(confirmFn.mock.calls[0][0]).toMatchObject({
      title: expect.stringMatching(/back up/i),
    })
    expect(triggerBackup).not.toHaveBeenCalled()
  })

  it('backup proceeds when confirmed and emits a toast (iter-211)', async () => {
    confirmFn.mockReset().mockResolvedValue(true)
    triggerBackup.mockResolvedValue({ ok: true })
    const user = userEvent.setup()
    render(<Settings />)
    await user.click(
      screen.getByRole('button', { name: /back up server state/i }),
    )
    await waitFor(() => expect(triggerBackup).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.stringMatching(/backup requested/i),
        'success',
      ),
    )
  })

  it('backup honestly reports the stubbed-server case (iter-211)', async () => {
    // The iter-210 server returns `{ ok, note }` until the host-
    // helper is wired. UI must surface the truth, not claim success.
    confirmFn.mockReset().mockResolvedValue(true)
    triggerBackup.mockResolvedValue({
      ok: true,
      note: 'scaffold: backup is stubbed',
    })
    const user = userEvent.setup()
    render(<Settings />)
    await user.click(
      screen.getByRole('button', { name: /back up server state/i }),
    )
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.stringMatching(/isn't set up yet/i),
        'info',
      ),
    )
  })

  it('backup toasts an error when triggerBackup rejects (iter-211)', async () => {
    confirmFn.mockReset().mockResolvedValue(true)
    triggerBackup.mockRejectedValue(new Error('boom'))
    const user = userEvent.setup()
    render(<Settings />)
    await user.click(
      screen.getByRole('button', { name: /back up server state/i }),
    )
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.stringMatching(/backup failed/i),
        'error',
      ),
    )
  })

  it('backup button hidden for viewer role (iter-211, mirrors iter-198)', async () => {
    _authUser = { username: 'kid', role: 'viewer' }
    render(<Settings />)
    await screen.findByText(/kid/)
    expect(
      screen.queryByRole('button', { name: /back up server state/i }),
    ).not.toBeInTheDocument()
  })

  it('backup button visible for legacy admin role (iter-211 carve-out)', async () => {
    _authUser = { username: 'alice', role: 'admin' }
    render(<Settings />)
    expect(
      await screen.findByRole('button', { name: /back up server state/i }),
    ).toBeInTheDocument()
  })

  // iter-214 (Feature #8 slice 3): Timelapses Settings panel.
  // Owner-only section; lists existing timelapse files with
  // download links + offers a date-input + Generate button that
  // hits the iter-213 trigger route.

  it('hides Timelapses section for non-owner roles (iter-214)', async () => {
    _authUser = { username: 'kid', role: 'viewer' }
    render(<Settings />)
    await screen.findByText(/kid/)
    expect(
      screen.queryByLabelText(/timelapse date/i),
    ).not.toBeInTheDocument()
    expect(listTimelapses).not.toHaveBeenCalled()
  })

  it('loads timelapses on mount for owner (iter-214)', async () => {
    listTimelapses.mockResolvedValue({
      items: [
        { date: '2026-04-30', url: '/timelapses/2026-04-30.mp4', size_bytes: 1234 },
        { date: '2026-04-29', url: '/timelapses/2026-04-29.mp4', size_bytes: 5_000_000 },
      ],
    })
    render(<Settings />)
    expect(await screen.findByText('2026-04-30')).toBeInTheDocument()
    expect(screen.getByText('2026-04-29')).toBeInTheDocument()
    // Size shown via formatBytes — 5 MB.
    expect(screen.getByText(/5\.0 MB/)).toBeInTheDocument()
  })

  it('shows "No timelapses yet" when listing returns empty (iter-214)', async () => {
    listTimelapses.mockResolvedValue({ items: [] })
    render(<Settings />)
    expect(
      await screen.findByLabelText(/no timelapses yet/i),
    ).toBeInTheDocument()
  })

  it('given iter-304 Build button defaults to yesterday, when rendered, then it is enabled with a pre-filled date', async () => {
    // arrange — iter-304 replaced the free-text input with a native
    // <input type="date"> AND defaulted the value to yesterday so
    // the dominant case ("build yesterday's video") is one tap. Pre-
    // iter-304 Generate was disabled until the user typed a date.
    render(<Settings />)

    // act — wait for the Build button to render.
    const button = await screen.findByRole('button', {
      name: /generate timelapse/i,
    })

    // assert — enabled by default because the date is pre-populated.
    expect(button).not.toBeDisabled()
  })

  it('given iter-304 native date input, when user changes it, then the Build button still triggers with the new date', async () => {
    // arrange
    triggerTimelapse.mockResolvedValue({
      ok: true,
      note: 'scaffold: timelapse is stubbed',
      date: '2026-04-30',
      url: '/timelapses/2026-04-30.mp4',
    })
    listTimelapses
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce({
        items: [
          { date: '2026-04-30', url: '/timelapses/2026-04-30.mp4', size_bytes: 100 },
        ],
      })
    const { fireEvent } = await import('@testing-library/react')
    const user = userEvent.setup()
    render(<Settings />)
    const input = (await screen.findByLabelText(
      /timelapse date/i,
    )) as HTMLInputElement

    // act — fireEvent.change is the right API for native date inputs;
    // userEvent.type doesn't work on them.
    fireEvent.change(input, { target: { value: '2026-04-30' } })
    await user.click(
      screen.getByRole('button', { name: /generate timelapse/i }),
    )

    // assert
    await waitFor(() => expect(triggerTimelapse).toHaveBeenCalledWith('2026-04-30'))
    await waitFor(() => expect(listTimelapses).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.stringMatching(/isn't set up yet/i),
        'info',
      ),
    )
  })

  it('given iter-304 trigger rejects, when Build clicked, then error toast fires', async () => {
    // arrange
    triggerTimelapse.mockRejectedValue(new Error('boom'))
    const user = userEvent.setup()
    render(<Settings />)

    // act
    await user.click(
      await screen.findByRole('button', { name: /generate timelapse/i }),
    )

    // assert
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.stringMatching(/timelapse failed/i),
        'error',
      ),
    )
  })

  it('given iter-304 Yesterday preset, when clicked, then date input fills with yesterday', async () => {
    // arrange
    const user = userEvent.setup()
    render(<Settings />)
    const input = (await screen.findByLabelText(
      /timelapse date/i,
    )) as HTMLInputElement
    const initial = input.value

    // act — change to a different date first, then click Yesterday
    // to verify the preset overwrites correctly.
    const { fireEvent } = await import('@testing-library/react')
    fireEvent.change(input, { target: { value: '2020-01-01' } })
    expect(input.value).toBe('2020-01-01')
    await user.click(screen.getByRole('button', { name: /pick yesterday/i }))

    // assert — back to the default-yesterday value.
    expect(input.value).toBe(initial)
  })

  it('given iter-304 timelapses listed, when rendered, then inline video element is present per item', async () => {
    // arrange — pre-iter-304 listing was a one-line row with just
    // a Download link. iter-304 added an inline <video controls>
    // so the user can play in place.
    listTimelapses.mockResolvedValue({
      items: [
        { date: '2026-04-30', url: '/timelapses/2026-04-30.mp4', size_bytes: 100 },
      ],
    })

    // act
    render(<Settings />)

    // assert
    const video = await screen.findByLabelText(
      /timelapse video for 2026-04-30/i,
    )
    expect(video).toBeInTheDocument()
    expect(video.tagName).toBe('VIDEO')
    expect(video).toHaveAttribute('src', '/timelapses/2026-04-30.mp4')
  })

  it('renders a Download link per timelapse (iter-214)', async () => {
    listTimelapses.mockResolvedValue({
      items: [
        { date: '2026-04-30', url: '/timelapses/2026-04-30.mp4', size_bytes: 100 },
      ],
    })
    render(<Settings />)
    const link = await screen.findByLabelText(/download timelapse for 2026-04-30/i)
    expect(link).toHaveAttribute('href', '/timelapses/2026-04-30.mp4')
    expect(link).toHaveAttribute('download')
  })

  // iter-231 (Feature #12 OTA slice 2): Update button mirrors the
  // iter-211 Backup + iter-197 Reboot button UX. Confirm-gated;
  // surfaces server's `note` when stubbed instead of pretending
  // success.

  it('update button asks for confirmation and aborts on cancel (iter-231)', async () => {
    confirmFn.mockReset().mockResolvedValue(false)
    const user = userEvent.setup()
    render(<Settings />)
    await user.click(
      screen.getByRole('button', { name: /update server software/i }),
    )
    await waitFor(() => expect(confirmFn).toHaveBeenCalled())
    expect(confirmFn.mock.calls[0][0]).toMatchObject({
      title: expect.stringMatching(/update/i),
      destructive: true,
    })
    expect(triggerUpdate).not.toHaveBeenCalled()
  })

  it('update proceeds when confirmed and emits a toast (iter-231)', async () => {
    confirmFn.mockReset().mockResolvedValue(true)
    triggerUpdate.mockResolvedValue({ ok: true })
    const user = userEvent.setup()
    render(<Settings />)
    await user.click(
      screen.getByRole('button', { name: /update server software/i }),
    )
    await waitFor(() => expect(triggerUpdate).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.stringMatching(/update requested/i),
        'success',
      ),
    )
  })

  it('update honestly reports the stubbed-server case (iter-231)', async () => {
    confirmFn.mockReset().mockResolvedValue(true)
    triggerUpdate.mockResolvedValue({
      ok: true,
      note: 'scaffold: update is stubbed',
    })
    const user = userEvent.setup()
    render(<Settings />)
    await user.click(
      screen.getByRole('button', { name: /update server software/i }),
    )
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.stringMatching(/isn't set up yet/i),
        'info',
      ),
    )
  })

  it('update toasts an error when triggerUpdate rejects (iter-231)', async () => {
    confirmFn.mockReset().mockResolvedValue(true)
    triggerUpdate.mockRejectedValue(new Error('boom'))
    const user = userEvent.setup()
    render(<Settings />)
    await user.click(
      screen.getByRole('button', { name: /update server software/i }),
    )
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.stringMatching(/update failed/i),
        'error',
      ),
    )
  })

  it('update button hidden for viewer role (iter-231, mirrors iter-198)', async () => {
    _authUser = { username: 'kid', role: 'viewer' }
    render(<Settings />)
    await screen.findByText(/kid/)
    expect(
      screen.queryByRole('button', { name: /update server software/i }),
    ).not.toBeInTheDocument()
  })

  it('update button visible for legacy admin role (iter-231 carve-out)', async () => {
    _authUser = { username: 'alice', role: 'admin' }
    render(<Settings />)
    expect(
      await screen.findByRole('button', { name: /update server software/i }),
    ).toBeInTheDocument()
  })

  // iter-234 (Feature #12 OTA slice 3b): server version display in
  // the Account section. Em-dash while loading or on error;
  // informational only, no toast on failure.

  it('displays server version after fetch resolves (iter-234)', async () => {
    getServerVersion.mockResolvedValue({ version: '1.2.3' })
    render(<Settings />)
    await screen.findByText(/app version/i)
    expect(await screen.findByText('1.2.3')).toBeInTheDocument()
  })

  it('shows em-dash when getServerVersion rejects (iter-234)', async () => {
    getServerVersion.mockRejectedValue(new Error('network down'))
    render(<Settings />)
    await screen.findByText(/app version/i)
    // Wait for the fetch to settle. Find the em-dash inside the
    // App version Row (other rows may also use em-dash; scope by
    // the label).
    const versionRow = screen.getByText(/app version/i).closest('div')
    expect(versionRow).not.toBeNull()
    // Allow react fetch + microtask flush.
    await new Promise((r) => setTimeout(r, 0))
    expect(versionRow!.textContent).toContain('—')
    // Crucially: no toast fired on the error path.
    expect(showToast).not.toHaveBeenCalledWith(
      expect.stringMatching(/version/i),
      expect.anything(),
    )
  })

  it('fetches server version once on mount (iter-234)', async () => {
    render(<Settings />)
    await screen.findByText(/app version/i)
    expect(getServerVersion).toHaveBeenCalledTimes(1)
  })

  // iter-237 (Feature #12 OTA slice 6): inline restore-from-backup
  // form. Two-tap pattern: button reveals form; Submit triggers
  // confirm dialog → triggerRestore.

  it('shows Restore button (collapsed form) for owner by default (iter-237)', async () => {
    render(<Settings />)
    expect(
      await screen.findByRole('button', { name: /^restore from backup$/i }),
    ).toBeInTheDocument()
    // The dropdown is NOT yet rendered (lazy-fetched on form open).
    expect(
      screen.queryByLabelText(/^backup file$/i),
    ).not.toBeInTheDocument()
  })

  it('clicking Restore button opens the inline form (iter-237 + iter-239 dropdown)', async () => {
    const user = userEvent.setup()
    render(<Settings />)
    await user.click(
      await screen.findByRole('button', { name: /^restore from backup$/i }),
    )
    // iter-239: dropdown populated from listBackups (one backup in
    // beforeEach default mock).
    expect(
      await screen.findByLabelText(/^backup file$/i),
    ).toBeInTheDocument()
  })

  it('Cancel collapses the form back to button (iter-237)', async () => {
    const user = userEvent.setup()
    render(<Settings />)
    await user.click(
      await screen.findByRole('button', { name: /^restore from backup$/i }),
    )
    await user.click(
      screen.getByRole('button', { name: /cancel restore/i }),
    )
    await waitFor(() =>
      expect(
        screen.queryByLabelText(/^backup file$/i),
      ).not.toBeInTheDocument(),
    )
  })

  it('Submit confirmed → calls triggerRestore + toasts on stubbed note (iter-237)', async () => {
    // iter-239: backup pre-selected from listBackups; user just hits Submit.
    triggerRestore.mockResolvedValue({
      ok: true,
      note: 'scaffold: restore is stubbed',
      backup_path: 'snap.tar.gz',
    })
    confirmFn.mockReset().mockResolvedValue(true)
    const user = userEvent.setup()
    render(<Settings />)
    await user.click(
      await screen.findByRole('button', { name: /^restore from backup$/i }),
    )
    // Wait for backups fetch + dropdown render.
    await screen.findByLabelText(/^backup file$/i)
    await user.click(
      screen.getByRole('button', { name: /^restore from backup$/i }),
    )
    await waitFor(() => expect(triggerRestore).toHaveBeenCalledWith('snap.tar.gz'))
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.stringMatching(/isn't set up yet/i),
        'info',
      ),
    )
  })

  it('Submit cancelled by confirm dialog → no triggerRestore (iter-237)', async () => {
    confirmFn.mockReset().mockResolvedValue(false)
    const user = userEvent.setup()
    render(<Settings />)
    await user.click(
      await screen.findByRole('button', { name: /^restore from backup$/i }),
    )
    await screen.findByLabelText(/^backup file$/i)
    await user.click(
      screen.getByRole('button', { name: /^restore from backup$/i }),
    )
    await waitFor(() => expect(confirmFn).toHaveBeenCalled())
    expect(triggerRestore).not.toHaveBeenCalled()
  })

  it('Submit error path toasts the failure (iter-237)', async () => {
    triggerRestore.mockRejectedValue(new Error('boom'))
    confirmFn.mockReset().mockResolvedValue(true)
    const user = userEvent.setup()
    render(<Settings />)
    await user.click(
      await screen.findByRole('button', { name: /^restore from backup$/i }),
    )
    await screen.findByLabelText(/^backup file$/i)
    await user.click(
      screen.getByRole('button', { name: /^restore from backup$/i }),
    )
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.stringMatching(/restore failed/i),
        'error',
      ),
    )
  })

  // iter-239 (Feature #10/12 follow-up): dropdown + empty-state
  // + selection-defaulting tests.

  it('opens form → fetches backup list (iter-239)', async () => {
    const user = userEvent.setup()
    render(<Settings />)
    await user.click(
      await screen.findByRole('button', { name: /^restore from backup$/i }),
    )
    await waitFor(() => expect(listBackups).toHaveBeenCalledTimes(1))
  })

  it('dropdown populated with multiple backups, newest pre-selected (iter-239)', async () => {
    listBackups.mockResolvedValue({
      items: [
        { filename: 'newest.tar.gz', size_bytes: 200, mtime_s: 1700000200 },
        { filename: 'older.tar.gz', size_bytes: 100, mtime_s: 1700000100 },
      ],
    })
    const user = userEvent.setup()
    render(<Settings />)
    await user.click(
      await screen.findByRole('button', { name: /^restore from backup$/i }),
    )
    const select = (await screen.findByLabelText(/^backup file$/i)) as HTMLSelectElement
    expect(select.value).toBe('newest.tar.gz')
    expect(select.options).toHaveLength(2)
  })

  it('shows empty-state when no backups are available (iter-239)', async () => {
    listBackups.mockResolvedValue({ items: [] })
    const user = userEvent.setup()
    render(<Settings />)
    await user.click(
      await screen.findByRole('button', { name: /^restore from backup$/i }),
    )
    expect(
      await screen.findByLabelText(/no backups available/i),
    ).toBeInTheDocument()
    // Dropdown is NOT rendered when list is empty.
    expect(
      screen.queryByLabelText(/^backup file$/i),
    ).not.toBeInTheDocument()
    // Submit button is disabled.
    expect(
      screen.getByRole('button', { name: /^restore from backup$/i }),
    ).toBeDisabled()
  })

  it('listBackups error treated as empty-state (iter-239)', async () => {
    listBackups.mockRejectedValue(new Error('network down'))
    const user = userEvent.setup()
    render(<Settings />)
    await user.click(
      await screen.findByRole('button', { name: /^restore from backup$/i }),
    )
    expect(
      await screen.findByLabelText(/no backups available/i),
    ).toBeInTheDocument()
  })

  it('Restore button hidden for viewer role (iter-237)', async () => {
    _authUser = { username: 'kid', role: 'viewer' }
    render(<Settings />)
    await screen.findByText(/kid/)
    expect(
      screen.queryByRole('button', { name: /^restore from backup$/i }),
    ).not.toBeInTheDocument()
  })

  // iter-266: ManageUsersPanel UI coverage. BDD-lite (Given/When/Then
  // names + AAA bodies) per CLAUDE.md tests-as-contract section.

  it('given an owner mounts settings, when manage users panel renders, then existing users appear', async () => {
    // arrange
    adminListUsers.mockResolvedValue({
      users: [
        { username: 'Israel', role: 'owner', created_at: 1714000000 },
        { username: 'Babage', role: 'family', created_at: 1714000100 },
      ],
    })

    // act
    render(<Settings />)

    // assert
    await screen.findByRole('list', { name: /user accounts/i })
    expect(screen.getByText('Israel')).toBeInTheDocument()
    expect(screen.getByText('Babage')).toBeInTheDocument()
    // Role chip is rendered too.
    expect(screen.getByText('owner')).toBeInTheDocument()
    expect(screen.getByText('family')).toBeInTheDocument()
  })

  it('given a viewer mounts settings, when the page renders, then the manage users panel is hidden', async () => {
    // arrange
    _authUser = { username: 'kid', role: 'viewer' }

    // act
    render(<Settings />)
    await screen.findByText(/kid/)

    // assert
    expect(screen.queryByText(/manage users/i)).not.toBeInTheDocument()
  })

  it('given the owner submits a valid add-user form, when create succeeds, then adminCreateUser is called and list refreshes', async () => {
    // arrange
    adminCreateUser.mockResolvedValueOnce({
      ok: true,
      username: 'NewKid',
      role: 'family',
    })
    // First refresh on mount returns one user; the post-create refetch
    // must observe the new user.
    adminListUsers
      .mockResolvedValueOnce({
        users: [{ username: 'Israel', role: 'owner', created_at: 1 }],
      })
      .mockResolvedValueOnce({
        users: [
          { username: 'Israel', role: 'owner', created_at: 1 },
          { username: 'NewKid', role: 'family', created_at: 2 },
        ],
      })
    const user = userEvent.setup()
    render(<Settings />)
    await screen.findByRole('list', { name: /user accounts/i })

    // act
    await user.click(screen.getByRole('button', { name: /^add user$/i }))
    await user.type(screen.getByLabelText(/^new username$/i), 'NewKid')
    await user.type(screen.getByLabelText(/^new user password$/i), 'kidpass1')
    // Default role is "family" — no select change needed.
    await user.click(screen.getByRole('button', { name: /^create user$/i }))

    // assert
    await waitFor(() =>
      expect(adminCreateUser).toHaveBeenCalledWith('NewKid', 'kidpass1', 'family'),
    )
    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining('Created NewKid'),
      'success',
    )
    expect(await screen.findByText('NewKid')).toBeInTheDocument()
  })

  it('given the owner submits a short password in add-user, when validate runs, then no API call and an error toast', async () => {
    // arrange
    const user = userEvent.setup()
    render(<Settings />)
    await screen.findByRole('list', { name: /user accounts/i })

    // act
    await user.click(screen.getByRole('button', { name: /^add user$/i }))
    await user.type(screen.getByLabelText(/^new username$/i), 'tiny')
    await user.type(screen.getByLabelText(/^new user password$/i), 'abc') // <8

    // The button is disabled-on-empty but enabled on any non-empty
    // password — the 8-char floor is enforced inline at submit time.
    await user.click(screen.getByRole('button', { name: /^create user$/i }))

    // assert
    expect(adminCreateUser).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith(
      'Password must be at least 8 characters',
      'error',
    )
  })

  it('given add-user returns 409 conflict, when the owner submits, then a friendly "already taken" toast', async () => {
    // arrange — iter-279 (code-scalability-auditor T2): the
    // production code path throws HttpError for non-2xx responses
    // (lib/api.ts::req). Pre-iter-279 the test used a plain
    // `Error` with `.status` because the consumer's status check
    // was a structural cast; iter-279 tightened it to
    // `e instanceof HttpError`. Rejecting with a real HttpError
    // mirrors prod and unblocks the new instanceof check.
    const { HttpError } = await import('../lib/api')
    const conflictError = new HttpError(
      '/api/auth/admin/users',
      409,
      ': username already exists',
    )
    adminCreateUser.mockRejectedValueOnce(conflictError)
    const user = userEvent.setup()
    render(<Settings />)
    await screen.findByRole('list', { name: /user accounts/i })

    // act
    await user.click(screen.getByRole('button', { name: /^add user$/i }))
    await user.type(screen.getByLabelText(/^new username$/i), 'Israel')
    await user.type(screen.getByLabelText(/^new user password$/i), 'taken123')
    await user.click(screen.getByRole('button', { name: /^create user$/i }))

    // assert
    await waitFor(() => expect(adminCreateUser).toHaveBeenCalled())
    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining('already taken'),
      'error',
    )
  })

  it('given the owner inline-resets a password, when valid 8-char value submitted, then adminResetPassword is called', async () => {
    // arrange
    adminListUsers.mockResolvedValueOnce({
      users: [
        { username: 'Israel', role: 'owner', created_at: 1 },
        { username: 'Babage', role: 'family', created_at: 2 },
      ],
    })
    const user = userEvent.setup()
    render(<Settings />)
    await screen.findByText('Babage')

    // act
    // Two "Reset password" buttons — one per row. Pick Babage's by
    // scoping to the row.
    const babageRow = screen.getByText('Babage').closest('li')
    expect(babageRow).not.toBeNull()
    await user.click(
      screen.getAllByRole('button', { name: /^set new password$/i })[1],
    )
    await user.type(
      screen.getByLabelText(/^new password for babage$/i),
      'fresh8chars',
    )
    await user.click(screen.getByRole('button', { name: /^save$/i }))

    // assert
    await waitFor(() =>
      expect(adminResetPassword).toHaveBeenCalledWith('Babage', 'fresh8chars'),
    )
    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining('Reset password for Babage'),
      'success',
    )
  })

  it('given a short password on inline reset, when submit, then error toast and no API call', async () => {
    // arrange
    adminListUsers.mockResolvedValueOnce({
      users: [
        { username: 'Israel', role: 'owner', created_at: 1 },
        { username: 'Babage', role: 'family', created_at: 2 },
      ],
    })
    const user = userEvent.setup()
    render(<Settings />)
    await screen.findByText('Babage')

    // act
    await user.click(
      screen.getAllByRole('button', { name: /^set new password$/i })[1],
    )
    await user.type(
      screen.getByLabelText(/^new password for babage$/i),
      'tiny',
    )
    await user.click(screen.getByRole('button', { name: /^save$/i }))

    // assert
    expect(adminResetPassword).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith(
      'Password must be at least 8 characters',
      'error',
    )
  })

  it('given owner clicks delete and confirms, when delete succeeds, then adminDeleteUser is called', async () => {
    // arrange
    adminListUsers
      .mockResolvedValueOnce({
        users: [
          { username: 'Israel', role: 'owner', created_at: 1 },
          { username: 'Babage', role: 'family', created_at: 2 },
        ],
      })
      .mockResolvedValueOnce({
        users: [{ username: 'Israel', role: 'owner', created_at: 1 }],
      })
    confirmFn.mockResolvedValueOnce(true)
    const user = userEvent.setup()
    render(<Settings />)
    await screen.findByText('Babage')

    // act
    // Two Delete buttons (Israel = self disabled, Babage = enabled).
    const deleteButtons = screen.getAllByRole('button', { name: /^delete$/i })
    // The enabled one is Babage (Israel is the owner = self).
    const enabled = deleteButtons.find((b) => !(b as HTMLButtonElement).disabled)
    expect(enabled).toBeDefined()
    await user.click(enabled!)

    // assert
    await waitFor(() => expect(adminDeleteUser).toHaveBeenCalledWith('Babage'))
    expect(confirmFn).toHaveBeenCalledWith(
      expect.objectContaining({ destructive: true }),
    )
  })

  it('given owner clicks delete and cancels, when confirm rejects, then no API call', async () => {
    // arrange
    adminListUsers.mockResolvedValueOnce({
      users: [
        { username: 'Israel', role: 'owner', created_at: 1 },
        { username: 'Babage', role: 'family', created_at: 2 },
      ],
    })
    confirmFn.mockResolvedValueOnce(false)
    const user = userEvent.setup()
    render(<Settings />)
    await screen.findByText('Babage')

    // act
    const deleteButtons = screen.getAllByRole('button', { name: /^delete$/i })
    const enabled = deleteButtons.find((b) => !(b as HTMLButtonElement).disabled)
    await user.click(enabled!)

    // assert
    expect(adminDeleteUser).not.toHaveBeenCalled()
  })

  it('given the last owner is the current user, when the panel renders, then their delete button is disabled', async () => {
    // arrange
    adminListUsers.mockResolvedValueOnce({
      users: [
        { username: 'alice', role: 'admin', created_at: 1 }, // current user
        { username: 'Babage', role: 'family', created_at: 2 },
      ],
    })

    // act
    render(<Settings />)
    await screen.findByText('alice')

    // assert
    const deleteButtons = screen.getAllByRole('button', { name: /^delete$/i })
    // alice is BOTH the only owner AND the current user → disabled.
    const aliceButton = deleteButtons.find((b) =>
      b.getAttribute('title')?.toLowerCase().includes("can't delete"),
    )
    expect(aliceButton).toBeDefined()
    expect(aliceButton).toBeDisabled()
  })

  it('given adminListUsers fails on mount, when the panel renders, then a load-error message is shown', async () => {
    // arrange
    adminListUsers.mockRejectedValueOnce(
      Object.assign(new Error('network'), { status: 500 }),
    )

    // act
    render(<Settings />)

    // assert
    expect(
      await screen.findByText(/could not load users/i),
    ).toBeInTheDocument()
  })

  // iter-278: 3-tab IA. BDD-lite naming, AAA structure.

  it('given owner mounts settings, when the page renders, then the tab strip lists Detection, Notifications, Account & System (iter-356.19 Frank Round-8 #4)', async () => {
    // arrange — iter-356.19 (Frank Round-8 #4): for OWNERS the
    // tab label is "Account & System" so the dangerous half of the
    // tab body (Reboot/Backup/Restore/Update) isn't hidden behind
    // the word "Account". Viewers still see plain "Account".
    _authUser = { username: 'alice', role: 'admin' }

    // act
    render(<Settings />)
    await screen.findByRole('tablist', { name: /settings sections/i })

    // assert
    expect(
      screen.getByRole('tab', { name: /^detection$/i }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('tab', { name: /^notifications$/i }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('tab', { name: /account & system/i }),
    ).toBeInTheDocument()
  })

  it('given a viewer role, when the page renders, then the Detection tab is omitted and System reads "Account" (iter-279)', async () => {
    // arrange
    _authUser = { username: 'kid', role: 'viewer' }

    // act
    render(<Settings />)
    await screen.findByText(/kid/)

    // assert: the Detection tab — owner-only knobs — is hidden so a
    // non-owner doesn't see a tab whose body is empty for them.
    expect(
      screen.queryByRole('tab', { name: /^detection$/i }),
    ).not.toBeInTheDocument()
    // Notifications + Account ("System" tab renamed for non-owners
    // per ux-grandpa #1 — viewer's tab body is just account stuff).
    expect(
      screen.getByRole('tab', { name: /^notifications$/i }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('tab', { name: /^account$/i }),
    ).toBeInTheDocument()
    // iter-355ac: both roles now use the same "Account" label.
    // No-op pin kept for the role-equivalence assertion.
  })

  it('given owner clicks the Account & System tab, when the click handler fires, then the active tab is persisted to localStorage (iter-279/356.19)', async () => {
    // arrange — iter-356.19: owner label is "Account & System".
    // Storage key is STILL the canonical 'system' string — only the
    // user-visible label changed.
    _authUser = { username: 'alice', role: 'admin' }
    window.localStorage.removeItem('homecam:settingsTab')
    const user = userEvent.setup()
    render(<Settings />)
    await screen.findByRole('tablist', { name: /settings sections/i })

    // act
    await user.click(screen.getByRole('tab', { name: /account & system/i }))

    // assert
    expect(window.localStorage.getItem('homecam:settingsTab')).toBe('system')
    expect(screen.getByRole('tab', { name: /account & system/i })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  })

  it('given owner first-visit (no localStorage), when settings mounts, then Notifications is the active tab (iter-279 ux-grandpa #2)', async () => {
    // arrange
    _authUser = { username: 'alice', role: 'admin' }
    window.localStorage.removeItem('homecam:settingsTab')

    // act
    render(<Settings />)
    await screen.findByRole('tablist', { name: /settings sections/i })

    // assert: pre-iter-279 the default for owners was 'camera';
    // Frank pointed out 90% of Settings visits are turn-push-on /
    // send-test / sign-out, all under Notifications. Default
    // landing should be Notifications regardless of role.
    expect(
      screen.getByRole('tab', { name: /^notifications$/i }),
    ).toHaveAttribute('aria-selected', 'true')
  })

  // iter-281 (test-coverage gap #5): localStorage corruption
  // tolerance. A non-tab string in localStorage falls through to
  // the iter-279 'notifications' default; pin so a future malformed
  // value (browser version drift, manual tinkering) doesn't crash.

  it('given localStorage holds a non-tab string, when settings mounts, then Notifications is the active tab (iter-281)', async () => {
    // arrange
    _authUser = { username: 'alice', role: 'admin' }
    window.localStorage.setItem('homecam:settingsTab', 'banana')

    // act
    render(<Settings />)
    await screen.findByRole('tablist', { name: /settings sections/i })

    // assert: corrupt value treated as "no preference" → fall to
    // iter-279 first-visit default of Notifications.
    expect(
      screen.getByRole('tab', { name: /^notifications$/i }),
    ).toHaveAttribute('aria-selected', 'true')
  })

  // iter-281 (test-coverage gap #6): viewer with stored 'camera'
  // value from a prior owner session. Derived clamp drops them to
  // Notifications without erasing the stored value (per iter-278
  // pure-derivation refactor).

  it('given a viewer with localStorage="camera" from a prior owner session, when settings mounts, then the Detection tab is hidden and Notifications is active (iter-281)', async () => {
    // arrange: this user was the owner once; they got demoted to
    // viewer (via admin reset_role in a future iter, or an admin
    // demo). Their browser's localStorage still says 'camera'.
    _authUser = { username: 'kid', role: 'viewer' }
    window.localStorage.setItem('homecam:settingsTab', 'camera')

    // act
    render(<Settings />)
    await screen.findByText(/kid/)

    // assert: Detection tab is hidden (owner-only); active tab is
    // clamped to Notifications via pure derivation. localStorage
    // value is NOT auto-rewritten — that's intentional per iter-278
    // (the user might be re-promoted; if so, their preference
    // survives).
    expect(
      screen.queryByRole('tab', { name: /^detection$/i }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('tab', { name: /^notifications$/i }),
    ).toHaveAttribute('aria-selected', 'true')
    expect(window.localStorage.getItem('homecam:settingsTab')).toBe('camera')
  })
})
