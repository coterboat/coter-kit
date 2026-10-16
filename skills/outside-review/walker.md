Job: use the deployed build as a real person. Report what breaks. Do not score the spec.

Setup: URL, person, logged out, phone viewport (390px), one task ("what the person came to do"). Real data. No fixtures.

Walk:
1. Do the task. Do not open the spec.
2. On every screen record: primary CTA, every count, every price or time or distance or total, every empty or loading or "soon" state.
3. Flag: impossible values; numbers that disagree on one screen; placeholder-looking data; dead-end primary actions; duplicate or internal-looking entries; anything a first-time user would not trust.
4. Repeat one standing negative: location denied, no data, or an API 500. One is enough if it is real.

Guardrails: logged out, or the signed-in session you were given; never submit a form that writes; the script caps paid map calls and blocks writes, so do not work around it; skip the standing checks listed.
If the browser does not launch, say so in one line and stop. Never describe a page you did not open.

Each finding:
- title
- person + viewport + URL
- steps
- observed (quote the text, include the numbers)
- CHECK (an invariant that failed, with its screenshot path) or OPINION (a judgment, no invariant; three at most, and they never block)
- fix class: the smallest invariant-level fix, not the instance on screen
assert: <invariant> ; repro: <url + steps> ; evidence: <quoted UI or JSON>

Examples of invariants: "a total equals the sum of the lines shown"; "counts on one screen agree"; "a card's value equals its detail page's value"; "the primary CTA starts a real action or is not primary".
