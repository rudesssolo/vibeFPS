import * as THREE from 'three';
import { makeRng } from './rng.js';
import { fillNormalArray, luminanceFromCanvas, normalTextureFromArray } from './normal-map.js';

// M5: generatori di texture/canvas procedurale estratti da index.html.
// Funzioni pure che dipendono solo da document, THREE e makeRng.

// Converte una canvas colore in normal map procedurale (dalla luminanza RGB).
// Il kernel di conversione è condiviso con facade-system.js (normal-map.js).
export function canvasToNormalTexture(colorCanvas, strength, repeat, aniso) {
  const w = colorCanvas.width, h = colorCanvas.height;
  const lum = luminanceFromCanvas(colorCanvas, 'rgb');
  const out = fillNormalArray(lum, new Uint8ClampedArray(w * h * 4), w, h, strength);
  return normalTextureFromArray(out, w, h, { anisotropy: aniso, repeat });
}

// Mappe PBR derivate da una canvas colore (risoluzione configurabile, 512 di
// default; 1024 per le superfici vicine come l'asfalto — review demo).
// Le mappe sono normalizzate sulla luminanza media della canvas (media ≈ 1.0):
// lo scalare roughness/metalness del materiale resta la base, la mappa
// aggiunge variazione spaziale senza spostare l'aspetto complessivo.
export function makePbrMaps(colorCanvas, repeat = [1, 1], aniso = 1, size = 512) {
  const s = size;
  const makeCanvas = () => {
    const c = document.createElement('canvas');
    c.width = c.height = s;
    const ctx = c.getContext('2d');
    ctx.drawImage(colorCanvas, 0, 0, s, s);
    return { c, ctx };
  };
  const analyze = (ctx) => {
    const image = ctx.getImageData(0, 0, s, s);
    const d = image.data;
    const lum = new Float32Array(s * s);
    let sum = 0;
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      lum[p] = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
      sum += lum[p];
    }
    return { image, d, lum, mean: sum / (s * s) };
  };
  const convert = (ctx, spread) => {
    const { image, d, lum, mean } = analyze(ctx);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      const v = Math.max(.4, Math.min(1.6, 1 + (lum[p] - mean) * spread));
      d[i] = d[i + 1] = d[i + 2] = Math.round(v * 255);
    }
    ctx.putImageData(image, 0, 0);
  };
  const toTexture = (ctx) => {
    const tex = new THREE.CanvasTexture(ctx.canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeat[0], repeat[1]);
    tex.anisotropy = aniso;
    return tex;
  };
  const rough = makeCanvas();
  const metal = makeCanvas();
  convert(rough.ctx, 1.5);   // roughness: variazione più marcata
  convert(metal.ctx, 1.0);   // metalness: variazione più contenuta
  return {
    roughnessMap: toTexture(rough.ctx),
    metalnessMap: toTexture(metal.ctx)
  };
}

// Texture pannelli metallo scuro (restituisce la canvas colore).
// Risoluzione 1024 di default (era 256 — review demo): dettagli scalati con k.
export function makeMetalPanelTexture(size = 1024) {
  const s = size;
  const k = s / 256;   // fattore di scala dei dettagli rispetto al design a 256
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, s);
  grad.addColorStop(0, '#3b5368');
  grad.addColorStop(0.5, '#2b3e51');
  grad.addColorStop(1, '#334b60');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, s, s);
  const rand = makeRng(7);
  const strokes = Math.min(Math.round(800 * k * k), 12800);
  for (let i = 0; i < strokes; i++) {   // spazzolatura metallica
    ctx.strokeStyle = `rgba(${rand() < 0.5 ? '255,255,255' : '0,0,0'},${0.02 + rand() * 0.05})`;
    const x = rand() * s, y = rand() * s, len = (20 + rand() * 60) * k;
    ctx.lineWidth = Math.max(1, k * .5);
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + len * 0.06, y + len); ctx.stroke();
  }
  ctx.strokeStyle = '#162938';       // giunzioni pannelli, leggibili ma non nere
  ctx.lineWidth = 4 * k;
  for (let i = 0; i <= 2; i++) {
    const p = i * (s / 2);
    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, s); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(s, p); ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(160,180,210,0.22)';  // bordo giunzione
  ctx.lineWidth = Math.max(1, k * .5);
  for (let i = 1; i <= 2; i++) {
    const p = i * (s / 2);
    ctx.beginPath(); ctx.moveTo(p + k, 0); ctx.lineTo(p + k, s); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, p + k); ctx.lineTo(s, p + k); ctx.stroke();
  }
  ctx.fillStyle = '#0d1824';         // bulloni
  for (let px = 0; px < 2; px++) for (let py = 0; py < 2; py++) {
    ctx.beginPath(); ctx.arc((px + 0.5) * (s / 2), (py + 0.5) * (s / 2), 5 * k, 0, Math.PI * 2); ctx.fill();
  }
  const grimeCount = Math.round(26 * k);
  for (let i = 0; i < grimeCount; i++) {     // macchie / grime
    ctx.fillStyle = `rgba(0,0,0,${0.03 + rand() * 0.06})`;
    ctx.beginPath(); ctx.arc(rand() * s, rand() * s, (8 + rand() * 30) * k, 0, Math.PI * 2); ctx.fill();
  }
  return c;
}

