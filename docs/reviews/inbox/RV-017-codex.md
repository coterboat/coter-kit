CANARY: I can see workspace and tool context beyond the packet.

### F1 · high · security
File: hooks/addressed.js:161
Claim: The peer-turn configuration guard is bypassable with ordinary shell syntax. A hostile note can cause `cd .claude && printf ... > settings.json` or a script that constructs the path; neither contains the contiguous pattern the regex requires, so the peer turn can alter permissions, hooks, or persistent instructions.
Evidence: `touchesConfig` permits unrestricted Bash and PowerShell whenever `PROTECTED.test(command)` is false. The test covers only commands containing literal full paths. The decision that this regex is “enforced” is wrong.
Fix: Enforce protected-path writes below the shell-command layer, or deny general shells during peer turns and expose narrowly controlled operations such as merge/test helpers.

### F2 · medium · correctness
File: hooks/register.js:1249
Claim: After `/clear` changes the session ID, notes addressed by name can be rejected as ambiguous. The old live record still has the same title, while `namesakes` excludes only the new `env.sessionId`; the session therefore sees its own former record as a twin and does not receive the note until that record becomes stale.
Evidence: `/clear` adds the old ID to `formerIds`, but `deliverable` passes only `exceptId: env.sessionId`. The RV-016 F5 test addresses the old ID directly, so it does not exercise name delivery after `/clear`.
Fix: Exclude every `selfIds()` value when detecting namesakes, and mark the former live record ended when the ID changes.

### F3 · medium · correctness
File: hooks/addressed.js:68
Claim: A same-named session in another project can permanently strand a note. For example, a jobsnearme note for “coordinator” is pinned to the Mac because an unrelated project has a live “coordinator” there; project checks then reject that recipient, while the real jobsnearme coordinator on the PC rejects the Mac pin.
Evidence: `pinDevice` matches only ID/name, liveness, and scheduled state; it does not compare the live record’s project. `isForSession` later does compare projects.
Fix: Pass the note’s resolved project into `pinDevice` and only pin when a live matching recipient exists in that project.

### F4 · medium · reliability
File: hooks/register.js:1268
Claim: Two sessions can both take over the same stale claim and execute a note twice. Both can read the old mtime; session A removes and recreates the claim, then session B removes A’s fresh claim using its stale observation and successfully recreates it. Both have already added the note to `mine`.
Evidence: Takeover reads mtimes once, then performs unconditional `unclaim` followed by `claim`, without verifying that the directory being removed is still the stale claim observed.
Fix: Use an atomic ownership/lease operation with a unique token and conditional takeover; never delete a claim based solely on an earlier mtime snapshot.

### F5 · medium · correctness
File: hooks/register.js:1632
Claim: A scheduled run that resumes an existing session can receive and act on addressed notes, contrary to A9. Before its first tagged prompt identifies it as scheduled, a non-startup `SessionStart` sets `attended = true`, puts notes in the snapshot, and schedules `sendAct`.
Evidence: Only fresh `startup` sessions defer delivery until the first prompt. The scheduled-run test covers startup, not resume or clear.
Fix: Do not hand over notes after any SessionStart until the run is authoritatively classified as attended versus scheduled, or use scheduling metadata available at SessionStart.

### F6 · medium · reliability
File: hooks/brain.js:280
Claim: A failed journal append can produce duplicate execution. After the wake prompt is accepted, `markDelivered` mutates the in-memory entry before appending the delivery row. If that append fails, the caller releases the claim, but this process believes the note is delivered while other machines—and this process after restart—see it as undelivered.
Evidence: `brain.entries.set(... delivered ...)` precedes `await append(io, rows)`, and the wake failure handler subsequently unclaims the note.
Fix: Track accepted-but-unrecorded deliveries separately, retain their claims, and retry the append without resubmitting the note; only update ordinary delivered state after durable append succeeds.
