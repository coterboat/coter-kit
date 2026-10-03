// The brain: what Claude learns about working with you, kept across sessions,
// repositories and machines.
//
// Storage is a git working copy (default ~/.claude/coter-brain) synced to a branch of a
// remote. Every session appends to a file of its own, journal/<device>/<date>-<session>.jsonl,
// so two sessions or two machines never write the same file and syncs never conflict.
// A line is either an entry or a status change to an earlier entry; loading folds them.
//
// Guardrails against memory rot: anything about the user (preferences, vocabulary), and
// anything the digest proposes, waits for their review before it shapes a session; threads
// expire; decisions can be superseded; what reaches a session is capped.

import { env, join, norm, safeJson, clip, ago } from './util.js'
import { waitingFields, waitingSection } from './waiting.js'

// Every call into Claude Code goes through `io`, which register.js builds from `$`:
// { run, list, read, write, exists, after, now, fork, log, pluginRoot }

export const REMEMBER_TOOL = 'mcp__coter-kit__remember'
export const RECALL_TOOL = 'mcp__coter-kit__recall'
export const KINDS = ['preference', 'term', 'decision', 'thread', 'fact', 'handoff', 'waiting', 'route']
// Where a piece of work was sent (docs/routing.md); a 'route' note records the choice, then its outcome
export const ROUTE_WHERE = ['here', 'new-session', 'subagent', 'cloud', 'remote', 'scheduled', 'routine', 'workflow', 'other-model']
const NEEDS_REVIEW = new Set(['preference', 'term'])
// A handoff is for whichever session picks the work up next, in any project or on any machine
const GLOBAL_KINDS = new Set(['preference', 'term', 'handoff'])
// An unanswered 'waiting' item (waiting.js) leaves the list after a month
const TTL_DAYS = { thread: 21, decision: 180, fact: 180, handoff: 7, waiting: 30, route: 180 }
const MAX_TEXT = { handoff: 4000 }
const DAY = 86_400_000
const CONTEXT_BUDGET = 13000
const SYNC_DELAY_MS = 20_000
// A running session takes in what other sessions wrote this often
export const REFRESH_EVERY_MS = 120_000

export const brain = {
  dir: '',
  remote: '',
  branch: 'brain',
  file: '', // this session's journal file
  lines: [], // what this session has written to it
  entries: new Map(), // id -> entry, folded
  unseen: [], // ids that other sessions wrote after this one loaded, not yet shown to Claude
  lastPull: 0, // when the brain was last re-read (and pulled, with a remote)
  lastSync: null, // { ok, at, error, arrived }
  overrules: [], // the user's disagreements with the reviewer (review.js)
  syncTimer: null,
  refreshing: null,
}

// ---------------------------------------------------------------- redaction

const SECRET_PATTERNS = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\b[a-f0-9]{32,}\b/gi,
  // A labelled value that looks like a credential (6+ characters with a digit), so prose
  // such as "the token budget" is left alone
  /((?:password|passwd|pwd|\bpw|secret|token|api[_ -]?key)\s*(?:is\s+|=\s*|:\s*)?)(?=\S*\d)\S{6,}/gi,
]

// Keeps credentials out of the brain, whatever Claude or the digest wrote
export function redact(text) {
  let out = String(text)
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (match, prefix) => (typeof prefix === 'string' && match.startsWith(prefix) ? prefix + '[redacted]' : '[redacted]'))
  }
  return out
}

// ---------------------------------------------------------------- setup and loading

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32)
const newId = () => Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 5)
export const sameText = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

