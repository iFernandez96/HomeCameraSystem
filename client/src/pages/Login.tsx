import {
  useState,
  type FocusEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { BrandMarkRow } from '../components/WhoMark'
import { Button } from '../components/primitives/Button'
import { HttpError } from '../lib/api'
import { useAuth } from '../lib/auth'
import { log } from '../lib/log'

/**
 * Full-page sign-in form — the brand-setting first impression.
 * Playroom Modern (Task 9): the page sits directly on the wall ground
 * (`--color-bg`) rather than a lifted paper card; `<BrandMarkRow>`
 * (Panther / Mushu / Coco, one shared mark shape with the rest of the
 * identity system) replaces the old CatTrioMark PNG stitch above the
 * title, staggering in nose-to-tail (0/90/180ms) via the scoped
 * `<style>` block below — reuses index.css's `login-fade-in` keyframe
 * so the global `prefers-reduced-motion: reduce` clamp (index.css)
 * already covers it without a component-level guard. Username +
 * password now share ONE rounded bar (radius-xl) instead of two
 * separately-bordered fields — a hairline divider marks the seam.
 * Kept from the iter-356 series:
 *  - Surfaced error state (icon + tinted box, not bare red text)
 *  - Loading spinner inside the submit button
 *  - Caps Lock warning on the password field
 *  - 44 px touch targets on inputs + button; 16 px input text so iOS
 *    Safari doesn't zoom-jump the viewport on focus
 *
 * Auth contract preserved: AuthProvider's `login` posts /api/auth/
 * login, sets state to 'authed', and we navigate back to /live.
 * If the user is already authed (e.g., they manually visited
 * /login from inside the app), short-circuit to /live so the back
 * button works sanely.
 */
export function Login() {
  const { state, login } = useAuth()
  const navigate = useNavigate()
  // iter-356.65 (Mira critic blocker #5): persistent banner when
  // the user landed here because their session expired (auth.tsx
  // appends ?expired=1 on the redirect). Without this, a user
  // bumped mid-session sees a clean Login form and assumes their
  // password is wrong — they'll burn two attempts before checking
  // anything else. Banner is informational (role="status"), not an
  // error, because nothing the user did is wrong.
  const [searchParams] = useSearchParams()
  const wasExpired = searchParams.get('expired') === '1'
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // iter-356.1: Caps Lock warning. Driven by the password field's
  // keydown — getModifierState reads the actual OS key state, not
  // a tracked toggle, so it stays accurate even if the user toggled
  // Caps before clicking into the field.
  const [capsLockOn, setCapsLockOn] = useState(false)
  // iter-356.1a (Maya Major): show-password toggle. Anyone with a
  // complex password on a phone with no visibility into typos rage-
  // quits within two attempts. THIS is what a paid product fixes;
  // Caps Lock warning is the consolation prize. Stripe / 1Password /
  // Linear all ship this.
  const [showPassword, setShowPassword] = useState(false)

  if (state === 'authed') {
    // UI/UX overhaul 2026-07-07 (Mira, Login): "/live" is a retired
    // alias — the Watch page lives at "/" now. Land there directly
    // instead of bouncing through the alias redirect.
    return <Navigate to="/" replace />
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await login(username, password)
      navigate('/', { replace: true })
    } catch (err) {
      // docs/logging_plan.md §2 (Auth): failed sign-in WARN. GUARDRAIL
      // §4 — log the username + HTTP status ONLY; NEVER the password
      // (it's in `password` scope here and must never reach the log).
      // online disambiguates "wrong creds" (401) from "server/network
      // down" (no status). navigator.onLine is the network-edge signal.
      log.warn('login:failed', {
        username,
        status: err instanceof HttpError ? err.status : null,
        online: typeof navigator !== 'undefined' ? navigator.onLine : null,
      })
      if (err instanceof HttpError && err.status === 401) {
        // iter-356.1: human voice + recovery action in the copy itself.
        setError('Wrong username or password — try again.')
      } else if (err instanceof Error) {
        // iter-356.1: don't leak internal err.message strings.
        setError('Could not sign in. Check your connection and try again.')
      } else {
        setError('Something went wrong. Try again in a moment.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  function handlePasswordKey(e: KeyboardEvent<HTMLInputElement>) {
    setCapsLockOn(e.getModifierState('CapsLock'))
  }

  // iter-356.1a (Frank #5): iOS Safari's virtual keyboard often
  // doesn't fire keydown on password fields. onFocus DOES fire on
  // physical-keyboard flows and we can probe the modifier state via
  // FocusEvent.getModifierState (DOM L3, supported in all browsers
  // we ship to). Combined with onKeyDown, this catches both
  // physical-keyboard + tap-then-type flows.
  function handlePasswordFocus(e: FocusEvent<HTMLInputElement>) {
    const native = e.nativeEvent as unknown as {
      getModifierState?: (k: string) => boolean
    }
    if (typeof native.getModifierState === 'function') {
      setCapsLockOn(native.getModifierState('CapsLock'))
    }
  }

  return (
    <div className="min-h-full flex items-center justify-center px-6 py-16 bg-[var(--color-bg)]">
      {/* Playroom Modern (Task 9): card grammar matches the rest of
          the redesign — rounded-[var(--radius-xl)] + a 1.5px hairline
          border, still lifted by --shadow-card / --shadow-card-inset
          (paper catching daylight, not a glow) off the wall-ground
          page behind it. */}
      <form
        onSubmit={handleSubmit}
        aria-label="Sign in"
        // iter-356.56 (mobile F1): flex-col + min-h ensures the Sign
        // in button doesn't disappear behind the iOS soft keyboard
        // on short Android devices when interactive-widget=resizes-
        // content shrinks the viewport. Card grows to fill available
        // space so the submit button stays bottom-anchored relative
        // to the card body.
        className="w-full max-w-sm flex flex-col bg-[var(--color-surface)] border-[1.5px] border-[var(--color-border)] rounded-[var(--radius-xl)] p-10 animate-login-in shadow-[var(--shadow-card)]"
        style={{ boxShadow: 'var(--shadow-card), var(--shadow-card-inset)' }}
      >
        {/* Playroom Modern (Task 9): the scoped stagger only fires
            under prefers-reduced-motion: no-preference — reduced-
            motion users get the marks at their resting (100%
            opacity, 0 offset) state instantly. Reuses the
            `login-fade-in` keyframe already defined in index.css
            (also respected by the global reduced-motion clamp
            there) rather than introducing a parallel one.
            Landscape pass (Task 3): BrandMarkRow now renders raster
            `<img>` marks (real cat-face photos) instead of inline
            `<svg>` glyphs — selector updated to match. */}
        <style>{`
          @media (prefers-reduced-motion: no-preference) {
            .login-brand-stagger img:nth-of-type(1) {
              animation: login-fade-in 300ms var(--ease-out, cubic-bezier(0,0,0.2,1)) both;
              animation-delay: 0ms;
            }
            .login-brand-stagger img:nth-of-type(2) {
              animation: login-fade-in 300ms var(--ease-out, cubic-bezier(0,0,0.2,1)) both;
              animation-delay: 90ms;
            }
            .login-brand-stagger img:nth-of-type(3) {
              animation: login-fade-in 300ms var(--ease-out, cubic-bezier(0,0,0.2,1)) both;
              animation-delay: 180ms;
            }
          }
        `}</style>
        {wasExpired && (
          <div
            role="status"
            className="mb-6 rounded-lg border border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] px-4 py-3 text-sm text-[var(--color-text-primary)]"
          >
            <span className="font-semibold">You&apos;ve been signed out for security.</span>{' '}
            <span className="text-[var(--color-text-secondary)]">
              Sign back in to pick up where you left off.
            </span>
          </div>
        )}
        <div className="flex flex-col items-center text-center mb-8">
          {/* Playroom Modern (Task 9): BrandMarkRow replaces the old
              CatTrioMark PNG stitch — same three-cat identity, drawn
              from the shared WhoMark shape/color system instead of a
              one-off raster asset. Wrapper class scopes the staggered
              entrance defined in the <style> block above. */}
          <div className="login-brand-stagger mb-4">
            <BrandMarkRow size={44} />
          </div>
          <h1 className="font-display text-4xl font-bold text-[var(--color-text-primary)] tracking-tight">
            HomeCam
          </h1>
          <p className="font-display text-base text-[var(--color-text-secondary)] mt-2 max-w-xs">
            Panther, Mushu &amp; Coco are watching the door.
          </p>
          <p className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-brass-default)] font-semibold mt-3">
            The Den · A household watch
          </p>
        </div>

        {/* Playroom Modern (Task 9): username + password now share ONE
            big rounded input bar (radius-xl) instead of two separately
            bordered fields — a hairline divider marks the seam between
            them. Each <label> keeps its own visible caption + the
            same aria wiring (aria-invalid/aria-describedby, Caps Lock
            probes) as before; only the outer border/radius moved from
            per-field to the shared bar. */}
        <div className="flex flex-col rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-bg)] overflow-hidden mb-2">
          <label className="flex flex-col px-3.5 py-3 border-b border-[var(--color-border)] focus-within:bg-[var(--color-surface)] transition-colors">
            <span className="text-xs font-medium text-[var(--color-text-secondary)] mb-1">
              Username
            </span>
            <input
              type="text"
              // iter-356.1a (Frank #1): blank field with no hint left
              // first-time users (Frank: "what do I type? my email?
              // 'admin'?"). Placeholder makes the expected input
              // shape obvious.
              placeholder="Your account name"
              autoComplete="username"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              // iter-271 a11y: tie inputs to the role="alert" error region
              // so NVDA reads field+error together, not separately.
              aria-invalid={error ? true : undefined}
              aria-describedby={
                error ? 'username-hint login-error' : 'username-hint'
              }
              className="bg-transparent text-base text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] outline-none focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 rounded"
            />
          </label>

          <label className="flex flex-col px-3.5 py-3 focus-within:bg-[var(--color-surface)] transition-colors">
            <span className="text-xs font-medium text-[var(--color-text-secondary)] mb-1">
              Password
            </span>
            {/* iter-356.1a (Maya Major): show-password eye toggle.
                Position: absolute right-side inside the input. The
                `pr-11` on the input reserves 44 px space for the
                toggle's tap target. Toggle's aria-label flips with
                state so SR users get accurate announcements. */}
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                placeholder="Your password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={handlePasswordKey}
                onFocus={handlePasswordFocus}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? 'login-error' : undefined}
                className="w-full bg-transparent pr-11 text-base text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] outline-none focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 rounded"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                // Sunroom hit-area fix: the input's own line-box is well
                // under 44px, so anchoring the button with inset-y-0
                // (stretched to that line height) shrank the real tap
                // target to ~24px. Centering an explicit 44x44 box on
                // the input row instead (parts.tsx Toggle's h/w-fixed
                // pattern) — the surrounding label is tall enough that
                // this never clips against the shared bar's
                // overflow-hidden edge.
                className="absolute right-0 top-1/2 -translate-y-1/2 h-11 w-11 flex items-center justify-center text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 rounded-r-lg transition-colors duration-150"
              >
                {showPassword ? (
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </svg>
                ) : (
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </button>
            </div>
          </label>
        </div>
        <p id="username-hint" className="text-xs text-[var(--color-text-tertiary)] -mt-1 mb-4 px-1">
          Created when HomeCam was first set up.
        </p>

        {/* iter-356.5 (a11y C1 #2 + mobile F1): persistent live-region
            slot — pre-iter-356.5 the warning was a conditional <p>
            that React mounted/unmounted on each keystroke. Two bugs:
            (a) without aria-live, NVDA never announced it; (b) adding
            role="alert" naively would re-announce on every remount =
            on every keystroke = unusable. The fix is a persistent
            <div role="status" aria-live="polite"> that's ALWAYS
            mounted and only its text content swaps — NVDA announces
            once when content goes empty → string. Min-h reserves the
            ~32 px so the submit button doesn't push below the fold
            on small viewports with virtual keyboard open (iPhone SE +
            Bluetooth keyboard with CapsLock). icon stays inline.
            iter-356.1a copy + token preserved. */}
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="min-h-[1.25rem] flex items-center gap-2 text-sm text-[var(--color-warning)] mb-4"
        >
          {capsLockOn && (
            <>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                className="flex-shrink-0"
              >
                <path d="M12 19V5" />
                <polyline points="5 12 12 5 19 12" />
                <line x1="5" y1="19" x2="19" y2="19" />
              </svg>
              <span>Caps Lock is on — passwords are case-sensitive.</span>
            </>
          )}
        </div>

        {/* iter-356.1a (Frank #4): reserve the error slot height
            unconditionally so the submit button doesn't jump up by
            ~80 px when the error appears. Pre-iter-356.1a Frank's
            thumb was tapping air after a wrong-password attempt.
            min-h ensures the layout stays stable empty-or-full. */}
        <div className="min-h-[3.5rem] mt-4 mb-6">
          {error && (
            // iter-356.1a (Maya Major Color): all token-driven. Was
            // bg-red-500/8 (non-standard /8 stop) + bare red-500/300.
            <div
              id="login-error"
              role="alert"
              className="flex items-start gap-2.5 bg-[var(--color-danger-bg)] border border-[var(--color-danger-border)] rounded-lg px-3.5 py-3 text-sm text-[var(--color-danger)]"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="flex-shrink-0 mt-0.5"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* redesign/warm-boutique (Sunroom): the submit goes through
            the Button primitive — Panther-INK fill per the calico
            tri-tone discipline (ink for the one primary action;
            marmalade stays reserved for links/focus). The primitive
            carries the marmalade focus ring (visible against the ink
            fill), the loading spinner + sr-only announcement, and the
            48 px lg tap target. Replaces the old raw accent-orange
            <button> whose active state flashed the now-LIGHT
            --color-accent-muted under white text. Pinned by
            Login.test.tsx. */}
        <Button
          type="submit"
          variant="primary"
          size="lg"
          fullWidth
          loading={submitting}
          loadingText="Signing in…"
        >
          Sign in
        </Button>
      </form>
    </div>
  )
}
