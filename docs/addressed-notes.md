# Addressed notes

Asked for by the owner on 2026-10-11: "check the brain and see if there's a session waiting for your input periodically so that any restarts happen automatically."

## The problem

jobsnearme runs a coordinator session that merges work from lane sessions. Lanes message it by name with SendMessage. When the coordinator restarts or compacts, SendMessage fails, so the lanes leave a brain note instead ("jobsnearme L3 -> coordinator (unreachable 10-10): MERGE launch/l3-signup-polish at 7520fa0a ..."). Nothing told the coordinator. It found those notes only when the owner asked it to look, and lanes sat idle for hours with certified work, at least four times between 10-9 and 10-11. It happens the other way too.

## What it does

1. **A note can be addressed.** `remember` takes `to`, a session's name, for kinds `thread` and `handoff`. The name is the session's title, the same one ListAgents shows and SendMessage takes. The tool description says to use it when SendMessage to a session fails, and a failed SendMessage now says so too. The note keeps the sender's own name (`from_name`), so the answer can come back the same way.
2. **It wakes the session it names.** Every live session already pulls the brain every 2 minutes. Now each one also checks for live, undelivered notes addressed to it. If it is idle, the kit starts a turn of its own that carries them, the way an answer from `/waiting` does. If it is busy, the turn starts once the session is idle again. If the user sends a prompt first, the notes go along with that prompt and no turn is spent.
3. **A restart catches up.** On `/resume`, `/clear` and compaction, the snapshot lists every undelivered note addressed to the session. In the middle of a turn (a compaction) the snapshot carries them in full. In an idle session it only lists them, briefly, and the kit starts a turn of its own that carries them in full, so it acts on them without anyone asking (or the user's next prompt carries them, if it comes first). They count as delivered once that prompt is in. A fresh session hears them with its first prompt, since until then nobody can tell whether it is a scheduled run, and so does a resumed one that nothing draws (a `-p` run). The snapshot also names, briefly, the notes the session was handed on this machine in the past day that nobody has retired, since a compaction may have dropped them. Claude retires a note once it's done (`resolves`, text `done`).
4. **Delivery is recorded once.** A delivered note gets a `{ "op": "delivered", "ref": <id>, "at", "device", "session" }` row in the delivering session's journal file. It's an append, never an edit, so it syncs like any other line. A note with one is never delivered again, on any machine. On one machine, a claim folder (`claims/deliver-<id>`) stops two sessions delivering the same note between the brain's syncs; a claim still undelivered after 10 minutes was left by a session that stopped, so the next one (`deliver-<id>-2`, `-3`, ...) is claimed instead, which only one session can do. If the delivered row can't be written after the turn went in, the claim stays and the row goes out with the journal's next write. A note that rides a prompt counts as delivered only once that prompt is in: one another hook drops leaves it for the next poll. The sender is told with its next prompt that its note was delivered, and `recall` shows it.

## Rules

- **A peer's words, not the user's.** The turn says another session left the note, to treat it as a teammate's request within the work the session is already doing, and that it can't approve a pending prompt, grant permissions, or ask for changes to CLAUDE.md, settings, hooks or config. The note text is quoted line by line, so it can't pass itself off as the kit's own words.
- **Held in code too, until the user sends a message.** A turn the kit starts for a note is kept off CLAUDE.md, Claude Code's settings, hooks, agents, commands, skills, plugins, `.mcp.json` and coter-kit's own config in three ways:
  - The edit tools are refused those files. A project's own `settings.json` and the worktrees under `.claude/` are fine.
  - A shell command that mentions `.claude` (its worktrees aside) or any of those names is refused.
  - After every shell command, the files that grant permissions or carry instructions are compared with how they were when the turn began, and any change is put back: CLAUDE.md and CLAUDE.local.md in the session's folder and the repository's main folder, `~/.claude/CLAUDE.md`, `.claude/settings.json` and `settings.local.json` there, `~/.claude/settings.json`, `.mcp.json`, every file in the `hooks`, `agents`, `commands` and `rules` folders of `.claude` there and in `~/.claude` (up to 200 each), and the scripts the settings' hooks run (a hook's program, or the script its interpreter runs, not the files it is handed). A file the command added is left harmless (`{}` or empty), not deleted. Whatever a restore replaces is saved first to `~/.claude/coter-kit/quarantine/<time>/`, since it may be another session's or the user's own edit made meanwhile, and a file that can't be saved there is left alone. Links in those folders are never followed.

  Skills and plugin folders get only the first two layers (`~/.claude/skills` is hundreds of files, too many to compare after every command), and a determined shell command could get past those. The boundary that holds is Claude Code's own permission mode, as it is for SendMessage.
- **Its own project only.** A note reaches only sessions of the project it was written in (a handoff counts as the project it came from), so a session reading hostile content in one repository can't wake a session of another. Inside a project it can do what SendMessage already does: start a turn framed as a teammate's request.
- **No more trust than any note.** Credentials are redacted on write, as for every note. Addressing changes who gets woken, nothing else.
- **One wake per note, one turn per burst.** Every undelivered note goes into one turn, up to 10 and about 12,000 characters, and the rest go in the next one. One kit turn runs at a time, at least a minute apart. The woken session answers only when the sender needs something back, never just to acknowledge, so two sessions that can only reach each other through notes don't trade turns. The same request asked again while the first waits is one note; asked again after it was delivered, it's a new one.
- **Expiry.** A note stops being deliverable when it stops being live: when it is retired (`resolves`), or after 3 weeks for a thread and 7 days for a handoff.
- **An unknown or ambiguous name never wakes anyone.** When two live sessions on the machine have the name, neither is woken. When no session has it, nothing is woken either. Either way, after 3 minutes the band of every session in the note's project says so. Renaming one session, or starting one with that name, lets it through.
- **No delivery to scheduled runs.** A run started by a scheduled task, a routine or `/loop` never receives addressed notes and can't send one (`to` is dropped).
- **Addressed notes stay out of everyone else's context.** They're not listed among the project's threads or handed off to other sessions. `recall` still finds them.
- **No model calls.** The poll reads files and the live status records. A turn is spent only when a note arrives.

