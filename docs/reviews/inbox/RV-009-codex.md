CANARY: I can see repository and tool context beyond the packet, though I reviewed only the supplied diff.

### F1 · high · data-loss
File: hooks/register.js:806
Claim: Concurrent commands on the same machine can both report success while one adjustment or confirmation is lost. If sessions A and B read the same file, both complete the final equality check, A writes and verifies its change, then B writes and verifies its change, B overwrites A. The re-read loop only catches writes before the final comparison; the unlocked comparison-to-write gap remains.
Evidence: `saveTimesheet` compares `readText(path)` with `text`, then performs a separate `$.fs.write`. Its post-write check verifies only the current mutation. The RV-008 test injects a competing write before the comparison, so it cannot exercise this sequence.
Fix: Serialize each machine’s complete read/merge/write transaction with a machine-wide lock, or use a genuine atomic compare-and-swap/versioned write. Re-reading without atomicity cannot close this class. The no-lock decision is unsafe.

### F2 · medium · correctness
File: hooks/timesheet.js:44
Claim: Invalid files can be accepted as healthy and produce an incomplete confirmed invoice. For example, a peer file with `updated_at: "invalid"`, empty `days`, and otherwise object-shaped fields passes `validSheet`; even if that peer has journal entries in the week, `confirmCheck` does not mark it stale because `Date.parse("invalid")` becomes `NaN` and `NaN < end` is false. Confirmation can therefore omit that machine’s hours without requiring `anyway`.
Evidence: `validSheet` does not validate `v`, `updated_at`, date keys, numeric totals, or adjustment/confirmation fields. `confirmCheck` directly uses `ms(f.updated_at) < end`.
Fix: Fully validate the v1 schema before accepting a file, including `v === 1`, a finite timestamp, valid dates, required adjustment fields, finite numeric totals, and confirmation contents. Treat any failure as unreadable so it blocks confirmation.

### F3 · high · data-loss
File: hooks/timesheet.js:44
Claim: A future-version or malformed local file is overwritten despite the promise that non-v1 files are left alone. For example, `{"v":2,"device":"mac","updated_at":"...","days":{},"adjustments":[],"confirmed":{},"invoice_metadata":{...}}` passes `validSheet`; `updateMachine` rewrites it as v1 and drops `invoice_metadata`.
Evidence: `validSheet` never checks `f.v`. `updateMachine` always returns a newly constructed `{ v: 1, device, updated_at, days, adjustments, confirmed }`, discarding every other field.
Fix: Reject unsupported versions before any write. Only migrate explicitly recognized legacy shapes with a lossless, tested migration; otherwise leave the file untouched.
