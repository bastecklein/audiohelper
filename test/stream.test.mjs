import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Streaming music playback.
 *
 * Node cannot create a real HTMLAudioElement or MediaElementAudioSourceNode, so
 * the browser pieces are faked. Everything under test -- the handle, the
 * volume/fade scheduling, pause/resume/seek, cleanup and callback rules -- is
 * the real code.
 */

globalThis.window = {
    addEventListener: function() {},
    location: { href: 'https://game.example/' }
};

let audios = [];
let gains = [];
let playResult = null;
let pendingPlay = null;
let failMediaError = false;
let failMediaSource = false;

class FakeAudio {
    constructor() {
        this.src = null;
        this.crossOrigin = null;
        this.preload = null;
        this.loop = false;
        this.volume = 1;
        this.paused = true;
        this.currentTime = 0;
        this.duration = 120;
        this.listeners = {};
        this.playCalls = 0;
        this.loadCalls = 0;
        this.style = {};
        this.attributes = {};
        this.parentNode = null;

        audios.push(this);
    }

    play() {
        this.playCalls++;

        if(failMediaError) {
            this.error = { code: 4, message: "no source" };

            return Promise.reject({ name: "NotSupportedError" });
        }

        if(pendingPlay) {
            this.paused = false;

            return pendingPlay;
        }

        if(playResult) {
            const rejection = playResult;
            playResult = null;

            return Promise.reject(rejection);
        }

        this.paused = false;

        return Promise.resolve();
    }

    pause() {
        this.paused = true;
    }

    load() {
        this.loadCalls++;
    }

    removeAttribute(name) {
        if(name === "src") {
            this.src = null;
        }

        delete this.attributes[name];
    }

    setAttribute(name, value) {
        this.attributes[name] = value;
    }

    addEventListener(name, fn) {
        if(!this.listeners[name]) {
            this.listeners[name] = [];
        }

        this.listeners[name].push(fn);
    }

    removeEventListener(name, fn) {
        const list = this.listeners[name] || [];
        const index = list.indexOf(fn);

        if(index > -1) {
            list.splice(index, 1);
        }
    }

    emit(name) {
        const list = [...(this.listeners[name] || [])];

        for(const fn of list) {
            fn({ type: name });
        }
    }
}

class FakeGain {
    constructor() {
        this.gain = {
            value: 1,
            setValueAtTime: function(value) {
                this.value = value;
            },
            cancelScheduledValues: function() {},
            linearRampToValueAtTime: function(value) {
                this.value = value;
            }
        };
        this.disconnected = false;
    }

    connect(node) {
        return node;
    }

    disconnect() {
        this.disconnected = true;
    }
}

class FakeSource {
    constructor() {
        this.disconnected = false;
    }

    connect(node) {
        return node;
    }

    disconnect() {
        this.disconnected = true;
    }
}

class FakeAudioContext {
    constructor() {
        this.currentTime = 0;
        this.state = 'running';
        this.destination = {};
        this.listener = null;
    }

    createMediaElementSource() {
        if(failMediaSource) {
            throw new Error('no media element source');
        }

        const source = new FakeSource();

        return source;
    }

    createGain() {
        const gain = new FakeGain();

        gains.push(gain);

        return gain;
    }
}

globalThis.Audio = FakeAudio;
globalThis.AudioContext = FakeAudioContext;

const { playStream } = await import('../audiohelper.js');

beforeEach(function() {
    audios = [];
    gains = [];
    playResult = null;
    pendingPlay = null;
    failMediaError = false;
    failMediaSource = false;
});

describe('audiohelper streaming: basic playback', () => {
    it('creates a streaming element routed through a gain node', async() => {
        const handle = await playStream('music/theme.mp3', { volume: 0.5 });
        const audio = audios[0];

        assert.equal(audio.src, 'music/theme.mp3');
        assert.equal(audio.preload, 'auto');
        assert.equal(audio.playCalls, 1);
        assert.equal(handle.blocked, false);
        assert.equal(handle.isPaused(), false);
        assert.equal(gains[0].gain.value, 0.5);
    });

    it('returns undefined for an empty path', async() => {
        assert.equal(await playStream(''), undefined);
        assert.equal(audios.length, 0);
    });

    it('keeps the stream element in the document while playing', async() => {
        const appended = [];
        const body = {
            appendChild: function(element) {
                element.parentNode = body;
                appended.push(element);
            },
            removeChild: function(element) {
                element.parentNode = null;
            }
        };

        globalThis.document = { body };

        try {
            const handle = await playStream('music/a.mp3');

            assert.equal(appended.length, 1);
            assert.equal(audios[0].parentNode, body);
            assert.equal(audios[0].style.display, 'none');

            handle.stop();

            assert.equal(audios[0].parentNode, null);
        } finally {
            delete globalThis.document;
        }
    });

    it('supports pause, resume, seek, loop and duration', async() => {
        const handle = await playStream('music/a.mp3');

        handle.pause();
        assert.equal(handle.isPaused(), true);

        await handle.play();
        assert.equal(handle.isPaused(), false);

        assert.equal(handle.seek(42), true);
        assert.equal(handle.getCurrentTime(), 42);

        handle.setLoop(true);
        assert.equal(audios[0].loop, true);

        assert.equal(handle.getDuration(), 120);
    });
});

