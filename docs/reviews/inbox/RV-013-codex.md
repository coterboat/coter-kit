CANARY: I can see workspace and tool context beyond the packet.

### F1 · medium · reliability
File: hooks/register.js:1198  
Claim: A slow request can produce unlimited duplicate pushes, not merely two. If each POST takes over 15 seconds but eventually reaches ntfy, an unchanged `needs_ok` wait is posted again every five minutes indefinitely.  
Evidence: Every timeout unclaims the wait and sets `phoneRetryAt`; there is no per-wait attempt count or terminal retry state. The test stops after observing the second request.  
Fix: Persist an attempt count keyed by `pushKey`, permit at most one retry, and retain a terminal claim after the second attempt.

### F2 · medium · correctness
File: hooks/register.js:1150  
Claim: The machine-wide uniqueness guarantee disappears whenever the claims directory is unwritable, replaced by a file, or hits another mkdir error. Every competing session then treats itself as the winner, so the same answer can start multiple turns and the same wait can send multiple pushes.  
Evidence: After `mkdir` fails, `claim` returns `true` whenever `exists(path)` is false, explicitly allowing all callers to proceed.  
Fix: Return success only when this process atomically created the claim. Treat unexpected errors as unclaimed, log them, and retry later.

### F3 · medium · reliability
File: hooks/register.js:1103  
Claim: Claims are recorded as completed before the operation completes. If `prompt.submit` rejects after an answer is claimed, the catch only logs; the answer was already removed from `answersArrived` and is never queued again. Likewise, a process dying after claiming a phone wait but before `sendPush` reports failure suppresses that unsent push until the week-old claim is pruned.  
Evidence: Answer claims precede the deferred submit at lines 1103–1116 with no unclaim or requeue in the catch; phone claims precede the POST at lines 1195–1203, with cleanup only after a handled false return.  
Fix: Represent claims as recoverable in-progress leases and separate durable completion records. Retry/requeue failed answer submission, and let another session recover an expired in-progress phone claim promptly.
