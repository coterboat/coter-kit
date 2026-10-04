CANARY: I can see workspace and tool context beyond the packet; I did not inspect them.

### F1 · high · data-loss
File: hooks/register.js:805
Claim: Two sessions on one machine can both report a successful adjustment or confirmation while the later write deletes the earlier change. For example, A and B read an empty adjustment list, A writes and verifies line A, then B writes and verifies line B; both commands say “Added,” but only B remains.
Evidence: `saveTimesheet` performs an unlocked read-modify-write and returns immediately after its own read-back succeeds. Verification cannot prevent a write that occurs afterward. Confirmation verification is weaker still: `holds` checks only that some confirmation exists for the week, not that the newly calculated record survived.
Fix: Serialize the entire read-modify-write with a cross-process per-device lock and use atomic replacement. Verify the exact intended record, not merely its presence.

### F2 · high · data-loss
File: hooks/register.js:812
Claim: A malformed, partial, or temporarily unreadable local timesheet is treated as nonexistent and overwritten, deleting all historical days, adjustments, and confirmations.
Evidence: `safeJson(await readText(...))` becomes `null`, after which changes start from `{ adjustments: [], confirmed: {}, days: {} }`; even a heartbeat calls `updateMachine(null, ...)` and writes that replacement.
Fix: Distinguish “file absent” from read/parse/schema failure. Refuse to overwrite an existing invalid file, preserve or quarantine it, and write updates through an atomic temporary-file rename.

### F3 · high · correctness
File: hooks/timesheet.js:164
Claim: A week can be confirmed with a machine’s hours missing. If a PC worked during the week but its timesheet has not synced and it created no dated journal note, it appears in neither `files` nor `roster`; `missing` is empty and the understated bill is recorded as confirmed.
Evidence: `absent` considers only devices returned by `journalRoster`, while that function includes only machines having matching dated journal files. Nothing establishes a complete roster of machines that may have recorded time.
Fix: Maintain a durable device registry with per-week activity and coverage watermarks. Confirmation must require coverage from every device active in that week, independent of optional journal notes.

### F4 · high · data-loss
File: hooks/register.js:809
Claim: Two distinct machines with the same hostname write the same `timesheets/<device>.json` and can erase each other’s adjustments or confirmations. Replacement laptops and cloned/default hostnames are a concrete trigger.
Evidence: The filename and ownership identity are derived solely from `env.device`; there is no persistent unique machine identifier or ownership check.
Fix: Key files by a generated persistent machine UUID, retain the hostname only as display metadata, and reject an existing file whose stored UUID belongs to another machine.

### F5 · medium · correctness
File: hooks/timesheet.js:168
Claim: Confirmation can be blocked forever by machines that could not have hours in the target week. A retired laptop whose file was last updated months before the week is always classified as stale; a journal’s latest date after the target week also makes an absent device look active during every intervening week.
Evidence: `stale` includes every file with `updated_at < end`, without checking activity during the week, and `absent` checks `r.last >= monday` without requiring `r.last < end`.
Fix: Base confirmation on explicit per-week activity/coverage, not a device’s all-time latest timestamp.

### F6 · medium · correctness
File: hooks/timesheet.js:34
Claim: The `__proto__` fix covers only one inherited property name. A valid adjustment for project `constructor` is accepted and then omitted or produces `NaN`; synced day data under `constructor` can throw when code accesses `p.days`.
Evidence: Aggregation uses ordinary `{}` objects and `projects[name] || ...`, so names such as `constructor`, `toString`, and `hasOwnProperty` resolve inherited values.
Fix: Use `Map` or null-prototype dictionaries for every project-keyed collection and validate numeric input fields; do not patch individual property names.

### F7 · medium · test-gap
File: tests/coter-kit.test.ts:1705
Claim: The RV-005 F1 test does not exercise a lost adjustment write or concurrent overwrite.
Evidence: `start($)` now invokes `saveTimesheet` during `startLive`, so `dropFirstWrite` is consumed while creating the initial empty timesheet before the test runs `/timesheet add`. The test also never interleaves a second writer.
Fix: Arm the dropped/interleaved write after startup and simulate two read-modify-write operations, asserting that both independent changes remain after both commands report success.
