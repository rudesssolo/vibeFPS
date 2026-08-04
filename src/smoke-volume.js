import * as THREE from 'three';
import {
  Fn, Loop, attribute, cameraPosition, color, dot, exp, float, hash, length,
  max, modelPosition, modelScale, normalize, positionWorld, pow, saturate,
  screenCoordinate, sqrt, triNoise3D, vec3, vec4
} from 'three/tsl';

// Fumo volumetrico delle esplosioni, renderizzato in 3D tramite raymarching.
//
// Ogni "puff" è una sfera (geometria unitaria) con un materiale NodeMaterial
// condiviso che, nel fragment shader, raymarcia il volume: ricostruisce il raggio
// vista (camera -> fragment), interseca la sfera del puff e integra la densità
// lungo il segmento usando un noise 3D (triNoise3D). Il fumo risultante ha
// parallasse reale, illuminazione per fase (Henyey-Greenstein), ombreggiatura
// interna (self-shadow) e un innesto caldo vicino all'origine dell'esplosione.
// Essendo un vero volume, si riflette anche sul pavimento bagnato (il reflector
// della scena lo renderizza dalla propria camera virtuale).
//
// Centro e raggio della sfera NON sono attributi: derivano da modelPosition e
// modelScale, cioè da mesh.position / mesh.scale, che sono uniform per-oggetto
// aggiornate automaticamente dal renderer. Restano attributi solo i dati che
// non sono esprimibili come trasformazione (densità, colore, origine, seed,
// tempo del noise); di questi solo densità e tempo cambiano ogni frame.

// Qualità del raymarch. Valori più alti = più passi, più costo GPU.
// Sono parametri di COSTRUZIONE, non di runtime: finiscono nel corpo dello
// shader (Loop non è dinamico), quindi cambiarli richiede una ricompilazione.
// I profili qualità agiscono invece sul numero di puff (vedi setQuality).
const DEFAULT_STEPS = 16;        // passi di integrazione della densità
const DEFAULT_SHADOW_STEPS = 2;  // passi del self-shadow (marcia verso la luce)
const MAX_PUFFS = 24;            // pool massimo di volumi contemporanei

// La icosfera è INSCRITTA nella sfera analitica raymarchata: senza margine il
// guscio esterno del volume verrebbe tagliato dalla silhouette del poliedro.
// Per IcosahedronGeometry(1, 2) il rapporto inradius/circumradius è ~0.97.
const HULL_MARGIN = 1.04;

// Direzioni verso le sorgenti di luce (world, puntano verso la luce).
// Moon: [-60, 90, -110] normalizzato; rim caldo: [70, 30, 90] normalizzato.
const L_MOON = vec3(-0.39, 0.58, -0.71);
const L_RIM = vec3(0.59, 0.25, 0.76);

// Fase di Henyey-Greenstein (diffusione della luce nel fumo).
function hg(cosTheta, g) {
  const g2 = g * g;
  return float(1 - g2).div(
    pow(float(1 + g2).sub(float(2 * g).mul(cosTheta)), float(1.5))
  );
}

