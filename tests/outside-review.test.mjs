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
  // The packet-only way, kept for "export": false and --packet-only (the export has its own tests below)
  const ok = node(dir, 'relay.mjs', '--packet', 'docs/reviews/packets/RV-001.md', '--packet-only', '--cmd', 'cat ' + reply)
  assert.equal(ok.status, 0, ok.stderr)
  assert.equal(readFileSync(join(dir, 'docs/reviews/inbox/RV-001-custom.md'), 'utf8'), REPLY)
  const meta = JSON.parse(readFileSync(join(dir, 'docs/reviews/inbox/RV-001-custom.meta.json'), 'utf8'))
  assert.equal(meta.packet_only, true)
  assert.match(meta.packet_sha256, /^[0-9a-f]{64}$/)

  const leaky = node(dir, 'relay.mjs', '--packet', 'docs/reviews/packets/RV-001.md', '--packet-only', '--cmd', 'echo I can see your repo')
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

test('a fresh checkout numbers the next round past the logged ones, so a reply in the inbox is never overwritten', () => {
  const dir = repo()
  // The trail is committed; the packets folder is not, so a new clone or worktree has none
  mkdirSync(join(dir, 'docs/reviews/inbox'), { recursive: true })
  writeFileSync(join(dir, 'docs/reviews/inbox/RV-007-codex.md'), 'kept\n')
  writeFileSync(join(dir, 'docs/reviews/findings.jsonl'), JSON.stringify({ round: 'RV-009', closed: true, by: 'owner', reason: 'shipped', at: '2026-10-04T00:00:00Z' }) + '\n')
  writeFileSync(join(dir, 'app.js'), 'export const add = (a, b) => a - b\n')
  const ok = node(dir, 'packet.mjs', '--goal', 'Add numbers', '--base', 'HEAD', '--gate', 'true')
  assert.equal(ok.status, 0, ok.stderr)
  assert.ok(existsSync(join(dir, 'docs/reviews/packets/RV-010.md')))
})

// ── The export (Codex's ask, 2026-10-15; jobsnearme FS-650), and nothing secret leaving with it ──

