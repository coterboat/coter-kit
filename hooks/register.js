// coter-kit: four mods in one plugin.
//   1. Snapshot  - gives Claude a short project snapshot (git, stack, last check results)
//                  and its working memory at startup, /resume, /clear and after compaction.
//   2. Checks    - after Claude edits files, runs the project's typecheck/build before
//                  Claude may stop, and sends failures back so Claude fixes them.
//   3. Checklist - a live task list above the prompt (and a /checklist pane) that
//                  Claude keeps current with its own tool.
//   4. Brain     - what Claude learns about working with you, shared across sessions,
//                  repositories and machines (see brain.js). /brain reviews it.

import { env, norm, dirname, basename, isAbs, join, within, ago, span, clip, safeJson } from './util.js'
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
  takeRetired,
  forgetUnseen,
  arrivalsContext,
  waitingHandoffs,
  waitingOnUser,
  isLive,
  writeHandoffFile,
  HANDOFF_PROMPT,
  KINDS,
  REMEMBER_TOOL,
  RECALL_TOOL,
  REFRESH_EVERY_MS,
  reread,
  ROUTE_WHERE,
} from './brain.js'
import { formatWaiting, waitingCard, cardAnswer, answerNote, answersRoot, outsideAnswer, followerOf, followUpPrompt, firstAnswer, LATER } from './waiting.js'
import { formatRoutes } from './routes.js'
import { updateMachine, sheetFor, weekOf, confirmCheck, parseAdjustment, formatSheet, validSheet } from './timesheet.js'
import { liveRoot, dayOf, beatCredit, liveRecord, liveness, lastBeatIn, glance, KEEP_DAYS } from './live.js'
import { alsoRedact } from './redact.js'
import { phoneFile, sentFile, phoneConfig, pusherOf, dueWaits, pushMessage, pushRequest, parseSent, mergeSent, nextSent, idleMs, newTopic } from './phone.js'
import { REVIEW_TOOL, VERDICTS, reviewQueue, queueText, recordVerdicts, picks, challenges, applyVerdict, applyPicks, keepAsIs, userDecides, score, isGuarded, isProtected } from './review.js'

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

// Catch-up: when the user last sent a message, and how much work the session did since
let lastLookAt = 0
let workSinceLook = 0
let turnStartedAt = 0
// Prompts that aren't the user looking: background deliveries, other sessions, schedules
const NOT_THE_USER = new Set(['task-notification', 'scheduled-trigger', 'peer', 'peer-send-message', 'projects-relay', 'coordinator', 'observer', 'observer-activity'])
// Another plugin's own prompt isn't the user either, unless it passes on their words (asUser). This
// kit's own (when an answer comes in) never reaches its own hooks
const fromTheUser = (origin) => !NOT_THE_USER.has(origin?.kind) && !(origin?.kind === 'plugin' && !origin.asUser)
// The band offers /catchup after this much work without the user
const CATCHUP_AFTER_MS = 30 * 60_000

// The live status file (live.js): this session's state as other tools read it
let liveFile = ''
let liveState = 'idle' // working | needs_ok | your_move | idle | ended
let liveStateSince = 0
let openedAt = 0
let lastEventAt = 0
let beats = [] // [at, credit]: the user's beats and the time each one earned
let turns = [] // [start, end] of each finished main-thread turn
let lastTurnEnd = 0
let brokenSince = 0
let branch = ''
let publishTimer = null
let heartbeatTimer = null
let othersNeedingYou = [] // other live sessions on this machine waiting on the user, for the band
let lastUsage = null // $.session.usage(), refreshed on the heartbeat and after each turn
const LIVE_COMMANDS = ['catchup', 'glance', 'waiting', 'brain', 'checklist', 'checks', 'snapshot', 'handoff', 'routes', 'timesheet', 'phone']
// This machine's timesheet file in the brain is rewritten at most this often (and when the session ends)
const TIMESHEET_EVERY_MS = 10 * 60_000
let lastTimesheetAt = 0

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
  let named = (await $.env.get('COMPUTERNAME')) || (await $.env.get('HOSTNAME'))
  // macOS sets neither, and each Claude Code host (the desktop app, the terminal) keeps its own
  // store, so the machine's own name keeps one Mac from showing up as two devices
  if (!named) {
    const r = await run($, ['hostname', '-s'], { timeoutMs: 5_000 })
    if (r.exitCode === 0) named = r.stdout.trim()
  }
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
    // How long the build has been broken is what the home dashboard ranks on
    brokenSince ||= await $.clock.now()
  } else if (passed.length) {
    checkView = { state: 'pass', summary: passed.join(', ') + ' passed', at: Date.now() }
    brokenSince = 0
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
  publish($)
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
    "Save something to the user's long-term memory, shared across their sessions, repositories and machines. Use it when the user states a preference or corrects how you work (preference), uses shorthand you should learn (term, written as \"<term>\" = meaning), makes a lasting decision about the project (decision, with the reason), leaves work open (thread), or you learn something non-obvious about the project (fact). Every question or decision the user owes you an answer on, with or without a link (a mockup or page to review, a spec question, a sign-off), is its own waiting note, never a thread: it is what /waiting, the band and catch-up count. Give it a short ref (such as \"Q8\") and its link when there is one, and when the question has set answers, options: two or three short ones, your pick first, which /waiting and the home dashboard show as choices to click; when they answer, save the answer as a decision with resolves set to the waiting note's id. One short sentence per note. Preferences and terms wait for the user's review unless confirmed is true, which you set only when the user explicitly asked you to remember it. To retire a note that is no longer true or a thread that is finished, pass its id as resolves (with a replacing note, or kind 'thread' and text 'done'). When you choose where a piece of work runs (here, a new session, subagents, cloud, a scheduled task, another model), save it as kind route with where set, the task and why in text; when it is done, save the outcome as kind route with resolves set to that note (time, usage, what went well or not). A waiting item or a route for another project takes project, its repository name.",
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
            link: { type: 'string', description: 'waiting only, optional: the http(s) URL of what to review' },
            ref: { type: 'string', description: 'waiting only: a short label, such as "Q8"' },
            options: { type: 'array', items: { type: 'string' }, description: 'waiting only, optional: 2 or 3 short answers the user can click, your recommendation first (Later and a typed answer are always offered)' },
            where: { type: 'string', enum: ROUTE_WHERE, description: 'route only: where the work runs' },
            project: { type: 'string', description: 'waiting and route only: file it under another project, by its repository name' },
          },
          required: ['kind', 'text'],
        },
      },
    },
    required: ['notes'],
  },
}

const REVIEW_SPEC = {
  name: 'review',
  description:
    "The outside reviewer's desk, for the review-brain skill only; do not use it otherwise. action 'list' returns the notes to review: everything waiting in /brain, and live notes from the last week without a verdict, with ids and tags. action 'verdicts' records one verdict per note: accept, reject, rewrite, merge, retire or ask. Every verdict but ask needs evidence (a file:line, a commit, a session and time, or the id of the note it repeats). Changing a live note also needs a steelman: the strongest case for keeping it as it is. rewrite and merge need a replacement; merge names the other notes in with. A reject of an exact duplicate names the live note in duplicateOf. A verdict against the user's own note is kept as a challenge, and a topic replaced twice in a week is frozen: the user decides both. Nothing is applied until the user presses for it in /brain, except exact duplicates.",
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'verdicts'] },
      verdicts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            ref: { type: 'string', description: "The note's id" },
            verdict: { type: 'string', enum: VERDICTS },
            reason: { type: 'string', description: 'One short sentence' },
            evidence: { type: 'string', description: 'What shows it: a file:line, a commit, a session and time, or the id of the note it repeats' },
            steelman: { type: 'string', description: 'For a verdict that changes a live note: the best case for keeping it' },
            replacement: { type: 'object', properties: { kind: { type: 'string', enum: KINDS }, text: { type: 'string' } }, description: 'For rewrite and merge: the note that replaces it' },
            with: { type: 'array', items: { type: 'string' }, description: 'For merge: the other notes the replacement absorbs' },
            duplicateOf: { type: 'string', description: 'For reject: the live note this one repeats word for word' },
          },
          required: ['ref', 'verdict'],
        },
      },
    },
    required: ['action'],
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

