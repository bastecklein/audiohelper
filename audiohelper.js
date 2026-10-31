if(typeof window !== "undefined") {
    window.addEventListener("pointerdown", winPointerDown);
}

/*
    Decoded audio buffers, keyed by URL or by a caller-supplied `tag`.

    **This used to be an unbounded plain object, and that is a real leak for anything
    longer than a sound effect.** A two-minute stereo track decodes to roughly 42 MB of
    float32 PCM, so a music playlist retained the whole album in memory for the life of
    the page. The cache is now a size-bounded LRU: callers can still get the decode-once
    behaviour that makes short effects cheap, a long track is never the thing that fills
    the budget, and an unaware caller cannot grow it forever. `retain: false` on
    `playAudio` opts out entirely for a track that should not occupy the budget at all.
*/
const DEFAULT_AUDIO_CACHE_LIMIT = 32 * 1024 * 1024;

let retainedBuffers = new Map();
let retainedBufferBytes = 0;
let audioCacheLimit = DEFAULT_AUDIO_CACHE_LIMIT;

let audioContext = null;
let fakeiOSElement = null;

function audioBufferBytes(buffer) {
    return (buffer.length || 0) * (buffer.numberOfChannels || 0) * Float32Array.BYTES_PER_ELEMENT;
}

/** Read a retained buffer and move it to the most-recently-used end of the LRU. */
function takeRetainedBuffer(key) {
    if(!retainedBuffers.has(key)) {
        return null;
    }

    const buffer = retainedBuffers.get(key);
    retainedBuffers.delete(key);
    retainedBuffers.set(key, buffer);

    return buffer;
}

function evictOldestRetainedBuffer() {
    const oldestKey = retainedBuffers.keys().next().value;
    const oldest = retainedBuffers.get(oldestKey);

    retainedBuffers.delete(oldestKey);
    retainedBufferBytes -= audioBufferBytes(oldest);
}

function retainBuffer(key, buffer) {
    const bytes = audioBufferBytes(buffer);

    // A single buffer over the whole budget is not worth evicting everything else for.
    if(bytes > audioCacheLimit) {
        releaseCachedAudio(key);
        return;
    }

    if(retainedBuffers.has(key)) {
        retainedBufferBytes -= audioBufferBytes(retainedBuffers.get(key));
        retainedBuffers.delete(key);
    }

    while(retainedBuffers.size > 0 && retainedBufferBytes + bytes > audioCacheLimit) {
        evictOldestRetainedBuffer();
    }

    retainedBuffers.set(key, buffer);
    retainedBufferBytes += bytes;
}

/**
 * Drop one decoded buffer from the cache.
 *
 * Safe while the buffer is playing: the `AudioBufferSourceNode` keeps its own reference,
 * so playback continues and the memory is released when the source ends.
 *
 * @param {string} key  the URL or `tag` it was retained under.
 * @returns {boolean} whether something was cached under that key.
 */
export function releaseCachedAudio(key) {
    if(!retainedBuffers.has(key)) {
        return false;
    }

    retainedBufferBytes -= audioBufferBytes(retainedBuffers.get(key));
    retainedBuffers.delete(key);

    return true;
}

/** Drop every decoded buffer. Playing sounds are unaffected. */
export function clearAudioCache() {
    retainedBuffers.clear();
    retainedBufferBytes = 0;
}

/**
 * Change the decoded-audio cache budget, in bytes.
 *
 * Zero disables retention without changing any call sites. A non-finite or negative
 * value restores the default. Lowering the limit evicts least-recently-used buffers
 * immediately.
 *
 * @param {number} bytes
 * @returns {number} the limit now in effect.
 */
export function setAudioCacheLimit(bytes) {
    const limit = Number(bytes);

    audioCacheLimit = Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : DEFAULT_AUDIO_CACHE_LIMIT;

    while(retainedBuffers.size > 0 && retainedBufferBytes > audioCacheLimit) {
        evictOldestRetainedBuffer();
    }

    return audioCacheLimit;
}

/**
 * The cache's current size, for diagnostics and tests.
 *
 * @returns {{entries: number, bytes: number, limit: number}}
 */
