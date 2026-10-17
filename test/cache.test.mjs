import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The decoded-audio cache.
 *
 * `audiohelper` cannot decode real audio in Node, so the two browser pieces it touches
 * are faked: `AudioContext.decodeAudioData` returns a plain `{length, numberOfChannels}`
 * object with the byte size the cache cares about, and `fetch` returns that object
 * through `arrayBuffer()`. Everything under test -- the LRU, the `retain` opt-out and the
 * tagged-buffer path -- is real code.
 *
 * `window` has to exist before the module is imported: `audiohelper.js` reads
 * `window.webkit` at module scope (for its iOS detection) and registers a
 * `pointerdown` listener.
 */

globalThis.window = {
    addEventListener: function() {}
};

let nextBuffer = null;
let decodeCount = 0;
let fetchCount = 0;

/** A stand-in for an `AudioBuffer`; only the fields the cache measures matter. */
function bufferOf(frames, channels = 2) {
    return {
        length: frames,
        numberOfChannels: channels,
        sampleRate: 48000,
        duration: frames / 48000
    };
}

function listenerWithPosition() {
    const param = function() {
        return { setValueAtTime: function() {} };
    };

    return {
        positionX: param(),
        positionY: param(),
        positionZ: param(),
        forwardX: param(),
        forwardY: param(),
        forwardZ: param(),
        upX: param(),
        upY: param(),
        upZ: param()
    };
}

class FakeAudioContext {
    constructor() {
        this.currentTime = 0;
        this.state = 'running';
        this.destination = {};
        this.listener = listenerWithPosition();
    }

    decodeAudioData() {
        decodeCount++;
        return Promise.resolve(nextBuffer);
    }

    createBufferSource() {
        return {
            buffer: null,
            playbackRate: { value: 1 },
            onended: null,
            connect: function(node) {
                return node;
            },
            start: function() {},
            stop: function() {}
        };
    }

    createGain() {
        return {
            gain: { setValueAtTime: function() {} },
            connect: function(node) {
                return node;
            }
        };
    }
}

globalThis.AudioContext = FakeAudioContext;
globalThis.fetch = async function() {
    fetchCount++;

    return {
        ok: true,
        arrayBuffer: async function() {
            return { fake: true };
        }
    };
};

const {
    playAudio,
    releaseCachedAudio,
    clearAudioCache,
    setAudioCacheLimit,
    getAudioCacheStats
} = await import('../audiohelper.js');

const DEFAULT_LIMIT = 32 * 1024 * 1024;

beforeEach(function() {
    clearAudioCache();
    setAudioCacheLimit(DEFAULT_LIMIT);
    nextBuffer = bufferOf(48000);
    decodeCount = 0;
    fetchCount = 0;
});

describe('audiohelper cache: default retention', () => {
    it('retains a decoded URL and reuses it on the next play', async() => {
        await playAudio('sfx/click.mp3');

        assert.deepEqual(getAudioCacheStats(), {
            entries: 1,
            bytes: 48000 * 2 * 4,
            limit: DEFAULT_LIMIT
        });
        assert.equal(decodeCount, 1);

        await playAudio('sfx/click.mp3');

        assert.equal(fetchCount, 1, 'the second play does not fetch');
        assert.equal(decodeCount, 1, 'the second play does not decode');
    });

    it('keeps distinct URLs as distinct entries', async() => {
        await playAudio('sfx/one.mp3');
        await playAudio('sfx/two.mp3');

        assert.equal(getAudioCacheStats().entries, 2);
        assert.equal(decodeCount, 2);
    });
});

describe('audiohelper cache: retain: false', () => {
    it('does not read or write the cache', async() => {
        await playAudio('music/long.mp3', { retain: false });

        assert.deepEqual(getAudioCacheStats(), {
            entries: 0,
            bytes: 0,
            limit: DEFAULT_LIMIT
        });

        await playAudio('music/long.mp3', { retain: false });

        assert.equal(fetchCount, 2);
        assert.equal(decodeCount, 2);
    });

    it('does not populate the cache for a tagged ArrayBuffer either', async() => {
        const bytes = new ArrayBuffer(16);

        await playAudio(bytes, { tag: 'theme', retain: false });

        assert.equal(decodeCount, 1);
        assert.equal(getAudioCacheStats().entries, 0);
    });
});

