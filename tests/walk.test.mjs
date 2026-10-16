// The outside-review walker: its guard (skills/outside-review/walk/guard.mjs), its template and the relay that
// writes a walk's scratch folder (scripts/walk.mjs). No network, no browser, no real Playwright and no real grok:
// node --test tests/walk.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, realpathSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, sep } from 'node:path'
import {
  BILLED_CAP,
  ROUTES_CAP,
  checkBudget,
  checkReadPosts,
  checkGoogleHosts,
  checkBlockHosts,
  classify,
  createBudget,
  installGuard,
  installMapCounter,
  slippedPast,
} from '../skills/outside-review/walk/guard.mjs'
import { buildWalkPrompt, parseReadPost, startUrlProblem } from '../skills/outside-review/scripts/walk.mjs'

const SKILL = join(import.meta.dirname, '..', 'skills', 'outside-review')
const WALK = join(SKILL, 'scripts', 'walk.mjs')
const GUARD = join(SKILL, 'walk', 'guard.mjs')
const TEMPLATE = join(SKILL, 'walk', 'walk-template.mjs')
const BRIEF = readFileSync(join(SKILL, 'walker.md'), 'utf8')
const sha256 = (data) => createHash('sha256').update(data).digest('hex')

// --- classify ---------------------------------------------------------------------------------------------------

const RULES = [{ host: 'api.example.test', path: '^/rest/v1/rpc/(search|nearby)$' }]

test('classify: GET, HEAD and OPTIONS are reads; any other method is a write when no rule allows it', () => {
  for (const m of ['GET', 'HEAD', 'OPTIONS']) assert.equal(classify(m, 'https://app.example.test/api/items'), 'read')
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(classify(m, 'https://app.example.test/api/items'), 'write', m)
  assert.equal(classify('POST', 'https://api.example.test/rest/v1/rpc/search', { readPosts: [] }), 'write', 'no rules: every POST is a write')
  assert.equal(classify('GET', 'data:text/plain,hi'), 'read')
  assert.equal(classify('GET', 'blob:https://app.example.test/1234'), 'read')
})

test('classify: a POST is a read-post only on a rule\'s host and a path its regex matches', () => {
  const opts = { readPosts: RULES }
  assert.equal(classify('POST', 'https://api.example.test/rest/v1/rpc/search', opts), 'read-post')
  assert.equal(classify('POST', 'https://api.example.test/rest/v1/rpc/nearby?select=id,name', opts), 'read-post', 'the query is not part of the rule')
  assert.equal(classify('POST', 'https://api.example.test/rest/v1/rpc/delete_everything', opts), 'write')
  assert.equal(classify('POST', 'https://api.example.test/rest/v1/rpc/search/', opts), 'write', 'the regex is anchored by its owner')
  assert.equal(classify('POST', 'https://other.example.test/rest/v1/rpc/search', opts), 'write', 'another host')
  assert.equal(classify('POST', 'https://api.example.test.evil.test/rest/v1/rpc/search', opts), 'write', 'a lookalike host')
  for (const m of ['PUT', 'PATCH', 'DELETE']) assert.equal(classify(m, 'https://api.example.test/rest/v1/rpc/search', opts), 'write', m)
  // A path regex is used as written: unanchored, it matches anywhere in the pathname
  assert.equal(classify('POST', 'https://api.example.test/x/search/y', { readPosts: [{ host: 'api.example.test', path: 'search' }] }), 'read-post')
  // A rule that does not compile allows nothing
  assert.equal(classify('POST', 'https://api.example.test/x', { readPosts: [{ host: 'api.example.test', path: '(' }] }), 'write')
  // A rule with a port matches only that port
  const local = { readPosts: [{ host: 'localhost:3000', path: '^/api/search$' }] }
  assert.equal(classify('POST', 'http://localhost:3000/api/search', local), 'read-post')
  assert.equal(classify('POST', 'http://localhost:4000/api/search', local), 'write')
})

test('classify: analytics hosts are blocked outright, GET included, by host suffix', () => {
  for (const u of [
    'https://www.google-analytics.com/g/collect?v=2',
    'https://region1.google-analytics.com/g/collect',
    'https://www.googletagmanager.com/gtag/js?id=G-1',
    'https://o1.ingest.sentry.io/api/1/envelope/',
    'https://stats.g.doubleclick.net/j/collect',
    'https://analytics.google.com/g/collect',
  ]) {
    assert.equal(classify('GET', u), 'analytics', u)
    assert.equal(classify('POST', u), 'analytics', u)
  }
  assert.equal(classify('GET', 'https://notgoogle-analytics.com.evil.test/x'), 'read')
  // A read-post rule cannot open an analytics host
  assert.equal(classify('POST', 'https://www.google-analytics.com/g/collect', { readPosts: [{ host: 'www.google-analytics.com', path: '.*' }] }), 'analytics')
})

test('classify: every Google Maps Platform request has a kind', () => {
  const probe = [
    ['GET', 'https://maps.googleapis.com/maps/api/js?key=k&libraries=places', 'maps-internal'],
    ['GET', 'https://maps.googleapis.com/maps-api-v3/api/js/66/8b/main.js', 'maps-internal'],
    ['GET', 'https://maps.googleapis.com/maps/vt?pb=!1m5', 'maps-internal'],
    ['GET', 'https://maps.googleapis.com/maps/api/mapsjs/gen_204?csp_test=true', 'maps-internal'],
    ['GET', 'https://maps.googleapis.com/maps/api/js/StaticMapService.GetMapImage?1m2', 'maps-internal'],
    ['POST', 'https://maps.googleapis.com/$rpc/google.internal.maps.mapsjs.v1.MapsJsInternalService/GetViewportInfo', 'maps-internal'],
    ['POST', 'https://places.googleapis.com/$rpc/google.maps.places.v1.Places/AutocompletePlaces', 'billed:places'], // RV-022 F2: billed
    ['POST', 'https://places.googleapis.com/$rpc/google.maps.places.v1.Places/GetPlace', 'billed:places'],
    ['POST', 'https://routes.googleapis.com/$rpc/google.maps.routing.v2.Routes/ComputeRoutes', 'billed:routes'],
    ['GET', 'https://maps.googleapis.com/maps/api/js/GeocodeService.Search?4s', 'billed:geocode'],
    ['GET', 'https://maps.googleapis.com/maps/api/geocode/json?address=x', 'billed:geocode'],
    // RV-021 F2: the legacy services are billed, so they count (this line used to pin DirectionsService as unclassified)
    ['GET', 'https://maps.googleapis.com/maps/api/js/DirectionsService.Route?5m', 'billed:routes'],
    ['GET', 'https://maps.googleapis.com/maps/api/js/DistanceMatrixService.GetDistanceMatrix?1m2', 'billed:routes'],
    ['GET', 'https://maps.googleapis.com/maps/api/directions/json?origin=a', 'billed:routes'],
    ['GET', 'https://maps.googleapis.com/maps/api/js/ElevationService.GetElevationForLocations?1m', 'billed:other'],
    ['GET', 'https://maps.googleapis.com/maps/api/place/js/PlaceService.GetPlaceDetails?1s', 'billed:places'],
    ['GET', 'https://maps.googleapis.com/maps/api/js/QuotaService.RecordEvent?1s', 'maps-internal'],
    ['GET', 'https://maps.googleapis.com/maps/api/js/SomethingNew.Call?1s', 'unclassified-google'],
    ['OPTIONS', 'https://routes.googleapis.com/$rpc/google.maps.routing.v2.Routes/ComputeRoutes', 'maps-internal'],
    ['GET', 'https://maps.gstatic.com/mapfiles/transparent.png', 'read'],
    ['GET', 'https://fonts.googleapis.com/css?family=Roboto', 'read'],
  ]
  for (const [method, url, kind] of probe) assert.equal(classify(method, url), kind, method + ' ' + url)
})

