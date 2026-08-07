import test from 'node:test';
import assert from 'node:assert/strict';
import { GraphicsManager } from '../src/graphics-manager.js';
import { QUALITY_PROFILES } from '../src/config.js';

function withFakeTimers() {
  const rafQueue = [];
  const timeoutQueue = [];
  const originalRAF = globalThis.requestAnimationFrame;
  const originalTimeout = globalThis.setTimeout;
  globalThis.requestAnimationFrame = (cb) => { rafQueue.push(cb); return rafQueue.length; };
  globalThis.setTimeout = (cb, ms) => { timeoutQueue.push({ cb, ms }); return timeoutQueue.length; };
  return {
    flushRAF() { while (rafQueue.length) rafQueue.shift()(); },
    flushTimeouts() { while (timeoutQueue.length) timeoutQueue.shift().cb(); },
    restore() {
      globalThis.requestAnimationFrame = originalRAF;
      globalThis.setTimeout = originalTimeout;
    }
  };
}

function withAutoMode() {
  const original = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', { value: {
    getItem: () => null, setItem: () => {}, removeItem: () => {}
  }, configurable: true });
  return () => { Object.defineProperty(globalThis, 'localStorage', { value: original, configurable: true }); };
}

function makeManager() {
  const applied = [];
  const statuses = [];
  const transitions = [];
  const manager = new GraphicsManager({
    applyProfile: (profile, info) => applied.push({ name: profile.name, info }),
    onStatus: (name, mode) => statuses.push([name, mode]),
    onTransition: (state) => transitions.push(state)
  });
  return { manager, applied, statuses, transitions };
}

test('ULTRA esegue la transizione e spegne il watchdog degli FPS', () => {
  {
    const restore = withAutoMode();
    const timers = withFakeTimers();
    try {
      const { manager, transitions } = makeManager();
      manager.init();
      manager.setMode('ultra');
      assert.equal(manager.transitioning, true);
      timers.flushRAF();
      assert.equal(manager.mode, 'ultra');
      assert.equal(manager.profile, QUALITY_PROFILES.ultra);
      timers.flushTimeouts();
      assert.equal(manager.transitioning, false);
      assert.ok(transitions.some(t => t.active === false));
    } finally { timers.restore(); restore(); }
  }

  {
    const restore = withAutoMode();
    const timers = withFakeTimers();
    try {
      const { manager } = makeManager();
      manager.updateFPS(10, 0.5); // prima di init: autoHigh, conta
      assert.ok(manager.lowWindows > 0);
      manager.setMode('ultra');
      timers.flushRAF();
      timers.flushTimeouts();
      assert.equal(manager.mode, 'ultra');
      const lowBefore = manager.lowWindows;
      manager.updateFPS(10, 0.5);
      assert.equal(manager.lowWindows, lowBefore);
    } finally { timers.restore(); restore(); }
  }
});

test('il tier automatico scende dopo 6 finestre lente, rispetta il cooldown e risale dopo 20 veloci', () => {
  const restore = withAutoMode();
  try {
    const { manager, applied } = makeManager();
    manager.init();
    assert.equal(manager.profile, QUALITY_PROFILES.autoHigh, 'init deve applicare il profilo corrente');
    assert.equal(applied.length, 1);
    assert.equal(applied[0].info.initial, true);

    // 6 finestre a FPS basso, una per frame da 0.5s (nessun cooldown residuo).
    for (let i = 0; i < 6; i++) manager.updateFPS(40, 0.5);
    assert.equal(manager.autoTier, 'autoLow');
    assert.equal(manager.profile, QUALITY_PROFILES.autoLow);
    assert.equal(manager.cooldown, 30);
    // Durante il cooldown non si risale, anche con FPS alti.
    for (let i = 0; i < 20; i++) manager.updateFPS(60, 0.5);
    assert.equal(manager.autoTier, 'autoLow');
    // Scaduto il cooldown, 20 finestre veloci riportano su.
    manager.cooldown = 0;
    for (let i = 0; i < 20; i++) manager.updateFPS(60, 0.5);
    assert.equal(manager.autoTier, 'autoHigh');
  } finally { restore(); }
});
