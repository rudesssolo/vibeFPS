import test from 'node:test';
import assert from 'node:assert/strict';
import { RenderPipelineController } from '../src/render-pipeline.js';

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