export class VolumetricSmokeSystem {
  constructor(scene, { steps = DEFAULT_STEPS, shadowSteps = DEFAULT_SHADOW_STEPS } = {}) {
    this.scene = scene;
    this.steps = Math.max(4, Math.round(steps));
    this.shadowSteps = Math.max(1, Math.round(shadowSteps));
    this.maximum = MAX_PUFFS;
    // Regolati da setQuality(): quanti puff genera un'esplosione e quanti
    // volumi possono essere vivi insieme (tetto all'overdraw del raymarch).
    this.puffBudget = 8;
    this.maxActive = MAX_PUFFS;
    this.cursor = 0;
    this.activeCount = 0;
    this.puffs = Array.from({ length: MAX_PUFFS }, () => ({
      active: false,
      mesh: null,
      inside: false,
      age: 0,
      life: 1,
      radius: 0.5,
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      origin: new THREE.Vector3(),
      color: new THREE.Color(),
      radiusStart: 0.5,
      radiusEnd: 3,
      density: 1,
      gravity: 0,
      drag: 0,
      turbulence: 0,
      phase: 0,
      noiseSpeed: 0.6,
      noiseTime: 0
    }));
    // Sfera unitaria (detail 2): silhouette sufficientemente liscia per un
    // volume raymarchato; il fill è dominato dal raymarch, non dai vertici.
    this.baseGeometry = new THREE.IcosahedronGeometry(1, 2);
    // Due varianti dello STESSO grafo di nodi, che differiscono solo per il
    // culling delle facce. Il volume è chiuso, quindi quale faccia porta il
    // fragment cambia il comportamento nei due casi limite:
    //
    //  - camera FUORI dal puff (caso normale): serve la faccia anteriore. È la
    //    più vicina, quindi il depth test contro la scena si comporta come
    //    l'occlusione reale del volume.
    //  - camera DENTRO il puff (frequente: i puff crescono di metri e nascono
    //    sulle kill): la faccia anteriore è dietro la camera e viene cullata,
    //    il volume spariva del tutto. Serve la faccia posteriore.
    //
    // Usare BackSide sempre non funziona: l'hull posteriore di un puff appoggiato
    // a terra finisce sotto il pavimento e il depth test scarterebbe l'intero
    // volume. DoubleSide invece comporrebbe il volume due volte dove entrambe le
    // facce passano. Da qui la commutazione per-puff, decisa sulla CPU in update().
    this.material = this._buildMaterial(THREE.FrontSide);
    this.materialInside = this._buildMaterial(THREE.BackSide);
    // Warmup delle pipeline: due mesh a scala 0 restano nel render graph così la
    // compilazione degli shader non cade sulla prima esplosione (stesso motivo
    // per cui ExplosionSystem tiene le shockwave in scena con opacity 0).
    this.warmupMeshes = [this.material, this.materialInside].map(material => {
      const mesh = new THREE.Mesh(this._createPuffGeometry(), material);
      mesh.frustumCulled = false;
      mesh.scale.setScalar(0);
      scene.add(mesh);
      return mesh;
    });
  }

