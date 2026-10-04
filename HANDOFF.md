# Handoff

From home on alexs-macbook-pro, 2026-10-04 18:49 UTC (id 6dsucaxr).

Sessions with coter-kit pick this up by themselves, including ones already open. Without it yet, install it first, in a terminal:

```
claude plugin marketplace add coterboat/coter-kit
claude plugin install coter-kit@coter-kit --config brainRemote=https://github.com/coterboat/coter-kit.git --config brainBranch=brain
```

---

Goal: home (github.com/coterboat/home, private): Alex's launchpad per docs/spec.md, by plain code; models only for hand-offs.

Where it stands: main = c4caaf7, pushed, live on http://127.0.0.1:4800 (LaunchAgents com.coterboat.home and com.coterboat.home-runner, from ~/Documents/GitHub/home; they restart on a pull). npm test 63/63. Since the last handoff: questions on the strip can be answered (Answer... / key a: the note's options with its pick marked, or yes and no, a typed answer, Later). home writes ~/.claude/coter-kit/answers/<id>.json (coter-kit's contract in its docs/live-status.md, 'Answering from outside a session'); a coter-kit session saves the decision and closes the question; home never writes the brain. The question leaves the strip at once, waits under 'Answered · saving' with Undo, and home removes its file once the brain shows it closed. Proven end to end on 4800 with a test question (home-test, 6by88i0z): saved by a live session as decision 6d9lm0jd within ~25 s.

Decisions: Alex 10-4 OK'd home writing answers; coter-kit's inbox makes that possible without touching the brain (decision 665h03ey). Earlier ones stand (read-only hand-offs, ourPlace without a checkout).

Next steps:
1. Alex: PC-home; TODO links in projects/ourplace.yaml and jobsnearme.yaml; say how Grok Bot takes requests if the side rail/command box should come next.
2. Possible builds: closing a handoff row (coter-kit has no inbox for that yet; it would need one), hand-offs that may write on a fresh worktree, supporting metrics.
3. Claude: worktree, home-dev on 4801, npm run shot before calling a visual change done, push only on fail 0, pull in the main checkout.

Gotchas: Alex's weekly Max window showed 100% on 10-4 18:45. A questions group's header carries its members' refs, so select member rows by data-key. My session's remember tool predates coter-kit's options field (new sessions have it).
