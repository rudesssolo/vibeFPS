import * as THREE from 'three';
import { max, positionGeometry, sin, smoothstep, uniform, vec3 } from 'three/tsl';
import { makeRng } from './rng.js';

const METEOR_POOL = 4;
const TRAFFIC_POOL = 18;

function makeStreakTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 16;
  const context = canvas.getContext('2d');
  const gradient = context.createLinearGradient(0, 0, canvas.width, 0);
  gradient.addColorStop(0, 'rgba(255,255,255,0)');
  gradient.addColorStop(.72, 'rgba(150,215,255,.35)');
  gradient.addColorStop(1, 'rgba(255,255,255,1)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);
  return new THREE.CanvasTexture(canvas);
}

export class AtmosphereSystem {
  constructor({ scene, timeNode = null, seed = 7301, onThunder = null } = {}) {
    this.scene = scene;
    this.timeNode = timeNode || uniform(0);
    this.random = makeRng(seed);
    this.onThunder = onThunder || (() => {});
    this.elapsed = 0;
    this.lightningFlash = 0;
    this.meteorRate = 0;
    this.trafficCount = 0;
    this._strikeTimer = this._nextStrike();
    this._strikeAge = -1;
    this._strikeLife = 0;
    this._thunderDelay = 0;
    this._thunderFired = false;
    this._meteorTimer = 8;
    this._objects = [];
    this.currentProfile = null;
    this.fxOverrides = {};
    this._buildSkyLayers();
    this._buildMeteors();
    this._buildTraffic();
  }

  _nextStrike() {
    return 18 + this.random() * 14;
  }

  _buildSkyLayers() {
    this.cloudIntensity = uniform(.35);
    const direction = positionGeometry.normalize();
    const altitude = smoothstep(.02, .18, direction.y)
      .mul(smoothstep(.28, .72, direction.y).oneMinus());
    const phaseA = sin(direction.x.mul(13).add(direction.z.mul(7)).add(this.timeNode.mul(.035)));
    const phaseB = sin(direction.x.mul(23).sub(direction.z.mul(17)).sub(this.timeNode.mul(.021))).mul(.45);
    const cloudShape = smoothstep(.18, .82, phaseA.add(phaseB).mul(.5).add(.5));
    const cloudMaterial = new THREE.MeshBasicNodeMaterial({
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      fog: false,
      blending: THREE.NormalBlending
    });
    cloudMaterial.colorNode = vec3(.15, .2, .34);
    cloudMaterial.opacityNode = cloudShape.mul(altitude).mul(this.cloudIntensity).mul(.22);
    this.clouds = new THREE.Mesh(new THREE.SphereGeometry(386, 48, 24), cloudMaterial);
    this.clouds.frustumCulled = false;
    this.scene.add(this.clouds);
    this._objects.push(this.clouds);

    this.auroraIntensity = uniform(0);
    const auroraPhase = direction.x.mul(5).add(direction.z.mul(3.2)).add(this.timeNode.mul(.22));
    const ribbons = sin(auroraPhase).add(sin(auroraPhase.mul(2.3).add(1.7)).mul(.55));
    const band = smoothstep(-.02, .1, direction.y).mul(smoothstep(.2, .58, direction.y).oneMinus());
    const green = vec3(.04, .72, .42).mul(ribbons.mul(ribbons)).mul(.5);
    const violet = vec3(.38, .18, .82).mul(max(sin(auroraPhase.mul(.7).add(2.4)).mul(ribbons), 0)).mul(.22);
    const auroraMaterial = new THREE.MeshBasicNodeMaterial({
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      fog: false,
      blending: THREE.AdditiveBlending
    });
    auroraMaterial.colorNode = green.add(violet).mul(band).mul(this.auroraIntensity);
    auroraMaterial.opacityNode = band.mul(this.auroraIntensity).mul(.72);
    this.aurora = new THREE.Mesh(new THREE.SphereGeometry(384, 48, 24), auroraMaterial);
    this.aurora.frustumCulled = false;
    this.scene.add(this.aurora);
    this._objects.push(this.aurora);
  }

