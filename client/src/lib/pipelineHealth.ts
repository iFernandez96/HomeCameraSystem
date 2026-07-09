import type { ServerStatus } from './types'

export type PipelineStage = 'camera' | 'mediamtx' | 'detect' | 'server'
export type PipelineVerdict = 'up' | 'down' | 'warn' | 'unknown'

export type PipelineStageHealth = {
  stage: PipelineStage
  verdict: PipelineVerdict
  reason: string
}

export function derivePipeline(status: ServerStatus | null): PipelineStageHealth[] {
  const server: PipelineStageHealth = {
    stage: 'server',
    verdict: status?.ok ? 'up' : 'down',
    reason: status?.ok ? 'status API healthy' : 'status API down',
  }

  if (status === null) {
    return [
      { stage: 'camera', verdict: 'unknown', reason: 'no status yet' },
      { stage: 'mediamtx', verdict: 'unknown', reason: 'no frame freshness yet' },
      { stage: 'detect', verdict: 'unknown', reason: 'no worker status yet' },
      server,
    ]
  }

  const camera: PipelineStageHealth =
    status.camera === 'ok'
      ? { stage: 'camera', verdict: 'up', reason: 'camera ok' }
      : {
          stage: 'camera',
          verdict: 'down',
          reason: status.camera === 'missing' ? 'camera missing' : 'camera error',
        }

  // MediaMTX has no direct status field; the worker's frame freshness is
  // the liveness proxy for the camera -> MediaMTX -> worker stream path.
  const mediamtx: PipelineStageHealth =
    status.seconds_since_last_frame == null
      ? { stage: 'mediamtx', verdict: 'unknown', reason: 'no frames reported yet' }
      : status.seconds_since_last_frame > 60
        ? { stage: 'mediamtx', verdict: 'down', reason: 'STREAM STALE' }
        : { stage: 'mediamtx', verdict: 'up', reason: 'frames fresh' }

  const detect: PipelineStageHealth = !status.worker_alive
    ? { stage: 'detect', verdict: 'down', reason: 'worker silent' }
    : status.detection_active
      ? { stage: 'detect', verdict: 'up', reason: 'detection active' }
      : { stage: 'detect', verdict: 'warn', reason: 'detection off' }

  return [camera, mediamtx, detect, server]
}

export function gpuTempTone(c: number | null): 'neutral' | 'warn' | 'down' {
  if (c == null) return 'neutral'
  if (c >= 80) return 'down'
  if (c >= 70) return 'warn'
  return 'neutral'
}

export function cpuFreqTone(pct: number | null): 'neutral' | 'warn' {
  return pct != null && pct < 100 ? 'warn' : 'neutral'
}
