import test from 'node:test';
import assert from 'node:assert/strict';
import { RenderPipelineController, guardPassReentrancy } from '../src/render-pipeline.js';
import { QUALITY_PROFILES } from '../src/config.js';

// --- Rientranza fra PassNode -------------------------------------------------
// Regressione dal difetto "schermo nero per secondi": normalPass e scenePass
// renderizzano la stessa coppia (scene, camera) e quindi condividono la render
// list poolizzata. Il contextNode dell'AO lega gli oggetti della scene pass alla
// texture della normal pre-pass, così un oggetto poteva far ri-scattare la
// normal pass DENTRO la scene pass: il render annidato azzerava la lista mentre
// `_renderObjects` aveva già catturato la lunghezza, e three lanciava
// «Cannot destructure property 'object' of renderList[i]». La pipeline
// catturava l'eccezione e non disegnava: in WebGPU un frame senza disegno è nero.

function fakePass(name, log) {
  return { name, updateBefore() { log.push(name); return 'eseguito'; } };
}

test('un pass annidato dentro un altro viene rifiutato invece di corrompere la lista', () => {
  const log = [];
  const normalPass = fakePass('normal', log);
  let nested;
  // La scene pass, mentre renderizza, fa ri-scattare la normal pass: è
  // esattamente ciò che accade quando un oggetto della scene pass dipende dalla
  // texture della normal pre-pass tramite il contextNode dell'AO.
  const scenePass = {
    name: 'scene',
    updateBefore(frame) {
      log.push('scene:inizio');
      nested = normalPass.updateBefore(frame);
      log.push('scene:fine');
      return 'eseguito';
    }
  };
  guardPassReentrancy([normalPass, scenePass]);

  assert.equal(scenePass.updateBefore({}), 'eseguito');
  assert.equal(nested, false, 'il pass annidato deve restituire false, non eseguire');
  // Il corpo della normal pass non è mai partito dentro la scene pass.
  assert.deepEqual(log, ['scene:inizio', 'scene:fine']);
  // Fuori dall'annidamento riparte: NodeFrame lo ritenta dopo il rollback.
  assert.equal(normalPass.updateBefore({}), 'eseguito');
  assert.deepEqual(log, ['scene:inizio', 'scene:fine', 'normal']);
});

test('fuori dal contesto annidato i pass girano normalmente', () => {
  const log = [];
  const normalPass = fakePass('normal', log);
  const scenePass = fakePass('scene', log);
  guardPassReentrancy([normalPass, scenePass]);
  assert.equal(normalPass.updateBefore({}), 'eseguito');
  assert.equal(scenePass.updateBefore({}), 'eseguito');
  assert.deepEqual(log, ['normal', 'scene']);
});

test('la guardia si riarma anche se il pass lancia', () => {
  const log = [];
  const boom = { name: 'boom', updateBefore() { log.push('boom'); throw new Error('render fallito'); } };
  const other = fakePass('other', log);
  guardPassReentrancy([boom, other]);
  assert.throws(() => boom.updateBefore({}), /render fallito/);
  // Senza il finally la guardia resterebbe alzata e spegnerebbe i pass per sempre.
  assert.equal(other.updateBefore({}), 'eseguito');
  assert.deepEqual(log, ['boom', 'other']);
});

function makeController(renderPipeline, onPersistentFailure = () => {}) {
  const controller = Object.create(RenderPipelineController.prototype);
  Object.assign(controller, {
    grainTime: { value: 0 },
    progress: 1,
    postProcessingError: null,
    consecutivePostProcessingErrors: 0,
    persistentFailureReported: false,
    onPersistentFailure,
    renderer: {
      toneMapping: 'ACES',
      outputColorSpace: 'sRGB',
      xr: { enabled: true },
      setRenderTargetCalls: 0,
      setMRTCalls: 0,
      setRenderTarget() { this.setRenderTargetCalls++; },
      setMRT() { this.setMRTCalls++; }
    },
    pipeline: { render: renderPipeline },
  });
  return controller;
}

test('wall proximity cannot bypass a healthy post-processing pipeline', () => {
  let pipelineRenders = 0;
  const controller = makeController(() => { pipelineRenders++; });

  // Preserve the old failure trigger as a regression probe. Rendering must not
  // consult this player-position-derived state, even if a caller reintroduces it.
  controller.edgeSafeMode = true;
  controller.render(1 / 60, 10);

  assert.equal(pipelineRenders, 1);
  assert.equal(controller.postProcessingError, null);
});

