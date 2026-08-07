import test from 'node:test';
import assert from 'node:assert/strict';
import { fillNormalArray, fillNormalRow } from '../src/normal-map.js';

// Kernel di conversione luminanza → normal map (M5.1): test del puro calcolo
// su array, senza DOM (canvas/ImageData sono toccati solo da
// luminanceFromCanvas/normalTextureFromArray, non testati qui).

function rgba(out, x, y, w) {
  const idx = (y * w + x) * 4;
  return [out[idx], out[idx + 1], out[idx + 2], out[idx + 3]];
}

test('il kernel inclina la normale col gradiente, la scala con la strength e wrappa', () => {
  {
    const w = 8, h = 8;
    const flat = fillNormalArray(new Float32Array(w * h).fill(0.5), new Uint8ClampedArray(w * h * 4), w, h, 1);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const [r, g, b, a] = rgba(flat, x, y, w);
        assert.equal(r, 128, 'nx ≈ 0');
        assert.equal(g, 128, 'ny ≈ 0');
        assert.equal(b, 255, 'nz ≈ 1');
        assert.equal(a, 255);
      }
    }

    const ramp = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) ramp[y * w + x] = x / (w - 1); // cresce verso destra
    }
    // xl (sinistra, valore più basso) - xr (destra, più alto) → nx negativo → r < 128.
    const tilted = fillNormalArray(ramp, new Uint8ClampedArray(w * h * 4), w, h, 2);
    assert.ok(rgba(tilted, 3, 3, w)[0] < 128, 'atteso left-tilt (r<128)');

    const peak = new Float32Array(w).fill(0);
    peak[4] = 1; // picco: pendenza rilevante solo attorno a x=4
    const weak = rgba(fillNormalArray(peak, new Uint8ClampedArray(w * 4), w, 1, 1), 3, 0, w)[0];
    const strong = rgba(fillNormalArray(peak, new Uint8ClampedArray(w * 4), w, 1, 8), 3, 0, w)[0];
    assert.ok(Math.abs(strong - 128) > Math.abs(weak - 128), 'strength più alta → inclinazione maggiore');
  }

  {
    const w = 4, h = 4;
    // Colonna 0 alta, colonna 3 bassa: il wrap orizzontale deve dare lo stesso
    // risultato per x=0 e x=w-1 (pattern seamless).
    const lum = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      lum[y * w + 0] = 1.0;
      lum[y * w + 1] = 0.5;
      lum[y * w + 2] = 0.5;
      lum[y * w + 3] = 0.0;
    }
    const out = new Uint8ClampedArray(w * h * 4);
    fillNormalRow(lum, out, w, h, 1, 1);
    // x=0: xl = lum[3]=0, xr = lum[1]=0.5 → nx = -0.5 → r < 128
    // x=3: xl = lum[2]=0.5, xr = lum[0]=1.0 → nx = -0.5 → r < 128, uguale
    assert.equal(rgba(out, 0, 1, w)[0], rgba(out, 3, 1, w)[0], 'i bordi wrappati coincidono');
    assert.ok(rgba(out, 0, 1, w)[0] < 128);
  }
});
