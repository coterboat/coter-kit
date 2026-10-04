// coter-kit: "waiting on you". Mockups to review, questions to answer and sign-offs the user still owes, each with
// its link, kept in the brain so every session and machine sees the same list. A brain note of kind 'waiting'
// (brain.js) carries an optional link (http/https only, no credentials) and a short ref such as "Q8". Resolving it
// (remember with resolves set to its id) takes it off the list; unanswered, it expires after 30 days.
// A question with set answers also keeps them as options: /waiting shows each item as a card to click
// through, and the home dashboard shows the same choices (docs/live-status.md, "Answering from outside").
import { ago, clip, join } from './util.js'
import { redact } from './redact.js'

const MAX_LINK = 400
const MAX_REF = 16
const MAX_OPTION = 40
const MAX_ANSWER = 300

// Every card ends with Later, which skips the item and keeps it waiting. Up to three answers of the
// note's own come before it (the question card holds four), and the card's Other lets the user type one.
export const LATER = 'Later'
const MAX_OPTIONS = 3
const RECOMMENDED = ' (Recommended)'
const FALLBACK_OPTIONS = ['Yes, or done', 'No, drop it']

// Only a plain web link is kept: no javascript:, data: or file: links, no user:password@ in the
// address, and no query string or fragment at all, since any parameter can be the capability that
// opens the page (?ticket=, ?jwt=, …) and a list of bad names is never complete (RV-003 F1,
// RV-004 F2). What's left is redacted like any note.
export function safeLink(raw) {
  const s = String(raw || '').trim()
  if (!s) return undefined
  let url
  try {
    url = new URL(s)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
  if (url.username || url.password) return undefined
  url.search = ''
  url.hash = ''
  return clip(redact(url.toString()), MAX_LINK)
}

// A question's set answers: two or three short, distinct strings, the asker's pick first. Anything
// else keeps no options, and the card offers yes and no instead.
export function waitingOptions(raw) {
  if (!Array.isArray(raw)) return undefined
  const out = []
  for (const o of raw) {
    if (typeof o !== 'string') continue
    const s = clip(redact(o.replace(/\s+/g, ' ').trim()), MAX_OPTION)
    const key = s.toLowerCase()
    if (!s || key === LATER.toLowerCase() || out.some((x) => x.toLowerCase() === key)) continue
    out.push(s)
    if (out.length === MAX_OPTIONS) break
  }
  return out.length >= 2 ? out : undefined
}

// The extra fields a 'waiting' note keeps
export function waitingFields(note) {
  const link = safeLink(note.link)
  const ref = clip(redact(String(note.ref || '').replace(/\s+/g, ' ').trim()), MAX_REF)
  const options = waitingOptions(note.options)
  return { ...(link ? { link } : {}), ...(ref ? { ref } : {}), ...(options ? { options } : {}) }
}

// The question card /waiting shows for one item: the question (with the project when it is another
// one, and the link), its ref as the header, its answers with the first marked, then Later
export function waitingCard(item, { project } = {}) {
  const where = item.project && item.project !== project ? '[' + item.project + '] ' : ''
  const own = waitingOptions(item.options)
  const options = own ? [own[0] + RECOMMENDED, ...own.slice(1)] : FALLBACK_OPTIONS
  return { question: where + item.text + (item.link ? ' · ' + item.link : ''), header: item.ref || 'Waiting', options: [...options, LATER] }
}

// The card's answer as the user means it: the recommendation mark is the card's, not theirs
export const cardAnswer = (answer) => clip(String(answer || '').replace(RECOMMENDED, '').replace(/\s+/g, ' ').trim(), MAX_ANSWER)

// The decision an answer becomes. It resolves the item, so it files under the item's project, and it
// carries the question, since another session reads the answer without the card.
export function answerNote(item, answer, via) {
  return {
    kind: 'decision',
    text: (item.ref ? item.ref + ': ' : '') + answer + ' (answer to "' + clip(item.text, 120) + '", given in ' + via + ')',
    resolves: item.id,
  }
}

// Answers given outside a session (the home dashboard) wait in this folder, one file per item, named
// by the item's id: { "v": 1, "id": "<id>", "answer": "<text>", "at": "<ISO time>", "from": "home" }
export const answersRoot = (home) => join(home, '.claude/coter-kit/answers')

// The answer in such a file, or nothing if the file is not one, or is for another item
export function outsideAnswer(raw, id) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.v !== 1 || raw.id !== id || typeof raw.answer !== 'string') return ''
  return cardAnswer(raw.answer)
}

const label = (e) => (e.ref ? e.ref + ' · ' : '') + e.text

// What /waiting prints: plain text, so it reads the same in the terminal, the desktop app and on a phone
export function formatWaiting(items, { project, all }) {
  if (!items.length) {
    return all ? 'Nothing is waiting on you.' : 'Nothing is waiting on you in ' + (project || 'this project') + '. /waiting all shows every project.'
  }
  const groups = new Map()
  for (const e of items) {
    const key = e.project || 'every project'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(e)
  }
  const out = []
  for (const [name, rows] of groups) {
    out.push('Waiting on you (' + name + '): ' + rows.length)
    for (const e of rows) {
      out.push('- ' + label(e) + '  (' + ago(e.updatedAt || e.at) + ')')
      if (e.link) out.push('  ' + e.link)
    }
    out.push('')
  }
  return out.join('\n').trim()
}

// What a new session is told, so it can point at the list and resolve items as the user answers them
export function waitingSection(items, project) {
  if (!items.length) return ''
  return (
    '## Waiting on the user (' + project + ')\n' +
    'Mockups, questions and sign-offs they still owe an answer on. When they answer one, resolve it: a decision note with resolves set to its id.\n' +
    items.map((e) => '- [' + e.id + '] ' + label(e) + (e.link ? ' (' + e.link + ')' : '')).join('\n')
  )
}