// ---------------------------------------------------------------- catch-up

// Kept per session, so an app restart or a resumed session still knows when the user last spoke
async function saveLook($) {
  if (env.sessionId) await $.store.set('look:' + env.sessionId, { lastLookAt, workSinceLook })
}

// Work the session did since the user's last message, the turn under way included
async function workWithoutYou($) {
  return workSinceLook + (turnStartedAt ? (await $.clock.now()) - turnStartedAt : 0)
}

// What the kit already knows, no model needed: the clock, the checklist, checks, what needs them
function catchupHeader(now, work) {
  const lines = [lastLookAt ? 'Since your last message, ' + span(now - lastLookAt) + ' ago: ' + span(work) + ' of work' : 'Since this session started: ' + span(work) + ' of work']
  if (checklist.items.length) {
    const done = checklist.items.filter((it) => it.status === 'done').length
    const current = checklist.items.find((it) => it.status === 'active') || checklist.items.find((it) => it.status === 'pending')
    const blocked = checklist.items.filter((it) => it.status === 'blocked').length
    lines.push('Checklist: ' + (checklist.title ? checklist.title + ' ' : '') + done + '/' + checklist.items.length + (current ? ' · ' + ICON[current.status] + ' ' + current.text : ' · all done') + (blocked ? ' · ' + blocked + ' blocked' : ''))
  }
  if (checkView.state === 'fail' || checkView.state === 'pass') lines.push('Checks: ' + (checkView.state === 'fail' ? '✗ ' : '✓ ') + checkView.summary + ' (' + ago(checkView.at) + ')')
  if (brain.dir) {
    const asks = waitingOnUser(env.project).length
    const handoff = waitingHandoffs()[0]
    const review = pendingEntries().length
    if (asks) lines.push('Waiting on you: ' + asks + ' (/waiting)')
    if (handoff) lines.push('Handoff waiting from ' + (handoff.from || 'a session') + ' on ' + handoff.device + ' (' + ago(handoff.at) + ')')
    if (review) lines.push('To review: ' + review + ' in /brain')
  }
  return lines.join('\n')
}

const CATCHUP_PROMPT = (away) =>
  '[coter-kit catch-up. This is an automated request, not the user; your reply is shown to them as-is.]\n' +
  'The user is back' + (away ? ' after ' + away : '') + ' and wants to know where things stand at a glance, not an essay. Cover only what happened since their last message. Reply with at most six short lines, each starting with one of these labels, and leave out any label with nothing under it:\n' +
  'Done: what was finished, and whether it was verified\n' +
  'Doing: what is under way right now\n' +
  'Decided: choices made that they did not make themselves\n' +
  'Needs you: each question or decision waiting on them, one per line, with its ref if it has one\n' +
  'Next: the next step, and who takes it\n' +
  'Use exact names (files, branches, specs, commands). No preamble and no closing line.'

// ---------------------------------------------------------------- live status file

// Every record in every day folder kept (a week), this session's included. A session lives in the
// folder of the day it opened, so one left open across two midnights must still be found
// (RV-002 F4); if a record turns up twice, the fresher one counts.
async function readLive($, now) {
  const root = liveRoot(env.home)
  const byId = new Map()
  for (const d of await listDir($, root)) {
    if (d.kind !== 'dir' || !/^\d{4}-\d{2}-\d{2}$/.test(d.name)) continue
    for (const f of await listDir($, join(root, d.name))) {
      if (f.kind !== 'file' || !f.name.endsWith('.json')) continue
      const rec = safeJson(await readText($, join(root, d.name + '/' + f.name)))
      if (!rec || !rec.v || !rec.id) continue
      const seen = byId.get(rec.id)
      if (!seen || Date.parse(rec.updated_at) > Date.parse(seen.updated_at)) byId.set(rec.id, rec)
    }
  }
  return [...byId.values()]
}

// This session as liveRecord (live.js) reads it
function liveSelf() {
  const asks = brain.dir ? waitingOnUser(env.project) : []
  const handoff = brain.dir ? waitingHandoffs()[0] : null
  return {
    id: env.sessionId,
    device: env.device,
    project: env.project,
    worktree: env.worktree,
    branch,
    openedAt,
    lastEventAt,
    state: liveState,
    stateSince: liveStateSince,
    scheduled: unattended,
    checklist,
    checks: checkView,
    brokenSince,
    needs: brain.dir
      ? {
          waiting: asks.length,
          waiting_refs: asks.map((e) => e.ref).filter(Boolean).slice(0, 12),
          handoff: handoff ? { id: handoff.id, from: handoff.from || '', device: handoff.device, at: new Date(handoff.at).toISOString() } : null,
          review: pendingEntries().length,
        }
      : null,
    beats,
    turns,
    turnStartedAt,
  }
}

// What the session has used, and the account's rate-limit windows, for routing choices. Looked up
// on the heartbeat and after each turn, never on the way to writing a beat, so a beat reaches the
// file as fast as it can (RV-003 F6)
async function refreshUsage($) {
  const usage = await $.session.usage().catch(() => lastUsage)
  if (usage === lastUsage) return
  lastUsage = usage
  publish($)
}

// Start a lookup without waiting on it: session start and the end of a turn never hang on it, even
// if it never answers (RV-004 F5)
function refreshUsageSoon($) {
  $.clock.after(0, () => refreshUsage($))
}

async function publishNow($) {
  if (!liveFile) return
  try {
    await $.fs.write(liveFile, JSON.stringify(liveRecord({ ...liveSelf(), usage: lastUsage }, await $.clock.now())) + '\n')
  } catch (err) {
    $.ui.log('live status not written: ' + (err?.message || err))
  }
}

// At most one write a second, however many changes come in; the write reads the state then
function publish($) {
  if (!liveFile || publishTimer) return
  publishTimer = $.clock.after(1_000, async () => {
    publishTimer = null
    await publishNow($)
  })
}

async function setLiveState($, state) {
  const now = await $.clock.now()
  if (state !== liveState) {
    liveState = state
    liveStateSince = now
  }
  lastEventAt = now
  publish($)
}

// One of the user's beats (a message, a kit command, an answered permission prompt) and the
// time before it that counts as theirs (live.js, beatCredit)
async function userBeat($) {
  if (unattended || !liveFile) return
  const now = await $.clock.now()
  const elsewhere = lastBeatIn(await readLive($, now), env.sessionId)
  const own = beats.length ? beats[beats.length - 1][0] : 0
  beats.push([now, beatCredit(now, { lastBeatAnywhere: Math.max(elsewhere, own), lastTurnEnd, openedAt })])
  lastEventAt = now
  // Written at once, not batched: another session's beat a moment later must see this one, or
  // both would credit the same minutes (RV-001 F5)
  await publishNow($)
}

async function currentBranch($) {
  const r = await run($, ['git', '-C', env.sessionRoot, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 5_000 })
  return r.exitCode === 0 ? r.stdout.trim() : ''
}

