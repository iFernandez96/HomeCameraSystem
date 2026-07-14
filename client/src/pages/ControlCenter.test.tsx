import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

vi.mock('./settings/OperationsSection', () => ({ OperationsSection: () => <div>Operations proof</div> }))

import { ControlCenter } from './ControlCenter'

describe('ControlCenter', () => {
  it('Given an owner reaches the dedicated route, Then operational proof is separate from Settings', () => {
    render(<MemoryRouter><ControlCenter /></MemoryRouter>)
    expect(screen.getByRole('heading', { name: 'Control Center' })).toBeInTheDocument()
    expect(screen.getByText('Operations proof')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings')
  })
})
