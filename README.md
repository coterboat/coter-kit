# coter-kit

A personal Claude Code plugin for the CLI and the desktop app. It answers one problem: every session starts from zero, with one Markdown file telling it how to behave. coter-kit gives each session a working memory that is shared across sessions, repositories and machines, and that you can review.

| Mod | What it does |
| :- | :- |
| **Brain** | What Claude learns about working with you: your profile, how you like to work, your shorthand, each project's decisions and open threads. It reaches Claude with your first message in every session, on every machine, and is kept current while a session runs. Claude adds notes with its `remember` tool and searches them with `recall`. Every 8 turns, and before compaction, a cheap digest of the session (run over the session's own cached transcript) proposes what it learned about you, your preferences and shorthand, for you to keep or drop in `/brain`. Project facts, decisions and open work come only from Claude's own saves as they happen. |
| **Snapshot** | On startup, `/resume`, `/clear` and after compaction, gives Claude the branch, uncommitted files, last 8 commits, the stack and the last check results, then the brain (at startup, with your first message). `/snapshot` shows exactly what Claude gets. |
| **Checks** | Remembers which files Claude edits. Before Claude finishes a turn, it runs that project's typecheck or build. If they fail, Claude is sent back to fix them, at most 2 rounds, and never twice for the same failure. Python syntax errors are reported right after the edit. |
| **Waiting on you** | Every question, mockup, page or sign-off Claude is waiting on you for, with its link when there is one, in the brain. `/waiting` puts each one in a question card to click through; an answer resolves it; unanswered ones drop off after 30 days. |
| **Checklist** | Claude keeps a live task list with its `checklist` tool. A band above the prompt shows progress, the current step, what Claude is doing right now, and failing checks. The ▸ at its start opens every step in the band and ▾ folds it back (click it, or ctrl+x tab then Enter in the terminal); it stays the way you left it, across sessions. `/checklist` opens the list in a pane. |
| **Live status** | Every session writes a small status file (state, checklist step, what needs you, your time and Claude's) so other tools read it instead of transcripts: `/glance`, undertone, the home dashboard, a phone notifier. The band says when another session here needs you. Format: `docs/live-status.md`. |
| **Timesheets** | Your time and Claude's per project per day, rolled up from the status files into one file per machine in the brain (`timesheets/<machine>.json`). `/timesheet` shows a week in three columns (yours, Claude's, adjustments) and the hours to bill: your time rounded up to 0.1 h per project per day, plus manual lines (`/timesheet add jobsnearme 1.5h client call`). `/timesheet confirm` makes a finished week final and shows anything that changes after. Format and rules: `docs/timesheets.md`. |
| **Reviewer** | `/coter-kit:review-brain` checks the notes waiting in `/brain`, and what went live this week, against the code, git and other sessions' logs, and gives each a verdict with its evidence. You apply its picks with one press. Rules that stop the newest sentence from always winning are enforced in code (`docs/build-plan.md`). |
| **Where work runs** | Every session is told when to work here, open a new session, fan out to subagents, use the cloud or a scheduled task (`docs/routing.md`). Each choice is logged as a `route` note with its reason, then its outcome and usage; `/routes` lists them, and the latest outcomes reach every session, so the playbook learns from what happened. |
| **How we build** | The house standard every project inherits (`docs/standard.md`), lifted from what jobsnearme's pipeline proved: tiers by stakes, acceptance criteria that name their tests, a read-only critic, gates where a skip is "not verified", and an outside review by another model before landing. `/coter-kit:outside-review` runs that loop: a script-built packet, Codex (or Grok as red team) in a read-only sandbox, the answer saved verbatim, every finding verified and logged, at most 4 rounds. Every session is told the standard. |

## How the brain avoids rotting

Memory that learns by itself can learn the wrong thing and keep reinforcing it. So:

- **You approve anything about you.** Preferences and vocabulary, including everything the digest proposes, wait in `/brain` (keep / drop) until you approve them, unless you told Claude outright to remember them. A digest note can't skip that, retire another note, or leave a handoff, and one you dropped isn't proposed again.
- **Work in progress expires.** Threads drop out after 3 weeks; decisions and facts after 6 months. Claude can retire a note early with `resolves`.
- **An outside reviewer checks them**, with evidence, and you decide. It can drop an exact duplicate by itself; it can only challenge notes you made, and it can't flip-flop a topic.
- **There's a budget.** At most about 13,000 characters reach a session, newest first. Other projects get one short line each, their latest thread; `recall` has the rest.
- **Credentials are redacted** (keys, tokens, `pw ...`, long hex strings) before anything is written. The digest is told never to keep client or end-user personal data.

