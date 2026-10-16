#!/usr/bin/env node
// Sends a packet to an outside reviewer and saves the answer verbatim. It moves bytes and
// stops: it never judges a finding, never edits code, never commits.
//
//   node relay.mjs --packet docs/reviews/packets/RV-003.md [--reviewer codex|grok] [--rubric <file>]
//                  [--packet-only] [--keep] [--allow-secrets "<why>"]
//   node relay.mjs --packet ... --cmd "<shell command>"   (any other reviewer; the prompt arrives on stdin)
//
// Guardrails (lifted from jobsnearme's relay, FS-650 included):
//  - the packet must match the code as it is now (same HEAD, same changes), or it is refused as stale
//  - nothing secret-shaped leaves: the prompt is scanned, and a hit refuses the relay unless
//    --allow-secrets says why (fake fixtures, checked by you); the export is scanned too, and a hit
//    there means no export this round, only the packet
//  - the reviewer runs read-only in an export of the repository as it is now (export.mjs): the
//    files the packet describes, without .git, ignored files, media or the review trail, with a
//    random id planted in it. The relay checks the reply: the id on its first line, and no path of
//    the real checkout. .claude/review.json "export": false, or --packet-only, keeps the old way:
//    an empty folder and a canary asking the reviewer to say what it can see
//  - rubric, packet and prompt are pinned by sha256, written beside the response
//  - the response is saved before anyone reads it, and the export is removed after (--keep keeps it)
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, isAbsolute, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { args, die, git, repoRoot, reviewDirs, fingerprint, packetHeader, sha } from './lib.mjs'
import { exportList, isolationProblems, reviewConfig, scan, secretsIn, knownSecrets, unexcused, writeExport } from './export.mjs'

const a = args()
const repo = repoRoot(a.repo || process.cwd())
const dirs = reviewDirs(repo)
if (!a.packet || a.packet === true) die('--packet is required (build one with packet.mjs)')
const packetPath = isAbsolute(a.packet) ? a.packet : join(repo, a.packet)
if (!existsSync(packetPath)) die('no packet at ' + packetPath)
const packet = readFileSync(packetPath, 'utf8')
if (!packet.trim()) die('the packet is empty')
const header = packetHeader(packet)
if (!header.round || !header.base || !header.fingerprint) die('not a packet built by packet.mjs (no round, base or fingerprint in its header)')
if (fingerprint(repo, header.base) !== header.fingerprint) die('stale packet: the code changed since ' + header.round + ' was built. Build a new one.', 2)

let cfg
try {
  cfg = reviewConfig(repo)
} catch (err) {
  die(err.message)
}
const here = dirname(fileURLToPath(import.meta.url))
const rubricPath = a.rubric && a.rubric !== true ? (isAbsolute(a.rubric) ? a.rubric : join(repo, a.rubric)) : join(here, '..', 'rubric.md')
const rubric = readFileSync(rubricPath, 'utf8')
const where = (hits) => hits.map((h) => h.path + ':' + h.line + ' (' + h.kind + ')').join(', ')

// What leaves this machine is scanned first; the relay names where, never what
const known = knownSecrets(repo)
const promptHits = secretsIn(rubric + '\n' + packet, known).map((h) => ({ path: 'the packet', ...h }))
const allowSecrets = a['allow-secrets'] && a['allow-secrets'] !== true ? String(a['allow-secrets']) : null
if (promptHits.length && !allowSecrets) {
  die(promptHits.length + ' secret-shaped value(s) in what would be sent: ' + where(promptHits) + '. If they are fake (test fixtures), check each, then pass --allow-secrets "<why>"; if any is real, take it out of the change and rotate it')
}

// The export, unless it is off or would carry a secret
const head = git(repo, ['rev-parse', 'HEAD']).trim()
let ex = null
let exportOff = a['packet-only'] === true ? '--packet-only' : cfg.export === false ? '.claude/review.json "export": false' : null
let withheld = []
let left = []
if (!exportOff) {
  const listed = exportList(repo, { exclude: [].concat(cfg.exportExclude || []) })
  left = listed.left
  withheld = unexcused(scan(repo, listed.files, { known }), cfg.exportFakes || [])
  // The digest lets the owner excuse one checked fake exactly ({ path, digests } in exportFakes); never the value
  if (withheld.length) exportOff = 'secret-shaped values in ' + withheld.map((h) => h.path + ':' + h.line + ' (' + h.kind + ', digest ' + h.digest + ')').join(', ')
  else {
    try {
      ex = writeExport(repo, listed.files, head)
    } catch (err) {
      die('export failed: ' + err.message)
    }
    ex.files = listed.files.size
  }
}

const canary = ex
  ? '\n\n---\n\nCANARY: your working folder is a read-only export of this repository as it is now (HEAD ' + head + ', uncommitted changes included): its files, without .git, ignored files, media or the review trail. Put `EXPORT <id>` on your first line, with the id from its .review-export file, and name any file you read outside this folder.\n\n---\n\n'
  : '\n\n---\n\nCANARY: you should have been given only this rubric and the packet below. If you can see any repository, files, tools or other context beyond this message, say so on your first line, before any finding. If you can\'t, start with the line "CANARY: packet only".\n\n---\n\n'
