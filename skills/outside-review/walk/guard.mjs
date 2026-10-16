// The walk guard. walk.mjs (written into a scratch folder by scripts/walk.mjs) imports this file from the plugin by
// absolute path, so the rules below are the plugin's, not a copy the walker can edit. It holds the Maps budget (by
// default at most 3 computeRoutes and 12 billed Google requests per walk), blocks every write except the read-only
// POSTs the project allows, keeps walks out of analytics, and audits what actually went out. It stops accidents; it is
// not a sandbox.
//
// Billed means Routes computeRoutes, Places details (GetPlace; Autocomplete is free inside its session), geocoding,
// and map loads (counted in the page, where a map is constructed). Every other Google Maps Platform request (JS
// chunks, tiles, gen_204, StaticMapService, GetViewportInfo) is part of a map load. A Google path not named here is
// reported as unclassified, so a new billed API shows up instead of passing silently.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const ROUTES_CAP = 3
export const BILLED_CAP = 12
export const GOOGLE_HOSTS = ['maps.googleapis.com', 'routes.googleapis.com', 'places.googleapis.com']
// The other Maps Platform services: every call to them is billed (RV-022 F3: Roads went through as a read)
export const MAPS_PLATFORM_HOSTS = ['roads', 'addressvalidation', 'airquality', 'pollen', 'solar', 'routeoptimization', 'tile', 'aerialview', 'weather', 'mapsplatformdatasets'].map((h) => h + '.googleapis.com')
// Google hosts that serve ordinary reads; any other *.googleapis.com host is blocked unless the project names it
const GOOGLE_READ_HOSTS = ['fonts.googleapis.com', 'storage.googleapis.com', 'ajax.googleapis.com']
// Analytics and session recording: a walk is not a visitor, so it never reaches them (RV-023 F3: five hosts were not
// enough). A project adds its own with walk.blockHosts
const ANALYTICS = [
  'google-analytics.com', 'googletagmanager.com', 'analytics.google.com', 'doubleclick.net', 'googleadservices.com', 'sentry.io',
  'connect.facebook.net', 'mixpanel.com', 'segment.io', 'segment.com', 'amplitude.com', 'heapanalytics.com', 'posthog.com',
  'plausible.io', 'clarity.ms', 'hotjar.com', 'hotjar.io', 'fullstory.com', 'logrocket.io', 'lr-ingest.io', 'mouseflow.com',
  'crazyegg.com', 'bat.bing.com', 'px.ads.linkedin.com', 'analytics.tiktok.com', 'tr.snapchat.com', 'analytics.twitter.com',
  'browser-intake-datadoghq.com', 'nr-data.net', 'bugsnag.com', 'intercom.io', 'rollbar.com', 'quantserve.com', 'scorecardresearch.com',
]
// Pixels on hosts that also serve real pages, and self-hosted analytics on any host
const ANALYTICS_PATHS = [
  { host: 'facebook.com', path: /^\/tr\/?$/ },
  { host: 't.co', path: /^\/i\/adsct/ },
  { host: null, path: /(?:^|\/)(?:matomo|piwik)\.(?:php|js)$/ },
]
const READ_METHODS = ['GET', 'HEAD', 'OPTIONS']
const MAPS_INTERNAL = [
  /^\/maps-api-v3\/api\/js\//,
  /^\/maps\/api\/js$/,
  /^\/maps\/vt/,
  /^\/maps\/api\/mapsjs\/gen_204/,
  /^\/maps\/api\/js\/StaticMapService\.GetMapImage/,
  /^\/maps\/api\/js\/AuthenticationService\.Authenticate/,
  /MapsJsInternalService\/GetViewportInfo$/,
  /^\/maps\/api\/js\/QuotaService\.RecordEvent/,
  /^\/maps\/api\/js\/ViewportInfoService\.GetViewportInfo/,
]
// The legacy services the Maps JS API still bills (RV-021 F2: DirectionsService ran unbudgeted): Directions and
// Distance Matrix count as routes, Elevation as billed, the legacy Places library as places
const LEGACY_ROUTES = /^\/maps\/api\/(?:js\/(?:DirectionsService|DistanceMatrixService)\.|directions\/|distancematrix\/)/
const LEGACY_PLACES = /^\/maps\/api\/place\//
const ELEVATION = /^\/maps\/api\/(?:js\/ElevationService\.|elevation\/)/

