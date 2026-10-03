// Pure helpers shared by the coter-kit modules. Anything that calls Claude Code ($)
// lives in register.js: the validator follows $ only within one file.

// Facts about this machine and session, filled in at session.start
export const env = {
  isWindows: false,
  python: null,
  sessionRoot: '',
  sessionId: '',
  project: '', // the repository's name, the same on every machine
  worktree: '', // the worktree's folder name when the session runs in one, else ''
  device: '',
  home: '',
}

export const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '')
export const dirname = (p) => {
  const n = norm(p)
  const i = n.lastIndexOf('/')
  return i <= 0 ? n : n.slice(0, i)
}
export const basename = (p) => norm(p).split('/').pop()
export const isAbs = (p) => /^[A-Za-z]:\//.test(norm(p)) || norm(p).startsWith('/')
export const join = (a, b) => norm(a) + '/' + String(b).replace(/^\/+/, '')
export const within = (child, parent) => {
  const c = norm(child).toLowerCase()
  const p = norm(parent).toLowerCase()
  return c === p || c.startsWith(p + '/')
}
export const ago = (ms) => {
  const s = Math.round((Date.now() - ms) / 1000)
  if (s < 60) return s + 's ago'
  if (s < 3600) return Math.round(s / 60) + 'm ago'
  if (s < 86400) return Math.round(s / 3600) + 'h ago'
  return Math.round(s / 86400) + 'd ago'
}
// A length of time: "under a minute", "14m", "2h 10m"
export const span = (ms) => {
  const m = Math.round(ms / 60_000)
  if (m < 1) return 'under a minute'
  if (m < 60) return m + 'm'
  return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm'
}
export const clip = (text, max) => (text.length > max ? text.slice(0, max - 1) + '…' : text)

export function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
