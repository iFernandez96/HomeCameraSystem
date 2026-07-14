import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { JetsonSection } from './JetsonSection'
import type { ServerStatus } from '../../lib/types'

/**
 * Premium-launch slice — Settings health UX. The pre-fix
 * JetsonSection was a single 18-row dump titled "Camera box
 * health"; the slice adds a top-line verdict + 3 grouped panels
 * (Camera box / Detection / System resources) WITHOUT removing
 * any telemetry. The existing severity-color helpers
 * (InferenceLatency, DroppedFrames, StreamRecoveries,
 * CpuFreqPct, FaceRecogStatus) are pinned by Settings.test.tsx
 * and unchanged here; this file pins the NEW behavior:
 *
 *   1. Top-line verdict renders with kind ∈
 *      {loading, healthy, attention, critical}.
 *   2. Verdict copy explains the worst issue in plain English
 *      while preserving raw values in the row table.
 *   3. All three section headings render and contain the
 *      expected rows.
 *   4. Every row from the legacy single-section layout is
 *      still present (regression sentinel — removing telemetry
 *      was explicitly out of scope per the slice brief).
 */

function baseStatus(over: Partial<ServerStatus> = {}): ServerStatus {
  return {
    ok: true,
    uptime_s: 600,
    camera: 'ok',
    detection_active: true,
    worker_alive: true,
    worker_last_seen_s: 1.5,
    power_sample_age_s: null,
    cpu_temp_c: 50,
    gpu_temp_c: 47,
    cpu_freq_pct: 100,
    load_avg: [0.5, 0.6, 0.7],
    memory_used_mb: 1400,
    memory_total_mb: 1979,
    disk_free_gb: 28,
    fps: 5,
    push_subs_count: 0,
    seconds_since_last_frame: null,
    camera_label: 'Front Door',
    audio_enabled: false,
    worker_metrics: {
      gear: 'idle',
      frames: 100,
      inferences: 20,
      emitted: 0,
      uptime_s: 600,
    },
    ...over,
  } as ServerStatus
}

