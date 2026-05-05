import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

// iter-356.C (mobile-redesign Slice C — security clarity): the
// Saving-faces pill renders when GET /api/detection/config returns
// face_capture_enabled=true. Owner-only PATCH is server-enforced;
// the GET is open to all authed roles so every household member
// can see the pill (household-trust signal).

const getDetectionConfig = vi.fn()
vi.mock('../lib/api', () => ({
  getDetectionConfig: (...a: unknown[]) => getDetectionConfig(...a),
}))

import { CaptureSavingPill } from './CaptureSavingPill'

beforeEach(() => {
  getDetectionConfig.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('CaptureSavingPill', () => {
  it('given config.face_capture_enabled=true, when fetched, then pill renders', async () => {
    // arrange
    getDetectionConfig.mockResolvedValue({
      face_capture_enabled: true,
      face_capture_retention_days: 30,
    })

    // act
    render(<CaptureSavingPill />)

    // assert
    await waitFor(() =>
      expect(
        screen.getByLabelText(/saving faces for training/i),
      ).toBeInTheDocument(),
    )
    expect(screen.getByText(/saving faces for training/i)).toBeInTheDocument()
  })

  it('given face_capture_enabled=false, when fetched, then no pill', async () => {
    // arrange
    getDetectionConfig.mockResolvedValue({
      face_capture_enabled: false,
      face_capture_retention_days: 30,
    })

    // act
    render(<CaptureSavingPill />)

    // assert — give the promise a tick to settle, then assert silence.
    await Promise.resolve()
    await Promise.resolve()
    expect(
      screen.queryByLabelText(/saving faces for training/i),
    ).not.toBeInTheDocument()
  })

  it('given the config fetch rejects, when rendered, then no pill (default-off)', async () => {
    // arrange
    getDetectionConfig.mockRejectedValue(new Error('401'))

    // act
    render(<CaptureSavingPill />)

    // assert
    await Promise.resolve()
    await Promise.resolve()
    expect(
      screen.queryByLabelText(/saving faces for training/i),
    ).not.toBeInTheDocument()
  })
})
