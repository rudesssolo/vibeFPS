import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isEarlierSegmentHit,
  segmentPointFraction,
  segmentSphereFirstHitFraction
} from '../src/projectile-impact.js';

const p = (x, y = 0, z = 0) => ({ x, y, z });

test('il primo impatto lungo il segmento rispetta copertura e ordine fisico (U1)', () => {
  const start = p(0);
  const end = p(10);
  const coverT = segmentPointFraction(start, end, p(4));
  const behindCoverT = segmentSphereFirstHitFraction(start, end, p(6), 1);
  const beforeCoverT = segmentSphereFirstHitFraction(start, end, p(3), .5);

  assert.equal(coverT, .4);
  assert.equal(behindCoverT, .5);
  assert.equal(beforeCoverT, .25);
  assert.equal(isEarlierSegmentHit(behindCoverT, coverT, 1, 0), false,
    'un bersaglio dietro la copertura non deve vincere');
  assert.equal(isEarlierSegmentHit(beforeCoverT, coverT, 1, 0), true,
    'un bersaglio prima della copertura deve essere colpito');
  assert.equal(isEarlierSegmentHit(coverT, coverT, 1, 0), false,
    'a parità deve vincere la superficie statica');

  // L'ordine d'inserimento non decide il bersaglio: vince il t minore.
  let bestT = Number.POSITIVE_INFINITY;
  let bestId = null;
  for (const target of [{ id: 'lontano', center: p(8) }, { id: 'vicino', center: p(4) }]) {
    const t = segmentSphereFirstHitFraction(start, end, target.center, .5);
    if (isEarlierSegmentHit(t, bestT)) { bestT = t; bestId = target.id; }
  }
  assert.equal(bestId, 'vicino');
  assert.equal(bestT, .35);
});

test("l'intersezione segmento-sfera gestisce delta grande e input degeneri", () => {
  assert.equal(segmentSphereFirstHitFraction(p(0), p(100), p(90), 1), .89);
  assert.equal(segmentSphereFirstHitFraction(p(0), p(0), p(2), 1), null);
  assert.equal(segmentSphereFirstHitFraction(p(0), p(0), p(0), 1), 0);
  assert.equal(segmentSphereFirstHitFraction(p(0), p(10), p(5, 2), 1), null);
  assert.equal(segmentSphereFirstHitFraction(p(Number.NaN), p(10), p(5), 1), null);
});
