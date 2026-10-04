// The outside-review skill's scripts, on a throwaway git repository: node --test tests/outside-review.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPTS = join(import.meta.dirname, '..', 'skills', 'outside-review', 'scripts')
const node = (repo, script, ...argv) => spawnSync('node', [join(SCRIPTS, script), ...argv], { cwd: repo, encoding: 'utf8' })
const git = (repo, ...argv) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...argv], { encoding: 'utf8' })

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'or-test-'))
  git(dir, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'app.js'), 'export const add = (a, b) => a + b\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'base')
  return dir
}

const REPLY = 'CANARY: packet only\n### F1 · high · correctness\nFile: app.js:1\nClaim: subtracts\nEvidence: the diff\nFix: add\n'

test('a packet needs a goal and a change, and carries the diff, new files and gates', () => {
  const dir = repo()
  assert.match(node(dir, 'packet.mjs').stderr, /--goal is required/)
  const empty = node(dir, 'packet.mjs', '--goal', 'Add numbers', '--base', 'HEAD')
  assert.equal(empty.status, 2)
  assert.match(empty.stderr, /nothing changed/)

  writeFileSync(join(dir, 'app.js'), 'export const add = (a, b) => a - b\n')
  writeFileSync(join(dir, 'new.js'), 'export const x = 1\n')
  const ok = node(dir, 'packet.mjs', '--goal', 'Add numbers', '--base', 'HEAD', '--targets', 'wrong sums', '--gate', 'true')
  assert.equal(ok.status, 0, ok.stderr)
  const packet = readFileSync(join(dir, 'docs/reviews/packets/RV-001.md'), 'utf8')
  assert.match(packet, /- round: RV-001/)
  assert.match(packet, /a - b/)
  assert.match(packet, /### new\.js/)
  assert.match(packet, /PASS · true/)
  assert.match(packet, /wrong sums/)
})

test('a red gate refuses the packet unless it is sent red on purpose, with the reason', () => {
  const dir = repo()
  writeFileSync(join(dir, 'app.js'), 'broken(\n')
  const red = node(dir, 'packet.mjs', '--goal', 'g', '--base', 'HEAD', '--gate', 'false')
  assert.equal(red.status, 1)
  assert.match(red.stderr, /gate\(s\) red/)
  const sent = node(dir, 'packet.mjs', '--goal', 'g', '--base', 'HEAD', '--gate', 'false', '--allow-red', 'reviewing the failure itself')
  assert.equal(sent.status, 0, sent.stderr)
  assert.match(readFileSync(join(dir, 'docs/reviews/packets/RV-001.md'), 'utf8'), /Sent red on purpose: reviewing the failure itself/)
})

test('without a gate, a packet says NOT VERIFIED, never a pass', () => {
  const dir = repo()
  writeFileSync(join(dir, 'app.js'), 'export const add = () => 0\n')
  node(dir, 'packet.mjs', '--goal', 'g', '--base', 'HEAD')
  assert.match(readFileSync(join(dir, 'docs/reviews/packets/RV-001.md'), 'utf8'), /NOT VERIFIED/)
})

test('the relay saves the answer verbatim with pins, warns without the canary, and refuses a stale packet', () => {
  const dir = repo()
  writeFileSync(join(dir, 'app.js'), 'export const add = (a, b) => a - b\n')
  node(dir, 'packet.mjs', '--goal', 'g', '--base', 'HEAD')
  // The fake reviewer's answer lives outside the repo: any new file in it makes the packet stale
  const reply = join(mkdtempSync(join(tmpdir(), 'or-reply-')), 'reply.txt')
  writeFileSync(reply, REPLY)
  const ok = node(dir, 'relay.mjs', '--packet', 'docs/reviews/packets/RV-001.md', '--cmd', 'cat ' + reply)
  assert.equal(ok.status, 0, ok.stderr)
  assert.equal(readFileSync(join(dir, 'docs/reviews/inbox/RV-001-custom.md'), 'utf8'), REPLY)
  const meta = JSON.parse(readFileSync(join(dir, 'docs/reviews/inbox/RV-001-custom.meta.json'), 'utf8'))
  assert.equal(meta.packet_only, true)
  assert.match(meta.packet_sha256, /^[0-9a-f]{64}$/)

  const leaky = node(dir, 'relay.mjs', '--packet', 'docs/reviews/packets/RV-001.md', '--cmd', 'echo I can see your repo')
  assert.match(leaky.stdout, /did not confirm it saw only the packet/)

  writeFileSync(join(dir, 'app.js'), 'export const add = (a, b) => a * b\n')
  const stale = node(dir, 'relay.mjs', '--packet', 'docs/reviews/packets/RV-001.md', '--cmd', 'cat ' + reply)
  assert.equal(stale.status, 2)
  assert.match(stale.stderr, /stale packet/)
})

test('a finding without evidence or with an unknown verdict logs nothing', () => {
  const dir = repo()
  writeFileSync(join(dir, 'v.json'), JSON.stringify([{ round: 'RV-001', reviewer: 'codex', id: 'F1', severity: 'high', claim: 'x', verdict: 'agreed', resolution: 'fixed' }]))
  const bad = node(dir, 'findings.mjs', 'add', '--file', 'v.json')
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /evidence is missing/)
  assert.match(bad.stderr, /verdict must be/)
  assert.equal(existsSync(join(dir, 'docs/reviews/findings.jsonl')), false)
})

