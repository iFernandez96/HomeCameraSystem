import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getCameraExposure = vi.fn()
const getRecoverStatus = vi.fn()
const putCameraExposure = vi.fn()
const connectWhep = vi.fn()
const listCameraExposurePresets = vi.fn()
const createCameraExposurePreset = vi.fn()
const deleteCameraExposurePreset = vi.fn()
const setCameraFocusMode = vi.fn()

vi.mock('../lib/api', () => ({
  getCameraExposure: (...args: unknown[]) => getCameraExposure(...args),
  getRecoverStatus: (...args: unknown[]) => getRecoverStatus(...args),
  putCameraExposure: (...args: unknown[]) => putCameraExposure(...args),
  listCameraExposurePresets: (...args: unknown[]) => listCameraExposurePresets(...args),
  createCameraExposurePreset: (...args: unknown[]) => createCameraExposurePreset(...args),
  deleteCameraExposurePreset: (...args: unknown[]) => deleteCameraExposurePreset(...args),
  setCameraFocusMode: (...args: unknown[]) => setCameraFocusMode(...args),
}))

vi.mock('../lib/webrtc', () => ({
  connectWhep: (...args: unknown[]) => connectWhep(...args),
}))

import { ExposureAssistant } from './ExposureAssistant'

const exposure = {
  enabled: true,
  x: 0.25,
  y: 0.25,
  width: 0.5,
  height: 0.5,
  compensation: 0,
  locked: false,
}

describe('ExposureAssistant', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    getCameraExposure.mockReset().mockResolvedValue(exposure)
    getRecoverStatus.mockReset().mockResolvedValue({ status: 'done' })
    putCameraExposure.mockReset().mockResolvedValue({ request_id: 'exposure-1' })
    connectWhep.mockReset().mockResolvedValue({ close: vi.fn() })
    listCameraExposurePresets.mockReset().mockResolvedValue({ presets: [] })
    createCameraExposurePreset.mockReset()
    deleteCameraExposurePreset.mockReset()
    setCameraFocusMode.mockReset().mockImplementation(async (enabled: boolean) => ({
      request_id: enabled ? 'focus-start' : 'focus-stop',
    }))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('Given exposure is applied, When camera recovery finishes, Then it reconnects and shows the updated preview', async () => {
    // arrange
    const { container } = render(
      <MemoryRouter>
        <ExposureAssistant />
      </MemoryRouter>,
    )
    const video = container.querySelector('video')
    expect(video).not.toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    await waitFor(() => expect(connectWhep).toHaveBeenCalledTimes(1))
    fireEvent.loadedData(video!)

    // act
    fireEvent.click(screen.getByRole('button', { name: 'Apply exposure' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })

    // assert
    await waitFor(() => expect(connectWhep).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('status')).toHaveTextContent('Refreshing preview')
    fireEvent.loadedData(video!)
    expect(screen.getByRole('status')).toHaveTextContent('Exposure applied. Preview updated.')
  })

  it('Given the preview failed, When Retry is tapped, Then it starts a fresh connection', async () => {
    // arrange
    connectWhep.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ close: vi.fn() })
    render(
      <MemoryRouter>
        <ExposureAssistant />
      </MemoryRouter>,
    )
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    const retry = await screen.findByRole('button', { name: 'Retry' })

    // act
    fireEvent.click(retry)

    // assert
    await waitFor(() => expect(connectWhep).toHaveBeenCalledTimes(2))
    expect(screen.getByText('Connecting to the camera…')).toBeInTheDocument()
  })

  it('Given a named zone, When it is restored and undone, Then both exact configurations are applied', async () => {
    // arrange
    const savedConfig = { ...exposure, x: 0.1, compensation: 0.8 }
    listCameraExposurePresets.mockResolvedValue({
      presets: [{
        id: 'zone-1',
        name: 'Bright doorway',
        thumbnail: 'data:image/jpeg;base64,AAAA',
        config: savedConfig,
        created_at: 1,
      }],
    })
    const { container } = render(
      <MemoryRouter>
        <ExposureAssistant />
      </MemoryRouter>,
    )
    const video = container.querySelector('video')!
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    await waitFor(() => expect(connectWhep).toHaveBeenCalledTimes(1))
    fireEvent.loadedData(video)

    // act
    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    await waitFor(() => expect(putCameraExposure).toHaveBeenCalledWith(savedConfig))
    fireEvent.loadedData(video)
    fireEvent.click(await screen.findByRole('button', { name: 'Undo last change' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })

    // assert
    expect(putCameraExposure).toHaveBeenNthCalledWith(1, savedConfig)
    expect(putCameraExposure).toHaveBeenNthCalledWith(2, exposure)
  })
})
