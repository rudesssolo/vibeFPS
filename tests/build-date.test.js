import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { formatBuildDate } from '../tools/stamp-build.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const buildLabel = () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const match = html.match(/<div class="build">BUILD ([^ ]+) \/\/ ([^<]*)<\/div>/);
  assert.ok(match, 'l\'elemento .build non è più nel formato atteso da stamp-build.mjs');
  return { date: match[1], suffix: match[2] };
};

test('la data di build è una data, sta in un posto solo e main.js non la importa', () => {
  {
    const { date } = buildLabel();
    assert.match(date, /^\d{2}\.\d{1,2}\.\d{1,2}$/, `data = '${date}'`);
    const [, month, day] = date.split('.').map(Number);
    assert.ok(month >= 1 && month <= 12, `mese ${month}`);
    assert.ok(day >= 1 && day <= 31, `giorno ${day}`);
    // Niente zeri iniziali: '26.08.07' non è il formato voluto.
    for (const part of date.split('.').slice(1)) {
      assert.equal(part, String(Number(part)), `'${part}' ha uno zero iniziale`);
    }

    assert.equal(formatBuildDate(new Date(2026, 7, 7)), '26.8.7');
    assert.equal(formatBuildDate(new Date(2026, 11, 25)), '26.12.25');
    assert.equal(formatBuildDate(new Date(2030, 0, 1)), '30.1.1');
    assert.throws(() => formatBuildDate(new Date('non una data')), /non valida/);
    assert.throws(() => formatBuildDate('2026-08-07'), /non valida/);
  }

  {
    // Q5: se main.js avesse bisogno di un export nuovo di config.js, un config.js
    // servito dalla cache insieme a un main.js aggiornato romperebbe il link del
    // modulo e il gioco resterebbe allo 0% senza disegnare nulla. La data sta solo
    // in index.html; main.js sostituisce ciò che segue '//'.
    const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
    assert.equal(/BUILD_DATE/.test(main), false, 'main.js è tornato a importare la data da config.js');
    const config = fs.readFileSync(path.join(ROOT, 'src', 'config.js'), 'utf8');
    assert.equal(/BUILD_DATE/.test(config), false, 'config.js riespone una costante di build inutilizzata');

    const { suffix } = buildLabel();
    assert.equal(suffix, 'GPU INIT', 'il segnaposto pre-boot è cambiato');
    // La sostituzione in main.js deve agganciare quel suffisso.
    assert.match(main, /replace\(\/\\\/\\\/\.\*\$\/, `\/\/ \$\{rendererBackend\}`\)/);
  }
});
