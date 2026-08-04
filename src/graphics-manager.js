import { QUALITY_PROFILES, getStoredQualityMode, storeQualityMode } from './config.js';

export class GraphicsManager {
  constructor({ applyProfile, onStatus, onTransition, allowUltra = true }) {
    this.applyProfile = applyProfile;
    this.onStatus = onStatus || (() => {});
    this.onTransition = onTransition || (() => {});
    this.allowUltra = allowUltra;
    this.mode = allowUltra ? getStoredQualityMode() : 'auto';
    this.autoTier = 'autoHigh';
    this.lowWindows = 0;
    this.highWindows = 0;
    this.cooldown = 0;
    this.profile = null;
    this.transitioning = false;
  }

  init() {
    this.applyCurrent(true);
    return this.profile;
  }

  setMode(mode) {
    // Su dispositivi touch non high-end ULTRA non è disponibile: forza AUTO.
    const nextMode = mode === 'ultra' && this.allowUltra ? 'ultra' : 'auto';
    if (this.transitioning || nextMode === this.mode) return;
    this.mode = nextMode;
    this.autoTier = 'autoHigh';
    this.lowWindows = 0;
    this.highWindows = 0;
    storeQualityMode(this.mode);
    if (this.mode !== 'ultra') {
      this.applyCurrent(false);
      return;
    }

    this.transitioning = true;
    this.onTransition({ active: true, progress: 0, label: 'ULTRA PROFILE', detail: 'PREPARAZIONE DELLE RISORSE AD ALTA QUALITÀ...' });
    requestAnimationFrame(() => {
      this.onTransition({ active: true, progress: .18, label: 'ULTRA PROFILE', detail: 'RIDIMENSIONAMENTO DEL BUFFER GRAFICO...' });
      requestAnimationFrame(() => {
        this.applyCurrent(false);
        this.onTransition({ active: true, progress: .78, label: 'ULTRA PROFILE', detail: 'RICOSTRUZIONE TEXTURE E RIFLESSI...' });
        requestAnimationFrame(() => {
          this.onTransition({ active: true, progress: 1, label: 'ULTRA READY', detail: 'PROFILO ULTRA APPLICATO · SINCRONIZZAZIONE COMPLETATA' });
          setTimeout(() => {
            this.transitioning = false;
            this.onTransition({ active: false });
          }, 260);
        });
      });
    });
  }

  applyCurrent(initial) {
    const key = this.mode === 'ultra' ? 'ultra' : this.autoTier;
    this.profile = QUALITY_PROFILES[key];
    this.applyProfile(this.profile, { mode: this.mode, initial });
    this.onStatus(this.profile.name, this.mode);
  }

  updateFPS(fps, delta) {
    if (this.mode !== 'auto') return;
    this.cooldown = Math.max(0, this.cooldown - delta);
    if (fps < 50) {
      this.lowWindows++;
      this.highWindows = Math.max(0, this.highWindows - 1);
    } else if (fps > 58) {
      this.highWindows++;
      this.lowWindows = Math.max(0, this.lowWindows - 1);
    } else {
      this.lowWindows = Math.max(0, this.lowWindows - 1);
      this.highWindows = Math.max(0, this.highWindows - 1);
    }

    if (this.autoTier === 'autoHigh' && this.lowWindows >= 6 && this.cooldown <= 0) {
      this.autoTier = 'autoLow';
      // L15: il cooldown è conteggiato in sample FPS (updateFPS è chiamato con
      // delta=0.5s da index.html), non in secondi: 30 sample ≈ 15s di gioco.
      this.cooldown = 30;
      this.lowWindows = 0;
      this.applyCurrent(false);
    } else if (this.autoTier === 'autoLow' && this.highWindows >= 20 && this.cooldown <= 0) {
      this.autoTier = 'autoHigh';
      this.cooldown = 30;
      this.highWindows = 0;
      this.applyCurrent(false);
    }
  }
}
