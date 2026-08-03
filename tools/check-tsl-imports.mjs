#!/usr/bin/env node
/**
 * VIBE FPS — controllo statico degli import TSL.
 *
 * `node --check` valida solo la sintassi: un simbolo usato ma non importato
 * (ReferenceError a runtime) passa indisturbato. È esattamente il modo in cui
 * `triNoise3D` è finito in src/smoke-volume.js senza il proprio import,
 * rompendo il boot della demo senza che né CI né smoke test se ne accorgessero.
 *
 * Il controllo è volutamente ristretto ai simboli di three/tsl, dove il rischio
 * è concreto (centinaia di export dal nome breve, usati come funzioni):
 *
 *   1. ogni nome dell'export list di three/tsl usato come CHIAMATA in un file
 *      deve essere importato (o comunque legato) in quel file;
 *   2. ogni nome importato da 'three/tsl' deve esistere davvero nell'export list
 *      del build vendorizzato (intercetta typo e API rimosse da un upgrade).
 *
 * Zero dipendenze: il progetto è deliberatamente senza node_modules.
 *
 * Uso:  npm run lint:tsl
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const TSL_BUILD = path.join(ROOT, 'vendor/three/build/three.tsl.js');

/** Estrae i nomi dalla `export { ... };` finale del build TSL. */
function readTslExports() {
  const source = fs.readFileSync(TSL_BUILD, 'utf8');
  const matches = [...source.matchAll(/export\s*\{([^}]*)\}/g)];
  if (!matches.length) throw new Error(`nessuna export list trovata in ${TSL_BUILD}`);
  const names = new Set();
  for (const match of matches) {
    for (const entry of match[1].split(',')) {
      // Supporta sia `name` che `local as exported`.
      const name = entry.includes(' as ') ? entry.split(' as ').pop() : entry;
      const clean = name.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(clean)) names.add(clean);
    }
  }
  return names;
}

/** Rimuove commenti e stringhe: evita match dentro testo e documentazione. */
function stripNoise(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``')
    .replace(/'(?:\\[\s\S]|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\[\s\S]|[^"\\\n])*"/g, '""');
}

/** Nomi importati da un modulo specifico (o da qualunque modulo se null). */
function importedNames(code, fromModule = null) {
  const names = new Set();
  const pattern = /import\s+([\s\S]*?)\s+from\s*['"]([^'"]+)['"]/g;
  for (const match of code.matchAll(pattern)) {
    const [, clause, source] = match;
    if (fromModule !== null && source !== fromModule) continue;
    const braces = clause.match(/\{([\s\S]*)\}/);
    if (braces) {
      for (const entry of braces[1].split(',')) {
        const local = entry.includes(' as ') ? entry.split(' as ').pop() : entry;
        const clean = local.trim();
        if (clean) names.add(clean);
      }
    }
    // `import X from` / `import * as X from`
    const head = clause.replace(/\{[\s\S]*\}/, '').trim();
    for (const part of head.split(',')) {
      const clean = part.replace(/^\*\s*as\s*/, '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(clean)) names.add(clean);
    }
  }
  return names;
}

/**
 * Classifica in UNA passata ogni identificatore del file (escluse le proprietà,
 * cioè i nomi preceduti da un punto):
 *
 *   - `called`: compare come `nome(` → uso come funzione;
 *   - `bound`:  compare almeno una volta in posizione diversa → dichiarazione,
 *               parametro, assegnazione, membro di un oggetto, ...
 *
 * La classificazione `bound` è volutamente generosa: preferiamo un falso
 * negativo a un falso positivo, perché il controllo gira in CI. Una passata
 * unica con lookbehind è necessaria per non consumare il carattere precedente,
 * che spezzerebbe i token adiacenti (`const sample` faceva sparire `sample`).
 */
function classifyNames(code) {
  const called = new Set();
  const bound = new Set();
  const pattern = /(?<![.\w$])[A-Za-z_$][\w$]*/g;
  for (const match of code.matchAll(pattern)) {
    let index = match.index + match[0].length;
    while (index < code.length && /\s/.test(code[index])) index++;
    if (code[index] === '(') called.add(match[0]);
    else bound.add(match[0]);
  }
  return { called, bound };
}

function inlineModuleFromHtml(html) {
  const match = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  return match ? match[1] : null;
}

function collectTargets() {
  const targets = [];
  const srcDir = path.join(ROOT, 'src');
  for (const entry of fs.readdirSync(srcDir).sort()) {
    if (!entry.endsWith('.js')) continue;
    targets.push({ label: `src/${entry}`, code: fs.readFileSync(path.join(srcDir, entry), 'utf8') });
  }
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const inline = inlineModuleFromHtml(html);
  if (inline) targets.push({ label: 'index.html (script type="module")', code: inline });
  return targets;
}

const tslExports = readTslExports();
const problems = [];

for (const { label, code } of collectTargets()) {
  const clean = stripNoise(code);
  const imported = importedNames(clean);
  const fromTsl = importedNames(clean, 'three/tsl');
  const { called, bound } = classifyNames(clean);

  for (const name of called) {
    if (!tslExports.has(name)) continue;   // non è un simbolo TSL: fuori scope
    if (imported.has(name) || bound.has(name)) continue;
    problems.push(`${label}: '${name}' è un export di three/tsl usato come chiamata ma non importato`);
  }
  for (const name of fromTsl) {
    if (tslExports.has(name)) continue;
    problems.push(`${label}: '${name}' è importato da 'three/tsl' ma non è esportato dal build vendorizzato`);
  }
}

if (problems.length) {
  console.error('[tsl] FALLITO:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`[tsl] OK — import TSL coerenti (${tslExports.size} export noti).`);
