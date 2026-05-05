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
    await user.click(screen.getByRole('button', { name: /reboot jetson/i }))

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

    // act
    render(<DangerZone />)
    await user.click(
      screen.getByRole('button', { name: /update server software/i }),
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
