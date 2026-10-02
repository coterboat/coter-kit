# Handoff

From scratch-2026-10-01-8fbfc8 on bld, 2026-10-02 05:49 UTC (id jm49wk7l).

Sessions with coter-kit pick this up by themselves. Without it yet, install it first:

```
/plugin marketplace add coterboat/coter-kit
/plugin install coter-kit@coter-kit
```

---

Goal: set up coter-kit on the Mac and fold the Mac's Claude Code history into the shared profile, so every session on every machine starts knowing the user, their projects and what's in flight.

Where it stands:
- coter-kit 0.3.0 is on github.com/coterboat/coter-kit (private), branch main, plugin at the repo root. Mods: project snapshot at session start; typecheck/build checks before Claude may stop (max 2 fix rounds); live task checklist band; the brain (remember/recall tools, digest every 8 turns and before compaction, /brain review pane); /handoff. Skills: coter-kit:mine-history, coter-kit:build-a-mod. 29 tests pass; validate --strict passes.
- Verified live on the Windows PC (device 'bld') through hot reload: /snapshot, /brain, the checklist band, remember. Not yet seen live: the 8-turn digest, the Stop checks in a real repo, and a sync from a second machine.
- The brain is ~/.claude/coter-brain, synced to the 'brain' branch of the same repo. profile.md there is the profile the user approved (23 PC sessions + the coworker style: push back with a reason, no devil's advocate on every point).
- The PC's working copy of the plugin is ~/.claude/dev-mods/5cf38e73-8943-4225-8d9e-907f45ba037f/coter-kit (has .git, pushes to origin). It is tied to that one session.

Decisions:
- No cloud session for this: it can't read the Mac's ~/.claude/projects or install into the Mac's Claude Code. The handoff travels through the brain instead.
- Brain data lives on the 'brain' branch, not a second repo. One journal file per session, so machines never conflict.
- Preferences and vocabulary wait for the user's keep/drop in /brain; threads expire after 21 days, handoffs after 7.
- Self-extension: when Claude Code lacks a capability, build a mod (build-a-mod skill) after saying what it does; the user's hot-reload answer is the consent. Never mods that approve tool calls, change settings/permissions, hide actions or bypass safety rules.

Next steps (on the Mac):
1. User: update the Claude desktop app / Claude Code to 2.1.286 or later.
2. User: in any Claude Code session run /plugin marketplace add coterboat/coter-kit, then /plugin install coter-kit@coter-kit, then start a new session. It clones the brain; the Mac needs git access to the private repo.
3. Claude: confirm this handoff and the profile arrived (/snapshot), then mark this handoff picked up.
4. Claude: run coter-kit:mine-history on the Mac's history; show what's new or contradicts profile.md, with dates or short quotes as evidence; edit profile.md only after the user approves; then /brain sync.
5. User, optional: clone coterboat/coter-kit into ~/Documents/GitHub/coter-kit (and on the PC into Documents\GitHub) for future plugin edits instead of the session-bound dev-mods copy.

Gotchas:
- claude plugin validate --strict passes JS syntax errors; run node --check hooks/*.js and claude plugin test.
- A mod can't pass $ across an import; brain.js gets an io adapter that register.js builds.
- On Windows, git fails inside the app's scratch folders (path length, virtualized AppData); work from a short path.
- The Facebook app credential pasted in a July ourPlace session should be rotated.
