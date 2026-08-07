import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import {
  DRONE_TUNING, APEX_TUNING, APEX_ROSTER, ENDGAME_TUNING,
  getApexStats, getApexStatsFor, getMegaBossStats
} from './config.js';
import { makeRng } from './rng.js';
import { unlitBasic } from './materials.js';

const clampLength = (vector, max) => {
  if (vector.lengthSq() > max * max) vector.setLength(max);
  return vector;
};

/**
 * Marca come caster/receiver solo le parti solide di un drone o di un Apex.
 *
 * Restano fuori l'occhio (emissivo, opaco ma senza volume credibile) e ogni
 * mesh trasparente o additiva. Il filtro è per materiale e non per lista di
 * eccezioni perché con T1 le decorazioni d'archetipo — orbite VEX, orbite e
 * corona OVERLORD, afterimage WRAITH — sono entrate nel grafo della scena:
 * elencandole a mano, un archetipo aggiunto in seguito tornerebbe a proiettare
 * blocchi d'ombra opachi al posto di un bagliore.
 */
function applyShadowFlags(root, eye) {
  root.traverse(object => {
    if (!object.isMesh || object === eye) return;
    const material = object.material;
    if (material && (material.transparent === true || material.blending === THREE.AdditiveBlending)) return;
    object.castShadow = true;
    object.receiveShadow = true;
  });
}

export class DroneSystem {
  constructor({ scene, camera, targetLayer, targetProvider, onFire, onTelegraph, onApexAttack, onApexContact, onApexMine, onApexSummon, onApexShockwave, onApexTelegraph, arenaLimit }) {
    this.scene = scene;
    this.camera = camera;
    this.targetLayer = targetLayer;
    this.targetProvider = targetProvider;
    // M9: il limite dell'arena dei droni è iniettato da index.html (derivato da
    // CONFIG.arenaSize/wallThick/playerRadius) per evitare il drift tra il
    // perimetro fisico dei muri e il volo dei droni. Default: DRONE_TUNING.
    this.arenaLimit = arenaLimit ?? DRONE_TUNING.arenaLimit;
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
    this.apexes = [];
    // Fantasmi del blink: sagome che restano dove il WRAITH era e dove ricompare.
    // Poolizzate — un blink ogni ~2.4 s con tre archetipi in scena non deve
    // allocare geometria durante il combattimento.
    this.blinkFrom = new THREE.Vector3();
    this.blinkGhosts = [];
    // Primary alive Apex retained for older consumers; multi-boss-aware code
    // uses apexes/getAliveApexes/getBossHudState.
    this.apex = null;
  }

  /**
   * Sagoma che marca un capo del teletrasporto. `grow > 1` la dilata mentre
   * svanisce (partenza: il corpo si disperde), `grow < 1` la contrae (arrivo:
   * si ricompone). Senza queste il blink era invisibile: l'afterimage esistente
   * è figlia del gruppo e quindi si sposta CON l'Apex, marcando solo l'arrivo.
   */
  spawnBlinkGhost(position, apex, startScale, grow) {
    let ghost = this.blinkGhosts.find(entry => !entry.active);
    if (!ghost) {
      if (this.blinkGhosts.length >= 8) return null;
      ghost = {
        active: false,
        // `color` esplicito: la tinta viene poi presa dall'Apex a ogni riuso, ma
        // il materiale deve nascere con una Color già istanziata.
        mesh: new THREE.Mesh(this.coreGeometry, unlitBasic({
          color: 0xffffff, transparent: true, opacity: 0,
          blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
        }))
      };
      ghost.mesh.frustumCulled = false;
      this.scene.add(ghost.mesh);
      this.blinkGhosts.push(ghost);
    }
    ghost.active = true;
    ghost.age = 0;
    ghost.life = .42;
    ghost.startScale = startScale;
    ghost.endScale = startScale * grow;
    ghost.mesh.material.color.set(apex.coreMaterial.emissive.getHex());
    ghost.mesh.position.copy(position);
    if (ghost.mesh.quaternion?.copy && apex.group?.quaternion) ghost.mesh.quaternion.copy(apex.group.quaternion);
    ghost.mesh.scale.setScalar(startScale);
    ghost.mesh.visible = true;
    return ghost;
  }

