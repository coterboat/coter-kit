EXPORT c09eb030cb4d72d292993cf2b0022624

### F1 · impact: high · confidence: high · privacy
Location: `skills/outside-review/scripts/export.mjs:49-73`
Failure: A changed or previously committed setting such as `PASSWORD="Correct Horse Battery Staple"` or `API_KEY="ABCDEFGHIJKLMNOP1234567890"` should stop the relay or force packet-only mode. Both produce zero scanner hits, so the credential can be included in the prompt or export.
Evidence: The quoted-setting regex rejects whitespace, while `isPlaceholder` treats every uppercase alphanumeric value as an environment-variable reference. The focused probe returned `[]` for both inputs.
Validation: `node --input-type=module -e 'import {secretsIn} from "./skills/outside-review/scripts/export.mjs"; for (const s of [\`API_KEY="ABCDEFGHIJKLMNOP1234567890"\`,\`PASSWORD="Correct Horse Battery Staple"\`]) console.log(JSON.stringify(s),JSON.stringify(secretsIn(s)))'`
Fix class: Parse quoted secret-setting values including whitespace and escapes, and exempt only syntactically explicit references/placeholders—not arbitrary uppercase credentials.
assert: every literal value assigned to a secret-named setting is detected unless it is an explicit reference or approved placeholder ; repro: run the validation command above ; evidence: `"API_KEY=\"ABCDEFGHIJKLMNOP1234567890\"" []` and `"PASSWORD=\"Correct Horse Battery Staple\"" []`

### F2 · impact: high · confidence: high · privacy
Location: `skills/outside-review/scripts/relay.mjs:69-75`, `.claude/review.json:12`
Failure: If a real private key, token, or exact `.env` value is present in any path listed in `exportFakes`, the export should be withheld. Instead, the path-level exemption discards every hit in that file and exports it. This repository permanently exempts three mutable test files.
Evidence: `withheld = hits.filter((h) => !fakes.has(h.path))` makes no distinction between the expected fixture and a newly introduced real credential. A probe with a private-key hit in an allowlisted path produced one hit and zero withheld hits.
Validation: `node --input-type=module -e 'import {secretsIn} from "./skills/outside-review/scripts/export.mjs"; const path="tests/coter-kit.test.ts"; const hits=secretsIn("-----BEGIN "+"RSA PRIVATE KEY-----").map(h=>({path,...h})); const fakes=new Set([path]); console.log(JSON.stringify({hits,withheld:hits.filter(h=>!fakes.has(h.path))}))'`
Fix class: Scope exemptions to immutable expected fixture values or hashes. Never exempt private-key/token-format hits or exact project `.env` matches merely because their file contains other fakes.
assert: no path-level fake exemption can suppress a newly added real-secret hit ; repro: run the validation command above ; evidence: `{"hits":[{"path":"tests/coter-kit.test.ts","line":1,"kind":"private key"}],"withheld":[]}`

### F3 · impact: high · confidence: high · privacy
Location: `skills/outside-review/walk/guard.mjs:21,105,129-132`; contract at `skills/outside-review/SKILL.md:109`
Failure: A deployed page issuing a GET tracking pixel to Facebook, Mixpanel, or a same-origin Matomo endpoint is expected to have analytics blocked. The guard classifies each as an ordinary read and continues it, disclosing the walk and contaminating production analytics.
Evidence: Analytics detection is a five-domain allowlist inversion. All other GETs fall through to `read`; `createBudget().decide()` then returns `continue`.
Validation: `node --input-type=module -e 'import {classify,createBudget} from "./skills/outside-review/walk/guard.mjs"; for (const u of ["https://www.facebook.com/tr/?id=123&ev=PageView","https://api.mixpanel.com/track/?data=abc","https://example.test/matomo.php?idsite=1&rec=1"]) { const k=classify("GET",u); console.log(u,"=>",k,"=>",createBudget().decide(k,"GET",u)); }'`
Fix class: Add a configurable analytics host/path deny policy with comprehensive built-ins, and test GET pixels—not only analytics POSTs or Google Tag Manager.
assert: every configured or recognized analytics request is aborted regardless of HTTP method ; repro: run the validation command above ; evidence: all three tracking URLs returned `read => continue`

**Limitations**

The export omitted `.git`, ignored files, media, and `docs/reviews`, so I could not independently reconstruct the base diff. The full test suites could not run because the read-only sandbox rejected their `mkdtemp` calls with `EPERM`; focused import-based probes ran successfully. I did not run Chromium, Grok, or a live relay. No files outside this export were read.