const endsWithHost = (host, base) => host === base || host.endsWith('.' + base)

// A rule's regex is used as written (anchor it with ^ and $); one that does not compile matches nothing
function pathMatches(pattern, pathname) {
  try {
    return new RegExp(pattern).test(pathname)
  } catch {
    return false
  }
}

// Read-only POSTs the project allows: [{ host, path }], path a regex string tested against the URL pathname.
// Throws on what cannot be a rule, so a typo stops the walk before it starts instead of blocking quietly
export function checkReadPosts(rules) {
  if (!Array.isArray(rules)) throw new Error('read-post rules must be a list of { host, path }')
  return rules.map((rule, i) => {
    const n = 'read-post rule ' + (i + 1)
    const host = typeof rule?.host === 'string' ? rule.host.trim().toLowerCase() : ''
    const path = typeof rule?.path === 'string' ? rule.path.trim() : ''
    if (!host || /[\s/@]/.test(host)) throw new Error(n + ': host must be a bare host such as api.example.com (a port is allowed), got ' + JSON.stringify(rule?.host))
    if (!path) throw new Error(n + ': path must be a regular expression for the URL pathname')
    try {
      new RegExp(path)
    } catch (err) {
      throw new Error(n + ': path is not a regular expression: ' + err.message)
    }
    return { host, path }
  })
}

// Google hosts the project's own reads need (Firebase, YouTube): bare hostnames under googleapis.com, never a Maps
// Platform host, which is billed whatever the project says
export function checkGoogleHosts(hosts) {
  if (!Array.isArray(hosts)) throw new Error('allowGoogleHosts must be a list of hostnames')
  return hosts.map((h, i) => {
    const host = typeof h === 'string' ? h.trim().toLowerCase() : ''
    if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.googleapis\.com$/.test(host)) throw new Error('allowGoogleHosts ' + (i + 1) + ': a googleapis.com hostname, got ' + JSON.stringify(h))
    if (GOOGLE_HOSTS.includes(host) || MAPS_PLATFORM_HOSTS.includes(host)) throw new Error('allowGoogleHosts ' + (i + 1) + ': ' + host + ' is a billed Maps host and stays in the budget')
    return host
  })
}

// Hosts the project wants kept out of a walk entirely (its own analytics, a chat widget): bare hostnames
export function checkBlockHosts(hosts) {
  if (!Array.isArray(hosts)) throw new Error('blockHosts must be a list of hostnames')
  return hosts.map((h, i) => {
    const host = typeof h === 'string' ? h.trim().toLowerCase() : ''
    if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host)) throw new Error('blockHosts ' + (i + 1) + ': a bare hostname, got ' + JSON.stringify(h))
    return host
  })
}

// The caps for one walk: positive whole numbers only, anything not given keeps the owner's default
export function checkBudget(budget = {}) {
  if (!budget || typeof budget !== 'object' || Array.isArray(budget)) throw new Error('budget must be { routes, billed }')
  for (const key of Object.keys(budget)) if (key !== 'routes' && key !== 'billed') throw new Error('budget.' + key + ' is not a setting (use routes and billed)')
  const pick = (key, fallback) => {
    const value = budget[key]
    if (value === undefined) return fallback
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('budget.' + key + ' must be a positive whole number, got ' + JSON.stringify(value))
    return value
  }
  return { routes: pick('routes', ROUTES_CAP), billed: pick('billed', BILLED_CAP) }
}