  updateBlinkGhosts(delta) {
    for (const ghost of this.blinkGhosts) {
      if (!ghost.active) continue;
      ghost.age += delta;
      const t = Math.min(1, ghost.age / ghost.life);
      if (t >= 1) {
        ghost.active = false;
        ghost.mesh.visible = false;
        ghost.mesh.material.opacity = 0;
        continue;
      }
      // Sfarfallio anche sul fantasma: non svanisce liscio, si spegne a scatti.
      const stutter = .55 + Math.sin(ghost.age * 92) * .45;
      ghost.mesh.material.opacity = (1 - t) * (1 - t) * .85 * stutter;
      ghost.mesh.scale.setScalar(ghost.startScale + (ghost.endScale - ghost.startScale) * t);
    }
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
    for (const apex of this.apexes) {
      if (apex.group) this.scene.remove(apex.group);
      if (apex.marker) apex.marker.remove();
      if (apex.coreMaterial) apex.coreMaterial.dispose();
      if (apex.eye?.material) apex.eye.material.dispose();
      if (apex.eyeHalo?.material) apex.eyeHalo.material.dispose();
      if (apex.ring?.material) apex.ring.material.dispose();
      for (const thruster of apex.thrusters || []) thruster.material.dispose();
      for (const part of apex.parts || []) {
        if (part.material && part.material !== this.darkMaterial) part.material.dispose();
      }
    }
    this.apexes.length = 0;
    this.apex = null;
    for (const ghost of this.blinkGhosts || []) {
      ghost.active = false;
      ghost.mesh.visible = false;
    }
  }

  spawnWave(wave, count) {
    this.clear();
    this.wave = wave;
    for (let index = 0; index < count; index++) this.drones.push(this.createDrone(index, count));
    return this.drones.length;
  }

  /** Crea un Apex. Di default sostituisce l'incontro attivo. */
  spawnApex(wave, { stats = null, clear = true, index = 0, total = 1 } = {}) {
    if (clear) this.clearApex();
    this.wave = wave;
    const resolvedStats = stats || getApexStats(wave);
    const random = makeRng(9900 + wave * 137 + index * 977);
    const angle = total > 1 ? index / total * Math.PI * 2 + .35 : random() * Math.PI * 2;
    const radius = resolvedStats.mega ? 8.5 : 11.5 + random() * 2;
    const anchor = new THREE.Vector3(Math.sin(angle) * radius, 14, Math.cos(angle) * radius);
    const built = this.buildApexVisual(resolvedStats);
    const group = new THREE.Group();
    group.add(built.visual);
    group.scale.setScalar(resolvedStats.visualScale || 1);
    group.position.copy(anchor);
    this.scene.add(group);

    const marker = document.createElement('div');
    marker.className = 'target-marker apex-marker';
    marker.innerHTML = '<span class="target-health"><i></i></span><span class="target-state"></span>';
    this.targetLayer.appendChild(marker);
    const markerHealth = marker.querySelector('.target-health i');
    const markerState = marker.querySelector('.target-state');

    const apex = {
      id: resolvedStats.mega ? 'OMEGA' : `APX-${index + 1}`,
      archetypeId: resolvedStats.archetype.id,
      nameKey: resolvedStats.nameKey,
      tier: resolvedStats.tier,
      mega: Boolean(resolvedStats.mega),
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
      health: resolvedStats.maxHealth,
      maxHealth: resolvedStats.maxHealth,
      radius: resolvedStats.radius,
      fireTimer: 2,
      alive: true,
      spawnTimer: APEX_TUNING.spawnDescent,
      state: 'spawn',
      stateTimer: 0,
      attackCooldown: 1.6,
      damage: resolvedStats.damage,
      speed: resolvedStats.speed,
      // Per-archetipo: armatura, blink, fasi, cariche.
      armor: resolvedStats.archetype.id === 'vanguard' ? Math.round(resolvedStats.maxHealth * .42) : 0,
      armorMax: resolvedStats.archetype.id === 'vanguard' ? Math.round(resolvedStats.maxHealth * .42) : 0,
      armorBroken: false,
      blinkCooldown: 1.2,
      mineTimer: 2.4,
      shockwaveTimer: 5,
      chargeCount: 0,
      telegraphing: false,
      summonTimer: resolvedStats.mega ? 5 : 6,
      megaPhase: 1,
      megaAttackIndex: 0
    };
    this.apexes.push(apex);
    this.apex = this.apexes.find(candidate => candidate.alive) || apex;
    return apex;
  }

