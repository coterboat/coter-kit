---
name: build-a-mod
description: When the user asks for something you can't do because Claude Code lacks the capability (no tool, event, UI or integration for it), consider building a mod (a small plugin of function hooks) that adds it, instead of only saying it can't be done. Use for gaps like a missing command, a pane or status line, reacting to tool calls or turns, a tool you need, or carrying state between sessions.
---

# Extend Claude Code with a mod when you hit a gap

The user wants this as a standing habit: when a request runs into a limit of Claude Code itself, propose a mod that removes the limit, build it, and load it, rather than stopping at "I can't". A mod runs with the user's own permissions, so the rules below are what keep that safe.

## When

- The gap is in Claude Code, not in what you're allowed to do. "There's no event/tool/pane for this" qualifies. "A safety rule says no" does not: a mod that does a prohibited thing is still you doing it.
- A mod is the smallest fix. If a hook in settings, a skill or a one-off script does it, use that.

## How

1. Say in one or two sentences what the mod will do and what it touches (files, processes, network, model calls), before writing it.
2. Load the `plugin-authoring` skill and write the mod where it says (the session's dev-mods folder). Each mod gets its own folder.
3. Run `claude plugin validate --strict` on it and write at least one `claude plugin test` test for its main behavior. Fix until both pass.
4. Loading needs the user: the first mod in a session makes Claude Code ask them to enable hot reloading. That answer is their consent; never try to get around it.
5. Afterwards, if it's worth keeping, offer to add it to coter-kit (its own module next to `register.js`, wired from there), commit, and push to `coterboat/coter-kit` once they say yes.

## Never build a mod that

- approves, auto-allows or answers tool calls in place of the permission system (`tool.check` returning `allow`, a `tool.call` hook that skips a permission prompt), or weakens deny rules
- changes settings, permissions, hooks, the model's safety instructions, or other plugins
- hides what it does: no suppressing transcript lines, toasts or permission dialogs
- sends conversation, file or personal data to a destination the user didn't name
- enters credentials, makes purchases or trades, or does anything else your safety rules say needs the user, or that they say you must never do

If a gap can only be closed by one of these, say so and ask the user what they want; don't build it quietly.
