import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'

export type ToastKind = 'info' | 'success' | 'error'

type Toast = {
  id: number
  message: string
  kind: ToastKind
}

type ToastApi = {
  showToast: (message: string, kind?: ToastKind) => void
}

const ToastContext = createContext<ToastApi>({ showToast: () => {} })

export function useToast(): ToastApi {
  return useContext(ToastContext)
}

// iter-356.3a (Maya Minor): bumped per-kind timeouts. Was 2.5s/2.5s/5s
// — Sonner default is 4s and Maya called the 2.5s "info" too brisk for
// a non-technical homeowner who looked away. Error stays at 5s; bumped
// info + success to 3.5s (still sub-Sonner; we want toasts out of the
// way fast on a glanceable surface).
const TIMEOUT_MS: Record<ToastKind, number> = {
  info: 3500,
  success: 3500,
  error: 5000,
}

// Premium-launch slice (Frank D2): the longest toast in the app is the
// notifications-setup info — 21 words at ~120 characters. The fixed
// 3.5s timeout vanishes the message before a typical reading pace
// (200 wpm) gets through it. Floor each toast's display time at
// roughly 60 ms per character, capped at 9 s so a runaway error
// payload doesn't park forever. The cap keeps the sub-Sonner feel
// for short toasts while letting long sentences breathe.
const PER_CHAR_MS = 60
const MAX_TIMEOUT_MS = 9_000

function timeoutFor(kind: ToastKind, message: string): number {
  const proportional = Math.min(message.length * PER_CHAR_MS, MAX_TIMEOUT_MS)
  return Math.max(TIMEOUT_MS[kind], proportional)
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const idRef = useRef(0)
  // iter-356.3a (Maya Nit + iter-355c1 polish): track timers so the
  // provider can clear them on unmount (was leaking) AND so toasts
  // can be dismissed-on-click by ID without leaving a stale timer.
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map())

  const dismiss = useCallback((id: number) => {
    const handle = timersRef.current.get(id)
    if (handle) {
      clearTimeout(handle)
      timersRef.current.delete(id)
    }
    setToasts((cur) => cur.filter((t) => t.id !== id))
  }, [])

  const showToast = useCallback(
    (message: string, kind: ToastKind = 'info') => {
      const id = ++idRef.current
      setToasts((cur) => [...cur, { id, message, kind }])
      const handle = setTimeout(() => {
        timersRef.current.delete(id)
        setToasts((cur) => cur.filter((t) => t.id !== id))
      }, timeoutFor(kind, message))
      timersRef.current.set(id, handle)
    },
    [],
  )

  // iter-356.3a (Maya Nit): clear all pending timers on unmount so
  // a provider-level remount during HMR / route swap doesn't leak
  // setTimeouts that fire against unmounted state.
  useEffect(() => {
    const timers = timersRef.current
    return () => {
      for (const handle of timers.values()) {
        clearTimeout(handle)
      }
      timers.clear()
    }
  }, [])

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div
        // Sits above the bottom nav. Pointer-events:none lets clicks pass
        // through except on the toast bubbles themselves.
        // iter-356.3a (Maya Minor): z-30 → z-[--z-sheet] token.
        // bottom-24 → bottom-[5.5rem] preserved as a magic number for now;
        // bottom-nav-height token would require touching BottomNav too.
        className="fixed bottom-24 lg:bottom-6 inset-x-0 lg:left-16 z-[20] flex flex-col items-center gap-2 px-4 pointer-events-none"
        style={{ zIndex: 'var(--z-sheet, 30)' }}
        aria-live="polite"
        aria-atomic="true"
      >
        {toasts.map((t) => (
          <ToastBubble key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

// iter-356.3a (Maya Critical 1+2): split out per-toast presentation so
// each bubble can carry its own enter animation + leading icon + click-
// to-dismiss handler. Pre-iter-356.3a everything was inline + the toasts
// were 3 raw hex colors with zero motion (Maya: "single render frame in
// a hard rectangle").
function ToastBubble({
  toast,
  onDismiss,
}: {
  toast: Toast
  onDismiss: () => void
}) {
  // Token-driven kind classes. Was bg-red-600/95, bg-emerald-600/95,
  // bg-[var(--color-surface-raised)]/95 — Maya: "bypass the iter-356.0 token system
  // entirely." Now: --color-success / --color-danger / surface-overlay
  // for info, with a SHAPE signal via leading icon (colorblind safety).
  // iter-356.26 fix: toast bg uses semantic FILL colors (red, emerald);
  // text MUST be white to read on those fills, not text-primary which
  // got swept in from text-white during the bulk dark→light migration.
  // White on red ~5:1, white on emerald ~4.7:1, both AA. Surface-overlay
  // (info) keeps text-primary because it's white-bg + warm-dark text.
  const kindClass =
    toast.kind === 'error'
      ? 'bg-[var(--color-danger)] text-white'
      : toast.kind === 'success'
        ? 'bg-[var(--color-success)] text-white'
        : 'bg-[var(--color-surface-overlay)] text-[var(--color-text-primary)] border border-[var(--color-border)]'

  return (
    <button
      type="button"
      onClick={onDismiss}
      role={toast.kind === 'error' ? 'alert' : 'status'}
      aria-label={`${toast.message}. Tap to dismiss.`}
      className={
        `pointer-events-auto max-w-md inline-flex items-center gap-2 ` +
        `px-4 py-2.5 min-h-[40px] rounded-full text-sm font-medium ` +
        `shadow-[var(--shadow-overlay)] backdrop-blur ` +
        `animate-toast-in ` +
        `focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 ` +
        `transition-transform duration-150 active:scale-[0.98] ` +
        kindClass
      }
    >
      <ToastIcon kind={toast.kind} />
      <span>{toast.message}</span>
    </button>
  )
}

function ToastIcon({ kind }: { kind: ToastKind }) {
  // 16 px outline icons — leading shape signal so colorblind users
  // distinguish kinds before reading. Maya Critical 1.
  if (kind === 'success') {
    return (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="flex-shrink-0"
        aria-hidden="true"
      >
        <polyline points="20 6 9 17 4 12" />
      </svg>
    )
  }
  if (kind === 'error') {
    return (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="flex-shrink-0"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
    )
  }
  // info
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="flex-shrink-0"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  )
}
