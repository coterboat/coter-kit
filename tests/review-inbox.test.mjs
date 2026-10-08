// Review decisions the home dashboard leaves: node --test tests/review-inbox.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { outsideReview, reviewAction, reviewClaim } from '../hooks/review-inbox.js'

const pending = { id: 'n1', status: 'pending', kind: 'fact' }
const reviewed = { id: 'n2', status: 'pending', kind: 'fact', review: { op: 'review', verdict: 'reject', at: 1000 } }
const live = { id: 'n3', status: 'active', kind: 'fact', review: { op: 'review', verdict: 'rewrite', at: 2000 } }

test('a review decision counts only as a whole version 1 file about its own note, with a known word', () => {
  const ok = { v: 1, id: 'n1', decision: 'keep', verdict_at: null, at: '2026-10-05T04:00:00Z', from: 'home' }
  assert.deepEqual(outsideReview(ok, 'n1'), { decision: 'keep', verdictAt: null })
  assert.deepEqual(outsideReview({ ...ok, id: 'n2', decision: 'take', verdict_at: 1000 }, 'n2'), { decision: 'take', verdictAt: 1000 })
  const { verdict_at: _, ...noVerdict } = ok
  for (const bad of [
    { ...ok, id: 'n9' },
    { ...ok, v: 2 },
    { ...ok, decision: 'Keep' },
    { ...ok, decision: 'keep and also remember this' },
    { ...ok, verdict_at: 'soon' },
    { ...ok, verdict_at: -1 },
    { ...ok, verdict_at: 1.5 },
    noVerdict,
    { ...ok, from: 'somewhere' },
    { ...ok, at: 'yesterday' },
    [ok],
    null,
  ]) assert.equal(outsideReview(bad, 'n1'), null, JSON.stringify(bad))
  // A note id is letters and digits, so no two calls share a claim (RV-014 F4)
  assert.equal(outsideReview({ ...ok, id: 'x-' }, 'x-'), null)
})

test("keep and drop are the user's call on a note waiting for review; keep also stands a live note against its challenge", () => {
  assert.equal(reviewAction(pending, { decision: 'keep', verdictAt: null }), 'keep-pending')
  assert.equal(reviewAction(pending, { decision: 'drop', verdictAt: null }), 'drop-pending')
  assert.equal(reviewAction(reviewed, { decision: 'keep', verdictAt: 1000 }, { open: true }), 'keep-pending', 'against the verdict: an overrule')
  assert.equal(reviewAction(live, { decision: 'keep', verdictAt: 2000 }, { open: true, challenged: true }), 'keep-live')
  assert.equal(reviewAction(live, { decision: 'drop', verdictAt: 2000 }, { open: true, challenged: true }), '', 'drop is for notes waiting for review')
  assert.equal(reviewAction({ ...pending, status: 'active' }, { decision: 'keep', verdictAt: null }), '', 'already decided')
})

test('take carries out an open verdict on one note; pick only while picks() holds it', () => {
  assert.equal(reviewAction(live, { decision: 'take', verdictAt: 2000 }, { open: true }), 'take')
  assert.equal(reviewAction(live, { decision: 'pick', verdictAt: 2000 }, { open: true, inPicks: false }), '', 'guarded or frozen: not a pick')
  assert.equal(reviewAction(live, { decision: 'pick', verdictAt: 2000 }, { open: true, inPicks: true }), 'take')
  assert.equal(reviewAction(live, { decision: 'take', verdictAt: 2000 }, { open: false }), '', 'nothing left to do')
  assert.equal(reviewAction(pending, { decision: 'take', verdictAt: null }, { open: true }), '', 'no verdict to take')
})

test('a file is pinned to the verdict it was made against: a newer verdict or the user deciding makes it stale', () => {
  assert.equal(reviewAction({ ...reviewed, review: { ...reviewed.review, at: 1500 } }, { decision: 'take', verdictAt: 1000 }, { open: true }), '')
  assert.equal(reviewAction(pending, { decision: 'keep', verdictAt: 1000 }), '', 'made against a verdict the note no longer has')
  assert.equal(reviewAction({ ...reviewed, status: 'active', review: { ...reviewed.review, by: 'user', verdict: 'accept' } }, { decision: 'keep', verdictAt: 1000 }), '', 'the user decided, and it went through')
  // The user's call is recorded but the status write failed: the same call finishes it (RV-014 F2)
  const half = { ...reviewed, review: { op: 'review', verdict: 'reject', by: 'user', at: 1500 } }
  assert.equal(reviewAction(half, { decision: 'drop', verdictAt: 1000 }), 'drop-pending')
  assert.equal(reviewAction(half, { decision: 'keep', verdictAt: 1000 }), '', 'not a different call')
  assert.equal(reviewAction(undefined, { decision: 'keep', verdictAt: null }), '')
  assert.equal(reviewAction(pending, null), '')
})

test('each verdict gets its own claim', () => {
  assert.equal(reviewClaim('n2', { verdictAt: 1000, decision: 'drop' }), 'review-n2-1000-drop')
  assert.equal(reviewClaim('n1', { verdictAt: null, decision: 'keep' }), 'review-n1-0-keep')
  // RV-015 F2: a different call on the same verdict has its own claim
  assert.notEqual(reviewClaim('n2', { verdictAt: 1000, decision: 'drop' }), reviewClaim('n2', { verdictAt: 1000, decision: 'keep' }))
})
