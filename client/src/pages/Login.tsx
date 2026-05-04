import {
  useState,
  type FocusEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { CatTrioMark } from '../components/CatIcons'
import { HttpError } from '../lib/api'
import { useAuth } from '../lib/auth'

/**
 * Full-page sign-in form. iter-356.1 redesign per architect brief:
 *  - Brand identity: lens-glyph + "HomeCam" wordmark + tagline
 *  - Brand-blue accent throughout (was emerald) per design-token
 *    foundation in index.css
 *  - Surfaced error state (icon + tinted box, not bare red text)
 *  - Loading spinner inside the submit button
 *  - Caps Lock warning on the password field
 *  - 44 px touch targets on inputs + button
 *  - Card animates in (login-fade-in keyframe in index.css)
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
    return <Navigate to="/live" replace />
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await login(username, password)
      navigate('/live', { replace: true })
    } catch (err) {
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
      {/* iter-356.1a (Maya Critical 3): card was invisible on dark
          background — #111 surface on #2a2a2a border on #0a0a0a page
          read as a "faint rectangle floating in void." Added
          `shadow-[var(--shadow-card)]` (token defined iter-356.0 but not
          consumed) + 1 px inner highlight via box-shadow inset for
          edge-light. Card now sits on the page instead of floating.
          (Maya Major: rounded-2xl preserved; matches button at
          rounded-xl after iter-356.1a button radius bump.) */}
      <form
        onSubmit={handleSubmit}
        aria-label="Sign in"
        // iter-356.56 (mobile F1): flex-col + min-h ensures the Sign
        // in button doesn't disappear behind the iOS soft keyboard
        // on short Android devices when interactive-widget=resizes-
        // content shrinks the viewport. Card grows to fill available
        // space so the submit button stays bottom-anchored relative
        // to the card body.
        className="w-full max-w-sm flex flex-col bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-10 animate-login-in shadow-[var(--shadow-card)]"
        style={{ boxShadow: 'var(--shadow-card), inset 0 1px 0 rgb(255 255 255 / 0.04)' }}
      >
        {/* iter-356.4-cats: brand identity now CARRIED BY THE THREE
            CATS (Panther / Mushu / Coco). Pixel-art trio replaces
            the generic camera-lens glyph — the household-watch crew
            IS the brand. Tagline tweak ties the wordmark to the
            ambient cat layer that walks the bottom of every page. */}
        {/* iter-356.57 (radical redesign): den-entrance brand block.
            Bigger trio mark, Fraunces serif headline, italic motto,
            cat names typeset as a small uppercase brass row — reads
            as a household sigil panel rather than a SaaS login card. */}
        <div className="flex flex-col items-center text-center mb-8">
          <CatTrioMark size={104} className="mb-4" />
          <h1 className="font-display text-4xl font-bold text-[var(--color-text-primary)] tracking-tight">
            HomeCam
          </h1>
          <p
            className="font-display italic text-base text-[var(--color-text-secondary)] mt-2 max-w-xs"
            style={{ fontStyle: 'italic' }}
          >
            Panther, Mushu &amp; Coco are watching the door.
          </p>
          <p className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-brass-default)] font-semibold mt-3">
            The Den · A household watch
          </p>
        </div>

        <label className="flex flex-col mb-5">
          <span className="text-xs font-medium text-[var(--color-text-secondary)] mb-1.5">
            Username
          </span>
          <input
            type="text"
            // iter-356.1a (Frank #1): blank field with no hint left
            // first-time users (Frank: "what do I type? my email?
            // 'admin'?"). Placeholder + helper text makes the
            // expected input shape obvious.
            placeholder="Your account name"
            autoComplete="username"
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            // iter-271 a11y: tie inputs to the role="alert" error region
            // so NVDA reads field+error together, not separately.
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'login-error' : undefined}
            className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg px-3.5 py-3 text-base text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] outline-none focus:border-[var(--color-accent-default)] focus:ring-2 focus:ring-[var(--color-accent-default)]/30 transition-all duration-150"
          />
          <p className="text-xs text-[var(--color-text-tertiary)] mt-1.5">
            Created when HomeCam was first set up.
          </p>
        </label>

        <label className="flex flex-col mb-2">
          <span className="text-xs font-medium text-[var(--color-text-secondary)] mb-1.5">
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
              className="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg pl-3.5 pr-11 py-3 text-base text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] outline-none focus:border-[var(--color-accent-default)] focus:ring-2 focus:ring-[var(--color-accent-default)]/30 transition-all duration-150"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              className="absolute inset-y-0 right-0 w-11 flex items-center justify-center text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 rounded-r-lg transition-colors duration-150"
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

        {/* iter-356.1a (Maya Major Button + Loading State):
            - rounded-xl (was rounded-lg) — nests under card's
              rounded-2xl with the canonical 4-px step
            - hover:bg-[var(--color-accent-bright)] (was raw blue-500) —
              token-driven, brightens consistently
            - min-h reserves height so spinner-vs-text doesn't jiggle
              the button width on slow networks
            - duration-150 (was duration-100) matches input focus
              transition (--duration-base)
            */}
        <button
          type="submit"
          disabled={submitting}
          className={
            // iter-356.26: text-white (was swept to text-primary by
            // the dark→light bulk migration). White on calico-orange
            // is the readable pair (~5:1 AA); warm-dark on orange
            // rendered the button invisible.
            `w-full bg-[var(--color-accent-default)] hover:bg-[var(--color-accent-bright)] active:bg-[var(--color-accent-muted)] ` +
            `disabled:opacity-60 disabled:cursor-not-allowed ` +
            `rounded-xl px-4 py-3 min-h-[48px] text-base font-semibold text-white ` +
            `transition-colors duration-150 ` +
            `focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2`
          }
        >
          {submitting ? (
            <span className="flex items-center justify-center gap-2">
              <svg
                className="animate-spin w-4 h-4"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
              >
                <circle
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeOpacity="0.25"
                />
                <path
                  d="M22 12a10 10 0 0 1-10 10"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                />
              </svg>
              Signing in…
            </span>
          ) : (
            'Sign in'
          )}
        </button>
      </form>
    </div>
  )
}
