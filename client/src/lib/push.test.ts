import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./api', () => ({
  getVapidPublicKey: vi.fn(),
  subscribePush: vi.fn(),
  sendTestPushReq: vi.fn(),
  unsubscribePush: vi.fn(),
}))

import {
  getVapidPublicKey,
  sendTestPushReq,
  subscribePush,
  unsubscribePush,
} from './api'
import {
  disablePushSubscription,
  ensurePushSubscription,
  getPushState,
  pushSupported,
  sendTestPush,
} from './push'

type SubscribeOptions = {
  userVisibleOnly: boolean
  applicationServerKey: BufferSource
}

interface TestPushManager {
  getSubscription: ReturnType<typeof vi.fn>
  subscribe: ReturnType<typeof vi.fn>
}

interface TestRegistration {
  pushManager: TestPushManager
}

describe('lib/push', () => {
  let currentSub: PushSubscription | null
  let reg: TestRegistration

  beforeEach(() => {
    currentSub = null
    reg = {
      pushManager: {
        getSubscription: vi.fn(async () => currentSub),
        subscribe: vi.fn(async (_opts: SubscribeOptions) => {
          currentSub = {
            endpoint: 'https://push.example/abc',
            toJSON: () => ({ endpoint: 'https://push.example/abc' }),
          } as unknown as PushSubscription
          return currentSub
        }),
      },
    }

    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { ready: Promise.resolve(reg as unknown as ServiceWorkerRegistration) },
    })
    vi.stubGlobal(
      'PushManager',
      function PushManager() {} as unknown as typeof PushManager,
    )
    vi.stubGlobal('Notification', {
      requestPermission: vi.fn(async () => 'granted' as NotificationPermission),
    })

    vi.mocked(getVapidPublicKey).mockResolvedValue({ key: 'BPubBase64' })
    vi.mocked(subscribePush).mockResolvedValue({ ok: true })
    vi.mocked(sendTestPushReq).mockResolvedValue({ ok: true, sent: 1 })
    vi.mocked(unsubscribePush).mockResolvedValue({ ok: true })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('pushSupported returns true when serviceWorker and PushManager are present', () => {
    expect(pushSupported()).toBe(true)
  })

  it('getPushState returns false when no subscription exists', async () => {
    expect(await getPushState()).toBe(false)
  })

  it('getPushState returns true when a subscription exists', async () => {
    currentSub = { endpoint: 'x' } as PushSubscription
    expect(await getPushState()).toBe(true)
  })

  it('ensurePushSubscription bails out when permission is denied', async () => {
    ;(Notification.requestPermission as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      'denied',
    )
    const ok = await ensurePushSubscription()
    expect(ok).toBe(false)
    expect(reg.pushManager.subscribe).not.toHaveBeenCalled()
    expect(subscribePush).not.toHaveBeenCalled()
  })

  it('ensurePushSubscription subscribes and posts to server when permission granted', async () => {
    const ok = await ensurePushSubscription()
    expect(ok).toBe(true)
    expect(reg.pushManager.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ userVisibleOnly: true }),
    )
    expect(subscribePush).toHaveBeenCalledTimes(1)
  })

  it('ensurePushSubscription reuses an existing browser subscription', async () => {
    const existing = {
      endpoint: 'existing',
      toJSON: () => ({ endpoint: 'existing' }),
    } as unknown as PushSubscription
    currentSub = existing
    const ok = await ensurePushSubscription()
    expect(ok).toBe(true)
    expect(reg.pushManager.subscribe).not.toHaveBeenCalled()
    expect(subscribePush).toHaveBeenCalledWith(existing)
  })

  it('sendTestPush hits the API and returns the count', async () => {
    vi.mocked(sendTestPushReq).mockResolvedValue({ ok: true, sent: 3 })
    const sent = await sendTestPush()
    expect(sendTestPushReq).toHaveBeenCalledTimes(1)
    expect(sent).toBe(3)
  })

  it('sendTestPush returns 0 when no subscriptions are reachable', async () => {
    vi.mocked(sendTestPushReq).mockResolvedValue({ ok: true, sent: 0 })
    const sent = await sendTestPush()
    expect(sent).toBe(0)
  })

  it('sendTestPush coerces a missing `sent` field to 0', async () => {
    // Older deploys / a malformed response could omit `sent`. The
    // helper treats it as zero so the caller's "no reachable" branch
    // fires instead of rendering "undefined devices".
    vi.mocked(sendTestPushReq).mockResolvedValue(
      { ok: true } as unknown as { ok: boolean; sent: number },
    )
    const sent = await sendTestPush()
    expect(sent).toBe(0)
  })

  it('disablePushSubscription invalidates the browser sub and POSTs to the server', async () => {
    const localUnsub = vi.fn(async () => true)
    currentSub = {
      endpoint: 'https://push.example/known',
      unsubscribe: localUnsub,
      toJSON: () => ({ endpoint: 'https://push.example/known' }),
    } as unknown as PushSubscription
    await disablePushSubscription()
    expect(localUnsub).toHaveBeenCalledTimes(1)
    expect(unsubscribePush).toHaveBeenCalledWith('https://push.example/known')
  })

  it('disablePushSubscription is a no-op when there is no subscription', async () => {
    currentSub = null
    await disablePushSubscription()
    expect(unsubscribePush).not.toHaveBeenCalled()
  })

  it('disablePushSubscription swallows server errors so the UI still progresses', async () => {
    // The browser-side unsubscribe already succeeded by the time we POST
    // to the server; if the server is unreachable the user-visible state
    // is still "push disabled". Eventual cleanup happens on next 410.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(unsubscribePush).mockRejectedValueOnce(new Error('network down'))
    currentSub = {
      endpoint: 'https://push.example/oops',
      unsubscribe: vi.fn(async () => true),
      toJSON: () => ({ endpoint: 'https://push.example/oops' }),
    } as unknown as PushSubscription
    await expect(disablePushSubscription()).resolves.toBeUndefined()
    warn.mockRestore()
  })

  // docs/logging_plan.md §2 (push.ts) + §4 guardrails.
  describe('failure-point logging', () => {
    it('Given permission is denied, When ensurePushSubscription runs, Then it logs the enable-failure step (no longer a bare false)', async () => {
      // arrange
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      ;(
        Notification.requestPermission as unknown as ReturnType<typeof vi.fn>
      ).mockResolvedValue('denied')

      // act
      const ok = await ensurePushSubscription()

      // assert — reason captured with the step + permission.
      expect(ok).toBe(false)
      expect(errorSpy).toHaveBeenCalledWith(
        '[push:enable-failed]',
        expect.objectContaining({ step: 'permission', permission: 'denied' }),
      )
    })

    it('Given the server-persist step rejects, When ensurePushSubscription runs, Then it logs the step + endpoint HOST (NOT the secret tail) and re-throws', async () => {
      // arrange — subscribe succeeds, server persist fails.
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.mocked(subscribePush).mockRejectedValueOnce(
        Object.assign(new Error('persist failed'), { status: 500 }),
      )

      // act / assert — the chain re-throws so the caller still surfaces it.
      await expect(ensurePushSubscription()).rejects.toThrow(/persist failed/)
      expect(errorSpy).toHaveBeenCalledWith(
        '[push:enable-failed]',
        expect.objectContaining({
          step: 'server-persist',
          endpointHost: 'push.example',
          status: 500,
        }),
      )
      // assert — the opaque endpoint secret tail (/abc) is NOT logged.
      const persistCall = errorSpy.mock.calls.find(
        (c) =>
          c[0] === '[push:enable-failed]' &&
          (c[1] as { step?: string })?.step === 'server-persist',
      )
      expect(JSON.stringify(persistCall)).not.toContain('/abc')
    })

    it('Given the server-side unsubscribe rejects, When disablePushSubscription runs, Then it logs a warn with the endpoint HOST only', async () => {
      // arrange
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.mocked(unsubscribePush).mockRejectedValueOnce(
        Object.assign(new Error('down'), { status: 503 }),
      )
      currentSub = {
        endpoint: 'https://fcm.googleapis.com/secret-tail-xyz',
        unsubscribe: vi.fn(async () => true),
        toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/secret-tail-xyz' }),
      } as unknown as PushSubscription

      // act
      await disablePushSubscription()

      // assert — host logged, secret path tail NOT logged.
      expect(warnSpy).toHaveBeenCalledWith(
        '[push:server-unsubscribe-failed]',
        expect.objectContaining({ endpointHost: 'fcm.googleapis.com', status: 503 }),
      )
      const call = warnSpy.mock.calls.find(
        (c) => c[0] === '[push:server-unsubscribe-failed]',
      )
      expect(JSON.stringify(call)).not.toContain('secret-tail-xyz')
    })
  })
})
