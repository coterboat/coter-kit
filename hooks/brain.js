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
import { redact } from './redact.js'
import { ADDRESSABLE, cleanName } from './addressed.js'

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
  unseen: [], // ids that other sessions wrote (or approved) after this one loaded, not yet shown to Claude
  retired: [], // notes Claude was using that another session retired since, not yet told
  answersArrived: [], // answers to questions that other sessions saved since, for register.js to act on
  deliveredArrived: [], // ids of this session's addressed notes that another session took delivery of, not yet told
  lastPull: 0, // when the brain was last re-read (and pulled, with a remote)
  lastSync: null, // { ok, at, error, arrived }
  overrules: [], // the user's disagreements with the reviewer (review.js)
  syncTimer: null,
  refreshing: null,
  lastPullResult: '', // ok | no-branch | busy | failed (pull)
  writtenLen: 0, // how many of `lines` the journal file is known to hold
  writing: null, // the journal write under way: writes run one at a time (writeJournal)
}

// ---------------------------------------------------------------- redaction

// One redactor for everything the kit writes (redact.js): notes, links, the reviewer's text
export { redact }

// ---------------------------------------------------------------- setup and loading

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32)
const newId = () => Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 5)
// Close enough to be the same note: case and punctuation don't count, but symbols that change the
// meaning do (C, C++ and C# are three notes) (RV-001 F2), and so do letters and numbers in any
// script (周二 and 周五 are two notes) (RV-003 F3)
export const sameText = (s) => String(s).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}+#]+/gu, ' ').trim()
// Two texts are the same note only if they still say something after normalising
export const sameNote = (a, b) => {
  const x = sameText(a)
  return x !== '' ? x === sameText(b) : String(a).trim() === String(b).trim()
}

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
  } else if (brain.remote && !(await rebaseUnderWay(io))) {
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
  brain.writtenLen = brain.lines.length
  await loadBrain(io)
  forgetUnseen()
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
    // An addressed note's first delivery, on whichever machine (addressed.js): it is never delivered again
    if (entry && op.op === 'delivered' && !entry.delivered) entries.set(op.ref, { ...entry, delivered: { at: op.at, device: op.device, session: op.session } })
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

// Writes this session's journal file. Writes run one at a time, and each writes every line known when it
// starts, so an older write can never land after a newer one and drop its lines (RV-019 F3). A failed write
// leaves its lines in `lines` for the next write, or flushJournal on the poll (RV-018 F3).
function writeJournal(io) {
  const run = (brain.writing || Promise.resolve()).then(async () => {
    const len = brain.lines.length
    await io.write(brain.file, brain.lines.join('\n') + '\n')
    brain.writtenLen = Math.max(brain.writtenLen, len)
  })
  brain.writing = run.catch(() => {})
  return run
}

async function append(io, rows) {
  if (!brain.file || !rows.length) return
  brain.lines.push(...rows.map((r) => JSON.stringify(r)))
  await writeJournal(io)
  scheduleSync(io)
}

// Writes the journal again while some of its lines never reached the file, such as a delivery's row
export async function flushJournal(io) {
  if (!brain.file || brain.writtenLen >= brain.lines.length) return
  await writeJournal(io)
  scheduleSync(io)
}

// Adds notes; returns the ones that were new. `confirmed` skips the review step,
// for things the user asked to have remembered.
// A thread or handoff may be addressed `to` a session by its name (addressed.js), unless `canAddress` is
// false (a scheduled run); `fromName` is this session's own name, so the answer can come back, and
// `pinFor(to)` the machine the note is pinned to, if any.
export async function remember(io, notes, { source = 'claude', fromName = '', pinFor = null, canAddress = true } = {}) {
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
    const to = ADDRESSABLE.has(kind) && canAddress && !fromDigest ? cleanName(note.to) : ''
    const confirmed = note.confirmed === true && !fromDigest
    const replaced = !fromDigest && note.resolves ? brain.entries.get(note.resolves) : null
    // A waiting item or a route can be filed under another project by its repository name, and
    // the reviewer rewrites notes of every project from coter-kit's folder. A note that resolves
    // another belongs where that one did: answering jobsnearme's question from coter-kit files the
    // answer under jobsnearme (RV-004 F4)
    const named = typeof note.project === 'string' && note.project.trim() ? note.project.trim().slice(0, 40) : null
    const project = named && (kind === 'waiting' || kind === 'route' || source === 'review')
      ? named
      : GLOBAL_KINDS.has(kind) || note.scope === 'global'
        ? ''
        : replaced && replaced.project
          ? replaced.project
          : env.project
    // "done" with resolves retires the note it names; it isn't a note of its own
    if (note.resolves && /^done[.!]?$/i.test(text)) {
      if (replaced) rows.push(setStatusRow(replaced.id, 'superseded'))
      continue
    }
    const dupe = [...brain.entries.values()].find(
      (e) =>
        e.kind === kind && (e.project || '') === project && (e.to || '') === to && sameNote(e.text, text) && (e.status !== 'rejected' || fromDigest) &&
        // An addressed note asked again once the first was delivered or retired is a new request
        (!to || (!e.delivered && e.status === 'active')),
    )
    if (dupe) {
      // The note is already known, but what it resolves still gets resolved: an answer that repeats
      // an earlier decision word for word still closes the question (RV-004 F3)
      if (replaced) rows.push(setStatusRow(replaced.id, 'superseded'))
      continue
    }
    const entry = {
      id: newId(),
      at: Date.now(),
      device: env.device,
      session: env.sessionId,
      project,
      // A handoff remembers where it came from, though every project sees it, and so does an addressed note,
      // which reaches only sessions of that project (addressed.js)
      from: kind === 'handoff' || to ? env.project : undefined,
      kind,
      text,
      // A 'waiting' item keeps its link and short ref (waiting.js)
      ...(kind === 'waiting' ? waitingFields(note) : {}),
      ...(kind === 'route' && ROUTE_WHERE.includes(note.where) ? { where: note.where } : {}),
      // Who it is for, who it is from (their name, to answer to), the machine it is pinned to, and the repository
      ...(to ? addressFields(to, fromName, pinFor, project || env.project) : {}),
      ...(to && env.repoId ? { repo: env.repoId } : {}),
      status: (NEEDS_REVIEW.has(kind) || fromDigest) && !confirmed ? 'pending' : 'active',
      source,
      // Lineage and authorship, for the reviewer's anti-churn rules (review.js)
      ...(replaced ? { replaces: replaced.id } : {}),
      ...(confirmed ? { confirmed: true } : {}),
      ...(replaced && replaced.kind === 'waiting' ? { answers: replaced.id } : {}),
      // An answer that came from outside any session (the home dashboard), kept as a field, since
      // redaction and clipping can change the text (RV-011 F3)
      ...(kind === 'decision' && note.outside === true ? { outside: true } : {}),
      // ...and whether it was typed there rather than one of the question's own choices (RV-012 F2)
      ...(kind === 'decision' && note.outside === true && note.typed === true ? { typed: true } : {}),
    }
    brain.entries.set(entry.id, entry)
    rows.push(entry)
    added.push(entry)
    if (replaced) rows.push(setStatusRow(replaced.id, 'superseded'))
  }
  await append(io, rows)
  return added
}

