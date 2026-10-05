# Phone pushes (M5)

When a session needs you and you're away from the machine, your phone gets one push. Plain code reading the live status files (`docs/live-status.md`), no model credits. Decided 2026-10-03 (a watcher on the live files, through ntfy, and only it pushes); OK'd to build 2026-10-04 (NEXT-1018).

## How it works

- **One session per machine pushes:** the longest-running live session on that machine whose code can push (its live record says `pushes`, so a session still on older code is never picked) and that isn't a scheduled run. It looks on its heartbeat, once a minute. When it closes, the next one takes over at the next heartbeat; when it crashes, within about four minutes, once its file goes stale. Each machine pushes for its own sessions.
- **What gets a push:** a session that has waited on a permission prompt (`needs_ok`) for 3 minutes with nobody touching the machine since the prompt appeared, or finished its turn (`your_move`) 5 minutes ago and not yet turned `idle` (15 minutes). A working, idle, ended or dead session never does, and neither does a scheduled run (nobody is there to answer it).
- **Why "nobody since the prompt appeared":** the kit can't see you approve a prompt. The state stays `needs_ok` until the approved tool finishes, which can take minutes (`npm test`). Approving it is input, so an approved prompt isn't pushed. The cost: if you were at the machine when a prompt appeared and left without seeing it, it isn't pushed either (the band and undertone's call were there to tell you).
- **One wait, one push, and then quiet:** the same session in the same state since the same moment is pushed once, even across a handover. After a push, that session isn't pushed again until you've been back (any message or kit command on the machine), so a session that keeps waking itself up doesn't push all night. Several waits found together go in one push, and sessions of one project in the same state share a line.
- **Only when you're away:** the keyboard and mouse idle for 2 minutes or more, which only a Mac can tell for now. Where it can't be told (Windows, or `ioreg` failing), nothing is pushed but `/phone test`.
- **Asleep:** a sleeping Mac sends nothing. The first heartbeat after it wakes only looks.
- **Once, and again only when unsure:** each wait is claimed on the machine (a folder under `~/.claude/coter-kit/claims`, which only one process can make) before it goes out, so two sessions can't both send it and a crash can't send it twice. One the server refuses, can't reach, or doesn't answer within 15 seconds is let go and tried again 5 minutes later, so a slow one can arrive twice (never more: after two unanswered tries it counts as sent), which beats a "needs you" that never comes. If claims can't be made at all, nothing is pushed and the session's log says why. A session that dies between claiming a wait and sending it loses that push.
- **Through ntfy:** `https://ntfy.sh` by default, or your own https server. The POST goes through Claude Code's own fetch, with the token (if any) in a header.

## What leaves the machine

Per waiting session: the project's folder name, its state ("needs your OK" or "your move"), how many minutes, and the machine's name. Never the checklist, prompt text, paths, notes, branch or worktree names.

The topic is a random name only you know. ntfy.sh keeps a message for 12 hours, and anyone with the topic can read it, so treat it like a password. `/phone` shows only its first letters; `/phone setup` prints the link. Once a session has read it, the kit masks it, and the token if there is one, in anything it writes (notes, the digest, handoffs), so neither reaches the brain. For ourPlace the push names the folder and nothing from inside it.

Nothing is sent until you run `/phone setup`, which is your consent. `/phone off` stops it on that machine.

## Commands

| Command | What it does |
| :- | :- |
| `/phone` | On or off, which session pushes on this machine, and the last push |
| `/phone setup` | Makes `~/.claude/coter-kit/phone.json` with a random topic (or keeps the one it has), then prints the link to subscribe in the ntfy app. On a second machine, `/phone setup <topic>` uses the same topic |
| `/phone test` | Sends one test push now, so you can see it arrive |
| `/phone off` | Turns pushes off on this machine (`/phone setup` turns them back on with the same topic) |

## Files

- `~/.claude/coter-kit/phone.json`: `{ "v": 1, "server": "https://ntfy.sh", "topic": "<random>", "token": "", "needs_ok_after_min": 3, "your_move_after_min": 5, "away_after_min": 2, "off": false }`. `token` is for a protected server, 16 characters or more (a shorter one couldn't be kept out of the brain, so the file is refused). It stays on the machine and is never written to the brain.
- `~/.claude/coter-kit/claims/push-<session>-<state>-<since>/`: one empty folder per wait sent, so only one session sends it. Claims go after a week.
- `~/.claude/coter-kit/phone-sent.json`: which waits were pushed and when (what keeps a session quiet until you're back), `{ "v": 1, "sent": { "<session id>": { "key": "<state>@<state_since>", "at": <epoch ms> } } }`, cut down to the sessions in the live files.

## Acceptance criteria

Each is a named test in `tests/phone.test.mjs` (pure functions in `hooks/phone.js`) or `tests/coter-kit.test.ts` (the session wiring). Every guard below was broken on purpose once to watch its test fail.

1. Only the longest-running live, non-scheduled session that can push does: "only the longest-running session on the machine pushes", "only the longest-running session that can push does, so one on older code never holds it up"
2. `needs_ok` at 3 minutes and `your_move` from 5 to 15 push; working, idle, ended, died and scheduled sessions never do: "which waits get a push"
3. An approved prompt whose tool is still running isn't pushed: "an approved permission prompt is not pushed while its tool runs"
4. One wait, one push, across ticks and a handover, then quiet until you're back: "a wait is pushed once, even after another session takes over"
5. At the machine, or when it can't be told, nothing is pushed: "nothing is pushed while you are at the machine"
6. The push carries only the project, the state, the minutes and the machine: "the push carries no checklist, path, branch or worktree"
7. No config, `off`, or a config that isn't a whole version 1 file with a topic and an https server: no request: "no setup, no push"
8. In a session, the pusher posts to `<server>/<topic>`; a failed push is tried again 5 minutes later and isn't marked sent: "the pushing session posts the wait to ntfy"
9. `/phone setup` writes a random topic of at least 24 characters and prints the subscribe link, `/phone test` sends one push, `/phone off` stops them, and the topic never reaches the brain: "/phone sets up, tests and turns off pushes", "/phone off stops the next heartbeat from pushing, and setup starts it again"
