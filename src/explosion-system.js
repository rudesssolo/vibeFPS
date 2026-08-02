import * as THREE from 'three';
import { instancedBufferAttribute, smoothstep, uv } from 'three/tsl';

const MAX_ADDITIVE = 720;
const MAX_SMOKE = 360;
const MAX_DEBRIS = 144;
const MAX_SHOCKWAVES = 12;

class ParticlePool {
  constructor(scene, maximum, blending) {
    this.maximum = maximum;
    this.particles = Array.from({ length: maximum }, () => ({
      active: false,
      position: new THREE.Vector3(0, -999, 0),
      velocity: new THREE.Vector3(),
      color: new THREE.Color(),
      age: 0,
      life: 1,
      delay: 0,
      sizeStart: 1,
      sizeEnd: 1,
      gravity: 0,
      drag: 0
    }));
    this.cursor = 0;
    this.positions = new Float32Array(maximum * 3);
    this.colors = new Float32Array(maximum * 3);
    this.sizes = new Float32Array(maximum);
    this.opacities = new Float32Array(maximum);
    this.activeCount = 0;
    const positionAttribute = new THREE.InstancedBufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage);
    const colorAttribute = new THREE.InstancedBufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage);
    const sizeAttribute = new THREE.InstancedBufferAttribute(this.sizes, 1).setUsage(THREE.DynamicDrawUsage);
    const opacityAttribute = new THREE.InstancedBufferAttribute(this.opacities, 1).setUsage(THREE.DynamicDrawUsage);
    this.attributes = [positionAttribute, colorAttribute, sizeAttribute, opacityAttribute];

    const pointUv = uv().sub(.5);
    const distance = pointUv.length().mul(2);
    const core = smoothstep(.12, 1, distance).oneMinus();
    const halo = smoothstep(.42, 1, distance).oneMinus();
    const radialOpacity = core.mul(.72).add(halo.mul(.28));
    const material = new THREE.PointsNodeMaterial({
      positionNode: instancedBufferAttribute(positionAttribute),
      colorNode: instancedBufferAttribute(colorAttribute),
      // Gli sprite WebGPU non hanno il limite hardware di gl_PointSize: una
      // scala in unità prospettiche evita quad grandi migliaia di pixel.
      sizeNode: instancedBufferAttribute(sizeAttribute).mul(.065),
      opacityNode: radialOpacity.mul(instancedBufferAttribute(opacityAttribute)),
      sizeAttenuation: true,
      transparent: true,
      depthWrite: false,
      blending,
      toneMapped: false,
      alphaTest: .003,
      alphaToCoverage: true
    });
    this.points = new THREE.Sprite(material);
    this.points.count = maximum;
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  spawn(options) {
    let particle = null;
    for (let search = 0; search < this.maximum; search++) {
      const index = (this.cursor + search) % this.maximum;
      if (!this.particles[index].active) {
        particle = this.particles[index];
        this.cursor = (index + 1) % this.maximum;
        break;
      }
    }
    if (!particle) {
      particle = this.particles[this.cursor];
      this.cursor = (this.cursor + 1) % this.maximum;
    }
    if (!particle.active) this.activeCount++;
    particle.active = true;
    particle.position.copy(options.position);
    particle.velocity.copy(options.velocity || new THREE.Vector3());
    particle.color.set(options.color || 0xffffff);
    particle.age = -(options.delay || 0);
    particle.life = options.life || 1;
    particle.sizeStart = options.sizeStart || 1;
    particle.sizeEnd = options.sizeEnd ?? particle.sizeStart;
    particle.gravity = options.gravity || 0;
    particle.drag = options.drag || 0;
  }

  update(delta, smoke = false) {
    if (this.activeCount === 0) return;
    for (let i = 0; i < this.maximum; i++) {
      const particle = this.particles[i];
      const offset = i * 3;
      if (!particle.active) {
        this.positions[offset + 1] = -999;
        this.opacities[i] = 0;
        continue;
      }
      particle.age += delta;
      if (particle.age < 0) {
        this.opacities[i] = 0;
        continue;
      }
      const t = Math.min(1, particle.age / particle.life);
      particle.velocity.multiplyScalar(Math.max(0, 1 - particle.drag * delta));
      particle.velocity.y -= particle.gravity * delta;
      particle.position.addScaledVector(particle.velocity, delta);
      this.positions[offset] = particle.position.x;
      this.positions[offset + 1] = particle.position.y;
      this.positions[offset + 2] = particle.position.z;
      this.colors[offset] = particle.color.r;
      this.colors[offset + 1] = particle.color.g;
      this.colors[offset + 2] = particle.color.b;
      this.sizes[i] = THREE.MathUtils.lerp(particle.sizeStart, particle.sizeEnd, t);
      this.opacities[i] = smoke ? Math.sin(Math.PI * t) * .52 : (1 - t) ** 1.5;
      if (t >= 1) {
        particle.active = false;
        this.activeCount--;
      }
    }
    for (const attribute of this.attributes) attribute.needsUpdate = true;
  }
}

