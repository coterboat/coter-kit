// coter-kit: the outside reviewer's desk. The review-brain skill reads the queue and records
// a verdict on each note with the review tool; the user applies the picks with one press in
// /brain. The anti-churn rules from docs/build-plan.md are enforced here, so they hold
// whatever the reviewer's prompt says:
//
//  1. The incumbent wins ties: a verdict that changes a live note needs evidence.
//  2. The user's own notes (ones they confirmed, or answers to their questions) are only ever
//     challenged: the picks button never applies a verdict against them.
//  3. Steelman first: a verdict against a live note must state the best case for keeping it.
//  4. Flip-flops freeze: a note whose topic was replaced twice in a week, or a rewrite that
//     goes back to an earlier answer, is marked unsettled, and the picks button leaves it.
//  5. It keeps score: every time the user goes against a verdict is counted, by kind.
//
// On its own it applies one thing, the one it can prove in code: an exact duplicate of a live
// note is dropped (rejected if it was waiting for review, superseded if it was live).

import { env, clip, ago } from './util.js'
import { brain, remember, setStatus, appendOps, isLive, sameText, redact } from './brain.js'

export const REVIEW_TOOL = 'mcp__coter-kit__review'
export const VERDICTS = ['accept', 'reject', 'rewrite', 'merge', 'retire', 'ask']
// Verdicts that would change or remove a note
const CHANGES = new Set(['reject', 'rewrite', 'merge', 'retire'])
const WEEK = 7 * 86_400_000
const QUEUE_DAYS = 7

// A note the user made: they confirmed it, or it answers one of their questions
export const isProtected = (e) => !!(e.confirmed || e.answers)

// The notes this one replaced, newest first
function ancestors(e) {
  const out = []
  const seen = new Set([e.id])
  let cur = e
  while (cur.replaces && !seen.has(cur.replaces)) {
    const prev = brain.entries.get(cur.replaces)
    if (!prev) break
    seen.add(prev.id)
    out.push(prev)
    cur = prev
  }
  return out
}

// Rule 4: replaced twice in a week, or a rewrite that returns to an earlier answer
export function isUnsettled(e, replacementText, now = Date.now()) {
  const chain = [e, ...ancestors(e)]
  const recent = chain.filter((n) => n.replaces && now - n.at <= WEEK).length
  if (recent >= 2) return true
  return !!replacementText && chain.slice(1).some((n) => sameText(n.text) === sameText(replacementText))
}

// What the reviewer looks at: everything waiting for review, and every note that went live in
// the last week without a verdict (handoffs and waiting items are the user's, not the reviewer's)
export function reviewQueue(now = Date.now()) {
  return [...brain.entries.values()]
    .filter((e) => e.kind !== 'handoff' && e.kind !== 'waiting' && e.kind !== 'route' && !e.review)
    .filter((e) => e.status === 'pending' || (e.status === 'active' && now - e.at <= QUEUE_DAYS * 86_400_000))
    .sort((a, b) => a.at - b.at)
}

export function queueText(items, now = Date.now()) {
  if (!items.length) return 'Nothing to review.'
  return items
    .map((e) => {
      const tags = [e.status === 'pending' ? 'waiting for review' : 'live', e.kind, e.project || 'global', e.source || 'claude', ago(e.updatedAt || e.at)]
      if (isProtected(e)) tags.push("the user's own")
      if (e.replaces) tags.push('replaced ' + e.replaces)
      if (isUnsettled(e, '', now)) tags.push('unsettled')
      return '[' + e.id + ' · ' + tags.join(' · ') + '] ' + e.text
    })
    .join('\n')
}

