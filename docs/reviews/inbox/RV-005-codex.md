CANARY: I can see repository, filesystem, and tool context beyond the packet.

### F1 · high · data-loss
File: hooks/register.js:805  
Claim: Concurrent sessions on one machine can overwrite each other. If two `/timesheet add` commands read the same prior file, each appends its own line, and the last write permanently removes the other line. A heartbeat with changed totals can similarly erase a concurrent adjustment or confirmation.  
Evidence: `saveTimesheet` performs an unlocked read-modify-write of the shared device file. The stated LOCK-1 decision does not make this safe.  
Fix: Hold a machine-wide lock across reread, mutation, and atomic replacement, or use independently mergeable per-session records.

### F2 · high · correctness
File: hooks/timesheet.js:75  
Claim: Overlapping user time on two machines is double-billed. Two records for the same project each crediting 09:00–09:15 become 30 minutes and bill 0.5 h, although the user spent 15 wall-clock minutes, which should bill 0.3 h.  
Evidence: `dayTotals` adds every beat credit, and `sheetFor` adds machine totals. The persisted format discards the intervals needed to detect cross-machine overlap, despite the output claiming user time is “never counted twice.”  
Fix: Persist compact user-time intervals and union them per project/day across sessions and machines before rounding.

### F3 · medium · correctness
File: hooks/timesheet.js:104  
Claim: `max(old,new)` loses legitimate later work after the 36-hour window rolls. If 60 minutes were persisted, then a later 30-minute beat was not rolled up before a crash, a subsequent live snapshot containing only that later beat produces `max(60,30)=60` instead of 90.  
Evidence: Each field is merged using the maximum of two aggregate totals; those totals can describe different subsets of events.  
Fix: Merge monotonic values per stable session/day key or durable event ID, then sum them. Do not take a maximum of aggregate snapshots.

### F4 · high · data-loss
File: hooks/register.js:816  
Claim: A failed write is reported as success. With a full disk, permission failure, or transient filesystem error, `/timesheet add` still says “Added,” `remove` says “Removed,” and `confirm` says “Confirmed,” although nothing was persisted.  
Evidence: `saveTimesheet` catches the write error, logs it, returns the in-memory `next` sheet, and callers unconditionally emit success and attempt sync.  
Fix: Return or throw the write failure and make mutating commands refuse to acknowledge or sync until persistence succeeds.

### F5 · high · correctness
File: hooks/timesheet.js:146  
Claim: Confirmation cannot detect an absent machine. If the PC worked Sunday while offline and its file has not reached the Mac, Monday’s confirmation sees only the Mac, reports no stale PC, and confirms an underbilled week.  
Evidence: `confirmCheck` checks staleness only among files passed to it; `readTimesheets` supplies only locally present files. There is no device roster or per-week acknowledgement with which to identify a missing machine.  
Fix: Track known devices and require a post-week sync/ack from each before confirmation, explicitly refusing or listing every missing device.

### F6 · medium · security
File: hooks/timesheet.js:118  
Claim: A project named `__proto__` causes prototype pollution and silently loses its adjustment. `/timesheet add __proto__ 1h work` is accepted, but `proj('__proto__')` returns `Object.prototype`; updating `adjust_min` mutates the global prototype and leaves no own project entry to bill. Synced bad data can trigger the same path merely by viewing a sheet.  
Evidence: User-controlled project names index ordinary `{}` objects using inherited-property lookups.  
Fix: Use `Map` or `Object.create(null)` for project/day dictionaries and validate imported records before aggregation.
