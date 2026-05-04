import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Button } from '../components/primitives/Button'

type ConfirmOptions = {
  title: string
  body?: string
  confirmLabel?: string
  cancelLabel?: string
  /** Renders the confirm action in red — use for reboots, deletes, etc. */
  destructive?: boolean
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>

const ConfirmContext = createContext<ConfirmFn>(async () => false)

/**
 * Imperative async confirm dialog. Replaces `window.confirm()`:
 *
 *     const confirm = useConfirm()
 *     if (await confirm({ title: 'Reboot?', destructive: true })) ...
 *
 * Renders a focus-trapped modal with proper aria-modal semantics. ESC and
 * the backdrop both dismiss as cancel.
 */
export function useConfirm(): ConfirmFn {
  return useContext(ConfirmContext)
}

type Pending = ConfirmOptions & { resolve: (v: boolean) => void }

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null)

  const confirm = useCallback<ConfirmFn>(
    (opts) =>
      new Promise<boolean>((resolve) => {
        setPending({ ...opts, resolve })
      }),
    [],
  )

  const settle = useCallback(
    (value: boolean) => {
      setPending((cur) => {
        cur?.resolve(value)
        return null
      })
    },
    [],
  )

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <ConfirmDialog
          {...pending}
          onConfirm={() => settle(true)}
          onCancel={() => settle(false)}
        />
      )}
    </ConfirmContext.Provider>
  )
}

function ConfirmDialog({
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm,
  onCancel,
}: ConfirmOptions & {
  onConfirm: () => void
  onCancel: () => void
}) {
  const confirmRef = useRef<HTMLButtonElement | null>(null)
  const cancelRef = useRef<HTMLButtonElement | null>(null)

  // ESC closes; backdrop click also closes (handler on the wrapping
  // <div>, see below). Focus the confirm button on mount so the user
  // can ENTER straight through (with destructive=true the danger color
  // makes the consequences clear).
  //
  // iter-270 (accessibility-auditor A): stash document.activeElement
  // on open and restore on close so focus returns to the button that
  // triggered the dialog. Same pattern shipped this iter in
  // ClipModal.tsx.
  useEffect(() => {
    const previouslyFocused =
      typeof document !== 'undefined'
        ? (document.activeElement as HTMLElement | null)
        : null
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', handler)
    confirmRef.current?.focus()
    return () => {
      window.removeEventListener('keydown', handler)
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus()
      }
    }
  }, [onCancel])

  // iter-356.56 (Dana Critical 3): focus trap. Pre-fix, Tab from the
  // Confirm button advanced into the page DOM behind the modal —
  // chrome doesn't honor `aria-modal="true"` for keyboard
  // virtualization. ClipModal already had this pattern (iter-336);
  // ConfirmDialog was the leftover. Tab cycles between Cancel and
  // Confirm; Shift-Tab from Cancel wraps to Confirm; Tab from
  // Confirm wraps to Cancel. Destructive deletes are the surface
  // most likely to lose a Tab past Cancel and into a focusable
  // background element.
  const onKeyDownTrap = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab') return
    const focusables: (HTMLButtonElement | null)[] = [cancelRef.current, confirmRef.current]
    const list = focusables.filter(Boolean) as HTMLButtonElement[]
    if (list.length < 2) return
    const active = document.activeElement as HTMLElement | null
    const idx = active ? list.indexOf(active as HTMLButtonElement) : -1
    if (e.shiftKey) {
      if (idx <= 0) {
        e.preventDefault()
        list[list.length - 1].focus()
      }
    } else {
      if (idx === list.length - 1) {
        e.preventDefault()
        list[0].focus()
      }
    }
  }

  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      // iter-356.56 (Dana Critical 3): WAI-ARIA dialog focus-trap
      // pattern. Same shape as ClipModal.tsx — onKeyDown on the
      // dialog container is the standard authoring practice; the
      // jsx-a11y rule is stricter than the spec for this case.
      onKeyDown={onKeyDownTrap}
      className="fixed inset-0 z-40 flex items-end sm:items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in"
    >
      {/* iter-270 (accessibility-auditor A top-3): backdrop is a
          DIV with onClick + aria-hidden, NOT a button. Pre-iter-270
          a transparent <button> covered the entire dialog and
          VoiceOver landed on it FIRST, intercepting every swipe
          before the user could reach the title / Cancel / Confirm.
          aria-hidden + non-focusable means screen-readers + keyboard
          users skip the backdrop entirely; mouse + touch users
          still get backdrop-click-to-cancel via onClick. */}
      <div
        onClick={onCancel}
        aria-hidden="true"
        data-testid="confirm-backdrop"
        className="absolute inset-0 w-full h-full cursor-default"
      />
      {/* iter-356.2 (Maya Critical 1+2+3): tokens applied; Cancel
          + Confirm visual weight differentiated; destructive-mode
          warning glyph inline with title.
          - bg-[var(--color-surface-overlay)] + shadow-[var(--shadow-overlay)]
            replace bg-[var(--color-surface)] + shadow-2xl (token foundation).
          - Cancel = ghost variant (no fill); Confirm = destructive
            or primary filled. The eye knows which is the safe
            escape (was 1:1 weight — Fitts'-test failure).
          - Glyph: AlertTriangle inline at h2 size when destructive=true,
            color-coded so colorblind users get a shape signal too. */}
      <div className="relative w-full max-w-sm bg-[var(--color-surface-overlay)] rounded-2xl border border-[var(--color-border)] overflow-hidden shadow-[var(--shadow-overlay)]">
        <div className="p-5 space-y-2">
          <div className="flex items-start gap-2.5">
            {destructive && (
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="flex-shrink-0 mt-0.5 text-[var(--color-danger)]"
                aria-hidden="true"
              >
                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
            )}
            <h2 id="confirm-title" className="text-lg font-semibold text-[var(--color-text-primary)]">
              {title}
            </h2>
          </div>
          {body && (
            <p className="text-sm text-[var(--color-text-secondary)] leading-relaxed pl-0">
              {body}
            </p>
          )}
        </div>
        <div className="flex gap-2 px-5 pb-5 pt-2 border-t border-[var(--color-border-subtle)]">
          <Button
            ref={cancelRef}
            variant="ghost"
            size="md"
            onClick={onCancel}
            fullWidth
          >
            {cancelLabel}
          </Button>
          <Button
            ref={confirmRef}
            variant={destructive ? 'destructive' : 'primary'}
            size="md"
            onClick={onConfirm}
            fullWidth
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}
