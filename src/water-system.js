import * as THREE from 'three';
import {
  clamp, dot, float, normalView, positionViewDirection, screenUV, smoothstep, uv, vec3
} from 'three/tsl';
import { makeRng } from './rng.js';
import { unlitBasic } from './materials.js';

/** Sorgenti di increspatura simultanee. */
export const RIPPLE_SLOTS = 14;

/** Quanto a lungo un'increspatura resta viva, in secondi. */
export const RIPPLE_LIFE = 3.4;

/** Velocità del fronte d'onda, m/s. */
export const RIPPLE_SPEED = 2.4;

/**
 * Quanto la pendenza dell'onda viene amplificata nel calcolo della normale.
 *
 * L'increspatura di una pozza è alta pochi centimetri: alzando la geometria
 * quanto basta a *vedersi* si otterrebbero onde da mezzo metro, che in una
 * pozzanghera sono assurde. Ciò che si vede davvero è il riflesso che si piega,
 * e quello dipende dalla normale: si tiene la superficie bassa e si inclina di
 * più. È un'esagerazione dichiarata, non un errore di unità.
 */
export const NORMAL_BOOST = 4.5;

/**
 * Soglia oltre la quale un punto è acqua. Vive qui e non in due posti: da qui
 * nasce la geometria della pozza, e con questa la CPU decide dove possono
 * partire le onde.
 */
export const PUDDLE_THRESHOLD = .3;

/**
 * Quanto la mesh si spinge OLTRE il bordo dell'acqua. Serve alla dissolvenza:
 * senza banda, l'alfa dovrebbe cadere a zero esattamente sull'ultimo vertice e
 * il contorno resterebbe un gradino netto lungo il reticolo delle celle.
 */
export const PUDDLE_FEATHER = .12;

/**
 * Maschera delle pozzanghere: chiazze morbide sovrapposte, deterministica.
 *
 * @returns {Float32Array} un valore 0..1 per cella, riga per riga
 */
function makeValueNoise(gridSize, random) {
  const grid = new Float32Array(gridSize * gridSize);
  for (let i = 0; i < grid.length; i++) grid[i] = random();
  return grid;
}

/** Rumore a valori, bilineare e ciclico. */
function sampleNoise(grid, gridSize, x, y) {
  const fx = ((x % gridSize) + gridSize) % gridSize;
  const fy = ((y % gridSize) + gridSize) % gridSize;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = (x0 + 1) % gridSize;
  const y1 = (y0 + 1) % gridSize;
  const tx = fx - x0;
  const ty = fy - y0;
  // Interpolazione morbida: con quella lineare si vedrebbe il reticolo del
  // rumore nei contorni deformati.
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const a = grid[y0 * gridSize + x0];
  const b = grid[y0 * gridSize + x1];
  const c = grid[y1 * gridSize + x0];
  const d = grid[y1 * gridSize + x1];
  return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
}

export function computePuddleMask(size = 128, coverage = .52, seed = 4711) {
  const level = new Float32Array(size * size);
  const random = makeRng(seed);
  // Copertura 0 = arena asciutta. Un termine costante qui avrebbe lasciato
  // pozze anche a zero, cioè un parametro che non spegne quel che governa.
  const blobs = Math.round(coverage * 22);
  // Il dominio viene deformato da due ottave di rumore prima di valutare le
  // chiazze: senza, ogni pozza resta l'ellisse che l'ha generata — regolare e
  // riconoscibile. Deformando le coordinate i contorni diventano frastagliati e
  // le chiazze vicine si fondono in forme che non si ripetono.
  const warpA = makeValueNoise(8, random);
  const warpB = makeValueNoise(19, random);
  const warpAmplitude = size * .14;
  const warpAt = (x, y) => {
    const nx = sampleNoise(warpA, 8, x / size * 8, y / size * 8) - .5
      + (sampleNoise(warpB, 19, x / size * 19, y / size * 19) - .5) * .6;
    const ny = sampleNoise(warpA, 8, x / size * 8 + 3.7, y / size * 8 + 1.3) - .5
      + (sampleNoise(warpB, 19, x / size * 19 + 5.1, y / size * 19 + 2.9) - .5) * .6;
    return [x + nx * 2 * warpAmplitude, y + ny * 2 * warpAmplitude];
  };
  for (let i = 0; i < blobs; i++) {
    const cx = random() * size;
    const cy = random() * size;
    // Poche chiazze GRANDI invece di tante piccole: una pozza deve leggersi
    // come una pozza, non come una macchiolina.
    const radius = size * (.06 + coverage * .13) * (.6 + random() * 1.2);
    const squash = .35 + random() * .95;
    const angle = random() * Math.PI;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    // Il riquadro va allargato della deformazione massima, o le parti di
    // chiazza spinte fuori dal bordo verrebbero tagliate di netto.
    const reach = Math.ceil(radius * Math.max(1, squash) + warpAmplitude * 1.6);
    for (let y = Math.max(0, Math.floor(cy - reach)); y < Math.min(size, cy + reach); y++) {
      for (let x = Math.max(0, Math.floor(cx - reach)); x < Math.min(size, cx + reach); x++) {
        const [wx, wy] = warpAt(x + .5, y + .5);
        const dx = wx - cx;
        const dy = wy - cy;
        const rx = (dx * cos + dy * sin) / radius;
        const ry = (-dx * sin + dy * cos) / (radius * squash);
        const d = Math.sqrt(rx * rx + ry * ry);
        if (d >= 1) continue;
        const t = 1 - d;
        level[y * size + x] += t * t * (3 - 2 * t) * .95;
      }
    }
  }
  for (let i = 0; i < level.length; i++) level[i] = Math.min(1, level[i]);
  return level;
}

