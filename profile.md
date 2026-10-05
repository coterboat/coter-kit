# Profile

Reviewed by the user on 2026-10-02; the Mac's additions approved on 2026-10-04. Built from 23 sessions on the Windows PC (June to September 2026) and 107 sessions on the Mac (alexs-macbook-pro, July to October 2026).

## How to talk with them
- Be a coworker, not a yes-machine: push back and challenge an idea when you have a real reason, and say plainly when you think they're wrong. Don't play devil's advocate on every point; agree when you agree.
- Partner, not employee (their "Jarvis" model): they're big picture and see what can be; Claude gets them there, helps shape it, and raises what they're missing. Don't let politeness get in the way of the truth.
- Match their register: casual, direct, short. Profanity from them means excitement, not anger.
- Give short progress summaries and a clear "ready to push" when it is. Flag production and HIPAA risk early.
- Ask clarifying questions numbered, with lettered options and your pick (Q18: a/b). They answer inline in one batch ("18: a) 19: yes"). Go one at a time only when a decision needs thinking through ("ask me each of the fs-067 questions sequentially").
- The goal over time is a shared language: learn their shorthand and use it (saved as term notes).

## Who they are and what they build
- Full-stack developer running client work and personal projects in parallel, often several sessions at once, on a Windows PC and a Mac (most building happens on the Mac; Azure and SQL Server work needs the PC's whitelisted IP). On the Max plan.
- Models: Fable 5.1 to coordinate, Opus 5.5 when Fable's credits run out; they hit usage limits often. Subagents should run on cheaper models when the task is well defined. Leftover usage gets spent before a reset. Generous with asset credits (Ludo), careful with Claude tokens.
- **ourPlace** (joinourplace.com, client): disability-resources site. React (CRA) client, .NET API, Azure (SQL, AI Search, Foundry/OpenAI). Its RAG chatbot speaks as Megan, the site owner; /ourplacesv2 went live 2026-10-01 with an ElevenLabs voice. Backend inherited from another dev (the Deploy API is still tied to them). HIPAA is a hard line.
- **jobsnearme** (Juvo 2.0, client Juvo, Mark Emery): Next.js web app, desktop-first demo (/demo) plus a Capacitor Android app; Supabase (Postgres, GoTrue, RLS) dev DB; GitHub Pages deploy behind e2e gates; Google Maps, ingested Juvo jobs, Atlanta demo data, Juvo score, commute cost, "On the way" nearby services. Built through a spec pipeline (FS specs → critic → implementer → Codex review packet → tester, in waves); they apply migrations and sign compliance themselves. Investor demo at ThinkEquity, NYC, 2026-10-15.
- **wallstbets**: Python trading bots on Alpaca paper (equity bot, research/overlord bots, core-satellite, EDGAR scout). The bar: beat the index or it's a fun project.
- **Iron Veil** (xcombaby): XCOM / Battle Brothers-inspired tactics game in Godot 4.7 C# with .NET sim tools, ludo.ai sprites and audio, milestone roadmap (m1, m2, ...).
- **EO7**: kids' point-and-click adventure in Godot (GDScript) for their mom's book series (Max the dog; burrow, creek, loch). The bar is Lost in Play, Freddi Fish, Pajama Sam. Ludo.ai sprite, animation and audio pipeline with house tools; Grok reviews every round; a worktree per feature.
- **concurrent**: a Risk 2 "same time" successor in Godot, built for their dad (maybe Steam one day): simultaneous turns, Fortune, commanders with cloned voices (VoiceStudio, ElevenLabs), 3D diorama battles with a 2D map toggle, a review table to accept or reject generated assets, Grok playtest bots on every push.
- Smaller: ascendant (Godot, Grok-bot testbed, going 3D), chesssensei (personal chess trainer, a Stockfish PWA wrapped as a Mac app), tablehand (AI-run D&D on Discord for friends), a Shopify loyalty app from the "foundry" money idea, quick sites for friends.
- Their own tooling: hellskitchen (the first multi-agent dashboard) led to coter-kit (this memory), undertone (live sessions as background music) and home (a local launchpad).
- Other models: Codex (ChatGPT Plus since 2026-08-15) is the per-spec hostile reviewer, driven by Claude directly; Grok (Grok Build, Grok bot on GitHub) is the red team and "are we smoking crack" check, the playtest bots, and sometimes a builder; Gemini for meeting notes.

## How they work
- Lowercase, conversational prompts; big numbered batches of fixes with screenshots, logs and pasted chat transcripts.
- Tests in the real app and reports exactly what they see ("no effect", "not seeing any change"). Walks: Claude queues numbered steps (or walks it itself with screenshots), and they report back by number ("1. confirmed 2. ..."). For games, they play full games and note things as they go.
- Grants autonomy freely ("go wild", "keys to the kingdom", "keep cooking"), usually on a worktree or branch; leaves sessions cooking overnight and checks in from the phone.
- Runs several sessions in parallel and expects them to coordinate: message each other, separate worktrees, commit by explicit path, don't step on toes.
- Plan, then milestones / phases / specs in waves, a commit per milestone, then an outside review (Codex per spec, Grok for milestones and red team). Wants that loop closed: Claude relays to the reviewer itself instead of them pasting.
- Client meetings drive the next round: Gemini notes and transcripts land in the repo's docs.
- They apply DB migrations, sign off specs and push to prod themselves.

## Leans toward
- Reusable patterns over one-offs; built-in services over reinventing.
- Polished, modern UI that feels "magical"; smooth motion; consistency.
- Demo-first with mock data, but with seams ready for the real API.
- Commenting out with TODO notes rather than deleting.
- Theorycrafting before building; honest grades; verifying against real data, not logs.
- Moving on once nothing truly blocks: past a point, more review rounds cost more than they find ("is this just semantics at this point or is this a genuine blocker?"). Pragmatic about LOC caps and doc wording.
- Games: fun first, not a clone; systems that tell the story; "it's all about the feel"; small handcrafted touches. "Forgot I was testing" is the bar.
- Legal caution scaled to real harm: don't let hypothetical legal worries block the right build unless something would genuinely hurt them. HIPAA and seeker privacy stay hard lines.
- Data, but "only if it's not noise"; loves BI.
- Docs kept current but light, not "a million bulleted rules".

## Dislikes
- "Done" when the change isn't visible: prove a fix runs in the path the app actually uses.
- Claude skipping its own documented steps (the review packet, the spec before the build). They read it as context overload: compact or start fresh.
- Touching what already works, or another dev's workflow.
- Generic AI slop, and bots that answer vaguely when the data has the specific answer.
- Alerts that don't say what failed ("just a fire alarm"); constant tones as status.
- Relaying text between agents by hand.
- Deploying during client demos. They push to prod themselves once told it's ready. (Under demo pressure they'll ask to ship past the gates and fix after.)
- Losing a session's context.
