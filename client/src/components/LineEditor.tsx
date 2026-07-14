import { useRef, type MouseEvent as ReactMouseEvent } from 'react'
import type { ZonePoint } from '../lib/types'
import { Button } from './primitives/Button'

type LineEditorProps = {
  points: ZonePoint[]
  onChange: (points: ZonePoint[]) => void
  snapshotUrl?: string
}

function pct(value: number): number {
  return Math.round(value * 100)
}

/** Two-point, normalized crossing-line editor with mouse/touch and keyboard inputs. */
export function LineEditor({
  points,
  onChange,
  snapshotUrl = '/snapshots/latest.jpg',
}: LineEditorProps) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const line = points.slice(0, 2)

  const addPoint = (event: ReactMouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0 || rect.height === 0) return
    const point: ZonePoint = [
      Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    ]
    onChange(line.length >= 2 ? [point] : [...line, point])
  }

  const updateCoordinate = (
    index: number,
    axis: 0 | 1,
    raw: string,
  ) => {
    const value = Number(raw)
    if (!Number.isFinite(value)) return
    const next = line.map((point) => [...point] as ZonePoint)
    while (next.length <= index) {
      next.push([next.length === 0 ? 0.25 : 0.75, 0.5])
    }
    next[index][axis] = Math.max(0, Math.min(1, value / 100))
    onChange(next)
  }

  return (
    <div className="space-y-3 p-3">
      <p className="text-xs text-[var(--color-text-secondary)]">
        Tap two points across the path people cross, or enter both points as percentages below. A third tap starts a new line.
      </p>
      <svg
        ref={svgRef}
        role="img"
        aria-label={
          line.length === 2
            ? 'Crossing line with two points'
            : `Crossing line with ${line.length} of two points`
        }
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
        onClick={addPoint}
        className="aspect-video w-full touch-manipulation cursor-crosshair overflow-hidden rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface-raised)]"
      >
        <image href={snapshotUrl} width="1" height="1" preserveAspectRatio="xMidYMid slice" />
        {line.length === 2 ? (
          <line
            x1={line[0][0]}
            y1={line[0][1]}
            x2={line[1][0]}
            y2={line[1][1]}
            stroke="var(--color-accent-default)"
            strokeWidth="4"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
        {line.map(([x, y], index) => (
          <circle
            key={`${index}-${x}-${y}`}
            cx={x}
            cy={y}
            r="0.025"
            fill="var(--color-ink)"
            stroke="var(--color-on-ink)"
            strokeWidth="0.006"
          />
        ))}
      </svg>
      <div className="grid gap-2 sm:grid-cols-2" aria-label="Crossing line coordinates">
          {[0, 1].map((index) => {
            const point = line[index]
            return (
            <fieldset
              key={`line-point-${index + 1}`}
              className="grid grid-cols-2 gap-2 rounded-xl border border-[var(--color-border)] p-2"
            >
              <legend className="px-1 text-xs font-semibold text-[var(--color-text-secondary)]">
                Point {index + 1}
              </legend>
              <label className="text-xs text-[var(--color-text-secondary)]">
                X percent
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={point ? pct(point[0]) : ''}
                  placeholder={index === 0 ? '25' : '75'}
                  onChange={(event) => updateCoordinate(index, 0, event.target.value)}
                  className="mt-1 min-h-11 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-2 text-base text-[var(--color-text-primary)]"
                />
              </label>
              <label className="text-xs text-[var(--color-text-secondary)]">
                Y percent
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={point ? pct(point[1]) : ''}
                  placeholder="50"
                  onChange={(event) => updateCoordinate(index, 1, event.target.value)}
                  className="mt-1 min-h-11 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-2 text-base text-[var(--color-text-primary)]"
                />
              </label>
            </fieldset>
            )
          })}
      </div>
      <Button variant="ghost" size="sm" onClick={() => onChange([])} disabled={line.length === 0}>
        Clear line
      </Button>
    </div>
  )
}
