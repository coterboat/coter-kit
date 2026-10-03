# Handoff

From home on alexs-macbook-pro, 2026-10-03 20:35 UTC (id upll8fcz).

Sessions with coter-kit pick this up by themselves, including ones already open. Without it yet, install it first, in a terminal:

```
claude plugin marketplace add coterboat/coter-kit
claude plugin install coter-kit@coter-kit --config brainRemote=https://github.com/coterboat/coter-kit.git --config brainBranch=brain
```

---

Goal: home (github.com/coterboat/home, private): Alex's launchpad. Phase 1 is the Now strip, one local page ranking what needs Alex right now, built by plain code (no model calls) from coter-kit's live status files, the coter-brain journal (read-only) and GitHub via `gh api`.

Where it stands: Done, pushed and always on. main = 3fee858 on GitHub and in the main checkout ~/Documents/GitHub/home (tracks origin/main). A LaunchAgent (com.coterboat.home, ~/Library/LaunchAgents) runs that checkout's server.mjs on http://127.0.0.1:4800 at login with /opt/homebrew/bin/node. Verified: it comes back after kill -9, gh works under launchd (all three sources green), and a git pull in the main checkout restarts it on the new code by itself (exit 75 when server.mjs or lib/ changes). `npm test`: 25/25. Each project's open waiting notes fold into one row (ref chips) that opens to the questions, each with its own open/snooze/dismiss; 'Snooze all' on a group writes one record naming every question; a restore takes back only the keys it names. Checked on the page: fold, open state remembered after reload, keys j/k/l/h/s, snooze of one question and its restore.

Decisions: Alex 10-3: fold and expand the waiting notes; always-on via LaunchAgent from the main checkout; repo private. `/now` keeps `items` flat (for phone pushes or Grok Bot later) and adds `rows` (folded) for the page. Worktrees run their own copy as `home-dev` on 4801 (.claude/launch.json); `home` attaches to the always-on 4800.

Next steps:
1. Alex: live with the strip for a week (BRIEF.md), then decide Phase 2: project tiles, Sessions panel, PC state over a webhook or Tailscale.
2. Claude, when changing home: work in a worktree, test on 4801, push to main, then `git -C ~/Documents/GitHub/home pull --ff-only`. The LaunchAgent picks it up (`npm run status` / `npm run restart` in the main checkout if not).

Gotchas: `touch` doesn't trigger the restart-on-change (macOS's watcher ignores timestamp-only changes); real writes and pulls do. The log is ~/Library/Logs/home.log. JoinOurPlace's 'Deploy API' has never passed on main (13 runs since 9-1) and tops the strip until Alex dismisses it. The worktree branch claude/blissful-booth-8e36ba tracks origin/main; push it with `git push origin claude/blissful-booth-8e36ba:main`.
