/**
 * Wasp-style Filter - AudioWorkletProcessor
 * 
 * Goals:
 * - 2-pole multimode SVF core (LP/BP/HP/Notch)
 * - Nonlinearity INSIDE the filter loop (dirty core, not just dirty output)
 * - Asymmetric CMOS-ish soft clip
 * - Slightly unstable: bias drift + cutoff jitter + tiny noise
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
        automationRate: 'k-rate' // 0=LP,1=BP,2=HP,3=Notch
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

  constructor(options) {
    super();

    // SVF state
    this.ic1eq = 0;
    this.ic2eq = 0;

    // Bias drift for CMOS nonlinearity
    this.bias = 0;
    this.biasTarget = 0;

    this.frameCount = 0;
  }

  // Cheap-ish tanh approximation
  tanh(x) {
    if (x < -3) return -1;
    if (x > 3) return 1;
    const x2 = x * x;
    return x * (27 + x2) / (27 + 9 * x2);
  }

  // CMOS-inspired asymmetric soft clip
  cmos(x, bias, drive) {
    // bias nudges center; drive scales input
    const input = x + bias * 0.05;
    const gained = input * (1 + drive * 2);
    const asymm = gained >= 0 ? gained * 1.15 : gained * 0.85;
    return this.tanh(asymm);
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];

    if (!input || !input[0] || !output || !output[0]) {
      return true;
    }

    const inp = input[0];
    const out = output[0];
    const len = out.length;

    const cutoffArr = parameters.cutoff;
    const resArr = parameters.resonance;
    const driveArr = parameters.drive;

    const mode = parameters.mode[0] | 0;   // k-rate, treat as int-ish
    const chaos = parameters.chaos[0] || 0;

    // Slowly wandering bias target for nonlinearity center
    if (Math.random() < 0.01 * (0.2 + chaos)) {
      this.biasTarget = (Math.random() - 0.5) * chaos * 0.5;
    }
    // Very slow bias smoothing
    this.bias += (this.biasTarget - this.bias) * 0.0005;

    const nyquist = 0.5 * sampleRate;

    for (let i = 0; i < len; i++) {
      // ==== Parameters (a-rate where applicable) ====
      const cutoffParam = cutoffArr.length > 1 ? cutoffArr[i] : cutoffArr[0];
      const resParam = resArr.length > 1 ? resArr[i] : resArr[0];
      const driveParam = driveArr.length > 1 ? driveArr[i] : driveArr[0];

      // Shape resonance: most of the knob is tame, top is extreme
      const resShaped = Math.pow(Math.min(Math.max(resParam, 0), 1), 2.2);
      const Q = 0.7 + resShaped * 30.0; // up to pretty wild Q
      const k = 1 / Q;

      // Base cutoff
      let cutoff = Math.min(Math.max(cutoffParam, 20), nyquist * 0.98);

      // Chaos → slight cutoff jitter (fast, tiny)
      const jitter = (Math.random() - 0.5) * chaos * 0.002;
      cutoff *= (1 + jitter);
      cutoff = Math.min(Math.max(cutoff, 20), nyquist * 0.98);

      // TPT prewarp
      const wd = 2 * Math.PI * cutoff;
      const wa = 2 * sampleRate * Math.tan(wd / (2 * sampleRate));
      const g = wa / (2 * sampleRate);

      const a1 = 1 / (1 + g * (g + k));
      const a2 = g * a1;
      const a3 = g * a2;

      // ==== Input, with tiny chaos noise ====
      const noiseAmt = chaos * 0.0005;
      const noise = (Math.random() * 2 - 1) * noiseAmt;
      const v0 = inp[i] + noise;

      // ==== Dirty core SVF ====
      // Standard TPT SVF structure
      const v3 = v0 - this.ic2eq;

      // Linear integrator outputs first
      let v1 = a1 * this.ic1eq + a2 * v3;
      let v2 = this.ic2eq + a2 * this.ic1eq + a3 * v3;

      // Drive resonance path: nonlinearity inside the loop
      const resDrive = 0.5 + driveParam * 1.5;

      // Nonlinear "caps" – this is where we inject CMOS weirdness
      v1 = this.cmos(v1 * resDrive, this.bias, driveParam * 0.8);
      v2 = this.cmos(v2 * resDrive, this.bias * 0.5, driveParam * 0.8);

      // Update states using the nonlinear integrator outputs
      this.ic1eq = 2 * v1 - this.ic1eq;
      this.ic2eq = 2 * v2 - this.ic2eq;

      // Mild saturation of states to keep them bounded & juicy
      const stateDrive = 0.3 + driveParam * 0.7;
      this.ic1eq = this.tanh(this.ic1eq * (1 + stateDrive * 0.5));
      this.ic2eq = this.tanh(this.ic2eq * (1 + stateDrive * 0.5));

      // Compute outputs from nonlinear core
      const lp = v2;
      const bp = v1;
      const hp = v0 - k * v1 - v2;
      const notch = hp + lp;

      let filtered;
      switch (mode) {
        case 0:
        default:
          filtered = lp;
          break;
        case 1:
          filtered = bp;
          break;
        case 2:
          filtered = hp;
          break;
        case 3:
          filtered = notch;
          break;
      }

      // Gentle final clip to avoid total insanity on high drive/res
      const outDrive = 1 + driveParam * 0.3;
      out[i] = this.tanh(filtered * outDrive);
    }

    this.frameCount++;
    return true;
  }
}

registerProcessor('wasp-processor', WaspProcessor);
