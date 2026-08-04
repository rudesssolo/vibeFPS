import test from 'node:test';
import assert from 'node:assert/strict';
import { DroneSystem } from '../src/drone-system.js';
import { Vector3 } from './helpers/three-stub.mjs';

function megaBoss() {
  return {
    alive: true,
    mega: true,
    megaPhase: 1,
    health: 24000,
    maxHealth: 24000,
    armorMax: 0,
    armorBroken: false,
    parts: [],
    coreMaterial: { emissive: { setHex() {} }, emissiveIntensity: 0 },
    group: { visible: true },
    marker: { style: {} },
    position: new Vector3(),
    state: 'patrol',
    stateTimer: 0,
    attackCooldown: 0
  };
}

test('mega-boss crosses four phases and deploys phase retaliation', () => {
  const system = Object.create(DroneSystem.prototype);
  let summons = 0;
  let shockwaves = 0;
  system.onApexSummon = () => { summons++; };
  system.onApexShockwave = () => { shockwaves++; };
  const apex = megaBoss();

  const phase2 = system.applyApexDamage(apex, 7000);
  assert.equal(apex.megaPhase, 2);
  assert.equal(phase2.phaseChanged, true);
  assert.equal(summons, 1);
  assert.equal(shockwaves, 1);

  system.applyApexDamage(apex, 6000);
  assert.equal(apex.megaPhase, 3);
  system.applyApexDamage(apex, 6000);
  assert.equal(apex.megaPhase, 4);
  const killed = system.applyApexDamage(apex, 6000);
  assert.equal(killed.killed, true);
  assert.equal(apex.alive, false);
  assert.equal(apex.group.visible, false);
});

test('gauntlet HUD keeps aggregate progress as council members fall', () => {
  const system = Object.create(DroneSystem.prototype);
  system.apexes = [
    { alive: false, health: 0, maxHealth: 1000 },
    { alive: true, health: 700, maxHealth: 1000 },
    { alive: true, health: 500, maxHealth: 1000 },
    { alive: false, health: 0, maxHealth: 1000 }
  ];
  const hud = system.getBossHudState();
  assert.equal(hud.nameKey, 'apex.council');
  assert.equal(hud.stateLabel, '2 ACTIVE');
  assert.equal(hud.health, 1200);
  assert.equal(hud.maxHealth, 4000);
});