describe('JetsonSection — health verdict (premium-launch slice)', () => {
  it('Given status is null (still polling), When JetsonSection renders, Then the verdict reports a loading state without committing to healthy/degraded (no false reassurance during cold load)', () => {
    // arrange / act
    render(<JetsonSection status={null} />)

    // assert
    const verdict = screen.getByTestId('jetson-health-verdict')
    expect(verdict.getAttribute('data-verdict-kind')).toBe('loading')
    expect(verdict.textContent).toMatch(/checking the camera box/i)
  })

  it('Given a fully healthy status, When the verdict computes, Then it renders the calm "all systems normal" headline (no false alarms)', () => {
    // arrange / act
    render(<JetsonSection status={baseStatus()} />)

    // assert
    const verdict = screen.getByTestId('jetson-health-verdict')
    expect(verdict.getAttribute('data-verdict-kind')).toBe('healthy')
    expect(verdict.textContent).toMatch(/all systems normal/i)
    expect(verdict.textContent).toMatch(/running smoothly/i)
  })

  it('Given the camera box is unreachable (status.ok=false), When the verdict computes, Then it renders a critical headline with recovery guidance', () => {
    // arrange / act
    render(<JetsonSection status={baseStatus({ ok: false })} />)

    // assert
    const verdict = screen.getByTestId('jetson-health-verdict')
    expect(verdict.getAttribute('data-verdict-kind')).toBe('critical')
    expect(verdict.textContent).toMatch(/unreachable/i)
    expect(verdict.textContent).toMatch(/check power and network/i)
  })

  it('Given a critical verdict, When the card renders, Then it maps the health wording to the app-wide Camera offline wording', () => {
    // arrange / act
    render(<JetsonSection status={baseStatus({ ok: false })} />)

    // assert
    expect(
      screen.getByText(/elsewhere in the app this shows as camera offline\./i),
    ).toBeInTheDocument()
  })

  it('Given a healthy verdict, When the card renders, Then it does not show the Camera offline vocabulary bridge', () => {
    // arrange / act
    render(<JetsonSection status={baseStatus()} />)

    // assert
    expect(
      screen.queryByText(/elsewhere in the app this shows as camera offline/i),
    ).not.toBeInTheDocument()
  })

  it('Given the detection process is dead past the heartbeat window, When the verdict computes, Then it reports the offline duration in plain English (no jargon)', () => {
    // arrange — worker_alive false + last_seen > 60 s = critical-tier.
    render(
      <JetsonSection
        status={baseStatus({
          worker_alive: false,
          worker_last_seen_s: 92,
        })}
      />,
    )

    // assert
    const verdict = screen.getByTestId('jetson-health-verdict')
    expect(verdict.getAttribute('data-verdict-kind')).toBe('critical')
    expect(verdict.textContent).toMatch(/detection process is offline/i)
    expect(verdict.textContent).toMatch(/no heartbeat for 92s/i)
  })

  it('Given the GPU is over the critical thermal threshold, When the verdict computes, Then it surfaces the temperature in plain English without dropping the raw row value', () => {
    // arrange — GPU at 86 °C is critical (>=85).
    const status = baseStatus({ gpu_temp_c: 86 })
    render(<JetsonSection status={status} />)

    // assert — the verdict reports "GPU is overheating" with the raw value.
    const verdict = screen.getByTestId('jetson-health-verdict')
    expect(verdict.getAttribute('data-verdict-kind')).toBe('critical')
    expect(verdict.textContent).toMatch(/gpu is overheating/i)
    expect(verdict.textContent).toMatch(/86\.0\s*°C/)
    // The row-level telemetry is also still present (preservation
    // sentinel — verdict augments, never replaces).
    expect(screen.getByText('86.0 °C')).toBeInTheDocument()
  })

  it('Given temperature is in the warning band (75-84 °C), When the verdict computes, Then it falls under the calm "attention" tone, not "critical"', () => {
    // arrange — CPU at 78 °C is warning.
    render(<JetsonSection status={baseStatus({ cpu_temp_c: 78 })} />)

    // assert
    const verdict = screen.getByTestId('jetson-health-verdict')
    expect(verdict.getAttribute('data-verdict-kind')).toBe('attention')
    expect(verdict.textContent).toMatch(/cpu is running warm/i)
  })

  it('Given two simultaneous issues, When the verdict computes, Then the more severe one wins (critical beats attention; first-match priority order)', () => {
    // arrange — GPU 86 °C (critical) AND CPU 78 °C (attention).
    // Critical must win.
    render(
      <JetsonSection
        status={baseStatus({ gpu_temp_c: 86, cpu_temp_c: 78 })}
      />,
    )

    // assert — critical kind, GPU headline (the worse one).
    const verdict = screen.getByTestId('jetson-health-verdict')
    expect(verdict.getAttribute('data-verdict-kind')).toBe('critical')
    expect(verdict.textContent).toMatch(/gpu is overheating/i)
  })

  it('Given a critical verdict, When the announcement renders, Then it carries role="alert" so AT users get assertive notification (severity-aware ARIA)', () => {
    // arrange / act
    render(<JetsonSection status={baseStatus({ ok: false })} />)

    // assert — critical = role="alert" (assertive). Healthy +
    // attention use polite role="status" — verified separately
    // below.
    const verdict = screen.getByTestId('jetson-health-verdict')
    expect(verdict.getAttribute('role')).toBe('alert')
  })

  it('Given a healthy verdict, When the announcement renders, Then it carries role="status" + aria-live="polite" so AT users do not get interrupted', () => {
    // arrange / act
    render(<JetsonSection status={baseStatus()} />)

    // assert
    const verdict = screen.getByTestId('jetson-health-verdict')
    expect(verdict.getAttribute('role')).toBe('status')
    expect(verdict.getAttribute('aria-live')).toBe('polite')
  })
})

