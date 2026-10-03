CANARY: I can see workspace and tool context beyond the packet; I did not inspect or use it.

### F1 · high · data-loss
File: hooks/brain.js:559
Claim: A second session syncing while the shared brain is paused in a rebase can modify that rebase before reporting it as busy. `syncNow` calls `commit` first, whose `git add .` can mark conflicted files resolved and whose commit can alter `HEAD`; only the later pull checks for `rebase-*`. The test claiming the sync “stays out of” an existing rebase checks only pull/push/abort, not add or commit.
Evidence: `syncNow` unconditionally executes `await commit(io)` before `refresh`; the rebase check exists only inside `pull`. `commit` runs both `git add --ignore-removal .` and `git commit`.
Fix: Use an atomic machine-wide lock around the complete commit–pull–push transaction, including initialization. If the lock or a rebase exists, perform no Git mutation. Git’s per-command `index.lock` does not protect this multi-command transaction.

### F2 · high · correctness
File: hooks/brain.js:528
Claim: Open sessions are not told about status-only writes. If another session finishes a thread with `{text:"done", resolves:"t1"}`, rejects an active note, or approves an existing pending note, `reload` sees the same ID and queues nothing. Claude therefore continues using the old thread or never receives the newly approved note.
Evidence: Arrivals are selected solely with `!before.has(e.id)`. `takeUnseen` and `arrivalsContext` can consequently report only newly created IDs, not activation, retirement, rejection, or other changes to existing entries.
Fix: Diff the before/after state of every entry. Queue newly activated notes and explicit retraction/update records for notes that became superseded, rejected, or otherwise changed, then deliver each change once.

### F3 · high · data-loss
File: hooks/review.js:117
Claim: A reviewer can silently retire protected notes through a merge. For example, it can issue a merge for an ordinary pending digest fact with a user-answer decision in `with`; the primary fact remains an unguarded pick, and “Apply the reviewer’s picks” supersedes the user’s decision without presenting that decision as the protected target.
Evidence: Merge members are accepted whenever `brain.entries.has(id)`. Protection and freezing are calculated only from the primary entry, while `applyVerdict` later supersedes every ID in `v.with`. `recordVerdicts` also accepts refs outside `reviewQueue`, including waiting items and handoffs.
Fix: Reject verdicts whose primary ref is not in the current review queue. Validate every merge member for project, kind, queue eligibility, protection, live-decision status, and frozen lineage; if any member is guarded, make the whole operation an explicit user-only challenge.

### F4 · medium · correctness
File: hooks/register.js:627
Claim: A session left open across two midnights disappears from `/glance`, the needs-you band, and cross-session beat accounting. Its heartbeat continues writing into the folder for the day it originally opened, while readers inspect only today and yesterday. Subsequent sessions can then double-count user time because they cannot see its latest beat.
Evidence: `readLive` loops only over `dayOf(now)` and `dayOf(now - 86_400_000)`, while `startLive` fixes `liveFile` to `dayOf(openedAt)`.
Fix: Read all retained day folders and deduplicate by session ID, or rotate the current status record into today’s folder at midnight while preserving historical timing data separately.

### F5 · medium · reliability
File: hooks/review.js:46
Claim: Reviewing a note with exactly one ancestor crashes with `ReferenceError: sameText is not defined`. The existing test uses a two-replacement lineage, which returns early before reaching the broken call.
Evidence: `isUnsettled` calls `sameText`, but `review.js` does not import or define it. A single-ancestor chain reaches `chain.slice(1).some(...)`.
Fix: Import `sameText` from `brain.js` and add tests for one prior replacement, both with and without a return to the earlier text.

### F6 · medium · correctness
File: hooks/review.js:140
Claim: The reviewer’s “literal duplicate” auto-drop is not literal. A live fact `Use /data/config` and pending fact `Use /Data/config` compare equal and the latter can be rejected automatically, although those paths differ on a case-sensitive filesystem.
Evidence: The supposedly literal comparison lowercases both strings before collapsing whitespace, and an equal result immediately sets `row.auto`.
Fix: Require exact text equality for unattended drops, at most normalizing line endings if explicitly intended. Leave case or whitespace variants for user review.

### F7 · medium · overclaim
File: skills/outside-review/scripts/lib.mjs:63
Claim: Packets can omit changed source while still passing freshness checks. An untracked file over 200 KiB is replaced by a size-only marker; changing its contents without changing its size leaves the fingerprint unchanged, so the relay accepts the old packet as current even though it never contained the changed lines.
Evidence: `changes` stores only `(<size> bytes, too large to include)` for oversized files, and `fingerprint` hashes that marker rather than the file bytes.
Fix: Refuse to build a purportedly complete packet when a changed regular file cannot be included, or hash its actual bytes for freshness and mark the packet incomplete so it cannot be relayed as a full review.
