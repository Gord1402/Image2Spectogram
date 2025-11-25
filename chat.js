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

// Enhanced FSK Protocol with improved bit detection
class EnhancedFSKProtocol {
    constructor() {
        this.FREQ_0 = 6000;   // Frequency for bit 0
        this.FREQ_1 = 8000;   // Frequency for bit 1
        this.FREQ_SYNC = 10000; // Sync frequency
    
        // Frequencies for FSK (within optimal hearing range)
        // In EnhancedFSKProtocol constructor - adjust timing and thresholds
        this.BIT_DURATION = 1000; // ms per bit
        this.SAMPLE_RATE = 4;   // Slightly reduced sampling rate
        this.SAMPLES_PER_BIT = Math.max(2, Math.floor(this.BIT_DURATION / this.SAMPLE_RATE));

        // Detection - increased thresholds and stricter requirements
        this.THRESHOLD = 50;     // Increased threshold
        this.MIN_SIGNAL_DURATION = 10;  // Must be at least 70% of bit duration
        this.MAX_SIGNAL_DURATION = this.BIT_DURATION * 6;  // Tighter maximum
        this.SILENCE_GAP = 180;  // Increased silence gap

        // Signal processing - smaller history for faster response
        this.HISTORY_SIZE = 5;   // Reduced for quicker adaptation

        // Add new state variables for better bit tracking
        this.minSamplesForBit = Math.floor(this.SAMPLES_PER_BIT * 0.8); // 80% of expected samples
        this.signalConfidence = 0;
                
        // Signal processing
        this.signalHistory = [];
        
        // State management
        this.receiving = false;
        this.bitBuffer = [];
        this.lastBitTime = 0;
        this.currentSignal = null;
        this.signalStartTime = 0;
        this.lastSilenceTime = Date.now();
        this.consecutiveSamples = 0;
        this.lastDetectedBit = null;

        this.active0 = 0;
        this.active1 = 0;
        this.activesync = 0;
        
        // Reception state
        this.expectedBits = 0;
        this.receptionStartTime = 0;
    }
    
    detectFrequencies(dataArray, audioContext, analyser) {
        // Get frequency bins for our frequencies with wider detection
        const bin0 = this.frequencyToBin(this.FREQ_0, audioContext, analyser);
        const bin1 = this.frequencyToBin(this.FREQ_1, audioContext, analyser);
        const binSync = this.frequencyToBin(this.FREQ_SYNC, audioContext, analyser);
        
        // Get values with wider neighborhood averaging for better detection
        const value0 = this.getFrequencyValue(dataArray, bin0, 4); // Increased radius
        const value1 = this.getFrequencyValue(dataArray, bin1, 4);
        const valueSync = this.getFrequencyValue(dataArray, binSync, 4);
        
        // Store in history for smoothing
        this.signalHistory.push({ freq0: value0, freq1: value1, sync: valueSync });
        if (this.signalHistory.length > this.HISTORY_SIZE) {
            this.signalHistory.shift();
        }
        
        // Apply weighted moving average (recent samples have more weight)
        return this.getWeightedSmoothedValues();
    }
    
    getWeightedSmoothedValues() {
        if (this.signalHistory.length === 0) {
            return { freq0: 0, freq1: 0, sync: 0 };
        }
        
        const sum = { freq0: 0, freq1: 0, sync: 0 };
        let totalWeight = 0;
        
        for (let i = 0; i < this.signalHistory.length; i++) {
            // Recent samples get higher weight
            const weight = (i + 1) / this.signalHistory.length;
            totalWeight += weight;
            
            sum.freq0 += this.signalHistory[i].freq0 * weight;
            sum.freq1 += this.signalHistory[i].freq1 * weight;
            sum.sync += this.signalHistory[i].sync * weight;
        }
        
        return {
            freq0: sum.freq0 / totalWeight,
            freq1: sum.freq1 / totalWeight,
            sync: sum.sync / totalWeight
        };
    }
    
    frequencyToBin(frequencyHz, audioContext, analyser) {
        const sampleRate = audioContext.sampleRate;
        const fftSize = analyser.fftSize;
        return Math.floor(frequencyHz / (sampleRate / fftSize));
    }
    
