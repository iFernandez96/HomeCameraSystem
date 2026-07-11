import { LineEditor } from '../../components/LineEditor'
import { Button } from '../../components/primitives/Button'
import { ZoneEditor } from '../../components/ZoneEditor'
import type { Camera } from '../../lib/api'
import { pathOverlapsPrivacyMasks } from '../../lib/geometry'
import type { SmartRule, Zone } from '../../lib/types'

type RuleEditorProps = {
  rule: SmartRule
  cameras: Camera[]
  busy: boolean
  privacyMasks: Zone[]
  onChange: (rule: SmartRule) => void
  onSave: () => void
  onCancel: () => void
}

export function RuleEditor({
  rule,
  cameras,
  busy,
  privacyMasks,
  onChange,
  onSave,
  onCancel,
}: RuleEditorProps) {
  const packageMode = rule.kind === 'package'
  const polygon = rule.points.length >= 3 ? [rule.points] : []
  const overlapsPrivacy = pathOverlapsPrivacyMasks(
    rule.points,
    rule.kind !== 'line_crossing',
    privacyMasks,
  )
  return (
    <form
      aria-label="Security rule editor"
      className="space-y-4 rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
      onSubmit={(event) => {
        event.preventDefault()
        onSave()
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm font-medium text-[var(--color-text-secondary)]">
          Rule name
          <input
            value={rule.name}
            maxLength={64}
            required
            onChange={(event) => onChange({ ...rule, name: event.target.value })}
            className="mt-1 min-h-11 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 text-base text-[var(--color-text-primary)]"
          />
        </label>
        <label className="text-sm font-medium text-[var(--color-text-secondary)]">
          Rule type
          <select
            value={rule.kind}
            onChange={(event) => {
              const kind = event.target.value as SmartRule['kind']
              onChange({
                ...rule,
                kind,
                points: [],
                labels: kind === 'package' && rule.labels.length === 0
                  ? ['person']
                  : rule.labels,
              })
            }}
            className="mt-1 min-h-11 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 text-base text-[var(--color-text-primary)]"
          >
            <option value="line_crossing">Line crossing</option>
            <option value="loitering">Loitering</option>
            <option value="package">Package area (experimental)</option>
          </select>
        </label>
        <label className="text-sm font-medium text-[var(--color-text-secondary)]">
          Camera
          <select
            value={rule.camera_id}
            onChange={(event) => onChange({ ...rule, camera_id: event.target.value })}
            className="mt-1 min-h-11 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 text-base text-[var(--color-text-primary)]"
          >
            {cameras.length === 0 ? <option value={rule.camera_id}>{rule.camera_id}</option> : null}
            {cameras.map((camera) => (
              <option key={camera.id} value={camera.id}>{camera.name}</option>
            ))}
          </select>
        </label>
        <label className="text-sm font-medium text-[var(--color-text-secondary)]">
          {packageMode ? 'Objects that pause package detection' : 'Object labels'}
          <input
            value={rule.labels.join(', ')}
            aria-label={packageMode ? 'Objects that pause package detection' : 'Object labels'}
            aria-describedby={packageMode ? 'package-blocker-help' : undefined}
            onChange={(event) =>
              onChange({
                ...rule,
                labels: event.target.value
                  .split(',')
                  .map((value) => value.trim().toLowerCase())
                  .filter(Boolean),
              })
            }
            placeholder={packageMode ? 'person' : 'person, car'}
            className="mt-1 min-h-11 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 text-base text-[var(--color-text-primary)]"
          />
          {packageMode ? (
            <span id="package-blocker-help" className="mt-1 block text-xs font-normal text-[var(--color-text-secondary)]">
              People or other detected objects in this area pause scene-change sampling. This field does not identify a parcel.
            </span>
          ) : null}
        </label>
      </div>

      {rule.kind === 'line_crossing' ? (
        <>
          <LineEditor
            points={rule.points}
            onChange={(points) => onChange({ ...rule, points })}
          />
          <label className="block text-sm font-medium text-[var(--color-text-secondary)]">
            Direction
            <select
              value={rule.direction}
              onChange={(event) =>
                onChange({ ...rule, direction: event.target.value as SmartRule['direction'] })
              }
              className="mt-1 min-h-11 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 text-base text-[var(--color-text-primary)]"
            >
              <option value="any">Either way</option>
              <option value="forward">Forward only</option>
              <option value="reverse">Reverse only</option>
            </select>
          </label>
        </>
      ) : (
        <div>
          <p className="mb-2 text-sm font-medium text-[var(--color-text-secondary)]">
            {rule.kind === 'loitering' ? 'Area to watch for lingering' : 'Package area (experimental)'}
          </p>
          {packageMode ? (
            <p className="mb-2 text-xs text-[var(--color-text-secondary)]">
              Watches for a stable porch object appearing or disappearing. It does not recognize whether the object is a parcel.
            </p>
          ) : null}
          <ZoneEditor
            zones={polygon}
            onChange={(zones) => onChange({ ...rule, points: zones[0] ?? [] })}
          />
        </div>
      )}

      {overlapsPrivacy ? (
        <p role="alert" className="rounded-xl border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] p-3 text-sm text-[var(--color-text-primary)]">
          This rule touches a privacy mask. Move its points outside masked areas before saving.
        </p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm font-medium text-[var(--color-text-secondary)]">
          {rule.kind === 'loitering' ? 'Dwell seconds' : 'Minimum seconds'}
          <input
            type="number"
            min="0"
            max="3600"
            value={rule.dwell_s}
            onChange={(event) => onChange({ ...rule, dwell_s: Number(event.target.value) })}
            className="mt-1 min-h-11 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 text-base text-[var(--color-text-primary)]"
          />
        </label>
        <label className="text-sm font-medium text-[var(--color-text-secondary)]">
          Confidence threshold
          <input
            type="number"
            min="0.05"
            max="0.99"
            step="0.05"
            value={rule.threshold}
            onChange={(event) => onChange({ ...rule, threshold: Number(event.target.value) })}
            className="mt-1 min-h-11 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 text-base text-[var(--color-text-primary)]"
          />
        </label>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button type="submit" loading={busy} loadingText="Saving…" disabled={overlapsPrivacy}>Save rule</Button>
      </div>
    </form>
  )
}
