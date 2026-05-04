#!/usr/bin/env node
/**
 * iter-356.38 visual verification — Playwright.
 *
 * Captures the deployed PWA's cat surfaces:
 *   1. /login page → trio mark zoomed
 *   2. If HOMECAM_USER + HOMECAM_PASS env vars set, log in → /live →
 *      capture 6 screenshots 500ms apart (catches the walk_a ↔ walk_b
 *      leg-phase animation toggle).
 *   3. Always: fetch all 24 cat sprite PNGs directly + save a contact
 *      sheet so the deploy is verified at the asset level.
 *
 * Run:
 *   node tools/verify-sprites.mjs
 *   HOMECAM_USER=israel HOMECAM_PASS=... node tools/verify-sprites.mjs
 *
 * Output: /tmp/cat-verify/*.png
 */
import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const URL = 'https://homecam.tail4a6525.ts.net'
const OUT = '/tmp/cat-verify'
const USER = process.env.HOMECAM_USER
const PASS = process.env.HOMECAM_PASS

await fs.mkdir(OUT, { recursive: true })

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({
  viewport: { width: 1600, height: 900 },
  ignoreHTTPSErrors: false,
})
const page = await ctx.newPage()

console.log('1. /login page →')
await page.goto(`${URL}/login`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(800)
await page.screenshot({ path: path.join(OUT, 'login-full.png') })

// Crop the trio mark area in the login card
const card = page.locator('img[alt=""]').first()
if (await card.count()) {
  await page.locator('main, body').first().screenshot({
    path: path.join(OUT, 'login-card.png'),
    clip: { x: 600, y: 100, width: 400, height: 400 },
  })
}

console.log('2. Asset-level fetch (24 cat sprites)')
const cats = ['panther', 'mushu', 'coco']
const poses = ['face', 'sit', 'walk_a', 'walk_b', 'play', 'stretch', 'sleep_curled', 'hiss']
const assets = []
for (const cat of cats) {
  for (const pose of poses) {
    const url = `${URL}/cats/${cat}-${pose}.png`
    const res = await page.context().request.get(url)
    const ok = res.status() === 200
    const len = res.headers()['content-length']
    assets.push({ cat, pose, url, ok, len, body: ok ? await res.body() : null })
    console.log(`   ${cat}-${pose}: ${ok ? 'OK' : 'FAIL ' + res.status()} (${len} bytes)`)
    if (ok) {
      await fs.writeFile(path.join(OUT, `${cat}-${pose}.png`), assets.at(-1).body)
    }
  }
}

if (USER && PASS) {
  console.log('3. Login + capture animation frames')
  await page.goto(`${URL}/login`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(500)
  await page.fill('input[name="username"], input[autocomplete="username"]', USER)
  await page.fill('input[name="password"], input[type="password"]', PASS)
  await Promise.all([
    page.waitForURL(/\/live/, { timeout: 15000 }),
    page.click('button:has-text("Sign in")'),
  ])
  console.log(`   logged in, on ${page.url()}`)
  // Wait for CatLayer to mount + cats to be rendered
  await page.waitForSelector('[data-testid="cat-sprite"]', { timeout: 10000 })
  console.log(`   cats mounted`)
  await page.waitForTimeout(2000)
  // Force prefers-reduced-motion: no-preference so the rAF loop runs
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  for (let i = 0; i < 10; i++) {
    await page.screenshot({ path: path.join(OUT, `live-frame-${i}.png`) })
    // Snapshot the cat-sprite img src + its computed x position
    const cats = await page.$$eval('[data-testid="cat-sprite"]', (els) =>
      els.map((el) => ({
        cat: el.getAttribute('data-cat-id'),
        state: el.getAttribute('data-cat-state'),
        src: el.getAttribute('src'),
        x: Math.round(el.getBoundingClientRect().left),
      })),
    )
    console.log(`   t=${(i * 0.4).toFixed(1)}s ${JSON.stringify(cats)}`)
    await page.waitForTimeout(400)
  }
  console.log(`   wrote 10 live-frame-*.png`)

  // Also a zoomed bottom strip per frame
  for (let i = 0; i < 6; i++) {
    await page.screenshot({
      path: path.join(OUT, `catlayer-${i}.png`),
      clip: { x: 0, y: 700, width: 1600, height: 200 },
    })
    await page.waitForTimeout(400)
  }
  console.log(`   wrote 6 catlayer-*.png`)
} else {
  console.log('3. (skip live capture — set HOMECAM_USER + HOMECAM_PASS to enable)')
}

await browser.close()
console.log(`\nResults in ${OUT}/`)
