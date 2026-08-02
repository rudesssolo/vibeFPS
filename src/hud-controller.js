export class HudController {
  constructor() {
    this.ui = {
      healthFill: document.getElementById('health-fill'),
      shieldFill: document.getElementById('shield-fill'),
      staminaFill: document.getElementById('stamina-fill'),
      healthValue: document.getElementById('health-value'),
      shieldValue: document.getElementById('shield-value'),
      staminaValue: document.getElementById('stamina-value'),
      ammo: document.getElementById('ammo'),
      reserve: document.getElementById('reserve'),
      ammoCells: document.getElementById('ammo-cells'),
      reload: document.getElementById('reload-message'),
      score: document.getElementById('score'),
      combo: document.getElementById('combo'),
      fps: document.getElementById('fps'),
      objective: document.getElementById('objective-text'),
      missionFill: document.getElementById('mission-progress-fill'),
      waveLabel: document.getElementById('wave-label'),
      toasts: document.getElementById('toast-stack'),
      sound: document.getElementById('sound-state')
    };
    if (!this.ui.ammoCells.children.length) {
      for (let i = 0; i < 15; i++) this.ui.ammoCells.appendChild(document.createElement('i'));
    }
    this.last = {};
    this.graphicsStatus = 'AUTO // HIGH';
    this.onboardingTimer = null;
  }

  render(state) {
    const health = Math.max(0, state.health);
    const shield = Math.max(0, state.shield);
    const stamina = Math.max(0, state.stamina);
    this.ui.healthFill.style.width = `${health}%`;
    this.ui.shieldFill.style.width = `${shield / 75 * 100}%`;
    this.ui.staminaFill.style.width = `${stamina}%`;
    this.ui.healthValue.textContent = String(Math.ceil(health)).padStart(3, '0');
    this.ui.shieldValue.textContent = String(Math.ceil(shield)).padStart(3, '0');
    this.ui.staminaValue.textContent = String(Math.ceil(stamina)).padStart(3, '0');
    this.ui.ammo.textContent = String(state.ammo).padStart(2, '0');
    this.ui.reserve.textContent = String(state.reserve).padStart(3, '0');
    [...this.ui.ammoCells.children].forEach((cell, index) => cell.classList.toggle('empty', index * 2 >= state.ammo));
    this.ui.reload.classList.toggle('active', state.reloading);
    this.ui.score.textContent = String(Math.round(state.score)).padStart(6, '0');
    this.ui.combo.textContent = `x${state.combo.toFixed(1)}`;
    this.ui.objective.textContent = `NEUTRALIZZA I DRONI · ${state.waveKills}/${state.waveTargets}`;
    this.ui.missionFill.style.width = `${state.waveTargets ? state.waveKills / state.waveTargets * 100 : 0}%`;
    this.ui.waveLabel.textContent = `ONDATA ${String(state.wave).padStart(2, '0')}`;
    document.getElementById('game-hud').classList.toggle('critical', state.health < 35);
  }

  setFPS(fps) {
    this.ui.fps.textContent = `${fps} FPS · ${this.graphicsStatus}`;
  }

  setGraphicsStatus(status) {
    this.graphicsStatus = status;
  }

  setMuted(muted) {
    this.ui.sound.innerHTML = muted
      ? 'AUDIO: <b class="danger-text">MUTED</b> · M ENABLE'
      : 'AUDIO: IMMERSIVE · <b>M</b> MUTE';
  }

  toast(message) {
    const element = document.createElement('div');
    element.className = 'toast';
    element.innerHTML = message;
    this.ui.toasts.prepend(element);
    setTimeout(() => element.remove(), 2900);
  }

  beginOnboardingFade() {
    clearTimeout(this.onboardingTimer);
    document.getElementById('hud').classList.remove('onboarding-hidden');
    this.onboardingTimer = setTimeout(() => document.getElementById('hud').classList.add('onboarding-hidden'), 6000);
  }

  mountSettings(overlay, { qualityMode, mix, onQuality, onMix }) {
    const panel = document.createElement('div');
    panel.className = 'settings-panel';
    panel.innerHTML = `
      <div class="settings-title">SIMULATION SETTINGS</div>
      <div class="quality-toggle" role="group" aria-label="Qualità grafica">
        <button type="button" data-quality="auto">AUTO</button>
        <button type="button" data-quality="ultra">ULTRA</button>
      </div>
      <label><span>MUSICA</span><input data-mix="music" type="range" min="0" max="1" step="0.01" value="${mix.music}"></label>
      <label><span>EFFETTI</span><input data-mix="sfx" type="range" min="0" max="1" step="0.01" value="${mix.sfx}"></label>
      <label><span>AMBIENTE</span><input data-mix="ambience" type="range" min="0" max="1" step="0.01" value="${mix.ambience}"></label>`;
    panel.addEventListener('click', event => event.stopPropagation());
    panel.addEventListener('pointerdown', event => event.stopPropagation());
    const setSelected = mode => panel.querySelectorAll('[data-quality]').forEach(button => button.classList.toggle('selected', button.dataset.quality === mode));
    setSelected(qualityMode);
    panel.querySelectorAll('[data-quality]').forEach(button => button.addEventListener('click', () => {
      setSelected(button.dataset.quality);
      onQuality(button.dataset.quality);
    }));
    panel.querySelectorAll('[data-mix]').forEach(input => input.addEventListener('input', () => {
      onMix({ [input.dataset.mix]: Number(input.value) });
    }));
    overlay.appendChild(panel);
    return panel;
  }
}
