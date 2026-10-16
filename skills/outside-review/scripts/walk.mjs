#!/usr/bin/env node
// The walker's relay. A walker is an independent model (Grok by default) that uses the DEPLOYED build of a web app as
// one real person doing one task, logged out, at a phone viewport, on real data, without reading the spec. This writes
// a scratch folder for one walk and starts it there, or prints the command that does:
//
//   node walk.mjs --url <url> --person "<who>" --task "<task>" [--repo <dir>] [--staging <origin>] [--prod-readonly]
//                 [--desktop] [--storage-state <file>] [--skip "<check>"]... [--read-post "<host> <pathRegex>"]... [--run]
//
// Grok has no browser tool, so the folder holds a Playwright script (walk.mjs) it runs through Bash, editing only its
// steps(), and the brief (walk.md, built from ../walker.md). The script, not the prompt, holds the guardrails: it
// imports ../walk/guard.mjs by absolute path, so the viewport, the write block, the analytics block and the Maps
// budget are the plugin's, not a copy the walker can edit. Playwright is the walked project's own.
//
//  - a walk may START only on localhost or the exact --staging origin unless --prod-readonly is typed; the guard
//    holds every origin read-only either way
//  - every write is blocked (anything but GET, HEAD, OPTIONS) except POSTs a rule allows: --read-post flags and
//    .claude/review.json "walk.readPosts" [{ host, path }]; with no rules every non-GET is a blocked write
//  - Maps budget per walk: 3 computeRoutes and 12 billed requests, or .claude/review.json "walk.budget" { routes, billed }
//  - --run runs grok (30 minutes at most) and saves its answer verbatim in docs/reviews/inbox/WALK-NNN-grok.md,
//    beside a .meta.json that pins what ran. Without it, the grok command is printed. Importing this file runs nothing
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { args, die, repoRoot, reviewDirs, sha } from './lib.mjs'
import { checkBlockHosts, checkBudget, checkGoogleHosts, checkReadPosts } from '../walk/guard.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const GUARD = join(HERE, '..', 'walk', 'guard.mjs')
const TEMPLATE = join(HERE, '..', 'walk', 'walk-template.mjs')
const BRIEF = join(HERE, '..', 'walker.md')
const SKIP_PHRASE = 'skip the standing checks listed'
const FLAGS = ['url', 'person', 'task', 'repo', 'staging', 'prod-readonly', 'desktop', 'storage-state', 'skip', 'read-post', 'run']
const GROK_MINUTES = 30

const oneLine = (text) => String(text).replace(/\s+/g, ' ').trim()

// The brief with its Setup line rebuilt from the flags and the skip list filled, then the walk's own lines.
// Throws naming a missing or repeated anchor
export function buildWalkPrompt(brief, { url, person, task, desktop = false, signedIn = false, skip = [] }) {
  const lines = brief.replace(/\n+$/, '').split('\n')
  const setups = lines.flatMap((line, i) => (line.startsWith('Setup:') ? [i] : []))
  if (setups.length !== 1) throw new Error('walker.md: the "Setup:" line is not found exactly once')
  if (brief.split(SKIP_PHRASE).length !== 2) throw new Error('walker.md: the "' + SKIP_PHRASE + '" phrase is not found exactly once')
  const who = signedIn ? 'signed in with the session you were given' : 'logged out'
  const screen = desktop ? 'desktop (1440px)' : 'phone viewport (390px)'
  lines[setups[0]] = `Setup: ${url}, as ${oneLine(person)}, ${who}, ${screen}, one task ("${oneLine(task)}"). Real data. No fixtures.`
  const skips = skip.map(oneLine).filter(Boolean)
  const body = lines.join('\n').replace(SKIP_PHRASE, () => SKIP_PHRASE + ': ' + (skips.length ? skips.join('; ') : 'none'))
  return (
    body +
    `\n\nStay on ${new URL(url).origin}; if the address leaves it, say so and stop. A map or lookup left blank by the budget is expected, not a finding; ` +
    "so is a write or a WebSocket the guard blocked. Write your steps in steps() in walk.mjs and run `node walk.mjs`; take screenshots with `await shot('name')` and read them " +
    'from ./shots. The guard stops accidents; it is not a sandbox, so edit only steps(): leave the guard import and the routes it installs alone.\n'
  )
}

