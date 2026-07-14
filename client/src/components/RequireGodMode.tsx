import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { isGodModeUser } from '../lib/roles'
import { LivePageSkeleton } from './Skeleton'

/** Prevents the lazy God View bundle from rendering or fetching for anyone
 * except the two named owner-equivalent operator accounts. */
export function RequireGodMode({ children }: { children: ReactNode }) {
  const { state, user } = useAuth()
  if (state === 'loading') return <LivePageSkeleton />
  if (state === 'anon') return <Navigate to="/login" replace />
  if (!isGodModeUser(user)) return <Navigate to="/" replace />
  return <>{children}</>
}
