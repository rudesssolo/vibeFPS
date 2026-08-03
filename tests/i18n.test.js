import test from 'node:test';
import assert from 'node:assert/strict';

// i18n.js legge localStorage in modo lazy (al primo t()/getLanguage()): i test
// stubbiano lo storage prima di toccare il modulo. L'ordine dei test conta:
// lo stato del modulo è condiviso nel processo.
import { t, getLanguage, setLanguage, STRINGS } from '../src/i18n.js';
import { getStoredLanguage } from '../src/config.js';

function withStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  const storage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear()
  };
  const original = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  return () => { Object.defineProperty(globalThis, 'localStorage', { value: original, configurable: true }); };
}

test('language defaults to English with empty storage (L1)', () => {
  const restore = withStorage({});
  try {
    assert.equal(getLanguage(), 'en');
    assert.equal(t('overlay.cta.start'), 'INITIALIZE SIMULATION');
    assert.equal(t('mission.objective'), 'NEUTRALIZE THE DRONES');
  } finally { restore(); }
});

test('t() interpolates variables', () => {
  const restore = withStorage({});
  try {
    assert.equal(t('hud.wave', { wave: '03' }), 'WAVE 03');
    assert.equal(t('toast.scanner', { count: 7 }), '7 HOSTILE SIGNATURES ACQUIRED');
  } finally { restore(); }
});

test('unknown keys fall back to the key itself', () => {
  const restore = withStorage({});
  try {
    assert.equal(t('does.not.exist'), 'does.not.exist');
  } finally { restore(); }
});

test('setLanguage switches to Italian and persists (L1)', () => {
  const restore = withStorage({});
  try {
    setLanguage('it');
    assert.equal(getLanguage(), 'it');
    assert.equal(t('overlay.cta.start'), 'INIZIALIZZA SIMULAZIONE');
    assert.equal(t('hud.wave', { wave: '01' }), 'ONDATA 01');
    assert.equal(getStoredLanguage(), 'it');
  } finally { restore(); }
});

test('unknown language codes fall back to English', () => {
  const restore = withStorage({});
  try {
    setLanguage('fr');
    assert.equal(getLanguage(), 'en');
    setLanguage('it');
    assert.equal(getLanguage(), 'it');
  } finally { restore(); }
});

test('en/it dictionaries expose identical key sets (no missing translations)', () => {
  const enKeys = Object.keys(STRINGS.en).sort();
  const itKeys = Object.keys(STRINGS.it).sort();
  assert.deepEqual(itKeys, enKeys);
});
