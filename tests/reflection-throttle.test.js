import test from 'node:test';
import assert from 'node:assert/strict';

import { ReflectionScheduler } from '../src/reflection-throttle.js';

const pose = (x = 0, y = 1.6, z = 0) => ({ x, y, z });
// Runs `frames` still frames and returns how many of them rendered a reflection.
const countUpdates = (scheduler, frames, position = pose(), yaw = 0, pitch = 0) => {
  let updates = 0;
  for (let i = 0; i < frames; i++) {
    if (scheduler.shouldUpdate(position, yaw, pitch)) updates++;
  }
  return updates;
};

test('renders the first frame so the floor is never blank', () => {
  const scheduler = new ReflectionScheduler({ interval: 4 });
  assert.equal(scheduler.shouldUpdate(pose(), 0, 0), true);
});

test('caps staleness at the configured interval while the camera is still', () => {
  const scheduler = new ReflectionScheduler({ interval: 2 });
  // 60 still frames at interval 2 must halve the reflection renders, not stop
  // them: explosions and tracers have to keep appearing in the floor.
  assert.equal(countUpdates(scheduler, 60), 30);

  const quarter = new ReflectionScheduler({ interval: 4 });
  assert.equal(countUpdates(quarter, 60), 15);
});

test('interval 1 keeps the original every-frame behaviour', () => {
  const scheduler = new ReflectionScheduler({ interval: 1 });
  assert.equal(countUpdates(scheduler, 12), 12);
});

test('an invalid interval degrades to every frame, never to a frozen floor', () => {
  for (const bad of [0, -3, Number.NaN, null, 'two']) {
    const scheduler = new ReflectionScheduler({ interval: bad });
    assert.equal(scheduler.interval, 1, `interval ${String(bad)}`);
    assert.equal(countUpdates(scheduler, 5), 5);
  }
});

test('a profile without reflectorInterval falls back to every frame', () => {
  // updateReflectionQuality() forwards profile.reflectorInterval straight in;
  // an older or hand-built profile must not silently freeze the reflection.
  const scheduler = new ReflectionScheduler({ interval: 4 });
  scheduler.setInterval(undefined);
  assert.equal(scheduler.interval, 1);
  assert.equal(countUpdates(scheduler, 5), 5);
});

test('omitting the option entirely uses the 30 Hz default', () => {
  assert.equal(new ReflectionScheduler().interval, 2);
});

// Compromesso deliberato: mentre la camera si muove la deriva impone il refresh
// prima dell'intervallo, perché una reflection riusata da una posa diversa è
// visibile se quel frame resta a schermo (hitch). Il risparmio si conserva dove
// è sicuro — camera ferma, mira, menu, pausa.
test('camminando la deriva impone il refresh prima dell\'intervallo', () => {
  const scheduler = new ReflectionScheduler({ interval: 4 });
  let updates = 0;
  // 10 m/s a 60 FPS = ~0.167 m per frame, cioè la soglia di .35 m ogni ~2 frame.
  for (let frame = 0; frame < 60; frame++) {
    if (scheduler.shouldUpdate(pose(frame * .167), 0, 0)) updates++;
  }
  assert.ok(updates > 15, `atteso più di 15 refresh in movimento, ottenuti ${updates}`);
  assert.ok(updates < 60, `il throttle deve comunque saltare qualche frame, ottenuti ${updates}`);
});

test('da fermo l\'intervallo governa e il risparmio si conserva', () => {
  const scheduler = new ReflectionScheduler({ interval: 4 });
  assert.equal(countUpdates(scheduler, 60), 15);
});

test('una deriva impercettibile non forza il refresh', () => {
  const scheduler = new ReflectionScheduler({ interval: 8 });
  assert.equal(scheduler.shouldUpdate(pose(0), 0, 0), true);
  // 5 cm e ~1.1°: sotto soglia, la reflection resta riusabile.
  assert.equal(scheduler.shouldUpdate(pose(.05), .02, 0), false);
});

test('la deriva oltre soglia forza il refresh anche a frame veloci', () => {
  const scheduler = new ReflectionScheduler({ interval: 8 });
  scheduler.shouldUpdate(pose(0), 0, 0, 16);
  // .4 m > .35 m: è il caso del salto, dove l'artefatto compariva.
  assert.equal(scheduler.shouldUpdate(pose(.4), 0, 0, 16), true);
  scheduler.shouldUpdate(pose(.4), 0, 0, 16);
  // .06 rad > .05 rad di rotazione.
  assert.equal(scheduler.shouldUpdate(pose(.4), .06, 0, 16), true);
});

test('exceedsDrift riflette la decisione dello scheduler', () => {
  const scheduler = new ReflectionScheduler({ interval: 8 });
  // Senza una posa registrata la deriva è per definizione oltre soglia.
  assert.equal(scheduler.exceedsDrift(pose(), 0, 0), true);
  scheduler.shouldUpdate(pose(0), 0, 0, 16);
  assert.equal(scheduler.exceedsDrift(pose(.05), 0, 0), false);
  assert.equal(scheduler.exceedsDrift(pose(.4), 0, 0), true);
  assert.equal(scheduler.exceedsDrift(null, 0, 0), true);
  // Invariante: se shouldUpdate salta, la deriva NON può essere oltre soglia.
  const skipped = scheduler.shouldUpdate(pose(.05), 0, 0, 16);
  assert.equal(skipped, false);
  assert.equal(scheduler.exceedsDrift(pose(.05), 0, 0), false);
});

