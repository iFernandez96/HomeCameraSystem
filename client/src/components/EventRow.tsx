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
      {/* Decorative — the accessible identity already lands in the
          title text below, so a nested role="img" here would double-
          announce ("A cat, Cat at the front door…"). Matches
          EventList.tsx's EventCard WhoMark wrapper. */}
      <span aria-hidden="true">
        <WhoMark identity={identity} />
      </span>
      <div className="min-w-0 flex-1">
        {/* Overhaul W1 item 6 (mira#2): 13.5px was a one-off size —
            mapped onto the --text-sm token (14px). */}
        <div className="truncate text-sm font-bold">{title}</div>
        {/* Final whole-branch review fix batch #2: subline + time were
            inheriting the 16px base — LARGER than the bold 13.5px
            title, inverting the type hierarchy. text-xs pins both
            below the title. */}
        <div className="truncate text-xs text-[var(--color-text-secondary)]">{subline}</div>
      </div>
      <div className="shrink-0 text-xs tabular-nums text-[var(--color-text-tertiary)]">{time}</div>
    </>
  )

  if (onOpen) {
    return (
      // Overhaul W1 item 8 (landscape B1): hover/active/focus parity
      // with EventList's EventCard — same border-strong + raised
      // surface treatment, so the two "one card language" components
      // respond identically to a pointer.
      <button
        type="button"
        className={`${ROW_CLASSES} relative overflow-hidden w-full text-left transition-colors hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-raised)] active:border-[var(--color-border-strong)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2`}
        onClick={onOpen}
        onPointerDown={ripple}
      >
        {content}
      </button>
    )
  }

  return <div className={ROW_CLASSES}>{content}</div>
}
