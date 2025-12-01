/**
 * WASP Filter - AudioWorklet Processor
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

  constructor(options) {
    super();
    console.log('WaspProcessor constructor called');
    
    // SVF state
    this.ic1eq = 0;
    this.ic2eq = 0;
    
    // Bias drift
    this.bias = 0;
    this.biasTarget = 0;
    
    this.frameCount = 0;
  }

  tanh(x) {
    if (x < -3) return -1;
    if (x > 3) return 1;
    const x2 = x * x;
    return x * (27 + x2) / (27 + 9 * x2);
  }

  // CMOS nonlinearity - asymmetric soft clip
  cmos(x, bias, drive) {
    const input = x + bias * 0.05;
    const gained = input * (1 + drive * 2);
    const asymm = gained >= 0 ? gained * 1.15 : gained * 0.85;
    return this.tanh(asymm);
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    
    this.frameCount++;
    
    if (!input || !input[0] || !output || !output[0]) {
      return true;
    }
    
    const inp = input[0];
    const out = output[0];
    const len = out.length;
    
    // Debug logging
    if (this.frameCount <= 3 || this.frameCount === 10 || this.frameCount === 50) {
      const maxIn = Math.max(...Array.from(inp).map(Math.abs));
      console.log('Frame', this.frameCount, 'maxIn:', maxIn.toFixed(4));
    }
    
    const cutoffArr = parameters.cutoff;
    const resArr = parameters.resonance;
    const driveArr = parameters.drive;
    const mode = parameters.mode[0];
    const chaos = parameters.chaos[0];
    
    // Update bias drift
    if (Math.random() < 0.01) {
      this.biasTarget = (Math.random() - 0.5) * chaos * 0.5;
    }
    this.bias += (this.biasTarget - this.bias) * 0.0005;
    
    for (let i = 0; i < len; i++) {
      const v0 = inp[i];
      
      const cutoff = cutoffArr.length > 1 ? cutoffArr[i] : cutoffArr[0];
      const res = resArr.length > 1 ? resArr[i] : resArr[0];
      const drive = driveArr.length > 1 ? driveArr[i] : driveArr[0];
      
      // Prewarp cutoff for TPT
      const wd = 2 * Math.PI * Math.min(cutoff, sampleRate * 0.49);
      const wa = (2 * sampleRate) * Math.tan(wd / (2 * sampleRate));
      const g = wa / (2 * sampleRate);
      
      // Q from 0.5 to 20
      const Q = 0.5 + res * 19.5;
      const k = 1 / Q;
      
      // Standard TPT SVF
      const a1 = 1 / (1 + g * (g + k));
      const a2 = g * a1;
      const a3 = g * a2;
      
      // Compute outputs
      const v3 = v0 - this.ic2eq;
      const v1 = a1 * this.ic1eq + a2 * v3;
      const v2 = this.ic2eq + a2 * this.ic1eq + a3 * v3;
      
      // Update states
      this.ic1eq = 2 * v1 - this.ic1eq;
      this.ic2eq = 2 * v2 - this.ic2eq;
      
      // Outputs
      const lp = v2;
      const bp = v1;
      const hp = v0 - k * v1 - v2;
      const notch = hp + lp;
      
      // Mode select
      let filtered;
      if (mode < 0.5) filtered = lp;
      else if (mode < 1.5) filtered = bp;
      else if (mode < 2.5) filtered = hp;
      else filtered = notch;
      
      // Apply WASP character on output only
      const driven = filtered * (1 + drive);
      const shaped = this.cmos(driven, this.bias, drive);
      
      out[i] = shaped;
    }
    
    // Log output
    if (this.frameCount === 10 || this.frameCount === 50) {
      const maxOut = Math.max(...Array.from(out).map(Math.abs));
      console.log('Frame', this.frameCount, 'maxOut:', maxOut.toFixed(4));
    }
    
    return true;
  }
}

registerProcessor('wasp-processor', WaspProcessor);
