export const QUALITY_PROFILES = Object.freeze({
  autoHigh: Object.freeze({
    name: 'AUTO // HIGH',
    pixelRatio: 1.35,
    shadowSize: 1024,
    reflectorSize: 640,
    gtaoSamples: 10,
    facadeResolution: 1024,
    particleScale: 0.72,
    // Puff di fumo volumetrico per esplosione. Il raymarch costa per pixel e i
    // puff si sovrappongono, quindi questo è il parametro che governa davvero
    // il costo del fumo (non particleScale).
    smokePuffs: 7,
    dynamicLights: 4
  }),
  autoLow: Object.freeze({
    name: 'AUTO // BALANCED',
    pixelRatio: 1,
    shadowSize: 512,
    reflectorSize: 320,
    gtaoSamples: 8,
    facadeResolution: 1024,
    particleScale: 0.48,
    smokePuffs: 3,
    dynamicLights: 3
  }),
  ultra: Object.freeze({
    name: 'ULTRA',
    pixelRatio: 2,
    shadowSize: 1024,
    reflectorSize: 1280,
    gtaoSamples: 16,
    facadeResolution: 2048,
    particleScale: 1,
    smokePuffs: 12,
    dynamicLights: 8
  })
});

export const DRONE_TUNING = Object.freeze({
  patrolSpeed: 3.8,
  engageSpeed: 5.3,
  evadeSpeed: 8.2,
  maxAcceleration: 12.5,
  separationRadius: 2.6,
  threatRadius: 2,
  minAltitude: 1.9,
  maxAltitude: 6.25,
  arenaLimit: 18,
  telegraphMin: 0.14,
  telegraphMax: 0.24,
  evadeDuration: 0.45,
  recoverDuration: 0.62,
  evadeCooldownMin: 1.2,
  evadeCooldownMax: 1.8
});

// Apex Sentinel — nemico speciale di fine ondata.
//
// Il roster cicla ogni 4 ondate; ogni ciclo completo alza il "tier" (moltiplicatore
// di statistiche) e sblocca un'abilità extra per archetipo. Ne risulta un nemico
// diverso a ogni ondata e sempre più forte nelle successive.
const APEX_ROSTER_BASE = [
  {
    id: 'vanguard',
    nameKey: 'apex.vanguard',
    color: 0x00e5ff,
    baseHp: 420,
    baseSpeed: 3.4,
    baseDamage: 13,
    radius: 1.15,
    extraAbility: 1 // doppia carica da tier 2
  },
  {
    id: 'wraith',
    nameKey: 'apex.wraith',
    color: 0xff2d95,
    baseHp: 300,
    baseSpeed: 4.6,
    baseDamage: 12,
    radius: .95,
    extraAbility: 1 // triplo blink da tier 2
  },
  {
    id: 'vex',
    nameKey: 'apex.vex',
    color: 0xffc857,
    baseHp: 340,
    baseSpeed: 3.9,
    baseDamage: 14,
    radius: 1.0,
    extraAbility: 1 // 3 mine da tier 2
  },
  {
    id: 'sentinel',
    nameKey: 'apex.sentinel',
    color: 0xff4f5f,
    baseHp: 900,
    baseSpeed: 3.8,
    baseDamage: 16,
    radius: 1.35,
    extraAbility: 1 // 4 minion da tier 2
  }
];

export const APEX_ROSTER = Object.freeze(APEX_ROSTER_BASE.map(a => Object.freeze({ ...a })));

export const APEX_TUNING = Object.freeze({
  tierMultiplier: 1.35, // statistiche × per tier
  hpMultiplier: 4,      // vita dei boss ×4 (richiesta utente)
  rosterSize: 4,        // un archetipo per ondata, ciclo ogni 4
  spawnDescent: 2.6,    // secondi di discesa in aria prima di attivarsi
  chargeSpeed: 14,      // carica VANGUARD
  chargeContactDmg: 22, // danno da contatto carica
  wraithBlinkRange: 9,
  wraithBlinkCooldown: 3.2,
  vexMineCount: 2,
  vexSplitMinis: 2,
  sentinelMinions: 3,
  sentinelPhase2Hp: .66,
  sentinelPhase3Hp: .33,
  scoreKill: 500,
  healKill: 25,
  ammoDropGuaranteed: true
});