  _buildMaterial(side) {
    // Centro e raggio arrivano dalla trasformazione dell'oggetto: mesh.position
    // e mesh.scale (uniform per-oggetto, zero attributi e zero upload).
    const center = modelPosition;
    const radius = modelScale.x.div(float(HULL_MARGIN));
    // Dati per-puff che non sono una trasformazione, letti come attributi del
    // vertice (costanti per vertice => costanti nel fragment del puff corrente).
    const densityA = attribute('aDensity', 'float');
    const colorA = attribute('aColor', 'vec3');
    const origin = attribute('aOrigin', 'vec3');
    const seed = attribute('aSeed', 'float');
    const noiseT = attribute('aNoise', 'float');

    const STEPS = this.steps;
    const SHADOW_STEPS = this.shadowSteps;

    const march = Fn(() => {
      const rayOrigin = cameraPosition;
      const rayDir = normalize(positionWorld.sub(cameraPosition));

      // Intersezione analitica raggio-sfera (materializza il volume anche quando
      // la camera è dentro la sfera: tNear = 0).
      const oc = rayOrigin.sub(center);
      const b = dot(oc, rayDir);
      const c2 = dot(oc, oc).sub(radius.mul(radius));
      const disc = b.mul(b).sub(c2);
      const t0 = b.negate().sub(sqrt(max(disc, float(0))));
      const t1 = b.negate().add(sqrt(max(disc, float(0))));
      const tNear = max(t0, float(0));
      const tFar = max(tNear, t1);
      const stepSize = tFar.sub(tNear).div(float(STEPS));
      // Jitter randomico per ridurre le bande di integrazione.
      const jitter = hash(screenCoordinate.x.mul(104729.0).add(screenCoordinate.y))
        .mul(stepSize).sub(stepSize.mul(0.5));

      const p = rayOrigin.add(rayDir.mul(tNear.add(jitter))).toVar();
      const transmittance = float(1).toVar();
      const scattered = vec3(0).toVar();

      Loop(STEPS, () => {
        const local = p.sub(center);
        const dist = length(local);
        const rn = dist.div(max(radius, float(0.001)));
        // Envelope morbida: 1 al centro, 0 al bordo (curva quadratica).
        let envelope = float(1).sub(rn.mul(rn));
        envelope = saturate(envelope.mul(envelope));
        // Frequenza del noise relativa al raggio del puff.
        const noisePos = local.div(max(radius.mul(0.5), float(0.01)));
        const noiseVal = triNoise3D(noisePos, float(0.7), noiseT.add(seed));
        const densitySample = saturate(noiseVal.mul(0.55)).mul(envelope).mul(densityA);

        const dOd = densitySample.mul(stepSize).mul(float(0.5));
        transmittance.mulAssign(exp(dOd.negate()));

        // Fase di diffusione verso le due luci direzionali.
        const phaseMoon = hg(dot(rayDir, L_MOON), 0.42);
        const phaseRim = hg(dot(rayDir, L_RIM), -0.25);
        // Self-shadow: marcia breve verso la luce accumulando densità.
        const shadowP = p.toVar();
        const shadowStep = radius.mul(1.6).div(float(SHADOW_STEPS));
        const shadowDensity = float(0).toVar();
        Loop(SHADOW_STEPS, () => {
          shadowP.addAssign(L_MOON.mul(shadowStep));
          const sl = shadowP.sub(center);
          const sd = length(sl);
          const srn = sd.div(max(radius, float(0.001)));
          let senv = float(1).sub(srn.mul(srn));
          senv = saturate(senv.mul(senv));
          const snoise = triNoise3D(sl.div(max(radius.mul(0.5), float(0.01))), float(0.7), noiseT.add(seed));
          shadowDensity.addAssign(saturate(snoise.mul(0.55)).mul(senv).mul(densityA).mul(shadowStep));
        });
        const shadow = exp(shadowDensity.negate().mul(float(1.6)));

        const moonLight = color(0x9fc0ff).mul(phaseMoon).mul(float(2.4)).mul(shadow);
        const rimLight = color(0xff6a2d).mul(phaseRim).mul(float(1.1)).mul(shadow);
        const ambient = color(0x3a4354).mul(float(0.55)).mul(shadow.mul(0.6).add(float(0.4)));
        // Innesto caldo vicino all'origine dell'esplosione (core incandescente).
        const dOrigin = length(p.sub(origin));
        const hot = saturate(float(1).sub(dOrigin.div(max(radius.mul(2.6), float(0.01)))));
        const hotLight = color(0xff8a3c).mul(hot.mul(hot)).mul(float(2.2));
        // Emissione propria della fuliggine (si illumina anche in ombra).
        const emission = color(1.0, 0.45, 0.14).mul(hot.mul(hot))
          .mul(densitySample.mul(densitySample)).mul(float(2.0));

        const lightCol = moonLight.add(rimLight).add(ambient).add(hotLight);
        const tinted = lightCol.mul(colorA).add(emission);
        scattered.addAssign(tinted.mul(densitySample).mul(stepSize).mul(transmittance));
        p.addAssign(rayDir.mul(stepSize));
      });

      return vec4(scattered, float(1).sub(transmittance));
    });

    const material = new THREE.NodeMaterial();
    material.fragmentNode = march();
    material.transparent = true;
    material.depthWrite = false;
    material.side = side;
    material.toneMapped = false;
    // `scattered` è radianza già integrata e pesata per trasmittanza/densità,
    // cioè alpha PREMOLTIPLICATA. Con NormalBlending verrebbe moltiplicata una
    // seconda volta per l'alpha, scurendo sistematicamente il fumo.
    material.blending = THREE.CustomBlending;
    material.blendSrc = THREE.OneFactor;
    material.blendDst = THREE.OneMinusSrcAlphaFactor;
    material.blendSrcAlpha = THREE.OneFactor;
    material.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
    material.fog = false;
    return material;
  }

  /**
   * Numero di puff per esplosione e tetto ai volumi simultanei. Il costo del
   * raymarch è per-pixel e i puff si sovrappongono: il tetto sull'overdraw
   * conta più del numero di spawn.
   */
  setQuality(profile) {
    const budget = Number.isFinite(profile?.smokePuffs) ? profile.smokePuffs : 8;
    this.puffBudget = Math.max(0, Math.min(MAX_PUFFS, Math.round(budget)));
    this.maxActive = Math.max(this.puffBudget, Math.min(MAX_PUFFS, this.puffBudget * 3));
  }

