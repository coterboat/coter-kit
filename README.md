# coter-kit

A personal Claude Code plugin for the CLI and the desktop app. It answers one problem: every session starts from zero, with one Markdown file telling it how to behave. coter-kit gives each session a working memory that is shared across sessions, repositories and machines, and that you can review.

| Mod | What it does |
| :- | :- |
| **Brain** | What Claude learns about working with you: your profile, how you like to work, your shorthand, each project's decisions and open threads. It is loaded at the start of every session, on every machine. Claude adds notes with its `remember` tool and searches them with `recall`. Every 8 turns, and before compaction, a cheap digest of the session (run over the session's own cached transcript) catches what Claude missed. `/brain` reviews it. |
| **Snapshot** | On startup, `/resume`, `/clear` and after compaction, gives Claude the branch, uncommitted files, last 8 commits, the stack, the last check results, and the brain. `/snapshot` shows exactly what Claude gets. |
| **Checks** | Remembers which files Claude edits. Before Claude finishes a turn, it runs that project's typecheck or build. If they fail, Claude is sent back to fix them, at most 2 rounds, and never twice for the same failure. Python syntax errors are reported right after the edit. |
| **Checklist** | Claude keeps a live task list with its `checklist` tool. A band above the prompt shows progress, the current step, what Claude is doing right now, and failing checks. `/checklist` opens the full list. |

## How the brain avoids rotting

Memory that learns by itself can learn the wrong thing and keep reinforcing it. So:

- **You approve anything about you.** Preferences and vocabulary wait in `/brain` (keep / drop) until you approve them, unless you told Claude outright to remember them.
- **Work in progress expires.** Threads drop out after 3 weeks; decisions and facts after 6 months. Claude can retire a note early with `resolves`.
- **There's a budget.** At most about 9,000 characters reach a session, newest first.
- **Credentials are redacted** (keys, tokens, `pw ...`, long hex strings) before anything is written. The digest is told never to keep client or end-user personal data.

## Where it lives

The brain is a git folder, `~/.claude/coter-brain`:

- `profile.md`: yours to edit. It starts from `profile.seed.md`.
- `journal/<machine>/<date>-<session>.jsonl`: append-only, one file per session, so two machines never edit the same file and syncs never conflict.

It syncs to the `brain` branch of this repo; the plugin code is on `main`, at the repo root. Change that in the plugin's settings (`brainRemote`, `brainBranch`, `brainDir`). Set `brainRemote` empty to keep the brain on one machine.

## Commands

| Command | What it does |
| :- | :- |
| `/brain` | Review what Claude learned: keep or drop each item |
| `/brain sync` | Commit and push the brain now (it otherwise syncs 20 seconds after a write, and at the next session start) |
| `/brain digest` | Digest this session now |
| `/snapshot` | Show everything Claude is given at session start |
| `/checklist` | Open the task checklist |
| `/checks`, `/checks off`, `/checks on` | Run the checks now, or turn them off or on for this folder |
| `/coter-kit:mine-history` | Read this machine's past sessions and propose profile updates (run it once on each machine) |

## Checks it runs

The project is the nearest folder above the edited file with a manifest.

| Project | Check |
| :- | :- |
| `package.json` with a `typecheck` script | `npm run typecheck` |
| `package.json` + `tsconfig.json`, no script | `tsc --noEmit` (only when TypeScript is installed locally) |
| `.csproj` / `.sln` | `dotnet build` (skipped when a running app has the output locked) |
| Python files | `python -m py_compile` on the edited files |

Tests never run by default, because some runners (CRA's `npm test`) start a watch mode and never exit. To choose a project's checks, add `.claude/checks.json`:

```json
{
  "checks": [
    { "name": "unit tests", "run": ["npx", "jest", "--watchAll=false"], "cwd": "Ourplace.client", "timeoutSec": 300 }
  ]
}
```

`{ "enabled": false }` turns checks off in a repo.

## Install

Needs Claude Code 2.1.286 or later. Check with `claude --version`.

On each machine (Windows PC and Mac), in any Claude Code session:

```
/plugin marketplace add coterboat/coter-kit
/plugin install coter-kit@coter-kit
```

Then run `/plugin` and look for `1 mod active · coter-kit`. The first session clones the brain. On a new machine, run `/coter-kit:mine-history` once.

## Develop

```bash
claude --plugin-dir .                        # load it for one session, reloads on save
claude plugin validate --strict .
claude plugin test                            # 25 tests, no session or network needed
```

`register.js` holds every call into Claude Code (`$`), because the validator follows `$` only within one file. `brain.js` reaches Claude Code through the small `io` adapter that `register.js` builds.