/**
 * Altezza dell'onda di UNA sorgente, a `distance` metri dall'impatto e `age`
 * secondi dopo. Esportata perché è la formula che governa sia il movimento dei
 * vertici sia i test: c'è un solo posto in cui è scritta.
 */
export function rippleHeight(distance, age, amplitude) {
  if (!(amplitude > 0) || age < 0 || age > RIPPLE_LIFE) return 0;
  const front = age * RIPPLE_SPEED;
  // Il fronte viaggia: davanti a lui l'acqua è ancora ferma.
  if (distance > front) return 0;
  const behind = front - distance;
  // Decadimento più lento del precedente (1.4 / .3): l'onda resta leggibile
  // per qualche secondo e attraversa la pozza invece di spegnersi sul posto.
  const envelope = Math.exp(-behind * .7) * Math.exp(-distance * .16) * (1 - age / RIPPLE_LIFE) ** 1.5;
  return Math.sin(behind * 5.2) * envelope * amplitude;
}

/**
 * Derivata dell'onda rispetto alla distanza: la pendenza della superficie.
 * Analitica e non per differenze finite, che costerebbero cinque valutazioni
 * per vertice invece di una. È ciò che inclina la normale, e senza normale
 * inclinata l'acqua resta uno specchio piatto: i vertici si muovono ma non si
 * vede muovere niente.
 */
export function rippleSlope(distance, age, amplitude) {
  if (!(amplitude > 0) || age < 0 || age > RIPPLE_LIFE) return 0;
  const front = age * RIPPLE_SPEED;
  if (distance > front) return 0;
  const behind = front - distance;
  const decay = Math.exp(-behind * .7) * Math.exp(-distance * .16) * (1 - age / RIPPLE_LIFE) ** 1.5;
  return (-5.2 * Math.cos(behind * 5.2) + .54 * Math.sin(behind * 5.2)) * decay * amplitude;
}

/**
 * Lamina d'acqua fatta di **geometria**, non di una maschera campionata nello
 * shader.
 *
 * La versione precedente disegnava un piano grande quanto il pavimento e
 * ritagliava le pozze con una texture letta dal fragment shader. Non si vedeva
 * nulla, e in questo ambiente non c'era modo di scoprire perché: i pixel non
 * sono leggibili sull'adapter software, quindi l'unico percorso che decideva il
 * risultato era anche l'unico non verificabile — si poteva solo tarare alla
 * cieca. Qui la pozza **è** una mesh: si contano i triangoli, si misura quanto
 * è estesa, si controlla che i vertici si alzino. Tutto ciò che decide se
 * l'effetto si vede è misurabile fuori dal browser.
 *
 * Le onde muovono i vertici sulla CPU per la stessa ragione: un displacement
 * nel vertex shader costerebbe meno, ma nessuno qui potrebbe dimostrare che
 * avvenga davvero.
 */
export class WaterSystem {
  constructor({ scene, size, y = .05, reflectorNode = null, seed = 4711, maskSize = 160, cell = .28 }) {
    this.scene = scene;
    this.size = size;
    this.seed = seed;
    this.maskSize = maskSize;
    this.cell = cell;
    this.coverage = .52;
    this.elapsed = 0;
    this.rippleGain = 1;
    this.dirty = false;

    this.mask = computePuddleMask(maskSize, this.coverage, seed);
    this.slots = Array.from({ length: RIPPLE_SLOTS }, () => ({ x: 0, z: 0, start: -999, amplitude: 0 }));

    this.material = this._buildMaterial(reflectorNode);
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.position.y = y;
    scene.add(this.mesh);
    this._rebuildGeometry();
  }

