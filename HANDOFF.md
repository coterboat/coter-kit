# Handoff

From jobsnearme on alexs-macbook-pro, 2026-10-17 04:18 UTC (id vzfurp0c).

Sessions with coter-kit pick this up by themselves, including ones already open. Without it yet, install it first, in a terminal:

```
claude plugin marketplace add coterboat/coter-kit
claude plugin install coter-kit@coter-kit --config brainRemote=https://github.com/coterboat/coter-kit.git --config brainBranch=brain
```

---

Lane G go-live kit, branch lane-g/go-live-kit, all pushed, tree clean. Built: FS-740,741,742,743,744,745,746 (incl. AMENDMENT 2 after tester FAIL, scope.head bbfc0bf9),747,748,749 (built 4a3fd307, record fcb43616, in_progress). All specs still in_progress until recorded runs + one certify. REMAINING (all need /tmp/jnm-certify.lock, ONE slot, order C,T,E then G): FS-740 TC-2 (db:local, check:rls+ownership against it, evidence docs/90-evidence/lane-g-2026-10-16/db-local-gates.md, db:local:stop); FS-746 TC-2 (db:local --lane G --dir <no-op 0000_noop.sql>, db:migrate --init-ledger scratch ledger, --env-file outside repo, second run applies nothing, evidence db-migrate-run.md); FS-749 TC-3 = the AC-6 sequence (db:local --dir noop; write stack-env file outside repo = db:local export lines + NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY/SERVICE_ROLE_KEY from supabase status -o env --workdir $TMPDIR/jnm-db-local; rehearse build --stack-env; db:migrate; rehearse run; rehearse down; db:local:stop) and REPLACE the 64-zero nginx digest in scripts/rehearsal/compose.yml with docker buildx imagetools inspect nginx:1.27-alpine; also FS-743 TC-5/6, FS-744 TC-3, FS-745 TC-3, FS-741 TC-2 ride that run; OOM at docker build = stop, record, ask director (VM stays 2CPU/2GB). Then ONE lane certify (full gate list, build/next is 4890d41e at 10-17: rebase/merge first, recheck 0072 is next free migration number), flip specs in_review, message director a certified sha. Plan one outside review round for the kit's push (triage fires: runs on its own, others depend on it). LOCK PATTERN (director): background holder script scratchpad/hold-lock.sh polls until lock absent or dead pid (rm only if unchanged), noclobber create with its own $$, trap removes only own line; never overwrite/delete another lane's line; if classifier refuses, stop and tell director the exact command. Holder tasks were stopped for restart; relaunch: exec hold-lock.sh <flag> in background + Monitor on its output for HOLDING. Tier rules now coter-kit 0.15.0 standard: Light no critic/tester; Standard 1 critic (2 max)+tester; Full adds threat model + owner signoff.
