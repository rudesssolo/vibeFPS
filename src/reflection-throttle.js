/**
 * Decides on which frames the floor reflector is allowed to re-render.
 *
 * The reflector renders the whole scene a second time from a mirrored camera
 * (plus a mipmap chain), so it is one full scene traversal per frame. The wet
 * asphalt mixes that result at low strength through a blurred mip level, which
 * makes a slightly stale reflection imperceptible — but a *frozen* one is not:
 * explosions, tracers and drones would stop appearing in the floor. So the
 * scheduler caps staleness at `interval` frames instead of holding the target
 * until the camera moves.
 *
 * Drift is measured against the pose the reflection was last rendered from, not
 * against the previous frame. A fast mouse flick therefore forces an early
 * refresh on its own, and a teleport (respawn, level reset) can never show a
 * reflection rendered from somewhere else in the arena.
 *
 * Counting frames is only safe while frames are cheap. A budget of "2 frames"
 * is 33 ms at 60 FPS and imperceptible, but during a hitch a single frame can
 * stay on screen for a second — and for that whole second the floor would glow
 * with a reflection captured before the hitch (old grid lines, old skyline).
 * So a slow frame disables the throttle: the saving is worthless when the
 * bottleneck is elsewhere, and the artifact is glaring.
 *
 * Pure and free of three.js so the policy is unit-testable: positions are read
 * duck-typed (`{x, y, z}`) and angles are the yaw/pitch the camera already keeps.
 */

// Oltre questa durata il frame non è più "un frame": la reflection va
// riallineata subito perché resterà a schermo abbastanza da farsi notare.
// ~40 ms = 25 FPS, cioè sotto qualunque andatura considerata giocabile.
// Da sola questa regola NON basta: la decisione usa la durata del frame
// PRECEDENTE, quindi il primo frame di un hitch sfugge — ed è proprio quello che
// resta a schermo. La garanzia vera è la soglia di deriva qui sotto.
const SLOW_FRAME_MS = 40;

// Deriva massima della posa entro cui una reflection riusata è indistinguibile
// da una appena renderizzata. È QUESTA la proprietà che rende l'artefatto
// impossibile: se la camera non si è mossa in modo percettibile, un frame
// riusato è corretto anche se resta a schermo per un secondo.
// 0.35 m a 10 m/s sono ~2 frame a 60 FPS; 0.05 rad sono ~3°, sotto la soglia
// visibile su una superficie sfocata (mip .32) miscelata a strength .34.
// Valori larghi (i 2 m e 0.35 rad iniziali) lasciavano passare esattamente il
// caso segnalato: salto in alto verso il muro con hitch da ~1 s.
const MAX_DRIFT_DISTANCE = .35;
const MAX_DRIFT_ANGLE = .05;

export class ReflectionScheduler {
  /**
   * @param {Object} [options]
   * @param {number} [options.interval=2] - Max frames a reflection may be reused.
   * @param {number} [options.jumpDistance=2] - Metres of drift that force a refresh.
   * @param {number} [options.jumpAngle=0.35] - Radians of drift that force a refresh.
   * @param {number} [options.slowFrameMs=40] - Frame duration above which the throttle is bypassed.
   */
  constructor({
    interval = 2,
    jumpDistance = MAX_DRIFT_DISTANCE,
    jumpAngle = MAX_DRIFT_ANGLE,
    slowFrameMs = SLOW_FRAME_MS
  } = {}) {
    this.jumpDistance = Number.isFinite(jumpDistance) && jumpDistance > 0 ? jumpDistance : MAX_DRIFT_DISTANCE;
    this.jumpAngle = Number.isFinite(jumpAngle) && jumpAngle > 0 ? jumpAngle : MAX_DRIFT_ANGLE;
    this.slowFrameMs = Number.isFinite(slowFrameMs) && slowFrameMs > 0 ? slowFrameMs : SLOW_FRAME_MS;
    this.setInterval(interval);
    this.reset();
  }

  /**
   * Frames between forced refreshes. A value of 1 (or anything invalid) keeps
   * the original every-frame behaviour, so a bad profile degrades to correct
   * rendering rather than to a frozen floor.
   */
  setInterval(interval) {
    const value = Number(interval);
    this.interval = Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1;
  }

  /** Forces the next frame to render a fresh reflection. */
  reset() {
    this.framesSinceUpdate = this.interval;
    this.hasPose = false;
    this.poseX = 0;
    this.poseY = 0;
    this.poseZ = 0;
    this.poseYaw = 0;
    this.posePitch = 0;
  }

  /**
   * Deriva della posa rispetto a quella dell'ultimo render della reflection.
   * Serve a verificare l'invariante dall'esterno: se la reflection non è stata
   * renderizzata, questa deve essere false, altrimenti a schermo finirebbe un
   * riflesso preso da un altro punto di vista.
   *
   * @return {boolean} True se la deriva è oltre la soglia percettibile.
   */
  exceedsDrift(position, yaw, pitch) {
    if (!this.hasPose) return true;
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(yaw) || !Number.isFinite(pitch)) return true;
    return (position.x - this.poseX) ** 2
      + (position.y - this.poseY) ** 2
      + (position.z - this.poseZ) ** 2 > this.jumpDistance ** 2
      || Math.abs(yaw - this.poseYaw) > this.jumpAngle
      || Math.abs(pitch - this.posePitch) > this.jumpAngle;
  }

  /**
   * @param {{x: number, y: number, z: number}} position - Camera world position.
   * @param {number} yaw - Camera yaw in radians.
   * @param {number} pitch - Camera pitch in radians.
   * @param {number} [frameMs] - Duration of the frame being prepared, in ms.
   * @return {boolean} True when the reflector should re-render this frame.
   */
  shouldUpdate(position, yaw, pitch, frameMs = 0) {
    // Un frame lento resta a schermo a lungo: qualunque ritardo della
    // reflection diventa visibile, quindi il throttle si disattiva.
    if (Number.isFinite(frameMs) && frameMs > this.slowFrameMs) {
      this.framesSinceUpdate = this.interval;
    }
    const poseIsValid = Boolean(position)
      && Number.isFinite(position.x)
      && Number.isFinite(position.y)
      && Number.isFinite(position.z)
      && Number.isFinite(yaw)
      && Number.isFinite(pitch);

    if (!poseIsValid) {
      // A non-finite pose is repaired later in the same frame (see
      // constrainCameraToArena). Re-render rather than keep a target that was
      // rendered from a broken matrix, and do not store the bad pose.
      this.framesSinceUpdate = this.interval;
      return true;
    }

    this.framesSinceUpdate++;
    const jumped = this.hasPose && (
      (position.x - this.poseX) ** 2
      + (position.y - this.poseY) ** 2
      + (position.z - this.poseZ) ** 2 > this.jumpDistance ** 2
      || Math.abs(yaw - this.poseYaw) > this.jumpAngle
      || Math.abs(pitch - this.posePitch) > this.jumpAngle
    );

    if (!this.hasPose || jumped || this.framesSinceUpdate >= this.interval) {
      this.hasPose = true;
      this.poseX = position.x;
      this.poseY = position.y;
      this.poseZ = position.z;
      this.poseYaw = yaw;
      this.posePitch = pitch;
      this.framesSinceUpdate = 0;
      return true;
    }
    return false;
  }
}