// Clones or creates the brain, brings it up to date, and loads it
export async function initBrain(io, options = {}) {
  brain.dir = norm(options.brainDir || join(env.home, '.claude/coter-brain'))
  brain.remote = String(options.brainRemote || '').trim()
  brain.branch = String(options.brainBranch || 'brain').trim()

  if (!(await io.exists(join(brain.dir, '.git')))) {
    let cloned = false
    if (brain.remote) {
      const r = await io.run(['git', 'clone', '-q', '--branch', brain.branch, '--single-branch', brain.remote, brain.dir], { timeoutMs: 90_000 })
      cloned = r.exitCode === 0
    }
    if (!cloned) {
      await io.run(['git', 'init', '-q', '-b', brain.branch, brain.dir])
      if (brain.remote) await io.run(['git', '-C', brain.dir, 'remote', 'add', 'origin', brain.remote])
    }
  } else if (brain.remote) {
    // Commit what an earlier session left unsynced, then take the other machines' notes
    await commit(io)
    await pull(io)
  }

  if (!(await io.exists(join(brain.dir, 'profile.md')))) {
    const seed = await io.read(join(io.pluginRoot, 'profile.seed.md'))
    await io.write(join(brain.dir, 'profile.md'), seed || '# Profile\n\n(Nothing yet. Edit this file, or let Claude propose additions.)\n')
    await io.write(
      join(brain.dir, 'README.md'),
      '# coter-brain\n\nWritten by the coter-kit plugin. `profile.md` is yours to edit. `journal/` is append-only: one file per session, so machines never conflict. Review what Claude learned with `/brain`.\n',
    )
  }

  const date = new Date().toISOString().slice(0, 10)
  brain.file = join(brain.dir, 'journal/' + env.device + '/' + date + '-' + slug(env.sessionId).slice(0, 8) + '.jsonl')
  // A reload of the module keeps writing the same file, so start from what it holds
  brain.lines = (await io.read(brain.file)).split('\n').filter(Boolean)
  await loadBrain(io)
  brain.unseen = []
  brain.lastPull = await io.now()
}

export async function loadBrain(io) {
  const entries = new Map()
  const ops = []
  for (const device of await io.list(join(brain.dir, 'journal'))) {
    if (device.kind !== 'dir') continue
    for (const f of await io.list(join(brain.dir, 'journal/' + device.name))) {
      if (!f.name.endsWith('.jsonl')) continue
      const text = await io.read(join(brain.dir, 'journal/' + device.name + '/' + f.name))
      for (const line of text.split('\n')) {
        const row = safeJson(line)
        if (!row) continue
        if (row.op) ops.push(row)
        else if (row.id && row.kind && row.text) entries.set(row.id, row)
      }
    }
  }
  ops.sort((a, b) => a.at - b.at)
  const overrules = []
  for (const op of ops) {
    const entry = entries.get(op.ref)
    if (entry && op.op === 'status') entries.set(op.ref, { ...entry, status: op.status, updatedAt: op.at })
    // The reviewer's latest verdict on a note (review.js), and the user's disagreements with it
    if (entry && op.op === 'review') entries.set(op.ref, { ...entry, review: op })
    if (op.op === 'overrule') overrules.push(op)
  }
  // Notes saved before 0.7.0 don't say they answer a question. The answer was written in the
  // same remember call that retired the question, so it is the decision from that machine
  // saved within a few seconds of it
  for (const op of ops) {
    if (op.op !== 'status' || op.status !== 'superseded' || entries.get(op.ref)?.kind !== 'waiting') continue
    for (const e of entries.values()) {
      if (!e.answers && e.kind === 'decision' && e.device === op.device && Math.abs(op.at - e.at) < 5_000) entries.set(e.id, { ...e, answers: op.ref })
    }
  }
  brain.entries = entries
  brain.overrules = overrules
}

// Review and overrule lines, written as they are (review.js decides what they say)
export async function appendOps(io, rows) {
  await append(io, rows)
}

// ---------------------------------------------------------------- writing

async function append(io, rows) {
  if (!brain.file || !rows.length) return
  brain.lines.push(...rows.map((r) => JSON.stringify(r)))
  await io.write(brain.file, brain.lines.join('\n') + '\n')
  scheduleSync(io)
}

