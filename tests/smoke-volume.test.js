import test from 'node:test';
import assert from 'node:assert/strict';
import { Scene, Vector3, FrontSide, BackSide } from './helpers/three-stub.mjs';
import { VolumetricSmokeSystem } from '../src/smoke-volume.js';

// 'three' e 'three/tsl' sono rimappati sugli stub dal loader registrato in
// package.json (--import ./tests/helpers/register-stubs.mjs). Costruire il
// sistema esegue davvero il corpo del grafo TSL: un simbolo non importato
// (come triNoise3D) fa fallire già questo primo test.

function makeSystem(profile = { smokePuffs: 8 }) {
  const scene = new Scene();
  const system = new VolumetricSmokeSystem(scene);
  system.setQuality(profile);
  return { scene, system };
}

const basePuff = {
  position: new Vector3(0, 1, 0),
  velocity: new Vector3(0, 1, 0),
  life: 1,
  radiusStart: .5,
  radiusEnd: 2,
  density: 1
};

test('il grafo del materiale si costruisce senza simboli mancanti', () => {
  const { system } = makeSystem();
  assert.ok(system.material, 'materiale FrontSide assente');
  assert.ok(system.materialInside, 'materiale BackSide assente');
  assert.equal(system.material.side, FrontSide);
  assert.equal(system.materialInside.side, BackSide);
});

test('activeCount non va in deriva quando il pool si riempie (regressione)', () => {
  // Budget molto alto: maxActive coincide con la capacità del pool, così il caso
  // "nessuno slot libero" viene davvero raggiunto invece di essere nascosto dal
  // tetto sull'overdraw.
  const { system } = makeSystem({ smokePuffs: 999 });
  assert.equal(system.maxActive, system.maximum, 'il tetto non copre tutto il pool');
  // Gli spawn in eccesso riciclano uno slot GIÀ contato in activeCount: prima
  // veniva incrementato una seconda volta e il contatore non tornava mai a zero.
  for (let i = 0; i < system.maximum * 3; i++) system.spawn({ ...basePuff, life: 10 });
  const reallyActive = system.puffs.filter(puff => puff.active).length;
  assert.equal(system.activeCount, reallyActive);
  assert.equal(system.activeCount, system.maximum);
});

test('activeCount torna a zero quando tutti i puff sono scaduti', () => {
  const { system } = makeSystem();
  for (let i = 0; i < 5; i++) system.spawn({ ...basePuff, life: .5 });
  assert.equal(system.activeCount, 5);
  // Oltre la vita di ogni puff: tutti devono essere rilasciati.
  system.update(1);
  assert.equal(system.activeCount, 0);
  assert.equal(system.puffs.filter(puff => puff.active).length, 0);
});

test('un puff con delay resta invisibile finché non inizia la sua vita', () => {
  const { system } = makeSystem();
  system.spawn({ ...basePuff, delay: .2, life: 1 });
  const puff = system.puffs.find(item => item.active);
  assert.equal(puff.mesh.visible, false, 'visibile durante il delay');
  system.update(.1);
  assert.equal(puff.mesh.visible, false, 'visibile prima della fine del delay');
  system.update(.2);
  assert.equal(puff.mesh.visible, true, 'invisibile dopo la fine del delay');
});

test('le mesh sono allocate una volta per slot e mai ricreate', () => {
  const { scene, system } = makeSystem({ smokePuffs: 999 });
  const warmup = system.warmupMeshes.length;
  // Il cursore è round-robin: le prime `maximum` esplosioni allocano una mesh
  // per slot, da lì in poi il pool si riusa. Il punto è che la scena NON cresce:
  // prima ogni puff clonava una geometria e la distruggeva a fine vita.
  for (let cycle = 0; cycle < 10; cycle++) {
    for (let i = 0; i < system.maximum; i++) system.spawn({ ...basePuff, life: .2 });
    system.update(1);
  }
  assert.equal(system.activeCount, 0);
  assert.equal(scene.children.length, warmup + system.maximum, 'la scena è cresciuta oltre il pool');
  const meshes = new Set(system.puffs.map(puff => puff.mesh));
  assert.equal(meshes.size, system.maximum, 'uno slot ha riallocato la propria mesh');
  for (const puff of system.puffs) assert.equal(puff.mesh.geometry.disposed, false);
});

test('il materiale commuta quando la camera entra e esce dal volume', () => {
  const { system } = makeSystem();
  system.spawn({ ...basePuff, position: new Vector3(0, 1, 0), velocity: new Vector3(), life: 10, radiusStart: 2, radiusEnd: 2 });
  const puff = system.puffs.find(item => item.active);
  const camera = { position: new Vector3(0, 1, 0) };   // dentro il puff
  system.update(.016, camera);
  assert.equal(puff.mesh.material, system.materialInside);
  camera.position.set(0, 1, 40);                        // molto fuori
  system.update(.016, camera);
  assert.equal(puff.mesh.material, system.material);
});

test('setQuality a zero puff disattiva completamente il fumo', () => {
  const { system } = makeSystem({ smokePuffs: 0 });
  system.spawn({ ...basePuff });
  assert.equal(system.activeCount, 0);
  assert.equal(system.puffs.filter(puff => puff.active).length, 0);
});

test('reset libera tutti i puff e ripristina il materiale esterno', () => {
  const { system } = makeSystem();
  for (let i = 0; i < 4; i++) system.spawn({ ...basePuff, life: 10 });
  system.reset();
  assert.equal(system.activeCount, 0);
  for (const puff of system.puffs) {
    assert.equal(puff.active, false);
    if (puff.mesh) {
      assert.equal(puff.mesh.visible, false);
      assert.equal(puff.mesh.material, system.material);
    }
  }
});
