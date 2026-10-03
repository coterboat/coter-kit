# Handoff

From home on alexs-macbook-pro, 2026-10-03 23:10 UTC (id 09ie8qco).

Sessions with coter-kit pick this up by themselves, including ones already open. Without it yet, install it first, in a terminal:

```
claude plugin marketplace add coterboat/coter-kit
claude plugin install coter-kit@coter-kit --config brainRemote=https://github.com/coterboat/coter-kit.git --config brainBranch=brain
```

---

Goal: home (github.com/coterboat/home, private): Alex's launchpad, the Now strip of what needs Alex right now, built by plain code from coter-kit's live status files, the coter-brain journal (read-only), GitHub via gh, and now the PC's sessions and session titles. Tiles, project pages and Grok Bot actions still wait until Alex has lived with the strip a week (BRIEF.md).

Where it stands: pushed and live. main = 31488e2 on GitHub and in ~/Documents/GitHub/home; the LaunchAgent com.coterboat.home runs it on http://127.0.0.1:4800 and restarts on a pull. The phone reaches it at https://alexs-mac.tail9d147d.ts.net:8443 (tailscale serve; hosts.json in the main checkout). tailscaled now runs at login too (LaunchAgent com.coterboat.tailscaled, userspace, socket ~/.tailscale/tailscaled.sock; scripts/tailscaled.mjs). npm test 42/42. Built 10-3 evening: (1) PC on the strip: scripts/send-live.mjs on the PC posts its status files to POST /ingest/live every 15 s (checklist words dropped, last turn only); lib/remote.mjs keeps each device's latest post in log/remote/, corrects clock skew, and marks a device quiet for 3 min offline (no rows). Tested end to end on the dev server with a fake bld session; the real PC isn't on the tailnet yet. (2) Session titles from transcripts' custom-title/ai-title lines only (lib/titles.mjs), under item.private. (3) Buttons: Merge… (confirm step with method, base and workflows that may ship; --match-head-commit), Rerun (a run that may deploy asks first, enforced on the server), Diff, Repo; action records in log/ui.jsonl show on the row for an hour. Confirm panels checked on the page with real data and cancelled; nothing was merged or rerun. (4) Followed coter-kit 0.8.0's contract (no folder, every day folder).

Decisions: Alex 10-3 picked PC on the strip, actions on rows, session titles; OK'd pushing 5c2cbb7 and tailscaled at login. Titles and checklist words never leave the machine (the PC's sender doesn't read transcripts).

Next steps:
1. Alex or a PC session: PC-home (update coter-kit, Tailscale on as coterboat, clone home, send-live setup + install).
2. Alex: live with the strip a week, then Phase 2 (tiles, Sessions panel).
3. Claude when changing home: worktree, test on 4801 (home-dev), push to main only when npm test shows fail 0, `git -C ~/Documents/GitHub/home pull --ff-only`.

Gotchas: JoinOurPlace's 'Deploy API' has never passed on main and tops the strip; its Rerun would deploy to the client's production, hence the confirm. ~/Documents/GitHub/home has an untracked .claude/review.json from another session. `touch` doesn't trigger the restart-on-change; real writes do.