test('checkReadPosts: refuses what cannot be a rule, and normalises the rest', () => {
  assert.deepEqual(checkReadPosts([{ host: ' API.Example.test ', path: '^/q$' }]), [{ host: 'api.example.test', path: '^/q$' }])
  assert.deepEqual(checkReadPosts([]), [])
  assert.throws(() => checkReadPosts('nope'), /list/)
  assert.throws(() => checkReadPosts([{ host: '', path: '^/q$' }]), /host/)
  assert.throws(() => checkReadPosts([{ host: 'https://a.test', path: '^/q$' }]), /host/)
  assert.throws(() => checkReadPosts([{ host: 'a.test/x', path: '^/q$' }]), /host/)
  assert.throws(() => checkReadPosts([{ host: 'a.test' }]), /path/)
  assert.throws(() => checkReadPosts([{ host: 'a.test', path: '(' }]), /regular expression/)
  assert.throws(() => checkReadPosts([null]), /host/)
})

// --- the budget -------------------------------------------------------------------------------------------------

const ROUTES = 'https://routes.googleapis.com/$rpc/google.maps.routing.v2.Routes/ComputeRoutes'
const PLACE = 'https://places.googleapis.com/$rpc/google.maps.places.v1.Places/GetPlace'
const AUTOCOMPLETE = 'https://places.googleapis.com/$rpc/google.maps.places.v1.Places/AutocompletePlaces'

test('budget: the defaults are the owner\'s, 3 routes and 12 billed', () => {
  assert.equal(ROUTES_CAP, 3)
  assert.equal(BILLED_CAP, 12)
  assert.deepEqual(checkBudget(), { routes: 3, billed: 12 })
})

test('budget: the 4th computeRoutes is aborted and not billed', () => {
  const b = createBudget()
  assert.deepEqual([1, 2, 3, 4].map(() => b.decide('billed:routes', 'POST', ROUTES)), ['continue', 'continue', 'continue', 'abort'])
  assert.equal(b.state.routes, 3)
  assert.equal(b.billed(), 3)
  assert.deepEqual(b.state.abortedOverCap, ['POST routes.googleapis.com/$rpc/google.maps.routing.v2.Routes/ComputeRoutes'])
})

test('budget: the 13th billed request is aborted, and after it every Google Maps Platform request', () => {
  const b = createBudget()
  b.mapLoad()
  b.mapLoad()
  for (let i = 0; i < 10; i++) assert.equal(b.decide('billed:places', 'POST', PLACE), 'continue')
  assert.equal(b.billed(), BILLED_CAP)
  assert.equal(b.left(), 0)
  assert.equal(b.decide('billed:places', 'POST', PLACE), 'abort')
  assert.equal(b.decide('maps-internal', 'GET', 'https://maps.googleapis.com/maps/vt'), 'abort')
  assert.equal(b.decide('read', 'GET', 'https://app.example.test/'), 'continue', 'the app itself is not Google')
  assert.equal(b.billed(), BILLED_CAP)
})

// RV-022 F2: Autocomplete is billed per request unless its session ends in Details, which the browser can't show, so it
// counts (this test used to pin it as free and capped at 20)
test('budget: Autocomplete counts against the billed cap; the 13th is aborted', () => {
  const b = createBudget()
  const out = Array.from({ length: 13 }, () => b.decide(classify('POST', AUTOCOMPLETE), 'POST', AUTOCOMPLETE))
  assert.equal(out.filter((d) => d === 'continue').length, 12)
  assert.equal(out[12], 'abort')
  assert.equal(b.billed(), 12)
})

test('budget: caps can be set, and bad ones are refused', () => {
  const b = createBudget({ routesCap: 1, billedCap: 2 })
  assert.equal(b.decide('billed:routes', 'POST', ROUTES), 'continue')
  assert.equal(b.decide('billed:routes', 'POST', ROUTES), 'abort')
  assert.equal(b.decide('billed:places', 'POST', PLACE), 'continue')
  assert.equal(b.decide('billed:places', 'POST', PLACE), 'abort')
  assert.deepEqual(checkBudget({ routes: 5 }), { routes: 5, billed: 12 })
  assert.deepEqual(checkBudget({ routes: 1, billed: 40 }), { routes: 1, billed: 40 })
  for (const bad of [{ routes: 0 }, { routes: -1 }, { billed: 1.5 }, { billed: '12' }, { routes: null }, { routes: Infinity }, { route: 2 }, [3], 'x']) {
    assert.throws(() => checkBudget(bad), /budget/, JSON.stringify(bad))
  }
})

test('budget: writes and analytics are recorded without bodies; unclassified Google paths are blocked and listed', () => {
  const b = createBudget()
  assert.equal(b.decide('write', 'POST', 'https://app.example.test/api/save?token=secret'), 'abort')
  assert.equal(b.decide('analytics', 'GET', 'https://www.google-analytics.com/g/collect?v=2&tid=G-1'), 'abort')
  assert.equal(b.decide('read-post', 'POST', 'https://api.example.test/rest/v1/rpc/search'), 'continue')
  // RV-021 F2: an unclassified Google GET could be a billed service nobody named, so it is blocked (it used to continue)
  assert.equal(b.decide('unclassified-google', 'GET', 'https://maps.googleapis.com/maps/api/js/SomethingNew.Call?5m'), 'abort')
  assert.deepEqual(b.state.blockedWrites, ['POST app.example.test/api/save'])
  assert.deepEqual(b.state.blockedAnalytics, ['GET www.google-analytics.com/g/collect'])
  assert.deepEqual(b.state.unclassifiedGoogle, ['GET maps.googleapis.com/maps/api/js/SomethingNew.Call'])
})

test('the audit rule: a guarded kind that completed without the guard\'s continue slipped past; allowed traffic never did', () => {
  assert.equal(slippedPast('billed:routes', 'continue'), false)
  assert.equal(slippedPast('billed:routes', 'abort'), true)
  assert.equal(slippedPast('billed:routes', undefined), true)
  assert.equal(slippedPast('write', undefined), true)
  assert.equal(slippedPast('write', 'abort'), true)
  assert.equal(slippedPast('analytics', 'abort'), true)
  assert.equal(slippedPast('unclassified-google', 'abort'), true)
  assert.equal(slippedPast('maps-internal', undefined), false)
  assert.equal(slippedPast('read-post', undefined), false)
})

