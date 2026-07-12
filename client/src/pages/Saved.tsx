import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ActivityNav } from '../components/ActivityNav'
import { CatEmptyState } from '../components/CatEmptyState'
import { getSavedSearches, listIncidents, type IncidentSummary, type SavedSearch } from '../lib/api'

export function Saved() {
  const [incidents, setIncidents] = useState<IncidentSummary[] | null>(null)
  const [searches, setSearches] = useState<SavedSearch[] | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let cancelled = false
    Promise.all([listIncidents(), getSavedSearches()])
      .then(([incidentResult, searchResult]) => {
        if (cancelled) return
        setIncidents(incidentResult.items)
        setSearches(searchResult.items)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => { cancelled = true }
  }, [])
  return (
    <section aria-labelledby="saved-h1" className="mx-auto max-w-4xl space-y-4 p-4">
      <header>
        <h1 id="saved-h1" className="page-title text-3xl text-[var(--color-text-primary)]">Saved</h1>
        <p className="mt-1 text-sm text-[var(--color-text-secondary)]">Incidents, protected evidence, exports and reusable searches.</p>
      </header>
      <ActivityNav />
      {failed ? <p role="alert" className="card-paper p-4 text-sm text-[var(--color-danger)]">Saved items could not be loaded. Check the connection and try again.</p> : null}
      {incidents === null || searches === null ? <p role="status" className="p-4 text-sm">Loading saved items…</p> : incidents.length === 0 && searches.length === 0 ? (
        <CatEmptyState heading="Nothing saved yet" body="Create an incident or save a search to keep important activity close." />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          <Link to="/events/incidents" className="card-paper min-h-28 p-4">
            <span className="block text-lg font-semibold">Incident cases</span>
            <span className="mt-1 block text-sm text-[var(--color-text-secondary)]">{incidents.length} {incidents.length === 1 ? 'case' : 'cases'} with notes and evidence exports</span>
          </Link>
          <Link to="/events/playback" className="card-paper min-h-28 p-4">
            <span className="block text-lg font-semibold">Timeline and exports</span>
            <span className="mt-1 block text-sm text-[var(--color-text-secondary)]">Review continuous footage and build a bounded export</span>
          </Link>
          {searches.map((search) => (
            <Link key={search.id} to={`/events/search?q=${encodeURIComponent(search.query)}${search.semantic ? '&semantic=1' : ''}`} className="card-paper min-h-24 p-4">
              <span className="block font-semibold">{search.name}</span>
              <span className="mt-1 block text-sm text-[var(--color-text-secondary)]">{search.query}</span>
            </Link>
          ))}
        </div>
      )}
    </section>
  )
}
