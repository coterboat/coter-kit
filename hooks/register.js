// coter-kit: four mods in one plugin.
//   1. Snapshot  - gives Claude a short project snapshot (git, stack, last check results)
//                  and its working memory at startup, /resume, /clear and after compaction.
//   2. Checks    - after Claude edits files, runs the project's typecheck/build before
//                  Claude may stop, and sends failures back so Claude fixes them.
//   3. Checklist - a live task list above the prompt (and a /checklist pane) that
//                  Claude keeps current with its own tool.
//   4. Brain     - what Claude learns about working with you, shared across sessions,
//                  repositories and machines (see brain.js). /brain reviews it.

import { env, norm, dirname, basename, isAbs, join, within, ago, clip, safeJson } from './util.js'
import {
  brain,
  initBrain,
  brainContext,
  remember,
  recall,
  describe,
  setStatus,
  pendingEntries,
  digest,
  syncNow,
  refresh,
  refreshIfStale,
  takeUnseen,
  arrivalsContext,
  waitingHandoffs,
  waitingOnUser,
  writeHandoffFile,
  HANDOFF_PROMPT,
  KINDS,
  REMEMBER_TOOL,
  RECALL_TOOL,
  REFRESH_EVERY_MS,
} from './brain.js'
import { formatWaiting } from './waiting.js'

const CHECKLIST_TOOL = 'mcp__coter-kit__checklist'
const PANE = 'coter-checklist'
const BRAIN_PANE = 'coter-brain'
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
const MAX_FIX_ROUNDS = 2
const DIGEST_EVERY_TURNS = 8
// recall answers from a pull at most this old, so "pick up what I did on the PC" sees it
const RECALL_FRESH_MS = 15_000
const SKIP_DIRS = new Set(['node_modules', '.git', 'bin', 'obj', 'dist', 'build', '.next', '.godot', '.venv', 'venv', '__pycache__', '.claude'])
const LOCKED = /MSB3027|MSB3021|being used by another process/

// ---------------------------------------------------------------- state

// Checklist and live activity, drawn above the prompt
let checklist = { title: '', items: [] } // items: { text, status: pending|active|done|blocked }
let expanded = false // the band lists every step, not just the current one; kept across sessions
let activity = ''
let working = false

// Checks
let dirty = new Map() // project root -> Set of edited files (absolute)
let fixRounds = 0
let lastFailureSig = ''
let checkView = { state: 'idle', summary: '', at: 0 } // idle|running|pass|fail|skipped

// Brain
let turnsSinceDigest = 0
let refreshTimer = null
// The startup snapshot leaves the brain for the first prompt, which shows whether anyone is
// there: a scheduled task's run starts with its tag, and gets a lean brain (brainContext)
let promptSeen = false
let brainOnFirstPrompt = false
let unattended = false
const SCHEDULED_RUN = /^\s*<scheduled-task[\s>]/

// The session's setup, started once (see prepare)
let ready = null

// ---------------------------------------------------------------- calls into Claude Code

// npm/npx are .cmd shims on Windows, which only start through cmd.exe
const SHIMS = new Set(['npm', 'npx', 'yarn', 'pnpm'])

async function run($, argv, opts = {}) {
  const real = env.isWindows && SHIMS.has(argv[0]) ? ['cmd', '/d', '/s', '/c', ...argv] : argv
  try {
    return await $.process.run(real, { timeoutMs: 30_000, ...opts })
  } catch (err) {
    return { exitCode: -1, stdout: '', stderr: String(err && err.message ? err.message : err), failedToStart: true }
  }
}

async function listDir($, dir) {
  try {
    return await $.fs.list(dir)
  } catch {
    return []
  }
}

async function readText($, path) {
  try {
    const r = await $.fs.read(path)
    return typeof r === 'string' ? r : r && typeof r.text === 'string' ? r.text : ''
  } catch {
    return ''
  }
}

async function exists($, path) {
  try {
    return await $.fs.exists(path)
  } catch {
    return false
  }
}

// What brain.js may do, built from $ here so every call stays visible to the validator
function ioFor($) {
  return {
    run: (argv, opts) => run($, argv, opts),
    list: (path) => listDir($, path),
    read: (path) => readText($, path),
    write: (path, text) => $.fs.write(path, text),
    exists: (path) => exists($, path),
    after: (ms, fn) => $.clock.after(ms, fn),
    now: () => $.clock.now(),
    fork: (prompt) => $.model.fork({ prompt }),
    log: (text) => $.ui.log(text),
    pluginRoot: $.plugin.root,
  }
}

// A name for this machine that is the same in every session on it
async function deviceName($) {
  const named = (await $.env.get('COMPUTERNAME')) || (await $.env.get('HOSTNAME'))
  if (named) return named.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32)
  let saved = await $.store.get('device')
  if (!saved) {
    saved = 'device-' + Math.random().toString(36).slice(2, 7)
    await $.store.set('device', saved)
  }
  return saved
}

// ---------------------------------------------------------------- project detection