// Records verdicts under the rules; returns what was recorded, refused and applied on its own
export async function recordVerdicts(io, verdicts, now = Date.now()) {
  const rows = []
  const refused = []
  const auto = []
  // Only what the queue offered: not handoffs, waiting items or routes, which are the user's
  // records, and not notes already settled (RV-002 F3). A note the reviewer already ruled on can be
  // ruled on again until the user decides it.
  const queue = new Set(reviewQueue(now).map((n) => n.id))
  const reviewable = (n) => !!n && (queue.has(n.id) || (!!n.review && !n.review.by && (n.status === 'pending' || n.status === 'active')))
  for (const v of Array.isArray(verdicts) ? verdicts : []) {
    const e = brain.entries.get(v.ref)
    const why = (text) => refused.push(v.ref + ': ' + text)
    if (!e) {
      why('no such note')
      continue
    }
    if (!reviewable(e)) {
      why('not in the review queue (handoffs, waiting items, routes and settled notes are not the reviewer\'s)')
      continue
    }
    if (!VERDICTS.includes(v.verdict)) {
      why('verdict must be one of ' + VERDICTS.join(', '))
      continue
    }
    // Everything the reviewer writes is redacted like any note: it reads code and logs (RV-003 F1)
    const evidence = redact(String(v.evidence || '').trim())
    const steelman = redact(String(v.steelman || '').trim())
    const replacement = v.replacement && String(v.replacement.text || '').trim() ? { kind: v.replacement.kind || e.kind, text: clip(redact(String(v.replacement.text).trim()), 400) } : null
    if (v.verdict !== 'ask' && !evidence) {
      why('every verdict but ask needs evidence: a file:line, a commit, a session and time, or the id of the note it repeats')
      continue
    }
    // Rules 1 and 3: changing a live note takes evidence (above) and the best case for keeping it
    if (e.status === 'active' && CHANGES.has(v.verdict) && !steelman) {
      why('changing a live note needs a steelman: the strongest case for keeping it as it is')
      continue
    }
    if ((v.verdict === 'rewrite' || v.verdict === 'merge') && !replacement) {
      why(v.verdict + ' needs a replacement { text }')
      continue
    }
    // Every note a merge would retire is checked like the note itself: in the queue's kinds, the same
    // project, not already settled; and if any is the user's, or a live decision, or unsettled, the
    // whole merge becomes the user's call (RV-002 F3)
    const ids = v.verdict === 'merge' ? (Array.isArray(v.with) ? v.with : []).filter((id) => id !== e.id) : []
    const unknown = ids.filter((id) => !brain.entries.has(id))
    if (unknown.length) {
      why('a merge names notes that do not exist: ' + unknown.join(', '))
      continue
    }
    const members = ids.map((id) => brain.entries.get(id))
    // Members are held to the same bar as the note itself, and one the user already kept or
    // dropped is theirs (RV-003 F5)
    if (members.some((m) => !reviewable(m) || (m.project || '') !== (e.project || ''))) {
      why('a merge may only take in notes from the review queue, in the same project')
      continue
    }
    const merged = members.map((m) => m.id)
    const memberGuarded = members.some((m) => isProtected(m) || isLiveDecision(m) || m.review?.by === 'user')
    const memberFrozen = members.some((m) => isUnsettled(m, '', now))
    const row = {
      op: 'review',
      ref: e.id,
      verdict: v.verdict,
      reason: clip(redact(String(v.reason || '').trim()), 300),
      evidence: clip(evidence, 300),
      ...(steelman ? { steelman: clip(steelman, 300) } : {}),
      ...(replacement ? { replacement } : {}),
      ...(merged.length ? { with: merged } : {}),
      // Rule 2: against the user's own note, a verdict is a challenge, never applied for them
      ...((isProtected(e) && CHANGES.has(v.verdict)) || memberGuarded ? { protected: true } : {}),
      // Rule 4
      ...((CHANGES.has(v.verdict) && isUnsettled(e, replacement?.text, now)) || memberFrozen ? { frozen: true } : {}),
      at: now,
      device: env.device,
      session: env.sessionId,
    }
    // The one thing it does alone: an exact duplicate of a live note goes, if it isn't the user's
    // Literally the same note, in the same project, and the other one is live: anything looser
    // (C and C++, the same words in two projects) waits for the user (RV-001 F2)
    const dup = v.verdict === 'reject' && v.duplicateOf ? brain.entries.get(v.duplicateOf) : null
    // Exactly the same text: /data and /Data are different paths, so only line endings and
    // surrounding space are ignored (RV-002 F6)
    const literal = (s) => String(s).replace(/\r\n/g, '\n').trim()
    if (dup && dup.id !== e.id && isLive(dup, now) && dup.kind === e.kind && (dup.project || '') === (e.project || '') && literal(dup.text) === literal(e.text) && !row.protected) row.auto = true
    rows.push(row)
    brain.entries.set(e.id, { ...brain.entries.get(e.id), review: row })
  }
  await appendOps(io, rows)
  for (const row of rows.filter((r) => r.auto)) {
    const e = brain.entries.get(row.ref)
    await setStatus(io, e.id, e.status === 'pending' ? 'rejected' : 'superseded')
    auto.push(e.id)
  }
  return { recorded: rows.length, refused, auto }
}

