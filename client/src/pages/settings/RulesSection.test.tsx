import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Automation } from '../../lib/api'
import type { DetectionConfig } from '../../lib/types'

const mocks = vi.hoisted(() => ({
  createAutomation: vi.fn(),
  deleteAutomation: vi.fn(),
  getCameras: vi.fn(),
  getDeterrenceCapabilities: vi.fn(),
  getDetectionConfig: vi.fn(),
  listAutomations: vi.fn(),
  patchAutomationEnabled: vi.fn(),
  patchDetectionConfig: vi.fn(),
  testAutomation: vi.fn(),
  showToast: vi.fn(),
}))

vi.mock('../../lib/api', () => ({
  createAutomation: (...args: unknown[]) => mocks.createAutomation(...args),
  deleteAutomation: (...args: unknown[]) => mocks.deleteAutomation(...args),
  getCameras: (...args: unknown[]) => mocks.getCameras(...args),
  getDeterrenceCapabilities: (...args: unknown[]) => mocks.getDeterrenceCapabilities(...args),
  getDetectionConfig: (...args: unknown[]) => mocks.getDetectionConfig(...args),
  listAutomations: (...args: unknown[]) => mocks.listAutomations(...args),
  patchAutomationEnabled: (...args: unknown[]) => mocks.patchAutomationEnabled(...args),
  patchDetectionConfig: (...args: unknown[]) => mocks.patchDetectionConfig(...args),
  testAutomation: (...args: unknown[]) => mocks.testAutomation(...args),
}))

vi.mock('../../lib/toast', () => ({
  useToast: () => ({ showToast: mocks.showToast }),
}))

vi.mock('../../lib/confirm', () => ({
  useConfirm: () => vi.fn().mockResolvedValue(true),
}))

import { RulesSection } from './RulesSection'

const config = {
  smart_rules: [],
  privacy_masks: [],
  package_change_threshold: 0.35,
  package_stable_s: 10,
  audio_event_enabled: true,
  audio_event_labels: ['audio_smoke_alarm'],
  deterrence_enabled: true,
  deterrence_action: 'warning',
  deterrence_duration_s: 10,
} as unknown as DetectionConfig

const webhookAutomation: Automation = {
  id: 'webhook_alert',
  name: 'Webhook alert',
  enabled: true,
  triggers: { labels: ['person'], sources: [], camera_ids: [], rule_ids: [] },
  conditions: { operating_modes: [], person: 'any', min_score: 0 },
  actions: [
    {
      kind: 'webhook',
      target: 'https://example.test/private-path',
      secret_set: true,
    },
  ],
  created_ts: 1,
  updated_ts: 1,
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getDetectionConfig.mockResolvedValue(structuredClone(config))
  mocks.getCameras.mockResolvedValue({
    cameras: [{ id: 'front_door', name: 'Front Door', path: 'cam' }],
  })
  mocks.getDeterrenceCapabilities.mockResolvedValue({
    v: 1,
    available: false,
    adapter: null,
    limitation: 'A mounted adapter is required',
    armed: true,
    privacy_blocked: false,
    supported_actions: ['light', 'warning', 'siren'],
  })
  mocks.listAutomations.mockResolvedValue({ v: 1, items: [webhookAutomation] })
  mocks.patchAutomationEnabled.mockImplementation(
    async (_id: string, enabled: boolean) => ({
      ...webhookAutomation,
      enabled,
      updated_ts: 2,
    }),
  )
  mocks.patchDetectionConfig.mockImplementation(
    async (patch: Partial<DetectionConfig>) => ({ ...config, ...patch }),
  )
})

