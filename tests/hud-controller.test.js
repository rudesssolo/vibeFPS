import test from 'node:test';
import assert from 'node:assert/strict';

// HudController dipende solo dal DOM (niente three.js): qui il DOM è uno stub
// minimale sufficiente per costruttore e toast().
import { HudController } from '../src/hud-controller.js';

function makeElement() {
  const el = {
    parent: null,
    children: [],
    style: {},
    dataset: {},
    className: '',
    textContent: '',
    innerHTML: '',
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      toggle(c, force) {
        if (force === undefined) force = !this._set.has(c);
        if (force) this._set.add(c); else this._set.delete(c);
        return force;
      },
      contains(c) { return this._set.has(c); }
    },
    appendChild(child) { el.children.push(child); child.parent = el; return child; },
    prepend(child) { el.children.unshift(child); child.parent = el; return child; },
    remove() {
      if (!el.parent) return;
      const index = el.parent.children.indexOf(el);
      if (index >= 0) el.parent.children.splice(index, 1);
      el.parent = null;
    },
    querySelector() { return makeElement(); }
  };
  Object.defineProperty(el, 'lastElementChild', {
    get: () => el.children[el.children.length - 1] || null
  });
  return el;
}

function withFakeDom(fn) {
  const originalDocument = globalThis.document;
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.document = {
    getElementById: () => makeElement(),
    createElement: () => makeElement()
  };
  // I timer di auto-rimozione dei toast restano inerti: il test controlla solo
  // la logica di accodamento, non la scadenza temporale.
  globalThis.setTimeout = () => 0;
  try {
    fn();
  } finally {
    globalThis.document = originalDocument;
    globalThis.setTimeout = originalSetTimeout;
  }
}

test('toast stack is capped and keeps the most recent messages (N6)', () => {
  withFakeDom(() => {
    const hud = new HudController();
    for (let i = 1; i <= 8; i++) hud.toast(`msg-${i}`);
    const toasts = hud.ui.toasts.children;
    assert.equal(toasts.length, 5);
    // prepend → il più recente è in testa, il più vecchio è stato espulso.
    assert.equal(toasts[0].innerHTML, 'msg-8');
    assert.equal(toasts[4].innerHTML, 'msg-4');
  });
});

test('toast stack never exceeds the cap even in bursts (N6)', () => {
  withFakeDom(() => {
    const hud = new HudController();
    for (let i = 0; i < 40; i++) hud.toast(`<b>UNITÀ</b> · ${i}`);
    assert.equal(hud.ui.toasts.children.length, 5);
  });
});

test('renderBoss toggles the bar only while an apex is alive', () => {
  withFakeDom(() => {
    const hud = new HudController();
    const apex = { alive: true, nameKey: 'apex.vanguard', tier: 2, health: 250, maxHealth: 500 };
    hud.renderBoss(apex);
    assert.equal(hud.ui.bossBar.classList.contains('show'), true);
    assert.equal(hud.ui.bossName.textContent, 'VANGUARD');
    assert.equal(hud.ui.bossState.textContent, 'T-2');
    assert.equal(hud.ui.bossFill.style.width, '50%');
    // Ucciso → la barra sparisce.
    hud.renderBoss({ alive: false, nameKey: 'apex.vanguard', tier: 2, health: 0, maxHealth: 500 });
    assert.equal(hud.ui.bossBar.classList.contains('show'), false);
    assert.equal(hud.renderBoss(null), undefined);
  });
});

test('render draws one heart per remaining life and dims consumed ones', () => {
  withFakeDom(() => {
    const hud = new HudController();
    const base = {
      health: 100, shield: 75, stamina: 100,
      weapon: 'pulse', ammo: 30, reserve: 180,
      railgunAmmo: 0, railgunReserve: 0,
      score: 0, combo: 1, shots: 0, hits: 0,
      waveKills: 0, waveTargets: 5, wave: 1
    };
    hud.render({ ...base, lives: 3, maxLives: 3 });
    assert.equal(hud.ui.livesValue.textContent, '3');
    assert.equal(hud.ui.livesHearts.children.length, 3);
    assert.equal(hud.ui.livesHearts.children[0].classList.contains('full'), true);
    assert.equal(hud.ui.livesHearts.children[2].classList.contains('full'), true);
    // Una vita persa → contatore e cuori si allineano.
    hud.render({ ...base, lives: 1, maxLives: 3 });
    assert.equal(hud.ui.livesValue.textContent, '1');
    assert.equal(hud.ui.livesHearts.children[0].classList.contains('full'), true);
    assert.equal(hud.ui.livesHearts.children[1].classList.contains('full'), false);
    assert.equal(hud.ui.livesHearts.children[2].classList.contains('full'), false);
  });
});

