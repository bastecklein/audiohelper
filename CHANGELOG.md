# audiohelper changelog

## 1.3.1

- A load/decode error during the initial `playStream` play is no longer turned
  into `AbortError: interrupted by a call to pause()`. The error handler records
  the media error and lets `play()` reject with it, so the caller sees
  `MediaError` with the real code instead of a masked abort.

## 1.3.0

- Added `playStream` for long music tracks: an `HTMLAudioElement` routed through
  Web Audio, with pause/resume/seek, loop, volume, fades, autoplay-block
  detection, an error callback, and no full-track PCM decode.

## 1.2.0

- The decoded-audio cache is now a byte-bounded LRU instead of an unbounded map, so a
  music playlist can no longer retain an album's worth of PCM. Default budget: 32 MiB.
- Added `retain: false` to `playAudio` for long tracks that should not occupy the cache.
- Added `clearAudioCache()`, `releaseCachedAudio(key)`, `setAudioCacheLimit(bytes)` and
  `getAudioCacheStats()`.
- Fixed a tagged `ArrayBuffer`/byte-array source only playing when it was already cached:
  a tag miss now decodes, plays and retains instead of silently returning.
- A non-OK response from `fetch` now rejects with a message naming the path and status
  instead of failing inside `decodeAudioData`.

## 1.1.0 

- Added 3d audio support

## 1.0.1 - 2025-03-11

- Can now play from a straight ArrayBuffer source

## 1.0.0 - 2025-01-31

- Converted from Managed Script to git repo