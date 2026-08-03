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
      accuracy: document.getElementById('accuracy'),
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
    this.maxShield = 75; // valore massimo scudo (M2); allineato in index.html con CONFIG.maxShield
    this.onboardingTimer = null;
  }

  render(state) {
    const health = Math.max(0, state.health);
    const shield = Math.max(0, state.shield);
    const stamina = Math.max(0, state.stamina);
    // Dirty-check: il DOM viene toccato solo quando un valore cambia davvero,
    // evitando ~20 scritture ridondanti per frame nel loop di gioco.
    const last = this.last;

    if (last.health !== health) {
      this.ui.healthFill.style.width = `${health}%`;
      this.ui.healthValue.textContent = String(Math.ceil(health)).padStart(3, '0');
      last.health = health;
    }
    if (last.shield !== shield) {
      const maxShield = this.maxShield > 0 ? this.maxShield : 75;
      this.ui.shieldFill.style.width = `${shield / maxShield * 100}%`;
      this.ui.shieldValue.textContent = String(Math.ceil(shield)).padStart(3, '0');
      last.shield = shield;
    }
    if (last.stamina !== stamina) {
      this.ui.staminaFill.style.width = `${stamina}%`;
      this.ui.staminaValue.textContent = String(Math.ceil(stamina)).padStart(3, '0');
      last.stamina = stamina;
    }
    if (last.ammo !== state.ammo) {
      this.ui.ammo.textContent = String(state.ammo).padStart(2, '0');
      const cells = this.ui.ammoCells.children;
      for (let i = 0; i < cells.length; i++) cells[i].classList.toggle('empty', i * 2 >= state.ammo);
      last.ammo = state.ammo;
    }
    if (last.reserve !== state.reserve) {
      this.ui.reserve.textContent = String(state.reserve).padStart(3, '0');
      last.reserve = state.reserve;
    }
    if (last.reloading !== state.reloading) {
      this.ui.reload.classList.toggle('active', state.reloading);
      last.reloading = state.reloading;
    }
    if (last.score !== state.score) {
      this.ui.score.textContent = String(Math.round(state.score)).padStart(6, '0');
      last.score = state.score;
    }
    if (last.combo !== state.combo) {
      this.ui.combo.textContent = `x${state.combo.toFixed(1)}`;
      last.combo = state.combo;
    }
    const accuracy = state.shots > 0
      ? `${Math.round(state.hits / state.shots * 100)}%`
      : '--';
    if (last.accuracy !== accuracy) {
      this.ui.accuracy.textContent = accuracy;
      last.accuracy = accuracy;
    }
    const objective = `${state.waveKills}/${state.waveTargets}`;
    if (last.objective !== objective) {
      this.ui.objective.textContent = `NEUTRALIZZA I DRONI · ${objective}`;
      this.ui.missionFill.style.width = `${state.waveTargets ? state.waveKills / state.waveTargets * 100 : 0}%`;
      last.objective = objective;
    }
    if (last.wave !== state.wave) {
      this.ui.waveLabel.textContent = `ONDATA ${String(state.wave).padStart(2, '0')}`;
      last.wave = state.wave;
    }
    const critical = state.health < 35;
    if (last.critical !== critical) {
      document.getElementById('game-hud').classList.toggle('critical', critical);
      last.critical = critical;
    }
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

  mountSettings(overlay, { qualityMode, mix, sensitivity = 1, onQuality, onMix, onSensitivity = () => {}, onReset = () => {} }) {
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
      <label><span>AMBIENTE</span><input data-mix="ambience" type="range" min="0" max="1" step="0.01" value="${mix.ambience}"></label>
      <label><span>SENSIBILITÀ</span><input data-sensitivity type="range" min="0.25" max="3" step="0.05" value="${sensitivity}"></label>
      <button type="button" class="reset-level" data-reset-level>RESET LIVELLO</button>`;
    panel.addEventListener('click', event => event.stopPropagation());
    panel.addEventListener('pointerdown', event => event.stopPropagation());
    const setSelected = mode => panel.querySelectorAll('[data-quality]').forEach(button => button.classList.toggle('selected', button.dataset.quality === mode));
    setSelected(qualityMode);
    panel.querySelectorAll('[data-quality]').forEach(button => button.addEventListener('click', () => {
      // La selezione viene riallineata da onQuality() dopo l'applicazione reale
      // (che può essere ignorata, es. durante la transizione ULTRA): così la UI
      // riflette sempre lo stato effettivo del GraphicsManager.
      onQuality(button.dataset.quality);
    }));
    panel.querySelectorAll('[data-mix]').forEach(input => input.addEventListener('input', () => {
      onMix({ [input.dataset.mix]: Number(input.value) });
    }));
    panel.querySelector('[data-sensitivity]')?.addEventListener('input', event => {
      onSensitivity(Number(event.target.value));
    });
    panel.querySelector('[data-reset-level]')?.addEventListener('click', onReset);
    overlay.appendChild(panel);
    // Espone un setter per riallineare la selezione visiva allo stato reale del
    // GraphicsManager (usato da index.html dopo setMode, vedi B7).
    panel.syncMode = setSelected;
    return panel;
  }
}
