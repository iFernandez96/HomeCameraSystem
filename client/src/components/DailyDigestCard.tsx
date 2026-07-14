import { useEffect, useState } from 'react'
import { getDailyDigest, type DailyDigest } from '../lib/api'
import { log, errFields } from '../lib/log'

export function DailyDigestCard({ day }: { day: string }) {
  const [result, setResult] = useState<{
    day: string
    digest: DailyDigest | null
    failed: boolean
  }>({ day, digest: null, failed: false })

  useEffect(() => {
    let cancelled = false
    getDailyDigest(day)
      .then((value) => {
        if (!cancelled) setResult({ day, digest: value, failed: false })
      })
      .catch((error) => {
        log.warn('dailyDigest:load-failed', { day, ...errFields(error) })
        if (!cancelled) setResult({ day, digest: null, failed: true })
      })
    return () => {
      cancelled = true
    }
  }, [day])

  const digest = result.day === day ? result.digest : null
  const failed = result.day === day && result.failed
  if (failed) return null
  const labels = digest
    ? Object.entries(digest.by_label)
        .map(([label, count]) => `${count} ${label}`)
        .join(' · ')
    : 'Building summary…'
  const known = digest?.known_people.length
    ? `Recognized: ${digest.known_people.join(', ')}`
    : 'No familiar faces recognized'

  return (
    <section
      aria-label={`Activity summary for ${day}`}
      className="mx-4 mt-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 shadow-[var(--shadow-subtle)]"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-display text-base font-semibold text-[var(--color-text-primary)]">
          Daily digest
        </h2>
        <span className="text-xs tabular-nums text-[var(--color-text-secondary)]">
          {digest ? `${digest.total} total` : 'Loading'}
        </span>
      </div>
      <p className="mt-1 text-sm text-[var(--color-text-primary)]">{labels}</p>
      {digest ? (
        <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
          {known} · {digest.unknown_people} unrecognized person {digest.unknown_people === 1 ? 'visit' : 'visits'}
        </p>
      ) : null}
    </section>
  )
}