  spawnApexSquad(wave = ENDGAME_TUNING.gauntletWave) {
    this.clearApex();
    return APEX_ROSTER.map((archetype, index) => this.spawnApex(wave, {
      stats: getApexStatsFor(archetype, ENDGAME_TUNING.gauntletTier),
      clear: false,
      index,
      total: APEX_ROSTER.length
    }));
  }

  spawnMegaBoss(wave = ENDGAME_TUNING.finalWave) {
    return this.spawnApex(wave, { stats: getMegaBossStats() });
  }

  getAliveApexes() {
    return this.apexes.filter(apex => apex.alive);
  }

  getBossHudState() {
    // P1: chiamata ogni frame da updateHUD() durante i boss fight. Prima ogni
    // chiamata allocava un array (filter) + uno spread dell'intero oggetto
    // Apex; ora compila un unico oggetto riusato con i soli campi consumati da
    // HudController.renderBoss (alive, nameKey, tier, stateLabel, health,
    // maxHealth).
    const result = this._bossHudState || (this._bossHudState = {
      alive: true,
      nameKey: '',
      tier: 0,
      stateLabel: '',
      health: 0,
      maxHealth: 0
    });
    let aliveCount = 0;
    let healthSum = 0;
    let maxHealthSum = 0;
    let single = null;
    for (const apex of this.apexes) {
      maxHealthSum += apex.maxHealth;
      if (!apex.alive) continue;
      aliveCount++;
      healthSum += Math.max(0, apex.health);
      single = apex;
    }
    if (aliveCount === 0) return null;
    result.alive = true;
    if (this.apexes.length === 1) {
      result.nameKey = single.nameKey;
      result.tier = single.tier;
      result.stateLabel = single.mega ? `Ω-${single.megaPhase}` : `T-${single.tier}`;
      result.health = single.health;
      result.maxHealth = single.maxHealth;
    } else {
      result.nameKey = 'apex.council';
      result.tier = ENDGAME_TUNING.gauntletTier;
      result.stateLabel = `${aliveCount} ACTIVE`;
      result.health = healthSum;
      result.maxHealth = maxHealthSum;
    }
    return result;
  }

