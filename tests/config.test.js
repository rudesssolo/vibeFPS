import test from 'node:test';
import assert from 'node:assert/strict';
import { getStoredMix, storeMix, getStoredQualityMode, storeQualityMode } from '../src/config.js';

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

test('getStoredMix returns defaults when storage is empty (B1 regression)', () => {
  const restore = withStorage({});
  try {
    assert.deepEqual(getStoredMix(), { music: 0.72, sfx: 0.9, ambience: 0.58 });
  } finally { restore(); }
});

test('getStoredMix reads persisted values and clamps out-of-range', () => {
  const restore = withStorage({ 'vibefps.mix.music': '0.5', 'vibefps.mix.sfx': '7', 'vibefps.mix.ambience': 'abc' });
  try {
    assert.deepEqual(getStoredMix(), { music: 0.5, sfx: 1, ambience: 0.58 });
  } finally { restore(); }
});

test('storeMix then getStoredMix round-trips', () => {
  const restore = withStorage({});
  try {
    storeMix({ music: 0.3, sfx: 0.4, ambience: 0.2 });
    assert.deepEqual(getStoredMix(), { music: 0.3, sfx: 0.4, ambience: 0.2 });
  } finally { restore(); }
});

test('getStoredMix falls back to defaults when localStorage access throws', () => {
  const original = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', { get() { throw new Error('blocked'); }, configurable: true });
  try {
    assert.deepEqual(getStoredMix(), { music: 0.72, sfx: 0.9, ambience: 0.58 });
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { value: original, configurable: true });
  }
});

test('quality mode defaults to auto and persists ultra', () => {
  assert.equal(getStoredQualityMode(), 'auto');
  const restore = withStorage({});
  try {
    storeQualityMode('ultra');
    assert.equal(getStoredQualityMode(), 'ultra');
    storeQualityMode('bogus');
    assert.equal(getStoredQualityMode(), 'auto');
  } finally { restore(); }
});