export function getAudioCacheStats() {
    return {
        entries: retainedBuffers.size,
        bytes: retainedBufferBytes,
        limit: audioCacheLimit
    };
}

let listenerPosition = { x: 0, y: 0, z: 0 };
let activeSounds = new Set();

const SILENCE = "data:audio/mpeg;base64,//uQx" + huffman(23, "A") + "WGluZwAAAA8AAAACAAACcQCA" + huffman(16, "gICA") + huffman(66, "/") + "8AAABhTEFNRTMuMTAwA8MAAAAAAAAAABQgJAUHQQAB9AAAAnGMHkkI" + huffman(320, "A") + "//sQxAADgnABGiAAQBCqgCRMAAgEAH" + huffman(15, "/") + "7+n/9FTuQsQH//////2NG0jWUGlio5gLQTOtIoeR2WX////X4s9Atb/JRVCbBUpeRUq" + huffman(18, "/") + "9RUi0f2jn/+xDECgPCjAEQAABN4AAANIAAAAQVTEFNRTMuMTAw" + huffman(97, "V") + "Q==";

const ua = navigator.userAgent.toLowerCase();

const isIOS = ((window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.openFileDialog) ||
        (ua.indexOf("iphone") >= 0 && ua.indexOf("like iphone") < 0) ||
        (ua.indexOf("ipad") >= 0 && ua.indexOf("like ipad") < 0) ||
        (ua.indexOf("ipod") >= 0 && ua.indexOf("like ipod") < 0) ||
        (ua.indexOf("mac os x") >= 0 && navigator.maxTouchPoints > 0)
);

function SoundObject() {
    this.bufferSource = null;
    this.callback = null;
    this.tag = null;
    this.wasStopped = false;
    this.gainNode = null;

    this.pannerNode = null;
    this.position = null; // { x, y, z } or null for ambient sounds
    this.isPositional = false;

    const so = this;

    so.setCallback = function(callback) {

        so.callback = callback;

        so.bufferSource.onended = function() {

            if(so.wasStopped) {
                return;
            }

            if(so.callback) {
                so.callback(so.tag);
            }
        };
    };

    so.stop = function() {
        so.wasStopped = true;
        so.callback = null;
        so.bufferSource.onended = null;
        so.bufferSource.stop();

        if (so.isPositional) {
            activeSounds.delete(so);
        }
    };

    so.setVolume = function(vol) {
        if(so.gainNode) {
            so.gainNode.gain.setValueAtTime(vol, audioContext.currentTime);
        }
    };

    so.setPosition = function(x, y, z) {
        if (so.pannerNode && so.isPositional) {
            so.position = { x, y, z };
            so.pannerNode.positionX.setValueAtTime(x, audioContext.currentTime);
            so.pannerNode.positionY.setValueAtTime(y, audioContext.currentTime);
            so.pannerNode.positionZ.setValueAtTime(z, audioContext.currentTime);
        }
    };
}

export function getAudioContext() {
    if(audioContext) {
        return audioContext;
    }

    return null;
}