// Secret-shaped values are built at run time, so this file itself holds none
const FAKE = {
  storage: 'Account' + 'Key=' + 'Zq9'.repeat(12),
  conn: 'Server=db.example.net;Database=app;User Id=app;Pass' + 'word=' + 'Hx7'.repeat(4) + ';',
  setting: '"api' + 'Key": "' + 'k7Q'.repeat(8) + '"',
}
const EXPORT_REVIEWER = 'printf "EXPORT %s\\n" "$(head -1 .review-export)"; pwd; ls -a; cat app.js'
const exportRepo = () => {
  const dir = repo()
  writeFileSync(join(dir, '.gitignore'), 'ignored.txt\n.env\n')
  writeFileSync(join(dir, 'ignored.txt'), 'never exported\n')
  writeFileSync(join(dir, 'pic.png'), 'not really a png\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'fixture')
  writeFileSync(join(dir, 'app.js'), 'export const add = (a, b) => a - b\n')
  writeFileSync(join(dir, 'new.js'), 'export const x = 1\n')
  return dir
}
const relay = (dir, ...extra) => node(dir, 'relay.mjs', '--packet', 'docs/reviews/packets/RV-001.md', ...extra)

test('the export: the reviewer runs in a copy of the code as it is now, without .git, ignored files, media or the review trail, removed after', () => {
  const dir = exportRepo()
  assert.equal(node(dir, 'packet.mjs', '--goal', 'g', '--base', 'HEAD').status, 0)
  const r = relay(dir, '--cmd', EXPORT_REVIEWER)
  assert.equal(r.status, 0, r.stderr)
  const reply = readFileSync(join(dir, 'docs/reviews/inbox/RV-001-custom.md'), 'utf8')
  assert.match(reply, /^EXPORT [0-9a-f]{32}\n/)
  assert.match(reply, /a - b/, 'the working tree, not HEAD')
  const listing = reply.split('\n')
  assert.ok(listing.includes('new.js'), 'untracked files go')
  for (const gone of ['.git', 'docs', 'ignored.txt', 'pic.png']) assert.ok(!listing.includes(gone), gone + ' must not be exported')
  const exportDir = listing[1]
  assert.ok(!existsSync(exportDir), 'the export is removed after the reply is saved')
  const meta = JSON.parse(readFileSync(join(dir, 'docs/reviews/inbox/RV-001-custom.meta.json'), 'utf8'))
  assert.equal(meta.export.files, 3) // .gitignore, app.js and new.js; pic.png is media
  assert.deepEqual(meta.export.isolation_problems, [])
  assert.match(r.stdout, /isolation: the reply quotes the export id/)
})

test('the relay checks the reply itself: no EXPORT line, or a path of the real checkout, is written down and warned', () => {
  const dir = exportRepo()
  node(dir, 'packet.mjs', '--goal', 'g', '--base', 'HEAD')
  const r = relay(dir, '--cmd', 'echo "I read ' + dir + '/app.js"')
  assert.equal(r.status, 0, r.stderr)
  const meta = JSON.parse(readFileSync(join(dir, 'docs/reviews/inbox/RV-001-custom.meta.json'), 'utf8'))
  assert.equal(meta.export.isolation_problems.length, 2)
  assert.match(r.stdout, /does not begin with the EXPORT line/)
  assert.match(r.stdout, /names the checkout/)
})

test('a secret-shaped value in an exported file means packet only this round, named by place and never by value', () => {
  const dir = exportRepo()
  writeFileSync(join(dir, 'settings.ps1'), '$conn = "' + FAKE.storage + '"\n')
  git(dir, 'add', 'settings.ps1')
  git(dir, 'commit', '-q', '-m', 'a key, committed long ago')
  node(dir, 'packet.mjs', '--goal', 'g', '--base', 'HEAD')
  const r = relay(dir, '--cmd', 'cat; true')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /packet only this round: secret-shaped values in settings\.ps1:1 \(storage account key, digest [0-9a-f]{16}\)/)
  assert.ok(!r.stdout.includes('Zq9Zq9'), 'the value is never printed')
  const sent = readFileSync(join(dir, 'docs/reviews/inbox/RV-001-custom.md'), 'utf8')
  assert.match(sent, /CANARY: you should have been given only this rubric and the packet/)
  const meta = JSON.parse(readFileSync(join(dir, 'docs/reviews/inbox/RV-001-custom.meta.json'), 'utf8'))
  assert.equal(meta.export, false)
  assert.match(meta.export_off, /settings\.ps1:1/)
})

test('files the owner declares fake (exportFakes) are exported anyway; "export": false keeps the packet-only way', () => {
  const dir = exportRepo()
  writeFileSync(join(dir, 'fixtures.js'), 'export const conn = "' + FAKE.conn + '"\n')
  mkdirSync(join(dir, '.claude'), { recursive: true })
  writeFileSync(join(dir, '.claude', 'review.json'), JSON.stringify({ exportFakes: ['fixtures.js'] }))
  git(dir, 'add', 'fixtures.js', '.claude')
  git(dir, 'commit', '-q', '-m', 'fixtures')
  node(dir, 'packet.mjs', '--goal', 'g', '--base', 'HEAD')
  const r = relay(dir, '--cmd', EXPORT_REVIEWER)
  assert.equal(r.status, 0, r.stderr)
  assert.ok(JSON.parse(readFileSync(join(dir, 'docs/reviews/inbox/RV-001-custom.meta.json'), 'utf8')).export.files > 0)

  writeFileSync(join(dir, '.claude', 'review.json'), JSON.stringify({ export: false }))
  git(dir, 'commit', '-qam', 'export off')
  node(dir, 'packet.mjs', '--goal', 'g', '--base', 'HEAD~1')
  const off = node(dir, 'relay.mjs', '--packet', 'docs/reviews/packets/RV-002.md', '--cmd', 'cat; true')
  assert.equal(off.status, 0, off.stderr)
  assert.match(off.stdout, /packet only this round: \.claude\/review\.json "export": false/)
})

