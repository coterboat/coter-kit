// coter-kit: phone pushes (docs/phone.md). When a session needs the user and they're away from the
// machine, one push goes to their phone through ntfy. Plain code over the live status files (live.js),
// no model credits. One session per machine pushes, for that machine's sessions; nothing is sent
// until the user runs /phone setup, and a push carries only the project's name, its state, the
// minutes and the machine's name.
import { join } from './util.js'
import { liveness, lastBeatIn, IDLE_AFTER_MS } from './live.js'

const MIN = 60_000
const DEFAULTS = { server: 'https://ntfy.sh', needs_ok_after_min: 3, your_move_after_min: 5, away_after_min: 2 }
// A topic is a name only the user knows: anyone who has it can read the pushes
const TOPIC = /^[A-Za-z0-9_-]{24,64}$/
const SAY = { needs_ok: 'needs your OK', your_move: 'your move' }
// A permission prompt counts as unanswered only if nobody touched the machine since it appeared:
// approving one is input, most approvals come within seconds, and the state stays needs_ok until the
// approved tool finishes, which can take minutes (RV-010 F5)

export const phoneFile = (home) => join(home, '.claude/coter-kit/phone.json')
export const sentFile = (home) => join(home, '.claude/coter-kit/phone-sent.json')

// The settings, or null while pushes are off: no file, `off`, or anything but a whole version 1 file
// with a topic and an https server that carries no credentials
export function phoneConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.v !== 1 || raw.off === true) return null
  if (typeof raw.topic !== 'string' || !TOPIC.test(raw.topic)) return null
  let server
  try {
    const url = new URL(typeof raw.server === 'string' && raw.server.trim() ? raw.server.trim() : DEFAULTS.server)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null
    server = url.origin + url.pathname.replace(/\/+$/, '')
  } catch {
    return null
  }
  // A token short enough to turn up in ordinary words couldn't be kept out of the brain (RV-011 F2)
  const token = typeof raw.token === 'string' ? raw.token.trim() : ''
  if (token && token.length < 16) return null
  const minutes = (k) => (typeof raw[k] === 'number' && raw[k] >= 0 && raw[k] <= 24 * 60 ? raw[k] : DEFAULTS[k]) * MIN
  return {
    server,
    topic: raw.topic,
    token,
    needsOkAfter: minutes('needs_ok_after_min'),
    yourMoveAfter: minutes('your_move_after_min'),
    awayAfter: minutes('away_after_min'),
  }
}

// A fresh topic: 24 random URL-safe characters (144 bits)
export function newTopic() {
  const bytes = crypto.getRandomValues(new Uint8Array(18))
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out += abc[(n >> 18) & 63] + abc[(n >> 12) & 63] + abc[(n >> 6) & 63] + abc[n & 63]
  }
  return out
}

const running = (r, now) => !!(r && typeof r.id === 'string' && r.id && !r.scheduled && liveness(r, now) === 'live')
const opened = (r, now) => Date.parse(r.opened_at) || now