function addressFields(to, fromName, pinFor, project) {
  const from = cleanName(fromName)
  const device = typeof pinFor === 'function' ? pinFor(to, project) : ''
  return { to, ...(from ? { from_name: from } : {}), ...(device ? { to_device: device } : {}) }
}

function setStatusRow(id, status) {
  const at = Date.now()
  const entry = brain.entries.get(id)
  if (entry) brain.entries.set(id, { ...entry, status, updatedAt: at })
  return { op: 'status', ref: id, status, at, device: env.device }
}

// Notes addressed to this session that it was just handed: one row each, appended like any line, so no
// session on any machine delivers them again
export async function markDelivered(io, ids) {
  const at = Date.now()
  const rows = []
  for (const id of ids) {
    const entry = brain.entries.get(id)
    if (!entry || entry.delivered) continue
    brain.entries.set(id, { ...entry, delivered: { at, device: env.device, session: env.sessionId } })
    rows.push({ op: 'delivered', ref: id, at, device: env.device, session: env.sessionId })
  }
  await append(io, rows)
}

export async function setStatus(io, id, status) {
  if (!brain.entries.has(id)) return false
  await append(io, [setStatusRow(id, status)])
  return true
}

// ---------------------------------------------------------------- reading

export const isLive = (e, now) => e.status === 'active' && !(TTL_DAYS[e.kind] && now - (e.updatedAt || e.at) > TTL_DAYS[e.kind] * DAY)
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
    .filter((e) => e.kind === 'handoff' && !e.to && e.session !== env.sessionId && isLive(e, now))
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
  // The install line carries the remote without whatever credentials it was configured with (RV-004 F1)
  let remote = brain.remote
  try {
    const url = new URL(brain.remote)
    url.username = ''
    url.password = ''
    remote = url.toString()
  } catch {
    remote = brain.remote.replace(/\/\/[^/@]*@/, '//')
  }
  // Terminal commands: the desktop app's /plugin opens its plugin browser and ignores arguments
  const install = repo
    ? 'Sessions with coter-kit pick this up by themselves, including ones already open. Without it yet, install it first, in a terminal:\n\n```\n' +
      'claude plugin marketplace add ' + repo + '\n' +
      'claude plugin install coter-kit@coter-kit --config brainRemote=' + redact(remote) + ' --config brainBranch=' + brain.branch + '\n```\n\n'
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
  // A note addressed to one session reaches that session (addressed.js), not everyone's list
  const here = live.filter((e) => e.project === env.project && !e.to && ['decision', 'fact', 'thread'].includes(e.kind)).slice(0, 15)
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
    for (const e of live) if (e.kind === 'thread' && !e.to && e.project && e.project !== env.project && !latest.has(e.project)) latest.set(e.project, e)
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
    // The house standard (docs/standard.md): every project inherits the same pipeline
    sections.push(
      '## How we build\n' +
        'Follow the house standard, ' + join(io.pluginRoot || '', 'docs/standard.md') + '. Standing order through 2026-10-18 (' + join(io.pluginRoot || '', 'docs/grok-review-2026-10-04.md') + '): do the work of the repo you were opened in. coter-kit and undertone are in use. Do not start a milestone, review arc, engine, source, or cleanup on them unless the user asks in this conversation. Wheat from chaff is what they used; cutting means removing what they did not use, not redesigning it. ' +
        'Pick the tier by stakes: light (prototypes, small internal changes), standard (client features, anything a user sees), full (privacy, consent, money, auth, deleting data). ' +
        'Standard and full: acceptance criteria that each name the test proving them, a read-only critic pass on the plan before building (2 rounds at most), tests watched failing first, every gate green (a skip is "not verified"). ' +
        'An outside review (/coter-kit:outside-review) only when its triage says a trigger fired (data that lasts, who can do what, things others depend on, things that run on their own, a big change, a fix to a high finding): once per push, once you would push it right now; verify every finding with your own evidence, fix the class. Only a confirmed high finding or a compliance issue blocks shipping; mediums are fixed if quick or deferred with a reason. ' +
        'Aim reviews at what users, attackers or bad data could break, not at wording or the process. Compliance, privacy and judgment calls go to the user; anything user-visible is done once they have walked it.',
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

// Notes Claude was using that another session retired since; telling empties it
export function takeRetired() {
  const gone = brain.retired.filter((e) => brain.entries.get(e.id)?.status !== 'active')
  brain.retired = []
  return gone
}

// This session's addressed notes that another session took delivery of since it was last told; telling empties it
export function takeDelivered() {
  const done = brain.deliveredArrived.map((id) => brain.entries.get(id)).filter((e) => e && e.delivered)
  brain.deliveredArrived = []
  return done
}

// Nothing is left to tell: a fresh snapshot carries the whole brain
export function forgetUnseen() {
  brain.unseen = []
  brain.retired = []
}

// Attached to the user's next message when other sessions wrote something this one should know
export function arrivalsContext(entries, retired = [], delivered = []) {
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
  if (retired.length) {
    sections.push('## No longer true\nAnother session retired these. Stop relying on them.\n' + retired.slice(0, 20).map((e) => '- [' + e.id + ' · ' + e.kind + '] ' + clip(e.text, 200)).join('\n'))
  }
  if (delivered.length) {
    sections.push(
      '## Your addressed notes were delivered\nThe sessions they were for have them now.\n' +
        delivered.slice(0, 20).map((e) => '- [' + e.id + '] to "' + e.to + '", delivered ' + ago(e.delivered.at) + ' on ' + e.delivered.device + ': ' + clip(e.text, 120)).join('\n'),
    )
  }
  return clip(sections.join('\n\n'), CONTEXT_BUDGET)
}

// Keyword search over approved notes, past ones included (not rejected or waiting for review)
// A run nobody watches (a scheduled task) gets what its lean brain promises, nothing more: this
// project's decisions, facts and threads, and the approved ways of working; never another project,
// a handoff, a waiting item or a route (RV-003 F2)
const leanVisible = (e) => (e.project === env.project && ['decision', 'fact', 'thread'].includes(e.kind)) || (e.kind === 'preference' && !e.project && e.status === 'active')

export function recall(query, project, { lean = false } = {}) {
  // Words in any script; a CJK query has no spaces, so one character is a word there (RV-003 F3)
  const words = String(query || '').normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 || /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(w))
  const now = Date.now()
  const scored = []
  for (const e of brain.entries.values()) {
    // A note waiting for review hasn't been approved, so it isn't memory yet (RV-001 F1)
    if (e.status === 'rejected' || e.status === 'pending') continue
    if (lean && !leanVisible(e)) continue
    if (project && e.project && e.project.toLowerCase() !== String(project).toLowerCase()) continue
    const hay = (e.text + ' ' + e.project + ' ' + e.kind).toLowerCase()
    const hits = words.filter((w) => hay.includes(w)).length
    if (words.length && !hits) continue
    const ageDays = (now - (e.updatedAt || e.at)) / DAY
    scored.push({ e, score: hits * 10 + (e.project === env.project ? 3 : 0) + (e.status === 'active' ? 2 : 0) - Math.min(ageDays, 60) / 20 })
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, 12).map((s) => s.e)
}

