EXPORT a680c904bb039a0bb72021e0983bb1af

### F1 · impact: high · confidence: high · privacy
Location: `skills/outside-review/scripts/export.mjs:24,40,46-56,77-85`
Failure: A changed configuration containing `password: "CorrectHorseBatteryStaple"` or `Password=OnlyLettersPassword` should be refused as secret-bearing. Instead, every letter-only value is classified as a placeholder, so the packet and export may be sent.
Evidence: Direct execution printed `"password: \"CorrectHorseBatteryStaple\"" => []` and `"Server=db;Database=app;Password=OnlyLettersPassword" => []`. The same `isPlaceholder` filter also excludes exact values collected from `.env`.
Validation: `node --input-type=module -e "import {secretsIn} from './skills/outside-review/scripts/export.mjs'; for (const s of ['password: \"CorrectHorseBatteryStaple\"','Server=db;Database=app;Password=OnlyLettersPassword']) console.log(JSON.stringify(s), '=>', JSON.stringify(secretsIn(s)))"`
Fix class: Do not apply the digit/letter entropy heuristic to values already identified by a secret-bearing setting, connection-string field, or exact `.env` match; restrict placeholder suppression to explicit placeholder patterns.
assert: secret-named, connection-string, and exact `.env` values are blocked regardless of character mix ; repro: run the Validation command ; evidence: `password: "CorrectHorseBatteryStaple" => []`

### F2 · impact: high · confidence: high · privacy
Location: `skills/outside-review/scripts/export.mjs:19-20,92-119,126-135`
Failure: A tracked 1–2 MiB text file containing a recognized secret is eligible for export but skipped by the scanner. Expected packet-only fallback; actual result is an empty hit list followed by copying the entire file.
Evidence: `MAX_FILE` is 2 MiB while `MAX_SCAN` is 1 MiB. The reproduction placed a recognized secret after 1,048,577 bytes; direct detection found it, while `scan` returned `[]`.
Validation: `node --input-type=module -e "import {scan,secretsIn} from './skills/outside-review/scripts/export.mjs'; console.log(secretsIn('apiKey: \"Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8\"')); console.log(scan('/', ['dev/fd/3'], {known:new Set()}));" 3< <(node -e "process.stdout.write('x'.repeat(1048577)+'\napiKey: \"Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8\"\n')")`
Fix class: Never export an unscanned file. Scan every exported byte, or exclude/withhold files above the scan limit and binary files rather than silently continuing.
assert: every file copied into an export has been completely scanned or explicitly withheld ; repro: run the Validation command ; evidence: `scan 1MiB+ stream => []`

### F3 · impact: high · confidence: high · correctness
Location: `skills/outside-review/walk/guard.mjs:99-118,151-169,220-230`
Failure: Two pages or frames can each receive the full remaining map allowance. If each constructs seven maps before the asynchronous cross-page update takes effect, the advertised cap of 12 becomes 14; additional realms can exceed it further.
Evidence: `mapLoad()` increments without checking the cap, while `__walkBudgetLeft` is held separately in each window. A simulation using the production counter printed `two pages, 7 maps each => billed 14 left 0`.
Validation: `node --input-type=module -e "import {createBudget,installMapCounter} from './skills/outside-review/walk/guard.mjs'; const b=createBudget(); const wins=[{__walkBudgetLeft:12},{__walkBudgetLeft:12}]; for(const w of wins){installMapCounter(w,()=>b.mapLoad()); w.google={maps:{Map:class{}}}; for(let i=0;i<7;i++) new w.google.maps.Map()} console.log(b.billed(),b.left())"`
Fix class: Allocate map-load capacity centrally and atomically across every page/frame; no realm may construct a map without reserving one unit from the shared cap.
assert: total map constructions across all pages and frames never exceeds billedCap ; repro: run the Validation command ; evidence: `14 0`

### F4 · impact: medium · confidence: high · security
Location: `skills/outside-review/walk/guard.mjs:74-95,119-149,231-240`; `tests/walk.test.mjs:35-97`
Failure: Non-read methods to Google hosts bypass the default write block. For example, a `DELETE` to `routes.googleapis.com` becomes `billed:routes`, and an unapproved `POST` to an unknown Maps path becomes `unclassified-google`; both are continued while under budget. Expected behavior is aborting every non-read request except explicitly declared read-only POSTs.
Evidence: Direct execution printed `DELETE routes => billed:routes` and `POST unknown Google => unclassified-google`. `decide()` returns `continue` for both classes, and the route handler forwards that decision.
Validation: `node --input-type=module -e "import {classify,createBudget} from './skills/outside-review/walk/guard.mjs'; for(const [m,u] of [['DELETE','https://routes.googleapis.com/v1/projects/p/operations/x'],['POST','https://maps.googleapis.com/new-billed-api']]) { const k=classify(m,u); console.log(m,k,createBudget().decide(k,m,u)); }"`
Fix class: Apply method-based default denial before host classification. Allow only exact Google method/path combinations known to be read-only and budgeted.
assert: every non-GET/HEAD/OPTIONS request is aborted unless an explicit read-only POST rule or exact built-in read-only Google endpoint permits it ; repro: run the Validation command ; evidence: `DELETE routes => billed:routes`; `POST unknown Google => unclassified-google`

### F5 · impact: high · confidence: high · data-loss
Location: `skills/outside-review/scripts/relay.mjs:124-149`; `tests/outside-review.test.mjs:245-255`
Failure: Running the same packet with the same reviewer twice should preserve or refuse the first saved answer. Instead, both the response and metadata are overwritten because `writeFileSync` lacks exclusive creation. The round-numbering test covers creating a new packet, not retrying an existing packet.
Evidence: Both output paths are deterministic from `header.round` and `reviewer`, and both writes use the default truncating mode.
Validation: In a writable fixture with a valid `RV-001` packet, run `node skills/outside-review/scripts/relay.mjs --packet docs/reviews/packets/RV-001.md --cmd 'printf first'` followed by the same command with `printf second`, then inspect `docs/reviews/inbox/RV-001-custom.md`.
Fix class: Save replies and metadata with exclusive creation, refusing an occupied reviewer/round pair or allocating an immutable attempt identifier.
assert: once a review response is saved, no later relay invocation can alter its bytes or metadata ; repro: relay the same valid packet twice with different custom responses ; evidence: lines 125 and 149 use truncating `writeFileSync`

**Limitations**

The export omitted `.git`, ignored files, media, and `docs/reviews`, so those were unavailable. The full suites could not run because their temporary-fixture creation failed with `EPERM` in the read-only environment; pure function reproductions and syntax checks did run. No browser, network, or Grok execution was available. Outside the export, the only test-input path read was `/dev/fd/3`, a process-substitution stream generated by F2’s validation command; no source or repository file outside the export was read.
