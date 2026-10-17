---
name: fold-profile
description: Fold the user's approved preferences into their profile (coter-brain profile.md), so the profile stays the short, approved record of how they like to work and every session gets it. Use when the kit says their approved preferences are past the 25 a session gets, or when the user asks to fold, tidy or consolidate their preferences or profile.
---

# Fold approved preferences into the profile

A session gets at most 25 approved preferences (its own project's first, then the newest global ones) and as much of the profile as its budget allows, cut between sections from the top. Preferences past the 25 stop reaching sessions. Folding moves the ones that last into the profile, where they belong, and retires them as notes. Ask before you write anything.

1. Call the recall tool with `kind: 'preference'` and an empty `query`. It lists every approved preference with its id, its project (none means global) and its age, up to 500; if it says there are more, fold these first and list again.
2. Read `~/.claude/coter-brain/profile.md`.
3. Sort each preference into one of three:
   - **fold**: a lasting way of working with them. It goes into the profile section where it belongs, merged with what is already there and in their words where you can. Don't just append it.
   - **project**: it only matters in one project, such as a game's art rule or a client's demo. It stays a preference, filed under that project.
   - **retire**: it was tied to a moment that has passed (a demo that is over, a lane that closed), or the profile already says it.
4. Keep the profile under 8,000 characters. Merge and tighten rather than grow it. Keep the headings. Don't drop or reword anything they wrote themselves without saying so.
5. Mind what a busy session gets. A session in a busy project gets only the profile's top sections (on 10-16 a jobsnearme session got the first one, about 1,000 characters), so a rule folded into a later section stops reaching those sessions. Put rules that every session needs (secrets, billing, safety, how to talk with them) in the top sections. "How to talk with them" stays first.
6. Show them a table with one row per preference: its id, a few words of it, and fold (into which section, and whether a busy session gets it), project (which one) or retire (why). Add the profile's size before and after. Ask before writing anything.
7. Once they approve, edit `profile.md` in place and update its "Reviewed by the user" line with today's date. Then make one remember call:
   - for each folded or retired preference, `{ kind: 'thread', text: 'done', resolves: '<its id>' }`
   - for each one filed under a project, `{ kind: 'preference', text: '<its text>', project: '<repository name>', resolves: '<its id>', confirmed: true }`
   - one decision, such as `{ kind: 'decision', text: 'Folded 31 preferences into the profile on <date>; 6 filed under their projects, 4 retired', scope: 'global' }`

   That call is what syncs. About 20 seconds after it, the kit commits the whole brain, `profile.md` included, and pushes it. Don't run git in the brain yourself. If `git -C ~/.claude/coter-brain status --short` still lists `profile.md` a minute later, ask them to run `/brain sync`.

Never put secrets, keys, or client or end-user personal data into the profile. A preference that holds any is retired, not folded.
