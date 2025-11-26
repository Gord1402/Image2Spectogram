// chirp-detector.js
class AudioWorkletChirpDetector {
    constructor() {
      this.audioContext = null;
      this.workletNode = null;
      this.microphoneStream = null;
      this.isInitialized = false;
      this.isRunning = false;
      this.detectionCallbacks = [];
      this.templates = new Map();
      
      this.connectionRetryCount = 0;
      this.maxRetries = 3;
      this.retryDelay = 1000;
    }
  
    async initialize() {
      try {
        if (this.audioContext) {
          await this.audioContext.close();
        }
  
        // Create audio context with better settings
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
          sampleRate: 44100,
          latencyHint: 'interactive'
        });
        
        // Wait for context to be ready
        if (this.audioContext.state === 'suspended') {
          await this.audioContext.resume();
        }
        
        // Load worklet with retry logic
        await this.loadWorkletWithRetry();
        
        // Create worklet node
        this.workletNode = new AudioWorkletNode(this.audioContext, 'chirp-detector-processor', {
          outputChannelCount: [1],
          processorOptions: {
            bufferSize: 8192
          }
        });
        
        // Set up robust message handling
        this.workletNode.port.onmessage = (event) => {
          this.handleWorkletMessage(event.data);
        };
        
        // Handle node disconnection
        this.workletNode.onprocessorerror = (error) => {
          console.error('AudioWorklet processor error:', error);
          this.handleProcessorError();
        };
        
        // Send sample rate to worklet
        this.workletNode.port.postMessage({
          type: 'setSampleRate',
          sampleRate: this.audioContext.sampleRate
        });
        
        this.isInitialized = true;
        this.connectionRetryCount = 0;
        
