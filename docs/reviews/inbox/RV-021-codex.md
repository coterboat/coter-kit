CANARY: repository, tools, and environment context are visible beyond the packet.

### F1 · high · correctness
File: skills/fold-profile/SKILL.md:18
Claim: Folding can silently remove an approved rule from every busy session. With the measured crowded brain, only the profile’s first section fits; if a preference is folded into “How they work,” step 6 supersedes its note, while `fitProfile()` drops that later section. The next session receives neither copy.
Evidence: The skill retires every folded preference. `hooks/brain.js` makes the profile optional, keeps only leading sections that fit, and the packet explicitly says only “How to talk with them” fits current busy projects.
Fix: Never retire a preference unless its replacement is stored in an always-reserved rules block and verified to fit. If it cannot fit, leave the preference active and report that the fold is incomplete.

### F2 · medium · correctness
File: hooks/brain.js:433
Claim: The advertised “newest 25” rule is false when project preferences exist. Given one six-month-old project preference and 25 newer global preferences, `shownPrefs` puts the old project item first and silently drops the oldest global item—even though that global item is newer.
Evidence: The code concatenates all project preferences before all globals, then applies `.slice(0, PREFERENCE_CAP)`. The fold skill states that sessions receive the newest 25.
Fix: Apply the cap to the already filtered, newest-first `prefs` array, then separate the selected entries for budget/display priority.

### F3 · medium · correctness
File: hooks/brain.js:449
Claim: A crowded session can lose all of its own handoffs even when one fits. If two same-project handoffs collectively exceed the remaining room, `optional.handoff` returns an empty string instead of retaining the newest whole handoff.
Evidence: It joins every `own` handoff into one string and keeps that string only when its aggregate length fits.
Fix: Add handoff blocks individually in newest-first order until the next whole block does not fit.

### F4 · medium · reliability
File: hooks/brain.js:649
Claim: Empty-query preference and term recall can produce an arbitrarily large tool response. Terms have no TTL, so a large or corrupted journal containing thousands of 400-character terms can return megabytes at once and make recall—or the session consuming it—unusable.
Evidence: The `LISTABLE` branch sorts and returns every matching live entry without a limit or cursor; the test explicitly requires uncapped output.
Fix: Add bounded pagination with a cursor and make `fold-profile` iterate through pages.
