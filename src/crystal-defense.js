export const CRYSTAL_DAMAGE_BOOST_SECONDS = 30;

/**
 * Stato puro dell'obiettivo da difendere. Rendering, messaggi e targeting
 * restano nel gioco; qui vivono gli invarianti che non devono dipendere dal
 * frame rate: una ricostruzione per ondata, una sola risoluzione e 30 secondi
 * reali di danno doppio soltanto se il nucleo sopravvive.
 */
export class CrystalDefenseObjective {
  constructor({ baseHealth = 450, healthPerWave = 60,
    boostSeconds = CRYSTAL_DAMAGE_BOOST_SECONDS } = {}) {
    this.baseHealth = baseHealth;
    this.healthPerWave = healthPerWave;
    this.boostSeconds = boostSeconds;
    this.resetRun();
  }

  resetRun() {
    this.wave = 0;
    this.maxHealth = this.baseHealth;
    this.health = this.maxHealth;
    this.active = false;
    this.destroyed = false;
    this.resolved = false;
    this.boostRemaining = 0;
  }

  startWave(wave) {
    const safeWave = Number.isFinite(wave) ? Math.max(1, Math.floor(wave)) : 1;
    this.wave = safeWave;
    this.maxHealth = this.baseHealth + safeWave * this.healthPerWave;
    this.health = this.maxHealth;
    this.active = true;
    this.destroyed = false;
    this.resolved = false;
    return this.snapshot();
  }

  damage(amount) {
    if (!this.active || this.destroyed || this.resolved
      || !Number.isFinite(amount) || amount <= 0) {
      return { applied: 0, destroyedNow: false, ...this.snapshot() };
    }
    const before = this.health;
    this.health = Math.max(0, this.health - amount);
    const destroyedNow = before > 0 && this.health === 0;
    if (destroyedNow) {
      this.destroyed = true;
      this.active = false;
    }
    return { applied: before - this.health, destroyedNow, ...this.snapshot() };
  }

  completeWave() {
    if (this.resolved) {
      return { resolvedNow: false, survived: !this.destroyed, ...this.snapshot() };
    }
    this.resolved = true;
    this.active = false;
    const survived = !this.destroyed && this.health > 0;
    if (survived) this.boostRemaining = this.boostSeconds;
    return { resolvedNow: true, survived, ...this.snapshot() };
  }

  update(delta, active = true) {
    if (!active || !Number.isFinite(delta) || delta <= 0 || this.boostRemaining <= 0) {
      return { expiredNow: false, ...this.snapshot() };
    }
    const before = this.boostRemaining;
    this.boostRemaining = Math.max(0, before - delta);
    return { expiredNow: before > 0 && this.boostRemaining === 0, ...this.snapshot() };
  }

  get damageMultiplier() { return this.boostRemaining > 0 ? 2 : 1; }

  snapshot() {
    return {
      wave: this.wave,
      maxHealth: this.maxHealth,
      health: this.health,
      healthRatio: this.maxHealth > 0 ? this.health / this.maxHealth : 0,
      active: this.active,
      destroyed: this.destroyed,
      resolved: this.resolved,
      boostRemaining: this.boostRemaining,
      damageMultiplier: this.damageMultiplier
    };
  }
}

/** Cadenza deterministica: nessun RNG rende una run impossibile da riprodurre. */
export function shouldTargetCrystal(sequence, attackerId = 0, cadence = 3) {
  if (!Number.isFinite(sequence) || !Number.isFinite(attackerId)) return false;
  const safeCadence = Math.max(1, Math.floor(Number(cadence) || 1));
  return (Math.floor(sequence) + Math.floor(attackerId)) % safeCadence === 0;
}
