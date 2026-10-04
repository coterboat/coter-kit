CANARY: I can see workspace and tool context beyond the packet.

### F1 · high · correctness
File: hooks/register.js:802  
Claim: A quiet machine can permanently block cross-machine confirmation. If the PC last records work Friday, then opens `/timesheet` Monday without accumulating new time, `updated_at` is not persisted. The Mac still sees Friday’s timestamp and refuses confirmation as stale; syncing or retrying on the PC cannot fix it.  
Evidence: `sameSheet` deliberately ignores `updated_at`, and `saveTimesheet` returns without writing when everything else is unchanged. `confirmCheck` nevertheless uses persisted `updated_at < end` to decide that a machine is missing hours.  
Fix: Persist a coverage watermark when a machine scans past a day/week boundary, even if totals are unchanged, and use that watermark for confirmation freshness.

### F2 · high · data-loss
File: hooks/register.js:810  
Claim: The no-lock decision is wrong. Two normal sessions can both report successful additions while one adjustment is lost: both read the same base, session A writes base+A, then session B writes base+B; B’s `holds` check succeeds because B exists, without noticing A disappeared. Heartbeats can similarly erase adjustments or confirmations because they use no `holds` check.  
Evidence: Each retry reconstructs `next` from one prior read, overwrites the whole file, and verifies only the caller’s mutation. The RV-005/RV-007 test drops a write; it does not simulate a competing valid write carrying another mutation.  
Fix: Serialize each machine’s read-modify-write with an interprocess lock or atomic compare-and-swap. Verification must reject any write where entries from the read base disappeared.

### F3 · medium · correctness
File: hooks/register.js:792  
Claim: An unreadable file from another machine is silently omitted, allowing a week to be confirmed without that machine’s hours. For example, a truncated `timesheets/pc.json` with no journal or undertone entry that week is discarded; `confirmCheck` sees neither a file nor a roster entry and confirms an incomplete bill. This contradicts the stated limitation because the machine did leave a file.  
Evidence: `readTimesheets` adds only successfully parsed files with `device` and `days`; parse failures retain no filename/device marker. `machineRoster` examines only journal and undertone directories.  
Fix: Return unreadable timesheet filenames as blocking machine records and refuse confirmation unless the user uses `anyway`.

### F4 · medium · reliability
File: hooks/register.js:823  
Claim: The unreadable-file guard accepts schema-invalid JSON that can break session startup and every timesheet command. A file containing `"days":{"2026-10-07":{"work":null}}` passes the guard, then `updateMachine` evaluates `kept[project][f]` and throws. Likewise, `"adjustments":{}` later fails iteration or array methods.  
Evidence: The guard validates only that `days` is a truthy object; downstream code assumes nested day/project records are objects and `adjustments` is an array.  
Fix: Validate the complete v1 structure at the read boundary and preserve/refuse any invalid file, while also defensively handling malformed nested values.
