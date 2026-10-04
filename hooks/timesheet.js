// coter-kit: timesheets (M4, docs/build-plan.md "Billable time"). Pure functions; register.js
// reads and writes the files.
//
// The live status files (live.js) already hold the raw material: each session's beats (the user's
// time, credited once when the beat happened) and turns (Claude's). This module rolls them up per
// project per local day, one file per machine in the brain, at timesheets/<device>.json:
//
//   { v, device, updated_at,
//     days: { <date>: { <project>: { you_ms, claude_ms, claude_wall_ms, scheduled_ms } } },
//     adjustments: [{ id, date, project, min, note, at }],   // manual lines (calls, meetings)
//     confirmed: { <monday>: { at, device, billed_min: { <project>: min } } } }
//
//   you_ms          the user's time: the credit of each beat, never more than the minutes since midnight
//   claude_ms       Claude's time: main-thread turn minutes, summed over the project's sessions
//   claude_wall_ms  the same turns as wall clock (parallel sessions count once)
//   scheduled_ms    the part of claude_ms that scheduled runs did (they never earn you time)
//
// Hours billed are the user's time per project per day, rounded up to the next 6 minutes (0.1 h),
// plus the manual lines. The machines only ever write their own file, so the brain's sync can't
// make them collide; a week is every machine's file added up.

import { startOfDay, dayOf } from './live.js'
import { span } from './util.js'

export const BILL_UNIT_MIN = 6
export const RATIO_FLAG = 5
const MIN = 60_000
const DAY = 86_400_000
const FIELDS = ['you_ms', 'claude_ms', 'claude_wall_ms', 'scheduled_ms']
export const KEEP_DAYS = 400

const ms = (v) => (typeof v === 'number' ? v : v ? Date.parse(v) : 0)
// A project called __proto__ would write to Object.prototype where names are used as keys (RV-005 F6)
const unsafe = (name) => name === '__proto__'
// Project names are keys of plain objects, and `constructor` or `toString` must not find the inherited ones (RV-007 F6)
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key)
const num = (v) => (Number.isFinite(v) ? v : 0)
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const list = (v) => (Array.isArray(v) ? v : [])

// Is this a timesheet file of the v1 shape all the way down? A file that isn't is left alone (RV-008 F4)
export function validSheet(f) {
  if (!isObj(f) || typeof f.device !== 'string' || !f.device || !isObj(f.days)) return false
  if (!Object.values(f.days).every((day) => isObj(day) && Object.values(day).every(isObj))) return false
  if (f.adjustments !== undefined && !(Array.isArray(f.adjustments) && f.adjustments.every(isObj))) return false
  if (f.confirmed !== undefined && !(isObj(f.confirmed) && Object.values(f.confirmed).every(isObj))) return false
  return true
}
const empty = () => ({ you_ms: 0, claude_ms: 0, claude_wall_ms: 0, scheduled_ms: 0 })

// A date 'YYYY-MM-DD' as local midnight
const dateMs = (date) => {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, m - 1, d).getTime()
}
const addDays = (date, n) => dayOf(dateMs(date) + n * DAY + DAY / 2) // noon steps over daylight-saving changes
export const weekOf = (date) => {
  const dow = (new Date(dateMs(date) + DAY / 2).getDay() + 6) % 7 // Monday = 0
  return addDays(date, -dow)
}
export const weekDates = (monday) => Array.from({ length: 7 }, (_, i) => addDays(monday, i))

// Sorted spans merged where they overlap
function union(spans) {
  const out = []
  for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0])) {
    if (b <= a) continue
    const last = out[out.length - 1]
    if (last && a <= last[1]) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out
}
const length = (spans) => spans.reduce((sum, [a, b]) => sum + (b - a), 0)

// One session's turns, plus the one still running (up to the record's last heartbeat)
function turnSpans(r) {
  const spans = (r.turns || []).map(([a, b]) => [a, b])
  if (r.state === 'working' && r.state_since) spans.push([ms(r.state_since), ms(r.updated_at)])
  return spans
}

