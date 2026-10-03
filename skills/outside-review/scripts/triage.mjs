#!/usr/bin/env node
// Does this change need an outside review? It checks the triggers in coter-kit's standard
// (docs/standard.md, "When a change gets an outside review") against what changed since the base,
// says which fired, and lists leftovers to clean up before a packet.
//
//   node triage.mjs [--base <ref>] [--repo <dir>]
//
// Exit code 0: no trigger fired, skip the outside review. Exit code 3: a trigger fired.
// A project adds its own sensitive paths in .claude/review.json:
//   { "sensitive": [{ "glob": "supabase/**", "why": "the database" }], "maxLines": 400, "maxFiles": 8 }
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { args, git, repoRoot, reviewDirs, readFindings } from './lib.mjs'

const a = args()
const repo = repoRoot(a.repo || process.cwd())
let base = a.base && a.base !== true ? String(a.base) : null
if (!base) {
  try {
    base = git(repo, ['merge-base', 'HEAD', 'origin/main']).trim()
  } catch {
    base = 'HEAD'
  }
}

const cfgPath = join(repo, '.claude', 'review.json')
const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : {}
const MAX_LINES = cfg.maxLines || 400
const MAX_FILES = cfg.maxFiles || 8

const globToRe = (glob) => new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*') + '$')
const sensitive = (cfg.sensitive || []).map((s) => ({ re: globToRe(s.glob), why: s.why || s.glob }))

// What changed: tracked files with their line counts, and untracked files counted whole
const EXCLUDE = ':(exclude)docs/reviews'
const changed = git(repo, ['diff', '--numstat', '--no-renames', base, '--', '.', EXCLUDE])
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const [add, del, path] = line.split('\t')
    return { path, lines: add === '-' ? 0 : Number(add) + Number(del) }
  })
for (const path of git(repo, ['ls-files', '--others', '--exclude-standard', '--', '.', EXCLUDE]).split('\n').filter(Boolean)) {
  let lines = 0
  try {
    lines = readFileSync(join(repo, path), 'utf8').split('\n').length
  } catch {}
  changed.push({ path, lines })
}
const added = git(repo, ['diff', '--no-color', '-U0', base, '--', '.', EXCLUDE])
  .split('\n')
  .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
  .join('\n')

const isTest = (p) => /(^|\/)(tests?|__tests__|e2e|spec|fixtures)\//i.test(p) || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(p) || /(_test|_spec)\.(py|go|rb)$/i.test(p)
const isDoc = (p) => /\.(md|mdx|txt|rst)$/i.test(p) || /^docs\//i.test(p)
const source = changed.filter((f) => !isTest(f.path) && !isDoc(f.path))
const sourceLines = source.reduce((n, f) => n + f.lines, 0)

// The standard's triggers, by path and by what the change adds
const TRIGGERS = [
  { name: 'touches data that lasts', path: /migrations?\/|\.sql$|schema|prisma|supabase\/|(^|\/)(db|database|storage)\//i, adds: /\b(DROP|TRUNCATE|DELETE\s+FROM|ALTER\s+TABLE)\b|rmSync|unlinkSync|\brm -rf\b|\.destroy\(|deleteMany|git\b.*\b(push|reset|rebase|clean)\b/i },
  { name: 'touches who can do what', path: /auth|login|permission|role|secret|credential|crypt|payment|billing|stripe|consent|privacy|hipaa|pii/i, adds: /password|secret|api[_-]?key|access[_-]?token|private[_-]?key|Bearer\s|stripe|consent/i },
  { name: 'others depend on it', path: /(^|\/)api\/|openapi|swagger|graphql|\.proto$|(^|\/)contracts?\/|\.github\/workflows\/|(^|\/)release/i },
  { name: 'runs on its own', path: /cron|schedul|worker|queue|daemon|launchd|LaunchAgents/i, adds: /setInterval|clock\.every|cron\(|schedule\(|new Worker\(|launchctl/i },
]
const fired = []
for (const t of TRIGGERS) {
  const files = source.filter((f) => t.path && t.path.test(f.path)).map((f) => f.path)
  const why = files.length ? files.slice(0, 4).join(', ') + (files.length > 4 ? ', …' : '') : t.adds && t.adds.test(added) ? 'what the change adds' : ''
  if (why) fired.push(t.name + ': ' + why)
}
for (const s of sensitive) {
  const files = changed.filter((f) => s.re.test(f.path)).map((f) => f.path)
  if (files.length) fired.push('this project marks it sensitive (' + s.why + '): ' + files.slice(0, 4).join(', ') + (files.length > 4 ? ', …' : ''))
}
if (sourceLines >= MAX_LINES || source.length >= MAX_FILES) fired.push('too big to hold in your head: ' + sourceLines + ' changed source lines in ' + source.length + ' files (guide: ' + MAX_LINES + ' / ' + MAX_FILES + ')')

// A high finding that was fixed gets the next round
const dirs = reviewDirs(repo)
const rows = readFindings(dirs)
const rounds = [...new Set(rows.map((r) => r.round))].sort()
const last = rounds[rounds.length - 1]
// …unless the owner closed the arc (findings.mjs close)
if (last && !rows.some((r) => r.round === last && r.closed) && rows.some((r) => r.round === last && !r.clean && r.severity === 'high' && (r.verdict === 'confirmed' || r.verdict === 'partial') && r.resolution === 'fixed')) {
  fired.push('it fixes a high finding from ' + last + ': the fix gets the next round')
}

// Leftovers worth a look before any packet (warnings, not triggers)
const LEFTOVERS = [/\bdebugger\b/, /\.only\(/, /\bconsole\.log\(/, /\b(FIXME|XXX|WIP)\b/]
const leftovers = added.split('\n').filter((l) => LEFTOVERS.some((re) => re.test(l))).slice(0, 6)

if (fired.length) {
  console.log('Outside review: needed')
  for (const f of fired) console.log('  - ' + f)
  console.log("Build the packet once you'd push this right now: it works in the path the app uses, every acceptance test passes, the gates are green, the diff is only this change, and Claude has read all of it.")
} else {
  console.log('Outside review: not needed (' + (source.length ? sourceLines + ' changed source lines in ' + source.length + ' files, no trigger' : 'tests and docs only') + ').')
  console.log("Gates, Claude's own read of the diff and the owner's walk are enough.")
}
if (leftovers.length) {
  console.log('Leftovers to look at first:')
  for (const l of leftovers) console.log('  ' + l.slice(0, 120))
}
process.exit(fired.length ? 3 : 0)