test('a teleport refreshes immediately instead of showing another location', () => {
  const scheduler = new ReflectionScheduler({ interval: 8, jumpDistance: 2 });
  assert.equal(scheduler.shouldUpdate(pose(0), 0, 0), true);
  assert.equal(scheduler.shouldUpdate(pose(0), 0, 0), false);
  assert.equal(scheduler.shouldUpdate(pose(9), 0, 0), true);
});

test('drift is measured from the last rendered pose, so a fast flick refreshes early', () => {
  const scheduler = new ReflectionScheduler({ interval: 8, jumpAngle: .35 });
  assert.equal(scheduler.shouldUpdate(pose(), 0, 0), true);
  // Each step is under the threshold; the accumulated drift since the last
  // render is not. Comparing against the previous frame would miss this.
  assert.equal(scheduler.shouldUpdate(pose(), .2, 0), false);
  assert.equal(scheduler.shouldUpdate(pose(), .4, 0), true);
});

test('pitch drift is treated like yaw drift', () => {
  const scheduler = new ReflectionScheduler({ interval: 8, jumpAngle: .35 });
  assert.equal(scheduler.shouldUpdate(pose(), 0, 0), true);
  assert.equal(scheduler.shouldUpdate(pose(), 0, .5), true);
});

test('a non-finite pose refreshes and is never stored as a reference', () => {
  const scheduler = new ReflectionScheduler({ interval: 4 });
  assert.equal(scheduler.shouldUpdate(pose(), 0, 0), true);
  assert.equal(scheduler.shouldUpdate(pose(Number.NaN), 0, 0), true);
  assert.equal(scheduler.shouldUpdate(pose(), Number.NaN, 0), true);
  assert.equal(scheduler.shouldUpdate(null, 0, 0), true);
  assert.equal(scheduler.poseX, 0);
  // The repaired pose renders again rather than reusing a target drawn from a
  // broken camera matrix.
  assert.equal(scheduler.shouldUpdate(pose(), 0, 0), true);
});

// --- Frame lenti: il throttle deve disattivarsi ------------------------------
// Regressione: contare i frame è sicuro solo finché i frame costano poco. Con
// un hitch da ~1 s quel frame resta a schermo per un secondo intero e la
// reflection di due frame prima diventa visibile come "fotogramma precedente"
// sovrapposto (linee del pavimento, grattacieli).

test('un frame lento disattiva il throttle invece di mostrare una reflection vecchia', () => {
  const scheduler = new ReflectionScheduler({ interval: 4 });
  assert.equal(scheduler.shouldUpdate(pose(), 0, 0, 16), true);
  assert.equal(scheduler.shouldUpdate(pose(), 0, 0, 16), false);
  // 1000 ms: siamo dentro un hitch, la reflection va riallineata subito.
  assert.equal(scheduler.shouldUpdate(pose(), 0, 0, 1000), true);
});

test('durante un hitch prolungato ogni frame rinfresca la reflection', () => {
  const scheduler = new ReflectionScheduler({ interval: 4 });
  scheduler.shouldUpdate(pose(), 0, 0, 16);
  for (let i = 0; i < 5; i++) {
    assert.equal(scheduler.shouldUpdate(pose(), 0, 0, 250), true, `frame lento ${i}`);
  }
});

test('un frame normale continua a rispettare l\'intervallo', () => {
  const scheduler = new ReflectionScheduler({ interval: 4 });
  let updates = 0;
  // 16.7 ms/frame: sotto la soglia, il risparmio deve restare.
  for (let i = 0; i < 60; i++) {
    if (scheduler.shouldUpdate(pose(), 0, 0, 16.7)) updates++;
  }
  assert.equal(updates, 15);
});

test('la soglia di frame lento è configurabile e ignora valori non finiti', () => {
  const scheduler = new ReflectionScheduler({ interval: 4, slowFrameMs: 100 });
  scheduler.shouldUpdate(pose(), 0, 0, 0);
  // 50 ms è sotto la soglia personalizzata: nessun bypass.
  assert.equal(scheduler.shouldUpdate(pose(), 0, 0, 50), false);
  assert.equal(scheduler.shouldUpdate(pose(), 0, 0, Number.NaN), false);
  assert.equal(scheduler.shouldUpdate(pose(), 0, 0, 150), true);
});

test('omettere frameMs conserva il comportamento a soli frame', () => {
  const scheduler = new ReflectionScheduler({ interval: 2 });
  assert.equal(countUpdates(scheduler, 60), 30);
});

test('reset forces the next frame to render a fresh reflection', () => {
  const scheduler = new ReflectionScheduler({ interval: 4 });
  assert.equal(scheduler.shouldUpdate(pose(), 0, 0), true);
  assert.equal(scheduler.shouldUpdate(pose(), 0, 0), false);
  scheduler.reset();
  assert.equal(scheduler.shouldUpdate(pose(), 0, 0), true);
});

test('setInterval applies from the next frame without freezing the floor', () => {
  const scheduler = new ReflectionScheduler({ interval: 1 });
  assert.equal(countUpdates(scheduler, 4), 4);
  scheduler.setInterval(4);
  assert.equal(countUpdates(scheduler, 8), 2);
});
