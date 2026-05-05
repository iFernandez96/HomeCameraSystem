import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// iter-356.x — DetectionSection coverage gap closure (test-coverage
// auditor A1). Pre-test the component had ~240 lines of branching
// logic (chip toggle, retention preset, schedule defaults, zones
// onChange, error retry) with zero dedicated test coverage; the
// only assertions on its behavior were indirect via Settings.test.
//
// Follows the project's BDD-lite naming + AAA body convention
// (CLAUDE.md "NEW tests use Given/When/Then naming + // arrange /
// act / assert body blocks").

const getDetectionConfig = vi.fn()
const patchDetectionConfig = vi.fn()

vi.mock('../../lib/api', () => ({
  getDetectionConfig: (...a: unknown[]) => getDetectionConfig(...a),
  patchDetectionConfig: (...a: unknown[]) => patchDetectionConfig(...a),
}))

const showToast = vi.fn()
vi.mock('../../lib/toast', () => ({
  useToast: () => ({ showToast }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => children,
}))

import { DetectionSection } from './DetectionSection'

const defaultConfig = {
  threshold: 0.5,
  cooldown_s: 5,
  enabled: true,
  schedule_off_start: null,
  schedule_off_end: null,
  classes: ['person', 'car'],
  zones: [],
  clip_post_roll_s: 5,
  clip_pre_roll_s: 0,
  clip_retention_preset: 'month' as const,
  camera_label: 'Front Door',
  audio_enabled: false,
  face_capture_enabled: false,
  face_capture_retention_days: 30,
}

beforeEach(() => {
  getDetectionConfig.mockResolvedValue(structuredClone(defaultConfig))
  patchDetectionConfig.mockResolvedValue(structuredClone(defaultConfig))
  showToast.mockClear()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('DetectionSection', () => {
  it('given the config fetch fails, when the component mounts, then an error state with a Retry button renders', async () => {
    // arrange — Frank E2 / feature audit: pre-fix every field went
    // permanently disabled with no error message + no recovery.
    getDetectionConfig.mockRejectedValue(new Error('network down'))

    // act
    render(<DetectionSection />)

    // assert
    expect(
      await screen.findByText(/could not load detection settings/i),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /retry/i }),
    ).toBeInTheDocument()
  })

  it('given the config fetch fails, when the user clicks Retry, then getDetectionConfig is called again', async () => {
    // arrange
    const user = userEvent.setup()
    getDetectionConfig.mockRejectedValueOnce(new Error('network down'))
    getDetectionConfig.mockResolvedValueOnce(structuredClone(defaultConfig))
    render(<DetectionSection />)
    await screen.findByRole('button', { name: /retry/i })

    // act
    await user.click(screen.getByRole('button', { name: /retry/i }))

    // assert — fetch fired twice (initial fail + retry).
    await waitFor(() => {
      expect(getDetectionConfig).toHaveBeenCalledTimes(2)
    })
  })

  it('given a class chip is rendered, when the user toggles "person" off, then patchDetectionConfig is called with the class removed from the list', async () => {
    // arrange — chips render as <button>person</button> with
    // aria-pressed reflecting selection.
    const user = userEvent.setup()
    render(<DetectionSection />)
    // wait for config to land + chips to render
    const personChip = await screen.findByRole('button', { name: /^person$/i })
    expect(personChip).toHaveAttribute('aria-pressed', 'true')

    // act
    await user.click(personChip)

    // assert — patch fired with classes minus 'person'
    await waitFor(() => {
      expect(patchDetectionConfig).toHaveBeenCalledTimes(1)
    })
    const lastCall = patchDetectionConfig.mock.calls[0][0]
    expect(lastCall.classes).toEqual(['car'])
  })

  it('given the schedule toggle is off, when the user flips it on, then patchDetectionConfig commits the default 23:00 / 06:00 window', async () => {
    // arrange — pre-fix users who flipped the schedule toggle saw an
    // empty time-pair appear. iter-191/X sets sane defaults so the
    // first commit is a valid quiet window.
    const user = userEvent.setup()
    render(<DetectionSection />)
    const toggle = await screen.findByRole('button', {
      name: /auto-pause detection overnight/i,
    })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')

    // act
    await user.click(toggle)

    // assert
    await waitFor(() => {
      expect(patchDetectionConfig).toHaveBeenCalled()
    })
    const calls = patchDetectionConfig.mock.calls
    const scheduleCall = calls.find(
      (c) => c[0]?.schedule_off_start || c[0]?.schedule_off_end,
    )
    expect(scheduleCall).toBeDefined()
    expect(scheduleCall![0].schedule_off_start).toBe('23:00')
    expect(scheduleCall![0].schedule_off_end).toBe('06:00')
  })
})