describe('audiohelper cache: the LRU budget', () => {
    it('evicts the least-recently-used entry when the limit is exceeded', async() => {
        setAudioCacheLimit(10000);
        nextBuffer = bufferOf(500); // 500 frames * 2 channels * 4 bytes = 4000 bytes

        await playAudio('a.mp3');
        await playAudio('b.mp3');
        assert.deepEqual(getAudioCacheStats(), { entries: 2, bytes: 8000, limit: 10000 });

        await playAudio('c.mp3');
        assert.deepEqual(getAudioCacheStats(), { entries: 2, bytes: 8000, limit: 10000 });

        // `a` was oldest and must have been evicted; `b` and `c` must still be cached.
        const fetchesBefore = fetchCount;
        await playAudio('b.mp3');
        await playAudio('c.mp3');
        assert.equal(fetchCount, fetchesBefore, 'b and c are still cached');

        await playAudio('a.mp3');
        assert.equal(fetchCount, fetchesBefore + 1, 'a has to be fetched again');
    });

    it('treats a cache hit as recent use', async() => {
        setAudioCacheLimit(10000);
        nextBuffer = bufferOf(500);

        await playAudio('a.mp3');
        await playAudio('b.mp3');
        await playAudio('a.mp3'); // refresh a, so b is now the oldest
        await playAudio('c.mp3');

        const fetchesBefore = fetchCount;
        await playAudio('a.mp3');
        assert.equal(fetchCount, fetchesBefore, 'a survived the eviction');

        await playAudio('b.mp3');
        assert.equal(fetchCount, fetchesBefore + 1, 'b was evicted');
    });

    it('does not retain a single buffer larger than the whole budget', async() => {
        setAudioCacheLimit(10000);
        nextBuffer = bufferOf(5000); // 40000 bytes

        await playAudio('huge.mp3');

        assert.deepEqual(getAudioCacheStats(), { entries: 0, bytes: 0, limit: 10000 });
    });

    it('evicts immediately when the limit is lowered', async() => {
        nextBuffer = bufferOf(5000); // 40000 bytes each
        await playAudio('a.mp3');
        await playAudio('b.mp3');
        assert.equal(getAudioCacheStats().entries, 2);

        setAudioCacheLimit(40000);

        assert.deepEqual(getAudioCacheStats(), { entries: 1, bytes: 40000, limit: 40000 });
    });

    it('restores the default for a non-finite or negative limit', () => {
        assert.equal(setAudioCacheLimit(-1), DEFAULT_LIMIT);
        assert.equal(setAudioCacheLimit(Number.NaN), DEFAULT_LIMIT);
        assert.equal(setAudioCacheLimit('nonsense'), DEFAULT_LIMIT);
    });
});

describe('audiohelper cache: explicit release', () => {
    it('releases one key and reports whether it was there', async() => {
        await playAudio('a.mp3');

        assert.equal(releaseCachedAudio('a.mp3'), true);
        assert.equal(releaseCachedAudio('a.mp3'), false);
        assert.equal(getAudioCacheStats().entries, 0);
        assert.equal(getAudioCacheStats().bytes, 0);
    });

    it('clears everything', async() => {
        await playAudio('a.mp3');
        await playAudio('b.mp3');

        clearAudioCache();

        assert.deepEqual(getAudioCacheStats(), {
            entries: 0,
            bytes: 0,
            limit: DEFAULT_LIMIT
        });
    });
});

describe('audiohelper cache: tagged ArrayBuffer', () => {
    it('decodes and then reuses a tagged buffer', async() => {
        // This used to be a hole: a tag miss left `buffer` null and `playAudio` returned
        // without ever decoding, so the first play of a tagged buffer was silent and
        // nothing was cached.
        const bytes = new ArrayBuffer(16);

        await playAudio(bytes, { tag: 'beep' });

        assert.equal(decodeCount, 1);
        assert.equal(getAudioCacheStats().entries, 1);

        await playAudio(bytes, { tag: 'beep' });

        assert.equal(decodeCount, 1, 'the second play reads the retained buffer');
        assert.equal(fetchCount, 0);
    });
});
