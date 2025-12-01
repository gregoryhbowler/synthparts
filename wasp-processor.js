/**
 * WASP Filter - AudioWorklet Processor
 * 
 * Emulation of the EDP Wasp synthesizer's CD4069UB CMOS filter.
 * TPT SVF core with nonlinear integrators modeling the CMOS inverter behavior.
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
    this.s1 = [0, 0]; // bandpass state
    this.s2 = [0, 0]; // lowpass state
    
    // Bias drift for analog character
    this.bias = [0, 0];
    this.biasTarget = [0, 0];
    
    // DC blocker
    this.dcX = [0, 0];
    this.dcY = [0, 0];
  }

  // Fast tanh approximation
  tanh(x) {
    if (x < -3) return -1;
    if (x > 3) return 1;
    const x2 = x * x;
    return x * (27 + x2) / (27 + 9 * x2);
  }

  // CMOS inverter nonlinearity - asymmetric soft clip
  cmos(x, bias, drive) {
    const input = x + bias * 0.1;
    const gained = input * (1 + drive * 3);
    // Asymmetry: positive side clips slightly harder
    const asymm = gained >= 0 ? gained * 1.1 : gained * 0.9;
    return this.tanh(asymm);
  }

  // DC blocking filter
  dcBlock(x, ch) {
    const y = x - this.dcX[ch] + 0.995 * this.dcY[ch];
    this.dcX[ch] = x;
    this.dcY[ch] = y;
    return y;
  }

  // Update bias drift (once per block)
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
    
    if (!output || !output[0]) return true;
    
    const blockSize = output[0].length;
    const numChannels = Math.min(output.length, 2);
    
    // Get parameters
    const cutoffArr = parameters.cutoff;
    const resArr = parameters.resonance;
    const driveArr = parameters.drive;
    const mode = parameters.mode[0];
    const chaos = parameters.chaos[0];
    
    this.updateBias(chaos);
    
    for (let ch = 0; ch < numChannels; ch++) {
      const inp = input[ch] || new Float32Array(blockSize);
      const out = output[ch];
      const bias = this.bias[ch];
      
      for (let i = 0; i < blockSize; i++) {
        // Get sample parameters
        const cutoff = cutoffArr.length > 1 ? cutoffArr[i] : cutoffArr[0];
        const res = resArr.length > 1 ? resArr[i] : resArr[0];
        const drive = driveArr.length > 1 ? driveArr[i] : driveArr[0];
        
        // Input with tiny noise for analog feel
        const v0 = inp[i] + (Math.random() - 0.5) * 0.0001 * chaos;
        
        // TPT SVF coefficients
        const fc = Math.min(cutoff, sampleRate * 0.49);
        const g = Math.tan(Math.PI * fc / sampleRate);
        
        // Q from 0.5 to 50, k = 1/Q
        const Q = 0.5 + res * 49.5;
        const k = 1 / Q;
        
        // SVF computation (Zavalishin TPT)
        const a1 = 1 / (1 + g * (g + k));
        const a2 = g * a1;
        const a3 = g * a2;
        
        // Process with nonlinear integrators
        const v3 = v0 - this.s2[ch];
        
        // Bandpass path through CMOS nonlinearity
        const v1Linear = a1 * this.s1[ch] + a2 * v3;
        const v1 = this.cmos(v1Linear, bias, drive);
        
        // Lowpass path through CMOS nonlinearity  
        const v2Linear = this.s2[ch] + a2 * this.s1[ch] + a3 * v3;
        const v2 = this.cmos(v2Linear, bias * 0.7, drive);
        
        // Update states
        this.s1[ch] = 2 * v1 - this.s1[ch];
        this.s2[ch] = 2 * v2 - this.s2[ch];
        
        // Clamp states to prevent blowup at high resonance
        this.s1[ch] = Math.max(-4, Math.min(4, this.s1[ch]));
        this.s2[ch] = Math.max(-4, Math.min(4, this.s2[ch]));
        
        // Filter outputs
        const lp = v2;
        const bp = v1;
        const hp = v0 - k * v1 - v2;
        const notch = lp + hp;
        
        // Mode selection with interpolation
        const outputs = [lp, bp, hp, notch];
        const modeInt = Math.floor(mode);
        const modeFrac = mode - modeInt;
        
        let filtered;
        if (modeFrac < 0.01 || modeInt >= 3) {
          filtered = outputs[Math.min(modeInt, 3)];
        } else {
          filtered = outputs[modeInt] * (1 - modeFrac) + outputs[modeInt + 1] * modeFrac;
        }
        
        // Output saturation and DC block
        const saturated = this.tanh(filtered * (1 + drive * 0.5));
        out[i] = this.dcBlock(saturated, ch);
      }
    }
    
    return true;
  }
}

registerProcessor('wasp-processor', WaspProcessor);