test('a broken .claude/review.json refuses the relay rather than reading as no settings', () => {
  const dir = exportRepo()
  node(dir, 'packet.mjs', '--goal', 'g', '--base', 'HEAD')
  mkdirSync(join(dir, '.claude'), { recursive: true })
  writeFileSync(join(dir, '.claude', 'review.json'), '{ "export": false,')
  // The broken file is itself a change, so build the packet again with it in place
  node(dir, 'packet.mjs', '--goal', 'g', '--base', 'HEAD')
  const r = node(dir, 'relay.mjs', '--packet', 'docs/reviews/packets/RV-002.md', '--cmd', 'cat')
  assert.equal(r.status, 1)
  assert.match(r.stderr, /review\.json is not valid JSON/)
})

test('a secret-shaped value in the packet itself refuses the relay, unless --allow-secrets says why', () => {
  const dir = exportRepo()
  writeFileSync(join(dir, 'config.json'), '{ ' + FAKE.setting + ' }\n')
  node(dir, 'packet.mjs', '--goal', 'g', '--base', 'HEAD')
  const refused = relay(dir, '--cmd', 'cat')
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /secret-shaped value\(s\) in what would be sent: the packet:\d+ \(secret-named setting\)/)
  assert.ok(!refused.stderr.includes('k7Qk7Q'), 'the value is never printed')
  assert.ok(!existsSync(join(dir, 'docs/reviews/inbox/RV-001-custom.md')), 'nothing was sent')
  const sent = relay(dir, '--allow-secrets', 'a fake key in a fixture, checked', '--cmd', 'cat; true')
  assert.equal(sent.status, 0, sent.stderr)
  const meta = JSON.parse(readFileSync(join(dir, 'docs/reviews/inbox/RV-001-custom.meta.json'), 'utf8'))
  assert.equal(meta.secrets_allowed.why, 'a fake key in a fixture, checked')
})

test("a value from the project's own .env in a tracked file withholds the export; a public build variable doesn't", () => {
  const dir = exportRepo()
  const real = 'q8' + 'Lm3vT9xR2kWp'
  writeFileSync(join(dir, '.env'), 'NEXT_PUBLIC_API=https://api.example.com/v2\nSERVICE_SECRET=' + real + '\n')
  writeFileSync(join(dir, 'docs.md'), 'The API lives at https://api.example.com/v2\n')
  node(dir, 'packet.mjs', '--goal', 'g', '--base', 'HEAD')
  const clean = relay(dir, '--cmd', EXPORT_REVIEWER)
  assert.equal(clean.status, 0, clean.stderr)
  assert.doesNotMatch(clean.stdout, /packet only/)

  writeFileSync(join(dir, 'client.js'), 'const s = "' + real + '"\n')
  node(dir, 'packet.mjs', '--goal', 'g', '--base', 'HEAD')
  const leak = node(dir, 'relay.mjs', '--packet', 'docs/reviews/packets/RV-002.md', '--cmd', 'cat')
  assert.equal(leak.status, 1, 'the value is in the packet too, so the relay refuses outright')
  assert.match(leak.stderr, /a value from the project \.env/)
  assert.ok(!leak.stderr.includes(real))
})

test('the scanner leaves placeholders and ordinary code alone', async () => {
  const { secretsIn } = await import('../skills/outside-review/scripts/export.mjs')
  const quiet = [
    'const password = await hash(pw, 10)',
    'Server=db;Database=app;Password=${DB_PASSWORD};',
    '"apiKey": "your-api-key-goes-here-123"',
    'postgres://postgres:postgres@localhost:5432/app',
    'const url = `${proto}://${user}:${pass}@${host}`',
    'sha: 3f786850e387550fdab836ed7e6dc881de23001b',
  ]
  for (const line of quiet) assert.deepEqual(secretsIn(line), [], line)
  assert.equal(secretsIn(FAKE.conn)[0].kind, 'connection string password')
  assert.equal(secretsIn(FAKE.storage)[0].kind, 'storage account key')
  assert.equal(secretsIn('-----BEGIN ' + 'RSA PRIVATE KEY-----')[0].kind, 'private key')
})

