CANARY: I can see a workspace path and tool access beyond the packet; I did not use them.

### F1 · high · correctness
File: hooks/brain.js:414
Claim: An unapproved digest note reaches Claude through `recall`. For example, a pending digest fact “production uses Redis” is returned when Claude searches “Redis,” despite never being kept in `/brain`.
Evidence: Digest notes are stored as `pending`, while `recall` searches “everything except rejected notes”; the new tests only prove pending notes are absent from the startup snapshot.
Fix: Restrict normal recall results to live, active notes. Use a separate review-only path for pending notes.

### F2 · high · data-loss
File: hooks/review.js:126
Claim: The reviewer can automatically drop notes that are not exact duplicates. For example, active “The backend is C” and pending “The backend is C++” compare equal and the latter is rejected without user review. Identical project-specific text from two different projects can also be treated as duplicate.
Evidence: `sameText` removes all punctuation, and the auto-drop check compares only kind and normalized text—neither project nor live/TTL scope.
Fix: Auto-drop only when literal text, kind, project/scope, and relevant structured fields match an active, unexpired note.

### F3 · high · correctness
File: hooks/review.js:24
Claim: Ordinary user decisions are not protected. If the user says “Use Postgres,” Claude saves a normal decision, and the global “apply picks” button may rewrite or retire it as though it were model-authored.
Evidence: `isProtected` recognizes only `confirmed` or `answers`; `confirmed` is set only when the user explicitly asks to remember something, and `answers` only when resolving a recorded waiting item.
Fix: Persist reliable user-authorship provenance for every note derived from a direct user answer or decision, and exclude all such notes from bulk application.

### F4 · high · reliability
File: hooks/brain.js:489
Claim: Two normal sessions syncing the shared checkout concurrently can abort each other’s Git operation. If session A is rebasing and session B’s pull fails because that rebase or index lock exists, B unconditionally runs `git rebase --abort`; both sessions can then miss the remote notes they claim to ingest.
Evidence: Every process operates on the same `brain.dir`, there is no cross-process lock, and every failed pull executes `rebase --abort` without establishing that this invocation started the rebase.
Fix: Serialize the complete commit/pull/push transaction with a cross-process lock and retries; abort only a rebase owned by that transaction, and never push after a failed required pull.

### F5 · high · correctness
File: hooks/register.js:711
Claim: Parallel sessions can double-count the user’s time. After a ten-minute gap, prompts submitted in two sessions within the one-second publish window both read the old `last_beat_at` and each credit the same ten minutes.
Evidence: `userBeat` derives credit from asynchronously published status files, while `publish` delays writes by one second and provides no shared lock or atomic machine-wide beat record.
Fix: Allocate beats through one atomically updated, cross-process machine ledger; derive per-session status from that ledger.

### F6 · high · privacy
File: hooks/live.js:75
Claim: The live record exposes absolute paths such as `/Users/alice/Clients/HIPAA/project` to downstream readers that are told the record contains no file paths and may forward it to a phone or remote dashboard.
Evidence: `folder` is populated from `env.sessionRoot`; the privacy guidance only tells exporters to redact checklist wording.
Fix: Remove absolute paths from the shared schema, or place them in a separately documented local-only record that exporters never consume.

### F7 · high · privacy
File: skills/outside-review/scripts/lib.mjs:60
Claim: An untracked symlink can exfiltrate files outside the repository to the external reviewer. A repository containing `debug.txt -> ~/.ssh/config` causes the target contents to be read into the packet.
Evidence: `git ls-files --others` supplies the symlink path, then `statSync` and `readFileSync` follow it without checking file type or repository containment.
Fix: Use `lstatSync`, reject symlinks and special files, and verify every resolved input remains beneath the repository root before reading it.

### F8 · medium · correctness
File: hooks/live.js:47
Claim: Daily user totals are wrong across midnight. A beat at 00:05 credited for the preceding 15 minutes assigns all 15 minutes to the new day, including ten minutes from yesterday.
Evidence: `minutesToday` includes the entire credit whenever the beat timestamp is after midnight; it does not clip the credited interval at midnight.
Fix: Store each beat’s start and end, or clamp its credit to `at - startOfDay(now)` when calculating the day total.
