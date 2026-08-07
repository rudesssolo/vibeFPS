import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WaterSystem, computePuddleMask, rippleHeight, carveObstacles,
  RIPPLE_SLOTS, RIPPLE_LIFE, RIPPLE_SPEED, PUDDLE_THRESHOLD, PUDDLE_FEATHER,
  WATER_R0, WATER_FRESNEL_EXPONENT
} from '../src/water-system.js';
import { QUALITY_PROFILES } from '../src/config.js';
import fs from 'node:fs';
import path from 'node:path';

const scene = () => ({ add() {}, remove() {} });
const make = () => new WaterSystem({ scene: scene(), size: 44, maskSize: 128 });

const coperturaDi = water => {
  let bagnati = 0;
  let totale = 0;
  for (let x = -20; x < 20; x += .4) for (let z = -20; z < 20; z += .4) { totale++; if (water.isPuddle(x, z)) bagnati++; }
  return bagnati / totale;
};

const puntoProfondo = water => {
  let migliore = 0;
  let punto = null;
  for (let x = -19; x < 19; x += .5) for (let z = -19; z < 19; z += .5) {
    const m = water.maskAt(x, z);
    if (m > migliore) { migliore = m; punto = [x, z]; }
  }
  return punto;
};

test('la maschera dà pozze estese, irregolari e con un campo continuo', () => {
  assert.deepEqual([...computePuddleMask(64, .5, 4711)], [...computePuddleMask(64, .5, 4711)], 'non deterministica');
  const bagnato = data => data.filter(v => v >= PUDDLE_THRESHOLD).length;
  const scarsa = bagnato(computePuddleMask(64, .1, 4711));
  const media = bagnato(computePuddleMask(64, .5, 4711));
  const abbondante = bagnato(computePuddleMask(64, .9, 4711));
  assert.ok(scarsa < media && media < abbondante, `copertura non crescente: ${scarsa}/${media}/${abbondante}`);

  // Estese ma non un velo: sotto il 5% non sono pozze, sopra il 45% è pavimento
  // allagato e non si distingue più dall'asfalto bagnato.
  for (const key of ['autoLow', 'autoHigh', 'ultra']) {
    const water = make();
    water.setQuality(QUALITY_PROFILES[key]);
    const copertura = coperturaDi(water);
    assert.ok(copertura > .05 && copertura < .45, `${key}: copertura ${(copertura * 100).toFixed(1)}%`);
  }

  // Regressione: il contorno usciva a scalini perché `maskAt` campionava a
  // vicino più prossimo con texel larghi quanto una cella. Solo la TRANSIZIONE
  // conta — asciutto e saturo sono piatti per costruzione.
  {
    const water = make();
    water.setQuality(QUALITY_PROFILES.autoHigh);
    const valori = [];
    for (let x = -18; x < 18; x += .02) valori.push(water.maskAt(x, 3.7));
    let coppie = 0;
    let uguali = 0;
    let saltoMassimo = 0;
    for (let i = 1; i < valori.length; i++) {
      const a = valori[i - 1];
      const b = valori[i];
      if ((a <= 0 && b <= 0) || (a >= 1 && b >= 1)) continue;
      coppie++;
      if (a === b) uguali++;
      saltoMassimo = Math.max(saltoMassimo, Math.abs(b - a));
    }
    assert.ok(coppie > 200, 'la traversata non attraversa abbastanza bordi');
    // A vicino più prossimo un texel copre ~17 campioni: il 94% delle coppie
    // adiacenti sarebbe identico anche in piena transizione.
    assert.ok(uguali / coppie < .1, `bordo a gradini: ${(uguali / coppie * 100).toFixed(0)}% di coppie identiche`);
    assert.ok(saltoMassimo < .05, `gradino troppo netto: ${saltoMassimo.toFixed(3)}`);
  }

  // Regressione: le pozze erano ellissi pulite e si leggevano come cerchi. Il
  // dominio è deformato da due ottave di rumore; si misura il contorno della
  // pozza PIÙ GRANDE, l'unica che si guarda davvero.
  {
    const size = 160;
    const mask = computePuddleMask(size, .5, 4711);
    const bagnata = i => mask[i] >= PUDDLE_THRESHOLD;
    const vista = new Uint8Array(size * size);
    let maggiore = [];
    for (let start = 0; start < size * size; start++) {
      if (vista[start] || !bagnata(start)) continue;
      const pila = [start];
      const celle = [];
      vista[start] = 1;
      while (pila.length) {
        const i = pila.pop();
        celle.push(i);
        const x = i % size;
        const y = (i / size) | 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          const j = ny * size + nx;
          if (vista[j] || !bagnata(j)) continue;
          vista[j] = 1;
          pila.push(j);
        }
      }
      if (celle.length > maggiore.length) maggiore = celle;
    }
    assert.ok(maggiore.length > 200, `nessuna pozza degna di nota: ${maggiore.length} celle`);
    const dentro = new Set(maggiore);
    let perimetro = 0;
    for (const i of maggiore) {
      const x = i % size;
      const y = (i / size) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size || !dentro.has(ny * size + nx)) perimetro++;
      }
    }
    // Perimetro rapportato al cerchio di pari area: 1 = cerchio perfetto,
    // un'ellisse pulita resta sotto 1.3.
    const circolarita = perimetro / (2 * Math.sqrt(Math.PI * maggiore.length));
    assert.ok(circolarita > 1.5, `pozza troppo regolare: circolarità ${circolarita.toFixed(2)}`);
  }
});