test("the packet puts the builder's targets and decisions after the evidence, as hypotheses", () => {
  const dir = repo()
  writeFileSync(join(dir, 'app.js'), 'export const add = (a, b) => a - b\n')
  node(dir, 'packet.mjs', '--goal', 'g', '--base', 'HEAD', '--targets', 'wrong sums', '--decisions', 'kept it small')
  const packet = readFileSync(join(dir, 'docs/reviews/packets/RV-001.md'), 'utf8')
  const diffAt = packet.indexOf('## Diff since base')
  const hypAt = packet.indexOf("## The builder's hypotheses")
  assert.ok(diffAt > 0 && hypAt > diffAt, 'hypotheses come after the diff')
  assert.ok(packet.indexOf('wrong sums') > hypAt && packet.indexOf('kept it small') > hypAt)
})

// ── RV-020 (Codex on the export itself): each finding pinned ──

test('RV-020 F1: a letters-only secret is still a secret; only an explicit placeholder is let off', async () => {
  const { secretsIn } = await import('../skills/outside-review/scripts/export.mjs')
  const pw = 'pass' + 'word'
  assert.equal(secretsIn(pw + ': "Correct' + 'HorseBatteryStaple"').length, 1)
  assert.equal(secretsIn('Server=db;Database=app;Pass' + 'word=OnlyLettersPassword')[0].kind, 'connection string password')
  // ...and the two jobsnearme lines the stricter rule first caught: an autocomplete token, and a value named as a test
  const quietList = [
    'Server=db;Database=app;Password=DB_PASSWORD;',
    '"password": "your-password-goes-here"',
    'Server=db;Database=app;Password=${PW};',
    'autoComplete={creating ? "new-password" : "current-password"}',
    'access_token: "test-access-token",',
  ]
  assert.equal(secretsIn('config.pass' + 'word = "Zebra' + 'QuietLanternRiver"').length, 1)
  for (const quiet of quietList) {
    assert.deepEqual(secretsIn(quiet), [], quiet)
  }
})

test('RV-020 F2: a file too large to scan whole, or a binary, is left out of the export and named, never sent unscanned', () => {
  const dir = exportRepo()
  const key = '"api' + 'Key": "' + 'k7Q'.repeat(8) + '"'
  writeFileSync(join(dir, 'big.txt'), 'x'.repeat(1024 * 1024 + 1) + '\n' + key + '\n')
  writeFileSync(join(dir, 'data.db'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(key)]))
  git(dir, 'add', 'big.txt', 'data.db')
  git(dir, 'commit', '-q', '-m', 'a big file and a binary')
  node(dir, 'packet.mjs', '--goal', 'g', '--base', 'HEAD')
  const r = relay(dir, '--cmd', EXPORT_REVIEWER)
  assert.equal(r.status, 0, r.stderr)
  const listing = readFileSync(join(dir, 'docs/reviews/inbox/RV-001-custom.md'), 'utf8').split('\n')
  assert.ok(!listing.includes('big.txt') && !listing.includes('data.db'), 'neither is exported')
  const meta = JSON.parse(readFileSync(join(dir, 'docs/reviews/inbox/RV-001-custom.meta.json'), 'utf8'))
  assert.deepEqual(meta.export.left_out.sort(), ['big.txt (too large)', 'data.db (binary)'])
})

test('RV-020 F5: relaying the same round again never writes over the saved answer', () => {
  const dir = exportRepo()
  node(dir, 'packet.mjs', '--goal', 'g', '--base', 'HEAD')
  assert.equal(relay(dir, '--packet-only', '--cmd', 'printf first').status, 0)
  const again = relay(dir, '--packet-only', '--cmd', 'printf second')
  assert.equal(again.status, 0, again.stderr)
  assert.equal(readFileSync(join(dir, 'docs/reviews/inbox/RV-001-custom.md'), 'utf8'), 'first')
  assert.equal(readFileSync(join(dir, 'docs/reviews/inbox/RV-001-custom-2.md'), 'utf8'), 'second')
  assert.ok(existsSync(join(dir, 'docs/reviews/inbox/RV-001-custom-2.meta.json')))
})

