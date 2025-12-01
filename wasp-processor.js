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
    
    // Base sample rate
    this.baseSampleRate = sampleRate;
    
    // SVF state variables (stereo)
    this.s1 = [0, 0];
    this.s2 = [0, 0];
    
    // Oversampling state
    this.prevSample = [0, 0];
    
    // Bias drift state
    this.biasDrift = [0, 0];
    this.biasDriftTarget = [0, 0];
    
    // DC blocker state
    this.dcX = [0, 0];
    this.dcY = [0, 0];
  }

  /**
   * Fast tanh approximation
   */
  fastTanh(x) {
    if (x < -3) return -1;
    if (x > 3) return 1;
    const x2 = x * x;
    return x * (27 + x2) / (27 + 9 * x2);
  }

  /**
   * CMOS inverter nonlinearity model
   */
  cmosNonlinearity(x, bias, drive) {
    const biased = x + bias * 0.05;
    const asymmetry = biased >= 0 ? 1.12 : 0.88;
    const driven = biased * (1 + drive * 2.5) * asymmetry;
    const clipped = this.fastTanh(driven);
    const cubic = 0.08 * driven * (1 - clipped * clipped);
    return clipped + cubic * drive;
  }

  /**
   * Update bias drift once per block
   */
  updateBiasDrift(chaos) {
    for (let ch = 0; ch < 2; ch++) {
      if (Math.random() < 0.02) {
        this.biasDriftTarget[ch] = (Math.random() - 0.5) * chaos * 0.8;
      }
      this.biasDrift[ch] += (this.biasDriftTarget[ch] - this.biasDrift[ch]) * 0.001;
      this.biasDrift[ch] += (Math.random() - 0.5) * 0.0005 * chaos;
    }
  }

  /**
   * DC blocker
   */
  dcBlock(x, ch) {
    const R = 0.995;
    const y = x - this.dcX[ch] + R * this.dcY[ch];
    this.dcX[ch] = x;
    this.dcY[ch] = y;
    return y;
  }

  /**
   * Process one sample through WASP filter (TPT SVF with nonlinear integrators)
   */
  processSample(v0, cutoff, resonance, mode, drive, bias, ch, oversampledRate) {
    // Clamp cutoff to safe range
    const fc = Math.min(cutoff, oversampledRate * 0.49);
    const g = Math.tan(Math.PI * fc / oversampledRate);
    
    // Resonance: k = 1/Q, where Q ranges from 0.5 to ~50
    const Q = 0.5 + resonance * 49.5;
    const k = 1 / Q;
    
    // TPT SVF
    const a1 = 1 / (1 + g * (g + k));
    const a2 = g * a1;
    const a3 = g * a2;
    
    const v3 = v0 - this.s2[ch];
    
    // First integrator path with nonlinearity
    const v1_linear = a2 * v3 + a1 * this.s1[ch];
    const v1 = this.cmosNonlinearity(v1_linear, bias, drive);
    
    // Second integrator path with nonlinearity
    const v2_linear = a3 * v3 + a2 * this.s1[ch] + this.s2[ch];
    const v2 = this.cmosNonlinearity(v2_linear, bias * 0.7, drive);
    
    // Update state
    this.s1[ch] = 2 * v1 - this.s1[ch];
    this.s2[ch] = 2 * v2 - this.s2[ch];
    
    // Limit state to prevent blowup
    this.s1[ch] = this.fastTanh(this.s1[ch] * 0.5) * 2;
    this.s2[ch] = this.fastTanh(this.s2[ch] * 0.5) * 2;
    
    // Outputs: LP = v2, BP = v1, HP = v0 - k*v1 - v2
    const lp = v2;
    const bp = v1;
    const hp = v0 - k * v1 - v2;
    const notch = lp + hp;
    
    // Mode interpolation
    const outputs = [lp, bp, hp, notch];
    const modeFloor = Math.floor(mode);
    const modeFrac = mode - modeFloor;
    
    if (modeFrac < 0.001 || modeFloor >= 3) {
      return outputs[Math.min(modeFloor, 3)];
    }
    return outputs[modeFloor] * (1 - modeFrac) + outputs[modeFloor + 1] * modeFrac;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    
    if (!output || !output[0]) return true;
    
    const blockSize = output[0].length;
    const oversampledRate = this.baseSampleRate * 2;
    
    // Get parameters
    const cutoffParam = parameters.cutoff;
    const resonanceParam = parameters.resonance;
    const modeParam = parameters.mode;
    const driveParam = parameters.drive;
    const chaosParam = parameters.chaos;
    
    const mode = modeParam[0];
    const chaos = chaosParam[0];
    
    this.updateBiasDrift(chaos);
    
    const numChannels = output.length;
    
    for (let ch = 0; ch < numChannels; ch++) {
      const inputChannel = (input && input[ch]) ? input[ch] : null;
      const outputChannel = output[ch];
      const chIdx = Math.min(ch, 1);
      const bias = this.biasDrift[chIdx];
      
      for (let i = 0; i < blockSize; i++) {
        const inputSample = inputChannel ? inputChannel[i] : 0;
        
        const cutoff = cutoffParam.length > 1 ? cutoffParam[i] : cutoffParam[0];
        const resonance = resonanceParam.length > 1 ? resonanceParam[i] : resonanceParam[0];
        const drive = driveParam.length > 1 ? driveParam[i] : driveParam[0];
        
        // Tiny noise for analog character
        const noise = (Math.random() - 0.5) * 0.00005 * (1 + chaos);
        const v0 = inputSample + noise;
        
        // 2x oversample: interpolate input, process twice, average output
        const mid = (this.prevSample[chIdx] + v0) * 0.5;
        this.prevSample[chIdx] = v0;
        
        const out1 = this.processSample(mid, cutoff, resonance, mode, drive, bias, chIdx, oversampledRate);
        const out2 = this.processSample(v0, cutoff, resonance, mode, drive, bias, chIdx, oversampledRate);
        
        // Average and apply soft saturation on output
        const filtered = (out1 + out2) * 0.5;
        const saturated = this.fastTanh(filtered * (1 + drive * 0.3));
        
        outputChannel[i] = this.dcBlock(saturated, chIdx);
      }
    }
    
    return true;
  }
}

registerProcessor('wasp-processor', WaspProcessor);