// Conta le scritture reali su style.width / textContent di una barra vitale.
function spyBar(hud, fillKey, valueKey) {
  const counts = { width: 0, text: 0 };
  const fill = hud.ui[fillKey];
  const value = hud.ui[valueKey];
  let width = '';
  let text = '';
  Object.defineProperty(fill, 'style', {
    value: { set width(v) { counts.width++; width = v; }, get width() { return width; } }
  });
  Object.defineProperty(value, 'textContent', {
    set(v) { counts.text++; text = v; },
    get() { return text; }
  });
  return counts;
}

const vitalsBase = {
  health: 100, shield: 75, stamina: 100,
  weapon: 'pulse', ammo: 30, reserve: 180,
  railgunAmmo: 0, railgunReserve: 0,
  score: 0, combo: 1, shots: 0, hits: 0,
  waveKills: 0, waveTargets: 5, wave: 1, lives: 3, maxLives: 3
};

test('la rigenerazione della stamina non riscrive il DOM a ogni frame', () => {
  withFakeDom(() => {
    const hud = new HudController();
    const counts = spyBar(hud, 'staminaFill', 'staminaValue');
    // 19 punti/s a 60 FPS = ~.317 per frame: il valore grezzo cambia sempre,
    // ma il testo intero cambia ogni ~3 frame e la barra ogni ~2.
    let stamina = 40;
    for (let frame = 0; frame < 60; frame++) {
      hud.render({ ...vitalsBase, stamina });
      stamina = Math.min(100, stamina + 19 / 60);
    }
    assert.ok(counts.width < 40, `scritture width: ${counts.width}`);
    assert.ok(counts.text < 40, `scritture testo: ${counts.text}`);
    // ...ma la barra deve comunque avanzare fino al valore corrente.
    assert.equal(hud.ui.staminaValue.textContent, '059');
  });
});

test('un valore fermo non produce nessuna scrittura dopo la prima', () => {
  withFakeDom(() => {
    const hud = new HudController();
    const counts = spyBar(hud, 'healthFill', 'healthValue');
    for (let i = 0; i < 10; i++) hud.render({ ...vitalsBase, health: 73 });
    assert.equal(counts.width, 1);
    assert.equal(counts.text, 1);
  });
});

test('le barre restano corrette ai limiti e con maxShield custom', () => {
  withFakeDom(() => {
    const hud = new HudController();
    hud.render({ ...vitalsBase, health: 0, shield: 0, stamina: 0 });
    assert.equal(hud.ui.healthFill.style.width, '0%');
    assert.equal(hud.ui.healthValue.textContent, '000');
    hud.render({ ...vitalsBase, health: 100, shield: 75, stamina: 100 });
    assert.equal(hud.ui.healthFill.style.width, '100%');
    assert.equal(hud.ui.healthValue.textContent, '100');
    // maxShield 75 → 37.5 punti sono il 50% della barra.
    hud.render({ ...vitalsBase, shield: 37.5 });
    assert.equal(hud.ui.shieldFill.style.width, '50%');
    assert.equal(hud.ui.shieldValue.textContent, '038');
  });
});

test('invalidateCache forza la riscrittura delle barre', () => {
  withFakeDom(() => {
    const hud = new HudController();
    const counts = spyBar(hud, 'healthFill', 'healthValue');
    hud.render({ ...vitalsBase, health: 50 });
    hud.render({ ...vitalsBase, health: 50 });
    assert.equal(counts.width, 1);
    hud.invalidateCache();
    hud.render({ ...vitalsBase, health: 50 });
    assert.equal(counts.width, 2);
  });
});

test('mission bar clamps at 100% when waveKills exceeds waveTargets (S5)', () => {
  withFakeDom(() => {
    const hud = new HudController();
    const base = {
      health: 100, shield: 75, stamina: 100,
      weapon: 'pulse', ammo: 30, reserve: 180,
      railgunAmmo: 0, railgunReserve: 0,
      score: 0, combo: 1, shots: 0, hits: 0,
      waveKills: 0, waveTargets: 5, wave: 1
    };
    // L'eliminazione dell'Apex conta in waveKills e può superare il target
    // (es. 6/5): la barra non deve superare il 100%.
    hud.render({ ...base, waveKills: 6, waveTargets: 5 });
    assert.equal(hud.ui.missionFill.style.width, '100%');
    assert.equal(hud.ui.objective.textContent.includes('6/5'), true);
  });
});
