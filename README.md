# audiohelper

Simple library for playing sound effects and streaming music with the web audio API.

```json
"dependencies": {
    "audiohelper": "git+ssh://git@github.com:bastecklein/audiohelper.git#main"
}
```

## Usage

```javascript
// node
import audioHelper from "audiohelper";

// browser
import audioHelper from "./audiohelper.js";
```

```javascript
import { playAudio } from "audiohelper";

const sound = await playAudio("sfx/click.mp3");

// stop it early
sound.stop();

// change its volume while it plays
sound.setVolume(0.5);
```

`playAudio` also accepts an `ArrayBuffer` or a byte array, and resolves to a handle with
`stop()` and `setVolume()`. The handle is `undefined` if the browser cannot create an
`AudioContext` or the source could not be decoded.

### Options

| Option | Meaning |
| --- | --- |
| `volume` | Playback volume, `0..1`. Default `1`. |
| `callback` | Called when the sound finishes. It receives the `tag`. It is **not** called when the sound is stopped. |
| `tag` | A cache key for an `ArrayBuffer`/byte-array source, and the value passed to `callback`. |
| `retain` | Whether the decoded buffer may be cached. Default `true`; see below. |
| `rate` | Playback rate. Default `1`. |
| `x`, `y`, `z` | Play at a 3D position instead of as an ambient sound. |
| `connectors` | Extra Web Audio nodes to insert before the gain node. |

## Decoded-audio cache

Decoding is expensive and adds latency at the moment a sound is triggered, so a
successfully loaded buffer is kept and reused by its URL or `tag`. **That retention is
deliberate**: it is what makes a repeated click, alert or footstep start without paying
the decode again. The cache is a **least-recently-used list with a byte budget**, not an
unbounded map: the default budget is **32 MiB of decoded PCM**, and a buffer larger than
the whole budget is played but never retained. That keeps the latency win for ordinary
sound effects while preventing a music playlist from holding an album's worth of float32
samples in memory.

**Use `retain: false` for long tracks.** It skips both the cache read and the cache
write, which is what a two-minute stereo track wants: the cache exists for effects that
are played again, not for songs that play once.

```javascript
await playAudio("music/theme.mp3", { retain: false, volume: 0.6 });
```

The cache can be managed directly:

```javascript
import {
    clearAudioCache,
    releaseCachedAudio,
    setAudioCacheLimit,
    getAudioCacheStats
} from "audiohelper";

releaseCachedAudio("sfx/click.mp3"); // drop one entry; returns whether it existed
clearAudioCache();                   // drop everything

setAudioCacheLimit(16 * 1024 * 1024); // bytes; 0 disables retention
getAudioCacheStats();                 // { entries, bytes, limit }
```

Dropping a buffer is safe while it is playing: the audio source keeps its own reference,
so playback continues and the memory is released when the sound ends.

## Streaming music

`playAudio` decodes the whole source into memory. For a long music track, use
`playStream`, which keeps the browser's streaming pipeline and adds
pause/resume/seek and fades:

```javascript
import { playStream } from "audiohelper";

const track = await playStream("music/theme.mp3", {
    volume: 0.6,
    loop: false,
    tag: "theme",
    callback: function() {
        // The track ended naturally: start the next one.
    }
});

track.pause();
track.play();
track.seek(30);
await track.fadeTo(0, 1000);
track.stop();
```

The handle matches the useful parts of `playAudio` (`stop`, `setVolume`) and adds
`play`, `pause`, `seek`, `setLoop`, `getCurrentTime`, `getDuration`, `isPaused`
and `fadeTo`. Volume is applied through a `GainNode`; if the browser cannot create
a `MediaElementAudioSourceNode` (or the source is cross-origin without CORS), it
falls back to `HTMLMediaElement.volume`.

Remote URLs are fetched in CORS mode and must send `Access-Control-Allow-Origin`,
or Web Audio would receive silence. If autoplay is blocked, the returned handle
has `blocked === true`; call `track.play()` from a user gesture to retry.

## Notes

- `AudioContext` starts suspended until a user gesture in most browsers. The library
  resumes it on `pointerdown`; hosts that support keyboard-only play should call
  `tryResumeAudio()` from their own gesture handler.
- On iOS a silent looping `<audio>` element is kept alive as a workaround for the
  platform's Web Audio restrictions.
