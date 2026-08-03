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
    // Dirty-check: il DOM viene toccato solo quando un valore cambia davvero,
    // evitando ~20 scritture ridondanti per frame nel loop di gioco.
    const last = this.last;

    if (last.health !== health) {
      this.ui.healthFill.style.width = `${health}%`;
      this.ui.healthValue.textContent = String(Math.ceil(health)).padStart(3, '0');
      last.health = health;
    }
    if (last.shield !== shield) {
      this.ui.shieldFill.style.width = `${shield / 75 * 100}%`;
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

  mountSettings(overlay, { qualityMode, mix, onQuality, onMix, onReset = () => {} }) {
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
      <button type="button" class="reset-level" data-reset-level>RESET LIVELLO</button>`;
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
    panel.querySelector('[data-reset-level]')?.addEventListener('click', onReset);
    overlay.appendChild(panel);
    return panel;
  }
}
