import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const getStatus = vi.fn()
const beginSetup = vi.fn()
const confirmSetup = vi.fn()
const disable = vi.fn()
const showToast = vi.fn()
const reportError = vi.fn()

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api')
  return {
    ...actual,
    getMfaStatus: (...args: unknown[]) => getStatus(...args),
    beginMfaSetup: (...args: unknown[]) => beginSetup(...args),
    confirmMfaSetup: (...args: unknown[]) => confirmSetup(...args),
    disableMfa: (...args: unknown[]) => disable(...args),
  }
})

vi.mock('../../lib/toast', () => ({
  useToast: () => ({ showToast }),
  useReportError: () => reportError,
}))

import { MfaControls } from './MfaControls'

describe('MfaControls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getStatus.mockResolvedValue({ enabled: false })
    beginSetup.mockResolvedValue({
      secret: 'JBSWY3DPEHPK3PXP',
      provisioning_uri: 'otpauth://totp/HomeCam:test',
      recovery_codes: ['AAAAAA-BBBBBB', 'CCCCCC-DDDDDD'],
      expires_in_s: 600,
    })
    confirmSetup.mockResolvedValue({ ok: true, enabled: true })
  })

  it('Given a privileged account, When MFA setup completes, Then the secret and one-time recovery codes are shown before confirmation', async () => {
    // arrange
    render(<MfaControls />)
    await screen.findByText(/protect this admin account/i)

    // act
    fireEvent.click(screen.getByRole('button', { name: /set up/i }))
    fireEvent.change(screen.getByLabelText(/current password for two-step/i), {
      target: { value: 'current-password' },
    })
    fireEvent.click(screen.getByRole('button', { name: /continue/i }))

    // assert
    expect(await screen.findByText('JBSWY3DPEHPK3PXP')).toBeInTheDocument()
    expect(screen.getByRole('list', { name: /recovery codes/i })).toHaveTextContent('AAAAAA-BBBBBB')
    expect(beginSetup).toHaveBeenCalledWith('current-password')

    fireEvent.change(screen.getByLabelText(/authenticator verification code/i), {
      target: { value: '123456' },
    })
    fireEvent.click(screen.getByRole('button', { name: /verify and enable/i }))
    await waitFor(() => expect(confirmSetup).toHaveBeenCalledWith('123456'))
    expect(showToast).toHaveBeenCalledWith('Two-step verification enabled', 'success')
  })
})
