#!/usr/bin/env node
// The findings log: one append-only line per verified finding, rejects included, so a
// reviewer's precision and the recurring kinds of defect can be measured.
//
//   node findings.mjs add --file verdicts.json      (a JSON array of findings, see below)
//   node findings.mjs clean --round RV-004 --reviewer codex
//   node findings.mjs close --round RV-004 --reason "<the owner's call>"   (the owner ends the arc)
//   node findings.mjs stats
//
// A finding: { round, reviewer, id, severity, category, file, claim, verdict, evidence, resolution }
//   severity    high | medium | low
//   verdict     confirmed | partial | rejected | duplicate   (your verdict, from your own evidence)
//   resolution  fixed | deferred | wontfix | open
import { appendFileSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { args, die, repoRoot, reviewDirs, readFindings } from './lib.mjs'

const SEVERITY = ['high', 'medium', 'low']
const VERDICT = ['confirmed', 'partial', 'rejected', 'duplicate']
const RESOLUTION = ['fixed', 'deferred', 'wontfix', 'open']
// Free to extend: an unknown category is accepted and reported, never a reason to fail the log
const CATEGORIES = ['correctness', 'security', 'privacy', 'data-loss', 'test-gap', 'overclaim', 'ux', 'performance', 'reliability', 'maintainability', 'process', 'other']
const MAX_ROUNDS = 4

const a = args()
const repo = repoRoot(a.repo || process.cwd())
const dirs = reviewDirs(repo)
const cmd = a._[0]

if (cmd === 'add') {
  if (!a.file || a.file === true) die('--file is required: a JSON array of findings')
  const path = isAbsolute(a.file) ? a.file : join(repo, a.file)
  const rows = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(rows) || !rows.length) die('the file must hold a non-empty JSON array')
  const problems = []
  rows.forEach((r, i) => {
    const where = 'finding ' + (i + 1) + (r.id ? ' (' + r.id + ')' : '')
    for (const key of ['round', 'reviewer', 'id', 'claim', 'evidence']) if (!String(r[key] || '').trim()) problems.push(where + ': ' + key + ' is missing')
    if (!SEVERITY.includes(r.severity)) problems.push(where + ': severity must be ' + SEVERITY.join(' | '))
    if (!VERDICT.includes(r.verdict)) problems.push(where + ': verdict must be ' + VERDICT.join(' | '))
    if (!RESOLUTION.includes(r.resolution)) problems.push(where + ': resolution must be ' + RESOLUTION.join(' | '))
  })
  if (problems.length) die('nothing logged:\n  ' + problems.join('\n  '))
  const at = new Date().toISOString()
  appendFileSync(dirs.findings, rows.map((r) => JSON.stringify({ ...r, category: r.category || 'other', at })).join('\n') + '\n')
  const odd = rows.filter((r) => r.category && !CATEGORIES.includes(r.category)).map((r) => r.category)
  console.log('✓ logged ' + rows.length + ' finding(s) to docs/reviews/findings.jsonl' + (odd.length ? ' (new categories: ' + [...new Set(odd)].join(', ') + ')' : ''))
} else if (cmd === 'clean') {
  if (!a.round || !a.reviewer) die('--round and --reviewer are required')
  // A clean round is a row too, or the log can't tell "clean" from "never reviewed"
  appendFileSync(dirs.findings, JSON.stringify({ round: a.round, reviewer: a.reviewer, clean: true, at: new Date().toISOString() }) + '\n')
  console.log('✓ ' + a.round + ' logged as clean')
} else if (cmd === 'close') {
  if (!a.round || !a.reason || a.reason === true) die('--round and --reason are required: the owner closes an arc, and says why')
  appendFileSync(dirs.findings, JSON.stringify({ round: a.round, closed: true, by: 'owner', reason: String(a.reason), at: new Date().toISOString() }) + '\n')
  console.log('✓ the arc ending at ' + a.round + ' is closed by the owner')
} else if (cmd === 'stats') {
  const rows = readFindings(dirs)
  const findings = rows.filter((r) => !r.clean && !r.closed)
  const rounds = [...new Set(rows.map((r) => r.round))].sort()
  const count = (key, list = findings) => list.reduce((m, r) => ((m[r[key]] = (m[r[key]] || 0) + 1), m), {})
  console.log('Rounds: ' + rounds.length + ' · findings: ' + findings.length + ' · clean rounds: ' + rows.filter((r) => r.clean).length)
  if (!findings.length && !rounds.length) process.exit(0)
  for (const [reviewer, n] of Object.entries(count('reviewer'))) {
    const mine = findings.filter((r) => r.reviewer === reviewer)
    const held = mine.filter((r) => r.verdict === 'confirmed' || r.verdict === 'partial').length
    console.log('  ' + reviewer + ': ' + n + ' finding(s), ' + Math.round((held / n) * 100) + '% held up (confirmed or partial)')
  }
  console.log('By severity: ' + JSON.stringify(count('severity')))
  console.log('By category: ' + JSON.stringify(count('category')))
  console.log('By verdict: ' + JSON.stringify(count('verdict')))
  const open = findings.filter((r) => r.resolution === 'open' || r.resolution === 'deferred')
  if (open.length) console.log('Open or deferred: ' + open.map((r) => r.round + ' ' + r.id).join(', '))
  // Where the arc stands. Only a confirmed high finding blocks shipping (docs/standard.md, "What
  // blocks shipping"): a round without one closes the arc, mediums fixed or deferred. The owner can
  // close it too. After MAX_ROUNDS rounds with a high each, it's the owner's call.
  const last = rounds[rounds.length - 1]
  const blocks = (round) => !rows.some((r) => r.round === round && (r.clean || r.closed)) && findings.some((r) => r.round === round && r.severity === 'high' && (r.verdict === 'confirmed' || r.verdict === 'partial'))
  const ownerClosed = rows.find((r) => r.round === last && r.closed)
  let since = 0
  for (const round of [...rounds].reverse()) {
    if (!blocks(round)) break
    since++
  }
  if (ownerClosed) console.log('Arc: closed by the owner at ' + last + ': ' + ownerClosed.reason)
  else if (!blocks(last)) console.log('Arc: closed. ' + last + ' had no confirmed high finding; fix the mediums that are quick, defer the rest with a reason, and ship.')
  else if (since >= MAX_ROUNDS) console.log('Arc: ' + since + ' rounds with a high finding each. Stop, and let the owner decide what ships.')
  else console.log('Arc: open. A high finding held up: fix the class, rebuild the packet, run round ' + (since + 1) + ' of ' + MAX_ROUNDS + '.')
} else {
  die('usage: findings.mjs add --file <verdicts.json> | clean --round <RV-NNN> --reviewer <name> | stats')
}
