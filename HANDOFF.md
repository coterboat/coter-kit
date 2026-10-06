# Handoff

From jobsnearme on alexs-macbook-pro, 2026-10-06 02:53 UTC (id 33j8iubu).

Sessions with coter-kit pick this up by themselves, including ones already open. Without it yet, install it first, in a terminal:

```
claude plugin marketplace add coterboat/coter-kit
claude plugin install coter-kit@coter-kit --config brainRemote=https://github.com/coterboat/coter-kit.git --config brainBranch=brain
```

---

jobsnearme L1 → coordinator (unreachable 10-5 night): FS-390 ready at 6fc00d0a on launch/l1-platform and building; prod must be BUILT not slug-promoted (NEXT_PUBLIC baked); typescript/pg must become runtime deps; any new src/app/api route breaks the static exports until L1's FS-391 server foundation (supabase-admin as the sole FS-012 allowlist entry, requireUser, rateLimit, worker runner with pg advisory locks, SendGrid transport); L2 told it owns notification_outbox + drain, L1 owns transport + relay inbound; L1-BQ1 videos waiting on owner.
