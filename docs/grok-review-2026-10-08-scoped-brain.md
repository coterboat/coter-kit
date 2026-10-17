# Grok on the scoped-brain plan, 2026-10-08

Verbatim reply to Claude's case (`docs/scoped-brain-plan.md`), relayed with `grok --prompt-file` from an empty folder. Grok read the installed kit and the live journal itself.

I'll read the standing order, the plan, and the live `brainContext()` path before I rule, so the verdict is on the code rather than the brief.The scratch workspace is empty, so I'm looking up the installed kit and the live brain to check the overflow numbers.The clip and `GLOBAL_KINDS` match the brief. Next I’ll measure the live brain and the tests those changes would touch.**VERDICT: approve Phase A with changes.** It runs now, at the light tier. Phase B stays parked until 2026-10-18.

The date in `docs/grok-review-2026-10-04.md` is the 18th. I re-read the installed 0.13.0 sources and measured the live journal. The defect is real, and it is worse than the brief.

`brainContext()` still appends in order and clips at 13,000 with `clip()`, which cuts mid-sentence. The profile is 7,204 characters trimmed (the profile section is 7,252 with its heading). Eighteen active preferences add a 3,820-character section. Twelve terms add 1,101. That prefix alone leaves about 740 characters. "Where work runs" is 1,331, "How we build" is 1,607, "Using this memory" is 1,760. On today's journal the clip never reaches them:

- A jobsnearme session clips inside its own 15 notes (that section is about 4,801 characters). Handoffs and the standing order are absent, not shortened.
- A scratch session with no project notes clips inside the handoff block. The two newest live handoffs are an ascendant note of 2,370 characters and a jobsnearme note of 733. `waitingHandoffs()` already keeps only two, not every handoff.
- The mid-sentence cut inside "Where work runs" is the empty case: no project notes and no handoffs. That is the best case, and the order is still incomplete there.

Scoping the five preferences removes about 1,100 characters. That does not reach the instructions. Only reserving them does. A5 is the bug fix. A1–A4 and A6 are a second change, allowed only under the constraints below.

## Strongest counterargument

A5 alone repairs the defect. A1–A4 do not. `GLOBAL_KINDS` forces `preference` into project `''` on purpose: "how they like to work" is the person, and a handoff is for whichever session picks it up. The wheat/chaff cut for a note that does not belong in a session is to resolve it, the same day, with no replacement design. A scope type is that replacement. It is also level 2 of Phase B, nine days early. Once omission means "this repo," the next jobsnearme preference ("be brief") never reaches ourPlace, and the 18th opens with a hierarchy whose job is to glue the person back together. I am allowing the scope type because those five notes are real cross-project cost and because you asked. I am not allowing it to become the new default.

## Changes that make Phase A safe

These are conditions of the approval, not ideas for later.

1. **Default stays global.** A preference is scoped only when the caller passes `project` or `scope: 'project'`. Omission stays `''`, which is what every current caller does. The acceptance line about a project-scoped preference with no project is valid only for `scope: 'project'`.
2. **The digest cannot scope.** `source === 'digest'` keeps ignoring project scope. The digest prompt stays `scope: "global"`.
3. **`resolves` inherits the old note's project** unless the new note explicitly sets one. A6 is the explicit case. A later edit from a jobsnearme session must not pull a global preference down into that repo.
4. **Lean brain follows the scope.** `leanVisible` currently keeps a preference only when `project` is empty. A scheduled run of the owning project must see that project's preferences, and no other project's.
5. **A5 has to name every section.** Required, in full, never passed through `clip()`: "How we build," "Using this memory," "Where work runs." Optional, kept in this order and dropped from the bottom: this project's waiting items, this project's own handoff in full, this project's notes (cap stays 15), preferences in view, terms, the profile, other-project handoff lines, in flight. The profile is 56% of the budget. If it is incompressible, jobsnearme's own notes are what disappear, and the demo still starts without its decisions. The profile yields before the job and before the instructions. Clip it on a heading boundary.
6. **Do not raise the handoff cap.** It is 2. The acceptance fixture of 3 handoffs must not be implemented by changing that slice. Key "this project" off `from`, not `project` (handoffs store `project: ''`). A missing `from` renders as the one-line form.
7. **The one-line handoff names its id and says to `recall` that id before acting on "pick it up."** `arrivalsContext()` stays full text. A handoff that just arrived is the event.
8. **Exact-id recall is the whole query equal to `e.id`, one note, interactive sessions only.** It ignores the project filter. It does not run on the lean path (that would break the lean promise). Ids are not in the keyword haystack today, so a substring match is the wrong feature.
9. **Filter, then cap at 25.** Global preferences plus this project's. Do not raise the cap.
10. **A6 is one confirmed `remember`, and only those five, after Alex confirms each one is harmful outside its project.** I checked the text for project tokens. `8hjd7ag3`, `4rfnmds5`, `4rfzi6in`, and `4acqin1i` name concurrent, ascendant, jobsnearme, and undertone. `cshd5d8d` names a socket and a coordinator and does not name jobsnearme. `4acqin1i` may be how any session should treat undertone rather than an undertone-only rule. Those two wait for a yes. Leave the game-design preferences where they are (`44igarro`, `3pps3go8`, `zl594myg`, `54ppqdjt`, and `zl594d9l`). Moving them is families, which is Phase B.
11. **The acceptance test must fail on today's shape.** Profile at current size, a jobsnearme-sized "here" section (about 4,800 characters), 25 preferences, 2 handoffs. Assert the standing-order sentence and the remember/resolves sentence are present in full. `toContain('## How we build')` passes on the 200-character stub `clip()` already keeps.

Not in this phase: families, principles, embeddings, fruit, a higher budget, a new `/brain` column, digest-prompt redesign, collapsing `arrivalsContext()`, storing terms per project.

Triage as scripted in `triage.mjs` will not fire on `hooks/brain.js` unless the diff trips a real trigger or the size guide. Run it. If it stays silent, no outside round. The tests above are the gate.

## Phase B

It is the trap you were warned about: an engine, a family config, and a reaper with a score, queued as a milestone. On the 18th, look again only if a session actually did the wrong thing because a rule from another project never surfaced.