// What kind of project a directory is, from the files in it
function markersOf(entries) {
  const names = entries.map((x) => x.name)
  const has = (n) => names.includes(n)
  return {
    node: has('package.json'),
    tsconfig: has('tsconfig.json'),
    dotnet: names.some((n) => /\.csproj$/i.test(n)),
    sln: names.some((n) => /\.sln$/i.test(n)),
    godot: has('project.godot'),
    python: has('pyproject.toml') || has('setup.py') || has('requirements.txt'),
    checksFile: false,
  }
}

const dirCache = new Map()
async function markersAt($, dir) {
  if (!dirCache.has(dir)) {
    const entries = await listDir($, dir)
    const m = markersOf(entries)
    if (entries.some((x) => x.name === '.claude' && x.kind === 'dir')) m.checksFile = await exists($, join(dir, '.claude/checks.json'))
    dirCache.set(dir, m)
  }
  return dirCache.get(dir)
}

// The nearest directory at or above a file that is a project (has a checks file or a
// manifest), not going above the session root
async function projectRootOf($, file) {
  let dir = dirname(file)
  const stop = env.sessionRoot
  for (let i = 0; i < 12; i++) {
    const m = await markersAt($, dir)
    if (m.checksFile || m.node || m.dotnet || m.sln || m.python) return dir
    if (!stop || norm(dir).toLowerCase() === norm(stop).toLowerCase()) break
    const up = dirname(dir)
    if (up === dir || !within(up, stop)) break
    dir = up
  }
  return null
}

// ---------------------------------------------------------------- 1. Snapshot

async function gitSummary($, root) {
  const status = await run($, ['git', '-C', root, 'status', '--porcelain=v1', '-b'], { timeoutMs: 10_000 })
  if (status.exitCode !== 0) return null
  const lines = status.stdout.split('\n').filter(Boolean)
  const head = (lines.shift() || '').replace(/^## /, '')
  const log = await run($, ['git', '-C', root, 'log', '-8', '--pretty=format:%h %cr  %s'], { timeoutMs: 10_000 })
  return {
    branch: head,
    changed: lines.length,
    changedList: lines.slice(0, 8).map((l) => l.trim()),
    commits: log.exitCode === 0 ? log.stdout.split('\n').filter(Boolean) : [],
  }
}

async function stackSummary($, root) {
  const found = []
  const describeDir = async (dir, label) => {
    const m = await markersAt($, dir)
    const where = label ? label + '/' : ''
    if (m.godot) found.push(where + ' Godot project')
    if (m.dotnet || m.sln) found.push(where + ' .NET')
    if (m.node) {
      const pkg = safeJson(await readText($, join(dir, 'package.json')))
      const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) }
      const kind = deps.next ? 'Next.js' : deps['react-scripts'] ? 'React (CRA)' : deps.vite ? 'Vite' : deps.react ? 'React' : 'Node'
      const scripts = Object.keys(pkg?.scripts || {}).slice(0, 8).join(', ')
      found.push(where + ' ' + kind + (deps.typescript ? ' + TypeScript' : '') + (scripts ? ' (scripts: ' + scripts + ')' : ''))
    }
    if (m.python) found.push(where + ' Python')
  }
  await describeDir(root, '')
  // One level down catches client/ + server/ style repos
  for (const entry of (await listDir($, root)).slice(0, 60)) {
    if (entry.kind !== 'dir' || SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
    await describeDir(join(root, entry.name), entry.name)
  }
  return found.map((s) => s.trim())
}

// brain: 'full', 'lean' (brainContext) or 'none', left for the first prompt
async function buildSnapshot($, brainMode = 'full') {
  const root = env.sessionRoot
  const out = ['# Project snapshot (from the coter-kit mod)']
  const git = await gitSummary($, root)
  out.push('Project: ' + env.project + '  (' + root + ', on ' + env.device + ')')
  if (git) {
    out.push('Branch: ' + git.branch + '  ·  uncommitted files: ' + git.changed)
    if (git.changedList.length) out.push('Uncommitted: ' + git.changedList.join(' | '))
    if (git.commits.length) out.push('Recent commits:\n' + git.commits.map((c) => '  ' + c).join('\n'))
  } else {
    out.push('Not a git repository.')
  }
  const stack = await stackSummary($, root)
  if (stack.length) out.push('Stack: ' + stack.join('; '))

  const results = (await $.store.get('checks')) || {}
  const mine = Object.entries(results).filter(([r]) => within(r, root))
  if (mine.length) {
    out.push(
      'Last automatic checks:\n' +
        mine.map(([r, v]) => '  ' + (r === root ? '.' : r.slice(root.length + 1)) + ': ' + (v.ok ? 'passing' : 'FAILING - ' + v.summary) + ' (' + ago(v.at) + ')').join('\n'),
    )
  }

  out.push(
    'Checklist: for any task with 3 or more steps, call ' + CHECKLIST_TOOL + ' with the full list of steps, and call it again as each step starts and finishes. The user watches it above the prompt.',
  )
  out.push(
    "Checks: when you finish a turn that edited code, the mod runs the project's typecheck/build. If it fails, you will be asked to fix it before stopping. If a failure predates your change or is unrelated, say so plainly instead of guessing at a fix.",
  )

  if (brain.dir && brainMode !== 'none') out.push(await brainContext(ioFor($), { lean: brainMode === 'lean' }))
  return out.join('\n')
}

// ---------------------------------------------------------------- 2. Checks

