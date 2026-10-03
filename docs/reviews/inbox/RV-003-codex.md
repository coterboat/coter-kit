CANARY: I can see tool and workspace context beyond the packet; I did not inspect or use it.

### F1 · high · security
File: hooks/waiting.js:9
Claim: A waiting link such as `https://preview.example/item?access_token=sk-secret` is written verbatim to the append-only, git-synced brain. Review reasons, evidence and steelmen likewise bypass redaction, so credentials encountered by the reviewer can also be persisted.
Evidence: `safeLink` rejects only URL basic-auth fields, while `waitingFields(note)` receives the raw link. `recordVerdicts` in `hooks/review.js` clips raw strings without calling `redact`.
Fix: Apply one mandatory sanitizer to every persisted string field. Strip or redact URL query/fragment credentials and sanitize review metadata before `appendOps`.

### F2 · high · privacy
File: hooks/register.js:1147
Claim: A scheduled task can call `recall` without a project and receive notes from every project, including handoffs. Even supplying its project does not exclude global handoffs, contradicting “only its project’s notes and never a handoff.”
Evidence: The handler passes `e.project` directly to `recall`; it never uses `unattended`. `recall` searches all entries when project is absent and permits every global entry when project is present.
Fix: Enforce a scheduled-run predicate in code: current-project decisions/facts/threads plus specifically approved global working preferences, while always excluding handoffs, waiting items, routes and other projects.

### F3 · high · correctness
File: hooks/brain.js:81
Claim: Distinct non-Latin notes are treated as duplicates. For example, after saving `周二发布`, saving `周五发布` in the same project and kind silently drops the second because both normalize to an empty string.
Evidence: `sameText` removes every character outside ASCII `[a-z0-9+#]`, and `remember` uses its result for deduplication.
Fix: Normalize Unicode and retain Unicode letters and numbers, for example with `\p{L}` and `\p{N}` property escapes; never treat two empty normalized values as equal.

### F4 · high · reliability
File: hooks/brain.js:502
Claim: With two sessions syncing, one session can report a handoff as pushed even though its `git add` and `commit` lost an `index.lock` race. If the lock clears before its pull, the later pull and push succeed, and `lastSync.ok` is based only on the push; the new note was never in that push.
Evidence: `syncNow` checks for a rebase only once, ignores the result returned by `commit`, then performs pull and push. `commit` itself ignores the exit status of `git add`. Git’s per-command lock does not serialize this multi-command transaction.
Fix: The no-machine-lock decision is wrong. Serialize the complete commit–pull–push transaction with a machine-wide lock, recheck rebase state inside it, and stop on every failed git mutation.

### F5 · medium · correctness
File: hooks/review.js:117
Claim: Merge-member validation can crash on a hallucinated ID, and it permits a merge to retire notes outside the review queue. A digest fact the user previously kept can be included in another verdict’s `with` list and silently retired by “Apply picks.”
Evidence: Missing IDs map to `undefined`; `find` returning that value makes `stray !== undefined` false, after which `m.id` throws. Existing members are checked only for project/kind/status, not queue membership or `review.by === "user"`.
Fix: Validate every requested member ID before mapping, require every member to be in the current review queue, and treat any prior user verdict as protected.

### F6 · medium · correctness
File: hooks/register.js:691
Claim: Parallel beats can still double-count billable time. If two sessions receive prompts before either immediate status write finishes, both read the same previous beat and each credits the entire preceding interval.
Evidence: `userBeat` performs `readLive → calculate → publishNow`; the read-modify-write is not atomic, and `publishNow` awaits session usage before writing.
Fix: Put global beat allocation in a machine-wide locked ledger or other atomic compare-and-append operation. Writing each per-session file promptly does not close the race.

### F7 · medium · overclaim
File: skills/outside-review/scripts/lib.mjs:42
Claim: A tracked binary change, such as a modified PNG or database fixture, produces a packet marked `complete: yes` even though the packet contains only Git’s “Binary files differ” summary and none of the changed content.
Evidence: Special handling, byte hashing and `omitted` flags apply only to untracked files. `packet.mjs` derives incompleteness solely from `untracked.filter(f => f.omitted)`.
Fix: Enumerate all changed tracked paths too; include reviewable representations or mark binary/omitted files incomplete and require an explicit, non-empty exception reason.
