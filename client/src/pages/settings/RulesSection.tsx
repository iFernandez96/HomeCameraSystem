import { useEffect, useState } from 'react'
import { Button } from '../../components/primitives/Button'
import { CatEmptyState } from '../../components/CatEmptyState'
import { ErrorState } from '../../components/states/ErrorState'
import {
  createAutomation,
  deleteAutomation,
  getCameras,
  getDeterrenceCapabilities,
  getDetectionConfig,
  listAutomations,
  patchAutomationEnabled,
  patchDetectionConfig,
  testAutomation,
  type Automation,
  type AutomationActionInput,
  type AutomationInput,
  type Camera,
  type DeterrenceCapability,
} from '../../lib/api'
import type { DetectionConfig, SmartRule } from '../../lib/types'
import { useConfirm } from '../../lib/confirm'
import { useToast } from '../../lib/toast'
import { RuleEditor } from './RuleEditor'
import { Row, Section, Toggle } from './parts'

function newRule(cameraId: string): SmartRule {
  const id = `rule_${Date.now().toString(36)}`.slice(0, 32)
  return {
    id,
    name: 'New security rule',
    kind: 'line_crossing',
    enabled: true,
    camera_id: cameraId,
    points: [],
    labels: ['person'],
    direction: 'any',
    dwell_s: 30,
    threshold: 0.55,
  }
}

const AUDIO_EVENT_OPTIONS = [
  { id: 'audio_smoke_alarm', label: 'Smoke-alarm pattern' },
  { id: 'audio_glass_break', label: 'Glass-break pattern' },
] as const

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

function usesPhysicalAction(automation: Automation): boolean {
  return automation.actions.some((action) =>
    action.kind === 'light' || action.kind === 'warning' || action.kind === 'siren',
  )
}

