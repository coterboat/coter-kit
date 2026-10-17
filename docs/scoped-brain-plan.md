# Scoped brain: plan

## Shipped in 0.15.0 (2026-10-16)

Phase A sat unbuilt from 10-08 until the two-week retro found every interactive session starting without its project's notes, its handoffs or the instructions, and approved preferences ageing out past the cap of 25. Alex called it (RETRO-Q1 and Q2): ship A now, and fold overflowing preferences into the profile.

- A1–A5 shipped under Grok's conditions 1–9 and 11, with one change to condition 5's order. The profile now comes before the global preferences and terms (waiting, own handoff, notes, this project's preferences, **profile**, global preferences, terms, other handoffs, in flight). The reason: RETRO-Q2 made the profile the folded, approved form of the global preferences, so cutting it before the loose list would drop the better copy first. This project's own preferences stay ahead of it, since the fold leaves them as preferences (RV-020 F2). It still yields to the job and to the instructions.
- The two handoffs a session is told about are this project's first, then the newest from elsewhere (RV-020 F3); the cap stays 2.
- A6 is replaced by the fold (`skills/fold-profile`): when a session's preferences pass 25, Claude offers to fold them. Each preference is folded into the profile, filed under its project (the five above among them), or retired, in one change Alex approves.
- The `recall` tool also takes `kind`. With an empty query, a preference or term lists every live one, which is how the fold reads the preferences; other kinds keep the usual 12 (RV-020 F1, F4).
- A preference that says both `scope: 'global'` and a project is refused, and Claude is told why (RV-020 F5).
- `remember` now says when it cuts a note at 400 characters and what to do with the rest.
- Measured on the live brain (10-16): jobsnearme, ascendant, coter-kit and undertone sessions each get the three instruction sections, their notes and the profile's first section ("How to talk with them") within 13,000 characters. The rest of the profile doesn't fit at that budget.

Phase B is unchanged: it still waits for scope-miss evidence.

Written 2026-10-08 in conversation with Alex. Each session should get only what its project needs. Anything a higher level already learned in another project should be found when it applies, not loaded everywhere.

Phase A is a bug fix and runs now, inside the standing order (`docs/grok-review-2026-10-04.md`), at the light tier. Phase B is new core, so it waits for 2026-10-18.

## Why now: what's broken today

Measured 2026-10-08 against the live brain:

1. **The context budget overflows, and the instructions are what get cut.** `brainContext()` (`hooks/brain.js`) adds sections in order and clips at 13,000 characters. The profile alone is 7,213. After it come 18 global preferences, 12 terms, and every handoff in full. The sections lost off the end are "Where work runs" (cut mid-sentence), "How we build" (which carries the standing order itself) and "Using this memory" (the rules for remember, resolves, waiting and recall). Interactive sessions now start without the standing order, without the house standard, and without the instructions for the memory they're writing to.
2. **A preference can't belong to a project.** `GLOBAL_KINDS` forces every preference to project `''`. Five of the 18 are single-project:
   - `8hjd7ag3`: CONCURRENT asset swaps
   - `4rfnmds5`: ascendant's 2D art
   - `4rfzi6in`: the jobsnearme demo-leg visual calls
   - `cshd5d8d`: the jobsnearme coordinator socket
   - `4acqin1i`: the undertone vision

   Every session in every repo pays for all five.
3. **The preference list is capped at 25.** Two weeks at this rate and the oldest approved rules drop silently.
4. **Handoffs go everywhere in full.** A scratch session got two jobsnearme handoffs, roughly 1,500 characters.

## Phase A: scoping (now, light tier, about 100 lines plus tests)

| # | Change | Where |
|---|---|---|
| A1 | A preference can carry a project: `remember` honors `project` (or `scope: 'project'`, meaning this session's project) for kind `preference`. Terms stay global. | `remember()` |
| A2 | A session gets the global preferences plus its own project's preferences. | `brainContext()` |
| A3 | A handoff from this project shows in full. Handoffs from other projects get one line each: `[id] from jobsnearme, 11h ago: <first 100 chars>`. They're still discoverable, and "pick it up" works from anywhere. | `brainContext()`, `handoffBlock` |
| A4 | `recall` matches an exact note id, so a session can read the full text of a collapsed handoff. | `recall()` |
| A5 | Budget order: the required sections (How we build, Using this memory, Where work runs) are reserved first. The optional ones (profile overflow, other projects' handoffs, In flight) share what's left, so overflow cuts the optional sections, never the instructions. | `brainContext()` |
| A6 | Re-file the five preferences above under their projects with the existing `resolves` mechanism (a new note that replaces the old one), confirmed by Alex in conversation. No migration script. | one `remember` call |

**Acceptance (in `tests/coter-kit.test.ts`, each watched failing first):**
- A jobsnearme session sees `4rfzi6in` and not `8hjd7ag3`. A scratch session sees neither.
- With the current profile, 25 preferences and 3 handoffs, the output stays within budget and still contains "How we build" and "Using this memory".
- Another project's handoff is one line, and `recall('<its id>')` returns the full text.
- A project-scoped preference with no `project` falls back to the session's project.

Not in Phase A: the families, principles, embeddings or scoring from Phase B. No new UI either. `/brain` shows the scope in the note's existing project column.

## Phase B: hierarchy (after 2026-10-18; sketch for Grok's next look)

**Shape.** New learnings are recorded as *cause → dilemma → solution*. That's the form that convinced Alex in the first brain review. `remember` and the digest ask for the three parts. Old notes stay as they are.

**Levels.**
1. **Notes**: decisions, facts, threads. They stay in the journal and are pulled when needed.
2. **Rules**: preferences scoped to a project (Phase A).
3. **Families**: rules shared by a group of projects. Today's game-design rules (`44igarro` target ranges, `3pps3go8` asymmetric spikes, `zl594myg` uncapped cuts, `54ppqdjt` approve the base) belong to *games* (ascendant, concurrent, xcombaby, EO7), not to every session. A project names its families in its `.claude/` config.
4. **Principles**: global, few, and each one carries 1–2 concrete examples and the ids of the rules it came from.

**Promotion.** review-brain proposes a principle when at least 3 rules from at least 2 projects share the same *why*. It counts evidence, not eloquence; that's the guard against "the new idea always sounds better". Alex approves principles only. Example: "approve the base model before derived assets" (games) plus "spec before build" (jobsnearme) become *lock the foundation before building on it*.

**Retrieval.** A local embedding model (free, no Claude tokens) indexes each note's cause and dilemma. At session start, and when `recall` is called, the principles and other-project rules whose situation matches this session's work come up even when they share no words. That's the case keyword recall misses. `recall` becomes keyword plus vector.

**Fruit.** Each rule counts the times it was applied and held, and the times Alex corrected or reversed it. Corrections are the clean signal. Project success isn't counted, because it's too noisy to credit to any one rule. Rules that keep getting corrected go back to review. Principles inherit their rules' record.

**Open questions for Alex (after 10-18):** which local embedding model (size versus quality), whether families are declared or inferred, and whether a principle can override a project rule. The default is no: the more specific rule wins, as in law.

## Grok's ruling, 2026-10-08 (binding for Phase A)

Grok's verdict was **approve Phase A with changes**; it's verbatim in `docs/grok-review-2026-10-08-scoped-brain.md`. Claude checked the claims against the code (the handoff cap of 2 in `waitingHandoffs()`, the lean filter in `leanVisible`, the section sizes), and they hold. The defect is worse than measured above. In a jobsnearme session the clip lands inside the session's own 15 notes, so handoffs, "How we build" and "Using this memory" never appear. A5 is the bug fix. A1–A4 and A6 are allowed only under these conditions:

1. Preferences stay global by default. They're scoped only with an explicit `project` or `scope: 'project'`.
2. The digest can't scope.
3. A note that `resolves` another inherits the old note's project unless the new note sets one.
4. The lean brain shows the global preferences plus the owning project's, never another project's.
5. A5 names every section. Required, never clipped: How we build, Using this memory, Where work runs. Optional, dropped from the bottom in this order: this project's waiting items, this project's handoff in full, this project's notes (cap 15), preferences, terms, the profile (clipped on a heading boundary), other projects' handoff lines, In flight.
6. The handoff cap stays 2. "This project" is keyed off `from`, not `project`. A missing `from` gets the one-line form.
7. The one-line handoff names its id and says to `recall` that id before acting on "pick it up". `arrivalsContext()` stays full text.
8. Exact-id recall: the whole query equals `e.id`, it returns one note, it ignores the project filter, and it's never on the lean path.
9. Filter first, then cap at 25.
10. A6 re-files only `8hjd7ag3`, `4rfnmds5` and `4rfzi6in` now. `cshd5d8d` and `4acqin1i` wait for Alex's yes. The game-design preferences stay global, since moving them would mean families, which is Phase B.
11. The acceptance test uses today's shape (the current profile, a 4,800-character project section, 25 preferences, 2 handoffs) and asserts that the full standing-order sentence and the full remember/resolves sentence are present, not just the headings. It must fail on 0.13.0.

The acceptance line above about "3 handoffs" becomes 2. The line about a project-scoped preference with no `project` applies to `scope: 'project'` only.

**Phase B:** Grok calls it the trap. The bar for opening it on 2026-10-18 is evidence: a session that did the wrong thing because a rule from another project never surfaced. Sessions log those as facts tagged `scope-miss` so the count exists when the date comes.
