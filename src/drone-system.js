import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { DRONE_TUNING, APEX_TUNING, getApexStats } from './config.js';
import { makeRng } from './rng.js';

const clampLength = (vector, max) => {
  if (vector.lengthSq() > max * max) vector.setLength(max);
  return vector;
};

export class DroneSystem {
  constructor({ scene, camera, targetLayer, targetProvider, onFire, onTelegraph, onApexAttack, onApexContact, onApexMine, onApexSummon, onApexShockwave, onApexTelegraph }) {
    this.scene = scene;
    this.camera = camera;
    this.targetLayer = targetLayer;
    this.targetProvider = targetProvider;
    this.onFire = onFire;
    this.onTelegraph = onTelegraph || (() => {});
    // Callback per gli attacchi/effetti speciali degli Apex.
    this.onApexAttack = onApexAttack || (() => {});
    this.onApexContact = onApexContact || (() => {});
    this.onApexMine = onApexMine || (() => {});
    this.onApexSummon = onApexSummon || (() => {});
    this.onApexShockwave = onApexShockwave || (() => {});
    this.onApexTelegraph = onApexTelegraph || (() => {});
    this.drones = [];
    this.wave = 1;
    this.line = new THREE.Line3();
    this.closest = new THREE.Vector3();
    this.temp = new THREE.Vector3();
    this.temp2 = new THREE.Vector3();
    this.temp3 = new THREE.Vector3();
    this.steering = new THREE.Vector3();
    this.separationOffset = new THREE.Vector3();
    this.markerProjected = new THREE.Vector3();
    this.lookHelper = new THREE.Object3D();
    this.coreGeometry = new RoundedBoxGeometry(.86, .54, .94, 4, .12);
    this.wingGeometry = new RoundedBoxGeometry(.62, .11, .38, 3, .045);
    this.eyeGeometry = new THREE.SphereGeometry(.11, 18, 12);
    this.ringGeometry = new THREE.TorusGeometry(.59, .032, 8, 28);
    this.haloGeometry = new THREE.CircleGeometry(.25, 24);
    this.thrusterGeometry = new THREE.ConeGeometry(.095, .44, 12);
    this.darkMaterial = new THREE.MeshPhysicalMaterial({ color: 0x0a1017, metalness: .94, roughness: .23, clearcoat: .35, envMapIntensity: 1.6 });
    // --- Geometrie per gli Apex (nemici speciali di fine ondata) ---
    this.armorGeometry = new THREE.BoxGeometry(1.24, .62, .16);
    this.bladeGeometry = new THREE.BoxGeometry(.1, .7, .34);
    this.spikeGeometry = new THREE.ConeGeometry(.16, .5, 6);
    this.orbitGeometry = new THREE.SphereGeometry(.2, 12, 10);
    this.miniGeometry = new THREE.SphereGeometry(.28, 12, 10);
    this.apex = null;
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
    this.clearApex();
  }

  clearApex() {
    if (!this.apex) return;
    if (this.apex.group) this.scene.remove(this.apex.group);
    if (this.apex.marker) this.apex.marker.remove();
    if (this.apex.coreMaterial) this.apex.coreMaterial.dispose();
    if (this.apex.eye?.material) this.apex.eye.material.dispose();
    if (this.apex.eyeHalo?.material) this.apex.eyeHalo.material.dispose();
    if (this.apex.ring?.material) this.apex.ring.material.dispose();
    if (this.apex.afterimage?.material) this.apex.afterimage.material.dispose();
    for (const part of this.apex.parts || []) {
      // darkMaterial è CONDIVISO con le ali di ogni drone e con gli Apex futuri
      // (spine, blade, lowerPlate lo riusano): disporlo qui liberava risorse GPU
      // di un materiale ancora in scena, a ogni cambio di Apex.
      if (part.material && part.material !== this.darkMaterial) part.material.dispose();
    }
    this.apex = null;
  }

