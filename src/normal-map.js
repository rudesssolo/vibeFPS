// M5.1: unica copia del kernel di conversione luminanza → normal map.
// Prima esistevano tre implementazioni indipendenti (heightToNormal e
// heightToNormalAsync in facade-system.js, canvasToNormalTexture in
// textures.js) con la stessa matematica OOB-wrap + normalizzazione + packing:
// un cambiamento in una non si propagava alle altre (rischio di drift visivo).
// Qui il kernel è unico; le funzioni pubbliche restano nei loro moduli e
// differiscono solo per l'estrazione della luminanza (canale rosso vs RGB).

import * as THREE from 'three';

// Riempe una RIGA dell'output RGBA dal buffer di luminanza [0..1].
// Wrap toroidale su entrambi gli assi (pattern ripetibile seamless).
export function fillNormalRow(lum, out, width, height, y, strength) {
  const yp = ((y + height - 1) % height) * width;
  const yn = ((y + 1) % height) * width;
  const yc = y * width;
  for (let x = 0; x < width; x++) {
    const xl = lum[yc + ((x + width - 1) % width)];
    const xr = lum[yc + ((x + 1) % width)];
    const yu = lum[yp + x];
    const yd = lum[yn + x];
    let nx = (xl - xr) * strength;
    let ny = (yu - yd) * strength;
    let nz = 1.0;
    const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
    nx *= inv; ny *= inv; nz *= inv;
    const idx = (yc + x) * 4;
    out[idx] = Math.round((nx * 0.5 + 0.5) * 255);
    out[idx + 1] = Math.round((ny * 0.5 + 0.5) * 255);
    out[idx + 2] = Math.round((nz * 0.5 + 0.5) * 255);
    out[idx + 3] = 255;
  }
  return out;
}

// Riempe l'intero output (chiamato dal percorso sincrono).
export function fillNormalArray(lum, out, width, height, strength) {
  for (let y = 0; y < height; y++) fillNormalRow(lum, out, width, height, y, strength);
  return out;
}

// Estrae la luminanza da una canvas heightmap:
//  - 'red': canale rosso (heightmap ASCII delle facciate);
//  - 'rgb': luminanza BT.709 pesata (canvas colore delle texture PBR).
export function luminanceFromCanvas(canvas, mode = 'red') {
  const width = canvas.width;
  const height = canvas.height;
  const source = canvas.getContext('2d').getImageData(0, 0, width, height).data;
  const lum = new Float32Array(width * height);
  if (mode === 'rgb') {
    for (let i = 0; i < width * height; i++) {
      lum[i] = (0.2126 * source[i * 4] + 0.7152 * source[i * 4 + 1] + 0.0722 * source[i * 4 + 2]) / 255;
    }
  } else {
    for (let i = 0; i < width * height; i++) lum[i] = source[i * 4] / 255;
  }
  return lum;
}

// Canvas + CanvasTexture dall'array RGBA di una normal map (configurazione
// wrap/minFilter/anisotropy/repeat identica per tutti i chiamanti).
export function normalTextureFromArray(data, width, height, { anisotropy = 1, repeat = null } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').putImageData(new ImageData(data, width, height), 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.anisotropy = anisotropy;
  if (repeat) texture.repeat.set(repeat[0], repeat[1]);
  return texture;
}