// La pozza è geometria, non una maschera campionata nel fragment shader: quel
// percorso qui non è verificabile (i pixel non sono leggibili), questo sì.
test('la pozza è geometria: triangoli solo dove c\'è acqua, e seguono la copertura', () => {
  const water = make();
  water.setQuality(QUALITY_PROFILES.autoHigh);
  assert.ok(water.triangleCount > 200, `pozze senza geometria: ${water.triangleCount} triangoli`);

  // Ogni vertice è l'angolo di almeno una cella entro il bordo geometrico — la
  // mesh si estende di una fascia oltre l'acqua, ed è lì che l'alfa sfuma. Gli
  // indici si ricavano con la STESSA aritmetica del costruttore: sondare con
  // offset in virgola mobile fa sbagliare texel proprio sui bordi.
  const half = water.size / 2;
  const centro = i => -half + (i + .5) * water.cell;
  const bordo = PUDDLE_THRESHOLD - PUDDLE_FEATHER;
  let fuori = 0;
  for (let i = 0; i < water.vertexCount; i++) {
    const ix = Math.round((water.vertexX[i] + half) / water.cell);
    const iz = Math.round((water.vertexZ[i] + half) / water.cell);
    if (![ix - 1, ix].some(cx => [iz - 1, iz].some(cz => water.maskAt(centro(cx), centro(cz)) >= bordo))) fuori++;
  }
  assert.equal(fuori, 0, `${fuori} vertici d'acqua sull'asfalto asciutto`);

  // Copertura 0 = arena asciutta: un parametro deve poter spegnere ciò che governa.
  const asciutto = make();
  asciutto.setQuality({ city: { puddleCoverage: 0, puddleRipples: 1 } });
  assert.equal(asciutto.triangleCount, 0);

  // Un oggetto solido appoggiato a terra sposta l'acqua. Senza questo la lamina
  // passava sotto il jump pad, e la sua piastra luminosa 29 cm più in alto ci si
  // specchiava dentro: un riflesso corretto per uno specchio — spostato di
  // 2h/tan θ, oltre due metri a 15° — ma assurdo per un oggetto poggiato a terra.
  const ostacoli = [
    { x: -8, z: -6, halfX: 1.4, halfZ: 1.4 },   // jump pad
    { x: 3, z: 9, radius: .6 },                 // pilastro
    { x: 0, z: 4, halfX: 1.6, halfZ: .2 },      // copertura, sottile e allungata
    { x: 6, z: -3, halfX: 1.5, halfZ: .35, angle: Math.PI / 4 }  // ruotata attorno a Y
  ];
  const scavata = new WaterSystem({ scene: scene(), size: 44, maskSize: 128, obstacles: ostacoli });
  scavata.setQuality(QUALITY_PROFILES.ultra);
  const dentro = (o, x, z) => {
    if (o.radius !== undefined) return (x - o.x) ** 2 + (z - o.z) ** 2 <= o.radius ** 2;
    const a = o.angle || 0;
    const dx = x - o.x;
    const dz = z - o.z;
    const lx = dx * Math.cos(-a) - dz * Math.sin(-a);
    const lz = dx * Math.sin(-a) + dz * Math.cos(-a);
    return Math.abs(lx) <= o.halfX && Math.abs(lz) <= o.halfZ;
  };
  let campioni = 0;
  for (const o of ostacoli) {
    const r = o.radius !== undefined ? o.radius : Math.max(o.halfX, o.halfZ);
    for (let dx = -r; dx <= r; dx += .1) for (let dz = -r; dz <= r; dz += .1) {
      const x = o.x + dx;
      const z = o.z + dz;
      if (!dentro(o, x, z)) continue;
      campioni++;
      assert.equal(scavata.isPuddle(x, z), false, `acqua dentro un ostacolo a ${x.toFixed(2)},${z.toFixed(2)}`);
    }
  }
  assert.ok(campioni > 500, 'lo scavo non è stato campionato abbastanza');
  // ...e senza ostacoli quelle stesse aree tornano bagnabili, o il test
  // passerebbe anche con una maschera vuota.
  const senzaScavo = make();
  senzaScavo.setQuality(QUALITY_PROFILES.ultra);
  assert.ok(ostacoli.some(o => senzaScavo.isPuddle(o.x, o.z)),
    'nessun ostacolo cadeva su una pozza: lo scavo non è dimostrato');
  assert.ok(carveObstacles(new Float32Array(16).fill(1), 4, 8, []).every(v => v === 1),
    'senza ostacoli la maschera non va toccata');

  // L'acqua dev'essere la superficie più riflettente della scena, a OGNI angolo.
  // La curva di Fresnel parte da WATER_R0 e cresce, quindi basta confrontare il
  // pavimento della curva con la riflettanza piatta dell'asfalto.
  const main = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'main.js'), 'utf8');
  const asfalto = main.match(/reflector: \{ strength: ([\d.]+), blur: ([\d.]+) \}/);
  assert.ok(asfalto, 'la configurazione del reflector del pavimento è cambiata forma');
  assert.ok(WATER_R0 > Number(asfalto[1]),
    `a piombo l'acqua riflette ${WATER_R0} contro ${asfalto[1]} dell'asfalto: meno del pavimento su cui poggia`);
  assert.ok(WATER_FRESNEL_EXPONENT > 0 && WATER_R0 < 1);

  // Il riflesso va campionato con uv CLAMPATE: la deformazione dovuta alle onde
  // portava il campionamento fuori dalla texture, e ne tornava il colore del
  // bordo — chiazze poligonali scure lungo gli spigoli dei triangoli.
  const sorgente = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'water-system.js'), 'utf8');
  assert.match(sorgente, /reflectorNode\.sample\(.*\.clamp\(0, 1\)\)/,
    'il campionamento del riflesso non è più clampato');

  const scala = make();
  scala.setQuality({ city: { puddleCoverage: .2, puddleRipples: .5 } });
  const scarsaCopertura = coperturaDi(scala);
  const scarsiTriangoli = scala.triangleCount;
  scala.setQuality({ city: { puddleCoverage: .7, puddleRipples: 1.3 } });
  assert.ok(scarsaCopertura < coperturaDi(scala), 'la copertura non ha effetto');
  assert.ok(scarsiTriangoli < scala.triangleCount, 'la geometria non segue la copertura');
  assert.equal(scala.rippleGain, 1.3);
  assert.equal(scala.mesh.geometry.getAttribute('position').array, scala.positions,
    'l\'attributo caricato sulla GPU non è il buffer che le onde muovono');
});