// Why a start URL may not be walked (null: it may). A bad URL, a non-http(s) one or one with userinfo is refused even with --prod-readonly
export function startUrlProblem(url, staging, prodReadonly) {
  let u
  try {
    u = new URL(url)
  } catch {
    return `--url ${JSON.stringify(url)} is not a URL`
  }
  if (!['http:', 'https:'].includes(u.protocol)) return `--url must be http: or https: (got ${u.protocol})`
  if (u.username || u.password) return '--url must not carry a username or password'
  let stagingOrigin = null
  if (staging !== undefined) {
    let s
    try {
      s = new URL(staging)
    } catch {
      return `--staging ${JSON.stringify(staging)} is not a URL`
    }
    if (s.protocol !== 'https:' || s.username || s.password || !['/', ''].includes(s.pathname) || s.search || s.hash) {
      return '--staging must be an https origin only (no path, query, hash or userinfo)'
    }
    stagingOrigin = s.origin
  }
  const walkable = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || (stagingOrigin !== null && u.origin === stagingOrigin)
  return walkable || prodReadonly ? null : `--url ${u.origin} is not localhost or the --staging origin; a walk there needs --prod-readonly`
}

// "<host> <pathRegex>" from --read-post: the host, then everything after the first run of spaces
export function parseReadPost(text) {
  const m = typeof text === 'string' ? text.trim().match(/^(\S+)\s+(\S[\s\S]*)$/) : null
  if (!m) throw new Error('--read-post needs "<host> <pathRegex>", for example --read-post "api.example.com ^/rpc/search$"')
  try {
    return checkReadPosts([{ host: m[1], path: m[2] }])[0]
  } catch (err) {
    throw new Error('--read-post ' + JSON.stringify(text) + ': ' + err.message)
  }
}

// The walk's settings in a project's .claude/review.json (the parsed file). Throws on anything that is not a rule or a cap
function walkSettings(config) {
  const walk = config?.walk
  if (walk === undefined) return { readPosts: [], googleHosts: [], blockHosts: [], budget: checkBudget(), allowWebSockets: false }
  if (!walk || typeof walk !== 'object' || Array.isArray(walk)) throw new Error('walk must be an object')
  const wrap = (prefix, fn) => {
    try {
      return fn()
    } catch (err) {
      throw new Error(prefix + err.message)
    }
  }
  return {
    readPosts: wrap('walk.readPosts: ', () => checkReadPosts(walk.readPosts ?? [])),
    googleHosts: wrap('walk.', () => checkGoogleHosts(walk.allowGoogleHosts ?? [])),
    blockHosts: wrap('walk.', () => checkBlockHosts(walk.blockHosts ?? [])),
    budget: wrap('walk.', () => checkBudget(walk.budget)),
    allowWebSockets: wrap('', () => {
      if (walk.allowWebSockets === undefined) return false
      if (typeof walk.allowWebSockets !== 'boolean') throw new Error('walk.allowWebSockets must be true or false, got ' + JSON.stringify(walk.allowWebSockets))
      return walk.allowWebSockets
    }),
  }
}

// Playwright is the walked project's own: playwright, else @playwright/test, found the way the walk will find it
function hasPlaywright(dir) {
  const req = createRequire(join(dir, 'package.json'))
  for (const name of ['playwright', '@playwright/test']) {
    try {
      req.resolve(name)
      return true
    } catch {
      // not installed under this name: try the next
    }
  }
  return false
}

// One past the highest WALK-NNN in the inbox. 'wx' never overwrites an answer another walk saved in the meantime
function saveAnswer(inbox, response) {
  for (;;) {
    let max = 0
    for (const name of readdirSync(inbox)) {
      const m = name.match(/^WALK-(\d+)/)
      if (m) max = Math.max(max, Number(m[1]))
    }
    const id = 'WALK-' + String(max + 1).padStart(3, '0')
    try {
      writeFileSync(join(inbox, id + '-grok.md'), response, { flag: 'wx' })
      return id
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
    }
  }
}