// --- installGuard on a fake BrowserContext ---------------------------------------------------------------------

function fakeContext() {
  const c = {
    initScripts: [],
    bindings: {},
    handler: null,
    listeners: {},
    evaluated: [],
    addInitScript: async (script) => c.initScripts.push(script),
    exposeBinding: async (name, fn) => {
      c.bindings[name] = fn
    },
    route: async (_glob, fn) => {
      c.handler = fn
    },
    socketHandler: null,
    routeWebSocket: async (_pattern, fn) => {
      c.socketHandler = fn
    },
    on: (event, fn) => {
      c.listeners[event] = fn
    },
    pages: () => [{ evaluate: async (_fn, left) => c.evaluated.push(left) }],
  }
  return c
}
const fakeRequest = (method, url) => ({ method: () => method, url: () => url })
async function send(c, method, url) {
  const request = fakeRequest(method, url)
  let outcome
  await c.handler({ request: () => request, abort: async () => (outcome = 'aborted'), continue: async () => (outcome = 'continued') })
  return { request, outcome }
}

test('installGuard: routes at the context, rewrites summary.json after each event, and audits what completed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'walk-guard-'))
  const summary = () => JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'))
  const c = fakeContext()
  const guard = await installGuard(c, { readPosts: RULES, budget: { routes: 1, billed: 3 }, dir, shas: { guard: 'g', template: 't' } })
  assert.deepEqual(summary().caps, { routes: 1, billed: 3 })
  assert.deepEqual(summary().readPostRules, RULES)
  assert.equal(summary().guardSha256, 'g')
  assert.equal(summary().templateSha256, 't')

  assert.equal((await send(c, 'POST', ROUTES)).outcome, 'continued')
  assert.equal(summary().routes, 1)
  assert.equal(c.evaluated.at(-1), 2, 'the page is told 2 of 3 are left')
  assert.equal((await send(c, 'POST', ROUTES)).outcome, 'aborted', 'the 2nd route is over this walk\'s cap of 1')
  assert.equal(summary().abortedOverCap.length, 1)

  await c.bindings.__walkMapLoad()
  assert.equal(summary().mapLoads, 1)
  assert.equal(summary().billed, 2)
  assert.equal(c.evaluated.at(-1), 1)

  assert.equal((await send(c, 'POST', 'https://app.example.test/api/save')).outcome, 'aborted')
  assert.equal((await send(c, 'POST', 'https://api.example.test/rest/v1/rpc/search')).outcome, 'continued')
  assert.equal((await send(c, 'GET', 'https://www.google-analytics.com/g/collect')).outcome, 'aborted')
  assert.deepEqual(summary().blockedWrites, ['POST app.example.test/api/save'])
  assert.deepEqual(summary().blockedAnalytics, ['GET www.google-analytics.com/g/collect'])

  // The audit: a write that completed without the guard's continue is a guard failure; allowed traffic is not
  c.listeners.requestfinished(fakeRequest('POST', 'https://app.example.test/apply'))
  c.listeners.requestfinished(fakeRequest('GET', 'https://maps.googleapis.com/maps/vt?x'))
  c.listeners.requestfinished(fakeRequest('GET', 'https://app.example.test/'))
  const completed = (await send(c, 'POST', 'https://api.example.test/rest/v1/rpc/search')).request
  c.listeners.requestfinished(completed)
  assert.deepEqual(summary().guardFailures, ['completed past the guard: POST app.example.test/apply'])

  guard.shot('01-landing.png')
  assert.deepEqual(summary().shots, ['01-landing.png'])

  // After the walk: more map roots than counted constructions means a map was built before the counter took
  await guard.finish({ evaluate: async () => 2 })
  assert.match(summary().guardFailures.at(-1), /a map built before the counter \(2 map roots, 1 counted\)/)
  assert.equal(guard.summary().billed, 2)
})

test('installGuard: bad rules or caps stop the walk before it starts', async () => {
  await assert.rejects(() => installGuard(fakeContext(), { readPosts: [{ host: 'a.test', path: '(' }] }), /regular expression/)
  await assert.rejects(() => installGuard(fakeContext(), { budget: { routes: 0 } }), /budget/)
})

test('installGuard: the page script it injects is valid and counts a map load', async () => {
  const c = fakeContext()
  await installGuard(c, {})
  const loads = []
  const win = { __walkMapLoad: (n) => loads.push(n) }
  new Function('window', c.initScripts.at(-1))(win)
  assert.equal(win.__walkBudgetLeft, 12)
  win.google = { maps: { Map: class {} } }
  new win.google.maps.Map()
  assert.deepEqual(loads, [1])
  assert.equal(win.__walkBudgetLeft, 11)
})

test('installMapCounter: the trap chain wraps maps.Map before any construction, spends the budget, and throws at 0', () => {
  const win = { __walkBudgetLeft: 2 }
  const loads = []
  installMapCounter(win, (n) => loads.push(n))
  class RealMap {
    constructor(el) {
      this.el = el
    }
  }
  const g = {}
  win.google = g // the loader sets window.google, then google.maps, then maps.Map
  const maps = {}
  g.maps = maps
  maps.Map = RealMap
  const Map = win.google.maps.Map
  const first = new Map('a')
  assert.ok(first instanceof RealMap)
  assert.equal(first.el, 'a')
  new Map('b')
  assert.deepEqual(loads, [1, 2])
  assert.equal(win.__walkBudgetLeft, 0)
  assert.throws(() => new Map('c'), /walk budget: map loads/)
})

test('installMapCounter: a google object that already exists is trapped too', () => {
  class RealMap {}
  const win = { __walkBudgetLeft: 1, google: { maps: { Map: RealMap } } }
  const loads = []
  installMapCounter(win, (n) => loads.push(n))
  new win.google.maps.Map()
  assert.deepEqual(loads, [1])
})

// --- the template ----------------------------------------------------------------------------------------------

test('the template: explicit viewports, service workers blocked, the guard imported by the given path, Playwright from the project', () => {
  const src = readFileSync(TEMPLATE, 'utf8')
  assert.ok(src.includes("{ ...devices['Pixel 7'], viewport: { width: 390, height: 844 } }"))
  assert.ok(src.includes('{ viewport: { width: 1440, height: 900 } }'))
  assert.ok(src.includes("serviceWorkers: 'block'"))
  assert.ok(src.includes('await import('))
  assert.ok(src.includes('createRequire(PACKAGE_JSON)'))
  assert.ok(src.indexOf("'playwright'") < src.indexOf("'@playwright/test'"), 'playwright first, then @playwright/test')
  assert.equal(spawnSync(process.execPath, ['--check', TEMPLATE]).status, 0)
})

