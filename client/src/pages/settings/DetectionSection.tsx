import { useEffect, useState } from 'react'
import { Slider } from '../../components/Slider'
import { ErrorState } from '../../components/states/ErrorState'
import { ZoneEditor } from '../../components/ZoneEditor'
import { getDetectionConfig, patchDetectionConfig } from '../../lib/api'
import { log, errFields } from '../../lib/log'
import { useReportError, useToast } from '../../lib/toast'
import {
  COMMON_DETECTION_CLASSES,
  DETECTION_LIMITS,
  type DetectionConfig,
  RETENTION_PRESETS,
} from '../../lib/types'
import {
  RetentionPresetPicker,
  Row,
  Section,
  TimeInput,
  Toggle,
} from './parts'

// iter-291: extracted from Settings.tsx (~240 lines of inline JSX
// + config state + commitConfig handler + getDetectionConfig effect).
// Pre-iter-291 the Detection block was the largest remaining
// chunk in Settings — 5 sub-sections (Detection / Clip recording /
// What to detect / Detection zones / Schedule) all mutating one
// shared `config: DetectionConfig` via a single PATCH route.
// Pulling it out drops Settings.tsx to ~785 lines (cumulative
// since iter-267: 1969 → ~780 lines, -60%).
//
// Self-contained: owns config state, commits via patchDetectionConfig,
// fetches once on mount. Parent gates rendering via showCameraPanel +
// isOwner — this component assumes both already hold (server gates
// PATCH at require_role('owner') anyway).

function formatClipDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(0)} s`
  const m = Math.floor(seconds / 60)
  const s = seconds - m * 60
  if (s === 0) return `${m} min`
  return `${m} min ${s.toFixed(0)} s`
}

export function DetectionSection() {
  const { showToast } = useToast()
  const reportError = useReportError()
  const [config, setConfig] = useState<DetectionConfig | null>(null)
  // iter-356.x (Frank E2 + feature audit): pre-fix a transient
  // getDetectionConfig() failure put every field into a permanent
  // disabled state with no error message + no retry — looked like a
  // permission problem, was actually a network blip.
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    getDetectionConfig()
      .then((c) => {
        if (cancelled) return
        setConfig(c)
        setLoadError(null)
      })
      .catch((e) => {
        // Log BEFORE the cancelled guard so an unmount mid-failure is
        // still recorded. The component renders an ErrorState below; the
        // log carries the status / network reason for the operator.
        log.warn('detectionSettings:load-failed', errFields(e))
        if (cancelled) return
        setLoadError(e instanceof Error ? e.message : 'Could not load settings')
      })
    return () => {
      cancelled = true
    }
  }, [reloadKey])

  const commitConfig = (patch: Partial<DetectionConfig>) => {
    patchDetectionConfig(patch)
      .then((next) => {
        setConfig(next)
        showToast('Detection settings saved', 'success')
      })
      .catch((e) => {
        // docs/logging_plan.md §2 + §4 guardrail: log the patch KEYS
        // (NOT values — zone geometry / labels are PII-adjacent) plus
        // the status so the operator sees WHICH setting failed to save
        // and WHY. Replaces the bare console.error.
        reportError('detectionSettings:save-failed', 'Could not save settings', {
          keys: Object.keys(patch),
          ...errFields(e),
        })
      })
  }

  if (loadError) {
    return (
      <ErrorState
        title="Could not load detection settings"
        message="Check your connection and try again."
        retry={() => {
          setLoadError(null)
          setReloadKey((k) => k + 1)
        }}
        technicalDetail={loadError}
      />
    )
  }

  return (
    <>
      {/* iter-305 (user "How do I know which cam is which? Right
          now, I only have 1 camera, but it is not labeled at all"):
          friendly camera name. Used as the Live page header.
          Commit on blur (not per-keystroke) so a half-typed
          "Driv" doesn't churn the disk + WS broadcast. */}
      <Section title="Camera name">
        <div className="px-4 py-3 space-y-2">
          <label className="block">
            <span className="text-sm text-[var(--color-text-primary)]">Display name</span>
            <input
              type="text"
              value={config?.camera_label ?? ''}
              onChange={(e) =>
                setConfig((c) =>
                  c ? { ...c, camera_label: e.target.value } : c,
                )
              }
              onBlur={(e) => {
                const v = e.target.value.trim()
                if (v) commitConfig({ camera_label: v })
              }}
              maxLength={32}
              placeholder="Front Door"
              aria-label="Camera display name"
              className="w-full mt-1 bg-[var(--color-surface-raised)] border border-[var(--color-border)] rounded-lg px-3 py-2 text-base text-[var(--color-text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2"
              disabled={config === null}
            />
          </label>
          <p className="text-xs text-[var(--color-text-secondary)]">
            Shown at the top of the Live page. Up to 32 characters.
          </p>
        </div>
      </Section>

      {/* iter-308 (user "make the infrastructure" for two-way
          audio): Talk + Listen affordances stay disabled until
          this flag is on. Operator wires hardware (Plugable USB
          dongle + AC-powered speaker per the iter-307 research),
          flips this on, then the Live page lights up the buttons.
          Real WebRTC plumbing lands when the operator has
          hardware to test against — see
          memory/two_way_audio_plan_iter308.md.
          iter-321 (ux-grandpa Frank Gripe #2): "Two-way audio"
          renamed → "Talk through the camera" (developer jargon
          → user-visible outcome). Description leads with what
          it DOES, not what it requires. */}
      <Section title="Talk through the camera">
        <Row
          label="Let me speak to whoever's outside"
          right={
            <Toggle
              checked={config?.audio_enabled ?? false}
              onChange={(v) => commitConfig({ audio_enabled: v })}
              disabled={config === null}
              ariaLabel="Enable two-way audio"
            />
          }
        />
        <p className="px-4 -mt-2 pb-3 text-xs text-[var(--color-text-secondary)]">
          When on, the Talk button on the Live page lets you speak
          out of a speaker on the camera. Needs a microphone and
          speaker plugged into the camera box. Off by default.
        </p>
      </Section>

      {/* Playroom Modern (Task 8 copy pass): this panel's own section
          head was literally "Detection" — same word as the tab label
          and JetsonSection's worker-health group, which read as three
          different things all called the same name. "Watching"
          names what the camera is actually doing when it's armed. */}
      <Section title="Watching">
        {/* iter-259: plain-English labels per ux-grandpa.
            "Confidence threshold" → "Sensitivity" (Frank: "I'm 72;
            my confidence is fine"). "Cooldown" → "Quiet time
            after a detection." */}
        <Slider
          label="Sensitivity"
          value={config?.threshold ?? 0.55}
          min={DETECTION_LIMITS.thresholdMin}
          max={DETECTION_LIMITS.thresholdMax}
          step={0.05}
          format={(v) => v.toFixed(2)}
          onChange={(v) =>
            setConfig((c) => (c ? { ...c, threshold: v } : c))
          }
          onCommit={(v) => commitConfig({ threshold: v })}
          disabled={config === null}
          ariaLabel="Detection sensitivity"
        />
        <p className="px-4 -mt-2 pb-2 text-xs text-[var(--color-text-secondary)]">
          Lower means more events (and more false alarms). Higher
          means only confident detections.
        </p>
        <Slider
          label="Quiet time after a detection"
          value={config?.cooldown_s ?? 5}
          min={DETECTION_LIMITS.cooldownMin}
          max={DETECTION_LIMITS.cooldownMax}
          step={1}
          format={(v) => `${v.toFixed(0)} s`}
          onChange={(v) =>
            setConfig((c) => (c ? { ...c, cooldown_s: v } : c))
          }
          onCommit={(v) => commitConfig({ cooldown_s: v })}
          disabled={config === null}
          ariaLabel="Quiet time after a detection in seconds"
        />
      </Section>

      {/* iter-254 / iter-257: per-event clip duration + retention
          preset. The preset picks both the retention window AND the
          per-clip max length (longer clips = shorter retention so
          the disk math stays bounded). Post-roll is live-tunable on
          the worker; pre-roll is persisted but won't take effect
          until the iter-255 rolling-segment recorder ships. */}
      <Section title="Clip recording">
        <RetentionPresetPicker
          value={config?.clip_retention_preset ?? 'month'}
          onChange={(preset) => {
            // Switching tiers may clamp the active durations down
            // — reflect locally so the slider snaps before the
            // server PATCH round-trip lands.
            const tier = RETENTION_PRESETS[preset]
            setConfig((c) =>
              c
                ? {
                    ...c,
                    clip_retention_preset: preset,
                    clip_post_roll_s: Math.min(
                      c.clip_post_roll_s,
                      tier.clipPostRollMaxS,
                    ),
                    clip_pre_roll_s: Math.min(
                      c.clip_pre_roll_s,
                      tier.clipPreRollMaxS,
                    ),
                  }
                : c,
            )
            commitConfig({ clip_retention_preset: preset })
          }}
          disabled={config === null}
        />
        <Slider
          label="Post-roll"
          value={config?.clip_post_roll_s ?? 8}
          min={DETECTION_LIMITS.clipPostRollMin}
          max={
            RETENTION_PRESETS[config?.clip_retention_preset ?? 'month']
              .clipPostRollMaxS
          }
          step={1}
          format={formatClipDuration}
          onChange={(v) =>
            setConfig((c) => (c ? { ...c, clip_post_roll_s: v } : c))
          }
          onCommit={(v) => commitConfig({ clip_post_roll_s: v })}
          disabled={config === null}
          ariaLabel="Seconds the camera keeps recording after detection"
        />
        {RETENTION_PRESETS[config?.clip_retention_preset ?? 'month']
          .clipPreRollMaxS > 0 ? (
          <Slider
            label="Pre-roll"
            value={config?.clip_pre_roll_s ?? 0}
            min={DETECTION_LIMITS.clipPreRollMin}
            max={
              RETENTION_PRESETS[config?.clip_retention_preset ?? 'month']
                .clipPreRollMaxS
            }
            step={1}
            format={formatClipDuration}
            onChange={(v) =>
              setConfig((c) => (c ? { ...c, clip_pre_roll_s: v } : c))
            }
            onCommit={(v) => commitConfig({ clip_pre_roll_s: v })}
            disabled={config === null}
            ariaLabel="Seconds before detection to include in the clip"
          />
        ) : (
          <Row
            label="Pre-roll"
            right={
              <span className="text-xs text-[var(--color-text-secondary)]">
                Disabled at this retention
              </span>
            }
          />
        )}
        <p className="px-4 pb-3 text-xs text-[var(--color-text-secondary)]">
          Pre-roll is saved with your settings. The recorder will
          start using it once an upcoming update lands the rolling
          buffer; until then, clips begin at the moment of detection.
        </p>
      </Section>

      {/* feat/continuous-capture (plan S6): one clip per VISIT instead of
          one per detection. When a person is seen the camera records
          continuously until they leave, waits out the grace period, and
          finalizes a single clip — killing the overlapping-clips
          "teleport" in the daily reel. Off by default; the worker reads
          these off its config-poll, so no restart is needed. */}
      <Section title="Continuous recording">
        <Row
          label="Record one clip per visit"
          right={
            <Toggle
              checked={config?.continuous_capture ?? false}
              onChange={(v) => commitConfig({ continuous_capture: v })}
              disabled={config === null}
              ariaLabel="Enable continuous per-visit recording"
            />
          }
        />
        <p className="px-4 -mt-2 pb-2 text-xs text-[var(--color-text-secondary)]">
          When on, the camera follows a person through their whole visit
          and saves a single continuous clip instead of several
          overlapping ones. Better daily recap videos; uses more disk per
          visit.
        </p>
        {config?.continuous_capture ? (
          <>
            <Slider
              label="Grace period after they leave"
              value={config?.absence_finalize_s ?? 10}
              min={DETECTION_LIMITS.absenceFinalizeMin}
              max={DETECTION_LIMITS.absenceFinalizeMax}
              step={1}
              format={(v) => `${v.toFixed(0)} s`}
              onChange={(v) =>
                setConfig((c) => (c ? { ...c, absence_finalize_s: v } : c))
              }
              onCommit={(v) => commitConfig({ absence_finalize_s: v })}
              disabled={config === null}
              ariaLabel="Seconds to wait after the subject leaves before finalizing the visit clip"
            />
            <p className="px-4 -mt-2 pb-2 text-xs text-[var(--color-text-secondary)]">
              If they come back within this window, the same clip keeps
              going instead of starting a new one.
            </p>
            <Slider
              label="Longest single clip"
              value={config?.max_visit_s ?? 150}
              min={DETECTION_LIMITS.maxVisitMin}
              max={DETECTION_LIMITS.maxVisitMax}
              step={10}
              format={formatClipDuration}
              onChange={(v) =>
                setConfig((c) => (c ? { ...c, max_visit_s: v } : c))
              }
              onCommit={(v) => commitConfig({ max_visit_s: v })}
              disabled={config === null}
              ariaLabel="Maximum length of a single visit clip in seconds"
            />
            <p className="px-4 -mt-2 pb-3 text-xs text-[var(--color-text-secondary)]">
              A safety cap so a stuck detection cannot fill the disk with
              one endless clip. Long visits split into back-to-back clips
              at this length.
            </p>
          </>
        ) : null}
      </Section>

      <Section title="What to detect">
        <div className="px-4 py-3 space-y-2">
          <p className="text-xs text-[var(--color-text-secondary)]">
            Tap a class to toggle. Empty selection means no detections fire.
          </p>
          <div
            className="flex flex-wrap gap-2"
            role="group"
            aria-label="Detection classes"
          >
            {(() => {
              // Show all common classes, plus any extra classes the user
              // has configured outside the curated set (e.g. via the API
              // or a manual config edit). Without this branch, a "horse"
              // entry in config.classes would be invisible — the user
              // couldn't see or untoggle it.
              const cur = config?.classes ?? []
              const extras = cur.filter(
                (c) => !(COMMON_DETECTION_CLASSES as readonly string[]).includes(c),
              )
              return [...COMMON_DETECTION_CLASSES, ...extras]
            })().map((name) => {
              const selected = (config?.classes ?? []).includes(name)
              return (
                <button
                  key={name}
                  type="button"
                  onClick={() => {
                    const cur = config?.classes ?? []
                    const next = selected
                      ? cur.filter((c) => c !== name)
                      : [...cur, name]
                    commitConfig({ classes: next })
                  }}
                  aria-pressed={selected}
                  // Sunroom: selected chip = accent-subtle peach paper +
                  // ink text (light surface; accent-colored text was a
                  // dark-era treatment) with a pre-mixed accent border —
                  // the /opacity-on-var() modifiers were unreliable.
                  className={`px-3 py-1.5 min-h-[36px] rounded-full text-sm font-medium border transition-colors duration-150 capitalize focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 ${
                    selected
                      ? 'bg-[var(--color-accent-subtle)] border-[var(--color-accent-border)] text-[var(--color-text-primary)]'
                      : 'bg-[var(--color-surface)] border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-[var(--color-border-strong)]'
                  }`}
                >
                  {name}
                </button>
              )
            })}
          </div>
        </div>
      </Section>

      {/* iter-191c (Feature #5): polygon mask editor. Empty zones list
          = no spatial gating (default). When non-empty, the worker
          drops events whose detection-box centers all fall outside
          the configured polygons. Live-commits via the existing
          `commitConfig` patch flow. */}
      <Section title="Detection zones">
        <p className="px-1 text-xs text-[var(--color-text-secondary)]">
          Draw polygons over the live frame to limit where detections
          fire. No zones = whole frame is active (default).
        </p>
        <ZoneEditor
          zones={config?.zones ?? []}
          onChange={(zones) => commitConfig({ zones })}
        />
      </Section>

      <Section title="Schedule">
        <Row
          label="Auto-pause overnight"
          right={
            <Toggle
              checked={
                !!config?.schedule_off_start && !!config?.schedule_off_end
              }
              onChange={(v) =>
                commitConfig(
                  v
                    ? {
                        schedule_off_start:
                          config?.schedule_off_start ?? '23:00',
                        schedule_off_end: config?.schedule_off_end ?? '06:00',
                      }
                    : { schedule_off_start: null, schedule_off_end: null },
                )
              }
              disabled={config === null}
              ariaLabel="Auto-pause detection overnight"
            />
          }
        />
        {config?.schedule_off_start && config?.schedule_off_end && (
          <>
            <Row
              label="From"
              right={
                <TimeInput
                  value={config.schedule_off_start}
                  onChange={(v) =>
                    commitConfig({ schedule_off_start: v })
                  }
                  ariaLabel="Schedule pause start time"
                />
              }
            />
            <Row
              label="To"
              right={
                <TimeInput
                  value={config.schedule_off_end}
                  onChange={(v) =>
                    commitConfig({ schedule_off_end: v })
                  }
                  ariaLabel="Schedule pause end time"
                />
              }
            />
          </>
        )}
      </Section>
    </>
  )
}
