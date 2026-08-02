import { getStoredMix, storeMix } from './config.js';

export class AdaptiveAudioEngine {
  constructor(onStateChange = () => {}) {
    this.ctx = null;
    this.master = null;
    this.sfx = null;
    this.music = null;
    this.musicDuck = null;
    this.ambience = null;
    this.reverb = null;
    this.reverbSend = null;
    this.noiseBuffer = null;
    this.started = false;
    this.muted = false;
    this.nextStepTime = 0;
    this.step = 0;
    this.targetIntensity = 0;
    this.intensity = 0;
    this.mix = getStoredMix();
    this.onStateChange = onStateChange;
    this.droneVoices = [];
    this.tempo = 128;
  }

  async start() {
    if (this.started) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    this.ctx = new AudioContextClass();
    const compressor = this.ctx.createDynamicsCompressor();
    compressor.threshold.value = -14;
    compressor.knee.value = 14;
    compressor.ratio.value = 4.5;
    compressor.attack.value = .004;
    compressor.release.value = .22;
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
    this.noiseBuffer = this.makeNoise(3);
    this.applyMix();
    this.startAmbience();
    this.createDroneVoices();
    this.nextStepTime = this.ctx.currentTime + .08;
    this.started = true;
    await this.ctx.resume();
    this.ui();
  }

  makeNoise(seconds) {
    const buffer = this.ctx.createBuffer(1, Math.floor(this.ctx.sampleRate * seconds), this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let brown = 0;
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1;
      brown = brown * .965 + white * .035;
      data[i] = white * .38 + brown * .9;
    }
    return buffer;
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

  routePan(node, pan, destination) {
    if (this.ctx.createStereoPanner) {
      const panner = this.ctx.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, pan || 0));
      node.connect(panner);
      panner.connect(destination);
      return panner;
    }
    node.connect(destination);
    return destination;
  }

  tone(frequencyStart, frequencyEnd, duration, gainValue, type = 'sine', when = null, destination = null, pan = 0) {
    if (!this.started) return;
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
  }

  noise(duration, gainValue, frequency = 1200, type = 'bandpass', pan = 0, when = null, destination = null, q = .7) {
    if (!this.started) return;
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
    this.master.gain.setTargetAtTime(this.muted ? 0 : .72, now, .025);
    this.sfx.gain.setTargetAtTime(this.mix.sfx, now, .025);
    this.music.gain.setTargetAtTime(this.mix.music * .26, now, .035);
    this.ambience.gain.setTargetAtTime(this.mix.ambience * .5, now, .035);
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
    const danger = health < 35 ? .4 : health < 60 ? .18 : 0;
    const energy = Math.min(1, enemies / 8 * .45 + wave / 8 * .3 + danger + (snapshot.combo || 1) / 5 * .12);
    this.targetIntensity = energy > .78 ? 3 : energy > .48 ? 2 : energy > .18 ? 1 : 0;
    const sixteenth = 60 / this.tempo / 4;
    while (this.nextStepTime < this.ctx.currentTime + .12) {
      if (this.step % 16 === 0) this.intensity = this.targetIntensity;
      this.scheduleStep(this.nextStepTime, this.step);
      this.nextStepTime += sixteenth;
      this.step++;
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
    if (this.intensity >= 2 && beat % 2 === (variation % 2)) {
      const arpeggio = [146.83, 174.61, 220, 261.63, 220, 174.61, 164.81, 196];
      const note = arpeggio[(Math.floor(step / 2) + variation * 2) % arpeggio.length];
      this.tone(note, note * 1.002, .095, .015 + this.intensity * .004, 'triangle', time, this.music, beat < 8 ? -.28 : .28);
    }
    if (beat === 0) {
      const chord = variation % 2 ? [110, 146.83, 220] : [110, 164.81, 220];
      for (const note of chord) this.tone(note, note * .998, 1.75, .006 + this.intensity * .0015, 'triangle', time, this.music);
    }
    if (this.intensity >= 3 && beat === 15) this.tone(220, 880, .105, .018, 'sawtooth', time, this.music, .22);
  }

  updateDroneHums(drones, camera) {
    if (!this.started) return;
    const alive = drones.filter(drone => drone.alive).sort((a, b) => a.position.distanceToSquared(camera.position) - b.position.distanceToSquared(camera.position));
    const now = this.ctx.currentTime;
    for (let i = 0; i < this.droneVoices.length; i++) {
      const voice = this.droneVoices[i];
      const drone = alive[i];
      if (!drone) {
        voice.gain.gain.setTargetAtTime(0, now, .08);
        continue;
      }
      const distance = drone.position.distanceTo(camera.position);
      const gain = Math.max(0, 1 - distance / 30) * .027;
      const projected = drone.position.clone().project(camera);
      voice.gain.gain.setTargetAtTime(gain, now, .08);
      voice.oscillator.frequency.setTargetAtTime(72 + drone.velocity.length() * 7 + i * 11, now, .08);
      if (voice.panner) voice.panner.pan.setTargetAtTime(Math.max(-.9, Math.min(.9, projected.x)), now, .06);
    }
  }

  gun() {
    const variation = Math.random();
    this.noise(.075 + variation * .035, .36 + variation * .08, 1650 + variation * 700, 'bandpass');
    this.tone(165 + variation * 28, 42 + variation * 10, .12, .27, 'square');
    this.tone(1180 + variation * 300, 250, .07, .06, 'sawtooth');
    this.duckMusic(.12, .1);
  }
  dry() { this.tone(420, 260, .055, .07, 'square'); }
  footstep(sprint = false) {
    const variation = Math.random();
    this.noise(.075 + variation * .035, sprint ? .14 : .095, 520 + variation * 460, 'lowpass', variation > .5 ? .16 : -.16);
    this.tone(sprint ? 90 : 70, 42, .065, .04 + variation * .012, 'sine');
  }
  jump() { this.noise(.08, .055, 700, 'lowpass'); this.tone(130, 260, .14, .065, 'sine'); }
  land(force = 1) { this.noise(.14, .12 * Math.min(force, 1.5), 420, 'lowpass'); this.tone(64, 36, .11, .08 * Math.min(force, 1.4), 'sine'); }
  pad() { this.tone(90, 720, .42, .18, 'sawtooth'); this.tone(180, 1080, .5, .08, 'sine'); }
  reload() {
    if (!this.started) return;
    const time = this.ctx.currentTime;
    this.noise(.055, .09, 1700, 'bandpass', -.2, time);
    this.tone(430, 260, .06, .07, 'square', time + .26);
    this.tone(320, 610, .08, .075, 'square', time + .78);
  }
  impact(material = 'metal') {
    const frequency = material === 'wood' ? 620 : material === 'concrete' ? 820 : 3100;
    this.noise(.07, .105, frequency, 'bandpass', Math.random() - .5);
    this.tone(material === 'metal' ? 540 : 230, 160, .06, .038, 'square');
  }
  hit(kill = false) {
    this.tone(kill ? 880 : 690, kill ? 1320 : 930, kill ? .12 : .065, kill ? .09 : .055, 'sine');
    if (kill) this.tone(440, 880, .16, .045, 'triangle', this.ctx.currentTime + .035);
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
  ui() { this.tone(520, 760, .055, .035, 'sine'); }
  toggle() {
    this.muted = !this.muted;
    this.applyMix();
    this.onStateChange(this.muted);
  }
}