## Where it lives

The brain is a git folder, `~/.claude/coter-brain`:

- `profile.md`: yours to edit. It starts from `profile.seed.md`.
- `journal/<machine>/<date>-<session>.jsonl`: append-only, one file per session, so two machines never edit the same file and syncs never conflict.

A sync never deletes anything. It commits only new and changed files, and puts back any file missing from disk, so a half-finished clone or a stray delete can't wipe another machine's notes.

It syncs to the `brain` branch of this repo; the plugin code is on `main`, at the repo root. Change that in the plugin's settings (`brainRemote`, `brainBranch`, `brainDir`). Set `brainRemote` empty to keep the brain on one machine.

## How open sessions stay in sync

A session doesn't have to restart to see what another one wrote, on this machine or another:

| When | What happens |
| :- | :- |
| Session start | Pulls the brain. The snapshot goes in at once, and the brain goes with your first message, because that message shows who is there: a scheduled task's run starts with its `<scheduled-task>` tag and gets only this project's notes and your approved ways of working (no profile, no other projects, never a handoff, nothing more later, no digest). |
| Every 2 minutes | Pulls the brain and re-reads it. A new handoff shows in the band above the prompt; Claude acts on it only when you say "pick it up". |
| Each prompt you send | Anything new from other sessions goes along with it, under "New in working memory", once. Only this project's notes and the global ones (handoffs, approved preferences and vocabulary) are sent. |
| Claude calls `recall` | Pulls first if the last pull is over 15 seconds old, so "pick up what I did on the PC" sees it. |
| `/clear`, `/resume`, compaction | Pulls and re-reads before giving Claude the fresh snapshot. |
| `/brain sync` | Pushes this session's notes and pulls everyone else's now; what arrives goes with your next prompt. |

Claude is told all of this at session start, along with when to call `recall`, when to offer `/handoff`, and that `/brain sync` (not `/clear`) is the fix when memory looks out of date. Sessions that started before a plugin update keep running the old code until they are restarted.

## Commands

| Command | What it does |
| :- | :- |
| `/brain` | Review what Claude learned: keep or drop each item, with the reviewer's verdict under it; apply all the reviewer's picks with one press; see the live notes it would change, and how often you've overruled it |
| `/coter-kit:review-brain` | Run the brain's outside review now (it also runs daily, as a scheduled task) |
| `/coter-kit:outside-review` | Have a change reviewed by another model before it lands, when it needs one: triage says whether a trigger fired (data that lasts, who can do what, what others depend on, what runs on its own, a big change, a fix to a high finding, a path the project marks sensitive in `.claude/review.json`); then packet, relay, verify, log, fix the class. Only a confirmed high finding blocks shipping (`docs/standard.md`) |
| `/brain sync` | Push this session's notes and pull everyone else's now (it otherwise pushes 20 seconds after a write and pulls every 2 minutes) |
| `/brain digest` | Digest this session now |
| `/phone`, `/phone setup [topic]`, `/phone test`, `/phone off` | Pushes to your phone through ntfy when a session waits on your OK or your move and you're away from the Mac. One session per machine sends them; each says only the project, the state, the minutes and the machine. Nothing is sent until you run `/phone setup` (`docs/phone.md`). |
| `/waiting`, `/waiting all`, `/waiting list` | What is waiting on you: mockups to review, questions to answer, sign-offs. Each item opens as a question card, the same one Claude uses to ask you something. Click one of its answers (the first is Claude's pick), type your own, or pick Later. Closing the card stops. An answer is saved as a decision every session gets, and the item leaves the list. Then one session acts on it without you typing anything more: the one that asked, while it runs, or else a session of the question's project on this machine gets a prompt of its own once it is idle. From the home dashboard only a tapped choice does that; a typed answer waits for you in the session. `list` prints the items with their links instead. Claude adds an item whenever it publishes something for you to look at or asks a decision you may answer later. The home dashboard can show the same choices and answer them (`docs/live-status.md`, "Answering from outside a session"). Kept in the brain, so every session and machine sees the same list; this project's items by default, `all` for every project. The band above the prompt shows the count. |
| `/handoff [note]` | Leave this conversation for the next session to pick up, on any machine: a summary with next steps, saved to the brain, written to `HANDOFF.md` on the `brain` branch, and pushed at once. Every session with coter-kit, including ones already open (within 2 minutes), shows it in the band and picks it up when you say so; it is a plan written earlier, so Claude checks it against the repo first. |
| `/timesheet [last\|days]` | A week's hours: yours, Claude's, adjustments and what to bill, across every machine. `add <project> <time> <note>` and `remove <id>` keep manual lines; `confirm [last]` finalizes a week that is over |
| `/glance` | Every running session on this machine, what needs you first: needs your OK, your move, working, idle, with the checklist step, a broken build, each session's usage and context, your 5-hour and 7-day windows, and today's time, yours and Claude's |
| `/routes`, `/routes all` | Where work was sent (here, a new session, subagents, cloud, a schedule, another model), why, and how it went |
| `/catchup` | Back in a long session: since your last message, how long and how much work, the checklist, checks and what's waiting on you, then up to six lines (Done, Doing, Decided, Needs you, Next) from the session's own transcript. Works while Claude is mid-turn. The band offers it after 30 minutes of work without you. |
| `/snapshot` | Show everything Claude is given at session start |
| `/checklist` | Open the task checklist |
| `/checks`, `/checks off`, `/checks on` | Run the checks now, or turn them off or on for this folder |
| `/coter-kit:mine-history` | Read this machine's past sessions and propose profile updates (run it once on each machine) |

The plugin also ships the `build-a-mod` skill: when you ask for something Claude Code can't do, Claude proposes a mod that adds the capability, builds and tests it, and loads it once you enable hot reloading. The skill lists what such a mod must never do (approve tool calls, change settings or permissions, hide its actions, send data somewhere you didn't name).

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