// --- the start URL ---------------------------------------------------------------------------------------------

const STAGING = 'https://staging.example.test'

test('startUrlProblem: localhost and the exact --staging origin are walkable', () => {
  assert.equal(startUrlProblem('http://localhost:3000/demo', undefined, false), null)
  assert.equal(startUrlProblem('http://127.0.0.1:4180/', undefined, false), null)
  assert.equal(startUrlProblem(STAGING + '/demo', STAGING, false), null)
  assert.equal(startUrlProblem(STAGING + '/', STAGING + '/', false), null)
})

test('startUrlProblem: any other host needs --prod-readonly, lookalikes included', () => {
  for (const url of [
    'https://example.test/',
    'https://www.example.test/',
    'https://localhost.evil.test/',
    'http://localhost./',
    'http://[::1]:3000/',
    'http://staging.example.test/',
    'https://evil-staging.example.test/',
    'https://staging.example.test.evil.test/',
  ]) {
    assert.match(startUrlProblem(url, STAGING, false), /needs --prod-readonly/, url)
    assert.equal(startUrlProblem(url, STAGING, true), null, url + ' with --prod-readonly')
  }
})

test('startUrlProblem: not a URL, not http(s), userinfo, or a bad --staging are refused even with --prod-readonly', () => {
  for (const url of ['localhost:3000', 'ftp://localhost/', 'javascript:alert(1)', 'https://user:pw@example.test/', 'http://evil.test@localhost/', 'not a url']) {
    assert.notEqual(startUrlProblem(url, undefined, true), null, url)
  }
  for (const staging of ['http://staging.example.test', 'https://staging.example.test/path', 'https://staging.example.test/?x=1', 'https://u@staging.example.test', 'nope']) {
    assert.match(startUrlProblem('https://staging.example.test/', staging, true), /--staging/, staging)
  }
})

// --- the brief -------------------------------------------------------------------------------------------------

const FLAGS = { url: 'https://staging.example.test/menu', person: 'a first-time visitor on a phone', task: 'find tonight\'s opening hours', skip: ['the footer links 404'] }

test('buildWalkPrompt: rebuilds the Setup line from the flags, fills the skip list, keeps the brief, appends the walk\'s own lines', () => {
  const md = buildWalkPrompt(BRIEF, FLAGS)
  assert.ok(md.includes('Setup: https://staging.example.test/menu, as a first-time visitor on a phone, logged out, phone viewport (390px), one task ("find tonight\'s opening hours"). Real data. No fixtures.'))
  assert.ok(md.includes('skip the standing checks listed: the footer links 404'))
  assert.ok(md.startsWith('Job: use the deployed build as a real person.'))
  assert.ok(!md.includes('Setup: URL'), 'the placeholder Setup line is gone')
  assert.ok(md.includes('Stay on https://staging.example.test; if the address leaves it, say so and stop.'))
  assert.match(md, /left blank by the budget is expected, not a finding/)
  assert.match(md, /Write your steps in steps\(\) in walk\.mjs and run `node walk\.mjs`/)
  assert.match(md, /edit only steps\(\)/)
  assert.ok(buildWalkPrompt(BRIEF, { ...FLAGS, skip: [] }).includes('skip the standing checks listed: none'))
  assert.ok(buildWalkPrompt(BRIEF, { ...FLAGS, skip: ['a', 'b'] }).includes('skip the standing checks listed: a; b'))
  const wide = buildWalkPrompt(BRIEF, { ...FLAGS, desktop: true, signedIn: true })
  assert.match(wide, /signed in/)
  assert.match(wide, /desktop \(1440px\)/)
})

test('buildWalkPrompt: a missing or repeated anchor throws, naming it', () => {
  assert.throws(() => buildWalkPrompt(BRIEF.replace(/^Setup:/m, 'Prep:'), FLAGS), /Setup:/)
  assert.throws(() => buildWalkPrompt(BRIEF + '\nSetup: again\n', FLAGS), /Setup:.*exactly once/)
  assert.throws(() => buildWalkPrompt(BRIEF.replace('skip the standing checks listed', 'skip nothing'), FLAGS), /skip the standing checks listed/)
  assert.throws(() => buildWalkPrompt(BRIEF + '\nskip the standing checks listed\n', FLAGS), /exactly once/)
})

test('walker.md: the generic brief keeps its finding format and carries nothing from the product it was lifted from', () => {
  for (const phrase of [
    'Job: use the deployed build as a real person. Report what breaks. Do not score the spec.',
    'skip the standing checks listed',
    'CHECK',
    'OPINION',
    'fix class',
    'assert: <invariant> ; repro: <url + steps> ; evidence: <quoted UI or JSON>',
    'If the browser does not launch, say so in one line and stop. Never describe a page you did not open.',
  ]) {
    assert.ok(BRIEF.includes(phrase), phrase)
  }
  assert.equal(BRIEF.split('\n').filter((l) => l.startsWith('Setup:')).length, 1)
  assert.doesNotMatch(BRIEF, /jobsnearme|supabase|juvo|commute|job posting|corpus|FS-\d+|rung/i)
})

test('parseReadPost: "<host> <pathRegex>", split on the first run of spaces', () => {
  assert.deepEqual(parseReadPost('api.example.test ^/rest/v1/rpc/(search|nearby)$'), { host: 'api.example.test', path: '^/rest/v1/rpc/(search|nearby)$' })
  assert.deepEqual(parseReadPost('  localhost:3000   ^/api/search$  '), { host: 'localhost:3000', path: '^/api/search$' })
  for (const bad of ['api.example.test', 'api.example.test (', ' ', '', true]) assert.throws(() => parseReadPost(bad), /--read-post/, String(bad))
})

// --- the relay, run as a child process -------------------------------------------------------------------------

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'walk-tmp-')))

// A Playwright that opens nothing: it records the context options it was given, so a written walk.mjs can run for real
const FAKE_PLAYWRIGHT = `const { writeFileSync } = require('node:fs')
const { join } = require('node:path')
const page = { goto: async () => {}, screenshot: async ({ path }) => writeFileSync(path, 'png'), evaluate: async () => 0 }
const context = { addInitScript: async () => {}, exposeBinding: async () => {}, route: async () => {}, on: () => {}, pages: () => [page], newPage: async () => page }
const newContext = async (options) => {
  writeFileSync(join(process.cwd(), 'context.json'), JSON.stringify(options))
  return context
}
module.exports = {
  devices: { 'Pixel 7': { userAgent: 'pixel', isMobile: true, hasTouch: true, viewport: { width: 412, height: 915 } } },
  chromium: { launch: async () => ({ newContext, close: async () => {} }) },
}
`

