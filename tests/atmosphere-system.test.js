import test from 'node:test';
import assert from 'node:assert/strict';
import { AtmosphereSystem } from '../src/atmosphere-system.js';

function makeLogicSystem() {
  let thunder = 0;
  const system = Object.assign(Object.create(AtmosphereSystem.prototype), {
    random: () => .5,
    onThunder: () => { thunder++; },
    timeNode: { value: 0 },
    elapsed: 0,
    meteorRate: 0,
    meteorRateTimer: 8,
    meteors: [],
    traffic: [],
    trafficCount: 0,
    lightningEnabled: true,
    lightningFlash: 0,
    _strikeTimer: 1,
    _strikeAge: -1,
    _strikeLife: 0,
    _thunderDelay: 0,
    _thunderFired: false
  });
  return { system, thunderCount: () => thunder };
}

test('lightning has a bounded flash envelope and fires thunder once', () => {
  const { system, thunderCount } = makeLogicSystem();
  assert.equal(system.triggerLightning(), true);
  for (let i = 0; i < 80; i++) {
    const flash = system.update(.02, i * .02);
    assert.ok(Number.isFinite(flash));
    assert.ok(flash >= 0 && flash <= 1);
  }
  assert.equal(thunderCount(), 1);
});

test('disabled lightning cannot be triggered', () => {
  const { system } = makeLogicSystem();
  system.lightningEnabled = false;
  assert.equal(system.triggerLightning(), false);
});
