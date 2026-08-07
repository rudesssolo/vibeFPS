import test from 'node:test';
import assert from 'node:assert/strict';
import { DroneSystem } from '../src/drone-system.js';
import { APEX_ROSTER, getApexStatsFor, getMegaBossStats } from '../src/config.js';
import { AdditiveBlending, MeshPhysicalMaterial, Vector3 } from './helpers/three-stub.mjs';

function megaBoss() {
  return {
    alive: true,
    mega: true,
    megaPhase: 1,
    health: 24000,
    maxHealth: 24000,
    armorMax: 0,
    armorBroken: false,
    parts: [],
    coreMaterial: { emissive: { setHex() {} }, emissiveIntensity: 0 },
    group: { visible: true },
    marker: { style: {} },
    position: new Vector3(),
    state: 'patrol',
    stateTimer: 0,
    attackCooldown: 0
  };
}

test('la silhouette di ogni Apex è nel grafo, distinta per archetipo e per tier', () => {
  {
    const signatures = new Map();
    for (const archetype of ALL_ARCHETYPES) {
      const built = makeVisualSystem().buildApexVisual(statsFor(archetype));
      const rendered = meshesOf(built.visual);
      // +1: la cresta di rango, una pinna al tier 1. OVERLORD ne è escluso.
      const crest = archetype === 'overlord' ? 0 : 1;
      assert.equal(rendered.length, SHARED_MESHES + ARCHETYPE_EXTRA_MESHES[archetype] + crest, `${archetype}: conteggio mesh`);
      // Ogni mesh di `parts` deve essere raggiungibile dal gruppo visivo: è
      // esattamente il difetto T1, che lasciava `parts` fuori dal grafo.
      for (const part of built.parts) {
        if (part.isMesh) assert.ok(rendered.includes(part), `${archetype}: una parte non è nel grafo`);
      }
      // Dopo T1 le decorazioni additive sono nel grafo: senza il filtro per
      // materiale proietterebbero blocchi d'ombra opachi al posto di un bagliore.
      for (const mesh of rendered) {
        const decorative = mesh.material.transparent === true || mesh.material.blending === AdditiveBlending;
        if (decorative || mesh === built.eye) {
          assert.equal(mesh.castShadow, false, `${archetype}: una decorazione proietta ombra`);
        } else {
          assert.equal(mesh.castShadow, true, `${archetype}: una parte solida non proietta ombra`);
          assert.equal(mesh.receiveShadow, true);
        }
      }
      signatures.set(archetype, rendered.map(mesh => mesh.geometry.name).sort().join('|'));
    }
    // Firma = geometrie montate. Il conteggio da solo non basta (VANGUARD e VEX
    // aggiungono entrambi 4 mesh): quello che deve differire è la forma.
    assert.equal(new Set(signatures.values()).size, signatures.size,
      `due archetipi hanno la stessa silhouette: ${[...signatures].map(([k, v]) => `${k}=${v}`).join('\n')}`);
  }

  {
    for (const archetype of APEX_ROSTER.map(entry => entry.id)) {
      const perTier = [1, 2, 3].map(tier => {
        const built = makeVisualSystem().buildApexVisual(statsFor(archetype, tier));
        const meshes = meshesOf(built.visual);
        return {
          tier,
          count: meshes.length,
          crest: built.parts.filter(p => p.isMesh && p.geometry.name === 'bladeGeometry').length,
          signature: meshes.map(m => `${m.geometry.name}@${m.position.x.toFixed(2)},${m.position.y.toFixed(2)}`).sort().join('|')
        };
      });
      // Più parti a ogni ciclo, mai le stesse.
      assert.ok(perTier[0].count < perTier[1].count && perTier[1].count < perTier[2].count,
        `${archetype}: conteggio mesh non crescente ${perTier.map(t => t.count).join(' → ')}`);
      assert.equal(new Set(perTier.map(t => t.signature)).size, 3,
        `${archetype}: due tier hanno la stessa disposizione`);
    }
  }

  {
    // Segno condiviso e leggibile: una pinna per tier su ogni archetipo.
    for (const archetype of APEX_ROSTER.map(entry => entry.id)) {
      for (const tier of [1, 2, 3]) {
        const built = makeVisualSystem().buildApexVisual(statsFor(archetype, tier));
        const fins = meshesOf(built.visual).filter(m => m.geometry.name === 'bladeGeometry' && m.position.y > .4);
        assert.equal(fins.length, tier, `${archetype} tier ${tier}: pinne di cresta`);
      }
    }
    const mega = makeVisualSystem().buildApexVisual(getMegaBossStats());
    assert.equal(meshesOf(mega.visual).filter(m => m.geometry.name === 'bladeGeometry' && m.position.y > .4).length, 0);
  }
});