// Day folders past a week go; the name is checked so nothing else is ever removed
async function pruneLive($, now) {
  if (!env.home) return
  const root = liveRoot(env.home)
  const cutoff = dayOf(now - KEEP_DAYS * 86_400_000)
  for (const d of await listDir($, root)) {
    if (d.kind !== 'dir' || !/^\d{4}-\d{2}-\d{2}$/.test(d.name) || d.name >= cutoff) continue
    const path = join(root, d.name)
    await run($, env.isWindows ? ['cmd', '/d', '/s', '/c', 'rmdir', '/s', '/q', path] : ['rm', '-rf', path], { timeoutMs: 10_000 })
  }
  // Claims past a week go too, by the same rule: only folders with a claim's name
  for (const c of await listDir($, claimsRoot())) {
    if (c.kind !== 'dir' || !/^(acted|push)-[\w.-]+$/.test(c.name) || !(c.mtimeMs > 0) || now - c.mtimeMs < KEEP_DAYS * 86_400_000) continue
    await run($, shell(['rmdir', join(claimsRoot(), c.name)]), { timeoutMs: 5_000 })
  }
}

// Other running sessions here that are waiting on the user, for the band
function needingYou(records, now) {
  return records.filter(
    (r) => r.id !== env.sessionId && !r.scheduled && liveness(r, now) === 'live' && (r.state === 'needs_ok' || (r.state === 'your_move' && now - Date.parse(r.state_since) >= 2 * 60_000)),
  )
}

// Opens this session's record (a resumed session picks its old one back up) and keeps it beating
async function startLive($) {
  const now = await $.clock.now()
  openedAt = now
  liveStateSince = now
  lastEventAt = now
  const mine = (await readLive($, now)).find((r) => r.id === env.sessionId)
  if (mine) {
    openedAt = Date.parse(mine.opened_at) || now
    beats = Array.isArray(mine.beats) ? mine.beats : []
    turns = Array.isArray(mine.turns) ? mine.turns : []
    lastTurnEnd = turns.length ? turns[turns.length - 1][1] : 0
  }
  liveFile = join(liveRoot(env.home), dayOf(openedAt) + '/' + env.sessionId.replace(/[^\w-]/g, '') + '.json')
  // A resumed session's old beats may be past the 36 hours the file keeps: roll them up before the first write drops them (RV-005 F3)
  await saveTimesheet($, null, { own: false })
  branch = await currentBranch($)
  refreshUsageSoon($)
  await pruneLive($, now)
  heartbeatTimer?.cancel()
  heartbeatTimer = $.clock.every(60_000, async () => {
    branch = await currentBranch($)
    const at = await $.clock.now()
    othersNeedingYou = needingYou(await readLive($, at), at)
    await publishNow($)
    await phoneTick($, at)
    if (at - lastTimesheetAt >= TIMESHEET_EVERY_MS) await saveTimesheet($)
    refreshUsageSoon($)
    $.ui.invalidate('ui.render')
  })
  await publishNow($)
}

// ---------------------------------------------------------------- timesheets

const timesheetDir = () => join(brain.dir, 'timesheets')

// Every machine's file in the brain (timesheets.js): this machine's is read as written, the others as synced.
// A file that is there but isn't a valid timesheet is named in `unreadable` instead.
async function readTimesheets($) {
  const files = []
  const unreadable = []
  for (const f of await listDir($, timesheetDir())) {
    if (f.kind !== 'file' || !f.name.endsWith('.json')) continue
    const file = safeJson(await readText($, join(timesheetDir(), f.name)))
    if (validSheet(file)) files.push(file)
    else unreadable.push(f.name.replace(/\.json$/, ''))
  }
  return { files, unreadable }
}

const sameSheet = (a, b) => JSON.stringify({ ...a, updated_at: 0 }) === JSON.stringify({ ...b, updated_at: 0 })

// Rolls this machine's live records up into its file, which only this machine writes. `change`
// edits the file's own adjustments or confirmations first, and `holds` says whether that edit is
// in the file: another session on this machine may have written it between this one's read and
// write (no lock: LOCK-1), so a change is checked by reading the file back and made again up to
// 3 times (RV-005 F1). The file is written only when something in it changed, so the brain doesn't
// gather a commit a minute. Returns { file, saved }; saved is false when it could not be written.
async function saveTimesheet($, change = null, { holds = null, own = true } = {}) {
  if (!brain.dir || !env.device) return null
  const now = await $.clock.now()
  lastTimesheetAt = now
  if (own) await publishNow($)
  const path = join(timesheetDir(), env.device + '.json')
  let next = null
  for (let attempt = 0; attempt < 3; attempt++) {
    // The slow read first, then the file itself, so another session's edit has the least time to slip in between
    const records = await readLive($, now)
    // A file that is there but isn't a valid timesheet is never replaced: it holds history, lines and confirmations (RV-007 F2, RV-008 F4)
    const text = await readText($, path)
    const prior = safeJson(text)
    if ((await exists($, path)) && !validSheet(prior)) {
      $.ui.log('timesheet file ' + path + ' could not be read; left as it is')
      return { file: null, saved: false, unreadable: true }
    }
    next = updateMachine(change ? change(prior || { adjustments: [], confirmed: {}, days: {} }) : prior || null, { device: env.device, records, now })
    // Unchanged, but the time it was last looked at moves forward once a day, so another machine can tell
    // this one has been checked since a week ended (RV-008 F1)
    if (prior && sameSheet(prior, next) && dayOf(Date.parse(prior.updated_at) || 0) === dayOf(now)) return { file: next, saved: true }
    // The file again just before writing: if another session wrote since the read, start over from what it wrote (RV-008 F2)
    if ((await readText($, path)) !== text) continue
    try {
      await $.fs.write(path, JSON.stringify(next, null, 1) + '\n')
    } catch (err) {
      $.ui.log('timesheet not written: ' + (err?.message || err))
      return { file: next, saved: false }
    }
    const back = safeJson(await readText($, path))
    if (back && (!holds || holds(back))) return { file: next, saved: true }
  }
  return { file: next, saved: false }
}

// Every machine that left notes in the brain, and on which days: its journal files and, where undertone
// runs, its daily summaries. They show a machine whose timesheet has not arrived.
async function machineRoster($) {
  const byDevice = new Map()
  const add = (device, date) => byDevice.set(device, [...(byDevice.get(device) || []), date])
  for (const d of await listDir($, join(brain.dir, 'journal'))) {
    if (d.kind !== 'dir') continue
    for (const f of await listDir($, join(brain.dir, 'journal/' + d.name))) {
      const m = /^(\d{4}-\d{2}-\d{2})-/.exec(f.name)
      if (m) add(d.name, m[1])
    }
  }
  for (const d of await listDir($, join(brain.dir, 'undertone'))) {
    if (d.kind !== 'dir') continue
    for (const f of await listDir($, join(brain.dir, 'undertone/' + d.name))) {
      const m = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(f.name)
      if (m) add(d.name, m[1])
    }
  }
  return [...byDevice].map(([device, dates]) => ({ device, dates: [...new Set(dates)] }))
}