  /**
   * Geometria di un puff: position/normal/uv sono CONDIVISE con la geometria
   * base (il renderer carica quei buffer una volta sola per tutto il pool),
   * gli attributi per-puff sono privati. Solo densità e tempo del noise sono
   * dinamici: colore, origine e seed si scrivono una volta allo spawn.
   */
  _createPuffGeometry() {
    const count = this.baseGeometry.attributes.position.count;
    const geometry = new THREE.BufferGeometry();
    for (const name of ['position', 'normal', 'uv']) {
      const shared = this.baseGeometry.getAttribute(name);
      if (shared) geometry.setAttribute(name, shared);
    }
    const index = this.baseGeometry.getIndex();
    if (index) geometry.setIndex(index);
    const addAttribute = (name, itemSize, dynamic) => {
      const attributeData = new THREE.BufferAttribute(new Float32Array(count * itemSize), itemSize);
      if (dynamic) attributeData.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute(name, attributeData);
      return attributeData;
    };
    geometry.vibeAttributes = {
      density: addAttribute('aDensity', 1, true),
      noise: addAttribute('aNoise', 1, true),
      color: addAttribute('aColor', 3, false),
      origin: addAttribute('aOrigin', 3, false),
      seed: addAttribute('aSeed', 1, false)
    };
    return geometry;
  }

  /** Le mesh sono allocate una volta per slot e riusate: nessun churn di GPU. */
  _acquireMesh(puff) {
    if (puff.mesh) return puff.mesh;
    const mesh = new THREE.Mesh(this._createPuffGeometry(), this.material);
    mesh.frustumCulled = false;
    mesh.visible = false;
    this.scene.add(mesh);
    puff.mesh = mesh;
    return mesh;
  }

  spawn(options) {
    if (this.puffBudget === 0) return;
    let puff = null;
    for (let search = 0; search < this.maximum; search++) {
      const index = (this.cursor + search) % this.maximum;
      if (!this.puffs[index].active) {
        puff = this.puffs[index];
        this.cursor = (index + 1) % this.maximum;
        break;
      }
    }
    if (puff) {
      // Tetto all'overdraw: oltre maxActive volumi vivi si rinuncia al puff
      // invece di riciclarne uno ancora visibile (che farebbe un pop).
      if (this.activeCount >= this.maxActive) return;
    } else {
      // L5: nessuno slot libero — si rinuncia al nuovo puff invece di
      // sovrascrivere un volume ancora visibile (pop). Il commento qui sopra
      // dichiarava già questa intenzione ma il ramo la contraddiceva: con la
      // coda piena a Ultra i nuovi spawn rimpiazzavano i vivi a raffica.
      return;
    }
    puff.position.copy(options.position || new THREE.Vector3());
    puff.velocity.copy(options.velocity || new THREE.Vector3());
    puff.origin.copy(options.origin || puff.position);
    puff.color.set(options.color || 0xffffff);
    puff.age = -(options.delay || 0);
    puff.life = options.life || 1;
    puff.radiusStart = options.radiusStart ?? 0.5;
    puff.radiusEnd = options.radiusEnd ?? 3;
    puff.density = options.density ?? 1;
    puff.gravity = options.gravity || 0;
    puff.drag = options.drag || 0;
    puff.turbulence = options.turbulence || 0;
    puff.phase = options.phase ?? Math.random() * Math.PI * 2;
    puff.noiseTime = 0;
    puff.noiseSpeed = options.noiseSpeed || 0.6;
    puff.radius = Math.max(puff.radiusStart, 0.001);
    puff.inside = false;

    // activeCount incrementato SOLO a puff effettivamente attivato (dopo
    // _acquireMesh): se l'acquisizione della mesh lancia, il contatore non
    // deriva (stessa classe di bug L5/L6).
    let mesh;
    try {
      mesh = this._acquireMesh(puff);
    } catch (error) {
      return;
    }
    // L6: puff attivo SOLO dopo che la mesh è stata acquisita con successo.
    puff.active = true;
    this.activeCount++;
    const attributes = mesh.geometry.vibeAttributes;
    // Costanti per la vita del puff: scritte una volta sola qui.
    this._fill(attributes.color, [puff.color.r, puff.color.g, puff.color.b]);
    this._fill(attributes.origin, [puff.origin.x, puff.origin.y, puff.origin.z]);
    attributes.seed.array.fill(Math.random() * 100);
    attributes.seed.needsUpdate = true;
    mesh.material = this.material;
    mesh.position.copy(puff.position);
    mesh.scale.setScalar(puff.radius * HULL_MARGIN);
    // Un puff con delay non deve essere visibile a densità piena prima di
    // iniziare la propria vita: update() lo riaccende quando age >= 0.
    mesh.visible = puff.age >= 0;
    this._writeFrameAttributes(puff, puff.density);
  }