  /**
   * Valore della maschera in un punto del mondo, 0..1, **interpolato**.
   *
   * A vicino più prossimo il valore restava costante dentro ogni texel — larghi
   * quanto una cella — quindi il contorno della pozza seguiva i texel a scalini
   * invece della curva. L'interpolazione bilineare rende il campo continuo: il
   * bordo non ha più un reticolo a cui aderire.
   */
  maskAt(x, z) {
    const u = x / this.size + .5;
    const v = z / this.size + .5;
    if (u < 0 || u > 1 || v < 0 || v > 1) return 0;
    const fx = Math.min(this.maskSize - 1.001, Math.max(0, u * this.maskSize - .5));
    const fy = Math.min(this.maskSize - 1.001, Math.max(0, v * this.maskSize - .5));
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(this.maskSize - 1, x0 + 1);
    const y1 = Math.min(this.maskSize - 1, y0 + 1);
    const tx = fx - x0;
    const ty = fy - y0;
    const a = this.mask[y0 * this.maskSize + x0];
    const b = this.mask[y0 * this.maskSize + x1];
    const c = this.mask[y1 * this.maskSize + x0];
    const d = this.mask[y1 * this.maskSize + x1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  }

  isPuddle(x, z) {
    return this.maskAt(x, z) >= PUDDLE_THRESHOLD;
  }

  /**
   * Mesh con le sole celle bagnate. Niente pozza, niente triangoli: fuori
   * dall'acqua non si disegna nulla, al contrario del piano a tutto pavimento
   * di prima che pagava un fragment shader su ogni pixel del terreno.
   */
  _rebuildGeometry() {
    const half = this.size / 2;
    const columns = Math.ceil(this.size / this.cell);
    const positions = [];
    const wetness = [];
    const indices = [];
    // Vertici CONDIVISI fra celle adiacenti: senza, le onde aprirebbero
    // fessure fra un quadrato e l'altro.
    const vertexAt = new Int32Array((columns + 1) * (columns + 1)).fill(-1);
    const ensureVertex = (ix, iz) => {
      const key = iz * (columns + 1) + ix;
      if (vertexAt[key] >= 0) return vertexAt[key];
      const x = -half + ix * this.cell;
      const z = -half + iz * this.cell;
      const index = positions.length / 3;
      positions.push(x, 0, z);
      wetness.push(this.maskAt(x, z), 0);
      vertexAt[key] = index;
      return index;
    };

    for (let iz = 0; iz < columns; iz++) {
      for (let ix = 0; ix < columns; ix++) {
        const x = -half + (ix + .5) * this.cell;
        const z = -half + (iz + .5) * this.cell;
        // Si emette anche la fascia esterna: è lì che l'alfa sfuma a zero.
        if (this.maskAt(x, z) < PUDDLE_THRESHOLD - PUDDLE_FEATHER) continue;
        const a = ensureVertex(ix, iz);
        const b = ensureVertex(ix + 1, iz);
        const c = ensureVertex(ix + 1, iz + 1);
        const d = ensureVertex(ix, iz + 1);
        indices.push(a, d, c, a, c, b);
      }
    }

    this.mesh.geometry?.dispose?.();
    const geometry = new THREE.BufferGeometry();
    this.positions = new Float32Array(positions);
    this.vertexCount = this.positions.length / 3;
    this.vertexX = new Float32Array(this.vertexCount);
    this.vertexZ = new Float32Array(this.vertexCount);
    for (let i = 0; i < this.vertexCount; i++) {
      this.vertexX[i] = this.positions[i * 3];
      this.vertexZ[i] = this.positions[i * 3 + 2];
    }
    this.positionAttribute = new THREE.BufferAttribute(this.positions, 3);
    this.positionAttribute.setUsage?.(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', this.positionAttribute);
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(wetness), 2));
    this.normals = new Float32Array(this.vertexCount * 3);
    for (let i = 0; i < this.vertexCount; i++) this.normals[i * 3 + 1] = 1;
    this.normalAttribute = new THREE.BufferAttribute(this.normals, 3);
    this.normalAttribute.setUsage?.(THREE.DynamicDrawUsage);
    geometry.setAttribute('normal', this.normalAttribute);
    geometry.setIndex(indices);
    this.mesh.geometry = geometry;
    this.triangleCount = indices.length / 3;
    this._buildVertexIndex();
    return geometry;
  }

