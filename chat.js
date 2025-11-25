const canvas = document.getElementById('spectrogram');
const ctx = canvas.getContext('2d');
const startButton = document.getElementById('startButton');

// Set canvas size
canvas.width = 800;
canvas.height = 400;

let audioContext;
let analyser;
let dataArray;
let animationId;
let spectrogramImage;

// Simplified FSK Protocol with the new detection algorithm
class SimpleFSKProtocol {
    constructor() {
        this.FREQ_0 = 13000;   // Frequency for bit 0
        this.FREQ_1 = 12000;   // Frequency for bit 1
        this.FREQ_SYNC = 11000; // Sync frequency
        
        this.BIT_DURATION = 100; // ms per bit
        this.GAP = 200;

        this.TRESH = 20
        
        this.bitBuffer = [];
        this.active0 = 0;
        this.active1 = 0;
        this.activesync = 0;
        this.isActive = false;
    }
    
    reset() {
        this.bitBuffer = [];
        this.active0 = 0;
        this.active1 = 0;
        this.activesync = 0;
        this.isActive = false;
    }
}

// Create protocol instance
const protocol = new SimpleFSKProtocol();

// UI elements
let dataDisplay, sendInput, sendButton, statusDisplay, logDisplay;

startButton.addEventListener('click', async () => {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
            audio: {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
                channelCount: 1,
                sampleRate: 44100,
                latency: 0.01
            } 
        });
        
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        analyser = audioContext.createAnalyser();
        
        const source = audioContext.createMediaStreamSource(stream);
        source.connect(analyser);
        
        analyser.fftSize = 8192;
        analyser.smoothingTimeConstant = 0.02;
        
        const bufferLength = analyser.frequencyBinCount;
        dataArray = new Uint8Array(bufferLength);
        
        spectrogramImage = document.createElement('canvas');
        spectrogramImage.width = bufferLength;
        spectrogramImage.height = canvas.height;
        const spectrogramCtx = spectrogramImage.getContext('2d');
        
        spectrogramCtx.fillStyle = '#000000';
        spectrogramCtx.fillRect(0, 0, spectrogramImage.width, spectrogramImage.height);
        
        createInterface();
        startButton.style.display = 'none';
        drawSpectrogram(spectrogramCtx);
        startReceiver();
        
    } catch (err) {
        console.error('Error accessing microphone:', err);
        updateStatus('Error accessing microphone: ' + err.message, 'error');
    }
});

function drawSpectrogram(spectrogramCtx) {
    analyser.getByteFrequencyData(dataArray);
    
    const imageData = spectrogramCtx.getImageData(0, 0, spectrogramImage.width, spectrogramImage.height - 1);
    spectrogramCtx.putImageData(imageData, 0, 1);
    
    const newRow = spectrogramCtx.createImageData(spectrogramImage.width, 1);
    
    for (let i = 0; i < dataArray.length; i++) {
        const intensity = dataArray[i] / 255;
        const color = getColor(intensity);
        
        const r = parseInt(color.substr(1, 2), 16);
        const g = parseInt(color.substr(3, 2), 16);
        const b = parseInt(color.substr(5, 2), 16);
        
        const pixelIndex = i * 4;
        newRow.data[pixelIndex] = r;
        newRow.data[pixelIndex + 1] = g;
        newRow.data[pixelIndex + 2] = b;
        newRow.data[pixelIndex + 3] = 255;
    }
    
    spectrogramCtx.putImageData(newRow, 0, 0);
    ctx.drawImage(spectrogramImage, 0, 0, canvas.width, canvas.height);
    
    animationId = requestAnimationFrame(() => drawSpectrogram(spectrogramCtx));
}