  _fill(attributeData, values) {
    const array = attributeData.array;
    const itemSize = attributeData.itemSize;
    for (let i = 0; i < attributeData.count; i++) {
      for (let k = 0; k < itemSize; k++) array[i * itemSize + k] = values[k];
    }
    attributeData.needsUpdate = true;
  }

  _writeFrameAttributes(puff, density) {
    const attributes = puff.mesh.geometry.vibeAttributes;
    attributes.density.array.fill(density);
    attributes.density.needsUpdate = true;
    attributes.noise.array.fill(puff.noiseTime);
    attributes.noise.needsUpdate = true;
  }

  _release(puff) {
    if (puff.mesh) puff.mesh.visible = false;
  }

  update(delta, camera = null) {
    if (this.activeCount === 0) return;
    for (const puff of this.puffs) {
      if (!puff.active) continue;
      puff.age += delta;
      if (puff.age < 0) continue; // delay: la mesh resta invisibile
      if (!puff.mesh.visible) puff.mesh.visible = true;
      const t = Math.min(1, puff.age / puff.life);

      // Integrazione del moto (velocità, gravità, turbolenza).
      puff.velocity.multiplyScalar(Math.max(0, 1 - puff.drag * delta));
      puff.velocity.y -= puff.gravity * delta;
      if (puff.turbulence > 0) {
        const turb = puff.turbulence;
        puff.position.x += Math.sin(puff.age * 2.4 + puff.phase) * turb * delta;
        puff.position.z += Math.cos(puff.age * 1.8 + puff.phase * 1.3) * turb * delta;
        puff.position.y += Math.sin(puff.age * 2.1 + puff.phase * 2.1) * turb * .6 * delta;
      }
      puff.position.addScaledVector(puff.velocity, delta);

      // Crescita del raggio (ease-out) + decadimento della densità.
      const ease = 1 - Math.pow(1 - t, 2.2);
      const radius = Math.max(puff.radiusStart + (puff.radiusEnd - puff.radiusStart) * ease, 0.001);
      const density = puff.density * (1 - t) * (0.35 + 0.65 * (1 - t));
      puff.noiseTime += delta * puff.noiseSpeed;
      puff.radius = radius;

      // Centro e raggio del volume viaggiano nella trasformazione della mesh:
      // il fragment shader li rilegge da modelPosition / modelScale.
      puff.mesh.position.copy(puff.position);
      puff.mesh.scale.setScalar(radius * HULL_MARGIN);
      this._writeFrameAttributes(puff, density);
      if (camera) this._syncFacing(puff, camera);

      if (t >= 1) {
        puff.active = false;
        this.activeCount--;
        this._release(puff);
      }
    }
  }

  /**
   * Commuta la variante del materiale quando la camera entra o esce dal volume.
   * Il margine evita che il materiale sfarfalli sul bordo esatto.
   */
  _syncFacing(puff, camera) {
    const hull = puff.radius * HULL_MARGIN;
    const threshold = puff.inside ? hull + .35 : hull + .12;
    const inside = camera.position.distanceToSquared(puff.position) < threshold * threshold;
    if (inside === puff.inside) return;
    puff.inside = inside;
    puff.mesh.material = inside ? this.materialInside : this.material;
  }

  reset() {
    this.cursor = 0;
    this.activeCount = 0;
    for (const puff of this.puffs) {
      puff.active = false;
      puff.age = 0;
      puff.inside = false;
      if (puff.mesh) puff.mesh.material = this.material;
      this._release(puff);
    }
  }

  dispose() {
    const releaseGeometry = mesh => {
      this.scene.remove(mesh);
      // position/normal/uv sono condivise con baseGeometry: vanno staccate
      // prima del dispose, altrimenti liberano buffer ancora in uso dal pool.
      for (const name of ['position', 'normal', 'uv']) mesh.geometry.deleteAttribute(name);
      mesh.geometry.setIndex(null);
      mesh.geometry.dispose();
    };
    for (const puff of this.puffs) {
      if (!puff.mesh) continue;
      releaseGeometry(puff.mesh);
      puff.mesh = null;
    }
    for (const mesh of this.warmupMeshes) releaseGeometry(mesh);
    this.warmupMeshes.length = 0;
    this.baseGeometry.dispose();
    this.material.dispose();
    this.materialInside.dispose();
    this.activeCount = 0;
  }
}
