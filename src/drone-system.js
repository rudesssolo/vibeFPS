import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { DRONE_TUNING } from './config.js';
import { makeRng } from './rng.js';

const clampLength = (vector, max) => {
  if (vector.lengthSq() > max * max) vector.setLength(max);
  return vector;
};

export class DroneSystem {
  constructor({ scene, camera, targetLayer, targetProvider, onFire, onTelegraph }) {
    this.scene = scene;
    this.camera = camera;
    this.targetLayer = targetLayer;
    this.targetProvider = targetProvider;
    this.onFire = onFire;
    this.onTelegraph = onTelegraph || (() => {});
    this.drones = [];
    this.wave = 1;
    this.line = new THREE.Line3();
    this.closest = new THREE.Vector3();
    this.temp = new THREE.Vector3();
    this.temp2 = new THREE.Vector3();
    this.steering = new THREE.Vector3();
    this.separationOffset = new THREE.Vector3();
    this.lookHelper = new THREE.Object3D();
    this.coreGeometry = new RoundedBoxGeometry(.86, .54, .94, 4, .12);
    this.wingGeometry = new RoundedBoxGeometry(.62, .11, .38, 3, .045);
    this.eyeGeometry = new THREE.SphereGeometry(.11, 18, 12);
    this.ringGeometry = new THREE.TorusGeometry(.59, .032, 8, 28);
    this.haloGeometry = new THREE.CircleGeometry(.25, 24);
    this.thrusterGeometry = new THREE.ConeGeometry(.095, .44, 12);
    this.darkMaterial = new THREE.MeshPhysicalMaterial({ color: 0x0a1017, metalness: .94, roughness: .23, clearcoat: .35, envMapIntensity: 1.6 });
  }

  clear() {
    for (const drone of this.drones) {
      this.scene.remove(drone.group);
      drone.marker.remove();
      drone.coreMaterial.dispose();
      drone.eye.material.dispose();
      drone.ring.material.dispose();
      drone.eyeHalo.material.dispose();
      for (const thruster of drone.thrusters) thruster.material.dispose();
    }
    this.drones.length = 0;
  }

  spawnWave(wave, count) {
    this.clear();
    this.wave = wave;
    for (let index = 0; index < count; index++) this.drones.push(this.createDrone(index, count));
    return this.drones.length;
  }

