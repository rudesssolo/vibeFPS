import * as THREE from 'three';
import { makeRng } from './rng.js';
import { unlitBasic } from './materials.js';
import { fillNormalArray, fillNormalRow, luminanceFromCanvas, normalTextureFromArray } from './normal-map.js';

function canvasTexture(canvas, { color = false, anisotropy = 1 } = {}) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = anisotropy;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  if (color) texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function heightToNormal(heightCanvas, strength, anisotropy) {
  const width = heightCanvas.width;
  const height = heightCanvas.height;
  const lum = luminanceFromCanvas(heightCanvas, 'red');
  const output = fillNormalArray(lum, new Uint8ClampedArray(width * height * 4), width, height, strength);
  return normalTextureFromArray(output, width, height, { anisotropy });
}

// N1/B9: la conversione a 2048px è un loop su ~4,2M pixel che in forma sincrona
// blocca il main thread per centinaia di ms durante la transizione ULTRA. La
// variante asincrona cede il controllo ogni CHUNK_ROWS righe: il rebuild avviene
// in background senza freeze (il boot resta sul percorso sincrono a 1024px).
const CHUNK_ROWS = 64;
const yieldMainThread = () => new Promise(resolve => setTimeout(resolve, 0));

async function heightToNormalAsync(heightCanvas, strength, anisotropy) {
  const width = heightCanvas.width;
  const height = heightCanvas.height;
  const lum = luminanceFromCanvas(heightCanvas, 'red');
  const output = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    fillNormalRow(lum, output, width, height, y, strength);
    if (y % CHUNK_ROWS === CHUNK_ROWS - 1) await yieldMainThread();
  }
  return normalTextureFromArray(output, width, height, { anisotropy });
}

function createFacadeCanvases(resolution) {
  const width = resolution;
  const height = resolution;
  const albedo = document.createElement('canvas');
  const roughness = document.createElement('canvas');
  const heightMap = document.createElement('canvas');
  const emissive = document.createElement('canvas');
  for (const canvas of [albedo, roughness, heightMap, emissive]) {
    canvas.width = width; canvas.height = height;
  }
  const a = albedo.getContext('2d');
  const r = roughness.getContext('2d');
  const h = heightMap.getContext('2d');
  const e = emissive.getContext('2d');
  const random = makeRng(481516);

  a.fillStyle = '#111923'; a.fillRect(0, 0, width, height);
  r.fillStyle = '#adadad'; r.fillRect(0, 0, width, height);
  h.fillStyle = '#9c9c9c'; h.fillRect(0, 0, width, height);
  e.fillStyle = '#000'; e.fillRect(0, 0, width, height);

  const columns = 12;
  const rows = 30;
  const cellW = width / columns;
  const cellH = height / rows;
  const litPalette = ['#ffc975', '#9bd8ff', '#ffb17e', '#d9ecff'];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const x = column * cellW;
      const y = row * cellH;
      const marginX = cellW * .15;
      const marginY = cellH * .18;
      const windowX = x + marginX;
      const windowY = y + marginY;
      const windowW = cellW - marginX * 2;
      const windowH = cellH - marginY * 2;
      const glass = a.createLinearGradient(windowX, windowY, windowX + windowW, windowY + windowH);
      const blue = 20 + Math.floor(random() * 18);
      glass.addColorStop(0, `rgb(${8 + blue * .15},${13 + blue * .28},${blue})`);
      glass.addColorStop(.46, `rgb(${12 + blue * .2},${20 + blue * .32},${blue + 8})`);
      glass.addColorStop(.5, 'rgb(50,68,82)');
      glass.addColorStop(.56, `rgb(${8 + blue * .1},${15 + blue * .24},${blue - 2})`);
      glass.addColorStop(1, 'rgb(6,10,17)');
      a.fillStyle = glass; a.fillRect(windowX, windowY, windowW, windowH);
      r.fillStyle = random() < .12 ? '#666' : '#303030'; r.fillRect(windowX, windowY, windowW, windowH);
      h.fillStyle = '#565656'; h.fillRect(windowX, windowY, windowW, windowH);

      if (random() < .34) {
        const light = litPalette[Math.floor(random() * litPalette.length)];
        e.globalAlpha = .35 + random() * .55;
        e.fillStyle = light;
        e.fillRect(windowX + 1, windowY + 1, windowW - 2, windowH - 2);
        e.globalAlpha = 1;
        a.globalAlpha = .18 + random() * .22;
        a.fillStyle = light;
        a.fillRect(windowX + 1, windowY + 1, windowW - 2, windowH - 2);
        a.globalAlpha = 1;
      }
      if (random() < .22) {
        a.fillStyle = 'rgba(3,5,8,.55)';
        a.fillRect(windowX + windowW * (.3 + random() * .4), windowY, Math.max(1, width / 1024), windowH);
      }
    }
  }

  // Montanti metallici, fasce di piano e guarnizioni incassate.
  a.fillStyle = 'rgba(6,9,13,.88)';
  r.fillStyle = '#b8b8b8';
  h.fillStyle = '#d8d8d8';
  for (let column = 0; column <= columns; column++) {
    const x = column * cellW;
    const line = Math.max(2, width / 320);
    a.fillRect(x - line / 2, 0, line, height);
    r.fillRect(x - line / 2, 0, line, height);
    h.fillRect(x - line / 2, 0, line, height);
  }
  for (let row = 0; row <= rows; row++) {
    const y = row * cellH;
    const line = Math.max(2, height / 420);
    a.fillRect(0, y - line / 2, width, line);
    r.fillRect(0, y - line / 2, width, line);
    h.fillRect(0, y - line / 2, width, line);
  }

  // Pioggia, calcare, polvere e colature verticali modificano soprattutto la roughness.
  for (let i = 0; i < 170; i++) {
    const x = random() * width;
    const y = random() * height;
    const length = height * (.025 + random() * .16);
    a.strokeStyle = random() < .5 ? 'rgba(188,207,214,.025)' : 'rgba(0,0,0,.065)';
    r.strokeStyle = random() < .5 ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.12)';
    a.lineWidth = r.lineWidth = 1 + random() * width / 600;
    a.beginPath(); a.moveTo(x, y); a.lineTo(x + (random() - .5) * 4, y + length); a.stroke();
    r.beginPath(); r.moveTo(x, y); r.lineTo(x + (random() - .5) * 4, y + length); r.stroke();
  }

  return { albedo, roughness, heightMap, emissive };
}