  spawnWave(wave, count) {
    this.clear();
    this.wave = wave;
    for (let index = 0; index < count; index++) this.drones.push(this.createDrone(index, count));
    return this.drones.length;
  }

  /** Crea (o sostituisce) l'Apex di fine ondata per l'ondata data. */
  spawnApex(wave) {
    this.clearApex();
    this.wave = wave;
    const stats = getApexStats(wave);
    const random = makeRng(9900 + wave * 137);
    const angle = random() * Math.PI * 2;
    const radius = 12 + random() * 3;
    const anchor = new THREE.Vector3(Math.sin(angle) * radius, 14, Math.cos(angle) * radius + 4);
    const built = this.buildApexVisual(stats);
    const group = new THREE.Group();
    group.add(built.visual);
    group.position.copy(anchor);
    this.scene.add(group);

    const marker = document.createElement('div');
    marker.className = 'target-marker apex-marker';
    marker.innerHTML = '<span class="target-health"><i></i></span><span class="target-state"></span>';
    this.targetLayer.appendChild(marker);
    const markerHealth = marker.querySelector('.target-health i');
    const markerState = marker.querySelector('.target-state');

    const apex = {
      id: 'APX',
      archetypeId: stats.archetype.id,
      nameKey: stats.nameKey,
      tier: stats.tier,
      group,
      visual: built.visual,
      core: built.core,
      coreMaterial: built.coreMaterial,
      eye: built.eye,
      eyeHalo: built.eyeHalo,
      ring: built.ring,
      secondRing: built.secondRing,
      thrusters: built.thrusters,
      afterimage: built.afterimage,
      parts: built.parts,
      marker, markerHealth, markerState,
      lastLeft: -1, lastTop: -1, lastRange: '', lastState: '', lastHealth: -1, lastOffscreen: null,
      anchor,
      position: anchor.clone(),
      velocity: new THREE.Vector3(),
      acceleration: new THREE.Vector3(),
      desiredVelocity: new THREE.Vector3(),
      random,
      phase: random() * 7,
      health: stats.maxHealth,
      maxHealth: stats.maxHealth,
      radius: stats.radius,
      fireTimer: 2,
      alive: true,
      spawnTimer: APEX_TUNING.spawnDescent,
      state: 'spawn',
      stateTimer: 0,
      attackCooldown: 1.6,
      damage: stats.damage,
      speed: stats.speed,
      // Per-archetipo: armatura, blink, fasi, cariche.
      armor: stats.archetype.id === 'vanguard' ? Math.round(stats.maxHealth * .42) : 0,
      armorMax: stats.archetype.id === 'vanguard' ? Math.round(stats.maxHealth * .42) : 0,
      armorBroken: false,
      blinkCooldown: 1.2,
      mineTimer: 2.4,
      shockwaveTimer: 5,
      chargeCount: 0,
      telegraphing: false,
      summonTimer: 6
    };
    this.apex = apex;
    return apex;
  }

