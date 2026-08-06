import * as THREE from 'three';
import { makeRng } from './rng.js';

const MAX_RAIN = 2200;
const MAX_SPLASHES = 32;
const MAX_RIPPLES = 24;
const MAX_FOG_BANKS = 12;
// Scie volutamente minute: la pioggia deve dare profondità alla scena senza
// creare una cortina luminosa davanti a mirino e bersagli.
const RAIN_STREAK_OPACITY = .075;
const RAIN_STREAK_BASE_LENGTH = .16;
const RAIN_STREAK_SPEED_LENGTH = .006;
const RAIN_STREAK_WIND = .035;

function radialTexture(size = 64, ring = false) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const context = canvas.getContext('2d');
  const gradient = context.createRadialGradient(size / 2, size / 2, ring ? size * .28 : 0, size / 2, size / 2, size / 2);
  if (ring) {
    gradient.addColorStop(0, 'rgba(255,255,255,0)');
    gradient.addColorStop(.45, 'rgba(255,255,255,.9)');
    gradient.addColorStop(.62, 'rgba(255,255,255,.18)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
  } else {
    gradient.addColorStop(0, 'rgba(255,255,255,.8)');
    gradient.addColorStop(.35, 'rgba(255,255,255,.3)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
  }
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

function rippleNormalTexture(size = 128) {
  const random = makeRng(4411);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const context = canvas.getContext('2d');
  context.fillStyle = 'rgb(128,128,255)';
  context.fillRect(0, 0, size, size);
  for (let i = 0; i < 18; i++) {
    const x = random() * size;
    const y = random() * size;
    const radius = 4 + random() * 15;
    context.strokeStyle = i % 2 ? 'rgb(148,116,250)' : 'rgb(108,142,250)';
    context.globalAlpha = .22;
    context.lineWidth = 1 + random() * 1.5;
    context.beginPath();
    context.ellipse(x, y, radius, radius * .55, random() * Math.PI, 0, Math.PI * 2);
    context.stroke();
  }
  context.globalAlpha = 1;
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(3, 3);
  return texture;
}

export class WeatherSystem {
  constructor({ scene, floorSize = 48, height = 18, seed = 9917 } = {}) {
    this.scene = scene;
    this.floorSize = floorSize;
    this.height = height;
    this.spread = floorSize * .52;
    this.random = makeRng(seed);
    this.rainCount = 0;
    this.splashLimit = 0;
    this.rippleLimit = 0;
    this.fogLimit = 0;
    this.wetness = .72;
    this.wetMaterials = [];
    this._objects = [];
    this.currentProfile = null;
    this.fxOverrides = {};
    this._buildRain();
    this._buildImpacts();
    this._buildFogBanks();
    this.wetNormalTexture = rippleNormalTexture();
  }

  _buildRain() {
    this.rainPositions = new Float32Array(MAX_RAIN * 3);
    this.rainVelocity = new Float32Array(MAX_RAIN);
    this.linePositions = new Float32Array(MAX_RAIN * 6);
    for (let i = 0; i < MAX_RAIN; i++) {
      this._resetDrop(i, this.random() * this.height);
      this._writeDrop(i);
    }
    this.lineGeometry = new THREE.BufferGeometry();
    this.lineGeometry.setAttribute('position', new THREE.BufferAttribute(this.linePositions, 3).setUsage(THREE.DynamicDrawUsage));
    this.lineGeometry.setDrawRange(0, 0);
    this.lineMaterial = new THREE.LineBasicMaterial({
      color: 0x7890aa,
      transparent: true,
      opacity: RAIN_STREAK_OPACITY,
      blending: THREE.NormalBlending,
      depthWrite: false
    });
    this.lines = new THREE.LineSegments(this.lineGeometry, this.lineMaterial);
    this.lines.frustumCulled = false;
    this.scene.add(this.lines);
    this._objects.push(this.lines);
  }

  _buildImpacts() {
    this.splashTexture = radialTexture(64);
    this.rippleTexture = radialTexture(64, true);
    this.splashes = Array.from({ length: MAX_SPLASHES }, () => {
      const material = new THREE.SpriteMaterial({
        map: this.splashTexture,
        color: 0xbce7ff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      });
      const mesh = new THREE.Sprite(material);
      mesh.visible = false;
      this.scene.add(mesh);
      this._objects.push(mesh);
      return { mesh, material, active: false, age: 0, life: .2 };
    });
    this.ripples = Array.from({ length: MAX_RIPPLES }, () => {
      const material = new THREE.MeshBasicMaterial({
        map: this.rippleTexture,
        color: 0x89ceff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
      mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      this.scene.add(mesh);
      this._objects.push(mesh);
      return { mesh, material, active: false, age: 0, life: .55 };
    });
  }

  _buildFogBanks() {
    this.fogTexture = radialTexture(128);
    this.fogBanks = Array.from({ length: MAX_FOG_BANKS }, (_, index) => {
      const material = new THREE.SpriteMaterial({
        map: this.fogTexture,
        color: index % 3 ? 0x46556f : 0x71465f,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.NormalBlending,
        fog: true
      });
      const mesh = new THREE.Sprite(material);
      const angle = this.random() * Math.PI * 2;
      const radius = 8 + this.random() * 13;
      mesh.position.set(Math.cos(angle) * radius, .45 + this.random() * .65, Math.sin(angle) * radius);
      mesh.scale.set(8 + this.random() * 7, 2 + this.random() * 2.2, 1);
      mesh.visible = false;
      this.scene.add(mesh);
      this._objects.push(mesh);
      return { mesh, material, phase: this.random() * Math.PI * 2, drift: .08 + this.random() * .1 };
    });
  }

  _resetDrop(index, y = this.height) {
    const offset = index * 3;
    this.rainPositions[offset] = (this.random() * 2 - 1) * this.spread;
    this.rainPositions[offset + 1] = y;
    this.rainPositions[offset + 2] = (this.random() * 2 - 1) * this.spread;
    this.rainVelocity[index] = 15 + this.random() * 9;
  }

  _writeDrop(index) {
    const source = index * 3;
    const target = index * 6;
    const wind = RAIN_STREAK_WIND;
    const length = RAIN_STREAK_BASE_LENGTH + this.rainVelocity[index] * RAIN_STREAK_SPEED_LENGTH;
    this.linePositions[target] = this.rainPositions[source];
    this.linePositions[target + 1] = this.rainPositions[source + 1];
    this.linePositions[target + 2] = this.rainPositions[source + 2];
    this.linePositions[target + 3] = this.rainPositions[source] - wind;
    this.linePositions[target + 4] = this.rainPositions[source + 1] + length;
    this.linePositions[target + 5] = this.rainPositions[source + 2] + wind * .35;
  }

  registerWetMaterial(material, { dryRoughness = material?.roughness ?? .5, wetRoughness = .16, animatedNormal = false } = {}) {
    if (!material) return;
    if (animatedNormal) {
      material.normalMap = this.wetNormalTexture;
      material.normalScale = new THREE.Vector2(.18, .18);
    }
    this.wetMaterials.push({ material, dryRoughness, wetRoughness, animatedNormal });
    this._applyWetness();
  }

  _applyWetness() {
    for (const entry of this.wetMaterials) {
      entry.material.roughness = THREE.MathUtils.lerp(entry.dryRoughness, entry.wetRoughness, this.wetness);
      if ('clearcoat' in entry.material) entry.material.clearcoat = Math.max(entry.material.clearcoat || 0, this.wetness * .72);
      entry.material.needsUpdate = true;
    }
  }

  setQuality(profile) {
    this.currentProfile = profile;
    const atmosphere = profile?.atmosphere || {};
    this.rainCount = Math.max(0, Math.min(MAX_RAIN, Math.round(atmosphere.rainStreaks || 0)));
    this.splashLimit = Math.max(0, Math.min(MAX_SPLASHES, atmosphere.splashes || 0));
    this.rippleLimit = Math.max(0, Math.min(MAX_RIPPLES, atmosphere.ripples || 0));
    this.fogLimit = Math.max(0, Math.min(MAX_FOG_BANKS, atmosphere.fogBanks || 0));
    this.wetness = Math.max(0, Math.min(1, profile?.city?.wetDetail ?? .72));
    this.lineGeometry.setDrawRange(0, this.rainCount * 2);
    this.lines.visible = this.rainCount > 0;
    this.fogBanks.forEach((bank, index) => { bank.mesh.visible = index < this.fogLimit; });
    for (let i = this.splashLimit; i < this.splashes.length; i++) this._hideImpact(this.splashes[i]);
    for (let i = this.rippleLimit; i < this.ripples.length; i++) this._hideImpact(this.ripples[i]);
    this._applyWetness();
    this._applyFxOverrides();
  }

  setFxOverrides(overrides = {}) {
    this.fxOverrides = { ...this.fxOverrides, ...overrides };
    if (this.currentProfile) this.setQuality(this.currentProfile);
  }

  _applyFxOverrides() {
    if (this.fxOverrides?.weather === false) {
      this.lines.visible = false;
      this.fogLimit = 0;
      this.splashLimit = 0;
      this.rippleLimit = 0;
      for (const bank of this.fogBanks) bank.mesh.visible = false;
      for (const item of [...this.splashes, ...this.ripples]) this._hideImpact(item);
    }
  }

  _hideImpact(item) {
    item.active = false;
    item.mesh.visible = false;
    item.material.opacity = 0;
  }

  _spawnImpact(pool, limit, x, z) {
    if (limit <= 0) return;
    let item = null;
    for (let i = 0; i < limit; i++) {
      if (!pool[i].active) { item = pool[i]; break; }
    }
    if (!item) return;
    item.active = true;
    item.age = 0;
    item.mesh.visible = true;
    item.mesh.position.set(x, .075, z);
    item.mesh.scale.setScalar(.12);
    item.material.opacity = .8;
  }

  _updateImpactPool(pool, limit, ripple, delta) {
    for (let i = 0; i < limit; i++) {
      const item = pool[i];
      if (!item.active) continue;
      item.age += delta;
      const progress = Math.min(1, item.age / item.life);
      item.material.opacity = Math.sin(progress * Math.PI) * (ripple ? .38 : .72);
      item.mesh.scale.setScalar((ripple ? .18 : .1) + progress * (ripple ? 1.6 : .48));
      if (progress >= 1) this._hideImpact(item);
    }
  }

  update(delta, elapsed) {
    const safeDelta = Number.isFinite(delta) ? Math.min(.1, Math.max(0, delta)) : 0;
    this.wetNormalTexture.offset.set((elapsed * .007) % 1, (elapsed * .011) % 1);
    if (this.rainCount === 0 && this.fogLimit === 0) {
      this._updateImpactPool(this.splashes, this.splashLimit, false, safeDelta);
      this._updateImpactPool(this.ripples, this.rippleLimit, true, safeDelta);
      return;
    }
    // Precompute drift factors once per frame; per-drop trig still needed but
    // uses cheaper incremental sway (one sin/cos per 8 drops via batching).
    const sinSway = Math.sin(elapsed * 0.31);
    const cosSway = Math.cos(elapsed * 0.27);
    for (let i = 0; i < this.rainCount; i++) {
      const offset = i * 3;
      this.rainPositions[offset + 1] -= this.rainVelocity[i] * safeDelta;
      // Reduced trig: only every 4th drop computes per-drop phase; others use
      // frame-level sway scaled by index hash for variation.
      const swayPhase = (i & 3) === 0 ? Math.sin(elapsed * 1.3 + i * 0.37) * .32 : sinSway * (.12 + (i % 7) * .018);
      const swayZ = (i & 3) === 0 ? Math.cos(elapsed * .9 + i * .22) * .2 : cosSway * (.08 + (i % 5) * .012);
      this.rainPositions[offset] += swayPhase * safeDelta;
      this.rainPositions[offset + 2] += swayZ * safeDelta;
      if (this.rainPositions[offset + 1] < 0) {
        if (i % 17 === 0) this._spawnImpact(this.splashes, this.splashLimit, this.rainPositions[offset], this.rainPositions[offset + 2]);
        if (i % 29 === 0) this._spawnImpact(this.ripples, this.rippleLimit, this.rainPositions[offset], this.rainPositions[offset + 2]);
        this._resetDrop(i);
      }
      this._writeDrop(i);
    }
    if (this.rainCount > 0) this.lineGeometry.attributes.position.needsUpdate = true;

    this._updateImpactPool(this.splashes, this.splashLimit, false, safeDelta);
    this._updateImpactPool(this.ripples, this.rippleLimit, true, safeDelta);

    for (let i = 0; i < this.fogLimit; i++) {
      const bank = this.fogBanks[i];
      // Batch fog drift: single sin/cos per frame scaled by phase
      bank.mesh.position.x += sinSway * Math.cos(bank.phase) * bank.drift * safeDelta * 1.8;
      bank.mesh.position.z += cosSway * Math.sin(bank.phase) * bank.drift * safeDelta * 1.8;
      if ((i & 3) === 0) bank.material.opacity = .032 + Math.sin(elapsed * .17 + bank.phase) * .012;
    }
  }

  reset() {
    for (let i = 0; i < MAX_RAIN; i++) {
      this._resetDrop(i, this.random() * this.height);
      this._writeDrop(i);
    }
    for (const item of [...this.splashes, ...this.ripples]) this._hideImpact(item);
  }

  dispose() {
    for (const object of this._objects) this.scene.remove(object);
    this.lineGeometry.dispose();
    this.lineMaterial.dispose();
    this.splashTexture.dispose();
    this.rippleTexture.dispose();
    this.fogTexture.dispose();
    this.wetNormalTexture.dispose();
    for (const item of this.splashes) item.material.dispose();
    for (const item of this.ripples) { item.mesh.geometry.dispose(); item.material.dispose(); }
    for (const bank of this.fogBanks) bank.material.dispose();
  }
}