  /**
   * Indice spaziale dei vertici, a celle di BUCKET metri.
   *
   * Senza, ogni frame con un'onda viva scorreva TUTTI i vertici per scoprire
   * che quasi nessuno era nel raggio del fronte: 1,6 ms per frame in ultra con
   * quattordici sorgenti. Con l'indice il costo segue l'area davvero toccata.
   */
  _buildVertexIndex() {
    const BUCKET = 2;
    this.bucketSize = BUCKET;
    this.bucketColumns = Math.ceil(this.size / BUCKET) + 1;
    this.buckets = Array.from({ length: this.bucketColumns * this.bucketColumns }, () => []);
    const half = this.size / 2;
    for (let i = 0; i < this.vertexCount; i++) {
      const bx = Math.min(this.bucketColumns - 1, Math.max(0, Math.floor((this.vertexX[i] + half) / BUCKET)));
      const bz = Math.min(this.bucketColumns - 1, Math.max(0, Math.floor((this.vertexZ[i] + half) / BUCKET)));
      this.buckets[bz * this.bucketColumns + bx].push(i);
    }
    // Accumulatori riusati fra i frame: l'onda somma qui, poi un secondo
    // passaggio scrive quote e normali solo sui vertici toccati.
    this.accumHeight = new Float32Array(this.vertexCount);
    this.accumSlopeX = new Float32Array(this.vertexCount);
    this.accumSlopeZ = new Float32Array(this.vertexCount);
    this.inTouched = new Uint8Array(this.vertexCount);
    this.touched = [];
  }

  _buildMaterial(reflectorNode) {
    const material = unlitBasic({
      color: 0xffffff, transparent: true, depthWrite: false, side: THREE.DoubleSide
    });
    const facing = clamp(dot(normalView, positionViewDirection).abs(), 0, 1);
    const grazing = facing.oneMinus();
    // uv.x porta il valore della maschera al vertice.
    const wet = uv().x;

    let surface = vec3(.07, .15, .2);
    if (reflectorNode) {
      // Il riflesso si campiona PIEGATO dalla normale: quando un'onda passa, la
      // normale si inclina e l'immagine riflessa si spezza. È così che il moto
      // dell'acqua si vede — muovere i vertici di qualche centimetro, da solo,
      // a schermo non si nota.
      const bend = normalView.xy.mul(.22);
      const reflected = reflectorNode.sample(screenUV.flipX().add(bend)).rgb;
      // Nitido e più forte del pavimento: l'asfalto riflette sfocato a .34, la
      // pozza deve staccare da quello o si mimetizza — che è esattamente il
      // difetto della versione precedente.
      surface = reflected.mul(vec3(.72, .88, 1)).mul(2.1).add(vec3(.02, .05, .07));
    }
    // Nessun alone sul contorno. Il "menisco" luminoso che c'era prima si
    // leggeva come un anello bianco disegnato attorno alla pozza: l'acqua vera
    // non ha un bordo che emette luce, ha solo meno spessore — e lo spessore lo
    // dice già l'opacità, che sfuma sulla fascia esterna.
    material.colorNode = surface;
    // Una pozza COPRE l'asfalto: al centro è quasi opaca, si assottiglia solo
    // sul bordo. Con .3 di base era un velo trasparente indistinguibile dal
    // pavimento sotto, che mostra lo stesso riflesso.
    // Da zero sul bordo geometrico a piena opacità dentro l'acqua: la
    // dissolvenza occupa tutta la fascia, quindi il contorno è un gradiente e
    // non un gradino.
    const depth = smoothstep(float(PUDDLE_THRESHOLD - PUDDLE_FEATHER), float(PUDDLE_THRESHOLD + .08), wet);
    material.opacityNode = depth.mul(clamp(grazing.mul(.24).add(.76), 0, 1));
    return material;
  }

