import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ServerStatus } from '../../lib/types'
import { PipelinePanel } from './PipelinePanel'
import { VitalsPanel } from './VitalsPanel'
import { WedgePanel } from './WedgePanel'
import { WorkerLivenessPanel } from './WorkerLivenessPanel'

function status(overrides: Partial<ServerStatus> = {}): ServerStatus {
  return {
    ok: true,
    uptime_s: 100,
    camera: 'ok',
    detection_active: true,
    worker_alive: true,
    worker_last_seen_s: 4,
    worker_metrics: {
      fps: 12,
      infer_ms_recent: 44,
      infer_ms_p95: 62,
      mediamtx_restarts: 0,
      argus_restarts: 0,
      uptime_s: 3600,
      gear: 'active',
    },
    cpu_temp_c: 45,
    gpu_temp_c: 55,
    cpu_freq_pct: 100,
    load_avg: [0.1, 0.2, 0.3],
    memory_used_mb: 512,
    memory_total_mb: 2048,
    disk_free_gb: 24,
    fps: 12,
    push_subs_count: 1,
    seconds_since_last_frame: 2,
    camera_label: 'Front Door',
    audio_enabled: false,
    ...overrides,
  }
}

describe('God View crash-cart panels', () => {
  it('Given a stale stream, When PipelinePanel renders, Then the down node exposes the reason as an accessible name', () => {
    // arrange / act
    render(<PipelinePanel status={status({ seconds_since_last_frame: 120 })} />)

    // assert
    expect(
      screen.getByRole('listitem', { name: /mediamtx down: stream stale/i }),
    ).toBeInTheDocument()
  })

  it('Given worker metrics are null, When WorkerLivenessPanel renders, Then CatEmptyState announces the silent worker state', () => {
    // arrange / act
    render(<WorkerLivenessPanel status={status({ worker_metrics: null })} />)

    // assert
    expect(screen.getByRole('status', { name: /worker is silent/i })).toBeInTheDocument()
  })

  it('Given null vitals fields, When VitalsPanel renders, Then empty stats render em-dashes', () => {
    // arrange / act
    render(
      <VitalsPanel
        status={status({
          cpu_temp_c: null,
          gpu_temp_c: null,
          memory_used_mb: null,
          memory_total_mb: null,
          cpu_freq_pct: null,
          load_avg: null,
        })}
      />,
    )

    // assert
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(5)
  })

  it('Given watchdog escalation metrics, When WedgePanel renders, Then it shows rung, guard, and diagnostics', () => {
    // arrange / act
    render(
      <WedgePanel
        now={1_700_002_000_000}
        metrics={{
          watchdog_level: 3,
          watchdog_last_action: 'restart_nvargus',
          watchdog_last_action_at: 1_700_001_700,
          watchdog_last_reboot_at: 1_700_001_200,
          watchdog_action_count: 4,
          wedge_diag_at: 1_700_001_940,
          wedge_diag_nvargus_rss_kb: 51200,
          wedge_diag_gpu_temp_c: 71,
          wedge_diag_mem_avail_mb: 384,
          wedge_diag_argus_pending: 2,
        }}
      />,
    )

    // assert
    expect(
      screen.getByRole('heading', { name: /capture wedge/i }),
    ).toBeInTheDocument()
    expect(screen.getByText(/Rung 3 of 5 - nvargus-daemon restart/i)).toBeInTheDocument()
    expect(screen.getByText(/nvargus-daemon restart - 5m ago/i)).toBeInTheDocument()
    expect(screen.getByText(/boot-loop guard active/i)).toBeInTheDocument()
    expect(screen.getByText('50.0 MB')).toBeInTheDocument()
    expect(screen.getByText('384 MB')).toBeInTheDocument()
  })

  it('Given no wedge diagnostics, When WedgePanel renders, Then CatEmptyState announces the healthy empty state', () => {
    // arrange / act
    render(<WedgePanel metrics={{ watchdog_level: 0, wedge_diag_at: 0 }} />)

    // assert
    expect(
      screen.getByRole('status', { name: /no camera wedges this session/i }),
    ).toBeInTheDocument()
  })
})
