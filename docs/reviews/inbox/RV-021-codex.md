EXPORT c284d293eb56f603d35a7e46cb072c25

### F1 · impact: high · confidence: high · privacy
Location: `skills/outside-review/scripts/export.mjs:36,43-44,81-89`; `skills/outside-review/scripts/relay.mjs:53-75`; `tests/outside-review.test.mjs:420-435`  
Failure: A changed file containing `API_KEY=AbcDefGhiJklMnoPqrStuVwx` or `password: "prod-test-UltraSecretValue"` should stop the packet or withhold the export. Instead, both return no scanner hits and can be sent to the reviewer. The first bypasses detection because secret-named settings require quotes; the second because any `test`, `fake`, or similar segment anywhere in the value is treated as a placeholder.  
Evidence: The pure-module reproduction printed `"API_KEY=AbcDefGhiJklMnoPqrStuVwx" []`, `"api_key: AbcDefGhiJklMnoPqrStuVwx" []`, and `"password: \"prod-test-UltraSecretValue\"" []`. The regression test explicitly requires `access_token: "test-access-token"` to remain undetected, locking in the broad exemption.  
Validation: `node --input-type=module -e 'import {secretsIn} from "./skills/outside-review/scripts/export.mjs"; for (const s of ["API_KEY=AbcDefGhiJklMnoPqrStuVwx","api_key: AbcDefGhiJklMnoPqrStuVwx","password: \"prod-test-UltraSecretValue\""]) console.log(JSON.stringify(s),JSON.stringify(secretsIn(s)))'`  
Fix class: Detect quoted and unquoted secret-named assignments. Only exempt placeholders whose entire value has an explicit placeholder form; intentional test credentials should use `exportFakes`, not a generic word embedded in the credential.  
assert: every non-placeholder value assigned to a secret-named setting blocks the packet or export, regardless of quoting or embedded words ; repro: run the Validation command ; evidence: `"API_KEY=AbcDefGhiJklMnoPqrStuVwx" []`

### F2 · impact: medium · confidence: high · correctness
Location: `skills/outside-review/walk/guard.mjs:84-105,123-153`; `tests/walk.test.mjs:79-93`; `skills/outside-review/SKILL.md:106-112`  
Failure: A site using the Maps JavaScript `DirectionsService` can make unlimited billed direction requests during a walk. The expected result under a billed cap of one is that the first request consumes the budget and later requests are aborted; the actual result is that every request is classified `unclassified-google`, continues, and leaves `billed` at zero. Google identifies Maps JavaScript Directions Service requests as billable Directions SKU events. [Google SKU documentation](https://developers.google.com/maps/billing-and-pricing/sku-details)  
Evidence: Four simulated requests each printed `unclassified-google continue 0`. The test at line 92 explicitly asserts this classification, so the suite treats this budget bypass as correct behavior.  
Validation: `node --input-type=module -e 'import {classify,createBudget} from "./skills/outside-review/walk/guard.mjs"; const u="https://maps.googleapis.com/maps/api/js/DirectionsService.Route?5m"; const b=createBudget({billedCap:1}); for(let i=1;i<=4;i++){const k=classify("GET",u); console.log(i,k,b.decide(k,"GET",u),b.billed())}'`  
Fix class: Classify every supported billable Maps service—including legacy Directions and Distance Matrix—into the budget, and default-deny unknown Google service endpoints until explicitly classified as non-billable infrastructure.  
assert: every billable Google Maps request consumes the billed budget or is blocked ; repro: run the Validation command with `billedCap:1` ; evidence: `1 unclassified-google continue 0` through `4 unclassified-google continue 0`

**Limitations**

Local files read outside the export: none. External documentation consulted: the linked official Google billing documentation. Syntax checks passed, but the full test suites could not run because their fixtures require temporary-directory writes and failed with `EPERM`. The export omitted `.git`, ignored files, media, and the review trail; no deployed browser walk was available.
