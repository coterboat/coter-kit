# How we build

Standing order through 2026-10-18: `docs/grok-review-2026-10-04.md` in coter-kit. Do the repo you were opened in. coter-kit and undertone are in use, not under construction. Do not open a milestone, review arc, or cleanup on them unless the user asks in this conversation. Wheat from chaff is what they used. This standard's tiers still apply, including full for privacy, consent, money, auth, and deleting data.

This is the house standard for every project. It is lifted from what jobsnearme's pipeline proved between August and October 2026: 89 outside review rounds, 308 findings, 3 retros and 3 red-team passes. What caught real defects is kept. What only reviewed itself is left behind. Every session sees a short form of this standard, and coter-kit's `outside-review` skill runs the review loop.

## Principles

1. **Different eyes find different holes.** Work is reviewed by a model from another lab that sees the packet and a read-only copy of the code, never the builder's reasoning: Codex for each change, Grok as the red team at milestones, a fresh Claude subagent when neither is available. In jobsnearme, Codex raised 308 findings and 96% were confirmed, among them privacy leaks, a consent chain that didn't hold, and an ingest bug that would have archived every live posting. Grok's product red team found that every demo would have died.
2. **Aim reviews at the product, not the process.** Give the reviewer hostile targets: what a user, an attacker or bad data could break. A review left to wander turns to the review machinery and to wording. jobsnearme ran 67 rounds on a prototype with no users, and in RV-067 five of six findings were about packet arithmetic.
3. **Rules that matter are scripts.** A rule left as prose doesn't fire; every retro said so. If a rule matters, it exits non-zero. If it doesn't, cut it.
4. **Done means a named test passes.** Each acceptance criterion names the test that proves it. A model's read, the builder's or a reviewer's, is never the judge: the judge is something that runs, such as a test, a check over real data, or a walk's `assert` line made into a check. A skipped check reads "not verified", never "pass". Watch every new test and gate fail before you trust it.
5. **Writing and verifying are separate jobs.** The builder doesn't grade its own work. Critics, testers and reviewers are read-only, and "no evidence" counts as a fail. In RETRO-001, a read-only tester found 2 defects after three clean reviews.
6. **Verify every finding, and keep the rejects.** Save the reviewer's response verbatim before anyone reads it. Then check each finding against the code with your own evidence, and log it as confirmed, partial, rejected or duplicate to an append-only file.
7. **Fix the class, not the instance.** Search for the claim, not just the cited line, and pin the fix with a test that stays.
8. **Every loop is bounded.**
   - Critic: 2 rounds.
   - Outside review: it closes on a round with no confirmed high finding, after at most 4 rounds; then the owner decides. Mediums are fixed if they're quick, or deferred with a reason.
   - Tester retries: 3.
   - Compliance, privacy and judgment calls always go to the owner.
9. **Scale the rigor to the stakes.** A prototype doesn't get a client feature's process, and a consent rule gets more than a button does. Size limits, such as a line budget, are guides: one or two standard deviations over is fine, and only a monster gets split.
10. **The owner walks it.** A change a user can see isn't done until it has been seen working in the real app.

## The loop, by stakes

| | Light | Standard | Full |
| :- | :- | :- | :- |
| **For** | Prototypes, internal tools, small changes to the kit | Client features, anything a user sees | Privacy, consent, money, auth, deleting data |
| **Plan** | The goal and acceptance criteria, in the checklist | A spec: acceptance criteria, each naming its test; the files in scope; blocking questions | Standard, plus a threat model and the owner's sign-off |
| **Critic** | None | One read-only pass on the plan before building (2 rounds at most) | The same, by another model |
| **Build** | Tests first where that's cheap | Tests first, watched failing | The same, plus fixtures that stay |
| **Gates** | The project's checks (coter-kit runs them at stop) | Every gate green; a skip says "not verified" | The same |
| **Tester** | None | A read-only pass for each criterion | The same |
| **Outside review** | Only if a trigger fires (below) | When a trigger fires, rounds until no confirmed high, 4 at most | Always, plus a red team at the milestone |
| **Land** | The owner walks it, if a user can see it | The owner walks it; findings logged | The owner walks it and signs off compliance |

## When a change gets an outside review

