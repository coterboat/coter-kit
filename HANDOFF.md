# Handoff

From undertone on alexs-macbook-pro, 2026-10-04 16:32 UTC (id 1hcqxu7r).

Sessions with coter-kit pick this up by themselves, including ones already open. Without it yet, install it first, in a terminal:

```
claude plugin marketplace add coterboat/coter-kit
claude plugin install coter-kit@coter-kit --config brainRemote=https://github.com/coterboat/coter-kit.git --config brainBranch=brain
```

---

Goal: undertone (github.com/coterboat/undertone) turns live Claude Code sessions into background music that tells Alex what's happening and what needs him. The current leg is "styles": game-soundtrack-quality genres (after Mass Effect and Stellaris) that keep the signals (calls, sour notes, asks) readable over hours.

Where it stands: main is 5db4282 (0.11.0), pushed. The coter-kit plugin is updated on the Mac, which runs a detached bridge on 127.0.0.1:4747.
- Styles are moods carrying a style:
  - Late shift: lofi.
  - Blue hour: jazz, made consonant and nobody's default.
  - Afterhours: house, home's default.
  - Far shore: ME1-style synth bed, undertone's default.
  - Deep field: Stellaris-style, coter-kit's default.
- Space-style sounds are kits in web/engines/common.js (makeFarShore, makeDeepField). The conductor uses tiers (calm/working/full) and the optional engine calls layer(), tier(), style() and comp(), all in web/index.html.
- Every style was verified on a scratch bridge and muted page: scheduled calls instrumented, 30 s clips, ear stats and spectrograms; 0 clicks on Synth and Sampled.
- The research doc is docs/space-styles.md, with Codex and Grok reviews in docs/reviews/space-styles/. Tests: npm test 72/72, claude plugin test . 24/24.
- Not done: Alex hasn't listened to Far shore or Deep field yet; reference-track analysis; DJ transitions and takeovers.

Decisions:
- No constant tones; a style change must carry information.
- Codex and Grok consensus applied: fewer moving parts, frequency bands per part, tiers up fast and down slow, no 7/8.
- Deep field's strings and organ stay synthesized: smplr's sustained string samples clicked on 128-sample block boundaries.
- Drone counts come from coter-kit's journal, not the live status files.
- No YouTube ripping; only files Alex owns.
- One session per leg, with /handoff at boundaries.

Next steps:
1. Alex (Mac): reload the page, live with Far shore and Deep field, and report how they feel over an hour.
2. Alex: put owned soundtrack files (Stellaris Steam soundtrack MP3s, Mass Effect OSTs, favourite work music) in ~/Music/undertone-refs/.
3. Claude (Mac): decode with ffmpeg, measure with ear/analyze.mjs (bands, loudness arc, onset density), cluster, and tune the styles toward the clusters.
4. Claude: DJ transitions (16-bar holds, phrase-boundary blends, related keys, tempo ratios), then takeovers on push or green deploy.
5. Alex: the PC still needs undertone updated (claude plugin marketplace update coter-kit, then claude plugin update undertone@coter-kit).

Gotchas:
- Test rig: scratch bridge `HOME=<tmp> UNDERTONE_HOME=<tmp>/.undertone UNDERTONE_BRAIN_DIR=<tmp>/brain UNDERTONE_SOURCES=0 GEMINI_API_KEY= node bridge/server.mjs 47xx`. Open it via preview_start url http://localhost:47xx and set Tone.getDestination().mute=true. Wrap UndertoneEngines.get(id).create to log calls, and use the Snapshot button for clips.
- Block-aligned clicks: check positions mod 128 (scratchpad quantum.mjs idea). Mixed mono/stereo buses must use kit.stereo().
- Tone's a.connect(b) returns a, not b.
- Gemini's free quota runs out fast; never put the key on scratch bridges.
- Performance resource buffer caps at 250 entries.
- Spotify connector: no listening history.
