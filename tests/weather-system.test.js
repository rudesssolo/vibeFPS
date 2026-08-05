import test from 'node:test';
import assert from 'node:assert/strict';
import { WeatherSystem } from '../src/weather-system.js';
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
