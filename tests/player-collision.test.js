import test from 'node:test';
import assert from 'node:assert/strict';

import { constrainBodyToSquare } from '../src/player-collision.js';

const spawn = { x: 0, y: 2, z: 8 };
const body = (position, velocity) => ({
  position: { y: .5, ...position },
  velocity: { y: 0, ...velocity }
});

test('preserves wall-parallel velocity while removing outward velocity', () => {
  const player = body({ x: 10, z: 2 }, { x: 4, z: -7 });
  constrainBodyToSquare(player, 10, spawn);
  assert.deepEqual(player.position, { x: 10, y: .5, z: 2 });
  assert.deepEqual(player.velocity, { x: 0, y: 0, z: -7 });
});

test('preserves velocity directed back into the arena', () => {
  const player = body({ x: 10.2, z: 2 }, { x: -4, z: 3 });
  constrainBodyToSquare(player, 10, spawn);
  assert.deepEqual(player.position, { x: 10, y: .5, z: 2 });
  assert.deepEqual(player.velocity, { x: -4, y: 0, z: 3 });
});

test('handles both axes independently in an arena corner', () => {
  const player = body({ x: -10.3, z: 10.4 }, { x: -4, z: 6 });
  constrainBodyToSquare(player, 10, spawn);
  assert.deepEqual(player.position, { x: -10, y: .5, z: 10 });
  assert.deepEqual(player.velocity, { x: 0, y: 0, z: 0 });
});

test('recovers the complete body state from non-finite physics values', () => {
  const player = body({ x: 1, y: Number.NaN, z: 2 }, { x: 3, z: 4 });
  const result = constrainBodyToSquare(player, 10, spawn);
  assert.deepEqual(player.position, spawn);
  assert.deepEqual(player.velocity, { x: 0, y: 0, z: 0 });
  assert.equal(result.reset, true);
});
