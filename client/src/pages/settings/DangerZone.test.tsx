import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
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
// useReportError mirrors the real pairing (log.error + error toast).
// Under vitest (MODE === 'test') lib/log ship() is disabled, so
// log.error only hits console.error — observed via spy in the tests.
vi.mock('../../lib/toast', async () => {
  const { log } = await vi.importActual<typeof import('../../lib/log')>(
    '../../lib/log',
  )
  return {
    useToast: () => ({ showToast }),
    useReportError:
      () =>
      (event: string, message: string, fields: Record<string, unknown> = {}) => {
        log.error(event, fields)
        showToast(message, 'error')
      },
  }
})

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

  it('Given PR-002 launch scope, When maintenance renders, Then OTA is disabled and explains the laptop deployment path', async () => {
    // arrange
    const user = userEvent.setup()

    // act
    render(<DangerZone />)
    const updateButton = screen.getByRole('button', {
      name: /install camera updates/i,
    })
    await user.click(updateButton)

    // assert
    expect(updateButton).toBeDisabled()
    expect(updateButton).toHaveAttribute('aria-describedby', 'ota-launch-status')
    expect(confirmFn).not.toHaveBeenCalled()
    expect(triggerUpdate).not.toHaveBeenCalled()
    expect(
      screen.getByText(
        /unavailable for this release.*versioned builds.*laptop.*signing is not production-supported/i,
      ),
    ).toHaveAttribute('role', 'status')
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

  it('Given the maintenance controls render, When OTA is inspected, Then it remains visible but unavailable rather than implying support', () => {
    // arrange / act
    render(<DangerZone />)

    // assert
    expect(
      screen.getByRole('button', { name: /install camera updates/i }),
    ).toBeDisabled()
    expect(
      screen.getByText(/release signing is not production-supported yet/i),
    ).toHaveAttribute('role', 'status')
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

describe('DangerZone — high-consequence op failure logging (docs/logging_plan.md §2)', () => {
  it('Given the operator confirms a Reboot, When rebootJetson rejects, Then the error toast is paired with an error log carrying the status', async () => {
    // arrange — confirm resolves true so the op fires; reboot rejects.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    confirmFn.mockResolvedValue(true)
    const err = Object.assign(new Error('host down'), { status: 502 })
    rebootJetson.mockRejectedValue(err)
    const user = userEvent.setup()

    // act
    render(<DangerZone />)
    await user.click(screen.getByRole('button', { name: /restart camera box/i }))

    // assert — toast-only is no longer the whole story; a durable log
    // records WHY the highest-consequence op failed.
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.stringMatching(/reboot failed/i),
        'error',
      ),
    )
    expect(errorSpy).toHaveBeenCalledWith(
      '[dangerZone:reboot-failed]',
      expect.objectContaining({ status: 502 }),
    )
  })

  it('Given the restore form opens, When listBackups rejects, Then the silent empty-dropdown fallback still logs the reason', async () => {
    // arrange — listBackups rejects; the form falls back to an empty
    // list that reads identically to "no backups yet".
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const err = Object.assign(new Error('nope'), { status: 500 })
    listBackups.mockReset().mockRejectedValue(err)
    const user = userEvent.setup()

    // act
    render(<DangerZone />)
    await user.click(screen.getByRole('button', { name: /restore from backup/i }))

    // assert
    await waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith(
        '[dangerZone:list-backups-failed]',
        expect.objectContaining({ status: 500 }),
      ),
    )
  })
})
