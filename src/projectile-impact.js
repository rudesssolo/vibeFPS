const SEGMENT_EPSILON = 1e-7;

function finitePoint(point) {
  return Boolean(point)
    && Number.isFinite(point.x)
    && Number.isFinite(point.y)
    && Number.isFinite(point.z);
}

/**
 * Restituisce il primo parametro t in [0, 1] in cui il segmento entra nella
 * sfera. `null` significa nessun contatto. Funziona con THREE.Vector3,
 * CANNON.Vec3 e semplici oggetti { x, y, z }.
 */
export function segmentSphereFirstHitFraction(start, end, center, radius) {
  if (!finitePoint(start) || !finitePoint(end) || !finitePoint(center)
    || !Number.isFinite(radius) || radius < 0) return null;

  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dz = end.z - start.z;
  const mx = start.x - center.x;
  const my = start.y - center.y;
  const mz = start.z - center.z;
  const lengthSq = dx * dx + dy * dy + dz * dz;
  const radiusSq = radius * radius;
  const c = mx * mx + my * my + mz * mz - radiusSq;

  // Un segmento che parte già nel volume lo tocca a t=0.
  if (c <= 0) return 0;
  if (lengthSq <= SEGMENT_EPSILON) return null;

  const b = mx * dx + my * dy + mz * dz;
  const discriminant = b * b - lengthSq * c;
  if (discriminant < 0) return null;
  const t = (-b - Math.sqrt(Math.max(0, discriminant))) / lengthSq;
  if (t < -SEGMENT_EPSILON || t > 1 + SEGMENT_EPSILON) return null;
  return Math.max(0, Math.min(1, t));
}

/** Parametro t del punto proiettato sul segmento, clampato in [0, 1]. */
export function segmentPointFraction(start, end, point) {
  if (!finitePoint(start) || !finitePoint(end) || !finitePoint(point)) return null;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dz = end.z - start.z;
  const lengthSq = dx * dx + dy * dy + dz * dz;
  if (lengthSq <= SEGMENT_EPSILON) return 0;
  const t = ((point.x - start.x) * dx
    + (point.y - start.y) * dy
    + (point.z - start.z) * dz) / lengthSq;
  return Math.max(0, Math.min(1, t));
}

/**
 * Confronto comune per l'arbitraggio del primo impatto. A parità di t vince
 * la priorità numerica minore: gli ostacoli usano 0, i bersagli 1, così una
 * superficie esattamente tangente non lascia passare il colpo.
 */
export function isEarlierSegmentHit(candidateFraction, bestFraction,
  candidatePriority = 1, bestPriority = 1) {
  if (!Number.isFinite(candidateFraction)) return false;
  if (!Number.isFinite(bestFraction)) return true;
  if (candidateFraction < bestFraction - SEGMENT_EPSILON) return true;
  return Math.abs(candidateFraction - bestFraction) <= SEGMENT_EPSILON
    && candidatePriority < bestPriority;
}

