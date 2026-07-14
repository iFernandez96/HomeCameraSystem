import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  reportCellularWhepProbe,
  usePageViewTelemetry,
  useEventViewTelemetry,
} from './telemetry'

const sendBeacon = vi.fn()
const fetchMock = vi.fn()
let perfNow = 0

function PageProbe({
  username,
  pathname,
}: {
  username: string | null
  pathname: string
}) {
  usePageViewTelemetry(username, pathname)
  return null
}

function EventProbe({
  username,
  eventId,
}: {
  username: string | null
  eventId: string
}) {
  useEventViewTelemetry(username, eventId)
  return null
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: state,
  })
}

async function beaconPayloadAt(index: number) {
  const blob = sendBeacon.mock.calls[index][1] as Blob
  const text = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(blob)
  })
  return JSON.parse(text)
}

describe('view telemetry', () => {
  beforeEach(() => {
    sendBeacon.mockReset().mockReturnValue(true)
    fetchMock.mockReset().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    Object.defineProperty(navigator, 'sendBeacon', {
      configurable: true,
      value: sendBeacon,
    })
    vi.spyOn(Date, 'now').mockReturnValue(1714000000000)
    perfNow = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => perfNow)
    setVisibility('visible')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    setVisibility('visible')
  })

  it('Given an authed page span, When the document becomes hidden, Then it emits the finished page dwell', async () => {
    // arrange
    render(<PageProbe username="alice" pathname="/events" />)

    // act
    perfNow = 2400
    setVisibility('hidden')
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })

    // assert
    expect(sendBeacon).toHaveBeenCalledWith(
      '/api/telemetry/view',
      expect.any(Blob),
    )
    expect(await beaconPayloadAt(0)).toEqual({
      v: 1,
      kind: 'page',
      name: '/events',
      dwell_ms: 1400,
      ts: 1714000000,
    })
  })

  it('Given sendBeacon is unavailable, When an event span closes, Then fetch keepalive sends the pinned payload shape', async () => {
    // arrange
    sendBeacon.mockReturnValue(false)
    const { unmount } = render(<EventProbe username="alice" eventId="evt_123" />)

    // act
    perfNow = 2400
    unmount()

    // assert
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/telemetry/view',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        body: JSON.stringify({
          v: 1,
          kind: 'event',
          name: 'evt_123',
          dwell_ms: 1400,
          ts: 1714000000,
        }),
      }),
    )
  })

  it('Given an anonymous user, When a page span finishes, Then telemetry is a no-op', () => {
    // arrange
    render(<PageProbe username={null} pathname="/settings" />)

    // act
    setVisibility('hidden')
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })

    // assert
    expect(sendBeacon).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('cellular WHEP telemetry', () => {
  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(Date, 'now').mockReturnValue(1714000000000)
  })

  afterEach(() => {
    Object.defineProperty(navigator, 'connection', {
      configurable: true,
      value: undefined,
    })
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('ships a bounded authenticated report only from a cellular interface', () => {
    Object.defineProperty(navigator, 'connection', {
      configurable: true,
      value: { type: 'cellular' },
    })

    reportCellularWhepProbe('/whep/cam_lq/whep', 'first_frame', 1234.4)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/telemetry/whep-probe',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({
          v: 1,
          rung: 'cam_lq',
          result: 'first_frame',
          network_type: 'cellular',
          ttff_ms: 1234,
          ts: 1714000000,
        }),
      }),
    )
  })

  it('does not classify Wi-Fi or unknown clients as cellular observers', () => {
    Object.defineProperty(navigator, 'connection', {
      configurable: true,
      value: { type: 'wifi' },
    })
    reportCellularWhepProbe('/whep/cam/whep', 'no_media')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