export async function playAudio(path, options) {
    createFakeIOSElement();

    if(!audioContext) {
        gooseUpAudioContext();
    }

    if(!audioContext) {
        return;
    }

    let buffer = null;

    if(!options) {
        options = {};
    }

    /*
        `retain: false` is the explicit opt-out for long tracks: skip both the cache read
        and the cache write. The default is `true`, which keeps the decode-once behaviour
        short sound effects have always had -- now under the LRU budget rather than
        forever.
    */
    const retain = options.retain !== false;

    if(path instanceof ArrayBuffer) {
        if(retain && options.tag) {
            buffer = takeRetainedBuffer(options.tag);
        }

        if(!buffer) {
            buffer = await audioContext.decodeAudioData(path);

            if(retain && options.tag) {
                retainBuffer(options.tag, buffer);
            }
        }
    } else if(typeof path == "string") {
        buffer = await getFile(path, retain);
    } else if(Array.isArray(path)) {
        const uint = new Uint8Array(path);

        if(uint && uint.buffer) {
            if(retain && options.tag) {
                buffer = takeRetainedBuffer(options.tag);
            }

            if(!buffer) {
                const ab = uint.buffer;

                buffer = await audioContext.decodeAudioData(ab);

                if(retain && options.tag) {
                    retainBuffer(options.tag, buffer);
                }
            }
        }
    }

    if(!buffer) {
        return;
    }

    tryResumeAudio();

    const bufferSource = audioContext.createBufferSource();
    bufferSource.buffer = buffer;

    let curDest = bufferSource;

    if(options.rate && options.rate != 1) {
        bufferSource.playbackRate.value = parseFloat(options.rate);
    }

    // Check if this should be a 3D positioned sound
    const isPositional = options.x !== undefined && options.y !== undefined && options.z !== undefined;
    let pannerNode = null;

    if (isPositional) {
        // Create panner node for 3D audio
        pannerNode = audioContext.createPanner();
        
        // Configure panner settings (you can make these configurable via options)
        pannerNode.panningModel = 'HRTF';
        pannerNode.distanceModel = options.distanceModel || 'inverse';
        pannerNode.refDistance = options.refDistance || 1;
        pannerNode.maxDistance = options.maxDistance || 10000;
        pannerNode.rolloffFactor = options.rolloffFactor || 1;
        pannerNode.coneInnerAngle = options.coneInnerAngle || 360;
        pannerNode.coneOuterAngle = options.coneOuterAngle || 0;
        pannerNode.coneOuterGain = options.coneOuterGain || 0;

        // Set initial position
        if (pannerNode.positionX) {
            // Modern browsers
            pannerNode.positionX.setValueAtTime(options.x, audioContext.currentTime);
            pannerNode.positionY.setValueAtTime(options.y, audioContext.currentTime);
            pannerNode.positionZ.setValueAtTime(options.z, audioContext.currentTime);
        } else {
            // Fallback for older browsers
            pannerNode.setPosition(options.x, options.y, options.z);
        }

        // Set orientation if provided
        if (options.orientationX !== undefined) {
            if (pannerNode.orientationX) {
                pannerNode.orientationX.setValueAtTime(options.orientationX || 1, audioContext.currentTime);
                pannerNode.orientationY.setValueAtTime(options.orientationY || 0, audioContext.currentTime);
                pannerNode.orientationZ.setValueAtTime(options.orientationZ || 0, audioContext.currentTime);
            } else {
                pannerNode.setOrientation(
                    options.orientationX || 1,
                    options.orientationY || 0,
                    options.orientationZ || 0
                );
            }
        }

        curDest = curDest.connect(pannerNode);
    }

    if(options.connectors) {
        for(let i = 0; i < options.connectors.length; i++) {
            const connector = options.connectors[i];
            curDest = curDest.connect(connector);
        }
    }

    let useVol = 1.0;

    if(options.volume != undefined && options.volume != null)  {
        useVol = options.volume;
    }

    const gainNode = audioContext.createGain();
    gainNode.gain.setValueAtTime(useVol, audioContext.currentTime);
    curDest = curDest.connect(gainNode);

    curDest.connect(audioContext.destination);
        

    bufferSource.start();

    const so = new SoundObject();
    so.bufferSource = bufferSource;
    so.gainNode = gainNode;
    so.pannerNode = pannerNode;
    so.isPositional = isPositional;

    if (isPositional) {
        so.position = { x: options.x, y: options.y, z: options.z };
        activeSounds.add(so);
        
        // Set up cleanup when sound ends
        const originalOnEnded = bufferSource.onended;
        bufferSource.onended = function() {
            activeSounds.delete(so);
            if (originalOnEnded) {
                originalOnEnded();
            }
        };
    }

    if(options.tag) {
        so.tag = options.tag;
    } else {
        so.tag = path;
    }

    if(options.callback) {
        so.setCallback(options.callback);
    }
        
    return so;
}

