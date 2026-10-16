// A walk. scripts/walk.mjs copies this file into a fresh scratch folder and writes its three values in; you write your
// steps in steps() and run `node walk.mjs`. The guard is the plugin's file, imported by absolute path: it holds the Maps
// budget, blocks every write except the project's read-only POSTs and keeps the walk out of analytics. It stops
// accidents; it is not a sandbox, so do not edit the import below or the routes it installs. Screenshots go to
// ./shots; ./summary.json is rewritten after every recorded event and printed as one JSON line at the end.
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { readFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, dirname } from 'node:path'

// The relay replaces the three values below with JSON (valid JS), never by splicing text into a string.
// OPTIONS is { url, readPosts, googleHosts, blockHosts, budget, allowWebSockets, desktop, storageState }
const GUARD = __WALK_GUARD_PATH__
const PACKAGE_JSON = __WALK_REPO_PACKAGE_JSON__
const OPTIONS = __WALK_OPTIONS_JSON__

const here = dirname(fileURLToPath(import.meta.url))
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

// Playwright comes from the walked project, not from the plugin
const req = createRequire(PACKAGE_JSON)
let playwright
for (const name of ['playwright', '@playwright/test']) {
  try {
    playwright = req(name)
    break
  } catch {
    // not installed under this name: try the next
  }
}
if (!playwright) throw new Error('Playwright (playwright or @playwright/test) does not resolve from ' + PACKAGE_JSON)
const { chromium, devices } = playwright
const { installGuard } = await import(pathToFileURL(GUARD).href)

const browser = await chromium.launch()
const viewport = OPTIONS.desktop ? { viewport: { width: 1440, height: 900 } } : { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } }
const context = await browser.newContext({ ...viewport, serviceWorkers: 'block', ...(OPTIONS.storageState ? { storageState: OPTIONS.storageState } : {}) })
const guard = await installGuard(context, {
  readPosts: OPTIONS.readPosts,
  googleHosts: OPTIONS.googleHosts,
  blockHosts: OPTIONS.blockHosts,
  budget: OPTIONS.budget,
  allowWebSockets: OPTIONS.allowWebSockets,
  dir: here,
  shas: { guard: sha(GUARD), template: sha(fileURLToPath(import.meta.url)) },
})
const page = await context.newPage()
mkdirSync(join(here, 'shots'), { recursive: true })
let n = 0

// A full-page screenshot into ./shots, numbered in order
const shot = async (name) => {
  const file = String(++n).padStart(2, '0') + '-' + name.replace(/[^a-z0-9-]+/gi, '-') + '.png'
  await page.screenshot({ path: join(here, 'shots', file), fullPage: true })
  guard.shot(file)
}

// The walk: write your steps here (the task is in walk.md). page, context and shot() are in scope
async function steps() {
  await page.goto(OPTIONS.url)
  await shot('landing')
}

try {
  await steps()
} finally {
  await guard.finish(page)
  console.log(JSON.stringify(guard.summary()))
  await browser.close()
}
