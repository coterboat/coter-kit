// Review decisions made outside a session (the home dashboard): the review twin of the answers inbox
// (docs/live-status.md, "Reviewing from outside a session"). One file per note, named by its id:
//   { "v": 1, "id": "<note id>", "decision": "keep" | "drop" | "take" | "pick",
//     "verdict_at": <the reviewer's verdict's at, or null when the note had none>, "at": "<ISO>", "from": "home" }
//
//   keep  the user's own call: a note waiting for review goes live; a live note the reviewer would
//         change stays as it is (the /brain pane's keep buttons)
//   drop  a note waiting for review is rejected (the pane's drop)
//   take  the reviewer's verdict on this one note is carried out (the pane's take): the user chose it
//   pick  the same, as part of "Apply the reviewer's picks": only while picks() still holds the note,
//         so a guarded or frozen verdict is never applied this way
//
// verdict_at pins a file to the verdict it was made against: once there's a newer verdict, or the
// user's own decision, the file is stale and does nothing. No free text: the decision is one word,
// and nothing from the file but that word and that number reaches the brain.

import { join } from './util.js'

export const reviewsRoot = (home) => join(home, '.claude/coter-kit/reviews')
export const REVIEW_DECISIONS = ['keep', 'drop', 'take', 'pick']

// The decision in such a file, or null unless it is a whole one about its own note: every field there,
// a note id (letters and digits), a verdict time that is a positive whole number or an explicit null,
// a real time, from home (RV-014 F3, F4)
const NOTE_ID = /^[A-Za-z0-9]{1,40}$/
export function outsideReview(raw, id) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.v !== 1 || raw.id !== id || !NOTE_ID.test(id)) return null
  if (!REVIEW_DECISIONS.includes(raw.decision) || raw.from !== 'home' || !(Date.parse(raw.at) > 0)) return null
  if (!('verdict_at' in raw) || (raw.verdict_at !== null && !(Number.isSafeInteger(raw.verdict_at) && raw.verdict_at > 0))) return null
  return { decision: raw.decision, verdictAt: raw.verdict_at }
}

// What a decision does to a note as it stands now, or '' when it does nothing.
//   open        the note's verdict still has something to do (review.js isOpen)
//   challenged  a live note the reviewer would change (review.js challenges)
//   inPicks     picks() holds it now
export function reviewAction(e, d, { open = false, challenged = false, inPicks = false } = {}) {
  if (!e || !d) return ''
  // The user's call is recorded but the note still waits (the status write after it failed): finish it,
  // whatever verdict the file was made against, as long as it is the same call (RV-014 F2)
  if (e.review?.by === 'user') {
    if (e.status === 'pending' && d.decision === 'keep' && e.review.verdict === 'accept') return 'keep-pending'
    if (e.status === 'pending' && d.decision === 'drop' && e.review.verdict === 'reject') return 'drop-pending'
    return ''
  }
  if ((e.review ? e.review.at : null) !== d.verdictAt) return ''
  if (d.decision === 'keep') return e.status === 'pending' ? 'keep-pending' : challenged ? 'keep-live' : ''
  if (d.decision === 'drop') return e.status === 'pending' ? 'drop-pending' : ''
  if (d.decision === 'take') return e.review && open ? 'take' : ''
  if (d.decision === 'pick') return e.review && open && inPicks ? 'take' : ''
  return ''
}

// The claim that makes one process on the machine carry a file out: per verdict and per call, so a
// newer verdict, or a different call on the same one, gets its own (RV-015 F2)
export const reviewClaim = (id, d) => 'review-' + id + '-' + (d.verdictAt ?? 0) + '-' + d.decision