test('stats: precision per reviewer, and when the arc closes or goes to the owner', () => {
  const dir = repo()
  const f = (round, id, severity, verdict) => ({ round, reviewer: 'codex', id, severity, category: 'correctness', file: 'app.js:1', claim: 'c', verdict, evidence: 'e', resolution: 'fixed' })
  writeFileSync(join(dir, 'v.json'), JSON.stringify([f('RV-001', 'F1', 'high', 'confirmed'), f('RV-001', 'F2', 'medium', 'rejected')]))
  node(dir, 'findings.mjs', 'add', '--file', 'v.json')
  let stats = node(dir, 'findings.mjs', 'stats').stdout
  assert.match(stats, /codex: 2 finding\(s\), 50% held up/)
  assert.match(stats, /Arc: open\. A high finding held up: .*round 2 of 4/)

  node(dir, 'findings.mjs', 'clean', '--round', 'RV-002', '--reviewer', 'codex')
  assert.match(node(dir, 'findings.mjs', 'stats').stdout, /Arc: closed\. RV-002/)

  for (const r of ['RV-003', 'RV-004', 'RV-005', 'RV-006']) {
    writeFileSync(join(dir, 'v.json'), JSON.stringify([f(r, 'F1', 'high', 'confirmed')]))
    node(dir, 'findings.mjs', 'add', '--file', 'v.json')
  }
  stats = node(dir, 'findings.mjs', 'stats').stdout
  assert.match(stats, /4 rounds with a high finding each\. Stop, and let the owner decide/)
})