/**
 * Play a streaming source through an HTMLAudioElement.
 *
 * `playAudio` decodes the whole file into an AudioBuffer, which is right for
 * short effects and wrong for a multi-minute music track: the decoded PCM can be
 * tens of megabytes, and there is no pause, resume or seek. `playStream` keeps
 * the browser's streaming pipeline and routes the element through Web Audio so
 * the caller still gets a gain node for volume and fades.
 *
 * @param {string} path
 * @param {object} [options]
 * @param {number} [options.volume=1]
 * @param {boolean} [options.loop=false]
 * @param {number} [options.startAt=0] seconds
 * @param {string} [options.tag] value passed to the callbacks
 * @param {function} [options.callback] called with `tag` when the track ends
 * @param {function} [options.errorCallback] called with `(event, tag)` on error
 * @param {boolean} [options.crossOrigin] force CORS mode for a remote URL
 * @returns {Promise<object|undefined>} handle, or undefined if no audio element
 */
export async function playStream(path, options) {
    if(!path) {
        return;
    }

    if(!options) {
        options = {};
    }

    if(!audioContext) {
        gooseUpAudioContext();
    }

    tryResumeAudio();

    const audio = createAudioElement(path, options);

    if(!audio) {
        return;
    }

    let sourceNode = null;
    let gainNode = null;

    if(audioContext) {
        try {
            sourceNode = audioContext.createMediaElementSource(audio);
            gainNode = audioContext.createGain();
            sourceNode.connect(gainNode);
            gainNode.connect(audioContext.destination);
        } catch {
            // A cross-origin element without CORS, or a browser without
            // MediaElementAudioSourceNode. The element can still play; volume
            // then falls back to HTMLMediaElement.volume.
            if(sourceNode) {
                try {
                    sourceNode.disconnect();
                } catch {
                    // Nothing to disconnect.
                }
            }

            sourceNode = null;
            gainNode = null;
        }
    }

    const so = new StreamObject(audio, sourceNode, gainNode);

    so.tag = options.tag || path;
    so.callback = options.callback || null;
    so.errorCallback = options.errorCallback || null;

    so.setVolume(options.volume === undefined ? 1 : options.volume);
    so.setLoop(!!options.loop);

    if(options.startAt) {
        so.seek(options.startAt);
    }

    audio.addEventListener("ended", so.onEnded);
    audio.addEventListener("error", so.onError);

    try {
        await audio.play();
        so.started = true;
        so.blocked = false;
    } catch(ex) {
        if(ex && ex.name === "NotAllowedError") {
            // Autoplay was blocked. The caller can retry so.play() from a
            // user gesture.
            so.blocked = true;
        } else {
            const mediaError = describeMediaError(audio, path);

            if(mediaError) {
                console.error("audiohelper: could not play stream", path, mediaError);
            }

            so.destroy();
            throw mediaError || ex;
        }
    }

    return so;
}

