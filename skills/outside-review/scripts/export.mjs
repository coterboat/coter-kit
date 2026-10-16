// What the relay hands a reviewer besides the packet: a read-only export of the repository as it
// is now (the code the packet's fingerprint describes), with a random id planted in it, and the
// relay's own check of the reply. Codex asked for it (2026-10-15): "Isolation is useful for
// preventing edits, not for removing relevant evidence." Ported from jobsnearme's FS-650.
//
// Nothing secret leaves with it. Every exported file, and the packet itself, is scanned first; a
// secret-shaped value anywhere means no export (the reviewer gets the packet only) and the relay
// names where it was, never what. ourPlace keeps live keys in a tracked appsettings.json, which is
// what this is for.
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, matchesGlob, sep } from 'node:path'

// The review's own trail is never part of what it reviews, and media is only weight
const TRAIL = 'docs/reviews/'
const MEDIA = /\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|psd|mp4|mov|webm|mkv|avi|mp3|wav|ogg|flac|m4a|pdf|zip|gz|tgz|7z|rar|woff2?|ttf|otf|eot)$/i
// One limit for both: a file too large to scan whole is never exported (RV-020 F2)
const MAX_FILE = 1024 * 1024

// High-confidence shapes only: in code, the brain's redactor (a 32-hex run, "token = <anything
// with a digit>") would flag every commit sha and half the source
const PLACEHOLDER = /^(?:\$\{|\$\(|<|%|\{\{|process\.env|env\(|your|xxx|changeme|change_me|example|dummy|fake|placeholder|redacted|\*{3})/i
// A name may carry a prefix joined by _ or camelCase (DB_PASSWORD, googleMapsApiKey) and a suffix (AWS_SECRET_ACCESS_KEY,
// password_hash), but not a hyphen: "new-password" ends in a word, it isn't one
const SECRET_NAME = '(?:api[_-]?key|apikey|secret|client[_-]?secret|access[_-]?token|auth[_-]?token|refresh[_-]?token|password|passwd|pwd|private[_-]?key|signing[_-]?key|access[_-]?key|connection[_-]?string|token)[A-Za-z0-9_]*'
// A name that describes a secret rather than holds one: CLAIM_TOKEN_HEADER = "x-employer-claim-token", PASSWORD_MIN_LENGTH
const LABEL_NAME = /(?:header|name|field|param|cookie|type|prefix|suffix|url|uri|path|endpoint|length|ttl|expiry|expires|hint|label|id|count|regex|pattern|kind|format|placeholder|policy|rule|scope)s?$/i
// A value that is code, not a credential: a regex or an escape
const CODE_VALUE = /\(\?|\\|\|/
// Every detector is global and every match on a line is judged on its own value, so a placeholder early in a line can't
// excuse a real value after it (RV-022 F1). `value` lists the capture groups that may hold the value
const DETECTORS = [
  { kind: 'private key', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g },
  { kind: 'api token', re: /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  // Only on a line that is a connection string, so `password = hash(pw, 10)` in code is left alone; a quoted value may hold spaces
  {
    kind: 'connection string password',
    re: /\b(?:password|pwd)\s*=\s*(?:"([^"]{4,})"|'([^']{4,})'|([^;"'\s]{4,}))/gi,
    value: [1, 2, 3],
    when: /\b(?:server|data source|host|user id|uid|database|initial catalog|address)\s*=/i,
  },
  { kind: 'storage account key', re: /\b(?:AccountKey|SharedAccessKey)\s*=\s*([A-Za-z0-9+/=]{20,})/g, value: [1] },
  { kind: 'credentials in a URL', re: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@'"]+:([^@\s'"/]{3,})@(?!(?:localhost|127\.0\.0\.1|0\.0\.0\.0)[:/])/gi, value: [1] },
  {
    kind: 'secret-named setting',
    re: new RegExp('(?<![-\\w])["\']?([A-Za-z0-9_]*?' + SECRET_NAME + ')["\']?\\s*[:=]\\s*(?:"([^"\\n]{16,})"|\'([^\'\\n]{16,})\')', 'gi'),
    name: 1,
    value: [2, 3],
  },
  // Unquoted, on a line that is only `name = value` or `name: value` (.env, YAML, INI), so code such as
  // `apiKey: config.key,` is left alone (RV-021 F1: API_KEY=AbcDef… went through)
  {
    kind: 'secret-named setting',
    re: new RegExp('^\\s*(?:export\\s+)?([A-Za-z0-9_.]*?' + SECRET_NAME + ')\\s*[:=]\\s*([^\\s"\'#;,()\\[\\]{}$<>]{16,})\\s*(?:#.*)?$', 'gi'),
    name: 1,
    value: [2],
  },
]

// Files whose purpose is secrets never go into an export, whatever a pattern makes of them: the scanner is a net, not a
// proof (RV-022). Changed ones still reach the packet, and the packet is scanned
const SECRET_FILE = /(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.htpasswd|credentials(?:\.[a-z]+)?|secrets?\.[a-z.]+|[^/]*\.secrets?\.[a-z]+|appsettings[^/]*\.json|web\.config|[^/]*\.publishsettings|[^/]*\.(?:pem|key|p12|pfx|jks|keystore|ppk|tfvars|tfstate(?:\.backup)?)|id_(?:rsa|dsa|ecdsa|ed25519)[^/]*|[^/]*service[-_]?account[^/]*\.json)$/i

// Only an explicit placeholder is let off: ${VAR}, <value>, "your-…", one repeated character, or an ENV_VAR_NAME.
// A letters-only value is still a secret (RV-020 F1: CorrectHorseBatteryStaple went through a digit check)
// A value that is nothing but lowercase words opening or closing with a test word (test-access-token, my-fake). A test
// word inside a real-looking value doesn't excuse it (RV-021 F1: prod-test-UltraSecretValue); fake credentials that
// look real belong in exportFakes
const TEST_WORD = /^(?:test|fake|dummy|example|sample|mock|placeholder)(?:[-_][a-z0-9]+)*$|^(?:[a-z0-9]+[-_])+(?:test|fake|dummy|example|sample|mock|placeholder)$/
// An ENV_VAR_NAME needs its underscore segments: ABCDEFGHIJKLMNOP1234567890 is a credential, not a name (RV-023 F1)
const ENV_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/
// A quoted value with spaces is a credential unless it reads as a sentence (UI copy: "Enter your password here")
const PROSE = /^[A-Z]?[a-z0-9']+(?:[\s,]+[a-z0-9']+){2,}[.!?…]*$/
const isPlaceholder = (value) => PLACEHOLDER.test(value) || /^(.)\1+$/.test(value) || ENV_NAME.test(value) || TEST_WORD.test(value) || (/\s/.test(value) && PROSE.test(value))

// Values the machine already treats as secret: whatever the project's own untracked .env files hold,
// less what ships to every browser by design (NEXT_PUBLIC_ and friends) and plain URLs with no
// credentials in them (jobsnearme's public API base sits in its docs, rightly)
const PUBLIC_VAR = /^(?:NEXT_PUBLIC_|VITE_|REACT_APP_|PUBLIC_|EXPO_PUBLIC_|NUXT_PUBLIC_|GATSBY_)/
export function knownSecrets(repo) {
  const values = new Set()
  for (const name of existsSync(repo) ? readdirSync(repo) : []) {
    if (!/^\.env(\..+)?$/.test(name) || /\.(example|sample|template)$/.test(name)) continue
    const full = join(repo, name)
    if (!lstatSync(full).isFile()) continue
    for (const line of readFileSync(full, 'utf8').split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
      if (!m || PUBLIC_VAR.test(m[1])) continue
      const value = m[2].trim().replace(/^(['"])(.*)\1$/, '$2')
      if (value.length >= 10 && !isPlaceholder(value) && !/^https?:\/\/[^@\s]+$/.test(value)) values.add(value)
    }
  }
  return values
}

// The project's .claude/review.json: export (false turns it off), exportExclude (paths or globs
// never exported) and exportFakes (fixture files whose secret-shaped values are fake on purpose; see unexcused)
export function reviewConfig(repo) {
  const file = join(repo, '.claude', 'review.json')
  if (!existsSync(file)) return {}
  // A broken file must not read as "no settings": that would turn an export the owner switched off back on
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    throw new Error('.claude/review.json is not valid JSON (' + err.message + '): fix it before relaying')
  }
}

const digest = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16)
export const ENV_KIND = 'a value from the project .env'
// Kinds a path in exportFakes may excuse: shapes a fixture file is full of. A key, a token format or a .env value is
// excused only by its exact digest, so a real one added to a fixture file still stops the export (RV-023 F2)
const FAKEABLE = new Set(['secret-named setting', 'credentials in a URL', 'connection string password'])

// The hits exportFakes does not excuse. An entry is a path (its fixture-shaped hits are fake) or { path, digests }
// (exactly those hits are fake, whatever their kind); a .env value is never excused
export function unexcused(hits, fakes = []) {
  const byPath = new Map()
  for (const f of [].concat(fakes)) {
    // Entries for one path merge, in any order
    if (typeof f === 'string') {
      const e = byPath.get(f) || { shapes: false, digests: new Set() }
      e.shapes = true
      byPath.set(f, e)
    } else if (f && typeof f.path === 'string') {
      const e = byPath.get(f.path) || { shapes: false, digests: new Set() }
      for (const d of [].concat(f.digests || [])) e.digests.add(String(d))
      byPath.set(f.path, e)
    }
  }
  return hits.filter((h) => {
    const e = byPath.get(h.path)
    if (!e || h.kind === ENV_KIND) return true
    return !(e.digests.has(h.digest) || (e.shapes && FAKEABLE.has(h.kind)))
  })
}

// Where a text holds something secret-shaped: [{ line, kind, digest }]. The digest (sha256 of the matched text, 16 hex)
// lets the owner excuse one known fake exactly (exportFakes); the value itself never leaves this function
export function secretsIn(text, known = new Set()) {
  const hits = []
  const lines = String(text).split('\n')
  lines.forEach((line, i) => {
    for (const d of DETECTORS) {
      if (d.when && !d.when.test(line)) continue
      for (const m of line.matchAll(d.re)) {
        const value = d.value ? d.value.map((g) => m[g]).find((v) => v !== undefined) : null
        if (d.name && (LABEL_NAME.test(m[d.name]) || CODE_VALUE.test(value))) continue
        if (!(value != null && isPlaceholder(value))) {
          hits.push({ line: i + 1, kind: d.kind, digest: digest(m[0]) })
          break
        }
      }
    }
    for (const value of known) if (line.includes(value)) hits.push({ line: i + 1, kind: ENV_KIND, digest: digest(value) })
  })
  return hits
}

// The files the packet's fingerprint covers: tracked and untracked, ignored ones left out, as they
// are on disk now (coter-kit reviews uncommitted work, so HEAD alone would show the old code). Read
// once: the bytes scanned are the bytes copied. Only text that fits the scan goes; a binary or a
// file over the limit is left out and named (RV-020 F2: a database or a spreadsheet is never sent)
export function exportList(repo, { exclude = [] } = {}) {
  const out = execFileSync('git', ['-C', repo, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  const root = realpathSync(repo) + sep
  const files = new Map()
  const left = []
  for (const path of [...new Set(out.split('\0').filter(Boolean))]) {
    if (path.startsWith(TRAIL) || MEDIA.test(path) || exclude.some((g) => path === g || path.startsWith(g.replace(/\/?$/, '/')) || matchesGlob(path, g))) continue
    if (SECRET_FILE.test(path)) {
      left.push(path + ' (secret-bearing file)')
      continue
    }
    const full = join(repo, path)
    if (!existsSync(full)) continue // deleted in the working tree
    // Never a link or a special file, and never anything that resolves outside the repository (RV-001 F7)
    const stat = lstatSync(full)
    if (stat.isSymbolicLink() || !stat.isFile() || !realpathSync(full).startsWith(root)) continue
    if (stat.size > MAX_FILE) {
      left.push(path + ' (too large)')
      continue
    }
    const bytes = readFileSync(full)
    if (bytes.length > MAX_FILE) {
      left.push(path + ' (too large)')
      continue
    }
    if (bytes.subarray(0, 8000).includes(0)) {
      left.push(path + ' (binary)')
      continue
    }
    files.set(path, bytes)
  }
  return { files, left }
}

// Scans what would leave: every byte of every export file (a Map of path to bytes, from exportList), and
// the prompt. [{ path, line, kind }]
export function scan(repo, files, { prompt, known = knownSecrets(repo) } = {}) {
  const hits = []
  for (const [path, bytes] of files) for (const h of secretsIn(bytes.toString('utf8'), known)) hits.push({ path, ...h })
  if (prompt !== undefined) for (const h of secretsIn(prompt, known)) hits.push({ path: '(the prompt: rubric and packet)', ...h })
  return hits
}

// Writes the scanned bytes into a fresh folder outside the repository, with the id file
export function writeExport(repo, files, head) {
  const dir = mkdtempSync(join(tmpdir(), 'review-export-'))
  try {
    if ((realpathSync(dir) + sep).startsWith(realpathSync(repo) + sep)) throw new Error('the export folder ' + dir + ' is inside the repository; set TMPDIR outside it')
    let bytes = 0
    for (const [path, content] of files) {
      const to = join(dir, path)
      mkdirSync(dirname(to), { recursive: true })
      writeFileSync(to, content)
      bytes += content.length
    }
    const id = randomBytes(16).toString('hex')
    writeFileSync(join(dir, '.review-export'), id + '\n' + head + '\n')
    return { dir, id, bytes }
  } catch (err) {
    rmSync(dir, { recursive: true, force: true })
    throw err
  }
}

// The relay's check of the reply text: the EXPORT line first (only the export holds the id), and
// no path of the real checkout. A read that names no path can't be seen from here
export function isolationProblems(reply, { id, roots }) {
  const problems = []
  const first = (String(reply).split('\n').find((l) => l.trim()) || '').trim().replace(/^`+/, '').trim()
  if (!new RegExp('^EXPORT ' + id + '(?![0-9a-f])').test(first)) problems.push('the first line does not begin with the EXPORT line (got: ' + (first.slice(0, 60) || 'nothing') + ')')
  for (const root of roots) if (root && String(reply).includes(root)) problems.push('the reply names the checkout ' + root)
  return problems
}