function facadeMapsFromCanvases(canvases, normalMap, anisotropy) {
  return {
    map: canvasTexture(canvases.albedo, { color: true, anisotropy }),
    roughnessMap: canvasTexture(canvases.roughness, { anisotropy }),
    normalMap,
    emissiveMap: canvasTexture(canvases.emissive, { color: true, anisotropy })
  };
}

// Percorso sincrono: usato al boot a 1024px (costo contenuto, comportamento
// invariato rispetto alla versione originale).
function createFacadeMaps(resolution, anisotropy) {
  const canvases = createFacadeCanvases(resolution);
  return facadeMapsFromCanvases(canvases, heightToNormal(canvases.heightMap, 2.4, anisotropy), anisotropy);
}

// Percorso asincrono chunked (N1): usato per il rebuild ULTRA a 2048px.
async function createFacadeMapsAsync(resolution, anisotropy) {
  const canvases = createFacadeCanvases(resolution);
  // Cede il frame anche tra disegno canvas e conversione: nessun long task.
  await yieldMainThread();
  const normalMap = await heightToNormalAsync(canvases.heightMap, 2.4, anisotropy);
  return facadeMapsFromCanvases(canvases, normalMap, anisotropy);
}

// Disegna un numero "dipinto" su un canvas quadrato e lo restituisce. Il canvas
// non diventa una texture: le 56 celle finiscono in un unico atlas (vedi
// buildCity), così la città usa una texture e un materiale invece di 56 di
// ciascuno. Il corpo del disegno è invariato: cambia solo cosa viene ritornato.
function paintNumberCanvas(text, color, resolution, seed) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = resolution;
  const context = canvas.getContext('2d');
  const random = makeRng(seed);
  context.clearRect(0, 0, resolution, resolution);
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  const size = Math.min(resolution * .62, resolution * .84 / Math.max(1, text.length * .58));
  context.font = `900 ${size}px "Arial Narrow", "Arial Black", sans-serif`;
  context.lineJoin = 'round';
  context.strokeStyle = 'rgba(7,10,13,.32)';
  context.lineWidth = Math.max(2, resolution * .018);
  context.strokeText(text, resolution / 2, resolution * .52);
  context.fillStyle = color;
  context.globalAlpha = .78;
  context.fillText(text, resolution / 2, resolution * .52);
  context.globalAlpha = 1;

  // Erosione della vernice e graffi allineati con la gravità.
  context.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 100 + text.length * 18; i++) {
    const x = random() * resolution;
    const y = resolution * .18 + random() * resolution * .68;
    const radius = .5 + random() * resolution * .012;
    context.globalAlpha = .22 + random() * .72;
    context.beginPath();
    context.ellipse(x, y, radius * (1 + random() * 2), radius * (.3 + random()), random() * Math.PI, 0, Math.PI * 2);
    context.fill();
  }
  for (let i = 0; i < 18; i++) {
    const x = resolution * (.16 + random() * .68);
    const y = resolution * (.36 + random() * .28);
    context.globalAlpha = .2 + random() * .35;
    context.fillRect(x, y, 1 + random() * 2, resolution * (.03 + random() * .14));
  }
  context.globalCompositeOperation = 'source-over';
  context.globalAlpha = 1;
  return canvas;
}

