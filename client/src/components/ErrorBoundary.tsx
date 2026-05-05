import { Component, type ErrorInfo, type ReactNode } from 'react'
import { ErrorState } from './states/ErrorState'

/**
 * Last-resort React error boundary. Wraps a subtree so an uncaught
 * exception in a render doesn't blank the whole PWA — the user still
 * sees a usable Reload button instead of a white screen.
 *
 * Scope: place around each top-level page (Live / Events / Settings)
 * so a bug in one doesn't take the others down with it. The bottom
 * navigation stays interactive even when a page crashes.
 *
 * React 19 still requires a class component for error boundaries —
 * no hooks API for this yet. Keep the surface small.
 *
 * Premium-launch slice (Mira #1+#2+#3, Dana #1): the previous
 * fallback was hand-rolled with raw Tailwind reds (`bg-red-500/10`,
 * `text-red-400`) that violated CLAUDE.md's "no raw red-XXX" rule
 * and rendered the AA-fail glyph at ~2.6:1 on the calico-cream
 * theme. It also leaked `error.message` directly to the user (the
 * exact thing `<ErrorState>` was built to hide inside a `<details>`)
 * and used ad-hoc <button> elements that diverged from the project's
 * `<Button>` primitive on radius (full vs. xl), height (32 px vs
 * 44 px tap target), and focus-ring tokens.
 *
 * Now: render `<ErrorState>` with the warning palette + technical-
 * detail disclosure pattern. The visual treatment harmonizes with
 * inline error states elsewhere in the app — one error vocabulary,
 * not two.
 */
type Props = {
  children: ReactNode
  /** Optional label for the failing region; shows in the fallback
   * UI as "Something went wrong in {label}." */
  label?: string
}

type State = {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Log to the console so the dev sees a usable trace; the
    // user-facing UI is intentionally minimal because the user
    // can't do anything with stack traces.
    console.error('ErrorBoundary caught', error, info.componentStack)
  }

  reset = () => this.setState({ error: null })

  reload = () => {
    // Hard reload picks up any updated client/dist via the service
    // worker's update flow.
    window.location.reload()
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    const where = this.props.label ? ` in ${this.props.label}` : ''
    // ErrorState's primary-on-the-right convention: `retry` is the
    // hard-fix (Reload app — always works), `secondaryAction` is
    // the cheap recovery (Try again — re-renders the subtree,
    // might re-throw the same error). Hard-fix as primary because
    // a user who's already at the failure screen wants the path
    // most likely to recover, not the cheapest one.
    return (
      <ErrorState
        title={`Something went wrong${where}.`}
        message="The app hit an unexpected error. Try again first; if it doesn't recover, reload the app."
        technicalDetail={error.message || String(error)}
        retry={this.reload}
        retryLabel="Reload app"
        secondaryAction={{ label: 'Try again', onClick: this.reset }}
      />
    )
  }
}
