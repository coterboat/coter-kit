# Future ideas for coter-kit

Captured 2026-10-04 from a conversation with Grok. These are candidates, not a queue — the standing order through 2026-10-18 (`docs/grok-review-2026-10-04.md`) says the desk is in use, not under construction, and a new idea is not permission to reopen that tempo. Revisit after the eighteenth, or when Alex asks.

## 1. `/reviewer` — the scorecard the reviewer already keeps

The build plan's anti-churn rules say the reviewer keeps score of overruled verdicts by category, and that count is what widens or narrows its authority. That machinery exists in the journal files, but nothing reads it back to Alex.

A `/reviewer` command would show the scorecard: overruled on duplicates twelve times, so it now auto-drops those; overruled on contradictions three times, so it still asks. It closes the loop on the whole authority-split design — the reviewer earns trust in code, and Alex sees the receipt.

## 2. Routing digest — mine the route log

Every routing choice is a `route` note with the reason, the outcome, and the usage. The log is a dataset nobody is reading. A weekly digest would say things like: cloud sessions on refactors cost X and saved Y; subagents on searches were the cheapest path for Z. That turns `docs/routing.md` from a starting playbook into one the log actually earned.

## 3. Pre-flight check before a fan-out

The status files already carry the five-hour and seven-day rate-limit windows. A check before fanning out to subagents or a cloud session that says "you're at eighty percent of the five-hour window; this fan-out will blow it" would stop the expensive mistake before it happens, instead of showing it in `/glance` after the fact.

## 4. Dynamic workflows in Claude Managed Agents — parked until a job needs it

Added 2026-10-09 by Claude, in a cloud session with Alex, the day @ClaudeDevs announced it. Not a candidate yet. It's here so the fit is already worked out if one turns up.

What it is: a Claude Managed Agents agent (the API product, `client.beta.agents.create`) with `multiagent: {"type": "multiagent_20261001"}` can write a plan that Anthropic's servers run in the background. A run can use up to about 1,000 agents, 64 at a time, in phases, all sharing one container. It is not Claude Code's own `Workflow` tool (the Workflow row in `docs/routing.md`). It bills an API key, not Claude Max: tokens, plus $0.08 per session-hour at list price. None of that spend shows in `/glance`'s 5-hour or 7-day windows.

Why not now:

- **Our parallel work is lanes, not one big job.** Several repos and products each run in their own local session, and coter-kit coordinates them through the brain, `/glance`, `/waiting` and `/handoff`. Dynamic workflows split one job across many agents.
- **It can't see the local machine.** It runs on Anthropic's servers, so it can't reach local sessions, their status files, or the transcripts in `~/.claude/projects/`. The kit is at its best locally.
- **None of the kit's jobs is the right size or shape:**
  - `review-brain`: the band suggests a run at 15 notes.
  - `outside-review`: its point is a model from another lab.
  - `mine-history`: it would send transcripts off the machine.
  - The route log: it fits in one call.

Revisit when:

- **A product grows a job with hundreds of same-shaped items whose data may leave our machines.** A nightly check of every jobsnearme posting would be one. The docs' test: a roster of 25 agents would have to work through it in batches. Never with ourPlace data.
- **Cloud sessions carry the brain.** It already syncs to GitHub. Whether a cloud environment can run the plugin is untested.

If one comes up:

- Start with a scoped run: `/claude-api managed-agents-onboard` in Claude Code.
- Set a dollar budget when the session is created, because one can't be added afterward.
- Give the agent a system prompt line saying which tasks get a run, never "always".
- Give it its own row in `docs/routing.md`.
- Note in idea 3 that the pre-flight check can't see API spend.

## Notes

- None of these are milestones. They're a file so the ideas survive past this conversation without becoming a build arc.
- If one of them gets built, it should follow `docs/standard.md` at the tier it deserves, and the build-a-mod skill's never-list still holds.
- Added by Grok (Eve) on 2026-10-04, in a conversation with Alex about what coter-kit could do that isn't already built or documented. The commit is authored under Alex's GitHub account, so it reads as his own note.
