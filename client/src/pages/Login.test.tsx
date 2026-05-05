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

import { HttpError } from '../lib/api'
import { Login } from './Login'

function renderLogin(initialPath = '/login') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/live" element={<div data-testid="live">live page</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('Login page', () => {
  beforeEach(() => {
    loginFn.mockReset()
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

  it('redirects to /live if user is already authed', () => {
    _authState = 'authed'
    renderLogin()
    expect(screen.getByTestId('live')).toBeInTheDocument()
  })

  it('calls login() and navigates to /live on success', async () => {
    loginFn.mockResolvedValueOnce(undefined)
    renderLogin()
    fireEvent.change(screen.getByLabelText(/username/i), {
      target: { value: 'alice' },
    })
    fireEvent.change(screen.getByLabelText(/^password$/i), {
      target: { value: 'hunter2' },
    })
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
    await waitFor(() => {
      expect(loginFn).toHaveBeenCalledWith('alice', 'hunter2')
    })
    await waitFor(() => {
      expect(screen.getByTestId('live')).toBeInTheDocument()
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
    // Stays on /login — no /live redirect.
    expect(screen.queryByTestId('live')).not.toBeInTheDocument()
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

  it('given password keydown WITHOUT CapsLock, then the live-region slot stays empty (iter-356.5 a11y Top 2)', () => {
    // arrange
    renderLogin()
    const password = screen.getByLabelText(/^password$/i)

    // act — default getModifierState returns false for CapsLock.
    fireEvent.keyDown(password, { key: 'a' })

    // assert — the role=status slot exists (persistent), no warning text.
    const slot = screen.getByRole('status')
    expect(slot.textContent ?? '').not.toMatch(/caps lock/i)
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

    // assert — the SAME slot now contains the warning text.
    const slot = screen.getByRole('status')
    expect(slot.textContent ?? '').toMatch(/caps lock is on/i)
    expect(slot.getAttribute('aria-live')).toBe('polite')
  })

  it('given the submit button renders, when AT users tab to it, then the focus-visible outline color differs from the button background (iter-356.63: Slice D a11y — invisible focus ring fix)', () => {
    // arrange — pre-fix the button had bg-accent-default AND
    // focus-visible:outline-accent-default, so the keyboard-focus
    // ring rendered as the same orange as the fill (zero contrast).
    renderLogin()
    const submit = screen.getByRole('button', { name: /sign in/i })
    const cls = submit.className

    // act / assert — focus-ring color must NOT be the same token as
    // the button bg. The bg uses accent-default; the ring now uses
    // text-primary.
    expect(cls).toMatch(/bg-\[var\(--color-accent-default\)\]/)
    expect(cls).toMatch(/focus-visible:outline-\[var\(--color-text-primary\)\]/)
    expect(cls).not.toMatch(
      /focus-visible:outline-\[var\(--color-accent-default\)\]/,
    )
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

  // iter-356-E (Slice E): Login hero trio mark sits above-the-fold —
  // first paint depends on the three face PNGs. Pre-iter-356-E they
  // were `loading="lazy"`, which on slow connections deferred them
  // BELOW critical resources. Eager + fetchpriority="high" tells the
  // browser to prioritize them in the network queue.
  it('given the Login hero renders, then the trio mark imgs are eager + high priority (iter-356-E)', () => {
    // arrange / act
    renderLogin()
    const trio = screen.getByRole('img', { name: /three cats/i })
    const imgs = trio.querySelectorAll('img')

    // assert — three cells (panther / mushu / coco), each eager and
    // carrying the fetchpriority hint.
    expect(imgs.length).toBe(3)
    for (const img of imgs) {
      expect(img.getAttribute('loading')).toBe('eager')
      expect(img.getAttribute('fetchpriority')).toBe('high')
    }
  })
})
