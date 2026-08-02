import { QUALITY_PROFILES, getStoredQualityMode, storeQualityMode } from './config.js';

export class GraphicsManager {
  constructor({ applyProfile, onStatus }) {
    this.applyProfile = applyProfile;
    this.onStatus = onStatus || (() => {});
    this.mode = getStoredQualityMode();
    this.autoTier = 'autoHigh';
    this.lowWindows = 0;
    this.highWindows = 0;
    this.cooldown = 0;
    this.profile = null;
  }

  init() {
    this.applyCurrent(true);
    return this.profile;
  }

  setMode(mode) {
    this.mode = mode === 'ultra' ? 'ultra' : 'auto';
    this.autoTier = 'autoHigh';
    this.lowWindows = 0;
    this.highWindows = 0;
    storeQualityMode(this.mode);
    this.applyCurrent(false);
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