async function readChecksFile($, root) {
  const cfg = safeJson(await readText($, join(root, '.claude/checks.json')))
  return cfg && typeof cfg === 'object' ? cfg : null
}

// The checks to run for one project root
async function checksFor($, root, files) {
  const cfg = await readChecksFile($, root)
  if (cfg && cfg.enabled === false) return []
  if (cfg && Array.isArray(cfg.checks)) {
    return cfg.checks.map((c) => ({
      name: c.name || c.run.join(' '),
      argv: c.run,
      cwd: c.cwd ? join(root, c.cwd) : root,
      timeoutMs: (c.timeoutSec || 180) * 1000,
    }))
  }
  const m = await markersAt($, root)
  const checks = []
  if (m.node) {
    const pkg = safeJson(await readText($, join(root, 'package.json'))) || {}
    const scripts = pkg.scripts || {}
    if (scripts.typecheck) checks.push({ name: 'npm run typecheck', argv: ['npm', 'run', '--silent', 'typecheck'], cwd: root, timeoutMs: 240_000 })
    else if (m.tsconfig && (await exists($, join(root, 'node_modules/typescript'))))
      checks.push({ name: 'tsc --noEmit', argv: ['npx', '--no-install', 'tsc', '--noEmit', '-p', root], cwd: root, timeoutMs: 240_000 })
  }
  if (m.dotnet || m.sln) {
    checks.push({ name: 'dotnet build', argv: ['dotnet', 'build', root, '--nologo', '-v', 'q', '-clp:ErrorsOnly'], cwd: root, timeoutMs: 420_000 })
  }
  const py = [...files].filter((f) => /\.py$/i.test(f))
  if (py.length && env.python) {
    checks.push({ name: 'python compile', argv: [env.python, '-m', 'py_compile', ...py], cwd: root, timeoutMs: 60_000 })
  }
  return checks
}

// The lines worth showing from a failed check's output
function errorLines(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean)
  const errors = lines.filter((l) => /\berror\b|Error:|SyntaxError|Traceback|FAILED|✗/i.test(l))
  const picked = (errors.length ? [...new Set(errors)] : lines.slice(-20)).slice(0, 20)
  return clip(picked.join('\n'), 4000)
}

async function runChecks($, targets) {
  checkView = { state: 'running', summary: 'running checks…', at: Date.now() }
  redraw($)
  const failures = []
  const passed = []
  const stored = (await $.store.get('checks')) || {}
  for (const [root, files] of targets) {
    const checks = await checksFor($, root, files)
    let rootOk = true
    const rootFails = []
    for (const check of checks) {
      checkView = { state: 'running', summary: check.name + ' in ' + basename(root) + '…', at: Date.now() }
      redraw($)
      const r = await run($, check.argv, { cwd: check.cwd, timeoutMs: check.timeoutMs })
      if (r.failedToStart) continue // tool missing or timed out to start: not the code's fault
      // A running app (dotnet run, the Godot editor) locks build outputs on Windows: not the code's fault either
      if (r.exitCode !== 0 && LOCKED.test(r.stdout + r.stderr)) {
        $.ui.log(check.name + ' skipped: build output is locked by a running process')
        continue
      }
      if (r.exitCode === 0) {
        passed.push(check.name)
        continue
      }
      rootOk = false
      const detail = errorLines(r.stdout + '\n' + r.stderr)
      rootFails.push(check.name)
      failures.push({ root, name: check.name, detail })
    }
    if (checks.length) stored[root] = { ok: rootOk, summary: rootFails.join(', '), at: Date.now() }
  }
  await $.store.set('checks', stored)
  if (failures.length) {
    checkView = { state: 'fail', summary: failures.map((f) => f.name).join(', ') + ' failed', at: Date.now() }
  } else if (passed.length) {
    checkView = { state: 'pass', summary: passed.join(', ') + ' passed', at: Date.now() }
  } else {
    checkView = { state: 'skipped', summary: 'no checks for these files', at: Date.now() }
  }
  redraw($)
  return failures
}

// Fast per-file check right after an edit, so Claude sees a syntax error immediately
async function quickCheck($, file) {
  if (/\.py$/i.test(file) && env.python) {
    const r = await run($, [env.python, '-m', 'py_compile', file], { timeoutMs: 15_000 })
    if (!r.failedToStart && r.exitCode !== 0) return 'Python syntax check failed for ' + file + ':\n' + errorLines(r.stderr + r.stdout)
  }
  if (basename(file) === 'package.json') {
    const text = await readText($, file)
    if (text && !safeJson(text)) return file + ' is no longer valid JSON.'
  }
  return ''
}

// ---------------------------------------------------------------- 3. Checklist

const ICON = { done: '✓', active: '▸', pending: '○', blocked: '✗' }
const STATUS_COLOR = { done: 'green', active: 'cyan', blocked: 'red' }

// One step as the band and the /checklist pane draw it
function stepRow(Text, it, { indent = '', width = 0 } = {}) {
  const line = indent + ICON[it.status] + ' ' + it.text
  const props = width ? { wrap: 'truncate', children: [clip(line, width)] } : { wrap: 'wrap', children: [line] }
  if (STATUS_COLOR[it.status]) props.color = STATUS_COLOR[it.status]
  if (it.status === 'done') props.dimColor = true
  return Text(props)
}
const STATUS_ALIASES = { completed: 'done', in_progress: 'active', 'in-progress': 'active', todo: 'pending', failed: 'blocked' }

