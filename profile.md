# Profile

Reviewed by the user on 2026-10-02. Built from 23 sessions on the Windows PC (June to September 2026); the Mac's sessions are still to be added.

## How to talk with them
- Be a coworker, not a yes-machine: push back and challenge an idea when you have a real reason, and say plainly when you think they're wrong. Don't play devil's advocate on every point; agree when you agree.
- Match their register: casual, direct, short. Profanity from them means excitement, not anger.
- Give short progress summaries and a clear "ready to push" when it is. Flag production and HIPAA risk early.
- The goal over time is a shared language: learn their shorthand and use it.

## Who they are and what they build
- Full-stack developer running client work and personal projects in parallel, often two or three sessions at once, on a Windows PC and a Mac. On the Max plan.
- **ourPlace** (joinourplace.com, client): disability-resources site. React (CRA) client, .NET API, Azure (SQL, AI Search, Foundry/OpenAI), a RAG chatbot persona "Megan". Backend inherited from another dev. HIPAA is a hard line.
- **jobsnearme** (Juvo 2.0, client): Next.js mobile app with Google Maps, seeker and employer signup wizards. Requirements come from client docs.
- **wallstbets**: Python trading bots on Alpaca paper (equity bot, research/overlord bots, core-satellite, EDGAR scout). The bar: beat the index or it's a fun project.
- **Iron Veil** (xcombaby): XCOM / Battle Brothers-inspired tactics game in Godot 4.7 C# with .NET sim tools, ludo.ai sprites and audio, milestone roadmap (m1, m2, ...).
- Uses Grok (Grok Build) as a second reviewer: it leaves review docs for Claude to absorb. Gemini for meeting notes.

## How they work
- Lowercase, conversational prompts; big numbered batches of fixes with screenshots, logs and pasted chat transcripts.
- Tests in the real app and reports exactly what they see ("no effect", "not seeing any change").
- Grants autonomy freely ("go wild", "keys to the kingdom", "keep cooking"), usually on a worktree or branch.
- Plan, then milestones / phases / sprints, a commit per milestone, then a Grok review.
- Likes clarifying questions one at a time and answers them numbered (1a, 1b).

## Leans toward
- Reusable patterns over one-offs; built-in services over reinventing.
- Polished, modern UI that feels "magical"; smooth motion; consistency.
- Demo-first with mock data, but with seams ready for the real API.
- Commenting out with TODO notes rather than deleting.
- Theorycrafting before building; honest grades; verifying against real data, not logs.
- Games: fun first, not a clone; systems that tell the story.
- Docs kept current but light, not "a million bulleted rules".

## Dislikes
- "Done" when the change isn't visible: prove a fix runs in the path the app actually uses.
- Touching what already works, or another dev's workflow.
- Generic AI slop, and bots that answer vaguely when the data has the specific answer.
- Deploying during client demos. They push to prod themselves once told it's ready.
- Losing a session's context.
