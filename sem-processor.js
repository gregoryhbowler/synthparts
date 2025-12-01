/**
 * SEM Filter AudioWorklet Processor
 * 
 * Highly accurate emulation of the Oberheim SEM state-variable filter:
 * - TPT/ZDF (Topology Preserving Transform / Zero Delay Feedback) SVF core
 * - OTA saturation modeling (CA3080-style tanh nonlinearity)
 * - Resonance-as-damping behavior (authentic SEM Q response)
 * - No gain normalization (natural loudness bloom with resonance)
 * - 2x/4x oversampling with polyphase halfband decimation
 * - Per-instance analog drift (Tier 3 accuracy)
 */

class SEMFilterProcessor extends AudioWorkletProcessor {
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
        name: 'morph',
        defaultValue: 0,
        minValue: -1,
        maxValue: 1,
        automationRate: 'a-rate'
      },
      {
        name: 'drive',
        defaultValue: 1,
        minValue: 0.1,
        maxValue: 10,
        automationRate: 'a-rate'
      },
      {
        name: 'oversample',
        defaultValue: 2,
        minValue: 1,
        maxValue: 4,
        automationRate: 'k-rate'
      }
    ];
  }

  constructor(options) {
    super();
    
    // State variables for the SVF (per channel, stereo)
    this.ic1eq = [0, 0]; // Integrator 1 state
    this.ic2eq = [0, 0]; // Integrator 2 state
    
    // Halfband filter states for decimation (per channel)
    this.halfbandState1 = [new Float32Array(12), new Float32Array(12)];
    this.halfbandState2 = [new Float32Array(12), new Float32Array(12)];
    
    // === TIER 3: Per-instance analog drift ===
    const seed = options?.processorOptions?.seed ?? Math.random() * 10000;
    this.rng = this.createRNG(seed);
    
    // Component tolerances (±5% typical for vintage gear)
    this.cutoffDrift = 1 + (this.rng() - 0.5) * 0.10;
    this.resDrift = 1 + (this.rng() - 0.5) * 0.08;
    this.capDrift1 = 1 + (this.rng() - 0.5) * 0.06;
    this.capDrift2 = 1 + (this.rng() - 0.5) * 0.06;
    
    // Asymmetric nonlinearity coefficients
    this.saturationAmount = 0.8 + this.rng() * 0.4; // How hard the OTAs clip
    this.asymmetry = 1 + (this.rng() - 0.5) * 0.1;
    
    // Tiny DC offset from component mismatch
    this.dcOffset = (this.rng() - 0.5) * 0.001;
    
    // Denormal threshold
    this.denormalThreshold = 1e-18;
  }
  
  createRNG(seed) {
    return function() {
      let t = seed += 0x6D2B79F5;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  
  // Fast tanh approximation (Pade approximant)
  tanh(x) {
    if (x < -3) return -1;
    if (x > 3) return 1;
    const x2 = x * x;
    return x * (27 + x2) / (27 + 9 * x2);
  }
  
  // Soft saturation with asymmetry (models OTA mismatch)
  saturate(x, amount, asymmetry) {
    const scaled = x * amount;
    if (scaled >= 0) {
      return this.tanh(scaled * asymmetry) / amount;
    } else {
      return this.tanh(scaled / asymmetry) / amount;
    }
  }
  
  // Kill denormals
  flushDenormal(x) {
    return (x > this.denormalThreshold || x < -this.denormalThreshold) ? x : 0;
  }
  
  // Halfband decimation filter
  halfbandDecimate(input, state, len) {
    // Optimized 11-tap halfband FIR
    const h = [
      0.00320982, -0.01442291, 0.04299436, -0.09939089, 
      0.31546250, 0.50000000, 0.31546250, -0.09939089, 
      0.04299436, -0.01442291, 0.00320982
    ];
    
    const output = new Float32Array(len >> 1);
    
    for (let i = 0; i < len; i += 2) {
      // Shift state
      for (let j = state.length - 1; j >= 2; j--) {
        state[j] = state[j - 2];
      }
      state[1] = input[i + 1];
      state[0] = input[i];
      
      // Convolve
      let sum = 0;
      for (let j = 0; j < h.length; j++) {
        sum += h[j] * state[j];
      }
      output[i >> 1] = sum;
    }
    
    return output;
  }
  
  // Linear interpolation upsample
  upsample2x(input, output, len) {
    for (let i = 0; i < len; i++) {
      output[i << 1] = input[i];
      output[(i << 1) + 1] = (i < len - 1) 
        ? (input[i] + input[i + 1]) * 0.5 
        : input[i];
    }
  }
  
  // === Core TPT SVF ===
  processSample(x, cutoffHz, resonance, morph, drive, channel, sr) {
    // Apply component drift to cutoff
    const fc = cutoffHz * this.cutoffDrift;
    
    // Prewarp for trapezoidal integration
    // Clamp to just under Nyquist to prevent instability
    const g = Math.tan(Math.PI * Math.min(fc / sr, 0.49));
    
    // Apply cap drift to integrator time constants
    const g1 = g * this.capDrift1;
    const g2 = g * this.capDrift2;
    
    // === SEM Resonance Model ===
    // Resonance control adds damping to naturally resonant system
    // resonance=0: near self-oscillation (k≈0)
    // resonance=1: heavily damped (k=2, Q=0.5)
    const kMin = 0.02; // Just shy of self-oscillation
    const kMax = 2.0;
    const k = (kMin + resonance * (kMax - kMin)) * this.resDrift;
    
    // === Input stage ===
    // Pre-filter saturation (mixer/input amp clipping)
    x = x * drive;
    x = this.saturate(x, this.saturationAmount, this.asymmetry);
    
    // Add tiny DC offset (component mismatch)
    x += this.dcOffset;
    
    // Get integrator states
    let s1 = this.ic1eq[channel];
    let s2 = this.ic2eq[channel];
    
    // === TPT State Variable Filter ===
    // Using the Zavalishin/Cytomic form
    // 
    // The key insight: solve for HP first, then cascade
    // This gives us zero-delay feedback behavior
    
    const gk = g1 * k;
    const g1g2 = g1 * g2;
    const denom = 1 / (1 + gk + g1g2);
    
    // Solve for highpass output
    const hp = (x - (k + g1) * s1 - s2) * denom;
    
    // Bandpass: first integrator output
    const v1 = g1 * hp;
    const bp = v1 + s1;
    
    // Lowpass: second integrator output  
    const v2 = g2 * bp;
    const lp = v2 + s2;
    
    // === OTA Saturation ===
    // Apply saturation to integrator outputs (models OTA limiting)
    const bpSat = this.saturate(bp, this.saturationAmount * 0.7, this.asymmetry);
    const lpSat = this.saturate(lp, this.saturationAmount * 0.7, this.asymmetry);
    
    // Update integrator states (trapezoidal rule)
    // Mix saturated and clean for subtle effect
    const satMix = 0.3;
    this.ic1eq[channel] = this.flushDenormal(
      v1 + bp * (1 - satMix) + bpSat * satMix
    );
    this.ic2eq[channel] = this.flushDenormal(
      v2 + lp * (1 - satMix) + lpSat * satMix
    );
    
    // === Output Mixing (SEM morph control) ===
    // morph: -1 = LP, 0 = Notch (LP+HP), +1 = HP
    let output;
    if (morph <= 0) {
      // LP to Notch crossfade
      const t = morph + 1; // 0 = LP, 1 = Notch
      output = lp * (1 - t) + (lp + hp) * t;
    } else {
      // Notch to HP crossfade
      const t = morph; // 0 = Notch, 1 = HP
      output = (lp + hp) * (1 - t) + hp * t;
    }
    
    // No gain compensation - loudness bloom is part of SEM character
    return output;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    
    if (!input || !input[0]) return true;
    
    const blockSize = input[0].length;
    
    // Get oversample factor (1, 2, or 4)
    let osf = Math.round(parameters.oversample[0]);
    if (osf < 1) osf = 1;
    if (osf === 3) osf = 2;
    if (osf > 4) osf = 4;
    
    const baseSR = sampleRate;
    
    // Process each channel
    const numChannels = Math.min(input.length, output.length);
    
    for (let ch = 0; ch < numChannels; ch++) {
      const inCh = input[ch];
      const outCh = output[ch];
      
      if (osf === 1) {
        // No oversampling
        for (let i = 0; i < blockSize; i++) {
          const cutoff = parameters.cutoff.length > 1 ? parameters.cutoff[i] : parameters.cutoff[0];
          const res = parameters.resonance.length > 1 ? parameters.resonance[i] : parameters.resonance[0];
          const morph = parameters.morph.length > 1 ? parameters.morph[i] : parameters.morph[0];
          const drive = parameters.drive.length > 1 ? parameters.drive[i] : parameters.drive[0];
          
          outCh[i] = this.processSample(inCh[i], cutoff, res, morph, drive, ch, baseSR);
        }
      } 
      else if (osf === 2) {
        // 2x oversampling
        const upLen = blockSize * 2;
        const upsampled = new Float32Array(upLen);
        const processed = new Float32Array(upLen);
        
        this.upsample2x(inCh, upsampled, blockSize);
        
        const osSR = baseSR * 2;
        for (let i = 0; i < upLen; i++) {
          const idx = i >> 1;
          const cutoff = parameters.cutoff.length > 1 ? parameters.cutoff[idx] : parameters.cutoff[0];
          const res = parameters.resonance.length > 1 ? parameters.resonance[idx] : parameters.resonance[0];
          const morph = parameters.morph.length > 1 ? parameters.morph[idx] : parameters.morph[0];
          const drive = parameters.drive.length > 1 ? parameters.drive[idx] : parameters.drive[0];
          
          processed[i] = this.processSample(upsampled[i], cutoff, res, morph, drive, ch, osSR);
        }
        
        const decimated = this.halfbandDecimate(processed, this.halfbandState1[ch], upLen);
        outCh.set(decimated);
      } 
      else if (osf === 4) {
        // 4x oversampling (two stages)
        const up2Len = blockSize * 2;
        const up4Len = blockSize * 4;
        
        const up2 = new Float32Array(up2Len);
        const up4 = new Float32Array(up4Len);
        const processed = new Float32Array(up4Len);
        
        this.upsample2x(inCh, up2, blockSize);
        this.upsample2x(up2, up4, up2Len);
        
        const osSR = baseSR * 4;
        for (let i = 0; i < up4Len; i++) {
          const idx = i >> 2;
          const cutoff = parameters.cutoff.length > 1 ? parameters.cutoff[idx] : parameters.cutoff[0];
          const res = parameters.resonance.length > 1 ? parameters.resonance[idx] : parameters.resonance[0];
          const morph = parameters.morph.length > 1 ? parameters.morph[idx] : parameters.morph[0];
          const drive = parameters.drive.length > 1 ? parameters.drive[idx] : parameters.drive[0];
          
          processed[i] = this.processSample(up4[i], cutoff, res, morph, drive, ch, osSR);
        }
        
        const dec2 = this.halfbandDecimate(processed, this.halfbandState1[ch], up4Len);
        const dec1 = this.halfbandDecimate(dec2, this.halfbandState2[ch], up2Len);
        outCh.set(dec1);
      }
    }
    
    return true;
  }
}

registerProcessor('sem-filter-processor', SEMFilterProcessor);