    getFrequencyValue(dataArray, centerBin, radius = 3) {
        // Average over multiple bins for more robust detection
        let sum = 0;
        let count = 0;
        for (let i = centerBin - radius; i <= centerBin + radius; i++) {
            if (i >= 0 && i < dataArray.length) {
                sum += dataArray[i];
                count++;
            }
        }
        return count > 0 ? sum / count : 0;
    }
    
// Enhanced detectBit method with stricter requirements
detectBit(freqValues) {
    const threshold = this.THRESHOLD;
    
    // Check if any frequency is above threshold with clear dominance
    const isFreq0 = freqValues.freq0 > threshold;
    const isFreq1 = freqValues.freq1 > threshold;
    const isSync = freqValues.sync > threshold;

    const currentTime = Date.now();

    if(this.active0 == 0 && isFreq0) this.active0 = currentTime;
    if(this.active1 == 0 && isFreq1) this.active1 = currentTime;
    if(this.activesync == 0 && isSync) this.activesync = currentTime;

    if(this.active0 == -1 && !isFreq0) this.active0 = 0;
    if(this.active1 == -1 && !isFreq1) this.active1 = 0;
    if(this.activesync == -1 && !isSync) this.activesync = 0;

    if (currentTime - this.active0 >= this.MIN_SIGNAL_DURATION / 2&& isFreq0 && this.active0 > 0){
        this.active0 = -1
        return '0';
    }

    if (currentTime - this.active1 >=  this.MIN_SIGNAL_DURATION / 2&& isFreq1 && this.active1 > 0){
        this.active1 = -1
        return '1';
    }

    if (currentTime - this.activesync >=  this.MIN_SIGNAL_DURATION / 2&& isSync && this.activesync > 0){
        this.activesync = -1
        return 'S';
    }
    
    
    return null; // No clear signal
}
    resetReception() {
        this.receiving = false;
        this.bitBuffer = [];
        this.currentSignal = null;
        this.consecutiveSamples = 0;
        this.lastDetectedBit = null;
        this.expectedBits = 0;
    }
}

// Create protocol instance
const protocol = new EnhancedFSKProtocol();

// UI elements
let dataDisplay, sendInput, sendButton, statusDisplay, logDisplay, statsDisplay;

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
        
        // Increased FFT size for better frequency resolution
        analyser.fftSize = 16384; // Doubled for better frequency resolution
        analyser.smoothingTimeConstant = 0.2; // Less smoothing for faster response
        
        const bufferLength = analyser.frequencyBinCount;
        dataArray = new Uint8Array(bufferLength);
        
        spectrogramImage = document.createElement('canvas');
        spectrogramImage.width = bufferLength;
        spectrogramImage.height = canvas.height;
        const spectrogramCtx = spectrogramImage.getContext('2d');
        
        spectrogramCtx.fillStyle = '#000000';
        spectrogramCtx.fillRect(0, 0, spectrogramImage.width, spectrogramImage.height);
        
        createEnhancedInterface();
        startButton.style.display = 'none';
        drawSpectrogram(spectrogramCtx);
        startEnhancedReceiver();
        
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

function createEnhancedInterface() {
    const container = document.createElement('div');
    container.style.cssText = 'text-align: center; margin: 20px; max-width: 800px; margin: 0 auto;';
    
    // Status display
    statusDisplay = document.createElement('div');
    statusDisplay.style.cssText = 'font-family: monospace; font-size: 14px; margin: 10px; padding: 8px; background: #e8f4fd; border-radius: 5px; min-height: 20px;';
    statusDisplay.textContent = 'Status: Ready';
    
    // Stats display
    statsDisplay = document.createElement('div');
    statsDisplay.style.cssText = 'font-family: monospace; font-size: 12px; margin: 5px; padding: 5px; background: #f0f0f0; border-radius: 3px;';
    statsDisplay.textContent = 'Freq0: -- | Freq1: -- | Sync: -- | Samples: --';
    
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
    sendButton.onclick = sendEnhancedData;
    
    const protocolInfo = document.createElement('div');
    protocolInfo.style.cssText = 'font-size: 12px; color: #666; margin: 10px;';
    protocolInfo.innerHTML = `Protocol: Enhanced FSK | Bit duration: ${protocol.BIT_DURATION}ms | Samples per bit: ${protocol.SAMPLES_PER_BIT}`;
    
    sendContainer.appendChild(sendInput);
    sendContainer.appendChild(sendButton);
    
    container.appendChild(statusDisplay);
    container.appendChild(statsDisplay);
    container.appendChild(dataDisplay);
    container.appendChild(logDisplay);
    container.appendChild(sendContainer);
    container.appendChild(protocolInfo);
    
    document.body.appendChild(container);
}

function frequencyToBin(frequencyHz, audioContext, analyser) {
    const sampleRate = audioContext.sampleRate;
    const fftSize = analyser.fftSize;
    return Math.floor(frequencyHz / (sampleRate / fftSize));
}

