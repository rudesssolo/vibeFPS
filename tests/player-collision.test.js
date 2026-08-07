import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { constrainBodyToSquare } from '../src/player-collision.js';

const spawn = { x: 0, y: 2, z: 8 };
const body = (position, velocity) => ({
  position: { y: .5, ...position },
  velocity: { y: 0, ...velocity }
});

test('il vincolo dell\'arena conserva la velocità utile e recupera stati non finiti', () => {
  {
    // Al muro: la componente uscente sparisce, quella parallela resta.
    const sliding = body({ x: 10, z: 2 }, { x: 4, z: -7 });
    constrainBodyToSquare(sliding, 10, spawn);
    assert.deepEqual(sliding.position, { x: 10, y: .5, z: 2 });
    assert.deepEqual(sliding.velocity, { x: 0, y: 0, z: -7 });

    // Chi sta rientrando nell'arena conserva tutta la sua velocità.
    const returning = body({ x: 10.2, z: 2 }, { x: -4, z: 3 });
    constrainBodyToSquare(returning, 10, spawn);
    assert.deepEqual(returning.position, { x: 10, y: .5, z: 2 });
    assert.deepEqual(returning.velocity, { x: -4, y: 0, z: 3 });

    // In un angolo i due assi si trattano in modo indipendente.
    const corner = body({ x: -10.3, z: 10.4 }, { x: -4, z: 6 });
    constrainBodyToSquare(corner, 10, spawn);
    assert.deepEqual(corner.position, { x: -10, y: .5, z: 10 });
    assert.deepEqual(corner.velocity, { x: 0, y: 0, z: 0 });
  }

  {
    const player = body({ x: 1, y: Number.NaN, z: 2 }, { x: 3, z: 4 });
    const result = constrainBodyToSquare(player, 10, spawn);
    assert.deepEqual(player.position, spawn);
    assert.deepEqual(player.velocity, { x: 0, y: 0, z: 0 });
    assert.equal(result.reset, true);
  }
});

test('ogni CANNON.Cylinder è montato con un orientamento esplicito', () => {
  // `CANNON.Cylinder` è costruito lungo Z (i vertici variano di raggio in x,y e
  // di ±height/2 in z), `THREE.CylinderGeometry` lungo Y. Senza rotazione i
  // corpi restano coricati: le colonne diventavano cilindri orizzontali che
  // partivano da y=1.4, sopra la testa del collider, e si attraversavano.
  // La rotazione va sulla FORMA, non sul corpo, così `body.quaternion` resta
  // identità per chi legge l'orientamento (sync mesh, raycast).
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main.js'), 'utf8');
  const usi = source.match(/new CANNON\.Cylinder\([^)]*\)/g) || [];
  assert.ok(usi.length > 0, 'nessun cilindro fisico: il controllo non serve più?');
  for (const uso of usi) {
    const riga = source.slice(source.indexOf(uso), source.indexOf(uso) + 200);
    assert.match(riga, /\)\s*,\s*new CANNON\.Vec3\(\)\s*,\s*\w+\s*\)/,
      `un cilindro è aggiunto senza orientamento: ${uso}`);
  }
  assert.match(source, /setFromAxisAngle\(new CANNON\.Vec3\(1, 0, 0\), -Math\.PI \/ 2\)/,
    'la rotazione che porta +Z su +Y è sparita');
});
