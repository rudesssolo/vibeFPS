#!/usr/bin/env node
/**
 * VIBE FPS — smoke test di boot (headless).
 *
 * Carica la demo in Chromium headless e verifica, senza bisogno di WebGPU:
 *   1. tutte le risorse si caricano (nessuna 404 / request fallita → valida il
 *      vendoring di ./vendor e l'import map);
 *   2. nessun errore JS (pageerror) e nessun console.error durante il boot;
 *   3. l'overlay raggiunge lo stato `ready` entro il timeout;
 *   4. senza adapter WebGPU il pannello di recovery compare correttamente
 *      (percorso di fallback), con WebGPU il boot completa normalmente.
 *
 * Uso:  npm run smoke
 *
 * Richiede playwright e un browser chromium (`npx playwright install chromium`).
 * La risoluzione di playwright prova, in ordine: $PLAYWRIGHT_MODULE,
 * node_modules locale, cache npx (~/.npm/_npx). Se manca, lo script esce con
 * codice 2 e istruzioni.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BOOT_TIMEOUT_MS = 90000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.map': 'application/json'
};

async function loadPlaywright() {
  const candidates = [];
  if (process.env.PLAYWRIGHT_MODULE) candidates.push(process.env.PLAYWRIGHT_MODULE);
  candidates.push('playwright');
  const npxCache = path.join(os.homedir(), '.npm', '_npx');
  try {
    for (const entry of fs.readdirSync(npxCache)) {
      candidates.push(path.join(npxCache, entry, 'node_modules', 'playwright', 'index.mjs'));
    }
  } catch { /* cache npx assente */ }
  for (const candidate of candidates) {
    try {
      return await import(candidate);
    } catch { /* prossimo candidato */ }
  }
  return null;
}

function serveStatic() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const filePath = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
    if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    fs.readFile(filePath, (error, data) => {
      if (error) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function main() {
  const playwright = await loadPlaywright();
  if (!playwright) {
    console.error('[smoke] playwright non trovato. Installa con: npx playwright@latest install chromium');
    process.exit(2);
  }

  const { server, port } = await serveStatic();
  const failures = [];
  let browser = null;
  try {
    // Senza questi flag Chromium headless non espone navigator.gpu, quindi il
    // boot prendeva SEMPRE il ramo di fallback e uscivamo da bootGame() prima di
    // costruire scena, materiali e sistemi di combattimento: un errore nel corpo
    // del boot (es. un simbolo TSL non importato) restava invisibile allo smoke
    // test. Con l'adapter software di Dawn il percorso reale viene eseguito.
    browser = await playwright.chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--enable-unsafe-webgpu',
        '--enable-features=Vulkan',
        '--use-angle=swiftshader',
        '--use-gl=angle'
      ]
    });
    const page = await browser.newPage();
    page.on('pageerror', error => failures.push(`pageerror: ${String(error).slice(0, 300)}`));
    page.on('console', message => {
      if (message.type() === 'error') failures.push(`console.error: ${message.text().slice(0, 300)}`);
    });
    page.on('requestfailed', request => failures.push(`requestfailed: ${request.url()} (${request.failure()?.errorText})`));
    page.on('response', response => {
      if (response.status() >= 400) failures.push(`HTTP ${response.status()}: ${response.url()}`);
    });

    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 60000 });
    await page.waitForSelector('#overlay.ready', { timeout: BOOT_TIMEOUT_MS });

    const state = await page.evaluate(async () => {
      let adapter = false;
      try { adapter = Boolean(navigator.gpu && await navigator.gpu.requestAdapter()); } catch { /* assente */ }
      return {
        overlayClass: document.getElementById('overlay')?.className || '',
        gpuUnavailable: document.getElementById('overlay')?.classList.contains('gpu-unavailable'),
        warningVisible: !document.getElementById('gpu-warning')?.hidden,
        adapter
      };
    });

    if (!state.adapter && !(state.gpuUnavailable && state.warningVisible)) {
      failures.push('senza adapter WebGPU il pannello di recovery non è stato mostrato');
    }
    // Il ramo di fallback verifica solo il pannello di recovery: NON esegue il
    // corpo del boot. Con SMOKE_REQUIRE_WEBGPU=1 il test pretende un adapter,
    // così in CI si può garantire che il percorso reale sia stato coperto.
    if (process.env.SMOKE_REQUIRE_WEBGPU === '1' && !state.adapter) {
      failures.push('SMOKE_REQUIRE_WEBGPU=1 ma nessun adapter WebGPU: il boot reale non è stato eseguito');
    }
    if (failures.length) {
      console.error('[smoke] FALLITO:');
      for (const failure of failures) console.error(`  - ${failure}`);
      process.exit(1);
    }
    console.log(`[smoke] OK — boot completato (${state.adapter ? 'adapter WebGPU attivo' : 'fallback senza adapter verificato'} · overlay: "${state.overlayClass}"), nessun errore, nessuna risorsa mancante.`);
  } catch (error) {
    console.error(`[smoke] FALLITO: ${String(error).slice(0, 400)}`);
    process.exit(1);
  } finally {
    await browser?.close();
    server.close();
  }
}

main();