function main() {
  const a = args()
  for (const key of Object.keys(a)) if (key !== '_' && !FLAGS.includes(key)) die('unknown flag --' + key, 2)
  if (a._.length) die('unexpected argument ' + JSON.stringify(a._[0]) + ' (this takes flags only)', 2)
  for (const need of ['url', 'person', 'task']) if (a[need] === undefined) die('--' + need + ' is required', 2)
  const one = (name) => {
    const value = a[name]
    if (value === undefined) return undefined
    if (typeof value !== 'string') die(Array.isArray(value) ? `--${name} was given more than once` : `--${name} needs a value`, 2)
    return value
  }
  const many = (name) => {
    const list = [].concat(a[name] ?? [])
    if (list.some((v) => typeof v !== 'string')) die(`--${name} needs a value`, 2)
    return list
  }
  const bool = (name) => {
    if (a[name] === undefined) return false
    if (a[name] !== true) die(`--${name} takes no value (got ${JSON.stringify(a[name])})`, 2)
    return true
  }
  const url = one('url')
  const person = one('person')
  const task = one('task')
  const staging = one('staging')
  const desktop = bool('desktop')
  const prodReadonly = bool('prod-readonly')
  const run = bool('run')
  const skip = many('skip')
  for (const [name, value] of [['url', url], ['person', person], ['task', task]]) if (!value.trim()) die('--' + name + ' is required', 2)

  const problem = startUrlProblem(url, staging, prodReadonly)
  if (problem) die(problem, 2)
  if (startUrlProblem(url, staging, false)) console.log('PROD READ-ONLY: ' + new URL(url).origin)

  let storageState = null
  if (one('storage-state') !== undefined) {
    storageState = resolve(one('storage-state'))
    let state
    try {
      state = JSON.parse(readFileSync(storageState, 'utf8'))
    } catch {
      die('not a usable storage state: ' + storageState, 2)
    }
    const has = (key) => Array.isArray(state?.[key]) && state[key].length > 0
    if (!state || typeof state !== 'object' || !(has('cookies') || has('origins'))) die('not a usable storage state: ' + storageState, 2)
  }

  const dir = resolve(one('repo') ?? process.cwd())
  const repo = repoRoot(dir)
  let settings
  const configFile = join(repo, '.claude', 'review.json')
  try {
    let config = {}
    if (existsSync(configFile)) {
      try {
        config = JSON.parse(readFileSync(configFile, 'utf8'))
      } catch {
        throw new Error(configFile + ' is not valid JSON')
      }
    }
    settings = walkSettings(config)
  } catch (err) {
    return die(err.message.startsWith(configFile) ? err.message : configFile + ': ' + err.message, 2)
  }
  // Flags first, then the project's own; the same rule twice counts once
  let readPosts = []
  try {
    readPosts = many('read-post').map(parseReadPost)
  } catch (err) {
    return die(err.message, 2)
  }
  const seen = new Set()
  readPosts = [...readPosts, ...settings.readPosts].filter((r) => !seen.has(r.host + ' ' + r.path) && seen.add(r.host + ' ' + r.path))
  const budget = settings.budget

  const packageJson = join(dir, 'package.json')
  if (!hasPlaywright(dir)) die(`Playwright is not installed in ${dir}: playwright or @playwright/test must resolve from its package.json to walk it (npm i -D playwright)`, 2)

  const folder = mkdtempSync(join(tmpdir(), 'walk-'))
  if ((realpathSync(folder) + sep).startsWith(realpathSync(repo) + sep)) {
    rmSync(folder, { recursive: true, force: true })
    die(`the walk folder ${folder} is inside the repository; set TMPDIR outside it`, 2)
  }
  const fail = (message) => {
    rmSync(folder, { recursive: true, force: true })
    die(message, 1)
  }

  let prompt
  try {
    prompt = buildWalkPrompt(readFileSync(BRIEF, 'utf8'), { url, person, task, desktop, signedIn: storageState !== null, skip })
  } catch (err) {
    fail(err.message)
  }
  // Each placeholder in the template becomes a JSON value (JSON is valid JS), never text spliced into a string
  const values = {
    __WALK_GUARD_PATH__: GUARD,
    __WALK_REPO_PACKAGE_JSON__: packageJson,
    __WALK_OPTIONS_JSON__: { url, readPosts, googleHosts: settings.googleHosts, blockHosts: settings.blockHosts, budget, allowWebSockets: settings.allowWebSockets, desktop, storageState },
  }
  const script = readFileSync(TEMPLATE, 'utf8').replace(/__WALK_[A-Z_]+__/g, (token) => {
    if (!(token in values)) fail('walk.mjs: unknown template token ' + token)
    return JSON.stringify(values[token])
  })
  const promptFile = join(folder, 'walk.md')
  writeFileSync(join(folder, 'walk.mjs'), script)
  writeFileSync(promptFile, prompt)

  const guardSha = sha(readFileSync(GUARD))
  console.log(`guard sha256 ${guardSha} (the plugin's; compare with summary.json's guardSha256)`)
  console.log(`walk.mjs sha256 ${sha(script)} (as written; the walker edits steps())`)
  console.log(`walk.md sha256 ${sha(prompt)}`)
  console.log(`budget: ${budget.routes} routes, ${budget.billed} billed; ${readPosts.length} read-only POST rule(s); every other write is blocked; WebSockets ${settings.allowWebSockets ? 'allowed' : 'closed'}; other googleapis.com hosts blocked${settings.googleHosts.length ? ' but ' + settings.googleHosts.join(', ') : ''}`)
  console.log('scratch folder ' + folder)
  const grok = ['--prompt-file', promptFile, '--cwd', folder, '--always-approve', '--max-turns', '30']
  if (!run) {
    console.log(`grok --prompt-file "${promptFile}" --cwd "${folder}" --always-approve --max-turns 30`)
    return
  }

  console.log(`running grok (up to ${GROK_MINUTES} minutes)...`)
  const started = Date.now()
  // Stdin is closed and the answer stays bytes: grok waits on an open stdin, and the saved file must be exactly what it printed
  const r = spawnSync('grok', grok, { cwd: folder, stdio: ['ignore', 'pipe', 'pipe'], timeout: GROK_MINUTES * 60_000, maxBuffer: 64 * 1024 * 1024 })
  if (r.error?.code === 'ENOENT') die('grok is not on PATH: install it, or run the command above yourself', 1)
  const response = r.stdout ?? Buffer.alloc(0)
  const failure = r.error ? r.error.message : r.status !== 0 ? `grok exited ${r.status ?? 'on ' + r.signal}` : null
  if (failure && !response.length) die(failure + ': ' + String(r.stderr ?? '').slice(0, 500), 1)

  // The answer is saved before anyone reads it
  const inbox = reviewDirs(repo).inbox
  const id = saveAnswer(inbox, response)
  let summary = null
  try {
    const parsed = JSON.parse(readFileSync(join(folder, 'summary.json'), 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) summary = parsed
  } catch {
    // the walker never ran walk.mjs, or it died before the guard started
  }
  const meta = {
    round: id,
    reviewer: 'grok',
    url,
    person,
    task,
    scratch_folder: folder,
    walk_md_sha256: sha(prompt),
    walk_mjs_sha256: sha(script),
    guard_sha256: guardSha,
    response_sha256: sha(response),
    started_at: new Date(started).toISOString(),
    duration_ms: Date.now() - started,
    exit_status: r.status,
    summary,
  }
  writeFileSync(join(inbox, id + '-grok.meta.json'), JSON.stringify(meta, null, 2) + '\n', { flag: 'wx' })
  const saved = join(inbox, id + '-grok.md')
  console.log(`✓ grok walked ${url} in ${Math.round(meta.duration_ms / 1000)}s: ${saved.slice(repo.length + 1)}`)
  console.log('  response sha256 ' + meta.response_sha256)
  if (!summary) {
    console.log('  ⚠ no summary.json in the scratch folder: the walker never ran walk.mjs, so nothing here was guarded or counted')
  } else {
    console.log(`  billed ${summary.billed ?? '?'} of ${summary.caps?.billed ?? '?'} (routes ${summary.routes ?? '?'} of ${summary.caps?.routes ?? '?'}); ${summary.blockedWrites?.length ?? 0} write(s) blocked`)
    if (summary.guardSha256 !== guardSha) console.log('  ⚠ guard sha256 in summary.json does not match the guard above (or is missing): do not trust this walk')
    if (summary.guardFailures?.length) console.log('  ⚠ ' + summary.guardFailures.join('; '))
    if (summary.unclassifiedGoogle?.length) console.log('  ⚠ unclassified Google requests: ' + summary.unclassifiedGoogle.join('; '))
  }
  if (failure) die(`${failure}; its output so far is saved in ${saved.slice(repo.length + 1)}`, 1)
  console.log('  Screenshots are in ' + join(folder, 'shots'))
  console.log('  Read it, then verify every finding against the build before logging a verdict.')
}

// Importing this file (the tests do) runs nothing
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main()
