import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import { getMe, HttpError, login as apiLogin, logout as apiLogout } from './api'
import { log, errFields } from './log'
import { useToast } from './toast'
import type { User } from './types'
import { warmWhepConnection } from './webrtc'

/**
 * Tri-state auth lifecycle (iter-182, Auth Plan Phase 4).
 *
 *  - `loading`: initial mount, /api/auth/me request in flight. Don't
 *    redirect yet — flashing /login on first paint when the user
 *    actually has a valid session is the worst-of-both UX.
 *  - `authed`:  /api/auth/me returned 200; `user` is non-null.
 *  - `anon`:    /api/auth/me returned 401 (or any other error). User
 *    must log in. RequireAuth redirects on this state.
 */
export type AuthState = 'loading' | 'authed' | 'anon'

type AuthContextValue = {
  state: AuthState
  user: User | null
  login: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

// iter-356.65 (Mira critic blocker #5): module-scope flag set when
// /api/auth/refresh 401s mid-session. RequireAuth reads this on the
// redirect to /login so the Login banner can render the "you've been
// signed out for security" copy. Cleared by Login when consumed (so
// a manual /login visit later doesn't keep showing the banner).
let _wasSessionExpired = false
export function getSessionExpiredFlag(): boolean {
  return _wasSessionExpired
}
export function clearSessionExpiredFlag(): void {
  _wasSessionExpired = false
}

/**
 * Wrap the app inside this once at the top of the tree. Fires a
 * single /api/auth/me on mount to determine initial state.
 *
 * Phase 5 (iter-183) starts gating /api/* on the cookies set by
 * /api/auth/login. Today those routes are still ungated, so this
 * provider is harmless on a server that hasn't rolled out auth —
 * the /me call returns 401, state flips to `anon`, and the user
 * is redirected to /login (which the operator must seed at least
 * one user for before deploying iter-182).
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>('loading')
  const [user, setUser] = useState<User | null>(null)
  const { showToast } = useToast()

  useEffect(() => {
    let cancelled = false
    // Premium-launch slice — Live-chunk prefetch. Today the React.lazy
    // import for the Live page only fires AFTER /api/auth/me resolves
    // and RequireAuth re-renders with children — so the chunk fetch
    // runs SERIALLY after the auth round-trip. Kicking the dynamic
    // import here, in parallel with the auth fetch, lets the chunk
    // fetch overlap the auth round-trip on every cold visit. The
    // import is fire-and-forget; it caches in the module loader so
    // the React.lazy promise resolves instantly when Live mounts.
    // Errors are swallowed because the React.lazy will surface its
    // own retry path through Suspense if the chunk genuinely fails.
    void import('../pages/Live').catch(() => {})
    getMe()
      .then((res) => {
        if (cancelled) return
        setUser(res.user)
        setState('authed')
      })
      .catch((e) => {
        // docs/logging_plan.md §2 (Auth): a non-401 /me error is
        // masquerading as anon below — a 5xx or network failure looks
        // identical to "never logged in" to the user, which is the
        // exact ambiguity to surface. 401 is the expected first-visit
        // path (DEBUG, high-freq). Logged BEFORE the cancelled guard so
        // an in-flight failure during unmount is still recorded (§1.3).
        if (e instanceof HttpError && e.status === 401) {
          log.debug('auth:me-anon', { status: 401 })
        } else {
          log.warn('auth:me-failed', {
            ...errFields(e),
            online: typeof navigator !== 'undefined' ? navigator.onLine : null,
          })
        }
        if (cancelled) return
        // 401 → anonymous, expected on first visit. Any other error
        // (network, 5xx) → also anonymous. The login form covers the
        // recovery path; tight-looping retries here would race with
        // the user typing creds.
        if (e instanceof HttpError && e.status === 401) {
          setUser(null)
          setState('anon')
        } else {
          setUser(null)
          setState('anon')
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Premium-launch slice — pre-warm the WHEP peer connection AFTER
  // auth resolves to authed and BEFORE the user reaches /live. Pre-
  // creates the RTCPeerConnection + generates the SDP offer + waits
  // for ICE gathering (host candidates only, iceServers: []). All
  // local — no /whep/* call here, no video element binding here.
  // Warmup runs only when authed (anon visitors don't need it). The
  // warm cache invalidates on `offline` and after a 30 s TTL inside
  // lib/webrtc.ts. See connectWhep for the consume side. Errors are
  // swallowed — warmup is best-effort; cold-path connectWhep still
  // works if warmup never primed the cache.
  useEffect(() => {
    if (state !== 'authed') return
    warmWhepConnection().catch(() => {})
  }, [state])

  // iter-185 (Auth Plan Phase 6): when the WS handshake fails with
  // 1008 (auth/origin gate), `lib/ws.ts` dispatches a window-level
  // `homecam:auth-failed` event. Re-check /api/auth/me — if the
  // cookie is still valid (e.g., the WS 1008 was an origin issue)
  // we stay authed; if it 401s we flip to anon, RequireAuth
  // redirects to /login on the next render. Self-healing.
  useEffect(() => {
    function onAuthFailed() {
      // docs/logging_plan.md §2 (Auth): self-heal result INFO. The WS
      // 1008 → re-check /me round-trip is otherwise invisible; logging
      // the outcome distinguishes "origin gate, cookie still good"
      // (healed) from "cookie actually expired" (flipped to anon).
      getMe()
        .then((res) => {
          log.info('auth:self-heal-ok', {})
          setUser(res.user)
          setState('authed')
        })
        .catch((e) => {
          if (e instanceof HttpError && e.status === 401) {
            log.info('auth:self-heal-anon', { status: 401 })
            setUser(null)
            setState('anon')
          } else {
            // Non-401 (network, 5xx) — leave state alone. The next
            // user action will trigger another check.
            log.warn('auth:self-heal-failed', {
              ...errFields(e),
              online:
                typeof navigator !== 'undefined' ? navigator.onLine : null,
            })
          }
        })
    }
    window.addEventListener('homecam:auth-failed', onAuthFailed)
    return () => window.removeEventListener('homecam:auth-failed', onAuthFailed)
  }, [])

  // iter-186 (Auth Plan Phase 7): session-expiry UX. `lib/api.ts`
  // dispatches `homecam:session-expired` when /api/auth/refresh
  // 401s (the refresh cookie expired or was invalidated). Toast
  // 'Session expired', flip to anon — RequireAuth redirects to
  // /login on the next render. Functional setState dedupes:
  // multiple bursts dispatching simultaneously only show the toast
  // on the FIRST anon transition (subsequent calls find state
  // already anon and short-circuit).
  useEffect(() => {
    function onSessionExpired() {
      setState((cur) => {
        if (cur === 'anon') return cur
        // docs/logging_plan.md §2 (Auth): session-expired INFO — fires
        // once on the authed→anon transition (the functional-setState
        // dedupe means a burst only logs/toasts the first time).
        log.info('auth:session-expired', {})
        // iter-356.65 (Mira critic blocker #5): set the module-scope
        // flag BEFORE the state flip so RequireAuth's next-render
        // redirect picks it up and lands the user at /login?expired=1.
        _wasSessionExpired = true
        showToast('Session expired', 'error')
        return 'anon'
      })
      setUser(null)
    }
    window.addEventListener('homecam:session-expired', onSessionExpired)
    return () =>
      window.removeEventListener('homecam:session-expired', onSessionExpired)
  }, [showToast])

  const login = useCallback(async (username: string, password: string) => {
    const res = await apiLogin({ username, password })
    setUser(res.user)
    setState('authed')
    // iter-356.65: a successful sign-in clears the expired flag so
    // a future MANUAL sign-out doesn't show the "signed out for
    // security" banner (that copy belongs only to involuntary expiry).
    _wasSessionExpired = false
  }, [])

  const logout = useCallback(async () => {
    try {
      await apiLogout()
    } catch (e) {
      // docs/logging_plan.md §2 (Auth): logout server-call fail WARN.
      // The POST that clears the cookie didn't land — the cookie may
      // not be invalidated server-side (security-relevant: we proceed
      // to clear LOCAL state regardless, but the operator should know
      // the round-trip failed).
      // Network failure during logout — the server may still hold a
      // session record (it doesn't, since there's no server-side
      // blocklist by Charter anti-rec #21, but cookies on the client
      // may also still exist). Clear local state regardless so the
      // UI immediately reflects logged-out, and the cookies' 15-min
      // TTL expires them server-side soon enough.
      log.warn('auth:logout-failed', {
        ...errFields(e),
        online: typeof navigator !== 'undefined' ? navigator.onLine : null,
      })
    }
    setUser(null)
    setState('anon')
  }, [])

  return (
    <AuthContext.Provider value={{ state, user, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    throw new Error('useAuth must be used within <AuthProvider>')
  }
  return ctx
}