// What the records say about one local day, per project
export function dayTotals(records, date) {
  const from = dateMs(date)
  const to = dateMs(addDays(date, 1))
  const out = {}
  const byProject = {}
  const seen = new Set()
  for (const r of records) {
    if (!r || !r.project || unsafe(r.project) || seen.has(r.id)) continue
    seen.add(r.id)
    const t = has(out, r.project) ? out[r.project] : (out[r.project] = empty())
    // The user's time: a beat counts on the day it happened, and a beat just after midnight only
    // the minutes since midnight (RV-001 F8)
    if (!r.scheduled) for (const [at, credit] of r.beats || []) if (at >= from && at < to) t.you_ms += Math.min(credit, at - from)
    const clipped = union(turnSpans(r).map(([a, b]) => [Math.max(a, from), Math.min(b, to)]))
    const mine = length(clipped)
    t.claude_ms += mine
    if (r.scheduled) t.scheduled_ms += mine
    ;(has(byProject, r.project) ? byProject[r.project] : (byProject[r.project] = [])).push(...clipped)
  }
  for (const [project, spans] of Object.entries(byProject)) out[project].claude_wall_ms = length(union(spans))
  for (const [project, t] of Object.entries(out)) if (!FIELDS.some((f) => t[f])) delete out[project]
  return out
}

// This machine's file after a look at its live records. A day's beats leave the live files after
// 36 hours, so a day that is already in the file never shrinks: each field keeps the larger value.
// The adjustments and confirmations the file already holds carry through.
export function updateMachine(prior, { device, records, now, lookBackDays = 7 }) {
  const days = { ...(prior?.days || {}) }
  const today = dayOf(now)
  for (let i = lookBackDays; i >= 0; i--) {
    const date = addDays(today, -i)
    const fresh = dayTotals(records, date)
    const kept = has(days, date) && isObj(days[date]) ? days[date] : {}
    const merged = {}
    for (const project of new Set([...Object.keys(kept), ...Object.keys(fresh)])) {
      if (unsafe(project)) continue
      merged[project] = {}
      for (const f of FIELDS) merged[project][f] = Math.max(has(kept, project) && isObj(kept[project]) ? num(kept[project][f]) : 0, has(fresh, project) ? num(fresh[project][f]) : 0)
    }
    if (Object.keys(merged).length) days[date] = merged
    else delete days[date]
  }
  const oldest = addDays(today, -KEEP_DAYS)
  for (const date of Object.keys(days)) if (date < oldest) delete days[date]
  return { v: 1, device, updated_at: new Date(now).toISOString(), days, adjustments: list(prior?.adjustments), confirmed: isObj(prior?.confirmed) ? prior.confirmed : {} }
}

// Minutes billed for a stretch of the user's time: up to the next 6 minutes
export const billedMinutes = (youMs) => Math.ceil(youMs / MIN / BILL_UNIT_MIN) * BILL_UNIT_MIN