        console.log('AudioWorkletChirpDetector initialized successfully');
        return true;
        
      } catch (error) {
        console.error('Failed to initialize AudioWorkletChirpDetector:', error);
        this.connectionRetryCount++;
        return false;
      }
    }
  
    async loadWorkletWithRetry() {
      for (let attempt = 0; attempt < this.maxRetries; attempt++) {
        try {
          await this.audioContext.audioWorklet.addModule('chirp-detector-processor.js');
          return;
        } catch (error) {
          console.warn(`Worklet load attempt ${attempt + 1} failed:`, error);
          if (attempt < this.maxRetries - 1) {
            await new Promise(resolve => setTimeout(resolve, this.retryDelay));
          } else {
            throw error;
          }
        }
      }
    }
  
    async start() {
      if (!this.isInitialized) {
        const success = await this.initialize();
        if (!success) {
          throw new Error('Failed to initialize audio detector');
        }
      }
  
      try {
        // Get microphone access with better constraints
        this.microphoneStream = await navigator.mediaDevices.getUserMedia({ 
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: 1,
            sampleRate: 44100,
            latency: 0.01
          },
          video: false
        });
        
        // Create source from microphone
        const source = this.audioContext.createMediaStreamSource(this.microphoneStream);
        
        // Connect source to worklet
        source.connect(this.workletNode);
        
        // Optional: Connect to destination for monitoring
        // this.workletNode.connect(this.audioContext.destination);
        
        // Handle audio context suspension
        this.audioContext.onstatechange = () => {
          console.log('AudioContext state:', this.audioContext.state);
          if (this.audioContext.state === 'suspended') {
            this.resumeContext();
          }
        };
        
        this.isRunning = true;
        console.log('Chirp detection started successfully');
        return true;
        
      } catch (error) {
        console.error('Failed to start microphone:', error);
        
        // Provide helpful error messages
        if (error.name === 'NotAllowedError') {
          throw new Error('Microphone access denied. Please allow microphone permissions.');
        } else if (error.name === 'NotFoundError') {
          throw new Error('No microphone found. Please check your audio device.');
        } else {
          throw new Error(`Failed to access microphone: ${error.message}`);
        }
      }
    }
  
    async resumeContext() {
      try {
        if (this.audioContext && this.audioContext.state === 'suspended') {
          await this.audioContext.resume();
          console.log('AudioContext resumed');
        }
      } catch (error) {
        console.error('Failed to resume AudioContext:', error);
      }
    }
  
    async stop() {
      this.isRunning = false;
      
      // Stop microphone tracks
      if (this.microphoneStream) {
        this.microphoneStream.getTracks().forEach(track => track.stop());
        this.microphoneStream = null;
      }
      
      // Close audio context
      if (this.audioContext) {
        await this.audioContext.close();
        this.audioContext = null;
      }
      
      this.isInitialized = false;
      console.log('Chirp detection stopped');
    }
  
    addTemplate(name, duration, f0, f1) {
      if (!this.isInitialized) {
        console.warn('Detector not initialized. Call initialize() first.');
        return false;
      }
  
      this.templates.set(name, { duration, f0, f1 });
      
      this.workletNode.port.postMessage({
        type: 'addTemplate',
        name: name,
        duration: duration,
        f0: f0,
        f1: f1
      });
      
      console.log(`Template "${name}" added: ${f0}Hz → ${f1}Hz (${duration}s)`);
      return true;
    }
  
    setDetectionThreshold(threshold) {
      if (this.isInitialized) {
        this.workletNode.port.postMessage({
          type: 'setThreshold',
          threshold: threshold
        });
      }
    }
  
    handleWorkletMessage(message) {
      switch (message.type) {
        case 'chirpDetected':
          console.log(`Chirp detected: ${message.name} (confidence: ${message.confidence.toFixed(3)}, SNR: ${message.snr?.toFixed(1)})`);
          this.notifyDetection(message);
          break;
          
        case 'templateAdded':
          console.log(`Template "${message.name}" loaded in worklet`);
          break;
      }
    }
  
    handleProcessorError() {
      console.error('AudioWorklet processor crashed, attempting to restart...');
      this.reinitialize();
    }
  
    async reinitialize() {
      await this.stop();
      await new Promise(resolve => setTimeout(resolve, 500));
      await this.initialize();
      
      if (this.isRunning) {
        await this.start();
      }
    }
  
    onDetection(callback) {
      this.detectionCallbacks.push(callback);
    }
  
    notifyDetection(detection) {
      this.detectionCallbacks.forEach(callback => {
        try {
          callback(detection);
        } catch (error) {
          console.error('Error in detection callback:', error);
        }
      });
    }
  
    // Generate and play test chirp for verification
    async playTestChirp(duration = 1.0, f0 = 100, f1 = 2000, volume = 0.3) {
      if (!this.audioContext) {
        await this.initialize();
      }
      
      const chirp = this.generateTestChirp(duration, f0, f1, volume);
      const buffer = this.audioContext.createBuffer(1, chirp.length, this.audioContext.sampleRate);
      buffer.getChannelData(0).set(chirp);
      
      const source = this.audioContext.createBufferSource();
      const gainNode = this.audioContext.createGain();
      
      source.buffer = buffer;
      source.connect(gainNode);
      gainNode.connect(this.audioContext.destination);
      
      // Set volume
      gainNode.gain.value = volume;
      
      source.start();
      
      return new Promise(resolve => {
        source.onended = resolve;
      });
    }
  
    generateTestChirp(duration, f0, f1, volume = 0.3) {
      const length = Math.floor(duration * 44100);
      const chirp = new Float32Array(length);
      const fadeSamples = Math.min(100, length / 10);
      
      for (let i = 0; i < length; i++) {
        const t = i / 44100;
        const phase = 2 * Math.PI * (f0 * t + (f1 - f0) * t * t / (2 * duration));
        
        let amplitude = volume;
        // Add fade in/out
        if (i < fadeSamples) {
          amplitude *= (i / fadeSamples);
        } else if (i > length - fadeSamples) {
          amplitude *= ((length - i) / fadeSamples);
        }
        
        chirp[i] = Math.sin(phase) * amplitude;
      }
      
      return chirp;
    }
  
    // Method to test the detection system
    async runSelfTest() {
      console.log('Running self-test...');
      
      if (!this.isRunning) {
        await this.start();
      }
      
      // Add a test template
      this.addTemplate('self_test_chirp', 1.0, 500, 1500);
      
      // Wait a moment for template to load
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Play test chirp
      console.log('Playing test chirp...');
      await this.playTestChirp(1.0, 500, 1500, 0.5);
      
      console.log('Self-test completed. Check console for detections.');
    }
  }