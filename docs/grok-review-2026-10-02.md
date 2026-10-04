# Grok review: is coter-kit a real step, or does it muddy the water?

Superseded for what to do next by `docs/grok-review-2026-10-04.md`. The notes below are the record of that morning. Do not carry them out as current tasks.

2026-10-02. Reviewed the plugin on `main` (0.4.0, plus uncommitted 0.4.1) and the live brain at `~/.claude/coter-brain`. The user agrees with this review and is going to use the kit for a while and see. This file is the record. It is not a work order. Do not start cutting mods, adding a freshness system, or "fixing" the pitfalls below unless they ask.

## Verdict

The problem is real, and the core shape is a genuine next step. The bundle as it sits is one step past what can be judged, and the automatic half will muddy the water if it is all left on and then patched with more mechanism.

Stock sessions are isolated on purpose. A context window full of another session's leftovers is worse than an empty one, and two or three sessions are often open at once. That design is right for a single conversation. It is the wrong design for the actual work: one person, two machines, several repos, and a hard stop when a session dies or the desk changes. Resume does not cross machines. A repo `CLAUDE.md` does not know who you are. Compaction keeps the transcript and drops the point of it.

Refining notes that should never have been stored does not fix that. A freshness pass, a reaper, or a second summary of the summary is more of the same writer. The trial is to see which of the existing pieces earn their place on real switches between the PC and the Mac.

## What was actually there

Code: `hooks/brain.js`, `hooks/register.js`, `hooks/util.js`, both skills, `profile.seed.md`, the README, and `tests/coter-kit.test.ts` (39 tests). History runs from 0.2.0 (snapshot, checks, checklist, brain) through 0.3.0 (`/handoff`, `build-a-mod`) to 0.4.0, with 0.4.1 uncommitted.

The tests are real and they cover the nasty cases: a failing typecheck blocks stop, the same failure does not loop, a locked `dotnet` build is skipped, a conflicted pull is aborted, a sync must not commit a deletion. They stub `model.fork`. They prove the parser and the git choreography. They do not prove the agent gets better.

Live brain, this Mac, same morning:

- `profile.md` matches the seed. Mac history has not been folded in.
- One journal file, `journal/bld/2026-10-02-5cf38e73.jsonl`. One entry: handoff `jm49wk7l`, status active, from the PC session, about setting the kit up on the Mac.
- That handoff is already stale. It describes 0.3.0, the old `/plugin` install lines, and a test count that has moved. `main` is ahead of it. It is still active, and `brainContext` tells the next Claude session to act on a waiting handoff before anything else, for up to 7 days.
- This Grok session was not given the handoff. It was found by reading the brain directory. The sync from a second machine, the 8-turn digest, and the stop-hook checks in a real repo were still unverified when the handoff was written.
- Uncommitted 0.4.1 exists because `git add -A` could delete another machine's notes. The patch stages with `--ignore-removal` and puts missing files back. That tax showed up before a second machine had synced.

The repo is private. The brain branch is the same repo.

## What is worth keeping

Three pieces aim at the gap, and the shape of them is right.

- **Profile.** Highest-value file in the repo. Short, approved by the user, same on every machine. `mine-history` asks before it writes. That is the correct way to grow it.
- **Handoff, when a person asks for one.** The right object for "I am about to switch machines." Append-only journals, one file per session, are the right way to sync without two machines editing one file.
- **Snapshot.** Branch, dirty files, last commits, stack. Cheap, and it stops the cold-start ritual.

The review gate on preferences and vocabulary, the TTLs, the redaction, and the context cap show the rot problem was already understood. The checklist band is a nicer view of a list Claude already keeps. Leave it if it is useful to watch. The stop-hook checks are careful (two rounds, same failure does not loop, locked builds are skipped). They optimize for the compiler. The user's bar is the running app.

## Where it gets worse than nothing

**A handoff ages in place.** Useful for about an hour, then it is a stale plan the next session is told to obey. `jm49wk7l` is the demonstration, on night one. The receiving side should be one line in the band ("handoff waiting"), not the first instruction in the prompt. Marking it picked up is what retires it. Nobody has.

**The digest writes the categories that skip review.** Preferences and terms wait in `/brain`. Decisions, facts, and threads go live immediately, and the digest writes those every 8 turns, plus before compaction, from the model's own summary of the conversation. Paraphrases do not dedupe. Nothing links a note back to the turn that justified it. `resolves` only fires when the model remembers to pass it. There are zero live digest notes so far, which is luck, not evidence. After a week of real use the failure mode is arguing with a sentence the model stored because it sounded like a decision.

**The two shared files fight the journal design.** `profile.md` and `HANDOFF.md` are the files that conflict. A conflict aborts the rebase, and that pull never lands. The journal avoids this. Those two files reintroduce it. The 0.4.1 patch is the same layer demanding care.

**Client work will get summarized.** The digest prompt says to leave out client and end-user personal data. A prompt is not a control, and facts skip review. The handoff already on `origin/brain` says to rotate a Facebook app credential from a July ourPlace session. The value is not in the note. ourPlace is HIPAA. A session about that client will be summarized and pushed, the repo is append-only, and the sync refuses to delete. A bad note stays in git history. Private is not a substitute for the review gate.

**Checks can spend the next turn on the build.** On ourPlace the stop hook is a `dotnet build` at the end of a turn that edited a file, then up to two rounds of the model fixing the compiler. `/checks off` exists. Feeling this once on a TypeScript repo is enough to know whether it earns its place. Feeling it first on .NET or Godot is a bad trial.

**`build-a-mod` is how the kit grows without a decision.** The never-list is right: no approving tool calls, no changing settings or permissions, no hiding actions, no sending data somewhere the user did not name. The habit will still outrun the four mods. Every friction becomes a hook.

## Grok and Claude are not one agent

Do not merge them. This plugin cannot see a Grok session. Grok's memory is a different store. If both write "decisions" into one journal, the next session treats whichever sentence is newer as the user's.

Share the profile. It is markdown, and either tool can read it. Share handoffs the same way: one `HANDOFF.md`, written when asked, read when asked. Keep each tool's working notes on its own side.

## How to run the trial

Use it. Do not add a system to keep automatic notes fresh. If a note should not have been written, another pass over it does not help.

While working, the useful discipline is small:

1. Profile stays on. Run `mine-history` on the Mac once, and approve the diff yourself.
2. `/handoff` stays on. Retire `jm49wk7l` when the Mac setup it describes is done or abandoned. It has already drifted.
3. `recall` stays on, so a session can search. Treat digest output as untrusted until you have read a pile of it. If it starts storing decisions you did not make, turn it off. Pending-review for decisions and facts is the fix, later, if the digest earns a second chance.
4. Snapshot stays on.
5. Stop-hook checks stay off (`/checks off`) until you want them on one repo. Turn them on for a TypeScript repo before .NET.

Success looks like this: after a few real switches between the PC and the Mac, you stop re-explaining where you left off, and you are not correcting notes. If you are correcting notes, the digest is the problem and the profile was the part that mattered. Cut what you did not use. Do not add a fifth mod to supervise the first four.
