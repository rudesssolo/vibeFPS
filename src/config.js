export const QUALITY_PROFILES = Object.freeze({
  autoHigh: Object.freeze({
    name: 'AUTO // HIGH',
    pixelRatio: 1.35,
    shadowSize: 2048,
    reflectorSize: 512,
    gtaoSamples: 16,
    facadeResolution: 1024,
    particleScale: 0.72,
    dynamicLights: 4
  }),
  autoLow: Object.freeze({
    name: 'AUTO // BALANCED',
    pixelRatio: 1,
    shadowSize: 1024,
    reflectorSize: 256,
    gtaoSamples: 8,
    facadeResolution: 1024,
    particleScale: 0.48,
    dynamicLights: 3
  }),
  ultra: Object.freeze({
    name: 'ULTRA',
    pixelRatio: 2,
    shadowSize: 4096,
    reflectorSize: 1024,
    gtaoSamples: 24,
    facadeResolution: 2048,
    particleScale: 1,
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

export function getStoredQualityMode() {
  const value = localStorage.getItem('vibefps.quality');
  return value === 'ultra' ? 'ultra' : 'auto';
}

export function storeQualityMode(mode) {
  localStorage.setItem('vibefps.quality', mode === 'ultra' ? 'ultra' : 'auto');
}

export function getStoredMix() {
  const safe = (key, fallback) => {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
  };
  return {
    music: safe('vibefps.mix.music', 0.72),
    sfx: safe('vibefps.mix.sfx', 0.9),
    ambience: safe('vibefps.mix.ambience', 0.58)
  };
}

export function storeMix(mix) {
  for (const [key, value] of Object.entries(mix)) {
    localStorage.setItem(`vibefps.mix.${key}`, String(Math.max(0, Math.min(1, value))));
  }
}