// One request's kind. `readPosts` and `googleHosts` are the walk's own (options, never read from the project's files here)
export function classify(method, url, { readPosts = [], googleHosts = [], blockHosts = [] } = {}) {
  let u
  try {
    u = new URL(url)
  } catch {
    return 'read'
  }
  if (u.protocol === 'data:' || u.protocol === 'blob:') return 'read'
  const host = u.hostname.replace(/\.$/, '')
  if ([...ANALYTICS, ...blockHosts].some((a) => endsWithHost(host, a))) return 'analytics'
  if (ANALYTICS_PATHS.some((a) => (a.host === null || endsWithHost(host, a.host)) && a.path.test(u.pathname))) return 'analytics'
  if (MAPS_PLATFORM_HOSTS.includes(host)) return READ_METHODS.includes(method) && method !== 'GET' ? 'maps-internal' : method === 'GET' || method === 'POST' ? 'billed:other' : 'write'
  // Default-deny the rest of googleapis.com: an unknown Google API could be billed, and its GET is listed until named
  if (endsWithHost(host, 'googleapis.com') && !GOOGLE_HOSTS.includes(host) && !GOOGLE_READ_HOSTS.includes(host) && !googleHosts.includes(host)) {
    return READ_METHODS.includes(method) ? (method === 'GET' ? 'unclassified-google' : 'maps-internal') : 'write'
  }
  if (GOOGLE_HOSTS.includes(host)) {
    // Default-deny first (RV-020 F4): the Maps JS API reads with GET and POST (Routes and Places are gRPC-web POSTs);
    // a DELETE, PUT or PATCH to Google is a write like any other
    if (!READ_METHODS.includes(method) && method !== 'POST') return 'write'
    if (method === 'OPTIONS') return 'maps-internal'
    if (host === 'routes.googleapis.com') return 'billed:routes'
    // Autocomplete is billed per request unless its session ends in a Details call, which the browser can't show us, so
    // it counts (RV-022 F2: thirteen ran free)
    if (host === 'places.googleapis.com') return 'billed:places'
    if (/^\/maps\/api\/js\/GeocodeService\.|^\/maps\/api\/geocode/.test(u.pathname)) return 'billed:geocode'
    if (LEGACY_ROUTES.test(u.pathname)) return 'billed:routes'
    if (LEGACY_PLACES.test(u.pathname)) return 'billed:places'
    if (ELEVATION.test(u.pathname)) return 'billed:other'
    if (MAPS_INTERNAL.some((re) => re.test(u.pathname))) return 'maps-internal'
    // An unknown POST to Maps could be a write; an unknown GET could be a billed service nobody classified. Either way
    // it is blocked: a write as a write, a GET listed as unclassified until it is named here (RV-021 F2)
    return method === 'POST' ? 'write' : 'unclassified-google'
  }
  if (READ_METHODS.includes(method)) return 'read'
  // Default-deny: a POST is a read only when a rule names its host (or host:port) and its path
  if (method === 'POST' && readPosts.some((r) => (r.host === host || r.host === u.host) && pathMatches(r.path, u.pathname))) return 'read-post'
  return 'write'
}

