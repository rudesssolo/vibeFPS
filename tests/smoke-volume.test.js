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

test('il pool alloca una volta sola, non va in deriva e il reset libera tutto', () => {
  {
    const { scene, system } = makeSystem({ smokePuffs: 999 });
    // Budget molto alto: maxActive coincide con la capacità del pool, così il caso
    // "nessuno slot libero" viene davvero raggiunto invece di essere nascosto dal
    // tetto sull'overdraw.
    assert.equal(system.maxActive, system.maximum, 'il tetto non copre tutto il pool');
    // Gli spawn in eccesso vengono RIFIUTATI (L5: nessun pop di un volume visibile)
    // e non incrementano mai activeCount: prima il ramo di riciclo incrementava
    // una seconda volta e il contatore non tornava mai a zero.
    for (let i = 0; i < system.maximum * 3; i++) system.spawn({ ...basePuff, life: 10 });
    assert.equal(system.activeCount, system.puffs.filter(puff => puff.active).length);
    assert.equal(system.activeCount, system.maximum);

    // Il cursore è round-robin: da lì in poi il pool si riusa e la scena NON
    // cresce. Prima ogni puff clonava una geometria e la distruggeva a fine vita.
    const warmup = system.warmupMeshes.length;
    system.update(20);
    for (let cycle = 0; cycle < 10; cycle++) {
      for (let i = 0; i < system.maximum; i++) system.spawn({ ...basePuff, life: .2 });
      system.update(1);
    }
    assert.equal(system.activeCount, 0, 'i puff scaduti devono liberare lo slot');
    assert.equal(scene.children.length, warmup + system.maximum, 'la scena è cresciuta oltre il pool');
    assert.equal(new Set(system.puffs.map(puff => puff.mesh)).size, system.maximum, 'uno slot ha riallocato la propria mesh');
    for (const puff of system.puffs) assert.equal(puff.mesh.geometry.disposed, false);

    const fresh = makeSystem().system;
    for (let i = 0; i < 4; i++) fresh.spawn({ ...basePuff, life: 10 });
    fresh.reset();
    assert.equal(fresh.activeCount, 0);
    for (const puff of fresh.puffs) {
      assert.equal(puff.active, false);
      if (puff.mesh) {
        assert.equal(puff.mesh.visible, false);
        assert.equal(puff.mesh.material, fresh.material);
      }
    }

    const off = makeSystem({ smokePuffs: 0 }).system;
    off.spawn({ ...basePuff });
    assert.equal(off.activeCount, 0, 'smokePuffs 0 disattiva il fumo');
    assert.equal(off.puffs.filter(puff => puff.active).length, 0);
  }

  {
    const { system } = makeSystem();
    system.spawn({ ...basePuff, delay: .2, life: 1 });
    const puff = system.puffs.find(item => item.active);
    assert.equal(puff.mesh.visible, false, 'visibile durante il delay');
    system.update(.1);
    assert.equal(puff.mesh.visible, false, 'visibile prima della fine del delay');
    system.update(.2);
    assert.equal(puff.mesh.visible, true, 'invisibile dopo la fine del delay');
  }
});

test('le varianti sono precompilate e il materiale segue camera e budget', () => {
  {
    const { system } = makeSystem({ smokePuffs: 8 });
    assert.ok(system.material, 'materiale FrontSide assente');
    assert.ok(system.materialInside, 'materiale BackSide assente');
    assert.equal(system.material.side, FrontSide);
    assert.equal(system.materialInside.side, BackSide);
    // Una mesh a scala 0 per materiale: se una variante non è nel grafo, le sue
    // pipeline si compilerebbero al primo cambio di tier.
    assert.equal(system.warmupMeshes.length, 4);
    const materials = new Set(system.warmupMeshes.map(mesh => mesh.material));
    assert.equal(materials.size, 4);
    assert.ok(materials.has(system.variants.high.front));
    assert.ok(materials.has(system.variants.low.back));

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

    // Un puff già attivo segue lo scambio mantenendo il proprio lato.
    const swap = makeSystem({ smokePuffs: 8 }).system;
    swap.spawn({ ...basePuff, life: 10 });
    const puff = swap.puffs.find(entry => entry.active);
    puff.inside = true;
    puff.mesh.material = swap.materialInside;
    swap.setQuality({ smokePuffs: 2 });
    assert.equal(puff.mesh.material, swap.variants.low.back);
  }

  {
    const { system } = makeSystem();
    system.spawn({ ...basePuff, position: new Vector3(0, 1, 0), velocity: new Vector3(), life: 10, radiusStart: 2, radiusEnd: 2 });
    const puff = system.puffs.find(item => item.active);
    const camera = { position: new Vector3(0, 1, 0) };   // dentro il puff
    system.update(.016, camera);
    assert.equal(puff.mesh.material, system.materialInside);
    camera.position.set(0, 1, 40);                        // molto fuori
    system.update(.016, camera);
    assert.equal(puff.mesh.material, system.material);
  }

  {
    const { system } = makeSystem({ smokePuffs: 8 });   // ultra
    spawnOverlapping(system, 8);
    const before = system.activeCount;
    system.update(.016, insideCamera());
    assert.equal(visibleCount(system), 2, 'ultra deve fermarsi a 2 strati');
    // Esclusi dal disegno, non dalla simulazione: altrimenti resterebbero
    // bloccati e non libererebbero mai lo slot del pool.
    assert.equal(system.activeCount, before);
    for (let i = 0; i < 700; i++) system.update(.016, insideCamera());
    assert.equal(system.activeCount, 0, 'tutti i puff devono scadere');

    const low = makeSystem({ smokePuffs: 2 }).system;   // autoLow
    spawnOverlapping(low, 4);
    low.update(.016, insideCamera());
    assert.equal(visibleCount(low), 1, 'autoLow deve fermarsi a 1 strato');

    // Un puff isolato e lontano non viene escluso.
    const far = makeSystem({ smokePuffs: 8 }).system;
    far.spawn({ ...basePuff, position: new Vector3(0, 1, 12), life: 10, radiusStart: 2, radiusEnd: 2 });
    far.update(.016, { isCamera: true, fov: 75, position: new Vector3(0, 1, 0) });
    assert.equal(visibleCount(far), 1);
  }
});