// A project with a fake Playwright, so createRequire resolves it and nothing real runs
function project({ playwright = 'playwright', config } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'walk-proj-')))
  execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main'])
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', private: true }))
  if (playwright) {
    mkdirSync(join(dir, 'node_modules', playwright), { recursive: true })
    writeFileSync(join(dir, 'node_modules', playwright, 'package.json'), JSON.stringify({ name: playwright, version: '0.0.0', main: 'index.js' }))
    writeFileSync(join(dir, 'node_modules', playwright, 'index.js'), FAKE_PLAYWRIGHT)
  }
  if (config) {
    mkdirSync(join(dir, '.claude'))
    writeFileSync(join(dir, '.claude', 'review.json'), typeof config === 'string' ? config : JSON.stringify(config))
  }
  return dir
}
const BASE = ['--url', 'http://localhost:4180/', '--person', 'a first-time visitor', '--task', 'find the opening hours']
function walk(dir, argv, env = {}) {
  return spawnSync(process.execPath, [WALK, '--repo', dir, ...argv], { encoding: 'utf8', env: { ...process.env, TMPDIR: TMP, ...env } })
}
const folderOf = (stdout) => stdout.match(/--cwd "([^"]+)"/)?.[1] ?? ''
const optionsOf = (folder) => JSON.parse(readFileSync(join(folder, 'walk.mjs'), 'utf8').match(/^const OPTIONS = (\{.*\})$/m)[1])

test('walk.mjs writes a scratch folder: no token left, the guard path absolute, options as JSON, the shas and the grok command printed', () => {
  const dir = project()
  const out = walk(dir, BASE)
  assert.equal(out.status, 0, out.stderr)
  const folder = folderOf(out.stdout)
  assert.ok(folder && existsSync(join(folder, 'walk.md')) && existsSync(join(folder, 'walk.mjs')))
  assert.ok(!(folder + sep).startsWith(dir + sep), 'the scratch folder is not inside the project')
  assert.ok(folder.startsWith(TMP), 'it is under the temp dir')

  const script = readFileSync(join(folder, 'walk.mjs'), 'utf8')
  assert.doesNotMatch(script, /__WALK_/)
  assert.ok(isAbsolute(GUARD))
  assert.ok(script.includes('const GUARD = ' + JSON.stringify(GUARD)))
  assert.ok(script.includes('const PACKAGE_JSON = ' + JSON.stringify(join(dir, 'package.json'))))
  // allowWebSockets added with the socket guard: false unless the project's review.json allows them
  assert.deepEqual(optionsOf(folder), { url: 'http://localhost:4180/', readPosts: [], budget: { routes: 3, billed: 12 }, allowWebSockets: false, desktop: false, storageState: null, googleHosts: [], blockHosts: [] })
  assert.equal(spawnSync(process.execPath, ['--check', join(folder, 'walk.mjs')]).status, 0, 'walk.mjs parses')

  const prompt = readFileSync(join(folder, 'walk.md'), 'utf8')
  assert.ok(prompt.includes('Setup: http://localhost:4180/, as a first-time visitor, logged out, phone viewport (390px), one task ("find the opening hours").'))
  assert.ok(prompt.includes('skip the standing checks listed: none'))

  assert.ok(out.stdout.includes('guard sha256 ' + sha256(readFileSync(GUARD))))
  assert.ok(out.stdout.includes('walk.mjs sha256 ' + sha256(script)))
  assert.ok(out.stdout.includes('walk.md sha256 ' + sha256(prompt)))
  assert.ok(out.stdout.includes(`grok --prompt-file "${join(folder, 'walk.md')}" --cwd "${folder}" --always-approve --max-turns 30`))
  assert.deepEqual(readdirSync(join(dir)).filter((n) => n === 'docs'), [], 'without --run nothing is written to the project')
})

