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

vi.mock('../../lib/api', () => ({
  getMyPushFilters: (...a: unknown[]) => getMyPushFilters(...a),
  getKnownFilterOptions: (...a: unknown[]) => getKnownFilterOptions(...a),
  setMyPushFilters: (...a: unknown[]) => setMyPushFilters(...a),
}))

const showToast = vi.fn()
vi.mock('../../lib/toast', () => ({
  useToast: () => ({ showToast }),
}))

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