export class ExplosionSystem {
  constructor({ scene, onShockwave, onCameraImpulse }) {
    this.scene = scene;
    this.onShockwave = onShockwave || (() => {});
    this.onCameraImpulse = onCameraImpulse || (() => {});
    this.additive = new ParticlePool(scene, MAX_ADDITIVE, THREE.AdditiveBlending);
    this.smoke = new ParticlePool(scene, MAX_SMOKE, THREE.NormalBlending);
    this.particleScale = .72;
    this.lightLimit = 4;
    this.debris = Array.from({ length: MAX_DEBRIS }, () => ({
      active: false,
      position: new THREE.Vector3(0, -999, 0),
      velocity: new THREE.Vector3(),
      rotation: new THREE.Euler(),
      angular: new THREE.Vector3(),
      age: 0,
      life: 1,
      scale: 1
    }));
    this.debrisCursor = 0;
    this.activeDebris = 0;
    this.debrisMesh = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(.11, 0),
      new THREE.MeshStandardMaterial({ color: 0x59636d, metalness: .9, roughness: .32, envMapIntensity: 1.4 }),
      MAX_DEBRIS
    );
    this.debrisMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.debrisMesh.frustumCulled = false;
    scene.add(this.debrisMesh);
    this.matrix = new THREE.Matrix4();
    this.quaternion = new THREE.Quaternion();
    this.scaleVector = new THREE.Vector3();
    this.scaleVector.setScalar(0);
    for (let i = 0; i < MAX_DEBRIS; i++) {
      this.matrix.compose(this.debris[i].position, this.quaternion, this.scaleVector);
      this.debrisMesh.setMatrixAt(i, this.matrix);
    }
    this.debrisMesh.instanceMatrix.needsUpdate = true;