function StreamObject(audio, sourceNode, gainNode) {
    this.audio = audio;
    this.sourceNode = sourceNode;
    this.gainNode = gainNode;
    this.tag = null;
    this.callback = null;
    this.errorCallback = null;
    this.blocked = false;
    this.wasStopped = false;
    this.started = false;
    this.mediaError = null;

    const so = this;

    so.onEnded = function() {
        if(so.wasStopped) {
            return;
        }

        try {
            if(so.callback) {
                so.callback(so.tag);
            }
        } finally {
            so.destroy();
        }
    };

    so.onError = function(event) {
        if(so.wasStopped) {
            return;
        }

        /*
            An error during the initial play() is a load/decode failure. Do not
            pause here: that turns the pending play() promise into an
            "AbortError: interrupted by a call to pause()" and hides the real
            media error. Record it and let the play() rejection carry it out.
        */
        if(!so.started) {
            so.mediaError = so.audio.error;

            return;
        }

        try {
            if(so.errorCallback) {
                so.errorCallback(event, so.tag);
            }
        } finally {
            so.destroy();
        }
    };

    so.setVolume = function(vol) {
        const useVol = clampVolume(vol);

        if(so.gainNode && audioContext) {
            if(so.gainNode.gain.cancelScheduledValues) {
                so.gainNode.gain.cancelScheduledValues(audioContext.currentTime);
            }

            so.gainNode.gain.setValueAtTime(useVol, audioContext.currentTime);
        } else {
            so.audio.volume = useVol;
        }
    };

    /**
     * Ramp the volume to `vol` over `duration` milliseconds. Resolves when the
     * ramp is scheduled to finish. Without Web Audio the change is immediate.
     */
    so.fadeTo = function(vol, duration) {
        const useVol = clampVolume(vol);
        const ms = Math.max(0, Number(duration) || 0);

        if(!so.gainNode || !audioContext) {
            so.setVolume(useVol);
            return Promise.resolve();
        }

        const now = audioContext.currentTime;

        if(so.gainNode.gain.cancelScheduledValues) {
            so.gainNode.gain.cancelScheduledValues(now);
        }

        so.gainNode.gain.setValueAtTime(so.gainNode.gain.value, now);
        so.gainNode.gain.linearRampToValueAtTime(useVol, now + (ms / 1000));

        if(ms === 0) {
            return Promise.resolve();
        }

        return new Promise(function(resolve) {
            setTimeout(resolve, ms);
        });
    };

    so.play = function() {
        so.wasStopped = false;
        so.blocked = false;

        const result = so.audio.play();

        if(result && result.catch) {
            result.catch(function(ex) {
                if(ex && ex.name === "NotAllowedError") {
                    so.blocked = true;
                }
            });
        }

        return result;
    };

    so.pause = function() {
        so.audio.pause();
    };

    so.seek = function(time) {
        const useTime = Number(time);

        if(!Number.isFinite(useTime) || useTime < 0) {
            return false;
        }

        try {
            so.audio.currentTime = useTime;
            return true;
        } catch {
            return false;
        }
    };

    so.setLoop = function(loop) {
        so.audio.loop = !!loop;
    };

    so.getCurrentTime = function() {
        return so.audio.currentTime || 0;
    };

    so.getDuration = function() {
        return so.audio.duration || 0;
    };

    so.isPaused = function() {
        return so.audio.paused;
    };

    so.stop = function() {
        so.wasStopped = true;
        so.destroy();
    };

    so.destroy = function() {
        so.audio.removeEventListener("ended", so.onEnded);
        so.audio.removeEventListener("error", so.onError);

        try {
            so.audio.pause();
            so.audio.removeAttribute("src");
            so.audio.load();
        } catch {
            // The element may already be detached.
        }

        if(so.sourceNode) {
            try {
                so.sourceNode.disconnect();
            } catch {
                // Already disconnected.
            }
        }

        if(so.gainNode) {
            try {
                so.gainNode.disconnect();
            } catch {
                // Already disconnected.
            }
        }
    };
}

function describeMediaError(audio, path) {
    const error = audio && audio.error;

    if(!error) {
        return null;
    }

    const messages = {
        1: "aborted",
        2: "network error",
        3: "decode error",
        4: "source not supported"
    };

    const message = messages[error.code] || ("media error " + error.code);
    const mediaError = new Error("audiohelper: could not play " + path + " (" + message + ")");

    mediaError.name = "MediaError";
    mediaError.code = error.code;
    mediaError.mediaMessage = error.message;

    return mediaError;
}

function clampVolume(vol) {    const useVol = Number(vol);

    if(!Number.isFinite(useVol)) {
        return 1;
    }

    return Math.min(1, Math.max(0, useVol));
}

function isCrossOrigin(path) {
    if(typeof path != "string" || path.length == 0) {
        return false;
    }

    if(path.indexOf("data:") === 0 || path.indexOf("blob:") === 0) {
        return false;
    }

    if(typeof window === "undefined" || !window.location || !window.location.href) {
        return false;
    }

    try {
        const base = new URL(window.location.href);

        return new URL(path, base).origin !== base.origin;
    } catch {
        return false;
    }
}

function createAudioElement(path, options) {
    let audio = null;

    try {
        audio = new Audio();
    } catch {
        if(typeof document !== "undefined" && document.createElement) {
            audio = document.createElement("audio");
        }
    }

    if(!audio) {
        return null;
    }

    if(audioContext && (options.crossOrigin || isCrossOrigin(path))) {
        audio.crossOrigin = "anonymous";
    }

    audio.preload = "auto";
    audio.src = path;

    return audio;
}