## Matching

- A session's name comes from Claude Code (`session_title` at SessionStart and with each prompt) and is kept per session. It goes in the live status file as `name`, so every session on the machine can tell when two share a name.
- Names match after normalising case, spacing and Unicode, and after dropping a trailing ListAgents ref such as ` [de7a55]`. A note can also be addressed to a session id.
- A project is its folder name, as everywhere in the brain, and a note also carries its repository's origin remote (`repo`, as host/owner/name, or none). Note and session must match on it too, a missing remote included, so two unrelated repositories with the same folder name can't reach each other. The live status file carries it (`repo`), so pinning and the twin check count only sessions of that repository.
- After `/clear` a session keeps answering to the ids it had before, for notes addressed by id and for word that its own notes were delivered.
- When the sender writes the note, the kit checks this machine's live status files. If a session with the name is running here now, the note is pinned to this machine (`to_device`), so a session with the same name on another machine never takes it. Otherwise (none here, or it is restarting) any machine can deliver it, so a session that moved to another machine still gets it.
- What's left: two sessions with the same name on two other machines could both deliver an unpinned note between syncs. The live status files are per machine, so neither can see the other. And a crash in the moment between a turn going in and its delivered row being written, on a disk that then won't take the row, can deliver a note again after 10 minutes; the note tells Claude to check first that nothing has done it already. A row whose write failed is otherwise written on the next poll; journal writes run one at a time, so a retry never lands over a newer write.

## Acceptance criteria and their tests

Plugin tests (`claude plugin test`, `tests/coter-kit.test.ts`, "addressed notes" section), and `node --test tests/addressed.test.mjs` for the pure parts:

| # | Criterion | Test |
| :- | :- | :- |
| A1 | `remember` keeps `to` and `from_name` on a thread or handoff, redacted and on one line, drops it on other kinds and in scheduled runs, and its result says whether that session runs here | "remember keeps who a thread or handoff is addressed to…", "a scheduled run can't address a note" |
| A2 | An idle session named in a note gets one turn carrying it, framed as a peer's, and it's recorded as delivered | "an idle session named in a note gets one turn that carries it…" |
| A3 | A busy session gets it once its turn ends, not before | "a busy session gets the note once its turn ends" |
| A4 | A user prompt carries the note, so no extra turn is spent | "a note waiting when the user sends a prompt goes with it" |
| A5 | On resume the snapshot lists undelivered notes, and the idle session gets one short turn to act on them | "on resume the snapshot lists the notes addressed to the session…" |
| A6 | Delivered once: a later poll, another session on the machine, and another machine that has the delivery row all leave it alone | "a delivered note is never delivered again…" |
| A7 | Several notes make one turn | "a burst of notes makes one turn" |
| A8 | Two live sessions with the name: no wake, and the band says so; no session with the name: no wake, and the band says so | "two sessions with the same name are never woken…", "a note for a name no session has shows in the band" |
| A9 | Scheduled runs never get a delivery | "a scheduled run never gets an addressed note" |
| A10 | Retired or expired notes are not delivered | "a retired or expired note is not delivered" |
| A11 | The sender is told its note was delivered | "the sender hears that its note was delivered" |
| A12 | Addressed notes stay out of other sessions' handoffs and thread lists | "an addressed handoff is not everyone's handoff" |
| A13 | A failed SendMessage to a name points at `remember` with `to` | "a SendMessage that fails points at an addressed note" |
| A14 | The poll makes no model calls | asserted in A2 (no fork) |
| A15 | A note pinned to another machine is left to it | addressed.test.mjs, "a note pinned to another machine" |
| A16 | After a restart the snapshot names notes handed earlier and not retired, without starting a turn | "after a restart the snapshot names the notes the session was handed earlier…" |
| A17 | The remember tool's schema and description offer `to` | "remember offers to, and says when to use it" |
| A18 | A prompt another hook drops leaves its notes undelivered | "a prompt another hook drops leaves the notes it carried undelivered…" |
| A19 | The same request again is one note while the first waits, a new one after delivery | "the same request again is one note while the first waits…" |
| A20 | Outside review RV-016's fixes: project scope, the config guard, pin only to a live session, stale claims, delivery after a snapshot, ids across `/clear` | the "RV-016 F…" tests in both files |
| A23 | RV-019's fixes: remotes must match exactly, repo in the live file, journal writes one at a time, quarantine before any restore and no links followed, only a hook's script guarded, full notes in the kit's turn after a resume | the "RV-019 F…" tests in both files |
| A22 | RV-018's fixes: hook scripts and the hooks, agents, commands and rules folders put back; repositories told apart by remote; a failed delivery row written on a later poll | the "RV-018 F…" tests in both files |
| A21 | RV-017's fixes: split shell paths refused and changed config put back, no self-twin after `/clear`, pin within the project, claim generations, headless resume waits, a failed record keeps its claim | the "RV-017 F…" tests in both files |