function startEnhancedReceiver() {
    let lastSampleTime = 0;
    let sampleCount = 0;

    let isActtive = false;
    
    function sampleSignal() {
        if (!analyser) return;
        
        const currentTime = Date.now();

        analyser.getByteFrequencyData(dataArray);

        const freq = dataArray[frequencyToBin(10000, audioContext, analyser)]
        const freq0 = dataArray[frequencyToBin(9000, audioContext, analyser)]
        const freq1 = dataArray[frequencyToBin(8000, audioContext, analyser)]
        console.log(freq, freq0,freq1)

        if (freq < 50 && isActtive) isActtive = false;

        if (freq > 50 && !isActtive){
            isActtive = true;
            console.log("Start reciving bit")
            if (freq0 > 50 && freq1 > 50) {
                console.log(protocol.bitBuffer)
                tryDecodeBuffer();
                startReception(currentTime)
            }
            if (freq0 > 50) protocol.bitBuffer.push('0')
            else if (freq1 > 50) protocol.bitBuffer.push('1')
            
        }

        
        requestAnimationFrame(sampleSignal);
    }
    
    sampleSignal();
}

function startReception(currentTime) {
    protocol.receiving = true;
    protocol.bitBuffer = [];
    protocol.currentSignal = null;
    protocol.receptionStartTime = currentTime;
    protocol.lastBitTime = currentTime;
    protocol.consecutiveSamples = 0;
    
    logMessage('🔷 SYNC DETECTED - Starting reception');
    updateStatus('Receiving...', 'receiving');
    dataDisplay.textContent = 'Receiving...';
}

// Modified processEnhancedBit with confidence-based detection
function processEnhancedBit(detectedBit, currentTime) {
    // Require multiple consecutive samples of the same signal before considering it valid
    if (detectedBit !== protocol.currentSignal) {
        protocol.signalConfidence = 1;
        protocol.currentSignal = detectedBit;
        protocol.signalStartTime = currentTime;
        protocol.consecutiveSamples = 1;
    } else {
        protocol.consecutiveSamples++;
        protocol.signalConfidence++;
    }
    
    protocol.lastBitTime = currentTime;
}

// Stricter processPendingBit with higher requirements
function processPendingBit(currentTime) {
    if (protocol.currentSignal !== null) {
        const signalDuration = currentTime - protocol.signalStartTime;
        
        // Require both minimum duration AND sufficient consecutive samples
        const hasMinDuration = signalDuration >= protocol.MIN_SIGNAL_DURATION;
        const hasMinSamples = protocol.consecutiveSamples >= protocol.minSamplesForBit;
        const hasHighConfidence = protocol.signalConfidence >= 3;
        
        if (hasHighConfidence) {
            finalizeBit(currentTime);
        }
        // Prevent overly long bits
        else if (signalDuration > protocol.MAX_SIGNAL_DURATION) {
            logMessage(`⚠️ Signal too long, discarding: ${protocol.currentSignal}`);
            protocol.currentSignal = null;
            protocol.consecutiveSamples = 0;
            protocol.signalConfidence = 0;
        }
    }
}
// Modified finalizeBit to reset confidence
function finalizeBit(currentTime) {
    if (protocol.currentSignal === null) return;
    
    const signalDuration = currentTime - protocol.signalStartTime;
    
    // Only add to buffer if we have high confidence
    if (protocol.signalConfidence >= 2) {
        protocol.bitBuffer.push(protocol.currentSignal);
        logMessage(`✓ Bit ${protocol.currentSignal} received (${signalDuration}ms, ${protocol.consecutiveSamples} samples, confidence: ${protocol.signalConfidence})`);
        updateDisplay();
        tryDecodeBuffer();
    } else {
        logMessage(`✗ Low confidence bit discarded: ${protocol.currentSignal} (confidence: ${protocol.signalConfidence})`);
    }
    
    // Reset for next bit
    protocol.currentSignal = null;
    protocol.consecutiveSamples = 0;
    protocol.signalConfidence = 0;
}

function checkForReceptionEnd(currentTime) {
    const timeSinceLastBit = currentTime - protocol.lastBitTime;
    const timeSinceSilence = currentTime - protocol.lastSilenceTime;
    
    // End reception if no signal for extended period
    if (timeSinceLastBit > protocol.BIT_DURATION * 3 && 
        timeSinceSilence > protocol.SILENCE_GAP * 2) {
        
        endReception();
    }
}

function tryDecodeBuffer() {
    if (protocol.bitBuffer.length < 8) return false;
    
    const bitString = protocol.bitBuffer.join('');
    
    // Look for complete bytes (groups of 8 bits)
    let decodedAny = false;
    let i = 0;
    
    while (i <= bitString.length - 8) {
        const byteStr = bitString.substring(i, i + 8);
        const charCode = parseInt(byteStr, 2);
        
        // Check if it's a printable ASCII character
        if (charCode >= 32 && charCode <= 126) {
            const text = String.fromCharCode(charCode);
            dataDisplay.innerHTML = `✅ <strong>Received:</strong> "${text}" <small>(${byteStr})</small>`;
            console.log(`🎉 Decoded character: "${text}" from ${byteStr}`);
            
            // Remove processed bits
            protocol.bitBuffer.splice(0, i + 8);
            decodedAny = true;
            break;
        }
        i++;
    }
    
    // If we decoded something but have bits left, update display
    if (decodedAny && protocol.bitBuffer.length > 0) {
        updateDisplay();
    }
    
    return decodedAny;
}

