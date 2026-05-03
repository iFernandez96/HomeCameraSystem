import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { useToast } from '../lib/toast'
import type { Zone, ZonePoint } from '../lib/types'

/**
 * iter-191c (Feature #5): in-frame polygon-mask editor.
 *
 * iter-295 (user-reported "really difficult"): full UX overhaul.
 * Pre-iter-295 the editor was effectively MVP — click to add a
 * vertex, no drag, no undo, no edit-existing-polygon. A typo in
 * vertex 4 of an 8-point polygon meant deleting the whole zone
 * and restarting. Vertex dots were r=0.012 (~6 px on a 480 px-wide
 * mobile editor) which is far below the WCAG 44 px target.
 *
 * iter-295 changes:
 *   - **Pointer drag-to-move** every vertex (committed AND
 *     in-progress) via PointerEvent so mouse + touch + pen all
 *     share one code path.
 *   - **Bigger hit zones**: a transparent r=0.04 hit-ring sits on
 *     top of each visible r=0.018 vertex dot. The hit ring scales
 *     to ~32 px on a 800 px editor, comfortable for thumbs.
 *   - **Undo last point** during draw — the most-requested mid-
 *     draw correction.
 *   - **Live coordinate readout** floating on pointer move so the
 *     user knows where the next click will land.
 *   - **Active-zone selection**: tap a committed polygon to
 *     highlight it; vertices become draggable + delete is one
 *     button below the editor (not a tiny ✕ in the listing).
 *
 * Coordinate space:
 *   - Zone payloads are NORMALIZED [0, 1] (the iter-191 schema).
 *   - SVG uses `viewBox="0 0 1 1"` so the overlay's pixel size is
 *     decoupled from the wire shape.
 *   - Pointer events translate via `getBoundingClientRect()`,
 *     clamped to [0, 1].
 *
 * Drag-vs-add disambiguation: `pointerdown` on a vertex starts a
 * drag; `pointerup` on empty space adds a new vertex (only when
 * no drag was in progress and we're authoring a polygon). The
 * `_dragMoved` flag distinguishes click-vs-drag — if pointer
 * moved more than ~2% of the editor between down + up, treat as
 * drag, not click.
 */

type DragHandle =
  | { kind: 'inProgress'; vertexIndex: number }
  | { kind: 'committed'; zoneIndex: number; vertexIndex: number }

const _DRAG_THRESHOLD = 0.02 // 2% of editor — distinguishes click vs drag

