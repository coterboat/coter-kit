# Handoff

From ascendant on alexs-macbook-pro, 2026-10-08 15:45 UTC (id pjqivosc).

Sessions with coter-kit pick this up by themselves, including ones already open. Without it yet, install it first, in a terminal:

```
claude plugin marketplace add coterboat/coter-kit
claude plugin install coter-kit@coter-kit --config brainRemote=https://github.com/coterboat/coter-kit.git --config brainBranch=brain
```

---

Goal: ascendant (github.com/coterboat/ascendant) to the MVP Alex wants to play (3D board and battles, rulers, paths, forts & sieges, independents, fog, magic, everything on by default), plus the Candlewake as the next faction right after the MVP walk.

Where it stands (10-8 ~11:45 ET): main = c688817. Merged this leg: Review Table #151-#153, #155 keep both, #157 self-restart, #158 keep-both state, #159 canon prune; #160 canon picks + duplicates removed; #164 MVP-1 (screens fit 1600x900/1280x720, first-game guide, How to play codex); #165 design/.gdignore; #166 M5-4 AI under fog (1182/0 suite; fog doesn't move the contract config: 23:36 vs 23:37). Candlewake spec PR #156 at r5 (Alex answered: flame-1, Free Holds give flame + reduced Harvest, Golden cools / Red burns, the Risen from Deep Wake, target ranges not hard caps, hollow eyeless wax shells). Review Table batches waiting for Alex: art_r3d, art_r3e (Candlewake hollow host).

Running (Sonnet builders, worktrees, shared rules in the director scratchpad builder_rules.md): M5-8 #119 magic on screen (branch m5-8-magic-ui), S-5 #103 walls on the 3D stage (m3c-s5-walls-stage), M5-3 #114 fog on the 3D board (m5-3-fog-board).

Next steps:
1. Verify each PR in a clean worktree merged with current main (import, compile_check, the PR's tests, full suite via tests/runner.gd in the background ~20-40 min, boot incl. flags, look at screenshots), merge with --match-head-commit, remove the verify and builder worktrees.
2. Launch M5-10 #121 (AI with magic; Far Sight via AIPlayer._fog.unseen) after the weekly reset; then M5-9 #120 (magic 3D, needs M5-3), S-7 #105 (siege balance), IND-2 #161 and M4-ART #162 (models from Alex's grok art into review/m4_looks); then M5-11 #122 (magic/fog bands; add --fog/--magic to autoplay, switch simulator to state_for) and MVP-2 #163 defaults flip (gated on S-7/M5-11 bands); then a director screenshot walk, then hand Alex the MVP walk.
3. Keep feeding Candlewake concept art (Codex + Grok, ivory wax hollow shells per canon candlewake_tide.png) into review/ batches with from-folder; Alex judges.

Gotchas: never make Review Table verdicts for Alex; builders must not EnterWorktree; Godot import first in fresh worktrees; play_shots needs --always-on-top; Grok CLI writes files into its cwd; codex exec needs < /dev/null; builders' full suites under load take 30-60 min.
