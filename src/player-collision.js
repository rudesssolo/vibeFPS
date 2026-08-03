const AXES = ['x', 'z'];

/**
 * Keeps a physics body inside a square arena without destroying the velocity
 * parallel to a wall. The function only removes an outward velocity component:
 * an inward component is preserved so the player can immediately leave a wall.
 */
export function constrainBodyToSquare(body, limit, spawn, epsilon = 1e-5) {
  const { position, velocity } = body;
  const positionIsValid = Number.isFinite(position.x)
    && Number.isFinite(position.y)
    && Number.isFinite(position.z);
  const velocityIsValid = Number.isFinite(velocity.x)
    && Number.isFinite(velocity.y)
    && Number.isFinite(velocity.z);

  if (!positionIsValid || !velocityIsValid || !Number.isFinite(limit) || limit <= 0) {
    position.x = spawn.x;
    position.y = spawn.y;
    position.z = spawn.z;
    velocity.x = 0;
    velocity.y = 0;
    velocity.z = 0;
    return { corrected: true, positionCorrected: true, reset: true };
  }

  let corrected = false;
  let positionCorrected = false;
  for (const axis of AXES) {
    const coordinate = position[axis];
    const speed = velocity[axis];
    let wallSide = 0;

    if (coordinate >= limit - epsilon) {
      wallSide = 1;
      if (coordinate !== limit) {
        position[axis] = limit;
        corrected = true;
        positionCorrected = true;
      }
    } else if (coordinate <= -limit + epsilon) {
      wallSide = -1;
      if (coordinate !== -limit) {
        position[axis] = -limit;
        corrected = true;
        positionCorrected = true;
      }
    }

    // speed * wallSide > 0 means that the body is moving out of the arena.
    // Never clear an inward component: doing so is what makes a controller
    // feel stuck for a frame when changing direction next to a wall.
    if (wallSide && speed * wallSide > 0) {
      velocity[axis] = 0;
      corrected = true;
    }
  }

  return { corrected, positionCorrected, reset: false };
}
