EXPORT 105049680e71e7512e782735a21b51b1

### F1 · impact: high · confidence: high · security
Location: `skills/outside-review/scripts/export.mjs:25-47,93-103`; `skills/outside-review/scripts/relay.mjs:52-57,67-72`

Failure: A tracked or changed file containing common credential forms is sent to the external reviewer instead of being refused. Demonstrated misses include `AWS_SECRET_ACCESS_KEY`, a quoted connection-string password containing spaces, and a real credential following a placeholder on the same JSON line.

Evidence: `SECRET_NAME` does not recognize `SECRET_ACCESS_KEY`; quoted captures exclude whitespace; and `line.match()` checks only the first matching assignment. The focused reproduction returned `[]` for all three inputs.

Validation:
```sh
node --input-type=module -e 'import { secretsIn } from "./skills/outside-review/scripts/export.mjs"; const cases=["AWS_SECRET_ACCESS_KEY="+"AbcDefGhiJklMnoPqrStuVwx",JSON.stringify({apiKey:"your-api-key-goes-here-123",clientSecret:"RealCredentialValueAbcDef123"}),"Server=db;Database=app;User Id=app;Password=\"Correct Horse Battery Staple\";"]; for(const value of cases) console.log(JSON.stringify(value),"=>",JSON.stringify(secretsIn(value)))'
```

Fix class: Recognize compound secret names such as `*_SECRET_ACCESS_KEY`, parse quoted credential values including whitespace, and iterate over every assignment on a line so one placeholder exempts only its own match. Pin each case through the relay, not only `secretsIn`.

assert: every non-placeholder value assigned to a recognized secret-bearing setting prevents the prompt or export from leaving ; repro: run the Validation command ; evidence: `"AWS_SECRET_ACCESS_KEY=..." => []`, one-line JSON `=> []`, and quoted connection string `=> []`

### F2 · impact: high · confidence: high · correctness
Location: `skills/outside-review/walk/guard.mjs:96-97,114-166`; `tests/walk.test.mjs:152-158`

Failure: Thirteen Places Autocomplete requests without a valid session token should consume the 12-request billed cap and block the thirteenth. Instead, every Autocomplete URL is classified as `places-session`; thirteen requests continue, `billed` remains zero, and no guard failure is recorded. Autocomplete without a valid session token is billed per request under Google’s current contract. [Google Maps Platform SKU details](https://developers.google.com/maps/billing-and-pricing/sku-details)

Evidence:
```text
autocomplete kind = places-session
13 decisions = continue,continue,continue,continue,continue,continue,continue,continue,continue,continue,continue,continue,continue
billed = 0 placesSession = 13 guardFailures = 0
```
The existing test explicitly asserts this incorrect zero-billed behavior.

Validation:
```sh
node --input-type=module -e 'import { classify, createBudget } from "./skills/outside-review/walk/guard.mjs"; const u="https://places.googleapis.com/$rpc/google.maps.places.v1.Places/AutocompletePlaces"; const b=createBudget(); console.log("kind =",classify("POST",u)); console.log(Array.from({length:13},()=>b.decide(classify("POST",u),"POST",u)).join(",")); console.log("billed =",b.billed(),"failures =",b.state.guardFailures.length)'
```

Fix class: Conservatively count Autocomplete requests against the billed cap unless the guard can validate and track the request’s session token and terminating request. Replace the test that permanently classifies all Autocomplete traffic as free.

assert: no sequence capable of generating more than 12 billed Autocomplete events is allowed by the default guard ; repro: execute 13 Autocomplete POST decisions without a session token ; evidence: `billed = 0` and all 13 decisions are `continue`

### F3 · impact: medium · confidence: high · correctness
Location: `skills/outside-review/walk/guard.mjs:17,91-107,143-171`; `skills/outside-review/SKILL.md:110-112`; `tests/walk.test.mjs:79-105`

Failure: A billed Roads API request is treated as an ordinary read. Even after the billed counter reaches 12, a `GET https://roads.googleapis.com/v1/snapToRoads` request continues without being counted, blocked, or reported. This contradicts the documented invariant that unknown Google endpoints are blocked after the budget is reached. Roads requests generate billed SKUs. [Google Roads API billing](https://developers.google.com/maps/documentation/roads/usage-and-billing)

Evidence:
```text
before = 12 kind = read decision = continue after = 12 failures = 0
```
`GOOGLE_HOSTS` contains only Maps, Routes, and Places hosts; the test named “every Google Maps Platform request” exercises only those hosts.

Validation:
```sh
node --input-type=module -e 'import { classify, createBudget } from "./skills/outside-review/walk/guard.mjs"; const u="https://roads.googleapis.com/v1/snapToRoads?path=1,2|3,4"; const b=createBudget(); for(let i=0;i<12;i++) b.mapLoad(); console.log("before =",b.billed(),"kind =",classify("GET",u),"decision =",b.decide(classify("GET",u),"GET",u),"after =",b.billed(),"failures =",b.state.guardFailures.length)'
```

Fix class: Maintain an exhaustive Google Maps Platform host classification or default-deny relevant `*.googleapis.com` hosts, explicitly classifying approved non-Maps services. Add billed-host coverage including Roads.

assert: once the billed cap is reached, no Google Maps Platform request continues unclassified ; repro: fill the budget and classify a Roads `snapToRoads` GET ; evidence: `kind = read decision = continue`

**Limitations**

No file was read outside the export. The export excludes `.git`, ignored files, media, and the review trail. The full test suites could not create temporary repositories under the read-only sandbox and stopped with `EPERM`; pure tests and the focused in-memory reproductions above did run. I did not run Chromium or a deployed walk.
