import * as THREE from 'three/webgpu';
import {
  abs,
  builtinAOContext,
  colorToDirection,
  convertToTexture,
  directionToColor,
  dot,
  float,
  fract,
  max,
  mix,
  mrt,
  normalView,
  pass,
  renderOutput,
  sample,
  screenUV,
  sin,
  smoothstep,
  uniform,
  vec2,
  vec3,
  vec4
} from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import BloomNode from 'three/addons/tsl/display/BloomNode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';

// Bloom a 1/4 della risoluzione di output: equivalente di
// `UnrealBloomPass.resolution = (window.innerWidth/4, ...)`. `setSize()` viene
// invocato da `updateBefore()` a ogni frame con la dimensione del drawing
// buffer; partiamo da width/4 invece di width/2 e scendiamo per mip, riducendo
// sensibilmente il costo dei passaggi di blur e composite.
class QuarterResolutionBloomNode extends BloomNode {
  setSize(width, height) {
    let resx = Math.max(1, Math.round(width / 4));
    let resy = Math.max(1, Math.round(height / 4));
    this._renderTargetBright.setSize(resx, resy);
    for (let i = 0; i < this._nMips; i++) {
      this._renderTargetsHorizontal[i].setSize(resx, resy);
      this._renderTargetsVertical[i].setSize(resx, resy);
      this._separableBlurMaterials[i].invSize.value.set(1 / resx, 1 / resy);
      resx = Math.max(1, Math.round(resx / 2));
      resy = Math.max(1, Math.round(resy / 2));
    }
  }
}

export class RenderPipelineController {
  constructor({ renderer, scene, camera, graphics }) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.graphics = graphics;
    this.grainTime = uniform(0);
    this.shockwaveCenter = uniform(new THREE.Vector2(.5, .5));
    this.shockwaveProgress = uniform(1);
    this.shockwaveStrength = uniform(0);
    this.aspect = uniform(window.innerWidth / Math.max(1, window.innerHeight));
    this.progress = 1;
    this.postProcessingEnabled = true;
    this.postProcessingError = null;
    // A camera pressed against the perimeter is a deliberately conservative
    // rendering case: the optional screen-space passes have very little useful
    // information there and can amplify depth precision artifacts. The game
    // keeps the base scene alive while the edge-safe material is active.
    this.edgeSafeMode = false;

    this.pipeline = new THREE.RenderPipeline(renderer);
    // outputColorTransform=false + renderOutput() esplicito (sotto): la pipeline
    // non applica conversioni implicite, mentre il nodo renderOutput() gestisce
    // da solo tone mapping e conversione nello spazio colore di output.
    this.pipeline.outputColorTransform = false;

    const normalPass = pass(scene, camera);
    normalPass.name = 'VIBE Normal Pre-Pass';
    normalPass.transparent = false;
    normalPass.setMRT(mrt({ output: directionToColor(normalView) }));

    const normalNode = sample(uvNode => colorToDirection(normalPass.getTextureNode().sample(uvNode)));
    const depthNode = normalPass.getTextureNode('depth');
    this.aoPass = ao(depthNode, normalNode, camera);
    this.aoPass.resolutionScale = .5;
    this.aoPass.useTemporalFiltering = true;
    this.applyAoSettings(graphics.gtao);

    const scenePass = pass(scene, camera);
    const aoTexture = this.aoPass.getTextureNode();
    const aoFactor = graphics.gtao.enabled
      ? mix(float(1), aoTexture.sample(screenUV).r, float(graphics.gtao.blendIntensity))
      : float(1);
    scenePass.contextNode = builtinAOContext(aoFactor);

    const sceneColor = scenePass.getTextureNode('output');
    this.bloomPass = new QuarterResolutionBloomNode(
      sceneColor,
      graphics.bloom.strength,
      graphics.bloom.radius,
      graphics.bloom.threshold
    );

