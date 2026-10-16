---
name: outside-review
description: Have a change reviewed by a model from another lab (Codex, or Grok as a red team) on a script-built packet, then verify every finding, log it, fix the class and repeat until a round comes back clean (4 rounds at most). Use before landing any change at the standard or full tier of coter-kit's standard (client features, anything a user sees, privacy, consent, money, auth), once for a light change, and when the user asks for an outside, hostile or second-opinion review. Also walks a deployed web build as one person doing one task (a model that didn't build it, behind a guard), for anything a user sees.
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
- The relay refuses a stale packet. It saves the response verbatim with sha256 pins.
- **The export.** The reviewer runs read-only in a copy of the repository as it is now: the files the packet describes, without `.git`, ignored files, media or `docs/reviews/`. Only text files under 1 MiB go, copied from the very bytes that were scanned; a binary or a larger file is left out and named in the meta. So is any file whose purpose is secrets (`.env*`, keys and certificates, `appsettings*.json`, `web.config`, `.npmrc`, `.netrc`, `*.tfvars`, service-account JSON), whatever the scan makes of it: the scan is a net, not a proof. Codex asked for it: "Isolation is useful for preventing edits, not for removing relevant evidence." A random id is planted in the copy. The relay checks the reply: its first line must quote the id, and it must name no path of the real checkout. A warning there means read the reply before trusting it.
- **Nothing secret leaves.** The relay scans the prompt and every exported file for secret-shaped values: private keys, known token formats, connection-string passwords, storage keys, credentials in URLs, secret-named settings, JWTs, and any value from the project's own `.env` files (public build variables aside). It names where, never what.
  - **A hit in the packet refuses the relay.** If the hits are fake (test fixtures), check each one, then pass `--allow-secrets "<why>"`; the reason goes in the meta. If any is real, take it out of the change and tell the owner it needs rotating.
  - **A hit in the export means packet only this round,** and the relay says where. Files whose values are fake on purpose go in `.claude/review.json` `"exportFakes"`: a path excuses only fixture-shaped hits (secret-named settings, URL credentials, connection-string passwords); a key or token format is excused only by its exact digest, `{ "path": …, "digests": [...] }`, which the relay prints for each hit once you've checked it is fake; a value from the project's `.env` is never excused; paths never to export go in `"exportExclude"`; `"export": false` (or `--packet-only`) keeps the old way: an empty folder and a canary asking the reviewer to say what it can see.

## 3. Verify every finding

Read the response from `docs/reviews/inbox/`. For each finding:
- Run its `Validation` / `repro` first, exactly as given, before arguing about what it means. Then check it against the code with your own evidence: the line, a test you run, a reproduction. The reviewer's word is not evidence, and neither is your opinion of it: "'Claude thinks this is rejected' is another model judgment" (Codex).
- Give it a verdict: `confirmed`, `partial`, `rejected` or `duplicate`.
- Log the rejects too. They're how the reviewer's precision gets measured.

Write the verdicts to a JSON file and log them:

```
node <this skill's folder>/scripts/findings.mjs add --file <verdicts.json>
```

Each entry looks like `{ "round": "RV-NNN", "reviewer": "codex", "id": "F1", "severity": "high", "confidence": "medium", "category": "data-loss", "file": "path:line", "claim": "...", "verdict": "confirmed", "evidence": "the command and what it printed", "rung": "repro", "resolution": "fixed" }`. `severity` is the reviewer's impact. `rung` is what decided the verdict: `test` (a regression test), `repro` (a command), `trace` (a browser trace or screenshot with the expected state), `query` (an invariant over realistic data) or `hypothesis` (nothing ran). The order is a guide, not a ranking: name the strongest evidence that applies.

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

## The walk: the deployed build, as one person

A review reads the change. A walk uses the product. On 10-14 a first-time tester near Atlanta found three P0s in jobsnearme that every spec, test and review had passed. Commutes of 1,716 minutes showed as normal results, and three counts on one screen couldn't all be true. Nobody's job was the product as a person meets it. The walker's is.

```
node <this skill's folder>/scripts/walk.mjs --url <start url> --person "<who>" --task "<one task>" \
  [--staging <https origin>] [--prod-readonly] [--desktop] [--storage-state <file>] \
  [--skip "<a standing check>"]... [--read-post "<host> <path regex>"]... [--run]
```

- **Who walks.** A browser-capable model that didn't build the change: Grok by default, never the same Grok run that built it. Grok has no browser tool. The relay writes a scratch folder outside the repository with a Playwright script (`walk.mjs`) and the brief (`walk.md`, from `walker.md`). Grok runs the script through Bash and reads the screenshots, as `grok --prompt-file walk.md --cwd <folder> --always-approve --max-turns 30`. Without `--always-approve` it stalls at the first Bash prompt, "and I will describe a page I did not open." `--run` runs it and saves the reply verbatim to `docs/reviews/inbox/WALK-NNN-grok.md` with a meta file. Without `--run`, the relay prints the command.
- **What it gets.** A URL, a person, a task and the standing checks to skip. Never the spec: the walker finds what no acceptance criterion named.
- **The guard, not the prompt, holds the line.** It's imported by absolute path from this skill and recorded by sha256:
  - a 390×844 viewport (`--desktop` for 1440);
  - every write blocked except the read-only POSTs you allow, by `--read-post` or `.claude/review.json` `walk.readPosts`;
  - analytics and session recording blocked (a long built-in list, tracking-pixel paths, self-hosted Matomo, and `walk.blockHosts` for your own), service workers off, WebSockets closed (a write over a socket would never pass the request guard; `walk.allowWebSockets` lets them through), no cookies unless a storage-state file is given;
  - the owner's Maps budget: at most 3 Routes calls and 12 billed Google requests per walk, overridable in `walk.budget`. The legacy Directions and Distance Matrix services count as routes, and Places Autocomplete counts as billed (its session discount can't be seen from the browser). The other Maps Platform APIs (Roads, Address Validation, Tiles, Air Quality and the rest) are billed. Any other `googleapis.com` host is blocked and listed unless `walk.allowGoogleHosts` names it (Firebase, YouTube); a Google endpoint the guard doesn't know is blocked and listed until it's named in `walk/guard.mjs`.

  A blank commute or map left by the budget is expected, not a finding. Two pages building maps at the same moment can pass the map cap before the guard catches up; every Google request stops once it's reached, and a load past it shows in summary.json as a guard failure. It stops accidents. It is not a sandbox.
- **Where.** localhost, or the exact `--staging` origin. Anything else needs `--prod-readonly`, and is read-only.
- **What comes back.** Findings typed `CHECK` (an invariant with a reproduction, its rung and a screenshot) or `OPINION` (three at most, never blocking). Each `CHECK` ends with `assert: … ; repro: … ; evidence: …`.
- **Closing a CHECK.** The walker never closes its own. Reproduce it failing on the build, then encode it as a check that runs against the deployed build (Playwright, or a query), then watch it pass after the fix. A check that passes on the day it's written may have locked the bug in. A class becomes a standing check when it has a stable invariant and a real chance of coming back. Standing checks run with no model.
- **Blocking.** The walker's word blocks nothing. A `CHECK` you reproduce on a real rung fails the change like any other defect. The owner's walk stays last.
