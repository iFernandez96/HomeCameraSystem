import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { isOwner } from '../lib/roles'
import { LivePageSkeleton } from './Skeleton'

/**
 * Route-level guard for operational controls that are owner-only on the API.
 * Keeping this at the route boundary avoids presenting family/viewer accounts
 * with a fully editable screen whose every save would be rejected by FastAPI.
 * Server-side role checks remain the source of truth.
 */
export function RequireOwner({ children }: { children: ReactNode }) {
  const { state, user } = useAuth()

  if (state === 'loading') return <LivePageSkeleton />
  if (state === 'anon') return <Navigate to="/login" replace />
  if (!isOwner(user)) return <Navigate to="/settings" replace />

  return <>{children}</>
}
