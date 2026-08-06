#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MODE = ['idle', 'storm', 'combat'].includes(process.argv[2]) ? process.argv[2] : 'idle';
const QUALITY = ['autoLow', 'autoHigh', 'ultra'].includes(process.argv[3]) ? process.argv[3] : 'autoHigh';
const OUTPUT = process.env.VISUAL_OUTPUT_DIR || path.join(os.tmpdir(), 'vibefps-visual');
const SAMPLE_SECONDS = Math.max(2, Math.min(120, Number(process.env.VISUAL_SECONDS || (MODE === 'combat' ? 3.2 : 2.2))));
const PERF_ASSERT = process.env.VISUAL_PERF === '1';

async function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_MODULE, 'playwright'].filter(Boolean);
  const cache = path.join(os.homedir(), '.npm', '_npx');
  try {
    for (const entry of fs.readdirSync(cache)) candidates.push(path.join(cache, entry, 'node_modules', 'playwright', 'index.mjs'));
  } catch {}
  for (const candidate of candidates) {
    try { return await import(candidate); } catch {}
  }
  return null;
}

function serve() {
  const mime = { '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
  const server = http.createServer((request, response) => {
    const urlPath = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const target = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
    if (!target.startsWith(ROOT)) { response.writeHead(403); response.end(); return; }
    fs.readFile(target, (error, data) => {
      if (error) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { 'content-type': mime[path.extname(target)] || 'application/octet-stream' });
      response.end(data);
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

async function analyze(page, canvas) {
  await page.evaluate(() => document.documentElement.classList.add('visual-canvas-only'));
  let png;
  try { png = await canvas.screenshot({ type: 'png' }); }
  finally { await page.evaluate(() => document.documentElement.classList.remove('visual-canvas-only')); }
  const encoded = png.toString('base64');
  const stats = await page.evaluate(async source => {
    const image = new Image();
    image.src = `data:image/png;base64,${source}`;
    await image.decode();
    const probe = document.createElement('canvas');
    probe.width = image.width; probe.height = image.height;
    const context = probe.getContext('2d');
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, probe.width, probe.height).data;
    const count = probe.width * probe.height;
    let luminance = 0, luminanceSq = 0, black = 0, white = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const value = pixels[i] * .2126 + pixels[i + 1] * .7152 + pixels[i + 2] * .0722;
      luminance += value;
      luminanceSq += value * value;
      if (pixels[i] < 20 && pixels[i + 1] < 20 && pixels[i + 2] < 20) black++;
      if (pixels[i] > 235 && pixels[i + 1] > 235 && pixels[i + 2] > 235) white++;
    }
    const mean = luminance / count;
    return {
      width: probe.width,
      height: probe.height,
      mean: +mean.toFixed(2),
      stddev: +Math.sqrt(Math.max(0, luminanceSq / count - mean * mean)).toFixed(2),
      blackPct: +(black / count * 100).toFixed(2),
      whitePct: +(white / count * 100).toFixed(2)
    };
  }, encoded);
  return { png, stats };
}

async function main() {
  const playwright = await loadPlaywright();
  if (!playwright) { console.error('[visual] playwright non trovato'); process.exit(2); }
  const { server, port } = await serve();
  const failures = [];
  let browser;
  try {
    const hardwareRequested = process.env.VISUAL_GPU === 'hardware';
    const args = ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan'];
    if (!hardwareRequested) args.push('--use-angle=swiftshader', '--use-gl=angle');
    browser = await playwright.chromium.launch({ headless: true, args });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.addInitScript(() => {
      window.__vibeLongTasks = [];
      try {
        new PerformanceObserver(list => {
          for (const entry of list.getEntries()) window.__vibeLongTasks.push(entry.duration);
        }).observe({ type: 'longtask', buffered: true });
      } catch {}
    });
    page.on('pageerror', error => failures.push(`pageerror: ${String(error).slice(0, 260)}`));
    page.on('console', message => { if (message.type() === 'error') failures.push(`console.error: ${message.text().slice(0, 260)}`); });
    await page.goto(`http://127.0.0.1:${port}/?visualTest=${MODE}&quality=${QUALITY}&seed=7301`, { waitUntil: 'load', timeout: 60000 });
    await page.waitForSelector('#overlay.ready', { timeout: 90000 });
    await page.evaluate(() => { window.__vibeLongTasks = []; });
    await page.addStyleTag({ content: 'html.visual-canvas-only body > :not(#game-canvas) { visibility: hidden !important; }' });
    await page.evaluate(() => document.querySelector('.cta')?.click());
    // Le metriche di rendering partono dal primo frame di gioco: il boot e il
    // primo cambio profilo hanno un profilo di draw call diverso e falserebbero
    // media e minimo.
    await page.evaluate(() => window.__vibeResetDiagnostics?.());
    const fpsSamples = [];
    const sampleCount = Math.ceil(SAMPLE_SECONDS * 2);
    for (let i = 0; i < sampleCount; i++) {
      await page.waitForTimeout(500);
      const fps = await page.evaluate(() => Number.parseInt(document.getElementById('fps')?.textContent || '', 10));
      if (Number.isFinite(fps)) fpsSamples.push(fps);
    }
    // Contatori di rendering (src/main.js, attivi solo con ?visualTest=...).
    // Sono indipendenti dal backend: restano confrontabili anche quando i pixel
    // non sono autorevoli, quindi valgono come baseline delle ottimizzazioni.
    const perf = await page.evaluate(() => {
      const value = window.__vibeDiagnostics;
      if (!value || !value.frames) return null;
      return {
        frames: value.frames,
        drawCallsAvg: Math.round(value.drawCallsTotal / value.frames),
        drawCallsMin: Number.isFinite(value.drawCallsMin) ? value.drawCallsMin : null,
        drawCallsPeak: value.drawCallsPeak,
        reflectionRenders: value.reflectionRenders,
        reflectionWidth: value.reflectionWidth,
        reflectionHeight: value.reflectionHeight
      };
    });
    const canvas = page.locator('#game-canvas');
    await canvas.waitFor({ state: 'visible' });
    const adapter = await page.evaluate(async () => {
      const value = await navigator.gpu?.requestAdapter();
      const info = value?.info || {};
      const label = [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' ') || 'unknown';
      return { label, software: /swiftshader|software|llvmpipe/i.test(label) };
    });
    const authoritative = hardwareRequested && !adapter.software;
    const { png, stats } = await analyze(page, canvas);
    const sortedFps = [...fpsSamples].sort((a, b) => a - b);
    const medianFps = sortedFps.length ? sortedFps[Math.floor(sortedFps.length * .5)] : null;
    const lowFps = sortedFps.length ? sortedFps[Math.floor(sortedFps.length * .01)] : null;
    const maxLongTask = await page.evaluate(() => Math.max(0, ...(window.__vibeLongTasks || [])));
    fs.mkdirSync(OUTPUT, { recursive: true });
    const outputPath = path.join(OUTPUT, `${MODE}-${QUALITY}.png`);
    fs.writeFileSync(outputPath, png);
    if (authoritative && (stats.whitePct >= 99.5 || stats.blackPct >= 99.5 || stats.stddev < 1.5)) {
      failures.push(`frame non valido: ${JSON.stringify(stats)}`);
    }
    if (authoritative && PERF_ASSERT && (medianFps < 60 || lowFps < 50)) {
      failures.push(`budget FPS non rispettato: median=${medianFps}, 1%low=${lowFps}`);
    }
    if (authoritative && PERF_ASSERT && maxLongTask > 100) failures.push(`long task massimo ${maxLongTask.toFixed(1)}ms`);
    const perfLabel = perf
      ? ` · frames=${perf.frames}`
        + ` · drawCalls avg=${perf.drawCallsAvg} min=${perf.drawCallsMin ?? '?'} peak=${perf.drawCallsPeak}`
        + ` · reflection=${perf.reflectionRenders}/${perf.frames}@${perf.reflectionWidth}x${perf.reflectionHeight}`
      : ' · render counters n/d';
    console.log(`[visual] ${MODE}/${QUALITY} · ${adapter.label} · ${authoritative ? 'hardware autorevole' : 'pixel non autorevoli'} · ${JSON.stringify(stats)} · median=${medianFps} FPS · 1%low=${lowFps} FPS · maxLongTask=${maxLongTask.toFixed(1)}ms${perfLabel} · ${outputPath}`);
    if (failures.length) {
      for (const failure of failures) console.error(`  - ${failure}`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`[visual] FALLITO: ${String(error).slice(0, 400)}`);
    process.exitCode = 1;
  } finally {
    await browser?.close();
    server.close();
  }
}

main();
