// chirp-detector-processor.js
class ChirpDetectorProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      
      this.sampleRate = 44100;
      this.bufferSize = 8192; // Larger buffer for better FFT
      this.audioBuffer = new Float32Array(this.bufferSize * 4); // 4x buffer for history
      this.bufferPointer = 0;
      this.processCounter = 0;
      
      this.templates = new Map();
      this.detectionThreshold = 0.15; // Lower threshold for noisy environments
      this.minDetectionGap = 0.3; // seconds between detections
      this.lastDetectionTime = 0;
      
      this.noiseFloor = 0.01;
      this.snrThreshold = 3.0; // Signal-to-noise ratio threshold
      
      // FFT settings
      this.fftSize = 1024;
      this.hopSize = 256;
      this.frequencyBuffer = new Float32Array(this.fftSize);
      
      // Adaptive thresholding
      this.energyHistory = new Float32Array(100); // Store recent energy values
      this.energyPointer = 0;
      this.backgroundEnergy = 0.01;
      
      this.port.onmessage = (event) => {
        this.handleMessage(event.data);
      };
      
      console.log('ChirpDetectorProcessor initialized');
    }
  
    handleMessage(message) {
      switch (message.type) {
        case 'addTemplate':
          this.addTemplate(message.name, message.duration, message.f0, message.f1);
          break;
        case 'setThreshold':
          this.detectionThreshold = message.threshold;
          break;
        case 'setSampleRate':
          this.sampleRate = message.sampleRate;
          break;
      }
    }
  
    addTemplate(name, duration, f0, f1) {
      const template = this.generateChirp(duration, f0, f1);
      const normalizedTemplate = this.normalizeSignal(template);
      
      this.templates.set(name, {
        template: normalizedTemplate,
        duration: duration,
        f0: f0,
        f1: f1,
        length: template.length
      });
      
      this.port.postMessage({
        type: 'templateAdded',
        name: name,
        length: template.length
      });
    }
  
    generateChirp(duration, f0, f1) {
      const length = Math.floor(duration * this.sampleRate);
      const chirp = new Float32Array(length);
      
      // Add fade in/out to reduce spectral leakage
      const fadeSamples = Math.min(100, length / 10);
      
      for (let i = 0; i < length; i++) {
        const t = i / this.sampleRate;
        const phase = 2 * Math.PI * (f0 * t + (f1 - f0) * t * t / (2 * duration));
        let amplitude = 1.0;
        
        // Fade in/out
        if (i < fadeSamples) {
          amplitude = i / fadeSamples;
        } else if (i > length - fadeSamples) {
          amplitude = (length - i) / fadeSamples;
        }
        
        chirp[i] = Math.sin(phase) * amplitude;
      }
      
      return chirp;
    }
  
    normalizeSignal(signal) {
      // Find maximum absolute value
      let maxVal = 0;
      for (let i = 0; i < signal.length; i++) {
        maxVal = Math.max(maxVal, Math.abs(signal[i]));
      }
      
      // Normalize
      if (maxVal > 0) {
        const normalized = new Float32Array(signal.length);
        for (let i = 0; i < signal.length; i++) {
          normalized[i] = signal[i] / maxVal;
        }
        return normalized;
      }
      
      return signal;
    }
  
    process(inputs, outputs, parameters) {
      const input = inputs[0];
      if (input.length === 0 || input[0].length === 0) {
        return true;
      }
  
      const inputChannel = input[0];
      
      // Update background energy estimation
      this.updateBackgroundEnergy(inputChannel);
      
      // Add new samples to buffer
      this.addToBuffer(inputChannel);
      
      // Process detection every N frames to reduce CPU load
      this.processCounter++;
      if (this.processCounter % 2 === 0) { // Process every 2nd frame
        this.processDetection();
      }
      
      return true;
    }
  
    addToBuffer(newSamples) {
      const newLength = newSamples.length;
      
      if (this.bufferPointer + newLength <= this.audioBuffer.length) {
        this.audioBuffer.set(newSamples, this.bufferPointer);
        this.bufferPointer += newLength;
      } else {
        // Shift buffer and add new data
        const shiftAmount = this.bufferPointer + newLength - this.audioBuffer.length;
        this.audioBuffer.copyWithin(0, shiftAmount, this.bufferPointer);
        this.bufferPointer = this.audioBuffer.length - shiftAmount;
        this.audioBuffer.set(newSamples, this.bufferPointer);
        this.bufferPointer += newLength;
      }
    }
  
    updateBackgroundEnergy(samples) {
      // Calculate RMS energy of current frame
      let energy = 0;
      for (let i = 0; i < samples.length; i++) {
        energy += samples[i] * samples[i];
      }
      energy = Math.sqrt(energy / samples.length);
      
      // Update energy history
      this.energyHistory[this.energyPointer] = energy;
      this.energyPointer = (this.energyPointer + 1) % this.energyHistory.length;
      
      // Update background energy (slowly adapt to environment)
      let totalEnergy = 0;
      let count = 0;
      for (let i = 0; i < this.energyHistory.length; i++) {
        if (this.energyHistory[i] > 0) {
          totalEnergy += this.energyHistory[i];
          count++;
        }
      }
      
      if (count > 0) {
        this.backgroundEnergy = totalEnergy / count;
      }
    }
  
    processDetection() {
      const currentTime = currentFrame / this.sampleRate;
      
      // Only process if we have enough data and sufficient signal above noise
      if (this.bufferPointer < this.bufferSize || this.backgroundEnergy < 0.001) {
        return;
      }
  
      // Get the most recent audio data
      const recentAudio = this.getRecentAudio(this.bufferSize);
      
      // Check signal-to-noise ratio
      const currentSNR = this.calculateSNR(recentAudio);
      if (currentSNR < this.snrThreshold) {
        return; // Too noisy, skip detection
      }
  
      // Check each template
      for (const [name, templateInfo] of this.templates.entries()) {
        const correlation = this.computeRobustCorrelation(recentAudio, templateInfo.template);
        const confidence = this.calculateConfidence(correlation, currentSNR);
        
        if (confidence > this.detectionThreshold && 
            (currentTime - this.lastDetectionTime) > this.minDetectionGap) {
          
          this.lastDetectionTime = currentTime;
          
          this.port.postMessage({
            type: 'chirpDetected',
            name: name,
            confidence: confidence,
            correlation: correlation,
            snr: currentSNR,
            timestamp: currentTime,
            backgroundEnergy: this.backgroundEnergy
          });
        }
      }
    }
  
    getRecentAudio(length) {
      const audio = new Float32Array(length);
      const startIdx = this.bufferPointer - length;
      
      for (let i = 0; i < length; i++) {
        const bufferIdx = (startIdx + i) % this.audioBuffer.length;
        audio[i] = this.audioBuffer[bufferIdx];
      }
      
      return audio;
    }
  
    calculateSNR(signal) {
      let signalPower = 0;
      for (let i = 0; i < signal.length; i++) {
        signalPower += signal[i] * signal[i];
      }
      signalPower /= signal.length;
      
      const noisePower = this.backgroundEnergy * this.backgroundEnergy;
      
      if (noisePower < 1e-10) return 100; // Very high SNR if no noise
      
      return signalPower / noisePower;
    }
  
    computeRobustCorrelation(signal, template) {
      let maxCorrelation = 0;
      const templateLength = template.length;
      const searchLength = Math.min(signal.length, this.bufferSize) - templateLength;
      
      // Pre-normalize the signal window for better correlation
      const normalizedSignal = this.normalizeWindow(signal, templateLength);
      
      for (let i = 0; i < searchLength; i += 4) { // Skip samples for performance
        let correlation = 0;
        
        for (let j = 0; j < templateLength; j++) {
          correlation += normalizedSignal[i + j] * template[j];
        }
        
        correlation /= templateLength;
        maxCorrelation = Math.max(maxCorrelation, Math.abs(correlation));
      }
      
      return maxCorrelation;
    }
  
    normalizeWindow(signal, windowSize) {
      // Simple normalization for correlation
      const normalized = new Float32Array(signal.length);
      
      for (let i = 0; i <= signal.length - windowSize; i++) {
        // Calculate RMS for this window
        let sumSq = 0;
        for (let j = 0; j < windowSize; j++) {
          sumSq += signal[i + j] * signal[i + j];
        }
        const rms = Math.sqrt(sumSq / windowSize);
        
        // Normalize this window
        if (rms > 1e-10) {
          for (let j = 0; j < windowSize; j++) {
            normalized[i + j] = signal[i + j] / rms;
          }
        }
      }
      
      return normalized;
    }
  
    calculateConfidence(correlation, snr) {
      // Combine correlation and SNR for better confidence
      const snrFactor = Math.min(1.0, snr / 10.0); // Normalize SNR
      return correlation * (0.7 + 0.3 * snrFactor);
    }
  }
  
  registerProcessor('chirp-detector-processor', ChirpDetectorProcessor);