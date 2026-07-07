import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    ToastProvider: ({ children }: { children: React.ReactNode }) => children,
  }
})

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
  continuous_capture: false,
  max_visit_s: 150,
  absence_finalize_s: 10,
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

  it('Given a setting commit rejects, When patchDetectionConfig fails, Then the error toast is paired with a log naming the patch KEYS + status (NOT the values — §4 guardrail)', async () => {
    // arrange — toggling "person" off issues a patch { classes: [...] }.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const err = Object.assign(new Error('save blew up'), { status: 500 })
    patchDetectionConfig.mockRejectedValue(err)
    const user = userEvent.setup()
    render(<DetectionSection />)
    const personChip = await screen.findByRole('button', { name: /^person$/i })

    // act
    await user.click(personChip)

    // assert — toast + paired log carrying the changed KEY ('classes')
    // and the status, but not the geometry/values.
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.stringMatching(/could not save settings/i),
        'error',
      ),
    )
    expect(errorSpy).toHaveBeenCalledWith(
      '[detectionSettings:save-failed]',
      expect.objectContaining({ keys: ['classes'], status: 500 }),
    )
  })

  // feat/continuous-capture (plan S6): operator opt-in toggle + the two
  // per-visit knobs that only appear once it's on.
  it('Given continuous capture is off, When the user flips the toggle on, Then patchDetectionConfig commits { continuous_capture: true }', async () => {
    // arrange
    const user = userEvent.setup()
    render(<DetectionSection />)
    const toggle = await screen.findByRole('button', {
      name: /enable continuous per-visit recording/i,
    })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    // while off, the per-visit sliders stay hidden.
    expect(
      screen.queryByLabelText(/maximum length of a single visit clip/i),
    ).not.toBeInTheDocument()

    // act
    await user.click(toggle)

    // assert
    await waitFor(() => {
      expect(patchDetectionConfig).toHaveBeenCalledWith({
        continuous_capture: true,
      })
    })
  })

  it('Given continuous capture is on, When the section renders, Then the grace-period and longest-clip sliders are present', async () => {
    // arrange — server returns config with the feature already enabled.
    getDetectionConfig.mockResolvedValue(
      structuredClone({ ...defaultConfig, continuous_capture: true }),
    )

    // act
    render(<DetectionSection />)

    // assert — both per-visit knobs render, bound to the live values.
    expect(
      await screen.findByLabelText(
        /seconds to wait after the subject leaves/i,
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByLabelText(/maximum length of a single visit clip/i),
    ).toBeInTheDocument()
  })

  it('Given two-way audio is coming soon, When the user tries to click the toggle, Then it stays disabled and does not persist a changed setting', async () => {
    // arrange
    const user = userEvent.setup()
    getDetectionConfig.mockResolvedValue(
      structuredClone({ ...defaultConfig, audio_enabled: true }),
    )
    render(<DetectionSection />)
    const toggle = await screen.findByRole('button', {
      name: /enable two-way audio/i,
    })

    // act
    await user.click(toggle)

    // assert
    expect(toggle).toBeDisabled()
    expect(toggle).toHaveAttribute('aria-disabled', 'true')
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(
      screen.getByText(
        /coming soon\. needs a microphone and speaker on the camera before this can turn on\./i,
      ),
    ).toBeInTheDocument()
    expect(patchDetectionConfig).not.toHaveBeenCalledWith(
      expect.objectContaining({ audio_enabled: expect.any(Boolean) }),
    )
  })

  it('Given pre-roll is enabled for the current retention preset, When the user drags the slider, Then it PATCHes clip_pre_roll_s', async () => {
    // arrange
    render(<DetectionSection />)
    const slider = await screen.findByRole('slider', {
      name: /seconds before detection to include in the clip/i,
    })

    // act
    fireEvent.change(slider, { target: { value: '10' } })
    fireEvent.pointerUp(slider)

    // assert
    expect(slider).not.toBeDisabled()
    expect(screen.getByText('10 s')).toBeInTheDocument()
    await waitFor(() => {
      expect(patchDetectionConfig).toHaveBeenCalledWith({ clip_pre_roll_s: 10 })
    })
  })

  it('Given pre-roll exceeds a shorter preset ceiling, When the preset changes, Then the displayed pre-roll value is clamped', async () => {
    // arrange
    const user = userEvent.setup()
    getDetectionConfig.mockResolvedValue(
      structuredClone({
        ...defaultConfig,
        clip_retention_preset: 'week',
        clip_pre_roll_s: 200,
      }),
    )
    patchDetectionConfig.mockResolvedValue(
      structuredClone({
        ...defaultConfig,
        clip_retention_preset: 'month',
        clip_pre_roll_s: 150,
      }),
    )
    render(<DetectionSection />)
    expect(await screen.findByText('3 min 20 s')).toBeInTheDocument()

    // act
    await user.click(screen.getByRole('radio', { name: /1 month/i }))

    // assert
    expect(screen.getByText('2 min 30 s')).toBeInTheDocument()
    await waitFor(() => {
      expect(patchDetectionConfig).toHaveBeenCalledWith({
        clip_retention_preset: 'month',
      })
    })
  })

  it('Given the sensitivity value moves across boundary values, When the slider changes, Then the plain-word qualifier updates with the numeric readout', async () => {
    // arrange
    getDetectionConfig.mockResolvedValue(
      structuredClone({ ...defaultConfig, threshold: 0.45 }),
    )
    render(<DetectionSection />)
    const slider = await screen.findByRole('slider', {
      name: /detection sensitivity/i,
    })

    // act
    fireEvent.change(slider, { target: { value: '0.4' } })

    // assert
    expect(screen.getByText('0.40')).toBeInTheDocument()
    expect(screen.getByText(/loose: more events/i)).toBeInTheDocument()

    // act
    fireEvent.change(slider, { target: { value: '0.45' } })

    // assert
    expect(screen.getByText('0.45')).toBeInTheDocument()
    expect(screen.getByText(/^balanced$/i)).toBeInTheDocument()

    // act
    fireEvent.change(slider, { target: { value: '0.7' } })

    // assert
    expect(screen.getByText('0.70')).toBeInTheDocument()
    expect(screen.getByText(/strict: fewer events/i)).toBeInTheDocument()
  })
})
