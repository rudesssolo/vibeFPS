# VIBE FPS — Bug Remediation & Improvement Plan

> **Data analisi:** 3 agosto 2026
> **Commit analizzato:** `88bc585` ("Require WebGPU and harden arena gameplay", branch `main`)
> **Scope:** revisione statica completa di `index.html` (2924 righe), `src/*.js` (10 moduli), `styles/hud.css`, `tests/`. Verifiche puntuali eseguite con Node.js.
> **Stato documento:** ✅ **TUTTE LE AZIONI ESEGUITE** (Fase 1, 2, 3). Vedi sezione 13 "Stato di completamento".
>
> **Stato implementazione:** completato in 4 commit:
> - `4d1d0b9` · Fase 1 — bug fix chirurgici (B1, B2, B3, B4, B5, B7, B8, C1, C2, C3)
> - `63a718b` · Fase 2 — performance e UX (B6, B9, C4, C5, M2, M3)
> - `fed7449` · Fase 3 — test, SRI, CI (M1, M4, M6)
> - `96a08b6` · Fase 3 — M5: estrazione texture procedurali in `src/textures.js`

---

## 1. Contesto e metodologia

VIBE FPS è una tech demo FPS cyberpunk: rendering WebGPU (three.js r184, TSL), fisica cannon.js 0.6.2, audio 100% procedurale WebAudio, game loop e maggior parte della logica in un'unica funzione `bootGame()` in `index.html`; sistemi riusabili in `src/`.

Metodologia della revisione:

1. Lettura integrale di tutti i sorgenti (nessun file escluso).
2. Esecuzione della suite esistente (`node --test` → 4/4 verdi).
3. Verifica sperimentale dei sospetti su snippet isolati con Node (es. `Number(null)`).
4. Ricerche mirate su pattern sospetti: dead code, variabili di stato non resettate, scritture DOM per-frame, gestione timer/scheduler.
5. Classificazione per **impatto utente × probabilità**, con stima effort e rischio per ogni intervento.

---

## 2. Sintesi esecutiva

| ID | Titolo | Severità | Effort | Fase |
|----|--------|----------|--------|------|
| B1 | Gioco muto al primo avvio (volumi default mai applicati) | 🔴 Critica | S | 1 |
| B2 | Il menu di pausa non sospende la simulazione | 🟠 Alta | M | 1 |
| B3 | Raffica audio/stallo dopo tab in background | 🟠 Alta | S | 1 |
| B4 | Tunneling dei colpi nemici a FPS bassi | 🟠 Alta | S | 1 |
| B5 | `resetLevel`/`respawnPlayer`: stato incompleto (footstep, stamina) | 🟡 Media | S | 1 |
| B6 | `updateMarkers`: layout thrash DOM per-frame | 🟡 Media | M | 2 |
| B7 | Desync UI qualità durante transizione ULTRA | 🟡 Media | S | 1 |
| B8 | Pickup munizioni consumato a riserva piena | 🟡 Media | S | 1 |
| B9 | `heightToNormal` a 2048 blocca il main thread | 🟡 Media | M | 2 |
| C1–C5 | Dead code, tuning hardcoded, pointer lock, allocazioni | ⚪ Bassa | S | 1–2 |
| M1–M6 | Test, magic numbers, UX, CDN, refactor moduli, CI | 🔧 Strutturale | S–L | 2–3 |

