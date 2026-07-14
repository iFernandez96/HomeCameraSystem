import { powerDisplay } from '../lib/power'

export function LiveGlanceStrip({
  unhealthy,
  stateLabel,
  watchingDetail,
  sentryName,
  detectionActive,
  canManageDetection,
  detectionToggleBusy,
  onToggleDetection,
  power,
}: {
  unhealthy: boolean
  stateLabel: string
  watchingDetail: string
  sentryName: string
  detectionActive: boolean | null
  canManageDetection: boolean
  detectionToggleBusy: boolean
  onToggleDetection: () => void
  power: ReturnType<typeof powerDisplay>
}) {
  const watchState = (
    <div className="flex min-w-0 items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-extrabold leading-tight landscape-phone:text-xs tablet-landscape:text-sm">{stateLabel.replace(/…/g, '')}</p>
        <p className="text-xs font-medium leading-tight text-white/78">{detectionToggleBusy ? 'Updating watch status' : watchingDetail}</p>
      </div>
      <div className="flex flex-none items-center gap-1.5">
        <span aria-label={power.detail} title={power.detail} className={`whitespace-nowrap rounded-full border px-2 py-1 text-[10px] font-bold tabular-nums ${power.state === 'live' ? 'border-white/25 bg-white/8 text-white/85' : power.state === 'error' || power.state === 'stale' ? 'border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] text-[var(--color-warning)]' : 'border-white/18 bg-white/5 text-white/60'}`}>{power.compact}</span>
        {canManageDetection && detectionActive != null ? (
          <span aria-hidden="true" className="inline-flex flex-none items-center gap-1 rounded-full border border-white/35 bg-white/10 px-2 py-1 text-[11px] font-bold text-white shadow-sm transition-colors group-hover:bg-white/16 group-active:bg-white/22">
            {detectionToggleBusy ? <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/35 border-t-white" /> : detectionActive ? (
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="3" width="3.5" height="10" rx="1" /><rect x="9.5" y="3" width="3.5" height="10" rx="1" /></svg>
            ) : <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.8v10.4L13 8 4 2.8Z" /></svg>}
            {detectionToggleBusy ? 'Saving' : detectionActive ? 'Pause' : 'Resume'}
          </span>
        ) : null}
      </div>
    </div>
  )
  return (
    <div data-testid="live-glance-strip" className="shrink-0 border-t border-white/10 bg-black/88 px-3 py-2 text-white backdrop-blur-md landscape-phone:px-2.5 landscape-phone:py-1.5 tablet-landscape:px-3 tablet-landscape:py-2 lg:px-4">
      <div className="flex items-center">
        {canManageDetection && detectionActive != null ? (
          <button type="button" disabled={detectionToggleBusy} onClick={onToggleDetection} aria-label={detectionActive ? `Pause detection and classification — ${sentryName} is on watch` : `Resume detection and classification — bring ${sentryName} back on watch`} className={`group min-h-11 w-full min-w-0 cursor-pointer rounded-xl border px-3 py-2 text-left shadow-sm transition-colors hover:bg-white/8 active:bg-white/12 focus-visible:outline-2 focus-visible:outline-[var(--color-accent-bright)] focus-visible:outline-offset-2 disabled:cursor-wait disabled:opacity-70 ${unhealthy ? 'border-[var(--color-danger)] bg-white/5 text-[var(--color-danger)]' : 'border-white/18 bg-white/5 text-white'}`}>{watchState}</button>
        ) : (
          <div className={`min-h-11 w-full min-w-0 rounded-xl border px-3 py-2 ${unhealthy ? 'border-[var(--color-danger)] text-[var(--color-danger)]' : 'border-white/18 bg-white/5 text-white'}`}>{watchState}</div>
        )}
      </div>
    </div>
  )
}