test('le decorazioni si animano senza sovrapporsi, e l\'armatura è marcata', () => {
  {
    for (const tier of [1, 2, 3]) {
      const system = makeVisualSystem();
      const built = system.buildApexVisual(statsFor('vex', tier));
      const orbits = built.parts.filter(p => p.userData?.orbitIndex !== undefined);
      assert.equal(orbits.length, 2 + tier, `tier ${tier}: numero di orbite`);
      system.animateArchetypeParts({ archetypeId: 'vex', parts: built.parts }, 1 / 60, .3);
      const places = orbits.map(o => `${o.position.x.toFixed(4)},${o.position.z.toFixed(4)}`);
      // Se lo sfasamento restasse fisso a 3, dal tier 2 le orbite in più si
      // sovrapporrebbero esattamente alle prime.
      assert.equal(new Set(places).size, orbits.length, `tier ${tier}: due orbite sovrapposte`);
    }
  }

  {
    const system = makeVisualSystem();
    const vex = system.buildApexVisual(getApexStatsFor('vex', 1));
    const vexApex = { archetypeId: 'vex', parts: vex.parts };
    const orbits = () => vex.parts.filter(p => p.userData?.orbitIndex !== undefined).map(p => ({ ...p.position }));
    system.animateArchetypeParts(vexApex, 1 / 60, 0);
    const first = orbits();
    system.animateArchetypeParts(vexApex, 1 / 60, .5);
    const second = orbits();
    assert.equal(first.length, 3);
    for (let i = 0; i < first.length; i++) assert.notDeepEqual(first[i], second[i], 'un\'orbita VEX è ferma');
    // Le tre orbite sono sfasate fra loro (a t=0 due condividono la stessa x:
    // il confronto deve essere sulla posizione intera).
    assert.equal(new Set(first.map(p => `${p.x.toFixed(4)},${p.y.toFixed(4)},${p.z.toFixed(4)}`)).size, 3);

    const overlord = system.buildApexVisual(getMegaBossStats());
    const crown = overlord.parts.find(p => p.userData?.overlordCrown);
    system.animateArchetypeParts({ archetypeId: 'overlord', megaPhase: 1, parts: overlord.parts }, .25, 0);
    assert.ok(crown.rotation.z > 0, 'la corona OVERLORD non ruota');

    const built = system.buildApexVisual(getApexStatsFor('vanguard', 1));
    const armor = built.parts.find(part => part.userData?.apexArmor);
    assert.ok(armor, 'armatura non marcata');
    const apex = {
      alive: true, health: 400, maxHealth: 400, armor: 100, armorMax: 100,
      armorBroken: false, parts: built.parts, coreMaterial: built.coreMaterial,
      group: { visible: true }, marker: { style: {} }, position: new Vector3(1, 2, 3)
    };
    system.applyApexDamage(apex, 150);
    assert.equal(apex.armorBroken, true);
    assert.equal(armor.visible, false, 'la piastra rotta non è quella nascosta');
  }
});

// Blink del WRAITH: era muto e quasi invisibile. `onApexContact(apex, 'blink')`
// arrivava a un callback vuoto in main.js, e l'unico effetto — l'afterimage — è
// figlio del gruppo, quindi si sposta CON l'Apex e non marca la partenza.
function blinkSystem() {
  const system = makeVisualSystem();
  system.scene = { add() {}, remove() {} };
  system.blinkGhosts = [];
  return system;
}

const fakeApexForGhost = () => ({
  radius: .95,
  coreMaterial: { emissive: { getHex: () => 0xff2d95 } },
  group: { quaternion: { x: 0, y: .3, z: 0, w: .95 } }
});

test('il blink lascia sagome ai due capi, sfarfallanti e riciclate dal pool', () => {
  {
    const system = blinkSystem();
    const apex = fakeApexForGhost();
    system.spawnBlinkGhost(new Vector3(1, 2, 3), apex, 1.4, 1.75);   // partenza: si dilata
    system.spawnBlinkGhost(new Vector3(9, 2, 4), apex, 2.9, .55);    // arrivo: si contrae
    assert.equal(system.blinkGhosts.length, 2);
    assert.ok(system.blinkGhosts.every(g => g.active && g.mesh.visible));
    assert.ok(system.blinkGhosts[0].endScale > system.blinkGhosts[0].startScale, 'la partenza deve dilatarsi');
    assert.ok(system.blinkGhosts[1].endScale < system.blinkGhosts[1].startScale, 'l\'arrivo deve contrarsi');
    assert.equal(system.blinkGhosts[0].mesh.position.x, 1, 'la sagoma di partenza non è dove l\'Apex era');
    assert.equal(system.blinkGhosts[0].mesh.quaternion.y, .3, 'orientamento non copiato');

    // Scadute, tornano al pool invece di accumularsi.
    for (let i = 0; i < 40; i++) system.updateBlinkGhosts(1 / 60);
    assert.ok(system.blinkGhosts.every(g => !g.active && !g.mesh.visible && g.mesh.material.opacity === 0));
    system.spawnBlinkGhost(new Vector3(), apex, 1.4, 1.75);
    assert.equal(system.blinkGhosts.length, 2, 'il pool non è stato riusato');

    // Tetto duro: un blink ogni ~2.4s non deve poter far crescere il pool.
    for (let i = 0; i < 30; i++) system.spawnBlinkGhost(new Vector3(), apex, 1.4, 1.75);
    assert.ok(system.blinkGhosts.length <= 8, `pool cresciuto a ${system.blinkGhosts.length}`);
  }

  {
    const system = blinkSystem();
    system.spawnBlinkGhost(new Vector3(), fakeApexForGhost(), 1.4, 1.75);
    const ghost = system.blinkGhosts[0];
    const samples = [];
    for (let i = 0; i < 18; i++) { system.updateBlinkGhosts(1 / 60); samples.push(ghost.mesh.material.opacity); }
    // Una dissolvenza lineare sarebbe monotona: qui deve risalire almeno una
    // volta, altrimenti lo sfarfallio non c'è.
    assert.ok(samples.some((v, i) => i > 0 && v > samples[i - 1]), 'opacità monotona: nessuno sfarfallio');
    assert.ok(samples.every(v => v >= 0 && v <= 1));
  }

  {
    const system = blinkSystem();
    system.apexes = [];
    system.spawnBlinkGhost(new Vector3(), fakeApexForGhost(), 1.4, 1.75);
    system.clearApex();
    assert.ok(system.blinkGhosts.every(g => !g.active && !g.mesh.visible));
  }
});

