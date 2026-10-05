// Phone pushes (docs/phone.md): who pushes, which waits, what the push says: node --test tests/phone.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { phoneConfig, pusherOf, dueWaits, pushMessage, pushRequest, parseSent, mergeSent, nextSent, idleMs, newTopic } from '../hooks/phone.js'

const MIN = 60_000
const NOW = Date.parse('2026-10-04T22:00:00Z')
const iso = (ms) => new Date(ms).toISOString()
// A session's live record as live.js writes it, with the private fields a push must never carry
const rec = (id, over = {}) => ({
  v: 1, tool: 'claude', id, device: 'alexs-macbook-pro', project: 'coter-kit', worktree: 'secret-worktree', branch: 'claude/secret-branch',
  opened_at: iso(NOW - 60 * MIN), updated_at: iso(NOW - 20_000), state: 'working', state_since: iso(NOW - 10 * MIN), scheduled: false, pushes: true, last_beat_at: null,
  checklist: { title: 'Patient intake fix', done: 1, total: 3, current: 'Edit /Users/x/ourplace/patients.ts', blocked: 0 },
  needs_you: { waiting: 2 }, ...over,
})
const CFG = phoneConfig({ v: 1, topic: 'abcdefghijklmnopqrstuvwx' })
// Away from the keyboard since long before any of these waits began
const AWAY = Infinity

test('only the longest-running session on the machine pushes', () => {
  const records = [rec('young', { opened_at: iso(NOW - 5 * MIN) }), rec('old', { opened_at: iso(NOW - 90 * MIN) }), rec('mid')]
  assert.equal(pusherOf(records, NOW), 'old')
  // A scheduled run, an ended session and one that died (no heartbeat for 3 minutes) never push
  const others = [rec('sched', { opened_at: iso(NOW - 900 * MIN), scheduled: true }), rec('ended', { opened_at: iso(NOW - 800 * MIN), state: 'ended' }), rec('died', { opened_at: iso(NOW - 700 * MIN), updated_at: iso(NOW - 4 * MIN) })]
  assert.equal(pusherOf([...others, ...records], NOW), 'old')
  // Same start: the lower id, so every session picks the same one
  assert.equal(pusherOf([rec('b', { opened_at: iso(NOW - MIN) }), rec('a', { opened_at: iso(NOW - MIN) })], NOW), 'a')
  assert.equal(pusherOf(others, NOW), null)
  // A session on older code writes no `pushes`, so it is never picked to push nothing
  assert.equal(pusherOf([rec('stale-code', { opened_at: iso(NOW - 999 * MIN), pushes: undefined }), ...records], NOW), 'old')
})

test('which waits get a push', () => {
  const at = (state, minutes, over = {}) => rec(state + minutes, { state, state_since: iso(NOW - minutes * MIN), ...over })
  const due = dueWaits([at('needs_ok', 3), at('needs_ok', 2), at('your_move', 5), at('your_move', 4), at('working', 30), at('idle', 30), at('ended', 30), at('needs_ok', 9, { scheduled: true }), at('needs_ok', 9, { id: 'died', updated_at: iso(NOW - 4 * MIN) })], {}, CFG, NOW, AWAY)
  assert.deepEqual(due.map((r) => r.id), ['needs_ok3', 'your_move5'])
  // A finished turn is pushed until it turns idle at 15 minutes, even if the file has not caught up
  assert.equal(dueWaits([at('your_move', 14.98)], {}, CFG, NOW, AWAY).length, 1)
  assert.equal(dueWaits([at('your_move', 15)], {}, CFG, NOW, AWAY).length, 0)
  // A record with a time that can't be read is skipped, never pushed with a wrong age
  assert.deepEqual(dueWaits([at('needs_ok', 9, { state_since: 'soon' })], {}, CFG, NOW, AWAY), [])
  // The session that pushes counts its own wait like any other
  assert.equal(dueWaits([at('needs_ok', 4, { id: 'pusher' })], {}, CFG, NOW, AWAY)[0].id, 'pusher')
})

