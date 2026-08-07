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
  // Gli spawn in eccesso vengono RIFIUTATI (L5: nessun pop di un volume visibile)
  // e non incrementano mai activeCount: prima il ramo di riciclo incrementava
  // una seconda volta e il contatore non tornava mai a zero.
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

// Regressione: il cambio di tier automatico (autoHigh -> autoLow) avviene in
// gioco, senza schermata di transizione, e proprio quando il frame rate è già
// in difficoltà. Ricostruire i materiali lì compilava ~35 pipeline dentro un
// frame: ~2 s di stallo misurati. Le due varianti devono essere già pronte.
test('il cambio di qualità scambia materiali già compilati senza ricostruirli', () => {
  const { system } = makeSystem({ smokePuffs: 8 });
  const highFront = system.material;
  const highBack = system.materialInside;
  assert.equal(system.activeVariant, 'high');

  system.setQuality({ smokePuffs: 2 });          // scende a autoLow
  assert.equal(system.activeVariant, 'low');
  assert.notEqual(system.material, highFront, 'la variante low deve essere un materiale distinto');
  const lowFront = system.material;
  const lowBack = system.materialInside;
  assert.equal(lowFront.side, FrontSide);
  assert.equal(lowBack.side, BackSide);

  system.setQuality({ smokePuffs: 8 });          // risale a autoHigh
  // Identità: gli stessi oggetti di prima, quindi nessuna ricompilazione.
  assert.equal(system.material, highFront);
  assert.equal(system.materialInside, highBack);
  system.setQuality({ smokePuffs: 2 });
  assert.equal(system.material, lowFront);
  assert.equal(system.materialInside, lowBack);
});

test('entrambe le varianti restano nel render graph per il warmup al boot', () => {
  const { system } = makeSystem();
  // Una mesh a scala 0 per materiale: se una variante non è nel grafo, le sue
  // pipeline si compilerebbero al primo cambio di tier.
  assert.equal(system.warmupMeshes.length, 4);
  const materials = new Set(system.warmupMeshes.map(mesh => mesh.material));
  assert.equal(materials.size, 4);
  assert.ok(materials.has(system.variants.high.front));
  assert.ok(materials.has(system.variants.low.back));
});

test('i puff attivi seguono lo scambio di variante mantenendo il lato corretto', () => {
  const { system } = makeSystem({ smokePuffs: 8 });
  system.spawn({ ...basePuff, life: 10 });
  const puff = system.puffs.find(entry => entry.active);
  puff.inside = true;
  puff.mesh.material = system.materialInside;
  system.setQuality({ smokePuffs: 2 });
  assert.equal(puff.mesh.material, system.variants.low.back);
});

// Regressione: con la camera dentro la nuvola l'hull di ogni puff riempie lo
// schermo. Il solo tetto `maxActive` ne consentiva 16 in ultra, cioè 16 raymarch
// a schermo pieno da 12 passi nello stesso frame: abbastanza da mandare la GPU
// in timeout e far restare lo schermo nero per qualche secondo.
const insideCamera = () => ({ isCamera: true, fov: 75, position: new Vector3(0, 1, 0) });
const spawnOverlapping = (system, count) => {
  for (let i = 0; i < count; i++) {
    system.spawn({ ...basePuff, position: new Vector3(i * .05, 1, 0), life: 10, radiusStart: 3, radiusEnd: 3 });
  }
};
const visibleCount = system => system.puffs.filter(p => p.active && p.mesh && p.mesh.visible).length;

test('dentro la nuvola gli strati a schermo pieno sono limitati dal budget', () => {
  const { system } = makeSystem({ smokePuffs: 8 });   // ultra
  spawnOverlapping(system, 8);
  system.update(.016, insideCamera());
  assert.equal(visibleCount(system), 2, 'ultra deve fermarsi a 2 strati');
});

test('il budget scala con il profilo', () => {
  const low = makeSystem({ smokePuffs: 2 }).system;   // autoLow
  spawnOverlapping(low, 4);
  low.update(.016, insideCamera());
  assert.equal(visibleCount(low), 1, 'autoLow deve fermarsi a 1 strato');
});

test('i puff esclusi restano vivi e continuano a invecchiare', () => {
  const { system } = makeSystem({ smokePuffs: 8 });
  spawnOverlapping(system, 8);
  const before = system.activeCount;
  system.update(.016, insideCamera());
  // Esclusi dal disegno, non dalla simulazione: altrimenti resterebbero
  // bloccati e non libererebbero mai lo slot del pool.
  assert.equal(system.activeCount, before);
  for (let i = 0; i < 700; i++) system.update(.016, insideCamera());
  assert.equal(system.activeCount, 0, 'tutti i puff devono scadere');
});

test('un puff isolato e lontano non viene escluso dal budget', () => {
  const { system } = makeSystem({ smokePuffs: 8 });
  system.spawn({ ...basePuff, position: new Vector3(0, 1, 12), life: 10, radiusStart: 2, radiusEnd: 2 });
  system.update(.016, { isCamera: true, fov: 75, position: new Vector3(0, 1, 0) });
  assert.equal(visibleCount(system), 1);
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