// The session that pushes on this machine: the longest-running live one that can (its record says
// `pushes`, so a session still on older code is never picked and left to push nothing) and isn't a
// scheduled run. Every session works it out the same way, so only one pushes; null when none can.
export function pusherOf(records, now) {
  const able = records.filter((r) => running(r, now) && r.pushes === true)
  able.sort((a, b) => opened(a, now) - opened(b, now) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return able.length ? able[0].id : null
}

// One wait: a session in one state since one moment
export const waitKey = (r) => r.state + '@' + r.state_since

// The waits due a push now. `idle` is how long the keyboard and mouse have been idle (Infinity to ask
// "would any be due if the user were away", null when it can't be told, and then none is: a push
// sent while the user is at the machine is noise). A permission prompt is due once it has waited
// needsOkAfter with no input since it appeared; a finished turn once it has waited yourMoveAfter, until
// it turns idle (live.js), while the user has been away awayAfter. A session already pushed is not
// pushed again until the user has been back (a beat anywhere on the machine) since that push.
export function dueWaits(records, sent, cfg, now, idle) {
  if (idle === null || idle === undefined || idle < cfg.awayAfter) return []
  const back = lastBeatIn(records, null)
  return records.filter((r) => {
    if (!running(r, now)) return false
    const since = Date.parse(r.state_since)
    if (!since) return false
    const age = now - since
    const due =
      r.state === 'needs_ok' ? age >= cfg.needsOkAfter && idle >= age : r.state === 'your_move' ? age >= cfg.yourMoveAfter && age < IDLE_AFTER_MS : false
    if (!due) return false
    const last = Object.hasOwn(sent, r.id) ? sent[r.id] : null
    return !last || (last.key !== waitKey(r) && back > last.at)
  })
}

// Which waits were pushed, and when, as the file holds it: own properties with the right shape only
export function parseSent(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object' || raw.v !== 1 || !raw.sent || typeof raw.sent !== 'object' || Array.isArray(raw.sent)) return out
  for (const [id, v] of Object.entries(raw.sent)) {
    if (id !== '__proto__' && v && typeof v === 'object' && typeof v.key === 'string' && typeof v.at === 'number') out[id] = { key: v.key, at: v.at }
  }
  return out
}

// What another record knows that this one doesn't: per session, the later push wins
export function mergeSent(a, b) {
  const out = { ...a }
  for (const [id, v] of Object.entries(b)) if (!Object.hasOwn(out, id) || out[id].at < v.at) out[id] = v
  return out
}

// The record after a push: sessions gone from the live files drop out, the pushed waits go in
export function nextSent(sent, records, pushed, now) {
  const ids = new Set(records.map((r) => r && r.id))
  const out = {}
  for (const [id, v] of Object.entries(sent)) if (ids.has(id)) out[id] = v
  for (const r of pushed) out[r.id] = { key: waitKey(r), at: now }
  return out
}

// How long the keyboard and mouse have been idle, from macOS's `ioreg -c IOHIDSystem` (nanoseconds),
// or null when it can't be told
export function idleMs(stdout) {
  const m = /"HIDIdleTime" = (\d+)/.exec(String(stdout || ''))
  return m ? Math.floor(Number(m[1]) / 1e6) : null
}

// Plain ASCII, one line, short: it goes in an HTTP header
const plain = (s, fallback) => String(s || '').normalize('NFKD').replace(/[^\x20-\x7e]+/g, ' ').replace(/[^\w .-]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 40) || fallback
const minutes = (ms) => (ms > 120 * MIN ? 'over 2 h' : Math.max(1, Math.round(ms / MIN)) + ' min')

// The push: one line per project and state, with nothing but the project, the state, the minutes and
// the machine. Sessions of one project in the same state share a line, since nothing else may tell
// them apart.
export function pushMessage(waits, device, now) {
  const groups = new Map()
  for (const r of waits) {
    const key = plain(r.project, 'a session') + '\u0000' + r.state
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(now - Date.parse(r.state_since))
  }
  const lines = [...groups].map(([key, ages]) => {
    const [name, state] = key.split('\u0000')
    const longest = Math.max(...ages)
    return name + ': ' + SAY[state] + ' (' + (ages.length > 1 ? ages.length + ' sessions, longest ' + minutes(longest) : minutes(longest)) + ')'
  })
  const who = waits.length === 1 ? plain(waits[0].project, 'a session') + ' needs you' : waits.length + ' sessions need you'
  return { title: who + ' on ' + plain(device, 'this machine'), body: lines.join('\n'), priority: waits.some((r) => r.state === 'needs_ok') ? 'high' : 'default' }
}

// The ntfy request: a POST to the topic, the title and priority as headers, the token only when set
export function pushRequest(cfg, msg) {
  const headers = { Title: msg.title, Priority: msg.priority, Tags: msg.priority === 'high' ? 'warning' : 'hourglass' }
  if (cfg.token) headers.Authorization = 'Bearer ' + cfg.token
  return { url: cfg.server + '/' + cfg.topic, init: { method: 'POST', headers, body: msg.body } }
}
