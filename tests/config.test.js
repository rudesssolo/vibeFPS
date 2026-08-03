import test from 'node:test';
import assert from 'node:assert/strict';
import { getStoredMix, storeMix, getStoredQualityMode, storeQualityMode, getStoredMuted, storeMuted, getApexArchetype, getApexStats, APEX_ROSTER, APEX_TUNING, RAILGUN_TUNING, QUALITY_PROFILES } from '../src/config.js';

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
    assert.deepEqual(getStoredMix(), { music: 0.82, sfx: 0.95, ambience: 0.66 });
  } finally { restore(); }
});

test('getStoredMix reads persisted values and clamps out-of-range', () => {
  const restore = withStorage({ 'vibefps.mix.music': '0.5', 'vibefps.mix.sfx': '7', 'vibefps.mix.ambience': 'abc' });
  try {
    assert.deepEqual(getStoredMix(), { music: 0.5, sfx: 1, ambience: 0.66 });
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
    assert.deepEqual(getStoredMix(), { music: 0.82, sfx: 0.95, ambience: 0.66 });
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { value: original, configurable: true });
  }
});

test('railgun tuning guarantees a single-shot standard-drone kill', () => {
  assert.equal(RAILGUN_TUNING.magazineSize, 1);
  assert.ok(RAILGUN_TUNING.damage > 100 + 1 * 12);
  assert.ok(RAILGUN_TUNING.range >= 40);
  assert.ok(RAILGUN_TUNING.cooldown > 0);
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

test('mute state defaults to false and round-trips (N8)', () => {
  const restore = withStorage({});
  try {
    assert.equal(getStoredMuted(), false);
    storeMuted(true);
    assert.equal(getStoredMuted(), true);
    storeMuted(false);
    assert.equal(getStoredMuted(), false);
  } finally { restore(); }
});

test('mute state survives a blocked storage (N8)', () => {
  const original = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', { get() { throw new Error('blocked'); }, configurable: true });
  try {
    assert.equal(getStoredMuted(), false);
    storeMuted(true); // non deve lanciare
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { value: original, configurable: true });
  }
});

// --- Profili qualità: contratto con i sistemi che li consumano ---

test('ogni profilo qualità espone tutti i parametri consumati dai sistemi', () => {
  // ExplosionSystem.explode() ricava il numero di puff di fumo da smokePuffs:
  // se un profilo lo omettesse, il fumo delle esplosioni spariva in silenzio.
  const required = [
    'name', 'pixelRatio', 'shadowSize', 'reflectorSize',
    'gtaoSamples', 'facadeResolution', 'particleScale', 'smokePuffs', 'dynamicLights'
  ];
  const keys = Object.keys(QUALITY_PROFILES);
  assert.deepEqual(keys, ['autoHigh', 'autoLow', 'ultra']);
  for (const key of keys) {
    const profile = QUALITY_PROFILES[key];
    for (const field of required) {
      assert.ok(field in profile, `${key}: manca '${field}'`);
    }
    assert.equal(typeof profile.name, 'string');
    for (const field of required.filter(f => f !== 'name')) {
      assert.ok(Number.isFinite(profile[field]), `${key}.${field} non è un numero finito`);
    }
    assert.ok(profile.smokePuffs > 0, `${key}: smokePuffs deve essere positivo`);
  }
  // Il costo del fumo deve crescere con il livello di qualità.
  assert.ok(QUALITY_PROFILES.autoLow.smokePuffs < QUALITY_PROFILES.autoHigh.smokePuffs);
  assert.ok(QUALITY_PROFILES.autoHigh.smokePuffs < QUALITY_PROFILES.ultra.smokePuffs);
});

// --- Apex Sentinel: roster a ciclo + tier scaling ---

test('apex roster exposes the 4 archetypes with unique ids', () => {
  assert.equal(APEX_ROSTER.length, 4);
  const ids = APEX_ROSTER.map(a => a.id);
  assert.deepEqual(ids, ['vanguard', 'wraith', 'vex', 'sentinel']);
  for (const archetype of APEX_ROSTER) {
    assert.ok(archetype.baseHp > 0);
    assert.ok(archetype.baseSpeed > 0);
    assert.ok(archetype.color !== undefined);
  }
});

test('getApexArchetype cycles the roster every 4 waves and raises the tier', () => {
  const w1 = getApexArchetype(1);
  assert.equal(w1.archetype.id, 'vanguard');
  assert.equal(w1.tier, 1);
  const w2 = getApexArchetype(2);
  assert.equal(w2.archetype.id, 'wraith');
  const w4 = getApexArchetype(4);
  assert.equal(w4.archetype.id, 'sentinel');
  assert.equal(w4.tier, 1);
  // Secondo ciclo: stesso archetipo, tier 2.
  const w5 = getApexArchetype(5);
  assert.equal(w5.archetype.id, 'vanguard');
  assert.equal(w5.tier, 2);
  const w9 = getApexArchetype(9);
  assert.equal(w9.archetype.id, 'vanguard');
  assert.equal(w9.tier, 3);
});

test('getApexArchetype is resilient to invalid input', () => {
  assert.equal(getApexArchetype(NaN).tier, 1);
  assert.equal(getApexArchetype(0).tier, 1);
  assert.equal(getApexArchetype(-3).tier, 1);
  assert.equal(getApexArchetype('x').archetype.id, 'vanguard');
});

test('getApexStats scales health, speed and damage with the tier', () => {
  const t1 = getApexStats(1);
  const t2 = getApexStats(5);
  const multiplier = Math.pow(APEX_TUNING.tierMultiplier, 1);
  assert.equal(t2.maxHealth, Math.round(t1.maxHealth * multiplier));
  assert.ok(t2.speed > t1.speed);
  assert.ok(t2.damage > t1.damage);
  assert.equal(t2.tier, 2);
  assert.equal(t2.nameKey, t1.nameKey);
});
