import { t } from './i18n.js';

// Granularità della larghezza delle barre vitali, in punti percentuali.
// Scudo e stamina si rigenerano di frazioni di punto per frame (~.2 e ~.32 a
// 60 FPS), quindi un dirty-check sul valore grezzo non filtra nulla: la barra
// veniva riscritta a ogni frame per una differenza sotto il pixel. A .5 il
// passo vale ~1 px su una barra da 200 px, cioè sotto la soglia visibile,
// e dimezza le scritture durante la rigenerazione.
const BAR_STEP_PERCENT = .5;

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
      weaponName: document.getElementById('weapon-name'),
      reload: document.getElementById('reload-message'),
      score: document.getElementById('score'),
      combo: document.getElementById('combo'),
      accuracy: document.getElementById('accuracy'),
      fps: document.getElementById('fps'),
      objective: document.getElementById('objective-text'),
      missionFill: document.getElementById('mission-progress-fill'),
      waveLabel: document.getElementById('wave-label'),
      toasts: document.getElementById('toast-stack'),
      sound: document.getElementById('sound-state'),
      overlaySound: document.getElementById('overlay-sound-state'),
      bossBar: document.getElementById('boss-bar'),
      bossName: document.getElementById('boss-name'),
      bossFill: document.getElementById('boss-fill'),
      bossHp: document.getElementById('boss-hp'),
      bossState: document.getElementById('boss-state'),
      livesValue: document.getElementById('lives-value'),
      livesHearts: document.getElementById('lives-hearts')
    };
    if (!this.ui.ammoCells.children.length) {
      for (let i = 0; i < 15; i++) this.ui.ammoCells.appendChild(document.createElement('i'));
    }
    this.last = {};
    this.graphicsStatus = 'AUTO // HIGH';
    this.maxShield = 75; // valore massimo scudo (M2); allineato in index.html con CONFIG.maxShield
    this.maxLives = 3;   // vite massime; allineato in index.html con CONFIG.maxLives
    this.onboardingTimer = null;
  }

  render(state) {
    const health = Math.max(0, state.health);
    const shield = Math.max(0, state.shield);
    const stamina = Math.max(0, state.stamina);
    // Dirty-check: il DOM viene toccato solo quando un valore cambia davvero,
    // evitando ~20 scritture ridondanti per frame nel loop di gioco.
    const last = this.last;

    const maxShield = this.maxShield > 0 ? this.maxShield : 75;
    this._renderVitalBar(this.ui.healthFill, this.ui.healthValue, health, health, 'healthWidth', 'healthShown');
    this._renderVitalBar(this.ui.shieldFill, this.ui.shieldValue, shield, shield / maxShield * 100, 'shieldWidth', 'shieldShown');
    this._renderVitalBar(this.ui.staminaFill, this.ui.staminaValue, stamina, stamina, 'staminaWidth', 'staminaShown');
    // Vite: contatore + cuori. A vite piene si può perdere comunque la carry
    // (dirty-check) ma i cuori restano 3 accesi; il pickup è gestito in gioco.
    const lives = Math.max(0, Math.floor(state.lives ?? this.maxLives));
    const maxLives = Math.max(1, Math.floor(state.maxLives ?? this.maxLives));
    if (last.lives !== lives || last.livesMax !== maxLives) {
      while (this.ui.livesHearts.children.length < maxLives) {
        const heart = document.createElement('span');
        heart.className = 'life-heart';
        heart.textContent = '♥';
        this.ui.livesHearts.appendChild(heart);
      }
      while (this.ui.livesHearts.children.length > maxLives) {
        this.ui.livesHearts.lastElementChild.remove();
      }
      const hearts = this.ui.livesHearts.children;
      for (let i = 0; i < hearts.length; i++) hearts[i].classList.toggle('full', i < lives);
      this.ui.livesValue.textContent = String(lives);
      last.lives = lives;
      last.livesMax = maxLives;
    }
    // --- Arma corrente (uniforme per tutte le armi: ammo/riserva/nome/capienza
    // vengono passati da index.html via _ammo/_reserve/_weaponName/_magazineSize).
    const ammo = state._ammo ?? state.ammo ?? 0;
    const reserve = state._reserve ?? state.reserve ?? 0;
    const weaponName = state._weaponName ?? t('weapon.pulse');
    const magSize = state._magazineSize ?? 30;
    if (last.weaponName !== weaponName) {
      this.ui.weaponName.textContent = weaponName;
      last.weaponName = weaponName;
    }
    if (last.ammo !== ammo || last.magSize !== magSize) {
      this.ui.ammo.textContent = String(ammo).padStart(magSize <= 1 ? 1 : (magSize >= 100 ? 3 : 2), '0');
      const cells = this.ui.ammoCells.children;
      // Per armi a colpo singolo (railgun, magSize 1) mostra solo il primo cell:
      // la cella 0 è piena SOLO se c'è ancora una munizione (T5).
      if (magSize <= 1) {
        const hasShot = ammo > 0;
        for (let i = 0; i < cells.length; i++) cells[i].classList.toggle('empty', i >= 1 || !hasShot);
      } else {
        const perCell = magSize / cells.length;
        for (let i = 0; i < cells.length; i++) cells[i].classList.toggle('empty', i * perCell >= ammo);
      }
      last.ammo = ammo;
      last.magSize = magSize;
    }
    if (last.reserve !== reserve) {
      this.ui.reserve.textContent = String(reserve).padStart(3, '0');
      last.reserve = reserve;
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
      this.ui.objective.textContent = `${t('mission.objective')} · ${objective}`;
      // S5: clamp a 100% — l'eliminazione dell'Apex conta in waveKills e può
      // superare il target (es. 6/5) senza rompere la barra.
      this.ui.missionFill.style.width = `${state.waveTargets ? Math.min(100, state.waveKills / state.waveTargets * 100) : 0}%`;
      last.objective = objective;
    }
    if (last.wave !== state.wave) {
      this.ui.waveLabel.textContent = t('hud.wave', { wave: String(state.wave).padStart(2, '0') });
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
    this.ui.sound.innerHTML = t(muted ? 'sound.offHtml' : 'sound.onHtml');
    // Con il mute persistente (A5/N8) lo stato deve essere evidente anche
    // sull'overlay di start/pausa: altrimenti il gioco sembra "senza audio".
    if (this.ui.overlaySound) {
      this.ui.overlaySound.innerHTML = muted ? t('mute.badgeHtml') : '';
    }
  }

  // Dopo un cambio lingua i testi dinamici vanno riscritti anche se i valori
  // numerici non sono cambiati: si azzera la cache del dirty-check.
  /**
   * Scrive una barra vitale confrontando ciò che finisce davvero nel DOM, non
   * il valore in virgola mobile: il numero è l'intero mostrato (confronto
   * esatto, nessuna differenza visiva) e la larghezza è quantizzata a
   * BAR_STEP_PERCENT. Lo stato vive in `this.last`, quindi invalidateCache()
   * lo azzera insieme al resto.
   */
  _renderVitalBar(fillElement, valueElement, value, percent, widthKey, shownKey) {
    const last = this.last;
    const clamped = Math.max(0, Math.min(100, percent));
    const width = Math.round(clamped / BAR_STEP_PERCENT) * BAR_STEP_PERCENT;
    if (last[widthKey] !== width) {
      fillElement.style.width = `${width}%`;
      last[widthKey] = width;
    }
    // Math.ceil senza allocare la stringa nel caso comune (valore invariato).
    const shown = Math.ceil(value);
    if (last[shownKey] !== shown) {
      valueElement.textContent = String(shown).padStart(3, '0');
      last[shownKey] = shown;
    }
  }

  invalidateCache() {
    this.last = {};
  }

  // Barra del boss Apex: visibile solo quando un Apex è vivo, con dirty-check.
  renderBoss(apex) {
    const visible = !!apex && apex.alive;
    if (visible !== this.last.bossVisible) {
      this.ui.bossBar.classList.toggle('show', visible);
      this.last.bossVisible = visible;
    }
    if (!visible) return;
    const name = t(apex.nameKey);
    if (this.last.bossName !== name) {
      this.ui.bossName.textContent = name;
      this.last.bossName = name;
    }
    const state = apex.stateLabel || `T-${apex.tier}`;
    if (this.last.bossState !== state) {
      this.ui.bossState.textContent = state;
      this.last.bossState = state;
    }
    const pct = Math.max(0, Math.min(100, apex.health / apex.maxHealth * 100));
    if (this.last.bossPct !== pct) {
      this.ui.bossFill.style.width = `${pct}%`;
      this.last.bossPct = pct;
    }
    // Numerico: mostra la life effettiva (es. "840 / 1680") così il ×N dell'HP
    // dei boss è visibile, non solo la barra percentuale.
    const hp = `${Math.max(0, Math.round(apex.health))} / ${Math.round(apex.maxHealth)}`;
    if (this.last.bossHp !== hp) {
      this.ui.bossHp.textContent = hp;
      this.last.bossHp = hp;
    }
  }

  toast(message) {
    // N6: tetto ai toast visibili. In combattimento intenso (kill + heal +
    // rifornimento + bonus ondata) gli eventi si accumulerebbero coprendo il
    // lato destro dello schermo: oltre il limite il più vecchio cede subito.
    const MAX_TOASTS = 5;
    while (this.ui.toasts.children.length >= MAX_TOASTS) {
      this.ui.toasts.lastElementChild.remove();
    }
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

  mountSettings(overlay, { qualityMode, language = 'en', mix, sensitivity = 1, allowUltra = true, onQuality, onLanguage = () => {}, onMix, onSensitivity = () => {}, onReset = () => {} }) {
    const panel = document.createElement('div');
    panel.className = 'settings-panel';
    // Le label usano data-i18n: al cambio lingua (L1) applyStaticStrings() in
    // index.html le riscrive senza ricreare il pannello.
    panel.innerHTML = `
      <div class="settings-title" data-i18n="settings.title">${t('settings.title')}</div>
      <div class="panel-toggles">
        <div class="quality-toggle" role="group" aria-label="${t('settings.qualityAria')}">
          <button type="button" data-quality="auto">AUTO</button>
          <button type="button" data-quality="ultra" ${allowUltra ? '' : 'disabled title="Unavailable on this device"'}">ULTRA</button>
        </div>
        <div class="quality-toggle lang-toggle" role="group" aria-label="${t('settings.langAria')}">
          <button type="button" data-lang="it">IT</button>
          <button type="button" data-lang="en">EN</button>
        </div>
      </div>
      <label><span data-i18n="settings.music">${t('settings.music')}</span><input data-mix="music" type="range" min="0" max="1" step="0.01" value="${mix.music}"></label>
      <label><span data-i18n="settings.sfx">${t('settings.sfx')}</span><input data-mix="sfx" type="range" min="0" max="1" step="0.01" value="${mix.sfx}"></label>
      <label><span data-i18n="settings.ambience">${t('settings.ambience')}</span><input data-mix="ambience" type="range" min="0" max="1" step="0.01" value="${mix.ambience}"></label>
      <label><span data-i18n="settings.sensitivity">${t('settings.sensitivity')}</span><input data-sensitivity type="range" min="0.25" max="3" step="0.05" value="${sensitivity}"></label>
      <button type="button" class="reset-level" data-reset-level data-i18n="settings.reset">${t('settings.reset')}</button>`;
    panel.addEventListener('click', event => event.stopPropagation());
    panel.addEventListener('pointerdown', event => event.stopPropagation());
    const setSelected = mode => panel.querySelectorAll('[data-quality]').forEach(button => button.classList.toggle('selected', button.dataset.quality === mode));
    setSelected(qualityMode);
    const setLangSelected = lang => panel.querySelectorAll('[data-lang]').forEach(button => button.classList.toggle('selected', button.dataset.lang === lang));
    setLangSelected(language);
    panel.querySelectorAll('[data-quality]').forEach(button => button.addEventListener('click', () => {
      // La selezione viene riallineata da onQuality() dopo l'applicazione reale
      // (che può essere ignorata, es. durante la transizione ULTRA): così la UI
      // riflette sempre lo stato effettivo del GraphicsManager.
      onQuality(button.dataset.quality);
    }));
    panel.querySelectorAll('[data-lang]').forEach(button => button.addEventListener('click', () => {
      onLanguage(button.dataset.lang);
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
    // Riallinea selezione lingua e aria-label dopo un cambio lingua (L1).
    panel.syncLanguage = lang => {
      setLangSelected(lang);
      panel.querySelector('.quality-toggle').setAttribute('aria-label', t('settings.qualityAria'));
      panel.querySelector('.lang-toggle').setAttribute('aria-label', t('settings.langAria'));
    };
    return panel;
  }
}
