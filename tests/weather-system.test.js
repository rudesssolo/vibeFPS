import test from 'node:test';
import assert from 'node:assert/strict';
import { INTERACTION_SPLASHES, WeatherSystem } from '../src/weather-system.js';
import { QUALITY_PROFILES } from '../src/config.js';

const impact = () => ({ active: false, mesh: { visible: false }, material: { opacity: 0 } });

function makeSystem() {
  return Object.assign(Object.create(WeatherSystem.prototype), {
    lineGeometry: {
      drawCount: -1,
      setDrawRange(_start, count) { this.drawCount = count; }
    },
    lines: { visible: false },
    fogBanks: Array.from({ length: 12 }, () => ({ mesh: { visible: false } })),
    splashes: Array.from({ length: 32 }, impact),
    ripples: Array.from({ length: 24 }, impact),
    wetMaterials: []
  });
}

test('weather quality applies exact bounded pool budgets', () => {
  const system = makeSystem();
  system.setQuality(QUALITY_PROFILES.ultra);
  assert.equal(system.rainCount, 700);
  assert.equal(system.lineGeometry.drawCount, 1400);
  assert.equal(system.fogLimit, 12);
  assert.equal(system.splashLimit, 32);
  assert.equal(system.rippleLimit, 24);
  system.setQuality(QUALITY_PROFILES.autoLow);
  assert.equal(system.rainCount, 260);
  assert.equal(system.fogLimit, 0);
  assert.equal(system.splashLimit, 0);
  assert.equal(system.rippleLimit, 0);
});

test('un materiale può limitare il clearcoat bagnato senza ereditare il boost globale', () => {
  const system = makeSystem();
  system.wetness = .75;
  const material = { roughness: .6, clearcoat: .12, needsUpdate: false };
  system.registerWetMaterial(material, { dryRoughness: .6, wetRoughness: .5, wetClearcoat: .2 });
  assert.equal(material.roughness, .525);
  assert.equal(material.clearcoat, .18);
  assert.equal(material.needsUpdate, true);
});

test('gli schizzi di gameplay restano disponibili anche col budget pioggia a zero', () => {
  const system = makeSystem();
  system.fxOverrides = {};
  const transforms = { position: null, scale: null };
  system.splashes = Array.from({ length: 32 }, () => ({
    active: false,
    age: 0,
    life: .28,
    mesh: {
      visible: false,
      position: { set(...value) { transforms.position = value; } },
      scale: { set(...value) { transforms.scale = value; } }
    },
    material: { opacity: 0 }
  }));
  system.splashLimit = 0;
  assert.equal(system.splashAt(2, -3, 1.4), true);
  assert.equal(system.splashes[0].active, true);
  assert.deepEqual(transforms.position, [2, .075, -3]);
  assert.equal(INTERACTION_SPLASHES, 8);
  assert.equal(system.splashAt(Number.NaN, 0), false);
});