// The text of /timesheet: a week (this one, or `last`), three columns, and the hours to bill
async function timesheetCommand($, args) {
  if (!brain.dir) return { text: 'The timesheet lives in the brain, which is unavailable in this session.' }
  const now = await $.clock.now()
  const words = args.trim().split(/\s+/).filter(Boolean)
  const verb = ['add', 'remove', 'confirm'].includes(words[0]) ? words.shift() : ''
  const rest = args.trim().slice(verb.length).trim()
  if (!env.device) return { text: 'This machine has no name yet, so there is no file to write.' }
  await refreshIfStale(ioFor($), 60_000)
  const thisWeek = weekOf(dayOf(now))
  const lastWeek = weekOf(dayOf(new Date(thisWeek.replace(/-/g, '/')).getTime() - 12 * 3_600_000))
  const monday = words.includes('last') ? lastWeek : thisWeek
  // The other machines' files, read after this machine's own is up to date
  const others = async () => {
    const all = await readTimesheets($)
    return { files: all.files.filter((f) => f.device !== env.device), unreadable: all.unreadable.filter((d) => d !== env.device) }
  }
  const pushed = async () => {
    const sync = await syncNow(ioFor($))
    return sync && !sync.ok ? ' (saved on this machine; the push failed, /brain sync retries)' : ''
  }

  const notSaved = (what, r) => 'Not saved: ' + what + (r?.unreadable ? ' was not added because this machine\'s timesheet file (timesheets/' + env.device + '.json in the brain) could not be read, and it is left as it is. Repair or delete it, then try again.' : ' could not be written to the brain on this machine (see the log). Nothing was changed or synced.')
  if (verb === 'add') {
    const line = parseAdjustment(rest, now)
    if (!line.ok) return { text: line.reason }
    const id = 'a' + now.toString(36).slice(-4) + Math.random().toString(36).slice(2, 4)
    const entry = { id, date: line.date, project: line.project, min: line.min, note: line.note, at: new Date(now).toISOString() }
    const r = await saveTimesheet($, (f) => ({ ...f, adjustments: [...(f.adjustments || []).filter((a) => a.id !== id), entry] }), { holds: (f) => (f.adjustments || []).some((a) => a.id === id) })
    if (!r?.saved) return { text: notSaved('the line', r) }
    return { text: 'Added ' + id + ': ' + line.project + ' ' + (line.min > 0 ? '+' : '-') + span(Math.abs(line.min) * 60_000) + ' on ' + line.date + (line.note ? ' (' + line.note + ')' : '') + ' (a line rounds up to 0.1 h). Remove it with /timesheet remove ' + id + '.' + (await pushed()) }
  }
  if (verb === 'remove') {
    const id = words[0] || ''
    const own = await saveTimesheet($)
    if (!(own?.file?.adjustments || []).some((a) => a.id === id)) return { text: 'No line ' + (id || '(none given)') + ' in this machine\'s file. A line can be removed only on the machine that added it.' }
    const r = await saveTimesheet($, (f) => ({ ...f, adjustments: f.adjustments.filter((a) => a.id !== id) }), { holds: (f) => !(f.adjustments || []).some((a) => a.id === id) })
    if (!r?.saved) return { text: notSaved('the removal', r) }
    return { text: 'Removed ' + id + '.' + (await pushed()) }
  }
  if (verb === 'confirm') {
    const own = await saveTimesheet($)
    if (own?.unreadable) return { text: notSaved('the confirmation', own) }
    const peers = await others()
    const check = confirmCheck([own.file, ...peers.files], monday, now, { roster: await machineRoster($), unreadable: peers.unreadable, force: words.includes('anyway') })
    if (!check.ok) return { text: check.reason }
    const r = await saveTimesheet($, (f) => ({ ...f, confirmed: { ...(f.confirmed || {}), [monday]: { ...check.record, device: env.device } } }), { holds: (f) => f.confirmed?.[monday]?.at === check.record.at })
    if (!r?.saved) return { text: notSaved('the confirmation', r) }
    const lines = ['Confirmed the week of ' + monday + ': ' + Object.entries(check.record.billed_min).map(([p, m]) => p + ' ' + (m / 60).toFixed(1) + ' h').join(', ') + ' (total ' + (check.sheet.total.billed_min / 60).toFixed(1) + ' h).']
    if (check.missing.length) lines.push('Confirmed without ' + check.missing.join(', ') + ': /timesheet shows anything that changes when their hours arrive.')
    return { text: lines.join('\n') + (await pushed()) }
  }
  const own = await saveTimesheet($)
  const peers = await others()
  const sheet = formatSheet(sheetFor([own?.file, ...peers.files].filter(Boolean), monday), { days: words.includes('days') })
  return { text: sheet + (peers.unreadable.length ? '\n(' + peers.unreadable.map((d) => d + '.json').join(', ') + ' could not be read, so ' + (peers.unreadable.length > 1 ? 'their' : 'its') + ' hours are missing here.)' : '') + (own?.unreadable ? '\n(This machine\'s timesheet file could not be read, so its hours are missing here. It is left as it is: repair or delete timesheets/' + env.device + '.json in the brain.)' : own && !own.saved ? '\n(This machine\'s file could not be written, so other machines will not see these hours yet.)' : '') }
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
  env.worktree = repo?.root && norm(repo.root) !== env.sessionRoot ? basename(env.sessionRoot) : ''
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
  const look = await $.store.get('look:' + env.sessionId)
  if (look && typeof look.lastLookAt === 'number') ({ lastLookAt, workSinceLook } = look)

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
        await takeAnswers($)
        await followArrived($)
      } catch (err) {
        $.ui.log('brain refresh failed: ' + (err?.message || err))
      }
    })
  } catch (err) {
    brain.dir = ''
    $.ui.log('brain unavailable: ' + (err?.message || err))
  }
  try {
    if (env.home) await startLive($)
    // The phone topic and token are masked from the start, before any note could quote them
    if (env.home) await readPhoneFile($)
  } catch (err) {
    $.ui.log('live status unavailable: ' + (err?.message || err))
  }
}

// ---------------------------------------------------------------- answering what waits on the user

// /waiting's cards, one item at a time. An answer is saved at once, as a decision that resolves the
// item; Later skips it. Closing the card (or a surface that has none) stops, and lists what is left.
async function clickThrough($, items, all) {
  const answered = []
  const given = []
  const later = []
  let stopped = -1
  for (const [i, item] of items.entries()) {
    const card = waitingCard(item, { project: env.project })
    let answer
    try {
      answer = cardAnswer(await $.ui.ask(card.question, { header: card.header, options: card.options }))
    } catch {
      stopped = i
      break
    }
    if (!answer || answer.toLowerCase() === LATER.toLowerCase()) {
      later.push(item)
      continue
    }
    const [saved] = await remember(ioFor($), [answerNote(item, answer, '/waiting')])
    answered.push((item.ref || item.text.slice(0, 40)) + ' → ' + answer)
    // The same answer saved already (word for word) is being acted on where it was saved
    if (saved) given.push({ item, answer: saved })
  }
  redraw($)
  const left = stopped < 0 ? [] : items.slice(stopped)
  if (!answered.length && !later.length) return formatWaiting(left, { project: env.project, all })
  const out = []
  if (answered.length) out.push('Answered ' + answered.length + ' (saved as decisions, which every session and machine gets):', ...answered.map((a) => '- ' + a))
  const next = answered.length ? whoActs(await followUp($, given)) : ''
  if (next) out.push(next)
  if (later.length) out.push('Later: ' + later.map((x) => x.ref || x.text.slice(0, 40)).join(', '))
  if (left.length) out.push('', formatWaiting(left, { project: env.project, all }))
  return out.join('\n')
}

// Answers given on the home dashboard (docs/live-status.md, "Answering from outside a session"): one
// file per item, named by its id. Only a live waiting item is answered this way, so a file whose item
// is already answered is left alone, and nothing here deletes anything.
async function takeAnswers($) {
  if (!brain.dir || unattended || !env.home) return
  const root = answersRoot(env.home)
  const files = (await listDir($, root)).filter((f) => f.kind === 'file' && f.name.endsWith('.json'))
  if (!files.length) return
  // Another session here may have taken the same file a moment ago: read what it saved first, so the
  // answer is saved once (RV-011 F1)
  await reread(ioFor($))
  const notes = []
  for (const f of files) {
    const id = f.name.slice(0, -5)
    const item = brain.entries.get(id)
    if (!item || item.kind !== 'waiting' || !isLive(item, Date.now())) continue
    const answer = outsideAnswer(safeJson(await readText($, root + '/' + f.name)), id)
    if (answer) notes.push(answerNote(item, answer, 'the home dashboard', { outside: true }))
  }
  if (!notes.length) return
  const saved = await remember(ioFor($), notes)
  redraw($)
  await followUp($, saved.filter((e) => e.answers).map((e) => ({ item: brain.entries.get(e.answers), answer: e })))
}

