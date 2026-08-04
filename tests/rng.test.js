import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRng } from '../src/rng.js';

test('same seed produces the same sequence', () => {
  const a = makeRng(12345);
  const b = makeRng(12345);
  for (let i = 0; i < 100; i++) assert.equal(a(), b());
});

test('different seeds produce different sequences', () => {
  const a = makeRng(1);
  const b = makeRng(2);
  const seqA = Array.from({ length: 20 }, () => a());
  const seqB = Array.from({ length: 20 }, () => b());
  assert.notDeepEqual(seqA, seqB);
});

test('output is always in [0, 1)', () => {
  const rng = makeRng(42);
  for (let i = 0; i < 5000; i++) {
    const value = rng();
    assert.ok(value >= 0 && value < 1, `out of range: ${value}`);
  }
});

test('default seed is stable and not NaN', () => {
  const rng = makeRng();
  const first = rng();
  assert.ok(Number.isFinite(first) && first >= 0 && first < 1);
});

test('invalid seeds (negative, zero, NaN) never produce out-of-range output (L1)', () => {
  for (const seed of [-5, -2147483647, 0, NaN]) {
    const rng = makeRng(seed);
    for (let i = 0; i < 500; i++) {
      const value = rng();
      assert.ok(Number.isFinite(value) && value >= 0 && value < 1, `seed ${seed}: out of range ${value}`);
    }
  }
  // seed 0/negativo cadono su un default deterministico (niente NaN/Infinity).
  assert.ok(Number.isFinite(makeRng(-42)()));
});