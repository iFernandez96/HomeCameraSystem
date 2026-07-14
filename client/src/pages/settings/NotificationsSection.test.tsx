import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'

// iter-356.C (mobile-redesign Slice C — security clarity): when the
// browser's notification permission is revoked while the app is
// open, the Settings → Notifications panel must surface a banner
// (role=alert) and disable the toggle. Pre-356.C the toggle stayed
// in its last-known state and every togglePush() silently failed.

const ensurePushSubscription = vi.fn().mockResolvedValue(true)
const disablePushSubscription = vi.fn().mockResolvedValue(undefined)
const getPushState = vi.fn().mockResolvedValue(false)
const pushSupported = vi.fn().mockReturnValue(true)
const sendTestPush = vi.fn().mockResolvedValue(0)

vi.mock('../../lib/push', () => ({
  ensurePushSubscription: (...a: unknown[]) => ensurePushSubscription(...a),
  disablePushSubscription: (...a: unknown[]) => disablePushSubscription(...a),
  getPushState: (...a: unknown[]) => getPushState(...a),
  pushSupported: (...a: unknown[]) => pushSupported(...a),
  sendTestPush: (...a: unknown[]) => sendTestPush(...a),
}))

const getMyPushFilters = vi.fn().mockResolvedValue({ filters: null })
const getKnownFilterOptions = vi
  .fn()
  .mockResolvedValue({ cameras: [], person_names: [] })
const setMyPushFilters = vi.fn().mockResolvedValue(undefined)
const getNotificationInbox = vi.fn().mockResolvedValue({ v: 1, items: [], unread: 0 })
const createIncident = vi.fn()
const addIncidentEvents = vi.fn()
const markNotificationSeen = vi.fn().mockResolvedValue({ seen: true })
const snoozeNotification = vi.fn().mockResolvedValue({ kind: 'event', snoozed_until: 0 })
const retainNotificationEvent = vi.fn().mockResolvedValue({ event_id: 'event', retention_class: 'permanent' })

vi.mock('../../lib/api', () => ({
  getMyPushFilters: (...a: unknown[]) => getMyPushFilters(...a),
  getKnownFilterOptions: (...a: unknown[]) => getKnownFilterOptions(...a),
  setMyPushFilters: (...a: unknown[]) => setMyPushFilters(...a),
  getNotificationInbox: (...a: unknown[]) => getNotificationInbox(...a),
  createIncident: (...a: unknown[]) => createIncident(...a),
  addIncidentEvents: (...a: unknown[]) => addIncidentEvents(...a),
  markNotificationSeen: (...a: unknown[]) => markNotificationSeen(...a),
  snoozeNotification: (...a: unknown[]) => snoozeNotification(...a),
  retainNotificationEvent: (...a: unknown[]) => retainNotificationEvent(...a),
}))

const showToast = vi.fn()
// useReportError mirrors the real pairing (log.error + error toast).
// Under vitest (MODE === 'test') lib/log ship() is disabled, so
// log.error only hits console.error — observed via spy in the tests.
vi.mock('../../lib/toast', async () => {
  const { log } = await vi.importActual<typeof import('../../lib/log')>(
    '../../lib/log',
  )
  return {
    useToast: () => ({ showToast }),
    useReportError:
      () =>
      (event: string, message: string, fields: Record<string, unknown> = {}) => {
        log.error(event, fields)
        showToast(message, 'error')
      },
  }
})

import { NotificationsSection } from './NotificationsSection'

// Permissions API mock — a tiny EventTarget-flavored stub that the
// listener can subscribe to and we can fire `change` against.
type Listener = () => void
type FakeStatus = {
  state: PermissionState
  addEventListener: (ev: 'change', l: Listener) => void
  removeEventListener: (ev: 'change', l: Listener) => void
  fire: () => void
}
function makeFakeStatus(state: PermissionState): FakeStatus {
  const ls: Listener[] = []
  return {
    state,
    addEventListener: (_ev, l) => ls.push(l),
    removeEventListener: (_ev, l) => {
      const i = ls.indexOf(l)
      if (i >= 0) ls.splice(i, 1)
    },
    fire: () => {
      for (const l of ls) l()
    },
  }
}

let fakeStatus: FakeStatus
let originalPermissions: typeof navigator.permissions | undefined
let originalNotificationPermission: NotificationPermission

