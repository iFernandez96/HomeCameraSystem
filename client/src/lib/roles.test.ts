import { describe, expect, it } from 'vitest'
import { isGodModeUser, isOwner, isOwnerRole } from './roles'
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

  it('Given the same role matrix, When isGodModeUser is called, Then owner and admin pass', () => {
    // arrange / act / assert
    expect(isGodModeUser({ username: 'owner-user', role: 'owner' })).toBe(true)
    expect(isGodModeUser({ username: 'legacy-admin', role: 'admin' })).toBe(true)
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
})
