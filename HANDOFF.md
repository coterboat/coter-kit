# Handoff

From home on alexs-macbook-pro, 2026-10-03 20:22 UTC (id u9pl3sd4).

Sessions with coter-kit pick this up by themselves, including ones already open. Without it yet, install it first, in a terminal:

```
claude plugin marketplace add coterboat/coter-kit
claude plugin install coter-kit@coter-kit --config brainRemote=https://github.com/coterboat/coter-kit.git --config brainBranch=brain
```

---

Goal: home Phase 1 (BRIEF.md in coterboat/home): the Now strip, one local page on 127.0.0.1 ranking what needs Alex right now, built by plain code (no model calls) from coter-kit's live status files, the coter-brain journal (read-only) and GitHub via `gh api`. Each item has a one-line evidence and a link to its source.

Where it stands: Built and verified on the Mac. Commit 79d08a9 on branch claude/blissful-booth-8e36ba in the worktree ~/Documents/GitHub/home/.claude/worktrees/blissful-booth-8e36ba. NOT pushed: the GitHub repo coterboat/home doesn't exist yet. `npm test`: 23/23 pass (one reader per source against fixtures/, plus ranking, snooze/dismiss/restore, offMachine). Checked on the page at http://127.0.0.1:4800 (`npm start`): 22 real items in the right order; a synthetic needs_ok (test instance on :4801 with a scratch live dir) ranked above an 11h waiting note; dismiss and restore by click and by keys wrote append-only records; POST guards return 403/415/421; light, dark and phone width look right. log/ui.jsonl in the repo is still empty (tests used a scratch log).

Decisions: needs_ok first, then the longest wait (BRIEF.md). An idle session waits on Alex from the end of its last turn; idle with no turns isn't an item. Scheduled runs never make your_move. GitHub: PRs and review requests untouched for 30 days are dropped (otherwise year-old Copilot drafts top the strip); a default-branch failure counts only when coterboat's push/run is in the failing streak, for repos pushed in the last 7 days; a streak running past the first 30 runs is re-read per workflow, and the item key is anchored on the last green run so a dismiss sticks. Waiting notes dedupe per project on trim+lowercase (the brief's rule, slightly looser than coter-kit's sameText). Checklist words live under item.private and offMachine() drops them.

Next steps:
1. Alex: answer home-repo (create coterboat/home private + push), home-group (fold waiting notes per project?), home-always-on (LaunchAgent?).
2. Claude, on the Mac, once home-repo is a yes: `gh repo create coterboat/home --private`, push the branch as main.
3. Alex: live with the strip for a week, then Phase 2 (project tiles, Sessions panel, PC state over webhook/Tailscale).

Gotchas: coter-kit's status files gained `usage` and `rate_limits` on 10-3. That's fine: the real-files test checks only that the fixture's fields are still there. JoinOurPlace's 'Deploy API' workflow (ctarveriii/JoinOurPlace) has failed all 13 runs on main since 9-1 and tops the strip; dismiss it if it's known. The page re-renders only when items change, so browser-tool element refs can go stale between reads.
