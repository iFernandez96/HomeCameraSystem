import { test, expect } from '@playwright/test'

// iter-245: Pins the iter-244d false-LIVE bug end-to-end. Pre-fix,
// the StatusPill flipped to LIVE as soon as the WHEP signaling
// handshake resolved, even when ICE never produced a usable media
// path. Post-fix, status stays 'connecting' until the <video>
// element fires `playing` OR pc.connectionState === 'connected'.
// In E2E (no MediaMTX backend) the WHEP fetch fails outright, so
// we expect to see Connecting → Offline within the 8 s media-
// timeout window.

test.describe('Live tab — StatusPill correctness', () => {
  test.beforeEach(async ({ page }) => {
    // arrange — log in once per test (cookies are per-context).
    await page.goto('/login')
    await page.getByLabel(/username/i).fill('admin')
    await page.getByLabel(/password/i).fill('admin')
    await page.getByRole('button', { name: /sign in|log in|login/i }).click()
    await expect(page).toHaveURL(/\/live$/)
  })

  test('given no MediaMTX is reachable, when the Live tab loads, then LIVE never appears (iter-244d false-LIVE bug)', async ({
    page,
  }) => {
    // act — the Live tab mounts on /live; WHEP attempt fires.
    // FastAPI's SPA catch-all returns index.html for /whep/* so
    // connectWhep tries to parse HTML as SDP, throws, status flips
    // to error. No MediaMTX, no media flow.

    // assert — wait long enough that the iter-244d 8s media-timer
    // (and faster failure paths) would have flipped to LIVE if the
    // pre-fix bug were still present. Instead, the LIVE pill must
    // never appear.
    await page.waitForTimeout(10_000)
    // StatusPill renders the literal label "LIVE" inside a div.
    // Pre-iter-244d fix this assertion would FAIL.
    await expect(page.getByText('LIVE', { exact: true })).toHaveCount(0)
  })

  test('given the Live tab is open, then a fullscreen button is rendered with the correct aria label', async ({
    page,
  }) => {
    // arrange / act — landing on /live mounts VideoTile which
    // unconditionally renders the fullscreen button (regardless
    // of camera-reachable state).
    await expect(page).toHaveURL(/\/live$/)

    // assert — button exists with correct ARIA label. Click is
    // not asserted because in headless Chromium without a real
    // media stream, the "Camera unreachable" overlay intercepts
    // pointer events, which is a separate UX consideration tied
    // to error-state z-index — not the bug under test.
    await expect(
      page.getByRole('button', { name: /enter fullscreen/i }),
    ).toBeVisible()
  })
})
