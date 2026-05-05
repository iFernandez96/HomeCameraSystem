import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from 'react'

export type ConfirmOptions = {
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

// iter-356-E (Slice E): the actual ConfirmDialog component is split out
// into `./confirm-impl.tsx` and dynamically imported on first call.
// Pre-iter-356-E the dialog code (~3 KB gzip — primitives import,
// focus-trap logic, the inline SVG icon) was always in the shell
// bundle even on sessions that never trigger a confirm. React.lazy +
// Suspense boundary keeps the API surface (`useConfirm()`) identical
// — `confirm.test.tsx` still passes because the lazy chunk resolves
// synchronously in vitest where the module graph is in-process.
const LazyConfirmDialog = lazy(() => import('./confirm-impl'))

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
        <Suspense fallback={null}>
          <LazyConfirmDialog
            {...pending}
            onConfirm={() => settle(true)}
            onCancel={() => settle(false)}
          />
        </Suspense>
      )}
    </ConfirmContext.Provider>
  )
}