const addressedTo = (e) => (e.to ? ' · to "' + e.to + '", ' + (e.delivered ? 'delivered ' + ago(e.delivered.at) + ' on ' + e.delivered.device : 'not delivered yet') : '')
export const describe = (e) =>
  '[' + e.id + ' · ' + e.kind + (e.project ? ' · ' + e.project : '') + ' · ' + ago(e.updatedAt || e.at) + (e.status !== 'active' ? ' · ' + e.status : '') + addressedTo(e) + '] ' +
  (e.ref ? e.ref + ' · ' : '') + e.text + (e.link ? ' (' + e.link + ')' : '')

// ---------------------------------------------------------------- the digest

let digesting = false
// Only what is about the user (DIGEST-1, 10-7). Facts, threads and decisions come from Claude's own
// saves as they happen; the digest proposing them too filled /brain with 548 notes nobody could review
const DIGEST_KINDS = ['preference', 'term']

const DIGEST_PROMPT = (known) =>
  '[coter-kit memory digest. This is an automated request, not the user; nobody will read your reply but a parser.]\n' +
  'From this conversation, list only what it taught you about this user that a FUTURE session should know, as JSON lines, one object per line, nothing else:\n' +
  '{"kind": "preference" | "term", "text": "one short sentence", "scope": "global"}\n' +
  '- preference: how the user wants you to work or communicate, only if they said it or clearly reacted to it\n' +
  '- term: shorthand or jargon they use, as "<term>" = meaning\n' +
  'Nothing about the project itself: its decisions, open work and facts are saved as they happen. At most 4 lines. Leave out anything already known (below), secrets or credentials, and any personal data of their clients or of end users. Output nothing if nothing qualifies.\n' +
  'Already known:\n' + (known || '(nothing yet)')

