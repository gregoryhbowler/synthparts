/**
 * WASP Filter - AudioWorklet Processor
 * 
 * Emulation of the EDP Wasp synthesizer's CD4069UB CMOS filter.
 */

class WaspProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'cutoff', defaultValue: 1000, minValue: 20, maxValue: 20000, automationRate: 'a-rate' },
      { name: 'resonance', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
      { name: 'mode', defaultValue: 0, minValue: 0, maxValue: 3, automationRate: 'k-rate' },
      { name: 'drive', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
      { name: 'chaos', defaultValue: 0.3, minValue: 0, maxValue: 1, automationRate: 'k-rate' }
    ];
  }

  constructor() {
    super();
    
    // SVF state (stereo)
    this.s1 = [0, 0]; // integrator 1 state
    this.s2 = [0, 0]; // integrator 2 state
    
    // Bias drift
    this.bias = [0, 0];
    this.biasTarget = [0, 0];
    
    // DC blocker
    this.dcX = [0, 0];
    this.dcY = [0, 0];
    
    // Debug: log first few blocks
    this.debugCount = 0;
  }

  // Fast tanh
  tanh(x) {
    if (x < -3) return -1;
    if (x > 3) return 1;
    const x2 = x * x;
    return x * (27 + x2) / (27 + 9 * x2);
  }

  // CMOS nonlinearity
  cmos(x, bias, drive) {
    const input = x + bias * 0.1;
    const gained = input * (1 + drive * 3);
    const asymm = gained >= 0 ? gained * 1.1 : gained * 0.9;
    return this.tanh(asymm);
  }

  // DC blocker
  dcBlock(x, ch) {
    const y = x - this.dcX[ch] + 0.995 * this.dcY[ch];
    this.dcX[ch] = x;
    this.dcY[ch] = y;
    return y;
  }

  updateBias(chaos) {
    for (let ch = 0; ch < 2; ch++) {
      if (Math.random() < 0.01) {
        this.biasTarget[ch] = (Math.random() - 0.5) * chaos;
      }
      this.bias[ch] += (this.biasTarget[ch] - this.bias[ch]) * 0.001;
    }
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    
    if (!output || output.length === 0) return true;
    
    const blockSize = output[0].length;
    const numChannels = output.length;
    
    // Debug logging
    if (this.debugCount < 3) {
      this.debugCount++;
      console.log('Process called:', {
        hasInput: !!input,
        inputChannels: input ? input.length : 0,
        inputHasData: input && input[0] ? input[0].some(x => x !== 0) : false,
        outputChannels: numChannels,
        blockSize: blockSize
      });
    }
    
    // Get parameters
    const cutoffArr = parameters.cutoff;
    const resArr = parameters.resonance;
    const driveArr = parameters.drive;
    const mode = parameters.mode[0];
    const chaos = parameters.chaos[0];
    
    this.updateBias(chaos);
    
    for (let ch = 0; ch < numChannels; ch++) {
      // Get input channel - if no input, use zeros
      const hasInput = input && input[ch] && input[ch].length > 0;
      const out = output[ch];
      const bias = this.bias[Math.min(ch, 1)];
      
      for (let i = 0; i < blockSize; i++) {
        const v0 = hasInput ? input[ch][i] : 0;
        
        // Get per-sample parameters
        const cutoff = cutoffArr.length > 1 ? cutoffArr[i] : cutoffArr[0];
        const res = resArr.length > 1 ? resArr[i] : resArr[0];
        const drive = driveArr.length > 1 ? driveArr[i] : driveArr[0];
        
        // Add tiny noise
        const noisy = v0 + (Math.random() - 0.5) * 0.00001 * (1 + chaos);
        
        // TPT SVF coefficients
        const g = Math.tan(Math.PI * Math.min(cutoff, sampleRate * 0.49) / sampleRate);
        const k = 2 - res * 1.98; // k from 2 (no res) to 0.02 (max res)
        
        // Correct TPT SVF (Zavalishin)
        // hp = (v0 - k*s1 - s2) / (1 + k*g + g*g)
        const denom = 1 + k * g + g * g;
        const hp = (noisy - k * this.s1[ch] - this.s2[ch]) / denom;
        
        // Bandpass with CMOS nonlinearity
        const bpLinear = g * hp + this.s1[ch];
        const bp = this.cmos(bpLinear, bias, drive);
        
        // Lowpass with CMOS nonlinearity
        const lpLinear = g * bp + this.s2[ch];
        const lp = this.cmos(lpLinear, bias * 0.7, drive);
        
        // Update states (trapezoidal integration)
        this.s1[ch] = 2 * bp - this.s1[ch];
        this.s2[ch] = 2 * lp - this.s2[ch];
        
        // Clamp states
        this.s1[ch] = Math.max(-5, Math.min(5, this.s1[ch]));
        this.s2[ch] = Math.max(-5, Math.min(5, this.s2[ch]));
        
        // Notch = HP + LP
        const notch = hp + lp;
        
        // Mode selection
        let filtered;
        if (mode < 0.5) {
          filtered = lp;
        } else if (mode < 1.5) {
          filtered = bp;
        } else if (mode < 2.5) {
          filtered = hp;
        } else {
          filtered = notch;
        }
        
        // Output with soft saturation
        const saturated = this.tanh(filtered * (1 + drive * 0.5));
        out[i] = this.dcBlock(saturated, ch);
      }
    }
    
    return true;
  }
}

registerProcessor('wasp-processor', WaspProcessor);
