import { chromium } from 'playwright'
const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } })
const page = await ctx.newPage()
await page.goto('https://homecam.tail4a6525.ts.net/login', { waitUntil: 'domcontentloaded' })
await page.fill('input[autocomplete="username"]', 'Israel')
await page.fill('input[type="password"]', 'admin')
await Promise.all([page.waitForURL(/\/live/), page.click('button:has-text("Sign in")')])
await page.waitForSelector('[data-testid="cat-sprite"]')
await page.waitForTimeout(2000)

// Check that the cat tree habitat exists
const tree = await page.$('[data-testid="habitat-cat-tree"]')
console.log('cat tree present:', !!tree)
const treeBox = tree && await tree.boundingBox()
console.log('cat tree position:', treeBox)

// Watch cats over 60 seconds and capture any on_post moments
let onPostSeen = []
for (let i = 0; i < 30; i++) {
  const cats = await page.$$eval('[data-testid="cat-sprite"]', (els) =>
    els.map((el) => ({
      cat: el.getAttribute('data-cat-id'),
      state: el.getAttribute('data-cat-state'),
      src: el.getAttribute('src'),
      x: Math.round(el.getBoundingClientRect().left),
    })),
  )
  const onPost = cats.filter((c) => c.state === 'on_post')
  if (onPost.length > 0) {
    onPostSeen.push({ t: i * 2, onPost })
    console.log(`t=${i*2}s ON-POST:`, JSON.stringify(onPost))
    await page.screenshot({ path: `/tmp/cat-verify/cat-tree-${i}.png` })
  }
  await page.waitForTimeout(2000)
}
console.log(`\nTotal on_post observations: ${onPostSeen.length}`)
await browser.close()