test('an approved permission prompt is not pushed while its tool runs', () => {
  // The prompt appeared 6 minutes ago; you approved it a minute later and walked away 5 minutes ago
  const running = rec('s1', { state: 'needs_ok', state_since: iso(NOW - 6 * MIN) })
  assert.deepEqual(dueWaits([running], {}, CFG, NOW, 5 * MIN), [])
  // RV-010 F5: approved a second, or 29 seconds, after it appeared
  assert.deepEqual(dueWaits([running], {}, CFG, NOW, 6 * MIN - 1_000), [])
  assert.deepEqual(dueWaits([running], {}, CFG, NOW, 6 * MIN - 29_000), [])
  // Nobody has touched the machine since it appeared: it is waiting on you
  assert.equal(dueWaits([running], {}, CFG, NOW, 6 * MIN).length, 1)
  // A finished turn needs only that you have been away a while
  assert.equal(dueWaits([rec('s2', { state: 'your_move', state_since: iso(NOW - 6 * MIN) })], {}, CFG, NOW, 2 * MIN).length, 1)
})

test('a wait is pushed once, even after another session takes over', () => {
  const waiting = rec('s1', { state: 'needs_ok', state_since: iso(NOW - 4 * MIN) })
  const sent = nextSent({}, [waiting], [waiting], NOW)
  assert.deepEqual(dueWaits([waiting], sent, CFG, NOW + MIN, AWAY), [])
  // The sent record is what the next pusher reads back: the same wait stays pushed
  const reread = parseSent(JSON.parse(JSON.stringify({ v: 1, sent })))
  assert.deepEqual(dueWaits([waiting], reread, CFG, NOW + 2 * MIN, AWAY), [])
  // A new wait of the same session waits until you have been back since the push...
  const later = NOW + 7 * MIN
  const again = { ...waiting, state: 'your_move', state_since: iso(NOW + MIN), updated_at: iso(later - 10_000), last_beat_at: null }
  assert.deepEqual(dueWaits([again], reread, CFG, later, AWAY), [])
  assert.deepEqual(dueWaits([{ ...again, last_beat_at: iso(NOW - MIN) }], reread, CFG, later, AWAY), [])
  // ...so a session that keeps waking up on its own doesn't push all night
  const back = rec('s9', { updated_at: iso(later - 10_000), last_beat_at: iso(NOW + 30_000) })
  assert.deepEqual(dueWaits([again, back], reread, CFG, later, AWAY).map((r) => r.id), ['s1'])
  // Sessions no longer in the live files drop out of the record
  assert.deepEqual(nextSent({ gone: { key: 'k', at: 1 }, s1: { key: 'y', at: 2 } }, [waiting], [], NOW), { s1: { key: 'y', at: 2 } })
  assert.deepEqual(parseSent({ v: 1, sent: { s2: 'old shape', s3: { key: 'your_move@t', at: 5 }, s4: { key: 1, at: 2 } } }), { s3: { key: 'your_move@t', at: 5 } })
  assert.deepEqual(parseSent({ v: 2, sent: { s3: { key: 'a', at: 1 } } }), {})
  // What this session pushed but could not write down still counts
  assert.deepEqual(mergeSent({ a: { key: 'x', at: 1 } }, { a: { key: 'y', at: 2 }, b: { key: 'z', at: 3 } }), { a: { key: 'y', at: 2 }, b: { key: 'z', at: 3 } })
})

test('nothing is pushed while you are at the machine', () => {
  const waits = [rec('s1', { state: 'needs_ok', state_since: iso(NOW - 9 * MIN) }), rec('s2', { state: 'your_move', state_since: iso(NOW - 9 * MIN) })]
  assert.deepEqual(dueWaits(waits, {}, CFG, NOW, MIN), [])
  // When it can't be told whether you are there (not a Mac, or ioreg failed), nothing is pushed
  assert.deepEqual(dueWaits(waits, {}, CFG, NOW, null), [])
  const out = 'x\n    | |     "HIDIdleTime" = 348496250\n'
  assert.equal(idleMs(out), 348)
  assert.equal(idleMs('no such key'), null)
  assert.equal(idleMs(''), null)
})

