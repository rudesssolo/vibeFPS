/**
 * Gating dei drop d'arma lasciati dai boss (T2).
 *
 * Il difetto: ogni arma poteva cadere una volta sola, all'ondata del proprio
 * sblocco, e un flag "già droppata" impediva ogni tentativo successivo. Se il
 * drop scadeva a terra senza essere raccolto — 90 secondi, un boss lungo li
 * consuma — l'arma restava irraggiungibile per il resto della run: soft-lock
 * silenzioso, perché niente in gioco segnala che quella ricompensa è persa.
 *
 * Il roster degli Apex cicla ogni 4 ondate, quindi lo stesso archetipo torna
 * all'ondata `unlockWave + 4k`. Il drop si riapre lì, e solo lì, finché l'arma
 * non è stata raccolta: la ricompensa resta legata al suo boss e le ondate non
 * si riempiono di casse.
 *
 * La regola vale per tutte le armi droppate, railgun inclusa: era proprio la
 * railgun (ondata 1, ricompensa di progressione) a non avere nessuna seconda
 * occasione.
 */

/** Periodicità del roster Apex: lo stesso archetipo torna ogni 4 ondate. */
export const WEAPON_DROP_CYCLE = 4;

export class WeaponDropRegistry {
  /**
   * @param {Object<string, {unlockWave: number}>} weapons tuning per id; le
   *   armi con `unlockWave` non positivo (l'arma iniziale) sono ignorate.
   */
  constructor(weapons = {}) {
    this.unlockWaves = new Map();
    for (const [id, tuning] of Object.entries(weapons)) {
      const unlockWave = tuning?.unlockWave;
      if (Number.isFinite(unlockWave) && unlockWave > 0) this.unlockWaves.set(id, unlockWave);
    }
    /** Armi con un drop attualmente a terra: nessun secondo esemplare. */
    this.pending = new Set();
  }

  /** L'ondata è una di quelle in cui ricompare il boss che porta quest'arma. */
  isWaveEligible(id, wave) {
    const unlockWave = this.unlockWaves.get(id);
    if (unlockWave === undefined || !Number.isFinite(wave)) return false;
    return wave >= unlockWave && (wave - unlockWave) % WEAPON_DROP_CYCLE === 0;
  }

  canSpawn(id, wave, unlocked) {
    if (unlocked || this.pending.has(id)) return false;
    return this.isWaveEligible(id, wave);
  }

  markSpawned(id) {
    this.pending.add(id);
    return this;
  }

  /** Il drop non è più a terra (scaduto o rimosso): l'arma torna droppabile. */
  release(id) {
    this.pending.delete(id);
    return this;
  }

  reset() {
    this.pending.clear();
    return this;
  }
}
