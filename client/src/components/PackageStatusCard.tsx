import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getCurrentPackages, type PackageStatus } from '../lib/api'
import { relativeTime } from '../lib/eventLabel'
import { useTicker } from '../lib/useTicker'

const STATE_COPY: Record<PackageStatus['state'], string> = {
  delivered: 'Package delivered',
  present: 'Package is still outside',
  collected: 'Package collected',
  possible_theft: 'Package may have been taken',
}

export function PackageStatusCard() {
  const [items, setItems] = useState<PackageStatus[] | null>(null)
  const navigate = useNavigate()
  const now = useTicker()

  useEffect(() => {
    let cancelled = false
    const refresh = () => {
      getCurrentPackages()
        .then((result) => {
          if (!cancelled) setItems(result.items)
        })
        .catch(() => {
          if (!cancelled) setItems([])
        })
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    refresh()
    const timer = window.setInterval(refresh, 60_000)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  const current = items?.find((item) => item.state !== 'collected') ?? null
  if (!current) return null
  const urgent = current.state === 'possible_theft'
  const content = (
    <>
      {current.thumb_url ? (
        <img
          src={current.thumb_url}
          alt=""
          className="h-14 w-14 flex-none rounded-xl object-cover"
        />
      ) : (
        <span
          aria-hidden="true"
          className="flex h-14 w-14 flex-none items-center justify-center rounded-xl bg-[var(--color-brass-subtle)] text-xl"
        >
          □
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block font-semibold text-[var(--color-text-primary)]">
          {STATE_COPY[current.state]}
        </span>
        <span className="block text-xs text-[var(--color-text-secondary)]">
          Updated {relativeTime(current.updated_ts, now)}
        </span>
      </span>
      {current.event_id ? <span aria-hidden="true">›</span> : null}
    </>
  )

  const classes = `mx-4 mt-3 flex items-center gap-3 rounded-[var(--radius-xl)] border-[1.5px] px-3 py-2.5 text-left md:mx-auto md:w-full md:max-w-[40rem] lg:mx-0 ${
    urgent
      ? 'border-[var(--color-danger-border)] bg-[var(--color-danger-bg)]'
      : 'border-[var(--color-border)] bg-[var(--color-surface)]'
  }`

  return current.event_id ? (
    <button
      type="button"
      className={`${classes} min-h-11 focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2`}
      onClick={() => navigate(`/events?event=${encodeURIComponent(current.event_id ?? '')}`)}
      aria-label={`${STATE_COPY[current.state]}. Open package event.`}
    >
      {content}
    </button>
  ) : (
    <section className={classes} aria-label={STATE_COPY[current.state]}>
      {content}
    </section>
  )
}
