import type { DetectionEvent } from '../lib/types'

export type EventVideoStatus = NonNullable<DetectionEvent['video_status']>

const STATUS_LABEL: Record<EventVideoStatus, string> = {
  recording: 'Recording video — person in scene, ETA paused',
  finalizing: 'Finalizing video',
  available: 'Video available',
  failed: 'Video unavailable',
  unknown: 'Video status unknown',
}

export function formatEventVideoEta(
  minTs: number | null | undefined,
  maxTs: number | null | undefined,
  nowMs: number,
): string {
  if (
    typeof minTs !== 'number' ||
    typeof maxTs !== 'number' ||
    !Number.isFinite(minTs) ||
    !Number.isFinite(maxTs) ||
    minTs > maxTs
  ) {
    return 'Estimating…'
  }

  const nowTs = nowMs / 1000
  const minRemainingS = minTs - nowTs
  const maxRemainingS = maxTs - nowTs
  if (maxRemainingS <= 0) return 'Finishing…'
  if (maxRemainingS < 60) return '<1 min'

  const upperMinutes = Math.ceil(maxRemainingS / 60)
  if (minRemainingS < 60) return `<${upperMinutes} min`

  // Round outward so the display never promises a narrower window
  // than the authoritative server bounds. This intentionally favors
  // a conservative range over false second-level precision.
  const lowerMinutes = Math.floor(minRemainingS / 60)
  if (lowerMinutes === upperMinutes) return `~${upperMinutes} min`
  return `~${lowerMinutes}–${upperMinutes} min`
}

export function formatCalibratedVideoEta(pointTs: number, nowMs: number): string {
  const remainingS = Math.max(0, pointTs - nowMs / 1000)
  if (remainingS < 60) {
    return `~${Math.max(5, Math.ceil(remainingS / 5) * 5)}s`
  }
  if (remainingS < 10 * 60) {
    const roundedS = Math.max(60, Math.round(remainingS / 15) * 15)
    const minutes = Math.floor(roundedS / 60)
    const seconds = roundedS % 60
    return seconds === 0 ? `~${minutes}m` : `~${minutes}m ${seconds}s`
  }
  return `~${Math.round(remainingS / 60)}m`
}

/**
 * One truthful video-lifecycle indicator for every event surface.
 * Callers must pass the server's explicit `video_status` value (or
 * `unknown` when the field is absent); this component deliberately
 * never guesses from clip_url, thumbnails, or event age.
 */
export function EventVideoStatusIcon({
  status,
  placement = 'inline',
  etaMinTs,
  etaMaxTs,
  etaPointTs,
  etaModelSamples,
  etaBacktestMedianErrorS,
  etaLiveProgress,
  activityPresent,
  finalizeIfClearTs,
  nowMs,
}: {
  status: EventVideoStatus
  placement?: 'axis' | 'inline'
  etaMinTs?: number | null
  etaMaxTs?: number | null
  etaPointTs?: number | null
  etaModelSamples?: number | null
  etaBacktestMedianErrorS?: number | null
  etaLiveProgress?: boolean
  activityPresent?: boolean | null
  finalizeIfClearTs?: number | null
  nowMs?: number
}) {
  const loading = status === 'recording' || status === 'finalizing'
  const nowTs = nowMs == null ? null : nowMs / 1000
  const personPresent = status === 'recording' && activityPresent !== false
  const clearRemainingS = status === 'recording'
    && !personPresent
    && nowTs != null
    && typeof finalizeIfClearTs === 'number'
    && Number.isFinite(finalizeIfClearTs)
    ? Math.max(0, finalizeIfClearTs - nowTs)
    : null
  const eta = status === 'recording'
    ? personPresent
      ? 'Person in scene'
      : clearRemainingS != null && clearRemainingS > 0
        ? `Clear · ${Math.ceil(clearRemainingS)}s`
        : 'Confirming clear…'
    : loading
    ? nowMs == null
      ? 'Estimating…'
      : typeof etaPointTs === 'number' && Number.isFinite(etaPointTs)
          && (etaLiveProgress === true
            || (typeof etaModelSamples === 'number' && etaModelSamples >= 8))
          ? formatCalibratedVideoEta(etaPointTs, nowMs)
          : formatEventVideoEta(etaMinTs, etaMaxTs, nowMs)
    : null
  const etaTitle = status === 'recording'
    ? personPresent
      ? 'ETA is paused; leaving and returning continues the same capture'
      : 'Scene is temporarily clear; this countdown resets if the person returns'
    : etaLiveProgress
    ? 'Calculated from live video-validation progress and measured speed'
    : eta && typeof etaModelSamples === 'number' && etaModelSamples >= 8
      ? `Calibrated from ${etaModelSamples} completed videos${
        typeof etaBacktestMedianErrorS === 'number'
          ? `; walk-forward median error about ${Math.round(etaBacktestMedianErrorS)} seconds`
          : ''
      }`
      : undefined
  const statusLabel = status === 'recording'
    ? personPresent
      ? 'Recording video — person in scene, ETA paused'
      : clearRemainingS != null && clearRemainingS > 0
        ? `Recording video — scene temporarily clear, finalizing in ${Math.ceil(clearRemainingS)} seconds unless the person returns`
        : 'Recording video — confirming the scene is clear'
    : STATUS_LABEL[status]
  const wrapperClass =
    placement === 'axis'
      ? 'absolute left-[3.45rem] top-2 w-6'
      : `relative shrink-0 items-center ${loading ? 'flex w-16 flex-col gap-1' : 'inline-flex w-6'}`
  const etaClass =
    placement === 'axis'
      ? 'absolute right-0 top-7 w-16 text-right'
      : 'block text-center'

  return (
    <span className={wrapperClass}>
      <span
        role="img"
        aria-label={statusLabel}
        data-testid="event-video-status"
        data-video-status={status}
        className={`relative inline-flex h-6 w-6 items-center justify-center rounded-full text-[var(--color-text-secondary)] ring-1 ring-[var(--color-border-subtle)] ${
          placement === 'axis'
            ? 'bg-[var(--color-bg)]'
            : 'bg-[var(--color-surface-raised)]'
        }`}
      >
        <svg
          aria-hidden="true"
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="2.5" y="6" width="13" height="12" rx="2" />
          <path d="m15.5 10 6-3v10l-6-3" />
          {status === 'failed' ? (
            <path d="M4 4 20 20" strokeWidth="2.4" />
          ) : null}
          {status === 'unknown' ? (
            <path d="M10 10.1a2.2 2.2 0 1 1 3.5 1.8c-.9.6-1.5 1-1.5 2M12 17h.01" />
          ) : null}
        </svg>
        {status === 'finalizing' || (status === 'recording' && !personPresent) ? (
          <span
            aria-hidden="true"
            className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 animate-spin rounded-full border-2 border-[var(--color-bg)] border-t-[var(--color-accent-default)]"
          />
        ) : status === 'recording' ? (
          <span
            aria-hidden="true"
            className="absolute -right-0.5 -top-0.5 inline-flex h-3 w-3 items-center justify-center gap-px rounded-full border border-[var(--color-bg)] bg-[var(--color-accent-default)]"
          >
            <span className="h-1.5 w-px rounded-full bg-[var(--color-on-accent)]" />
            <span className="h-1.5 w-px rounded-full bg-[var(--color-on-accent)]" />
          </span>
        ) : null}
      </span>
      {eta ? (
        <span
          title={etaTitle}
          className={`${etaClass} whitespace-nowrap text-[9px] font-medium leading-none text-[var(--color-text-tertiary)]`}
        >
          {eta}
        </span>
      ) : null}
    </span>
  )
}
