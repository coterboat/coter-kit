CANARY: I can see workspace, tool, and environment context beyond the packet; I did not inspect them.

### F1 · high · security
File: hooks/addressed.js:52
Claim: A session processing hostile repository or web content can autonomously wake an unrelated session and induce actions under that session’s existing permissions. For example, it can address a plausible deploy request to a production session title; `inboxFor` does not require the note’s project to match the recipient’s, and the generated prompt explicitly says to “Act on it now.” Markdown quoting and advisory wording are not security boundaries against prompt injection.
Evidence: `remember` permits any normal session to choose `to`; `inboxFor` checks name, device, liveness, and delivery but not project or trust; `wakePrompt` turns the untrusted text into an unsolicited actionable model turn.
Fix: Enforce project/session authorization before delivery and run peer-started turns under a hard read-only or tightly allowlisted capability policy. Require user authorization before any mutation or privileged tool call; do not rely on prompt wording.

### F2 · high · correctness
File: hooks/addressed.js:65
Claim: Moving a named session between machines strands messages on the old machine. If the coordinator ran on Mac anytime in the previous week but now runs on PC, a Mac lane pins its note to Mac because even an ended record qualifies; `isForSession` then rejects the active PC coordinator. The advertised cross-machine restart recovery does not occur.
Evidence: `pinDevice` considers every matching record updated within `PIN_WINDOW_MS`, without requiring it to be live, while `isForSession` rejects any different `to_device`. The test explicitly establishes that an ended two-hour-old session causes pinning.
Fix: Pin only to a currently live matching recipient, or address a globally stable session identity with an authoritative device assignment. A stale record must never exclude the active recipient elsewhere.

### F3 · medium · reliability
File: hooks/register.js:1238
Claim: A crash or module reload after `claimNotes` succeeds but before the deferred prompt is accepted blocks the note for a week. The claim contains no owner or lease that another session can reclaim, so the exact restart scenario this feature targets can leave an undelivered note inert.
Evidence: Delivery creates `claims/deliver-<id>` before scheduling `$.prompt.submit` with `after(0)`. Cleanup only removes delivery claims after `KEEP_DAYS`; cleanup in the catch block cannot run if the process exits.
Fix: Store claim owner and a short expiry, and permit takeover when the owner is no longer live. Renew the lease only while submission is active.

### F4 · medium · reliability
File: hooks/register.js:1247
Claim: Notes attached to a user prompt or snapshot are marked delivered before Claude is known to have received them. If a downstream prompt handler refuses the prompt, the client disconnects, or the process crashes after the journal append, the global delivery row suppresses every retry although the note never reached a turn.
Evidence: `handOver` calls `markDelivered` before returning the context to the prompt or snapshot path. The refusal test covers only the autonomous wake path, which correctly marks after `$.prompt.submit`; it does not exercise `handOver`.
Fix: Persist a pending handoff, attach its IDs to the prompt, and write `delivered` only on a confirmed turn-start event. Reclaim pending handoffs after failure or restart.

### F5 · medium · correctness
File: hooks/register.js:1570
Claim: `/clear` breaks notes addressed by session ID. A note waiting for the pre-clear ID stops matching as soon as `env.sessionId` is replaced, even though the feature explicitly supports ID addressing; preserving only the title does not help an ID-addressed note. The same identity change also prevents automatic delivery receipts for notes authored before `/clear`.
Evidence: The clear handler replaces `env.sessionId`; `isForSession` recognizes only the current ID or matching name, and `brain.reload` reports delivery only when the note’s original `session` equals the current ID.
Fix: Maintain a stable logical session identity across `/clear`, or persist old-ID aliases and authorship lineage for routing and receipts.