// The walk's counts and caps: decide() says continue or abort for one classified request and records it. Pure state, no Playwright
export function createBudget({ routesCap = ROUTES_CAP, billedCap = BILLED_CAP } = {}) {
  const s = { routes: 0, places: 0, geocode: 0, other: 0, mapLoads: 0, abortedOverCap: [], blockedWrites: [], blockedAnalytics: [], blockedWebSockets: [], unclassifiedGoogle: [], guardFailures: [] }
  const billed = () => s.routes + s.places + s.geocode + s.other + s.mapLoads
  // Method and path only, never a query or a body: those can carry tokens
  const where = (method, url) => {
    try {
      const u = new URL(url)
      return method + ' ' + u.hostname + u.pathname
    } catch {
      return method + ' ' + url
    }
  }
  const over = (method, url) => {
    s.abortedOverCap.push(where(method, url))
    return 'abort'
  }
  return {
    state: s,
    billed,
    left: () => Math.max(0, billedCap - billed()),
    decide(kind, method, url) {
      if (kind === 'analytics') {
        s.blockedAnalytics.push(where(method, url))
        return 'abort'
      }
      if (kind === 'write') {
        s.blockedWrites.push(where(method, url))
        return 'abort'
      }
      if (kind === 'read' || kind === 'read-post') return 'continue'
      if (billed() >= billedCap) return over(method, url) // every Google Maps Platform request once the budget is spent
      if (kind === 'billed:routes') {
        if (s.routes >= routesCap) return over(method, url)
        s.routes += 1
        return 'continue'
      }
      if (kind === 'billed:places') {
        s.places += 1
        return 'continue'
      }
      if (kind === 'billed:geocode') {
        s.geocode += 1
        return 'continue'
      }
      if (kind === 'billed:other') {
        s.other += 1
        return 'continue'
      }
      if (kind === 'unclassified-google') {
        s.unclassifiedGoogle.push(where(method, url))
        return 'abort'
      }
      return 'continue'
    },
    // A map constructed in the page (the counter reports it; the page has already taken it off its own copy of what is left)
    // Each page holds its own copy of what is left until the guard's update reaches it, so two pages building maps at
    // the same moment can pass the cap (RV-020 F3). Every Google request is aborted once it is reached, and a load past
    // it is written down, never hidden
    mapLoad() {
      if (billed() >= billedCap) {
        s.abortedOverCap.push('a map load past the cap')
        s.guardFailures.push('a map load past the cap: two pages built maps before the guard caught up (' + (billed() + 1) + ' of ' + billedCap + ')')
      }
      s.mapLoads += 1
    },
  }
}

// Runs IN THE PAGE (installGuard injects its source): synchronous defineProperty traps on window.google, then its maps,
// then maps.Map, so the wrap takes before any map is built. Each construction reads win.__walkBudgetLeft, throws at 0,
// else takes one off and reports the load. Self-contained on purpose: it is serialized with Function#toString
export function installMapCounter(win, onLoad) {
  const wrap = (Orig) => {
    if (typeof Orig !== 'function' || Orig.__walkCounted) return Orig
    function Counted(...args) {
      const left = typeof win.__walkBudgetLeft === 'number' ? win.__walkBudgetLeft : 0
      if (left <= 0) throw new Error('walk budget: map loads')
      win.__walkBudgetLeft = left - 1
      win.__walkMapLoads = (win.__walkMapLoads || 0) + 1
      onLoad(win.__walkMapLoads)
      return Reflect.construct(Orig, args, new.target || Counted)
    }
    Counted.prototype = Orig.prototype
    Object.setPrototypeOf(Counted, Orig)
    Object.defineProperty(Counted, '__walkCounted', { value: true })
    return Counted
  }
  const trap = (obj, key, onValue) => {
    let value = obj[key]
    if (value !== undefined) value = onValue(value)
    Object.defineProperty(obj, key, {
      configurable: true,
      enumerable: true,
      get: () => value,
      set: (v) => {
        value = onValue(v)
      },
    })
  }
  trap(win, 'google', (g) => {
    if (g && typeof g === 'object') {
      trap(g, 'maps', (m) => {
        if (m && typeof m === 'object') trap(m, 'Map', wrap)
        return m
      })
    }
    return g
  })
}

// The audit's rule: a request the guard should have stopped (or never saw) that completed anyway
export function slippedPast(kind, decision) {
  const guarded = kind === 'write' || kind === 'analytics' || kind === 'unclassified-google' || kind.startsWith('billed:')
  return guarded && decision !== 'continue' // aborted yet completed, or never seen by the guard's route at all
}

