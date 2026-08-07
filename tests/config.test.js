import test from 'node:test';
import assert from 'node:assert/strict';
import { getStoredMix, storeMix, getStoredQualityMode, storeQualityMode, getStoredMuted, storeMuted, getApexArchetype, getApexStats, getApexStatsFor, getMegaBossStats, getBossEncounter, APEX_ROSTER, APEX_TUNING, ENDGAME_TUNING, RAILGUN_TUNING, QUALITY_PROFILES } from '../src/config.js';

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

test('le preferenze persistite e il tuning della railgun', () => {
  {
    const DEFAULTS = { music: 0.82, sfx: 0.95, ambience: 0.1 };
    let restore = withStorage({});
    try {
      assert.deepEqual(getStoredMix(), DEFAULTS, 'storage vuoto');
      // L'ambiente è un fruscio continuo: al primo avvio parte quasi spento.
      assert.ok(getStoredMix().ambience <= 0.15, 'il default dell\'ambiente è tornato alto');
      storeMix({ music: 0.3, sfx: 0.4, ambience: 0.2 });
      assert.deepEqual(getStoredMix(), { music: 0.3, sfx: 0.4, ambience: 0.2 }, 'round-trip');
      storeQualityMode('ultra');
      assert.equal(getStoredQualityMode(), 'ultra');
      storeQualityMode('bogus');
      assert.equal(getStoredQualityMode(), 'auto', 'un valore ignoto torna ad auto');
      assert.equal(getStoredMuted(), false);
      storeMuted(true);
      assert.equal(getStoredMuted(), true);
      storeMuted(false);
      assert.equal(getStoredMuted(), false);
    } finally { restore(); }

    restore = withStorage({ 'vibefps.mix.music': '0.5', 'vibefps.mix.sfx': '7', 'vibefps.mix.ambience': 'abc' });
    try {
      assert.deepEqual(getStoredMix(), { music: 0.5, sfx: 1, ambience: 0.1 }, 'fuori range e non numerici');
    } finally { restore(); }

    // Storage bloccato (modalità privata, cookie di terze parti): niente eccezioni
    // in boot, si cade sui default. È la regressione B1 — gioco muto al primo avvio.
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', { get() { throw new Error('blocked'); }, configurable: true });
    try {
      assert.deepEqual(getStoredMix(), DEFAULTS);
      assert.equal(getStoredMuted(), false);
      storeMuted(true); // non deve lanciare
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { value: original, configurable: true });
    }
  }

  {
    assert.equal(RAILGUN_TUNING.magazineSize, 1);
    assert.ok(RAILGUN_TUNING.damage > 100 + 1 * 12);
    assert.ok(RAILGUN_TUNING.range >= 40);
    assert.ok(RAILGUN_TUNING.cooldown > 0);
  }
});

test('il roster Apex cicla, scala col tier e culmina nel gauntlet', () => {
  {
    assert.equal(APEX_ROSTER.length, 4);
    assert.deepEqual(APEX_ROSTER.map(a => a.id), ['vanguard', 'wraith', 'vex', 'sentinel']);
    for (const archetype of APEX_ROSTER) {
      assert.ok(archetype.baseHp > 0);
      assert.ok(archetype.baseSpeed > 0);
      assert.ok(archetype.color !== undefined);
    }

    const w1 = getApexArchetype(1);
    assert.equal(w1.archetype.id, 'vanguard');
    assert.equal(w1.tier, 1);
    assert.equal(getApexArchetype(2).archetype.id, 'wraith');
    const w4 = getApexArchetype(4);
    assert.equal(w4.archetype.id, 'sentinel');
    assert.equal(w4.tier, 1);
    // Secondo e terzo ciclo: stesso archetipo, tier crescente.
    const w5 = getApexArchetype(5);
    assert.equal(w5.archetype.id, 'vanguard');
    assert.equal(w5.tier, 2);
    assert.equal(getApexArchetype(9).tier, 3);

    for (const bad of [NaN, 0, -3]) assert.equal(getApexArchetype(bad).tier, 1, `wave ${bad}`);
    assert.equal(getApexArchetype('x').archetype.id, 'vanguard');

    // Le statistiche scalano col tier, il nome no.
    const t1 = getApexStats(1);
    const t2 = getApexStats(5);
    assert.equal(t2.maxHealth, Math.round(t1.maxHealth * Math.pow(APEX_TUNING.tierMultiplier, 1)));
    assert.ok(t2.speed > t1.speed);
    assert.ok(t2.damage > t1.damage);
    assert.equal(t2.tier, 2);
    assert.equal(t2.nameKey, t1.nameKey);
  }

  {
    assert.deepEqual(getBossEncounter(8), { kind: 'standard', bossCount: 1, final: false });
    assert.deepEqual(getBossEncounter(9), { kind: 'gauntlet', bossCount: 4, final: false });
    assert.deepEqual(getBossEncounter(10), { kind: 'final', bossCount: 1, final: true });
    assert.deepEqual(getBossEncounter(99), { kind: 'final', bossCount: 1, final: true });

    const gauntlet = APEX_ROSTER.map(archetype => getApexStatsFor(archetype, ENDGAME_TUNING.gauntletTier));
    assert.deepEqual(gauntlet.map(stats => stats.archetype.id), ['vanguard', 'wraith', 'vex', 'sentinel']);
    assert.ok(gauntlet.every(stats => stats.tier === 3 && stats.maxHealth > 0));
    const mega = getMegaBossStats();
    assert.equal(mega.archetype.id, 'overlord');
    assert.equal(mega.visualScale, 3);
    assert.ok(mega.maxHealth > Math.max(...gauntlet.map(stats => stats.maxHealth)) * 2);
  }
});