// A verdict that still has something to do, given where the note stands now
export function isOpen(e) {
  const v = e.review
  // The user's own keep or drop closes it
  if (!v || v.by === 'user' || v.verdict === 'ask') return false
  if (v.verdict === 'accept') return e.status === 'pending'
  return e.status === 'pending' || e.status === 'active'
}

// A verdict against the user's own note, whether that was known when it was recorded or worked
// out since (brain.js links older answers to the questions they closed). A live decision is
// guarded too: a decision the user made in conversation looks like any other in the data, so
// changing one is always their call (RV-001 F3)
export const isLiveDecision = (e) => e.kind === 'decision' && e.status === 'active'
export const isGuarded = (e) => !!e.review && (!!e.review.protected || ((isProtected(e) || isLiveDecision(e)) && CHANGES.has(e.review.verdict)))

// The picks one press applies: open verdicts that aren't challenges to the user's own notes
// and aren't frozen
export const picks = () => [...brain.entries.values()].filter((e) => isOpen(e) && !isGuarded(e) && !e.review.frozen)

// Live notes the reviewer wants changed, for /brain's challenges list
export const challenges = () => [...brain.entries.values()].filter((e) => e.status === 'active' && isOpen(e) && CHANGES.has(e.review.verdict))

// Carries out one verdict: the user pressed for it
export async function applyVerdict(io, e) {
  const v = e.review
  if (!isOpen(e)) return false
  if (v.verdict === 'accept') return setStatus(io, e.id, 'active')
  if (v.verdict === 'reject') return setStatus(io, e.id, e.status === 'pending' ? 'rejected' : 'superseded')
  if (v.verdict === 'retire') return setStatus(io, e.id, 'superseded')
  // rewrite / merge: the replacement goes live in the note's own project, and replaces it
  const [added] = await remember(
    io,
    [{ kind: v.replacement.kind, text: v.replacement.text, resolves: e.id, project: e.project || '', scope: e.project ? 'project' : 'global', confirmed: true }],
    { source: 'review' },
  )
  if (!added) await setStatus(io, e.id, 'superseded')
  for (const id of v.with || []) if (brain.entries.get(id)?.status === 'active' || brain.entries.get(id)?.status === 'pending') await setStatus(io, id, 'superseded')
  return true
}

export async function applyPicks(io) {
  let n = 0
  for (const e of picks()) if (await applyVerdict(io, brain.entries.get(e.id))) n++
  return n
}

// The user kept or dropped a note the reviewer had a verdict on: that closes the verdict, and
// counts against it when they went the other way
export async function userDecides(io, e, action) {
  if (!e?.review || e.review.by === 'user') return
  await noteOverrule(io, e, action)
  const row = { op: 'review', ref: e.id, verdict: action === 'keep' ? 'accept' : 'reject', reason: 'the user ' + (action === 'keep' ? 'kept' : 'dropped') + ' it', evidence: 'the user', by: 'user', at: Date.now(), device: env.device }
  brain.entries.set(e.id, { ...brain.entries.get(e.id), review: row })
  await appendOps(io, [row])
}

// The user looked at a challenge and kept the note as it is
export const keepAsIs = (io, e) => userDecides(io, e, 'keep')

// Rule 5: the user kept what the reviewer would drop, or dropped what it would keep
export async function noteOverrule(io, e, action) {
  const v = e?.review
  if (!v) return
  const against = (action === 'keep' && CHANGES.has(v.verdict)) || (action === 'drop' && v.verdict === 'accept')
  if (!against) return
  const row = { op: 'overrule', ref: e.id, verdict: v.verdict, action, kind: e.kind, at: Date.now(), device: env.device }
  brain.overrules.push(row)
  await appendOps(io, [row])
}

// The score line /brain shows: verdicts so far, and how many the user went against, by kind
export function score() {
  const reviewed = [...brain.entries.values()].filter((e) => e.review).length
  if (!reviewed) return ''
  const byKind = new Map()
  for (const o of brain.overrules) byKind.set(o.kind, (byKind.get(o.kind) || 0) + 1)
  const detail = [...byKind].map(([k, n]) => k + ' ' + n).join(', ')
  return 'reviewer: ' + reviewed + ' verdict(s), ' + brain.overrules.length + ' overruled' + (detail ? ' (' + detail + ')' : '')
}
