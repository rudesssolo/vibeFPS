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

test('la lingua si sceglie, si persiste, interpola e non perde chiavi (L1)', () => {
  {
    let restore = withStorage({});
    try {
      assert.equal(getLanguage(), 'en');
      assert.equal(t('overlay.cta.start'), 'INITIALIZE SIMULATION');
      assert.equal(t('mission.objective'), 'NEUTRALIZE HOSTILES');
      setLanguage('it');
      assert.equal(getLanguage(), 'it');
      assert.equal(getStoredLanguage(), 'it', 'la scelta non è stata persistita');
      assert.equal(t('mission.objective'), 'NEUTRALIZZA GLI OSTILI');
      setLanguage('xx');
      assert.equal(getLanguage(), 'en', 'un codice ignoto deve tornare all\'inglese');
    } finally { restore(); }
  }

  {
    const restore = withStorage({});
    try {
      setLanguage('en');
      assert.equal(t('hud.wave', { wave: '03' }), 'WAVE 03');
      assert.equal(t('toast.scanner', { count: 7 }), '7 HOSTILE SIGNATURES ACQUIRED');
      assert.equal(t('does.not.exist'), 'does.not.exist');
    } finally { restore(); }
  }

  {
    assert.deepEqual(Object.keys(STRINGS.en).sort(), Object.keys(STRINGS.it).sort());
    const restore = withStorage({});
    try {
      for (const language of ['en', 'it']) {
        setLanguage(language);
        for (const key of ['apex.vanguard', 'apex.wraith', 'apex.vex', 'apex.sentinel', 'apex.overlord']) {
          assert.notEqual(t(key), key, `${language}: ${key} non risolve`);
        }
      }
    } finally { restore(); }
  }
});
