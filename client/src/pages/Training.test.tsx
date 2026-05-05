import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { FaceCaptureDir, FaceCaptureFile } from '../lib/api'

// iter-352/353/353a (face-capture-for-retraining, Phases 2-3): pin
// the /training page's read-only browse + drill-in flow + per-thumb
// action menu (move/delete). iter-353a applied audit findings: copy
// rewrites, name-picker chips, focus restore.

const listFaceCaptureDirs = vi.fn()
const listFaceCapturesInDir = vi.fn()
const moveFaceCapture = vi.fn()
const deleteFaceCapture = vi.fn()
const navigate = vi.fn()
// iter-356.6X (slice 4) — additional wrappers consumed by the page.
const getDetectionConfig = vi.fn()
const patchDetectionConfig = vi.fn()
const getTrainingExport = vi.fn()
const deleteTrainingCaptures = vi.fn()
const getNameConsent = vi.fn()
const setNameConsent = vi.fn()

vi.mock('../lib/api', () => ({
  listFaceCaptureDirs: (...a: unknown[]) => listFaceCaptureDirs(...a),
  listFaceCapturesInDir: (...a: unknown[]) => listFaceCapturesInDir(...a),
  moveFaceCapture: (...a: unknown[]) => moveFaceCapture(...a),
  deleteFaceCapture: (...a: unknown[]) => deleteFaceCapture(...a),
  getDetectionConfig: (...a: unknown[]) => getDetectionConfig(...a),
  patchDetectionConfig: (...a: unknown[]) => patchDetectionConfig(...a),
  getTrainingExport: (...a: unknown[]) => getTrainingExport(...a),
  deleteTrainingCaptures: (...a: unknown[]) => deleteTrainingCaptures(...a),
  getNameConsent: (...a: unknown[]) => getNameConsent(...a),
  setNameConsent: (...a: unknown[]) => setNameConsent(...a),
}))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>(
    'react-router-dom',
  )
  return { ...actual, useNavigate: () => navigate }
})

import { ConfirmProvider } from '../lib/confirm'
import { ToastProvider } from '../lib/toast'
import { Training } from './Training'

function renderTraining(initialUrl = '/training') {
  return render(
    <MemoryRouter initialEntries={[initialUrl]}>
      <ToastProvider>
        <ConfirmProvider>
          <Training />
        </ConfirmProvider>
      </ToastProvider>
    </MemoryRouter>,
  )
}

const SAMPLE_CONFIG = {
  threshold: 0.55,
  cooldown_s: 5,
  enabled: true,
  schedule_off_start: null,
  schedule_off_end: null,
  classes: ['person'],
  zones: [],
  clip_post_roll_s: 5,
  clip_pre_roll_s: 5,
  clip_retention_preset: 'month' as const,
  camera_label: 'Front Door',
  audio_enabled: false,
  face_capture_enabled: true,
  face_capture_retention_days: 30,
}

const SAMPLE_DIRS: FaceCaptureDir[] = [
  { name: 'alice', count: 12, latest_ts: Date.now() / 1000 - 60 },
  { name: '__unknown__', count: 3, latest_ts: Date.now() / 1000 - 7200 },
]

const SAMPLE_FILES: FaceCaptureFile[] = [
  {
    filename: '1700000060000_evt-002.jpg',
    ts_ms: 1700000060000,
    event_id: 'evt-002',
    url: '/api/face/captures/alice/1700000060000_evt-002.jpg',
  },
  {
    filename: '1700000000000_evt-001.jpg',
    ts_ms: 1700000000000,
    event_id: 'evt-001',
    url: '/api/face/captures/alice/1700000000000_evt-001.jpg',
  },
]

