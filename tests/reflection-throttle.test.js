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

test('la deriva della posa e exceedsDrift concordano', () => {
  {
    const moving = new ReflectionScheduler({ interval: 4 });
    let updates = 0;
    // 10 m/s a 60 FPS = ~0.167 m per frame, cioè la soglia di .35 m ogni ~2 frame.
    for (let frame = 0; frame < 60; frame++) {
      if (moving.shouldUpdate(pose(frame * .167), 0, 0)) updates++;
    }
    assert.ok(updates > 15, `atteso più di 15 refresh in movimento, ottenuti ${updates}`);
    assert.ok(updates < 60, `il throttle deve comunque saltare qualche frame, ottenuti ${updates}`);
    assert.equal(countUpdates(new ReflectionScheduler({ interval: 4 }), 60), 15, 'da fermo governa l\'intervallo');

    const scheduler = new ReflectionScheduler({ interval: 8 });
    assert.equal(scheduler.shouldUpdate(pose(0), 0, 0), true);
    // 5 cm e ~1.1°: sotto soglia, la reflection resta riusabile.
    assert.equal(scheduler.shouldUpdate(pose(.05), .02, 0), false, 'deriva impercettibile');

    const fast = new ReflectionScheduler({ interval: 8 });
    fast.shouldUpdate(pose(0), 0, 0, 16);
    // .4 m > .35 m: è il caso del salto, dove l'artefatto compariva.
    assert.equal(fast.shouldUpdate(pose(.4), 0, 0, 16), true, 'deriva di posizione oltre soglia');
    fast.shouldUpdate(pose(.4), 0, 0, 16);
    // .06 rad > .05 rad di rotazione.
    assert.equal(fast.shouldUpdate(pose(.4), .06, 0, 16), true, 'deriva angolare oltre soglia');

    // La deriva si misura dall'ultima posa RESA: confrontarla col frame
    // precedente mancherebbe un accumulo di passi tutti sotto soglia.
    const flick = new ReflectionScheduler({ interval: 8, jumpAngle: .35 });
    assert.equal(flick.shouldUpdate(pose(), 0, 0), true);
    assert.equal(flick.shouldUpdate(pose(), .2, 0), false);
    assert.equal(flick.shouldUpdate(pose(), .4, 0), true);
    const pitched = new ReflectionScheduler({ interval: 8, jumpAngle: .35 });
    assert.equal(pitched.shouldUpdate(pose(), 0, 0), true);
    assert.equal(pitched.shouldUpdate(pose(), 0, .5), true, 'il pitch conta come lo yaw');

    const teleport = new ReflectionScheduler({ interval: 8, jumpDistance: 2 });
    assert.equal(teleport.shouldUpdate(pose(0), 0, 0), true);
    assert.equal(teleport.shouldUpdate(pose(0), 0, 0), false);
    assert.equal(teleport.shouldUpdate(pose(9), 0, 0), true, 'un teleport non mostra un altro luogo');
  }

  {
    const scheduler = new ReflectionScheduler({ interval: 8 });
    // Senza una posa registrata la deriva è per definizione oltre soglia.
    assert.equal(scheduler.exceedsDrift(pose(), 0, 0), true);
    scheduler.shouldUpdate(pose(0), 0, 0, 16);
    assert.equal(scheduler.exceedsDrift(pose(.05), 0, 0), false);
    assert.equal(scheduler.exceedsDrift(pose(.4), 0, 0), true);
    assert.equal(scheduler.exceedsDrift(null, 0, 0), true);
    // Invariante: se shouldUpdate salta, la deriva NON può essere oltre soglia.
    assert.equal(scheduler.shouldUpdate(pose(.05), 0, 0, 16), false);
    assert.equal(scheduler.exceedsDrift(pose(.05), 0, 0), false);
  }
});