test('a transient pipeline failure restores renderer state and retries', () => {
  const failure = new Error('shader compilation failed');
  let shouldFail = true;
  const controller = makeController(() => {
    controller.renderer.toneMapping = 'NoToneMapping';
    controller.renderer.outputColorSpace = 'working';
    controller.renderer.xr.enabled = false;
    if (shouldFail) throw failure;
  });
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    assert.equal(controller.render(1 / 60, 10), false);
    assert.equal(controller.postProcessingError, failure);
    assert.equal(controller.consecutivePostProcessingErrors, 1);
    assert.equal(controller.renderer.toneMapping, 'ACES');
    assert.equal(controller.renderer.outputColorSpace, 'sRGB');
    assert.equal(controller.renderer.xr.enabled, true);
    assert.equal(controller.renderer.setRenderTargetCalls, 1);
    assert.equal(controller.renderer.setMRTCalls, 1);

    shouldFail = false;
    assert.equal(controller.render(1 / 60, 11), true);
    assert.equal(controller.postProcessingError, null);
    assert.equal(controller.consecutivePostProcessingErrors, 0);
  } finally {
    console.error = originalConsoleError;
  }
});

test('persistent pipeline failures are reported once without a dark fallback', () => {
  const failure = new Error('persistent failure');
  let reports = 0;
  const controller = makeController(() => { throw failure; }, () => { reports++; });
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    for (let frame = 0; frame < 120; frame++) controller.render(1 / 60, frame / 60);
    assert.equal(reports, 1);
    assert.equal(controller.consecutivePostProcessingErrors, 120);
    assert.equal(controller.renderer.setRenderTargetCalls, 120);
  } finally {
    console.error = originalConsoleError;
  }
});

function makeQualityController() {
  const value = initial => ({ value: initial });
  return Object.assign(Object.create(RenderPipelineController.prototype), {
    aoPass: { samples: value(0) },
    graphics: { grain: { amount: .01 }, vignette: { darkness: .92 } },
    flareStrength: value(0),
    heatScale: value(0),
    grainAmount: value(0),
    vignetteDarkness: value(0),
    gradeSaturation: value(1),
    gradeVibrance: value(0),
    gradeAmount: value(1),
    heatSlots: Array.from({ length: 4 }, () => ({ strength: value(0), peak: 0 })),
    fxOverrides: {},
    currentProfile: null
  });
}

test('quality profiles update cinematic uniforms without recompiling the graph', () => {
  const controller = makeQualityController();
  controller.setQuality(QUALITY_PROFILES.ultra);
  assert.equal(controller.flareStrength.value, QUALITY_PROFILES.ultra.post.flare);
  assert.equal(controller.heatScale.value, QUALITY_PROFILES.ultra.post.heatHaze);
  assert.equal(controller.heatSlotLimit, 4);
  assert.equal(controller.gradeVibrance.value, QUALITY_PROFILES.ultra.post.vibrance);
});

test('FX overrides disable and restore the active profile values', () => {
  const controller = makeQualityController();
  controller.setQuality(QUALITY_PROFILES.autoHigh);
  controller.setFxOverrides({ flare: false, heatHaze: false, grain: false });
  assert.equal(controller.flareStrength.value, 0);
  assert.equal(controller.heatScale.value, 0);
  assert.equal(controller.grainAmount.value, 0);
  controller.setFxOverrides({ flare: true, heatHaze: true, grain: true });
  assert.equal(controller.flareStrength.value, QUALITY_PROFILES.autoHigh.post.flare);
  assert.equal(controller.heatScale.value, QUALITY_PROFILES.autoHigh.post.heatHaze);
  assert.equal(controller.grainAmount.value, QUALITY_PROFILES.autoHigh.post.grain);
});

test('world-space optical events reject invalid and off-screen projections', () => {
  const controller = Object.assign(Object.create(RenderPipelineController.prototype), { camera: {} });
  const point = projected => ({
    x: 0, y: 0, z: 0,
    clone: () => ({ project: () => projected })
  });
  assert.equal(controller._projectWorldPosition(point({ x: 0, y: 0, z: 0 })).z, 0);
  assert.equal(controller._projectWorldPosition(point({ x: 2, y: 0, z: 0 })), null);
  assert.equal(controller._projectWorldPosition(point({ x: 0, y: 0, z: Number.NaN })), null);
  assert.equal(controller._projectWorldPosition({ x: Number.NaN, y: 0, z: 0 }), null);
});

test('lightning exposure is finite and clamped', () => {
  const controller = Object.assign(Object.create(RenderPipelineController.prototype), { lightningFlash: { value: 0 } });
  controller.setLightningFlash(7);
  assert.equal(controller.lightningFlash.value, 1);
  controller.setLightningFlash(Number.NaN);
  assert.equal(controller.lightningFlash.value, 0);
});