Not every change does. An outside round costs another lab's quota and an hour of your attention. The gates, Claude's own read of the diff and your walk catch most things. A change goes out only when it can do damage that those three would miss.

**It needs one when any of these is true** (`triage.mjs` checks them and says which fired):

1. **It touches data that lasts.** A database schema or migration, files people keep, a sync, or anything that deletes or overwrites.
2. **It touches who can do what.** Auth, permissions, secrets, privacy and personal data, consent, money.
3. **Others depend on it.** An API, a file format other tools read, a client deliverable, or a release or demo build.
4. **It runs on its own.** Background jobs, schedulers, timers, concurrency.
5. **It's too big to hold in your head.** About 400 changed source lines or 8 source files, tests and docs not counted. That's a guide, not a ceiling.
6. **It fixes a high finding.** The fix gets the next round (3 of coter-kit's first 28 findings were bugs in earlier fixes).

Otherwise, skip it. That covers copy and styling, docs, tests, a refactor whose tests didn't change and still pass, spikes and prototypes, and internal tools that keep no data. Gates, Claude's read and your walk are enough.

**Review once per push, not per edit.** The unit is what you'd push: a branch, a milestone, a client deliverable. One packet per unit.

**It's ready for the packet when you'd push it right now.**
- It does what the goal says, end to end, in the path the app actually uses (seen working, if a user can see it).
- Every acceptance criterion's test passes, and the new ones were watched failing.
- The gates are green.
- The diff is the change and only the change: no work in progress, no debug leftovers, nothing unrelated.
- Claude has read the whole diff itself first. An outside round is wasted on what Claude would have caught.

If you wouldn't push it yet, it isn't ready, whatever the iteration.

**What blocks shipping.** A confirmed high finding (data loss, a privacy or security hole, a wrong result on the main path), or a compliance issue. Nothing else does. A medium gets fixed if it's quick, or deferred in the log with a reason. A low is noted. When a round comes back with no confirmed high, ship.

## The outside review (`/coter-kit:outside-review`)

1. **Packet.** A script builds the packet. It contains the goal or spec, the diff (untracked files included), the gate results, and the decisions to challenge and the hostile targets you name. It refuses an empty diff, and it refuses red gates unless you say why.
2. **Relay.** Another model reviews it in a read-only sandbox, in a copy of the code as it is now with a random id planted in it; the relay checks that the reply quotes the id and names no path of the real checkout. Nothing secret-shaped leaves: a hit in the packet refuses the relay, and a hit in the copy sends the packet alone. The prompt's and the packet's sha256 are recorded, and the response is saved verbatim before anyone reads it.
3. **Verify.** Check every finding against the code with your own evidence, and log each verdict to `docs/reviews/findings.jsonl` in the project.
4. **Fix and repeat.** Fix the class, rebuild the packet, and send another round. Point each new round at the previous round's fixes first: in coter-kit's own first arc, 3 of 28 findings were bugs introduced by earlier fixes. Stop when a round comes back with no confirmed high finding, or after 4 rounds, when the owner decides.
5. **Never merge.** The loop never commits or merges. The owner does, after the walk.
6. **Walk it, for anything a user sees.** A review reads the change; a walk uses the product. A model that didn't build it uses the deployed build as one person doing one task, logged out, on a phone, on real data, without the spec, behind a guard that blocks writes and holds a Maps budget (`walk.mjs`). Each `CHECK` it reports is reproduced failing, then made a check that runs, and the walker never closes its own. jobsnearme's 10-14 user test found three P0s every spec and review had passed.

## Left behind on purpose

- **Reviewing the review machinery.** Packet arithmetic and process-about-process findings get fixed once, not reviewed every round.
- **Wording as a blocker.** Documentation semantics and "semicolon" findings get fixed or deferred, never looped on.
- **Heavyweight bookkeeping on small projects.** Hard line ceilings, ID registries and renumbering rules, and threat-model keys written for one stack.
- **Precision as a goal.** When the builder judges the findings, "96% confirmed" partly measures agreement. Spot-check with the owner or a second reviewer.
- **Long arcs.** Four rounds, then the owner.

## Budget

Claude Max is the main build resource. Outside reviews spend another lab's quota, so aim them where the stakes are. Subagents doing defined tasks with clear success criteria can run on a cheaper model. Routing choices and their cost go in `/routes` (`docs/routing.md`).
