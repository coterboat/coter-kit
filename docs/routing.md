# Where work runs

A starting playbook, written 2026-10-03. The route log tests it: every routing choice is saved as a `route` note with its reason, then its outcome, and `/routes` lists them. Change the playbook when the log says otherwise.

Claude Max is the main build resource, so it is the budget to manage. A session pays for its whole context on every turn. That makes a long session's turns expensive, and it makes fresh context with a tight brief cheap.

| Option | Use it when | What it costs, what it can't do |
| :- | :- | :- |
| **Here** (this session) | The work needs what this session already knows, and it's short | Every turn re-reads this whole session. Once its context is past about half full, move new, unrelated work out |
| **New local session** (a task chip, `/handoff`, a brief file) | A separate repo or product, or a long piece of work this context would only slow down | A cold start, so write a brief. It has the brain, the kit, local files and local dev servers |
| **Subagents** (Agent tool) | Searches, checks or reviews that fan out and only need a conclusion back, or independent parts of a task in parallel | Each has its own context and only its summary comes back. A search can run on a cheaper model. A subagent can't ask you anything |
| **Cloud session** | Long autonomous work on a pushed repo that doesn't need this machine (refactors, migrations, test runs), or when the Mac will sleep | No local files, no coter-kit brain or kit, no local dev servers, browser pane or simulator. Works from GitHub only |
| **Remote Control** | Steering a local session from your phone | The same as local. The machine has to be on |
| **Scheduled task** (desktop) | Recurring work that needs this machine (the brain, local repos) | Runs while the app is open, one fresh session per run, with the lean brain |
| **Cloud routine** | Recurring work that needs only GitHub or connectors | Runs with the Mac off. No local access |
| **Workflow** (many agents) | Only when you ask for one | Heavy usage, at the scale of dozens of agents |
| **Another model** (Grok Bot, Gemini) | A second opinion from a different model, or a sense Claude lacks (audio) | Their credits. Keep their notes on their side of the brain |

Rules of thumb:

- Say which option you picked and why in one line, before starting.
- Look at `/glance` before fanning out. It shows each session's usage and your 5-hour and 7-day windows. Near a limit, use fewer subagents, or leave the work for a scheduled run.
- Record the choice: `remember` with kind `route`, a `where`, the task and the reason. Record the outcome when it's done: kind `route`, `resolves` set to the first note, with the time it took, the usage (from `/glance` or the subagent's report) and what went well or didn't.