// A week (from its Monday) across every machine's file
export function sheetFor(files, monday) {
  const dates = weekDates(monday)
  const projects = {}
  const proj = (name) => (has(projects, name) ? projects[name] : (projects[name] = { days: {}, ...empty(), adjust_min: 0, billed_min: 0 }))
  for (const f of files) {
    for (const date of dates) {
      for (const [name, t] of Object.entries(isObj(f.days) && has(f.days, date) && isObj(f.days[date]) ? f.days[date] : {})) {
        if (unsafe(name)) continue
        const p = proj(name)
        const d = has(p.days, date) ? p.days[date] : (p.days[date] = empty())
        for (const k of FIELDS) { d[k] += num(t?.[k]); p[k] += num(t?.[k]) }
      }
    }
    for (const a of list(f.adjustments)) if (isObj(a) && dates.includes(a.date) && !unsafe(a.project)) proj(a.project).adjust_min += num(a.min)
  }
  const total = { you_ms: 0, claude_ms: 0, adjust_min: 0, billed_min: 0 }
  for (const p of Object.values(projects)) {
    p.billed_min = Object.values(p.days).reduce((sum, d) => sum + billedMinutes(d.you_ms), 0) + p.adjust_min
    for (const k of Object.keys(total)) total[k] += p[k]
  }
  // The latest confirmation of this week, from any machine, and what moved since
  let confirmed = null
  for (const f of files) {
    const c = isObj(f.confirmed) ? f.confirmed[monday] : null
    if (isObj(c) && (!confirmed || ms(c.at) > ms(confirmed.at))) confirmed = { ...c, device: c.device || f.device }
  }
  if (confirmed) {
    const names = new Set([...Object.keys(confirmed.billed_min || {}), ...Object.keys(projects)])
    confirmed.changed = [...names].map((project) => ({ project, was: confirmed.billed_min?.[project] || 0, now: projects[project]?.billed_min || 0 })).filter((c) => c.was !== c.now)
  }
  return { week: monday, from: dates[0], to: dates[6], dates, devices: files.map((f) => f.device), projects, total, confirmed }
}

// May this week be confirmed now? It has to be over. A machine that may hold hours this sheet
// can't see blocks the confirm unless the owner says so (`force`) (RV-005 F5, RV-007 F3/F5):
//   - one with no file here at all but with notes in the week (`roster`: [{ device, dates }], the
//     dates of its journal files and undertone summaries in the brain), and
//   - one whose file is here but could not be read (`unreadable`), and
//   - one whose file stopped before the week ended, if it wrote within the 7 days before the week
//     or has notes in the week. A retired machine's old file blocks nothing.
// A machine that has left no note and no file anywhere can't be known; the owner's own count is
// the check on that.
export function confirmCheck(files, monday, now, { roster = [], unreadable = [], force = false } = {}) {
  const end = dateMs(addDays(monday, 7))
  if (now < end) return { ok: false, reason: 'The week of ' + monday + ' runs until Sunday night. Confirm it from Monday.' }
  const sheet = sheetFor(files, monday)
  const dates = weekDates(monday)
  const active = (device) => roster.some((r) => r.device === device && (r.dates || []).some((d) => dates.includes(d)))
  const recent = (f) => ms(f.updated_at) >= dateMs(monday) - 7 * DAY
  const stale = files.filter((f) => ms(f.updated_at) < end && (recent(f) || active(f.device))).map((f) => f.device)
  const absent = roster.filter((r) => !files.some((f) => f.device === r.device) && active(r.device)).map((r) => r.device)
  const missing = [...stale, ...absent, ...unreadable]
  if (missing.length && !force) {
    return {
      ok: false,
      missing,
      reason: 'Not confirmed: ' + [stale.length ? stale.join(', ') + ' last wrote before the week ended' : '', absent.length ? absent.join(', ') + ' worked this week but ' + (absent.length > 1 ? 'have' : 'has') + ' no timesheet here yet' : '', unreadable.length ? unreadable.join(', ') + ': the file could not be read' : ''].filter(Boolean).join('; ') + '. Their hours may be missing: /brain sync, or update coter-kit on that machine. To confirm without them: /timesheet confirm' + (monday === weekOf(dayOf(now)) ? '' : ' last') + ' anyway.',
    }
  }
  const billed_min = {}
  for (const [name, p] of Object.entries(sheet.projects)) if (p.billed_min) billed_min[name] = p.billed_min
  return { ok: true, missing, sheet, record: { at: new Date(now).toISOString(), billed_min } }
}