  /** Costruisce la silhouette visiva dell'Apex per archetipo e restituisce i riferimenti. */
  buildApexVisual(stats) {
    const visual = new THREE.Group();
    const coreMaterial = new THREE.MeshPhysicalMaterial({
      color: 0x0c111a,
      metalness: .92,
      roughness: .2,
      clearcoat: .9,
      clearcoatRoughness: .08,
      envMapIntensity: 1.8,
      emissive: stats.color,
      emissiveIntensity: .55
    });
    const parts = [];
    let coreScale = 1.15;
    let afterimage = null;
    switch (stats.archetype.id) {
      case 'vanguard': {
        coreScale = 1.55;
        const armor = new THREE.Mesh(
          this.armorGeometry,
          new THREE.MeshPhysicalMaterial({ color: 0x141d2b, metalness: .9, roughness: .3, clearcoat: .5, envMapIntensity: 1.6 })
        );
        armor.position.set(0, .02, .46);
        armor.rotation.x = .12;
        parts.push(armor);
        for (const x of [-.95, .95]) {
          const spike = new THREE.Mesh(this.spikeGeometry, this.darkMaterial);
          spike.position.set(x, .32, 0);
          spike.rotation.z = x < 0 ? .5 : -.5;
          spike.rotation.x = -Math.PI / 2;
          parts.push(spike);
        }
        const lowerPlate = new THREE.Mesh(this.miniGeometry, this.darkMaterial);
        lowerPlate.scale.setScalar(2.1);
        lowerPlate.position.set(0, -.28, .1);
        parts.push(lowerPlate);
        break;
      }
      case 'wraith': {
        coreScale = 1.25;
        for (const x of [-.8, .8]) {
          const blade = new THREE.Mesh(this.bladeGeometry, this.darkMaterial);
          blade.position.set(x, 0, 0);
          blade.rotation.z = x < 0 ? .1 : -.1;
          blade.rotation.y = x < 0 ? .25 : -.25;
          parts.push(blade);
        }
        const afterimageMat = new THREE.MeshBasicMaterial({
          color: stats.color,
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false
        });
        const afterCore = new THREE.Mesh(this.coreGeometry, afterimageMat);
        afterCore.scale.setScalar(1.25);
        afterimage = afterCore;
        parts.push(afterimage);
        break;
      }
      case 'vex': {
        coreScale = 1.4;
        const core = new THREE.Mesh(
          this.orbitGeometry,
          new THREE.MeshBasicMaterial({ color: stats.color, transparent: true, opacity: .5, blending: THREE.AdditiveBlending, depthWrite: false })
        );
        core.scale.setScalar(3.4);
        parts.push(core);
        for (let i = 0; i < 3; i++) {
          const orb = new THREE.Mesh(this.orbitGeometry, new THREE.MeshBasicMaterial({ color: stats.color, transparent: true, opacity: .85, blending: THREE.AdditiveBlending, depthWrite: false }));
          orb.userData.orbitIndex = i;
          parts.push(orb);
        }
        break;
      }
      case 'sentinel': {
        coreScale = 1.9;
        for (let i = 0; i < 6; i++) {
          const spike = new THREE.Mesh(this.spikeGeometry, this.darkMaterial);
          const a = i / 6 * Math.PI * 2;
          spike.position.set(Math.cos(a) * .62, .3, Math.sin(a) * .62);
          spike.rotation.x = -Math.PI / 2;
          parts.push(spike);
        }
        break;
      }
    }

    // Corpo, occhio, due anelli, propulsori: comuni a tutti gli archetipi.
    const core = new THREE.Mesh(this.coreGeometry, coreMaterial);
    core.scale.setScalar(coreScale);
    visual.add(core);
    const eye = new THREE.Mesh(this.eyeGeometry, new THREE.MeshBasicMaterial({ color: stats.color }));
    eye.position.set(0, .04, .5 * coreScale);
    eye.scale.setScalar(1.8);
    visual.add(eye);
    const eyeHalo = new THREE.Mesh(
      this.haloGeometry,
      new THREE.MeshBasicMaterial({ color: stats.color, transparent: true, opacity: .3, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })
    );
    eyeHalo.position.set(0, .04, .52 * coreScale);
    eyeHalo.scale.setScalar(2);
    visual.add(eyeHalo);
    const ring = new THREE.Mesh(
      this.ringGeometry,
      new THREE.MeshBasicMaterial({ color: stats.color, transparent: true, opacity: .85, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    ring.rotation.x = Math.PI / 2;
    ring.scale.setScalar(1.9);
    visual.add(ring);
    const secondRing = new THREE.Mesh(
      this.ringGeometry,
      new THREE.MeshBasicMaterial({ color: stats.color, transparent: true, opacity: .4, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    secondRing.rotation.x = Math.PI / 2;
    secondRing.rotation.z = Math.PI / 4;
    secondRing.scale.setScalar(2.4);
    visual.add(secondRing);
    parts.push({ material: secondRing.material });

    const thrusters = [];
    for (const x of [-.7, .7]) {
      const material = new THREE.MeshBasicMaterial({ color: stats.color, transparent: true, opacity: .85, blending: THREE.AdditiveBlending, depthWrite: false });
      const thruster = new THREE.Mesh(this.thrusterGeometry, material);
      thruster.position.set(x, -.55, -.05);
      thruster.scale.set(1.6, 1.6, 1.6);
      thruster.rotation.z = Math.PI;
      visual.add(thruster);
      thrusters.push(thruster);
    }
    visual.traverse(object => {
      if (object.isMesh && object !== eye && object !== eyeHalo && object !== ring && object !== secondRing && object !== afterimage && !thrusters.includes(object)) {
        object.castShadow = true;
        object.receiveShadow = true;
      }
    });
    return { visual, coreMaterial, core, eye, eyeHalo, ring, secondRing, thrusters, afterimage, parts, coreScale };
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
    // B6: cache dei riferimenti figli + stato precedente per il dirty-check,
    // così updateMarkers non fa querySelector né scritture DOM ridondanti.
    const markerHealth = marker.querySelector('.target-health i');
    const markerState = marker.querySelector('.target-state');
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
      markerHealth,
      markerState,
      // Dirty-check markers (B6): solo i valori cambiati vengono scritti al DOM.
      lastLeft: -1,
      lastTop: -1,
      lastRange: '',
      lastState: '',
      lastHealth: -1,
      lastOffscreen: null,
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
      drone.stateTimer = Math.max(.12, THREE.MathUtils.lerp(DRONE_TUNING.telegraphMin, DRONE_TUNING.telegraphMax, drone.random()));
      drone.marker.classList.add('evade-warning');
      this.onTelegraph(drone);
    }
    return { hit: true, killed, position: drone.position.clone() };
  }

  /** Aggiorna l'Apex (movimento, stati per archetipo, animazioni). Ritorna la vita. */
  updateApex(delta, time, { active = true, dead = false } = {}) {
    const apex = this.apex;
    if (!apex || !apex.alive) return false;
    const target = this.targetProvider();
    const edge = DRONE_TUNING.arenaLimit;

    // Fase di discesa: scende dall'alto senza attaccare.
    if (apex.spawnTimer > 0) {
      apex.spawnTimer -= delta;
      const progress = 1 - Math.max(0, apex.spawnTimer) / APEX_TUNING.spawnDescent;
      apex.position.y = THREE.MathUtils.lerp(16, 5.2, Math.min(1, progress));
      apex.group.position.copy(apex.position);
      apex.ring.rotation.z += delta * 2;
      apex.secondRing.rotation.z -= delta * 1.4;
      apex.eyeHalo.scale.setScalar(1 + Math.sin(time * 6 + apex.phase) * .2);
      if (apex.spawnTimer <= 0) {
        apex.state = 'patrol';
        apex.velocity.set(0, 0, 0);
      }
      return true;
    }

    apex.attackCooldown = Math.max(0, apex.attackCooldown - delta);
    apex.stateTimer -= delta;
    apex.blinkCooldown = Math.max(0, apex.blinkCooldown - delta);
    apex.mineTimer -= delta;
    apex.shockwaveTimer -= delta;
    apex.summonTimer -= delta;

    const toTargetXZ = this.temp.copy(target).sub(apex.position);
    toTargetXZ.y = 0;
    const distanceXZ = toTargetXZ.length();

    apex.desiredVelocity.set(0, 0, 0);
    this.apexBehavior(apex, delta, time, target, distanceXZ, active, dead);

    // Integrazione movimento comune.
    if (apex.state === 'charge' && apex.chargeDir) {
      apex.velocity.copy(apex.chargeDir);
      clampLength(apex.velocity, APEX_TUNING.chargeSpeed);
    } else {
      apex.acceleration.copy(apex.desiredVelocity).sub(apex.velocity).multiplyScalar(2.6);
      clampLength(apex.acceleration, 10);
      apex.velocity.addScaledVector(apex.acceleration, delta);
      const maxSpeed = apex.state === 'recover' ? apex.speed * .5 : apex.speed;
      clampLength(apex.velocity, maxSpeed);
    }
    apex.position.addScaledVector(apex.velocity, delta);
    apex.position.x = THREE.MathUtils.clamp(apex.position.x, -edge, edge);
    apex.position.z = THREE.MathUtils.clamp(apex.position.z, -edge, edge);
    apex.position.y = THREE.MathUtils.clamp(apex.position.y, 3.4, 8.5);
    apex.group.position.copy(apex.position);

    this.lookHelper.position.copy(apex.position);
    this.lookHelper.lookAt(target);
    apex.group.quaternion.slerp(this.lookHelper.quaternion, Math.min(1, delta * 3.5));
    apex.ring.rotation.z += delta * 2.4;
    apex.secondRing.rotation.z -= delta * 1.7;
    const thrust = .8 + Math.min(1, apex.acceleration.length() / 10) * .9;
    for (const thruster of apex.thrusters) thruster.scale.y = THREE.MathUtils.lerp(thruster.scale.y, thrust, delta * 8);
    apex.eyeHalo.scale.setScalar(1 + Math.sin(time * 5 + apex.phase) * .16 + (apex.telegraphing ? .7 : 0));
    apex.coreMaterial.emissiveIntensity = Math.max(.5, apex.coreMaterial.emissiveIntensity - delta * 6);
    if (apex.afterimage) apex.afterimage.material.opacity = Math.max(0, apex.afterimage.material.opacity - delta * 2.4);
    if (apex.archetypeId === 'vex') {
      let orbitIndex = 0;
      for (const part of apex.parts) {
        if (part.userData && part.userData.orbitIndex !== undefined) {
          const a = time * 2.2 + orbitIndex * Math.PI * 2 / 3;
          part.position.set(Math.cos(a) * 1.15, Math.sin(a * .8) * .5, Math.sin(a) * 1.15);
          orbitIndex++;
        }
      }
    }
    return true;
  }
/** Comportamento (velocità desiderata + stati d'attacco) per archetipo. */
  apexBehavior(apex, delta, time, target, distanceXZ, active, dead) {
    const canAct = active && !dead;
    const toTarget = this.temp2.copy(target).sub(apex.position);
    toTarget.y = 0;
    if (toTarget.lengthSq() > .0001) toTarget.normalize();

    switch (apex.archetypeId) {
      case 'vanguard': {
        if (apex.state === 'telegraph') {
          apex.desiredVelocity.set(0, 0, 0);
          if (apex.stateTimer <= 0) {
            apex.state = 'charge';
            apex.stateTimer = 1.15;
            apex.chargeDir = toTarget.clone().multiplyScalar(APEX_TUNING.chargeSpeed);
            apex.telegraphing = false;
            this.onApexAttack(apex, 'charge');
          }
        } else if (apex.state === 'charge') {
          if (apex.stateTimer <= 0
            || Math.abs(apex.position.x) > DRONE_TUNING.arenaLimit - 1.5
            || Math.abs(apex.position.z) > DRONE_TUNING.arenaLimit - 1.5) {
            apex.state = 'recover';
            apex.stateTimer = 1.5;
            apex.chargeDir.set(0, 0, 0);
            apex.velocity.set(0, 0, 0);
          }
        } else if (apex.state === 'recover') {
          apex.desiredVelocity.set(0, 0, 0);
          if (apex.stateTimer <= 0) {
            apex.chargeCount = 0;
            apex.state = 'patrol';
          }
        } else {
          const orbitPoint = this.temp3.set(
            target.x + Math.sin(time * .3 + apex.phase) * 3,
            target.y,
            target.z + Math.cos(time * .27 + apex.phase) * 2.4
          );
          apex.desiredVelocity.copy(orbitPoint).sub(apex.position);
          apex.desiredVelocity.y = 0;
          if (apex.desiredVelocity.lengthSq() > 1) apex.desiredVelocity.setLength(apex.speed * .8);
          apex.chargeCount = 0;
          if (canAct && distanceXZ < 20 && apex.attackCooldown <= 0) {
            apex.state = 'telegraph';
            apex.stateTimer = 1.15;
            apex.attackCooldown = 4.4;
            apex.telegraphing = true;
            this.onApexTelegraph(apex);
          }
        }
        break;
      }

      case 'wraith': {
        if (apex.state === 'blink' || apex.state === 'burst') {
          apex.desiredVelocity.set(0, 0, 0);
          if (apex.state === 'blink' && apex.stateTimer <= 0) {
            apex.state = 'burst';
            apex.stateTimer = .6;
          } else if (apex.state === 'burst' && apex.stateTimer <= 0) {
            apex.state = 'patrol';
            apex.attackCooldown = 1.6;
          }
        } else if (canAct && apex.blinkCooldown <= 0 && distanceXZ > 4) {
          const side = apex.random() > .5 ? 1 : -1;
          const blinkTarget = this.temp3.set(
            target.x + side * (3 + apex.random() * 3),
            target.y + 2,
            target.z + (apex.random() - .5) * 5
          );
          blinkTarget.x = THREE.MathUtils.clamp(blinkTarget.x, -DRONE_TUNING.arenaLimit + 2, DRONE_TUNING.arenaLimit - 2);
          blinkTarget.z = THREE.MathUtils.clamp(blinkTarget.z, -DRONE_TUNING.arenaLimit + 2, DRONE_TUNING.arenaLimit - 2);
          if (apex.afterimage) apex.afterimage.material.opacity = .75;
          apex.position.copy(blinkTarget);
          apex.velocity.set(0, 0, 0);
          apex.state = 'blink';
          apex.stateTimer = .5;
          apex.blinkCooldown = apex.tier >= 2 ? 2.4 : 3.4;
          this.onApexContact(apex, 'blink');
        } else {
          const orbitPoint = this.temp3.set(
            target.x + Math.sin(time * .55 + apex.phase) * 4,
            target.y + 2,
            target.z + Math.cos(time * .5 + apex.phase) * 4
          );
          apex.desiredVelocity.copy(orbitPoint).sub(apex.position);
          apex.desiredVelocity.y = 0;
          if (apex.desiredVelocity.lengthSq() > 1) apex.desiredVelocity.setLength(apex.speed * .9);
        }
        break;
      }

      case 'vex': {
        const orbitPoint = this.temp3.set(
          target.x + Math.sin(time * .4 + apex.phase) * 5,
          target.y + 3,
          target.z + Math.cos(time * .36 + apex.phase) * 5
        );
        apex.desiredVelocity.copy(orbitPoint).sub(apex.position);
        apex.desiredVelocity.y = 0;
        if (apex.desiredVelocity.lengthSq() > 1) apex.desiredVelocity.setLength(apex.speed * .7);
        if (canAct && apex.mineTimer <= 0) {
          apex.mineTimer = 7;
          apex.state = 'recover';
          apex.stateTimer = .9;
          this.onApexMine(apex);
        }
        if (canAct && apex.shockwaveTimer <= 0 && distanceXZ < 10) {
          apex.shockwaveTimer = 8;
          apex.state = 'recover';
          apex.stateTimer = .8;
          this.onApexShockwave(apex);
        }
        if (apex.state === 'recover' && apex.stateTimer <= 0) apex.state = 'patrol';
        break;
      }

      case 'sentinel': {
        if (apex.state === 'barrage' || apex.state === 'recover') {
          apex.desiredVelocity.set(0, 0, 0);
          if (apex.stateTimer <= 0) {
            apex.state = 'patrol';
            apex.stateTimer = 0;
          }
        } else {
          const orbitPoint = this.temp3.set(
            target.x + Math.sin(time * .28 + apex.phase) * 7,
            target.y + 3.5,
            target.z + Math.cos(time * .25 + apex.phase) * 7
          );
          apex.desiredVelocity.copy(orbitPoint).sub(apex.position);
          apex.desiredVelocity.y = 0;
          if (apex.desiredVelocity.lengthSq() > 1) apex.desiredVelocity.setLength(apex.speed * .7);
          const phase = apex.sentinelPhase || 1;
          const period = phase >= 3 ? 3.6 : phase === 2 ? 5 : 6.4;
          if (canAct && apex.attackCooldown <= 0) {
            apex.state = 'barrage';
            apex.stateTimer = 1.0;
            apex.attackCooldown = period;
            this.onApexAttack(apex, 'radial');
          }
          if (phase >= 3 && canAct && apex.summonTimer <= 0 && distanceXZ < 22) {
            apex.summonTimer = 9;
            this.onApexSummon(apex);
          }
        }
        break;
      }

      default: {
        const orbitPoint = this.temp3.set(
          target.x + Math.sin(time * .4 + apex.phase) * 5,
          target.y + 3,
          target.z + Math.cos(time * .36 + apex.phase) * 5
        );
        apex.desiredVelocity.copy(orbitPoint).sub(apex.position);
        apex.desiredVelocity.y = 0;
        if (apex.desiredVelocity.lengthSq() > 1) apex.desiredVelocity.setLength(apex.speed * .7);
      }
    }

    // Fuoco a distanza comune, diverso per archetipo.
    apex.fireTimer -= delta;
    if (canAct && distanceXZ < 34 && apex.fireTimer <= 0 && apex.state === 'patrol') {
      if (apex.archetypeId === 'wraith') {
        this.onApexAttack(apex, 'burst');
        apex.fireTimer = 3.6;
      } else if (apex.archetypeId === 'vex') {
        this.onApexAttack(apex, 'shot');
        apex.fireTimer = 2.4;
      } else if (apex.archetypeId === 'sentinel') {
        this.onApexAttack(apex, 'shot');
        apex.fireTimer = 1.9;
      } else {
        this.onApexAttack(apex, 'shot');
        apex.fireTimer = 2.8;
      }
    }
  }

  /** Applica danno all'Apex (armatura VANGUARD, fasi SENTINEL). */
  applyApexDamage(apex, amount) {
    if (!apex || !apex.alive) return { hit: false, killed: false, armorBroken: false, phaseChanged: false };
    let dealt = amount;
    let armorBroken = false;
    const armorMesh = apex.parts && apex.parts[0];
    if (apex.armorMax > 0 && !apex.armorBroken) {
      apex.armor -= Math.min(apex.armor, dealt);
      dealt *= .5;
      if (apex.armor <= 0) {
        apex.armorBroken = true;
        armorBroken = true;
        if (armorMesh && armorMesh.material) armorMesh.visible = false;
      }
    }
    apex.health -= dealt;
    apex.coreMaterial.emissive.setHex(0xff173c);
    apex.coreMaterial.emissiveIntensity = 2.7;
    const killed = apex.health <= 0;
    const prevPhase = apex.sentinelPhase || 1;
    if (killed) {
      apex.alive = false;
      apex.group.visible = false;
      apex.marker.style.display = 'none';
    } else if (apex.archetypeId === 'sentinel') {
      const ratio = apex.health / apex.maxHealth;
      const phase = ratio > APEX_TUNING.sentinelPhase2Hp ? 1 : ratio > APEX_TUNING.sentinelPhase3Hp ? 2 : 3;
      if (phase !== prevPhase) {
        apex.sentinelPhase = phase;
        apex.state = 'recover';
        apex.stateTimer = 1.2;
      }
    }
    return { hit: true, killed, armorBroken, phaseChanged: apex.sentinelPhase !== prevPhase, position: apex.position.clone() };
  }

  updateMarkers() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    for (const drone of this.drones) {
      if (!drone.alive) continue;
      // B6: riuso del vettore di proiezione (niente allocazioni per frame).
      const projected = this.markerProjected.copy(drone.position);
      const distance = projected.distanceTo(this.camera.position);
      projected.project(this.camera);
      const visible = projected.z > -1 && projected.z < 1 && Math.abs(projected.x) < .94 && Math.abs(projected.y) < .9;
      let screenX = projected.x;
      let screenY = projected.y;
      if (!visible) {
        if (projected.z > 1) { screenX *= -1; screenY *= -1; }
        screenX = THREE.MathUtils.clamp(screenX, -.9, .9);
        screenY = THREE.MathUtils.clamp(screenY, -.82, .82);
      }
      const left = Math.round((screenX * .5 + .5) * width);
      const top = Math.round((-screenY * .5 + .5) * height);
      const state = !visible ? 'THREAT' : drone.state === 'telegraph' ? 'EVADE' : '';
      const range = `${distance.toFixed(0)}M · SNT-${String(drone.id).padStart(2, '0')}`;

      // Dirty-check: scrive al DOM solo i valori realmente cambiati (B6).
      if (drone.lastOffscreen !== !visible) {
        drone.lastOffscreen = !visible;
        drone.marker.classList.toggle('offscreen', !visible);
        drone.marker.style.display = 'block';
      }
      if (drone.lastLeft !== left) {
        drone.lastLeft = left;
        drone.marker.style.left = `${left}px`;
      }
      if (drone.lastTop !== top) {
        drone.lastTop = top;
        drone.marker.style.top = `${top}px`;
      }
      if (drone.lastRange !== range) {
        drone.lastRange = range;
        drone.marker.dataset.range = range;
      }
      if (drone.lastState !== state) {
        drone.lastState = state;
        drone.markerState.textContent = state;
      }
      const healthPct = Math.max(0, drone.health / drone.maxHealth * 100);
      if (drone.lastHealth !== healthPct) {
        drone.lastHealth = healthPct;
        drone.markerHealth.style.width = `${healthPct}%`;
      }
    }

    // Marker dedicato per l'Apex di fine ondata.
    if (this.apex && this.apex.alive) {
      const apex = this.apex;
      const projected = this.markerProjected.copy(apex.position);
      const distance = projected.distanceTo(this.camera.position);
      projected.project(this.camera);
      const visible = projected.z > -1 && projected.z < 1 && Math.abs(projected.x) < .94 && Math.abs(projected.y) < .9;
      let screenX = projected.x;
      let screenY = projected.y;
      if (!visible) {
        if (projected.z > 1) { screenX *= -1; screenY *= -1; }
        screenX = THREE.MathUtils.clamp(screenX, -.9, .9);
        screenY = THREE.MathUtils.clamp(screenY, -.82, .82);
      }
      const left = Math.round((screenX * .5 + .5) * width);
      const top = Math.round((-screenY * .5 + .5) * height);
      const state = !visible ? 'THREAT' : apex.telegraphing ? 'TELEGRAPH' : apex.state === 'recover' ? 'STAGGERED' : '';
      const range = `${distance.toFixed(0)}M · APX-T${apex.tier}`;
      if (apex.lastOffscreen !== !visible) {
        apex.lastOffscreen = !visible;
        apex.marker.classList.toggle('offscreen', !visible);
        apex.marker.style.display = 'block';
      }
      if (apex.lastLeft !== left) { apex.lastLeft = left; apex.marker.style.left = `${left}px`; }
      if (apex.lastTop !== top) { apex.lastTop = top; apex.marker.style.top = `${top}px`; }
      if (apex.lastRange !== range) { apex.lastRange = range; apex.marker.dataset.range = range; }
      if (apex.lastState !== state) { apex.lastState = state; apex.markerState.textContent = state; }
      const healthPct = Math.max(0, apex.health / apex.maxHealth * 100);
      if (apex.lastHealth !== healthPct) { apex.lastHealth = healthPct; apex.markerHealth.style.width = `${healthPct}%`; }
    }
  }
}
