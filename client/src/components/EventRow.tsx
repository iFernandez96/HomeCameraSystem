import type { DetectionEvent } from '../lib/types'
import { clockTime, eventTitle } from '../lib/eventLabel'
import { identityOf } from '../lib/identity'
import { useRipple } from '../lib/ripple'
import { WhoMark } from './WhoMark'

/**
 * EventRow — the shared Playroom event card row (Watch story, Events
 * list, Review "more from tonight"). Renders as a `<button>` when
 * `onOpen` is given (with the app's press ripple), else a plain,
 * non-interactive `<div>`.
 */
const ROW_CLASSES =
  'rounded-[var(--radius-xl)] border-[1.5px] border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 flex items-center gap-3'

export function EventRow({
  event,
  subline,
  onOpen,
}: {
  event: DetectionEvent
  subline: string
  onOpen?: () => void
}) {
  const ripple = useRipple()
  const identity = identityOf(event)
  const title = eventTitle(event)
  const time = clockTime(event.ts)

  const content = (
    <>
      <WhoMark identity={identity} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13.5px] font-bold">{title}</div>
        <div className="truncate text-[var(--color-text-secondary)]">{subline}</div>
      </div>
      <div className="shrink-0 tabular-nums text-[var(--color-text-tertiary)]">{time}</div>
    </>
  )

  if (onOpen) {
    return (
      <button
        type="button"
        className={`${ROW_CLASSES} relative overflow-hidden w-full text-left`}
        onClick={onOpen}
        onPointerDown={ripple}
      >
        {content}
      </button>
    )
  }

  return <div className={ROW_CLASSES}>{content}</div>
}