    this.shockwaves = [];
    this.warmupPending = true;
    for (let i = 0; i < MAX_SHOCKWAVES; i++) {
      const material = new THREE.MeshBasicMaterial({ color: 0x8df7ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(new THREE.RingGeometry(.28, .43, 42), material);
      // Resta nel render graph con opacity 0: così la pipeline non viene compilata
      // durante la prima esplosione, causando uno stallo visibile.
      mesh.visible = true;
      scene.add(mesh);
      this.shockwaves.push({ mesh, material, active: false, age: 0, life: .55 });
    }

    this.lights = [];
    for (let i = 0; i < 8; i++) {
      const light = new THREE.PointLight(0xffa05c, 0, 18, 2);
      light.visible = i < this.lightLimit;
      light.userData.active = false;
      light.userData.age = 0;
      light.userData.life = .45;
      // Le ombre cubiche di una PointLight richiedono sei passaggi completi e
      // provocavano il blocco più evidente in Ultra al primo scoppio.
      light.castShadow = false;
      scene.add(light);
      this.lights.push(light);
    }
  }

  setQuality(profile) {
    this.particleScale = profile.particleScale;
    this.lightLimit = profile.dynamicLights;
    this.lights.forEach((light, index) => {
      light.visible = index < this.lightLimit;
      if (!light.visible) {
        light.userData.active = false;
        light.intensity = 0;
      }
    });
  }

  finishWarmup() {
    if (!this.warmupPending) return;
    this.warmupPending = false;
    for (const wave of this.shockwaves) {
      if (!wave.active) wave.mesh.visible = false;
    }
  }

  randomDirection(speed, verticalBias = 0) {
    const direction = new THREE.Vector3(Math.random() - .5, Math.random() - .5 + verticalBias, Math.random() - .5).normalize();
    return direction.multiplyScalar(speed * (.55 + Math.random() * .75));
  }

  sparkBurst(position, color = 0xffd19a, amount = 9) {
    const count = Math.max(3, Math.round(amount * this.particleScale));
    for (let i = 0; i < count; i++) {
      this.additive.spawn({
        position,
        velocity: this.randomDirection(7, .38),
        color: Math.random() < .35 ? color : 0xa8efff,
        life: .22 + Math.random() * .34,
        sizeStart: 3 + Math.random() * 4,
        sizeEnd: .4,
        gravity: 10,
        drag: .6
      });
    }
  }

  explode(position, accent = 0x66efff) {
    const sparkCount = Math.round(48 * this.particleScale);
    const smokeCount = Math.round(24 * this.particleScale);
    const debrisCount = Math.round(14 * this.particleScale);
    this.additive.spawn({ position, color: 0xffe0a0, life: .22, sizeStart: 32, sizeEnd: 132, drag: 5 });
    this.additive.spawn({ position, color: accent, life: .34, sizeStart: 22, sizeEnd: 104, drag: 4 });
    for (let i = 0; i < sparkCount; i++) {
      this.additive.spawn({
        position,
        velocity: this.randomDirection(10.5, .16),
        color: i % 4 ? 0xff9d58 : accent,
        life: .35 + Math.random() * .72,
        sizeStart: 3 + Math.random() * 6,
        sizeEnd: .5,
        gravity: 10.5,
        drag: .35
      });
    }
    for (let i = 0; i < smokeCount; i++) {
      this.smoke.spawn({
        position: position.clone().add(this.randomDirection(.4)),
        velocity: this.randomDirection(1.8, .72),
        color: Math.random() < .35 ? 0x53616b : 0x252b31,
        life: 1.2 + Math.random() * 1.15,
        sizeStart: 15 + Math.random() * 15,
        sizeEnd: 70 + Math.random() * 55,
        delay: Math.random() * .18,
        gravity: -1.2,
        drag: .72
      });
    }
    for (let i = 0; i < debrisCount; i++) this.spawnDebris(position);
    this.spawnShockwave(position, accent);
    this.spawnLight(position);
    this.onShockwave(position);
    this.onCameraImpulse(.12);
  }

  spawnDebris(position) {
    let debris = null;
    for (let search = 0; search < MAX_DEBRIS; search++) {
      const index = (this.debrisCursor + search) % MAX_DEBRIS;
      if (!this.debris[index].active) {
        debris = this.debris[index];
        this.debrisCursor = (index + 1) % MAX_DEBRIS;
        break;
      }
    }
    if (!debris) debris = this.debris[this.debrisCursor++ % MAX_DEBRIS];
    if (!debris.active) this.activeDebris++;
    debris.active = true;
    debris.position.copy(position);
    debris.velocity.copy(this.randomDirection(7, .28));
    debris.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
    debris.angular.set((Math.random() - .5) * 12, (Math.random() - .5) * 12, (Math.random() - .5) * 12);
    debris.age = 0;
    debris.life = 1.5 + Math.random() * 1.1;
    debris.scale = .55 + Math.random() * 1.5;
  }

  spawnShockwave(position, color) {
    const wave = this.shockwaves.find(item => !item.active) || this.shockwaves[0];
    wave.active = true;
    wave.age = 0;
    wave.mesh.visible = true;
    wave.mesh.position.copy(position);
    wave.material.color.set(color);
    wave.material.opacity = .9;
    wave.mesh.scale.setScalar(1);
  }

  spawnLight(position) {
    const light = this.lights.slice(0, this.lightLimit).find(item => !item.userData.active) || this.lights[0];
    light.position.copy(position);
    light.color.setHex(Math.random() < .28 ? 0x71eaff : 0xff9354);
    light.intensity = this.lightLimit >= 8 ? 48 : 32;
    light.userData.active = true;
    light.userData.age = 0;
  }

  update(delta, camera) {
    this.additive.update(delta, false);
    this.smoke.update(delta, true);
    if (this.activeDebris > 0) {
      for (let i = 0; i < MAX_DEBRIS; i++) {
        const debris = this.debris[i];
        if (!debris.active) continue;
        debris.age += delta;
        debris.velocity.y -= 9.82 * delta;
        debris.position.addScaledVector(debris.velocity, delta);
        if (debris.position.y < .08) {
          debris.position.y = .08;
          debris.velocity.y = Math.abs(debris.velocity.y) * .28;
          debris.velocity.x *= .66;
          debris.velocity.z *= .66;
        }
        debris.rotation.x += debris.angular.x * delta;
        debris.rotation.y += debris.angular.y * delta;
        debris.rotation.z += debris.angular.z * delta;
        const remaining = Math.max(0, 1 - debris.age / debris.life);
        const scale = debris.scale * Math.min(1, remaining * 4);
        this.quaternion.setFromEuler(debris.rotation);
        this.scaleVector.setScalar(scale);
        this.matrix.compose(debris.position, this.quaternion, this.scaleVector);
        this.debrisMesh.setMatrixAt(i, this.matrix);
        if (debris.age >= debris.life) {
          debris.active = false;
          this.activeDebris--;
        }
      }
      this.debrisMesh.instanceMatrix.needsUpdate = true;
    }

    for (const wave of this.shockwaves) {
      if (!wave.active) continue;
      wave.age += delta;
      const t = Math.min(1, wave.age / wave.life);
      wave.mesh.lookAt(camera.position);
      wave.mesh.scale.setScalar(1 + t * 9);
      wave.material.opacity = (1 - t) * .82;
      if (t >= 1) { wave.active = false; wave.material.opacity = 0; wave.mesh.visible = false; }
    }
    for (const light of this.lights) {
      if (!light.userData.active) continue;
      light.userData.age += delta;
      const t = light.userData.age / light.userData.life;
      light.intensity *= Math.max(0, 1 - delta * 8.5);
      if (t >= 1) { light.userData.active = false; light.intensity = 0; }
    }
  }
}