// ---------------------------------------------------------------- acting on answers

// Every answer, saved here or arriving from another session, goes through followUp: the one session
// that acts on it (followerOf, waiting.js) gets a prompt of its own, which runs once it is idle, so the
// user's answer is acted on without them typing anything more. Returns how many act here, in the
// session that asked, in another session of the project, or nowhere yet (none runs on this machine).
async function followUp($, given) {
  const counts = { here: 0, asker: 0, other: 0, nobody: 0, typed: 0 }
  if (unattended || !given.length) return counts
  const now = await $.clock.now()
  const records = env.home ? await readLive($, now) : []
  const self = { id: env.sessionId, project: env.project, device: env.device }
  const mine = []
  for (const g of given) {
    if (!g.item) continue
    // Typed on the dashboard rather than tapped: its words never start a turn on their own. Claude is
    // told it with the user's next message in a session of its project (RV-012 F2)
    if (g.answer.outside && g.answer.typed) {
      if (g.answer.id && g.answer.session === env.sessionId) brain.unseen.push(g.answer.id)
      counts.typed++
      continue
    }
    // A second answer to the same question, saved by a session that hadn't heard: the first is acted on
    const first = firstAnswer(brain.entries.values(), g.item.id)
    if (first && g.answer.id && first.id !== g.answer.id) {
      counts.other++
      continue
    }
    const who = followerOf(g.item, g.answer, { records, now, self })
    if (who !== env.sessionId) {
      counts[!who ? 'nobody' : who === g.item.session ? 'asker' : 'other']++
      continue
    }
    // Acted on once on the machine, whatever two sessions make of the live files (RV-012 F1)
    if (await claim($, 'acted-' + g.item.id)) {
      mine.push(g.answer)
      counts.here++
    } else counts.other++
  }
  if (!mine.length) return counts
  const text = followUpPrompt(mine)
  // Sent from a timer: a hook that awaited its own prompt would wait for a turn that can't start
  // until the hook returns. A prompt that is refused lets its claims go and goes round again with the
  // next refresh (RV-013 F3)
  $.clock.after(0, async () => {
    try {
      await $.prompt.submit({ text })
    } catch (err) {
      $.ui.log('could not start a turn for an answer, trying again shortly: ' + (err?.message || err))
      for (const a of mine) await unclaim($, 'acted-' + a.answers)
      brain.answersArrived.push(...mine)
    }
  })
  return counts
}

// Answers other sessions saved since this one last looked (brain.js keeps them as they arrive)
async function followArrived($) {
  const arrived = brain.answersArrived.splice(0)
  const given = arrived.map((e) => ({ item: brain.entries.get(e.answers), answer: e })).filter((g) => g.item && g.item.kind === 'waiting')
  await followUp($, given)
}

// What /waiting says about who acts on the answers it just saved
function whoActs({ here, asker, other, nobody, typed }) {
  const parts = []
  if (here) parts.push('Claude acts on ' + here + ' here once the session is idle')
  if (asker) parts.push('the session that asked acts on ' + asker)
  if (other) parts.push('another session of its project acts on ' + other)
  if (nobody) parts.push('no session of its project runs here, so ' + nobody + ' stay' + (nobody > 1 ? '' : 's') + ' a decision for the next one to read')
  if (typed) parts.push(typed + ' typed on the dashboard wait' + (typed > 1 ? '' : 's') + ' for you in a session')
  return parts.length ? 'Next: ' + parts.join('; ') + '.' : ''
}

// ---------------------------------------------------------------- claims

// Something done once on the machine, by whichever session gets there first: it makes a folder named
// for it, which the file system lets only one process do (RV-012 F1, F4). True only when this session
// made it: when claims can't be made at all, nothing is done and the log says why, since every session
// doing it is worse than none (RV-013 F2). Claims go after a week (pruneLive).
const claimsRoot = () => join(env.home, '.claude/coter-kit/claims')
const claimPath = (key) => join(claimsRoot(), String(key).replace(/[^\w.-]+/g, '_').slice(0, 120))
const shell = (argv) => (env.isWindows ? ['cmd', '/d', '/s', '/c', ...argv] : argv)

async function claim($, key) {
  if (!env.home) return true
  const path = claimPath(key)
  await run($, shell(env.isWindows ? ['mkdir', claimsRoot()] : ['mkdir', '-p', claimsRoot()]), { timeoutMs: 5_000 })
  const r = await run($, shell(['mkdir', path]), { timeoutMs: 5_000 })
  if (r.exitCode === 0) return true
  if (!(await exists($, path))) $.ui.log('could not make a claim in ' + claimsRoot() + ', so ' + key + ' waits: ' + clip(String(r.stderr || '').trim(), 120))
  return false
}

async function unclaim($, key) {
  if (env.home) await run($, shell(['rmdir', claimPath(key)]), { timeoutMs: 5_000 })
}

// ---------------------------------------------------------------- phone pushes (docs/phone.md)

let lastPush = null // { at, ok, error, test } of this session's last push
let phoneBusy = false // a push is on its way
let lastPhoneTick = 0
let phoneRetryAt = 0 // after a failed push, the next try waits
let sentHere = {} // the sent record as this session last wrote it, in case the write was lost
const PUSH_TIMEOUT_MS = 15_000
// One wait, as a claim's name
const pushKey = (r) => 'push-' + r.id + '-' + r.state + '-' + Date.parse(r.state_since)
// How many times a wait's POST got no answer: after two it may well have arrived, so it isn't sent again
const pushTimeouts = new Map()

// On every heartbeat: if this session is the one that pushes on this machine and the user is away,
// one push for the waits that are due, and a record of them so none is pushed twice
async function phoneTick($, now) {
  // After the machine slept every file is stale for a moment, so the first heartbeat back only looks
  const woke = lastPhoneTick && now - lastPhoneTick > 150_000
  lastPhoneTick = now
  if (unattended || !env.home || phoneBusy || woke || now < phoneRetryAt) return
  const cfg = await readPhone($)
  if (!cfg) return
  const records = await readLive($, now)
  if (pusherOf(records, now) !== env.sessionId) return
  const sent = mergeSent(parseSent(safeJson(await readText($, sentFile(env.home)))), sentHere)
  // ioreg runs only when a wait would be due if the user were away
  if (!dueWaits(records, sent, cfg, now, Infinity).length) return
  const due = dueWaits(records, sent, cfg, now, await idleNow($))
  if (!due.length) return
  phoneBusy = true
  try {
    // Each wait is claimed before it goes out, so two sessions that both think they push, or a crash and
    // a handover, can't send it twice (RV-011 F4, RV-012 F4)
    const mine = []
    for (const r of due) if (await claim($, pushKey(r))) mine.push(r)
    if (!mine.length) return
    if (!(await sendPush($, cfg, pushMessage(mine, env.device, now)))) {
      // Not known to have arrived: let it go again in 5 minutes. A slow one may then arrive twice,
      // which beats a "needs you" that never comes (RV-012 F3), but no more than twice (RV-013 F1)
      for (const r of mine) {
        const key = pushKey(r)
        const timeouts = (pushTimeouts.get(key) || 0) + (lastPush.timedOut ? 1 : 0)
        pushTimeouts.set(key, timeouts)
        if (timeouts < 2) await unclaim($, key)
      }
      phoneRetryAt = now + 5 * 60_000
      return
    }
    sentHere = nextSent(sent, records, mine, now)
    try {
      await $.fs.write(sentFile(env.home), JSON.stringify({ v: 1, sent: sentHere }) + '\n')
    } catch {
      $.ui.log('phone push sent, but its record could not be written; its claim still stops it going twice')
    }
  } finally {
    phoneBusy = false
  }
}

