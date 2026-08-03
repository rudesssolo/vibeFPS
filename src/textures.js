import * as THREE from 'three';
import { makeRng } from './rng.js';

// M5: generatori di texture/canvas procedurale estratti da index.html.
// Funzioni pure che dipendono solo da document, THREE e makeRng.

// Converte una canvas colore in normal map procedurale (dalla luminanza).
export function canvasToNormalTexture(colorCanvas, strength, repeat, aniso) {
  const w = colorCanvas.width, h = colorCanvas.height;
  const ctx = colorCanvas.getContext('2d');
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    lum[i] = (0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) / 255;
  }
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const yp = ((y + h - 1) % h) * w, yn = ((y + 1) % h) * w, yc = y * w;
    for (let x = 0; x < w; x++) {
      const xl = lum[yc + ((x + w - 1) % w)];
      const xr = lum[yc + ((x + 1) % w)];
      const yu = lum[yp + x];
      const yd = lum[yn + x];
      let nx = (xl - xr) * strength;
      let ny = (yu - yd) * strength;
      let nz = 1.0;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx *= inv; ny *= inv; nz *= inv;
      const idx = (yc + x) * 4;
      out[idx]     = Math.round((nx * 0.5 + 0.5) * 255);
      out[idx + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      out[idx + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      out[idx + 3] = 255;
    }
  }
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').putImageData(new ImageData(out, w, h), 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat[0], repeat[1]);
  tex.anisotropy = aniso;
  return tex;
}

// Mappe PBR a bassa risoluzione (512x512) derivate da una canvas colore.
// Le mappe sono normalizzate sulla luminanza media della canvas (media ≈ 1.0):
// lo scalare roughness/metalness del materiale resta la base, la mappa
// aggiunge variazione spaziale senza spostare l'aspetto complessivo.
export function makePbrMaps(colorCanvas, repeat = [1, 1], aniso = 1) {
  const s = 512;
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
export function makeMetalPanelTexture() {
  const s = 256;
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
  for (let i = 0; i < 800; i++) {   // spazzolatura metallica
    ctx.strokeStyle = `rgba(${rand() < 0.5 ? '255,255,255' : '0,0,0'},${0.02 + rand() * 0.05})`;
    const x = rand() * s, y = rand() * s, len = 20 + rand() * 60;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + len * 0.06, y + len); ctx.stroke();
  }
  ctx.strokeStyle = '#162938';       // giunzioni pannelli, leggibili ma non nere
  ctx.lineWidth = 4;
  for (let i = 0; i <= 2; i++) {
    const p = i * (s / 2);
    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, s); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(s, p); ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(160,180,210,0.22)';  // bordo giunzione
  ctx.lineWidth = 1;
  for (let i = 1; i <= 2; i++) {
    const p = i * (s / 2);
    ctx.beginPath(); ctx.moveTo(p + 1, 0); ctx.lineTo(p + 1, s); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, p + 1); ctx.lineTo(s, p + 1); ctx.stroke();
  }
  ctx.fillStyle = '#0d1824';         // bulloni
  for (let px = 0; px < 2; px++) for (let py = 0; py < 2; py++) {
    ctx.beginPath(); ctx.arc((px + 0.5) * (s / 2), (py + 0.5) * (s / 2), 5, 0, Math.PI * 2); ctx.fill();
  }
  for (let i = 0; i < 26; i++) {     // macchie / grime
    ctx.fillStyle = `rgba(0,0,0,${0.03 + rand() * 0.06})`;
    ctx.beginPath(); ctx.arc(rand() * s, rand() * s, 8 + rand() * 30, 0, Math.PI * 2); ctx.fill();
  }
  return c;
}

// Texture legno scurito per le casse.
export function makeWoodTexture() {
  const s = 256;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#241a10';
  ctx.fillRect(0, 0, s, s);
  const rand = makeRng(31);
  const planks = 6, ph = s / planks;
  for (let p = 0; p < planks; p++) {
    const base = 38 + rand() * 26;
    ctx.fillStyle = `rgb(${Math.round(base * 0.8)},${Math.round(base * 0.62)},${Math.round(base * 0.42)})`;
    ctx.fillRect(0, p * ph, s, ph);
    for (let i = 0; i < 26; i++) {   // venature
      ctx.strokeStyle = `rgba(0,0,0,${0.08 + rand() * 0.14})`;
      ctx.lineWidth = 1;
      const x = rand() * s, y = p * ph + rand() * ph;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 30 + rand() * 40, y - 6 + rand() * 12); ctx.stroke();
    }
    ctx.strokeStyle = '#0a0705';     // giunzione asse
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, p * ph + 1); ctx.lineTo(s, p * ph + 1); ctx.stroke();
    for (let i = 0; i < 4; i++) {    // chiodi
      ctx.fillStyle = '#050403';
      ctx.beginPath(); ctx.arc(20 + i * (s / 4), p * ph + ph / 2, 3, 0, Math.PI * 2); ctx.fill();
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
export function makeAsphaltCanvas() {
  const s = 512;
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
  for (let i = 0; i < 22; i++) {
    ctx.fillStyle = i % 3 ? '#06090d' : '#26303a';
    ctx.beginPath();
    ctx.ellipse(rand()*s,rand()*s,8+rand()*50,2+rand()*11,rand()*Math.PI,0,Math.PI*2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = 'rgba(2,4,6,.72)';
  ctx.lineWidth = 1.3;
  for (let i = 0; i < 14; i++) {
    let x=rand()*s,y=rand()*s;
    ctx.beginPath(); ctx.moveTo(x,y);
    for(let p=0;p<5;p++){x+=(rand()-.5)*38;y+=(rand()-.5)*44;ctx.lineTo(x,y);}
    ctx.stroke();
  }
  return c;
}

// Texture bande di pericolo (giallo/nero) per la rampa.
export function makeHazardCanvas() {
  const s = 256;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#181008';
  ctx.fillRect(0, 0, s, s);
  ctx.fillStyle = '#ffd166';
  for (let i = -s; i < s * 2; i += 48) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + 24, 0);
    ctx.lineTo(i - 24, s);
    ctx.lineTo(i - 48, s);
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