// Endgame della demo: due cicli completi del roster, gauntlet e boss finale.
export const ENDGAME_TUNING = Object.freeze({
  gauntletWave: 9,
  finalWave: 10,
  gauntletTier: 3,
  megaBoss: Object.freeze({
    id: 'overlord',
    nameKey: 'apex.overlord',
    color: 0xc76dff,
    maxHealth: 24000,
    speed: 3.1,
    damage: 34,
    radius: 4.05,
    visualScale: 3,
    scoreKill: 5000
  })
});

// Railgun ricompensata dal primo Apex. Ha un caricatore a colpo singolo e un
// raggio istantaneo: il danno enorme vale per i droni semplici, mentre il
// danno separato per gli Apex evita che l'arma annulli il combattimento boss.
// Tuning per tutte le armi. Ogni arma ha caricatore, riserva, cadenza, tempo
// di ricarica e danno. Le armi nuove (minigun, rpg, flamethrower) vengono
// droppate dai boss dopo il primo (onda 2/3/4) e sbloccate una volta sola.
export const WEAPON_TUNING = Object.freeze({
  pulse: Object.freeze({
    nameKey: 'weapon.pulse',
    magazineSize: 30,
    reserveAmmo: 180,
    fireRate: 0.12,
    reloadTime: 1.35,
    damage: 34,
    projectile: true,
    bulletSpeed: 60,
    unlockWave: 0
  }),
  railgun: Object.freeze({
    nameKey: 'weapon.railgun',
    magazineSize: 1,
    reserveAmmo: 5,
    cooldown: 1.15,
    reloadTime: 1.2,
    damage: 9999,
    apexDamage: 180,
    range: 100,
    projectile: false,
    unlockWave: 1
  }),
  minigun: Object.freeze({
    nameKey: 'weapon.minigun',
    displayName: 'VULCAN',
    magazineSize: 120,
    reserveAmmo: 480,
    fireRate: 0.04,
    reloadTime: 3.0,
    damage: 12,
    spinUp: 0.4,
    projectile: true,
    bulletSpeed: 90,
    spread: 0.02,
    unlockWave: 2
  }),
  rpg: Object.freeze({
    nameKey: 'weapon.rpg',
    displayName: 'HELLSTORM',
    magazineSize: 1,
    reserveAmmo: 8,
    cooldown: 1.7,
    reloadTime: 2.2,
    damage: 220,
    blastRadius: 5,
    projectile: true,
    bulletSpeed: 28,
    unlockWave: 3
  }),
  flame: Object.freeze({
    nameKey: 'weapon.flame',
    displayName: 'PYRE',
    magazineSize: 80,
    reserveAmmo: 320,
    fireRate: 0.05,
    reloadTime: 2.5,
    damage: 5,
    range: 8,
    cone: 0.6,
    projectile: false,
    unlockWave: 4
  })
});

// T3: RAILGUN_TUNING deriva da WEAPON_TUNING.railgun (unica fonte di verità),
// con solo il tempo di vita del pickup aggiunto.
export const RAILGUN_TUNING = Object.freeze({
  ...WEAPON_TUNING.railgun,
  pickupLifetime: 90
});

// Seleziona l'archetipo Apex per l'ondata data (ciclo + tier).
export function getApexArchetype(wave) {
  const safeWave = Math.max(1, Math.floor(Number(wave) || 1));
  const tier = Math.floor((safeWave - 1) / APEX_TUNING.rosterSize) + 1;
  const archetype = APEX_ROSTER[(safeWave - 1) % APEX_ROSTER.length];
  return { archetype, tier };
}

// Statistiche scalate di un Apex per l'ondata data.
export function getApexStats(wave) {
  const { archetype, tier } = getApexArchetype(wave);
  return getApexStatsFor(archetype, tier);
}

// Statistiche di un archetipo specifico, usate dal gauntlet dell'ondata 9.
export function getApexStatsFor(archetypeOrId, tier = 1) {
  const archetype = typeof archetypeOrId === 'string'
    ? APEX_ROSTER.find(entry => entry.id === archetypeOrId) || APEX_ROSTER[0]
    : archetypeOrId || APEX_ROSTER[0];
  const safeTier = Math.max(1, Math.floor(Number(tier) || 1));
  const m = Math.pow(APEX_TUNING.tierMultiplier, safeTier - 1);
  return {
    archetype,
    tier: safeTier,
    maxHealth: Math.round(archetype.baseHp * APEX_TUNING.hpMultiplier * m),
    speed: archetype.baseSpeed * m,
    damage: Math.round(archetype.baseDamage * m),
    radius: archetype.radius,
    color: archetype.color,
    nameKey: archetype.nameKey
  };
}

