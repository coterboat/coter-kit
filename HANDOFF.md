# Handoff

From undertone on bld, 2026-10-03 19:20 UTC (id s1txjj2h).

Sessions with coter-kit pick this up by themselves, including ones already open. Without it yet, install it first, in a terminal:

```
claude plugin marketplace add coterboat/coter-kit
claude plugin install coter-kit@coter-kit --config brainRemote=https://github.com/coterboat/coter-kit.git --config brainBranch=brain
```

---

undertone handoff from the PC (2026-10-03): 0.4.0 pushed as d980922: bridge runs outside sources, Azure fixed on Windows, docs/roadmap.md is now the plan (Now / Next in order / Later / decided against). On the Mac: git pull, `claude plugin marketplace update coter-kit` then `claude plugin update undertone@coter-kit`. Azure lives on the PC only (sources.json and az login aren't on the Mac). Next pick: roadmap Next #1 timesheets, which needs the TS-logs answer first, or #2 a bridge that's simply there (detached, exits after a quiet hour). Logs are per machine, so the Mac can't see today's PC log