describe('JetsonSection — grouped panels (premium-launch slice)', () => {
  it('Given the panel renders, When the user scans, Then three group headings (Camera box / Detection / System resources) are present so 18 rows organize by purpose', () => {
    // arrange / act
    render(<JetsonSection status={baseStatus()} />)

    // assert — the prior single-section "Camera box health"
    // heading is replaced by three group headings. All three
    // are level-2 (the Section primitive renders <h2>).
    expect(
      screen.getByRole('heading', { level: 2, name: /camera box/i }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { level: 2, name: /^detection$/i }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { level: 2, name: /system resources/i }),
    ).toBeInTheDocument()
  })

  it('Given the panel renders, When the user reads each group, Then a one-line subtitle explains what the group covers (Frank-grade context, calm tone)', () => {
    // arrange / act
    render(<JetsonSection status={baseStatus()} />)

    // assert — calm helper text on each group.
    expect(
      screen.getByText(/physical reachability of the jetson/i),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/what the ai is watching for/i),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/power, cpu, memory, and storage/i),
    ).toBeInTheDocument()
  })

  it('Given the panel renders, When the user looks for legacy rows, Then every telemetry label from the pre-slice single-section layout is still present (preservation sentinel — operator-grade detail must not be hidden)', () => {
    // arrange / act
    render(<JetsonSection status={baseStatus()} />)

    // assert — every row label that existed before the slice is
    // still queryable somewhere on the page. If a future
    // refactor drops a row this test catches it before it ships.
    const labels = [
      'Camera box',
      'Jetson running',
      'API running',
      'Detection running',
      'Camera',
      'Watching for people',
      'Face recognition',
      'Detection process',
      'Power draw',
      'CPU temp',
      'GPU temp',
      'CPU clock',
      'Memory',
      'Capture storage free',
      'System SD free',
      'FPS',
      'Inference',
      'Dropped frames',
      'Stream recoveries',
    ]
    for (const label of labels) {
      // getAllByText so the assertion survives "Camera box"
      // appearing both as a heading and as a row label.
      expect(screen.getAllByText(label).length).toBeGreaterThan(0)
    }

    // The Load avg row keeps its raw 3-tuple value AND now
    // surfaces a helper "(1m · 5m · 15m)" so a homeowner who
    // doesn't know Unix-load-avg semantics has context.
    expect(screen.getByText(/load avg \(1m · 5m · 15m\)/i)).toBeInTheDocument()
  })

  it('Given the Nano 2GB has no input monitor, Then Settings explains why watts are unavailable', () => {
    // arrange / act
    render(<JetsonSection status={baseStatus()} />)

    // assert
    expect(screen.getByText('External power sensor needed')).toBeInTheDocument()
    expect(screen.getByText(/nano 2gb has no onboard power monitor/i)).toBeInTheDocument()
  })

  it('Given a fresh power sample, Then Settings shows watts, volts, and amps together', () => {
    // arrange / act
    render(
      <JetsonSection
        status={baseStatus({
          power_sample_age_s: 1,
          worker_metrics: {
            power_sensor_status: 1,
            power_watts: 6.287,
            power_volts: 5.03,
            power_amps: 1.25,
          },
        })}
      />,
    )

    // assert
    expect(screen.getByText('6.29 W · 5.03 V · 1.25 A')).toBeInTheDocument()
  })

  it('Given the panel renders, When the user scans the Camera box group, Then it contains exactly the camera-identity rows (no detection or system rows leak in)', () => {
    // arrange / act
    render(<JetsonSection status={baseStatus()} />)

    // assert — find the Camera box <section> via its heading,
    // then assert specific row labels are inside it. This pins
    // the GROUPING contract: a future refactor that moves
    // "Camera" into the Detection group would trip this test.
    const heading = screen.getByRole('heading', {
      level: 2,
      name: /camera box/i,
    })
    const section = heading.closest('section')
    expect(section).not.toBeNull()
    const within_ = within(section!)
    // Within the Camera box section we expect the 3 identity rows.
    expect(within_.getByText('Jetson running')).toBeInTheDocument()
    expect(within_.getByText('API running')).toBeInTheDocument()
    expect(within_.getByText('Camera')).toBeInTheDocument()
    // Hardware-resource rows belong elsewhere — they should NOT
    // be inside this group's section.
    expect(within_.queryByText('CPU temp')).not.toBeInTheDocument()
    expect(within_.queryByText('Inference')).not.toBeInTheDocument()
  })

  it('Given the panel renders, When the user scans the Detection group, Then it contains the worker + inference rows', () => {
    // arrange / act
    render(<JetsonSection status={baseStatus()} />)

    // assert
    const heading = screen.getByRole('heading', {
      level: 2,
      name: /^detection$/i,
    })
    const section = heading.closest('section')!
    const within_ = within(section)
    expect(within_.getByText('Detection process')).toBeInTheDocument()
    expect(within_.getByText('Detection running')).toBeInTheDocument()
    expect(within_.getByText('Watching for people')).toBeInTheDocument()
    expect(within_.getByText('Face recognition')).toBeInTheDocument()
    expect(within_.getByText('FPS')).toBeInTheDocument()
    expect(within_.getByText('Inference')).toBeInTheDocument()
    expect(within_.getByText('Dropped frames')).toBeInTheDocument()
    expect(within_.getByText('Stream recoveries')).toBeInTheDocument()
    // Hardware rows are elsewhere.
    expect(within_.queryByText('CPU temp')).not.toBeInTheDocument()
  })

  it('Given the panel renders, When the user scans the System resources group, Then it contains exactly the hardware-state rows', () => {
    // arrange / act
    render(<JetsonSection status={baseStatus()} />)

    // assert
    const heading = screen.getByRole('heading', {
      level: 2,
      name: /system resources/i,
    })
    const section = heading.closest('section')!
    const within_ = within(section)
    expect(within_.getByText('CPU temp')).toBeInTheDocument()
    expect(within_.getByText('GPU temp')).toBeInTheDocument()
    expect(within_.getByText('CPU clock')).toBeInTheDocument()
    expect(within_.getByText('Memory')).toBeInTheDocument()
    expect(within_.getByText('Capture storage free')).toBeInTheDocument()
    expect(within_.getByText('System SD free')).toBeInTheDocument()
    expect(within_.getByText(/load avg/i)).toBeInTheDocument()
    // Detection rows belong elsewhere.
    expect(within_.queryByText('Detection process')).not.toBeInTheDocument()
    expect(within_.queryByText('Inference')).not.toBeInTheDocument()
  })
})

