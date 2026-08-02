import * as THREE from 'three';

const MAX_ADDITIVE = 720;
const MAX_SMOKE = 360;
const MAX_DEBRIS = 144;
const MAX_SHOCKWAVES = 12;

const ParticleShader = {
  vertexShader: `
    attribute float aSize;
    attribute float aOpacity;
    attribute vec3 aColor;
    varying float vOpacity;
    varying vec3 vColor;
    void main(){
      vec4 mvPosition=modelViewMatrix*vec4(position,1.0);
      gl_Position=projectionMatrix*mvPosition;
      gl_PointSize=aSize*(300.0/max(1.0,-mvPosition.z));
      vOpacity=aOpacity;
      vColor=aColor;
    }`,
  fragmentShader: `
    varying float vOpacity;
    varying vec3 vColor;
    void main(){
      vec2 p=gl_PointCoord-.5;
      float d=length(p)*2.0;
      float core=1.0-smoothstep(.12,1.0,d);
      float halo=1.0-smoothstep(.42,1.0,d);
      float alpha=(core*.72+halo*.28)*vOpacity;
      if(alpha<.003)discard;
      gl_FragColor=vec4(vColor,alpha);
    }`
};

export const ShockwaveShader = {
  name: 'ExplosionShockwave',
  uniforms: {
    tDiffuse: { value: null },
    center: { value: new THREE.Vector2(.5, .5) },
    progress: { value: 1 },
    strength: { value: 0 },
    aspect: { value: 1 }
  },
  vertexShader: `varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform vec2 center;
    uniform float progress;
    uniform float strength;
    uniform float aspect;
    varying vec2 vUv;
    void main(){
      vec2 delta=vUv-center;
      delta.x*=aspect;
      float radius=length(delta);
      float ring=smoothstep(.055,.0,abs(radius-progress*.42));
      vec2 dir=radius>.0001?delta/radius:vec2(0.0);
      dir.x/=aspect;
      vec2 displaced=vUv-dir*ring*strength*(1.0-progress);
      vec3 color=texture2D(tDiffuse,displaced).rgb;
      color+=ring*vec3(.08,.16,.2)*(1.0-progress);
      gl_FragColor=vec4(color,1.0);
    }`
};

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
    const geometry = new THREE.BufferGeometry();
    this.positions = new Float32Array(maximum * 3);
    this.colors = new Float32Array(maximum * 3);
    this.sizes = new Float32Array(maximum);
    this.opacities = new Float32Array(maximum);
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('aOpacity', new THREE.BufferAttribute(this.opacities, 1).setUsage(THREE.DynamicDrawUsage));
    const material = new THREE.ShaderMaterial({
      vertexShader: ParticleShader.vertexShader,
      fragmentShader: ParticleShader.fragmentShader,
      transparent: true,
      depthWrite: false,
      blending,
      toneMapped: false
    });
    this.points = new THREE.Points(geometry, material);
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
      if (t >= 1) particle.active = false;
    }
    for (const attribute of Object.values(this.points.geometry.attributes)) attribute.needsUpdate = true;
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

    this.shockwaves = [];
    for (let i = 0; i < MAX_SHOCKWAVES; i++) {
      const material = new THREE.MeshBasicMaterial({ color: 0x8df7ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(new THREE.RingGeometry(.28, .43, 42), material);
      mesh.visible = false;
      scene.add(mesh);
      this.shockwaves.push({ mesh, material, active: false, age: 0, life: .55 });
    }

    this.lights = [];
    for (let i = 0; i < 8; i++) {
      const light = new THREE.PointLight(0xffa05c, 0, 18, 2);
      light.visible = false;
      light.userData.age = 0;
      light.userData.life = .45;
      if (i === 0) {
        light.castShadow = true;
        light.shadow.mapSize.set(512, 512);
        light.shadow.bias = -.001;
      }
      scene.add(light);
      this.lights.push(light);
    }
  }

  setQuality(profile) {
    this.particleScale = profile.particleScale;
    this.lightLimit = profile.dynamicLights;
    this.lights[0].castShadow = profile.dynamicLights >= 8;
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
    const light = this.lights.slice(0, this.lightLimit).find(item => !item.visible) || this.lights[0];
    light.position.copy(position);
    light.color.setHex(Math.random() < .28 ? 0x71eaff : 0xff9354);
    light.intensity = this.lightLimit >= 8 ? 48 : 32;
    light.visible = true;
    light.userData.age = 0;
  }

  update(delta, camera) {
    this.additive.update(delta, false);
    this.smoke.update(delta, true);
    for (let i = 0; i < MAX_DEBRIS; i++) {
      const debris = this.debris[i];
      if (debris.active) {
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
        if (debris.age >= debris.life) debris.active = false;
      } else {
        this.scaleVector.setScalar(0);
        this.matrix.compose(debris.position, this.quaternion.identity(), this.scaleVector);
        this.debrisMesh.setMatrixAt(i, this.matrix);
      }
    }
    this.debrisMesh.instanceMatrix.needsUpdate = true;

    for (const wave of this.shockwaves) {
      if (!wave.active) continue;
      wave.age += delta;
      const t = Math.min(1, wave.age / wave.life);
      wave.mesh.lookAt(camera.position);
      wave.mesh.scale.setScalar(1 + t * 9);
      wave.material.opacity = (1 - t) * .82;
      if (t >= 1) { wave.active = false; wave.mesh.visible = false; }
    }
    for (const light of this.lights) {
      if (!light.visible) continue;
      light.userData.age += delta;
      const t = light.userData.age / light.userData.life;
      light.intensity *= Math.max(0, 1 - delta * 8.5);
      if (t >= 1) { light.visible = false; light.intensity = 0; }
    }
  }
}
