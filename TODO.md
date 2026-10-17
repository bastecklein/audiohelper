# audiohelper

### Todo

- [ ] **OPEN, 2026-10-17 — the 32 MiB cache budget is a judgement, not a measurement.**
  It is chosen to hold a healthy set of short effects while refusing a two-minute music
  track, but no phone or desktop has measured decode cost, memory pressure or whether
  evicting at that size causes audible re-decodes. The limit is runtime-tunable
  (`setAudioCacheLimit`), so this is a tuning question rather than a correctness one.

### In Progress

### Done ✓