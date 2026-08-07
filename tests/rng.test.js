import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRng } from '../src/rng.js';

test('stesso seed stessa sequenza, e l\'output resta sempre in [0,1) (L1)', () => {
  {
    const a = makeRng(42);
    const b = makeRng(42);
    const c = makeRng(43);
    const seqA = Array.from({ length: 8 }, () => a());
    assert.deepEqual(seqA, Array.from({ length: 8 }, () => b()));
    assert.notDeepEqual(seqA, Array.from({ length: 8 }, () => c()));
  }

  {
    for (const seed of [undefined, 0, -7, Number.NaN, 'x', 12345]) {
      const rng = makeRng(seed);
      for (let i = 0; i < 200; i++) {
        const value = rng();
        assert.ok(Number.isFinite(value), `seed ${String(seed)}: valore non finito`);
        assert.ok(value >= 0 && value < 1, `seed ${String(seed)}: ${value} fuori da [0,1)`);
      }
    }
  }
});
