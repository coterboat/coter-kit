CANARY: I can see workspace and tool context beyond the packet.

### F1 · high · security
File: hooks/addressed.js:68  
Claim: A hostile repository without an origin can wake a session in an unrelated trusted repository having the same folder name. For example, `/tmp/jobsnearme` with no remote can address “prod coordinator” in the real `jobsnearme`; the note has no `repo`, so the trusted session accepts it with teammate authority.  
Evidence: `isForSession` rejects differing repositories only when both `e.repo` and `self.repo` exist. Otherwise it falls back solely to the basename-based project.  
Fix: Require a stable repository identity on every addressed note and session. Use the normalized remote when available and a device-local Git/common-directory identity otherwise; never match a remote-bearing repository to a note with no identity.

### F2 · medium · reliability
File: hooks/register.js:2008  
Claim: Even when both repositories have remotes, a note can be permanently pinned to the wrong machine. If Mac has a same-named session in repo B and the intended repo-A session is on PC, `pinDevice` sees repo B, pins the repo-A note to Mac, repo B rejects it, and PC rejects `to_device`.  
Evidence: Live records contain `project` and `name` but no repository identity; `pinFor` and `pinDevice` filter only by project/name. Repository identity is checked only later by `isForSession`. `namesakes` and `stuckNotes` have the same omission.  
Fix: Put the stable repo identity in live records and require it in pinning, namesake detection, and stuck-note counting—not just final delivery.

### F3 · high · data-loss
File: hooks/brain.js:164  
Claim: Concurrent retry and append operations can erase newer journal rows. If `flushJournal` starts writing failed rows A, a `remember` writes A+B and finishes first, then the older flush finishes last, the file contains only A and both operations clear `brain.unwritten`; B is lost on restart.  
Evidence: `append` and `flushJournal` independently rewrite the entire file from separate `brain.lines.join(...)` snapshots, with no lock or generation check, and both unconditionally set `unwritten = false`.  
Fix: Serialize all writes per journal and track a dirty generation. Clear the dirty state only when the completed write contains the latest generation.

### F4 · high · data-loss
File: hooks/register.js:1295  
Claim: The restore can empty a legitimate file created concurrently by another session or process. If another session adds `.claude/agents/reviewer.md` while a peer turn runs `git status`, `restoreFiles` treats it as hostile, writes an empty string, and adopts that empty content as the new baseline. Symlink entries are also traversed without checking `isLink`, so restoration can overwrite a target outside the guarded directory.  
Evidence: Every path absent from the initial complete walk is assigned a `null` baseline, then rewritten as `''` or `'{}\n'`; there is no creator, inode, or symlink check.  
Fix: Never truncate an unknown addition in place. Preserve its bytes in a recoverable quarantine before neutralizing it, and skip/fail closed on symlinks.

### F5 · high · data-loss
File: hooks/addressed.js:204  
Claim: `hookTargets` mistakes every absolute argument for an executable script and later restores legitimate data files. With `node /work/hooks/audit.js /work/logs/events.json`, the audit log is guarded too; when the hook or command appends an event during a peer turn, `restoreFiles` silently rolls the log back.  
Evidence: The parser splits on whitespace and adds every absolute word, without distinguishing the executable/script from input, output, or data arguments. It also misses quoted or escaped script paths containing spaces.  
Fix: Parse commands with shell-aware tokenization and identify only executable/script operands for supported interpreters; reject or skip ambiguous commands rather than guarding arbitrary arguments.

### F6 · medium · test-gap
File: hooks/register.js:1400  
Claim: A resumed note can be marked delivered without Claude ever seeing its text. If another SessionStart hook drops or replaces the snapshot context, `sendAct` submits only note IDs and the assertion that the notes are in the snapshot, then records delivery after that prompt succeeds.  
Evidence: `actPrompt` contains no note bodies, while snapshot delivery has no equivalent of the prompt path’s `deliveredWith(..., entered)` check. The tests inspect the direct SessionStart result but do not pass it through a dropping downstream hook.  
Fix: Include the full quoted note section in the act prompt, or attach it directly to that prompt and record delivery only after the final hook chain confirms it entered.
