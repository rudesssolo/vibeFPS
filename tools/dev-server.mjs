#!/usr/bin/env node
/**
 * VIBE FPS — server statico di sviluppo.
 *
 * Esiste per una ragione sola: mandare `Cache-Control: no-store` su tutto.
 *
 * Il gioco è un grafo di ES module senza build step né versioning nelle URL.
 * Se il browser serve dalla cache anche un solo modulo mentre gli altri sono
 * aggiornati, l'import viene risolto **al link**, prima che una riga giri: un
 * export mancante blocca il boot lasciando l'overlay sul suo testo statico,
 * senza errori in pagina. È già successo due volte (Q5, e di nuovo con la data
 * di build). `python3 -m http.server` risponde con header cacheabili e rende
 * quella condizione facile da incontrare.
 *
 * Uso:  ./startServer.sh            → http://localhost:8080
 *       ./startServer.sh 3000       → porta esplicita
 *       PORT=3000 ./startServer.sh
 *
 * Come `python3 -m http.server`, ascolta su 0.0.0.0: da WSL2 la pagina resta
 * raggiungibile dal browser di Windows sia via localhost sia via IP della VM.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.argv[2] || process.env.PORT || 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2'
};

const server = http.createServer((request, response) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  } catch {
    response.writeHead(400).end('bad request');
    return;
  }
  const target = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
  // Il join normalizza '..': senza questo controllo un path risalente
  // servirebbe file fuori dal progetto.
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
    response.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(target, (error, data) => {
    if (error) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
      console.log(`  404  ${urlPath}`);
      return;
    }
    response.writeHead(200, {
      'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      // Il punto di tutto lo script: nessuna copia, nessuna rivalidazione
      // condizionale. Ogni reload prende i moduli aggiornati, tutti insieme.
      'cache-control': 'no-store, must-revalidate',
      'pragma': 'no-cache',
      'expires': '0'
    }).end(data);
  });
});

server.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    console.error(`[dev] porta ${PORT} già occupata — chiudi l'altro server o passa una porta: ./startServer.sh 3000`);
    process.exit(1);
  }
  console.error(`[dev] ${error.message}`);
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[dev] VIBE FPS su http://localhost:${PORT}  ·  cache disattivata (no-store)`);
  console.log('[dev] Ctrl+C per fermare');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { server.close(); process.exit(0); });
}