  createDrone(index, count) {
    const random = makeRng(7100 + this.wave * 101 + index * 17);
    const angle = index / count * Math.PI * 2 + this.wave * .37;
    const radius = 10 + ((index * 7 + this.wave * 3) % 8);
    const anchor = new THREE.Vector3(Math.sin(angle) * radius, 2.5 + index % 3 * .72, Math.cos(angle) * radius);
    const group = new THREE.Group();
    const visual = new THREE.Group();
    group.add(visual);

    const coreMaterial = new THREE.MeshPhysicalMaterial({
      color: index % 2 ? 0x2d3742 : 0x172a36,
      metalness: .88,
      roughness: .22,
      clearcoat: .62,
      clearcoatRoughness: .12,
      envMapIntensity: 1.65,
      emissive: 0x21040b,
      emissiveIntensity: .34
    });
    const core = new THREE.Mesh(this.coreGeometry, coreMaterial);
    visual.add(core);
    const wingLeft = new THREE.Mesh(this.wingGeometry, this.darkMaterial);
    const wingRight = new THREE.Mesh(this.wingGeometry, this.darkMaterial);
    wingLeft.position.x = -.66; wingRight.position.x = .66;
    wingLeft.rotation.z = .12; wingRight.rotation.z = -.12;
    visual.add(wingLeft, wingRight);

    const eye = new THREE.Mesh(this.eyeGeometry, new THREE.MeshBasicMaterial({ color: 0xff334f }));
    eye.position.set(0, .03, .49);
    visual.add(eye);
    const eyeHalo = new THREE.Mesh(
      this.haloGeometry,
      new THREE.MeshBasicMaterial({ color: 0xff203f, transparent: true, opacity: .22, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })
    );
    eyeHalo.position.set(0, .03, .505);
    visual.add(eyeHalo);
    const ring = new THREE.Mesh(
      this.ringGeometry,
      new THREE.MeshBasicMaterial({ color: index % 2 ? 0xff2d95 : 0x00e5ff, transparent: true, opacity: .72, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    ring.rotation.x = Math.PI / 2;
    visual.add(ring);

    const thrusters = [];
    for (const x of [-.46, .46]) {
      const material = new THREE.MeshBasicMaterial({ color: 0x72f5ff, transparent: true, opacity: .75, blending: THREE.AdditiveBlending, depthWrite: false });
      const thruster = new THREE.Mesh(this.thrusterGeometry, material);
      thruster.position.set(x, -.38, -.05);
      thruster.rotation.z = Math.PI;
      visual.add(thruster);
      thrusters.push(thruster);
    }
    visual.traverse(object => {
      if (object.isMesh && object !== eye && object !== eyeHalo && object !== ring && !thrusters.includes(object)) {
        object.castShadow = true;
        object.receiveShadow = true;
      }
    });

    group.position.copy(anchor);
    this.scene.add(group);
    const marker = document.createElement('div');
    marker.className = 'target-marker';
    marker.innerHTML = '<span class="target-health"><i></i></span><span class="target-state"></span>';
    this.targetLayer.appendChild(marker);
    const maxHealth = 100 + this.wave * 12;
    return {
      id: index + 1,
      group,
      visual,
      core,
      coreMaterial,
      eye,
      eyeHalo,
      ring,
      thrusters,
      marker,
      anchor,
      position: anchor.clone(),
      velocity: new THREE.Vector3((random() - .5) * 2, 0, (random() - .5) * 2),
      acceleration: new THREE.Vector3(),
      desiredVelocity: new THREE.Vector3(),
      evadeDirection: new THREE.Vector3(),
      random,
      phase: index * 1.73,
      health: maxHealth,
      maxHealth,
      radius: .75,
      fireTimer: 1.2 + index * .35,
      alive: true,
      state: 'patrol',
      stateTimer: 0,
      evadeCooldown: random() * .8,
      telegraphTime: 0,
      bank: 0,
      pitch: 0
    };
  }

  registerProjectileThreat(start, end) {
    this.line.start.set(start.x, start.y, start.z);
    this.line.end.set(end.x, end.y, end.z);
    const bulletDirection = this.temp.set(end.x - start.x, end.y - start.y, end.z - start.z);
    if (bulletDirection.lengthSq() < .001) return;
    bulletDirection.normalize();
    for (const drone of this.drones) {
      if (!drone.alive || drone.evadeCooldown > 0 || drone.state === 'telegraph' || drone.state === 'evade') continue;
      this.line.closestPointToPoint(drone.position, true, this.closest);
      if (this.closest.distanceToSquared(drone.position) > DRONE_TUNING.threatRadius ** 2) continue;
      const side = this.separationOffset.copy(drone.position).sub(this.closest);
      if (side.lengthSq() < .04) side.set(-bulletDirection.z, 0, bulletDirection.x);
      side.y += (drone.random() - .5) * .7;
      side.normalize();
      drone.evadeDirection.copy(side);
      const waveFactor = Math.min(.3, (this.wave - 1) * .04);
      const reaction = THREE.MathUtils.lerp(DRONE_TUNING.telegraphMax, DRONE_TUNING.telegraphMin, drone.random());
      drone.telegraphTime = Math.max(.12, reaction * (1 - waveFactor * .45));
      drone.stateTimer = drone.telegraphTime;
      drone.state = 'telegraph';
      drone.marker.classList.add('evade-warning');
      this.onTelegraph(drone);
    }
  }

  update(delta, time, { active = true, dead = false } = {}) {
    const target = this.targetProvider();
    const waveScale = 1 + Math.min(.3, (this.wave - 1) * .04);
    let alive = 0;
    for (const drone of this.drones) {
      if (!drone.alive) continue;
      alive++;
      drone.evadeCooldown = Math.max(0, drone.evadeCooldown - delta);
      drone.stateTimer -= delta;

      if (drone.state === 'telegraph' && drone.stateTimer <= 0) {
        drone.state = 'evade';
        drone.stateTimer = DRONE_TUNING.evadeDuration;
        drone.marker.classList.remove('evade-warning');
      } else if (drone.state === 'evade' && drone.stateTimer <= 0) {
        drone.state = 'recover';
        drone.stateTimer = DRONE_TUNING.recoverDuration;
        drone.evadeCooldown = THREE.MathUtils.lerp(DRONE_TUNING.evadeCooldownMin, DRONE_TUNING.evadeCooldownMax, drone.random());
      } else if (drone.state === 'recover' && drone.stateTimer <= 0) {
        drone.state = 'engage';
      }

      const toTarget = this.temp.copy(target).sub(drone.position);
      const targetDistance = toTarget.length();
      const orbitTarget = this.temp2.set(
        drone.anchor.x + Math.sin(time * .43 + drone.phase) * 2.2,
        drone.anchor.y + Math.sin(time * 1.25 + drone.phase) * .62,
        drone.anchor.z + Math.cos(time * .37 + drone.phase) * 2
      );
      const toOrbit = orbitTarget.sub(drone.position);
      if (drone.state === 'evade') {
        drone.desiredVelocity.copy(drone.evadeDirection).multiplyScalar(DRONE_TUNING.evadeSpeed * waveScale);
      } else if (drone.state === 'telegraph') {
        drone.desiredVelocity.multiplyScalar(.72);
      } else {
        const speed = (targetDistance < 24 ? DRONE_TUNING.engageSpeed : DRONE_TUNING.patrolSpeed) * waveScale;
        drone.desiredVelocity.copy(toOrbit).normalize().multiplyScalar(speed);
        if (drone.state === 'recover') drone.desiredVelocity.lerp(toTarget.normalize().multiplyScalar(speed * .4), .16);
      }

      // Separazione morbida fra unità e repulsione dai limiti dell'arena.
      const steering = this.steering.set(0, 0, 0);
      for (const other of this.drones) {
        if (other === drone || !other.alive) continue;
        const offset = this.separationOffset.copy(drone.position).sub(other.position);
        const distance = offset.length();
        if (distance > .001 && distance < DRONE_TUNING.separationRadius) {
          steering.addScaledVector(offset.normalize(), (DRONE_TUNING.separationRadius - distance) * 3.8);
        }
      }
      const edge = DRONE_TUNING.arenaLimit;
      if (Math.abs(drone.position.x) > edge - 2.2) steering.x += -Math.sign(drone.position.x) * 9;
      if (Math.abs(drone.position.z) > edge - 2.2) steering.z += -Math.sign(drone.position.z) * 9;
      if (drone.position.y < DRONE_TUNING.minAltitude) steering.y += 10;
      if (drone.position.y > DRONE_TUNING.maxAltitude) steering.y -= 10;

      drone.acceleration.copy(drone.desiredVelocity).sub(drone.velocity).multiplyScalar(3.35).add(steering);
      clampLength(drone.acceleration, DRONE_TUNING.maxAcceleration * waveScale);
      drone.velocity.addScaledVector(drone.acceleration, delta);
      const maxSpeed = (drone.state === 'evade' ? DRONE_TUNING.evadeSpeed : DRONE_TUNING.engageSpeed) * waveScale;
      clampLength(drone.velocity, maxSpeed);
      drone.position.addScaledVector(drone.velocity, delta);
      drone.position.x = THREE.MathUtils.clamp(drone.position.x, -edge, edge);
      drone.position.z = THREE.MathUtils.clamp(drone.position.z, -edge, edge);
      drone.position.y = THREE.MathUtils.clamp(drone.position.y, DRONE_TUNING.minAltitude - .2, DRONE_TUNING.maxAltitude + .2);
      drone.group.position.copy(drone.position);

      this.lookHelper.position.copy(drone.position);
      this.lookHelper.lookAt(target);
      drone.group.quaternion.slerp(this.lookHelper.quaternion, Math.min(1, delta * 5.5));
      const lateralAcceleration = drone.acceleration.x * Math.cos(drone.group.rotation.y) - drone.acceleration.z * Math.sin(drone.group.rotation.y);
      const targetBank = THREE.MathUtils.clamp(-lateralAcceleration * .045, -.49, .49);
      const targetPitch = THREE.MathUtils.clamp(drone.acceleration.y * -.025, -.28, .28);
      drone.bank = THREE.MathUtils.lerp(drone.bank, targetBank, Math.min(1, delta * 6));
      drone.pitch = THREE.MathUtils.lerp(drone.pitch, targetPitch, Math.min(1, delta * 6));
      drone.visual.rotation.z = drone.bank;
      drone.visual.rotation.x = drone.pitch;
      drone.ring.rotation.z += delta * (2 + drone.id * .06);
      const thrust = .78 + drone.acceleration.length() / (DRONE_TUNING.maxAcceleration * waveScale) * .9;
      for (const thruster of drone.thrusters) thruster.scale.y = THREE.MathUtils.lerp(thruster.scale.y, thrust, delta * 9);
      drone.eyeHalo.scale.setScalar(1 + Math.sin(time * 5 + drone.phase) * .13 + (drone.state === 'telegraph' ? .55 : 0));
      drone.eye.material.color.setHex(drone.state === 'telegraph' ? 0xffc857 : 0xff334f);
      drone.coreMaterial.emissiveIntensity = Math.max(.34, drone.coreMaterial.emissiveIntensity - delta * 7);

      drone.fireTimer -= delta;
      if (active && !dead && targetDistance < 30 && drone.fireTimer <= 0 && drone.state !== 'evade' && drone.state !== 'telegraph') {
        this.onFire(drone);
        drone.fireTimer = Math.max(.78, 2.85 - this.wave * .13) + drone.random() * 1.7;
      }
    }
    return alive;
  }

  applyDamage(drone, amount) {
    if (!drone || !drone.alive) return { hit: false, killed: false };
    drone.health -= amount;
    drone.coreMaterial.emissive.setHex(0xff173c);
    drone.coreMaterial.emissiveIntensity = 2.7;
    const killed = drone.health <= 0;
    if (killed) {
      drone.alive = false;
      drone.group.visible = false;
      drone.marker.style.display = 'none';
    } else if (drone.evadeCooldown <= 0 && drone.state !== 'evade') {
      const away = drone.position.clone().sub(this.targetProvider()).setY((drone.random() - .5) * .65).normalize();
      drone.evadeDirection.copy(away);
      drone.state = 'telegraph';
      drone.stateTimer = Math.max(.12, THREE.MathUtils.lerp(.14, .22, drone.random()));
      drone.marker.classList.add('evade-warning');
      this.onTelegraph(drone);
    }
    return { hit: true, killed, position: drone.position.clone() };
  }

  updateMarkers() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    for (const drone of this.drones) {
      if (!drone.alive) continue;
      const projected = drone.position.clone();
      const distance = projected.distanceTo(this.camera.position);
      projected.project(this.camera);
      const visible = projected.z > -1 && projected.z < 1 && Math.abs(projected.x) < .94 && Math.abs(projected.y) < .9;
      drone.marker.style.display = 'block';
      drone.marker.classList.toggle('offscreen', !visible);
      let screenX = projected.x;
      let screenY = projected.y;
      if (!visible) {
        if (projected.z > 1) { screenX *= -1; screenY *= -1; }
        screenX = THREE.MathUtils.clamp(screenX, -.9, .9);
        screenY = THREE.MathUtils.clamp(screenY, -.82, .82);
      }
      const left = (screenX * .5 + .5) * width;
      const top = (-screenY * .5 + .5) * height;
      drone.marker.style.setProperty('--target-x', `${left}px`);
      drone.marker.style.setProperty('--target-y', `${top}px`);
      drone.marker.style.left = `${left}px`;
      drone.marker.style.top = `${top}px`;
      drone.marker.dataset.range = `${distance.toFixed(0)}M · SNT-${String(drone.id).padStart(2, '0')}`;
      drone.marker.querySelector('.target-health i').style.width = `${Math.max(0, drone.health / drone.maxHealth * 100)}%`;
      const state = drone.marker.querySelector('.target-state');
      state.textContent = !visible ? 'THREAT' : drone.state === 'telegraph' ? 'EVADE' : '';
    }
  }
}
