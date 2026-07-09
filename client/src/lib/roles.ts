import type { User } from './types'

/**
 * Owner-equivalent gate. `admin` is the transitional legacy owner
 * (CLAUDE.md: "RBAC admin-as-owner transitional carve-out") — it and
 * `owner` both pass until seeded users migrate, at which point this ONE
 * helper drops the `admin` arm and all call sites follow.
 */
export function isOwner(user: User | null | undefined): boolean {
  return user?.role === 'owner' || user?.role === 'admin'
}

export function isOwnerRole(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin'
}

/**
 * God-View / god-mode visibility. TODAY this is username-based
 * (`admin`) for historical reasons; unify onto the owner role so god
 * mode tracks RBAC instead of a magic username. Behaviour change:
 * a seeded `owner` (non-`admin`) now also sees God View — intended.
 */
export function isGodModeUser(user: User | null | undefined): boolean {
  return isOwner(user)
}