const colorCache = {};
function getColor(intensity) {
    const key = Math.floor(intensity * 100);
    if (colorCache[key]) return colorCache[key];
    
    let r, g, b;
    if (intensity < 0.25) {
        r = 0;
        g = Math.floor(intensity * 4 * 255);
        b = 255;
    } else if (intensity < 0.5) {
        r = 0;
        g = 255;
        b = Math.floor((1 - (intensity - 0.25) * 4) * 255);
    } else if (intensity < 0.75) {
        r = Math.floor((intensity - 0.5) * 4 * 255);
        g = 255;
        b = 0;
    } else {
        r = 255;
        g = Math.floor((1 - (intensity - 0.75) * 4) * 255);
        b = 0;
    }
    
    const color = `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
    colorCache[key] = color;
    return color;
}

function frequencyToBin(frequencyHz) {
    const sampleRate = audioContext.sampleRate;
    const fftSize = analyser.fftSize;
    return Math.floor(frequencyHz / (sampleRate / fftSize));
}

function startReceiver() {
    function sampleSignal() {
        if (!analyser) return;
        
        const currentTime = Date.now();
        analyser.getByteFrequencyData(dataArray);

        // Get frequency values using the new algorithm
        const freqSync = dataArray[frequencyToBin(protocol.FREQ_SYNC)];
        const freq0 = dataArray[frequencyToBin(protocol.FREQ_0)];
        const freq1 = dataArray[frequencyToBin(protocol.FREQ_1)];

        // New detection algorithm
        if (freqSync < protocol.TRESH && protocol.isActive) {
            protocol.isActive = false;
        }

        if (freqSync > protocol.TRESH && !protocol.isActive) {
            protocol.isActive = true;
            console.log("bit")
            
            // Check for sync pattern (both frequencies active)
            if (freq0 > protocol.TRESH && freq1 > protocol.TRESH) {
                tryDecodeBuffer();
                startReception(currentTime);
            }
            
            // Detect which bit is being sent
            if (freq0 > protocol.TRESH) {
                protocol.bitBuffer.push('0');
                logMessage("Detected bit: 0");
            } else if (freq1 > protocol.TRESH) {
                protocol.bitBuffer.push('1');
                logMessage("Detected bit: 1");
            }
            
            updateDisplay();
        }
        
        requestAnimationFrame(sampleSignal);
    }
    
    sampleSignal();
}

function startReception(currentTime) {
    protocol.bitBuffer = [];
}

function tryDecodeBuffer() {
    if (protocol.bitBuffer.length < 8) return false;
    
    const bitString = protocol.bitBuffer.join('');
    
    // Look for complete bytes (groups of 8 bits)
    let i = 0;
    result = ""
    while (i <= bitString.length - 8) {
        const byteStr = bitString.substring(i, i + 8);
        const charCode = parseInt(byteStr, 2);

        result += String.fromCharCode(charCode);
        protocol.bitBuffer.splice(0, i + 8);
        
        i++;
    }


    dataDisplay.innerHTML = `✅ <strong>Received:</strong> "${result}"`;
    logMessage(`🎉 Decoded character: "${result}"`);
    
    // Remove processed bits
    protocol.bitBuffer.splice(0, i + 8);
    updateDisplay();
    return true;
    
    return false;
}

function updateDisplay() {
    const bitString = protocol.bitBuffer.join('');
    if (bitString.length > 0) {
        dataDisplay.textContent = `Receiving bits: ${bitString} (${bitString.length} bits)`;
    }
}

function createInterface() {
    const container = document.createElement('div');
    container.style.cssText = 'text-align: center; margin: 20px; max-width: 800px; margin: 0 auto;';
    
    // Status display
    statusDisplay = document.createElement('div');
    statusDisplay.style.cssText = 'font-family: monospace; font-size: 14px; margin: 10px; padding: 8px; background: #e8f4fd; border-radius: 5px; min-height: 20px;';
    statusDisplay.textContent = 'Status: Ready';
    
    // Data display
    dataDisplay = document.createElement('div');
    dataDisplay.style.cssText = 'font-family: monospace; font-size: 16px; margin: 10px; padding: 12px; background: #f8f8f8; border-radius: 5px; min-height: 30px; word-wrap: break-word; border: 1px solid #ddd;';
    dataDisplay.textContent = 'Received data will appear here';
    
    // Log display
    logDisplay = document.createElement('div');
    logDisplay.style.cssText = 'font-family: monospace; font-size: 11px; margin: 10px; padding: 10px; background: #f5f5f5; border-radius: 5px; max-height: 150px; overflow-y: auto; text-align: left;';
    logDisplay.textContent = 'Protocol log:\n';
    
    // Send interface
    const sendContainer = document.createElement('div');
    sendContainer.style.cssText = 'margin: 20px;';
    
    sendInput = document.createElement('input');
    sendInput.type = 'text';
    sendInput.placeholder = 'Enter text to transmit';
    sendInput.style.cssText = 'padding: 10px; margin: 5px; width: 300px; border: 1px solid #ccc; border-radius: 4px;';
    
    sendButton = document.createElement('button');
    sendButton.textContent = 'Transmit Data';
    sendButton.style.cssText = 'padding: 10px 20px; margin: 5px; background: #4CAF50; color: white; border: none; border-radius: 4px; cursor: pointer;';
    sendButton.onclick = sendData;
    
    // Protocol info
    const protocolInfo = document.createElement('div');
    protocolInfo.style.cssText = 'font-size: 12px; color: #666; margin: 10px;';
    protocolInfo.innerHTML = `Protocol: Simple FSK | Frequencies: ${protocol.FREQ_0}Hz (0), ${protocol.FREQ_1}Hz (1), ${protocol.FREQ_SYNC}Hz (sync)`;
    
    sendContainer.appendChild(sendInput);
    sendContainer.appendChild(sendButton);
    
    container.appendChild(statusDisplay);
    container.appendChild(dataDisplay);
    container.appendChild(logDisplay);
    container.appendChild(sendContainer);
    container.appendChild(protocolInfo);
    
    document.body.appendChild(container);
}

// Transmission functions
async function sendData() {
    const text = sendInput.value.trim();
    if (!text) {
        updateStatus('Please enter text to send', 'warning');
        return;
    }
    
    if (text.length > 50) {
        updateStatus('Text too long (max 50 chars)', 'warning');
        return;
    }
    
    sendInput.value = '';
    updateStatus('Transmitting...', 'transmitting');
    
    logMessage(`Starting transmission: "${text}"`);
    
    try {
        // Add gap before transmission
        await new Promise(resolve => setTimeout(resolve, 200));
        
        // Send data
        for (let i = 0; i < text.length; i++) {
            await sendCharacter(text[i]);
        }
        
        // Send end sync
        playTone(protocol.FREQ_SYNC, protocol.BIT_DURATION * 2, ()=>{});
        playTone(protocol.FREQ_0, protocol.BIT_DURATION * 2, ()=>{});
        playTone(protocol.FREQ_1, protocol.BIT_DURATION * 2, ()=>{});
        
        // Add gap after transmission
        await new Promise(resolve => setTimeout(resolve, protocol.BIT_DURATION * 2));
        
        updateStatus('Transmission complete', 'success');
        logMessage('Transmission completed successfully');
        
    } catch (error) {
        updateStatus('Transmission failed', 'error');
        logMessage(`Transmission failed: ${error.message}`);
    }
}


async function sendCharacter(char) {
    const binary = char.charCodeAt(0).toString(2).padStart(8, '0');
    logMessage(`Sending '${char}' as ${binary}`);
    
    dataDisplay.textContent = `Sending: ${char} (${binary})`;
    
    for (let i = 0; i < binary.length; i++) {
        await sendBit(binary[i]);
        
        // Small gap between bits
        await new Promise(resolve => setTimeout(resolve, protocol.GAP));
    }
}

async function sendBit(bit) {
    const frequency = bit === '0' ? protocol.FREQ_0 : protocol.FREQ_1;
    
    setTimeout(()=>{playTone(protocol.FREQ_SYNC, protocol.BIT_DURATION / 3, ()=>{})}, protocol.BIT_DURATION / 3);
    return new Promise((resolve) => {
        playTone(frequency, protocol.BIT_DURATION, resolve);
    });
}

function playTone(frequency, durationMs, callback) {
    if (!audioContext) {
        if (callback) setTimeout(callback, durationMs);
        return;
    }
    
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    
    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);
    
    oscillator.frequency.value = frequency;
    oscillator.type = 'sine';
    
    const now = audioContext.currentTime;
    const duration = durationMs / 1000;
    
    // Clean envelope
    gainNode.gain.setValueAtTime(0, now);
    gainNode.gain.linearRampToValueAtTime(0.1, now + 0.01);
    gainNode.gain.setValueAtTime(0.1, now + duration - 0.02);
    gainNode.gain.linearRampToValueAtTime(0, now + duration - 0.01);
    
    oscillator.start(now);
    oscillator.stop(now + duration);
    
    if (callback) {
        setTimeout(callback, durationMs);
    }
}

// Utility functions
function updateStatus(message, type = 'info') {
    const colors = {
        info: '#e8f4fd',
        success: '#e8f8ef',
        error: '#fde8e8',
        warning: '#fff3cd',
        receiving: '#e8f8e8',
        transmitting: '#fff3cd'
    };
    
    statusDisplay.textContent = `Status: ${message}`;
    statusDisplay.style.background = colors[type] || colors.info;
}

function logMessage(message) {
    const timestamp = new Date().toLocaleTimeString();
    logDisplay.innerHTML += `[${timestamp}] ${message}<br>`;
    logDisplay.scrollTop = logDisplay.scrollHeight;
}

// Clean up
function stopVisualization() {
    if (animationId) {
        cancelAnimationFrame(animationId);
    }
}