// Adds notes; returns the ones that were new. `confirmed` skips the review step,
// for things the user asked to have remembered.
export async function remember(io, notes, { source = 'claude' } = {}) {
  // The digest's notes are the model's own reading of the conversation: every one waits for
  // the user's review, none may skip it or retire another note, and one the user dropped is
  // not proposed again
  const fromDigest = source === 'digest'
  const added = []
  const rows = []
  for (const note of notes) {
    const kind = KINDS.includes(note.kind) ? note.kind : null
    const text = clip(redact(String(note.text || '').trim()), MAX_TEXT[kind] || 400)
    if (!kind || !text) continue
    const confirmed = note.confirmed === true && !fromDigest
    // The reviewer runs in coter-kit's folder but rewrites notes of every project
    // A waiting item or a route can be filed under another project by its repository name, and
    // the reviewer rewrites notes of every project from coter-kit's folder
    const named = typeof note.project === 'string' && note.project.trim() ? note.project.trim().slice(0, 40) : null
    const project = named && (kind === 'waiting' || kind === 'route' || source === 'review') ? named : GLOBAL_KINDS.has(kind) || note.scope === 'global' ? '' : env.project
    const replaced = !fromDigest && note.resolves ? brain.entries.get(note.resolves) : null
    // "done" with resolves retires the note it names; it isn't a note of its own
    if (note.resolves && /^done[.!]?$/i.test(text)) {
      if (replaced) rows.push(setStatusRow(replaced.id, 'superseded'))
      continue
    }
    const dupe = [...brain.entries.values()].find(
      (e) => e.kind === kind && (e.project || '') === project && sameText(e.text) === sameText(text) && (e.status !== 'rejected' || fromDigest),
    )
    if (dupe) continue
    const entry = {
      id: newId(),
      at: Date.now(),
      device: env.device,
      session: env.sessionId,
      project,
      // A handoff remembers where it came from, though every project sees it
      from: kind === 'handoff' ? env.project : undefined,
      kind,
      text,
      // A 'waiting' item keeps its link and short ref (waiting.js)
      ...(kind === 'waiting' ? waitingFields(note) : {}),
      ...(kind === 'route' && ROUTE_WHERE.includes(note.where) ? { where: note.where } : {}),
      status: (NEEDS_REVIEW.has(kind) || fromDigest) && !confirmed ? 'pending' : 'active',
      source,
      // Lineage and authorship, for the reviewer's anti-churn rules (review.js)
      ...(replaced ? { replaces: replaced.id } : {}),
      ...(confirmed ? { confirmed: true } : {}),
      ...(replaced && replaced.kind === 'waiting' ? { answers: replaced.id } : {}),
    }
    brain.entries.set(entry.id, entry)
    rows.push(entry)
    added.push(entry)
    if (replaced) rows.push(setStatusRow(replaced.id, 'superseded'))
  }
  await append(io, rows)
  return added
}

function setStatusRow(id, status) {
  const at = Date.now()
  const entry = brain.entries.get(id)
  if (entry) brain.entries.set(id, { ...entry, status, updatedAt: at })
  return { op: 'status', ref: id, status, at, device: env.device }
}

export async function setStatus(io, id, status) {
  if (!brain.entries.has(id)) return false
  await append(io, [setStatusRow(id, status)])
  return true
}

// ---------------------------------------------------------------- reading

const isLive = (e, now) => e.status === 'active' && !(TTL_DAYS[e.kind] && now - (e.updatedAt || e.at) > TTL_DAYS[e.kind] * DAY)
const newestFirst = (a, b) => (b.updatedAt || b.at) - (a.updatedAt || a.at)

export const pendingEntries = () => [...brain.entries.values()].filter((e) => e.status === 'pending').sort(newestFirst)

// What the user still owes an answer on: this project's and the global ones, or every project's
export const waitingOnUser = (project, all = false, now = Date.now()) =>
  [...brain.entries.values()]
    .filter((e) => e.kind === 'waiting' && isLive(e, now) && (all || !e.project || e.project === project))
    .sort(newestFirst)

// Handoffs left by other sessions (on this machine or another) that nobody has picked up
export const waitingHandoffs = (now = Date.now()) =>
  [...brain.entries.values()]
    .filter((e) => e.kind === 'handoff' && e.session !== env.sessionId && isLive(e, now))
    .sort(newestFirst)
    .slice(0, 2)

// ---------------------------------------------------------------- handoffs