function setNotificationPermission(v: NotificationPermission) {
  // Notification.permission is a getter on the constructor; redefine.
  Object.defineProperty(globalThis.Notification, 'permission', {
    configurable: true,
    get: () => v,
  })
}

beforeEach(() => {
  // Provide a Notification global if jsdom doesn't have one.
  if (typeof globalThis.Notification === 'undefined') {
    ;(globalThis as unknown as { Notification: unknown }).Notification =
      function () {} as unknown as typeof Notification
  }
  originalNotificationPermission = globalThis.Notification.permission
  setNotificationPermission('granted')

  fakeStatus = makeFakeStatus('granted')
  originalPermissions = navigator.permissions
  Object.defineProperty(navigator, 'permissions', {
    configurable: true,
    value: {
      query: vi.fn().mockResolvedValue(fakeStatus),
    },
  })

  ensurePushSubscription.mockClear().mockResolvedValue(true)
  disablePushSubscription.mockClear().mockResolvedValue(undefined)
  getPushState.mockClear().mockResolvedValue(false)
  pushSupported.mockClear().mockReturnValue(true)
  showToast.mockClear()
})

afterEach(() => {
  setNotificationPermission(originalNotificationPermission)
  if (originalPermissions !== undefined) {
    Object.defineProperty(navigator, 'permissions', {
      configurable: true,
      value: originalPermissions,
    })
  }
})

describe('NotificationsSection — push permission revocation (iter-356.C)', () => {
  it('given permission revoked at runtime, when permissionchange fires, then banner appears + toggle disables', async () => {
    // arrange
    render(<NotificationsSection pushSubsCount={0} />)
    // wait for the permissions.query() promise to settle so the
    // listener is wired before we fire `change`.
    await waitFor(() =>
      expect(
        (navigator.permissions as unknown as { query: ReturnType<typeof vi.fn> })
          .query,
      ).toHaveBeenCalled(),
    )

    // act — flip the OS-level permission and fire the change event.
    setNotificationPermission('denied')
    fakeStatus.state = 'denied'
    await act(async () => {
      fakeStatus.fire()
    })

    // assert
    await waitFor(() => {
      expect(
        screen.getByRole('alert'),
      ).toHaveTextContent(/browser blocked homecam alerts/i)
    })
    const toggle = screen.getByLabelText(/enable push notifications/i)
    expect(toggle).toBeDisabled()
  })

  it('given permission already denied at mount, when rendered, then banner is present immediately', async () => {
    // arrange
    setNotificationPermission('denied')
    fakeStatus = makeFakeStatus('denied')
    Object.defineProperty(navigator, 'permissions', {
      configurable: true,
      value: { query: vi.fn().mockResolvedValue(fakeStatus) },
    })

    // act
    render(<NotificationsSection pushSubsCount={0} />)

    // assert
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        /browser blocked homecam alerts/i,
      ),
    )
    expect(screen.getByLabelText(/enable push notifications/i)).toBeDisabled()
  })

  it('given permission stays granted, when rendered, then no banner', async () => {
    // arrange + act
    render(<NotificationsSection pushSubsCount={0} />)

    // wait for any async listener wiring
    await waitFor(() =>
      expect(
        (navigator.permissions as unknown as { query: ReturnType<typeof vi.fn> })
          .query,
      ).toHaveBeenCalled(),
    )

    // assert
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('NotificationsSection — permission-denied recovery disclosure (premium-launch slice — Frank top-3 #1)', () => {
  beforeEach(() => {
    setNotificationPermission('denied')
    fakeStatus = makeFakeStatus('denied')
    Object.defineProperty(navigator, 'permissions', {
      configurable: true,
      value: { query: vi.fn().mockResolvedValue(fakeStatus) },
    })
  })

  it('Given permission is denied, When the banner renders, Then a "How do I re-enable alerts?" disclosure summary is present (no longer a dead-end one-liner)', async () => {
    // arrange — Frank top-3 #1: pre-fix the banner said only
    // "Re-enable in your device settings, then reload" — a
    // dead-end. Now the banner expands into platform-aware
    // recovery steps.
    render(<NotificationsSection pushSubsCount={0} />)

    // assert — disclosure summary is present.
    await waitFor(() =>
      expect(
        screen.getByText(/how do i re-enable alerts\?/i),
      ).toBeInTheDocument(),
    )
  })

  it('Given the disclosure expands, When the user reads, Then it covers iPhone, Android, and computer paths so a non-technical user can recover without external help', async () => {
    // arrange / act — render in denied state. The <details>
    // contents render in jsdom regardless of the open attribute
    // (jsdom doesn't gate visibility on it), so the platform
    // headings are queryable.
    render(<NotificationsSection pushSubsCount={0} />)

    // assert — three platform-specific headings.
    await waitFor(() =>
      expect(screen.getByText(/^On iPhone or iPad$/)).toBeInTheDocument(),
    )
    expect(screen.getByText(/^On Android$/)).toBeInTheDocument()
    expect(screen.getByText(/^On a computer$/)).toBeInTheDocument()
  })

  it('Given the disclosure renders, When the user looks for instruction lists, Then each platform section has an ordered list of recovery steps (no platform stranded with vague advice)', async () => {
    // arrange / act
    const { container } = render(<NotificationsSection pushSubsCount={0} />)

    // assert — disclosure has at least 3 ordered lists, one per
    // platform, with at least one step each.
    await waitFor(() =>
      expect(
        screen.getByText(/how do i re-enable alerts\?/i),
      ).toBeInTheDocument(),
    )
    const banner = container.querySelector('[role="alert"]')!
    const ols = banner.querySelectorAll('ol')
    expect(ols.length).toBe(3)
    for (const ol of ols) {
      expect(ol.querySelectorAll('li').length).toBeGreaterThanOrEqual(2)
    }
  })

  it('Given the headline renders, When the role="alert" element is queried, Then it still contains "Browser blocked HomeCam alerts" so existing AT and pinned tests keep working', async () => {
    // arrange / act
    render(<NotificationsSection pushSubsCount={0} />)

    // assert — preservation sentinel: the slice expanded the
    // banner with a disclosure but the role="alert" headline is
    // unchanged so iter-356.C contract holds. Existing tests
    // earlier in this file pin this exact substring.
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        /browser blocked homecam alerts/i,
      ),
    )
  })

  it('Given the disclosure renders, When the user reads recovery copy, Then "Re-enable in your device settings, then reload." dead-end copy is GONE (regression sentinel for the slice)', async () => {
    // arrange / act
    render(<NotificationsSection pushSubsCount={0} />)

    // assert — old text removed.
    await waitFor(() =>
      expect(
        screen.getByText(/how do i re-enable alerts\?/i),
      ).toBeInTheDocument(),
    )
    expect(
      screen.queryByText(/re-enable in your device settings, then reload/i),
    ).not.toBeInTheDocument()
  })
})