// /timesheet add <project> <duration> [date] <note>: 45m, 1.5h or 90 (minutes); negative to take time off.
// The size rounds up, away from zero, to the 6-minute unit.
export function parseAdjustment(text, now) {
  const m = String(text || '').trim().match(/^(\S+)\s+(-?\d+(?:\.\d+)?)\s*(h|m)?\b\s*(\d{4}-\d{2}-\d{2})?\s*(.*)$/i)
  const bad = (reason) => ({ ok: false, reason })
  if (!m) return bad('Say it as: /timesheet add <project> <time, like 45m or 1.5h> [date] <what it was>')
  const [, project, num, unit, date, note] = m
  const raw = Number(num) * ((unit || 'm').toLowerCase() === 'h' ? 60 : 1)
  const min = Math.sign(raw) * Math.ceil(Math.abs(raw) / BILL_UNIT_MIN - 1e-9) * BILL_UNIT_MIN
  if (unsafe(project)) return bad(project + ' cannot be a project name.')
  if (!min) return bad('That is no time at all.')
  if (Math.abs(min) > 24 * 60) return bad('A line is at most 24 hours; split it by day.')
  const day = date || dayOf(now)
  if (date && dayOf(dateMs(date)) !== date) return bad(date + ' is not a date.')
  return { ok: true, project, date: day, min, note: note.trim() }
}

const hm = (min) => span(min * MIN)
const hours = (min) => (min / 60).toFixed(1) + ' h'

// The sheet as text: three columns (yours, Claude's, adjustments) and the hours to bill
export function formatSheet(s, { days = false } = {}) {
  const names = Object.keys(s.projects).sort((a, b) => s.projects[b].billed_min - s.projects[a].billed_min || a.localeCompare(b))
  const width = Math.max(10, ...names.map((n) => n.length)) + 2
  const adj = (min) => (min ? (min > 0 ? '+' : '-') + hm(Math.abs(min)) : '·')
  const cell = (text, w) => text.padStart(w)
  const row = (name, you, claude, adjust, bill) => name.padEnd(width) + cell(you, 9) + cell(claude, 10) + cell(adjust, 9) + cell(bill, 9)
  const state = s.confirmed ? 'confirmed ' + dayOf(ms(s.confirmed.at)) + (s.confirmed.device ? ' on ' + s.confirmed.device : '') : 'not confirmed'
  const lines = [`Timesheet · week ${s.from} to ${s.to} · ${s.devices.join(' + ') || 'no machines yet'} · ${state}`, '', row('', 'yours', 'Claude', 'adjust', 'bill')]
  for (const n of names) {
    const p = s.projects[n]
    lines.push(row(n, p.you_ms ? span(p.you_ms) : '·', p.claude_ms ? span(p.claude_ms) : '·', adj(p.adjust_min), hours(p.billed_min)))
    if (days) {
      for (const date of Object.keys(p.days).sort()) {
        const d = p.days[date]
        lines.push('  ' + date + '  yours ' + (d.you_ms ? span(d.you_ms) : '·') + ' (bills ' + hours(billedMinutes(d.you_ms)) + ') · Claude ' + (d.claude_ms ? span(d.claude_ms) : '·'))
      }
    }
  }
  if (!names.length) lines.push('Nothing recorded in this week yet.')
  else lines.push(row('total', s.total.you_ms ? span(s.total.you_ms) : '·', s.total.claude_ms ? span(s.total.claude_ms) : '·', adj(s.total.adjust_min), hours(s.total.billed_min)))
  for (const n of names) {
    const p = s.projects[n]
    if (p.you_ms && p.claude_ms >= RATIO_FLAG * p.you_ms) lines.push(n + ': Claude ran ' + (p.claude_ms / p.you_ms).toFixed(1) + 'x your time; hourly pay undercounts it, so price the next piece as a milestone')
  }
  if (s.confirmed?.changed?.length) lines.push('changed since you confirmed: ' + s.confirmed.changed.map((c) => c.project + ' ' + hours(c.was) + ' -> ' + hours(c.now)).join(', '))
  lines.push('', 'yours: time before each of your messages and commands, up to 15m each, never counted twice on one machine · Claude: minutes a turn ran, summed over sessions · bill: yours rounded up to 0.1 h per project per day, plus adjustments')
  return lines.join('\n')
}
