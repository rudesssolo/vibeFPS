import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DroneSystem } from '../src/drone-system.js';
import { Vector3 } from './helpers/three-stub.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

function fakeMarker() {
  const classes = new Set();
  return {
    style: {},
    dataset: {},
    classList: {
      toggle: (name, on) => { if (on) classes.add(name); else classes.delete(name); },
      contains: name => classes.has(name)
    }
  };
}

function fakeApex(index, health, maxHealth) {
  return {
    alive: true, health, maxHealth, tier: 3, mega: false,
    telegraphing: false, state: 'patrol',
    position: new Vector3(index * 4, 3, 0),
    marker: fakeMarker(), markerHealth: { style: {} }, markerState: {},
    lastLeft: -1, lastTop: -1, lastRange: '', lastState: '', lastHealth: -1, lastOffscreen: null
  };
}

/** updateMarkers proietta con `markerProjected`: lo sostituiamo con NDC scritte a mano. */
function systemWithApexes(apexes, ndc) {
  const system = Object.create(DroneSystem.prototype);
  let cursor = 0;
  system.drones = [];
  system.apexes = apexes;
  system.camera = { position: new Vector3(0, 2, 20) };
  system.markerProjected = {
    x: 0, y: 0, z: 0,
    copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; },
    distanceTo() { return 12; },
    project() { Object.assign(this, ndc[cursor++ % ndc.length]); return this; }
  };
  return system;
}

test('ogni Apex vivo ha la sua barra, i morti no', () => {
  {
    const previousWindow = globalThis.window;
    globalThis.window = { innerWidth: 1920, innerHeight: 1080 };
    try {
      // Quattro boss con vite diverse: due inquadrati, due fuori campo.
      const apexes = [fakeApex(0, 900, 1000), fakeApex(1, 500, 1000), fakeApex(2, 250, 1000), fakeApex(3, 60, 1000)];
      const system = systemWithApexes(apexes, [
        { x: 0, y: 0, z: .5 },        // inquadrato
        { x: .3, y: -.2, z: .5 },     // inquadrato
        { x: 1.8, y: .4, z: .5 },     // fuori campo a destra
        { x: -.2, y: .1, z: 1.6 }     // dietro la camera
      ]);
      system.updateMarkers();

      // La barra di OGNI boss è scritta, e con la sua percentuale: prima del
      // supporto multi-boss il ciclo toccava solo l'Apex primario.
      assert.deepEqual(apexes.map(a => a.markerHealth.style.width), ['90%', '50%', '25%', '6%']);
      for (const apex of apexes) {
        assert.equal(apex.marker.style.display, 'block', 'un marker non è stato mostrato');
      }
      // I due fuori campo restano marcati offscreen: è il caso che il CSS deve
      // continuare a mostrare per gli Apex, a differenza dei droni.
      assert.deepEqual(apexes.map(a => a.marker.classList.contains('offscreen')), [false, false, true, true]);
    } finally {
      globalThis.window = previousWindow;
    }
  }

  {
    const previousWindow = globalThis.window;
    globalThis.window = { innerWidth: 1920, innerHeight: 1080 };
    try {
      const dead = fakeApex(0, 0, 1000);
      dead.alive = false;
      const alive = fakeApex(1, 400, 1000);
      const system = systemWithApexes([dead, alive], [{ x: 0, y: 0, z: .5 }]);
      system.updateMarkers();
      assert.equal(dead.markerHealth.style.width, undefined, 'un boss morto non va aggiornato');
      assert.equal(alive.markerHealth.style.width, '40%');
    } finally {
      globalThis.window = previousWindow;
    }
  }
});

test('la barra di un Apex fuori campo non viene nascosta dal CSS', () => {
  // `.target-marker.offscreen .target-health { display: none }` è giusto per i
  // droni — molti marker piccoli — ma su un boss toglie l'unico riscontro che i
  // colpi stiano arrivando, e nel gauntlet dell'ondata 9 quasi sempre almeno
  // due dei quattro Apex sono fuori inquadratura.
  const css = fs.readFileSync(path.join(ROOT, 'styles', 'hud.css'), 'utf8');
  assert.match(css, /\.target-marker\.offscreen \.target-health\s*\{\s*display:\s*none/,
    'la regola generica per i droni è cambiata: rivedere l\'override degli Apex');
  const override = css.match(/\.target-marker\.apex-marker\.offscreen \.target-health\s*\{([^}]*)\}/);
  assert.ok(override, 'manca l\'override che rimette la barra ai boss fuori campo');
  assert.match(override[1], /display:\s*block/);
});