test('RV-021 F1: unquoted and prefixed secret-named settings are caught; a test word only excuses a value made of nothing else', async () => {
  const { secretsIn } = await import('../skills/outside-review/scripts/export.mjs')
  const v = 'Abc' + 'DefGhiJklMnoPqrStuVwx'
  const caught = [
    'API_' + 'KEY=' + v,
    'api_' + 'key: ' + v,
    'pass' + 'word: "prod-test-' + 'UltraSecretValue"',
    '"GOOGLE_MAPS_API_' + 'KEY": "' + v + '"',
    'googleMapsApi' + 'Key: "' + v + '"',
    'DB_PASS' + 'WORD=CorrectHorseBatteryStaple',
  ]
  for (const line of caught) assert.equal(secretsIn(line).length > 0, true, line)
  const quiet = [
    'apiKey: config.mapsKey,',
    'API_KEY=process.env.API_KEY',
    'API_KEY=os.environ.get("X")',
    '<li key="landing.hero.title.long">',
    'password: string;',
    'password: Enter your password here',
    'SECRET_KEY=${SECRET_KEY}',
  ]
  for (const line of quiet) assert.deepEqual(secretsIn(line), [], line)
})

test('a file edited while the gates run makes the packet stale: its fingerprint is the snapshot its diff came from', () => {
  const dir = repo()
  writeFileSync(join(dir, 'app.js'), 'export const add = (a, b) => a - b\n')
  // The gate itself edits the code after the diff was read
  const built = node(dir, 'packet.mjs', '--goal', 'g', '--base', 'HEAD', '--gate', "printf '// edited mid-gate\\n' >> app.js")
  assert.equal(built.status, 0, built.stderr)
  // The gate's own command text is listed in the packet; what matters is that the diff doesn't carry the edit
  assert.doesNotMatch(readFileSync(join(dir, 'docs/reviews/packets/RV-001.md'), 'utf8'), /^\+\/\/ edited mid-gate/m)
  const r = node(dir, 'relay.mjs', '--packet', 'docs/reviews/packets/RV-001.md', '--packet-only', '--cmd', 'cat')
  assert.equal(r.status, 2, 'the packet no longer describes the code')
  assert.match(r.stderr, /stale packet/)
})

test('RV-022 F1: suffixed names, quoted passwords with spaces, and a real value after a placeholder on one line are caught, through the relay too', async () => {
  const { secretsIn } = await import('../skills/outside-review/scripts/export.mjs')
  const v = 'Abc' + 'DefGhiJklMnoPqrStuVwx'
  assert.equal(secretsIn('AWS_SECRET_ACCESS_' + 'KEY=' + v).length > 0, true)
  assert.equal(secretsIn(JSON.stringify({ apiKey: 'your-api-key-goes-here-123', clientSecret: 'RealCredential' + 'ValueAbcDef123' })).length > 0, true)
  assert.equal(secretsIn('Server=db;Database=app;User Id=app;Pass' + 'word="Correct Horse Battery Staple";').length > 0, true)

  const dir = exportRepo()
  writeFileSync(join(dir, 'deploy.env.sh'), 'AWS_SECRET_ACCESS_' + 'KEY=' + v + '\n')
  node(dir, 'packet.mjs', '--goal', 'g', '--base', 'HEAD')
  const refused = relay(dir, '--cmd', 'cat')
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /secret-named setting/)
  assert.ok(!refused.stderr.includes(v))
})

test('RV-022: a file whose purpose is secrets is never exported, whatever the patterns make of it', () => {
  const dir = exportRepo()
  mkdirSync(join(dir, 'config'), { recursive: true })
  writeFileSync(join(dir, 'config', 'appsettings.Production.json'), '{ "Feature": "on" }\n')
  writeFileSync(join(dir, '.npmrc'), 'registry=https://registry.npmjs.org/\n')
  git(dir, 'add', 'config', '.npmrc')
  git(dir, 'commit', '-q', '-m', 'config')
  node(dir, 'packet.mjs', '--goal', 'g', '--base', 'HEAD')
  const r = relay(dir, '--cmd', EXPORT_REVIEWER + '; ls -a config 2>/dev/null; true')
  assert.equal(r.status, 0, r.stderr)
  const reply = readFileSync(join(dir, 'docs/reviews/inbox/RV-001-custom.md'), 'utf8')
  assert.doesNotMatch(reply, /appsettings|\.npmrc/)
  const meta = JSON.parse(readFileSync(join(dir, 'docs/reviews/inbox/RV-001-custom.meta.json'), 'utf8'))
  assert.deepEqual(meta.export.left_out.sort(), ['.npmrc (secret-bearing file)', 'config/appsettings.Production.json (secret-bearing file)'])
})