// Asks the model, over this session's cached transcript, what is worth keeping
export async function digest(io, reason) {
  if (digesting || !brain.file) return 0
  digesting = true
  try {
    const known = [...brain.entries.values()]
      .filter((e) => e.status !== 'rejected' && DIGEST_KINDS.includes(e.kind))
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
      .slice(0, 4)
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

// Another session, or the user, is part-way through a rebase in this folder. While one is,
// none of our git commands may touch the folder: an add would mark half-resolved files as
// resolved, and a commit would move HEAD inside someone else's rebase (RV-002 F1)
async function rebaseUnderWay(io) {
  return (await io.exists(join(brain.dir, '.git/rebase-merge'))) || (await io.exists(join(brain.dir, '.git/rebase-apply')))
}

// Takes the other machines' notes: 'ok', 'no-branch' (the remote has no brain branch yet),
// 'busy' (another session on this machine is mid-rebase in the same folder) or 'failed'.
// Only a rebase this pull started and stopped on a conflict is undone; another session's
// rebase is never touched (RV-001 F4).
async function pull(io) {
  if (await rebaseUnderWay(io)) return 'busy'
  const r = await io.run(['git', '-C', brain.dir, 'pull', '-q', '--rebase', '--autostash', 'origin', brain.branch], { timeoutMs: 30_000 })
  if (r.exitCode === 0) return 'ok'
  const said = (r.stdout || '') + (r.stderr || '')
  if (/CONFLICT|could not apply/i.test(said)) {
    await io.run(['git', '-C', brain.dir, 'rebase', '--abort'])
    return 'failed'
  }
  if (/couldn't find remote ref/i.test(said)) return 'no-branch'
  return /index\.lock|rebase-merge|rebase-apply/i.test(said) ? 'busy' : 'failed'
}

// Re-reads the brain from disk and queues what other sessions wrote for Claude to be told.
// Other sessions on this machine write to the same folder, so this needs no remote.
// Changes to notes it already has count too (RV-002 F2): one approved since is told like a new one,
// and one it was using that another session retired is told as no longer true. This session's
// own changes are already in memory, so they never come back as news.
async function reload(io) {
  const before = brain.entries
  await loadBrain(io)
  const arrived = []
  for (const e of brain.entries.values()) {
    const was = before.get(e.id)
    // An answer to a question, whatever its project: one session on the machine acts on it, and the
    // one that asked may be in another project's folder (followerOf, waiting.js)
    if (!was && e.session !== env.sessionId && e.kind === 'decision' && e.answers) brain.answersArrived.push(e)
    // A note addressed to one session reaches that session, not everyone's context (addressed.js); when it
    // is this session's own and another session took delivery, this one is told
    if (e.to) {
      if ((e.session === env.sessionId || env.formerIds.includes(e.session)) && e.delivered && !was?.delivered) brain.deliveredArrived.push(e.id)
      continue
    }
    if (e.project && e.project !== env.project) continue
    if (!was ? e.session !== env.sessionId : was.status !== 'active' && e.status === 'active') arrived.push(e)
    else if (was && was.status === 'active' && e.status !== 'active') brain.retired.push(e)
  }
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
        if (brain.remote) brain.lastPullResult = await pull(io)
        return await reload(io)
      } finally {
        brain.lastPull = await io.now()
        brain.refreshing = null
      }
    })()
  }
  return brain.refreshing
}

