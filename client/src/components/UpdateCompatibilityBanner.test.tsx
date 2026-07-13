import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getServerVersion = vi.fn()
vi.mock('../lib/api', () => ({
  getServerVersion: () => getServerVersion(),
}))

import { UpdateCompatibilityBanner } from './UpdateCompatibilityBanner'

describe('UpdateCompatibilityBanner', () => {
  beforeEach(() => {
    getServerVersion.mockReset()
  })

  it('stays quiet when the server accepts this client contract', async () => {
    getServerVersion.mockResolvedValue({ minimum_client_compat: 1 })
    render(<UpdateCompatibilityBanner />)
    await Promise.resolve()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('blocks silent drift when the server requires a newer client contract', async () => {
    getServerVersion.mockResolvedValue({ minimum_client_compat: 2 })
    render(<UpdateCompatibilityBanner />)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This app version is no longer compatible with the camera box.',
    )
    expect(screen.getByRole('button', { name: 'Restart now' })).toBeInTheDocument()
  })
})
