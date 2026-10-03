# The live status file

Every Claude Code session with coter-kit writes one small JSON file describing itself, so other tools can read a session's state instead of parsing transcripts or spending model credits to work it out. Today's readers are `/glance` and the band ("elsewhere: … needs your OK"). undertone, the home dashboard (`coterboat/home`, session source 1 in its spec) and a phone notifier read the same file.

## Where

`~/.claude/coter-kit/live/<YYYY-MM-DD>/<session id>.json`. The date is the local day the session opened. Read today's folder and yesterday's. Folders older than 7 days are removed when a session starts.

## When it's written

- On every change of state, at most once a second.
- Every 60 seconds as a heartbeat.
- At once when the session closes.

**A file whose `updated_at` is more than 3 minutes old belongs to a session that died.** A closed session says `"state": "ended"`.

## Fields (version 1)

| Field | What it holds |
| :- | :- |
| `v` | `1` |
| `tool` | `"claude"` |
| `id` | The Claude Code session id |
| `device` | The machine's name (`alexs-macbook-pro`, `bld`), the same name coter-kit's brain uses |
| `project`, `worktree`, `folder`, `branch` | Where it runs. `worktree` is the worktree's folder name, or `""` |
| `opened_at`, `updated_at`, `last_event_at` | ISO times |
| `state`, `state_since` | `working` (mid-turn), `needs_ok` (a permission prompt is waiting), `your_move` (turn finished, waiting on you), `idle` (`your_move` for 15 minutes or more, or nothing yet), `ended` |
| `scheduled` | `true` for a run started by a scheduled task, a routine or `/loop`. It is never `your_move` and earns you no time |
| `checklist` | `{ title, done, total, current, blocked }`, or `null` |
| `checks`, `build_broken_since` | The last automatic check (`{ state, summary, at }`), and since when the build has been broken, or `null` |
| `needs_you` | Per project: `{ waiting, waiting_refs, handoff, review }`. These are the same for every session of the project, so count each project once |
| `minutes_today` | `{ you, claude }`: your time and Claude's since local midnight (definitions in `build-plan.md`, "Billable time") |
| `last_beat_at`, `beats`, `turns` | The raw material for timesheets, for the last 36 hours. `beats` are `[at, credited ms]`, `turns` are `[start, end]` in epoch ms. Sum `beats[i][1]` across every session's file for your time; per-session credits already exclude time counted in another session |

## Privacy

No prompt text, file paths, commands or note contents. The one piece of your own wording is `checklist.title` and `checklist.current`, so anything that sends a record off the machine (home-agent posting to Grok Bot, a phone push) redacts or drops them.
