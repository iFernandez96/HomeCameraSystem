import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// iter-356.C (mobile-redesign Slice C — security clarity): Reboot
// + Update confirm bodies must be specific about what won't survive
// the disruption (in-flight clip, open Live tabs) and what does
// survive (logins, push subs).

const rebootJetson = vi.fn()
const triggerBackup = vi.fn()
const triggerRestore = vi.fn()
const triggerUpdate = vi.fn()
const listBackups = vi.fn().mockResolvedValue({ items: [] })

vi.mock('../../lib/api', () => ({
  rebootJetson: (...a: unknown[]) => rebootJetson(...a),
  triggerBackup: (...a: unknown[]) => triggerBackup(...a),
  triggerRestore: (...a: unknown[]) => triggerRestore(...a),
  triggerUpdate: (...a: unknown[]) => triggerUpdate(...a),
  listBackups: (...a: unknown[]) => listBackups(...a),
}))

const confirmFn = vi.fn().mockResolvedValue(false)
vi.mock('../../lib/confirm', () => ({
  useConfirm: () => confirmFn,
}))

const showToast = vi.fn()
vi.mock('../../lib/toast', () => ({
  useToast: () => ({ showToast }),
}))

import { DangerZone } from './DangerZone'

beforeEach(() => {
  confirmFn.mockReset().mockResolvedValue(false)
  rebootJetson.mockReset()
  triggerUpdate.mockReset()
  showToast.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('DangerZone confirm bodies (iter-356.C)', () => {
  it('given the operator clicks Reboot, when confirm opens, then body warns about lost in-flight clip + open Live tabs + preserved logins/push', async () => {
    // arrange
    const user = userEvent.setup()

    // act
    render(<DangerZone />)
    await user.click(screen.getByRole('button', { name: /restart camera box/i }))

    // assert
    expect(confirmFn).toHaveBeenCalled()
    const body = (confirmFn.mock.calls[0][0] as { body: string }).body
    expect(body).toMatch(/clip currently being recorded will be lost/i)
    expect(body).toMatch(/reconnect/i)
    expect(body).toMatch(/saved logins.*push notification setup are preserved/i)
  })

  it('given the operator clicks Update, when confirm opens, then body mirrors the Reboot disruption context', async () => {
    // arrange
    const user = userEvent.setup()

    // act — premium-launch slice (Frank top-3 #2): button label
    // de-IT-ified to "Install camera updates" (was "Update
    // server software (~30 s outage)"). Confirm body still
    // explains the disruption.
    render(<DangerZone />)
    await user.click(
      screen.getByRole('button', { name: /install camera updates/i }),
    )

    // assert
    expect(confirmFn).toHaveBeenCalled()
    const body = (confirmFn.mock.calls[0][0] as { body: string }).body
    expect(body).toMatch(/installs the new version/i)
    expect(body).toMatch(/clip currently being recorded will be lost/i)
    expect(body).toMatch(/reconnect/i)
    expect(body).toMatch(/preserved/i)
  })
})

describe('DangerZone copy de-IT-ification (premium-launch slice — Frank top-3)', () => {
  it('Given the Maintenance section renders, When the user reads the button labels, Then they speak camera-product vocabulary (NOT datacenter vocabulary)', () => {
    // arrange — Frank top-3 #2: "Back up server state" /
    // "Update server software (~30 s outage)" read as
    // datacenter copy. Replaced with "Back up camera settings"
    // / "Install camera updates".
    render(<DangerZone />)

    // assert — new copy is present.
    expect(
      screen.getByRole('button', { name: /back up camera settings/i }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /install camera updates/i }),
    ).toBeInTheDocument()
    // assert — old copy is gone (regression sentinel).
    expect(
      screen.queryByRole('button', { name: /server state/i }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /server software/i }),
    ).not.toBeInTheDocument()
  })

  it('Given the user taps Restart camera box, When the confirm dialog opens, Then the title says "Restart the camera box?" — NOT "Reboot Jetson?" (Frank top-3 #3: drop hardware-brand leak)', async () => {
    // arrange
    const user = userEvent.setup()

    // act
    render(<DangerZone />)
    await user.click(screen.getByRole('button', { name: /restart camera box/i }))

    // assert — confirm payload uses the new title + action.
    expect(confirmFn).toHaveBeenCalled()
    const args = confirmFn.mock.calls[0][0] as {
      title: string
      confirmLabel: string
    }
    expect(args.title).toBe('Restart the camera box?')
    expect(args.confirmLabel).toBe('Restart')
    expect(args.title).not.toMatch(/jetson/i)
  })

  it('Given the user taps Install camera updates, When the confirm dialog opens, Then the title says "Install camera updates?" — matching the button vocabulary', async () => {
    // arrange
    const user = userEvent.setup()

    // act
    render(<DangerZone />)
    await user.click(
      screen.getByRole('button', { name: /install camera updates/i }),
    )

    // assert
    expect(confirmFn).toHaveBeenCalled()
    const args = confirmFn.mock.calls[0][0] as {
      title: string
      confirmLabel: string
    }
    expect(args.title).toBe('Install camera updates?')
    expect(args.confirmLabel).toBe('Install')
    expect(args.title).not.toMatch(/server software/i)
  })

  it('Given the section renders, When the user reads the section header, Then it says "Camera maintenance" (not just "Maintenance" — datacenter-eyebrow language)', () => {
    // arrange / act
    render(<DangerZone />)

    // assert
    expect(
      screen.getByText(/^camera maintenance$/i),
    ).toBeInTheDocument()
  })

  it('Given the section renders, When the user reads the danger-zone caveat, Then "interrupt service" / "change disk state" / "backup snapshot" datacenter phrases are GONE in favor of plain English (Frank top-3)', () => {
    // arrange / act
    render(<DangerZone />)

    // assert — preserved + new copy present.
    expect(
      screen.getByText(/these actions are harder to undo/i),
    ).toBeInTheDocument()
    // assert — old jargon is gone (regression sentinel).
    expect(
      screen.queryByText(/interrupt service/i),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText(/change disk state/i),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText(/backup snapshot/i),
    ).not.toBeInTheDocument()
  })
})
