#!/usr/bin/env node
/**
 * VIBE FPS — timbra la data di build.
 *
 * `BUILD 2.6.08` era un literal fisso, ripetuto in due file: non diceva niente
 * a nessuno e nessuno lo aggiornava. Ora è una data nel formato aa.m.g e vive
 * in UN SOLO posto, `index.html`, che è anche ciò che l'overlay dipinge per
 * primo. `main.js` ne sostituisce solo il suffisso di stato (`// WEBGPU`) e non
 * importa nessun simbolo nuovo: farlo dipendere da un export di `config.js`
 * significherebbe che un `config.js` servito dalla cache insieme a un `main.js`
 * nuovo blocca il boot prima di qualsiasi disegno (Q5).
 *
 * Uso:  npm run stamp:build             # oggi
 *       npm run stamp:build 2026-08-07  # data esplicita
 *
 * Le sostituzioni sono ancorate a un pattern preciso e **falliscono con errore**
 * se l'ancora non c'è più: una patch su stringa che diventa un no-op silenzioso
 * è già costata un difetto invisibile a questo progetto (Q6).
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

/** 2026-08-07 → '26.8.7'. Anno a due cifre, mese e giorno senza zeri iniziali. */
export function formatBuildDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error('data non valida');
  }
  return `${date.getFullYear() % 100}.${date.getMonth() + 1}.${date.getDate()}`;
}

function patch(file, pattern, replace, label) {
  const full = path.join(ROOT, file);
  const source = fs.readFileSync(full, 'utf8');
  const matches = source.match(pattern);
  if (!matches) {
    console.error(`[stamp] ancora non trovata per ${label} in ${file}: ${pattern}`);
    process.exit(1);
  }
  if (matches.length > 1) {
    console.error(`[stamp] ancora ambigua per ${label} in ${file}: ${matches.length} occorrenze`);
    process.exit(1);
  }
  const next = source.replace(pattern, replace);
  if (next === source) return false;
  fs.writeFileSync(full, next);
  return true;
}

function main() {
  const argument = process.argv[2];
  const date = argument ? new Date(argument) : new Date();
  if (Number.isNaN(date.getTime())) {
    console.error(`[stamp] data non interpretabile: ${argument}`);
    process.exit(1);
  }
  const stamp = formatBuildDate(date);

  const touched = [
    patch('index.html', /<div class="build">BUILD [^<]*<\/div>/g, `<div class="build">BUILD ${stamp} // GPU INIT</div>`, 'overlay build')
  ];

  console.log(touched.some(Boolean)
    ? `[stamp] build ${stamp}`
    : `[stamp] build ${stamp} — già aggiornata`);
}

// Eseguito come script, non quando i test importano formatBuildDate.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) main();
