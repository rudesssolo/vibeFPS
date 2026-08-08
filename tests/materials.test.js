import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { unlitBasic } from '../src/materials.js';
import { AdditiveBlending } from './helpers/three-stub.mjs';

const SRC = path.resolve(import.meta.dirname, '..', 'src');

test('unlitBasic è davvero unlit, e nessun MeshBasicMaterial resta in src/', () => {
  {
    const material = unlitBasic({
      color: 0xff2d95, transparent: true, opacity: .4,
      blending: AdditiveBlending, depthWrite: false, fog: false
    });
    // Il punto: senza questo, BasicLightingModel moltiplica il colore per
    // l'ambient occlusion del contesto, cioè per la GTAO della pipeline.
    assert.equal(material.lights, false);
    assert.equal(material.transparent, true);
    assert.equal(material.opacity, .4);
    assert.equal(material.blending, AdditiveBlending);
    assert.equal(material.depthWrite, false);
    assert.equal(material.color.getHex(), 0xff2d95);
    assert.equal(unlitBasic().lights, false, 'deve reggere anche senza parametri');
  }

  {
    // S1. `MeshBasicMaterial` sembra unlit e non lo è: three lo converte in
    // MeshBasicNodeMaterial, che passa da BasicLightingModel e viene moltiplicato
    // per l'AO. Ogni elemento pensato come emissivo — occhi dei droni, neon,
    // accenti delle armi, tracer — usciva più scuro del dichiarato, e la luna
    // usciva nera. Chi ne aggiunge uno nuovo deve passare da unlitBasic().
    const offenders = [];
    for (const entry of fs.readdirSync(SRC)) {
      if (!entry.endsWith('.js')) continue;
      const source = fs.readFileSync(path.join(SRC, entry), 'utf8');
      const matches = source.match(/new THREE\.MeshBasicMaterial\(/g);
      if (matches) offenders.push(`${entry} (${matches.length})`);
    }
    assert.deepEqual(offenders, [], `usare unlitBasic() da src/materials.js invece di new THREE.MeshBasicMaterial: ${offenders.join(', ')}`);
  }
});

test('il vapore dei tombini viene composto sopra l\'acqua senza attraversare i solidi', () => {
  const main = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
  assert.match(main, /depthTest:true,depthWrite:false/,
    'il vapore non conserva più il depth test contro le geometrie solide');
  assert.match(main, /sprite\.renderOrder=2/,
    'il vapore viene nuovamente composto prima della lamina d\'acqua');
  assert.match(main, /p\.base\.y \+ size \* \.72/,
    'il puff riparte centrato nel pavimento e viene tagliato alla base');
});

test('l\'aura del cristallo non viene tagliata o duplicata dalla pozzanghera', () => {
  const main = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
  assert.match(main, /crystalAura\.renderOrder = 2/,
    'l\'aura trasparente viene nuovamente composta prima dell\'acqua');
  assert.match(main, /reflectionExclusions\.push\(crystalAura\)/,
    'l\'aura additiva è rientrata nel reflector come copia frammentata');
});
