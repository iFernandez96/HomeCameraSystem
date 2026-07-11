import type { EventClipStatus } from '../lib/api'

type ClipStateTone = 'good' | 'pending' | 'bad' | 'neutral'

export function getClipStatePresentation({
  hasOwnClip,
  clipStatus,
  clipGone,
  clipInRecheckWindow,
}: ClipStateBadgeProps): { label: string; detail: string; tone: ClipStateTone } {
  if (!hasOwnClip) {
    return {
      label: 'No separate video',
      detail: 'This event was covered by another nearby recording. Check More from tonight.',
      tone: 'neutral',
    }
  }
  switch (clipStatus?.state) {
    case 'available':
      return { label: 'Video available', detail: 'The server has published this event video.', tone: 'good' }
    case 'recording':
      return { label: 'Recording now', detail: 'The recorder is still writing this event. Playback will appear after publishing.', tone: 'pending' }
    case 'finalizing':
      return { label: 'Publishing video', detail: 'Recording has ended. The server is assembling the clip.', tone: 'pending' }
    case 'failed':
      return {
        label: 'Video failed',
        detail: clipStatus.failure_summary
          ?? 'The server could not save this video. The snapshot remains captured evidence.',
        tone: 'bad',
      }
    case 'unknown':
      return {
        label: clipGone ? 'Video status unknown' : 'Checking video state',
        detail: clipGone
          ? 'The server has no recording ledger entry for this event. This can happen for older events.'
          : 'The clip is being requested, but the server has no ledger entry for this event.',
        tone: 'neutral',
      }
    default:
      if (!clipGone) {
        return { label: 'Video available', detail: 'The player is loading this event video.', tone: 'good' }
      }
      return clipInRecheckWindow
        ? { label: 'Checking video', detail: 'The video is not available yet. The app is still checking for it.', tone: 'pending' }
        : { label: 'No video available', detail: 'No video is available for this event. The snapshot remains captured evidence.', tone: 'neutral' }
  }
}

const toneClass: Record<ClipStateTone, string> = {
  good: 'bg-[var(--color-success-bg)] text-[var(--color-success)] border-[var(--color-success)]/30',
  pending: 'bg-[var(--color-warning-bg)] text-[var(--color-warning)] border-[var(--color-warning)]/35',
  bad: 'bg-[var(--color-danger-bg)] text-[var(--color-danger)] border-[var(--color-danger)]/35',
  neutral: 'bg-[var(--color-surface-raised)] text-[var(--color-text-secondary)] border-[var(--color-border)]',
}

const dotClass: Record<ClipStateTone, string> = {
  good: 'bg-[var(--color-success)]',
  pending: 'bg-[var(--color-warning)]',
  bad: 'bg-[var(--color-danger)]',
  neutral: 'bg-[var(--color-text-tertiary)]',
}

interface ClipStateBadgeProps {
  hasOwnClip: boolean
  clipStatus: EventClipStatus | null
  clipGone: boolean
  clipInRecheckWindow: boolean
}

export function ClipStateBadge(props: ClipStateBadgeProps) {
  const state = getClipStatePresentation(props)
  if (state.label === 'Video available') return null

  return (
    <div
      role="status"
      aria-live="polite"
      title={state.detail}
      className={`pointer-events-none absolute left-3 top-3 z-10 inline-flex max-w-[calc(100%-1.5rem)] items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold shadow-[var(--shadow-overlay)] backdrop-blur landscape-phone:top-[4.25rem] landscape-phone:px-2.5 landscape-phone:py-1 tablet-landscape:top-[4.25rem] ${toneClass[state.tone]}`}
    >
      <span aria-hidden="true" className={`h-2 w-2 flex-shrink-0 rounded-full ${dotClass[state.tone]}`} />
      <span className="truncate">{state.label}</span>
    </div>
  )
}