test('ogni profilo qualità espone tutti i parametri consumati dai sistemi', () => {
  // ExplosionSystem.explode() ricava il numero di puff di fumo da smokePuffs:
  // se un profilo lo omettesse, il fumo delle esplosioni spariva in silenzio.
  const required = [
    'name', 'pixelRatio', 'shadowSize', 'reflectorHeight', 'reflectorInterval', 'anisotropy',
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
  // reflectorInterval < 1 congelerebbe la reflection del pavimento; il profilo
  // più economico non può aggiornarla più spesso di quello alto.
  for (const key of keys) assert.ok(QUALITY_PROFILES[key].reflectorInterval >= 1, `${key}.reflectorInterval < 1`);
  assert.ok(QUALITY_PROFILES.autoLow.reflectorInterval >= QUALITY_PROFILES.autoHigh.reflectorInterval);
  // L'anisotropia è un tetto passato a Math.min con getMaxAnisotropy(): deve
  // restare >= 1 e crescere con la qualità, altrimenti ultra campionerebbe
  // peggio di autoHigh.
  for (const key of keys) assert.ok(QUALITY_PROFILES[key].anisotropy >= 1, `${key}.anisotropy < 1`);
  // reflectorHeight è l'altezza in pixel della render target del riflesso e
  // deve crescere con la qualità: ancorarla al lato lungo faceva collassare
  // la risoluzione verticale sugli schermi larghi (3440×1440 → 214px).
  assert.ok(QUALITY_PROFILES.autoLow.reflectorHeight < QUALITY_PROFILES.autoHigh.reflectorHeight);
  assert.ok(QUALITY_PROFILES.autoHigh.reflectorHeight < QUALITY_PROFILES.ultra.reflectorHeight);
  assert.ok(QUALITY_PROFILES.autoLow.anisotropy <= QUALITY_PROFILES.autoHigh.anisotropy);
  assert.ok(QUALITY_PROFILES.autoHigh.anisotropy <= QUALITY_PROFILES.ultra.anisotropy);

  // --- budget cinematici: completi e crescenti da Balanced a Ultra ---
  const ordered = [QUALITY_PROFILES.autoLow, QUALITY_PROFILES.autoHigh, QUALITY_PROFILES.ultra];
  for (const profile of ordered) {
    for (const group of ['atmosphere', 'city', 'post', 'combat']) {
      assert.ok(profile[group] && Object.isFrozen(profile[group]), `${profile.name}.${group} non è un contratto frozen`);
    }
    for (const value of [
      ...Object.values(profile.atmosphere),
      ...Object.values(profile.city),
      ...Object.values(profile.post),
      ...Object.values(profile.combat)
    ]) assert.ok(Number.isFinite(value));
  }
  const cost = profile => profile.atmosphere.rainStreaks
    + profile.atmosphere.fogBanks * 100
    + profile.city.aerialTraffic * 10
    + profile.combat.impactDecals * 5
    + profile.post.distortionSlots * 100;
  assert.ok(cost(ordered[0]) < cost(ordered[1]));
  assert.ok(cost(ordered[1]) < cost(ordered[2]));
  assert.equal(QUALITY_PROFILES.autoLow.post.flare, 0);
  assert.equal(QUALITY_PROFILES.autoLow.post.heatHaze, 0);
});

// --- Apex Sentinel: roster a ciclo + tier scaling ---