describe('NotificationsSection — filter-load 5xx logging (docs/logging_plan.md §2)', () => {
  // The filter load only fires when push is enabled. The catch falls
  // back to empty pickers, and a subsequent Save would WIPE the user's
  // real server-side filters. A 5xx is therefore a load FAILURE
  // masquerading as "no filters" — it must log WARN. A 404 is the
  // legitimate "no subs yet" case and must NOT log.

  beforeEach(() => {
    // Enable push so the filter-load effect runs.
    getPushState.mockResolvedValue(true)
    getKnownFilterOptions
      .mockReset()
      .mockResolvedValue({ cameras: [], person_names: [] })
  })

  it('Given push is enabled, When getMyPushFilters rejects with a 5xx, Then a warn log records the status (so the operator sees a masked load failure)', async () => {
    // arrange
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const err = Object.assign(new Error('server error'), { status: 503 })
    getMyPushFilters.mockReset().mockRejectedValue(err)

    // act
    render(<NotificationsSection pushSubsCount={1} />)

    // assert — the 5xx is logged, not silently masked as "no filters".
    await waitFor(() =>
      expect(warnSpy).toHaveBeenCalledWith(
        '[notifications:filter-load-5xx]',
        expect.objectContaining({ status: 503 }),
      ),
    )
  })

  it('Given push is enabled, When getMyPushFilters rejects with a 404, Then NO 5xx warn fires (legitimate no-subs case stays quiet)', async () => {
    // arrange
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const err = Object.assign(new Error('not found'), { status: 404 })
    getMyPushFilters.mockReset().mockRejectedValue(err)

    // act — let the effect settle by waiting for the filters UI to
    // render its clean-slate pickers.
    render(<NotificationsSection pushSubsCount={1} />)
    await waitFor(() =>
      expect(getMyPushFilters).toHaveBeenCalled(),
    )

    // assert — the masquerade warning is reserved for 5xx only.
    expect(warnSpy).not.toHaveBeenCalledWith(
      '[notifications:filter-load-5xx]',
      expect.anything(),
    )
  })
})
