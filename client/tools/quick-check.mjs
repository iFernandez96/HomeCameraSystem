import { chromium } from 'playwright'
const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } })
const page = await ctx.newPage()
page.on('console', (m) => console.log('[console]', m.type(), m.text()))
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
page.on('requestfailed', (r) => console.log('[reqfail]', r.url(), r.failure()?.errorText))
await page.goto('http://10.0.0.9:8000/login', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(500)
await page.fill('input[autocomplete="username"]', 'Israel')
await page.fill('input[type="password"]', 'admin')
await Promise.all([
  page.waitForURL(/\/live/),
  page.click('button:has-text("Sign in")'),
])
await page.waitForTimeout(5000)
const counts = await page.evaluate(() => ({
  catSprites: document.querySelectorAll('[data-testid="cat-sprite"]').length,
  habitatNodes: document.querySelectorAll('[data-testid^="habitat-"]').length,
  hasCatsLayer: !!document.querySelector('[role="presentation"]'),
  innerHTML_cat_part: (() => {
    const main = document.body.innerHTML
    const idx = main.indexOf('CatLayer') !== -1 ? main.indexOf('CatLayer') : -1
    return idx === -1 ? 'no CatLayer text in DOM' : main.slice(idx, idx + 200)
  })(),
  bodyEnd: document.body.innerHTML.slice(-2000),
}))
console.log('counts:', JSON.stringify(counts, null, 2))
await browser.close()
