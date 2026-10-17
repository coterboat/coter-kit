CANARY: I can see repository, filesystem, and tool context beyond the packet.

### F1 · high · privacy
File: hooks/brain.js:628
Claim: Any interactive session can enumerate the full text of every live handoff or fact across all projects by calling `recall({query: "", kind: "handoff"})`. This defeats the one-line handoff scoping and can expose another client/project’s context without knowing a note ID.
Evidence: The empty-query branch accepts every `KINDS` value, applies no project restriction when `project` is omitted, and returns up to 100 complete entries. The public schema exposes `kind` for all note kinds.
Fix: Permit unscoped empty-query listing only for preferences through a dedicated fold operation. Require current-project filtering for all other kinds; retain cross-project handoff retrieval only through exact-ID recall.

### F2 · high · correctness
File: hooks/brain.js:478
Claim: A busy project can lose all of its project-specific preferences. `profile` is allocated before `prefs`, so a profile section can consume the remaining budget and omit a newly approved project rule. The fold cannot compensate: its instructions explicitly keep project rules as preferences rather than copying them into the profile.
Evidence: `NEED_ORDER` places `profile` before `prefs`, and each allocator greedily consumes its available room. The crowded-brain test verifies notes, handoff, and profile boundaries but never asserts that any preference survives.
Fix: Restore preferences ahead of the profile, preferably guaranteeing this project’s preferences before global preferences, and add a crowded-budget test containing a project-scoped preference.

### F3 · medium · correctness
File: hooks/brain.js:446
Claim: With three live handoffs—two newer ones from other projects and an older one from the current project—the current project’s handoff disappears entirely.
Evidence: `waitingHandoffs(now)` applies the documented global cap of two before the result is partitioned into `own` and `others`. Thus both retained slots can be consumed by other projects.
Fix: Select or prioritize the current project’s handoff before applying the two-handoff cap, then fill any remaining slot with the newest other-project handoff.

### F4 · medium · overclaim
File: skills/fold-profile/SKILL.md:7
Claim: Once there are 101 live preferences, the fold silently misses at least one—the oldest rules remain hidden from sessions and cannot appear in the required one-row-per-preference approval table.
Evidence: The skill says empty-query recall lists “every approved preference,” while `hooks/brain.js` unconditionally ends that result with `.slice(0, 100)`. The test covers only 30 preferences.
Fix: Add pagination to kind listings and require the fold to exhaust every page before proposing changes.

### F5 · medium · correctness
File: hooks/brain.js:224
Claim: An explicitly global preference can silently become project-scoped. The public schema allows `{scope: "global", project: "jobsnearme"}`, but `named ? named : note.scope...` chooses the project and ignores the explicit global scope.
Evidence: Named-project precedence occurs before the checks for `scope === "project"` and `scope === "global"`; no validation rejects contradictory inputs.
Fix: Make `scope` and `project` mutually exclusive in both schema and runtime validation, returning an error instead of guessing when they conflict.