export const HANDOFF_PROMPT = (note) =>
  '[coter-kit handoff. This is an automated request, not the user; your reply is saved as-is for another session.]\n' +
  'Write a handoff so a new Claude session, possibly on another machine and with none of this conversation, can pick the work up. Plain text, under 3000 characters, with these headings:\n' +
  'Goal: what the user is trying to achieve, in a sentence or two.\n' +
  'Where it stands: what is done and whether it was verified; what is not done.\n' +
  'Decisions: the choices made and why, so they are not reopened.\n' +
  'Next steps: numbered; say who does each one, the user or Claude, and on which machine.\n' +
  'Gotchas: anything that cost time or would surprise a newcomer.\n' +
  'Use exact names: repositories, branches, file paths, commands, URLs. No secrets or credentials.' +
  (note ? '\nThe user adds: ' + note : '')

// A copy anyone can read on GitHub, even on a machine without the plugin yet
export async function writeHandoffFile(io, entry) {
  const repo = (brain.remote.match(/github\.com[/:]([^/]+\/[^/.]+)/) || [])[1]
  // Terminal commands: the desktop app's /plugin opens its plugin browser and ignores arguments
  const install = repo
    ? 'Sessions with coter-kit pick this up by themselves, including ones already open. Without it yet, install it first, in a terminal:\n\n```\n' +
      'claude plugin marketplace add ' + repo + '\n' +
      'claude plugin install coter-kit@coter-kit --config brainRemote=' + brain.remote + ' --config brainBranch=' + brain.branch + '\n```\n\n'
    : 'Sessions with coter-kit pick this up by themselves.\n\n'
  const text =
    '# Handoff\n\nFrom ' + (entry.from || 'a session') + ' on ' + entry.device + ', ' + new Date(entry.at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC (id ' + entry.id + ').\n\n' +
    install + '---\n\n' + entry.text + '\n'
  await io.write(join(brain.dir, 'HANDOFF.md'), text)
}

const MARK_PICKED_UP =
  'mark it picked up by calling ' + REMEMBER_TOOL + " with kind 'thread', a one-line note of what you're continuing, and resolves set to the handoff's id."
// A handoff is a plan someone wrote earlier: background until the user asks for it, never an
// order to act first. The band above their prompt shows it is waiting.
const HANDOFF_WAITS =
  'Another session left this for whoever picks the work up next, and the band above their prompt shows them it is waiting. Act on it only when they ask to pick it up; until then do not act on it or bring it up. When they do, check it against the repo first, since it may be out of date, tell them what you understand the next step to be, then ' +
  MARK_PICKED_UP
const handoffBlock = (h) => '### [' + h.id + '] from ' + (h.from || 'a session') + ' on ' + h.device + ', ' + ago(h.at) + '\n' + h.text
const OTHER_PROJECT_LINE = 140

// What a session is told: the profile, then what was learned, within a budget. A lean
// brain, for a run nobody is watching (a scheduled task), is this project's notes and the
// approved ways of working alone: no profile, no other projects, never a handoff.
export async function brainContext(io, { lean = false } = {}) {
  const now = Date.now()
  const live = [...brain.entries.values()].filter((e) => isLive(e, now)).sort(newestFirst)
  const sections = []
  const list = (rows, fmt) => rows.map((e) => '- ' + fmt(e)).join('\n')

  const profile = lean ? '' : (await io.read(join(brain.dir, 'profile.md'))).trim()
  if (profile) sections.push('## Who you are working with (their own profile)\n' + profile)
  const prefs = live.filter((e) => e.kind === 'preference').slice(0, 25)
  if (prefs.length) sections.push('## How they like to work (learned, approved by them)\n' + list(prefs, (e) => e.text))
  const terms = lean ? [] : live.filter((e) => e.kind === 'term').slice(0, 40)
  if (terms.length) sections.push('## Shared vocabulary\n' + list(terms, (e) => e.text))
  const here = live.filter((e) => e.project === env.project && ['decision', 'fact', 'thread'].includes(e.kind)).slice(0, 15)
  if (here.length) {
    sections.push('## ' + env.project + ': decisions, facts and open threads\n' + list(here, (e) => '[' + e.kind + ' · ' + ago(e.updatedAt || e.at) + ' · ' + e.id + '] ' + e.text))
  }
  if (!lean) {
    const handoffs = waitingHandoffs(now)
    if (handoffs.length) sections.push('## Handoff waiting\n' + HANDOFF_WAITS + '\n\n' + handoffs.map(handoffBlock).join('\n\n'))
    const asks = waitingSection(waitingOnUser(env.project, false, now).slice(0, 12), env.project)
    if (asks) sections.push(asks)
    // One line per other project, its newest thread: enough to know what is in flight
    const latest = new Map()
    for (const e of live) if (e.kind === 'thread' && e.project && e.project !== env.project && !latest.has(e.project)) latest.set(e.project, e)
    const elsewhere = [...latest.values()].slice(0, 8)
    if (elsewhere.length) {
      sections.push(
        '## In flight in their other projects (the latest thread of each; ' + RECALL_TOOL + ' has the rest)\n' +
          list(elsewhere, (e) => '[' + e.project + ' · ' + ago(e.updatedAt || e.at) + '] ' + clip(e.text, OTHER_PROJECT_LINE)),
      )
    }
  }

  if (!lean) {
    // Where work runs (docs/routing.md), with the latest outcomes so each session learns from them
    const outcomes = live.filter((e) => e.kind === 'route' && e.replaces).slice(0, 3)
    sections.push(
      '## Where work runs\n' +
        'Before a substantial piece of work, pick where it runs and say why in one line: here (it needs this session\'s context and is short), a new local session (a separate repo or product, or this context is large), subagents (searches or checks that fan out and only need a conclusion), cloud (long autonomous work on a pushed repo that doesn\'t need this machine; no brain there), or a scheduled task (recurring, needs this machine). Check /glance for usage and the 5-hour window before fanning out. Record the choice with ' +
        REMEMBER_TOOL + " kind 'route' (where, the task, why), and when it's done the outcome as kind 'route' with resolves set to it (time, usage, what went well or not). /routes lists them; the playbook is " +
        join(io.pluginRoot || '', 'docs/routing.md') + '.' +
        (outcomes.length ? '\nRecent outcomes:\n' + outcomes.map((e) => '- ' + clip(e.text, 160)).join('\n') : ''),
    )
  }

  const pending = lean ? 0 : pendingEntries().length
  const usage = [
    '## Using this memory',
    '- Call ' + REMEMBER_TOOL + ' when the user states a preference, corrects how you work, uses shorthand you should learn, makes a lasting decision, or leaves work open. One short sentence each, in their words where you can. If they explicitly ask you to remember something, pass confirmed: true.',
    '- When an item above is no longer true or a thread is finished, call ' + REMEMBER_TOOL + ' with resolves set to its id.',
  ]
  if (!lean) {
    usage.push(
      "- Every question or decision they owe you an answer on, with or without a link (a mockup or page to review, a spec question, a sign-off), is its own 'waiting' note with a short ref (such as \"Q8\") and its link when there is one; never a thread. When they answer, resolve it with a decision note. /waiting, the band and /catchup count these.",
      '- This memory stays current while the session runs: what their other sessions and machines write is taken in every ' + REFRESH_EVERY_MS / 60_000 + ' minutes, and anything new reaches you beside their next message, under "New in working memory".',
      '- Call ' + RECALL_TOOL + ' before asking them something they may already have told you, and whenever they mention work from another session or machine ("pick up where I left off", "what was I doing on the PC"): it fetches the latest from their other machines first.',
      '- If they say memory looks out of date, /brain sync pulls and pushes it now; what arrives reaches you with their next message, so there is no need to /clear or start over.',
      '- When they are about to switch machines or sessions, or wrap up a long stretch of work, offer /handoff: it leaves this conversation\'s state for the next session to pick up, on any machine, including sessions already open.',
    )
    if (pending) usage.push('- ' + pending + ' learned item(s) wait for their review in /brain. Do not bring it up unless it matters to the task.')
  } else {
    usage.push('- Call ' + RECALL_TOOL + ' to search the rest of their notes on this project.')
  }
  sections.push(usage.join('\n'))

  let out = lean
    ? '# Working memory (coter-brain): this project\'s notes, for a run nobody is watching'
    : '# Working memory (coter-brain, shared across their sessions, repos and machines)'
  for (const s of sections) {
    if (out.length + s.length + 2 > CONTEXT_BUDGET) {
      out += '\n\n' + clip(s, Math.max(200, CONTEXT_BUDGET - out.length - 2))
      break
    }
    out += '\n\n' + s
  }
  return out
}

// What arrived from other sessions since Claude was last told, still in use; telling empties it
export function takeUnseen(now = Date.now()) {
  const fresh = brain.unseen.map((id) => brain.entries.get(id)).filter((e) => e && isLive(e, now))
  brain.unseen = []
  return fresh.sort(newestFirst)
}

// Attached to the user's next message when other sessions wrote something this one should know
export function arrivalsContext(entries) {
  const handoffs = entries.filter((e) => e.kind === 'handoff').slice(0, 2)
  const notes = entries.filter((e) => e.kind !== 'handoff').slice(0, 20)
  const sections = ['# New in working memory (coter-brain): written by another session or machine since this session loaded it']
  if (handoffs.length) {
    sections.push(
      '## Handoff\n' +
        HANDOFF_WAITS + '\n\n' +
        handoffs.map(handoffBlock).join('\n\n'),
    )
  }
  if (notes.length) sections.push('## Notes\nUse these as you would the rest of your memory.\n' + notes.map((e) => '- ' + describe(e)).join('\n'))
  return clip(sections.join('\n\n'), CONTEXT_BUDGET)
}

// Keyword search over everything except rejected notes
export function recall(query, project) {
  const words = String(query || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3)
  const now = Date.now()
  const scored = []
  for (const e of brain.entries.values()) {
    if (e.status === 'rejected') continue
    if (project && e.project && e.project.toLowerCase() !== String(project).toLowerCase()) continue
    const hay = (e.text + ' ' + e.project + ' ' + e.kind).toLowerCase()
    const hits = words.filter((w) => hay.includes(w)).length
    if (words.length && !hits) continue
    const ageDays = (now - (e.updatedAt || e.at)) / DAY
    scored.push({ e, score: hits * 10 + (e.project === env.project ? 3 : 0) + (e.status === 'active' ? 2 : 0) - Math.min(ageDays, 60) / 20 })
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, 12).map((s) => s.e)
}

export const describe = (e) =>
  '[' + e.id + ' · ' + e.kind + (e.project ? ' · ' + e.project : '') + ' · ' + ago(e.updatedAt || e.at) + (e.status !== 'active' ? ' · ' + e.status : '') + '] ' +
  (e.ref ? e.ref + ' · ' : '') + e.text + (e.link ? ' (' + e.link + ')' : '')

// ---------------------------------------------------------------- the digest

let digesting = false
const DIGEST_KINDS = ['preference', 'term', 'decision', 'thread', 'fact']

const DIGEST_PROMPT = (known) =>
  '[coter-kit memory digest. This is an automated request, not the user; nobody will read your reply but a parser.]\n' +
  'From this conversation, list only what is worth knowing in a FUTURE session with this user, as JSON lines, one object per line, nothing else:\n' +
  '{"kind": "preference" | "term" | "decision" | "thread" | "fact", "text": "one short sentence", "scope": "project" | "global"}\n' +
  '- preference: how the user wants you to work or communicate, only if they said it or clearly reacted to it\n' +
  '- term: shorthand or jargon they use, as "<term>" = meaning\n' +
  '- decision: a lasting choice about the project, with the reason\n' +
  '- thread: work left open or the agreed next step\n' +
  '- fact: something non-obvious about the project or environment that the code does not show\n' +
  'At most 8 lines. Leave out anything obvious from the code, anything already known (below), secrets or credentials, and any personal data of their clients or of end users. Output nothing if nothing qualifies.\n' +
  'Already known:\n' + (known || '(nothing yet)')

// Asks the model, over this session's cached transcript, what is worth keeping
export async function digest(io, reason) {
  if (digesting || !brain.file) return 0
  digesting = true
  try {
    const known = [...brain.entries.values()]
      .filter((e) => e.status !== 'rejected' && (!e.project || e.project === env.project))
      .sort(newestFirst)
      .slice(0, 40)
      .map((e) => '- ' + e.kind + ': ' + e.text)
      .join('\n')
    const reply = await io.fork(DIGEST_PROMPT(known))
    if (!reply.isAnswered) return 0
    // Only the kinds the prompt asks for, and only their kind, text and scope: no handoff,
    // waiting item, confirmation or resolves from a parser's input
    const notes = reply.text
      .split('\n')
      .map((l) => safeJson(l.trim().replace(/^```(?:json)?|```$/g, '').replace(/,$/, '')))
      .filter((n) => n && DIGEST_KINDS.includes(n.kind) && n.text)
      .map((n) => ({ kind: n.kind, text: n.text, scope: n.scope }))
      .slice(0, 8)
    const added = await remember(io, notes, { source: 'digest' })
    if (added.length) io.log('brain: ' + added.length + ' note(s) from this session wait for review in /brain (' + reason + ')')
    return added.length
  } finally {
    digesting = false
  }
}

// ---------------------------------------------------------------- sync

// Nothing here deletes a file, so one missing from the working copy is an accident, such as
// a clone another session had not finished checking out. Committing it would delete another
// machine's notes everywhere, so only additions and changes are staged, and anything missing
// is put back.
async function commit(io) {
  await io.run(['git', '-C', brain.dir, 'add', '--ignore-removal', '.'])
  const who = ['-c', 'user.name=coter-kit (' + env.device + ')', '-c', 'user.email=coter-kit@users.noreply.github.com']
  const r = await io.run(['git', ...who, '-C', brain.dir, 'commit', '-q', '-m', env.device + ': ' + (env.project || 'notes')])
  const missing = (await io.run(['git', '-C', brain.dir, 'ls-files', '--deleted'])).stdout.split('\n').map((l) => l.trim()).filter(Boolean)
  if (missing.length) await io.run(['git', '-C', brain.dir, 'checkout', '--', ...missing])
  return r
}

// Takes the other machines' notes. A rebase that stops on a conflict (HANDOFF.md, profile.md)
// is undone, so the brain is never left mid-rebase and the next pull can try again.
async function pull(io) {
  const r = await io.run(['git', '-C', brain.dir, 'pull', '-q', '--rebase', '--autostash', 'origin', brain.branch], { timeoutMs: 30_000 })
  if (r.exitCode !== 0) await io.run(['git', '-C', brain.dir, 'rebase', '--abort'])
  return r.exitCode === 0
}

// Re-reads the brain from disk and queues what other sessions wrote for Claude to be told.
// Other sessions on this machine write to the same folder, so this needs no remote.
async function reload(io) {
  const before = brain.entries
  await loadBrain(io)
  const arrived = [...brain.entries.values()].filter(
    (e) => !before.has(e.id) && e.session !== env.sessionId && (!e.project || e.project === env.project),
  )
  brain.unseen.push(...arrived.map((e) => e.id))
  return arrived.filter((e) => isLive(e, Date.now()))
}

// Brings a running session up to date with every other session; returns the notes that
// arrived. Calls made while one is under way share it.
export function refresh(io) {
  if (!brain.dir) return Promise.resolve([])
  if (!brain.refreshing) {
    brain.refreshing = (async () => {
      try {
        if (brain.remote) await pull(io)
        return await reload(io)
      } finally {
        brain.lastPull = await io.now()
        brain.refreshing = null
      }
    })()
  }
  return brain.refreshing
}

export async function refreshIfStale(io, maxAgeMs) {
  if (!brain.dir || (await io.now()) - brain.lastPull < maxAgeMs) return []
  return refresh(io)
}

export async function syncNow(io) {
  if (!brain.dir) return null
  await commit(io)
  if (!brain.remote) {
    const arrived = await refresh(io)
    brain.lastSync = { ok: true, at: Date.now(), local: true, arrived: arrived.length }
    return brain.lastSync
  }
  // The first push creates the branch, so a failed pull is expected then
  const arrived = await refresh(io)
  const push = await io.run(['git', '-C', brain.dir, 'push', '-q', 'origin', 'HEAD:' + brain.branch], { timeoutMs: 30_000 })
  brain.lastSync = { ok: push.exitCode === 0, at: Date.now(), error: push.exitCode === 0 ? '' : clip(push.stderr.trim(), 200), arrived: arrived.length }
  return brain.lastSync
}

function scheduleSync(io) {
  if (brain.syncTimer) brain.syncTimer.cancel()
  brain.syncTimer = io.after(SYNC_DELAY_MS, async () => {
    brain.syncTimer = null
    await syncNow(io)
  })
}
