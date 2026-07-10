import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

const loginFn = vi.fn()
let _authState: 'loading' | 'authed' | 'anon' = 'anon'

vi.mock('../lib/auth', () => ({
  useAuth: () => ({
    state: _authState,
    user: null,
    login: (u: string, p: string) => loginFn(u, p),
    logout: vi.fn(),
  }),
}))

// docs/logging_plan.md §5: spy on the client log shim so the
// failed-sign-in tests can assert the username IS logged and the
// password is NOT (GUARDRAIL §4 — never log secrets).
const logWarn = vi.fn()
vi.mock('../lib/log', () => ({
  log: {
    error: vi.fn(),
    warn: (...a: unknown[]) => logWarn(...a),
    info: vi.fn(),
    debug: vi.fn(),
  },
  errFields: (e: unknown) => ({ value: String(e) }),
}))

import { HttpError } from '../lib/api'
import { Login } from './Login'

function renderLogin(initialPath = '/login') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/login" element={<Login />} />
        {/* UI/UX overhaul 2026-07-07: Login lands on "/" (Watch) —
            the retired /live alias is no longer a navigation target. */}
        <Route path="/" element={<div data-testid="home">home page</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('Login page', () => {
  beforeEach(() => {
    loginFn.mockReset()
    logWarn.mockReset()
    _authState = 'anon'
  })
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('renders the form with username + password inputs and a submit button', () => {
    renderLogin()
    expect(
      screen.getByRole('form', { name: /sign in/i }),
    ).toBeInTheDocument()
    expect(screen.getByLabelText(/username/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument()
  })

  it('Given an anonymous user, When Login renders, Then ambient cats sit behind the reachable sign-in form', () => {
    // arrange / act
    renderLogin()

    // assert
    const layer = screen.getByTestId('ambient-cat-layer')
    const root = screen.getByTestId('login-root')
    const form = screen.getByRole('form', { name: /sign in/i })
    expect(layer.className).toMatch(/pointer-events-none/)
    expect(layer.className).toMatch(/z-0/)
    expect(layer.className).toMatch(/absolute/)
    expect(layer.className).not.toMatch(/\bfixed\b/)
    expect(root.contains(layer)).toBe(true)
    expect(root.className).toContain(
      'pb-[calc(var(--login-cat-layer-height)+env(safe-area-inset-bottom,0px))]',
    )
    expect(root.getAttribute('style')).toMatch(/--login-cat-layer-height:\s*\d+px/)
    expect(form.className).toMatch(/z-10/)
    expect(screen.getByLabelText(/username/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument()
  })

  // Fix 7 (accessibility-auditor): the "Created when HomeCam was
  // first set up." helper text sat next to the username field with
  // no aria wiring — a screen-reader user tabbing to the field never
  // heard it.
  it('given no error, when the username field renders, then its helper text is tied via aria-describedby (fix 7)', () => {
    // arrange / act
    renderLogin()
    const usernameInput = screen.getByLabelText(/username/i)

    // assert
    expect(usernameInput).toHaveAttribute('aria-describedby', 'username-hint')
    expect(document.getElementById('username-hint')).toHaveTextContent(
      /created when homecam was first set up/i,
    )
  })

  it('given an already-authed user, when Login renders, then it redirects home to "/" (overhaul 2026-07-07)', () => {
    // arrange
    _authState = 'authed'

    // act
    renderLogin()

    // assert
    expect(screen.getByTestId('home')).toBeInTheDocument()
  })

  it('given valid credentials, when the form is submitted, then login() is called and the app navigates home to "/" (overhaul 2026-07-07)', async () => {
    // arrange
    loginFn.mockResolvedValueOnce(undefined)
    renderLogin()

    // act
    fireEvent.change(screen.getByLabelText(/username/i), {
      target: { value: 'alice' },
    })
    fireEvent.change(screen.getByLabelText(/^password$/i), {
      target: { value: 'hunter2' },
    })
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }))

    // assert
    await waitFor(() => {
      expect(loginFn).toHaveBeenCalledWith('alice', 'hunter2')
    })
    await waitFor(() => {
      expect(screen.getByTestId('home')).toBeInTheDocument()
    })
  })

  it('shows "Invalid username or password" on a 401', async () => {
    loginFn.mockRejectedValueOnce(new HttpError('/api/auth/login', 401, ''))
    renderLogin()
    fireEvent.change(screen.getByLabelText(/username/i), {
      target: { value: 'alice' },
    })
    fireEvent.change(screen.getByLabelText(/^password$/i), {
      target: { value: 'wrong' },
    })
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
    await waitFor(() => {
      // iter-356.1: copy rewrite — 401 path was "Invalid username
      // or password" (engineer voice). Now adds a recovery action:
      // "Wrong username or password — try again."
      expect(screen.getByRole('alert')).toHaveTextContent(
        /wrong username or password/i,
      )
    })
    // Stays on /login — no home redirect.
    expect(screen.queryByTestId('home')).not.toBeInTheDocument()
  })

  it('shows a generic error message on non-401 failures', async () => {
    loginFn.mockRejectedValueOnce(new Error('network down'))
    renderLogin()
    fireEvent.change(screen.getByLabelText(/username/i), {
      target: { value: 'alice' },
    })
    fireEvent.change(screen.getByLabelText(/^password$/i), {
      target: { value: 'hunter2' },
    })
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
    await waitFor(() => {
      // iter-356.1: copy rewrite — non-401 path used to interpolate
      // err.message ("Login failed: network down"). That leaks
      // internal strings. Now: "Could not sign in. Check your
      // connection and try again."
      expect(screen.getByRole('alert')).toHaveTextContent(/could not sign in/i)
    })
  })

  // iter-356.1a (Maya Major): show-password toggle.
  it('given the show-password button is clicked, then the password input type flips text/password (iter-356.1a)', () => {
    // arrange
    renderLogin()
    const passwordInput = screen.getByLabelText(/^password$/i) as HTMLInputElement
    expect(passwordInput.type).toBe('password')

    // act — click the eye toggle.
    fireEvent.click(screen.getByRole('button', { name: /show password/i }))

    // assert — input type flipped, button label flipped.
    expect(passwordInput.type).toBe('text')
    expect(
      screen.getByRole('button', { name: /hide password/i }),
    ).toBeInTheDocument()
  })

  // Fix 8 (mobile-view-auditor): the toggle's tap target had collapsed
  // to the input's line-box (~24px) via `inset-y-0` on a short parent.
  // Pins the parts.tsx Toggle pattern of an explicit ≥44px box.
  it('given the show-password button renders, then its box is at least 44px tall (fix 8)', () => {
    // arrange / act
    renderLogin()
    const toggle = screen.getByRole('button', { name: /show password/i })

    // assert
    expect(toggle.className).toMatch(/\bh-11\b/)
    expect(toggle.className).toMatch(/\bw-11\b/)
  })

  // iter-356.5 a11y Top 2: Caps Lock persistent live-region slot.
  // Pre-iter-356.5 the warning was a conditional <p> — bug 1: NVDA
  // never announced it (no aria-live); bug 2: naive role="alert"
  // would re-fire on every keystroke (React remount). The fix is a
  // PERSISTENT div role="status" aria-live="polite" that's always
  // mounted; only its text content swaps when capsLockOn flips.
  // iter-356.11: KeyboardEvent.getModifierState is a method on the
  // prototype that jsdom returns false for by default; React's
  // synthetic event delegates straight through. The cleanest way to
  // fake CapsLock=true in a test environment is to monkey-patch the
  // prototype around the dispatch (restore in finally).
  function withCapsLockOn(fn: () => void) {
    const orig = KeyboardEvent.prototype.getModifierState
    KeyboardEvent.prototype.getModifierState = function (k: string) {
      if (k === 'CapsLock') return true
      return orig.call(this, k)
    }
    try {
      fn()
    } finally {
      KeyboardEvent.prototype.getModifierState = orig
    }
  }

  // NOTE (Sunroom redesign): the submit button now goes through the
  // Button primitive, which mounts its own sr-only role="status" live
  // region — so these tests scan ALL status slots instead of assuming
  // a single one.
  it('given password keydown WITHOUT CapsLock, then no live-region slot carries the warning (iter-356.5 a11y Top 2)', () => {
    // arrange
    renderLogin()
    const password = screen.getByLabelText(/^password$/i)

    // act — default getModifierState returns false for CapsLock.
    fireEvent.keyDown(password, { key: 'a' })

    // assert — status slots exist (persistent), none carry the warning.
    const slots = screen.getAllByRole('status')
    expect(slots.length).toBeGreaterThan(0)
    for (const slot of slots) {
      expect(slot.textContent ?? '').not.toMatch(/caps lock/i)
    }
  })

  it('given password keydown WITH CapsLock, then the live-region slot announces the warning (iter-356.5 a11y Top 2)', () => {
    // arrange
    renderLogin()
    const password = screen.getByLabelText(/^password$/i)

    // act — monkey-patch the prototype so React's synthetic event
    // proxies through to a true result for CapsLock.
    withCapsLockOn(() => {
      fireEvent.keyDown(password, { key: 'a' })
    })

    // assert — a persistent polite live-region slot carries the warning.
    const slot = screen
      .getAllByRole('status')
      .find((el) => /caps lock is on/i.test(el.textContent ?? ''))
    expect(slot).toBeDefined()
    expect(slot?.getAttribute('aria-live')).toBe('polite')
  })

  it('given the submit button renders, when AT users tab to it, then it is the Panther-ink primary fill with a focus ring that differs from the fill (Sunroom redesign)', () => {
    // arrange — the Sunroom tri-tone discipline: the one primary
    // action is a Panther-ink fill (via the Button primitive); the
    // marmalade focus ring contrasts against the dark ink fill (the
    // pre-redesign bug was accent-ring-on-accent-fill = invisible).
    renderLogin()
    const submit = screen.getByRole('button', { name: /sign in/i })
    const cls = submit.className

    // act / assert — ink fill + white label + a focus-ring token that
    // is NOT the same token as the button bg.
    expect(cls).toMatch(/bg-\[var\(--color-ink\)\]/)
    expect(cls).toMatch(/text-\[var\(--color-on-ink\)\]/)
    expect(cls).toMatch(
      /focus-visible:outline-\[var\(--color-accent-default\)\]/,
    )
    expect(cls).not.toMatch(/focus-visible:outline-\[var\(--color-ink\)\]/)
    // The old raw button flashed the now-LIGHT accent-muted under
    // white text on press — must not come back.
    expect(cls).not.toMatch(/active:bg-\[var\(--color-accent-muted\)\]/)
  })

  // iter-356.1a (Frank #4): error slot reserves height so the submit
  // button doesn't jump up by ~80 px when an error appears mid-tap.
  it('given a wrong-password error renders, then the error slot has min-height so layout stays stable (iter-356.1a)', async () => {
    // arrange
    loginFn.mockRejectedValueOnce(new HttpError('/api/auth/login', 401, ''))
    renderLogin()
    fireEvent.change(screen.getByLabelText(/username/i), {
      target: { value: 'alice' },
    })
    fireEvent.change(screen.getByLabelText(/^password$/i), {
      target: { value: 'wrong' },
    })
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
    await waitFor(() => screen.getByRole('alert'))

    // assert — alert's parent (the slot wrapper) carries min-h.
    const slot = screen.getByRole('alert').parentElement
    expect(slot).not.toBeNull()
    expect(slot?.className).toMatch(/min-h-\[3\.5rem\]/)
  })

  // Playroom Modern (Task 9): the Login hero brand mark switched from
  // a raster CatTrioMark PNG stitch to <BrandMarkRow>, drawn from the
  // shared WhoMark identity system.
  // Landscape pass (Task 3): BrandMarkRow itself swapped from the
  // geometric eared-square glyph back to real cat-face photography
  // (`public/cats/{cat}-face.png`) — pin the raster <img> shape.
  it('given the Login hero renders, then the BrandMarkRow shows all three real cat face photos (Task 9)', () => {
    // arrange / act
    renderLogin()
    const trio = screen.getByRole('img', {
      name: /panther, mushu and coco/i,
    })

    // assert — three raster face photos, one per brand cat.
    const imgs = trio.querySelectorAll('img')
    expect(imgs.length).toBe(3)
    expect(Array.from(imgs).map((i) => i.getAttribute('src'))).toEqual([
      '/cats/panther-face.png',
      '/cats/mushu-face.png',
      '/cats/coco-face.png',
    ])
  })

  // Playroom Modern (Task 9): the three marks stagger in (0/90/180ms)
  // via a scoped <style> block guarded by prefers-reduced-motion:
  // no-preference, reusing the login-fade-in keyframe already defined
  // in index.css. jsdom doesn't compute keyframe timing, so pin the
  // wiring instead: the wrapper class exists and the scoped stylesheet
  // declares per-mark animation-delay rules inside the no-preference
  // media guard (never unconditionally, which would fight the global
  // reduced-motion clamp).
  it('given the Login hero renders, then the brand marks are wrapped for a reduced-motion-guarded staggered entrance (Task 9)', () => {
    // arrange / act
    const { container } = renderLogin()

    // assert
    expect(container.querySelector('.login-brand-stagger')).not.toBeNull()
    const styleText = Array.from(container.querySelectorAll('style'))
      .map((s) => s.textContent ?? '')
      .join('\n')
    expect(styleText).toMatch(/prefers-reduced-motion:\s*no-preference/)
    expect(styleText).toMatch(/animation-delay:\s*0ms/)
    expect(styleText).toMatch(/animation-delay:\s*90ms/)
    expect(styleText).toMatch(/animation-delay:\s*180ms/)
  })

  // docs/logging_plan.md §2/§5 (Auth): failed sign-in logs WARN with
  // the username + status, and CRUCIALLY never the password.
  it('given a failed sign-in, when the 401 surfaces, then it logs WARN with the username and status (logging plan §2)', async () => {
    // arrange
    loginFn.mockRejectedValueOnce(new HttpError('/api/auth/login', 401, ''))
    renderLogin()
    fireEvent.change(screen.getByLabelText(/username/i), {
      target: { value: 'alice' },
    })
    fireEvent.change(screen.getByLabelText(/^password$/i), {
      target: { value: 'hunter2' },
    })

    // act
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }))

    // assert — a single WARN carrying username + status.
    await waitFor(() => {
      expect(logWarn).toHaveBeenCalledWith(
        'login:failed',
        expect.objectContaining({ username: 'alice', status: 401 }),
      )
    })
  })

  it('given a failed sign-in, then the password value NEVER appears in any log field (GUARDRAIL §4)', async () => {
    // arrange
    loginFn.mockRejectedValueOnce(new HttpError('/api/auth/login', 401, ''))
    renderLogin()
    fireEvent.change(screen.getByLabelText(/username/i), {
      target: { value: 'alice' },
    })
    fireEvent.change(screen.getByLabelText(/^password$/i), {
      target: { value: 'hunter2' },
    })

    // act
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
    await waitFor(() => expect(logWarn).toHaveBeenCalled())

    // assert — serialize every captured log call and confirm the
    // password string is absent from all of them.
    const serialized = JSON.stringify(logWarn.mock.calls)
    expect(serialized).not.toContain('hunter2')
  })
})
