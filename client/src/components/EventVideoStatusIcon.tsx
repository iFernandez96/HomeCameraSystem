import type { DetectionEvent } from '../lib/types'

export type EventVideoStatus = NonNullable<DetectionEvent['video_status']>

const STATUS_LABEL: Record<EventVideoStatus, string> = {
  recording: 'Recording video',
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
  nowMs,
}: {
  status: EventVideoStatus
  placement?: 'axis' | 'inline'
  etaMinTs?: number | null
  etaMaxTs?: number | null
  nowMs?: number
}) {
  const loading = status === 'recording' || status === 'finalizing'
  const eta = loading
    ? nowMs == null
      ? 'Estimating…'
      : formatEventVideoEta(etaMinTs, etaMaxTs, nowMs)
    : null
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
        aria-label={STATUS_LABEL[status]}
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
        {loading ? (
          <span
            aria-hidden="true"
            className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 animate-spin rounded-full border-2 border-[var(--color-bg)] border-t-[var(--color-accent-default)]"
          />
        ) : null}
      </span>
      {eta ? (
        <span
          className={`${etaClass} whitespace-nowrap text-[9px] font-medium leading-none text-[var(--color-text-tertiary)]`}
        >
          {eta}
        </span>
      ) : null}
    </span>
  )
}
