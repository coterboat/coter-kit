CANARY: tool, filesystem, and environment context beyond the packet is visible.

### F1 · high · correctness
File: hooks/register.js:1075  
Claim: A concurrent update can make the worker apply a stale verdict. For example, it reads rewrite verdict `at:100`, another session records verdict `at:200` or the user keeps the note, then the worker claims `review-<id>-100` and applies the old rewrite. The same race can apply a pick after it becomes guarded or frozen.  
Evidence: State is reread only before the loop; action is computed at line 1084, followed by an awaited claim and mutation at lines 1087–1092, with no revalidation. The claim coordinates only inbox workers for that old verdict, not pane actions or new verdicts.  
Fix: Serialize all mutations per note, then reread the journal and file and recompute the action under that lock. The final mutation must atomically verify the expected verdict timestamp, status, and user-decision state.

### F2 · medium · reliability
File: hooks/register.js:1089  
Claim: A failed pending keep/drop is not safely retryable. If `userDecides` succeeds but `setStatus` fails, the claim is removed, yet the next attempt sees `review.by === 'user'` and does nothing, leaving the note permanently pending despite recording the decision.  
Evidence: Both pending actions perform two separately awaited writes, while every exception unclaims at line 1096. `reviewAction` rejects any note whose review is by the user at `hooks/review-inbox.js:37`.  
Fix: Make the decision and status transition atomic, or make the operation resumable so a retry completes the missing status transition after detecting the already-recorded matching decision.

### F3 · medium · correctness
File: hooks/review-inbox.js:23  
Claim: Malformed files outside the documented schema can change notes. A file containing only `{"v":1,"id":"n1","decision":"drop"}` is accepted and rejects an unreviewed pending note, despite lacking required `verdict_at`, `at`, and `from:"home"`.  
Evidence: `outsideReview` validates only version, id, decision, and an optional finite `verdict_at`; the test explicitly asserts that a file missing these fields is valid.  
Fix: Require and validate every mandatory field, including explicit `verdict_at`, `from === "home"`, and a valid ISO timestamp.

### F4 · medium · reliability
File: hooks/review-inbox.js:47  
Claim: Distinct notes and verdicts can produce the same claim and block one another. Accepted inputs `(id:"x-", verdict_at:-1)` and `(id:"x--", verdict_at:1)` both yield `review-x---1`; whichever is processed second is skipped indefinitely while the claim exists.  
Evidence: Any finite number, including negatives, is accepted, and the claim key concatenates unescaped values with `-`.  
Fix: Use an injective encoding or hash of the structured `(id, verdictAt)` tuple, and restrict verdict timestamps to the actual timestamp domain.