test("a packet never includes the review's own files", () => {
  const dir = repo()
  writeFileSync(join(dir, 'app.js'), 'export const add = (a, b) => a - b\n')
  node(dir, 'packet.mjs', '--goal', 'g', '--base', 'HEAD')
  node(dir, 'packet.mjs', '--goal', 'g', '--base', 'HEAD')
  const second = readFileSync(join(dir, 'docs/reviews/packets/RV-002.md'), 'utf8')
  assert.doesNotMatch(second, /# Review packet RV-001/)
  assert.deepEqual(readdirSync(join(dir, 'docs/reviews/packets')).sort(), ['RV-001.md', 'RV-002.md'])
})

test('RV-001 F7: a packet never follows a symbolic link out of the repository', () => {
  const dir = repo()
  const secret = join(mkdtempSync(join(tmpdir(), 'or-secret-')), 'config')
  writeFileSync(secret, 'Host prod\n  IdentityFile ~/.ssh/very-secret-key\n')
  symlinkSync(secret, join(dir, 'debug.txt'))
  writeFileSync(join(dir, 'app.js'), 'export const add = (a, b) => a - b\n')
  const ok = node(dir, 'packet.mjs', '--goal', 'g', '--base', 'HEAD')
  assert.equal(ok.status, 0, ok.stderr)
  const packet = readFileSync(join(dir, 'docs/reviews/packets/RV-001.md'), 'utf8')
  assert.doesNotMatch(packet, /very-secret-key/)
  assert.match(packet, /### debug\.txt\n\n````\n\(symbolic link, not included\)/)
})

test('RV-002 F7: a packet that would leave out a changed file is refused, and editing that file makes it stale', () => {
  const dir = repo()
  const big = join(dir, 'data.json')
  writeFileSync(big, 'a'.repeat(250 * 1024))
  const refused = node(dir, 'packet.mjs', '--goal', 'g', '--base', 'HEAD')
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /cannot show \(data\.json\)/)
  const ok = node(dir, 'packet.mjs', '--goal', 'g', '--base', 'HEAD', '--allow-incomplete', 'generated fixture')
  assert.equal(ok.status, 0, ok.stderr)
  const packet = readFileSync(join(dir, 'docs/reviews/packets/RV-001.md'), 'utf8')
  assert.match(packet, /- complete: no/)
  assert.match(packet, /INCOMPLETE: left out \(too large or binary\): data\.json\. Reason: generated fixture/)
  // Same size, different bytes: still stale
  writeFileSync(big, 'b'.repeat(250 * 1024))
  const reply = join(mkdtempSync(join(tmpdir(), 'or-reply-')), 'r.txt')
  writeFileSync(reply, 'CANARY: packet only\nCLEAN\n')
  const stale = node(dir, 'relay.mjs', '--packet', 'docs/reviews/packets/RV-001.md', '--cmd', 'cat ' + reply)
  assert.equal(stale.status, 2)
  assert.match(stale.stderr, /stale packet/)
})

test('RV-003 F7: a binary change in a tracked file makes the packet incomplete, and changing it again makes it stale', () => {
  const dir = repo()
  const png = join(dir, 'logo.png')
  writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1, 2, 3]))
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'logo')
  writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 9, 9, 9]))
  const refused = node(dir, 'packet.mjs', '--goal', 'g', '--base', 'HEAD')
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /logo\.png \(binary\)/)
  const ok = node(dir, 'packet.mjs', '--goal', 'g', '--base', 'HEAD', '--allow-incomplete', 'new logo')
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(readFileSync(join(dir, 'docs/reviews/packets/RV-001.md'), 'utf8'), /- complete: no/)
  writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 7, 7, 7]))
  const reply = join(mkdtempSync(join(tmpdir(), 'or-reply-')), 'r.txt')
  writeFileSync(reply, 'CANARY: packet only\nCLEAN\n')
  const stale = node(dir, 'relay.mjs', '--packet', 'docs/reviews/packets/RV-001.md', '--cmd', 'cat ' + reply)
  assert.equal(stale.status, 2)
})

test('RV-004 F6: a new untracked binary makes the packet incomplete', () => {
  const dir = repo()
  writeFileSync(join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1, 2]))
  const refused = node(dir, 'packet.mjs', '--goal', 'g', '--base', 'HEAD')
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /logo\.png \(binary\)/)
})