    let outputNode = smaa(sceneColor.add(this.bloomPass));
    outputNode = this.addGrain(outputNode);
    outputNode = this.addCinematicGrade(outputNode);
    outputNode = this.addShockwave(outputNode);
    outputNode = this.addVignette(outputNode);
    this.pipeline.outputNode = renderOutput(outputNode);
  }

  applyAoSettings(settings) {
    this.aoPass.samples.value = settings.samples;
    this.aoPass.distanceExponent.value = settings.distanceExponent;
    this.aoPass.distanceFallOff.value = settings.distanceFallOff;
    this.aoPass.radius.value = settings.radius;
    this.aoPass.scale.value = settings.scale;
    this.aoPass.thickness.value = settings.thickness;
  }

  addGrain(inputNode) {
    if (!this.graphics.grain.enabled) return inputNode;
    const grainUv = screenUV.mul(vec2(1920, 1080));
    const noise = fract(
      sin(dot(grainUv, vec2(127.1, 311.7)).add(this.grainTime.mul(.7))).mul(43758.5453)
    ).sub(.5).mul(this.graphics.grain.amount);
    return vec4(inputNode.rgb.add(noise), inputNode.a);
  }

  addCinematicGrade(inputNode) {
    const inputTexture = convertToTexture(inputNode);
    const fromCenter = screenUV.sub(.5);
    const edge = dot(fromCenter, fromCenter);
    const shift = fromCenter.mul(float(.0012).add(edge.mul(.0022)));
    const colorValue = vec3(
      inputTexture.sample(screenUV.add(shift)).r,
      inputTexture.sample(screenUV).g,
      inputTexture.sample(screenUV.sub(shift)).b
    );
    const luma = dot(colorValue, vec3(.2126, .7152, .0722));
    let graded = mix(vec3(luma), colorValue, float(1.08));
    graded = graded.add(vec3(-.018, .006, .014).mul(smoothstep(.08, .7, luma).oneMinus()));
    graded = graded.add(vec3(.018, .004, -.012).mul(smoothstep(.55, 1, luma)));
    return vec4(graded, 1);
  }

  addShockwave(inputNode) {
    const inputTexture = convertToTexture(inputNode);
    const delta = screenUV.sub(this.shockwaveCenter);
    const scaledDelta = vec2(delta.x.mul(this.aspect), delta.y);
    const radius = scaledDelta.length();
    const ringDistance = abs(radius.sub(this.shockwaveProgress.mul(.42)));
    const ring = smoothstep(0, .055, ringDistance).oneMinus();
    const direction = scaledDelta.div(max(radius, .0001));
    const correctedDirection = vec2(direction.x.div(this.aspect), direction.y);
    const displacedUv = screenUV.sub(
      correctedDirection
        .mul(ring)
        .mul(this.shockwaveStrength)
        .mul(this.shockwaveProgress.oneMinus())
    );
    const colorValue = inputTexture.sample(displacedUv).rgb.add(
      vec3(.08, .16, .2).mul(ring).mul(this.shockwaveProgress.oneMinus())
    );
    return vec4(colorValue, 1);
  }

  addVignette(inputNode) {
    const vignetteUv = screenUV.sub(.5).mul(this.graphics.vignette.offset);
    const weight = dot(vignetteUv, vignetteUv);
    return vec4(
      mix(inputNode.rgb, vec3(1 - this.graphics.vignette.darkness), weight),
      inputNode.a
    );
  }

  triggerShockwave(worldPosition) {
    if (!worldPosition
      || !Number.isFinite(worldPosition.x)
      || !Number.isFinite(worldPosition.y)
      || !Number.isFinite(worldPosition.z)) return;
    const projected = worldPosition.clone().project(this.camera);
    if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y)) return;
    this.shockwaveCenter.value.set(projected.x * .5 + .5, -projected.y * .5 + .5);
    this.shockwaveProgress.value = 0;
    this.shockwaveStrength.value = .032;
    this.progress = 0;
  }

  reset() {
    this.progress = 1;
    this.shockwaveProgress.value = 1;
    this.shockwaveStrength.value = 0;
  }

  setQuality(profile) {
    this.aoPass.samples.value = profile.gtaoSamples;
  }

  setEdgeSafeMode(enabled) {
    this.edgeSafeMode = Boolean(enabled);
  }

  resize(width, height) {
    this.aspect.value = width / Math.max(1, height);
  }

  render(delta, elapsed) {
    const safeDelta = Number.isFinite(delta) ? Math.min(Math.max(delta, 0), .1) : 0;
    const safeElapsed = Number.isFinite(elapsed) ? elapsed : 0;
    this.grainTime.value = safeElapsed;
    if (this.progress < 1) {
      this.progress = Math.min(1, this.progress + safeDelta / .56);
      this.shockwaveProgress.value = this.progress;
      this.shockwaveStrength.value = .032 * (1 - this.progress);
    }
    if (this.edgeSafeMode || !this.postProcessingEnabled) {
      this.renderBaseScene();
      return;
    }

    try {
      this.pipeline.render();
    } catch (error) {
      // A shader/resource failure must not stop gameplay. Keep the normal
      // scene render alive and permanently bypass only the optional post chain
      // for this renderer instance; the next page load can retry compilation.
      this.postProcessingEnabled = false;
      this.postProcessingError = error;
      console.error('VIBE post-processing disabled', error);
      this.renderBaseScene();
    }
  }

  renderBaseScene() {
    // A failed post pass may leave an intermediate target/MRT selected. Reset
    // both before drawing to the visible canvas.
    this.renderer.setRenderTarget(null);
    this.renderer.setMRT?.(null);
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.aoPass.dispose?.();
    this.bloomPass.dispose?.();
    this.pipeline.dispose?.();
  }
}
