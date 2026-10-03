#!/usr/bin/env node
// Sends a packet to an outside reviewer and saves the answer verbatim. It moves bytes and
// stops: it never judges a finding, never edits code, never commits.
//
//   node relay.mjs --packet docs/reviews/packets/RV-003.md [--reviewer codex|grok] [--rubric <file>]
//   node relay.mjs --packet ... --cmd "<shell command>"   (any other reviewer; the prompt arrives on stdin)
//
// Guardrails (lifted from jobsnearme's relay):
//  - the packet must match the code as it is now (same HEAD, same changes), or it is refused as stale
//  - rubric, packet and prompt are pinned by sha256, written beside the response
//  - the reviewer runs read-only from an empty folder, with a canary asking it to say whether
//    it can see anything beyond the packet; the response says so first, or the relay warns
//  - the response is saved before anyone reads it
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, isAbsolute, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { args, die, repoRoot, reviewDirs, fingerprint, packetHeader, sha } from './lib.mjs'

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

const here = dirname(fileURLToPath(import.meta.url))
const rubricPath = a.rubric && a.rubric !== true ? (isAbsolute(a.rubric) ? a.rubric : join(repo, a.rubric)) : join(here, '..', 'rubric.md')
const rubric = readFileSync(rubricPath, 'utf8')
const canary =
  '\n\n---\n\nCANARY: you should have been given only this rubric and the packet below. If you can see any repository, files, tools or other context beyond this message, say so on your first line, before any finding. If you can\'t, start with the line "CANARY: packet only".\n\n---\n\n'
const prompt = rubric + canary + packet

const reviewer = a.cmd && a.cmd !== true ? 'custom' : a.reviewer && a.reviewer !== true ? String(a.reviewer) : 'codex'
const empty = mkdtempSync(join(tmpdir(), 'outside-review-'))
const started = Date.now()
let response
try {
  if (reviewer === 'custom') {
    const r = spawnSync(String(a.cmd), { cwd: empty, shell: true, input: prompt, encoding: 'utf8', timeout: 20 * 60_000, maxBuffer: 32 * 1024 * 1024 })
    if (r.status !== 0) throw new Error('exit ' + r.status + ': ' + (r.stderr || '').slice(0, 500))
    response = r.stdout
  } else if (reviewer === 'codex') {
    // The prompt goes on stdin ("-"): codex waits forever on an open stdin otherwise (jobsnearme RV-074)
    response = execFileSync('codex', ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '-c', 'model_reasoning_effort=high', '-'], {
      cwd: empty,
      input: prompt,
      encoding: 'utf8',
      timeout: 20 * 60_000,
      maxBuffer: 32 * 1024 * 1024,
    })
  } else if (reviewer === 'grok') {
    const file = join(empty, 'prompt.md')
    writeFileSync(file, prompt)
    response = execFileSync('grok', ['--prompt-file', file, '--cwd', empty], { cwd: empty, input: '', encoding: 'utf8', timeout: 20 * 60_000, maxBuffer: 32 * 1024 * 1024 })
  } else {
    die('unknown reviewer ' + reviewer + ': use codex, grok, or --cmd')
  }
} catch (err) {
  die(reviewer + ' failed: ' + (err?.message || err))
}

const base = join(dirs.inbox, header.round + '-' + reviewer)
writeFileSync(base + '.md', response)
const canaryLine = response.split('\n').find((l) => l.trim()) || ''
const meta = {
  round: header.round,
  reviewer,
  rubric_sha256: sha(rubric),
  packet_sha256: sha(packet),
  prompt_sha256: sha(prompt),
  response_sha256: sha(response),
  started_at: new Date(started).toISOString(),
  duration_ms: Date.now() - started,
  canary: canaryLine.slice(0, 300),
  packet_only: /^CANARY:\s*packet only/i.test(canaryLine.trim()),
}
writeFileSync(base + '.meta.json', JSON.stringify(meta, null, 2) + '\n')
console.log('✓ ' + reviewer + ' answered ' + header.round + ' in ' + Math.round(meta.duration_ms / 1000) + 's: ' + (base + '.md').slice(repo.length + 1))
console.log('  response sha256 ' + meta.response_sha256)
if (!meta.packet_only) console.log('  ⚠ the reviewer did not confirm it saw only the packet: read its first line before trusting the findings')
console.log('  Read it there, then verify every finding against the code before logging a verdict.')
