CANARY: I can see workspace and tool context beyond the packet.

### F1 · high · security
File: hooks/brain.js:276
Claim: A `brainRemote` containing credentials, such as `https://user:ghp_...@github.com/org/repo.git`, is copied verbatim into `HANDOFF.md` and pushed into git history.
Evidence: `writeHandoffFile` concatenates `brain.remote` into the generated install command without sanitizing or redacting it; `shipHandoff` subsequently syncs that file.
Fix: Derive a credential-free remote containing only protocol, host and repository path, or omit `brainRemote` from the generated command entirely.

### F2 · high · security
File: hooks/waiting.js:20
Claim: Capability URLs leak when their secret parameter has an unrecognized name. For example, `https://preview.example/review?ticket=R4m9pZ7qW2s8N6vK` is stored and git-synced unchanged.
Evidence: `safeLink` uses a parameter-name denylist that misses names such as `ticket`, `jwt`, `nonce`, or `access`; the generic value also matches none of `redact`’s patterns.
Fix: Strip all query parameters by default, or retain only an explicit allowlist of parameters known not to carry authorization.

### F3 · medium · correctness
File: hooks/brain.js:184
Claim: Answering a waiting item does not resolve it when the answer duplicates an existing decision. If “Use layout B” is already recorded and the user answers a later question with the same decision plus `resolves`, `/waiting` continues to show the answered question.
Evidence: Duplicate detection executes `continue` before the status row that supersedes `note.resolves` is appended.
Fix: Process a valid resolution independently of whether the replacement note is new; preserve answer provenance by linking the existing decision or recording a dedicated resolution operation.

### F4 · medium · correctness
File: hooks/brain.js:179
Claim: Answering an item shown by `/waiting all` from another project retires that project’s question but saves the answer under the current project.
Evidence: The new note’s project is selected before loading `replaced`, and an explicit `project` is accepted only for `waiting`, `route`, or reviewer notes. A resolving `decision` therefore uses `env.project`.
Fix: When resolving a waiting item, inherit its project unless an authorized explicit project override is supplied.

### F5 · medium · reliability
File: hooks/register.js:682
Claim: If `$.session.usage()` never settles, session startup or turn completion hangs indefinitely and the live state remains stale.
Evidence: `refreshUsage` directly awaits the call without a timeout; both `startLive` and `turn.complete` await `refreshUsage`. The hanging-usage test checks only that a prompt beat is written and never exercises turn completion.
Fix: Fetch usage asynchronously behind a bounded timeout, retaining `lastUsage` on timeout or failure, and never block lifecycle hooks on it.

### F6 · medium · test-gap
File: skills/outside-review/scripts/lib.mjs:68
Claim: A new untracked binary such as `logo.png` is omitted from the packet while the packet still says `complete: yes`.
Evidence: An untracked file containing NUL is represented as `(binary file)` but is not marked `omitted`; only tracked binaries and oversized untracked files enter the incomplete-file check.
Fix: Mark binary or non-round-trippable untracked files as omitted and require `--allow-incomplete`, just as for tracked binaries.
