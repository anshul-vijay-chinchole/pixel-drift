// Procedural Web Audio API Sound Synthesizer for Pixel Drift
export class SoundEngine {
  private ctx: AudioContext | null = null;
  
  // Engine nodes
  private oscs: OscillatorNode[] = [];
  private engineGain: GainNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private distortion: WaveShaperNode | null = null;
  
  // Turbo nodes
  private turboOsc: OscillatorNode | null = null;
  private turboGain: GainNode | null = null;
  
  // Tire squeal nodes
  private tireNoise: AudioWorkletNode | ScriptProcessorNode | null = null;
  private tireFilter: BiquadFilterNode | null = null;
  private tireGain: GainNode | null = null;
  
  // Ambient nodes
  private envNoise: ScriptProcessorNode | null = null;
  private envGain: GainNode | null = null;
  
  private isMuted: boolean = false;
  private active: boolean = false;

  constructor() {
    // Audio Context is initialized on first user interaction
  }

  public init() {
    if (this.ctx) return;
    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      this.ctx = new AudioContextClass();
      this.setupEngine();
      this.setupTurbo();
      this.setupTires();
      this.setupAmbient();
      this.active = true;
    } catch (e) {
      console.error("Failed to initialize Web Audio:", e);
    }
  }

  private setupEngine() {
    if (!this.ctx) return;

    this.engineGain = this.ctx.createGain();
    this.engineGain.gain.setValueAtTime(0.0, this.ctx.currentTime);
    
    this.engineFilter = this.ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.setValueAtTime(400, this.ctx.currentTime);
    this.engineFilter.Q.setValueAtTime(2.0, this.ctx.currentTime);

    // Distortion for a grittier retro engine sound
    this.distortion = this.ctx.createWaveShaper();
    this.distortion.curve = this.makeDistortionCurve(40);
    this.distortion.oversample = '4x';

    // Create 3 oscillators to simulate engine cylinders/harmonics
    const waveTypes: OscillatorType[] = ['sawtooth', 'triangle', 'sawtooth'];
    const detunes = [-5, 0, 5];
    
    for (let i = 0; i < 3; i++) {
      const osc = this.ctx.createOscillator();
      osc.type = waveTypes[i];
      osc.frequency.setValueAtTime(100, this.ctx.currentTime);
      osc.detune.setValueAtTime(detunes[i], this.ctx.currentTime);
      
      const oscGain = this.ctx.createGain();
      // Mix: sawtooth quiet, triangle dominant for low-end rumble
      oscGain.gain.setValueAtTime(i === 1 ? 0.35 : 0.15, this.ctx.currentTime);
      
      osc.connect(oscGain);
      oscGain.connect(this.distortion);
      osc.start(0);
      this.oscs.push(osc);
    }

    this.distortion.connect(this.engineFilter);
    this.engineFilter.connect(this.engineGain);
    this.engineGain.connect(this.ctx.destination);
  }

  private makeDistortionCurve(amount: number) {
    const k = typeof amount === 'number' ? amount : 50;
    const n_samples = 44100;
    const curve = new Float32Array(n_samples);
    const deg = Math.PI / 180;
    for (let i = 0; i < n_samples; ++i) {
      const x = (i * 2) / n_samples - 1;
      curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
    }
    return curve;
  }

  private setupTurbo() {
    if (!this.ctx) return;
    
    this.turboOsc = this.ctx.createOscillator();
    this.turboOsc.type = 'sine';
    this.turboOsc.frequency.setValueAtTime(800, this.ctx.currentTime);
    
    this.turboGain = this.ctx.createGain();
    this.turboGain.gain.setValueAtTime(0.0, this.ctx.currentTime);
    
    this.turboOsc.connect(this.turboGain);
    this.turboGain.connect(this.ctx.destination);
    this.turboOsc.start(0);
  }

  private setupTires() {
    if (!this.ctx) return;

    this.tireGain = this.ctx.createGain();
    this.tireGain.gain.setValueAtTime(0.0, this.ctx.currentTime);

    this.tireFilter = this.ctx.createBiquadFilter();
    this.tireFilter.type = 'bandpass';
    this.tireFilter.frequency.setValueAtTime(1000, this.ctx.currentTime);
    this.tireFilter.Q.setValueAtTime(3.0, this.ctx.currentTime);

    // Simple script processor to generate white noise for tire squeals
    try {
      this.tireNoise = this.ctx.createScriptProcessor(4096, 0, 1);
      this.tireNoise.onaudioprocess = (e) => {
        const outputBuffer = e.outputBuffer;
        const channelData = outputBuffer.getChannelData(0);
        for (let i = 0; i < outputBuffer.length; i++) {
          channelData[i] = Math.random() * 2.0 - 1.0;
        }
      };
      this.tireNoise.connect(this.tireFilter);
      this.tireFilter.connect(this.tireGain);
      this.tireGain.connect(this.ctx.destination);
    } catch (e) {
      console.warn("ScriptProcessor fallback:", e);
    }
  }

  private setupAmbient() {
    if (!this.ctx) return;

    this.envGain = this.ctx.createGain();
    this.envGain.gain.setValueAtTime(0.02, this.ctx.currentTime); // Low volume wind

    try {
      this.envNoise = this.ctx.createScriptProcessor(4096, 0, 1);
      this.envNoise.onaudioprocess = (e) => {
        const outputBuffer = e.outputBuffer;
        const channelData = outputBuffer.getChannelData(0);
        // Wind noise is pink-like (filtered random noise)
        let lastOut = 0.0;
        for (let i = 0; i < outputBuffer.length; i++) {
          const white = Math.random() * 2.0 - 1.0;
          channelData[i] = 0.05 * white + 0.95 * lastOut; // simple lowpass filter
          lastOut = channelData[i];
        }
      };
      this.envNoise.connect(this.envGain);
      this.envGain.connect(this.ctx.destination);
    } catch (e) {
      console.warn("Ambient setup failed:", e);
    }
  }

  public update(rpm: number, redline: number, throttle: number, turboBoost: number, tireSlip: number, isElectric: boolean = false) {
    if (!this.active || this.isMuted || !this.ctx) return;

    // Resume AudioContext if suspended (browser security)
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }

    const t = this.ctx.currentTime;
    const rpmPct = rpm / redline;

    // 1. ENGINE SOUND UPGRADE
    if (this.engineGain && this.engineFilter) {
      // Scale engine volume based on throttle load + RPM
      const baseVol = isElectric ? 0.05 : 0.22;
      const targetGain = baseVol * (0.4 + 0.6 * throttle) * (0.3 + 0.7 * rpmPct);
      this.engineGain.gain.setTargetAtTime(targetGain, t, 0.1);

      // Shift engine filter frequency based on RPM (higher RPM = brighter, louder sound)
      const baseFreq = isElectric ? 800 : 300;
      const targetFreq = baseFreq + (isElectric ? 3000 : 1200) * rpmPct;
      this.engineFilter.frequency.setTargetAtTime(targetFreq, t, 0.05);

      // Pitch the oscillators
      const basePitch = isElectric ? 60 : 30; // Hz at idle
      const currentPitch = basePitch + (isElectric ? 240 : 180) * rpmPct;

      this.oscs.forEach((osc, idx) => {
        let mult = 1.0;
        if (idx === 0) mult = 0.5; // sub-harmonic rumble
        if (idx === 2) mult = 2.0; // second harmonic scream
        osc.frequency.setTargetAtTime(currentPitch * mult, t, 0.05);
      });
    }

    // 2. TURBO BOOSTER SOUND
    if (this.turboOsc && this.turboGain) {
      // Pitch goes up with boost levels
      const turboPitch = 800 + 2000 * turboBoost;
      this.turboOsc.frequency.setTargetAtTime(turboPitch, t, 0.05);

      // Turbo gain grows with throttle + boost
      const turboVolume = 0.08 * turboBoost * Math.max(0.2, throttle);
      this.turboGain.gain.setTargetAtTime(turboVolume, t, 0.1);
    }

    // 3. TIRE SQUEALS
    if (this.tireGain && this.tireFilter) {
      const clampedSlip = Math.min(1.0, Math.max(0.0, tireSlip));
      // Squeal starts above 0.15 tire slip
      const squealVol = clampedSlip > 0.18 ? (clampedSlip - 0.18) * 0.35 : 0.0;
      this.tireGain.gain.setTargetAtTime(squealVol, t, 0.05);

      // Slide frequency up slightly based on slip velocity
      const squealFreq = 800 + 400 * clampedSlip;
      this.tireFilter.frequency.setTargetAtTime(squealFreq, t, 0.05);
    }
  }

  public triggerBackfire() {
    if (!this.active || this.isMuted || !this.ctx) return;
    const t = this.ctx.currentTime;
    
    // Quick pop sound using a temporary burst oscillator
    const popOsc = this.ctx.createOscillator();
    const popGain = this.ctx.createGain();
    const popFilter = this.ctx.createBiquadFilter();

    popOsc.type = 'sawtooth';
    popOsc.frequency.setValueAtTime(80, t);
    popOsc.frequency.exponentialRampToValueAtTime(10, t + 0.15);

    popFilter.type = 'lowpass';
    popFilter.frequency.setValueAtTime(200, t);

    popGain.gain.setValueAtTime(0.4, t);
    popGain.gain.exponentialRampToValueAtTime(0.01, t + 0.18);

    popOsc.connect(popFilter);
    popFilter.connect(popGain);
    popGain.connect(this.ctx.destination);

    popOsc.start(t);
    popOsc.stop(t + 0.2);
  }

  public triggerShift() {
    if (!this.active || this.isMuted || !this.ctx) return;
    const t = this.ctx.currentTime;
    // Short mechanical "chunk": a quick low click.
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(140, t);
    osc.frequency.exponentialRampToValueAtTime(60, t + 0.06);
    gain.gain.setValueAtTime(0.12, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    osc.connect(gain); gain.connect(this.ctx.destination);
    osc.start(t); osc.stop(t + 0.09);
  }

  public triggerBlowOffValve() {
    if (!this.active || this.isMuted || !this.ctx) return;
    const t = this.ctx.currentTime;

    // "Psssshhh-tutu" sound for turbo releases
    const bovNoise = this.ctx.createScriptProcessor(4096, 0, 1);
    bovNoise.onaudioprocess = (e) => {
      const outputBuffer = e.outputBuffer;
      const channelData = outputBuffer.getChannelData(0);
      for (let i = 0; i < outputBuffer.length; i++) {
        channelData[i] = Math.random() * 2.0 - 1.0;
      }
    };

    const bovGain = this.ctx.createGain();
    const bovFilter = this.ctx.createBiquadFilter();

    bovFilter.type = 'bandpass';
    bovFilter.frequency.setValueAtTime(3000, t);
    bovFilter.Q.setValueAtTime(2.0, t);

    // Fade-out envelope
    bovGain.gain.setValueAtTime(0.12, t);
    bovGain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);

    bovNoise.connect(bovFilter);
    bovFilter.connect(bovGain);
    bovGain.connect(this.ctx.destination);

    setTimeout(() => {
      try {
        bovNoise.disconnect();
        bovGain.disconnect();
        bovFilter.disconnect();
      } catch { /* nodes already disconnected */ }
    }, 400);
  }

  public setMute(muted: boolean) {
    this.isMuted = muted;
    if (!this.ctx) return;
    if (muted) {
      if (this.engineGain) this.engineGain.gain.value = 0;
      if (this.turboGain) this.turboGain.gain.value = 0;
      if (this.tireGain) this.tireGain.gain.value = 0;
      if (this.envGain) this.envGain.gain.value = 0;
    } else {
      // Restore the ambient wind bed — engine/turbo/tire re-ramp themselves in
      // update(), but envGain is only set here, so without this it stayed silent
      // forever after the first mute/pause.
      if (this.envGain) this.envGain.gain.value = 0.02;
    }
  }

  public toggleMute() {
    this.setMute(!this.isMuted);
    return this.isMuted;
  }
}

export const sound = new SoundEngine();
export default sound;