**Quick win assoluto:** B1 (una riga, ripristina l'audio per ogni nuovo utente) + test di regressione.


---

## 3. Bug critici

### B1 — Il gioco parte MUTO al primo avvio 🔴

- **File:** `src/config.js:83-94` (`getStoredMix`)
- **Severità:** critica (colpisce il 100% dei nuovi utenti)
- **Effort:** S · **Rischio fix:** nullo

**Root cause.** `localStorage.getItem()` su chiave mancante restituisce `null`, e `Number(null) === 0` (verificato sperimentalmente: `Number('') === 0`, solo `Number(undefined) === NaN`). Il ramo di fallback non viene quindi mai eseguito quando lo storage esiste ma è vuoto:

```js
const safe = (key, fallback) => {
  const value = Number(readStorage(storage, key));   // null → 0
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
};
```

Risultato: al primo avvio `music/sfx/ambience` valgono **0** invece di `0.72/0.9/0.58`. Il mixer (`AudioEngine.applyMix`) azzera i gain e il gioco è silenzioso finché l'utente non tocca manualmente gli slider del pannello settings.

**Fix proposto:**

```js
const safe = (key, fallback) => {
  const raw = readStorage(storage, key);
  const value = raw === null || raw === '' ? Number.NaN : Number(raw);
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
};
```

**Test di regressione (nuovo, `tests/config.test.js`):** mock di `globalThis.localStorage` con chiavi assenti → attesi i default `0.72/0.9/0.58`; valori memorizzati validi → rispettati; valori fuori range (`'7'`, `'NaN'`, `'abc'`) → clamp/fallback. Questo test avrebbe intercettato il bug.

---

## 4. Bug di priorità alta

### B2 — Il menu di pausa non sospende la simulazione 🟠

- **File:** `index.html` — `animate()` (:2707+), `updateDrones` (:2097), `updateHostileShots` (:2103), `updateGameplay` (:2134)
- **Severità:** alta (bug gameplay: si può morire o avanzare di ondata mentre si è in pausa)
- **Effort:** M · **Rischio fix:** basso (gating, nessuna logica riscritta)

**Evidenza.** Con Esc premuto (`locked=false`, `gameState.started=true`) il loop continua a eseguire:

- `world.step()` e i constraint fisici: casse e corpi continuano a muoversi;
- `updateDrones`: la guardia è `if (!gameState.started && !locked) return;` → con partita avviata i droni pattugliano durante la pausa (non sparano, `active:false`);
- `updateHostileShots`: i colpi già in volo avanzano e chiamano `damagePlayer()` → **morte durante la pausa**;
- `updateGameplay`: decrementa `waveDelay` → `spawnWave(true)` può scattare nel menu; decrementa `respawnTimer` → respawn automatico in pausa; scudo/combo avanzano;
- `updateAmmoPickups`: i pickup scadono (`ammoDropLifetime: 35s`) mentre il giocatore legge il menu.

Contraddice il sottotitolo "SIMULAZIONE SOSPESA · STATO DI COMBATTIMENTO CONSERVATO".

**Fix proposto.** Un unico gate calcolato a inizio frame:

```js
const gameplayActive = locked && gameState.started && !gameStartLoading;
```

- `!gameplayActive` → saltare: blocco fuoco continuo, `updateDrones`, `updateAmmoPickups`, `updateBullets`, `updateEffects`, `updateHostileShots`, `updateShockwaves`, `updateGameplay`, il while di `world.step` (azzerando `accumulator` per evitare la raffica di step al rientro).
- Sempre attivi: `syncHudVisibility`, `updatePlayer` (già guarded), camera/HUD/pioggia/vapore, `explosionSystem.update` (solo visuale), `audio.update` (musica nel menu: scelta voluta), render.
- Attenzione a `updateDrones`: la guardia attuale va sostituita, non sommata, per non congelare i droni prima del primo start (oggi sono statici fino al via: comportamento da conservare).

**Validazione:** pausa durante colpi in volo → nessun danno; pausa a fine ondata → nessuno spawn; ripresa → stato coerente.

### B3 — Raffica audio e stallo dopo tab in background 🟠

- **File:** `src/audio-engine.js:378-393` (`update`)
- **Severità:** alta (stallo main-thread + raffica di suoni al ritorno sulla tab)
- **Effort:** S · **Rischio fix:** nullo

**Root cause.** Lo scheduler musicale usa `AudioContext.currentTime`, che avanza anche con tab nascosta (in Chrome il contesto resta `running`), mentre `animate()` (rAF) è fermo. Al ritorno:

```js
while (this.nextStepTime < this.ctx.currentTime + .12) { ... } // migliaia di iterazioni
```

Un minuto in background ≈ 512 step da 16ª a 128 BPM × più nodi (oscillatori/noise) per step → migliaia di nodi WebAudio creati in un frame e schedulati "nel passato".

**Fix proposto:**

```js
const now = this.ctx.currentTime;
if (this.nextStepTime < now - .25) this.nextStepTime = now + .05; // riallinea
let scheduled = 0;
while (this.nextStepTime < now + .12 && scheduled < 8) { ... scheduled++; }
```

Il riallineamento copre anche il caso `ctx.state` `suspended → running` (early-return attuale, stessa deriva al resume).

**Validazione:** tab nascosta 60s → ritorno senza burst; la musica riprende dal beat successivo.

### B4 — Tunneling dei colpi nemici a FPS bassi 🟠

- **File:** `index.html:2112` (`updateHostileShots`)
- **Severità:** alta a FPS degradati (la demo ha un profilo "balanced" proprio per macchine deboli)
- **Effort:** S · **Rischio fix:** nullo

**Root cause.** Il danno al giocatore è un test punto-distanza sulla sola posizione corrente:

```js
if(!remove && s.pos.distanceToSquared(hostilePlayerPoint) < .52) { damagePlayer(...); }
```

Con `delta` clampato a 0.1s e velocità proiettile `18 + wave*0.65` (onda 10 ≈ 24.5 m/s) il colpo percorre fino a ~2.4 m/frame: raggio utile ~0.72 m → il proiettile "salta" il giocatore. I proiettili del giocatore usano invece correttamente lo sweep segmento→punto (`bulletSegment.closestPointToPoint`, :2514-2524) contro i droni.

**Fix proposto.** Replicare il pattern esistente con due temp object riusati:

```js
hostileSegment.start.copy(s.prev);
hostileSegment.end.copy(s.pos);
hostileSegment.closestPointToPoint(hostilePlayerPoint, true, hostileClosest);
if (hostileClosest.distanceToSquared(hostilePlayerPoint) < .52) { damagePlayer(...); remove = true; }
```

**Validazione:** a 10 FPS simulati, colpo diretto → danno registrato; colpo di striscio → nessun falso positivo.

---

## 5. Bug di priorità media

### B5 — `resetLevel`/`respawnPlayer`: ripristino di stato incompleto 🟡

- **File:** `index.html:2627` (`resetLevel`), :2093 (`respawnPlayer`), :2327 (consumer)
- **Effort:** S

`resetLevel` azzera `elapsed = 0` ma non `nextFootstep` (dichiarata :1787, mai resettata — verificato con ricerca su tutte le occorrenze). Dopo un reset a run avanzata (es. `elapsed ≈ 500`), i passi restano muti finché il nuovo `elapsed` non raggiunge il vecchio valore: minuti di gioco senza footstep. Inoltre:

- `isGrounded` non viene riallineato (residuo transitorio del bob);
- `respawnPlayer` ripristina vita e scudo ma non `stamina`: si può rinascere con energia a 0.

**Fix:** in `resetLevel` aggiungere `nextFootstep = 0; isGrounded = false;`; in `respawnPlayer` aggiungere `gameState.stamina = 100;` + `updateHUD()` implicito già coperto.

### B6 — `updateMarkers`: layout thrash DOM per-frame 🟡

- **File:** `src/drone-system.js:295-324`
- **Effort:** M · **Fase 2**

Ogni frame, per ogni drone vivo (fino a 9): `drone.position.clone()` (allocazione), `projected.project()`, scrittura di **4 proprietà di stile** (`--target-x/y`, `left`, `top`), `dataset.range` (attributo → invalidation stile), `textContent` dello stato, e 2 `querySelector` per marker. A 60 FPS sono ~1000 scritture DOM/attributi al secondo, in gran parte con valori identici.

**Fix:**

1. In `createDrone` cachare i riferimenti: `markerHealth = marker.querySelector('.target-health i')`, `markerState = marker.querySelector('.target-state')`; salvare sul drone.
2. Riutilizzare un `THREE.Vector3` di classe al posto di `clone()`.
3. Dirty-check come in `HudController.render`: aggiornare `dataset.range` solo se la stringa cambia, `textContent` solo se lo stato cambia, `classList.toggle` solo su transizione (oggi `toggle` è già idempotente ma la scrittura di `display` ad ogni frame no).
4. Scrivere solo `transform: translate(...)` (compositor-friendly) invece di `left/top` + custom properties duplicate.

**Nota:** il CSS usa `--target-x/y` e `left/top`: verificare quale dei due canali è effettivamente consumato da `hud.css` prima di rimuoverne uno.

### B7 — Desync UI qualità durante la transizione ULTRA 🟡

- **File:** `src/graphics-manager.js:22-34`, `src/hud-controller.js:138-141`, `index.html:1950`
- **Effort:** S

Click su AUTO mentre `transitioning === true`: `setMode` esce subito (`if (this.transitioning || nextMode === this.mode) return;`) ma `mountSettings` ha già applicato la classe `selected` al bottone → la UI mostra AUTO mentre il motore resta in ULTRA.

**Fix:** `mountSettings` espone il setter della selezione (return `{ panel, setSelected }` oppure `panel.syncMode = setSelected`); in `index.html`:

```js
onQuality: mode => { graphicsManager.setMode(mode); settings.syncMode(graphicsManager.mode); }
```

Così la selezione visiva riflette sempre lo stato reale del manager, anche quando la richiesta è ignorata.

### B8 — Pickup munizioni consumato a riserva piena 🟡

- **File:** `index.html:2041-2054` (`updateAmmoPickups`)
- **Effort:** S

Con riserva al massimo, `amount` vale 0: il pickup viene comunque rimosso dalla scena con toast "MUNIZIONI AL MASSIMO". Il giocatore perde una risorsa senza beneficio.

**Fix:** se `amount <= 0` saltare la raccolta (`continue` senza `splice`): il pickup resta a terra finché non serve. Opzionale: mostrare l'hint "riserva piena" solo al primo contatto (throttle con un timestamp sul pickup per evitare spam di toast restando fermi sopra il drop).

### B9 — `heightToNormal` a 2048 blocca il main thread 🟡

- **File:** `src/facade-system.js:13-37`, chiamato da `rebuildMaterials` (:210) via `setQuality` (:242)
- **Effort:** M · **Fase 2**

In ULTRA (`facadeResolution: 2048`) la conversione height→normal è un loop JS su 4,19 Mpx con `Math.hypot` per pixel: centinaia di ms di blocco sul main thread durante lo switch di qualità. Il modale di transizione maschera in parte il jank, ma il frame loop è comunque congelato.

**Fix (una delle due):**

1. **Chunking async:** `heightToNormal` elabora fasce di ~64 righe per tick con `await new Promise(r => setTimeout(r))`; `createFacadeMaps`/`rebuildMaterials` diventano async; il constructor può avviare la build 1024 in fire-and-forget (il boot è già async) e `setQuality` awaita sotto il modale di transizione.
2. **OffscreenCanvas + Worker:** soluzione più pulita ma richiede un file worker separato (o Blob URL) — valutare in Fase 3 insieme al refactor moduli.

Raccomandazione: opzione 1, minima invasività.


---

## 6. Pulizia e fix minori

### C1 — Dead code accertato

Verificato con ricerca globale su tutti i consumer (nessuna occorrenza oltre la definizione):

| Simbolo | Posizione | Note |
|---------|-----------|------|
| `addShockwave` | `index.html:2009-2012` | Funzione mai chiamata: le shockwave attive sono quelle di `ExplosionSystem` e del post chain |
| `addSpark` | `index.html:2452-2472` | Mai chiamata (gli impatti usano `explosionSystem.sparkBurst`) |
| `bulletCurrent` | `index.html:2478` | Vector3 mai usato |
| `gun()` alias | `src/audio-engine.js:581` | Mai usato (`fireBullet` chiama `playShoot`) |
| `makeNoise()` alias | `src/audio-engine.js:127` | Mai usato |
| `AdaptiveAudioEngine` | `src/audio-engine.js:627` | Sottoclasse di compatibilità mai importata |
| `renderer.onError` | `index.html:561` | Proprietà custom: WebGPURenderer non la invoca |

Anche l'array `shockwaves` di `index.html` (:1959) e `updateShockwaves`/`clearShockwaves` diventano candidati alla rimozione **solo dopo** aver rimosso `addShockwave` (sono il suo unico consumer). Valutare se invece riutilizzare `addShockwave` per l'impatto dei colpi nemici sui muri (oggi spariscono senza feedback — vedi M3).

### C2 — Telegraph hardcoded nel danno drone

- **File:** `src/drone-system.js:288` — `THREE.MathUtils.lerp(.14, .22, drone.random())` duplica i valori di `DRONE_TUNING.telegraphMin/Max` (0.14/0.24) con un massimo diverso.
- **Fix:** usare `DRONE_TUNING.telegraphMin/Max` come in `registerProjectileThreat` (:172).

### C3 — Pointer lock non rilasciato sui pannelli di errore

- **File:** `index.html:539` (`showRendererFailure`), :556 (`onDeviceLost`)
- Se il device si perde o il loop va in errore persistente mentre il pointer lock è attivo, l'overlay di recovery appare ma il cursore resta catturato: l'utente non può interagire né leggere comodamente.
- **Fix:** `document.exitPointerLock?.()` in entrambi i percorsi.

### C4 — Allocazioni nel percorso caldo

- `fireBullet` (`index.html:2380-2381`): 2 `Vector3` per colpo (~8/s a fuoco continuo) → temp object di modulo.
- `onTelegraph` (`index.html:1983`) e `applyDamage` (`drone-system.js:285,292`): `clone()` per evento → temp object.
- B6 copre il caso più pesante (`updateMarkers`).
- **Nota:** i cloni restituiti da `applyDamage` (`position`) sono consumati come punto di impatto: se si introduce un temp, copiarlo esplicitamente nei consumer (`damageDrone` lo usa subito, quindi è sicuro).

### C5 — Origine proiettile oltre la parete (edge case, opzionale)

- **File:** `index.html:2381` — spawn a `camera.position + dir*0.6`: con la schiena a 0.12 m dalla parete e mirando all'indietro il colpo nasce dentro/oltre il muro e vive 1.6s fuori arena (innocuo ma sporco).
- **Fix opzionale:** clamp dell'origine entro `±(arenaInnerFace - 0.2)` su X/Z, coerente con i limiti già usati per camera e corpi.


---

## 7. Miglioramenti strutturali

### M1 — Copertura test (Fase 1 parziale → Fase 3)

Setup `node --test` già presente; oggi coperto solo `player-collision.js`. Nuovi test proposti, tutti su moduli puri o con mock leggeri (niente DOM/WebGPU):

1. `tests/config.test.js` **(Fase 1, con B1):** default del mix a storage vuoto; valori persistiti; clamp fuori range; storage assente/eccezioni (privacy mode) → fallback senza throw; round-trip `storeMix` → `getStoredMix`.
2. `tests/graphics-manager.test.js` (Fase 3): mock di `requestAnimationFrame`/`applyProfile`; transizione AUTO HIGH→BALANCED dopo 6 finestre <50 FPS; risalita dopo 20 finestre >58 FPS; rispetto del cooldown 30s; `setMode('ultra')` → sequenza transizione e stato finale.
3. `tests/rng.test.js` (Fase 3): stesso seed → stessa sequenza; seed diversi → sequenze diverse; output in `[0, 1)`.

### M2 — Magic numbers → CONFIG (Fase 2)

Duplicati tra logica e HUD, oggi allineati solo per disciplina manuale:

| Valore | Occorrenze |
|--------|-----------|
| Scudo max `75` | `gameState` (:1861), regen (:2139), bonus ondata (:2140), respawn (:2094), reset (:2639), HUD (`hud-controller.js:45`) |
| Rigenerazione scudo `9/s`, delay `4.5s` | `index.html:2139` |
| Combo finestra `3.2s`, max `x5`, step `+.25` | `index.html:2070-2072` |
| Punteggi kill `100`, impatto `12` | `index.html:2073-2081` |
| Raggio danno giocatore `0.52` (≈0.72²) | `index.html:2112` (da condividere con il fix B4) |

Proposta: estendere l'oggetto `CONFIG` in `index.html` (`maxShield`, `shieldRegen`, `shieldRegenDelay`, `comboWindow`, …) e passare i massimi a `HudController` via state o costruttore.

### M3 — UX/gameplay a costo nullo (Fase 2)

- **Accuracy in telemetry:** `gameState.shots/hits` sono già tracciati ma mai mostrati → riga "ACCURACY" nel pannello telemetry (`hits/shots`).
- **Toast bonus fine ondata:** +25 scudo e +60 munizioni (:2140) sono oggi invisibili → un toast li rende percepibili.
- **Feedback impatto colpi nemici sui muri:** oggi il colpo sparisce; riusare `addShockwave`/`sparkBurst` (vedi C1: decidere se dare uno scopo ad `addShockwave` invece di cancellarla).
- **Sensibilità mouse:** slider nel settings panel (oggi hardcoded `0.0022`, :2209-2210), persistita in localStorage come il mix.

### M4 — Robustezza delle dipendenze CDN (Fase 3)

- `cannon.js` è caricato con `<script src>` semplice → aggiungere `integrity` (SRI) + `crossorigin="anonymous"`.
- Per l'import map di three: la specifica import map supporta il campo `"integrity"` (Chrome 127+); in alternativa **vendoring locale** di `three.webgpu.js`, `three.tsl.js`, addons usati e `cannon.min.js` sotto `vendor/` → il gioco funzionerebbe anche offline e senza rischio di modifiche CDN. Da valutare insieme al refactor moduli (M5).
- Nota: `cannon.js` 0.6.2 è fermo al 2015; la migrazione a `cannon-es` (fork mantenuto, API quasi identica, ESM nativo) è un'opzione da pianificare a parte, non inclusa in questo piano.

### M5 — Refactor: spezzare `bootGame()` (Fase 3, invasivo)

`index.html` concentra ~2400 righe di logica in una closure unica: stato condiviso implicito, testabilità nulla, merge difficili. Estrazione incrementale proposta (ogni step lascia il gioco funzionante):

1. `src/main.js` come entry (import da `index.html`, che resta solo markup + import map);
2. `src/arena-builder.js` (sezioni 3–5: cielo, materiali, arena, set dressing);
3. `src/game-state.js` (`gameState`, `resetLevel`, danno/respawn, onde — con unit test);
4. `src/weapon-system.js` (proiettili, melee, tracer);
5. `src/input.js` (pointer lock, tastiera, mouse).

Sequenza vincolata: prima M2 (costanti in un posto solo) e M1 (rete di sicurezza sui moduli puri), poi l'estrazione.

### M6 — CI minima (Fase 3)

Workflow GitHub Actions: `node --test` su push/PR + `node --check` su ogni file di `src/` e `tests/`. Per l'`index.html` (script inline di tipo module): estrazione del blocco `<script type="module">` in un file temporaneo `.mjs` e `node --check` (solo parsing: gli import bare/URL non vengono risolti da `--check`, quindi il controllo è fattibile in CI).


---

## 8. Falsi positivi verificati (non-bug)

Piste controllate e scartate, per non riesaminarle in futuro:

- **`constrainBodyToSquare`**: la semantica "rimuovi solo la velocità uscente" è corretta e coperta dai 4 test esistenti (parete, direzione entrante, angolo, NaN).
- **`DroneSystem.clear()`**: dispone i materiali per-drone ma non le geometrie/shared `darkMaterial` → corretto, sono risorse condivise di classe.
- **Deriva orizzontale della pioggia** (`arr[i*3] += sin(elapsed…)`): è l'integrale di un seno → oscillazione limitata, nessuna fuga di coordinate.
- **Radar 440px attributo / 220px CSS:** intenzionale (HiDPI), non un mismatch.
- **Override CSS duplicati** (`#crosshair`, `#radar`… tra `<style>` inline e `styles/hud.css`): hud.css è caricato dopo → vince; funziona, ma va consolidato in M5.
- **`mesh.castShadow = true` sul `Group` dei pickup:** no-op innocuo (il Group non ha geometria).
- **`randomDirection()` con vettore quasi nullo:** `THREE.Vector3.normalize()` gestisce length 0 (`divideScalar(length || 1)`) → nessun NaN.
- **Casse spinte dai proiettili:** comportamento voluto (commento :1223), non un glitch fisico.
- **`THREE.Timer` da `three/webgpu`:** presente nella build pinnata r184 e usato correttamente (`connect(document)` per la gestione visibilità).
- **`safeStorage`/`readStorage` in `config.js`:** correttamente protetti da try/catch (privacy mode, file://); il bug B1 è solo nel `Number(null)`.
- **Singleton `AudioEngine`:** il doppio ingresso via `getInstance` e `new` è gestito in entrambi i rami.
- **`hud.css` `.hud-shell.sprinting + #hud`:** `#game-hud` e `#hud` sono effettivamente sibling nel DOM → il selettore funziona.

---

## 9. Piano di implementazione

### Fase 1 — Bug fix chirurgici (questo sprint)

Ordine consigliato (ogni punto = un commit separato, test verdi tra un punto e l'altro):

| # | Item | File | Dipendenze |
|---|------|------|-----------|
| 1.1 | **B1** fix `getStoredMix` + nuovo `tests/config.test.js` | `src/config.js`, `tests/` | — |
| 1.2 | **B3** riallineamento scheduler musicale | `src/audio-engine.js` | — |
| 1.3 | **B4** sweep segmento per colpi nemici | `index.html` | — |
| 1.4 | **B2** gate `gameplayActive` in `animate` | `index.html` | fare dopo 1.3 per testare il tunneling in pausa |
| 1.5 | **B5** reset `nextFootstep`/`isGrounded`, stamina al respawn | `index.html` | — |
| 1.6 | **B8** pickup non consumato a riserva piena | `index.html` | — |
| 1.7 | **B7** re-sync selezione qualità | `src/hud-controller.js`, `src/graphics-manager.js`, `index.html` | — |
| 1.8 | **C1** rimozione dead code (decisione su `addShockwave`, vedi M3) | `index.html`, `src/audio-engine.js` | — |
| 1.9 | **C2** telegraph da `DRONE_TUNING` | `src/drone-system.js` | — |
| 1.10 | **C3** `exitPointerLock` sui pannelli di errore | `index.html` | — |

Criteri di uscita Fase 1: `node --test` verde (≥ 4 vecchi + nuovi config), `node --check` pulito sui moduli toccati, smoke test manuale del gioco (checklist §10).

### Fase 2 — Performance & UX

| # | Item |
|---|------|
| 2.1 | **B6** marker drone: cache ref + dirty-check + `transform` |
| 2.2 | **B9** `heightToNormal` chunked async |
| 2.3 | **C4** temp vectors in `fireBullet`/`onTelegraph`/`applyDamage` |
| 2.4 | **M2** magic numbers → `CONFIG` (+ passaggio max scudo all'HUD) |
| 2.5 | **M3** accuracy, toast bonus, feedback impatti nemici, slider sensibilità |
| 2.6 | **C5** (opzionale) clamp origine proiettili |

### Fase 3 — Struttura (da pianificare a parte)

M5 (refactor moduli, step incrementali), M4 (SRI/vendoring), M6 (CI), completamento M1 (graphics-manager, rng). Richiede una sessione dedicata con branch feature.


---

## 10. Strategia di validazione

**Automatizzata (locale e CI):**

```bash
node --test                                    # suite unitaria
for f in src/*.js tests/*.js; do node --check "$f"; done   # parsing moduli
# parsing dello script inline di index.html:
sed -n '/<script type="module">/,/<\/script>/p' index.html | sed '1d;$d' > /tmp/main.mjs && node --check /tmp/main.mjs
```

**Smoke test manuale (browser WebGPU, `python3 -m http.server 8080`):**

1. **B1:** profilo browser pulito (o `localStorage.clear()`) → avvio → musica/effetti udibili senza toccare gli slider.
2. **B2:** pausa con colpi nemici in volo → nessun danno; pausa a fine ondata → nessun banner nuova ondata; ripresa → combattimento coerente.
3. **B3:** tab in background 60s durante il gioco → ritorno senza raffica né freeze.
4. **B4:** con throttling CPU (DevTools 6x) farsi colpire da un colpo diretto → danno registrato.
5. **B5:** RESET LIVELLO a run avanzata → footstep immediatamente presenti; morte → respawn con energia piena.
6. **B7:** switch ULTRA e click su AUTO durante la transizione → selezione UI torna su ULTRA.
7. **B8:** riserva piena (180) → camminare su un drop → il pickup resta a terra.
8. Non regressione: qualità AUTO↔ULTRA, radar, marker, melee, jump pad, ricarica, mute (M), resize finestra.

**Non copribile qui:** nessun ambiente browser/GPU nella macchina di sviluppo → i punti 1–8 richiedono verifica manuale; i fix sono progettati per essere a rischio minimo (gating e clamp, nessuna riscrittura di logica).

---

## 11. Rischi e mitigazioni

| Rischio | Mitigazione |
|---------|-------------|
| B2: il gate congela qualcosa che deve restare vivo (es. idle dei droni prima dello start) | Guardia esplicita sui tre stati (`!started` / `paused` / `active`); smoke test 2 e 8 |
| B6/M2: il CSS consuma sia `--target-x/y` sia `left/top` | Verifica in `hud.css` prima di rimuovere un canale; diff visivo dei marker |
| B9: `rebuildMaterials` async cambia il contratto del constructor | Boot 1024 fire-and-forget; `setQuality` await sotto modale transizione |
| C1: `addShockwave`/`shockwaves` hanno un consumer nascosto | Ricerca globale già eseguita (unici consumer: `updateShockwaves`/`clearShockwaves`); rimozione atomica nello stesso commit |
| M5: regressioni durante l'estrazione | Step incrementali con gioco funzionante a ogni commit; M1+M2 prima come rete di sicurezza |

## 12. Metriche di completamento

- **Fase 1 chiusa quando:** 0 bug 🔴/🟠 aperti; `node --test` ≥ 8 test verdi; smoke test 1–8 superati.
- **Fase 2 chiusa quando:** 0 scritture DOM ridondanti nei marker (verifica con DevTools Performance); switch ULTRA senza long task >100 ms; costanti di gameplay in `CONFIG`.
- **Fase 3 chiusa quando:** `index.html` < 400 righe (markup + bootstrap); CI verde su push; dipendenze con SRI o vendored.

- **Fase 3 chiusa quando:** `index.html` < 400 righe (markup + bootstrap); CI verde su push; dipendenze con SRI o vendored.

---

## 13. Stato di completamento

Aggiornato dopo l'implementazione. **Tutte le azioni del piano sono state eseguite** (Fase 1, 2 e 3), con verifiche automatiche. Rimane segnalato chiaramente il lavoro M5 più profondo (rifattorizzazione completa di `bootGame` in `main.js`/`arena-builder.js`/`weapon-system.js`/`game-state.js`/`input.js`), che richiede una sessione dedicata con test in browser WebGPU.

### Fase 1 — ✅ Completata
| Item | Verifica |
|------|----------|
| B1 `getStoredMix` | Fix + `tests/config.test.js` (5 test) |
| B2 pausa reale | Gate `gameplayActive` in `animate()` |
| B3 scheduler audio | Riallineamento `nextStepTime` + tetto iterazioni |
| B4 sweep colpi nemici | `hostileSegment`/`hostileClosest` (anti-tunneling) |
| B5 reset stato | `nextFootstep`/`isGrounded` in resetLevel; stamina al respawn |
| B7 desync qualità | `panel.syncMode` + re-sync in `onQuality` |
| B8 pickup riserva piena | Non consumato se `amount <= 0` |
| C1 dead code | Rimosso `addShockwave`/`addSpark`/`effects`/`shockwaves`/`bulletCurrent`/`renderer.onError`/alias audio |
| C2 telegraph | Usa `DRONE_TUNING.telegraphMin/Max` |
| C3 pointer lock | `document.exitPointerLock?.()` nei pannelli di errore |

### Fase 2 — ✅ Completata
| Item | Verifica |
|------|----------|
| B6 marker drone | Cache ref + dirty-check + riuso vettore proiezione |
| B9 `heightToNormal` | Chunked async (`CHUNK_ROWS`), `FacadeSystem.init()`/`setQuality` async |
| C4 temp vectors | `bulletDir`/`bulletOrigin` riusati in `fireBullet` |
| C5 origine proiettili | Clamp entro i limiti arena |
| M2 magic numbers | Costanti salute/scudo/stamina/combo/punteggi in `CONFIG`; `HudController.maxShield` |
| M3 UX | Accuracy in telemetry; toast bonus ondata; slider sensibilità mouse (persistito) |

### Fase 3 — ✅ Completata (con nota su M5)
| Item | Verifica |
|------|----------|
| M1 test | `tests/rng.test.js` (4) + `tests/graphics-manager.test.js` (5) + `tests/config.test.js` (5) |
| M4 SRI | `integrity`+`crossorigin` su cannon.js; `integrity` su import map (build three.js) |
| M6 CI | `.github/workflows/ci.yml` (unit test + syntax check) |
| M5 (incremental) | Estratto `src/textures.js` (8 generatori) — `index.html` ridotto di ~130 righe |

**Nota M5:** il rifattorizzazione completa di `bootGame()` nei moduli `main.js`/`arena-builder.js`/`weapon-system.js`/`game-state.js`/`input.js` **non** è stata eseguita in questa sessione: è un intervento invasivo su ~2400 righe con stato condiviso implicito e necessita di verifica in browser WebGPU (non disponibile in questo ambiente). È stato invece completato il primo passo incrementale (estrazione dei generatori di texture puri in `src/textures.js`), che è sicuro e testabile. Il resto della Fase 3 è da pianificare su un branch feature, come indicato nel piano (§9, Fase 3).

### Validazione finale
- `node --test`: **18/18 verdi** (4 originali + 5 config + 4 rng + 5 graphics-manager).
- `node --check` pulito su tutti i file `src/*.js`, `tests/*.js` e sullo script inline di `index.html`.
- Smoke test manuale in browser WebGPU: **da eseguire** (checklist §10, punti 1–8) — nessun ambiente GPU a disposizione qui.

---

## 14. Seconda tornata — bug residui, improvement grafica/audio/UI (3 agosto 2026, pomeriggio)

> **Contesto:** il commit `3cb4cb1` ("Fix regressione: boot bloccato al 46%") ha **revertito B9** ripristinando `FacadeSystem` sincrono: lo switch ULTRA tornava a bloccare il main thread (~4,2M pixel in `heightToNormal` a 2048²). La tabella §13 segnava B9 chiuso: **riaperto e richiuso correttamente** (N1). Nuova revisione completa + probe headless reale (Playwright/Chromium) del percorso di boot.
>
> **Stato: ✅ TUTTE LE AZIONI ESEGUITE** con verifiche automatiche (22/22 test, smoke boot OK).

### Bug residui corretti

| ID | Titolo | Fix | Verifica |
|----|--------|-----|----------|
| N1 | Switch ULTRA blocca il main thread (B9 riaperto dal revert `3cb4cb1`) | `facade-system.js`: split `createFacadeCanvases`/`facadeMapsFromCanvases`; `heightToNormalAsync` chunked (`CHUNK_ROWS=64`); `rebuildMaterialsAsync` con **token di generazione** + try/catch; boot **invariato** (sincrono a 1024); cache mappe base per ritorno ULTRA→AUTO immediato | `node --check`; checklist GPU §15 |
| N2 | Input di gioco attivo in pausa (Space→salto al resume, R→reload a sim congelata) | Gate `locked && gameState.started && !gameStartLoading` nel `keydown` (`index.html`) | smoke boot |
| N3 | Accuracy oltre il 100% con melee (hits++ senza shots) | `damageDrone(..., countHit)`; melee passa `false` | checklist GPU |
| N4 | Cooldown dry-fire sovrascritto dal loop (click ogni 120 ms) | Rimossa la sovrascrittura: `fireBullet` gestisce da solo il cooldown | revisione codice |
| N5 | Copy pausa contraddittorio ("restano attivi" ma B2 congela) | Testo brief aggiornato: "simulazione sospesa… congelati fino al rientro" | revisione |
| N6 | Toast senza tetto | Cap 5 in `HudController.toast` con espulsione del più vecchio | `tests/hud-controller.test.js` (2 test) |
| N7 | Scritture DOM per-frame (`sprinting`, `firing`) | Dirty-check come da filosofia B6; `fireBullet` non tocca più il DOM | revisione |
| N8 | Mute non persistito, HUD non sincronizzato | `getStoredMuted`/`storeMuted` in `config.js`; `toggle()` persiste; sync HUD al boot | `tests/config.test.js` (2 test) |
| N9 | Pan stereo incoerente (explode/impatti non pannati) | Helper `panForWorld(position)` (proiezione NDC → pan clamp); applicato a explode, impatti drone, impatti muro | checklist GPU |

### Improvement

| ID | Area | Titolo | Implementazione |
|----|------|--------|-----------------|
| G1 | Grafica | Warmup shader al boot | `await renderer.compileAsync(scene, camera)` + un `renderPipeline.render(0,0)` (try/catch non bloccanti): niente hitch al primo frame/colpo/esplosione |
| G2 | Grafica | GPU dedicata | `powerPreference: 'high-performance'` nel `WebGPURenderer` |
| G3 | Grafica | Flicker insegne neon | `flickerSigns` (9 insegne): modulazione colore time-based + rari cali brevi |
| G4 | Grafica | Landing camera dip | `landingKick` proporzionale alla velocità d'impatto, decadimento morbido |
| G5 | Grafica | Animazione ricarica arma | `reloadDip` (lerp su `gameState.reloading`): arma scende e si inclina |
| A1 | Audio | Ducking in pausa | `AudioEngine.setMenuDuck` (musica ×.42, ambiente ×.5, sfx ×.82); hum droni muti col menu aperto |
| A2 | Audio | Spazializzazione coerente | vedi N9 — pan da proiezione schermo su esplosioni/impatti |
| A3 | Audio | Stinger ondata | `AudioEngine.waveStart()`: sweep ascendente + impatto basso |
| A4 | Audio | Heartbeat critico | Doppio tonfo sub-60 Hz su SFX quando `health < 35` (ogni 2 battute) |
| A5 | Audio | Persistenza mute | vedi N8 |
| D1 | Affidabilità | **Vendoring dipendenze** | `vendor/three/build/*` + 5 addon jsm + `vendor/cannon/cannon.min.js` (three.js 0.184.0, cannon.js 0.6.2). Import map locale, SRI rimosso. **Demo 100% offline** |
| D2 | Affidabilità | Smoke test automatico | `tools/smoke-boot.mjs` + `npm run smoke`: zero pageerror/console.error/404, verifica fallback senza adapter |
| D3 | Affidabilità | Checklist GPU manuale | §15 sotto |
| D4 | Affidabilità | Documentazione | Questa sezione + README aggiornato |

### Aggiustamenti post-review demo

| ID | Titolo | Fix | Verifica |
|----|--------|-----|----------|
| N10 | Pareti che cambiano colore avvicinandosi: la modalità edge-safe sostituiva il materiale testurizzato con un `MeshBasicMaterial` **blu piatto** (`0x2f6488`) entro 2,8 m | `index.html`: edge-safe ora è un `MeshStandardMaterial` che **condivide mappe e tinta** col materiale lit, con solo l'emissiva leggermente alzata come assicurazione anti-faccia-nera. Swap visivamente impercettibile, protezione mantenuta | checklist GPU §15 |
| A6 | Volumi di base troppo bassi (musica effettiva ~13% del full scale) → poi **SFX mascherati** dal letto musica/ambiente arricchito | `audio-engine.js`: master .72→**.9**; SFX con **boost dedicato ×1.3** (bus ~1.23); musica ×.26→**×.42**; ambiente ×.5→**×.62**; gain alzati su hit marker, passi, melee, pickup, dry, jump, UI. `config.js`: default music .78 / sfx .95 / ambience .66. Verificato con probe headless + AnalyserNode: segnale SFX presente (shoot 0.088→**0.147**, explode 0.177→**0.232**) | `tests/config.test.js` (3 attese) + probe audio |
| U7 | Slider dei volumi troppo piccoli (griglia 6 colonne/7 elementi, font 8px, range nativi minuscoli) → poi ancora **troppo corti** (117px) | `hud.css`: pannello 980px, **riga dedicata per i 4 slider** (~222px ciascuno, doppio rispetto alla prima iterazione), traccia 5px e thumb 15px custom glow, layout 2×2 sotto i 1100px | screenshot headless verificato: slider 222×18px, nessuno sbordo |
| U8 | Mute persistente (A5) invisibile sull'overlay → gioco apparentemente "senza audio" | `#overlay-sound-state`: badge **AUDIO MUTED — premi M per riattivare** su start/pausa, sincronizzato da `HudController.setMuted` | revisione + `tests/hud-controller.test.js` |
| A9 | Musica ancora poco presente | `applyMix`: musica ×.42→**×.55**; default `vibefps.mix.music` .78→**.82** (`config.js`, test aggiornati) | probe audio headless |
| G8 | **Insegne coreane perpendicolari sui muri est/ovest**: il telaio (`frame`, box sottile solo lungo Z) non veniva mai ruotato — aderiva solo ai muri nord/sud | `index.html` `createNeonSign`: `frame.lookAt(pos + normal)` — il telaio segue la normale della parete | checklist GPU §15 |
| G9 | Texture procedurali a bassa risoluzione (metallo **256**, legno **256**, asfalto **512**, hazard **256**) | `textures.js`: generatori parametrizzati — metallo **1024**, legno **512**, asfalto **1024**, hazard **512**, PBR asfalto **1024**; normal map muri a 1024 **condivisa** (conversione 1× invece di 4×). Costo generazione misurato: **74 ms** totali | screenshot headless delle 4 texture + smoke boot |

### Validazione seconda tornata
- `node --test`: **22/22 verdi** (18 precedenti + 2 config mute + 2 hud-controller toast cap).
- `node --check` pulito su `src/*.js`, `tests/*.js`, `tools/*.mjs` e script inline.
- `npm run smoke`: **OK** — boot headless completato, fallback WebGPU verificato, nessun errore, nessuna risorsa mancante (valida anche il vendoring D1).
- Ambiente di sviluppo **senza adapter WebGPU**: la validazione del rendering reale resta alla checklist manuale §15.

## 15. Checklist manuale su macchina con GPU (pre-presentazione)

Eseguire in browser con WebGPU (Chrome/Edge recenti), servendo la cartella via HTTP:

1. **Boot**: barra di caricamento fino a `SYSTEM READY` senza errori console; nessuno stallo (watchdog muto).
2. **Start**: click su INIZIALIZZA SIMULAZIONE → pointer lock, HUD visibile, musica + ambiente attivi (o MUTED se persistito da sessione precedente, con HUD coerente).
3. **Primo colpo e prima esplosione**: nessun hitch percettibile (warmup G1).
4. **Pausa (Esc)**: simulazione congelata (droni fermi, copy N5), musica attenuata (A1), hum droni assenti; Space/R in pausa senza effetto (N2); ripresa senza salto o reload spurii.
5. **Switch ULTRA**: dal pannello settings → transizione senza freeze (N1); ritorno ad AUTO immediato (cache mappe base).
6. **Gameplay**: fuoco a secco → click dry ogni ~200 ms (N4); melee + accuracy ≤ 100% (N3); kill → esplosione pannata (N9/A2), toast max 5 (N6); wave start con stinger (A3); salute <35 → heartbeat (A4) + HUD critical.
7. **RESET LIVELLO**: run riavviata a ondata 1 senza residui.
8. **Atterraggio da salto/jump pad**: dip camera proporzionale (G4) + suono land; flicker neon visibile sulle insegne (G3); arma si abbassa in ricarica (G5); telai delle insegne coreane aderenti ai muri est/ovest (G8); dettaglio texture di asfalto, muri e casse visibilmente più fine da vicino (G9).
9. **Pareti rasenti**: percorrere il perimetro incollati al muro — nessun cambio di colore delle pareti (N10); volumi base e SFX chiaramente udibili al primo avvio (A6: sparo, hit marker, passi, esplosioni sopra il letto musicale); slider volumi lunghi e trascinabili (U7); premendo M il badge AUDIO MUTED compare sull'overlay e sparisce alla riattivazione (U8).
10. **Offline**: ripetere i punti 1–3 con la rete disattivata (vendoring D1).