// The topic and the token are masked in everything the kit writes from then on, so a note that quotes
// either never takes it into the brain: a token need not hold a digit for the patterns (RV-010 F2),
// and they are masked whether or not pushes are on (RV-011 F2)
function maskPhone(raw) {
  if (!raw || typeof raw !== 'object') return
  for (const v of [raw.topic, raw.token]) if (typeof v === 'string') alsoRedact(v)
}

// phone.json as it stands (masked as it is read), and the settings, null while pushes are off
async function readPhoneFile($) {
  const raw = safeJson(await readText($, phoneFile(env.home)))
  maskPhone(raw)
  return raw
}
async function readPhone($) {
  return phoneConfig(await readPhoneFile($))
}

// How long the keyboard and mouse have been idle, or null where it can't be told: only macOS says
// (ioreg), and with no answer nothing is pushed
async function idleNow($) {
  if (env.isWindows) return null
  const r = await run($, ['ioreg', '-c', 'IOHIDSystem', '-d', '4'], { timeoutMs: 5_000 })
  return r.exitCode === 0 ? idleMs(r.stdout) : null
}

// One POST to ntfy. Only the status is kept: an error's text could carry the topic's URL. A request
// with no answer in 15 seconds can't be called off, and may or may not arrive: it counts as failed, so
// it is tried again (RV-010 F4, RV-012 F3)
async function sendPush($, cfg, msg, test = false) {
  const { url, init } = pushRequest(cfg, msg)
  let ok = false
  let error = ''
  let timer = null
  const TIMEOUT = Symbol('timeout')
  try {
    const res = await Promise.race([
      $.http.fetch(url, init),
      new Promise((resolve) => {
        timer = $.clock.after(PUSH_TIMEOUT_MS, () => resolve(TIMEOUT))
      }),
    ])
    if (res === TIMEOUT) {
      error = 'no answer within 15 seconds'
    } else {
      ok = !!res.ok
      if (!ok) error = 'the server answered ' + res.status
    }
  } catch {
    error = 'the server could not be reached'
  } finally {
    timer?.cancel()
  }
  lastPush = { at: Date.now(), ok, error, test, timedOut: error === 'no answer within 15 seconds' }
  if (error) $.ui.log('phone push: ' + error)
  return ok
}

