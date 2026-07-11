import { describe, expect, it } from 'vitest'
import { canManageIncident, isGodModeUser, isOwner, isOwnerRole } from './roles'
import type { User } from './types'

describe('role helpers', () => {
  it('Given an owner user, When isOwner is called, Then it returns true', () => {
    // arrange
    const user: User = { username: 'olivia', role: 'owner' }

    // act
    const result = isOwner(user)

    // assert
    expect(result).toBe(true)
  })

  it('Given an admin user, When isOwner is called, Then it returns true for the transitional carve-out', () => {
    // arrange
    const user: User = { username: 'admin', role: 'admin' }

    // act
    const result = isOwner(user)

    // assert
    expect(result).toBe(true)
  })

  it('Given a viewer user, null, or undefined, When isOwner is called, Then it returns false', () => {
    // arrange / act / assert
    expect(isOwner({ username: 'vera', role: 'viewer' })).toBe(false)
    expect(isOwner(null)).toBe(false)
    expect(isOwner(undefined)).toBe(false)
  })

  it('Given the God View account policy, When isGodModeUser is called, Then only Israel and admin owners pass', () => {
    // arrange / act / assert
    expect(isGodModeUser({ username: 'Israel', role: 'owner' })).toBe(true)
    expect(isGodModeUser({ username: 'admin', role: 'admin' })).toBe(true)
    expect(isGodModeUser({ username: 'owner-user', role: 'owner' })).toBe(false)
    expect(isGodModeUser({ username: 'Israel', role: 'family' })).toBe(false)
    expect(isGodModeUser({ username: 'family', role: 'viewer' })).toBe(false)
    expect(isGodModeUser(null)).toBe(false)
  })

  it('Given role strings from user-management rows, When isOwnerRole is called, Then owner-equivalent roles pass', () => {
    // arrange / act / assert
    expect(isOwnerRole('owner')).toBe(true)
    expect(isOwnerRole('admin')).toBe(true)
    expect(isOwnerRole('viewer')).toBe(false)
    expect(isOwnerRole(null)).toBe(false)
  })

  it('Given an incident owner, When mutation access is checked, Then role and case-insensitive username must both match', () => {
    // arrange / act / assert
    expect(canManageIncident({ username: 'Admin', role: 'admin' }, 'admin')).toBe(true)
    expect(canManageIncident({ username: 'israel', role: 'owner' }, 'admin')).toBe(false)
    expect(canManageIncident({ username: 'admin', role: 'viewer' }, 'admin')).toBe(false)
    expect(canManageIncident({ username: 'admin', role: 'admin' }, undefined)).toBe(false)
  })
})