test('the written walk.mjs runs: phone viewport, service workers blocked, one summary line that matches summary.json and carries both shas', () => {
  const dir = project()
  const folder = folderOf(walk(dir, BASE).stdout)
  const run = spawnSync(process.execPath, ['walk.mjs'], { cwd: folder, encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  const context = JSON.parse(readFileSync(join(folder, 'context.json'), 'utf8'))
  assert.deepEqual(context.viewport, { width: 390, height: 844 })
  assert.equal(context.userAgent, 'pixel', 'the phone profile\'s agent and touch are kept')
  assert.equal(context.hasTouch, true)
  assert.equal(context.serviceWorkers, 'block')
  assert.equal('storageState' in context, false, 'no cookies unless a storage state is given')

  const summary = JSON.parse(readFileSync(join(folder, 'summary.json'), 'utf8'))
  assert.equal(summary.guardSha256, sha256(readFileSync(GUARD)))
  assert.equal(summary.templateSha256, sha256(readFileSync(join(folder, 'walk.mjs'))))
  assert.deepEqual(summary.caps, { routes: 3, billed: 12 })
  assert.deepEqual(summary.shots, ['01-landing.png'])
  assert.ok(existsSync(join(folder, 'shots', '01-landing.png')))
  assert.deepEqual(JSON.parse(run.stdout.trim().split('\n').at(-1)), summary)
})

test('the written walk.mjs runs at desktop width with --desktop, and hands a storage state to the context', () => {
  const dir = project()
  const state = join(TMP, 'run-state.json')
  writeFileSync(state, JSON.stringify({ cookies: [{ name: 's', value: 'x', domain: 'localhost', path: '/' }], origins: [] }))
  const folder = folderOf(walk(dir, [...BASE, '--desktop', '--storage-state', state]).stdout)
  const run = spawnSync(process.execPath, ['walk.mjs'], { cwd: folder, encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  const context = JSON.parse(readFileSync(join(folder, 'context.json'), 'utf8'))
  assert.deepEqual(context.viewport, { width: 1440, height: 900 })
  assert.equal(context.userAgent, undefined)
  assert.equal(context.storageState, state)
})

test('walk.mjs: --desktop, --skip and a usable storage state reach the options and the brief', () => {
  const dir = project()
  const state = join(TMP, 'state.json')
  writeFileSync(state, JSON.stringify({ cookies: [{ name: 's', value: 'x', domain: 'localhost', path: '/' }], origins: [] }))
  const out = spawnSync(process.execPath, [WALK, '--repo', dir, ...BASE, '--desktop', '--skip', 'cookie banner', '--skip', 'footer 404', '--storage-state', 'state.json'], {
    encoding: 'utf8',
    cwd: TMP,
    env: { ...process.env, TMPDIR: TMP },
  })
  assert.equal(out.status, 0, out.stderr)
  const folder = folderOf(out.stdout)
  const options = optionsOf(folder)
  assert.equal(options.desktop, true)
  assert.equal(options.storageState, state, 'resolved to an absolute path')
  const prompt = readFileSync(join(folder, 'walk.md'), 'utf8')
  assert.match(prompt, /signed in/)
  assert.match(prompt, /desktop \(1440px\)/)
  assert.ok(prompt.includes('skip the standing checks listed: cookie banner; footer 404'))
})

test('walk.mjs refuses a missing --url, --person or --task, an unknown flag, a stray argument and a flag without its value', () => {
  const dir = project()
  const without = (flag) => {
    const argv = [...BASE]
    argv.splice(argv.indexOf(flag), 2)
    return argv
  }
  for (const flag of ['--url', '--person', '--task']) {
    const out = walk(dir, without(flag))
    assert.equal(out.status, 2, flag)
    assert.match(out.stderr, new RegExp(flag + ' is required'))
  }
  const unknown = walk(dir, [...BASE, '--destop'])
  assert.equal(unknown.status, 2)
  assert.match(unknown.stderr, /unknown flag --destop/)
  assert.equal(walk(dir, [...BASE, 'extra']).status, 2)
  assert.match(walk(dir, ['--url', 'http://localhost/', '--person', 'p', '--task']).stderr, /--task is required|needs a value/)
  assert.match(walk(dir, [...BASE, '--storage-state']).stderr, /--storage-state needs a value/)
  assert.match(walk(dir, [...BASE, '--desktop', 'yes']).stderr, /--desktop takes no value/)
})

test('walk.mjs: a prod walk needs --prod-readonly and says so; userinfo stays refused', () => {
  const dir = project()
  const prod = ['--url', 'https://example.test/', '--person', 'p', '--task', 't']
  const refused = walk(dir, prod)
  assert.equal(refused.status, 2)
  assert.match(refused.stderr, /needs --prod-readonly/)
  const ok = walk(dir, [...prod, '--prod-readonly'])
  assert.equal(ok.status, 0, ok.stderr)
  assert.ok(ok.stdout.includes('PROD READ-ONLY: https://example.test'))
  assert.equal(walk(dir, ['--url', 'https://user:pw@example.test/', '--person', 'p', '--task', 't', '--prod-readonly']).status, 2)
  const staged = walk(dir, ['--url', 'https://staging.example.test/x', '--person', 'p', '--task', 't', '--staging', 'https://staging.example.test'])
  assert.equal(staged.status, 0, staged.stderr)
  assert.ok(!staged.stdout.includes('PROD READ-ONLY'))
})

test('walk.mjs exits 2 with a plain message when the project has no Playwright, and writes no folder', () => {
  const dir = project({ playwright: null })
  const own = mkdtempSync(join(TMP, 'empty-'))
  const out = walk(dir, BASE, { TMPDIR: own })
  assert.equal(out.status, 2)
  assert.match(out.stderr, /Playwright/)
  assert.match(out.stderr, /playwright or @playwright\/test/)
  assert.deepEqual(readdirSync(own), [])
})

test('walk.mjs finds @playwright/test when playwright is not there', () => {
  const out = walk(project({ playwright: '@playwright/test' }), BASE)
  assert.equal(out.status, 0, out.stderr)
})

test('walk.mjs: .claude/review.json overrides the budget; bad values are refused', () => {
  const ok = walk(project({ config: { walk: { budget: { routes: 5, billed: 20 } } } }), BASE)
  assert.equal(ok.status, 0, ok.stderr)
  assert.deepEqual(optionsOf(folderOf(ok.stdout)).budget, { routes: 5, billed: 20 })
  const partial = walk(project({ config: { walk: { budget: { billed: 6 } } } }), BASE)
  assert.deepEqual(optionsOf(folderOf(partial.stdout)).budget, { routes: 3, billed: 6 })
  const other = walk(project({ config: { somethingElse: true } }), BASE)
  assert.deepEqual(optionsOf(folderOf(other.stdout)).budget, { routes: 3, billed: 12 })

  for (const budget of [{ routes: 0 }, { routes: -2 }, { billed: 1.5 }, { billed: '12' }, { routes: null }, { route: 3 }, 7, [1]]) {
    const out = walk(project({ config: { walk: { budget } } }), BASE)
    assert.equal(out.status, 2, JSON.stringify(budget))
    assert.match(out.stderr, /review\.json/, JSON.stringify(budget))
    assert.match(out.stderr, /walk\.budget/, JSON.stringify(budget))
  }
  const broken = walk(project({ config: '{not json' }), BASE)
  assert.equal(broken.status, 2)
  assert.match(broken.stderr, /review\.json is not valid JSON/)
})

test('walk.mjs: read-post rules come from --read-post flags and walk.readPosts, and bad ones are refused', () => {
  const dir = project({ config: { walk: { readPosts: [{ host: 'api.example.test', path: '^/rpc/search$' }] } } })
  const out = walk(dir, [...BASE, '--read-post', 'api.example.test ^/rpc/(nearby|list)$', '--read-post', 'api.example.test ^/rpc/search$'])
  assert.equal(out.status, 0, out.stderr)
  assert.deepEqual(optionsOf(folderOf(out.stdout)).readPosts, [
    { host: 'api.example.test', path: '^/rpc/(nearby|list)$' },
    { host: 'api.example.test', path: '^/rpc/search$' },
  ])

  assert.equal(walk(project(), [...BASE, '--read-post', 'api.example.test']).status, 2)
  assert.match(walk(project(), [...BASE, '--read-post', 'api.example.test (']).stderr, /regular expression/)
  assert.match(walk(project(), [...BASE, '--read-post']).stderr, /--read-post needs a value/)
  for (const readPosts of ['x', [{ host: 'a.test' }], [{ host: 'https://a.test', path: '^/$' }], [{ host: 'a.test', path: '(' }]]) {
    const bad = walk(project({ config: { walk: { readPosts } } }), BASE)
    assert.equal(bad.status, 2, JSON.stringify(readPosts))
    assert.match(bad.stderr, /review\.json/)
  }
})

test('walk.mjs: a scratch folder inside the project is refused', () => {
  const dir = project()
  const inside = join(dir, 'tmp-inside')
  mkdirSync(inside)
  const out = walk(dir, BASE, { TMPDIR: inside })
  assert.equal(out.status, 2)
  assert.match(out.stderr, /inside the repository/)
  assert.deepEqual(readdirSync(inside), [], 'the folder it made is removed')
})

test('walk.mjs: an unusable storage state is refused without echoing its contents', () => {
  const dir = project()
  for (const [name, body] of [['missing.json', null], ['bad.json', '{not json'], ['empty.json', '{}'], ['nocookies.json', JSON.stringify({ cookies: [], origins: [] })]]) {
    const file = join(TMP, name)
    if (body !== null) writeFileSync(file, body)
    const out = walk(dir, [...BASE, '--storage-state', file])
    assert.equal(out.status, 2, name)
    assert.ok(out.stderr.includes('not a usable storage state: ' + file))
    assert.ok(!out.stderr.includes('{not json'))
  }
})

// --- --run, with a fake grok -----------------------------------------------------------------------------------

// Odd whitespace and no final newline on purpose: the reply must come back byte for byte
const REPLY = '  ### Finding 1 · CHECK\r\n\ttitle with trailing spaces   \n\nassert: totals agree ; repro: / ; evidence: "3 left" and "4 left"'

function fakeGrok({ reply = REPLY, exit = 0, summary = '{"billed":2,"routes":1,"guardFailures":[]}' } = {}) {
  const bin = mkdtempSync(join(TMP, 'bin-'))
  writeFileSync(join(bin, 'reply.txt'), reply)
  const lines = ['#!/bin/sh', 'here="$(dirname "$0")"', 'echo "$@" > "$here/grok.args"', 'pwd -P > "$here/grok.cwd"', 'cat > /dev/null'] // stdin must be closed, or this hangs
  if (summary !== null) {
    writeFileSync(join(bin, 'summary.txt'), summary)
    lines.push('cp "$here/summary.txt" summary.json')
  }
  lines.push('cat "$here/reply.txt"', 'exit ' + exit, '')
  writeFileSync(join(bin, 'grok'), lines.join('\n'))
  chmodSync(join(bin, 'grok'), 0o755)
  return bin
}
const withGrok = (bin) => ({ PATH: bin + ':' + process.env.PATH })

test('walk.mjs --run: saves grok\'s reply verbatim as WALK-001-grok.md, with a meta file pinned by sha256', () => {
  const dir = project()
  const bin = fakeGrok()
  const out = walk(dir, [...BASE, '--run'], withGrok(bin))
  assert.equal(out.status, 0, out.stderr)
  const inbox = join(dir, 'docs', 'reviews', 'inbox')
  assert.deepEqual(readdirSync(inbox).sort(), ['WALK-001-grok.md', 'WALK-001-grok.meta.json'])
  assert.equal(readFileSync(join(inbox, 'WALK-001-grok.md'), 'utf8'), REPLY, 'verbatim')

  const folder = out.stdout.match(/scratch folder (\S+)/)[1]
  const meta = JSON.parse(readFileSync(join(inbox, 'WALK-001-grok.meta.json'), 'utf8'))
  assert.equal(meta.round, 'WALK-001')
  assert.equal(meta.reviewer, 'grok')
  assert.equal(meta.url, 'http://localhost:4180/')
  assert.equal(meta.person, 'a first-time visitor')
  assert.equal(meta.task, 'find the opening hours')
  assert.equal(meta.scratch_folder, folder)
  assert.equal(meta.walk_md_sha256, sha256(readFileSync(join(folder, 'walk.md'))))
  assert.equal(meta.walk_mjs_sha256, sha256(readFileSync(join(folder, 'walk.mjs'))))
  assert.equal(meta.guard_sha256, sha256(readFileSync(GUARD)))
  assert.equal(meta.response_sha256, sha256(REPLY))
  assert.deepEqual(meta.summary, { billed: 2, routes: 1, guardFailures: [] })
  assert.ok(!Number.isNaN(Date.parse(meta.started_at)))
  assert.equal(typeof meta.duration_ms, 'number')

  // grok was run as the owner specified, from the scratch folder
  assert.equal(readFileSync(join(bin, 'grok.args'), 'utf8').trim(), `--prompt-file ${join(folder, 'walk.md')} --cwd ${folder} --always-approve --max-turns 30`)
  assert.equal(readFileSync(join(bin, 'grok.cwd'), 'utf8').trim(), realpathSync(folder))
  assert.ok(out.stdout.includes('docs/reviews/inbox/WALK-001-grok.md'))
  assert.ok(!out.stdout.includes('--always-approve'), 'it ran grok, so it does not print the command to run')

  // The next walk is one past the highest
  const again = walk(dir, [...BASE, '--run'], withGrok(bin))
  assert.equal(again.status, 0, again.stderr)
  assert.ok(existsSync(join(inbox, 'WALK-002-grok.md')))
  writeFileSync(join(inbox, 'WALK-009-grok.md'), 'x')
  assert.equal(walk(dir, [...BASE, '--run'], withGrok(bin)).status, 0)
  assert.ok(existsSync(join(inbox, 'WALK-010-grok.md')))
})

test('walk.mjs --run: warns when the guard that ran is not the one printed, or a request completed past it', () => {
  const dir = project()
  const bin = fakeGrok({ summary: '{"billed":0,"guardSha256":"deadbeef","guardFailures":["completed past the guard: POST app.example.test/apply"]}' })
  const out = walk(dir, [...BASE, '--run'], withGrok(bin))
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /guard sha256 in summary\.json does not match/)
  assert.match(out.stdout, /completed past the guard/)
  assert.ok(existsSync(join(dir, 'docs/reviews/inbox/WALK-001-grok.md')))
})

test('walk.mjs --run: a walk with no summary.json says the walker never ran the script', () => {
  const dir = project()
  const bin = fakeGrok({ summary: null })
  const out = walk(dir, [...BASE, '--run'], withGrok(bin))
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /no summary\.json/)
  assert.equal(JSON.parse(readFileSync(join(dir, 'docs/reviews/inbox/WALK-001-grok.meta.json'), 'utf8')).summary, null)
})

test('walk.mjs --run: a grok that fails after printing still has its output saved, then the run fails', () => {
  const dir = project()
  const out = walk(dir, [...BASE, '--run'], withGrok(fakeGrok({ reply: 'partial findings', exit: 3 })))
  assert.equal(out.status, 1)
  assert.equal(readFileSync(join(dir, 'docs/reviews/inbox/WALK-001-grok.md'), 'utf8'), 'partial findings')
  assert.equal(JSON.parse(readFileSync(join(dir, 'docs/reviews/inbox/WALK-001-grok.meta.json'), 'utf8')).exit_status, 3)
  assert.match(out.stderr, /grok exited 3/)
})

test('walk.mjs --run: no grok on PATH is a plain failure that saves nothing', () => {
  const dir = project()
  const gitDir = dirname(execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim())
  if (existsSync(join(gitDir, 'grok'))) return // a real grok sits beside git: nothing to prove here
  const out = walk(dir, [...BASE, '--run'], { PATH: gitDir })
  assert.equal(out.status, 1)
  assert.match(out.stderr, /grok/)
  assert.ok(!existsSync(join(dir, 'docs', 'reviews', 'inbox', 'WALK-001-grok.md')))
})

// --- WebSockets: context.route never sees them, so a write over one would pass the guard ----------------------

test('installGuard: a WebSocket is closed before it reaches the server and recorded without its query', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'walk-ws-'))
  const c = fakeContext()
  const guard = await installGuard(c, { dir })
  assert.equal(typeof c.socketHandler, 'function', 'sockets are routed')
  let closed = false
  let connected = false
  await c.socketHandler({ url: () => 'wss://rt.example.test/socket?token=abc123', close: async () => (closed = true), connectToServer: () => (connected = true) })
  assert.equal(closed, true)
  assert.equal(connected, false)
  const s = guard.summary()
  assert.deepEqual(s.blockedWebSockets, ['wss rt.example.test/socket'])
  assert.equal(s.webSockets, 'blocked')
  assert.ok(!JSON.stringify(s).includes('abc123'), 'never the query')
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')).blockedWebSockets, ['wss rt.example.test/socket'])
})