export function tryResumeAudio() {
    if(!audioContext) {
        return;
    }

    if (audioContext.state === "suspended") {
        audioContext.resume();
    }

    createFakeIOSElement();
}

function huffman(count, repeatStr) {
    let e = repeatStr;
    
    for (; count > 1; count--) {
        e += repeatStr;
    }    
    
    return e;
}

function winPointerDown() {
    tryResumeAudio();
}

function createFakeIOSElement()  {
    if(!isIOS) {
        return;
    }

    if(!fakeiOSElement) {
        const holder = document.createElement("div");
        holder.innerHTML = "<audio x-webkit-airplay='deny'></audio>";

        fakeiOSElement = holder.children.item(0);

        fakeiOSElement.controls = false;
        fakeiOSElement.disableRemotePlayback = true;
        fakeiOSElement.preload = "auto";
        fakeiOSElement.src = SILENCE;
        fakeiOSElement.loop = true;
        fakeiOSElement.load();
    }
    

    if(fakeiOSElement.paused) {
        const p = fakeiOSElement.play();

        if(p) {
            p.then(function() {}, killFakeiOSElement).catch(killFakeiOSElement);
        }
    }
}

function gooseUpAudioContext() {

    try {
        audioContext = new AudioContext();

        setListenerPosition(listenerPosition.x, listenerPosition.y, listenerPosition.z);
    } catch(ex) {
        console.log(ex);
        audioContext = null;
    }
}

async function getFile(path, retain) {

    if(!audioContext) {
        gooseUpAudioContext();
    }

    if(!audioContext) {
        return null;
    }

    if(retain) {
        const cached = takeRetainedBuffer(path);

        if(cached) {
            return cached;
        }
    }

    const response = await fetch(path);

    if(!response.ok) {
        throw new Error("audiohelper: could not load " + path + " (" + response.status + ")");
    }

    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

    if(retain) {
        retainBuffer(path, audioBuffer);
    }

    return audioBuffer;
}

function killFakeiOSElement() {
    if(fakeiOSElement) {
        fakeiOSElement.src = "about:blank";
        fakeiOSElement.load();
    }

    fakeiOSElement = null;
}

export function setListenerPosition(x, y, z) {
    listenerPosition = { x, y, z };
    
    if (audioContext && audioContext.listener) {
        // Update listener position
        if (audioContext.listener.positionX) {
            // Modern browsers
            audioContext.listener.positionX.setValueAtTime(x, audioContext.currentTime);
            audioContext.listener.positionY.setValueAtTime(y, audioContext.currentTime);
            audioContext.listener.positionZ.setValueAtTime(z, audioContext.currentTime);
        } else {
            // Fallback for older browsers
            audioContext.listener.setPosition(x, y, z);
        }
    }
}

export function setListenerOrientation(forwardX, forwardY, forwardZ, upX = 0, upY = 1, upZ = 0) {
    if (audioContext && audioContext.listener) {
        if (audioContext.listener.forwardX) {
            // Modern browsers
            audioContext.listener.forwardX.setValueAtTime(forwardX, audioContext.currentTime);
            audioContext.listener.forwardY.setValueAtTime(forwardY, audioContext.currentTime);
            audioContext.listener.forwardZ.setValueAtTime(forwardZ, audioContext.currentTime);
            audioContext.listener.upX.setValueAtTime(upX, audioContext.currentTime);
            audioContext.listener.upY.setValueAtTime(upY, audioContext.currentTime);
            audioContext.listener.upZ.setValueAtTime(upZ, audioContext.currentTime);
        } else {
            // Fallback for older browsers
            audioContext.listener.setOrientation(forwardX, forwardY, forwardZ, upX, upY, upZ);
        }
    }
}

export default {
    playAudio,
    playStream,
    getAudioContext,
    tryResumeAudio,
    setListenerPosition,
    setListenerOrientation,
    releaseCachedAudio,
    clearAudioCache,
    setAudioCacheLimit,
    getAudioCacheStats
};