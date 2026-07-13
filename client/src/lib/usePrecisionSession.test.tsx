import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const setCameraFocusMode = vi.fn()
const getRecoverStatus = vi.fn()
vi.mock('./api', () => ({
  setCameraFocusMode: (...args: unknown[]) => setCameraFocusMode(...args),
  getRecoverStatus: (...args: unknown[]) => getRecoverStatus(...args),
}))

import { usePrecisionSession } from './usePrecisionSession'

function Harness() {
  const session = usePrecisionSession()
  return <div><span>{session.state}</span><span>{session.detail}</span></div>
}

describe('usePrecisionSession', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    setCameraFocusMode.mockReset().mockImplementation(async (enabled: boolean) => ({
      request_id: enabled ? 'focus-start' : 'focus-stop',
    }))
    getRecoverStatus.mockReset().mockResolvedValue({ status: 'done' })
  })

  afterEach(() => vi.useRealTimers())

  it('waits for confirmed precision mode and restores stable mode on exit', async () => {
    const view = render(<Harness />)
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(await screen.findByText('ready')).toBeInTheDocument()
    expect(setCameraFocusMode).toHaveBeenCalledWith(true)

    view.unmount()
    await waitFor(() => expect(setCameraFocusMode).toHaveBeenCalledWith(false))
  })

  it('shows the measured preflight reason instead of claiming 1440p is active', async () => {
    getRecoverStatus.mockResolvedValue({
      status: 'failed',
      detail: 'precision mode blocked by safety preflight',
      result: { preflight: { safe: false, reasons: ['only 300 MB memory available'] } },
    })
    render(<Harness />)
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })

    expect(await screen.findByText('blocked')).toBeInTheDocument()
    expect(screen.getByText('only 300 MB memory available')).toBeInTheDocument()
    expect(setCameraFocusMode).not.toHaveBeenCalledWith(false)
  })

  it('retries stable-mode restoration when another camera action is finishing', async () => {
    let stopAttempts = 0
    setCameraFocusMode.mockImplementation(async (enabled: boolean) => {
      if (enabled) return { request_id: 'focus-start' }
      stopAttempts += 1
      if (stopAttempts === 1) throw Object.assign(new Error('busy'), { status: 409 })
      return { request_id: 'focus-stop' }
    })
    const view = render(<Harness />)
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(await screen.findByText('ready')).toBeInTheDocument()

    view.unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })

    expect(stopAttempts).toBe(2)
  })
})
