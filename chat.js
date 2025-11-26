const canvas = document.getElementById('spectrogram');
const ctx = canvas.getContext('2d');
const startButton = document.getElementById('startButton');

const axisCanvas = document.getElementById('axisCanvas');
const axisCtx = axisCanvas.getContext('2d');

canvas.width = 900;
canvas.height = 400;

axisCanvas.width = 900;
axisCanvas.height = 400;

let audioContext;
let analyser;
let dataArray;
let animationId;
let spectrogramImage;

let dataDisplay, sendInput, sendButton, statusDisplay, logDisplay;
const detector = new AudioWorkletChirpDetector()
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
        
        analyser.fftSize = 16384;
        analyser.smoothingTimeConstant = 0.00;
        
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
        drawFrequencyAxis()
        // startReceiver();

        await detector.initialize()
        detector.addTemplate('up', 1.0, 15000, 16000);
        detector.addTemplate('down', 1.0, 16000, 15000);

        detector.onDetection((detection) => {
            console.log(detection);
        });
        const success = await detector.start(stream);
        
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

function drawFrequencyAxis() {
    const height = axisCanvas.height;
    const width = axisCanvas.width;
    const margin = 10;
    
    axisCtx.clearRect(0, 0, width, height);
    axisCtx.fillStyle = '#ffffff';
    axisCtx.font = '12px monospace';
    axisCtx.textAlign = 'right';
    axisCtx.textBaseline = 'middle';

    // Logarithmic scale: 100Hz → Nyquist (~22050Hz)
    const sampleRate = audioContext.sampleRate;
    const nyquist = sampleRate / 2;
    const minFreq = 100; // ignore very low bins (0–100 Hz often noisy)

    // Choose nice frequency ticks: 100, 200, 500, 1k, 2k, 5k, 10k, 20k
    const freqTicks = [1, 2500, 5000, 7500, 10000, 12500, 15000, 17500, 20000, 22500, 25000].filter(f => f <= nyquist);

    freqTicks.forEach(freq => {
        const bin = frequencyToBin(freq);
        const x = (bin / analyser.frequencyBinCount) * width;

        // Skip if outside visible range
        if (x < 0 || x > width) return;

        // Draw horizontal tick line (optional)
        axisCtx.beginPath();
        axisCtx.moveTo(x, margin);
        axisCtx.lineTo(x, 0);
        axisCtx.strokeStyle = '#000';
        axisCtx.stroke();

        // Draw label
        let label = freq + ' Hz';
        if (freq >= 1000) label = (freq / 1000) + ' kHz';
        axisCtx.fillText(label, x + 40, margin + 10);
    });
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

function binToFrequency(binIndex) {
    const sampleRate = audioContext.sampleRate;
    const fftSize = analyser.fftSize;
    return binIndex * (sampleRate / fftSize);
}

function startReceiver() {
    function sampleSignal() {
        if (!analyser) return;
        
        analyser.getByteFrequencyData(dataArray);

        protocol.sample(dataArray);
        
        requestAnimationFrame(sampleSignal);
    }
    
    sampleSignal();
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
    // protocolInfo.innerHTML = `Protocol: Simple FSK | Frequencies: ${protocol.FREQ_0}Hz (0), ${protocol.FREQ_1}Hz (1), ${protocol.FREQ_SYNC}Hz (sync)`;
    
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
    sendInput.value = '';
    // protocol.sendBits(protocol.stringToBinary(text));
    await detector.playTestChirp(1.0, 15000, 16000)
    await detector.playTestChirp(1.0, 16000, 15000)
}

// Clean up
function stopVisualization() {
    if (animationId) {
        cancelAnimationFrame(animationId);
    }
}