test('l\'onda si espande dal punto d\'impatto, alza i vertici e torna piatta', () => {
  // Il fronte viaggia: davanti a lui l'acqua è ferma, o il cerchio comparirebbe
  // tutto insieme e non sembrerebbe acqua.
  assert.equal(rippleHeight(5, .1, 1), 0, 'onda dove il fronte non è arrivato');
  assert.notEqual(rippleHeight(.2, .3, 1), 0, 'nessuna onda dietro il fronte');
  assert.equal(rippleHeight(1, RIPPLE_LIFE + .1, 1), 0, 'l\'onda non si spegne mai');
  assert.equal(rippleHeight(1, -.1, 1), 0, 'onda prima dell\'impatto');
  assert.equal(rippleHeight(1, .5, 0), 0);
  const arrivo = 1.5 / RIPPLE_SPEED;
  assert.equal(rippleHeight(1.5, arrivo - .05, 1), 0);
  assert.notEqual(rippleHeight(1.5, arrivo + .05, 1), 0);

  const water = make();
  water.setQuality(QUALITY_PROFILES.autoHigh);
  const punto = puntoProfondo(water);
  const quote = () => {
    let massima = 0;
    for (let i = 0; i < water.vertexCount; i++) massima = Math.max(massima, Math.abs(water.positions[i * 3 + 1]));
    return massima;
  };
  const inclinazione = () => {
    let massima = 0;
    for (let i = 0; i < water.vertexCount; i++) massima = Math.max(massima, Math.hypot(water.normals[i * 3], water.normals[i * 3 + 2]));
    return massima;
  };

  assert.equal(water.update(0, 0), 0, 'acqua ferma: nessun vertice mosso');
  water.disturb(punto[0], punto[1], 1);
  const mossi = [];
  for (const t of [.15, .5, 1, 1.6]) mossi.push(water.update(0, t));
  assert.ok(quote() > .002, `i vertici non si alzano: ${quote()}`);
  assert.ok(quote() <= .071, `ampiezza fuori scala: ${quote().toFixed(3)} m`);
  assert.ok(mossi[0] < mossi[1] && mossi[1] < mossi[2] && mossi[2] < mossi[3],
    `il fronte non si espande: ${mossi.join(' → ')}`);
  // È la normale a piegare il riflesso: senza inclinazione i vertici si
  // muoverebbero senza che a schermo cambi nulla.
  water.update(0, .6);
  assert.ok(inclinazione() > .15, `normale quasi piatta: ${inclinazione().toFixed(3)}`);
  water.update(0, 2.2);
  assert.ok(inclinazione() > .02, `l'onda si spegne troppo presto: ${inclinazione().toFixed(3)}`);
  assert.ok(RIPPLE_LIFE >= 3, `vita dell'onda troppo breve: ${RIPPLE_LIFE}s`);

  // L'indice a bucket evita di scorrere tutti i vertici: deve dare esattamente
  // lo stesso campo del calcolo diretto, o non è un'ottimizzazione.
  const diretto = make();
  diretto.setQuality(QUALITY_PROFILES.autoHigh);
  const centroPozza = puntoProfondo(diretto);
  for (let i = 0; i < 6; i++) diretto.disturb(centroPozza[0] + i * .4, centroPozza[1] - i * .3, 1);
  diretto.update(0, 1.1);
  let scartoMassimo = 0;
  for (let i = 0; i < diretto.vertexCount; i++) {
    let atteso = 0;
    for (const slot of diretto.slots) {
      const age = 1.1 - slot.start;
      if (!(slot.amplitude > 0) || age < 0 || age > RIPPLE_LIFE) continue;
      atteso += rippleHeight(Math.hypot(diretto.vertexX[i] - slot.x, diretto.vertexZ[i] - slot.z), age, slot.amplitude);
    }
    atteso = Math.max(-.07, Math.min(.07, atteso * diretto.rippleGain));
    scartoMassimo = Math.max(scartoMassimo, Math.abs(atteso - diretto.positions[i * 3 + 1]));
  }
  assert.ok(scartoMassimo < 1e-6, `l'indice salta dei vertici: scarto ${scartoMassimo}`);

  // Scaduta l'onda la superficie torna esattamente piatta, senza deriva.
  water.update(0, RIPPLE_LIFE + .5);
  assert.equal(water.update(0, RIPPLE_LIFE + .6), 0);
  assert.equal(quote(), 0, 'la superficie non è tornata a riposo');
});