test('mega-boss crosses four phases and deploys phase retaliation', () => {
  const system = Object.create(DroneSystem.prototype);
  let summons = 0;
  let shockwaves = 0;
  system.onApexSummon = () => { summons++; };
  system.onApexShockwave = () => { shockwaves++; };
  const apex = megaBoss();

  const phase2 = system.applyApexDamage(apex, 7000);
  assert.equal(apex.megaPhase, 2);
  assert.equal(phase2.phaseChanged, true);
  assert.equal(summons, 1);
  assert.equal(shockwaves, 1);

  system.applyApexDamage(apex, 6000);
  assert.equal(apex.megaPhase, 3);
  system.applyApexDamage(apex, 6000);
  assert.equal(apex.megaPhase, 4);
  const killed = system.applyApexDamage(apex, 6000);
  assert.equal(killed.killed, true);
  assert.equal(apex.alive, false);
  assert.equal(apex.group.visible, false);
});

test('gauntlet HUD keeps aggregate progress as council members fall', () => {
  const system = Object.create(DroneSystem.prototype);
  system.apexes = [
    { alive: false, health: 0, maxHealth: 1000 },
    { alive: true, health: 700, maxHealth: 1000 },
    { alive: true, health: 500, maxHealth: 1000 },
    { alive: false, health: 0, maxHealth: 1000 }
  ];
  const hud = system.getBossHudState();
  assert.equal(hud.nameKey, 'apex.council');
  assert.equal(hud.stateLabel, '2 ACTIVE');
  assert.equal(hud.health, 1200);
  assert.equal(hud.maxHealth, 4000);
});

// --- T1: silhouette per archetipo --------------------------------------------
// Le parti costruite nello switch per archetipo (armatura VANGUARD, lame e
// afterimage WRAITH, orbite VEX, corona SENTINEL, corona e orbite OVERLORD)
// finivano solo in `parts`, che serve al dispose: nessuna veniva aggiunta al
// gruppo visivo, quindi a schermo tutti gli Apex erano identici. Questi test
// verificano il grafo effettivo, non la lista di dispose.

// Geometrie condivise da tutte le istanze di test: così due silhouette si
// possono confrontare per identità di geometria e non solo per conteggio.
const GEOMETRIES = Object.fromEntries([
  'coreGeometry', 'wingGeometry', 'eyeGeometry', 'ringGeometry', 'haloGeometry',
  'thrusterGeometry', 'armorGeometry', 'bladeGeometry', 'spikeGeometry',
  'orbitGeometry', 'miniGeometry'
].map(name => [name, { name }]));

function makeVisualSystem() {
  const system = Object.create(DroneSystem.prototype);
  Object.assign(system, {
    ...GEOMETRIES,
    darkMaterial: new MeshPhysicalMaterial({ color: 0x0a1017 })
  });
  return system;
}

const meshesOf = root => {
  const found = [];
  root.traverse(object => { if (object.isMesh) found.push(object); });
  return found;
};

// Mesh comuni a ogni archetipo: corpo, occhio, alone, due anelli, due propulsori.
const SHARED_MESHES = 7;

// Parti d'archetipo al tier 1, cresta di rango esclusa (una pinna per tier).
const ARCHETYPE_EXTRA_MESHES = {
  vanguard: 4,  // 1 piastra + 2 corni + piastra inferiore
  wraith: 3,    // 2 lame + afterimage
  vex: 4,       // nucleo additivo + 3 orbite
  sentinel: 6,  // corona di 6 punte
  overlord: 13  // 8 punte + 4 orbite + corona
};

const ALL_ARCHETYPES = [...APEX_ROSTER.map(entry => entry.id), 'overlord'];
const statsFor = (id, tier = 1) => (id === 'overlord' ? getMegaBossStats() : getApexStatsFor(id, tier));
