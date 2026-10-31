# audiohelper

### Todo

- [ ] **OPEN, 2026-10-17 — the 32 MiB cache budget is a judgement, not a measurement.**
  It is chosen to hold a healthy set of short effects while refusing a two-minute music
  track, but no phone or desktop has measured decode cost, memory pressure or whether
  evicting at that size causes audible re-decodes. The limit is runtime-tunable
  (`setAudioCacheLimit`), so this is a tuning question rather than a correctness one.

- [ ] **OPEN, 2026-10-31 — `playStream` has only been tested with fakes.**
  It needs a real browser pass on desktop, iOS and Android: autoplay retry from a
  gesture, `MediaElementAudioSourceNode` with and without CORS, fade scheduling, and
  cleanup when a track is stopped mid-fade.

### In Progress

### Done ✓