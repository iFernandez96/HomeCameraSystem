import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ClipModal } from '../components/ClipModal'
import { EventRow } from '../components/EventRow'
import { Button } from '../components/primitives/Button'
import { CatEmptyState } from '../components/CatEmptyState'
import {
  createSavedSearch,
  getSavedSearches,
  searchSecurityEvents,
  semanticSearch,
  type SavedSearch,
  type SecuritySearchResponse,
} from '../lib/api'
import type { DetectionEvent } from '../lib/types'
import { useToast } from '../lib/toast'

export function EventSearch() {
  const [searchParams] = useSearchParams()
  const [query, setQuery] = useState(() => searchParams.get('q') ?? '')
  const [useSemantic, setUseSemantic] = useState(() => searchParams.get('semantic') === '1')
  const [result, setResult] = useState<SecuritySearchResponse | null>(null)
  const [saved, setSaved] = useState<SavedSearch[]>([])
  const [saveName, setSaveName] = useState('')
  const [selected, setSelected] = useState<DetectionEvent | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { showToast } = useToast()

  useEffect(() => {
    let cancelled = false
    getSavedSearches()
      .then((value) => {
        if (!cancelled) setSaved(value.items)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const submit = async () => {
    const normalized = query.trim()
    if (!normalized || busy) return
    setBusy(true)
    setError(null)
    try {
      if (useSemantic) {
        const companion = await semanticSearch(normalized)
        setResult({
          v: 1,
          query: normalized,
          items: companion.items.map((event) => ({
            event,
            description: event.person_name ?? event.rule_name ?? event.label,
            match_reason: 'Visual similarity from your private companion',
            score: 1,
          })),
          index_status: {
            mode: 'private companion',
            status: 'ready',
            indexed_events: companion.items.length,
          },
        })
      } else {
        setResult(await searchSecurityEvents(normalized))
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Search failed')
    } finally {
      setBusy(false)
    }
  }

  const saveCurrent = async () => {
    const name = saveName.trim()
    const normalized = query.trim()
    if (!name || !normalized) return
    try {
      const item = await createSavedSearch(name, normalized, useSemantic)
      setSaved((current) => [...current, item])
      setSaveName('')
      showToast('Search saved', 'success')
    } catch {
      showToast('Could not save this search', 'error')
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="page-title text-2xl text-[var(--color-text-primary)]">Search events</h1>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">Search local event metadata, people, cameras, rules, and event types.</p>
        </div>
        <Link to="/events" className="inline-flex min-h-11 shrink-0 items-center rounded-full px-3 text-sm font-semibold text-[var(--color-accent-deep)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)]">
          Back
        </Link>
      </header>

      <form
        role="search"
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <label className="min-w-0 flex-1">
          <span className="sr-only">Search event descriptions</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Alice at the front door"
            autoComplete="off"
            className="min-h-12 w-full rounded-full border-[1.5px] border-[var(--color-border)] bg-[var(--color-surface)] px-4 text-base text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2"
          />
        </label>
        <Button type="submit" loading={busy} loadingText="Searching…" disabled={!query.trim()}>
          Search
        </Button>
      </form>

      <label className="flex min-h-11 items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm">
        <input type="checkbox" checked={useSemantic} onChange={(event) => setUseSemantic(event.target.checked)} className="h-5 w-5" />
        Use the private semantic-search companion
      </label>

      {saved.length ? (
        <section aria-labelledby="saved-searches-h2" className="space-y-2">
          <h2 id="saved-searches-h2" className="text-sm font-semibold">Saved collections</h2>
          <div className="flex flex-wrap gap-2">
            {saved.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setQuery(item.query)
                  setUseSemantic(item.semantic)
                }}
                className="min-h-11 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm font-semibold"
              >
                {item.name}
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {error ? <p role="alert" className="rounded-xl border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] p-3 text-sm">{error}</p> : null}

      {result ? (
        <section aria-labelledby="search-results-h2" className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="search-results-h2" className="text-lg font-semibold">Results</h2>
            <span className="text-xs text-[var(--color-text-secondary)]">
              {result.index_status.mode} · {result.index_status.status} · {result.index_status.indexed_events} indexed
            </span>
          </div>
          <div className="flex flex-col gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 sm:flex-row">
            <label className="min-w-0 flex-1 text-sm font-medium">Save this collection
              <input value={saveName} onChange={(event) => setSaveName(event.target.value)} placeholder="Unknown people after 10 PM" className="mt-1 min-h-11 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 text-base" />
            </label>
            <Button variant="secondary" disabled={!saveName.trim()} onClick={() => void saveCurrent()}>Save search</Button>
          </div>
          {result.items.length === 0 ? (
            <CatEmptyState
              mood="curious"
              heading="No matching events"
              body="Try a person, camera, event label, or rule, such as package delivered, glass break, porch line, or tamper."
            />
          ) : (
            <ol className="space-y-3">
              {result.items.map((item) => (
                <li key={item.event.id} className="card-paper space-y-2 p-2">
                  <EventRow event={item.event} subline={item.description} onOpen={() => setSelected(item.event)} />
                  <p className="px-3 pb-1 text-xs text-[var(--color-text-secondary)]">
                    Why it matched: {item.match_reason} · {Math.round(item.score * 100)}%
                  </p>
                </li>
              ))}
            </ol>
          )}
        </section>
      ) : (
        <CatEmptyState
          mood="curious"
          heading="Ask about your history"
          body="Try Alice, front door, package delivered, glass break, porch line, or tamper. Search stays local to HomeCam."
        />
      )}

      {selected ? <ClipModal event={selected} onClose={() => setSelected(null)} /> : null}
    </div>
  )
}