const prompt = rubric + canary + packet
if (exportOff) console.log('packet only this round: ' + exportOff)

const reviewer = a.cmd && a.cmd !== true ? 'custom' : a.reviewer && a.reviewer !== true ? String(a.reviewer) : 'codex'
const cwd = ex ? ex.dir : mkdtempSync(join(tmpdir(), 'outside-review-'))
const cleanup = () => {
  if (ex && a.keep !== true) rmSync(ex.dir, { recursive: true, force: true })
}
const started = Date.now()
let response
try {
  if (reviewer === 'custom') {
    const r = spawnSync(String(a.cmd), { cwd, shell: true, input: prompt, encoding: 'utf8', timeout: 20 * 60_000, maxBuffer: 32 * 1024 * 1024 })
    if (r.status !== 0) throw new Error('exit ' + r.status + ': ' + (r.stderr || '').slice(0, 500))
    response = r.stdout
  } else if (reviewer === 'codex') {
    // The prompt goes on stdin ("-"): codex waits forever on an open stdin otherwise (jobsnearme RV-074)
    response = execFileSync('codex', ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '-C', cwd, '-c', 'model_reasoning_effort=high', '-'], {
      cwd,
      input: prompt,
      encoding: 'utf8',
      timeout: 20 * 60_000,
      maxBuffer: 32 * 1024 * 1024,
    })
  } else if (reviewer === 'grok') {
    // The prompt file sits beside the export, not in it
    const file = join(mkdtempSync(join(tmpdir(), 'outside-review-prompt-')), 'prompt.md')
    writeFileSync(file, prompt)
    response = execFileSync('grok', ['--prompt-file', file, '--cwd', cwd], { cwd, input: '', encoding: 'utf8', timeout: 20 * 60_000, maxBuffer: 32 * 1024 * 1024 })
  } else {
    cleanup()
    die('unknown reviewer ' + reviewer + ': use codex, grok, or --cmd')
  }
} catch (err) {
  cleanup()
  die(reviewer + ' failed: ' + (err?.message || err))
}

// A saved answer is never written over: a second relay of the same round gets its own attempt name
// (RV-020 F5: a retry used to truncate the first reply and its pins)
let base
for (let attempt = 1; ; attempt++) {
  base = join(dirs.inbox, header.round + '-' + reviewer + (attempt > 1 ? '-' + attempt : ''))
  try {
    writeFileSync(base + '.md', response, { flag: 'wx' })
    break
  } catch (err) {
    if (err.code !== 'EEXIST') throw err
  }
}
const firstLine = response.split('\n').find((l) => l.trim()) || ''
let isolation = []
if (ex) {
  const common = git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()
  // Every spelling of the checkout: macOS reaches /private/var as /var, and /private/tmp as /tmp
  const spellings = (p) => [p, realpathSync(p)].flatMap((q) => (q.startsWith('/private/') ? [q, q.slice('/private'.length)] : [q]))
  const roots = [...new Set([...spellings(repo), ...spellings(dirname(common))])]
  isolation = isolationProblems(response, { id: ex.id, roots })
}
const meta = {
  round: header.round,
  reviewer,
  rubric_sha256: sha(rubric),
  packet_sha256: sha(packet),
  prompt_sha256: sha(prompt),
  response_sha256: sha(response),
  started_at: new Date(started).toISOString(),
  duration_ms: Date.now() - started,
  canary: firstLine.slice(0, 300),
  export: ex ? { head, files: ex.files, bytes: ex.bytes, left_out: left, isolation_problems: isolation } : false,
  ...(ex ? {} : { packet_only: /^CANARY:\s*packet only/i.test(firstLine.trim()), export_off: exportOff }),
  ...(allowSecrets ? { secrets_allowed: { why: allowSecrets, where: promptHits.map((h) => h.path + ':' + h.line + ' (' + h.kind + ')') } } : {}),
}
writeFileSync(base + '.meta.json', JSON.stringify(meta, null, 2) + '\n', { flag: 'wx' })
cleanup()
console.log('✓ ' + reviewer + ' answered ' + header.round + ' in ' + Math.round(meta.duration_ms / 1000) + 's: ' + (base + '.md').slice(repo.length + 1))
console.log('  response sha256 ' + meta.response_sha256)
if (ex) {
  console.log('  export: ' + ex.files + ' files, ' + Math.round(ex.bytes / 1024) + ' KB' + (left.length ? '; left out as too large: ' + left.join(', ') : '') + (a.keep === true ? '; kept at ' + ex.dir : ''))
  if (isolation.length) for (const p of isolation) console.log('  ⚠ ' + p + ': read the reply before trusting the findings')
  else console.log('  isolation: the reply quotes the export id and names no checkout path (a read that names no path cannot be seen from here)')
} else if (!meta.packet_only) console.log('  ⚠ the reviewer did not confirm it saw only the packet: read its first line before trusting the findings')
console.log('  Read it there, then verify every finding against the code before logging a verdict.')