On each machine (Windows PC and Mac), in a terminal:

```bash
claude plugin marketplace add coterboat/coter-kit
claude plugin install coter-kit@coter-kit --config brainRemote=https://github.com/coterboat/coter-kit.git --config brainBranch=brain
```

It installs for your user account, so every new session on that machine loads it, in the CLI and in the desktop app. The `--config` options point the brain at this repo's `brain` branch. Leave `brainDir` out: an empty `--config` value is rejected, and with it every other option on the line.

In the desktop app's Code tab, `/plugin` only opens the app's plugin browser and ignores what you type after it, so use the terminal commands above. In a terminal Claude Code session, the slash commands also work:

```
/plugin marketplace add coterboat/coter-kit
/plugin install coter-kit@coter-kit
```

`claude plugin list` should show `coter-kit@coter-kit` as enabled. The first session clones the brain. On a new machine, run `/coter-kit:mine-history` once.

### Updating

The brain syncs on its own. New plugin code does not: auto-update is off by default for marketplaces that aren't Anthropic's. Turn it on once per machine, from a terminal Claude Code session: `/plugin` → **Marketplaces** → `coter-kit` → **Enable auto-update**. It then checks after each session starts, and the new version loads in the next session. To update by hand:

```bash
claude plugin marketplace update coter-kit
claude plugin update coter-kit@coter-kit
```

When you release, bump `version` in `.claude-plugin/plugin.json`. Installed copies update only when it changes.

## Develop

```bash
claude --plugin-dir .                        # load it for one session, reloads on save
claude plugin validate --strict .claude-plugin/plugin.json   # `.` checks only the marketplace manifest
node --check hooks/*.js                       # validate does not catch syntax errors
claude plugin test                            # 142 tests, no session or network needed
node --test tests/outside-review.test.mjs     # the outside-review scripts (16 tests), on a throwaway repo
node --test tests/timesheet.test.mjs           # the timesheet arithmetic (22 tests)
node --test tests/waiting.test.mjs tests/phone.test.mjs   # question cards, who acts on an answer, phone pushes (19 tests)
```

If `claude plugin test` says hooks modules are turned off in this process, run it with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` set. Some builds ignore that setting and leave it to a server-side switch; the Claude Code inside the desktop app (`$CLAUDE_CODE_EXECPATH` in its sessions) runs the tests.

`register.js` holds every call into Claude Code (`$`), because the validator follows `$` only within one file. `brain.js` reaches Claude Code through the small `io` adapter that `register.js` builds.