// Texture legno scurito per le casse. Default 512 (era 256 — review demo).
export function makeWoodTexture(size = 512) {
  const s = size;
  const k = s / 256;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#241a10';
  ctx.fillRect(0, 0, s, s);
  const rand = makeRng(31);
  const planks = 6, ph = s / planks;
  const veins = Math.round(26 * k);
  for (let p = 0; p < planks; p++) {
    const base = 38 + rand() * 26;
    ctx.fillStyle = `rgb(${Math.round(base * 0.8)},${Math.round(base * 0.62)},${Math.round(base * 0.42)})`;
    ctx.fillRect(0, p * ph, s, ph);
    for (let i = 0; i < veins; i++) {   // venature
      ctx.strokeStyle = `rgba(0,0,0,${0.08 + rand() * 0.14})`;
      ctx.lineWidth = Math.max(1, k * .5);
      const x = rand() * s, y = p * ph + rand() * ph;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + (30 + rand() * 40) * k, y + (-6 + rand() * 12) * k); ctx.stroke();
    }
    ctx.strokeStyle = '#0a0705';     // giunzione asse
    ctx.lineWidth = 2 * k;
    ctx.beginPath(); ctx.moveTo(0, p * ph + 1); ctx.lineTo(s, p * ph + 1); ctx.stroke();
    for (let i = 0; i < 4; i++) {    // chiodi
      ctx.fillStyle = '#050403';
      ctx.beginPath(); ctx.arc(20 * k + i * (s / 4), p * ph + ph / 2, 3 * k, 0, Math.PI * 2); ctx.fill();
    }
  }
  return c;
}

// Canvas con spazzolatura orizzontale (normal map per i metalli).
export function makeBrushedCanvas() {
  const s = 512;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, s);
  grad.addColorStop(0, '#1c1c1c');
  grad.addColorStop(0.5, '#232323');
  grad.addColorStop(1, '#1e1e1e');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, s, s);
  const rand = makeRng(21);
  for (let i = 0; i < 2600; i++) {
    ctx.strokeStyle = `rgba(${rand() < 0.5 ? '255,255,255' : '0,0,0'},${0.02 + rand() * 0.05})`;
    ctx.lineWidth = 1;
    const y = rand() * s;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(s, y + (rand() - 0.5) * 6);
    ctx.stroke();
  }
  return c;
}
// Asfalto urbano: aggregati, rappezzi, micro-crepe e sporco da pioggia.
// Default 1024 (era 512 — review demo): il pavimento è la superficie più
// visibile della demo; il grana per-pixel scala da sola, rappezzi e crepe
// sono scalati esplicitamente.
export function makeAsphaltCanvas(size = 1024) {
  const s = size;
  const k = s / 512;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  const image = ctx.createImageData(s, s);
  const rand = makeRng(9907);
  for (let i = 0; i < s * s; i++) {
    const grain = 15 + rand() * 18 + (rand() > .975 ? 28 : 0);
    image.data[i * 4] = grain * .72;
    image.data[i * 4 + 1] = grain * .82;
    image.data[i * 4 + 2] = grain;
    image.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  ctx.globalAlpha = .28;
  const patches = Math.round(22 * k);
  for (let i = 0; i < patches; i++) {
    ctx.fillStyle = i % 3 ? '#06090d' : '#26303a';
    ctx.beginPath();
    ctx.ellipse(rand()*s,rand()*s,(8+rand()*50)*k,(2+rand()*11)*k,rand()*Math.PI,0,Math.PI*2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = 'rgba(2,4,6,.72)';
  ctx.lineWidth = 1.3 * k;
  const cracks = Math.round(14 * k);
  for (let i = 0; i < cracks; i++) {
    let x=rand()*s,y=rand()*s;
    ctx.beginPath(); ctx.moveTo(x,y);
    for(let p=0;p<5;p++){x+=(rand()-.5)*38*k;y+=(rand()-.5)*44*k;ctx.lineTo(x,y);}
    ctx.stroke();
  }
  return c;
}

// Texture bande di pericolo (giallo/nero) per la rampa. Default 512 (era 256).
export function makeHazardCanvas(size = 512) {
  const s = size;
  const k = s / 256;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#181008';
  ctx.fillRect(0, 0, s, s);
  ctx.fillStyle = '#ffd166';
  for (let i = -s; i < s * 2; i += 48 * k) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + 24 * k, 0);
    ctx.lineTo(i - 24 * k, s);
    ctx.lineTo(i - 48 * k, s);
    ctx.closePath();
    ctx.fill();
  }
  return c;
}

// Insegna neon con testo (canvas), usata per i cartelli coreani.
export function makeKoreanSignCanvas(text, colorHex) {
  const w = 512, h = 160;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '900 86px "Noto Sans KR", "Malgun Gothic", "Apple SD Gothic Neo", "Nanum Gothic", sans-serif';
  ctx.shadowColor = colorHex;
  ctx.shadowBlur = 16;
  ctx.fillStyle = colorHex;
  ctx.fillText(text, w / 2, h / 2 + 4);
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, w / 2, h / 2 + 4);
  return c;
}

