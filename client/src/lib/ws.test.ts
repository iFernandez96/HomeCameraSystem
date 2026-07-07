import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerEvent } from './types'

type Listener = (e: unknown) => void

class MockWebSocket {
  static CONNECTING = 0 as const
  static OPEN = 1 as const
  static CLOSING = 2 as const
  static CLOSED = 3 as const
  static instances: MockWebSocket[] = []

  url: string
  readyState: number = MockWebSocket.CONNECTING
  listeners: Record<string, Listener[]> = {}

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }

  addEventListener(t: string, cb: Listener) {
    ;(this.listeners[t] ??= []).push(cb)
  }
  removeEventListener(t: string, cb: Listener) {
    this.listeners[t] = (this.listeners[t] ?? []).filter((f) => f !== cb)
  }
  close() {
    this.readyState = MockWebSocket.CLOSED
    this.fire('close', {})
  }
  fire(t: string, ev: unknown) {
    ;(this.listeners[t] ?? []).slice().forEach((f) => f(ev))
  }
}

const detectionEvent: ServerEvent = {
  v: 1,
  type: 'detection',
  id: 'x',
  ts: 0,
  camera_id: 'cam',
  label: 'person',
  score: 0.9,
  boxes: [],
}

describe('lib/ws', () => {
  beforeEach(() => {
    vi.resetModules()
    MockWebSocket.instances = []
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('opens a single socket on first subscribe', async () => {
    const { subscribeEvents } = await import('./ws')
    subscribeEvents(() => {})
    expect(MockWebSocket.instances).toHaveLength(1)
    expect(MockWebSocket.instances[0].url).toMatch(/\/api\/events\/ws$/)
  })

  it('reuses the same socket for multiple subscribers', async () => {
    const { subscribeEvents } = await import('./ws')
    subscribeEvents(() => {})
    subscribeEvents(() => {})
    expect(MockWebSocket.instances).toHaveLength(1)
  })

  it('dispatches parsed JSON messages to every handler', async () => {
    const { subscribeEvents } = await import('./ws')
    const h1 = vi.fn()
    const h2 = vi.fn()
    subscribeEvents(h1)
    subscribeEvents(h2)
    const sock = MockWebSocket.instances[0]
    sock.fire('message', { data: JSON.stringify(detectionEvent) })
    expect(h1).toHaveBeenCalledWith(detectionEvent)
    expect(h2).toHaveBeenCalledWith(detectionEvent)
  })

  it('ignores malformed messages without throwing', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { subscribeEvents } = await import('./ws')
    const handler = vi.fn()
    subscribeEvents(handler)
    const sock = MockWebSocket.instances[0]
    expect(() => sock.fire('message', { data: 'not-json' })).not.toThrow()
    expect(handler).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('closes the socket once the last handler unsubscribes', async () => {
    const { subscribeEvents } = await import('./ws')
    const u1 = subscribeEvents(() => {})
    const u2 = subscribeEvents(() => {})
    const sock = MockWebSocket.instances[0]
    u1()
    expect(sock.readyState).not.toBe(MockWebSocket.CLOSED)
    u2()
    expect(sock.readyState).toBe(MockWebSocket.CLOSED)
  })

  it('does not invoke handlers that have unsubscribed', async () => {
    const { subscribeEvents } = await import('./ws')
    const h1 = vi.fn()
    const h2 = vi.fn()
    const u1 = subscribeEvents(h1)
    subscribeEvents(h2)
    u1()
    const sock = MockWebSocket.instances[0]
    sock.fire('message', { data: JSON.stringify(detectionEvent) })
    expect(h1).not.toHaveBeenCalled()
    expect(h2).toHaveBeenCalled()
  })

  it('subscribeWsState fires immediately with the current state', async () => {
    const { subscribeWsState } = await import('./ws')
    const states: string[] = []
    subscribeWsState((s) => states.push(s))
    // First call is synchronous: socket starts as 'closed', then connect() is
    // invoked which transitions to 'connecting'.
    expect(states).toEqual(['closed', 'connecting'])
  })

  it('subscribeWsState reports open and closed transitions', async () => {
    const { subscribeWsState } = await import('./ws')
    const states: string[] = []
    subscribeWsState((s) => states.push(s))
    const sock = MockWebSocket.instances[0]
    sock.fire('open', {})
    sock.close()
    expect(states).toEqual(['closed', 'connecting', 'open', 'closed'])
  })

  it('keeps the socket alive when only state subscribers exist', async () => {
    const { subscribeEvents, subscribeWsState } = await import('./ws')
    subscribeWsState(() => {})
    const unsubEvents = subscribeEvents(() => {})
    expect(MockWebSocket.instances).toHaveLength(1)
    const sock = MockWebSocket.instances[0]
    unsubEvents()
    // State subscriber is still listening — socket should remain open.
    expect(sock.readyState).not.toBe(MockWebSocket.CLOSED)
  })

  it('reconnectIfClosed is a no-op when no listeners are attached (iter-158)', async () => {
    const { reconnectIfClosed } = await import('./ws')
    reconnectIfClosed()
    expect(MockWebSocket.instances).toHaveLength(0)
  })

  it('reconnectIfClosed reconnects immediately after a close, skipping backoff (iter-158)', async () => {
    const { subscribeEvents, reconnectIfClosed } = await import('./ws')
    subscribeEvents(() => {})
    expect(MockWebSocket.instances).toHaveLength(1)
    // Simulate a browser-driven close (e.g. mobile backgrounding). The
    // close handler schedules a setTimeout-based reconnect; without
    // reconnectIfClosed the test would have to advance fake timers.
    MockWebSocket.instances[0].close()
    reconnectIfClosed()
    // A fresh socket should already exist — no time has been advanced.
    expect(MockWebSocket.instances).toHaveLength(2)
    expect(MockWebSocket.instances[1].readyState).toBe(MockWebSocket.CONNECTING)
  })

  it('reconnectIfClosed is a no-op when the socket is already open or connecting (iter-158)', async () => {
    const { subscribeEvents, reconnectIfClosed } = await import('./ws')
    subscribeEvents(() => {})
    // Still in CONNECTING — must not double-connect.
    reconnectIfClosed()
    expect(MockWebSocket.instances).toHaveLength(1)
    MockWebSocket.instances[0].fire('open', {})
    reconnectIfClosed()
    expect(MockWebSocket.instances).toHaveLength(1)
  })

  it('does NOT schedule a reconnect after a 1008 close (iter-185)', async () => {
    vi.useFakeTimers()
    try {
      const { subscribeEvents } = await import('./ws')
      subscribeEvents(() => {})
      expect(MockWebSocket.instances).toHaveLength(1)
      const sock = MockWebSocket.instances[0]
      sock.readyState = MockWebSocket.CLOSED
      sock.fire('close', { code: 1008, reason: 'auth required' })
      // Advance well past the 30s max backoff — no reconnect should fire.
      vi.advanceTimersByTime(60_000)
      expect(MockWebSocket.instances).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('schedules a reconnect after a non-1008 close (iter-158 backoff path)', async () => {
    vi.useFakeTimers()
    try {
      const { subscribeEvents } = await import('./ws')
      subscribeEvents(() => {})
      const sock = MockWebSocket.instances[0]
      sock.readyState = MockWebSocket.CLOSED
      sock.fire('close', { code: 1006, reason: 'abnormal' })
      // First backoff is 500ms; advance past it.
      vi.advanceTimersByTime(1000)
      expect(MockWebSocket.instances).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('Given a replacement socket, When a stale close fires, Then it does not null out or reconnect over the new socket', async () => {
    vi.useFakeTimers()
    try {
      // arrange
      const { subscribeEvents, reconnectIfClosed } = await import('./ws')
      subscribeEvents(() => {})
      const staleSock = MockWebSocket.instances[0]
      staleSock.readyState = MockWebSocket.CLOSED
      reconnectIfClosed()
      const activeSock = MockWebSocket.instances[1]
      expect(MockWebSocket.instances).toHaveLength(2)

      // act
      staleSock.fire('close', { code: 1006, reason: 'late close' })
      vi.advanceTimersByTime(1000)
      reconnectIfClosed()

      // assert
      expect(MockWebSocket.instances).toHaveLength(2)
      expect(MockWebSocket.instances[1]).toBe(activeSock)
      expect(activeSock.readyState).toBe(MockWebSocket.CONNECTING)
    } finally {
      vi.useRealTimers()
    }
  })

  it('Given a replacement socket, When a stale error fires, Then it does not close the new socket', async () => {
    // arrange
    const { subscribeEvents, reconnectIfClosed } = await import('./ws')
    subscribeEvents(() => {})
    const staleSock = MockWebSocket.instances[0]
    staleSock.readyState = MockWebSocket.CLOSED
    reconnectIfClosed()
    const activeSock = MockWebSocket.instances[1]
    const closeSpy = vi.spyOn(activeSock, 'close')

    // act
    staleSock.fire('error', {})

    // assert
    expect(closeSpy).not.toHaveBeenCalled()
    expect(activeSock.readyState).toBe(MockWebSocket.CONNECTING)
  })

  it('dispatches homecam:auth-failed on a 1008 close (iter-185)', async () => {
    const { subscribeEvents } = await import('./ws')
    subscribeEvents(() => {})
    const sock = MockWebSocket.instances[0]
    sock.readyState = MockWebSocket.CLOSED
    const seen: string[] = []
    const handler = () => seen.push('auth-failed')
    window.addEventListener('homecam:auth-failed', handler)
    try {
      sock.fire('close', { code: 1008, reason: 'auth required' })
      expect(seen).toEqual(['auth-failed'])
    } finally {
      window.removeEventListener('homecam:auth-failed', handler)
    }
  })

  it('does NOT dispatch homecam:auth-failed on a non-1008 close', async () => {
    const { subscribeEvents } = await import('./ws')
    subscribeEvents(() => {})
    const sock = MockWebSocket.instances[0]
    sock.readyState = MockWebSocket.CLOSED
    const seen: string[] = []
    const handler = () => seen.push('auth-failed')
    window.addEventListener('homecam:auth-failed', handler)
    try {
      sock.fire('close', { code: 1006, reason: 'abnormal' })
      expect(seen).toEqual([])
    } finally {
      window.removeEventListener('homecam:auth-failed', handler)
    }
  })
})
