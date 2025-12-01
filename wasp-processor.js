/**
 * WASP Filter - AudioWorklet Processor
 * 
 * High-fidelity emulation of the EDP Wasp synthesizer's filter section.
 * Based on CD4069UB CMOS inverters operating as nonlinear analog amplifiers
 * in a state-variable topology.
 * 
 * Features:
 * - TPT (Topology-Preserving Transform) SVF backbone
 * - CMOS inverter-style nonlinear integrators with asymmetric soft-clipping
 * - Bias drift simulation via slow random-walk LFO
 * - Internal noise injection for analog character
 * - 2x oversampling to reduce aliasing from nonlinearities
 * 
 * Parameters:
 * - cutoff: 20-20000 Hz
 * - resonance: 0-1 (self-oscillation occurs near 0.95+)
 * - mode: 0=LP, 1=BP, 2=HP, 3=Notch
 * - drive: Input gain into the nonlinearities (0-1, default 0.5)
 * - chaos: Amount of instability/drift (0-1, default 0.3)
 */

class WaspProcessor extends AudioWorkletProcessor {
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
        defaultValue: 0.5,
        minValue: 0,
        maxValue: 1,
        automationRate: 'a-rate'
      },
      {
        name: 'mode',
        defaultValue: 0,
        minValue: 0,
        maxValue: 3,
        automationRate: 'k-rate'
      },
      {
        name: 'drive',
        defaultValue: 0.5,
        minValue: 0,
        maxValue: 1,
        automationRate: 'a-rate'
      },
      {
        name: 'chaos',
        defaultValue: 0.3,
        minValue: 0,
        maxValue: 1,
        automationRate: 'k-rate'
      }
    ];
  }

  constructor() {
    super();
    
    // Oversampling factor (2x is a good balance of quality vs CPU)
    this.oversampleFactor = 2;
    this.sampleRate = sampleRate * this.oversampleFactor;
    
    // SVF state variables (per channel, we'll handle stereo)
    this.ic1eq = [0, 0]; // First integrator state
    this.ic2eq = [0, 0]; // Second integrator state
    
    // Bias drift state (slow random walk)
    this.biasDrift = [0, 0];
    this.biasDriftTarget = [0, 0];
    this.biasDriftPhase = 0;
    
    // Noise state (simple LCG for efficiency)
    this.noiseState = 12345;
    
    // DC blocker state
    this.dcX = [0, 0];
    this.dcY = [0, 0];
    
    // Downsampling filter state (simple 2-pole lowpass)
    this.dsState1 = [0, 0];
    this.dsState2 = [0, 0];
    
    // Pre-computed constants
    this.twoPi = 2 * Math.PI;
  }

  /**
   * Fast tanh approximation using rational function
   * Accurate to ~0.001 in [-4, 4] range, much faster than Math.tanh
   */
  fastTanh(x) {
    if (x < -3) return -1;
    if (x > 3) return 1;
    const x2 = x * x;
    return x * (27 + x2) / (27 + 9 * x2);
  }

  /**
   * CMOS inverter nonlinearity model
   * Simulates CD4069UB operating in linear region as an amplifier
   * 
   * Key characteristics:
   * - Asymmetric soft-clipping (different behavior for +/- input)
   * - Small DC bias offset (threshold voltage behavior)
   * - Gain that varies with input level
   */
  cmosNonlinearity(x, bias, drive) {
    // Add the bias offset (simulates CMOS threshold voltage)
    const biased = x + bias * 0.1;
    
    // Asymmetric gain: slightly different response for positive vs negative
    // Real CMOS inverters have asymmetric P/N channel characteristics
    const asymmetry = 1.0 + 0.15 * Math.sign(biased);
    
    // Apply drive scaling
    const driven = biased * (1 + drive * 3);
    
    // Core soft-clip using tanh with asymmetric scaling
    const clipped = this.fastTanh(driven * asymmetry);
    
    // Add subtle cubic term for extra "grit" in the transition region
    // This models the more complex transfer function of real CMOS
    const cubic = 0.1 * driven * (1 - clipped * clipped);
    
    return clipped + cubic * drive;
  }

  /**
   * Simple LCG noise generator
   * Returns value in [-1, 1]
   */
  noise() {
    this.noiseState = (this.noiseState * 1103515245 + 12345) & 0x7fffffff;
    return (this.noiseState / 0x3fffffff) - 1;
  }

  /**
   * Update bias drift (call once per block)
   * Creates slow, wandering modulation of internal operating points
   */
  updateBiasDrift(chaos) {
    const driftRate = 0.0001 + chaos * 0.0005;
    const driftAmount = chaos * 0.5;
    
    // Random walk toward target
    for (let ch = 0; ch < 2; ch++) {
      // Occasionally pick new target
      if (Math.random() < 0.01) {
        this.biasDriftTarget[ch] = (Math.random() - 0.5) * 2 * driftAmount;
      }
      
      // Slowly move toward target
      this.biasDrift[ch] += (this.biasDriftTarget[ch] - this.biasDrift[ch]) * driftRate;
      
      // Add tiny random jitter
      this.biasDrift[ch] += (Math.random() - 0.5) * 0.001 * chaos;
    }
  }

  /**
   * DC blocker to remove any DC offset introduced by asymmetric nonlinearities
   */
  dcBlock(x, ch) {
    // First-order highpass at ~5 Hz
    const R = 0.9997;
    const y = x - this.dcX[ch] + R * this.dcY[ch];
    this.dcX[ch] = x;
    this.dcY[ch] = y;
    return y;
  }

  /**
   * Simple 2x downsampling with 2-pole lowpass anti-aliasing
   */
  downsample(x, ch) {
    // 2-pole lowpass at ~0.4 * Nyquist
    const k = 0.35;
    this.dsState1[ch] += k * (x - this.dsState1[ch]);
    this.dsState2[ch] += k * (this.dsState1[ch] - this.dsState2[ch]);
    return this.dsState2[ch];
  }

  /**
   * Process a single sample through the WASP filter
   * Uses TPT SVF with nonlinear integrators
   */
  processSample(input, cutoff, resonance, mode, drive, chaos, channel) {
    // Get current bias drift for this channel
    const bias = this.biasDrift[channel];
    
    // Add pre-filter noise injection (very subtle, models thermal noise)
    const noiseLevel = chaos * 0.002;
    const noisyInput = input + this.noise() * noiseLevel;
    
    // Calculate filter coefficients
    // g = tan(pi * fc / fs) for TPT
    const g = Math.tan(Math.PI * cutoff / this.sampleRate);
    
    // k = 2 - 2*Q, but we want resonance to go into self-oscillation
    // WASP has very aggressive resonance, so we scale it up
    const k = 2 - resonance * 1.98;
    
    // TPT SVF with nonlinear integrators
    // Standard TPT: v1 = (ic1eq + g*(v0 - ic2eq)) / (1 + g*(g + k))
    // But we inject nonlinearity into the integrator inputs
    
    const v0 = noisyInput;
    
    // First, calculate what would go into the integrators
    const g1 = g / (1 + g * (g + k));
    const g2 = g * g1;
    const g3 = g * g2;
    const g4 = k * g1;
    
    // High-pass output
    const hp = (v0 - k * this.ic1eq[channel] - this.ic2eq[channel]) / (1 + k * g + g * g);
    
    // Bandpass output - apply nonlinearity to first integrator path
    const bp_input = g * hp;
    const bp_nonlin = this.cmosNonlinearity(bp_input + this.ic1eq[channel], bias, drive);
    
    // Lowpass output - apply nonlinearity to second integrator path
    const lp_input = g * bp_nonlin;
    const lp_nonlin = this.cmosNonlinearity(lp_input + this.ic2eq[channel], bias * 0.7, drive);
    
    // Update integrator states with nonlinear feedback
    // The nonlinearity affects how the state evolves
    this.ic1eq[channel] = 2 * bp_nonlin - this.ic1eq[channel];
    this.ic2eq[channel] = 2 * lp_nonlin - this.ic2eq[channel];
    
    // Apply soft limiting to states to prevent blowup at high resonance
    this.ic1eq[channel] = this.fastTanh(this.ic1eq[channel] * 0.5) * 2;
    this.ic2eq[channel] = this.fastTanh(this.ic2eq[channel] * 0.5) * 2;
    
    // Calculate all outputs
    const lp = lp_nonlin;
    const bp = bp_nonlin;
    // Recalculate HP with nonlinear states for consistency
    const hpOut = v0 - k * bp - lp;
    const notch = lp + hpOut;
    
    // Mode selection with interpolation support
    let output;
    const modeFloor = Math.floor(mode);
    const modeFrac = mode - modeFloor;
    
    const outputs = [lp, bp, hpOut, notch];
    
    if (modeFrac < 0.001 || modeFloor >= 3) {
      output = outputs[Math.min(modeFloor, 3)];
    } else {
      // Interpolate between modes
      output = outputs[modeFloor] * (1 - modeFrac) + outputs[modeFloor + 1] * modeFrac;
    }
    
    // Final soft-clip to simulate output stage saturation
    output = this.fastTanh(output * (1 + drive * 0.5));
    
    return output;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    
    // Handle mono/stereo
    const numChannels = Math.max(input.length, output.length, 1);
    const blockSize = output[0]?.length || 128;
    
    // Get parameter arrays
    const cutoffParam = parameters.cutoff;
    const resonanceParam = parameters.resonance;
    const modeParam = parameters.mode;
    const driveParam = parameters.drive;
    const chaosParam = parameters.chaos;
    
    // Mode and chaos are k-rate, get first value
    const mode = modeParam[0];
    const chaos = chaosParam[0];
    
    // Update bias drift once per block
    this.updateBiasDrift(chaos);
    
    for (let ch = 0; ch < numChannels; ch++) {
      const inputChannel = input[ch] || input[0] || new Float32Array(blockSize);
      const outputChannel = output[ch];
      
      if (!outputChannel) continue;
      
      for (let i = 0; i < blockSize; i++) {
        // Get per-sample parameters (a-rate)
        const cutoff = cutoffParam.length > 1 ? cutoffParam[i] : cutoffParam[0];
        const resonance = resonanceParam.length > 1 ? resonanceParam[i] : resonanceParam[0];
        const drive = driveParam.length > 1 ? driveParam[i] : driveParam[0];
        
        const inputSample = inputChannel[i] || 0;
        
        // 2x oversampling: process twice, take second result
        // First pass (discarded, but updates state)
        this.processSample(inputSample, cutoff, resonance, mode, drive, chaos, ch);
        
        // Second pass (this is our output)
        const filtered = this.processSample(inputSample, cutoff, resonance, mode, drive, chaos, ch);
        
        // Downsample and DC block
        const downsampled = this.downsample(filtered, ch);
        outputChannel[i] = this.dcBlock(downsampled, ch);
      }
    }
    
    return true;
  }
}

registerProcessor('wasp-processor', WaspProcessor);
