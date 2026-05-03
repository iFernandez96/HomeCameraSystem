import { Component, type ErrorInfo, type ReactNode } from 'react'

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
    return (
      <div
        role="alert"
        aria-live="assertive"
        className="px-4 py-12 text-center space-y-4"
      >
        <div className="mx-auto w-12 h-12 rounded-full bg-red-500/10 border border-red-500/30 flex items-center justify-center text-red-400 text-xl">
          !
        </div>
        <p className="text-[var(--color-text-primary)] font-medium">
          Something went wrong{where}.
        </p>
        <p className="text-xs text-[var(--color-text-tertiary)] break-words max-w-md mx-auto">
          {error.message || String(error)}
        </p>
        <div className="flex justify-center gap-3 pt-2">
          <button
            type="button"
            onClick={this.reset}
            className="px-4 py-2 bg-[var(--color-surface-raised)] hover:bg-[var(--color-border-strong)] active:bg-[var(--color-border-strong)] rounded-full text-sm font-medium border border-[var(--color-border-strong)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={this.reload}
            className="px-4 py-2 bg-[var(--color-accent-default)] hover:bg-[var(--color-accent-bright)] text-white rounded-full text-sm font-medium focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2"
          >
            Reload app
          </button>
        </div>
      </div>
    )
  }
}