function normalizeItems(items) {
  return (Array.isArray(items) ? items : [])
    .map((it) => ({
      text: String(it.text ?? it.content ?? '').trim(),
      status: STATUS_ALIASES[it.status] || (ICON[it.status] ? it.status : 'pending'),
    }))
    .filter((it) => it.text)
    .slice(0, 40)
}

async function saveChecklist($) {
  if (env.sessionId) await $.store.set('checklist:' + env.sessionId, checklist)
}

function describeTool(e) {
  const file = e.file_path ? basename(e.file_path) : ''
  switch (e.tool) {
    case 'Read':
      return 'Reading ' + file
    case 'Edit':
    case 'MultiEdit':
      return 'Editing ' + file
    case 'Write':
      return 'Writing ' + file
    case 'NotebookEdit':
      return 'Editing notebook ' + basename(e.notebook_path || '')
    case 'Bash':
    case 'PowerShell':
      return e.description ? String(e.description) : 'Running ' + clip(String(e.command || ''), 50)
    case 'Grep':
    case 'Glob':
      return 'Searching ' + clip(String(e.pattern || ''), 40)
    case 'WebFetch':
    case 'WebSearch':
      return 'Reading the web'
    case 'Agent':
    case 'Task':
      return 'Subagent: ' + clip(String(e.description || ''), 50)
    case CHECKLIST_TOOL:
      return activity
    case REMEMBER_TOOL:
      return 'Taking a note'
    case RECALL_TOOL:
      return 'Checking memory'
    default:
      return e.tool.startsWith('mcp__') ? 'Using ' + e.tool.split('__').pop() : 'Using ' + e.tool
  }
}

function redraw($) {
  $.ui.invalidate('ui.render')
}

// ---------------------------------------------------------------- tool specs

const CHECKLIST_SPEC = {
  name: 'checklist',
  description:
    "Show the user a live checklist of the current task's steps, drawn above their prompt. Send the whole list every time (it replaces the previous one). Use it for any task with 3 or more steps: send all steps at the start, then call again whenever a step starts (status 'active') or finishes ('done'). Use 'blocked' for a step you cannot finish. Keep each step under 70 characters.",
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short name of the overall task' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: { text: { type: 'string' }, status: { type: 'string', enum: ['pending', 'active', 'done', 'blocked'] } },
          required: ['text', 'status'],
        },
      },
    },
    required: ['items'],
  },
}

const REMEMBER_SPEC = {
  name: 'remember',
  description:
    "Save something to the user's long-term memory, shared across their sessions, repositories and machines. Use it when the user states a preference or corrects how you work (preference), uses shorthand you should learn (term, written as \"<term>\" = meaning), makes a lasting decision about the project (decision, with the reason), leaves work open (thread), or you learn something non-obvious about the project (fact). When you publish something for the user to review (a mockup, a page) or ask a decision they may answer later, add it as waiting, with link (its URL) and ref (a short label such as \"Q8\"); when they answer, save the answer as a decision with resolves set to the waiting note's id. One short sentence per note. Preferences and terms wait for the user's review unless confirmed is true, which you set only when the user explicitly asked you to remember it. To retire a note that is no longer true or a thread that is finished, pass its id as resolves (with a replacing note, or kind 'thread' and text 'done').",
  inputSchema: {
    type: 'object',
    properties: {
      notes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: KINDS },
            text: { type: 'string' },
            scope: { type: 'string', enum: ['project', 'global'], description: 'Decisions, threads and facts default to this project' },
            confirmed: { type: 'boolean' },
            resolves: { type: 'string', description: 'Id of an earlier note this replaces or finishes' },
            link: { type: 'string', description: "waiting only: the http(s) URL of what to review" },
            ref: { type: 'string', description: 'waiting only: a short label, such as "Q8"' },
          },
          required: ['kind', 'text'],
        },
      },
    },
    required: ['notes'],
  },
}

const RECALL_SPEC = {
  name: 'recall',
  description:
    "Search the user's long-term memory (notes from all their sessions, repositories and machines) by keywords. Use it before asking the user something they may already have told you, or to pick up work started elsewhere.",
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      project: { type: 'string', description: 'Limit to one project by its repository name' },
    },
    required: ['query'],
  },
}

// ---------------------------------------------------------------- handoffs

// Writes the readable copy and pushes at once: the next session may be on another machine
async function shipHandoff($, handoff) {
  await writeHandoffFile(ioFor($), handoff)
  const sync = await syncNow(ioFor($))
  if (!sync || !sync.ok) return ' Handoff saved on this machine, but the push failed (' + (sync?.error || 'unknown') + '); /brain sync retries.'
  if (sync.local) return ' Handoff saved on this machine only: the brain has no remote.'
  return ' Handoff ' + handoff.id + ' pushed; the next session on any machine with coter-kit picks it up.'
}

// ---------------------------------------------------------------- register

