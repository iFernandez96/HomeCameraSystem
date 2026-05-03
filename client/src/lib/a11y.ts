// iter-345: shared a11y helpers. Hoisted from iter-335 (ClipModal
// speed-pill radiogroup) and iter-339 (Events filter-chip radiogroup)
// after both reached identical implementations independently. Single
// source of truth for the WAI-ARIA Authoring Practices radiogroup
// keyboard navigation math.

/** WAI-ARIA Authoring Practices roving-tabindex radiogroup nav.
 *  Maps a keydown event's `key` to the next radio index in a
 *  horizontal radiogroup. Wraps at boundaries. Returns null when
 *  the key isn't a recognized navigation key — the caller should
 *  let the event bubble naturally.
 *
 *  - ArrowLeft / ArrowUp → previous (wrap from 0 → len-1)
 *  - ArrowRight / ArrowDown → next (wrap from len-1 → 0)
 *  - Home → 0
 *  - End → len - 1
 *
 *  Used by:
 *  - `client/src/components/ClipModal.tsx` speed-pill radiogroup
 *  - `client/src/pages/Events.tsx` filter-chip radiogroup
 */
export function nextRovingIndex(
  key: string,
  currentIdx: number,
  len: number,
): number | null {
  if (len <= 0) return null
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowUp':
      return (currentIdx - 1 + len) % len
    case 'ArrowRight':
    case 'ArrowDown':
      return (currentIdx + 1) % len
    case 'Home':
      return 0
    case 'End':
      return len - 1
    default:
      return null
  }
}
