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
    this.s1 = 0;
    this.s2 = 0;
    
    // Bias drift
    this.bias = 0;
    this.biasTarget = 0;
    
    // DC blocker
    this.dcPrev = 0;
    this.dcOut = 0;
    
    this.frameCount = 0;
    
    // SET TO FALSE TO ENABLE FILTER
    this.bypassFilter = false;
  }

  tanh(x) {
    if (x < -3) return -1;
    if (x > 3) return 1;
    const x2 = x * x;
    return x * (27 + x2) / (27 + 9 * x2);
  }

  cmos(x, bias, drive) {
    const gained = (x + bias * 0.1) * (1 + drive * 3);
    const asymm = gained >= 0 ? gained * 1.1 : gained * 0.9;
    return this.tanh(asymm);
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    
    this.frameCount++;
    
    // Safety check
    if (!input || !input[0] || !output || !output[0]) {
      if (this.frameCount <= 5) {
        console.log('Frame', this.frameCount, 'EARLY EXIT - no input/output');
      }
      return true;
    }
    
    const inp = input[0];
    const out = output[0];
    const len = out.length;
    
    // Debug logging
    if (this.frameCount <= 5 || this.frameCount === 10 || this.frameCount === 50) {
      const maxIn = Math.max(...Array.from(inp).map(Math.abs));
      console.log('Frame', this.frameCount, 'len:', len, 'maxIn:', maxIn.toFixed(4), 'bypass:', this.bypassFilter);
    }
    
    // BYPASS MODE - just pass audio through
    if (this.bypassFilter) {
      for (let i = 0; i < len; i++) {
        out[i] = inp[i];
      }
      return true;
    }
    
    // FILTER MODE
    const cutoffArr = parameters.cutoff;
    const resArr = parameters.resonance;
    const driveArr = parameters.drive;
    const mode = parameters.mode[0];
    const chaos = parameters.chaos[0];
    
    // Update bias drift
    if (Math.random() < 0.01) {
      this.biasTarget = (Math.random() - 0.5) * chaos;
    }
    this.bias += (this.biasTarget - this.bias) * 0.001;
    
    for (let i = 0; i < len; i++) {
      const v0 = inp[i];
      
      const cutoff = cutoffArr.length > 1 ? cutoffArr[i] : cutoffArr[0];
      const res = resArr.length > 1 ? resArr[i] : resArr[0];
      const drive = driveArr.length > 1 ? driveArr[i] : driveArr[0];
      
      // TPT SVF
      const g = Math.tan(Math.PI * Math.min(cutoff, sampleRate * 0.49) / sampleRate);
      const k = 2 - res * 1.98;
      
      const hp = (v0 - k * this.s1 - this.s2) / (1 + k * g + g * g);
      
      const bpLin = g * hp + this.s1;
      const bp = this.cmos(bpLin, this.bias, drive);
      
      const lpLin = g * bp + this.s2;
      const lp = this.cmos(lpLin, this.bias * 0.7, drive);
      
      this.s1 = 2 * bp - this.s1;
      this.s2 = 2 * lp - this.s2;
      
      // Clamp
      this.s1 = Math.max(-5, Math.min(5, this.s1));
      this.s2 = Math.max(-5, Math.min(5, this.s2));
      
      const notch = hp + lp;
      
      // Mode select
      let filtered;
      if (mode < 0.5) filtered = lp;
      else if (mode < 1.5) filtered = bp;
      else if (mode < 2.5) filtered = hp;
      else filtered = notch;
      
      // Output with saturation
      const sat = this.tanh(filtered * (1 + drive * 0.5));
      
      // DC block
      const dcBlocked = sat - this.dcPrev + 0.995 * this.dcOut;
      this.dcPrev = sat;
      this.dcOut = dcBlocked;
      
      out[i] = dcBlocked;
    }
    
    // Log output level
    if (this.frameCount === 10 || this.frameCount === 50) {
      const maxOut = Math.max(...Array.from(out).map(Math.abs));
      console.log('Frame', this.frameCount, 'maxOut:', maxOut.toFixed(4));
    }
    
    return true;
  }
}

registerProcessor('wasp-processor', WaspProcessor);