// Facts about the session, the checklist it left, and the brain
async function setUp($, options) {
  env.isWindows = (await $.env.get('OS')) === 'Windows_NT'
  env.sessionRoot = norm(await $.session.root())
  env.sessionId = await $.session.id()
  const repo = await $.session.repo().catch(() => null)
  env.project = basename(repo?.root || env.sessionRoot) || 'scratch'
  for (const candidate of env.isWindows ? ['python', 'py'] : ['python3', 'python']) {
    const r = await run($, [candidate, '--version'], { timeoutMs: 5_000 })
    if (r.exitCode === 0) {
      env.python = candidate
      break
    }
  }
  const saved = await $.store.get('checklist:' + env.sessionId)
  if (saved && Array.isArray(saved.items)) checklist = saved
  expanded = (await $.store.get('checklist:expanded')) === true

  try {
    env.home = norm((await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || '')
    env.device = await deviceName($)
    await initBrain(ioFor($), options)
    // Keep taking in what other sessions and machines write while this one runs; what
    // arrives reaches Claude with the next prompt (prompt.submit below)
    refreshTimer?.cancel()
    refreshTimer = $.clock.every(REFRESH_EVERY_MS, async () => {
      try {
        const arrived = await refreshIfStale(ioFor($), REFRESH_EVERY_MS / 2)
        if (arrived.length) redraw($)
      } catch (err) {
        $.ui.log('brain refresh failed: ' + (err?.message || err))
      }
    })
  } catch (err) {
    brain.dir = ''
    $.ui.log('brain unavailable: ' + (err?.message || err))
  }
}

// Runs setUp once, for whichever comes first: a session may raise the startup SessionStart,
// which builds the snapshot, before session.start
function prepare($, options) {
  ready ??= setUp($, options)
  return ready
}

export function register(on, options = {}) {

  on('session.start', async ($, e, next) => {
    await prepare($, options)

    for (const spec of [CHECKLIST_SPEC, REMEMBER_SPEC, RECALL_SPEC]) await $.tool.register(spec)

    // Commands last: a name clash throws, and nothing after it in this hook would run
    for (const spec of [
      { name: 'checklist', description: 'Open the task checklist pane', immediate: true },
      { name: 'checks', description: 'Run project checks now, or turn them on/off for this project', argumentHint: '[on|off]' },
      { name: 'snapshot', description: 'Show the project snapshot and memory coter-kit gives Claude' },
      { name: 'brain', description: 'Review what Claude learned about working with you', argumentHint: '[sync|digest]', immediate: true },
      { name: 'handoff', description: 'Leave this conversation for the next session to pick up, on any machine', argumentHint: '[anything to add]' },
      { name: 'waiting', description: 'What is waiting on you: mockups to review and questions to answer, with links', argumentHint: '[all]' },
    ]) {
      try {
        await $.command.register(spec)
      } catch (err) {
        $.ui.log('could not add /' + spec.name + ': ' + (err?.message || err))
      }
    }
    return next(e)
  })

  // 1. Snapshot: startup, /resume, /clear, compaction and /branch all raise SessionStart
  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    await prepare($, options)
    if (e.source === 'clear') {
      checklist = { title: '', items: [] }
      env.sessionId = await $.session.id()
      redraw($)
    }
    let snapshot = ''
    try {
      // At startup the brain was loaded just now; any other start re-reads it first
      if (brain.dir && e.source !== 'startup') await refresh(ioFor($))
      // Before any prompt, nobody can tell yet whether a person is there
      const later = e.source === 'startup' && !promptSeen
      snapshot = await buildSnapshot($, later ? 'none' : unattended ? 'lean' : 'full')
      if (later) brainOnFirstPrompt = true
      // The snapshot carries the whole brain, so nothing is left to deliver separately
      else brain.unseen = []
    } catch (err) {
      $.ui.log('snapshot failed: ' + (err?.message || err))
    }
    if (!snapshot) return result
    return { ...result, additionalContext: [...(result?.additionalContext || []), snapshot] }
  })

  on('command.run', { command: 'snapshot' }, async ($) => {
    return { text: await buildSnapshot($) }
  })

  // A new prompt from the user starts a fresh allowance of automatic fix rounds. The first
  // carries the brain the startup snapshot left out; later ones, what other sessions wrote
  // since Claude was last told. A scheduled run gets a lean brain and nothing after it.
  on('prompt.submit', async ($, e, next) => {
    fixRounds = 0
    lastFailureSig = ''
    if (!promptSeen && SCHEDULED_RUN.test(e.text)) {
      unattended = true
      refreshTimer?.cancel()
    }
    promptSeen = true
    const extra = []
    try {
      if (brainOnFirstPrompt) {
        brainOnFirstPrompt = false
        if (brain.dir) extra.push(await brainContext(ioFor($), { lean: unattended }))
        brain.unseen = []
      } else if (brain.dir && !unattended) {
        const arrived = takeUnseen()
        if (arrived.length) extra.push(arrivalsContext(arrived))
      }
    } catch (err) {
      $.ui.log('brain context failed: ' + (err?.message || err))
    }
    if (unattended) brain.unseen = []
    if (!extra.length) return next(e)
    return next({ ...e, context: [...(e.context ?? []), ...extra] })
  })

  // Live activity for the band, from every tool call (main loop and subagents)
  on('tool.call', async ($, e, next) => {
    if (!e.agentId) {
      activity = describeTool(e)
      redraw($)
    }
    return next(e)
  })

  // 2. Checks: remember what was edited, and catch syntax errors at once
  on('tool.call', { tool: EDIT_TOOLS }, async ($, e, next) => {
    const result = await next(e)
    if (result.deny || result.isError) return result
    const raw = e.file_path || e.notebook_path
    if (!raw) return result
    const file = isAbs(raw) ? norm(raw) : join(await $.session.cwd(), raw)
    // Loose Python scripts (no pyproject/requirements) still get checked from the session root
    const root = (await projectRootOf($, file)) || (/\.py$/i.test(file) && within(file, env.sessionRoot) ? env.sessionRoot : null)
    if (root) {
      if (!dirty.has(root)) dirty.set(root, new Set())
      dirty.get(root).add(file)
    }
    const problem = await quickCheck($, file)
    if (!problem) return result
    return { ...result, context: [...(result.context || []), problem] }
  })

  // Before Claude stops, run the checks for every project it edited
  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    if (result?.block || dirty.size === 0) return result
    const cfgOff = await $.store.get('off:' + env.sessionRoot)
    const targets = [...dirty.entries()]
    dirty = new Map()
    if (cfgOff) return result

    const failures = await runChecks($, targets)
    if (!failures.length) return result

    const sig = failures.map((f) => f.name + f.detail).join('|')
    const repeated = sig === lastFailureSig
    lastFailureSig = sig
    if (fixRounds >= MAX_FIX_ROUNDS || repeated) {
      $.ui.toast('coter-kit: checks still failing - see the checklist band')
      return result
    }
    fixRounds += 1
    // Run them again on the next stop, since nothing was fixed yet
    for (const t of targets) dirty.set(t[0], t[1])
    const report = failures.map((f) => '## ' + f.name + ' (' + f.root + ')\n' + f.detail).join('\n\n')
    return {
      ...result,
      block:
        'Automatic checks failed after your edits (round ' + fixRounds + ' of ' + MAX_FIX_ROUNDS + '):\n\n' + report +
        '\n\nFix these before finishing. If a failure was already there before your change or is unrelated to it, do not change unrelated code: say so in your answer and stop.',
    }
  })

  on('command.run', { command: 'checks' }, async ($, e) => {
    const arg = (e.args || '').trim().toLowerCase()
    if (arg === 'off' || arg === 'on') {
      if (arg === 'off') await $.store.set('off:' + env.sessionRoot, true)
      else await $.store.delete('off:' + env.sessionRoot)
      return { text: 'Automatic checks are ' + arg + ' for ' + env.sessionRoot }
    }
    // Run now against the projects Claude edited, or the session root and its subprojects
    let roots = [...dirty.keys()]
    if (!roots.length) {
      const m = await markersAt($, env.sessionRoot)
      if (m.node || m.dotnet || m.sln || m.python || m.checksFile) roots = [env.sessionRoot]
      for (const entry of await listDir($, env.sessionRoot)) {
        if (entry.kind !== 'dir' || SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
        const dir = join(env.sessionRoot, entry.name)
        const sub = await markersAt($, dir)
        if (sub.node || sub.dotnet || sub.sln || sub.checksFile) roots.push(dir)
      }
    }
    if (!roots.length) return { text: 'No project found to check here.' }
    const failures = await runChecks($, roots.map((r) => [r, new Set()]))
    if (!failures.length) return { text: 'Checks: ' + checkView.summary }
    return { text: failures.map((f) => '✗ ' + f.name + ' (' + f.root + ')\n' + f.detail).join('\n\n') }
  })

  // 3. Checklist: Claude's own tool
  on('tool.call', { tool: CHECKLIST_TOOL }, async ($, e) => {
    checklist = { title: String(e.title || checklist.title || ''), items: normalizeItems(e.items) }
    const active = checklist.items.find((it) => it.status === 'active')
    if (active) activity = active.text
    redraw($)
    await saveChecklist($)
    const done = checklist.items.filter((it) => it.status === 'done').length
    return { result: 'Checklist shown to the user: ' + done + '/' + checklist.items.length + ' done.' }
  })

  // Mirror Claude Code's own todo list when Claude uses it instead
  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const result = await next(e)
    if (!result.deny && !result.isError && Array.isArray(e.todos)) {
      checklist = { title: checklist.title, items: normalizeItems(e.todos) }
      redraw($)
      await saveChecklist($)
    }
    return result
  })

  // 4. Brain: Claude's notes and searches
  on('tool.call', { tool: 'mcp__coter-kit__remember' }, async ($, e) => {
    if (!brain.dir) return { result: 'Memory is unavailable in this session.' }
    const notes = Array.isArray(e.notes) ? e.notes : []
    const added = await remember(ioFor($), notes)
    redraw($)
    if (!added.length) return { result: 'Nothing new to save (already known, or empty).' }
    const waiting = added.filter((n) => n.status === 'pending').length
    const handoff = added.find((n) => n.kind === 'handoff')
    const shipped = handoff ? await shipHandoff($, handoff) : ''
    return {
      result:
        'Saved ' + added.length + ' note(s): ' + added.map((n) => n.id).join(', ') + '.' + (waiting ? ' ' + waiting + ' wait for the user to review them in /brain.' : '') + shipped,
    }
  })

  on('command.run', { command: 'handoff' }, async ($, e) => {
    if (!brain.dir) return { text: 'Memory is unavailable in this session, so there is nowhere to leave a handoff.' }
    const reply = await $.model.fork({ prompt: HANDOFF_PROMPT((e.args || '').trim()) })
    if (!reply.isAnswered) return { text: 'Could not write the handoff: ' + reply.reason + '. Ask Claude to save one with its remember tool instead.' }
    const [handoff] = await remember(ioFor($), [{ kind: 'handoff', text: reply.text.trim(), confirmed: true }])
    if (!handoff) return { text: 'That handoff is already saved.' }
    redraw($)
    return { text: reply.text.trim() + '\n\n' + (await shipHandoff($, handoff)).trim() }
  })

  on('tool.call', { tool: 'mcp__coter-kit__recall' }, async ($, e) => {
    if (!brain.dir) return { result: 'Memory is unavailable in this session.' }
    try {
      await refreshIfStale(ioFor($), RECALL_FRESH_MS)
    } catch (err) {
      $.ui.log('brain refresh failed: ' + (err?.message || err))
    }
    const found = recall(e.query, e.project)
    return { result: found.length ? found.map(describe).join('\n') : 'Nothing in memory matches "' + e.query + '".' }
  })

  on('turn.start', async ($, e, next) => {
    working = true
    activity = 'Thinking'
    redraw($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) return next(e)
    working = false
    activity = ''
    redraw($)
    turnsSinceDigest += 1
    // A run nobody watches proposes nothing for review
    if (brain.dir && !unattended && !e.isAborted && turnsSinceDigest >= DIGEST_EVERY_TURNS) {
      turnsSinceDigest = 0
      // Off the turn's path: the digest is a model call of its own
      $.clock.after(1_000, async () => {
        await digest(ioFor($), 'every ' + DIGEST_EVERY_TURNS + ' turns')
        redraw($)
      })
    }
    return next(e)
  })

  // Compaction is the last chance to read the full conversation, so digest first
  on('classic.PreCompact', async ($, e, next) => {
    if (brain.dir && !unattended && turnsSinceDigest > 0) {
      turnsSinceDigest = 0
      try {
        await digest(ioFor($), 'before compaction')
      } catch (err) {
        $.ui.log('digest failed: ' + (err?.message || err))
      }
    }
    return next(e)
  })

  on('command.run', { command: 'brain' }, async ($, e) => {
    const arg = (e.args || '').trim().toLowerCase()
    if (!brain.dir) return { text: 'Memory is unavailable in this session.' }
    if (arg === 'sync') {
      const r = await syncNow(ioFor($))
      redraw($)
      const arrived = r?.arrived
        ? ' ' + r.arrived + ' new note(s) from other sessions; Claude gets them with your next message.'
        : ' Nothing new from other sessions.'
      return { text: (r?.ok ? 'Brain synced' + (r.local ? ' (no remote set, committed locally).' : ' with ' + brain.remote + '.') : 'Sync failed: ' + (r?.error || 'unknown')) + arrived }
    }
    if (arg === 'digest') {
      const n = await digest(ioFor($), 'asked for')
      redraw($)
      return { text: n ? 'Kept ' + n + ' new note(s). /brain to review.' : 'Nothing new worth keeping.' }
    }
    await $.ui.open({ id: BRAIN_PANE, title: 'Brain', focus: true, closeOnEscape: true })
    return {}
  })

  // /waiting: plain text, so it reads the same in the terminal, the desktop app and on a phone
  on('command.run', { command: 'waiting' }, async ($, e) => {
    if (!brain.dir) return { text: 'Memory is unavailable in this session.' }
    const all = (e.args || '').trim().toLowerCase() === 'all'
    return { text: formatWaiting(waitingOnUser(env.project, all), { project: env.project, all }) }
  })

  on('command.run', { command: 'checklist' }, async ($) => {
    await $.ui.open({ id: PANE, title: 'Checklist', focus: true, closeOnEscape: true })
    return {}
  })

  // The band above the prompt: progress and the current step (or, expanded, every step),
  // what Claude is doing, checks, and a quiet note when there is something to review
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const hasList = checklist.items.length > 0
    const showChecks = checkView.state === 'running' || checkView.state === 'fail'
    const toReview = !working && brain.dir ? pendingEntries().length : 0
    const handoff = !working && brain.dir ? waitingHandoffs()[0] : null
    const asks = !working && brain.dir ? waitingOnUser(env.project).length : 0
    if (!hasList && !working && !showChecks && !toReview && !handoff && !asks) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const width = Math.max(20, (e.props.bodyColumns || 80) - 2)
    const rows = []

    if (hasList) {
      const done = checklist.items.filter((it) => it.status === 'done').length
      const current = checklist.items.find((it) => it.status === 'active') || checklist.items.find((it) => it.status === 'pending')
      const head = (checklist.title ? checklist.title + '  ' : '') + done + '/' + checklist.items.length
      // A click, or ctrl+x tab then Enter in the terminal, opens or folds the list
      const toggle = Button({
        key: 'checklist-toggle',
        label: expanded ? '▾' : '▸',
        plain: true,
        autoFocus: true,
        onPress: async () => {
          expanded = !expanded
          redraw($)
          await $.store.set('checklist:expanded', expanded)
        },
      })
      rows.push(
        Box({
          flexDirection: 'row',
          columnGap: 1,
          children: [
            toggle,
            Text({ color: done === checklist.items.length ? 'green' : 'cyan', bold: true, children: [head] }),
            ...(expanded ? [] : [Text({ wrap: 'truncate', children: [current ? '· ' + current.text : 'all done'] })]),
          ],
        }),
      )
      if (expanded) for (const it of checklist.items) rows.push(stepRow(Text, it, { indent: '  ', width }))
    }
    if (working && activity) rows.push(Text({ dimColor: true, wrap: 'truncate', children: [clip('now: ' + activity, width)] }))
    if (showChecks) {
      rows.push(
        Text({
          color: checkView.state === 'fail' ? 'red' : 'yellow',
          wrap: 'truncate',
          children: [clip((checkView.state === 'fail' ? '✗ ' : '… ') + checkView.summary, width)],
        }),
      )
    }
    if (handoff) {
      rows.push(Text({ color: 'cyan', wrap: 'truncate', children: [clip('handoff waiting from ' + (handoff.from || 'a session') + ' on ' + handoff.device + ' (' + ago(handoff.at) + ') · say "pick it up"', width)] }))
    }
    if (toReview) rows.push(Text({ dimColor: true, wrap: 'truncate', children: [clip('brain: ' + toReview + ' new thing(s) learned · /brain to review', width)] }))
    if (asks) rows.push(Text({ dimColor: true, wrap: 'truncate', children: [clip(asks + ' waiting on you · /waiting', width)] }))

    const others = await next(e)
    // Expanded, every step shows; past maxRows the engine scrolls the band ("n more")
    const shown = expanded ? rows : rows.slice(0, e.props.maxRows || 4)
    return Box({ flexDirection: 'column', children: [...shown, ...(others ? [others] : [])] })
  })

  // The /checklist pane: every step, plus the latest check result
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const width = Math.max(20, (e.props.bodyColumns || 60) - 4)
    const children = []
    if (checklist.title) children.push(Text({ bold: true, children: [clip(checklist.title, width)] }))
    if (!checklist.items.length) children.push(Text({ dimColor: true, children: ['No checklist yet. Claude adds one for multi-step tasks.'] }))
    for (const it of checklist.items) children.push(stepRow(Text, it))
    children.push(Text({ children: [' '] }))
    if (working && activity) children.push(Text({ dimColor: true, children: [clip('now: ' + activity, width)] }))
    if (checkView.state !== 'idle') {
      const mark = { pass: '✓', fail: '✗', running: '…', skipped: '–' }[checkView.state]
      const props = { wrap: 'wrap', children: [mark + ' checks: ' + checkView.summary + ' (' + ago(checkView.at) + ')'] }
      if (checkView.state === 'fail') props.color = 'red'
      if (checkView.state === 'pass') props.color = 'green'
      children.push(Text(props))
    }
    children.push(
      Button({
        key: 'clear',
        label: 'Clear list',
        hotkey: 'c',
        plain: true,
        onPress: async () => {
          checklist = { title: '', items: [] }
          redraw($)
          await saveChecklist($)
        },
      }),
    )
    return Box({ flexDirection: 'column', children })
  })

  // The /brain pane: what is waiting for review, with keep / drop for each
  on('ui.render', { component: 'Pane', requestId: BRAIN_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const width = Math.max(20, (e.props.bodyColumns || 60) - 10)
    const all = [...brain.entries.values()]
    const active = all.filter((x) => x.status === 'active').length
    const pending = pendingEntries()
    const sync = brain.lastSync
      ? brain.lastSync.ok
        ? 'synced ' + ago(brain.lastSync.at)
        : 'sync failed: ' + brain.lastSync.error
      : brain.remote
        ? 'not synced yet this session'
        : 'local only'
    const children = [
      Text({ bold: true, children: [active + ' notes in use · ' + pending.length + ' to review · ' + sync] }),
      Text({ dimColor: true, wrap: 'truncate', children: ['Profile: ' + join(brain.dir, 'profile.md')] }),
      Text({ children: [' '] }),
    ]
    if (!pending.length) children.push(Text({ dimColor: true, children: ['Nothing to review. New preferences and vocabulary show up here.'] }))
    for (const p of pending.slice(0, 15)) {
      children.push(
        Box({
          key: 'row-' + p.id,
          flexDirection: 'row',
          columnGap: 1,
          children: [
            Button({ key: 'keep-' + p.id, label: 'keep', plain: true, onPress: async () => (await setStatus(ioFor($), p.id, 'active'), redraw($)) }),
            Button({ key: 'drop-' + p.id, label: 'drop', plain: true, onPress: async () => (await setStatus(ioFor($), p.id, 'rejected'), redraw($)) }),
            Text({ wrap: 'wrap', children: [clip(p.kind + (p.project ? ' · ' + p.project : '') + (p.source === 'digest' ? ' · digest' : '') + ': ' + p.text, width)] }),
          ],
        }),
      )
    }
    return Box({ flexDirection: 'column', children })
  })
}
