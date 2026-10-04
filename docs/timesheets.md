# Timesheets

`/timesheet` shows a week of work in three columns and the hours to bill. The definitions are in `build-plan.md` ("Billable time"); this page is the file format and the rules the code follows (`hooks/timesheet.js`, tested by `tests/timesheet.test.mjs` and the M4 tests in `tests/coter-kit.test.ts`).

## Where

One file per machine, in the brain: `timesheets/<machine>.json`. A machine writes only its own file, so the brain's sync never has two machines editing the same file. A week is every machine's file added up. The machine name is the one the brain's journal uses.

A session rewrites its machine's file at most every 10 minutes (on its heartbeat), when it ends and on every `/timesheet`, and only when something in it changed.

## The file (version 1)

| Field | What it holds |
| :- | :- |
| `v`, `device`, `updated_at` | `1`, the machine's name, when it last looked |
| `days` | `{ "<YYYY-MM-DD>": { "<project>": { you_ms, claude_ms, claude_wall_ms, scheduled_ms } } }`, local days |
| `adjustments` | Manual lines: `{ id, date, project, min, note, at }`. `min` is signed, in multiples of 6 |
| `confirmed` | `{ "<Monday>": { at, device, billed_min: { "<project>": minutes } } }` |

- `you_ms`: your time. The credit of each beat (a message, a kit command), which the status file already holds (`docs/live-status.md`). A beat counts on the day it happened and never more than the minutes since midnight. Scheduled runs earn none.
- `claude_ms`: minutes a main-thread turn ran, summed over the project's sessions on this machine (a turn still running counts up to the last heartbeat). `claude_wall_ms` is the same turns as wall clock, parallel sessions once. `scheduled_ms` is the part of `claude_ms` that scheduled runs did.
- The status files keep only 36 hours of beats, so a day already in the file never shrinks: each field keeps the larger of what the file has and what the live files say now.

## Hours billed

For each project, for each day: `your time` rounded up to the next 6 minutes (0.1 h), added over the week and over every machine; plus the adjustments. Two machines' time on one day is added before it is rounded, so it bills the same as if one machine had done both.

Manual lines: `/timesheet add <project> <time> [date] <note>`, for example `1.5h`, `45m` or `-30m`. The size rounds up, away from zero, to 6 minutes. A line is at most 24 hours. `/timesheet remove <id>` works on the machine that added it.

## Confirming a week

Weeks run Monday to Sunday. `/timesheet confirm` (or `confirm last`) is refused until the week is over. It records the hours billed per project and names any machine whose file stopped before the week ended, since its last hours may still be on that machine. After that `/timesheet` shows "confirmed", and "changed since you confirmed" if a late sync or a new line moves a project's hours.

## One clock

This is the only clock for your time. undertone's `npm run week` and `GET /timesheet` count Claude's hours from its own event log (minutes in which a session did anything or was working, summed or as wall clock); they have no clock for your time. The two definitions of Claude's time differ and wait for your pick (waiting note M4-Q1); until then, coter-kit shows turn minutes and keeps the wall-clock figure in the file for comparison.
