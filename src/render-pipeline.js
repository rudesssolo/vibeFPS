import * as THREE from 'three/webgpu';
import {
  abs,
  builtinAOContext,
  colorToDirection,
  convertToTexture,
  directionToColor,
  dot,
  exp,
  float,
  fract,
  length,
  max,
  min,
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

const PERSISTENT_FAILURE_FRAMES = 60;

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
  constructor({ renderer, scene, camera, graphics, onPersistentFailure = null }) {
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
    this.postProcessingError = null;
    this.consecutivePostProcessingErrors = 0;
    this.persistentFailureReported = false;
    this.onPersistentFailure = onPersistentFailure || (() => {});
    this.currentProfile = null;
    this.fxOverrides = {};
    this.gradeSaturation = uniform(1.04);
    this.gradeVibrance = uniform(.1);
    this.gradeAmount = uniform(1);
    this.lightningFlash = uniform(0);
    this.grainAmount = uniform(graphics.grain.amount);
    this.vignetteDarkness = uniform(graphics.vignette.darkness);
    this.flareStrength = uniform(0);
    this.flareIntensity = uniform(0);
    this.flareCenter = uniform(new THREE.Vector2(.5, .5));
    this.flareTint = uniform(new THREE.Color(0xb9d5ff));
    this.flares = Array.from({ length: 12 }, () => ({
      active: false,
      center: new THREE.Vector2(.5, .5),
      color: new THREE.Color(0xffffff),
      intensity: 0,
      age: 0,
      life: .45
    }));
    this.flareCursor = 0;
    this._flareBlendColor = new THREE.Color(0, 0, 0);
    this._moonWorld = graphics?.lights?.moon?.pos
      ? new THREE.Vector3(...graphics.lights.moon.pos).normalize().multiplyScalar(350)
      : null;
    this.heatScale = uniform(0);
    this.heatSlotLimit = 0;
    this.heatSlots = Array.from({ length: 4 }, () => ({
      center: uniform(new THREE.Vector2(.5, .5)),
      strength: uniform(0),
      radius: uniform(28),
      peak: 0,
      age: 0,
      life: .5
    }));

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

    let outputNode = sceneColor.add(this.bloomPass);
    outputNode = this.addHeatHaze(outputNode);
    outputNode = this.addShockwave(outputNode);
    outputNode = this.addLensFlare(outputNode);
    outputNode = this.addCinematicGrade(outputNode);
    outputNode = smaa(outputNode);
    outputNode = this.addGrain(outputNode);
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
    ).sub(.5).mul(this.grainAmount);
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
    let graded = mix(vec3(luma), colorValue, this.gradeSaturation);
    graded = graded.add(vec3(-.018, .006, .014).mul(smoothstep(.08, .7, luma).oneMinus()));
    graded = graded.add(vec3(.018, .004, -.012).mul(smoothstep(.55, 1, luma)));
    const gradedLuma = dot(graded, vec3(.2126, .7152, .0722));
    const saturationMask = max(graded.x, max(graded.y, graded.z)).sub(
      min(graded.x, min(graded.y, graded.z))
    );
    graded = mix(graded, mix(vec3(gradedLuma), graded, float(1.18)),
      saturationMask.mul(this.gradeVibrance).clamp(0, 1));
    graded = mix(colorValue, graded, this.gradeAmount);
    graded = graded.add(vec3(.48, .62, 1).mul(this.lightningFlash).mul(.18));
    return vec4(graded, 1);
  }

  addHeatHaze(inputNode) {
    const inputTexture = convertToTexture(inputNode);
    const slotOffset = slot => {
      const delta = screenUV.sub(slot.center);
      const distance = length(delta);
      const direction = delta.div(max(distance, float(.002)));
      const envelope = exp(distance.mul(distance).mul(slot.radius.negate()));
      const shimmer = sin(screenUV.y.mul(73).add(this.grainTime.mul(8.3)))
        .mul(sin(screenUV.x.mul(61).sub(this.grainTime.mul(6.7))))
        .mul(.35).add(1);
      return direction.mul(envelope).mul(slot.strength).mul(shimmer);
    };
    const offset = slotOffset(this.heatSlots[0])
      .add(slotOffset(this.heatSlots[1]))
      .add(slotOffset(this.heatSlots[2]))
      .add(slotOffset(this.heatSlots[3]));
    const uv = screenUV.add(offset.mul(this.heatScale).mul(.009)).clamp(0, 1);
    return vec4(inputTexture.sample(uv).rgb, 1);
  }

  addLensFlare(inputNode) {
    const delta = screenUV.sub(this.flareCenter);
    const radial = smoothstep(.018, .085, length(delta)).oneMinus();
    const horizontal = smoothstep(.004, .026, abs(delta.y)).oneMinus()
      .mul(smoothstep(.02, .34, abs(delta.x)).oneMinus());
    const mirrored = screenUV.sub(vec2(1).sub(this.flareCenter));
    const ghost = smoothstep(.018, .065, length(mirrored)).oneMinus().mul(.32);
    const flare = this.flareTint
      .mul(radial.mul(.72).add(horizontal.mul(.22)).add(ghost))
      .mul(this.flareIntensity)
      .mul(this.flareStrength)
      .clamp(0, 1.5);
    return vec4(inputNode.rgb.add(flare), inputNode.a);
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
      mix(inputNode.rgb, vec3(1).sub(this.vignetteDarkness), weight),
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

  _projectWorldPosition(worldPosition) {
    if (!worldPosition
      || !Number.isFinite(worldPosition.x)
      || !Number.isFinite(worldPosition.y)
      || !Number.isFinite(worldPosition.z)) return null;
    const projected = worldPosition.clone().project(this.camera);
    if (!Number.isFinite(projected.x)
      || !Number.isFinite(projected.y)
      || !Number.isFinite(projected.z)
      || projected.z < -1 || projected.z > 1
      || Math.abs(projected.x) > 1.2 || Math.abs(projected.y) > 1.2) return null;
    return projected;
  }

  triggerLensFlare(worldPosition, intensity = 1, colorHex = 0xffffff, life = .45) {
    const projected = this._projectWorldPosition(worldPosition);
    if (!projected) return false;
    let flare = this.flares.find(item => !item.active);
    if (!flare) flare = this.flares[this.flareCursor++ % this.flares.length];
    flare.active = true;
    flare.center.set(projected.x * .5 + .5, -projected.y * .5 + .5);
    flare.color.set(colorHex);
    flare.intensity = Math.min(2, Math.max(0, intensity));
    flare.age = 0;
    flare.life = Math.max(.05, life);
    return true;
  }

  triggerHeatHaze(worldPosition, strength = 1, radius = 28, life = .5) {
    if (this.heatSlotLimit <= 0) return false;
    const projected = this._projectWorldPosition(worldPosition);
    if (!projected) return false;
    let slot = this.heatSlots[0];
    for (let i = 1; i < this.heatSlotLimit; i++) {
      if (this.heatSlots[i].strength.value < slot.strength.value) slot = this.heatSlots[i];
    }
    slot.center.value.set(projected.x * .5 + .5, -projected.y * .5 + .5);
    slot.peak = Math.min(1.2, Math.max(0, strength));
    slot.strength.value = slot.peak;
    slot.radius.value = Math.max(4, radius);
    slot.age = 0;
    slot.life = Math.max(.05, life);
    return true;
  }

  setLightningFlash(intensity) {
    this.lightningFlash.value = Math.min(1, Math.max(0, Number.isFinite(intensity) ? intensity : 0));
  }

  _updateOptics(delta) {
    // Some recovery-path tests instantiate only the render-loop surface of the
    // controller. Optical state is optional in that deliberately partial form.
    if (!this.flares || !this.heatSlots || !this.flareIntensity) return;
    let weight = 0;
    let x = 0;
    let y = 0;
    const tint = this._flareBlendColor;
    tint.setRGB(0, 0, 0);
    if (this._moonWorld) {
      const moon = this._projectWorldPosition(this._moonWorld);
      if (moon) {
        const moonWeight = .35;
        x += (moon.x * .5 + .5) * moonWeight;
        y += (-moon.y * .5 + .5) * moonWeight;
        tint.r += .7 * moonWeight;
        tint.g += .82 * moonWeight;
        tint.b += 1 * moonWeight;
        weight += moonWeight;
      }
    }
    for (let i = this.flares.length - 1; i >= 0; i--) {
      const flare = this.flares[i];
      if (!flare.active) continue;
      flare.age += delta;
      if (flare.age >= flare.life) { flare.active = false; continue; }
      const contribution = flare.intensity * (1 - flare.age / flare.life);
      x += flare.center.x * contribution;
      y += flare.center.y * contribution;
      tint.r += flare.color.r * contribution;
      tint.g += flare.color.g * contribution;
      tint.b += flare.color.b * contribution;
      weight += contribution;
    }
    if (weight > 0) {
      this.flareCenter.value.set(x / weight, y / weight);
      this.flareTint.value.setRGB(tint.r / weight, tint.g / weight, tint.b / weight);
      this.flareIntensity.value = Math.min(1.5, weight);
    } else {
      this.flareIntensity.value = 0;
    }
    for (const slot of this.heatSlots) {
      if (slot.strength.value <= 0) continue;
      slot.age += delta;
      slot.strength.value = slot.peak * Math.max(0, 1 - slot.age / slot.life);
    }
  }

  reset() {
    this.progress = 1;
    this.shockwaveProgress.value = 1;
    this.shockwaveStrength.value = 0;
    for (const flare of this.flares) {
      flare.active = false;
      flare.age = 0;
    }
    this.flareIntensity.value = 0;
    for (const slot of this.heatSlots) {
      slot.strength.value = 0;
      slot.peak = 0;
      slot.age = 0;
    }
    this.postProcessingError = null;
    this.consecutivePostProcessingErrors = 0;
    this.persistentFailureReported = false;
  }

  setQuality(profile) {
    if (!profile) return;
    this.currentProfile = profile;
    this.aoPass.samples.value = profile.gtaoSamples;
    const post = profile.post || {};
    this.flareStrength.value = post.flare ?? 0;
    this.heatScale.value = post.heatHaze ?? 0;
    this.heatSlotLimit = Math.max(0, Math.min(this.heatSlots.length, post.distortionSlots ?? 0));
    this.grainAmount.value = post.grain ?? this.graphics.grain.amount;
    this.vignetteDarkness.value = post.vignette ?? this.graphics.vignette.darkness;
    this.gradeSaturation.value = post.saturation ?? 1.04;
    this.gradeVibrance.value = post.vibrance ?? .1;
    this.gradeAmount.value = 1;
    for (let i = this.heatSlotLimit; i < this.heatSlots.length; i++) {
      this.heatSlots[i].strength.value = 0;
      this.heatSlots[i].peak = 0;
    }
    this._applyFxOverrides();
  }

  setFxOverrides(overrides = {}) {
    this.fxOverrides = { ...this.fxOverrides, ...overrides };
    if (this.currentProfile) this.setQuality(this.currentProfile);
  }

  _applyFxOverrides() {
    if (this.fxOverrides.flare === false) this.flareStrength.value = 0;
    if (this.fxOverrides.heatHaze === false) {
      this.heatScale.value = 0;
      for (const slot of this.heatSlots) slot.strength.value = 0;
    }
    if (this.fxOverrides.grain === false) this.grainAmount.value = 0;
    if (this.fxOverrides.vignette === false) this.vignetteDarkness.value = 0;
    if (this.fxOverrides.grade === false) this.gradeAmount.value = 0;
  }

  resize(width, height) {
    this.aspect.value = width / Math.max(1, height);
  }

  render(delta, elapsed) {
    const safeDelta = Number.isFinite(delta) ? Math.min(Math.max(delta, 0), .1) : 0;
    const safeElapsed = Number.isFinite(elapsed) ? elapsed : 0;
    this.grainTime.value = safeElapsed;
    this._updateOptics(safeDelta);
    if (this.progress < 1) {
      this.progress = Math.min(1, this.progress + safeDelta / .56);
      this.shockwaveProgress.value = this.progress;
      this.shockwaveStrength.value = .032 * (1 - this.progress);
    }
    // RenderPipeline.render() temporarily changes these renderer properties.
    // Three.js restores them only on its success path, so an exception would
    // otherwise leak NoToneMapping/working color space into every later frame.
    const rendererState = {
      toneMapping: this.renderer.toneMapping,
      outputColorSpace: this.renderer.outputColorSpace,
      xrEnabled: this.renderer.xr?.enabled
    };
    let renderError = null;
    try {
      this.pipeline.render();
    } catch (error) {
      renderError = error;
    } finally {
      this.renderer.toneMapping = rendererState.toneMapping;
      this.renderer.outputColorSpace = rendererState.outputColorSpace;
      if (this.renderer.xr && rendererState.xrEnabled !== undefined) {
        this.renderer.xr.enabled = rendererState.xrEnabled;
      }
    }

    if (!renderError) {
      this.postProcessingError = null;
      this.consecutivePostProcessingErrors = 0;
      this.persistentFailureReported = false;
      return true;
    }

    // A transient resize/compilation failure must not latch the game into the
    // visually darker raw renderer. Leave the last complete canvas frame in
    // place, reset leaked targets, and retry the normal pipeline next frame.
    this.postProcessingError = renderError;
    this.consecutivePostProcessingErrors++;
    this.renderer.setRenderTarget(null);
    this.renderer.setMRT?.(null);
    if (this.consecutivePostProcessingErrors === 1) {
      console.error('VIBE post-processing frame skipped; retrying', renderError);
    }
    if (this.consecutivePostProcessingErrors >= PERSISTENT_FAILURE_FRAMES
      && !this.persistentFailureReported) {
      this.persistentFailureReported = true;
      this.onPersistentFailure(renderError);
    }
    return false;
  }

  dispose() {
    this.aoPass.dispose?.();
    this.bloomPass.dispose?.();
    this.pipeline.dispose?.();
  }
}
