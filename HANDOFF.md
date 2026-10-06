# Handoff

From ascendant on alexs-macbook-pro, 2026-10-06 01:28 UTC (id 021bs8rs).

Sessions with coter-kit pick this up by themselves, including ones already open. Without it yet, install it first, in a terminal:

```
claude plugin marketplace add coterboat/coter-kit
claude plugin install coter-kit@coter-kit --config brainRemote=https://github.com/coterboat/coter-kit.git --config brainBranch=brain
```

---

Goal: ascendant (github.com/coterboat/ascendant) toward an MVP Alex would want to play: 3D board and battles, rulers, paths, forts & sieges, independents, fog, magic.

Where it stands: main = f8ac1bf. Merged 10-4/10-5: #140 play_shots harness, #143 M5-5 magic rules, #144 IND-1 independents, #145 S-4 sieges on the 3D board, #146 M5-2 fog on screen, #147 #131 balance picks (independents-on is the balance contract), #149 M5-6 rituals, #148 M5-7 battle spells. Last suite 1,128 passed, 0 failed. Every system is still an unticked preview box until the defaults flip. Lore room R1-R4 and the art pass are on branch lore-writers-room (design/lore/); proposal page https://claude.ai/artifact/SSNQsxV7xpbv6642nsiFWH, art sheet https://claude.ai/artifact/Q5QYJkFfpuSajJTd6UzHpY. Alex's faction picks: Candlewake, Ember Orchard, Lacquer Reed, Kilnborn, Verdigris Pans, Glasswake Compact, maybe the Veiled Table (should play entirely differently).

Next steps:
1. Start the next director session in ~/Documents/GitHub/ascendant itself, not a worktree, so builder subagents work (a worktree director had to use spawn_task chips).
2. Builders, at most 3 at a time, Sonnet when well specified: MVP-1 #141 (screens fit 1600x900 and 1280x720, first-game guide), M5-10 AI with magic, S-5 #103, IND-2 (garrison 3D models, Ludo), M5-3 and M5-4, M5-8 and M5-9, then the defaults flip (all boxes on, drop 'preview').
3. Waiting on Alex: DIR2 (night watch plus Grok as critic and artist, retire the Grok Bot director?) and ART2 (art round 2 for the picks: portraits, fortress, model turnarounds, a 'mark on the land' concept).

Gotchas: verify every PR merged with current main (suite, compile, boots, screenshots) before merging; windowed Godot captures need --always-on-top; codex exec needs '< /dev/null' and --sandbox workspace-write; grok --prompt-file writes files into its cwd unless told not to; Ludo key in the main checkout's .env.local (scratch ludo_images.py reads it without printing).
