---
name: mine-history
description: Read this machine's past Claude Code sessions and propose updates to the user's shared profile (coter-brain profile.md). Use when the user asks to build, refresh or check their profile from their history, for example on a new machine.
---

# Mine this machine's history into the profile

The profile lives in the brain, `~/.claude/coter-brain/profile.md` (the coter-kit mod syncs it across machines). Another machine may already have written it. Your job is to add what this machine's history shows, not to start over.

1. Run the extractor that sits next to this file, writing to your scratchpad or a temp folder:
   `python3 <this skill's folder>/scripts/extract_user_messages.py <scratch>/user_msgs.txt` (on Windows, `python`). Add `--since YYYY-MM-DD` if the user only wants recent history.
2. Read the whole output, in chunks if it is long. These are the user's own messages only.
3. Read `~/.claude/coter-brain/profile.md`.
4. Compare. Look for:
   - projects, stacks and tools that only this machine shows
   - how they prompt and what they push back on, where it differs from or sharpens the profile
   - things the profile says that this history contradicts
   - shorthand they use (these can also become `term` notes with the remember tool)
5. Tell the user what you found, briefly, in their register: what's new, what you'd change, what this history contradicts, with a short quote or date as evidence for each. Ask before writing anything.
6. Once they approve, edit `profile.md` in place (keep its structure; update the "Built from" line with this machine and date) and save any approved shorthand with the remember tool (`kind: term`, `confirmed: true`). Then run `/brain sync`.

Never copy secrets, passwords, keys or client end-user data into the profile, even if the history contains them. If you see a credential in the history, tell the user where so they can rotate it.
