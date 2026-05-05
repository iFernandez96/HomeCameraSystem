import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { RecordingIndicator } from './RecordingIndicator'
import type { ServerStatus } from '../lib/types'

// iter-356.C (mobile-redesign Slice C — security clarity): the
// Recording pill must only render when both worker_alive AND
// detection_active are true. Pre-roll runs continuously per
// CLAUDE.md, so that combination is the honest "we are recording
// now" signal.

function makeStatus(overrides: Partial<ServerStatus> = {}): ServerStatus {
  return {
    detection_active: true,
    worker_alive: true,
    worker_last_seen_s: 1,
    seconds_since_last_frame: 1,
    camera_label: 'Front Door',
    audio_enabled: false,
    ...(overrides as object),
  } as ServerStatus
}

describe('RecordingIndicator', () => {
  it('given worker_alive + detection_active, when rendered, then shows REC pill', () => {
    // arrange
    const status = makeStatus()

    // act
    render(<RecordingIndicator status={status} />)

    // assert
    expect(screen.getByLabelText(/recording/i)).toBeInTheDocument()
    expect(screen.getByText(/recording/i)).toBeInTheDocument()
  })

  it('given worker_alive=false, when rendered, then absent', () => {
    // arrange
    const status = makeStatus({ worker_alive: false })

    // act
    render(<RecordingIndicator status={status} />)

    // assert
    expect(screen.queryByLabelText(/recording/i)).not.toBeInTheDocument()
  })

  it('given detection_active=false, when rendered, then absent', () => {
    // arrange
    const status = makeStatus({ detection_active: false })

    // act
    render(<RecordingIndicator status={status} />)

    // assert
    expect(screen.queryByLabelText(/recording/i)).not.toBeInTheDocument()
  })

  it('given status=null, when rendered, then absent (no false-positive during connect)', () => {
    // arrange + act
    render(<RecordingIndicator status={null} />)

    // assert
    expect(screen.queryByLabelText(/recording/i)).not.toBeInTheDocument()
  })
})
