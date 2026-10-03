// coter-kit: "waiting on you". Mockups to review, questions to answer and sign-offs the user still owes, each with
// its link, kept in the brain so every session and machine sees the same list. A brain note of kind 'waiting'
// (brain.js) carries an optional link (http/https only, no credentials) and a short ref such as "Q8". Resolving it
// (remember with resolves set to its id) takes it off the list; unanswered, it expires after 30 days.
import { ago, clip } from './util.js'
import { redact } from './redact.js'

const MAX_LINK = 400
const MAX_REF = 16

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

// The extra fields a 'waiting' note keeps
export function waitingFields(note) {
  const link = safeLink(note.link)
  const ref = clip(redact(String(note.ref || '').replace(/\s+/g, ' ').trim()), MAX_REF)
  return { ...(link ? { link } : {}), ...(ref ? { ref } : {}) }
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
