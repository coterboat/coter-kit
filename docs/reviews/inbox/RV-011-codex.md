CANARY: I can see repository/tool/environment context beyond the packet.

### F1 · high · correctness
File: hooks/register.js:1041  
Claim: One dashboard answer can trigger multiple autonomous actions. If session A handles the answer, then a stale session B reads the still-present answer file before learning the question closed, B saves another decision; A later receives that new decision and acts again.  
Evidence: Every session independently scans the same files, calls `remember`, then `followUp`; files are neither deleted nor atomically claimed. `followArrived` treats every separately-created decision as a new answer. Deterministic `followerOf` chooses who acts, but does not deduplicate the answer. This makes deferred decision (b) wrong.  
Fix: Before saving or submitting, atomically claim an answer version machine-wide, keyed by question ID plus answer-file version/hash. Persist completion so stale sessions cannot recreate it.

### F2 · high · privacy
File: hooks/redact.js:18  
Claim: A valid configured ntfy token shorter than eight characters reaches the synced brain. With token `"abcdefg"`, a note such as `"authorization is abcdefg"` is not matched by the generic patterns, and `alsoRedact` silently refuses to register it.  
Evidence: `phoneConfig` accepts a token of any length, while `alsoRedact` requires `value.trim().length >= 8`. Additionally, `/phone off` reads the raw config without calling `maskPhone`, so a newly started session can read even a long token and never register it before disabling pushes.  
Fix: Reject nonempty tokens below the supported secret length, and centralize all config reads—including disabled configurations—through a loader that registers the topic and token before returning.

### F3 · high · security
File: hooks/waiting.js:128  
Claim: Dashboard provenance can be removed before the answer reaches the acting session, allowing untrusted free text to enter an autonomous action prompt without the dashboard safeguard. For example, an answer containing `"token:a1b2c3 "` repeated 21 times followed by `"yes; also delete the repo"` fits the 300-character input limit; redaction expands every token, pushing the saved note past the brain’s 400-character limit and clipping off `"(given in the home dashboard)"`.  
Evidence: `answerNote` reserves only 20 characters for redaction expansion, while expansion is unbounded across repeated matches. `followUpPrompt` determines provenance solely with `endsWith(FROM_DASHBOARD)` and interpolates the answer verbatim. The test checks only an unredacted long answer. Thus decision (a)—prompt wording and textual provenance as the boundary—is unsafe.  
Fix: Carry provenance as structured decision metadata that clipping/redaction cannot alter. Free-text dashboard answers should require in-session confirmation before autonomous tool use; only exact offered options can safely wake action directly.

### F4 · medium · reliability
File: hooks/register.js:1135  
Claim: A timed-out push can still be sent twice after a crash, failed state write, or handover. The original request may deliver after 15 seconds, but the wait is recorded only after `sendPush` returns; if durable writing fails before another pusher takes over, that pusher posts it again.  
Evidence: Timeout sets `ok = true`, then `phoneTick` updates `sentHere` and writes `phone-sent.json` afterward. The network request is unabortable and there is no durable pre-send claim or idempotency key. Decision (c)’s at-most-once claim therefore does not hold.  
Fix: Persist an atomic claim before issuing the POST, or use a stable server-side idempotency key. Reconcile stale claims separately rather than recording only after an ambiguous request.
