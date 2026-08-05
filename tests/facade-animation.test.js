import test from 'node:test';
import assert from 'node:assert/strict';
import { FacadeSystem } from '../src/facade-system.js';

test('facade pulse stays readable and lightning raises emission', () => {
  const system = Object.assign(Object.create(FacadeSystem.prototype), {
    materials: [{ emissiveIntensity: 0 }, { emissiveIntensity: 0 }],
    beaconMaterials: [{ opacity: 0 }, { opacity: 0 }],
    pulseAmplitude: .12
  });
  system.update(3, 0);
  const normal = system.materials.map(material => material.emissiveIntensity);
  system.update(3, 1);
  for (let i = 0; i < normal.length; i++) {
    assert.ok(normal[i] >= .48);
    assert.ok(system.materials[i].emissiveIntensity > normal[i]);
  }
});
