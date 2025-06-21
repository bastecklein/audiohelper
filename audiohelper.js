if(typeof window !== "undefined") {
    window.addEventListener("pointerdown", winPointerDown);
}

let retainedBuffers = {};
let audioContext = null;
let fakeiOSElement = null;

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

    if(path instanceof ArrayBuffer) {
        if(options && options.tag) {
            if(retainedBuffers[options.tag]) {
                buffer = retainedBuffers[options.tag];
            }
        } else {
            buffer = await audioContext.decodeAudioData(path);

            if(options && options.tag) {
                retainedBuffers[options.tag] = buffer;
            }
        }
        
    } else {
        if(typeof path == "string") {
            buffer = await getFile(path);
        } else {
    
            if(Array.isArray(path)) {
                const uint = new Uint8Array(path);
    
                if(uint && uint.buffer) {
                    if(options && options.tag) {
                        if(retainedBuffers[options.tag]) {
                            buffer = retainedBuffers[options.tag];
                        }
                    }
            
                    if(!buffer) {
                        const ab = uint.buffer;
            
                        buffer = await audioContext.decodeAudioData(ab);
            
                        if(options && options.tag) {
                            retainedBuffers[options.tag] = buffer;
                        }
                    }
                }
            }
    
        }
    }

    if(!buffer) {
        return;
    }

    if(!options) {
        options = {};
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

async function getFile(path) {

    if(!audioContext) {
        gooseUpAudioContext();
    }

    if(!audioContext) {
        return null;
    }

    if(retainedBuffers[path]) {
        return retainedBuffers[path];
    }

    const response = await fetch(path);
    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

    retainedBuffers[path] = audioBuffer;

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
    getAudioContext,
    tryResumeAudio,
    setListenerPosition,
    setListenerOrientation
};