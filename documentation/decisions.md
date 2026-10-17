# Decisions

## 2026-10-17 — The decoded-audio cache is a byte-bounded LRU, and long tracks can opt out

**Decided:** `retainedBuffers` changed from an unbounded plain object to a
**least-recently-used map with a byte budget**, defaulting to **32 MiB of decoded PCM**. A
buffer larger than the whole budget plays but is never retained. `playAudio` gained
**`retain: false`**, which skips both the cache read and the cache write. Four management
functions were exported: `clearAudioCache()`, `releaseCachedAudio(key)`,
`setAudioCacheLimit(bytes)` and `getAudioCacheStats()`. The cache remains on by default,
so short sound effects keep their existing decode-once behaviour without any call-site
change. **The retention itself is not the flaw** -- it exists so a sound effect that is
played repeatedly pays its decode once and starts without a decode hitch; the flaw was
that it had no ceiling. While touching the buffer path, a tagged `ArrayBuffer`/byte-array
source was fixed: a cache miss used to leave `buffer` null and return without decoding, so
the first play of a tagged buffer was silent.

**Why the old shape was a design flaw rather than a missed optimisation:** the cache was
keyed by URL or tag and never evicted. Retaining a click or an alert -- a few kilobytes
decoded once -- is reasonable and buys a real latency win on every later play. The trouble
is that the same rule applied to a two-minute stereo track at 44.1 kHz, which decodes to
roughly **42 MB of float32 PCM**; a shuffled music library therefore retained every track
it had played for the life of the page. The caller cannot be relied on to know that:
`playAudio(path)` looks like a one-shot operation, and the retention is invisible in its
signature. Keeping the cache and bounding it preserves the first case without the second.

**Why an LRU by bytes, not a maximum entry count or a time-to-live:** entry count treats a
50 ms click and a two-minute song as equal, and time does not bound memory at all. Bytes
are the resource that actually runs out, and an LRU is the policy that keeps the working
set -- the effects a game is playing repeatedly -- while letting one-shot long media fall
out. A single buffer over the budget is refused outright so one large file cannot evict a
whole set of small, useful effects.

**Why 32 MiB is the default:** it comfortably holds a few hundred ordinary effects while
refusing a two-minute music track, which is the split this library actually serves. It is
a judgement, not a measurement, and it is recorded OPEN in `TODO.md`; the limit is runtime
tunable so a host with a measured budget can say so.

**Why `retain: false` exists when the LRU already bounds memory:** a caller playing long
media knows the buffer will never be reused, so decoding it into the cache only to evict
it later is wasted work and one unnecessary large allocation. The default stays `true`
because the common case -- repeated short effects -- is exactly what should be cached.

**Dropping a cached buffer is safe while it plays.** An `AudioBufferSourceNode` keeps its
own reference to the `AudioBuffer`, so `clearAudioCache()` and `releaseCachedAudio()` do
not cut off a sound that is already playing; the memory is released when the source ends.
That is what makes the management API safe to call on a scene change.

**Verified:** `npm test` **12 passing, 0 failing** in the new `test/cache.test.mjs`; ESLint
clean on `audiohelper.js` and the test. The test fakes only `AudioContext` and `fetch`, so
the LRU, the opt-out, the limit changes and the tagged-buffer path are the real code. No
browser has played audio in this environment.