export function getMegaBossStats() {
  const mega = ENDGAME_TUNING.megaBoss;
  return {
    archetype: mega,
    tier: 4,
    maxHealth: mega.maxHealth,
    speed: mega.speed,
    damage: mega.damage,
    radius: mega.radius,
    color: mega.color,
    nameKey: mega.nameKey,
    visualScale: mega.visualScale,
    mega: true
  };
}

export function getBossEncounter(wave) {
  const safeWave = Math.max(1, Math.floor(Number(wave) || 1));
  if (safeWave === ENDGAME_TUNING.gauntletWave) {
    return { kind: 'gauntlet', bossCount: APEX_ROSTER.length, final: false };
  }
  if (safeWave >= ENDGAME_TUNING.finalWave) {
    return { kind: 'final', bossCount: 1, final: true };
  }
  return { kind: 'standard', bossCount: 1, final: false };
}

function safeStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    // Privacy mode, disabled storage, or a blocked file origin must not stop
    // the simulation from booting.
    return null;
  }
}

function readStorage(storage, key) {
  try {
    return storage?.getItem(key);
  } catch {
    return null;
  }
}

export function getStoredQualityMode() {
  const value = readStorage(safeStorage(), 'vibefps.quality');
  return value === 'ultra' ? 'ultra' : 'auto';
}

export function storeQualityMode(mode) {
  try {
    safeStorage()?.setItem('vibefps.quality', mode === 'ultra' ? 'ultra' : 'auto');
  } catch {
    // Storage quotas are optional; gameplay settings remain in memory.
  }
}

export function getStoredMix() {
  const storage = safeStorage();
  const safe = (key, fallback) => {
    // localStorage.getItem() restituisce null per una chiave mancante; Number(null)
    // è 0, quindi il fallback qui sotto non scatterebbe mai al primo avvio (gioco
    // muto). Trattiamo null/'' come "non memorizzato" e usiamo il valore di default.
    const raw = readStorage(storage, key);
    const value = raw === null || raw === '' ? Number.NaN : Number(raw);
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
  };
  return {
    // Volumi di default rialzati (review demo): il mix precedente era troppo
    // timido, soprattutto la musica (moltiplicatori in AudioEngine.applyMix).
    music: safe('vibefps.mix.music', 0.82),
    sfx: safe('vibefps.mix.sfx', 0.95),
    ambience: safe('vibefps.mix.ambience', 0.66)
  };
}

export function storeMix(mix) {
  const storage = safeStorage();
  if (!storage) return;
  for (const [key, value] of Object.entries(mix)) {
    try {
      storage.setItem(`vibefps.mix.${key}`, String(Math.max(0, Math.min(1, value))));
    } catch {
      // Ignore quota/security errors for non-essential persistence.
    }
  }
}

// Sensibilità del mouse (M3): persistita in localStorage come il mix.
export const SENSITIVITY_DEFAULT = 1;

export function getStoredSensitivity() {
  const raw = readStorage(safeStorage(), 'vibefps.sensitivity');
  const value = raw === null || raw === '' ? Number.NaN : Number(raw);
  return Number.isFinite(value) ? Math.max(.25, Math.min(3, value)) : SENSITIVITY_DEFAULT;
}

export function storeSensitivity(value) {
  try {
    safeStorage()?.setItem('vibefps.sensitivity', String(Math.max(.25, Math.min(3, value))));
  } catch {
    // Non essenziale: resta in memoria.
  }
}

// Stato mute (N8/A5): persistito come il mix, così il tasto M sopravvive al
// reload della pagina e l'HUD può rifletterlo fin dal primo avvio.
export function getStoredMuted() {
  return readStorage(safeStorage(), 'vibefps.muted') === '1';
}

export function storeMuted(muted) {
  try {
    safeStorage()?.setItem('vibefps.muted', muted ? '1' : '0');
  } catch {
    // Non essenziale: resta in memoria.
  }
}

// Lingua dell'interfaccia (L1): persistita come gli altri settings.
// Default 'en' (richiesta demo); 'it' disponibile dal pannello settings.
export const LANGUAGE_DEFAULT = 'en';

export function getStoredLanguage() {
  return readStorage(safeStorage(), 'vibefps.lang') === 'it' ? 'it' : LANGUAGE_DEFAULT;
}

export function storeLanguage(lang) {
  try {
    safeStorage()?.setItem('vibefps.lang', lang === 'it' ? 'it' : 'en');
  } catch {
    // Non essenziale: resta in memoria.
  }
}
