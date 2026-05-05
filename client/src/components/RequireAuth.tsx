import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { LivePageSkeleton } from './Skeleton'
import { getSessionExpiredFlag, useAuth } from '../lib/auth'

/**
 * Route gate (iter-182, Auth Plan Phase 4). Wrap every protected
 * route's element in <RequireAuth>...</RequireAuth>.
 *
 * iter-356.20 (Maya 14th CRITICAL #1): while the AuthProvider is
 * still resolving /api/auth/me, render the Live-shaped skeleton
 * instead of `null`. Pre-iter-356.20 the cold-load cycle on
 * Tailscale cellular was: navbar → empty <main> (this null) →
 * Suspense spinner → empty (Live mounts) → video. 800-1500ms of
 * nervous tic where Login was confident. Now: the page-to-be
 * shape paints immediately; auth resolves; Suspense swaps in the
 * real Live; user sees layout settling, not flickering.
 *
 * Server-side gating arrives at Phase 5 (iter-183). This is the
 * client-side enforcement; the loading-state skeleton is purely
 * UX (matches what the user is about to see).
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { state } = useAuth()
  if (state === 'loading') return <LivePageSkeleton />
  if (state === 'anon') {
    // iter-356.65 (Mira critic blocker #5): when the redirect was
    // triggered by an expiring session (auth.tsx setting the
    // module-scope flag), append ?expired=1 so Login renders the
    // informational banner. Fresh-visit / never-logged-in case
    // lands on a clean /login.
    const target = getSessionExpiredFlag() ? '/login?expired=1' : '/login'
    return <Navigate to={target} replace />
  }
  return <>{children}</>
}
