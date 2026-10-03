---
name: outside-review
description: Have a change reviewed by a model from another lab (Codex, or Grok as a red team) on a script-built packet, then verify every finding, log it, fix the class and repeat until a round comes back clean (4 rounds at most). Use before landing any change at the standard or full tier of coter-kit's standard (client features, anything a user sees, privacy, consent, money, auth), once for a light change, and when the user asks for an outside, hostile or second-opinion review.
---

# Outside review

The house standard is `docs/standard.md` in coter-kit; this skill runs its review loop. The scripts sit in `<this skill's folder>/scripts/` and run with `node`, from the project's folder. Everything they write goes in the project's `docs/reviews/`: packets, the verbatim responses in `inbox/`, and `findings.jsonl`. Commit `inbox/` and `findings.jsonl`. They're the trail. Packets can be rebuilt and are pinned by sha256 in each response's `.meta.json`, so add `docs/reviews/packets/` to the project's `.gitignore`.

## 0. Does it need one, and is it ready?

```
node <this skill's folder>/scripts/triage.mjs [--base <ref>]
```

Triage checks the standard's triggers against what changed: data that lasts, who can do what, things others depend on, things that run on their own, a change too big to hold in your head, a fix to a high finding, and the paths the project marks sensitive in `.claude/review.json`.
- **No trigger:** skip the outside review. The gates, your own read of the diff and the owner's walk are enough. Say so in one line.
- **A trigger fired:** review it once per push, not per edit. The unit is the branch, the milestone or the deliverable.
- **It's ready for the packet when you'd push it right now:**
  - it works in the path the app actually uses,
  - every acceptance test passes, and the new ones were watched failing,
  - the gates are green,
  - the diff is only this change, with the leftovers triage lists cleaned up,
  - you've read the whole diff yourself.

  Until all of that holds, keep building, whatever the iteration.

## 1. Build the packet

```
node <this skill's folder>/scripts/packet.mjs --goal <spec file, or the goal and acceptance criteria as text> \
  --targets "<what a user, an attacker or bad data could break here>" \
  --decisions "<choices you made that the reviewer should challenge>" \
  [--base <ref>] [--gate "<command>"]...
```

- **Targets.** Aim the review at the product: name the two or three things that would hurt most if they were wrong, such as data loss, a privacy leak or a wrong result on the main path. Don't aim it at the process.
- **Gates.** These come from `--gate` and from the project's `.claude/checks.json`. A red gate refuses the packet. `--allow-red "<why>"` sends it red on purpose, and the reason is printed into the packet.
- **Base.** It defaults to where the branch left `origin/main`. Use `--base` to review a narrower slice.

## 2. Relay it

```
node <this skill's folder>/scripts/relay.mjs --packet docs/reviews/packets/RV-NNN.md --reviewer codex
```

- Use `codex` for each change and `grok` for the red team at a milestone.
- With neither available, use a fresh Claude subagent instead. Give it only the rubric (`<this skill's folder>/rubric.md`) and the packet's text, tell it not to read the repository, and log it as reviewer `claude-fresh`. It's less independent, so say so in your report.
- The relay refuses a stale packet. It saves the response verbatim with sha256 pins, and warns if the reviewer didn't confirm it saw the packet only.

## 3. Verify every finding

Read the response from `docs/reviews/inbox/`. For each finding:
- Check it against the code with your own evidence: the line, a test you run, a reproduction. The reviewer's word is not evidence.
- Give it a verdict: `confirmed`, `partial`, `rejected` or `duplicate`.
- Log the rejects too. They're how the reviewer's precision gets measured.

Write the verdicts to a JSON file and log them:

```
node <this skill's folder>/scripts/findings.mjs add --file <verdicts.json>
```

Each entry looks like `{ "round": "RV-NNN", "reviewer": "codex", "id": "F1", "severity": "high", "category": "data-loss", "file": "path:line", "claim": "...", "verdict": "confirmed", "evidence": "what you checked", "resolution": "fixed" }`.

If a round has no findings at high or medium, log it as clean:

```
node <this skill's folder>/scripts/findings.mjs clean --round RV-NNN --reviewer codex
```

## 4. Fix the class, and go again

- **Fix the class.** Search for the same mistake elsewhere, not just the cited line, and pin the fix with a test that stays. Watch that test fail without the fix.
- **Run the next round.** Rebuild the packet and relay it again.
- **Know when it ends.** Only a confirmed high finding, or a compliance issue, blocks shipping. A medium gets fixed if it's quick, or deferred with a reason. `findings.mjs stats` says where the arc stands: closed (the last round had no confirmed high), open, or at 4 rounds, when the owner decides. When the owner calls it, record that with `findings.mjs close --round RV-NNN --reason "<their call>"`.
- **Don't loop on wording.** Findings about the review machinery or documentation wording are fixed or deferred once, never looped on.
- **Compliance, privacy and judgment calls go to the owner.** Save each one as a `waiting` note with a short ref.

## 5. Report and stop

Tell the owner, in at most eight lines:
- how many rounds, which reviewer,
- findings by severity and how many held up,
- what was fixed, and what was deferred and why,
- whether the arc closed.

Never commit, merge or push as part of this loop. The owner does, after walking the change.
