import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ReviewQueueItem } from '../lib/api'

// Sunroom redesign (2026-07-01): light BDD-lite smoke coverage for the
// review queue — tri-state render (loading / empty / items) plus the
// warning-toned confidence badge introduced in the warm-boutique pass.

const getReviewQueue = vi.fn()
const moveFaceCapture = vi.fn()
const deleteFaceCapture = vi.fn()

vi.mock('../lib/api', () => ({
  getReviewQueue: (...a: unknown[]) => getReviewQueue(...a),
  moveFaceCapture: (...a: unknown[]) => moveFaceCapture(...a),
  deleteFaceCapture: (...a: unknown[]) => deleteFaceCapture(...a),
}))

import { ConfirmProvider } from '../lib/confirm'
import { ToastProvider } from '../lib/toast'
import { Review } from './Review'

function renderReview() {
  return render(
    <MemoryRouter initialEntries={['/training/review']}>
      <ToastProvider>
        <ConfirmProvider>
          <Review />
        </ConfirmProvider>
      </ToastProvider>
    </MemoryRouter>,
  )
}

const SAMPLE_ITEM: ReviewQueueItem = {
  filename: '1700000000000_evt-001.jpg',
  current_dir: '__unknown__',
  predicted_name: 'Alice',
  confidence: 0.62,
  ts_ms: 1700000000000,
  event_id: 'evt-001',
  url: '/api/face/captures/__unknown__/1700000000000_evt-001.jpg',
}

describe('Review page', () => {
  beforeEach(() => {
    getReviewQueue.mockReset()
    moveFaceCapture.mockReset()
    deleteFaceCapture.mockReset()
  })
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('given the queue fetch is in-flight, when the page mounts, then the loading subhead renders', () => {
    // arrange
    getReviewQueue.mockReturnValue(new Promise(() => {}))

    // act
    renderReview()

    // assert
    expect(
      screen.getByRole('heading', { level: 1, name: /review queue/i }),
    ).toBeInTheDocument()
    expect(screen.getByText(/loading the review queue/i)).toBeInTheDocument()
  })

  it('given the queue is empty, when the fetch resolves, then the cat empty-state renders (sole empty-state primitive)', async () => {
    // arrange
    getReviewQueue.mockResolvedValue({ items: [], total_uncertain: 0 })

    // act
    renderReview()

    // assert
    await waitFor(() =>
      expect(screen.getByText(/nothing to review/i)).toBeInTheDocument(),
    )
    expect(
      screen.getByText(/confident about everyone/i),
    ).toBeInTheDocument()
  })

  it('given an uncertain item, when the card renders, then a warning-toned tabular confidence badge and the approve action appear', async () => {
    // arrange
    getReviewQueue.mockResolvedValue({
      items: [SAMPLE_ITEM],
      total_uncertain: 1,
    })

    // act
    renderReview()

    // assert — badge copy + warning tokens (uncertain range = warning
    // semantics per the Sunroom color budget).
    const badge = await screen.findByText(/62% sure/i)
    expect(badge.className).toMatch(/--color-warning/)
    expect(badge.className).toMatch(/tabular-nums/)
    expect(
      screen.getByRole('button', { name: /yes, alice/i }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /not sure/i }),
    ).toBeInTheDocument()
  })

  it('given the queue fetch rejects, when the page mounts, then a recoverable error state with Retry renders', async () => {
    // arrange
    getReviewQueue.mockRejectedValue(new Error('boom'))

    // act
    renderReview()

    // assert
    await waitFor(() =>
      expect(
        screen.getByText(/could not load review queue/i),
      ).toBeInTheDocument(),
    )
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument()
  })
})
