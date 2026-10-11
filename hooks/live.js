// coter-kit: the live status file. Every running session writes one small JSON file,
// ~/.claude/coter-kit/live/<date opened>/<session>.json, of what it is doing and what needs
// the user, so undertone, /glance, the home dashboard and a phone notifier read state
// instead of parsing the brain or transcripts (or spending credits to work it out).
//
// Readers look in every day folder (a session stays in the folder of the day it opened). A file
// whose updated_at is more than
// 3 minutes old belongs to a session that died (sessions write a heartbeat every minute);
// one whose state is "ended" closed normally. Files stay for a week, for the minutes.
//
// Billable time (docs/build-plan.md): each of the user's beats (a message, a kit command, an
// answered permission prompt) counts the time before it, back to the later of their previous
// beat anywhere on this machine and the end of this session's last turn, capped at 15
// minutes. Claude's time is its main-thread turns. Scheduled runs earn the user nothing.
// The file carries no prompt text, file paths (not even the session's folder: RV-001 F6) or
// commands; the checklist step and the session's name are the user's own wording in it, so
// anything that sends it off the machine redacts or drops them.

import { join } from './util.js'

export const LIVE_VERSION = 1
export const BEAT_CAP_MS = 15 * 60_000
export const IDLE_AFTER_MS = 15 * 60_000
export const STALE_AFTER_MS = 3 * 60_000
export const KEEP_DAYS = 7
const DAY = 86_400_000

export const liveRoot = (home) => join(home, '.claude/coter-kit/live')