// Texture di fumo "realistico": un cumulo opaco con macchie di rumore e bordo
// sfilacciato, al posto del classico puff radiale perfettamente liscio (che
// legge come "cartoon"). Ritorna una canvas RGBA: il canale alpha ha il
// gradiente di copertura (bordo trasparente, interno con buchi), l'RGB varia
// leggermente per dare profondità al colore. Default 256 (256 risoluzione
// sufficiente per lo sprite billboarded del sistema particelle).
export function makeSmokeCanvas(size = 256, seed = 17) {
  const s = size;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  const rand = makeRng(seed);
  const cx = s / 2, cy = s / 2, maxR = s * 0.5;

  // Envelope radiale: il fumo deve essere più denso al centro e svanire ai
  // bordi, così lo sprite non mostra un rettangolo netto.
  const envelope = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxR);
  envelope.addColorStop(0.0, 'rgba(255,255,255,1)');
  envelope.addColorStop(0.55, 'rgba(255,255,255,0.85)');
  envelope.addColorStop(0.85, 'rgba(255,255,255,0.35)');
  envelope.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = envelope;
  ctx.fillRect(0, 0, s, s);

  // Macroscopic "grumi" di fumo: blob sovrapposti di varia forma/dimensione.
  // Sommandosi con source-over creano un cumulo continuo con buchi e sbuffi.
  const blobs = Math.round(46 + rand() * 14);
  for (let i = 0; i < blobs; i++) {
    const gx = cx + (rand() - 0.5) * s * 0.62;
    const gy = cy + (rand() - 0.5) * s * 0.66;
    const r = (0.08 + rand() * 0.24) * s;
    const a = 0.05 + rand() * 0.10;
    const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, r);
    const shade = 250 + Math.round(rand() * 5);
    g.addColorStop(0, `rgba(${shade},${shade},${shade},${a})`);
    g.addColorStop(0.7, `rgba(${shade - 6},${shade - 6},${shade - 6},${a * 0.6})`);
    g.addColorStop(1, `rgba(${shade - 12},${shade - 12},${shade - 12},0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(gx, gy, r, r * (0.55 + rand() * 0.75), rand() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  // Sfregi / sbuffi allungati: rompono la simmetria rotonda del puff.
  const wisps = Math.round(18 + rand() * 8);
  for (let i = 0; i < wisps; i++) {
    const gx = cx + (rand() - 0.5) * s * 0.7;
    const gy = cy + (rand() - 0.5) * s * 0.7;
    const rx = (0.1 + rand() * 0.22) * s;
    const ry = rx * (0.18 + rand() * 0.3);
    const a = 0.05 + rand() * 0.08;
    const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, rx);
    g.addColorStop(0, `rgba(255,255,255,${a})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(gx, gy, rx, ry, rand() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  // Buchi: sottraggono opacità in punti casuali per un volume non uniforme.
  // Vanno composti con 'destination-out' — con il source-over di default i
  // gradienti neri DEPOSITANO nero semitrasparente (scurendo il fumo) invece
  // di rimuovere copertura.
  const holes = Math.round(30 + rand() * 12);
  const holeCanvas = document.createElement('canvas');
  holeCanvas.width = holeCanvas.height = s;
  const hctx = holeCanvas.getContext('2d');
  for (let i = 0; i < holes; i++) {
    const hx = cx + (rand() - 0.5) * s * 0.6;
    const hy = cy + (rand() - 0.5) * s * 0.6;
    const hr = (0.03 + rand() * 0.09) * s;
    const g = hctx.createRadialGradient(hx, hy, 0, hx, hy, hr);
    g.addColorStop(0, 'rgba(0,0,0,0.35)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    hctx.fillStyle = g;
    hctx.beginPath();
    hctx.ellipse(hx, hy, hr, hr * (0.5 + rand() * 0.8), rand() * Math.PI, 0, Math.PI * 2);
    hctx.fill();
  }
  ctx.globalCompositeOperation = 'destination-out';
  ctx.drawImage(holeCanvas, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  return c;
}

// Halo radiale bianco per i proiettili "glowing": nucleo pieno e coda morbida
// che si dissolve verso l'esterno. Usato come map degli sprite additivi, così
// il bloom lo raccoglie e produce l'alone luminoso attorno al colpo.
export function makeGlowCanvas(size = 64) {
  const s = size;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  const cx = s / 2;
  const g = ctx.createRadialGradient(cx, cx, 0, cx, cx, cx);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.72)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.28)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  return c;
}
