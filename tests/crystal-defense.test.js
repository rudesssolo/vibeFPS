import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CRYSTAL_DAMAGE_BOOST_SECONDS,
  CrystalDefenseObjective,
  shouldTargetCrystal
} from '../src/crystal-defense.js';

test("il cristallo distrutto non premia e si ricostruisce all'ondata successiva", () => {
  const objective = new CrystalDefenseObjective({ baseHealth: 100, healthPerWave: 10 });
  objective.startWave(1);
  const hit = objective.damage(999);
  assert.equal(hit.destroyedNow, true);
  assert.equal(objective.destroyed, true);
  assert.equal(objective.completeWave().survived, false);
  assert.equal(objective.damageMultiplier, 1);

  objective.startWave(2);
  assert.equal(objective.destroyed, false);
  assert.equal(objective.active, true);
  assert.equal(objective.health, 120);
  assert.equal(objective.maxHealth, 120);
});

test('un cristallo sopravvissuto dà danno doppio per esattamente 30 secondi', () => {
  const objective = new CrystalDefenseObjective();
  objective.startWave(4);
  const reward = objective.completeWave();
  assert.equal(reward.survived, true);
  assert.equal(objective.boostRemaining, CRYSTAL_DAMAGE_BOOST_SECONDS);
  assert.equal(objective.damageMultiplier, 2);

  objective.update(29.5);
  assert.equal(objective.damageMultiplier, 2);
  assert.equal(objective.boostRemaining, .5);
  assert.equal(objective.update(.5).expiredNow, true);
  assert.equal(objective.damageMultiplier, 1);
  assert.equal(objective.completeWave().resolvedNow, false, 'il premio non si applica due volte');
});

test('il targeting del cristallo è deterministico e cadenzato', () => {
  assert.deepEqual(
    Array.from({ length: 6 }, (_, sequence) => shouldTargetCrystal(sequence, 0, 3)),
    [true, false, false, true, false, false]
  );
  assert.equal(shouldTargetCrystal(1, 1, 2), true);
  assert.equal(shouldTargetCrystal(Number.NaN, 1, 2), false);
});
