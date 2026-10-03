# coter-kit build plan

Started 2026-10-03. The goal: you jump into a session that has run for four hours, or switch machines, and know where things stand at a glance, without reading an essay, re-explaining anything, or correcting notes. Grok's review (`docs/grok-review-2026-10-02.md`) still holds. No fifth mod to supervise the first four, every automatic writer gets a human gate or hard evidence, and anything that isn't used gets cut.

## Milestones

| # | What | Done when | Status |
| :- | :- | :- | :- |
| M1 | **Catch-up.** `/catchup` says what happened since your last message, in six lines. The band offers it when a session worked a long stretch without you. One rule for questions: every question you owe an answer to is a `waiting` note. | Back in a 4-hour session, you know what's done, what's decided and what needs you in under a minute | done in 0.6.1 |
| M2 | **Live status file.** Every session writes a small JSON file of its state (project, worktree, working or idle, checklist step, what needs you, checks, active minutes). `/glance` reads them all: one row per running session on this machine. | undertone, `/glance` and later the phone read one file instead of parsing the brain | next |
| M3 | **review-brain.** A daily outside review of the notes waiting in `/brain` and the ones that went live without review, with a verdict and evidence for each, under the authority split and the anti-churn rules below | A week of runs where you overrule few verdicts, and none of them is "it replaced something that was right" | planned |
| M4 | **Timesheets.** Active minutes per project per day, from turns and tool calls, written to the brain one file per machine, plus `/timesheet` | A client week totals right across the PC and the Mac | planned |
| M5 | **Phone.** Undertone's bridge pushes "needs you" to your phone when a call goes unanswered for a few minutes | You pick the service (ntfy or Pushover), since it sends data out | your call |

undertone's own items (its session owns them, and this repo doesn't touch its files):

- A run started by a scheduled task (its first prompt is `<scheduled-task …>`) plays quietly and never ends in a call. Today `concurrent-bots-loop` plays "your move" every 30 minutes, usually for a run that did nothing, and that teaches you to ignore the call.
- Read M2's status file instead of coter-kit's journal.
- The Gemini critic needs `GEMINI_API_KEY`, which you set.

## M1: catch-up

- `/catchup`: a header built from what the kit already knows (the checklist and its current step, checks, waiting items), then up to six lines from a fork over the session's own transcript, served from the prompt cache: **Done**, **Doing**, **Decided**, **Needs you**, **Next**. It covers the time since your last message and says how long that was. It works while Claude is mid-turn.
- The band shows `catch up: /catchup · 2h 10m without you` when you come back to a session that worked 30 minutes or more since your last message.
- Questions: the remember tool and the session instructions say that any question or decision you owe, with or without a link, is a `waiting` note, never a thread. That fixes the jobsnearme case, where 7 open questions were saved as a thread, so `/waiting` and undertone's drone missed them. `waiting` stays as it is: catch-up and glance show it, they don't replace it.

## M3: review-brain

**How it fires.** A desktop scheduled task, like `concurrent-bots-loop`, at 7:00 every morning in the coter-kit folder, running `/coter-kit:review-brain`. It needs the Mac awake and the app open. You can also run it yourself any time, and the band suggests it once 15 or more notes are waiting in `/brain`. A scheduled run gets the lean brain and no digest (0.6.0), and the skill reads the journal directly.

**What it does for each note.** It checks for duplicates (including paraphrases) and for contradictions with what's already there. It checks the claim against evidence the writer didn't have: the repo's code and git history (read-only), other sessions' logs, and whether a newer note about the same lane replaced it. The verdict is one of accept, reject, rewrite, merge, retire or ask, each with one line of evidence (`file:line`, a commit, a transcript time). Verdicts are saved as `review` lines in its own journal file. `/brain` shows each verdict next to its keep and drop buttons, and one button applies the reviewer's picks.

**Authority.** On its own it does only what it can prove: exact duplicates, threads replaced by a newer one from the same lane, and expired items. Everything else waits for your one press, including anything that challenges something already live. If you don't overrule it in a category for two weeks, it gets that category.

**Anti-churn rules**, so the newest sentence doesn't keep winning:

1. **The incumbent wins ties.** Replacing a live note needs evidence the live note didn't have. Better wording, a newer date or a more confident tone don't count.
2. **Your answers aren't the reviewer's to replace.** Decisions from your answers, notes you confirmed, and your profile can be challenged, with evidence and to you, never replaced.
3. **Steelman first.** For every contradiction, the reviewer writes the strongest case for the existing note before it argues against it.
4. **Flip-flops freeze.** Each note keeps its lineage. A topic replaced twice in seven days, or one that returns to an earlier answer, is frozen. The reviewer stops proposing changes and marks it "unsettled, your call".
5. **It keeps score.** Every overruled verdict is counted by category, and that count is what widens or narrows its authority.

**Cut it if** its verdicts stop citing evidence and start paraphrasing notes.

## Not doing yet

- Guardrails that block commands (a deploy during a demo, patient data in logs). You want to see the system run longer first.
- Sharing the brain with Grok. It can read the profile and `HANDOFF.md`, but its notes stay on its own side.
- Cross-machine sound (the PC's sessions heard on the Mac). Run undertone on both machines first.
