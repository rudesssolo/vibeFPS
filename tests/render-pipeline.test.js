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



function makeQualityController() {
  const value = initial => ({ value: initial });
  return Object.assign(Object.create(RenderPipelineController.prototype), {
    aoPass: { samples: value(0) },
    aoBlend: value(1),
    graphics: { grain: { amount: .01 }, vignette: { darkness: .92 }, gtao: { blendIntensity: 1 } },
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

function makeAoController() {
  const controller = Object.create(RenderPipelineController.prototype);
  let quadRenders = 0;
  controller.aoPass = {
    samples: { value: 0 },
    useTemporalFiltering: false,
    updateBefore() { quadRenders++; return 'renderizzato'; }
  };
  controller.aoBlend = { value: 1 };
  controller.graphics = { grain: { amount: .01 }, vignette: { darkness: .92 }, gtao: { blendIntensity: 1 } };
  Object.assign(controller, {
    flareStrength: { value: 0 }, heatScale: { value: 0 }, grainAmount: { value: 0 },
    vignetteDarkness: { value: 0 }, gradeSaturation: { value: 1 },
    gradeVibrance: { value: 0 }, gradeAmount: { value: 1 },
    heatSlots: Array.from({ length: 4 }, () => ({ strength: { value: 0 }, peak: 0 })),
    fxOverrides: {}, currentProfile: null
  });
  controller.gateAoPass();
  return { controller, renders: () => quadRenders };
}

test('la pipeline sopravvive ai fallimenti e i profili non ricostruiscono il grafo', () => {
  {
    let pipelineRenders = 0;
    const healthy = makeController(() => { pipelineRenders++; });
    // Sonda di regressione: il rendering non deve consultare lo stato derivato
    // dalla posizione del giocatore, nemmeno se qualcuno lo reintroducesse.
    healthy.edgeSafeMode = true;
    healthy.render(1 / 60, 10);
    assert.equal(pipelineRenders, 1);
    assert.equal(healthy.postProcessingError, null);

    const failure = new Error('shader compilation failed');
    let shouldFail = true;
    const controller = makeController(() => {
      controller.renderer.toneMapping = 'NoToneMapping';
      controller.renderer.outputColorSpace = 'working';
      controller.renderer.xr.enabled = false;
      if (shouldFail) throw failure;
    });
    let reports = 0;
    const persistent = makeController(() => { throw failure; }, () => { reports++; });
    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      assert.equal(controller.render(1 / 60, 10), false);
      assert.equal(controller.postProcessingError, failure);
      assert.equal(controller.consecutivePostProcessingErrors, 1);
      assert.equal(controller.renderer.toneMapping, 'ACES', 'toneMapping non ripristinato');
      assert.equal(controller.renderer.outputColorSpace, 'sRGB');
      assert.equal(controller.renderer.xr.enabled, true);
      assert.equal(controller.renderer.setRenderTargetCalls, 1);
      assert.equal(controller.renderer.setMRTCalls, 1);

      shouldFail = false;
      assert.equal(controller.render(1 / 60, 11), true, 'il frame successivo deve ritentare');
      assert.equal(controller.postProcessingError, null);
      assert.equal(controller.consecutivePostProcessingErrors, 0);

      // Fallimento persistente: segnalato una volta sola, senza fallback scuro.
      for (let frame = 0; frame < 120; frame++) persistent.render(1 / 60, frame / 60);
      assert.equal(reports, 1);
      assert.equal(persistent.consecutivePostProcessingErrors, 120);
      assert.equal(persistent.renderer.setRenderTargetCalls, 120);
    } finally {
      console.error = originalConsoleError;
    }
  }

  {
    const controller = makeQualityController();
    controller.setQuality(QUALITY_PROFILES.ultra);
    assert.equal(controller.flareStrength.value, QUALITY_PROFILES.ultra.post.flare);
    assert.equal(controller.heatScale.value, QUALITY_PROFILES.ultra.post.heatHaze);
    assert.equal(controller.heatSlotLimit, 4);
    assert.equal(controller.gradeVibrance.value, QUALITY_PROFILES.ultra.post.vibrance);

    const fx = makeQualityController();
    fx.setQuality(QUALITY_PROFILES.autoHigh);
    fx.setFxOverrides({ flare: false, heatHaze: false, grain: false });
    assert.equal(fx.flareStrength.value, 0);
    assert.equal(fx.heatScale.value, 0);
    assert.equal(fx.grainAmount.value, 0);
    fx.setFxOverrides({ flare: true, heatHaze: true, grain: true });
    assert.equal(fx.flareStrength.value, QUALITY_PROFILES.autoHigh.post.flare);
    assert.equal(fx.heatScale.value, QUALITY_PROFILES.autoHigh.post.heatHaze);
    assert.equal(fx.grainAmount.value, QUALITY_PROFILES.autoHigh.post.grain);
  }
});

test('eventi ottici e gate della GTAO', () => {
  {
    const controller = Object.assign(Object.create(RenderPipelineController.prototype), { camera: {} });
    const point = projected => ({
      x: 0, y: 0, z: 0,
      clone: () => ({ project: () => projected })
    });
    assert.equal(controller._projectWorldPosition(point({ x: 0, y: 0, z: 0 })).z, 0);
    assert.equal(controller._projectWorldPosition(point({ x: 2, y: 0, z: 0 })), null, 'fuori schermo');
    assert.equal(controller._projectWorldPosition(point({ x: 0, y: 0, z: Number.NaN })), null);
    assert.equal(controller._projectWorldPosition({ x: Number.NaN, y: 0, z: 0 }), null);

    const flash = Object.assign(Object.create(RenderPipelineController.prototype), { lightningFlash: { value: 0 } });
    flash.setLightningFlash(7);
    assert.equal(flash.lightningFlash.value, 1);
    flash.setLightningFlash(Number.NaN);
    assert.equal(flash.lightningFlash.value, 0);
  }

  // Q8. `aoPass.enabled = false` non faceva niente: il GTAONode vendorizzato non
  // consulta quella proprietà e in `updateBefore` disegna comunque il suo quad a
  // schermo intero, anche con `gtaoSamples: 0`.
  {
    const off = makeAoController();
    off.controller.setQuality(QUALITY_PROFILES.autoLow);
    assert.equal(off.controller.aoPass.enabled, false);
    assert.equal(off.controller.aoBlend.value, 0, 'il mix deve neutralizzare la texture non aggiornata');
    for (let frame = 0; frame < 10; frame++) off.controller.aoPass.updateBefore({});
    // Un solo render: quello che inizializza la render target. Prima erano 10.
    assert.equal(off.renders(), 1);
    // Il gate non restituisce false: quel valore farebbe annullare la
    // registrazione a NodeFrame, che ritenterebbe il nodo per ogni render object.
    assert.notEqual(off.controller.aoPass.updateBefore({}), false);

    const on = makeAoController();
    on.controller.setQuality(QUALITY_PROFILES.ultra);
    assert.equal(on.controller.aoPass.enabled, true);
    assert.equal(on.controller.aoPass.samples.value, QUALITY_PROFILES.ultra.gtaoSamples);
    assert.equal(on.controller.aoBlend.value, 1);
    assert.equal(on.controller.aoPass.useTemporalFiltering, true);
    for (let frame = 0; frame < 10; frame++) {
      assert.equal(on.controller.aoPass.updateBefore({}), 'renderizzato');
    }
    assert.equal(on.renders(), 10);

    // Riaccensione a caldo: riparte senza ricostruire il grafo.
    const back = makeAoController();
    back.controller.setQuality(QUALITY_PROFILES.autoLow);
    for (let frame = 0; frame < 5; frame++) back.controller.aoPass.updateBefore({});
    const spenta = back.renders();
    back.controller.setQuality(QUALITY_PROFILES.autoHigh);
    for (let frame = 0; frame < 5; frame++) back.controller.aoPass.updateBefore({});
    assert.equal(back.renders(), spenta + 5);
    assert.equal(back.controller.aoBlend.value, 1);
    // autoHigh ha 8 campioni: il filtro temporale resta acceso solo sopra 4.
    assert.equal(back.controller.aoPass.useTemporalFiltering, QUALITY_PROFILES.autoHigh.gtaoSamples > 4);
  }
});

test('la guardia di rientranza rifiuta il pass annidato, lascia passare gli altri e si riarma', () => {
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

  // Senza annidamento i pass girano normalmente, in ordine.
  const plain = [];
  const first = fakePass('normal', plain);
  const second = fakePass('scene', plain);
  guardPassReentrancy([first, second]);
  assert.equal(first.updateBefore({}), 'eseguito');
  assert.equal(second.updateBefore({}), 'eseguito');
  assert.deepEqual(plain, ['normal', 'scene']);

  // Senza il finally la guardia resterebbe alzata e spegnerebbe i pass per sempre.
  const crash = [];
  const boom = { name: 'boom', updateBefore() { crash.push('boom'); throw new Error('render fallito'); } };
  const other = fakePass('other', crash);
  guardPassReentrancy([boom, other]);
  assert.throws(() => boom.updateBefore({}), /render fallito/);
  assert.equal(other.updateBefore({}), 'eseguito');
  assert.deepEqual(crash, ['boom', 'other']);
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