describe('audiohelper streaming: volume and fades', () => {
    it('clamps volume to 0..1', async() => {
        const handle = await playStream('music/a.mp3', { volume: 4 });

        assert.equal(gains[0].gain.value, 1);

        handle.setVolume(-2);
        assert.equal(gains[0].gain.value, 0);
    });

    it('fades to the target volume', async() => {
        const handle = await playStream('music/a.mp3', { volume: 1 });

        await handle.fadeTo(0, 20);

        assert.equal(gains[0].gain.value, 0);
    });

    it('falls back to element volume when media source creation fails', async() => {
        failMediaSource = true;

        const handle = await playStream('music/a.mp3', { volume: 0.25 });

        assert.equal(audios[0].volume, 0.25);
        assert.equal(gains.length, 0);

        handle.setVolume(0.75);
        assert.equal(audios[0].volume, 0.75);
    });
});

describe('audiohelper streaming: lifecycle', () => {
    it('calls the callback with the tag when the track ends', async() => {
        let endedTag = null;

        await playStream('music/a.mp3', {
            tag: 'theme',
            callback: function(tag) {
                endedTag = tag;
            }
        });

        const audio = audios[0];

        audio.emit('ended');

        assert.equal(endedTag, 'theme');
        assert.equal(audio.src, null);
        assert.equal(audio.paused, true);
        assert.equal(gains[0].disconnected, true);
    });

    it('does not call the callback when stopped', async() => {
        let called = false;

        const handle = await playStream('music/a.mp3', {
            callback: function() {
                called = true;
            }
        });

        handle.stop();
        audios[0].emit('ended');

        assert.equal(called, false);
        assert.equal(audios[0].paused, true);
        assert.equal(audios[0].src, null);
    });

    it('calls the error callback and tears down', async() => {
        let errorEvent = null;

        await playStream('music/a.mp3', {
            errorCallback: function(event) {
                errorEvent = event;
            }
        });

        const audio = audios[0];

        audio.emit('error');

        assert.equal(errorEvent.type, 'error');
        assert.equal(audio.src, null);
    });
});

describe('audiohelper streaming: autoplay', () => {
    it('reports a blocked autoplay attempt and allows a retry', async() => {
        playResult = { name: 'NotAllowedError' };

        const handle = await playStream('music/a.mp3');

        assert.equal(handle.blocked, true);

        await handle.play();

        assert.equal(handle.blocked, false);
        assert.equal(audios[0].playCalls, 2);
    });
});

describe('audiohelper streaming: media errors', () => {
    it('surfaces the media error instead of masking it as AbortError', async() => {
        failMediaError = true;

        let errorCallbackCalled = false;

        await assert.rejects(
            playStream('music/bad.mp3', {
                errorCallback: function() {
                    errorCallbackCalled = true;
                }
            }),
            function(err) {
                return err.name === 'MediaError' && err.code === 4;
            }
        );

        assert.equal(errorCallbackCalled, false, 'the load error is thrown to the caller, not the error callback');
    });

    it('does not pause the element when it errors before play settles', async() => {
        let rejectPlay = null;

        pendingPlay = new Promise(function(resolve, reject) {
            rejectPlay = reject;
        });

        const promise = playStream('music/bad.mp3');

        await Promise.resolve();

        const audio = audios[0];

        audio.error = { code: 4, message: 'no source' };
        audio.emit('error');

        assert.equal(audio.paused, false, 'the error handler must not pause a pending play()');

        rejectPlay({ name: 'AbortError' });

        await assert.rejects(promise, function(err) {
            return err.name === 'MediaError';
        });

        assert.equal(audio.paused, true, 'the element is destroyed after play rejects');
    });
});

describe('audiohelper streaming: cross-origin', () => {
    it('sets CORS mode for a remote URL', async() => {
        await playStream('https://cdn.example/theme.mp3');

        assert.equal(audios[0].crossOrigin, 'anonymous');
    });

    it('leaves same-origin, data and blob sources alone', async() => {
        await playStream('music/a.mp3');
        await playStream('data:audio/mpeg;base64,AAAA');
        await playStream('blob:https://game.example/abc');

        assert.equal(audios[0].crossOrigin, null);
        assert.equal(audios[1].crossOrigin, null);
        assert.equal(audios[2].crossOrigin, null);
    });
});