  _buildMeteors() {
    this.streakTexture = makeStreakTexture();
    this.meteors = Array.from({ length: METEOR_POOL }, () => {
      const material = new THREE.SpriteMaterial({
        map: this.streakTexture,
        color: 0xccecff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
        fog: false
      });
      const mesh = new THREE.Sprite(material);
      mesh.visible = false;
      this.scene.add(mesh);
      this._objects.push(mesh);
      return { mesh, material, active: false, age: 0, life: 1, start: new THREE.Vector3(), velocity: new THREE.Vector3() };
    });
  }

  _buildTraffic() {
    const material = new THREE.MeshBasicMaterial({ color: 0x76ecff, toneMapped: false });
    const geometry = new THREE.SphereGeometry(.08, 6, 4);
    this.trafficMesh = new THREE.InstancedMesh(geometry, material, TRAFFIC_POOL);
    this.trafficMesh.count = 0;
    this.trafficMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.trafficMesh.frustumCulled = false;
    this.scene.add(this.trafficMesh);
    this._objects.push(this.trafficMesh);
    this.trafficMatrix = new THREE.Matrix4();
    this.trafficQuaternion = new THREE.Quaternion();
    this.trafficScale = new THREE.Vector3(2.8, .7, .7);
    this.trafficPosition = new THREE.Vector3();
    this.trafficAxis = new THREE.Vector3(0, 1, 0);
    this.traffic = Array.from({ length: TRAFFIC_POOL }, (_, index) => {
      return {
        angle: this.random() * Math.PI * 2,
        radius: 42 + this.random() * 22,
        height: 12 + this.random() * 26,
        speed: (.025 + this.random() * .045) * (index % 2 ? 1 : -1)
      };
    });
    this.trafficGeometry = geometry;
    this.trafficMaterial = material;
  }

  _spawnMeteor() {
    const meteor = this.meteors.find(item => !item.active);
    if (!meteor) return;
    meteor.active = true;
    meteor.age = 0;
    meteor.life = .65 + this.random() * .55;
    meteor.start.set(-110 + this.random() * 220, 100 + this.random() * 110, -180 - this.random() * 100);
    meteor.velocity.set(38 + this.random() * 35, -18 - this.random() * 24, 18 + this.random() * 30);
    meteor.mesh.position.copy(meteor.start);
    meteor.mesh.scale.set(12, .24, 1);
    meteor.mesh.material.rotation = -.35;
    meteor.mesh.visible = true;
  }

  setQuality(profile) {
    this.currentProfile = profile;
    const atmosphere = profile?.atmosphere || {};
    const city = profile?.city || {};
    this.auroraIntensity.value = Math.max(0, atmosphere.aurora || 0);
    this.aurora.visible = this.auroraIntensity.value > 0;
    this.cloudIntensity.value = Math.max(.12, Math.min(1, (atmosphere.cloudOctaves || 1) / 3));
    this.meteorRate = Math.max(0, atmosphere.meteorRate || 0);
    this.lightningEnabled = atmosphere.lightning !== 0;
    this.trafficCount = Math.max(0, Math.min(TRAFFIC_POOL, city.aerialTraffic || 0));
    this.trafficMesh.count = this.trafficCount;
    this.trafficMesh.visible = this.trafficCount > 0;
    this._applyFxOverrides();
  }

  setFxOverrides(overrides = {}) {
    this.fxOverrides = { ...this.fxOverrides, ...overrides };
    if (this.currentProfile) this.setQuality(this.currentProfile);
  }

  _applyFxOverrides() {
    if (this.fxOverrides?.atmosphere === false) {
      this.clouds.visible = false;
      this.aurora.visible = false;
      this.meteorRate = 0;
      this.lightningEnabled = false;
      this.trafficCount = 0;
      this.trafficMesh.count = 0;
      this.trafficMesh.visible = false;
    } else {
      this.clouds.visible = true;
    }
  }