test('installGuard: allowWebSockets leaves sockets alone; a Playwright that cannot route them says so', async () => {
  const c = fakeContext()
  const allowed = await installGuard(c, { allowWebSockets: true })
  assert.equal(c.socketHandler, null)
  assert.equal(allowed.summary().webSockets, 'allowed')

  const old = fakeContext()
  delete old.routeWebSocket
  const unguarded = await installGuard(old, {})
  assert.equal(unguarded.summary().webSockets, 'unguarded')
  assert.match(unguarded.summary().guardFailures.join(' '), /WebSockets unguarded/)
})

test('walk.mjs: walk.allowWebSockets reaches the options as a boolean; anything else is refused', () => {
  const ok = walk(project({ config: { walk: { allowWebSockets: true } } }), BASE)
  assert.equal(ok.status, 0, ok.stderr)
  assert.equal(optionsOf(folderOf(ok.stdout)).allowWebSockets, true)
  const off = walk(project({}), BASE)
  assert.equal(optionsOf(folderOf(off.stdout)).allowWebSockets, false)
  const bad = walk(project({ config: { walk: { allowWebSockets: 'yes' } } }), BASE)
  assert.equal(bad.status, 2)
  assert.match(bad.stderr, /walk\.allowWebSockets/)
})

// --- RV-020 (Codex): each finding pinned ---------------------------------------------------------------------

