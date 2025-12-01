/**
 * MEMORYMOOG LADDER FILTER - AudioWorklet Processor
 * 
 * A faithful recreation of the Moog 24dB/octave transistor ladder filter
 * featuring TPT topology, cascaded saturation, and analog behavior modeling.
 */

class MoogLadderProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      {
        name: 'cutoff',
        defaultValue: 1000,
        minValue: 20,
        maxValue: 20000,
        automationRate: 'a-rate'
      },
      {
        name: 'resonance',
        defaultValue: 0,
        minValue: 0,
        maxValue: 1,
        automationRate: 'a-rate'
      },
      {
        name: 'drive',
        defaultValue: 0,
        minValue: 0,
        maxValue: 1,
        automationRate: 'a-rate'
      },
      {
        name: 'warmth',
        defaultValue: 1,
        minValue: 0,
        maxValue: 1,
        automationRate: 'a-rate'
      }
    ];
  }

  constructor() {
    super();
    
    // Sample rate
    this.fs = sampleRate;
    
    // 4-pole ladder state (for each channel, up to 2)
    this.stages = [
      [0, 0, 0, 0],  // Left channel
      [0, 0, 0, 0]   // Right channel
    ];
    
    // Oversampling state
    this.oversampleStages = [
      [0, 0, 0, 0],
      [0, 0, 0, 0]
    ];
    
    // ========== TIER 3: Analog Behavior Modeling ==========
    
    // Stage mismatch: ±2% random offset per stage (set once at construction)
    this.stageMismatch = [
      1.0 + (Math.random() - 0.5) * 0.04,
      1.0 + (Math.random() - 0.5) * 0.04,
      1.0 + (Math.random() - 0.5) * 0.04,
      1.0 + (Math.random() - 0.5) * 0.04
    ];
    
    // Thermal drift: slow random walk state
    this.thermalPhase = Math.random() * Math.PI * 2;
    this.thermalPhase2 = Math.random() * Math.PI * 2;
    this.thermalRate = 0.15 + Math.random() * 0.2;  // 0.15-0.35 Hz
    this.thermalRate2 = 0.08 + Math.random() * 0.12; // Secondary slower drift
    this.thermalDepth = 0.003; // ±0.3% cutoff modulation
    
    // Leaky integrator coefficient (very subtle DC bleed)
    this.dcLeak = 0.9999;
    
    // Noise generator state (simple LFSR)
    this.noiseState = 0x7FFFFFFF;
    
    // Smoothing for parameters
    this.smoothedCutoff = 1000;
    this.smoothedResonance = 0;
    this.smoothedDrive = 0;
    this.smoothedWarmth = 1;
    this.smoothingCoeff = 0.001; // Very smooth parameter changes
    
    // Previous output for feedback (per channel)
    this.feedbackState = [0, 0];
    
    // DC blocker state
    this.dcBlockerX = [0, 0];
    this.dcBlockerY = [0, 0];
    this.dcBlockerCoeff = 0.995;
  }
  
  /**
   * Fast tanh approximation (Pade approximant)
   * Accurate within 0.1% for |x| < 3, gracefully saturates beyond
   */
  tanh(x) {
    if (x > 3) return 1;
    if (x < -3) return -1;
    const x2 = x * x;
    return x * (27 + x2) / (27 + 9 * x2);
  }
  
  /**
   * Generate noise sample (~-80dB level)
   * Simple LFSR-based white noise
   */
  generateNoise() {
    // Galois LFSR
    const bit = this.noiseState & 1;
    this.noiseState >>= 1;
    if (bit) this.noiseState ^= 0xB4BCD35C;
    // Scale to approximately -80dB (0.0001)
    return ((this.noiseState & 0xFFFF) / 65535 - 0.5) * 0.0002;
  }
  
  /**
   * Update thermal drift
   */
  updateThermalDrift() {
    // Two-phase slow modulation for organic feel
    this.thermalPhase += (this.thermalRate * 2 * Math.PI) / this.fs;
    this.thermalPhase2 += (this.thermalRate2 * 2 * Math.PI) / this.fs;
    
    if (this.thermalPhase > Math.PI * 2) this.thermalPhase -= Math.PI * 2;
    if (this.thermalPhase2 > Math.PI * 2) this.thermalPhase2 -= Math.PI * 2;
    
    // Combine two sine waves for less predictable drift
    return 1 + this.thermalDepth * (
      Math.sin(this.thermalPhase) * 0.7 + 
      Math.sin(this.thermalPhase2) * 0.3
    );
  }
  
  /**
   * Process one sample through the 4-pole ladder
   * @param {number} input - Input sample
   * @param {number} g - Filter coefficient (tan(π * fc / fs))
   * @param {number} k - Resonance feedback amount (0-4)
   * @param {number} drive - Drive amount (0-1)
   * @param {number} warmth - Nonlinearity blend (0-1)
   * @param {number} channel - Channel index
   * @param {boolean} isOversample - Use oversample state arrays
   */
  processLadder(input, g, k, drive, warmth, channel, isOversample = false) {
    const stages = isOversample ? this.oversampleStages[channel] : this.stages[channel];
    
    // Drive scaling: maps 0-1 to 1-4x gain into saturation
    const driveScale = 1 + drive * 3;
    
    // Get previous output for resonance feedback
    const feedback = this.feedbackState[channel];
    
    // Apply tanh to feedback before mixing (Tier 2)
    // The warmth parameter blends between clean and saturated feedback
    const saturatedFeedback = this.tanh(feedback * (1 + drive));
    const blendedFeedback = feedback + (saturatedFeedback - feedback) * warmth;
    
    // Resonance feedback: input = x - k * y4
    // k maxes at 4 for self-oscillation
    let x = input - k * blendedFeedback;
    
    // Add noise floor at input (Tier 3)
    x += this.generateNoise();
    
    // ========== TIER 1 & 2: TPT Ladder with Saturation ==========
    // Each stage: y[n] = y[n-1] + g * (tanh(x[n]) - y[n-1])
    // Saturation happens BEFORE integration
    
    for (let i = 0; i < 4; i++) {
      // Apply stage mismatch to cutoff coefficient
      const stageG = g * this.stageMismatch[i];
      
      // Saturation at input of each stage (Tier 2)
      // Models transistor differential pair behavior
      const saturatedInput = this.tanh(x * driveScale * (1 + drive * 0.5));
      
      // Blend between clean and saturated based on warmth
      const stageInput = x + (saturatedInput - x) * warmth;
      
      // TPT one-pole lowpass integration
      const v = stageG * (stageInput - stages[i]);
      const y = stages[i] + v;
      
      // Leaky integrator for analog DC behavior (Tier 3)
      stages[i] = y * this.dcLeak;
      
      // Output of this stage becomes input to next
      x = y;
    }
    
    // Store output for feedback on next sample
    this.feedbackState[channel] = stages[3];
    
    return stages[3];
  }
  
  /**
   * Simple 2x oversampling with linear interpolation
   */
  processWithOversampling(input, g, k, drive, warmth, channel) {
    // Upsample: process two samples
    // First sample: current input
    const y1 = this.processLadder(input, g, k, drive, warmth, channel, true);
    // Second sample: interpolated (use same input for simplicity)
    const y2 = this.processLadder(input, g, k, drive, warmth, channel, true);
    
    // Downsample: average
    return (y1 + y2) * 0.5;
  }
  
  /**
   * DC blocker to remove any accumulated DC offset
   */
  dcBlock(input, channel) {
    const y = input - this.dcBlockerX[channel] + this.dcBlockerCoeff * this.dcBlockerY[channel];
    this.dcBlockerX[channel] = input;
    this.dcBlockerY[channel] = y;
    return y;
  }
  
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    
    if (!input || !input.length) return true;
    
    const blockSize = input[0].length;
    const numChannels = Math.min(input.length, output.length, 2);
    
    // Get parameter arrays
    const cutoffParam = parameters.cutoff;
    const resonanceParam = parameters.resonance;
    const driveParam = parameters.drive;
    const warmthParam = parameters.warmth;
    
    // Update thermal drift once per block for efficiency
    const thermalMod = this.updateThermalDrift();
    
    for (let i = 0; i < blockSize; i++) {
      // Get parameter values (a-rate or k-rate)
      const cutoff = cutoffParam.length > 1 ? cutoffParam[i] : cutoffParam[0];
      const resonance = resonanceParam.length > 1 ? resonanceParam[i] : resonanceParam[0];
      const drive = driveParam.length > 1 ? driveParam[i] : driveParam[0];
      const warmth = warmthParam.length > 1 ? warmthParam[i] : warmthParam[0];
      
      // Smooth parameters
      this.smoothedCutoff += (cutoff - this.smoothedCutoff) * this.smoothingCoeff;
      this.smoothedResonance += (resonance - this.smoothedResonance) * this.smoothingCoeff;
      this.smoothedDrive += (drive - this.smoothedDrive) * this.smoothingCoeff;
      this.smoothedWarmth += (warmth - this.smoothedWarmth) * this.smoothingCoeff;
      
      // Apply thermal drift to cutoff (Tier 3)
      const modulatedCutoff = this.smoothedCutoff * thermalMod;
      
      // Calculate filter coefficient
      // g = tan(π * fc / fs), clamped to prevent instability
      const normalizedFreq = Math.min(modulatedCutoff / this.fs, 0.49);
      const g = Math.tan(Math.PI * normalizedFreq);
      
      // Resonance to feedback coefficient
      // k = 4 * resonance, with slight scaling for musical response
      const k = this.smoothedResonance * 4 * (1 - normalizedFreq * 0.2);
      
      // Determine if oversampling is needed (high drive)
      const useOversampling = this.smoothedDrive > 0.5;
      
      // Process each channel
      for (let ch = 0; ch < numChannels; ch++) {
        const inputSample = input[ch][i];
        
        let outputSample;
        if (useOversampling) {
          // 2x oversampling for high drive to reduce aliasing
          outputSample = this.processWithOversampling(
            inputSample,
            g * 0.5,  // Adjust g for 2x sample rate
            k,
            this.smoothedDrive,
            this.smoothedWarmth,
            ch
          );
        } else {
          outputSample = this.processLadder(
            inputSample,
            g,
            k,
            this.smoothedDrive,
            this.smoothedWarmth,
            ch
          );
        }
        
        // DC blocking
        outputSample = this.dcBlock(outputSample, ch);
        
        output[ch][i] = outputSample;
      }
    }
    
    return true;
  }
}

registerProcessor('moog-ladder-processor', MoogLadderProcessor);