export function RulesSection() {
  const [rules, setRules] = useState<SmartRule[] | null>(null)
  const [automations, setAutomations] = useState<Automation[] | null>(null)
  const [config, setConfig] = useState<DetectionConfig | null>(null)
  const [cameras, setCameras] = useState<Camera[]>([])
  const [editing, setEditing] = useState<SmartRule | null>(null)
  const [busy, setBusy] = useState(false)
  const [automationDraft, setAutomationDraft] = useState({
    name: '',
    labels: 'person',
    kind: 'push' as 'push' | 'webhook' | 'mqtt',
    target: '',
    mode: 'any' as 'any' | 'home' | 'away' | 'night' | 'privacy',
    person: 'any' as 'any' | 'known' | 'unknown',
    minScore: '0.55',
  })
  const [deterrenceCapability, setDeterrenceCapability] = useState<DeterrenceCapability | null>(null)
  const [deterrenceCapabilityState, setDeterrenceCapabilityState] = useState<
    'loading' | 'ready' | 'error'
  >('loading')
  const [deterrencePrivacyBlocked, setDeterrencePrivacyBlocked] = useState(false)
  const [packageThresholdDraft, setPackageThresholdDraft] = useState('0.35')
  const [packageStableDraft, setPackageStableDraft] = useState('10')
  const [deterrenceDurationDraft, setDeterrenceDurationDraft] = useState('10')
  const [error, setError] = useState<unknown>(null)
  const { showToast } = useToast()
  const confirm = useConfirm()

  useEffect(() => {
    let cancelled = false
    Promise.all([listAutomations(), getDetectionConfig(), getCameras()])
      .then(([automationResult, detectionConfig, cameraResult]) => {
        if (cancelled) return
        setRules(detectionConfig.smart_rules)
        setAutomations(automationResult.items)
        setConfig(detectionConfig)
        setPackageThresholdDraft(String(detectionConfig.package_change_threshold))
        setPackageStableDraft(String(detectionConfig.package_stable_s))
        setDeterrenceDurationDraft(String(detectionConfig.deterrence_duration_s))
        setCameras(cameraResult.cameras)
        setError(null)
      })
      .catch((reason) => {
        if (!cancelled) setError(reason)
      })
    getDeterrenceCapabilities()
      .then((capability) => {
        if (cancelled) return
        setDeterrenceCapability(capability)
        setDeterrencePrivacyBlocked(capability.privacy_blocked)
        setDeterrenceCapabilityState('ready')
      })
      .catch(() => {
        if (!cancelled) setDeterrenceCapabilityState('error')
      })
    return () => {
      cancelled = true
    }
  }, [])

  const syncDrafts = (value: DetectionConfig) => {
    setPackageThresholdDraft(String(value.package_change_threshold))
    setPackageStableDraft(String(value.package_stable_s))
    setDeterrenceDurationDraft(String(value.deterrence_duration_s))
  }

  const saveConfig = async (patch: Partial<DetectionConfig>) => {
    if (!config) return
    const previous = config
    setConfig({ ...config, ...patch })
    try {
      const saved = await patchDetectionConfig(patch)
      setConfig(saved)
      syncDrafts(saved)
      showToast('Security settings saved', 'success')
    } catch {
      setConfig(previous)
      syncDrafts(previous)
      showToast('Could not save security settings', 'error')
    }
  }

  const saveRule = async () => {
    if (!editing || busy) return
    if (editing.kind === 'line_crossing' && editing.points.length !== 2) {
      showToast('Add exactly two points for the crossing line', 'error')
      return
    }
    if (editing.kind !== 'line_crossing' && editing.points.length < 3) {
      showToast('Draw an area with at least three points', 'error')
      return
    }
    setBusy(true)
    try {
      const without = (rules ?? []).filter((rule) => rule.id !== editing.id)
      const nextConfig = await patchDetectionConfig({ smart_rules: [...without, editing] })
      setConfig(nextConfig)
      setRules(nextConfig.smart_rules)
      setEditing(null)
      showToast('Security rule saved', 'success')
    } catch {
      showToast('Could not save security rule', 'error')
    } finally {
      setBusy(false)
    }
  }

  const toggleRule = async (rule: SmartRule) => {
    const next = { ...rule, enabled: !rule.enabled }
    const nextRules = (rules ?? []).map((item) => item.id === rule.id ? next : item)
    setRules(nextRules)
    try {
      const nextConfig = await patchDetectionConfig({ smart_rules: nextRules })
      setConfig(nextConfig)
      setRules(nextConfig.smart_rules)
    } catch {
      setRules(rules)
      showToast('Could not change the rule', 'error')
    }
  }

  const removeRule = async (rule: SmartRule) => {
    const ok = await confirm({
      title: 'Delete this rule?',
      body: `${rule.name} will stop watching for this activity.`,
      confirmLabel: 'Delete rule',
      destructive: true,
    })
    if (!ok) return
    try {
      const nextRules = (rules ?? []).filter((item) => item.id !== rule.id)
      const nextConfig = await patchDetectionConfig({ smart_rules: nextRules })
      setConfig(nextConfig)
      setRules(nextConfig.smart_rules)
      showToast('Rule deleted', 'success')
    } catch {
      showToast('Could not delete the rule', 'error')
    }
  }

  const toggleAutomation = async (automation: Automation) => {
    const physical = usesPhysicalAction(automation)
    const hasNamedRule = automation.triggers.rule_ids.some((ruleId) =>
      (rules ?? []).some((rule) => rule.id === ruleId && rule.name.trim()),
    )
    const capabilityAvailable = deterrenceCapability?.available === true
    if (!automation.enabled && physical && (!hasNamedRule || !capabilityAvailable)) {
      showToast(
        !hasNamedRule
          ? 'Choose a named smart rule before enabling a physical action'
          : 'The deterrence adapter has not reported available',
        'error',
      )
      return
    }
    const optimistic = { ...automation, enabled: !automation.enabled }
    setAutomations((current) => current?.map((item) => item.id === automation.id ? optimistic : item) ?? current)
    try {
      const saved = await patchAutomationEnabled(automation.id, !automation.enabled)
      setAutomations((current) => current?.map((item) => item.id === saved.id ? saved : item) ?? current)
    } catch {
      setAutomations((current) => current?.map((item) => item.id === automation.id ? automation : item) ?? current)
      showToast('Could not change automation', 'error')
    }
  }

  const runAutomationTest = async (automation: Automation) => {
    try {
      const result = await testAutomation(automation.id)
      const capability = result.results.find((item) => item.capability)?.capability ?? null
      if (usesPhysicalAction(automation)) {
        setDeterrenceCapability(capability)
        setDeterrenceCapabilityState('ready')
        if (!capability?.available) {
          showToast(
            `Dry run only; no hardware action ran. ${capability?.limitation ?? 'No deterrence capability was reported.'}`,
            'error',
          )
          return
        }
        showToast(
          result.matched
            ? 'Dry run matched and the adapter reported available; no hardware action ran'
            : 'Dry run did not match; no hardware action ran',
          'info',
        )
        return
      }
      showToast(
        result.matched
          ? 'Dry run matched; no notification or message was sent'
          : 'Dry run did not match its conditions',
        'info',
      )
    } catch {
      showToast('Automation dry run failed', 'error')
    }
  }

  const removeAutomation = async (automation: Automation) => {
    const ok = await confirm({
      title: 'Delete this automation?',
      body: `${automation.name} will stop sending or triggering actions.`,
      confirmLabel: 'Delete automation',
      destructive: true,
    })
    if (!ok) return
    try {
      await deleteAutomation(automation.id)
      setAutomations((current) => current?.filter((item) => item.id !== automation.id) ?? current)
    } catch {
      showToast('Could not delete automation', 'error')
    }
  }

  const addAutomation = async () => {
    const name = automationDraft.name.trim()
    if (!name || busy) return
    const labels = automationDraft.labels.split(',').map((label) => label.trim().toLowerCase()).filter(Boolean)
    let action: AutomationActionInput
    if (automationDraft.kind === 'webhook') {
      action = { kind: 'webhook', url: automationDraft.target.trim() }
    } else if (automationDraft.kind === 'mqtt') {
      action = { kind: 'mqtt', topic: automationDraft.target.trim() }
    } else {
      action = { kind: 'push' }
    }
    const body: AutomationInput = {
      name,
      enabled: true,
      triggers: { labels, sources: [], camera_ids: [], rule_ids: [] },
      conditions: {
        operating_modes: automationDraft.mode === 'any' ? [] : [automationDraft.mode],
        person: automationDraft.person,
        min_score: clamp(Number(automationDraft.minScore) || 0, 0, 1),
      },
      actions: [action],
    }
    setBusy(true)
    try {
      const saved = await createAutomation(body)
      setAutomations((current) => [...(current ?? []), saved])
      setAutomationDraft({ name: '', labels: 'person', kind: 'push', target: '', mode: 'any', person: 'any', minScore: '0.55' })
      showToast('Automation saved', 'success')
    } catch {
      showToast('Could not save automation', 'error')
    } finally {
      setBusy(false)
    }
  }

  if (error) {
    return (
      <ErrorState
        title="Could not load security rules"
        message="Check the camera connection and reopen this section."
        technicalDetail={error instanceof Error ? error.message : String(error)}
      />
    )
  }

  return (
    <div className="space-y-6">
      <Section title="Activity rules" subtitle="Watch a line or area and alert only when the rule is met.">
        <div className="space-y-3 p-3">
          {rules?.length === 0 ? (
            <CatEmptyState
              mood="watching"
              heading="No custom rules yet"
              body="Add a crossing line, loitering area, or package area when you need one."
            />
          ) : null}
          {(rules ?? []).map((rule) => (
            <article
              key={rule.id}
              className="rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="font-semibold text-[var(--color-text-primary)]">{rule.name}</h3>
                  <p className="text-xs text-[var(--color-text-secondary)]">
                    {rule.kind.replace('_', ' ')} · {rule.camera_id}
                  </p>
                </div>
                <Toggle
                  checked={rule.enabled}
                  onChange={() => void toggleRule(rule)}
                  ariaLabel={`${rule.enabled ? 'Disable' : 'Enable'} ${rule.name}`}
                />
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="secondary" size="sm" onClick={() => setEditing(rule)}>Edit</Button>
                <Button variant="destructive" size="sm" onClick={() => void removeRule(rule)}>Delete</Button>
              </div>
            </article>
          ))}
          <Button
            variant="secondary"
            onClick={() => setEditing(newRule(cameras[0]?.id ?? 'front_door'))}
          >
            Add rule
          </Button>
        </div>
      </Section>

      {editing ? (
        <RuleEditor
          rule={editing}
          cameras={cameras}
          busy={busy}
          privacyMasks={config?.privacy_masks ?? []}
          onChange={setEditing}
          onSave={() => void saveRule()}
          onCancel={() => setEditing(null)}
        />
      ) : null}

      <Section title="Automations" subtitle="Send a push, webhook, or MQTT message when a rule matches. Tests are dry runs and never execute actions.">
        <div className="space-y-3 p-3">
          {(automations ?? []).map((automation) => {
            const physical = usesPhysicalAction(automation)
            const hasNamedRule = automation.triggers.rule_ids.some((ruleId) =>
              (rules ?? []).some((rule) => rule.id === ruleId && rule.name.trim()),
            )
            const capability = deterrenceCapability
            const cannotEnablePhysical =
              physical && !automation.enabled && (!hasNamedRule || capability?.available !== true)
            return (
            <article key={automation.id} className="rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="font-semibold text-[var(--color-text-primary)]">{automation.name}</h3>
                  <p className="text-xs text-[var(--color-text-secondary)]">
                    {automation.actions.map((action) => action.kind).join(', ')} · {automation.triggers.labels.length ? automation.triggers.labels.join(', ') : 'any event'}
                  </p>
                </div>
                <Toggle checked={automation.enabled} disabled={cannotEnablePhysical} onChange={() => void toggleAutomation(automation)} ariaLabel={`${automation.enabled ? 'Disable' : 'Enable'} ${automation.name}`} />
              </div>
              {physical ? (
                <p className="mt-2 text-xs text-[var(--color-text-secondary)]" role="status">
                  {!hasNamedRule
                    ? 'Physical action cannot be enabled: it does not reference a named smart rule.'
                    : capability?.available
                      ? 'The mounted adapter is available. Dry runs never execute hardware.'
                      : deterrenceCapabilityState === 'loading'
                        ? 'Checking whether a mounted deterrence adapter is available.'
                        : deterrenceCapabilityState === 'error'
                          ? 'Physical action is unavailable because adapter capability could not be verified.'
                          : `Physical action is unavailable.${capability?.limitation ? ` ${capability.limitation}` : ''}`}
                </p>
              ) : null}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="secondary" size="sm" onClick={() => void runAutomationTest(automation)}>Dry run</Button>
                <Button variant="destructive" size="sm" onClick={() => void removeAutomation(automation)}>Delete</Button>
              </div>
            </article>
            )
          })}
          <form
            className="grid gap-3 rounded-[var(--radius-xl)] border border-dashed border-[var(--color-border)] p-3 sm:grid-cols-2"
            onSubmit={(event) => { event.preventDefault(); void addAutomation() }}
          >
            <label className="text-sm text-[var(--color-text-secondary)]">
              Name
              <input value={automationDraft.name} onChange={(event) => setAutomationDraft({ ...automationDraft, name: event.target.value })} placeholder="Porch person alert" className="mt-1 min-h-11 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-base text-[var(--color-text-primary)]" />
            </label>
            <label className="text-sm text-[var(--color-text-secondary)]">
              When labels match
              <input value={automationDraft.labels} onChange={(event) => setAutomationDraft({ ...automationDraft, labels: event.target.value })} placeholder="person, package" className="mt-1 min-h-11 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-base text-[var(--color-text-primary)]" />
            </label>
            <label className="text-sm text-[var(--color-text-secondary)]">
              Action
              <select value={automationDraft.kind} onChange={(event) => setAutomationDraft({ ...automationDraft, kind: event.target.value as typeof automationDraft.kind })} className="mt-1 min-h-11 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-base text-[var(--color-text-primary)]">
                <option value="push">Push alert</option>
                <option value="webhook">Webhook</option>
                <option value="mqtt">MQTT</option>
              </select>
            </label>
            <label className="text-sm text-[var(--color-text-secondary)]">
              If household mode is
              <select value={automationDraft.mode} onChange={(event) => setAutomationDraft({ ...automationDraft, mode: event.target.value as typeof automationDraft.mode })} className="mt-1 min-h-11 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-base text-[var(--color-text-primary)]">
                <option value="any">Any mode</option>
                <option value="home">Home</option>
                <option value="away">Away or Vacation</option>
                <option value="night">Sleep</option>
                <option value="privacy">Privacy</option>
              </select>
            </label>
            <label className="text-sm text-[var(--color-text-secondary)]">
              If person is
              <select value={automationDraft.person} onChange={(event) => setAutomationDraft({ ...automationDraft, person: event.target.value as typeof automationDraft.person })} className="mt-1 min-h-11 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-base text-[var(--color-text-primary)]">
                <option value="any">Known or unknown</option>
                <option value="known">Known</option>
                <option value="unknown">Unknown</option>
              </select>
            </label>
            <label className="text-sm text-[var(--color-text-secondary)]">
              Minimum confidence
              <input type="number" min="0" max="1" step="0.05" value={automationDraft.minScore} onChange={(event) => setAutomationDraft({ ...automationDraft, minScore: event.target.value })} className="mt-1 min-h-11 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-base text-[var(--color-text-primary)]" />
            </label>
            {automationDraft.kind === 'webhook' || automationDraft.kind === 'mqtt' ? (
              <label className="text-sm text-[var(--color-text-secondary)]">
                {automationDraft.kind === 'webhook' ? 'Webhook URL' : 'MQTT topic'}
                <input type={automationDraft.kind === 'webhook' ? 'url' : 'text'} value={automationDraft.target} onChange={(event) => setAutomationDraft({ ...automationDraft, target: event.target.value })} required className="mt-1 min-h-11 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-base text-[var(--color-text-primary)]" />
              </label>
            ) : null}
            <div className="sm:col-span-2">
              <Button type="submit" variant="secondary" loading={busy} loadingText="Saving…" disabled={!automationDraft.name.trim()}>Add automation</Button>
              <p className="mt-2 text-xs text-[var(--color-text-secondary)]">
                Physical light, warning, and siren actions require a named smart rule plus a verified adapter capability and are not offered as quick actions here.
              </p>
            </div>
          </form>
        </div>
      </Section>

      <Section title="Package area (experimental)" subtitle="Watches for a stable porch object appearing or disappearing; it does not semantically recognize parcels.">
        <label className="block px-4 py-3 text-sm text-[var(--color-text-primary)]">
          Scene-change sensitivity (z-score)
          <input
            type="number"
            min="0.05"
            max="3"
            step="0.05"
            value={packageThresholdDraft}
            onChange={(event) => setPackageThresholdDraft(event.target.value)}
            onBlur={() => {
              const value = clamp(Number(packageThresholdDraft) || 0.35, 0.05, 3)
              setPackageThresholdDraft(String(value))
              void saveConfig({ package_change_threshold: value })
            }}
            className="mt-1 min-h-11 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 text-base"
          />
          <span className="mt-1 block text-xs text-[var(--color-text-secondary)]">Lower notices smaller changes; this is a scene-change z-score, not a confidence percentage.</span>
        </label>
        <label className="block px-4 py-3 text-sm text-[var(--color-text-primary)]">
          Stable for seconds
          <input
            type="number"
            min="2"
            max="300"
            value={packageStableDraft}
            onChange={(event) => setPackageStableDraft(event.target.value)}
            onBlur={() => {
              const value = clamp(Number(packageStableDraft) || 10, 2, 300)
              setPackageStableDraft(String(value))
              void saveConfig({ package_stable_s: value })
            }}
            className="mt-1 min-h-11 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 text-base"
          />
        </label>
      </Section>

      <Section title="Sound events" subtitle="Experimental sound-pattern heuristics only. HomeCam is not a safety alarm; keep certified smoke and carbon-monoxide alarms installed.">
        <Row
          label="Arm experimental sound matching"
          right={<Toggle checked={config?.audio_event_enabled ?? false} disabled={!config || !config.audio_event_enabled} onChange={(audio_event_enabled) => void saveConfig({ audio_event_enabled })} ariaLabel="Enable experimental sound matching" />}
        />
        <p role="status" className="px-4 pb-3 text-xs font-semibold text-[var(--color-warning)]">
          Unavailable/inactive: no microphone and audio-classifier capability has reported available. An already-enabled legacy setting can be turned off.
        </p>
        {config?.audio_event_enabled ? (
          <fieldset className="space-y-1 px-4 py-3">
            <legend className="text-sm font-semibold text-[var(--color-text-primary)]">Patterns to configure</legend>
            {AUDIO_EVENT_OPTIONS.map((option) => (
              <label key={option.id} className="flex min-h-11 items-center gap-3 text-sm text-[var(--color-text-primary)]">
                <input
                  type="checkbox"
                  checked={(config.audio_event_labels ?? []).includes(option.id)}
                  onChange={(event) => {
                    const current = config.audio_event_labels ?? []
                    const next = event.target.checked
                      ? [...new Set([...current, option.id])]
                      : current.filter((label) => label !== option.id)
                    void saveConfig({ audio_event_labels: next })
                  }}
                  className="h-5 w-5 accent-[var(--color-accent-default)]"
                />
                {option.label}
              </label>
            ))}
          </fieldset>
        ) : null}
      </Section>

      <Section title="Deterrence" subtitle="This arms policy only; it does not prove that a light or speaker can activate.">
        <Row
          label="Arm deterrence policy"
          right={<Toggle checked={config?.deterrence_enabled ?? false} disabled={!config || (!config.deterrence_enabled && deterrenceCapability?.available !== true)} onChange={(deterrence_enabled) => void saveConfig({ deterrence_enabled })} ariaLabel="Arm deterrence policy" />}
        />
        <p role="status" className="px-4 pb-3 text-xs font-semibold text-[var(--color-warning)]">
          {deterrenceCapabilityState === 'loading'
            ? 'Checking whether a mounted deterrence adapter is available. Arming remains unavailable until the check completes.'
            : deterrenceCapabilityState === 'error'
              ? 'Capability status could not be verified. Deterrence remains fail-closed; reopen Settings to retry.'
              : deterrenceCapability?.available
                ? deterrencePrivacyBlocked
                  ? 'A mounted deterrence adapter is available, but Privacy mode currently blocks activation. Arming only saves the policy.'
                  : 'A mounted deterrence adapter is available. Actions still require foreground confirmation and policy checks.'
                : `Unavailable/inactive: ${deterrenceCapability?.limitation ?? 'no mounted deterrence adapter is available'}. An already-armed policy can be turned off.`}
        </p>
        {config?.deterrence_enabled ? (
          <div className="grid gap-3 px-4 py-3 sm:grid-cols-2">
            <label className="text-sm text-[var(--color-text-primary)]">
              Default action
              <select
                value={config.deterrence_action}
                onChange={(event) => void saveConfig({ deterrence_action: event.target.value as DetectionConfig['deterrence_action'] })}
                className="mt-1 min-h-11 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 text-base"
              >
                <option value="light">Turn on light</option>
                <option value="warning">Play warning</option>
                <option value="siren">Sound siren</option>
              </select>
            </label>
            <label className="text-sm text-[var(--color-text-primary)]">
              Duration seconds
              <input
                type="number"
                min="1"
                max="60"
                value={deterrenceDurationDraft}
                onChange={(event) => setDeterrenceDurationDraft(event.target.value)}
                onBlur={() => {
                  const value = clamp(Number(deterrenceDurationDraft) || 10, 1, 60)
                  setDeterrenceDurationDraft(String(value))
                  void saveConfig({ deterrence_duration_s: value })
                }}
                className="mt-1 min-h-11 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 text-base"
              />
            </label>
          </div>
        ) : null}
      </Section>
    </div>
  )
}