test('the push carries no checklist, path, branch or worktree', () => {
  const waits = [rec('s1', { state: 'needs_ok', state_since: iso(NOW - 4 * MIN) }), rec('s2', { project: 'ourPlace', state: 'your_move', state_since: iso(NOW - 7 * MIN) })]
  const msg = pushMessage(waits, 'alexs-macbook-pro', NOW)
  const all = JSON.stringify(msg)
  for (const word of ['Patient', 'intake', '/Users', 'patients.ts', 'secret-worktree', 'secret-branch', 'waiting']) assert.ok(!all.includes(word), word)
  assert.equal(msg.title, '2 sessions need you on alexs-macbook-pro')
  assert.equal(msg.body, 'coter-kit: needs your OK (4 min)\nourPlace: your move (7 min)')
  assert.equal(msg.priority, 'high')
  // Headers stay plain ASCII whatever the names hold
  const odd = pushMessage([rec('s3', { project: 'café\nX-Evil: 1', state: 'your_move', state_since: iso(NOW - 5 * MIN) })], 'mäc', NOW)
  assert.match(odd.title, /^[\x20-\x7e]+$/)
  assert.ok(!odd.title.includes('\n') && !odd.body.includes('X-Evil: 1\n'))
  assert.equal(pushMessage([waits[1]], 'm', NOW).priority, 'default')
  // Sessions of one project in the same state share a line; a very old wait doesn't print hours of minutes
  const three = ['a', 'b', 'c'].map((id, i) => rec(id, { project: 'ascendant', state: 'needs_ok', state_since: iso(NOW - (4 + i) * MIN) }))
  assert.equal(pushMessage(three, 'm', NOW).body, 'ascendant: needs your OK (3 sessions, longest 6 min)')
  assert.equal(pushMessage([rec('d', { state: 'needs_ok', state_since: iso(NOW - 300 * MIN) })], 'm', NOW).body, 'coter-kit: needs your OK (over 2 h)')
})

test('no setup, no push', () => {
  for (const raw of [null, 'x', [], {}, { v: 2, topic: 'abcdefghijklmnopqrstuvwx' }, { v: 1 }, { v: 1, topic: 'short' }, { v: 1, topic: 'abcdefghijklmnopqrstuvwx', off: true }, { v: 1, topic: 'has/slash/abcdefghijklmnopqrstuvwx' }, { v: 1, topic: 'abcdefghijklmnopqrstuvwx', server: 'http://ntfy.example.com' }, { v: 1, topic: 'abcdefghijklmnopqrstuvwx', server: 'https://u:p@ntfy.example.com' }, { v: 1, topic: 'abcdefghijklmnopqrstuvwx', server: 'javascript:alert(1)' }]) {
    assert.equal(phoneConfig(raw), null, JSON.stringify(raw))
  }
  const cfg = phoneConfig({ v: 1, topic: 'abcdefghijklmnopqrstuvwx', server: 'https://ntfy.example.com/', needs_ok_after_min: 1, your_move_after_min: 'x', token: 'tk_AgQdq7mDVhB4z9tiqfT4xkBaT2o5J' })
  assert.equal(cfg.server, 'https://ntfy.example.com')
  assert.equal(cfg.needsOkAfter, MIN)
  assert.equal(cfg.yourMoveAfter, 5 * MIN)
  assert.equal(cfg.awayAfter, 2 * MIN)
  const req = pushRequest(cfg, { title: 't', body: 'b', priority: 'high' })
  assert.equal(req.url, 'https://ntfy.example.com/abcdefghijklmnopqrstuvwx')
  assert.equal(req.init.method, 'POST')
  assert.equal(req.init.headers.Authorization, 'Bearer tk_AgQdq7mDVhB4z9tiqfT4xkBaT2o5J')
  // A token too short to keep out of the brain is refused (RV-011 F2)
  assert.equal(phoneConfig({ v: 1, topic: 'abcdefghijklmnopqrstuvwx', token: 'abcdefg' }), null)
  assert.equal(pushRequest(CFG, { title: 't', body: 'b', priority: 'default' }).init.headers.Authorization, undefined)
})

test('a new topic is random, URL-safe and long enough to keep to yourself', () => {
  const a = newTopic()
  assert.match(a, /^[A-Za-z0-9_-]{24,}$/)
  assert.notEqual(a, newTopic())
})