// /phone: status; setup [topic]; test; off
async function phoneCommand($, args) {
  if (!env.home) return 'Phone pushes need the live status files, which are unavailable in this session.'
  const file = phoneFile(env.home)
  const raw = await readPhoneFile($)
  const saved = raw && typeof raw === 'object' && !Array.isArray(raw) && raw.v === 1 ? raw : null
  const [verb, arg] = args.split(/\s+/)
  if (verb === 'setup') {
    if (arg && !phoneConfig({ v: 1, topic: arg })) return 'A topic is 24 to 64 letters, digits, - or _, so it can\'t be guessed. Leave it out to get a random one.'
    const topic = arg || (saved && phoneConfig({ ...saved, off: false }) ? saved.topic : newTopic())
    const next = { server: 'https://ntfy.sh', token: '', needs_ok_after_min: 3, your_move_after_min: 5, away_after_min: 2, ...saved, v: 1, topic, off: false }
    const cfg = phoneConfig(next)
    if (!cfg) return 'phone.json has a server or a token that can\'t be used (an https address with no user or password in it; a token of 16 or more characters). Fix or remove it: ' + file
    await $.fs.write(file, JSON.stringify(next, null, 2) + '\n')
    maskPhone(cfg)
    return [
      'Phone pushes are on for this machine.',
      'Subscribe in the ntfy app (iOS or Android) to ' + cfg.server + '/' + cfg.topic + ', or open that link.',
      'Keep the topic to yourself: anyone who has it can read the pushes. Each push says only the project, "needs your OK" or "your move", the minutes and the machine.',
      'On your other machine: /phone setup ' + cfg.topic,
      '/phone test sends one now. /phone setup shows this link again.',
    ].join('\n')
  }
  if (verb === 'off') {
    if (!saved) return 'Phone pushes are already off on this machine.'
    await $.fs.write(file, JSON.stringify({ ...saved, off: true }, null, 2) + '\n')
    return 'Phone pushes are off on this machine. /phone setup turns them back on with the same topic.'
  }
  const cfg = phoneConfig(saved)
  if (!cfg && saved && saved.off !== true) return 'phone.json can\'t be used, so nothing is pushed: it needs a topic of 24 to 64 letters, digits, - or _, an https server, and a token of 16 or more characters if it has one. /phone setup fixes the topic: ' + file
  if (!cfg) return 'Phone pushes are off on this machine. /phone setup turns them on: a random ntfy topic, then the link to subscribe (docs/phone.md).'
  if (verb === 'test') {
    const ok = await sendPush($, cfg, { title: 'coter-kit test on ' + env.device, body: 'Pushes from this machine reach you.', priority: 'default' }, true)
    return ok ? 'Sent a test push. It should be on your phone now.' : 'The test push failed: ' + lastPush.error + '.'
  }
  const now = await $.clock.now()
  const pusher = pusherOf(await readLive($, now), now)
  const who = pusher === env.sessionId ? 'this session' : pusher ? 'another session on this machine' : 'no session yet'
  const last = lastPush ? (lastPush.test ? 'test ' : '') + (lastPush.ok ? 'sent ' : 'failed ') + (lastPush.error ? '(' + lastPush.error + ') ' : '') + ago(lastPush.at) : 'none from this session yet'
  const lines = [
    'Phone pushes: on, through ' + cfg.server + ' (topic ' + cfg.topic.slice(0, 4) + '…; /phone setup shows the link)',
    'Pushed once each: a session waiting on your OK for ' + cfg.needsOkAfter / 60_000 + ' min with nobody at the machine since, or on your move for ' + cfg.yourMoveAfter / 60_000 + ' min, once you have been away ' + cfg.awayAfter / 60_000 + ' min.',
    'Pushing on this machine: ' + who + '. Last push: ' + last + '.',
  ]
  if ((await idleNow($)) === null) lines.push('This machine can\'t tell when you are away (only a Mac can, for now), so it sends nothing but /phone test.')
  return lines.join('\n')
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

    for (const spec of [CHECKLIST_SPEC, REMEMBER_SPEC, RECALL_SPEC, REVIEW_SPEC]) await $.tool.register(spec)

    // Commands last: a name clash throws, and nothing after it in this hook would run
    for (const spec of [
      { name: 'checklist', description: 'Open the task checklist pane', immediate: true },
      { name: 'checks', description: 'Run project checks now, or turn them on/off for this project', argumentHint: '[on|off]' },
      { name: 'snapshot', description: 'Show the project snapshot and memory coter-kit gives Claude' },
      { name: 'brain', description: 'Review what Claude learned about working with you', argumentHint: '[sync|digest]', immediate: true },
      { name: 'handoff', description: 'Leave this conversation for the next session to pick up, on any machine', argumentHint: '[anything to add]' },
      { name: 'catchup', description: 'What happened since your last message, at a glance', immediate: true },
      { name: 'routes', description: 'Where work was sent (here, new session, subagents, cloud, schedules) and how it went', argumentHint: '[all]' },
      { name: 'glance', description: 'Every running session on this machine: what needs you, what is working, today\'s time', immediate: true },
      { name: 'timesheet', description: 'Your time, Claude\'s and your adjustments this week, and the hours to bill', argumentHint: '[last|days|add <project> <time> <note>|remove <id>|confirm]', immediate: true },
      { name: 'phone', description: 'Pushes to your phone when a session needs you and you are away: status, setup, a test push, off', argumentHint: '[setup [topic]|test|off]', immediate: true },
      { name: 'waiting', description: 'What is waiting on you, one card at a time: click an answer, or Later. "list" prints it with links instead', argumentHint: '[all] [list]' },
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
      beats = []
      turns = []
      lastTurnEnd = 0
      liveState = 'idle'
      if (env.home) await startLive($)
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
      else forgetUnseen()
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
    if (!promptSeen && (e.origin?.kind === 'scheduled-trigger' || SCHEDULED_RUN.test(e.text))) {
      unattended = true
      refreshTimer?.cancel()
      brain.answersArrived = []
    }
    promptSeen = true
    if (!unattended && fromTheUser(e.origin)) {
      lastLookAt = await $.clock.now()
      workSinceLook = 0
      if (turnStartedAt) turnStartedAt = lastLookAt
      await saveLook($)
      await userBeat($)
    }
    const extra = []
    try {
      if (brainOnFirstPrompt) {
        brainOnFirstPrompt = false
        if (brain.dir) extra.push(await brainContext(ioFor($), { lean: unattended }))
        forgetUnseen()
      } else if (brain.dir && !unattended) {
        const arrived = takeUnseen()
        const gone = takeRetired()
        if (arrived.length || gone.length) extra.push(arrivalsContext(arrived, gone))
      }
    } catch (err) {
      $.ui.log('brain context failed: ' + (err?.message || err))
    }
    if (unattended) forgetUnseen()
    if (!extra.length) return next(e)
    return next({ ...e, context: [...(e.context ?? []), ...extra] })
  })

  // Live activity for the band, from every tool call (main loop and subagents)
  on('tool.call', async ($, e, next) => {
    if (!e.agentId) {
      activity = describeTool(e)
      redraw($)
    }
    const result = await next(e)
    // The call came back while the session waited on a permission prompt: the user answered it
    if (!e.agentId && liveState === 'needs_ok') {
      await userBeat($)
      await setLiveState($, 'working')
    }
    return result
  })

  // A permission prompt is waiting on the user
  on('classic.Notification', async ($, e, next) => {
    if (/permission/i.test(String(e.notification_type || '') + ' ' + String(e.message || ''))) await setLiveState($, 'needs_ok')
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    heartbeatTimer?.cancel()
    publishTimer?.cancel()
    publishTimer = null
    liveState = 'ended'
    liveStateSince = await $.clock.now()
    await publishNow($)
    await saveTimesheet($)
    return next(e)
  })

  // The kit's commands are the user looking, so they count as beats
  on('command.run', async ($, e, next) => {
    if (LIVE_COMMANDS.includes(e.command)) await userBeat($)
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
    // A note another session wrote moments ago may not be loaded yet: take it in before resolving
    if (notes.some((n) => n.resolves && !brain.entries.has(n.resolves))) await refresh(ioFor($))
    const missing = notes.map((n) => n.resolves).filter((id) => id && !brain.entries.has(id))
    const added = await remember(ioFor($), notes)
    redraw($)
    const notFound = missing.length ? ' Could not find ' + missing.join(', ') + ' to resolve, so nothing was retired: check the id with ' + RECALL_TOOL + '.' : ''
    const retired = notes.filter((n) => n.resolves && !missing.includes(n.resolves) && /^done[.!]?$/i.test(String(n.text || '').trim())).map((n) => n.resolves)
    if (!added.length) return { result: (retired.length ? 'Retired ' + retired.join(', ') + '.' : 'Nothing new to save (already known, or empty).') + notFound }
    const waiting = added.filter((n) => n.status === 'pending').length
    const handoff = added.find((n) => n.kind === 'handoff')
    const shipped = handoff ? await shipHandoff($, handoff) : ''
    return {
      result:
        'Saved ' + added.length + ' note(s): ' + added.map((n) => n.id).join(', ') + '.' + (retired.length ? ' Retired ' + retired.join(', ') + '.' : '') + (waiting ? ' ' + waiting + ' wait for the user to review them in /brain.' : '') + shipped + notFound,
    }
  })

  // The route log: each routing choice, and its outcome once it has one
  on('command.run', { command: 'routes' }, async ($, e) => {
    if (!brain.dir) return { text: 'Memory is unavailable in this session.' }
    return { text: formatRoutes([...brain.entries.values()], { project: env.project, all: (e.args || '').trim() === 'all' }) }
  })

  // Every running session on this machine, what needs the user first
  on('command.run', { command: 'glance' }, async ($) => {
    if (!env.home) return { text: 'The live status file is unavailable in this session.' }
    const now = await $.clock.now()
    await publishNow($)
    const g = glance(await readLive($, now), now)
    const head = g.rows.length + ' session(s) running' + (g.waiting ? ' · ' + g.waiting + ' waiting on you (/waiting)' : '') + ' · today: you ' + span(g.you * 60_000) + ', Claude ' + span(g.claude * 60_000)
    const lines = [head + (g.limits ? ' · used: ' + g.limits : ''), ...g.rows.map((r) => r.text)]
    if (g.rows.some((r) => r.text.includes('$'))) lines.push('($ is usage at API prices; on a Max plan it counts toward your limits, it is not billed)')
    if (g.died) lines.push('(' + g.died + ' session(s) stopped without closing in the last hour)')
    return { text: lines.join('\n') }
  })

  // The week's hours: yours, Claude's, adjustments, and what to bill
  on('command.run', { command: 'timesheet' }, async ($, e) => timesheetCommand($, e.args || ''))

  on('command.run', { command: 'phone' }, async ($, e) => ({ text: await phoneCommand($, (e.args || '').trim()) }))

  // Back in a long session: the kit's own facts, then six lines from the transcript
  on('command.run', { command: 'catchup' }, async ($) => {
    const now = await $.clock.now()
    const work = await workWithoutYou($)
    const header = catchupHeader(now, work)
    const reply = await $.model.fork({ prompt: CATCHUP_PROMPT(lastLookAt ? span(now - lastLookAt) : '') })
    const body = reply.isAnswered ? reply.text.trim() : reply.reason === 'nothing-to-fork' ? 'Nothing has happened in this conversation yet.' : 'Could not summarize the conversation (' + reply.reason + ').'
    // Reading the catch-up is looking: the band stops offering it
    lastLookAt = now
    workSinceLook = 0
    if (turnStartedAt) turnStartedAt = now
    await saveLook($)
    redraw($)
    return { text: header + '\n\n' + body }
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

  on('tool.call', { tool: REVIEW_TOOL }, async ($, e) => {
    if (!brain.dir) return { result: 'Memory is unavailable in this session.' }
    if (e.action === 'list') {
      await refresh(ioFor($))
      const queue = reviewQueue()
      return { result: queue.length + ' note(s) to review:\n' + queueText(queue) }
    }
    if (e.action === 'verdicts') {
      const r = await recordVerdicts(ioFor($), e.verdicts)
      redraw($)
      return {
        result:
          'Recorded ' + r.recorded + ' verdict(s); they wait for the user in /brain.' +
          (r.auto.length ? ' Dropped as exact duplicates: ' + r.auto.join(', ') + '.' : '') +
          (r.refused.length ? ' Refused (fix and send again): ' + r.refused.join('; ') : ''),
      }
    }
    return { result: "action must be 'list' or 'verdicts'" }
  })

  on('tool.call', { tool: 'mcp__coter-kit__recall' }, async ($, e) => {
    if (!brain.dir) return { result: 'Memory is unavailable in this session.' }
    try {
      await refreshIfStale(ioFor($), RECALL_FRESH_MS)
    } catch (err) {
      $.ui.log('brain refresh failed: ' + (err?.message || err))
    }
    const found = recall(e.query, unattended ? env.project : e.project, { lean: unattended })
    return { result: found.length ? found.map(describe).join('\n') : 'Nothing in memory matches "' + e.query + '".' }
  })

  on('turn.start', async ($, e, next) => {
    working = true
    activity = 'Thinking'
    if (!e.agentId) {
      turnStartedAt = await $.clock.now()
      await setLiveState($, 'working')
    }
    redraw($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) return next(e)
    const endedAt = await $.clock.now()
    workSinceLook += turnStartedAt ? endedAt - turnStartedAt : e.durationMs || 0
    if (turnStartedAt) turns.push([turnStartedAt, endedAt])
    lastTurnEnd = endedAt
    turnStartedAt = 0
    refreshUsageSoon($)
    // A scheduled run never waits on the user
    await setLiveState($, unattended ? 'idle' : 'your_move')
    await saveLook($)
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

  // /waiting: each item as a question card to click through. "list", or a surface with no card,
  // gets the plain-text list, which reads the same in the terminal, the desktop app and on a phone
  on('command.run', { command: 'waiting' }, async ($, e) => {
    if (!brain.dir) return { text: 'Memory is unavailable in this session.' }
    const words = (e.args || '').trim().toLowerCase().split(/\s+/)
    const all = words.includes('all')
    // Never ask what another session or machine answered a minute ago
    try {
      await refreshIfStale(ioFor($), REFRESH_EVERY_MS / 2)
    } catch (err) {
      $.ui.log('brain refresh failed: ' + (err?.message || err))
    }
    await takeAnswers($)
    const items = waitingOnUser(env.project, all)
    if (!items.length || words.includes('list')) return { text: formatWaiting(items, { project: env.project, all }) }
    return { text: await clickThrough($, items, all) }
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
    const away = unattended ? 0 : await workWithoutYou($)
    const offerCatchup = lastLookAt > 0 && away >= CATCHUP_AFTER_MS
    const elsewhere = othersNeedingYou[0]
    if (!hasList && !working && !showChecks && !toReview && !handoff && !asks && !offerCatchup && !elsewhere) return next(e)

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
    if (toReview) {
      const ready = picks().length
      const hint = ready ? ready + " of the reviewer's picks ready" : toReview >= 15 ? '/coter-kit:review-brain can sort them' : ''
      rows.push(Text({ dimColor: true, wrap: 'truncate', children: [clip('brain: ' + toReview + ' to review · /brain' + (hint ? ' · ' + hint : ''), width)] }))
    }
    if (asks) rows.push(Text({ dimColor: true, wrap: 'truncate', children: [clip(asks + ' waiting on you · /waiting', width)] }))
    if (offerCatchup) rows.push(Text({ color: 'cyan', wrap: 'truncate', children: [clip('catch up: /catchup · ' + span(away) + ' of work since your last message', width)] }))
    if (elsewhere) {
      const who = elsewhere.project + (elsewhere.worktree ? ' · ' + elsewhere.worktree : '')
      const more = othersNeedingYou.length > 1 ? ' (+' + (othersNeedingYou.length - 1) + ' more)' : ''
      rows.push(Text({ color: 'yellow', wrap: 'truncate', children: [clip('elsewhere: ' + who + (elsewhere.state === 'needs_ok' ? ' needs your OK' : ' is your move') + more + ' · /glance', width)] }))
    }

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
    const label = (n) => clip(n.kind + (n.project ? ' · ' + n.project : '') + (n.source === 'digest' ? ' · digest' : '') + ': ' + n.text, width)
    // The reviewer's verdict under a note, with why, and whether it is the user's call alone
    const verdictLine = (n) => {
      const v = n.review
      if (!v || v.by === 'user') return null
      // The flags come first, so a narrow pane never cuts off whose call it is
      const flags = [isGuarded(n) ? (v.protected || isProtected(n) ? 'yours: your call' : 'a live decision: your call') : '', v.frozen ? 'unsettled: your call' : ''].filter(Boolean).join(', ')
      const text = '  ↳ reviewer: ' + v.verdict + (flags ? ' (' + flags + ')' : '') + (v.reason ? ' · ' + v.reason : '') + (v.evidence ? ' · ' + v.evidence : '') + (v.replacement ? ' → "' + v.replacement.text + '"' : '')
      return Text({ key: 'why-' + n.id, dimColor: true, wrap: 'wrap', children: [clip(text, 500)] })
    }
    const ready = picks()
    const challenged = challenges()
    const children = [
      Text({ bold: true, children: [active + ' notes in use · ' + pending.length + ' to review · ' + sync] }),
      Text({ dimColor: true, wrap: 'truncate', children: ['Profile: ' + join(brain.dir, 'profile.md')] }),
    ]
    const tally = score()
    if (tally) children.push(Text({ dimColor: true, children: [tally] }))
    if (ready.length) {
      children.push(
        Button({
          key: 'apply-picks',
          label: "Apply the reviewer's picks (" + ready.length + ')',
          plain: true,
          onPress: async () => (await applyPicks(ioFor($)), redraw($)),
        }),
      )
    }
    children.push(Text({ children: [' '] }))
    if (!pending.length) children.push(Text({ dimColor: true, children: ['Nothing to review. New preferences, vocabulary and digest notes show up here.'] }))
    for (const p of pending.slice(0, 15)) {
      const keep = async () => (await userDecides(ioFor($), brain.entries.get(p.id), 'keep'), await setStatus(ioFor($), p.id, 'active'), redraw($))
      const drop = async () => (await userDecides(ioFor($), brain.entries.get(p.id), 'drop'), await setStatus(ioFor($), p.id, 'rejected'), redraw($))
      children.push(
        Box({
          key: 'row-' + p.id,
          flexDirection: 'row',
          columnGap: 1,
          children: [Button({ key: 'keep-' + p.id, label: 'keep', plain: true, onPress: keep }), Button({ key: 'drop-' + p.id, label: 'drop', plain: true, onPress: drop }), Text({ wrap: 'wrap', children: [label(p)] })],
        }),
      )
      const why = verdictLine(p)
      if (why) children.push(why)
    }
    // Live notes the reviewer wants changed: carry out its verdict, or keep the note as it is
    if (challenged.length) {
      children.push(Text({ children: [' '] }), Text({ bold: true, children: ['The reviewer would change ' + challenged.length + ' live note(s)'] }))
      for (const c of challenged.slice(0, 10)) {
        const take = async () => (await applyVerdict(ioFor($), brain.entries.get(c.id)), redraw($))
        const stand = async () => (await keepAsIs(ioFor($), brain.entries.get(c.id)), redraw($))
        children.push(
          Box({
            key: 'live-' + c.id,
            flexDirection: 'row',
            columnGap: 1,
            children: [Button({ key: 'take-' + c.id, label: c.review.verdict, plain: true, onPress: take }), Button({ key: 'stand-' + c.id, label: 'keep', plain: true, onPress: stand }), Text({ wrap: 'wrap', children: [label(c)] })],
          }),
        )
        children.push(verdictLine(c))
      }
    }
    return Box({ flexDirection: 'column', children })
  })
}