test('la cadenza segue l\'intervallo, e ogni intervallo invalido degrada a ogni frame', () => {
  // Il primo frame rende sempre: il pavimento non deve mai partire vuoto.
  assert.equal(new ReflectionScheduler({ interval: 4 }).shouldUpdate(pose(), 0, 0), true);
  // Da fermo l'intervallo dimezza/quarta i render, non li ferma: esplosioni e
  // tracer devono continuare a comparire nel pavimento.
  assert.equal(countUpdates(new ReflectionScheduler({ interval: 2 }), 60), 30);
  assert.equal(countUpdates(new ReflectionScheduler({ interval: 4 }), 60), 15);
  assert.equal(countUpdates(new ReflectionScheduler({ interval: 1 }), 12), 12);
  assert.equal(new ReflectionScheduler().interval, 2, 'default 30 Hz');

  // Qualunque valore assurdo cade su "ogni frame", mai su un pavimento fermo.
  for (const bad of [0, -3, Number.NaN, null, 'two']) {
    const scheduler = new ReflectionScheduler({ interval: bad });
    assert.equal(scheduler.interval, 1, `interval ${String(bad)}`);
    assert.equal(countUpdates(scheduler, 5), 5, `interval ${String(bad)}`);
  }
  // updateReflectionQuality() inoltra profile.reflectorInterval così com'è: un
  // profilo vecchio o costruito a mano non deve congelare la reflection.
  const fallback = new ReflectionScheduler({ interval: 4 });
  fallback.setInterval(undefined);
  assert.equal(fallback.interval, 1);
  assert.equal(countUpdates(fallback, 5), 5);
});

// Compromesso deliberato: mentre la camera si muove la deriva impone il refresh
// prima dell'intervallo, perché una reflection riusata da una posa diversa è
// visibile se quel frame resta a schermo (hitch). Il risparmio si conserva dove
// è sicuro — camera ferma, mira, menu, pausa.

test('un frame lento disattiva il throttle invece di mostrare una reflection vecchia', () => {
  const scheduler = new ReflectionScheduler({ interval: 4 });
  assert.equal(scheduler.shouldUpdate(pose(), 0, 0, 16), true);
  assert.equal(scheduler.shouldUpdate(pose(), 0, 0, 16), false);
  assert.equal(scheduler.shouldUpdate(pose(), 0, 0, 1000), true, 'dentro un hitch si riallinea');
  for (let i = 0; i < 5; i++) {
    assert.equal(scheduler.shouldUpdate(pose(), 0, 0, 250), true, `hitch prolungato, frame ${i}`);
  }

  // 16.7 ms/frame: sotto la soglia, il risparmio deve restare.
  const normal = new ReflectionScheduler({ interval: 4 });
  let updates = 0;
  for (let i = 0; i < 60; i++) {
    if (normal.shouldUpdate(pose(), 0, 0, 16.7)) updates++;
  }
  assert.equal(updates, 15, 'frame normali rispettano l\'intervallo');
  // Omettere frameMs conserva il comportamento a soli frame.
  assert.equal(countUpdates(new ReflectionScheduler({ interval: 2 }), 60), 30);

  const custom = new ReflectionScheduler({ interval: 4, slowFrameMs: 100 });
  custom.shouldUpdate(pose(), 0, 0, 0);
  assert.equal(custom.shouldUpdate(pose(), 0, 0, 50), false, '50 ms sotto la soglia custom');
  assert.equal(custom.shouldUpdate(pose(), 0, 0, Number.NaN), false, 'frameMs non finito ignorato');
  assert.equal(custom.shouldUpdate(pose(), 0, 0, 150), true);
});

test('pose non finite, reset e setInterval non congelano mai il pavimento', () => {
  const broken = new ReflectionScheduler({ interval: 4 });
  assert.equal(broken.shouldUpdate(pose(), 0, 0), true);
  assert.equal(broken.shouldUpdate(pose(Number.NaN), 0, 0), true);
  assert.equal(broken.shouldUpdate(pose(), Number.NaN, 0), true);
  assert.equal(broken.shouldUpdate(null, 0, 0), true);
  assert.equal(broken.poseX, 0, 'una posa rotta non va memorizzata come riferimento');
  // La posa riparata rende di nuovo invece di riusare una target disegnata da
  // una matrice di camera corrotta.
  assert.equal(broken.shouldUpdate(pose(), 0, 0), true);

  const reset = new ReflectionScheduler({ interval: 4 });
  assert.equal(reset.shouldUpdate(pose(), 0, 0), true);
  assert.equal(reset.shouldUpdate(pose(), 0, 0), false);
  reset.reset();
  assert.equal(reset.shouldUpdate(pose(), 0, 0), true);

  const retimed = new ReflectionScheduler({ interval: 1 });
  assert.equal(countUpdates(retimed, 4), 4);
  retimed.setInterval(4);
  assert.equal(countUpdates(retimed, 8), 2);
});