function updateDisplay() {
    const bitString = protocol.bitBuffer.join('');
    if (bitString.length > 0) {
        dataDisplay.textContent = `Receiving bits: ${bitString} (${bitString.length} bits)`;
    }
}

function endReception() {
    const totalDuration = Date.now() - protocol.receptionStartTime;
    const bitString = protocol.bitBuffer.join('');
    
    logMessage(`Reception ended after ${totalDuration}ms. Raw bits: ${bitString}`);
    
    // Final attempt to decode any remaining bits
    if (bitString.length >= 8) {
        tryDecodeBuffer();
    }
    
    // If we still have undecoded bits, show them
    if (protocol.bitBuffer.length > 0) {
        const remainingBits = protocol.bitBuffer.join('');
        dataDisplay.innerHTML = `⚠️ Partial reception: ${remainingBits} (${remainingBits.length} bits)`;
        logMessage(`Undecoded bits remaining: ${remainingBits}`);
    }
    
    protocol.resetReception();
    updateStatus('Ready', 'info');
}

// Enhanced Transmission functions (unchanged from your original)
async function sendEnhancedData() {
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
        
        // Send data with proper gaps
        for (let i = 0; i < text.length; i++) {
            await sendEnhancedCharacter(text[i]);
        }
        playEnhancedTone(10000, protocol.BIT_DURATION * 2, ()=>{});
        playEnhancedTone(9000, protocol.BIT_DURATION * 2, ()=>{});
        await new Promise(resolve => playEnhancedTone(8000, protocol.BIT_DURATION * 2, resolve));
        
        // Add gap after transmission
        await new Promise(resolve => setTimeout(resolve, 200));
        
        updateStatus('Transmission complete', 'success');
        logMessage('Transmission completed successfully');
        
    } catch (error) {
        updateStatus('Transmission failed', 'error');
        logMessage(`Transmission failed: ${error.message}`);
    }
}

async function sendEnhancedSyncSignal() {
    logMessage('Sending sync signal');
    // Send sync frequency for 2 bit durations with clean start/end
    return new Promise((resolve) => {
        playEnhancedTone(protocol.FREQ_SYNC, protocol.BIT_DURATION * 2, resolve);
    });
}

async function sendEnhancedCharacter(char) {
    const binary = char.charCodeAt(0).toString(2).padStart(8, '0');
    logMessage(`Sending '${char}' as ${binary}`);
    
    dataDisplay.textContent = `Sending: ${char} (${binary})`;
    
    for (let i = 0; i < binary.length; i++) {
        await sendEnhancedBit(binary[i]);
        
        // Small gap between bits (except last one)
            await new Promise(resolve => setTimeout(resolve, 250));
    }
}

async function sendEnhancedBit(bit) {
    const frequency = bit === '0' ? 8000 : 9000;
    
    playEnhancedTone(frequency, protocol.BIT_DURATION * 2, ()=>{});
    return new Promise(resolve => playEnhancedTone(10000, protocol.BIT_DURATION * 2, resolve));
    

    return new Promise((resolve) => {
        // Slightly shorter tone to ensure clear separation
        playEnhancedTone(frequency, protocol.BIT_DURATION * 0.9, resolve);
    });
}

function playEnhancedTone(frequency, durationMs, callback) {
    if (!audioContext) {
        if (callback) setTimeout(callback, durationMs);
        return;
    }
    
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    
    oscillator.connect(gainNode);
    
    // Connect to both destination and analyser for monitoring
    gainNode.connect(audioContext.destination);
    if (analyser) {
        gainNode.connect(analyser);
    }
    
    oscillator.frequency.value = frequency;
    oscillator.type = 'sine';
    
    const now = audioContext.currentTime;
    const duration = durationMs / 1000;
    
    // Clean envelope with sharp attack and release
    gainNode.gain.setValueAtTime(0, now);
    gainNode.gain.linearRampToValueAtTime(0.1, now + 0.01); // Fast attack
    gainNode.gain.setValueAtTime(0.1, now + duration - 0.02);
    gainNode.gain.linearRampToValueAtTime(0, now + duration - 0.01); // Fast release
    
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
    logDisplay.innerHTML += `[${timestamp}] ${message}\n`;
    logDisplay.scrollTop = logDisplay.scrollHeight;
}

// Clean up
function stopVisualization() {
    if (animationId) {
        cancelAnimationFrame(animationId);
    }
}