  /** Costruisce la silhouette visiva dell'Apex per archetipo e restituisce i riferimenti. */
  /**
   * Silhouette dell'Apex per archetipo **e tier**.
   *
   * Il roster cicla ogni 4 ondate, quindi lo stesso archetipo torna al tier 2 e
   * al tier 3: senza differenze visive l'ondata 5 sembrava l'ondata 1 con più
   * vita. Ogni archetipo cresce lungo la **propria** abilità — quella che il
   * tier 2 gli sblocca davvero — così la forma anticipa il comportamento invece
   * di essere una decorazione: piastre d'ariete per la doppia carica del
   * VANGUARD, lame per il triplo blink del WRAITH, orbite per le mine del VEX,
   * corone per i minion del SENTINEL. In più una cresta dorsale di `tier` pinne,
   * uguale per tutti: dice il rango a colpo d'occhio anche di spalle.
   */
  buildApexVisual(stats) {
    const visual = new THREE.Group();
    const tier = Math.max(1, Math.min(3, Math.round(stats.tier) || 1));
    const coreMaterial = new THREE.MeshPhysicalMaterial({
      color: 0x0c111a,
      metalness: .92,
      roughness: .2,
      clearcoat: .9,
      clearcoatRoughness: .08,
      envMapIntensity: 1.8,
      emissive: stats.color,
      // Il nucleo scotta di più a ogni ciclo.
      emissiveIntensity: .55 + (tier - 1) * .22
    });
    const parts = [];
    let coreScale = 1.15;
    let afterimage = null;
    switch (stats.archetype.id) {
      case 'vanguard': {
        coreScale = 1.55;
        const armorMaterial = new THREE.MeshPhysicalMaterial({ color: 0x141d2b, metalness: .9, roughness: .3, clearcoat: .5, envMapIntensity: 1.6 });
        // Una piastra d'ariete per tier, stratificate in avanti: è la doppia
        // carica del tier 2 resa forma. Marcate tutte, non solo la prima:
        // `applyApexDamage` le nasconde insieme quando l'armatura cede.
        for (let layer = 0; layer < tier; layer++) {
          const armor = new THREE.Mesh(this.armorGeometry, armorMaterial);
          armor.position.set(0, .02 - layer * .06, .46 + layer * .18);
          armor.rotation.x = .12 + layer * .05;
          armor.scale.setScalar(1 - layer * .17);
          armor.userData.apexArmor = true;
          parts.push(armor);
        }
        // Un paio di corni per tier, sempre più abbassati in assetto d'urto.
        for (let pair = 0; pair < tier; pair++) {
          for (const x of [-.95, .95]) {
            const spike = new THREE.Mesh(this.spikeGeometry, this.darkMaterial);
            spike.position.set(x * (1 - pair * .13), .32 - pair * .29, pair * .1);
            spike.rotation.z = x < 0 ? .5 : -.5;
            spike.rotation.x = -Math.PI / 2 - pair * .18;
            parts.push(spike);
          }
        }
        const lowerPlate = new THREE.Mesh(this.miniGeometry, this.darkMaterial);
        lowerPlate.scale.setScalar(2.1 + (tier - 1) * .22);
        lowerPlate.position.set(0, -.28, .1);
        parts.push(lowerPlate);
        break;
      }
      case 'wraith': {
        coreScale = 1.25;
        // Una lama per lato per tier: la sagoma si apre a ventaglio, e il
        // ventaglio è quanti blink può incatenare.
        for (let i = 0; i < tier; i++) {
          for (const x of [-.8, .8]) {
            const blade = new THREE.Mesh(this.bladeGeometry, this.darkMaterial);
            blade.position.set(x * (1 + i * .24), i * .2 - (tier - 1) * .1, -i * .14);
            blade.rotation.z = (x < 0 ? .1 : -.1) * (1 + i * 1.8);
            blade.rotation.y = x < 0 ? .25 : -.25;
            blade.scale.setScalar(1 - i * .13);
            parts.push(blade);
          }
        }
        const afterimageMat = unlitBasic({
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
          unlitBasic({ color: stats.color, transparent: true, opacity: .5, blending: THREE.AdditiveBlending, depthWrite: false })
        );
        core.scale.setScalar(3.4);
        parts.push(core);
        // Una mina in orbita in più per tier (3/4/5): il tier 2 ne posa 3
        // invece di 2, e si vede prima ancora che le sganci.
        const orbitTotal = 2 + tier;
        for (let i = 0; i < orbitTotal; i++) {
          const orb = new THREE.Mesh(this.orbitGeometry, unlitBasic({ color: stats.color, transparent: true, opacity: .85, blending: THREE.AdditiveBlending, depthWrite: false }));
          orb.userData.orbitIndex = i;
          orb.userData.orbitTotal = orbitTotal;
          orb.scale.setScalar(1 + (tier - 1) * .12);
          parts.push(orb);
        }
        break;
      }
      case 'sentinel': {
        coreScale = 1.9;
        // Corona superiore: 6/8/10 punte. Dal tier 2 se ne aggiunge una
        // inferiore, rivolta in basso — un rastrello di minion in più.
        const crown = 4 + tier * 2;
        for (let i = 0; i < crown; i++) {
          const spike = new THREE.Mesh(this.spikeGeometry, this.darkMaterial);
          const a = i / crown * Math.PI * 2;
          spike.position.set(Math.cos(a) * .62, .3, Math.sin(a) * .62);
          spike.rotation.x = -Math.PI / 2;
          parts.push(spike);
        }
        for (let i = 0; tier >= 2 && i < tier * 2; i++) {
          const spike = new THREE.Mesh(this.spikeGeometry, this.darkMaterial);
          const a = (i + .5) / (tier * 2) * Math.PI * 2;
          spike.position.set(Math.cos(a) * .5, -.36, Math.sin(a) * .5);
          spike.rotation.x = Math.PI / 2;
          spike.scale.setScalar(.72);
          parts.push(spike);
        }
        break;
      }
      case 'overlord': {
        coreScale = 1.85;
        // Corona tetra-assiale: leggibile anche a grande distanza e distinta
        // dalle silhouette del roster standard.
        for (let i = 0; i < 8; i++) {
          const spike = new THREE.Mesh(this.spikeGeometry, i % 2 ? this.darkMaterial : unlitBasic({ color: stats.color }));
          const a = i / 8 * Math.PI * 2;
          spike.position.set(Math.cos(a) * .78, Math.sin(i * 1.7) * .22, Math.sin(a) * .78);
          spike.rotation.x = -Math.PI / 2;
          spike.rotation.z = a;
          spike.scale.set(1.4, 2.2, 1.4);
          parts.push(spike);
        }
        for (let i = 0; i < 4; i++) {
          const orb = new THREE.Mesh(
            this.orbitGeometry,
            unlitBasic({ color: stats.color, transparent: true, opacity: .9, blending: THREE.AdditiveBlending, depthWrite: false })
          );
          orb.userData.overlordOrbitIndex = i;
          orb.scale.setScalar(1.35);
          parts.push(orb);
        }
        const crown = new THREE.Mesh(
          this.ringGeometry,
          unlitBasic({ color: 0xffffff, transparent: true, opacity: .7, blending: THREE.AdditiveBlending, depthWrite: false })
        );
        crown.userData.overlordCrown = true;
        crown.rotation.x = Math.PI / 2;
        crown.scale.setScalar(2.8);
        parts.push(crown);
        break;
      }
    }

    // Cresta dorsale: una pinna per tier, uguale per ogni archetipo. È il segno
    // di rango — si conta a colpo d'occhio, anche da dietro e anche quando la
    // silhouette dell'archetipo è coperta dal combattimento. Il mega boss ne è
    // escluso: OVERLORD è unico e non appartiene alla scala dei tier.
    if (stats.archetype.id !== 'overlord') {
      const crestMaterial = unlitBasic({ color: stats.color });
      for (let i = 0; i < tier; i++) {
        const fin = new THREE.Mesh(this.bladeGeometry, crestMaterial);
        fin.position.set(0, .46, .26 - i * .3);
        fin.rotation.x = -.22;
        fin.scale.set(.34, .52, .7);
        parts.push(fin);
      }
    }

    // T1: le parti specifiche dell'archetipo (armor, lame, afterimage, orbs,
    // spuntoni) restavano solo in `parts` (per il dispose) e non venivano mai
    // aggiunte al gruppo visivo: tutti gli Apex apparivano identici. Qui le
    // aggiungiamo al `visual` (filter `isMesh` perché `parts` può contenere
    // anche voci di solo materiale, come { material: secondRing.material }).
    for (const p of parts) if (p.isMesh) visual.add(p);

    // Corpo, occhio, due anelli, propulsori: comuni a tutti gli archetipi.
    const core = new THREE.Mesh(this.coreGeometry, coreMaterial);
    core.scale.setScalar(coreScale);
    visual.add(core);
    const eye = new THREE.Mesh(this.eyeGeometry, unlitBasic({ color: stats.color }));
    eye.position.set(0, .04, .5 * coreScale);
    eye.scale.setScalar(1.8);
    visual.add(eye);
    const eyeHalo = new THREE.Mesh(
      this.haloGeometry,
      unlitBasic({ color: stats.color, transparent: true, opacity: .3, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })
    );
    eyeHalo.position.set(0, .04, .52 * coreScale);
    eyeHalo.scale.setScalar(2);
    visual.add(eyeHalo);
    const ring = new THREE.Mesh(
      this.ringGeometry,
      unlitBasic({ color: stats.color, transparent: true, opacity: .85, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    ring.rotation.x = Math.PI / 2;
    ring.scale.setScalar(1.9);
    visual.add(ring);
    const secondRing = new THREE.Mesh(
      this.ringGeometry,
      unlitBasic({ color: stats.color, transparent: true, opacity: .4, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    secondRing.rotation.x = Math.PI / 2;
    secondRing.rotation.z = Math.PI / 4;
    secondRing.scale.setScalar(2.4);
    visual.add(secondRing);
    parts.push({ material: secondRing.material });

    const thrusters = [];
    for (const x of [-.7, .7]) {
      const material = unlitBasic({ color: stats.color, transparent: true, opacity: .85, blending: THREE.AdditiveBlending, depthWrite: false });
      const thruster = new THREE.Mesh(this.thrusterGeometry, material);
      thruster.position.set(x, -.55, -.05);
      thruster.scale.set(1.6, 1.6, 1.6);
      thruster.rotation.z = Math.PI;
      visual.add(thruster);
      thrusters.push(thruster);
    }
    applyShadowFlags(visual, eye);
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

    const eye = new THREE.Mesh(this.eyeGeometry, unlitBasic({ color: 0xff334f }));
    eye.position.set(0, .03, .49);
    visual.add(eye);
    const eyeHalo = new THREE.Mesh(
      this.haloGeometry,
      unlitBasic({ color: 0xff203f, transparent: true, opacity: .22, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })
    );
    eyeHalo.position.set(0, .03, .505);
    visual.add(eyeHalo);
    const ring = new THREE.Mesh(
      this.ringGeometry,
      unlitBasic({ color: index % 2 ? 0xff2d95 : 0x00e5ff, transparent: true, opacity: .72, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    ring.rotation.x = Math.PI / 2;
    visual.add(ring);

    const thrusters = [];
    for (const x of [-.46, .46]) {
      const material = unlitBasic({ color: 0x72f5ff, transparent: true, opacity: .75, blending: THREE.AdditiveBlending, depthWrite: false });
      const thruster = new THREE.Mesh(this.thrusterGeometry, material);
      thruster.position.set(x, -.38, -.05);
      thruster.rotation.z = Math.PI;
      visual.add(thruster);
      thrusters.push(thruster);
    }
    applyShadowFlags(visual, eye);

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
      const edge = this.arenaLimit;
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

  /** Aggiorna tutti gli Apex attivi e ritorna quanti sono ancora vivi. */
  updateApex(delta, time, { active = true, dead = false } = {}) {
    // Fuori dal ciclo sugli Apex: i fantasmi sopravvivono a chi li ha lasciati.
    this.updateBlinkGhosts(delta);
    let alive = 0;
    for (const apex of this.apexes) {
      if (this.updateSingleApex(apex, delta, time, { active, dead })) alive++;
    }
    this.apex = this.apexes.find(apex => apex.alive) || this.apexes[0] || null;
    return alive;
  }

  updateSingleApex(apex, delta, time, { active = true, dead = false } = {}) {
    if (!apex || !apex.alive) return false;
    const target = this.targetProvider();
    const edge = this.arenaLimit;

    // Fase di discesa: scende dall'alto senza attaccare.
    if (apex.spawnTimer > 0) {
      apex.spawnTimer -= delta;
      const progress = 1 - Math.max(0, apex.spawnTimer) / APEX_TUNING.spawnDescent;
      // L18: l'ancor di spawn è a y=14 (spawnApex); partire la lerp da 16
      // faceva saltare l'Apex a 16 al primo frame di discesa (pop verso l'alto).
      apex.position.y = THREE.MathUtils.lerp(14, 5.2, Math.min(1, progress));
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
    // Sfarfallio del teletrasporto. Il WRAITH non scompare e riappare: per mezzo
    // secondo resta instabile e si vede a scatti. Due frequenze incommensurabili
    // danno accensioni irregolari — una sola sinusoide si legge come un
    // lampeggio meccanico, e a certi frame rate potrebbe persino sparire del
    // tutto per battimento.
    if (apex.state === 'blink') {
      apex.visual.visible = Math.sin(time * 47.3) + Math.sin(time * 31.1) > -.4;
      apex.coreMaterial.emissiveIntensity = Math.max(apex.coreMaterial.emissiveIntensity, 2.4);
    } else if (apex.visual.visible === false) {
      apex.visual.visible = true;
    }
    this.animateArchetypeParts(apex, delta, time);
    return true;
  }

  /**
   * Anima le decorazioni specifiche dell'archetipo (orbite VEX e OVERLORD,
   * corona OVERLORD). Estratta da `updateSingleApex` per essere verificabile
   * senza costruire un frame completo: fino a T1 queste parti non erano nel
   * grafo della scena, quindi il movimento non si vedeva comunque.
   */
  animateArchetypeParts(apex, delta, time) {
    if (apex.archetypeId === 'vex') {
      let orbitIndex = 0;
      for (const part of apex.parts) {
        if (part.userData && part.userData.orbitIndex !== undefined) {
          // Lo sfasamento si divide sul numero REALE di orbite: era fisso a 3,
          // e dal tier 2 in poi le orbite in più si sarebbero sovrapposte.
          const total = part.userData.orbitTotal || 3;
          const a = time * 2.2 + orbitIndex * Math.PI * 2 / total;
          part.position.set(Math.cos(a) * 1.15, Math.sin(a * .8) * .5, Math.sin(a) * 1.15);
          orbitIndex++;
        }
      }
    } else if (apex.archetypeId === 'overlord') {
      for (const part of apex.parts) {
        const orbitIndex = part.userData?.overlordOrbitIndex;
        if (orbitIndex !== undefined) {
          const a = time * (1.15 + apex.megaPhase * .18) + orbitIndex * Math.PI / 2;
          part.position.set(Math.cos(a) * 1.25, Math.sin(a * 1.7) * .45, Math.sin(a) * 1.25);
        } else if (part.userData?.overlordCrown) {
          part.rotation.z += delta * (1.2 + apex.megaPhase * .35);
        }
      }
    }
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
            || Math.abs(apex.position.x) > this.arenaLimit - 1.5
            || Math.abs(apex.position.z) > this.arenaLimit - 1.5) {
            apex.state = 'recover';
            apex.stateTimer = 1.5;
            apex.chargeDir.set(0, 0, 0);
            apex.velocity.set(0, 0, 0);
          }
        } else if (apex.state === 'recover') {
          apex.desiredVelocity.set(0, 0, 0);
          if (apex.stateTimer <= 0) {
            // L3: abilità extra di tier 2 di VANGUARD — doppia carica (come per
            // le altre l'abilità è gate sul tier, non sul campo extraAbility).
            if (apex.tier >= 2 && apex.chargeCount < 1) {
              apex.chargeCount++;
              apex.state = 'telegraph';
              apex.stateTimer = .85;
              apex.telegraphing = true;
              this.onApexTelegraph(apex);
            } else {
              apex.chargeCount = 0;
              apex.state = 'patrol';
            }
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
          blinkTarget.x = THREE.MathUtils.clamp(blinkTarget.x, -this.arenaLimit + 2, this.arenaLimit - 2);
          blinkTarget.z = THREE.MathUtils.clamp(blinkTarget.z, -this.arenaLimit + 2, this.arenaLimit - 2);
          if (apex.afterimage) apex.afterimage.material.opacity = .75;
          // La posizione di partenza va catturata PRIMA del salto: serve al
          // fantasma e al pan del suono, che deve dire da dove a dove.
          this.blinkFrom.copy(apex.position);
          const ghostScale = Math.max(.9, apex.radius * 1.5);
          this.spawnBlinkGhost(this.blinkFrom, apex, ghostScale, 1.75);   // si disperde
          this.spawnBlinkGhost(blinkTarget, apex, ghostScale * 2.1, .55); // si ricompone
          apex.position.copy(blinkTarget);
          apex.velocity.set(0, 0, 0);
          apex.state = 'blink';
          apex.stateTimer = .5;
          apex.blinkCooldown = apex.tier >= 2 ? 2.4 : 3.4;
          this.onApexContact(apex, 'blink', this.blinkFrom, blinkTarget);
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
        // S2: anche VEX si ferma durante 'recover' (telegraph per mine/
        // shockwave) come VANGUARD/WRAITH/SENTINEL: prima orbitava comunque.
        if (apex.state === 'recover') {
          apex.desiredVelocity.set(0, 0, 0);
        } else {
          apex.desiredVelocity.copy(orbitPoint).sub(apex.position);
          apex.desiredVelocity.y = 0;
          if (apex.desiredVelocity.lengthSq() > 1) apex.desiredVelocity.setLength(apex.speed * .7);
        }
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

      case 'overlord': {
        if (apex.state === 'barrage' || apex.state === 'recover') {
          apex.desiredVelocity.set(0, 0, 0);
          if (apex.stateTimer <= 0) {
            apex.state = 'patrol';
            apex.telegraphing = false;
          }
        } else {
          const orbitPoint = this.temp3.set(
            target.x + Math.sin(time * .2 + apex.phase) * 8,
            target.y + 5,
            target.z + Math.cos(time * .18 + apex.phase) * 8
          );
          apex.desiredVelocity.copy(orbitPoint).sub(apex.position);
          apex.desiredVelocity.y = 0;
          if (apex.desiredVelocity.lengthSq() > 1) apex.desiredVelocity.setLength(apex.speed);
        }
        if (canAct && apex.attackCooldown <= 0 && apex.state === 'patrol') {
          const attack = apex.megaAttackIndex++ % 4;
          const cooldown = Math.max(2.5, 4.6 - apex.megaPhase * .45);
          apex.attackCooldown = cooldown;
          apex.state = 'barrage';
          apex.stateTimer = attack === 2 ? 1.25 : .85;
          apex.telegraphing = true;
          this.onApexTelegraph(apex);
          if (attack === 0) this.onApexAttack(apex, 'megaSpiral');
          else if (attack === 1) this.onApexAttack(apex, 'megaLance');
          else if (attack === 2) this.onApexAttack(apex, 'megaBombard');
          else this.onApexShockwave(apex);
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
    if (!apex.mega && canAct && distanceXZ < 34 && apex.fireTimer <= 0 && apex.state === 'patrol') {
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
    const armorPlates = apex.parts?.filter(part => part.userData?.apexArmor) || [];
    if (apex.armorMax > 0 && !apex.armorBroken) {
      apex.armor -= Math.min(apex.armor, dealt);
      dealt *= .5;
      if (apex.armor <= 0) {
        apex.armorBroken = true;
        armorBroken = true;
        // Dal tier 2 le piastre sono più d'una: cadono tutte insieme.
        for (const plate of armorPlates) plate.visible = false;
      }
    }
    apex.health -= dealt;
    apex.coreMaterial.emissive.setHex(0xff173c);
    apex.coreMaterial.emissiveIntensity = 2.7;
    const killed = apex.health <= 0;
    const prevPhase = apex.mega ? (apex.megaPhase || 1) : (apex.sentinelPhase || 1);
    if (killed) {
      apex.alive = false;
      apex.group.visible = false;
      apex.marker.style.display = 'none';
    } else if (apex.mega) {
      const ratio = apex.health / apex.maxHealth;
      const phase = ratio > .75 ? 1 : ratio > .5 ? 2 : ratio > .25 ? 3 : 4;
      if (phase !== prevPhase) {
        apex.megaPhase = phase;
        apex.state = 'recover';
        apex.stateTimer = 1.4;
        apex.attackCooldown = .8;
        this.onApexSummon(apex);
        this.onApexShockwave(apex);
      }
    } else if (apex.archetypeId === 'sentinel') {
      const ratio = apex.health / apex.maxHealth;
      const phase = ratio > APEX_TUNING.sentinelPhase2Hp ? 1 : ratio > APEX_TUNING.sentinelPhase3Hp ? 2 : 3;
      if (phase !== prevPhase) {
        apex.sentinelPhase = phase;
        apex.state = 'recover';
        apex.stateTimer = 1.2;
      }
    }
    const currentPhase = apex.mega ? (apex.megaPhase || 1) : (apex.sentinelPhase || 1);
    return { hit: true, killed, armorBroken, phaseChanged: currentPhase !== prevPhase, position: apex.position.clone() };
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
      // P5: posizionamento via transform invece di left/top: il movimento dei
      // marker avviene sul compositor senza invalidare il layout a ogni frame.
      // translate(-50%,-50%) replica la centratura dichiarata nel CSS base.
      if (drone.lastLeft !== left || drone.lastTop !== top) {
        drone.lastLeft = left;
        drone.lastTop = top;
        drone.marker.style.transform = `translate3d(${left}px, ${top}px, 0) translate(-50%, -50%)`;
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

    // Marker dedicati: nel gauntlet dell'ondata 9 tutti e quattro gli Apex
    // restano tracciabili contemporaneamente.
    for (const apex of this.apexes) {
      if (!apex.alive) continue;
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
      const range = `${distance.toFixed(0)}M · ${apex.mega ? 'OMEGA' : `APX-T${apex.tier}`}`;
      if (apex.lastOffscreen !== !visible) {
        apex.lastOffscreen = !visible;
        apex.marker.classList.toggle('offscreen', !visible);
        apex.marker.style.display = 'block';
      }
      // P5: come per i droni — transform compositor-only al posto di left/top.
      if (apex.lastLeft !== left || apex.lastTop !== top) {
        apex.lastLeft = left;
        apex.lastTop = top;
        apex.marker.style.transform = `translate3d(${left}px, ${top}px, 0) translate(-50%, -50%)`;
      }
      if (apex.lastRange !== range) { apex.lastRange = range; apex.marker.dataset.range = range; }
      if (apex.lastState !== state) { apex.lastState = state; apex.markerState.textContent = state; }
      const healthPct = Math.max(0, apex.health / apex.maxHealth * 100);
      if (apex.lastHealth !== healthPct) { apex.lastHealth = healthPct; apex.markerHealth.style.width = `${healthPct}%`; }
    }
  }
}