describe('JetsonSection — temperature severity coloring (premium-launch slice)', () => {
  it('Given CPU temperature is in the warning band (≥75 °C), When the row renders, Then the value is colored warning (calm-severity row glance signal)', () => {
    // arrange / act
    render(<JetsonSection status={baseStatus({ cpu_temp_c: 78 })} />)

    // assert — the row text picks up the warning token.
    const value = screen.getByText('78.0 °C')
    expect(value.className).toMatch(/color-warning/)
  })

  it('Given GPU temperature crosses the critical threshold (≥85 °C), When the row renders, Then the value is colored danger', () => {
    // arrange / act
    render(<JetsonSection status={baseStatus({ gpu_temp_c: 86 })} />)

    // assert
    const value = screen.getByText('86.0 °C')
    expect(value.className).toMatch(/color-danger/)
  })

  it('Given disk free drops below 5 GB, When the row renders, Then the value is colored danger so a glance catches the storage emergency', () => {
    // arrange / act
    render(<JetsonSection status={baseStatus({ disk_free_gb: 3 })} />)

    // assert
    const value = screen.getByText('3 GB')
    expect(value.className).toMatch(/color-danger/)
  })

  it('Given memory pressure crosses 90 %, When the row renders, Then the value is colored warning to match the verdict cue', () => {
    // arrange — 1800 / 1979 ≈ 91 %.
    render(
      <JetsonSection
        status={baseStatus({ memory_used_mb: 1800, memory_total_mb: 1979 })}
      />,
    )

    // assert
    const value = screen.getByText(/1\.8 \/ 1\.9 GB/)
    expect(value.className).toMatch(/color-warning/)
  })
})