  triggerLightning() {
    if (!this.lightningEnabled || this._strikeAge >= 0) return false;
    this._strikeAge = 0;
    this._thunderDelay = .4 + this.random() * .8;
    this._strikeLife = Math.max(.66, this._thunderDelay + .05);
    this._thunderFired = false;
    return true;
  }

  _lightningPulse(center, width, scale) {
    return Math.exp(-(((this._strikeAge - center) / width) ** 2)) * scale;
  }

  update(delta, elapsed) {
    const safeDelta = Number.isFinite(delta) ? Math.min(.1, Math.max(0, delta)) : 0;
    this.elapsed = Number.isFinite(elapsed) ? elapsed : this.elapsed + safeDelta;
    this.timeNode.value = this.elapsed;

    if (this.meteorRate > 0) {
      this._meteorTimer -= safeDelta;
      if (this._meteorTimer <= 0) {
        this._spawnMeteor();
        this._meteorTimer = (.55 + this.random() * .9) / this.meteorRate;
      }
    }
    for (const meteor of this.meteors) {
      if (!meteor.active) continue;
      meteor.age += safeDelta;
      meteor.mesh.position.addScaledVector(meteor.velocity, safeDelta);
      const fade = Math.sin(Math.min(1, meteor.age / meteor.life) * Math.PI);
      meteor.material.opacity = Math.max(0, fade * .9);
      if (meteor.age >= meteor.life) {
        meteor.active = false;
        meteor.mesh.visible = false;
      }
    }

    for (let i = 0; i < this.trafficCount; i++) {
      const item = this.traffic[i];
      item.angle += item.speed * safeDelta;
      this.trafficPosition.set(Math.cos(item.angle) * item.radius, item.height, Math.sin(item.angle) * item.radius);
      this.trafficQuaternion.setFromAxisAngle(this.trafficAxis, -item.angle);
      this.trafficMatrix.compose(this.trafficPosition, this.trafficQuaternion, this.trafficScale);
      this.trafficMesh.setMatrixAt(i, this.trafficMatrix);
    }
    if (this.trafficCount > 0) this.trafficMesh.instanceMatrix.needsUpdate = true;

    this.lightningFlash = 0;
    if (this.lightningEnabled && this._strikeAge < 0) {
      this._strikeTimer -= safeDelta;
      if (this._strikeTimer <= 0) {
        this.triggerLightning();
      }
    }
    if (this._strikeAge >= 0) {
      this._strikeAge += safeDelta;
      this.lightningFlash = Math.min(1,
        this._lightningPulse(.035, .045, 1)
        + this._lightningPulse(.22, .038, .52)
        + this._lightningPulse(.47, .055, .28));
      if (!this._thunderFired && this._strikeAge >= this._thunderDelay) {
        this._thunderFired = true;
        this.onThunder();
      }
      if (this._strikeAge >= this._strikeLife) {
        this._strikeAge = -1;
        this._strikeTimer = this._nextStrike();
      }
    }
    return this.lightningFlash;
  }

  reset() {
    this.lightningFlash = 0;
    this._strikeAge = -1;
    this._strikeTimer = this._nextStrike();
    this._meteorTimer = 8;
    for (const meteor of this.meteors) {
      meteor.active = false;
      meteor.mesh.visible = false;
      meteor.material.opacity = 0;
    }
  }

  dispose() {
    for (const object of this._objects) this.scene.remove(object);
    this.clouds.geometry.dispose();
    this.clouds.material.dispose();
    this.aurora.geometry.dispose();
    this.aurora.material.dispose();
    this.streakTexture.dispose();
    for (const meteor of this.meteors) meteor.material.dispose();
    this.trafficGeometry.dispose();
    this.trafficMaterial.dispose();
  }
}