test('le increspature nascono solo nell\'acqua e riciclano gli slot', () => {
  const water = make();
  water.setQuality(QUALITY_PROFILES.autoHigh);
  const dentro = puntoProfondo(water);
  let fuori = null;
  for (let x = -19; x < 19 && !fuori; x += .5) for (let z = -19; z < 19 && !fuori; z += .5) {
    if (!water.isPuddle(x, z)) fuori = [x, z];
  }
  water.reset();
  assert.equal(water.disturb(dentro[0], dentro[1], 1), true, 'nessuna onda dentro la pozza');
  assert.equal(water.disturb(fuori[0], fuori[1], 1), false, 'onda sull\'asfalto asciutto');
  assert.equal(water.disturb(500, 500, 1), false, 'onda fuori dal pavimento');
  assert.equal(water.disturb(Number.NaN, 0, 1), false);

  const punti = [];
  for (let x = -19; x < 19 && punti.length < RIPPLE_SLOTS * 2; x += .5) {
    for (let z = -19; z < 19 && punti.length < RIPPLE_SLOTS * 2; z += .5) {
      if (water.isPuddle(x, z)) punti.push([x, z]);
    }
  }
  for (const [x, z] of punti) water.disturb(x, z, 1);
  assert.equal(water.slots.length, RIPPLE_SLOTS, 'il numero di slot non è fisso');
  assert.ok(water.slots.every(slot => slot.amplitude > 0));

  water.update(0, RIPPLE_LIFE + 1);
  water.disturb(punti[0][0], punti[0][1], 1);
  assert.equal(water.slots.filter(slot => water.elapsed - slot.start <= RIPPLE_LIFE).length, 1);
});