describe('RulesSection hardening', () => {
  it('uses enabled-only PATCH for an automation toggle and never reconstructs masked webhook actions', async () => {
    const user = userEvent.setup()
    render(<RulesSection />)

    await user.click(
      await screen.findByRole('button', { name: 'Disable Webhook alert' }),
    )

    expect(mocks.patchAutomationEnabled).toHaveBeenCalledWith(
      'webhook_alert',
      false,
    )
    expect(mocks.patchAutomationEnabled).toHaveBeenCalledTimes(1)
  })

  it('does not offer physical automation quick actions and clearly labels tests as dry runs', async () => {
    render(<RulesSection />)
    const automations = await screen.findByText('Webhook alert')
    const section = automations.closest('section') ?? document.body

    expect(within(section).getByRole('button', { name: 'Dry run' })).toBeInTheDocument()
    expect(within(section).queryByRole('option', { name: 'Siren' })).not.toBeInTheDocument()
    expect(screen.getByText(/physical light, warning, and siren actions require a named smart rule/i)).toBeInTheDocument()
  })

  it('keeps a physical automation disabled until a named rule and dry-run capability are both available', async () => {
    const user = userEvent.setup()
    const physical: Automation = {
      ...webhookAutomation,
      id: 'porch_warning',
      name: 'Porch warning',
      enabled: false,
      triggers: {
        labels: [],
        sources: ['vision'],
        camera_ids: ['front_door'],
        rule_ids: ['porch_line'],
      },
      actions: [{ kind: 'warning', duration_s: 10 }],
    }
    mocks.listAutomations.mockResolvedValue({ v: 1, items: [physical] })
    mocks.getDetectionConfig.mockResolvedValue({
      ...config,
      smart_rules: [{
        id: 'porch_line',
        name: 'Porch line',
        kind: 'line_crossing',
        enabled: true,
        camera_id: 'front_door',
        points: [[0.2, 0.5], [0.8, 0.5]],
        labels: ['person'],
        direction: 'any',
        dwell_s: 0,
        threshold: 0.5,
      }],
    })
    mocks.testAutomation.mockResolvedValue({
      ok: true,
      automation_id: physical.id,
      matched: true,
      dry_run: true,
      results: [{
        kind: 'warning',
        status: 'planned',
        capability: {
          available: true,
          adapter: 'mounted_executable',
          limitation: 'Mounted adapter required',
        },
      }],
    })
    mocks.patchAutomationEnabled.mockResolvedValue({ ...physical, enabled: true })
    render(<RulesSection />)
    const enable = await screen.findByRole('button', { name: 'Enable Porch warning' })
    expect(enable).toBeDisabled()

    await user.click(screen.getByRole('button', { name: 'Dry run' }))
    await waitFor(() => expect(enable).not.toBeDisabled())
    expect(mocks.patchAutomationEnabled).not.toHaveBeenCalled()

    await user.click(enable)
    expect(mocks.patchAutomationEnabled).toHaveBeenCalledWith(
      'porch_warning',
      true,
    )
  })

  it('matches server bounds and renders only supported audio-pattern checkboxes with life-safety disclosure', async () => {
    render(<RulesSection />)

    const stable = await screen.findByLabelText('Stable for seconds')
    expect(stable).toHaveAttribute('min', '2')
    expect(stable).toHaveAttribute('max', '300')
    const duration = screen.getByLabelText('Duration seconds')
    expect(duration).toHaveAttribute('max', '60')
    expect(screen.getByRole('checkbox', { name: 'Smoke-alarm pattern' })).toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: /carbon-monoxide/i })).not.toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Glass-break pattern' })).toBeInTheDocument()
    expect(screen.getByText(/homecam is not a safety alarm/i)).toBeInTheDocument()
    expect(screen.getByText(/keep certified smoke and carbon-monoxide alarms installed/i)).toBeInTheDocument()
    expect(screen.getAllByText(/unavailable\/inactive/i).length).toBeGreaterThanOrEqual(2)
  })

  it('Given a mounted adapter, When a fresh owner opens Rules, Then arming and a named physical automation are available without a dry run', async () => {
    // arrange
    const physical: Automation = {
      ...webhookAutomation,
      id: 'porch_warning',
      name: 'Porch warning',
      enabled: false,
      triggers: {
        labels: [],
        sources: ['vision'],
        camera_ids: ['front_door'],
        rule_ids: ['porch_line'],
      },
      actions: [{ kind: 'warning', duration_s: 10 }],
    }
    mocks.listAutomations.mockResolvedValue({ v: 1, items: [physical] })
    mocks.getDetectionConfig.mockResolvedValue({
      ...config,
      deterrence_enabled: false,
      smart_rules: [{
        id: 'porch_line',
        name: 'Porch line',
        kind: 'line_crossing',
        enabled: true,
        camera_id: 'front_door',
        points: [[0.2, 0.5], [0.8, 0.5]],
        labels: ['person'],
        direction: 'any',
        dwell_s: 0,
        threshold: 0.5,
      }],
    })
    mocks.getDeterrenceCapabilities.mockResolvedValue({
      v: 1,
      available: true,
      adapter: 'mounted_executable',
      limitation: 'A mounted adapter is required',
      armed: false,
      privacy_blocked: false,
      supported_actions: ['light', 'warning', 'siren'],
    })

    // act
    render(<RulesSection />)

    // assert
    const enableAutomation = await screen.findByRole('button', { name: 'Enable Porch warning' })
    const armPolicy = screen.getByRole('button', { name: 'Arm deterrence policy' })
    await waitFor(() => {
      expect(enableAutomation).not.toBeDisabled()
      expect(armPolicy).not.toBeDisabled()
    })
    expect(screen.getByText(/mounted deterrence adapter is available/i)).toBeInTheDocument()
    expect(mocks.testAutomation).not.toHaveBeenCalled()
  })

  it('Given the capability check is pending, When Rules renders, Then arming stays disabled with checking copy', async () => {
    // arrange
    mocks.getDetectionConfig.mockResolvedValue({ ...config, deterrence_enabled: false })
    mocks.getDeterrenceCapabilities.mockReturnValue(new Promise(() => undefined))

    // act
    render(<RulesSection />)

    // assert
    const armPolicy = await screen.findByRole('button', { name: 'Arm deterrence policy' })
    expect(armPolicy).toBeDisabled()
    expect(screen.getByText(/checking whether a mounted deterrence adapter is available/i)).toBeInTheDocument()
  })

  it('Given capability verification fails, When Rules renders, Then deterrence remains fail-closed with retry guidance', async () => {
    // arrange
    mocks.getDetectionConfig.mockResolvedValue({ ...config, deterrence_enabled: false })
    mocks.getDeterrenceCapabilities.mockRejectedValue(new Error('offline'))

    // act
    render(<RulesSection />)

    // assert
    const armPolicy = await screen.findByRole('button', { name: 'Arm deterrence policy' })
    await waitFor(() => {
      expect(screen.getByText(/capability status could not be verified/i)).toBeInTheDocument()
    })
    expect(armPolicy).toBeDisabled()
    expect(screen.getByText(/reopen settings to retry/i)).toBeInTheDocument()
  })

  it('rolls an optimistic config draft back when the server rejects it', async () => {
    mocks.patchDetectionConfig.mockRejectedValueOnce(new Error('rejected'))
    render(<RulesSection />)
    const stable = await screen.findByLabelText('Stable for seconds')

    fireEvent.change(stable, { target: { value: '45' } })
    fireEvent.blur(stable)

    await waitFor(() => {
      expect(mocks.patchDetectionConfig).toHaveBeenCalledWith({
        package_stable_s: 45,
      })
      expect(stable).toHaveValue(10)
    })
    expect(mocks.showToast).toHaveBeenCalledWith(
      'Could not save security settings',
      'error',
    )
  })
})
