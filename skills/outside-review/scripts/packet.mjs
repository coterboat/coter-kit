#!/usr/bin/env node
// Builds the review packet for an outside reviewer: the goal or spec, every changed byte since
// the base, the gate results, and what the reviewer should attack. A script builds it so no
// round depends on someone remembering what to include.
//
//   node packet.mjs --goal <file or text> [--base <ref>] [--targets "..."] [--decisions "..."]
//                   [--gate "<command>"]... [--allow-red "<reason>"] [--repo <dir>]
//
// Refuses: no goal; nothing changed; a red gate (unless --allow-red, whose reason is printed into
// the packet). Gates come from --gate and from the project's .claude/checks.json (coter-kit's
// format). A project with no gates gets "NOT VERIFIED", never a pass.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { args, die, git, repoRoot, reviewDirs, changes, fingerprint, nextRound, sha } from './lib.mjs'

const a = args()
const repo = repoRoot(a.repo || process.cwd())
const dirs = reviewDirs(repo)

// The goal is the yardstick: without it a reviewer can only grade style
if (!a.goal || a.goal === true) die('--goal is required: the spec file, or the goal and acceptance criteria as text')
const goalPath = isAbsolute(a.goal) ? a.goal : join(repo, a.goal)
const goal = existsSync(goalPath) ? readFileSync(goalPath, 'utf8') : String(a.goal)

let base = a.base && a.base !== true ? a.base : null
if (!base) {
  try {
    base = git(repo, ['merge-base', 'HEAD', 'origin/main']).trim()
  } catch {
    base = 'HEAD'
  }
}
const baseSha = git(repo, ['rev-parse', base]).trim()
const head = git(repo, ['rev-parse', 'HEAD']).trim()
const { diff, untracked, binaries } = changes(repo, baseSha)
if (!diff.trim() && !untracked.length) die('nothing changed since ' + base + ': there is nothing to review', 2)

// A packet that leaves out changed source can't pass for a full review (RV-002 F7), and neither
// can one whose binary changes it can only name (RV-003 F7)
const omitted = [...untracked.filter((f) => f.omitted).map((f) => f.path + (f.text === '(binary file)' ? ' (binary)' : '')), ...binaries.map((f) => f.path + ' (binary)')]
if (omitted.length && !a['allow-incomplete']) {
  die(omitted.length + ' changed file(s) the packet cannot show (' + omitted.join(', ') + '): too large or binary. Split the change, or pass --allow-incomplete "<why>" to review without them')
}

// Gates: run each, record pass or fail with the tail of its output
const gates = [].concat(a.gate || []).filter((g) => g !== true).map((cmd) => ({ name: cmd, cmd }))
const checksFile = join(repo, '.claude', 'checks.json')
if (existsSync(checksFile)) {
  const cfg = JSON.parse(readFileSync(checksFile, 'utf8'))
  for (const c of cfg.checks || []) gates.push({ name: c.name || c.run.join(' '), argv: c.run, cwd: c.cwd ? join(repo, c.cwd) : repo })
}
const results = gates.map((g) => {
  const started = Date.now()
  const r = g.argv
    ? spawnSync(g.argv[0], g.argv.slice(1), { cwd: g.cwd, encoding: 'utf8', timeout: 15 * 60_000, maxBuffer: 32 * 1024 * 1024 })
    : spawnSync(g.cmd, { cwd: repo, shell: true, encoding: 'utf8', timeout: 15 * 60_000, maxBuffer: 32 * 1024 * 1024 })
  const output = ((r.stdout || '') + (r.stderr || '')).trim().split('\n').slice(-30).join('\n')
  return { name: g.name, ok: r.status === 0, status: r.status, ms: Date.now() - started, output }
})
const red = results.filter((r) => !r.ok)
if (red.length && !a['allow-red']) {
  for (const r of red) console.error('✗ ' + r.name + ' (exit ' + r.status + ')\n' + r.output)
  die(red.length + ' gate(s) red: fix them, or pass --allow-red "<why>" to send a red packet on purpose')
}

const round = nextRound(dirs)
const fence = (text, lang = '') => '````' + lang + '\n' + text.replace(/\n?$/, '\n') + '````'
const parts = [
  '# Review packet ' + round,
  '',
  '- round: ' + round,
  '- repo: ' + repo.split('/').pop(),
  '- base: ' + baseSha,
  '- head: ' + head,
  '- fingerprint: ' + fingerprint(repo, baseSha),
  '- built: ' + new Date().toISOString(),
  '- complete: ' + (omitted.length ? 'no' : 'yes'),
  '',
  '## Goal',
  '',
  goal.trim(),
  '',
  '## What to attack',
  '',
  a.targets && a.targets !== true ? String(a.targets) : 'Whatever a real user, an attacker or bad data could break in this change.',
  '',
  '## Decisions to challenge',
  '',
  a.decisions && a.decisions !== true ? String(a.decisions) : '(none declared)',
  '',
  '## Gates',
  '',
  results.length
    ? results.map((r) => '- ' + (r.ok ? 'PASS' : 'RED') + ' · ' + r.name + ' (' + Math.round(r.ms / 1000) + 's)').join('\n')
    : '- NOT VERIFIED: no gates declared (add .claude/checks.json, or pass --gate)',
  ...(red.length ? ['', 'Sent red on purpose: ' + String(a['allow-red'])] : []),
  ...(omitted.length ? ['', 'INCOMPLETE: left out (too large or binary): ' + omitted.join(', ') + '. Reason: ' + String(a['allow-incomplete'])] : []),
  '',
  '## Diff since base',
  '',
  diff.trim() ? fence(diff, 'diff') : '(no tracked changes)',
  ...(untracked.length ? ['', '## New files', '', ...untracked.map((f) => '### ' + f.path + '\n\n' + fence(f.text))] : []),
  '',
]
const packet = parts.join('\n')
const out = join(dirs.packets, round + '.md')
writeFileSync(out, packet)
console.log('✓ packet ' + round + ': ' + out.slice(repo.length + 1))
console.log('  ' + Math.round(packet.length / 1024) + ' KB · sha256 ' + sha(packet) + ' · gates ' + (results.length ? results.length - red.length + '/' + results.length + ' green' : 'none'))
if (packet.length > 400 * 1024) console.log('  ⚠ over 400 KB: consider a narrower base, or splitting the change')
