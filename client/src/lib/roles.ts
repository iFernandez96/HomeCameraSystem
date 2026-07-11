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

/** Incident mutation is both role- and ownership-scoped. Incidents remain
 * readable household-wide, but an owner-equivalent account may only change
 * the incidents that account created. */
export function canManageIncident(
  user: User | null | undefined,
  ownerUsername: string | null | undefined,
): boolean {
  return isOwner(user)
    && typeof ownerUsername === 'string'
    && ownerUsername.trim().toLocaleLowerCase('en-US')
      === user?.username.trim().toLocaleLowerCase('en-US')
}

/** Household-wide usage surveillance is intentionally narrower than RBAC.
 * Only the two named operator accounts may discover or render God View, and
 * they must still hold an owner-equivalent role. The API enforces the same
 * rule so hiding navigation is never the security boundary.
 */
export function isGodModeUser(user: User | null | undefined): boolean {
  if (!isOwner(user)) return false
  const username = user?.username.trim().toLocaleLowerCase('en-US')
  return username === 'israel' || username === 'admin'
}