test('a name that describes a secret, a type annotation or a regex is not a secret (the false positives RV-022 fixes first raised)', async () => {
  const { secretsIn } = await import('../skills/outside-review/scripts/export.mjs')
  for (const quiet of [
    '  tokens: ReadonlySet<AvailabilityToken>',
    'export const CLAIM_TOKEN_HEADER = "x-employer-claim-token";',
    "const SECRET_NAME = '(?:api[_-]?key|apikey|secret|token)[A-Za-z0-9_]*'",
  ]) assert.deepEqual(secretsIn(quiet), [], quiet)
  assert.equal(secretsIn('JWT_SEC' + 'RET="' + 'Abc' + 'DefGhiJklMnoPqrStuVwx"').length, 1, 'a real name still counts')
})

test('RV-023 F1: an all-caps credential is not a variable name, and a quoted password with spaces counts unless it reads as a sentence', async () => {
  const { secretsIn } = await import('../skills/outside-review/scripts/export.mjs')
  const pw = 'PASS' + 'WORD'
  assert.equal(secretsIn('API_' + 'KEY="ABCDEFGHIJKLMNOP' + '1234567890"').length, 1)
  assert.equal(secretsIn(pw + '="Correct Horse ' + 'Battery Staple"').length, 1)
  assert.deepEqual(secretsIn(pw.toLowerCase() + ': "Enter your password here"'), [])
  assert.deepEqual(secretsIn(pw.toLowerCase() + ': "Your password must be at least 8 characters."'), [])
  assert.deepEqual(secretsIn('API_' + 'KEY=DB_API_KEY'), [], 'an ENV_VAR_NAME with its underscores is a reference')
})

test('RV-023 F2: a path in exportFakes excuses only fixture-shaped hits; a key or token needs its exact digest; a .env value never', async () => {
  const { unexcused } = await import('../skills/outside-review/scripts/export.mjs')
  const hits = [
    { path: 'fx.js', line: 1, kind: 'secret-named setting', digest: 'aaaa' },
    { path: 'fx.js', line: 2, kind: 'private key', digest: 'bbbb' },
    { path: 'fx.js', line: 3, kind: 'api token', digest: 'cccc' },
    { path: 'fx.js', line: 4, kind: 'a value from the project .env', digest: 'dddd' },
  ]
  assert.deepEqual(unexcused(hits, ['fx.js']).map((h) => h.line), [2, 3, 4], 'a path alone excuses only the shape')
  assert.deepEqual(unexcused(hits, ['fx.js', { path: 'fx.js', digests: ['cccc', 'dddd'] }]).map((h) => h.line), [2, 4], 'a digest excuses that one; a .env value never')

  // Through the relay: a real-looking key added to a file listed as fake still withholds the export, and the message gives its digest
  const dir = exportRepo()
  mkdirSync(join(dir, '.claude'), { recursive: true })
  writeFileSync(join(dir, '.claude', 'review.json'), JSON.stringify({ exportFakes: ['fixtures.js'] }))
  writeFileSync(join(dir, 'fixtures.js'), 'export const k = "' + '-----BEGIN ' + 'RSA PRIVATE KEY-----' + '"\n')
  git(dir, 'add', '.claude', 'fixtures.js')
  git(dir, 'commit', '-q', '-m', 'a key in a fixture file')
  node(dir, 'packet.mjs', '--goal', 'g', '--base', 'HEAD')
  const r = relay(dir, '--cmd', 'cat; true')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /packet only this round: secret-shaped values in fixtures\.js:1 \(private key, digest [0-9a-f]{16}\)/)
})

test('exportFakes entries for one path merge in any order', async () => {
  const { unexcused } = await import('../skills/outside-review/scripts/export.mjs')
  const hits = [{ path: 'fx.js', line: 1, kind: 'api token', digest: 'cccc' }, { path: 'fx.js', line: 2, kind: 'secret-named setting', digest: 'aaaa' }]
  for (const fakes of [['fx.js', { path: 'fx.js', digests: ['cccc'] }], [{ path: 'fx.js', digests: ['cccc'] }, 'fx.js']]) assert.deepEqual(unexcused(hits, fakes), [], JSON.stringify(fakes))
})
