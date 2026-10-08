CANARY: I can see filesystem, repository, and tool context beyond the packet.

### F1 · high · data-loss
File: hooks/register.js:1093  
Claim: A newer verdict or another session’s `/brain` choice can land after the final re-read and still be overwritten. For example, this session validates a `take` of `retire`, another session records **Keep**, then `applyVerdict(io, now)` supersedes the note using the stale object. A `pick` can likewise become guarded or frozen after validation and still be applied.  
Evidence: Lines 1093–1100 separate validation from mutation without a shared lock or conditional write. The claim only excludes another inbox consumer, not `/brain` or reviewer mutations.  
Fix: Serialize all mutations of a note under one machine-wide per-note lock, then re-read and conditionally apply against the expected review/status while holding it.

### F2 · medium · correctness
File: hooks/review-inbox.js:46  
Claim: `verdict_at` is not a unique verdict identity. Two verdict rows for the same note can have the same millisecond `at`; a file created for the first then passes validation against the second and applies the wrong verdict. Their claims also collide. Different dashboard decisions for the same note/verdict similarly share a claim, so an already-read old decision can execute while the replacement is permanently skipped.  
Evidence: `reviewAction` compares only `e.review.at` with `d.verdictAt`, while line 56 constructs claims from only note ID and timestamp. The file’s required `at` and its decision are absent from the claim.  
Fix: Give verdicts and inbox calls immutable unique IDs and use both in validation and claim keys; do not use timestamps as identities.

### F3 · medium · reliability
File: hooks/register.js:1084  
Claim: An unreadable or concurrently removed JSON file aborts the entire inbox pass and can prevent `/brain` from opening. If the transient failure occurs during the post-claim `reread`, the claim remains and the request cannot retry until claim pruning.  
Evidence: The file read at line 1084 and claimed re-read at line 1093 are outside the `try`; only failures from the action block at lines 1096–1104 unclaim. `safeJson` cannot catch a rejected `readText`.  
Fix: Isolate every file in a try/catch covering its read through execution, and unclaim on every exception occurring after a successful claim.

### F4 · medium · reliability
File: hooks/register.js:1097  
Claim: Retrying a keep/drop whose status write failed does not merely finish the status write—it records the user decision again. Every repeated status failure appends another user review row, causing unbounded duplicate journal entries and changing the latest review timestamp each retry.  
Evidence: `reviewAction` explicitly returns `keep-pending` or `drop-pending` when `e.review.by === "user"`, but those actions always call `userDecides` again before `setStatus`.  
Fix: When the matching user review already exists, skip `userDecides` and retry only the missing status transition.