// Celle dell'atlas dei numeri. 256 px bastano: il decal è alto al massimo 8 m su
// un edificio a 35-60 m, quindi a 1440p con FOV 75° copre ~220 px sullo schermo
// nel caso più favorevole — 512 era sopra la risoluzione utile. Con 8 colonne i
// 56 edifici stanno in 8×7 celle: 2048×1792 contro 56 texture da 512².
/**
 * Fonde geometrie statiche in una sola, applicando la matrice di ciascuna ai
 * vertici. Copre position/normal/uv, che è quanto usa la skyline (box, cilindri,
 * sfere): evita di vendorizzare BufferGeometryUtils e di introdurre una
 * dipendenza in più nella modalità offline (§13.3 del piano performance).
 */
export function mergeStaticGeometries(entries) {
  let vertexCount = 0;
  let indexCount = 0;
  for (const { geometry } of entries) {
    const count = geometry.getAttribute('position').count;
    const index = geometry.getIndex();
    vertexCount += count;
    indexCount += index ? index.count : count;
  }
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  // Oltre 65535 vertici servono indici a 32 bit.
  const indices = vertexCount > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
  const normalMatrix = new THREE.Matrix3();
  const vertex = new THREE.Vector3();
  let vertexOffset = 0;
  let indexOffset = 0;

  for (const { geometry, matrix } of entries) {
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    const uv = geometry.getAttribute('uv');
    normalMatrix.getNormalMatrix(matrix);
    for (let i = 0; i < position.count; i++) {
      const target = vertexOffset + i;
      vertex.fromBufferAttribute(position, i).applyMatrix4(matrix);
      positions[target * 3] = vertex.x;
      positions[target * 3 + 1] = vertex.y;
      positions[target * 3 + 2] = vertex.z;
      if (normal) {
        vertex.fromBufferAttribute(normal, i).applyMatrix3(normalMatrix).normalize();
        normals[target * 3] = vertex.x;
        normals[target * 3 + 1] = vertex.y;
        normals[target * 3 + 2] = vertex.z;
      }
      if (uv) {
        uvs[target * 2] = uv.getX(i);
        uvs[target * 2 + 1] = uv.getY(i);
      }
    }
    const index = geometry.getIndex();
    if (index) {
      for (let i = 0; i < index.count; i++) indices[indexOffset + i] = vertexOffset + index.getX(i);
      indexOffset += index.count;
    } else {
      for (let i = 0; i < position.count; i++) indices[indexOffset + i] = vertexOffset + i;
      indexOffset += position.count;
    }
    vertexOffset += position.count;
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  merged.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  merged.setIndex(new THREE.BufferAttribute(indices, 1));
  merged.computeBoundingSphere();
  return merged;
}

const ATLAS_CELL = 256;
const ATLAS_COLUMNS = 8;
// Margine in texel sulle UV: le mip mediano oltre il bordo della cella e senza
// inset il numero della cella vicina può affiorare da lontano.
const ATLAS_UV_PADDING = 2;

function disposeMaps(maps) {
  if (!maps) return;
  for (const texture of Object.values(maps)) texture.dispose();
}

// Risoluzione base dei profili AUTO: le mappe a questa risoluzione restano in
// cache dopo il passaggio a ULTRA, così il ritorno ad AUTO è immediato.
const BASE_RESOLUTION = 1024;

export class FacadeSystem {
  constructor({ scene, anisotropy = 1, resolution = BASE_RESOLUTION, buildingCount = 56 }) {
    this.scene = scene;
    this.anisotropy = anisotropy;
    this.resolution = resolution;
    this.buildingCount = buildingCount;
    this.group = new THREE.Group();
    this.group.name = 'RealisticSkyline';
    this.materials = [];
    this.maps = null;
    this.mapsResolution = 0;
    this.cachedBaseMaps = null;
    this.pulseAmplitude = .08;
    this.wetDetail = .72;
    this.beaconGeometry = new THREE.SphereGeometry(.075, 6, 4);
    this.beaconMaterials = [0xff4f68, 0x72edff].map(color => unlitBasic({
      color,
      transparent: true,
      opacity: .8,
      toneMapped: false
    }));
    // N1: token di generazione — un rebuild asincrono ancora in volo viene
    // scartato se nel frattempo è partita un'altra ricostruzione o un ritorno
    // alle mappe base. Evita swap fuori ordine e doppi materiali.
    this.buildGeneration = 0;
    this.numberAtlas = null;
    this.numberGeometry = null;
    this.numberMaterial = null;
    scene.add(this.group);
    this.rebuildMaterials(resolution);
    this.buildCity();
  }

  // Rebuild sincrono: solo al boot (risoluzione base, costo contenuto).
  rebuildMaterials(resolution) {
    this.buildGeneration++;
    this.applyMaps(createFacadeMaps(resolution, this.anisotropy), resolution);
  }

  // N1: rebuild asincrono chunked per le alte risoluzioni (transizione ULTRA).
  // Fire-and-forget da setQuality: un errore lascia attive le mappe correnti.
  async rebuildMaterialsAsync(resolution) {
    // N10/L33: single-flight con coalescenza — al massimo una build (es. 2048²)
    // alla volta. Le richieste arrivate durante una build in corso si accodano
    // e l'ultima vince: prima AUTO→ULTRA→AUTO lanciava due rebuild concorrenti
    // (~50-100MB di lavoro sprecato e un hitch di frame).
    this.pendingBuildResolution = resolution;
    if (this.buildPromise) return;
    const run = async () => {
      try {
        while (this.pendingBuildResolution != null) {
          const target = this.pendingBuildResolution;
          this.pendingBuildResolution = null;
          // Target già applicato (richiesta duplicata in coda): salta.
          if (target === this.resolution) continue;
          const generation = ++this.buildGeneration;
          let nextMaps;
          try {
            nextMaps = await createFacadeMapsAsync(target, this.anisotropy);
          } catch (error) {
            console.warn('VIBE facade rebuild failed, keeping current maps', error);
            continue;
          }
          if (generation !== this.buildGeneration) {
            disposeMaps(nextMaps);
            continue;
          }
          this.applyMaps(nextMaps, target);
        }
      } finally {
        this.buildPromise = null;
      }
    };
    this.buildPromise = run();
    this.buildPromise.catch(() => {});
  }

  applyMaps(nextMaps, resolution) {
    if (!this.materials.length) {
      const colors = [0xd7e1e8, 0xaab9c7, 0xc4c8c9, 0x8fa7b5];
      for (const color of colors) {
        this.materials.push(new THREE.MeshPhysicalMaterial({
          color,
          ...nextMaps,
          emissive: 0xffffff,
          emissiveIntensity: .82,
          metalness: .62,
          roughness: .3,
          normalScale: new THREE.Vector2(.72, .72),
          clearcoat: .86,
          clearcoatRoughness: .12,
          envMapIntensity: 1.65
        }));
      }
    } else {
      for (const material of this.materials) {
        material.map = nextMaps.map;
        material.roughnessMap = nextMaps.roughnessMap;
        material.normalMap = nextMaps.normalMap;
        material.emissiveMap = nextMaps.emissiveMap;
        material.needsUpdate = true;
      }
      // Le mappe base non vengono mai distrutte mentre sono di riserva per il
      // ritorno rapido ad AUTO; quelle ad alta risoluzione sì (memoria GPU).
      if (this.maps && this.maps !== nextMaps) {
        if (this.mapsResolution === BASE_RESOLUTION) this.cachedBaseMaps = this.maps;
        else disposeMaps(this.maps);
      }
    }
    if (this.cachedBaseMaps === nextMaps) this.cachedBaseMaps = null;
    this.maps = nextMaps;
    this.mapsResolution = resolution;
    this.resolution = resolution;
  }

  setQuality(profile) {
    if (!profile) return;
    this.pulseAmplitude = Math.max(0, profile.city?.facadePulse ?? .08);
    this.wetDetail = Math.max(0, Math.min(1, profile.city?.wetDetail ?? .72));
    for (const material of this.materials) {
      material.roughness = THREE.MathUtils.lerp(.38, .24, this.wetDetail);
      material.clearcoat = THREE.MathUtils.lerp(.55, .9, this.wetDetail);
    }
    const target = profile.facadeResolution;
    if (target === this.resolution) {
      // Annulla un rebuild asincrono in volo verso un'altra risoluzione.
      this.buildGeneration++;
      return;
    }
    if (target === BASE_RESOLUTION && this.cachedBaseMaps) {
      // Ritorno immediato alle mappe base (nessuna ricostruzione).
      this.buildGeneration++;
      this.applyMaps(this.cachedBaseMaps, BASE_RESOLUTION);
      return;
    }
    this.rebuildMaterialsAsync(target);
  }

  update(elapsed, lightningFlash = 0) {
    const safeElapsed = Number.isFinite(elapsed) ? elapsed : 0;
    const flash = Math.max(0, Math.min(1, Number.isFinite(lightningFlash) ? lightningFlash : 0));
    for (let i = 0; i < this.materials.length; i++) {
      const breath = Math.sin(safeElapsed * (.42 + i * .07) + i * 1.83) * this.pulseAmplitude;
      this.materials[i].emissiveIntensity = Math.max(.48, .82 + breath + flash * .32);
    }
    for (let i = 0; i < this.beaconMaterials.length; i++) {
      this.beaconMaterials[i].opacity = .45 + Math.max(0, Math.sin(safeElapsed * 2.4 + i * Math.PI)) * .5 + flash * .05;
    }
  }

  buildCity() {
    const random = makeRng(4242);
    const decals = [];
    // Gli edifici vengono assemblati in un gruppo di appoggio con la stessa
    // logica di posizionamento di sempre; alla fine le loro matrici mondo
    // vengono cotte in poche mesh unite. Costruirli davvero (invece di
    // calcolare le trasformazioni a mano) garantisce che la disposizione
    // resti identica all'originale.
    const staging = new THREE.Group();
    const numberColors = ['#e7e2d7', '#d4b24f', '#b7d3d5', '#a24f49'];
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x11171d, metalness: .72, roughness: .48, envMapIntensity: 1.1 });
    const trimMat = new THREE.MeshStandardMaterial({ color: 0x222a31, metalness: .85, roughness: .28, envMapIntensity: 1.25 });
    for (let i = 0; i < this.buildingCount; i++) {
      const angle = i / this.buildingCount * Math.PI * 2 + (random() - .5) * .1;
      const radius = 35 + random() * 25;
      const width = 5 + random() * 8;
      const depth = 5 + random() * 8;
      const totalHeight = 13 + random() * 38;
      const tiers = random() < .55 ? 2 : 1;
      const building = new THREE.Group();
      building.position.set(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
      building.rotation.y = -angle;

      const lowerHeight = tiers === 2 ? totalHeight * (.62 + random() * .12) : totalHeight;
      const lower = new THREE.Mesh(new THREE.BoxGeometry(width, lowerHeight, depth), this.materials[i % this.materials.length]);
      lower.position.y = lowerHeight / 2;
      lower.castShadow = i < 22;
      lower.receiveShadow = true;
      building.add(lower);

      if (tiers === 2) {
        const upperHeight = totalHeight - lowerHeight;
        const upper = new THREE.Mesh(new THREE.BoxGeometry(width * .72, upperHeight, depth * .76), this.materials[(i + 1) % this.materials.length]);
        upper.position.set((random() - .5) * width * .12, lowerHeight + upperHeight / 2, (random() - .5) * depth * .1);
        upper.castShadow = i < 22;
        upper.receiveShadow = true;
        building.add(upper);
      }

      // Fasce strutturali reali sui volumi più vicini.
      if (radius < 48) {
        const bandCount = 3 + Math.floor(random() * 4);
        for (let band = 1; band <= bandCount; band++) {
          const ledge = new THREE.Mesh(new THREE.BoxGeometry(width + .1, .07, depth + .1), trimMat);
          ledge.position.y = lowerHeight * band / (bandCount + 1);
          building.add(ledge);
        }
      }

      const roof = new THREE.Mesh(new THREE.BoxGeometry(width * .42, .55 + random() * .7, depth * .34), roofMat);
      roof.position.y = totalHeight + roof.geometry.parameters.height / 2;
      building.add(roof);
      if (random() < .72) {
        const antennaHeight = 1.5 + random() * 5;
        const antenna = new THREE.Mesh(new THREE.CylinderGeometry(.025, .04, antennaHeight, 6), trimMat);
        antenna.position.set((random() - .5) * width * .25, totalHeight + 1 + antennaHeight / 2, (random() - .5) * depth * .2);
        building.add(antenna);
      }
      if (random() < .42) {
        const beacon = new THREE.Mesh(this.beaconGeometry, this.beaconMaterials[i % this.beaconMaterials.length]);
        beacon.position.set((random() - .5) * width * .28, totalHeight + .9, (random() - .5) * depth * .24);
        building.add(beacon);
      }
      staging.add(building);

      // Il numero è un vero strato di vernice non emissivo, rivolto verso l'arena.
      // La sequenza di random() qui sotto è vincolante: cambiarne l'ordine
      // rigenererebbe l'intera città. I decal vengono solo raccolti; atlas e
      // geometria si costruiscono dopo il loop.
      const number = String(10 + Math.floor(random() * 990));
      const label = random() < .22 ? `${number}동` : number;
      const numberHeight = Math.min(8, totalHeight * .28);
      const inward = new THREE.Vector3(-Math.cos(angle), 0, -Math.sin(angle));
      const decalPosition = building.position.clone().addScaledVector(inward, depth * .5 + .045);
      decalPosition.y = totalHeight * (.48 + random() * .18);
      decals.push({
        label,
        color: numberColors[i % numberColors.length],
        seed: 9000 + i,
        width: Math.min(width * .76, numberHeight * 1.6),
        height: numberHeight,
        position: decalPosition
      });
    }

    this.mergeSkyline(staging);
    this.buildNumberDecals(decals);
  }

  /**
   * Un'unica mesh per tutti i numeri della skyline: prima erano 56 mesh, 56
   * MeshPhysicalMaterial (con clearcoat) e 56 texture 512², cioè ~78 MB di VRAM
   * e 56 draw call — pagate due volte, perché la città entra anche nel pass
   * della reflection del pavimento.
   *
   * Le trasformazioni sono cotte nei vertici invece di usare `lookAt` per mesh:
   * ogni quad è verticale e rivolto al centro dell'arena, quindi la sua base
   * ortonormale si ricava dalla direzione orizzontale verso l'origine.
   */
  /**
   * Riduce le 333 mesh della skyline a una manciata, fondendo la geometria
   * statica per materiale. I materiali sono già condivisi (4 facciate, tetti,
   * profili, 2 beacon) e vengono *mutati* al cambio qualità, mai sostituiti:
   * le mesh unite continuano quindi a riferire gli stessi oggetti e l'animazione
   * di `emissiveIntensity`/`opacity` in update() funziona come prima.
   *
   * I caster d'ombra restano in mesh separate: `castShadow` è per-oggetto e solo
   * i primi 22 edifici lo hanno attivo.
   *
   * Compromesso: si perde il frustum culling per-edificio, quindi ogni gruppo è
   * disegnato per intero o per niente. Su geometrie da poche decine di vertici
   * l'overhead per draw call domina largamente il costo dei vertici scartati.
   */
  mergeSkyline(staging) {
    staging.updateMatrixWorld(true);
    const groups = new Map();
    staging.traverse(object => {
      if (!object.isMesh) return;
      const key = `${object.material.uuid}|${object.castShadow ? 1 : 0}`;
      let group = groups.get(key);
      if (!group) {
        group = { material: object.material, castShadow: object.castShadow, entries: [] };
        groups.set(key, group);
      }
      group.entries.push({ geometry: object.geometry, matrix: object.matrixWorld });
    });

    for (const group of groups.values()) {
      const geometry = mergeStaticGeometries(group.entries);
      const mesh = new THREE.Mesh(geometry, group.material);
      mesh.castShadow = group.castShadow;
      mesh.receiveShadow = true;
      mesh.name = 'SkylineMerged';
      this.group.add(mesh);
      // Le geometrie originali non sono mai state caricate sulla GPU (le mesh
      // di appoggio non entrano nella scena), ma vanno comunque rilasciate.
      for (const entry of group.entries) entry.geometry.dispose();
    }
  }

  buildNumberDecals(decals) {
    if (!decals.length) return;
    const rows = Math.ceil(decals.length / ATLAS_COLUMNS);
    const atlas = document.createElement('canvas');
    atlas.width = ATLAS_COLUMNS * ATLAS_CELL;
    atlas.height = rows * ATLAS_CELL;
    const atlasContext = atlas.getContext('2d');

    const positions = new Float32Array(decals.length * 4 * 3);
    const normals = new Float32Array(decals.length * 4 * 3);
    const uvs = new Float32Array(decals.length * 4 * 2);
    const indices = new Uint16Array(decals.length * 6);
    const forward = new THREE.Vector3();
    const right = new THREE.Vector3();

    decals.forEach((decal, index) => {
      const column = index % ATLAS_COLUMNS;
      const row = Math.floor(index / ATLAS_COLUMNS);
      atlasContext.drawImage(
        paintNumberCanvas(decal.label, decal.color, ATLAS_CELL, decal.seed),
        column * ATLAS_CELL, row * ATLAS_CELL
      );

      // Base del quad: `forward` punta all'origine (come faceva lookAt), la
      // verticale resta il world up perché il decal non si inclina mai.
      forward.set(-decal.position.x, 0, -decal.position.z);
      if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
      forward.normalize();
      right.set(forward.z, 0, -forward.x);
      const halfWidth = decal.width / 2;
      const halfHeight = decal.height / 2;

      const u0 = (column * ATLAS_CELL + ATLAS_UV_PADDING) / atlas.width;
      const u1 = ((column + 1) * ATLAS_CELL - ATLAS_UV_PADDING) / atlas.width;
      const v1 = 1 - (row * ATLAS_CELL + ATLAS_UV_PADDING) / atlas.height;
      const v0 = 1 - ((row + 1) * ATLAS_CELL - ATLAS_UV_PADDING) / atlas.height;

      // Ordine dei vertici: alto-sx, alto-dx, basso-sx, basso-dx (come PlaneGeometry).
      const corners = [
        [-halfWidth, halfHeight, u0, v1],
        [halfWidth, halfHeight, u1, v1],
        [-halfWidth, -halfHeight, u0, v0],
        [halfWidth, -halfHeight, u1, v0]
      ];
      corners.forEach(([offsetX, offsetY, u, v], corner) => {
        const vertex = index * 4 + corner;
        positions[vertex * 3] = decal.position.x + right.x * offsetX;
        positions[vertex * 3 + 1] = decal.position.y + offsetY;
        positions[vertex * 3 + 2] = decal.position.z + right.z * offsetX;
        normals[vertex * 3] = forward.x;
        normals[vertex * 3 + 1] = forward.y;
        normals[vertex * 3 + 2] = forward.z;
        uvs[vertex * 2] = u;
        uvs[vertex * 2 + 1] = v;
      });

      const base = index * 4;
      indices.set([base, base + 2, base + 1, base + 2, base + 3, base + 1], index * 6);
    });

    const texture = new THREE.CanvasTexture(atlas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    this.numberAtlas = texture;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeBoundingSphere();
    this.numberGeometry = geometry;

    // MeshStandard invece di MeshPhysical: il clearcoat era a .08, cioè quasi
    // nulla, e non giustifica il lobo speculare in più su un decal di vernice.
    this.numberMaterial = new THREE.MeshStandardMaterial({
      map: texture,
      transparent: true,
      alphaTest: .06,
      depthWrite: false,
      roughness: .78,
      metalness: .02,
      polygonOffset: true,
      polygonOffsetFactor: -2
    });
    const mesh = new THREE.Mesh(geometry, this.numberMaterial);
    mesh.name = 'SkylineNumbers';
    this.group.add(mesh);
  }
}
