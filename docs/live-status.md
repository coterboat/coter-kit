# The live status file

Every Claude Code session with coter-kit writes one small JSON file describing itself, so other tools can read a session's state instead of parsing transcripts or spending model credits to work it out. Today's readers are `/glance` and the band ("elsewhere: … needs your OK"). undertone, the home dashboard (`coterboat/home`, session source 1 in its spec) and a phone notifier read the same file.

## Where

`~/.claude/coter-kit/live/<YYYY-MM-DD>/<session id>.json`. The date is the local day the session opened. Read every day folder, since a session left open across midnight stays in the folder of the day it opened. If a session id shows up twice, keep the fresher record. Folders older than 7 days are removed when a session starts.

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
| `project`, `worktree`, `branch` | Where it runs: the repository's name, the worktree's folder name (or `""`) and the branch. No absolute paths |
| `name` | The session's title, as ListAgents shows it and SendMessage takes it, or `""` until Claude Code gives one. Notes addressed by name are matched against it, and two live sessions with the same one are never woken (`docs/addressed-notes.md`). Absent in sessions on older code |
| `repo` | The repository's origin remote as host/owner/name, no credentials, or `""` without one. It tells apart two repositories that share a folder name. Absent in sessions on older code |
| `opened_at`, `updated_at`, `last_event_at` | ISO times |
| `state`, `state_since` | `working` (mid-turn), `needs_ok` (a permission prompt is waiting), `your_move` (turn finished, waiting on you), `idle` (`your_move` for 15 minutes or more, or nothing yet), `ended` |
| `scheduled` | `true` for a run started by a scheduled task, a routine or `/loop`. It is never `your_move` and earns you no time |
| `pushes` | `true` when the session's code can send phone pushes, so it may be the one that does (`docs/phone.md`). Absent in sessions on older code |
| `checklist` | `{ title, done, total, current, blocked }`, or `null` |
| `checks`, `build_broken_since` | The last automatic check (`{ state, summary, at }`), and since when the build has been broken, or `null` |
| `needs_you` | Per project: `{ waiting, waiting_refs, handoff, review }`. These are the same for every session of the project, so count each project once |
| `minutes_today` | `{ you, claude }`: your time and Claude's since local midnight (definitions in `build-plan.md`, "Billable time") |
| `usage` | `{ cost_usd, context_pct, context_tokens }`: what the session has used so far at API prices (as `/cost` totals it; on a Max plan that counts toward limits and isn't billed), and how full its context is |
| `rate_limits` | The account's windows from the last API response: `[{ kind, percent_used, resets_at }]`, such as `five_hour` and `seven_day`. They're the same in every session, so take the freshest |
| `last_beat_at`, `beats`, `turns` | The raw material for timesheets, for the last 36 hours. `beats` are `[at, credited ms]`, `turns` are `[start, end]` in epoch ms. Sum `beats[i][1]` across every session's file for your time; per-session credits already exclude time counted in another session |

## Privacy

No prompt text, file paths (not even the session's own folder), commands or note contents. The pieces of your own wording are `checklist.title`, `checklist.current` and `name` (a session's title is often drawn from its first prompt), so anything that sends a record off the machine (home-agent posting to Grok Bot, a phone push) redacts or drops them.

## Answering from outside a session

`needs_you.waiting` counts the questions you owe. The questions themselves are `waiting` notes in the brain's journal (`~/.claude/coter-brain/journal/**/*.jsonl`), and `/waiting` shows each one as a question card to click. A reader that shows them, such as the home dashboard, can offer the same choices:

- **The question:** a journal row with `kind: "waiting"`. It has `id`, `text` and `project`, and may have `ref` (a short label such as `"Q8"`), `link` and `options`. `options` is two or three short answers, and the first is the recommended one. With no `options`, offer `Yes, or done` and `No, drop it`. Always offer Later (do nothing) and a typed answer.
- **Still open:** it is open until a later `{ "op": "status", "ref": <id> }` row marks it otherwise, or until it is 30 days old.
- **The answer:** write `~/.claude/coter-kit/answers/<id>.json`, containing `{ "v": 1, "id": "<id>", "answer": "<the choice or the typed text>", "at": "<ISO time>", "from": "home" }`. Write it to a temporary name and rename it, so a session never reads half a file.

Any coter-kit session on the machine picks it up within two minutes, or at once on `/waiting`. The session saves the answer as a decision that resolves the question, so every session and machine gets it. The answer is redacted and cut to 300 characters.

**Then one session acts on it**, with a prompt of its own that starts a turn once it is idle and names the answer. Every session on the machine where the answer was given works out which from these files: the session that asked, while it runs; else the session the answer was given in, when it is of the question's project; else the longest-running session of that project. Scheduled runs never act, and with no session of the project running, the answer stays a decision for the next one to read. Answers given in `/waiting` follow the same rule. Since anything that can write your home folder can write an answer file, only a tapped choice starts a turn: one of the question's own `options`, or `Yes, or done` / `No, drop it` when it has none. Those words were Claude's to begin with. A typed answer is saved with `"typed": true` and never starts a turn; Claude hears it with your next message in a session of its project. Both carry `"outside": true`. Each answer is acted on once per machine: the acting session claims it first (a folder under `~/.claude/coter-kit/claims`), and if two sessions save an answer to the same question, only the first decision is acted on.

Only an open `waiting` note can be answered this way. A file for an answered question, an unknown id, or a note that is not a question is ignored, and so is a file whose `id` doesn't match its name. Sessions never delete these files. The writer can remove a file once its question is closed, or leave it.

The folder accepts answers from anything that can write to your home folder. A dashboard reachable from the phone writes only what you tapped, and only over the tailnet.

## Reviewing from outside a session

The notes waiting for review are journal rows with `"status": "pending"` (preferences and terms you haven't confirmed, and what the digest kept). The reviewer's verdict on a note is the latest `{ "op": "review", "ref": <id> }` row, with `verdict` (accept, reject, rewrite, merge, retire or ask), `reason`, `evidence`, sometimes a `replacement`, and `at`. A reader such as the home dashboard can offer the `/brain` pane's buttons:

- **Write** `~/.claude/coter-kit/reviews/<id>.json`, containing `{ "v": 1, "id": "<id>", "decision": "keep" | "drop" | "take" | "pick", "verdict_at": <the verdict's at, or null>, "at": "<ISO time>", "from": "home" }`. Write it to a temporary name and rename it.
- **keep** puts a note waiting for review live, and keeps a live note the reviewer would change as it is. **drop** rejects a note waiting for review. Against the reviewer's verdict, either counts as an overrule.
- **take** carries out the reviewer's verdict on that one note, as the pane's take button does.
- **pick** carries it out as one of "Apply the reviewer's picks": only while the note is still one of the picks, so a frozen verdict, or one that would change your own note or a live decision, is never applied this way.
- `verdict_at` pins the file to the verdict it was made against. A newer verdict, or your own decision since, makes the file stale, and it does nothing.

Any coter-kit session on the machine carries a file out within two minutes, or at once on `/brain`. Only one does: each file is claimed per verdict under `~/.claude/coter-kit/claims`. Unattended sessions leave the folder alone. Nothing but the one word and the number reaches the brain, and sessions never delete these files: the writer removes one once the note shows the change, or leaves it.
