import * as THREE from 'three';
import { getStoredMix, storeMix, getStoredMuted, storeMuted } from './config.js';

/**
 * Pure procedural audio engine. Every sound is synthesized at runtime with
 * WebAudio nodes; the game never fetches or decodes an audio asset.
 *
 * The singleton accessor prevents duplicate AudioContexts when both the start
 * screen and the pointer-lock transition request audio at the same time.
 */
export class AudioEngine {
  static instance = null;

  static getInstance(onStateChange = null) {
    if (!AudioEngine.instance) AudioEngine.instance = new AudioEngine(onStateChange || undefined);
    else if (onStateChange) AudioEngine.instance.onStateChange = onStateChange;
    return AudioEngine.instance;
  }

  constructor(onStateChange = () => {}) {
    if (AudioEngine.instance) {
      if (onStateChange) AudioEngine.instance.onStateChange = onStateChange;
      return AudioEngine.instance;
    }
    AudioEngine.instance = this;
    this.ctx = null;
    this.audioContext = null;
    this.master = null;
    this.masterCompressor = null;
    this.sfx = null;
    this.music = null;
    this.musicDuck = null;
    this.ambience = null;
    this.reverb = null;
    this.reverbSend = null;
    this.noiseBuffer = null;
    this.distortionCurve = null;
    this.started = false;
    this.startPromise = null;
    // N8/A5: il mute è persistito (localStorage) come mix e sensibilità.
    this.muted = getStoredMuted();
    // A1: con il menu di pausa aperto il mix viene attenuato (vedi applyMix).
    this.menuDucked = false;
    // A4: ultimo valore di salute noto, usato per il battito a integrità critica.
    this.lastHealth = 100;
    this.nextStepTime = 0;
    this.step = 0;
    this.targetIntensity = 0;
    this.intensity = 0;
    this.mix = getStoredMix();
    this.onStateChange = onStateChange;
    this.droneVoices = [];
    this.ambientDrone = null;
    this.apexHum = null; // sub-bass grave quando un Apex è vivo
    this.arpeggiatorEnabled = true;
    this.arpeggioStep = 0;
    // A natural minor, kept as frequencies so the scale can be swapped
    // without changing the scheduling code below.
    this.naturalMinorScale = [110, 130.81, 146.83, 164.81, 196, 220, 246.94];
    this.tempo = 128;
  }

  async start() {
    if (this.started) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.initialize();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async initialize() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    this.ctx = new AudioContextClass();
    this.audioContext = this.ctx;
    const compressor = this.ctx.createDynamicsCompressor();
    compressor.threshold.value = -14;
    compressor.knee.value = 14;
    compressor.ratio.value = 4.5;
    compressor.attack.value = .004;
    compressor.release.value = .22;
    this.masterCompressor = compressor;
    this.master = this.ctx.createGain();
    this.sfx = this.ctx.createGain();
    this.music = this.ctx.createGain();
    this.musicDuck = this.ctx.createGain();
    this.ambience = this.ctx.createGain();
    this.reverbSend = this.ctx.createGain();
    this.reverb = this.ctx.createConvolver();
    this.reverb.buffer = this.createImpulse(2.25, 2.8);
    this.reverbSend.gain.value = .14;
    this.sfx.connect(compressor);
    this.sfx.connect(this.reverbSend);
    this.music.connect(this.musicDuck);
    this.musicDuck.connect(compressor);
    this.ambience.connect(compressor);
    this.ambience.connect(this.reverbSend);
    this.reverbSend.connect(this.reverb);
    this.reverb.connect(compressor);
    compressor.connect(this.master);
    this.master.connect(this.ctx.destination);
    this.musicDuck.gain.value = 1;
    this.noiseBuffer = this.createNoiseBuffer(3);
    this.distortionCurve = this.createDistortionCurve(65);
    this.applyMix();
    this.startAmbience();
    this.createDroneVoices();
    this.nextStepTime = this.ctx.currentTime + .08;
    this.started = true;
    await this.ctx.resume();
    this.ui();
  }

  createNoiseBuffer(seconds, brownAmount = .035) {
    const buffer = this.ctx.createBuffer(1, Math.floor(this.ctx.sampleRate * seconds), this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let brown = 0;
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1;
      brown = brown * (1 - brownAmount) + white * brownAmount;
      data[i] = white * .38 + brown * .9;
    }
    return buffer;
  }