describe('Training page', () => {
  beforeEach(() => {
    listFaceCaptureDirs.mockReset()
    listFaceCapturesInDir.mockReset()
    moveFaceCapture.mockReset()
    deleteFaceCapture.mockReset()
    navigate.mockReset()
    getDetectionConfig.mockReset()
    patchDetectionConfig.mockReset()
    getTrainingExport.mockReset()
    deleteTrainingCaptures.mockReset()
    getNameConsent.mockReset()
    setNameConsent.mockReset()
    // Sensible defaults — the Index view always mounts these via
    // CaptureRetentionSection + ConsentControl. Tests that pin
    // specific behavior override below.
    getDetectionConfig.mockResolvedValue(SAMPLE_CONFIG)
    patchDetectionConfig.mockImplementation(
      async (patch: Partial<typeof SAMPLE_CONFIG>) => ({
        ...SAMPLE_CONFIG,
        ...patch,
      }),
    )
    getNameConsent.mockResolvedValue({
      granted: false,
      recorded_at_ms: null,
      consent_text_version: null,
      recorded_by: null,
    })
  })
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('given listFaceCaptureDirs is in-flight, when the page mounts, then a role=status loading indicator is announced', () => {
    // arrange
    listFaceCaptureDirs.mockReturnValue(new Promise(() => {}))

    // act
    renderTraining()

    // assert
    // iter-356.6X: page now mounts CaptureRetentionSection +
    // ExportSection alongside IndexView; the export Buttons render
    // sr-only role=status spans (Button primitive). Match the
    // dirs-loading status by its visible text.
    const statuses = screen.getAllByRole('status')
    expect(statuses.some((n) => /Loading photos/i.test(n.textContent ?? ''))).toBe(true)
  })

  it('when listFaceCaptureDirs resolves with dirs, then each dir renders with count + most-recent', async () => {
    // arrange
    listFaceCaptureDirs.mockResolvedValue({ dirs: SAMPLE_DIRS })

    // act
    renderTraining()

    // assert
    await waitFor(() => {
      expect(screen.getByText('alice')).toBeInTheDocument()
    })
    expect(screen.getByText('Unknown')).toBeInTheDocument()
    expect(screen.getByText(/12 photos/i)).toBeInTheDocument()
    expect(screen.getByText(/3 photos/i)).toBeInTheDocument()
  })

  it('given listFaceCaptureDirs resolves empty, when the page mounts, then "Nothing to review." is shown', async () => {
    // arrange — iter-353a copy update.
    listFaceCaptureDirs.mockResolvedValue({ dirs: [] })

    // act
    renderTraining()

    // assert
    await waitFor(() => {
      expect(screen.getByText(/Nothing to review/i)).toBeInTheDocument()
    })
  })

  it('given listFaceCaptureDirs rejects, when retried, then the wrapper is called again', async () => {
    // arrange
    listFaceCaptureDirs.mockRejectedValueOnce(new Error('500 boom'))

    // act
    renderTraining()
    await waitFor(() => {
      expect(screen.getByText(/Could not load training photos/i)).toBeInTheDocument()
    })
    listFaceCaptureDirs.mockResolvedValue({ dirs: SAMPLE_DIRS })
    fireEvent.click(screen.getByRole('button', { name: /Retry/i }))

    // assert
    await waitFor(() => {
      expect(screen.getByText('alice')).toBeInTheDocument()
    })
    expect(listFaceCaptureDirs).toHaveBeenCalledTimes(2)
  })

  it('when a dir is clicked, then router navigates to /training?name=<encoded>', async () => {
    // arrange
    listFaceCaptureDirs.mockResolvedValue({ dirs: SAMPLE_DIRS })

    // act
    renderTraining()
    await waitFor(() => screen.getByText('alice'))
    // iter-356.6X: row also contains "Delete all captures of alice"
    // + a per-name "Grant consent" button. Match the open-row
    // button by its full aria-label which includes the photo count.
    fireEvent.click(
      screen.getByRole('button', { name: /alice: 12 photos/i }),
    )

    // assert
    expect(navigate).toHaveBeenCalledWith('/training?name=alice')
  })

  it('given the URL has ?name=alice, when the page renders, then the gallery view loads files for alice', async () => {
    // arrange — iter-353a: gallery view also fetches dirs list
    // (Promise.all) for the chip picker. Mock both.
    listFaceCapturesInDir.mockResolvedValue({ name: 'alice', files: SAMPLE_FILES })
    listFaceCaptureDirs.mockResolvedValue({ dirs: SAMPLE_DIRS })

    // act
    renderTraining('/training?name=alice')

    // assert
    await waitFor(() => {
      expect(listFaceCapturesInDir).toHaveBeenCalledWith('alice')
    })
    const imgs = screen.getAllByRole('img')
    expect(imgs.length).toBe(2)
    expect(imgs[0]).toHaveAttribute(
      'src',
      '/api/face/captures/alice/1700000060000_evt-002.jpg',
    )
  })

  it('given gallery view is active, when Back button clicked, then params clear and the index view loads', async () => {
    // arrange
    listFaceCapturesInDir.mockResolvedValue({ name: 'alice', files: SAMPLE_FILES })
    listFaceCaptureDirs.mockResolvedValue({ dirs: SAMPLE_DIRS })

    // act
    renderTraining('/training?name=alice')
    await waitFor(() => screen.getAllByRole('img'))
    fireEvent.click(screen.getByRole('button', { name: /Back to all people/i }))

    // assert
    await waitFor(() => {
      expect(screen.getByText('alice')).toBeInTheDocument()
    })
  })

  it('given the gallery dir is empty, when fetched, then an empty-state caption renders', async () => {
    // arrange — iter-353a copy: "No photos here yet."
    listFaceCapturesInDir.mockResolvedValue({ name: 'bob', files: [] })
    listFaceCaptureDirs.mockResolvedValue({ dirs: SAMPLE_DIRS })

    // act
    renderTraining('/training?name=bob')

    // assert
    await waitFor(() => {
      expect(screen.getByText(/No photos here yet/i)).toBeInTheDocument()
    })
  })

  it('when gallery fetch fails, then Retry triggers a refetch', async () => {
    // arrange
    listFaceCapturesInDir.mockRejectedValueOnce(new Error('401 unauth'))
    listFaceCaptureDirs.mockResolvedValue({ dirs: SAMPLE_DIRS })

    // act
    renderTraining('/training?name=alice')
    await waitFor(() => {
      expect(screen.getByText(/Could not load these photos/i)).toBeInTheDocument()
    })
    listFaceCapturesInDir.mockResolvedValue({ name: 'alice', files: SAMPLE_FILES })
    fireEvent.click(screen.getByRole('button', { name: /Retry/i }))

    // assert
    await waitFor(() => {
      expect(screen.getAllByRole('img').length).toBe(2)
    })
  })

  it('when the gallery header renders for the active name, then it references the active name', async () => {
    // arrange — iter-353a copy: "Photos the camera saved as <name>".
    listFaceCapturesInDir.mockResolvedValue({ name: 'alice', files: [] })
    listFaceCaptureDirs.mockResolvedValue({ dirs: SAMPLE_DIRS })

    // act
    renderTraining('/training?name=alice')

    // assert
    await waitFor(() => {
      expect(screen.getByText(/Photos the camera saved as "alice"/i)).toBeInTheDocument()
    })
  })

  // iter-353/353a action-menu wire-up tests.

  it('when the Actions button is clicked, then a Move-to chip picker + Delete + Cancel panel opens for that thumbnail', async () => {
    // arrange — iter-353a: SAMPLE_DIRS includes "alice" + "__unknown__".
    // Gallery view fetches dirs on mount. Active name is alice, so the
    // chip picker shows "Unknown" (the only OTHER dir).
    listFaceCapturesInDir.mockResolvedValue({ name: 'alice', files: SAMPLE_FILES })
    listFaceCaptureDirs.mockResolvedValue({ dirs: SAMPLE_DIRS })

    // act
    renderTraining('/training?name=alice')
    await waitFor(() => screen.getAllByRole('img'))
    fireEvent.click(screen.getAllByRole('button', { name: /Move or delete photo/i })[0])

    // assert — Cancel button visible, chip for "Unknown" visible, Delete visible.
    expect(screen.getByRole('button', { name: /^Cancel$/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Unknown$/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^\+ New person$/ })).toBeInTheDocument()
    expect(
      screen.getAllByRole('button', { name: /^Delete$/ })[0],
    ).toBeInTheDocument()
  })

  it('when an existing-name chip is clicked, then moveFaceCapture is called with that target (no typing required)', async () => {
    // arrange — iter-353a: chip-click is the wife-test-friendly path.
    listFaceCapturesInDir.mockResolvedValue({ name: 'alice', files: SAMPLE_FILES })
    listFaceCaptureDirs.mockResolvedValue({ dirs: SAMPLE_DIRS })
    moveFaceCapture.mockResolvedValue({ ok: true, moved_to: '__unknown__/x.jpg' })

    // act
    renderTraining('/training?name=alice')
    await waitFor(() => screen.getAllByRole('img'))
    fireEvent.click(screen.getAllByRole('button', { name: /Move or delete photo/i })[0])
    fireEvent.click(screen.getByRole('button', { name: /^Unknown$/ }))

    // assert — chip click sends the on-disk name (`__unknown__`),
    // NOT the displayed name ("Unknown").
    await waitFor(() => {
      expect(moveFaceCapture).toHaveBeenCalledWith(
        'alice',
        SAMPLE_FILES[0].filename,
        '__unknown__',
      )
    })
    await waitFor(() => {
      expect(screen.getAllByRole('img').length).toBe(1)
    })
  })

  it('when "+ New person" is clicked then a name input + Move button appear, and a typed name calls moveFaceCapture', async () => {
    // arrange — iter-353a: text-input path is the new-person fallback.
    listFaceCapturesInDir.mockResolvedValue({ name: 'alice', files: SAMPLE_FILES })
    listFaceCaptureDirs.mockResolvedValue({ dirs: SAMPLE_DIRS })
    moveFaceCapture.mockResolvedValue({ ok: true, moved_to: 'bob/x.jpg' })

    // act
    renderTraining('/training?name=alice')
    await waitFor(() => screen.getAllByRole('img'))
    fireEvent.click(screen.getAllByRole('button', { name: /Move or delete photo/i })[0])
    fireEvent.click(screen.getByRole('button', { name: /^\+ New person$/ }))
    const input = screen.getByPlaceholderText(/Add a name/i)
    fireEvent.change(input, { target: { value: 'bob' } })
    fireEvent.click(screen.getByRole('button', { name: /^Move$/ }))

    // assert
    await waitFor(() => {
      expect(moveFaceCapture).toHaveBeenCalledWith(
        'alice',
        SAMPLE_FILES[0].filename,
        'bob',
      )
    })
  })

  it('given an invalid typed target name, when Move is clicked, then moveFaceCapture is NOT called and a toast appears', async () => {
    // arrange
    listFaceCapturesInDir.mockResolvedValue({ name: 'alice', files: SAMPLE_FILES })
    listFaceCaptureDirs.mockResolvedValue({ dirs: SAMPLE_DIRS })

    // act
    renderTraining('/training?name=alice')
    await waitFor(() => screen.getAllByRole('img'))
    fireEvent.click(screen.getAllByRole('button', { name: /Move or delete photo/i })[0])
    fireEvent.click(screen.getByRole('button', { name: /^\+ New person$/ }))
    const input = screen.getByPlaceholderText(/Add a name/i)
    fireEvent.change(input, { target: { value: '../etc' } })
    fireEvent.click(screen.getByRole('button', { name: /^Move$/ }))

    // assert
    await waitFor(() => {
      expect(
        screen.getByText(/Name can only contain letters, numbers/i),
      ).toBeInTheDocument()
    })
    expect(moveFaceCapture).not.toHaveBeenCalled()
  })

  it('given Delete is clicked and the confirm dialog is accepted, then deleteFaceCapture is called and the row is removed', async () => {
    // arrange
    listFaceCapturesInDir.mockResolvedValue({ name: 'alice', files: SAMPLE_FILES })
    listFaceCaptureDirs.mockResolvedValue({ dirs: SAMPLE_DIRS })
    deleteFaceCapture.mockResolvedValue({ ok: true })

    // act
    renderTraining('/training?name=alice')
    await waitFor(() => screen.getAllByRole('img'))
    fireEvent.click(screen.getAllByRole('button', { name: /Move or delete photo/i })[0])
    fireEvent.click(screen.getAllByRole('button', { name: /^Delete$/ })[0])
    await screen.findByRole('dialog')
    const deletes = screen.getAllByRole('button', { name: /^Delete$/ })
    fireEvent.click(deletes[deletes.length - 1])

    // assert
    await waitFor(() => {
      expect(deleteFaceCapture).toHaveBeenCalledWith(
        'alice',
        SAMPLE_FILES[0].filename,
      )
    })
    await waitFor(() => {
      expect(screen.getAllByRole('img').length).toBe(1)
    })
  })

  it('given Delete is clicked but the confirm dialog is cancelled, then deleteFaceCapture is NOT called', async () => {
    // arrange
    listFaceCapturesInDir.mockResolvedValue({ name: 'alice', files: SAMPLE_FILES })
    listFaceCaptureDirs.mockResolvedValue({ dirs: SAMPLE_DIRS })

    // act
    renderTraining('/training?name=alice')
    await waitFor(() => screen.getAllByRole('img'))
    fireEvent.click(screen.getAllByRole('button', { name: /Move or delete photo/i })[0])
    fireEvent.click(screen.getAllByRole('button', { name: /^Delete$/ })[0])
    await screen.findByRole('dialog')
    const cancels = screen.getAllByRole('button', { name: /^Cancel$/ })
    fireEvent.click(cancels[cancels.length - 1])

    // assert
    expect(deleteFaceCapture).not.toHaveBeenCalled()
    expect(screen.getAllByRole('img').length).toBe(2)
  })

  it('given a sidecar confidence on a file, when rendered, then a percentage badge appears (iter-355a)', async () => {
    // arrange — file with 73% confidence + predicted_name.
    const filesWithConf = [
      {
        ...SAMPLE_FILES[0],
        predicted_name: 'alice',
        confidence: 0.73,
      },
    ]
    listFaceCapturesInDir.mockResolvedValue({ name: 'alice', files: filesWithConf })
    listFaceCaptureDirs.mockResolvedValue({ dirs: SAMPLE_DIRS })

    // act
    renderTraining('/training?name=alice')
    await waitFor(() => screen.getAllByRole('img'))

    // assert
    expect(screen.getByText('73%')).toBeInTheDocument()
  })

  it('given confidence is null on a file, when rendered, then NO percentage badge appears (legacy capture / bootstrap upload)', async () => {
    // arrange — confidence omitted (legacy capture pre-iter-355a worker
    // OR operator bootstrap upload). UI degrades silently.
    listFaceCapturesInDir.mockResolvedValue({ name: 'alice', files: SAMPLE_FILES })
    listFaceCaptureDirs.mockResolvedValue({ dirs: SAMPLE_DIRS })

    // act
    renderTraining('/training?name=alice')
    await waitFor(() => screen.getAllByRole('img'))

    // assert — no percentage text rendered.
    expect(screen.queryByText(/%$/)).toBeNull()
  })

  it('when the Events deep-link is clicked, then router navigates to /events?person=<predicted_name>', async () => {
    // arrange — predicted_name overrides the dirname so a moved crop
    // links back to its ORIGINAL prediction, not its bucket.
    const filesWithPred = [
      { ...SAMPLE_FILES[0], predicted_name: 'sheenal', confidence: 0.6 },
    ]
    listFaceCapturesInDir.mockResolvedValue({ name: 'alice', files: filesWithPred })
    listFaceCaptureDirs.mockResolvedValue({ dirs: SAMPLE_DIRS })

    // act
    renderTraining('/training?name=alice')
    await waitFor(() => screen.getAllByRole('img'))
    fireEvent.click(screen.getByRole('button', { name: /View events from sheenal/i }))

    // assert
    expect(navigate).toHaveBeenCalledWith('/events?person=sheenal')
  })

  it('when action-panel Cancel is clicked, then the panel closes without firing any action', async () => {
    // arrange
    listFaceCapturesInDir.mockResolvedValue({ name: 'alice', files: SAMPLE_FILES })
    listFaceCaptureDirs.mockResolvedValue({ dirs: SAMPLE_DIRS })

    // act
    renderTraining('/training?name=alice')
    await waitFor(() => screen.getAllByRole('img'))
    fireEvent.click(screen.getAllByRole('button', { name: /Move or delete photo/i })[0])
    const cancels = screen.getAllByRole('button', { name: /^Cancel$/ })
    fireEvent.click(cancels[0])

    // assert — no API call.
    await waitFor(() => {
      expect(screen.queryAllByRole('button', { name: /^Cancel$/ }).length).toBe(0)
    })
    expect(moveFaceCapture).not.toHaveBeenCalled()
    expect(deleteFaceCapture).not.toHaveBeenCalled()
  })

  // iter-356.6X (tiered-inference slice 4) — capture & retention,
  // export, per-name consent, per-name purge.

  it('test_given_face_capture_enabled_in_config_when_page_loads_then_toggle_reflects_state', async () => {
    // arrange
    listFaceCaptureDirs.mockResolvedValue({ dirs: [] })
    getDetectionConfig.mockResolvedValue({
      ...SAMPLE_CONFIG,
      face_capture_enabled: true,
    })

    // act
    renderTraining()

    // assert
    const toggle = await screen.findByRole('switch', {
      name: /Save face captures for retraining/i,
    })
    expect(toggle).toBeChecked()
  })

  it('test_when_user_toggles_off_then_PATCH_sent_with_face_capture_enabled_false', async () => {
    // arrange
    listFaceCaptureDirs.mockResolvedValue({ dirs: [] })
    getDetectionConfig.mockResolvedValue({
      ...SAMPLE_CONFIG,
      face_capture_enabled: true,
    })

    // act
    renderTraining()
    const toggle = await screen.findByRole('switch', {
      name: /Save face captures for retraining/i,
    })
    fireEvent.click(toggle)

    // assert
    await waitFor(() => {
      expect(patchDetectionConfig).toHaveBeenCalledWith({
        face_capture_enabled: false,
      })
    })
  })

  it('test_when_retention_field_changes_then_PATCH_sent_with_new_value', async () => {
    // arrange
    listFaceCaptureDirs.mockResolvedValue({ dirs: [] })
    getDetectionConfig.mockResolvedValue({
      ...SAMPLE_CONFIG,
      face_capture_retention_days: 30,
    })

    // act — change-then-blur is the commit path (mirrors
    // DetectionSection's camera_label pattern; PATCH-on-debounce
    // would churn during typing).
    renderTraining()
    const input = await screen.findByLabelText(/Keep captures for N days/i)
    fireEvent.change(input, { target: { value: '60' } })
    fireEvent.blur(input)

    // assert
    await waitFor(() => {
      expect(patchDetectionConfig).toHaveBeenCalledWith({
        face_capture_retention_days: 60,
      })
    })
  })

  it('test_when_export_face_button_clicked_then_calls_getTrainingExport', async () => {
    // arrange — mock URL.createObjectURL so the download trigger
    // doesn't throw in jsdom.
    listFaceCaptureDirs.mockResolvedValue({ dirs: [] })
    const blob = new Blob(['zip'], { type: 'application/zip' })
    getTrainingExport.mockResolvedValue(blob)
    // jsdom doesn't implement URL.createObjectURL/revokeObjectURL.
    // Define them as no-ops so spyOn has something to wrap.
    const origCreate = (URL as unknown as { createObjectURL?: unknown })
      .createObjectURL
    const origRevoke = (URL as unknown as { revokeObjectURL?: unknown })
      .revokeObjectURL
    ;(URL as unknown as { createObjectURL: () => string }).createObjectURL =
      () => 'blob:fake'
    ;(URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL =
      () => {}
    const createSpy = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:fake')
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    // act
    renderTraining()
    const btn = await screen.findByRole('button', {
      name: /Export face crops/i,
    })
    fireEvent.click(btn)

    // assert
    await waitFor(() => {
      expect(getTrainingExport).toHaveBeenCalledWith('face', 224)
    })
    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledWith(blob)
    })

    createSpy.mockRestore()
    revokeSpy.mockRestore()
    if (origCreate === undefined) {
      delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL
    } else {
      ;(URL as unknown as { createObjectURL: unknown }).createObjectURL =
        origCreate
    }
    if (origRevoke === undefined) {
      delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL
    } else {
      ;(URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL =
        origRevoke
    }
  })

  it('test_given_consent_not_granted_when_render_then_consent_required_badge_shown', async () => {
    // arrange
    listFaceCaptureDirs.mockResolvedValue({ dirs: SAMPLE_DIRS })
    getNameConsent.mockResolvedValue({
      granted: false,
      recorded_at_ms: null,
      consent_text_version: null,
      recorded_by: null,
    })

    // act
    renderTraining()

    // assert — at least one "Consent required" badge per name in the
    // list (SAMPLE_DIRS has 2 names).
    await waitFor(() => {
      expect(screen.getAllByText(/Consent required/i).length).toBeGreaterThan(0)
    })
  })

  it('test_when_user_clicks_grant_consent_then_setNameConsent_called', async () => {
    // arrange
    listFaceCaptureDirs.mockResolvedValue({ dirs: SAMPLE_DIRS })
    getNameConsent.mockResolvedValue({
      granted: false,
      recorded_at_ms: null,
      consent_text_version: null,
      recorded_by: null,
    })
    setNameConsent.mockResolvedValue({
      granted: true,
      recorded_at_ms: 1700000000000,
      consent_text_version: 'v1',
      recorded_by: 'owner',
    })

    // act
    renderTraining()
    const grantBtns = await screen.findAllByRole('button', {
      name: /Grant consent for/i,
    })
    fireEvent.click(grantBtns[0])

    // assert
    await waitFor(() => {
      expect(setNameConsent).toHaveBeenCalledWith('alice', true, 'v1')
    })
  })

  it('test_when_user_clicks_delete_all_for_name_then_confirm_modal_appears', async () => {
    // arrange
    listFaceCaptureDirs.mockResolvedValue({ dirs: SAMPLE_DIRS })

    // act
    renderTraining()
    const deleteBtns = await screen.findAllByRole('button', {
      name: /Delete all captures of alice/i,
    })
    fireEvent.click(deleteBtns[0])

    // assert
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText(/Delete 12 captures of alice/i)).toBeInTheDocument()
  })

  it('test_when_user_confirms_delete_then_deleteTrainingCaptures_called_and_name_removed_from_list', async () => {
    // arrange
    listFaceCaptureDirs.mockResolvedValue({ dirs: SAMPLE_DIRS })
    deleteTrainingCaptures.mockResolvedValue({ ok: true, deleted: 12 })

    // act
    renderTraining()
    const deleteBtns = await screen.findAllByRole('button', {
      name: /Delete all captures of alice/i,
    })
    fireEvent.click(deleteBtns[0])
    await screen.findByRole('dialog')
    // Click the dialog's confirm "Delete" — last "Delete" button on
    // the page (the row buttons are "Delete all captures of …").
    const deletes = screen.getAllByRole('button', { name: /^Delete$/ })
    fireEvent.click(deletes[deletes.length - 1])

    // assert
    await waitFor(() => {
      expect(deleteTrainingCaptures).toHaveBeenCalledWith('alice')
    })
    await waitFor(() => {
      expect(
        screen.queryByRole('button', {
          name: /Delete all captures of alice/i,
        }),
      ).toBeNull()
    })
  })

  it('given the Training page renders, when AT users query for the page heading, then a level-1 sr-only heading is present (iter-356.63: Slice D a11y — sr-only h1 per route)', async () => {
    // arrange
    listFaceCaptureDirs.mockResolvedValue({ dirs: SAMPLE_DIRS })

    // act
    renderTraining()

    // assert
    expect(
      await screen.findByRole('heading', { level: 1, name: /teach mushu/i }),
    ).toBeInTheDocument()
  })

  it('test_when_user_cancels_delete_then_no_api_call', async () => {
    // arrange
    listFaceCaptureDirs.mockResolvedValue({ dirs: SAMPLE_DIRS })

    // act
    renderTraining()
    const deleteBtns = await screen.findAllByRole('button', {
      name: /Delete all captures of alice/i,
    })
    fireEvent.click(deleteBtns[0])
    await screen.findByRole('dialog')
    const cancels = screen.getAllByRole('button', { name: /^Cancel$/ })
    fireEvent.click(cancels[cancels.length - 1])

    // assert
    expect(deleteTrainingCaptures).not.toHaveBeenCalled()
  })
})