// The local date, as the folder name: 2026-10-03
export function dayOf(ms) {
  const d = new Date(ms)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

export function startOfDay(ms) {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

// How much of the time before a beat counts as the user's
export function beatCredit(at, { lastBeatAnywhere = 0, lastTurnEnd = 0, openedAt = 0 } = {}) {
  const from = Math.max(lastBeatAnywhere, lastTurnEnd) || openedAt || at
  return Math.max(0, Math.min(at - from, BEAT_CAP_MS))
}

// Minutes since local midnight: the user's from their beats, Claude's from its turns (clipped)
export function minutesToday({ beats, turns, turnStartedAt = 0 }, now) {
  const from = startOfDay(now)
  // A beat just after midnight credits only the minutes since midnight to today (RV-001 F8)
  const you = beats.filter(([at]) => at >= from).reduce((sum, [at, credit]) => sum + Math.min(credit, at - from), 0)
  const spans = [...turns, ...(turnStartedAt ? [[turnStartedAt, now]] : [])]
  const claude = spans.reduce((sum, [a, b]) => sum + Math.max(0, b - Math.max(a, from)), 0)
  return { you: Math.round(you / 60_000), claude: Math.round(claude / 60_000) }
}

// Only the last day and a half is kept in the file: beats are [at, credit], turns [start, end]
export const recentBeats = (beats, now) => beats.filter(([at]) => at >= now - 1.5 * DAY)
export const recentTurns = (turns, now) => turns.filter(([, end]) => end >= now - 1.5 * DAY)

const iso = (ms) => (ms ? new Date(ms).toISOString() : null)

// The record a session writes. `s` is the session's own view of itself.
export function liveRecord(s, now) {
  const state = s.state === 'your_move' && now - s.stateSince >= IDLE_AFTER_MS ? 'idle' : s.state
  const done = s.checklist.items.filter((it) => it.status === 'done').length
  const current = s.checklist.items.find((it) => it.status === 'active') || s.checklist.items.find((it) => it.status === 'pending')
  return {
    v: LIVE_VERSION,
    tool: 'claude',
    id: s.id,
    device: s.device,
    project: s.project,
    worktree: s.worktree || '',
    branch: s.branch || '',
    // The session's title, as ListAgents shows it: what addressed notes name it by (addressed.js)
    name: s.name || '',
    // Its origin remote as host/owner/name, or '': two repositories of one folder name are told apart by it
    repo: s.repo || '',
    opened_at: iso(s.openedAt),
    updated_at: iso(now),
    last_event_at: iso(s.lastEventAt),
    state,
    state_since: iso(state === 'idle' && s.state === 'your_move' ? s.stateSince + IDLE_AFTER_MS : s.stateSince),
    scheduled: !!s.scheduled,
    // This session's code can send phone pushes, so it may be the one that does (phone.js)
    pushes: true,
    checklist: s.checklist.items.length
      ? { title: s.checklist.title || '', done, total: s.checklist.items.length, current: current ? current.text : '', blocked: s.checklist.items.filter((it) => it.status === 'blocked').length }
      : null,
    checks: s.checks && s.checks.state !== 'idle' ? { state: s.checks.state, summary: s.checks.summary, at: iso(s.checks.at) } : null,
    build_broken_since: iso(s.brokenSince),
    needs_you: s.needs,
    minutes_today: minutesToday(s, now),
    // What the session has used at API prices and how full its context is, and the account's
    // rate-limit windows: what a routing choice is weighed against (docs/routing.md)
    usage: s.usage
      ? { cost_usd: typeof s.usage.cost?.usd === 'number' ? Math.round(s.usage.cost.usd * 100) / 100 : null, context_pct: s.usage.context?.percent ?? null, context_tokens: s.usage.context?.tokens ?? null }
      : null,
    rate_limits: (s.usage?.rateLimits || []).map((r) => ({ kind: r.kind, percent_used: r.percentUsed, resets_at: r.resetsAt || null })),
    last_beat_at: iso(s.beats.length ? s.beats[s.beats.length - 1][0] : 0),
    beats: recentBeats(s.beats, now),
    turns: recentTurns(s.turns, now),
  }
}

const ms = (v) => (v ? Date.parse(v) : 0)

// A record as a reader sees it: still running, ended, or died (no heartbeat for 3 minutes)
export function liveness(rec, now) {
  if (rec.state === 'ended') return 'ended'
  return now - ms(rec.updated_at) > STALE_AFTER_MS ? 'died' : 'live'
}

// The newest beat across every other session's record, for beatCredit
export const lastBeatIn = (records, exceptId) =>
  Math.max(0, ...records.filter((r) => r.id !== exceptId).map((r) => ms(r.last_beat_at)))

const ORDER = { needs_ok: 0, your_move: 1, working: 2, idle: 3 }
const LABEL = { needs_ok: 'needs your OK', your_move: 'your move', working: 'working', idle: 'idle' }
const MARK = { needs_ok: '!', your_move: '◆', working: '▸', idle: '·' }

const short = (msSpan) => {
  const m = Math.round(msSpan / 60_000)
  return m < 60 ? m + 'm' : Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0')
}

// /glance: one line per running session, what needs the user first, and today's totals
export function glance(records, now) {
  const live = records.filter((r) => liveness(r, now) === 'live').sort((a, b) => (ORDER[a.state] ?? 9) - (ORDER[b.state] ?? 9) || ms(b.state_since) - ms(a.state_since))
  const rows = live.map((r) => {
    const parts = [(MARK[r.state] || '·') + ' ' + (r.project || '?') + (r.worktree ? ' · ' + r.worktree : ''), LABEL[r.state] || r.state, short(now - ms(r.state_since))]
    if (r.checklist) parts.push(r.checklist.done + '/' + r.checklist.total + (r.checklist.current ? ' ' + r.checklist.current : ''))
    if (r.build_broken_since) parts.push('build broken ' + short(now - ms(r.build_broken_since)))
    if (r.usage && (r.usage.cost_usd != null || r.usage.context_pct != null)) {
      parts.push([r.usage.cost_usd != null ? '$' + r.usage.cost_usd.toFixed(2) : '', r.usage.context_pct != null ? 'context ' + Math.round(r.usage.context_pct) + '%' : ''].filter(Boolean).join(' · '))
    }
    if (r.scheduled) parts.push('scheduled')
    return { state: r.state, text: parts.join('  ') }
  })
  // Waiting items and handoffs are per project, so count each project once
  const projects = new Map()
  for (const r of live) if (r.needs_you) projects.set(r.project, r.needs_you)
  const waiting = [...projects.values()].reduce((sum, n) => sum + (n.waiting || 0), 0)
  // Minutes come from every session today, ended and died ones included
  const today = records.filter((r) => ms(r.updated_at) >= startOfDay(now))
  const you = today.reduce((sum, r) => sum + (r.minutes_today?.you || 0), 0)
  const claude = today.reduce((sum, r) => sum + (r.minutes_today?.claude || 0), 0)
  // The account's windows are the same in every session: take the freshest reading
  const freshest = [...records].sort((a, b) => ms(b.updated_at) - ms(a.updated_at)).find((r) => r.rate_limits?.length)
  const limits = (freshest?.rate_limits || []).map((l) => l.kind.replace(/_/g, '-') + ' ' + Math.round(l.percent_used) + '%').join(', ')
  return { rows, waiting, you, claude, limits, died: records.filter((r) => liveness(r, now) === 'died' && now - ms(r.updated_at) < 3_600_000).length }
}