  createDistortionCurve(amount = 50) {
    const samples = 256;
    const curve = new Float32Array(samples);
    const drive = Math.max(1, amount);
    for (let i = 0; i < samples; i++) {
      const x = i * 2 / samples - 1;
      curve[i] = ((3 + drive) * x * 20 * Math.PI / 180) / (Math.PI + drive * Math.abs(x));
    }
    return curve;
  }

  createImpulse(seconds, decay) {
    const length = Math.floor(this.ctx.sampleRate * seconds);
    const impulse = this.ctx.createBuffer(2, length, this.ctx.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const data = impulse.getChannelData(channel);
      for (let i = 0; i < length; i++) {
        const envelope = (1 - i / length) ** decay;
        data[i] = (Math.random() * 2 - 1) * envelope * (i < 80 ? i / 80 : 1);
      }
    }
    return impulse;
  }

  resolveDestination(destination) {
    if (destination?.getInput) return destination.getInput();
    if (destination?.input && typeof destination.input.connect === 'function') return destination.input;
    return destination || this.sfx;
  }

  routePan(node, pan, destination) {
    const target = this.resolveDestination(destination);
    if (this.ctx.createStereoPanner) {
      const panner = this.ctx.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, pan || 0));
      node.connect(panner);
      panner.connect(target);
      return panner;
    }
    node.connect(target);
    return target;
  }

  tone(frequencyStart, frequencyEnd, duration, gainValue, type = 'sine', when = null, destination = null, pan = 0) {
    if (!this.started) return null;
    const start = when ?? this.ctx.currentTime;
    const oscillator = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(Math.max(10, frequencyStart), start);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(10, frequencyEnd), start + duration);
    gain.gain.setValueAtTime(.0001, start);
    gain.gain.exponentialRampToValueAtTime(Math.max(.0002, gainValue), start + .006);
    gain.gain.exponentialRampToValueAtTime(.0001, start + duration);
    oscillator.connect(gain);
    this.routePan(gain, pan, destination || this.sfx);
    oscillator.start(start);
    oscillator.stop(start + duration + .03);
    return gain;
  }

  noise(duration, gainValue, frequency = 1200, type = 'bandpass', pan = 0, when = null, destination = null, q = .7) {
    if (!this.started) return null;
    const start = when ?? this.ctx.currentTime;
    const source = this.ctx.createBufferSource();
    const filter = this.ctx.createBiquadFilter();
    const gain = this.ctx.createGain();
    source.buffer = this.noiseBuffer;
    filter.type = type;
    filter.frequency.value = frequency;
    filter.Q.value = q;
    gain.gain.setValueAtTime(Math.max(.0002, gainValue), start);
    gain.gain.exponentialRampToValueAtTime(.0001, start + duration);
    source.connect(filter);
    filter.connect(gain);
    this.routePan(gain, pan, destination || this.sfx);
    source.start(start, Math.random() * 2);
    source.stop(start + duration + .03);
    return gain;
  }

  startAmbience() {
    const rain = this.ctx.createBufferSource();
    const rainFilter = this.ctx.createBiquadFilter();
    const rainGain = this.ctx.createGain();
    rain.buffer = this.noiseBuffer;
    rain.loop = true;
    rainFilter.type = 'highpass';
    rainFilter.frequency.value = 2500;
    rainGain.gain.value = .058;
    rain.connect(rainFilter);
    rainFilter.connect(rainGain);
    rainGain.connect(this.ambience);
    rain.start();

    const city = this.ctx.createBufferSource();
    const cityFilter = this.ctx.createBiquadFilter();
    const cityGain = this.ctx.createGain();
    city.buffer = this.noiseBuffer;
    city.loop = true;
    cityFilter.type = 'lowpass';
    cityFilter.frequency.value = 340;
    cityGain.gain.value = .064;
    city.connect(cityFilter);
    cityFilter.connect(cityGain);
    cityGain.connect(this.ambience);
    city.start(.02);
    for (const [frequency, gainValue] of [[43, .017], [65, .011], [118, .005]]) {
      const oscillator = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.value = gainValue;
      oscillator.connect(gain);
      gain.connect(this.ambience);
      oscillator.start();
    }
    this.startAmbientDrone();
    this.startArpeggiator();
  }

  /**
   * Starts a persistent low-frequency tension bed. The LFO modulates the
   * filter cutoff rather than the oscillator pitch, creating a subtle breath
   * without making the arena sound seasick.
   */
  startAmbientDrone() {
    if (!this.ctx || this.ambientDrone) return this.ambientDrone?.output || null;
    const output = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();
    const lfo = this.ctx.createOscillator();
    const lfoDepth = this.ctx.createGain();
    const now = this.ctx.currentTime;

    output.gain.value = .38;
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(360, now);
    filter.Q.value = .8;
    lfo.type = 'sine';
    lfo.frequency.value = .075;
    lfoDepth.gain.value = 125;
    lfo.connect(lfoDepth);
    lfoDepth.connect(filter.frequency);
    filter.connect(output);
    output.connect(this.ambience);

    const voices = [
      { type: 'sine', frequency: 40, gain: .15 },
      { type: 'sine', frequency: 41.5, gain: .12 },
      { type: 'triangle', frequency: 80, gain: .045 }
    ];
    const oscillators = voices.map(({ type, frequency, gain: gainValue }) => {
      const oscillator = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      oscillator.type = type;
      oscillator.frequency.value = frequency;
      gain.gain.value = gainValue;
      oscillator.connect(gain);
      gain.connect(filter);
      oscillator.start(now);
      return { oscillator, gain };
    });
    lfo.start(now);
    this.ambientDrone = { output, filter, lfo, lfoDepth, oscillators };
    return output;
  }

  startArpeggiator() {
    this.arpeggiatorEnabled = true;
    this.arpeggioStep = 0;
    return this;
  }

  stopArpeggiator() {
    this.arpeggiatorEnabled = false;
    return this;
  }

  playArpeggioNote(frequency, when, pan = 0, intensity = 1) {
    if (!this.started || !this.arpeggiatorEnabled) return null;
    const oscillator = this.ctx.createOscillator();
    const filter = this.ctx.createBiquadFilter();
    const gain = this.ctx.createGain();
    const output = this.ctx.createGain();
    const duration = .16;
    const start = when ?? this.ctx.currentTime;
    const level = .018 + intensity * .009;
    oscillator.type = 'sawtooth';
    oscillator.frequency.setValueAtTime(Math.max(20, frequency), start);
    filter.type = 'lowpass';
    filter.Q.value = 1.3;
    filter.frequency.setValueAtTime(2600, start);
    filter.frequency.exponentialRampToValueAtTime(460, start + duration);
    gain.gain.setValueAtTime(.0001, start);
    gain.gain.exponentialRampToValueAtTime(level, start + .004);
    gain.gain.exponentialRampToValueAtTime(.0001, start + duration);
    oscillator.connect(filter);
    filter.connect(gain);
    gain.connect(output);
    this.routePan(output, pan, this.music);
    oscillator.start(start);
    oscillator.stop(start + duration + .025);
    return output;
  }

  createDroneVoices() {
    for (let i = 0; i < 3; i++) {
      const oscillator = this.ctx.createOscillator();
      const filter = this.ctx.createBiquadFilter();
      const gain = this.ctx.createGain();
      const panner = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
      oscillator.type = i === 0 ? 'sawtooth' : 'triangle';
      oscillator.frequency.value = 72 + i * 19;
      filter.type = 'lowpass';
      filter.frequency.value = 430 + i * 120;
      gain.gain.value = 0;
      oscillator.connect(filter);
      filter.connect(gain);
      if (panner) { gain.connect(panner); panner.connect(this.sfx); }
      else gain.connect(this.sfx);
      oscillator.start();
      this.droneVoices.push({ oscillator, gain, panner });
    }
  }

  setMix(partial) {
    this.mix = { ...this.mix, ...partial };
    storeMix(this.mix);
    this.applyMix();
  }

  applyMix() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    // A1: menu di pausa aperto → musica e ambiente si abbassano e il pannello
    // resta leggibile; gli effetti UI restano quasi a pieno volume.
    const musicDuck = this.menuDucked ? .42 : 1;
    const ambienceDuck = this.menuDucked ? .5 : 1;
    const sfxDuck = this.menuDucked ? .82 : 1;
    // Livelli base rialzati (review demo): master .72→.9; SFX con boost
    // dedicato ×1.3; musica ×.55 (richiesta demo: più presente); ambiente
    // ×.62. Il compressore sul master gestisce i picchi.
    this.master.gain.setTargetAtTime(this.muted ? 0 : .9, now, .025);
    this.sfx.gain.setTargetAtTime(this.mix.sfx * 1.3 * sfxDuck, now, .025);
    this.music.gain.setTargetAtTime(this.mix.music * .55 * musicDuck, now, .035);
    this.ambience.gain.setTargetAtTime(this.mix.ambience * .62 * ambienceDuck, now, .035);
  }

  // A1: attenuazione del mix con il menu aperto. Dirty-check interno: chiamabile
  // a ogni frame dal game loop senza costo quando lo stato non cambia.
  setMenuDuck(active) {
    const next = Boolean(active);
    if (next === this.menuDucked) return;
    this.menuDucked = next;
    this.applyMix();
  }

  duckMusic(amount = .35, duration = .18) {
    if (!this.started) return;
    const now = this.ctx.currentTime;
    this.musicDuck.gain.cancelScheduledValues(now);
    this.musicDuck.gain.setValueAtTime(this.musicDuck.gain.value, now);
    this.musicDuck.gain.exponentialRampToValueAtTime(Math.max(.25, 1 - amount), now + .012);
    this.musicDuck.gain.exponentialRampToValueAtTime(1, now + duration);
  }

  update(snapshot = {}) {
    if (!this.started || this.ctx.state !== 'running') return;
    const enemies = snapshot.aliveEnemies || 0;
    const wave = snapshot.wave || 1;
    const health = snapshot.health ?? 100;
    this.lastHealth = health;
    const danger = health < 35 ? .4 : health < 60 ? .18 : 0;
    const energy = Math.min(1, enemies / 8 * .45 + wave / 8 * .3 + danger + (snapshot.combo || 1) / 5 * .12);
    this.targetIntensity = energy > .78 ? 3 : energy > .48 ? 2 : energy > .18 ? 1 : 0;
    const sixteenth = 60 / this.tempo / 4;
    const now = this.ctx.currentTime;
    // Riallinea lo scheduler dopo una tab nascosta o un resume: currentTime del
    // contesto continua ad avanzare mentre il loop rAF è fermo; senza questo clamp
    // al ritorno si schedulerebbero migliaia di note nel passato (stallo + raffica).
    if (this.nextStepTime < now - .25) this.nextStepTime = now + .05;
    let scheduled = 0;
    while (this.nextStepTime < now + .12 && scheduled < 8) {
      if (this.step % 16 === 0) this.intensity = this.targetIntensity;
      this.scheduleStep(this.nextStepTime, this.step);
      this.nextStepTime += sixteenth;
      this.step++;
      scheduled++;
    }
    // Sub-bass grave quando un Apex è vivo: hum "presenza" distinto dal ronzio
    // dei droni normali. Commutazione più aggressiva (figura/dà la tensione).
    this.updateApexHum(Boolean(snapshot.apexAlive), now);
  }

  updateApexHum(apexAlive, now = null) {
    const time = now ?? (this.ctx ? this.ctx.currentTime : 0);
    if (apexAlive && !this.apexHum) {
      if (!this.started || !this.ctx) return;
      const oscillator = this.ctx.createOscillator();
      oscillator.type = 'sawtooth';
      oscillator.frequency.value = 38;
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 160;
      oscillator.connect(filter);
      filter.connect(gain);
      gain.connect(this.music);
      oscillator.start();
      this.apexHum = { oscillator, gain, filter };
      this.duckMusic(.55, .12);
    } else if (!apexAlive && this.apexHum) {
      const hum = this.apexHum;
      hum.gain.gain.setTargetAtTime(0, time, .15);
      hum.oscillator.stop(time + 1);
      this.apexHum = null;
    }
    if (this.apexHum && this.ctx) {
      const intensity = 1 + Math.random() * .4;
      this.apexHum.gain.gain.setTargetAtTime(.035 + intensity * .015, time, .2);
      this.apexHum.oscillator.frequency.setTargetAtTime(36 + Math.random() * 6, time, .35);
      this.apexHum.filter.frequency.setTargetAtTime(130 + intensity * 50, time, .3);
    }
  }

  scheduleStep(time, step) {
    const beat = step % 16;
    const bar = Math.floor(step / 16);
    const variation = Math.floor(bar / 8) % 4;
    if (beat % 4 === 0) {
      this.tone(82, 34, .19, .2, 'sine', time, this.music);
      this.noise(.04, .032, 420, 'lowpass', 0, time, this.music);
    }
    if (beat === 4 || beat === 12) {
      this.noise(.105, .075, 1750, 'bandpass', variation % 2 ? .12 : -.12, time, this.music, 1.2);
      this.noise(.045, .034, 6500, 'highpass', 0, time, this.music);
    }
    if (this.intensity >= 1 && (beat % 2 === 1 || (this.intensity >= 3 && beat % 2 === 0))) {
      this.noise(.025, .018 + this.intensity * .006, 7600 + variation * 650, 'highpass', beat % 4 ? .24 : -.24, time, this.music);
    }
    if (beat % 4 === 2 && this.intensity >= 2) this.noise(.035, .035, 10200, 'highpass', .34, time, this.music);

    const roots = [36.71, 36.71, 43.65, 32.7, 36.71, 49, 43.65, 32.7];
    if (beat % 2 === 0) {
      const root = roots[(Math.floor(step / 2) + variation) % roots.length];
      this.tone(root, root * .992, .21, .055 + this.intensity * .008, 'sawtooth', time, this.music, beat % 4 ? -.1 : .1);
      if (this.intensity >= 2) this.tone(root * 2, root * 1.995, .12, .015, 'square', time, this.music, .18);
    }
    // Combat arpeggiator: short sawtooth plucks from the natural minor scale.
    if (this.intensity >= 1 && beat % 2 === (variation % 2)) {
      const scaleIndex = this.arpeggioStep++ % this.naturalMinorScale.length;
      const octave = this.intensity >= 2 ? 2 : 1;
      const note = this.naturalMinorScale[scaleIndex] * octave;
      this.playArpeggioNote(note, time, beat < 8 ? -.28 : .28, this.intensity);
    }
    if (beat === 0) {
      const chord = variation % 2 ? [110, 146.83, 220] : [110, 164.81, 220];
      for (const note of chord) this.tone(note, note * .998, 1.75, .006 + this.intensity * .0015, 'triangle', time, this.music);
    }
    if (this.intensity >= 3 && beat === 15) this.tone(220, 880, .105, .018, 'sawtooth', time, this.music, .22);
    // A4: integrità critica → doppio tonfo in ottava bassa (battito) ogni due
    // battute. Va al canale SFX: deve emergere anche sopra la musica ducked.
    if (this.lastHealth < 35 && beat % 8 === 0) {
      this.tone(58, 40, .11, .13, 'sine', time, this.sfx);
      this.tone(54, 36, .09, .09, 'sine', time + .17, this.sfx);
    }
  }

  updateDroneHums(drones, camera) {
    if (!this.started) return;
    const now = this.ctx.currentTime;
    // A1: con il menu aperto i rombi dei droni tacciono del tutto.
    if (this.menuDucked) {
      for (const voice of this.droneVoices) voice.gain.gain.setTargetAtTime(0, now, .12);
      return;
    }
    // Riutilizza array e vettori temporanei: niente allocazioni nel frame loop.
    const alive = this._aliveDrones || (this._aliveDrones = []);
    alive.length = 0;
    const camPos = camera.position;
    for (const drone of drones) {
      if (drone.alive) alive.push(drone);
    }
    alive.sort((a, b) => a.position.distanceToSquared(camPos) - b.position.distanceToSquared(camPos));
    const projected = this._projected || (this._projected = new THREE.Vector3());
    for (let i = 0; i < this.droneVoices.length; i++) {
      const voice = this.droneVoices[i];
      const drone = alive[i];
      if (!drone) {
        voice.gain.gain.setTargetAtTime(0, now, .08);
        continue;
      }
      const distance = drone.position.distanceTo(camPos);
      const gain = Math.max(0, 1 - distance / 30) * .027;
      projected.copy(drone.position).project(camera);
      voice.gain.gain.setTargetAtTime(gain, now, .08);
      voice.oscillator.frequency.setTargetAtTime(72 + drone.velocity.length() * 7 + i * 11, now, .08);
      if (voice.panner) voice.panner.pan.setTargetAtTime(Math.max(-.9, Math.min(.9, projected.x)), now, .06);
    }
  }

  createSfxOutput(destination = null, pan = 0) {
    const output = this.ctx.createGain();
    output.gain.value = 1;
    this.routePan(output, pan, destination || this.sfx);
    return output;
  }

  /** Sci-fi shot: fast pitch sweep + distorted low-passed noise. */
  playShoot({ when = null, destination = null, pan = 0 } = {}) {
    if (!this.started) return null;
    const start = when ?? this.ctx.currentTime;
    const output = this.createSfxOutput(destination, pan);
    const oscillator = this.ctx.createOscillator();
    const oscillatorGain = this.ctx.createGain();
    const noiseSource = this.ctx.createBufferSource();
    const noiseFilter = this.ctx.createBiquadFilter();
    const distortion = this.ctx.createWaveShaper();
    const noiseGain = this.ctx.createGain();
    const variation = Math.random();

    output.gain.setValueAtTime(.72, start);
    output.gain.exponentialRampToValueAtTime(.0001, start + .2);
    oscillator.type = 'sawtooth';
    oscillator.frequency.setValueAtTime(190 + variation * 35, start);
    oscillator.frequency.exponentialRampToValueAtTime(42 + variation * 12, start + .14);
    oscillatorGain.gain.setValueAtTime(.0001, start);
    oscillatorGain.gain.exponentialRampToValueAtTime(.28, start + .004);
    oscillatorGain.gain.exponentialRampToValueAtTime(.0001, start + .16);
    oscillator.connect(oscillatorGain);
    oscillatorGain.connect(output);

    noiseSource.buffer = this.noiseBuffer;
    noiseFilter.type = 'lowpass';
    noiseFilter.Q.value = 1.1;
    noiseFilter.frequency.setValueAtTime(5600 + variation * 900, start);
    noiseFilter.frequency.exponentialRampToValueAtTime(780, start + .12);
    distortion.curve = this.distortionCurve || this.createDistortionCurve(65);
    distortion.oversample = '2x';
    noiseGain.gain.setValueAtTime(.0001, start);
    noiseGain.gain.exponentialRampToValueAtTime(.4 + variation * .08, start + .003);
    noiseGain.gain.exponentialRampToValueAtTime(.0001, start + .13);
    noiseSource.connect(noiseFilter);
    noiseFilter.connect(distortion);
    distortion.connect(noiseGain);
    noiseGain.connect(output);

    oscillator.start(start);
    oscillator.stop(start + .2);
    noiseSource.start(start, Math.random() * Math.max(.01, this.noiseBuffer.duration - .2));
    noiseSource.stop(start + .16);
    this.duckMusic(.12, .1);
    return output;
  }

  /** Dry metallic hit with a short resonant transient. */
  playImpact(options = {}) {
    if (!this.started) return null;
    if (typeof options === 'string') options = { material: options };
    const { when = null, destination = null, pan = 0, material = 'metal' } = options;
    const start = when ?? this.ctx.currentTime;
    const output = this.createSfxOutput(destination, pan);
    const source = this.ctx.createBufferSource();
    const filter = this.ctx.createBiquadFilter();
    const noiseGain = this.ctx.createGain();
    const oscillator = this.ctx.createOscillator();
    const oscillatorGain = this.ctx.createGain();
    const frequency = material === 'wood' ? 760 : material === 'concrete' ? 980 : 3200;

    output.gain.setValueAtTime(.6, start);
    output.gain.exponentialRampToValueAtTime(.0001, start + .16);
    source.buffer = this.noiseBuffer;
    filter.type = 'bandpass';
    filter.frequency.value = frequency;
    filter.Q.value = material === 'metal' ? 4.2 : 1.4;
    noiseGain.gain.setValueAtTime(.0001, start);
    noiseGain.gain.exponentialRampToValueAtTime(.13, start + .002);
    noiseGain.gain.exponentialRampToValueAtTime(.0001, start + .085);
    source.connect(filter);
    filter.connect(noiseGain);
    noiseGain.connect(output);

    oscillator.type = 'triangle';
    oscillator.frequency.setValueAtTime(material === 'metal' ? 620 : 250, start);
    oscillator.frequency.exponentialRampToValueAtTime(120, start + .09);
    oscillatorGain.gain.setValueAtTime(.0001, start);
    oscillatorGain.gain.exponentialRampToValueAtTime(.055, start + .002);
    oscillatorGain.gain.exponentialRampToValueAtTime(.0001, start + .11);
    oscillator.connect(oscillatorGain);
    oscillatorGain.connect(output);
    source.start(start, Math.random() * Math.max(.01, this.noiseBuffer.duration - .12));
    source.stop(start + .12);
    oscillator.start(start);
    oscillator.stop(start + .14);
    return output;
  }

  /** Quiet, randomized low-pass noise step. */
  playFootstep({ when = null, destination = null, pan = 0, sprint = false } = {}) {
    if (!this.started) return null;
    const start = when ?? this.ctx.currentTime;
    const variation = Math.random();
    const output = this.createSfxOutput(destination, pan);
    const source = this.ctx.createBufferSource();
    const filter = this.ctx.createBiquadFilter();
    const gain = this.ctx.createGain();
    source.buffer = this.noiseBuffer;
    filter.type = 'lowpass';
    filter.frequency.value = (sprint ? 760 : 470) + variation * 260;
    filter.Q.value = .65 + variation * .35;
    gain.gain.setValueAtTime(.0001, start);
    gain.gain.exponentialRampToValueAtTime((sprint ? .19 : .13) + variation * .03, start + .003);
    gain.gain.exponentialRampToValueAtTime(.0001, start + (sprint ? .105 : .09));
    source.connect(filter);
    filter.connect(gain);
    gain.connect(output);
    source.start(start, Math.random() * Math.max(.01, this.noiseBuffer.duration - .12));
    source.stop(start + .12);
    return output;
  }

  // Compatibility aliases used by older gameplay code.
  melee() {
    const variation = Math.random();
    this.noise(.09 + variation * .04, .16 + variation * .06, 620 + variation * 420, 'bandpass');
    this.tone(190 + variation * 35, 62, .14, .12, 'sawtooth');
  }
  pickup() {
    this.tone(420, 920, .16, .09, 'sine');
    this.tone(840, 1320, .12, .06, 'triangle', (this.ctx?.currentTime || 0) + .05);
  }
  dry() { this.tone(420, 260, .055, .1, 'square'); }
  footstep(sprint = false) { return this.playFootstep({ sprint }); }
  jump() { this.noise(.08, .08, 700, 'lowpass'); this.tone(130, 260, .14, .09, 'sine'); }
  land(force = 1) { this.noise(.14, .12 * Math.min(force, 1.5), 420, 'lowpass'); this.tone(64, 36, .11, .08 * Math.min(force, 1.4), 'sine'); }
  pad() { this.tone(90, 720, .42, .18, 'sawtooth'); this.tone(180, 1080, .5, .08, 'sine'); }
  reload() {
    if (!this.started) return;
    const time = this.ctx.currentTime;
    this.noise(.055, .09, 1700, 'bandpass', -.2, time);
    this.tone(430, 260, .06, .07, 'square', time + .26);
    this.tone(320, 610, .08, .075, 'square', time + .78);
  }
  impact(material = 'metal') { return this.playImpact({ material }); }
  hit(kill = false) {
    this.tone(kill ? 880 : 690, kill ? 1320 : 930, kill ? .12 : .065, kill ? .13 : .085, 'sine');
    if (kill) this.tone(440, 880, .16, .065, 'triangle', this.ctx.currentTime + .035);
  }
  enemyShot(pan = 0) { this.tone(680, 110, .23, .075, 'sawtooth', null, null, pan); this.noise(.1, .04, 2400, 'bandpass', pan); }
  droneTelegraph(pan = 0) { this.tone(520, 1040, .09, .045, 'square', null, null, pan); }
  hurt() { this.noise(.18, .18, 260, 'lowpass'); this.tone(90, 42, .24, .15, 'sine'); this.duckMusic(.35, .3); }
  explode(pan = 0) {
    this.noise(.5, .3, 330, 'lowpass', pan);
    this.noise(.22, .17, 1800, 'bandpass', pan);
    this.tone(96, 24, .52, .22, 'sawtooth', null, null, pan);
    this.tone(480, 90, .2, .06, 'square', null, null, pan);
    this.duckMusic(.5, .46);
  }
  ui() { this.tone(520, 760, .055, .05, 'sine'); }

  /** A3: stinger di inizio ondata — sweep ascendente + impatto basso finale. */
  waveStart() {
    if (!this.started) return;
    const time = this.ctx.currentTime;
    this.tone(180, 720, .38, .055, 'sawtooth', time, this.music, -.12);
    this.tone(90, 360, .42, .04, 'triangle', time + .06, this.music, .12);
    this.noise(.3, .05, 2400, 'bandpass', 0, time + .26, this.music);
    this.tone(70, 34, .3, .15, 'sine', time + .3, this.sfx);
  }

  // --- Apex Sentinel: stinger e suoni del nemico speciale di fine ondata ---
  apexStart() {
    if (!this.started) return;
    const time = this.ctx.currentTime;
    this.tone(60, 120, .7, .06, 'sawtooth', time, this.music, -.16);
    this.tone(120, 240, .6, .045, 'square', time + .05, this.music, .16);
    this.noise(.5, .06, 900, 'lowpass', 0, time, this.music);
    this.tone(52, 30, .5, .16, 'sine', time + .35, this.sfx);
    this.tone(1040, 2080, .22, .03, 'triangle', time + .4, this.sfx, -.2);
  }
  apexKill(pan = 0) {
    this.noise(.7, .34, 260, 'lowpass', pan);
    this.noise(.34, .2, 1500, 'bandpass', pan);
    this.tone(70, 22, .7, .24, 'sawtooth', null, null, pan);
    this.tone(1400, 120, .5, .1, 'square', null, null, pan);
    this.duckMusic(.6, .7);
  }
  apexTelegraph(pan = 0) { this.tone(220, 880, .3, .05, 'square', null, null, pan); this.noise(.2, .04, 3000, 'bandpass', pan); }
  apexCharge() { this.tone(90, 320, .34, .07, 'sawtooth', null, null, 0); this.noise(.3, .05, 700, 'lowpass', 0); }
  apexBarrage() { this.tone(300, 900, .2, .05, 'square', null, null, 0); this.noise(.16, .04, 4200, 'bandpass', 0); }
  apexShot(pan = 0) { this.tone(720, 160, .2, .06, 'sawtooth', null, null, pan); this.noise(.12, .05, 2600, 'bandpass', pan); }
  apexSplit() { this.tone(500, 150, .25, .06, 'square', null, null, 0); this.noise(.2, .05, 1800, 'bandpass', 0); }
  apexSummon() { this.tone(100, 300, .4, .05, 'sawtooth', null, null, 0); this.noise(.3, .05, 1200, 'lowpass', 0); }
  apexMine() { this.tone(1200, 600, .22, .05, 'sine', null, null, 0); this.noise(.12, .04, 5000, 'highpass', 0); }
  apexMineBoom(pan = 0) { this.noise(.4, .22, 500, 'lowpass', pan); this.tone(120, 40, .4, .16, 'sine', null, null, pan); }
  apexShockwave() { this.noise(.45, .2, 300, 'lowpass', 0); this.tone(60, 180, .35, .12, 'sine', null, null, 0); }
  apexArmorBreak(pan = 0) { this.noise(.3, .18, 2400, 'bandpass', pan); this.tone(300, 90, .3, .08, 'square', null, null, pan); }
  apexPhase(pan = 0) { this.tone(200, 900, .4, .06, 'sawtooth', null, null, pan); this.noise(.3, .05, 3200, 'bandpass', pan); }

  toggle() {
    this.muted = !this.muted;
    storeMuted(this.muted);
    this.applyMix();
    this.onStateChange(this.muted);
  }
}