export function ZoneEditor({
  zones,
  onChange,
  snapshotUrl = '/snapshots/latest.jpg',
}: {
  zones: Zone[]
  onChange: (zones: Zone[]) => void
  snapshotUrl?: string
}) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [inProgress, setInProgress] = useState<ZonePoint[]>([])
  const [inputX, setInputX] = useState('50')
  const [inputY, setInputY] = useState('50')
  const [announce, setAnnounce] = useState('')
  // iter-295: which committed polygon is selected for editing.
  // null = no selection; vertex drag still works on in-progress.
  // When a polygon is selected, its vertices become draggable + a
  // big "Delete this zone" button appears below the editor.
  const [selectedZone, setSelectedZone] = useState<number | null>(null)
  // Active drag operation. null when not dragging.
  const [drag, setDrag] = useState<DragHandle | null>(null)
  // iter-310 (ux-grandpa Frank Gripe #3): "I see the green shape.
  // I tap it. Nothing. I tap it harder." Visual confirmation that
  // the tap registered: track the index of the most recently
  // SELECTED zone so we can render a 700 ms white outline pulse
  // over it. Cleared by a setTimeout effect below; re-fires on
  // every fresh selection (the timestamp is part of the state so
  // re-selecting the same zone re-runs the animation).
  const [flashSelect, setFlashSelect] = useState<{
    index: number
    at: number
  } | null>(null)
  useEffect(() => {
    if (flashSelect === null) return
    const t = setTimeout(() => setFlashSelect(null), 700)
    return () => clearTimeout(t)
  }, [flashSelect])
  // Live cursor coords for the floating readout. null = pointer
  // outside SVG. Tracks whatever pointer is over the editor.
  const [cursor, setCursor] = useState<ZonePoint | null>(null)
  // Distance dragged in normalized space (Manhattan). Resets on
  // pointerdown; if it stays under _DRAG_THRESHOLD across
  // pointerdown→up, treat as a click (which can add a vertex).
  const dragMovedRef = useRef(0)
  const { showToast } = useToast()

  function clientToNormalized(clientX: number, clientY: number): ZonePoint {
    const el = svgRef.current
    if (!el) return [0, 0]
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return [0, 0]
    const x = (clientX - rect.left) / rect.width
    const y = (clientY - rect.top) / rect.height
    return [
      Math.max(0, Math.min(1, x)),
      Math.max(0, Math.min(1, y)),
    ]
  }

  function addVertex(point: ZonePoint) {
    setInProgress((cur) => [...cur, point])
    setSelectedZone(null) // adding a new vertex always targets in-progress
    setAnnounce(
      `Vertex ${inProgress.length + 1} added at ${Math.round(point[0] * 100)} percent, ${Math.round(point[1] * 100)} percent.`,
    )
  }

  function handleSvgClick(e: ReactMouseEvent<SVGSVGElement>) {
    // iter-295: tap-on-empty-space adds a vertex only when (a) no
    // drag just happened, (b) we're not in drag mode (handled by
    // pointerup ordering), and (c) target is the SVG itself, not a
    // child handle. The target check prevents click-through from
    // a vertex tap landing as an "add vertex on top of vertex".
    if (dragMovedRef.current >= _DRAG_THRESHOLD) return
    if (e.target !== svgRef.current) return
    const point = clientToNormalized(e.clientX, e.clientY)
    addVertex(point)
  }

  function handlePointerMove(e: ReactPointerEvent<SVGSVGElement>) {
    const point = clientToNormalized(e.clientX, e.clientY)
    setCursor(point)
    if (drag === null) return
    // Track total distance moved to disambiguate click vs drag at
    // pointerup time.
    dragMovedRef.current += Math.abs(point[0] - (cursor?.[0] ?? point[0]))
    if (drag.kind === 'inProgress') {
      setInProgress((cur) => {
        const next = [...cur]
        next[drag.vertexIndex] = point
        return next
      })
    } else {
      const nextZones = zones.map((poly, zi) => {
        if (zi !== drag.zoneIndex) return poly
        const np = [...poly]
        np[drag.vertexIndex] = point
        return np
      })
      onChange(nextZones)
    }
  }

  function handleVertexPointerDown(
    e: ReactPointerEvent<SVGCircleElement>,
    handle: DragHandle,
  ) {
    e.stopPropagation()
    // Capture the pointer so move/up events fire on this element
    // even if the pointer leaves the SVG bounds mid-drag.
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
    dragMovedRef.current = 0
    setDrag(handle)
    if (handle.kind === 'committed') {
      setSelectedZone(handle.zoneIndex)
    }
  }

  function handlePointerUp() {
    setDrag(null)
    // Decay the drag-moved flag on next macrotask so the SVG's
    // click handler (which fires AFTER pointerup) sees the right
    // value when distinguishing click vs drag.
    setTimeout(() => {
      dragMovedRef.current = 0
    }, 0)
  }

  function handleKeyboardAdd() {
    const xPct = parseFloat(inputX)
    const yPct = parseFloat(inputY)
    if (!Number.isFinite(xPct) || !Number.isFinite(yPct)) {
      showToast('Enter X and Y as numbers between 0 and 100', 'error')
      return
    }
    if (xPct < 0 || xPct > 100 || yPct < 0 || yPct > 100) {
      showToast('X and Y must be between 0 and 100', 'error')
      return
    }
    addVertex([xPct / 100, yPct / 100])
  }

  function finishPolygon() {
    if (inProgress.length < 3) return
    onChange([...zones, inProgress])
    setInProgress([])
    setAnnounce(`Polygon committed with ${inProgress.length} points.`)
  }

  function cancelInProgress() {
    setInProgress([])
    setAnnounce('Polygon cancelled.')
  }

  // iter-295: undo last in-progress vertex. Most-common mid-draw
  // correction; pre-iter-295 the user had to Cancel + restart from
  // vertex 1.
  function undoLastVertex() {
    setInProgress((cur) => {
      if (cur.length === 0) return cur
      const next = cur.slice(0, -1)
      setAnnounce(`Removed last vertex. ${next.length} remaining.`)
      return next
    })
  }

  function deleteZone(index: number) {
    onChange(zones.filter((_, i) => i !== index))
    if (selectedZone === index) setSelectedZone(null)
    setAnnounce(`Zone ${index + 1} deleted.`)
  }

  function pointsAttr(poly: ZonePoint[]): string {
    return poly.map(([x, y]) => `${x},${y}`).join(' ')
  }

  const canFinish = inProgress.length >= 3
  const drawing = inProgress.length > 0
  const cursorReadout = cursor
    ? `${Math.round(cursor[0] * 100)}%, ${Math.round(cursor[1] * 100)}%`
    : ''

  // iter-297 (ux-grandpa Gripe #2): the disabled-Finish button used
  // to read "Finish polygon (1 pts)" — Frank tapped it, nothing
  // happened, no clue why. Now the label spells out what's missing
  // ("need 2 more") so the disabled state is self-explanatory.
  const finishLabel = canFinish
    ? `Finish polygon (${inProgress.length} pts)`
    : `Finish polygon (need ${3 - inProgress.length} more)`

  // iter-297: directive top-line help — was generic ("Tap to add
  // another"), now spells out the exact next action so the user
  // never wonders "OK I have 2 points, now what".
  const drawingHelp = (() => {
    if (inProgress.length === 1) {
      return 'Drawing — 1 point. Tap inside the frame to add the next (need 2 more).'
    }
    if (inProgress.length === 2) {
      return 'Drawing — 2 points. Tap inside the frame once more, then Finish polygon.'
    }
    return `Drawing — ${inProgress.length} points. Drag any dot to move it. Tap Finish polygon when done.`
  })()

  return (
    <div className="flex flex-col gap-3">
      {/* Top help row — short, action-oriented. iter-295 replaces the
          paragraph at the bottom with this so the user reads it
          BEFORE they start tapping. iter-297 made the drawing branch
          state-specific. */}
      <p className="px-1 text-xs text-[var(--color-text-secondary)]">
        {drawing
          ? drawingHelp
          : selectedZone !== null
            ? `Editing zone ${selectedZone + 1}. Drag a dot to move it, or delete the zone below.`
            : zones.length === 0
              ? 'Tap inside the frame to drop the first vertex of a polygon.'
              : 'Tap a polygon to edit it, or tap empty space to start a new one.'}
      </p>

      <div className="relative w-full aspect-video bg-[var(--color-surface-raised)] rounded overflow-hidden touch-none">
        <img
          src={snapshotUrl}
          alt="Latest camera frame"
          className="absolute inset-0 w-full h-full object-cover pointer-events-none select-none"
          onError={(e) => {
            ;(e.currentTarget as HTMLImageElement).style.visibility = 'hidden'
          }}
        />
        <svg
          ref={svgRef}
          viewBox="0 0 1 1"
          preserveAspectRatio="none"
          onClick={handleSvgClick}
          onPointerMove={handlePointerMove}
          onPointerLeave={() => setCursor(null)}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          className="absolute inset-0 w-full h-full cursor-crosshair"
          // iter-295: drop role="img" — the SVG is interactive, not
          // decorative. role="application" tells AT it's a custom
          // widget; the keyboard X/Y form below is the SR-accessible
          // path (iter-274). aria-label describes what the editor
          // does.
          role="application"
          aria-label="Detection zone editor — tap to add vertex, drag a dot to move it"
        >
          {/* Committed polygons — selected one gets a thicker
              stroke + brighter fill so the user knows which is
              active for editing. */}
          {zones.map((poly, i) => {
            const isSelected = selectedZone === i
            return (
              <polygon
                key={i}
                points={pointsAttr(poly)}
                fill={
                  isSelected
                    ? 'rgba(59, 130, 246, 0.30)' // blue when editing
                    : 'rgba(16, 185, 129, 0.22)' // emerald otherwise
                }
                stroke={
                  isSelected ? 'rgb(59, 130, 246)' : 'rgb(16, 185, 129)'
                }
                strokeWidth={isSelected ? '0.008' : '0.005'}
                onClick={(e) => {
                  e.stopPropagation()
                  if (drawing) return
                  setSelectedZone(i)
                  setFlashSelect({ index: i, at: Date.now() })
                }}
                style={{ cursor: drawing ? 'crosshair' : 'pointer' }}
                data-testid={`zone-${i}`}
              />
            )
          })}
          {/* iter-310 (Frank Gripe #3): brief white outline pulse on
              freshly-selected polygon. Renders on top of the polygon
              fill (same z-order) but with no fill + thick white
              stroke + animate-pulse so the user gets unmistakable
              "yes I heard your tap" feedback. Auto-clears after 700 ms
              via the useEffect above. pointerEvents=none so it never
              swallows clicks meant for the polygon below. */}
          {flashSelect !== null &&
            zones[flashSelect.index] !== undefined && (
              <polygon
                key={`flash-${flashSelect.at}`}
                points={pointsAttr(zones[flashSelect.index])}
                fill="none"
                stroke="white"
                strokeWidth="0.014"
                opacity={0.85}
                className="animate-pulse"
                style={{ pointerEvents: 'none' }}
                data-testid={`zone-${flashSelect.index}-flash`}
              />
            )}
          {/* Vertex handles for the selected committed polygon —
              draggable. */}
          {selectedZone !== null &&
            !drawing &&
            zones[selectedZone]?.map(([x, y], vi) => (
              <g key={`zsel-${vi}`}>
                {/* Big invisible hit ring for thumb-friendly grab. */}
                <circle
                  cx={x}
                  cy={y}
                  r="0.04"
                  fill="transparent"
                  onPointerDown={(e) =>
                    handleVertexPointerDown(e, {
                      kind: 'committed',
                      zoneIndex: selectedZone,
                      vertexIndex: vi,
                    })
                  }
                  style={{ cursor: 'grab', touchAction: 'none' }}
                  data-testid={`zone-${selectedZone}-vertex-${vi}`}
                />
                {/* Visible dot. */}
                <circle
                  cx={x}
                  cy={y}
                  r="0.018"
                  fill="rgb(59, 130, 246)"
                  stroke="white"
                  strokeWidth="0.004"
                  pointerEvents="none"
                />
              </g>
            ))}
          {/* In-progress polyline + vertices. Vertices are draggable
              for mid-draw corrections. */}
          {inProgress.length > 0 && (
            <>
              {inProgress.length >= 2 && (
                <polyline
                  points={pointsAttr(inProgress)}
                  fill="none"
                  stroke="rgb(245, 158, 11)"
                  strokeWidth="0.006"
                  strokeDasharray="0.012,0.008"
                />
              )}
              {/* iter-295 (architect step 1 polish): closing-line
                  preview from last vertex back to first once we
                  have ≥3 points. Visualizes what "Finish polygon"
                  will commit, so the user can see the closure
                  before they tap. */}
              {inProgress.length >= 3 && (
                <line
                  x1={inProgress[inProgress.length - 1][0]}
                  y1={inProgress[inProgress.length - 1][1]}
                  x2={inProgress[0][0]}
                  y2={inProgress[0][1]}
                  stroke="rgb(245, 158, 11)"
                  strokeWidth="0.004"
                  strokeDasharray="0.008,0.012"
                  opacity="0.6"
                />
              )}
              {inProgress.map(([x, y], i) => (
                <g key={`ip-${i}`}>
                  <circle
                    cx={x}
                    cy={y}
                    r="0.04"
                    fill="transparent"
                    onPointerDown={(e) =>
                      handleVertexPointerDown(e, {
                        kind: 'inProgress',
                        vertexIndex: i,
                      })
                    }
                    style={{ cursor: 'grab', touchAction: 'none' }}
                    data-testid={`in-progress-vertex-hit-${i}`}
                  />
                  <circle
                    cx={x}
                    cy={y}
                    r="0.018"
                    fill="rgb(245, 158, 11)"
                    stroke="white"
                    strokeWidth="0.004"
                    pointerEvents="none"
                    data-testid={`in-progress-vertex-${i}`}
                  />
                </g>
              ))}
            </>
          )}
        </svg>

        {/* iter-295: live coordinate readout. Floats top-right of
            the editor so the user sees where the next tap will
            land. Pointer-events-none so it doesn't interfere with
            taps underneath. */}
        {cursor && (
          <div className="absolute top-2 right-2 px-2 py-1 rounded bg-black/60 backdrop-blur text-xs text-zinc-100 tabular-nums pointer-events-none">
            {cursorReadout}
          </div>
        )}
      </div>

      {/* Primary actions row — Finish + Undo + Cancel during
          draw; Delete-selected when a committed zone is selected;
          empty otherwise. */}
      {drawing && (
        <div className="flex flex-wrap gap-2 text-sm">
          <button
            type="button"
            onClick={finishPolygon}
            disabled={!canFinish}
            className="bg-[var(--color-success)] hover:bg-[var(--color-success)]/90 text-white disabled:opacity-40 disabled:cursor-not-allowed rounded px-3 py-2 font-medium"
          >
            {finishLabel}
          </button>
          <button
            type="button"
            onClick={undoLastVertex}
            className="bg-[var(--color-surface-raised)] hover:bg-[var(--color-accent-subtle)] text-[var(--color-text-primary)] border border-[var(--color-border)] rounded px-3 py-2"
          >
            Undo last point
          </button>
          <button
            type="button"
            onClick={cancelInProgress}
            className="bg-[var(--color-surface-raised)] hover:bg-[var(--color-accent-subtle)] text-[var(--color-text-primary)] border border-[var(--color-border)] rounded px-3 py-2"
          >
            Cancel
          </button>
        </div>
      )}
      {!drawing && selectedZone !== null && (
        <div className="flex flex-wrap gap-2 text-sm">
          <button
            type="button"
            onClick={() => deleteZone(selectedZone)}
            className="bg-[var(--color-danger)] hover:bg-[var(--color-danger)]/90 text-white rounded px-3 py-2 font-medium"
            // iter-295: aria-label matches the visible text so it
            // doesn't collide with the per-row ✕ button below
            // (which uses `Delete zone N` for direct addressing).
            aria-label={`Delete this zone (${selectedZone + 1})`}
          >
            Delete this zone
          </button>
          <button
            type="button"
            onClick={() => setSelectedZone(null)}
            className="bg-[var(--color-surface-raised)] hover:bg-[var(--color-accent-subtle)] text-[var(--color-text-primary)] border border-[var(--color-border)] rounded px-3 py-2"
          >
            Done editing
          </button>
        </div>
      )}

      {/* iter-274 (accessibility-auditor #2 slice a) keyboard input
          path. Kept after the iter-295 redesign for screen-reader
          parity — the visual path is now drag-friendly but a sighted
          keyboard-only user can still author a polygon vertex by
          vertex via X% / Y% inputs. Collapsed visually below the
          primary controls so it doesn't compete with the drag UX. */}
      <details className="text-sm border border-[var(--color-border)] rounded">
        <summary className="px-3 py-2 cursor-pointer text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] select-none">
          Add vertex by typing coordinates
        </summary>
        <fieldset
          className="flex flex-col sm:flex-row sm:flex-wrap sm:items-end gap-2 p-3 border-t border-[var(--color-border)]"
          aria-label="Add vertex by coordinate"
        >
          <label className="flex flex-col gap-1">
            <span className="text-xs text-[var(--color-text-secondary)]">X (0-100%)</span>
            <input
              type="number"
              min={0}
              max={100}
              step={1}
              value={inputX}
              onChange={(e) => setInputX(e.target.value)}
              aria-label="Vertex X coordinate as percent"
              className="w-20 bg-[var(--color-surface-raised)] border border-[var(--color-border)] rounded px-2 py-2 text-base text-[var(--color-text-primary)] outline-none focus:ring-2 focus:ring-[var(--color-accent-default)]"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-[var(--color-text-secondary)]">Y (0-100%)</span>
            <input
              type="number"
              min={0}
              max={100}
              step={1}
              value={inputY}
              onChange={(e) => setInputY(e.target.value)}
              aria-label="Vertex Y coordinate as percent"
              className="w-20 bg-[var(--color-surface-raised)] border border-[var(--color-border)] rounded px-2 py-2 text-base text-[var(--color-text-primary)] outline-none focus:ring-2 focus:ring-[var(--color-accent-default)]"
            />
          </label>
          <button
            type="button"
            onClick={handleKeyboardAdd}
            className="bg-[var(--color-accent-default)] hover:bg-[var(--color-accent-bright)] text-white rounded px-3 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2"
          >
            Add point
          </button>
        </fieldset>
      </details>

      {/* iter-274: aria-live polite region for SR announcements. */}
      <div role="status" aria-live="polite" className="sr-only">
        {announce}
      </div>

      {/* Zone list — minimal now that delete moved into the editor.
          Each row is selectable for editing. */}
      {zones.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm">
          {zones.map((poly, i) => {
            const isSel = selectedZone === i
            return (
              <li
                key={i}
                className={`flex items-center justify-between rounded px-3 py-2 ${
                  isSel
                    ? 'bg-[var(--color-accent-default)]/10 border border-[var(--color-accent-default)]/40'
                    : 'bg-[var(--color-surface-raised)] border border-[var(--color-border)]'
                }`}
              >
                <button
                  type="button"
                  onClick={() => {
                    if (drawing) return
                    if (isSel) {
                      setSelectedZone(null)
                    } else {
                      setSelectedZone(i)
                      // iter-310: flash the polygon when the user
                      // selects via the list row too — same
                      // affordance as the in-frame tap path.
                      setFlashSelect({ index: i, at: Date.now() })
                    }
                  }}
                  disabled={drawing}
                  className="flex-1 text-left text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
                  aria-pressed={isSel}
                >
                  Zone {i + 1} · {poly.length} pts {isSel ? '· editing' : ''}
                </button>
                <button
                  type="button"
                  onClick={() => deleteZone(i)}
                  aria-label={`Delete zone ${i + 1}`}
                  className="inline-flex items-center justify-center w-11 h-11 -my-2 rounded text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10 focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2"
                >
                  ✕
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
