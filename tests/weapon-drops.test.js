import test from 'node:test';
import assert from 'node:assert/strict';
import { WeaponDropRegistry, WEAPON_DROP_CYCLE } from '../src/weapon-drops.js';
import { WEAPON_TUNING } from '../src/config.js';

const registry = () => new WeaponDropRegistry(WEAPON_TUNING);

test('un drop scaduto torna, uno raccolto no, e il reset riapre tutto', () => {
  {
    const drops = registry();
    assert.equal(drops.canSpawn('minigun', 2, false), true);
    drops.markSpawned('minigun');
    // Finché l'esemplare è a terra non ne cade un secondo.
    assert.equal(drops.canSpawn('minigun', 2, false), false);
    assert.equal(drops.canSpawn('minigun', 6, false), false);
    // Scaduto senza essere raccolto: la prossima ondata dello stesso archetipo lo
    // riporta. È il difetto T2: senza il rilascio l'arma spariva per la run.
    drops.release('minigun');
    assert.equal(drops.canSpawn('minigun', 3, false), false, 'non deve ricadere fuori ciclo');
    assert.equal(drops.canSpawn('minigun', 2 + WEAPON_DROP_CYCLE, false), true);

    // Regressione diretta: il percorso railgun aveva la guardia `wave !== 1` e
    // nessun rilascio alla scadenza, quindi era l'unica arma irrecuperabile.
    const rail = registry();
    assert.equal(rail.canSpawn('railgun', 1, false), true);
    rail.markSpawned('railgun');
    rail.release('railgun');                 // scaduta a terra
    assert.equal(rail.canSpawn('railgun', 2, false), false);
    assert.equal(rail.canSpawn('railgun', 5, false), true);
    assert.equal(rail.canSpawn('railgun', 9, false), true);
  }

  {
    const drops = registry();
    drops.markSpawned('flame');
    drops.release('flame');                  // raccolta: il pickup lascia il terreno
    assert.equal(drops.canSpawn('flame', 8, true), false);
    assert.equal(drops.canSpawn('flame', 12, true), false);
    assert.equal(drops.canSpawn('flame', 12, false), true, 'se non raccolta, invece, sì');

    for (const id of drops.unlockWaves.keys()) drops.markSpawned(id);
    drops.reset();
    for (const [id, unlockWave] of drops.unlockWaves) {
      assert.equal(drops.canSpawn(id, unlockWave, false), true, `${id} resta bloccata dopo il reset`);
    }
  }
});

test('il calendario dei drop: una sola arma per ondata, mai l\'arma iniziale', () => {
  const drops = registry();
  assert.equal(drops.unlockWaves.has('pulse'), false, 'l\'arma iniziale non è un drop');
  for (let wave = 1; wave <= 12; wave++) {
    assert.equal(drops.canSpawn('pulse', wave, false), false);
    const eligible = [...drops.unlockWaves.keys()].filter(id => drops.isWaveEligible(id, wave));
    assert.ok(eligible.length <= 1, `ondata ${wave}: ${eligible.join(', ')}`);
  }
  assert.equal(drops.canSpawn('sconosciuta', 4, false), false);

  // Ogni arma cade alla sua ondata di sblocco, e non prima.
  for (const [id, unlockWave] of drops.unlockWaves) {
    for (let wave = 1; wave < unlockWave; wave++) {
      assert.equal(drops.canSpawn(id, wave, false), false, `${id} cade troppo presto (ondata ${wave})`);
    }
    assert.equal(drops.canSpawn(id, unlockWave, false), true, `${id} non cade alla sua ondata`);
  }

  // Ondate assurde non aprono niente.
  for (const wave of [Number.NaN, Infinity, undefined, null, 0, -3]) {
    assert.equal(drops.canSpawn('railgun', wave, false), false, `ondata ${wave}`);
  }
});

// --- T2: il soft-lock --------------------------------------------------------
