# Standing order for Claude

From Grok, 2026-10-04. This is the order for the next two weeks, through 2026-10-18. It covers coter-kit, undertone, and every other repo a session opens while the kit is installed.

The 2026-10-02 review (`docs/grok-review-2026-10-02.md`) still describes that morning. Do not carry out its action items. The cuts it asked for that already landed (digest notes wait for review, a handoff waits in the band until the user says "pick it up", scheduled runs get the lean brain) stay as they are. This file is what to do now.

The user has read the later review of 0.10.0 and undertone 0.7.0. Their decision, in their words: it got out of control quickly, it was dope, let it ride, separate the wheat from the chaff, and that cut will be fast. Follow that. Do not improve on it.

## What the work is

The work is the repo you were opened in. jobsnearme, ourPlace, wallstbets, Iron Veil, and whatever they open next. coter-kit is the desk those sessions share. undertone is how the room sounds while they run. A session that wanders off its repo to grow the desk has left the job.

For these two weeks the desk is in use, not under construction. 0.4.0 to 0.10.0 and undertone through 0.7.0 already happened. Live status, `/glance`, `/catchup`, `/waiting`, the routing note, the house standard, and undertone's bridge are enough. Use them.

## Orders

1. Do the task the user asked for in this session. Ship that. Stop.
2. Use the kit that is already loaded. Remember a real preference or decision. File a question they owe as `waiting`. Offer `/handoff` when they are switching machines. Read `/glance` before fanning out. Follow `docs/standard.md` at the tier the change deserves.
3. Outside review only when `triage` says a trigger fired, once per thing they would push, aimed at what a user, an attacker, or bad data could break. Verify each finding yourself. Four rounds, then they decide. Only a confirmed high finding or a compliance issue blocks shipping.
4. When they say something was not used, remove it or turn it off that same day. Do not replace it with a cleaner version. Do not write a migration. Do not open a review round to justify the removal.
5. When they say something slapped, or to let it ride, leave it. A rough thing they are still using is wheat.

## The trap

"Separate the wheat from the chaff" is not a milestone. It is not a cleanup branch, a retro, a fifth mod, a freshness pass, or RV-010. If you start one, you have already left the order.

The example is already in this repo. RV-004 was closed on 2026-10-03 with "enough iterating, no true blocker left." The same night the timesheet arc opened, and RV-005 through RV-009 spent the next morning on `__proto__`, retired machines, and a lock the user already deferred (LOCK-1). Several of those findings were real. The tempo was the failure. A new idea is not permission to reopen that tempo the same day.

`build-a-mod` fires when the user hits a wall in the task they asked for and a hook is the smallest fix. It does not fire because the kit could also do something neat. The never-list in that skill still holds.

## Wheat and chaff, the fast way

Judge by what they did this week, not by what the code could become.

| What you notice | Wheat | Chaff |
| :- | :- | :- |
| A session needed them | They heard the call, or saw `/glance` or `/waiting`, and acted | They never looked. Mute the lane or leave the command. Do not retune it |
| Hours | They sent, or are about to send, a week from one clock | Two clocks exist and neither has been sent. Leave both until a real week needs one number |
| A note in the brain | It stopped them re-explaining | They corrected it, or `/brain` is full of things they did not say. Drop those. Do not invent a reaper |
| An engine or a source in undertone | They picked it by ear, or the ourPlace lane made them act | They did not. Delete or leave it dark. Do not add the next source |
| A review round | It caught a hole in the thing a user, an attacker, or bad data could break | It reviewed the packet, the wording, or the previous round's machinery. Stop the arc |

There are two clocks on purpose, and they measure different things. coter-kit's `/timesheet` is the user's time, the one that can be billed. undertone's `npm run week` is Claude's wall clock, the leverage. Do not merge them, rename them, or open an arc to reconcile M4-Q1 until a client week actually has to go out. When that week comes, ask once which number they are sending, then make the other a column. This Mac's `main` is ahead of `origin` by the timesheet commits. Do not assume the PC has `/timesheet`. Do not push unless they ask.

undertone reads waiting-questions from the journal on purpose (a live-status count would go silent for a project touched only on the other machine). The comment in `undertone/hooks/waiting.js` that says to switch is stale. Do not "finish" that switch.

## Other repos

Pick the tier from `docs/standard.md` and then do the repo's work.

- Light: prototypes, spikes, small internal changes, anything on the kit itself while this order stands. Gates and their walk. No outside round unless a trigger fires.
- Standard: a client feature, anything a person besides them will see. Acceptance criteria that name their tests, one read-only critic pass, gates green, their walk in the real app.
- Full: privacy, consent, money, auth, deleting data. The same, plus their sign-off. ourPlace stays on this tier. HIPAA is a hard line. Do not put client or patient data into the brain, a timesheet note, a handoff, an undertone event, or a review packet.

A change they can see is done when they have seen it in the app. A green gate is not that.

Do not import jobsnearme's round count into a button change. Do not import this order's freeze into a privacy or auth change: those still get the full tier.

## Do not

- Open a milestone, an engine, a source, a guardrail, or a review arc on coter-kit or undertone unless they ask in this conversation.
- Refine a piece in order to make it easier to delete later.
- Store a decision they did not make. The digest stays behind `/brain`.
- Write Grok's notes into the brain, or write the brain into Grok's memory. The profile and `HANDOFF.md` are the shared files. Each side keeps its own working notes.
- Treat a scheduled run as a chance to keep building. It gets the lean brain. It does its job and stops.
- Commit, push, or merge unless they ask.

## When this ends

On 2026-10-18 this file becomes history. The next session after that does not obey it as law and does not delete it. If they want the next pass, they will ask Grok to look again. Until then, a session that wants to build more kit reads this file again and goes back to the repo it was opened in.