test('RV-020 F4: a DELETE, PUT or PATCH to Google is a write, and so is an unknown POST to Maps; Routes and Places POSTs still count', () => {
  for (const method of ['DELETE', 'PUT', 'PATCH']) assert.equal(classify(method, 'https://routes.googleapis.com/v1/projects/p/operations/x'), 'write', method)
  assert.equal(classify('POST', 'https://maps.googleapis.com/new-billed-api'), 'write')
  assert.equal(classify('GET', 'https://maps.googleapis.com/new-read-api'), 'unclassified-google')
  assert.equal(classify('POST', 'https://routes.googleapis.com/directions/v2:computeRoutes'), 'billed:routes')
  assert.equal(classify('POST', 'https://places.googleapis.com/$rpc/google.maps.places.v1.Places/AutocompletePlaces'), 'billed:places') // RV-022 F2
  const b = createBudget()
  assert.equal(b.decide(classify('DELETE', 'https://routes.googleapis.com/x'), 'DELETE', 'https://routes.googleapis.com/x'), 'abort')
})

test('RV-020 F3: two pages building maps before the guard catches up are written down as a guard failure, never hidden', () => {
  const b = createBudget()
  const wins = [{ __walkBudgetLeft: 12 }, { __walkBudgetLeft: 12 }]
  for (const w of wins) {
    installMapCounter(w, () => b.mapLoad())
    w.google = { maps: { Map: class {} } }
    for (let i = 0; i < 7; i++) new w.google.maps.Map()
  }
  assert.equal(b.billed(), 14)
  assert.equal(b.state.guardFailures.filter((f) => f.startsWith('a map load past the cap')).length, 2)
  assert.equal(b.decide('maps-internal', 'GET', 'https://maps.googleapis.com/maps/vt?x=1'), 'abort', 'every Google request stops once the cap is reached')
})

test('RV-021 F2: legacy Directions stops at the routes cap, and an unclassified Google request that completes anyway is a guard failure', () => {
  const b = createBudget({ routesCap: 3 })
  const u = 'https://maps.googleapis.com/maps/api/js/DirectionsService.Route?5m'
  const outcomes = [1, 2, 3, 4].map(() => b.decide(classify('GET', u), 'GET', u))
  assert.deepEqual(outcomes, ['continue', 'continue', 'continue', 'abort'])
  assert.equal(b.state.routes, 3)
  assert.equal(slippedPast('unclassified-google', 'abort'), true)
})

test('RV-022 F3: the other Maps Platform hosts are billed, any other googleapis.com host is blocked unless the project names it', () => {
  const roads = 'https://roads.googleapis.com/v1/snapToRoads?path=1,2|3,4'
  assert.equal(classify('GET', roads), 'billed:other')
  assert.equal(classify('POST', 'https://addressvalidation.googleapis.com/v1:validateAddress'), 'billed:other')
  assert.equal(classify('DELETE', roads), 'write')
  const b = createBudget()
  for (let i = 0; i < 12; i++) b.mapLoad()
  assert.equal(b.decide(classify('GET', roads), 'GET', roads), 'abort', 'past the cap, Roads stops too')
  const yt = 'https://youtube.googleapis.com/youtube/v3/videos?id=x'
  assert.equal(classify('GET', yt), 'unclassified-google')
  assert.equal(classify('GET', yt, { googleHosts: ['youtube.googleapis.com'] }), 'read')
  assert.equal(classify('GET', 'https://fonts.googleapis.com/css2?family=Inter'), 'read')
  assert.throws(() => checkGoogleHosts(['roads.googleapis.com']), /billed Maps host/)
  assert.throws(() => checkGoogleHosts(['evil.example.com']), /googleapis\.com hostname/)
})

test('walk.mjs: walk.allowGoogleHosts reaches the options; a Maps host there is refused', () => {
  const ok = walk(project({ config: { walk: { allowGoogleHosts: ['firestore.googleapis.com'] } } }), BASE)
  assert.equal(ok.status, 0, ok.stderr)
  assert.deepEqual(optionsOf(folderOf(ok.stdout)).googleHosts, ['firestore.googleapis.com'])
  const bad = walk(project({ config: { walk: { allowGoogleHosts: ['tile.googleapis.com'] } } }), BASE)
  assert.equal(bad.status, 2)
  assert.match(bad.stderr, /billed Maps host/)
})

test('RV-023 F3: tracking pixels and self-hosted analytics are blocked on any method; a project adds its own with walk.blockHosts', () => {
  for (const u of ['https://www.facebook.com/tr/?id=123&ev=PageView', 'https://api.mixpanel.com/track/?data=abc', 'https://example.test/matomo.php?idsite=1&rec=1', 'https://us.i.posthog.com/e/', 'https://www.clarity.ms/tag/x']) {
    assert.equal(classify('GET', u), 'analytics', u)
    assert.equal(createBudget().decide('analytics', 'GET', u), 'abort')
  }
  assert.equal(classify('GET', 'https://www.facebook.com/somepage'), 'read', 'only the pixel path, not the site')
  assert.equal(classify('GET', 'https://chat.example.test/x', { blockHosts: ['chat.example.test'] }), 'analytics')
  assert.throws(() => checkBlockHosts(['not a host']), /bare hostname/)
})

test('walk.mjs: walk.blockHosts reaches the options; a bad one is refused', () => {
  const ok = walk(project({ config: { walk: { blockHosts: ['widget.example.test'] } } }), BASE)
  assert.equal(ok.status, 0, ok.stderr)
  assert.deepEqual(optionsOf(folderOf(ok.stdout)).blockHosts, ['widget.example.test'])
  const bad = walk(project({ config: { walk: { blockHosts: ['https://x.test/'] } } }), BASE)
  assert.equal(bad.status, 2)
  assert.match(bad.stderr, /walk\.blockHosts/)
})