// Wires the guard into a Playwright BrowserContext (popups and iframes included). `dir` gets summary.json after every
// recorded event. `budget` is { routes, billed }; `readPosts` is the project's read-only POST rules; `allowWebSockets`
// lets sockets through (they are closed otherwise)
export async function installGuard(context, { readPosts = [], googleHosts = [], blockHosts = [], budget: caps = {}, allowWebSockets = false, dir, shas = {} } = {}) {
  const rules = checkReadPosts(readPosts)
  const hosts = checkGoogleHosts(googleHosts)
  const blocked = checkBlockHosts(blockHosts)
  const limits = checkBudget(caps)
  const budget = createBudget({ routesCap: limits.routes, billedCap: limits.billed })
  const decisions = new WeakMap()
  const shots = []
  let webSockets = allowWebSockets ? 'allowed' : 'blocked'
  const summary = () => ({ ...budget.state, billed: budget.billed(), caps: limits, readPostRules: rules, googleHosts: hosts, blockHosts: blocked, webSockets, shots, guardSha256: shas.guard ?? null, templateSha256: shas.template ?? null })
  const write = () => {
    if (dir) writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary(), null, 2))
  }
  const pushLeft = async () => {
    const left = budget.left()
    await context.addInitScript('window.__walkBudgetLeft = ' + left + ';')
    await Promise.all(context.pages().map((p) => p.evaluate((v) => (window.__walkBudgetLeft = v), left).catch(() => {})))
  }
  await context.exposeBinding('__walkMapLoad', async () => {
    budget.mapLoad()
    write()
    await pushLeft()
  })
  await context.addInitScript('window.__walkBudgetLeft = ' + budget.left() + '; (' + installMapCounter.toString() + ')(window, (n) => window.__walkMapLoad(n));')
  await context.route('**/*', async (route) => {
    const req = route.request()
    const kind = classify(req.method(), req.url(), { readPosts: rules, googleHosts: hosts, blockHosts: blocked })
    const before = budget.billed()
    const decision = budget.decide(kind, req.method(), req.url())
    decisions.set(req, decision)
    if (decision === 'abort' || budget.billed() !== before) write()
    if (budget.billed() !== before) await pushLeft()
    return decision === 'abort' ? route.abort('blockedbyclient') : route.continue()
  })
  // A WebSocket never passes context.route, so a write over one (Firebase, a realtime API) would go straight through.
  // Closed before it reaches the server, unless the project allows sockets; a Playwright too old to route them says so
  if (!allowWebSockets) {
    if (typeof context.routeWebSocket === 'function') {
      await context.routeWebSocket(/.*/, async (ws) => {
        try {
          const u = new URL(ws.url())
          budget.state.blockedWebSockets.push(u.protocol.replace(':', '') + ' ' + u.hostname + u.pathname)
        } catch {
          budget.state.blockedWebSockets.push('(a socket with no readable URL)')
        }
        write()
        await ws.close()
      })
    } else {
      webSockets = 'unguarded'
      budget.state.guardFailures.push('WebSockets unguarded: this Playwright has no routeWebSocket (1.48 or later routes them)')
    }
  }
  context.on('requestfinished', (req) => {
    const kind = classify(req.method(), req.url(), { readPosts: rules, googleHosts: hosts, blockHosts: blocked })
    if (['read', 'read-post', 'maps-internal'].includes(kind)) return
    if (slippedPast(kind, decisions.get(req))) {
      const u = new URL(req.url())
      budget.state.guardFailures.push('completed past the guard: ' + req.method() + ' ' + u.hostname + u.pathname)
      write()
    }
  })
  write()
  return {
    summary,
    shot: (name) => {
      shots.push(name)
      write()
    },
    // After the walk: more map roots than counted constructions means a map was built before the counter took
    async finish(page) {
      const roots = await page.evaluate(() => document.querySelectorAll('.gm-style').length).catch(() => 0)
      if (roots > budget.state.mapLoads) budget.state.guardFailures.push('a map built before the counter (' + roots + ' map roots, ' + budget.state.mapLoads + ' counted)')
      write()
    },
  }
}