// Re-reads this machine's copy only, with no pull: cheap enough to run right before acting on something
// another session here may have just written (RV-011 F1)
export async function reread(io) {
  if (!brain.dir) return []
  return brain.refreshing || reload(io)
}

export async function refreshIfStale(io, maxAgeMs) {
  if (!brain.dir || (await io.now()) - brain.lastPull < maxAgeMs) return []
  return refresh(io)
}

// This session's notes went out: its journal file is committed, and nothing is left unpushed.
// Another session can hold git's lock at the moment this one commits, so "the push worked" is not
// enough to say "your notes are synced" (RV-003 F4)
async function delivered(io) {
  if (!brain.file) return true
  const rel = brain.file.slice(brain.dir.length + 1)
  const changed = (await io.run(['git', '-C', brain.dir, 'diff', '--name-only', 'HEAD', '--', rel])).stdout.trim()
  const untracked = (await io.run(['git', '-C', brain.dir, 'ls-files', '--others', '--', rel])).stdout.trim()
  const ahead = Number((await io.run(['git', '-C', brain.dir, 'rev-list', '--count', 'origin/' + brain.branch + '..HEAD'])).stdout.trim() || 0)
  return !changed && !untracked && !ahead
}

export async function syncNow(io) {
  if (!brain.dir) return null
  if (await rebaseUnderWay(io)) {
    brain.lastSync = { ok: false, at: Date.now(), error: 'another session is syncing; the next sync retries', arrived: 0 }
    return brain.lastSync
  }
  await commit(io)
  if (!brain.remote) {
    const arrived = await refresh(io)
    brain.lastSync = { ok: true, at: Date.now(), local: true, arrived: arrived.length }
    return brain.lastSync
  }
  const arrived = await refresh(io)
  // Push only on top of a pull that worked, or to create the branch the first time: never from
  // the middle of another session's rebase (RV-001 F4)
  if (brain.lastPullResult !== 'ok' && brain.lastPullResult !== 'no-branch') {
    brain.lastSync = { ok: false, at: Date.now(), error: brain.lastPullResult === 'busy' ? 'another session is syncing; the next sync retries' : 'the pull failed; the next sync retries', arrived: arrived.length }
    return brain.lastSync
  }
  const pushNow = () => io.run(['git', '-C', brain.dir, 'push', '-q', 'origin', 'HEAD:' + brain.branch], { timeoutMs: 30_000 })
  let push = await pushNow()
  if (push.exitCode === 0 && !(await delivered(io))) {
    // Another session held git's lock when this one committed: once more
    await commit(io)
    push = await pushNow()
  }
  const out = push.exitCode === 0 && (await delivered(io))
  const error = push.exitCode !== 0 ? clip(push.stderr.trim(), 200) : out ? '' : "some of this session's notes are not pushed yet; the next sync retries"
  brain.lastSync = { ok: out, at: Date.now(), error, arrived: arrived.length }
  return brain.lastSync
}

function scheduleSync(io) {
  if (brain.syncTimer) brain.syncTimer.cancel()
  brain.syncTimer = io.after(SYNC_DELAY_MS, async () => {
    brain.syncTimer = null
    await syncNow(io)
  })
}
