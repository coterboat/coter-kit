// Shared by packet.mjs, relay.mjs and findings.mjs: where a project's review files live, and
// the fingerprint that ties a packet to the exact state of the code it describes.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs'
import { join, sep } from 'node:path'

export const sha = (text) => createHash('sha256').update(text).digest('hex')

export function die(message, code = 1) {
  console.error('✗ ' + message)
  process.exit(code)
}

export function args(argv = process.argv.slice(2)) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) {
      out._.push(a)
      continue
    }
    const key = a.slice(2)
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true
    // Repeatable flags collect into a list
    if (key in out) out[key] = [].concat(out[key], value)
    else out[key] = value
  }
  return out
}

export const git = (repo, gitArgs, opts = {}) => execFileSync('git', ['-C', repo, ...gitArgs], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts })

export function repoRoot(dir) {
  try {
    return git(dir, ['rev-parse', '--show-toplevel']).trim()
  } catch {
    return die('not a git repository: ' + dir)
  }
}

// docs/reviews in the project: packets/, inbox/ and the findings log. Created only by the scripts
// that write there; triage only reads, so it never leaves empty folders in a repository
export function reviewDirs(repo, { create = true } = {}) {
  const root = join(repo, 'docs', 'reviews')
  const dirs = { root, packets: join(root, 'packets'), inbox: join(root, 'inbox'), findings: join(root, 'findings.jsonl') }
  if (create) {
    mkdirSync(dirs.packets, { recursive: true })
    mkdirSync(dirs.inbox, { recursive: true })
  }
  return dirs
}

// The review's own files are never part of what it reviews
const EXCLUDE = ':(exclude)docs/reviews'
const MAX_FILE = 200 * 1024

// What changed since `base`: the tracked diff (working tree included) and every untracked file
export function changes(repo, base) {
  const diff = git(repo, ['diff', '--no-color', '--no-ext-diff', base, '--', '.', EXCLUDE])
  const untracked = git(repo, ['ls-files', '--others', '--exclude-standard', '--', '.', EXCLUDE]).split('\n').filter(Boolean)
  const root = realpathSync(repo) + sep
  const files = untracked.map((path) => {
    const full = join(repo, path)
    // Never follow a link or read a special file: a link to ~/.ssh/config would send the key's
    // config to the reviewer (RV-001 F7)
    const stat = lstatSync(full)
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(full)
      return { path, text: '(symbolic link, not included)', hash: sha('link:' + target) }
    }
    if (!stat.isFile() || !realpathSync(full).startsWith(root)) return { path, text: '(not a regular file in this repository, not included)', hash: sha('special') }
    // Freshness is measured on the real bytes, whether or not they fit in the packet (RV-002 F7)
    const bytes = readFileSync(full)
    const hash = sha(bytes)
    if (stat.size > MAX_FILE) return { path, text: '(' + stat.size + ' bytes, too large to include)', hash, omitted: true }
    const text = bytes.toString('utf8')
    // A binary can't be shown, so it counts as left out, like a tracked one (RV-004 F6)
    return text.includes('\u0000') ? { path, text: '(binary file)', hash, omitted: true } : { path, text, hash }
  })
  // A tracked binary change shows in the diff only as "Binary files differ": it can't be reviewed,
  // so it counts as left out, and its bytes go in the fingerprint (RV-003 F7)
  const binaries = git(repo, ['diff', '--numstat', '--no-renames', base, '--', '.', EXCLUDE])
    .split('\n')
    .filter((line) => line.startsWith('-\t-\t'))
    .map((line) => {
      const path = line.slice(4)
      const full = join(repo, path)
      return { path, hash: existsSync(full) ? sha(readFileSync(full)) : 'deleted' }
    })
  return { diff, untracked: files, binaries }
}

// Ties a packet to the code: the base commit, HEAD, and every changed byte
export function fingerprint(repo, base) {
  return fingerprintOf(repo, changes(repo, base))
}

// The same, for changes already read: a packet fingerprints the very snapshot its diff came from, so a file edited
// while the gates run makes it stale instead of slipping past (found building RV-021)
export function fingerprintOf(repo, { diff, untracked, binaries }) {
  const head = git(repo, ['rev-parse', 'HEAD']).trim()
  return sha(head + '\n' + diff + '\n' + [...untracked, ...binaries].map((f) => f.path + '\n' + f.hash).join('\n'))
}

// The next round's id: one past the highest RV-NNN among packets, saved replies and logged findings.
// Packets aren't committed, so a fresh clone or worktree has none, and counting them alone would
// start again at RV-001 and overwrite the first reply in the inbox
export function nextRound(dirs) {
  let max = 0
  const see = (name) => {
    const m = String(name).match(/^RV-(\d+)/)
    if (m) max = Math.max(max, Number(m[1]))
  }
  for (const dir of [dirs.packets, dirs.inbox]) for (const name of existsSync(dir) ? readdirSync(dir) : []) see(name)
  for (const row of readFindings(dirs)) see(row.round)
  return 'RV-' + String(max + 1).padStart(3, '0')
}

export function readFindings(dirs) {
  if (!existsSync(dirs.findings)) return []
  return readFileSync(dirs.findings, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

// A packet's header fields, written as "- key: value" lines at the top
export function packetHeader(text) {
  const header = {}
  for (const line of text.split('\n').slice(0, 20)) {
    const m = line.match(/^- (\w+): (.*)$/)
    if (m) header[m[1]] = m[2].trim()
  }
  return header
}
