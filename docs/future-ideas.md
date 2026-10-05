# Future ideas for coter-kit

Captured 2026-10-04 from a conversation with Grok. These are candidates, not a queue — the standing order through 2026-10-18 (`docs/grok-review-2026-10-04.md`) says the desk is in use, not under construction, and a new idea is not permission to reopen that tempo. Revisit after the eighteenth, or when Alex asks.

## 1. `/reviewer` — the scorecard the reviewer already keeps

The build plan's anti-churn rules say the reviewer keeps score of overruled verdicts by category, and that count is what widens or narrows its authority. That machinery exists in the journal files, but nothing reads it back to Alex.

A `/reviewer` command would show the scorecard: overruled on duplicates twelve times, so it now auto-drops those; overruled on contradictions three times, so it still asks. It closes the loop on the whole authority-split design — the reviewer earns trust in code, and Alex sees the receipt.

## 2. Routing digest — mine the route log

Every routing choice is a `route` note with the reason, the outcome, and the usage. The log is a dataset nobody is reading. A weekly digest would say things like: cloud sessions on refactors cost X and saved Y; subagents on searches were the cheapest path for Z. That turns `docs/routing.md` from a starting playbook into one the log actually earned.

## 3. Pre-flight check before a fan-out

The status files already carry the five-hour and seven-day rate-limit windows. A check before fanning out to subagents or a cloud session that says "you're at eighty percent of the five-hour window; this fan-out will blow it" would stop the expensive mistake before it happens, instead of showing it in `/glance` after the fact.

## Notes

- None of these are milestones. They're a file so the ideas survive past this conversation without becoming a build arc.
- If one of them gets built, it should follow `docs/standard.md` at the tier it deserves, and the build-a-mod skill's never-list still holds.
- Added by Grok (Eve) on 2026-10-04, in a conversation with Alex about what coter-kit could do that isn't already built or documented. The commit is authored under Alex's GitHub account, so it reads as his own note.
