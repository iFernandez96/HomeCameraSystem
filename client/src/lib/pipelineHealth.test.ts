import { describe, expect, it } from 'vitest'
import { derivePipeline } from './pipelineHealth'
import type { ServerStatus } from './types'

function status(overrides: Partial<ServerStatus> = {}): ServerStatus {
  return {
    ok: true,
    uptime_s: 100,
    camera: 'ok',
    detection_active: true,
    worker_alive: true,
    worker_last_seen_s: 2,
    worker_metrics: {},
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

describe('derivePipeline', () => {
  it('Given status has no direct camera or MediaMTX probes, When derived, Then those stages stay unknown while detection and server are up', () => {
    // arrange / act
    const stages = derivePipeline(status())

    // assert
    expect(stages.map((s) => s.verdict)).toEqual(['unknown', 'unknown', 'up', 'up'])
  })

  it('Given detector frame age is 120 seconds, When derived, Then detection intake is down while MediaMTX remains unknown', () => {
    // arrange / act
    const stages = derivePipeline(status({ seconds_since_last_frame: 120 }))

    // assert
    expect(stages[1]).toMatchObject({ stage: 'mediamtx', verdict: 'unknown' })
    expect(stages[2]).toMatchObject({
      stage: 'detect',
      verdict: 'down',
      reason: 'frame intake stalled',
    })
  })

  it('Given seconds_since_last_frame is null, When derivePipeline runs, Then the MediaMTX stage is unknown', () => {
    // arrange / act
    const mediamtx = derivePipeline(status({ seconds_since_last_frame: null }))[1]

    // assert
    expect(mediamtx).toMatchObject({ stage: 'mediamtx', verdict: 'unknown' })
  })

  it('Given worker_alive true but detection_active false, When derivePipeline runs, Then the detect stage is warn', () => {
    // arrange / act
    const detect = derivePipeline(status({ detection_active: false }))[2]

    // assert
    expect(detect).toMatchObject({ stage: 'detect', verdict: 'warn' })
    expect(detect.reason).toMatch(/detection off/i)
  })

  it("Given camera 'error', When derivePipeline runs, Then the camera stage is down", () => {
    // arrange / act
    const camera = derivePipeline(status({ camera: 'error' }))[0]

    // assert
    expect(camera).toMatchObject({ stage: 'camera', verdict: 'down' })
  })
})
