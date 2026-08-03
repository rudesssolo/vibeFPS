import test from 'node:test';
import assert from 'node:assert/strict';

// HudController dipende solo dal DOM (niente three.js): qui il DOM è uno stub
// minimale sufficiente per costruttore e toast().
import { HudController } from '../src/hud-controller.js';

function makeElement() {
  const el = {
    parent: null,
    children: [],
    style: {},
    dataset: {},
    className: '',
    textContent: '',
    innerHTML: '',
    classList: { add() {}, remove() {}, toggle() {} },
    appendChild(child) { el.children.push(child); child.parent = el; return child; },
    prepend(child) { el.children.unshift(child); child.parent = el; return child; },
    remove() {
      if (!el.parent) return;
      const index = el.parent.children.indexOf(el);
      if (index >= 0) el.parent.children.splice(index, 1);
      el.parent = null;
    },
    querySelector() { return makeElement(); }
  };
  Object.defineProperty(el, 'lastElementChild', {
    get: () => el.children[el.children.length - 1] || null
  });
  return el;
}

function withFakeDom(fn) {
  const originalDocument = globalThis.document;
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.document = {
    getElementById: () => makeElement(),
    createElement: () => makeElement()
  };
  // I timer di auto-rimozione dei toast restano inerti: il test controlla solo
  // la logica di accodamento, non la scadenza temporale.
  globalThis.setTimeout = () => 0;
  try {
    fn();
  } finally {
    globalThis.document = originalDocument;
    globalThis.setTimeout = originalSetTimeout;
  }
}

test('toast stack is capped and keeps the most recent messages (N6)', () => {
  withFakeDom(() => {
    const hud = new HudController();
    for (let i = 1; i <= 8; i++) hud.toast(`msg-${i}`);
    const toasts = hud.ui.toasts.children;
    assert.equal(toasts.length, 5);
    // prepend → il più recente è in testa, il più vecchio è stato espulso.
    assert.equal(toasts[0].innerHTML, 'msg-8');
    assert.equal(toasts[4].innerHTML, 'msg-4');
  });
});

test('toast stack never exceeds the cap even in bursts (N6)', () => {
  withFakeDom(() => {
    const hud = new HudController();
    for (let i = 0; i < 40; i++) hud.toast(`<b>UNITÀ</b> · ${i}`);
    assert.equal(hud.ui.toasts.children.length, 5);
  });
});
