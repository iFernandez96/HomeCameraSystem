import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { LiveStats } from './LiveStats'
import type { ServerStatus } from '../lib/types'

function status(over: Partial<ServerStatus> = {}): ServerStatus {
  return {
    ok: true,
    uptime_s: 600,
    camera: 'ok',
    detection_active: true,
    worker_alive: true,
    worker_last_seen_s: 5,
    worker_metrics: null,
    cpu_temp_c: 50,
    gpu_temp_c: 47,
    cpu_freq_pct: 100,
    load_avg: [0.5, 0.6, 0.7],
    memory_used_mb: 1400,
    memory_total_mb: 1979,
    disk_free_gb: 28,
    fps: 5.0,
    push_subs_count: 0,
    seconds_since_last_frame: null,
    camera_label: 'Front Door',
    audio_enabled: false,
    ...over,
  }
}

describe('LiveStats System Health card (iter-356.15)', () => {
  it('given status is null, when rendered, then shows loading placeholder', () => {
    // arrange + act
    render(<LiveStats status={null} />)

    // assert
    expect(screen.getByText(/loading status/i)).toBeInTheDocument()
  })

  describe('summary line', () => {
    it('given a healthy worker + cool temps, when rendered, then "All systems normal" is the summary', () => {
      // arrange + act
      render(<LiveStats status={status()} />)

      // assert
      expect(screen.getByText('All systems normal')).toBeInTheDocument()
    })

    it('given worker_alive=false with last-seen, when rendered, then summary is Camera offline + reconnect hint', () => {
      // arrange + act
      render(
        <LiveStats
          status={status({ worker_alive: false, worker_last_seen_s: 45 })}
        />,
      )

      // assert
      expect(screen.getByText('Camera offline')).toBeInTheDocument()
      expect(screen.getByText(/last seen 45s ago/i)).toBeInTheDocument()
    })

    it('given worker_alive=false with no last_seen, when rendered, then hint says we never heard back', () => {
      // arrange + act
      render(
        <LiveStats
          status={status({ worker_alive: false, worker_last_seen_s: null })}
        />,
      )

      // assert
      expect(screen.getByText('Camera offline')).toBeInTheDocument()
      expect(screen.getByText(/haven't heard from the camera/i)).toBeInTheDocument()
    })

    it('given gear=low-memory, when rendered, then summary is the red "Detection paused — low memory" + recovery hint', () => {
      // arrange + act
      render(
        <LiveStats
          status={status({
            worker_alive: true,
            worker_metrics: {
              fps: 5,
              infer_per_s: 0,
              gear: 'low-memory',
              frames: 1000,
              inferences: 0,
              emitted: 0,
            },
          })}
        />,
      )

      // assert
      expect(
        screen.getByText(/detection paused — low memory/i),
      ).toBeInTheDocument()
    })

    it('given gear=thermal-throttled, when rendered, then summary is the amber "Camera running warm"', () => {
      // arrange + act
      render(
        <LiveStats
          status={status({
            worker_alive: true,
            worker_metrics: {
              fps: 5,
              infer_per_s: 1.0,
              gear: 'thermal-throttled',
              frames: 1000,
              inferences: 1,
              emitted: 0,
            },
          })}
        />,
      )

      // assert
      expect(screen.getByText('Camera running warm')).toBeInTheDocument()
      expect(
        screen.getByText(/slowed down to cool off/i),
      ).toBeInTheDocument()
    })

    it('given CPU temp >= 85 (no thermal gear), when rendered, then summary still warns "Camera running warm"', () => {
      // arrange + act
      render(<LiveStats status={status({ cpu_temp_c: 88 })} />)

      // assert
      expect(screen.getByText('Camera running warm')).toBeInTheDocument()
    })

    it('given clock throttled (cpu_freq_pct < 95), when rendered, then summary warns "Camera running warm"', () => {
      // arrange + act
      render(<LiveStats status={status({ cpu_freq_pct: 80 })} />)

      // assert
      expect(screen.getByText('Camera running warm')).toBeInTheDocument()
    })

    it('given gear=off (manually paused), when rendered, then summary is "Detection paused" with action hint', () => {
      // arrange + act
      render(
        <LiveStats
          status={status({
            worker_alive: true,
            worker_metrics: {
              fps: 5,
              infer_per_s: 0,
              gear: 'off',
              frames: 0,
              inferences: 0,
              emitted: 0,
            },
          })}
        />,
      )

      // assert
      expect(screen.getByText('Detection paused')).toBeInTheDocument()
      expect(screen.getByText(/tap detect on the action panel/i)).toBeInTheDocument()
    })

    it('given gear=scheduled-off, when rendered, then summary is "Detection paused on schedule"', () => {
      // arrange + act
      render(
        <LiveStats
          status={status({
            worker_alive: true,
            worker_metrics: {
              fps: 5,
              infer_per_s: 0,
              gear: 'scheduled-off',
              frames: 0,
              inferences: 0,
              emitted: 0,
            },
          })}
        />,
      )

      // assert
      expect(
        screen.getByText('Detection paused on schedule'),
      ).toBeInTheDocument()
    })

    it('given memory >= 90% but worker still healthy, when rendered, then summary warns "Memory running tight"', () => {
      // arrange — 1850 of 1979 = 93%
      render(
        <LiveStats
          status={status({ memory_used_mb: 1850, memory_total_mb: 1979 })}
        />,
      )

      // assert
      expect(screen.getByText('Memory running tight')).toBeInTheDocument()
    })
  })

  describe('System details disclosure', () => {
    it('given default render, when no click, then the system details grid is hidden', () => {
      // arrange + act
      render(<LiveStats status={status()} />)

      // assert — disclosure starts collapsed; aria-expanded=false; the
      // CPU temperature is NOT in the document.
      const toggle = screen.getByRole('button', { name: /system details/i })
      expect(toggle).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByText('50°C')).not.toBeInTheDocument()
    })

    it('given user clicks the disclosure, when it opens, then aria-expanded flips and details render', () => {
      // arrange
      render(<LiveStats status={status()} />)
      const toggle = screen.getByRole('button', { name: /system details/i })

      // act
      fireEvent.click(toggle)

      // assert — aria-expanded true + the existing stat grid renders.
      expect(toggle).toHaveAttribute('aria-expanded', 'true')
      expect(screen.getByText('50°C')).toBeInTheDocument()
      expect(screen.getByText('47°C')).toBeInTheDocument()
      expect(screen.getByText('1.4/1.9 GB')).toBeInTheDocument()
      expect(screen.getByText('10m')).toBeInTheDocument()
      expect(screen.getByText('0.50')).toBeInTheDocument()
      expect(screen.getByText('28 GB free')).toBeInTheDocument()
      expect(screen.getByText('Camera online')).toBeInTheDocument()
    })

    it('given the disclosure is open, when user clicks the toggle again, then details collapse', () => {
      // arrange
      render(<LiveStats status={status()} />)
      const toggle = screen.getByRole('button', { name: /system details/i })
      fireEvent.click(toggle)
      expect(screen.getByText('50°C')).toBeInTheDocument()

      // act
      fireEvent.click(screen.getByRole('button', { name: /hide system details/i }))

      // assert
      expect(screen.queryByText('50°C')).not.toBeInTheDocument()
    })

    it('given the disclosure is open with high CPU temp, when expanded, then 90°C is painted red', () => {
      // arrange
      render(<LiveStats status={status({ cpu_temp_c: 90 })} />)

      // act — open the details
      fireEvent.click(screen.getByRole('button', { name: /system details/i }))

      // assert
      expect(screen.getByText('90°C')).toHaveClass('text-red-400')
    })

    it('given the disclosure is open with throttled clock, when expanded, then a throttle warning sigil appears', () => {
      // arrange
      render(<LiveStats status={status({ cpu_freq_pct: 80 })} />)

      // act
      fireEvent.click(screen.getByRole('button', { name: /system details/i }))

      // assert — the throttled aria-label sigil is present.
      expect(screen.getByLabelText('throttled')).toBeInTheDocument()
    })

    it('given memory at 93%, when details are expanded, then memory cell paints red', () => {
      // arrange
      render(
        <LiveStats
          status={status({ memory_used_mb: 1850, memory_total_mb: 1979 })}
        />,
      )

      // act
      fireEvent.click(screen.getByRole('button', { name: /system details/i }))

      // assert
      expect(screen.getByText('1.8/1.9 GB')).toHaveClass('text-red-400')
    })

    it('given load_avg is high, when details are expanded, then the load value paints yellow', () => {
      // arrange
      render(
        <LiveStats status={status({ load_avg: [2.5, 1.0, 0.5] })} />,
      )

      // act
      fireEvent.click(screen.getByRole('button', { name: /system details/i }))

      // assert
      expect(screen.getByText('2.50')).toHaveClass('text-yellow-400')
    })

    it('given the worker is reporting active gear, when details are expanded, then state row reads "Watching: active" (iter-356.14 microcopy preserved)', () => {
      // arrange
      render(
        <LiveStats
          status={status({
            worker_alive: true,
            worker_metrics: { infer_per_s: 1.7, gear: 'active', fps: 4.9 },
          })}
        />,
      )

      // act
      fireEvent.click(screen.getByRole('button', { name: /system details/i }))

      // assert — in the disclosed details panel only, not the summary.
      expect(screen.getByText('Watching: active')).toBeInTheDocument()
    })

    it('given disk is null, when details are expanded, then disk cell falls back to em-dash', () => {
      // arrange
      render(
        <LiveStats
          status={status({
            disk_free_gb: null,
            cpu_temp_c: null,
            gpu_temp_c: null,
            load_avg: null,
          })}
        />,
      )

      // act
      fireEvent.click(screen.getByRole('button', { name: /system details/i }))

      // assert — multiple em-dashes from null fields.
      const dashes = screen.getAllByText('—')
      expect(dashes.length).toBeGreaterThan(0)
    })
  })
})
