import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const getOperationsState = vi.fn()
const getDailyBriefing = vi.fn()
const getHealthHistory = vi.fn()
const getRecordingIntegrity = vi.fn()
const setHomeProfile = vi.fn()
const setModeSchedules = vi.fn()
const configureExternalArchive = vi.fn()
const syncExternalArchive = vi.fn()
const configureSemanticCompanion = vi.fn()
const deleteSavedSearch = vi.fn()
const showToast = vi.fn()

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api')
  return {
    ...actual,
    getOperationsState: (...args: unknown[]) => getOperationsState(...args),
    getDailyBriefing: (...args: unknown[]) => getDailyBriefing(...args),
    getHealthHistory: (...args: unknown[]) => getHealthHistory(...args),
    getRecordingIntegrity: (...args: unknown[]) => getRecordingIntegrity(...args),
    setHomeProfile: (...args: unknown[]) => setHomeProfile(...args),
    setModeSchedules: (...args: unknown[]) => setModeSchedules(...args),
    configureExternalArchive: (...args: unknown[]) => configureExternalArchive(...args),
    syncExternalArchive: (...args: unknown[]) => syncExternalArchive(...args),
    configureSemanticCompanion: (...args: unknown[]) => configureSemanticCompanion(...args),
    deleteSavedSearch: (...args: unknown[]) => deleteSavedSearch(...args),
  }
})

vi.mock('../../lib/toast', () => ({ useToast: () => ({ showToast }) }))

import { OperationsSection } from './OperationsSection'

const operations = {
  v: 1 as const,
  active_profile: 'home' as const,
  effective_mode: 'home' as const,
  mode_schedules: [],
  archive: {
    enabled: false,
    available: false,
    target: '/app/external-archive',
    marker_required: '.homecam-external-archive',
    last_sync_ts: null,
    last_status: 'not_configured',
    last_error: null,
    files_verified: 0,
    bytes_verified: 0,
  },
  semantic_companion: {
    enabled: false,
    base_url: '',
    token_set: false,
    last_check_ts: null,
    last_status: 'not_configured',
  },
  saved_searches: [{
    id: 'saved-1', username: 'admin', name: 'Unknown at night',
    query: 'unknown person after 10pm', semantic: false, created_ts: 1,
  }],
  retention: {
    classes: { ordinary: 8, important: 1, incident: 1, permanent: 2 },
    class_bytes: { ordinary: 800, important: 100, incident: 100, permanent: 200 },
    protected_total: 3,
    ordinary_days: 30,
    important_days: 90,
    next_deletions: [{
      event_id: 'event-1', retention_class: 'ordinary' as const,
      bytes: 800, delete_after_ts: 2_000_000_000, overdue: false,
    }],
  },
}

describe('OperationsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getOperationsState.mockResolvedValue(operations)
    getDailyBriefing.mockResolvedValue({
      day: '2026-07-11', total: 3, by_label: { person: 3 }, unknown_people: 1,
      known_people: ['Israel'], headline: '3 events · 1 unknown person sighting',
      recording_state: 'ok', camera_interruptions: 0, protected_events: 3,
      video_counts: { available: 2, processing: 0, failed: 1, unknown: 0 },
      generated_ts: 2_000_000_000,
    })
    getHealthHistory.mockResolvedValue({
      v: 1,
      items: [{
        ts: 2_000_000_000, worker_alive: true, worker_last_seen_s: 1,
        fps: 14, camera_quality_status: 1, camera_luma: 100,
        camera_sharpness: 20, power_watts: 12, disk_free_bytes: 10_000,
        recording_state: 'ok',
      }],
    })
    getRecordingIntegrity.mockResolvedValue({
      v: 1,
      total: 3,
      counts: { recording: 0, finalizing: 0, available: 3, failed: 0, unknown: 0, expired: 0 },
      processing: 0,
      oldest_processing_age_s: null,
      stuck_jobs: 0,
      invalid_videos: 0,
      median_ready_s: 4.2,
      p95_ready_s: 7.5,
      objectives: [],
      recent_failures: [],
      storage: {
        state: 'healthy', recordings_path: '/recordings', filesystem: 'ext4',
        mountpoint: '/srv/homecam-media', device: '/dev/sda1', writable: true,
        read_only: false, smart_status: 'PASSED', write_probe_ms: 2.1,
        free_bytes: 10_000, total_bytes: 20_000, reasons: [], checked_at: 2_000_000_000,
      },
      assurance: { state: 'ok', checked_at: 2_000_000_000 },
      generated_ts: 2_000_000_000,
    })
    setHomeProfile.mockResolvedValue({ active_profile: 'away', effective_mode: 'away', changed_at: 2 })
    setModeSchedules.mockImplementation(async (items) => ({ v: 1, items }))
  })

  it('shows every control-center workflow and applies a household profile', async () => {
    render(<MemoryRouter><OperationsSection /></MemoryRouter>)

    expect(await screen.findByRole('heading', { name: 'Household mode' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Today’s security briefing' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Retention and protected evidence' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Camera health history' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Independent archive' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Optional semantic-search companion' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Unknown at night' })).toHaveAttribute('href', expect.stringContaining('unknown%20person'))

    fireEvent.click(screen.getByRole('button', { name: /^Away\b/ }))
    await waitFor(() => expect(setHomeProfile).toHaveBeenCalledWith('away'))
    expect(showToast).toHaveBeenCalledWith('Away mode active', 'success')
    expect(screen.getByRole('button', { name: /sync and verify now/i })).toBeDisabled()
  })

  it('adds a daily schedule with all seven weekdays', async () => {
    render(<MemoryRouter><OperationsSection /></MemoryRouter>)
    await screen.findByRole('heading', { name: 'Household mode' })
    fireEvent.change(screen.getByLabelText('Scheduled mode'), { target: { value: 'sleep' } })
    fireEvent.change(screen.getByLabelText('Scheduled mode time'), { target: { value: '23:15' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add schedule' }))
    await waitFor(() => expect(setModeSchedules).toHaveBeenCalled())
    expect(setModeSchedules.mock.calls[0][0][0]).toMatchObject({ profile: 'sleep', time: '23:15', days: [0, 1, 2, 3, 4, 5, 6] })
  })
})
