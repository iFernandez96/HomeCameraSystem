import { useEffect, useRef } from 'react'
import { Button } from '../components/primitives/Button'
import type { ConfirmOptions } from './confirm'

// iter-356-E (Slice E): the actual ConfirmDialog component lives here so
// the parent `confirm.tsx` can `import()` it on first call rather than
// pulling its ~3 KB gzip into the shell bundle. The shell's confirm
// surface is rarely the first interaction (login + live tile come
// first); deferring keeps the cold-start cheaper.
//
// Behavior is identical to the pre-iter-356-E inline ConfirmDialog —
// focus restore, focus trap, ESC/backdrop dismissal, destructive
// styling. All test pins on these behaviors continue to pass via
// confirm.tsx's Suspense fallback wrapping THIS module.

export type ConfirmDialogProps = ConfirmOptions & {
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
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
      onKeyDown={onKeyDownTrap}
      // redesign/warm-boutique (Sunroom): scrim lightened 70% → 40%.
      // The near-opaque black scrim belonged to the dark theme; on the
      // light linen ground a 40% dim + blur is enough to focus the
      // paper dialog without reading as a blackout.
      className="fixed inset-0 z-40 flex items-end sm:items-center justify-center p-4 bg-black/40 backdrop-blur-sm animate-in fade-in"
    >
      <div
        onClick={onCancel}
        aria-hidden="true"
        data-testid="confirm-backdrop"
        className="absolute inset-0 w-full h-full cursor-default"
      />
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

// Default export so React.lazy() can target this module directly.
export default ConfirmDialog