  /**
   * Alza e abbassa i vertici. Con l'acqua ferma non tocca niente e non fa
   * nessun upload; ritorna quanti vertici si sono mossi, che è ciò che i test
   * verificano.
   */
  update(delta, elapsed) {
    this.elapsed = Number.isFinite(elapsed) ? elapsed : this.elapsed + (delta || 0);
    if (!this.vertexCount) return 0;

    // Riporta a riposo ciò che era mosso il frame scorso. Solo quello: è la
    // ragione per cui esiste l'elenco `touched`.
    for (const i of this.touched) {
      this.positions[i * 3 + 1] = 0;
      this.normals[i * 3] = 0;
      this.normals[i * 3 + 1] = 1;
      this.normals[i * 3 + 2] = 0;
      this.accumHeight[i] = 0;
      this.accumSlopeX[i] = 0;
      this.accumSlopeZ[i] = 0;
      this.inTouched[i] = 0;
    }
    const eranoMossi = this.touched.length;
    this.touched.length = 0;

    const half = this.size / 2;
    for (const slot of this.slots) {
      const age = this.elapsed - slot.start;
      if (!(slot.amplitude > 0) || age < 0 || age > RIPPLE_LIFE) continue;
      const front = age * RIPPLE_SPEED;
      // Solo i bucket dentro il fronte: fuori, l'onda non è ancora arrivata.
      const lo = (v) => Math.max(0, Math.floor((v - front + half) / this.bucketSize));
      const hi = (v) => Math.min(this.bucketColumns - 1, Math.floor((v + front + half) / this.bucketSize));
      for (let bz = lo(slot.z); bz <= hi(slot.z); bz++) {
        for (let bx = lo(slot.x); bx <= hi(slot.x); bx++) {
          for (const i of this.buckets[bz * this.bucketColumns + bx]) {
            const dx = this.vertexX[i] - slot.x;
            const dz = this.vertexZ[i] - slot.z;
            const distanceSq = dx * dx + dz * dz;
            if (distanceSq > front * front) continue;
            const distance = Math.sqrt(distanceSq);
            const height = rippleHeight(distance, age, slot.amplitude);
            if (height === 0) continue;
            if (!this.inTouched[i]) { this.inTouched[i] = 1; this.touched.push(i); }
            this.accumHeight[i] += height;
            if (distance > 1e-4) {
              const slope = rippleSlope(distance, age, slot.amplitude);
              this.accumSlopeX[i] += dx / distance * slope;
              this.accumSlopeZ[i] += dz / distance * slope;
            }
          }
        }
      }
    }

    if (!this.touched.length) {
      if (eranoMossi) {
        this.positionAttribute.needsUpdate = true;
        this.normalAttribute.needsUpdate = true;
      }
      return 0;
    }
    for (const i of this.touched) {
      // Si somma SEMPRE sulla quota a riposo, mai sul frame precedente:
      // altrimenti l'errore si accumulerebbe e la superficie andrebbe alla deriva.
      // Tetto: quattordici onde sovrapposte nello stesso punto sommerebbero
      // fino a 20 cm, che in una pozzanghera è un'onda anomala.
      const h = this.accumHeight[i] * this.rippleGain;
      this.positions[i * 3 + 1] = Math.max(-.07, Math.min(.07, h));
      const nx = -this.accumSlopeX[i] * this.rippleGain * NORMAL_BOOST;
      const nz = -this.accumSlopeZ[i] * this.rippleGain * NORMAL_BOOST;
      const inverse = 1 / Math.hypot(nx, 1, nz);
      this.normals[i * 3] = nx * inverse;
      this.normals[i * 3 + 1] = inverse;
      this.normals[i * 3 + 2] = nz * inverse;
    }
    this.positionAttribute.needsUpdate = true;
    this.normalAttribute.needsUpdate = true;
    return this.touched.length;
  }

  /**
   * Increspa l'acqua. Ritorna false se lì non c'è pozza: un passo sull'asfalto
   * asciutto non deve produrre onde.
   */
  disturb(x, z, strength = 1) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
    const mask = this.maskAt(x, z);
    if (mask < PUDDLE_THRESHOLD) return false;
    const amplitude = Math.max(0, Math.min(1.4, strength)) * mask * .05;
    if (!(amplitude > 0)) return false;
    const slot = this._acquireSlot();
    slot.x = x;
    slot.z = z;
    slot.start = this.elapsed;
    slot.amplitude = amplitude;
    return true;
  }

  _acquireSlot() {
    let oldest = this.slots[0];
    for (const slot of this.slots) {
      if (this.elapsed - slot.start > RIPPLE_LIFE) return slot;
      if (slot.start < oldest.start) oldest = slot;
    }
    return oldest;
  }

  setQuality(profile) {
    this.rippleGain = profile?.city?.puddleRipples ?? 1;
    const coverage = Math.max(0, Math.min(1, profile?.city?.puddleCoverage ?? .52));
    if (Math.abs(coverage - this.coverage) < .001) return;
    this.coverage = coverage;
    this.mask = computePuddleMask(this.maskSize, coverage, this.seed);
    this._rebuildGeometry();
  }

  reset() {
    for (const slot of this.slots) { slot.start = -999; slot.amplitude = 0; }
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.geometry?.dispose?.();
    this.material.dispose?.();
  }
}
