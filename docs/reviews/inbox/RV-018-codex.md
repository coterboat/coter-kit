CANARY: I can see repository/files/tools context beyond the packet.

### F1 · high · security
File: hooks/register.js:1240
Claim: A peer-started turn can persist malicious hook code despite the advertised config guard. For example, an allowed `sh ./scripts/tidy.sh` can overwrite an already-configured `.claude/hooks/on-prompt.sh`; the command contains no protected token, and the post-command restore watches only individual settings/CLAUDE/MCP files. The hostile hook then runs during later user turns.
Evidence: `PROTECTED_SHELL` only examines command text, while `guardedFiles()` omits hooks, agents, skills, commands, rules, and plugin trees. The test explicitly permits an indirectly mutating `tidy.sh`. Claude’s permission mode does not repair or contain a hook after an already-permitted command overwrites it.
Fix: Snapshot and restore every effective executable/instruction surface, including configured hook targets and relevant directories, after all mutating tools. Canonicalize targets so symlinks and indirect paths cannot bypass protection.

### F2 · high · security
File: hooks/register.js:990
Claim: “Its own project only” is false for unrelated repositories with the same directory name. A note from `/tmp/hostile/work` addressed to `"coordinator"` can wake a `"coordinator"` session in `/clients/acme/work`, because both projects are identified only as `work`.
Evidence: `env.project = basename(repo?.root || env.sessionRoot)`, and `isForSession()` in `hooks/addressed.js` authorizes delivery solely by equality of that project string. The shared brain therefore cannot distinguish same-basename repositories.
Fix: Scope notes with a stable repository identity, such as a configured UUID or normalized remote identity, while retaining the basename only for display. Define an explicit migration path for existing notes.

### F3 · medium · reliability
File: hooks/brain.js:265
Claim: A delivery-record write failure can cause the note to be delivered again after ten minutes. `markDelivered()` marks the in-memory entry delivered before `append()` succeeds; if append fails, no durable row or retry queue exists. After restart or reload, the delivery disappears, and the stale-claim generation logic permits another session to deliver it again.
Evidence: `markDelivered()` updates `brain.entries` and then awaits `append()`. `recordDelivered()` catches the error but only logs it and discards `claimKeys`; nothing writes the missing row “with the journal’s next write.” The test stops after 250 seconds, before the ten-minute stale takeover.
Fix: Persist failed delivery rows in a durable outbox and flush them on polls and subsequent journal writes; prevent claim takeover while such a pending-delivery marker exists. Test across reload and beyond ten minutes.

### F4 · medium · overclaim
File: hooks/register.js:1290
Claim: Delivery is not exactly once across machines. If two machines have live sessions with the same title and receive an unpinned note before either delivery row syncs, each creates its own local claim and starts a turn for the same note.
Evidence: `claimNotes()` uses only `~/.claude/coter-kit/claims` on the current machine. The packet itself concedes that same-named sessions on two other machines can both deliver, contradicting the README and acceptance claim that each note is delivered once “on any machine.”
Fix: Use an atomic cross-machine claim/delivery primitive in the shared backend, or assign each unpinned note a deterministic single owner before waking a session.