test('the arc closes on a round with no confirmed high, and the owner can close it on record', () => {
  const dir = repo()
  const f = (round, id, severity, verdict) => ({ round, reviewer: 'codex', id, severity, category: 'correctness', file: 'a:1', claim: 'c', verdict, evidence: 'e', resolution: 'fixed' })
  writeFileSync(join(dir, 'v.json'), JSON.stringify([f('RV-001', 'F1', 'medium', 'confirmed'), f('RV-001', 'F2', 'high', 'rejected')]))
  node(dir, 'findings.mjs', 'add', '--file', 'v.json')
  assert.match(node(dir, 'findings.mjs', 'stats').stdout, /Arc: closed\. RV-001 had no confirmed high finding/)
  writeFileSync(join(dir, 'v.json'), JSON.stringify([f('RV-002', 'F1', 'high', 'confirmed')]))
  node(dir, 'findings.mjs', 'add', '--file', 'v.json')
  assert.match(node(dir, 'findings.mjs', 'stats').stdout, /Arc: open/)
  assert.match(node(dir, 'findings.mjs', 'close', '--round', 'RV-002').stderr, /--reason are required/)
  node(dir, 'findings.mjs', 'close', '--round', 'RV-002', '--reason', 'enough iterating')
  assert.match(node(dir, 'findings.mjs', 'stats').stdout, /Arc: closed by the owner at RV-002: enough iterating/)
})

test('triage: docs and tests alone need no outside review; data, a sensitive path or a big change do', () => {
  const dir = repo()
  writeFileSync(join(dir, 'README.md'), '# notes\n')
  writeFileSync(join(dir, 'app.test.js'), 'test()\n')
  let r = node(dir, 'triage.mjs', '--base', 'HEAD')
  assert.equal(r.status, 0, r.stdout)
  assert.match(r.stdout, /not needed \(tests and docs only\)/)

  writeFileSync(join(dir, 'app.js'), 'export const wipe = () => db.query("DELETE FROM users")\n')
  r = node(dir, 'triage.mjs', '--base', 'HEAD')
  assert.equal(r.status, 3)
  assert.match(r.stdout, /touches data that lasts: what the change adds/)

  const dir2 = repo()
  mkdirSync(join(dir2, '.claude'), { recursive: true })
  writeFileSync(join(dir2, '.claude/review.json'), JSON.stringify({ sensitive: [{ glob: 'src/consent/**', why: 'consent' }] }))
  mkdirSync(join(dir2, 'src/consent'), { recursive: true })
  writeFileSync(join(dir2, 'src/consent/rule.js'), 'export const ok = true\n')
  r = node(dir2, 'triage.mjs', '--base', 'HEAD')
  assert.match(r.stdout, /this project marks it sensitive \(consent\): src\/consent\/rule\.js/)

  const dir3 = repo()
  writeFileSync(join(dir3, 'big.js'), Array.from({ length: 450 }, (_, i) => 'export const v' + i + ' = ' + i).join('\n'))
  r = node(dir3, 'triage.mjs', '--base', 'HEAD')
  assert.match(r.stdout, /too big to hold in your head: 450 changed source lines/)
})

test('triage: a fixed high finding sends the next round, until the owner closes the arc', () => {
  const dir = repo()
  writeFileSync(join(dir, 'README.md'), 'x\n')
  writeFileSync(join(dir, 'v.json'), JSON.stringify([{ round: 'RV-001', reviewer: 'codex', id: 'F1', severity: 'high', category: 'privacy', file: 'a:1', claim: 'c', verdict: 'confirmed', evidence: 'e', resolution: 'fixed' }]))
  node(dir, 'findings.mjs', 'add', '--file', 'v.json')
  assert.match(node(dir, 'triage.mjs', '--base', 'HEAD').stdout, /it fixes a high finding from RV-001/)
  node(dir, 'findings.mjs', 'close', '--round', 'RV-001', '--reason', 'shipping')
  assert.match(node(dir, 'triage.mjs', '--base', 'HEAD').stdout, /not needed/)
})

test('triage only reads: it never creates review folders in a repository', () => {
  const dir = repo()
  writeFileSync(join(dir, 'README.md'), 'x\n')
  node(dir, 'triage.mjs', '--base', 'HEAD')
  assert.equal(existsSync(join(dir, 'docs/reviews')), false)
})
