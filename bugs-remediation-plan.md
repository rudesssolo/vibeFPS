# VIBE FPS — Registro dei bug

> Revisione: 7 agosto 2026 · Storico dei difetti trovati e corretti, e di quelli ancora aperti.

## Come leggere questo documento

- **§1 Aperti** è l'unica sezione che richiede azione. Il resto è storia chiusa, tenuta per non ripercorrere strade già battute.
- Gli ID sono per tornata: `B/C/M` prima, `N` seconda, `T` terza, `Q` quarta, `R` quinta.
- I riferimenti al codice sono `file › simbolo`, non numeri di riga: i numeri marciscono a ogni modifica.
- Qui stanno i **difetti**. Gli interventi di performance stanno in `performance-optimization-plan.md`.

## 1. Aperti

| ID | Sev. | Titolo | Codice | Nota |
|----|------|--------|--------|------|
| **T1** | 🔴 | I visuali specifici degli archetipi Apex non vengono renderizzati | `drone-system.js › buildApexVisual` | Serve conferma visiva su GPU reale: mai verificato a schermo |
| **T2** | 🟠 | Il drop di un'arma può sparire per sempre (soft-lock) | `main.js › updateWeaponPickups` | Serve conferma visiva su GPU reale |
| **Q8** | 🟡 | `aoPass.enabled = false` è inerte — il `GTAONode` vendorizzato non consulta quella proprietà — e la guardia `if (this.aoPass.enabled !== undefined)` è sempre vera | `render-pipeline.js › setQuality` | Da affrontare insieme alla variante di pipeline per autoLow, non isolatamente. Vedi §4.1 del piano performance |

Non c'è altro di aperto. I difetti latenti segnalati in passato — Q6 (patch dello smoke test inefficaci) e Q7 (dead code) — sono stati corretti.

## 2. Quinta tornata — schermo nero (7 agosto 2026)

### R1 — Schermo nero per secondi saltando verso una parete 🔴

**Sintomo.** Saltando in alto verso una parete, in ULTRA, il canvas 3D diventa completamente nero per alcuni secondi mentre l'HUD (che è DOM) continua a disegnarsi. Poi torna normale. Frame rate normale prima e dopo: ~100 FPS.

**Errore reale**, dalla console dell'utente:

```
VIBE post-processing frame skipped; retrying
TypeError: Cannot destructure property 'object' of 'renderList[i]' as it is undefined.
  at WebGPURenderer._renderObjects
  ...
  at PassNode.updateBefore                 ← un oggetto fa ripartire un pass
  at WebGPURenderer._renderObjectDirect    ← mentre un altro pass sta iterando
```

**Causa.** `normalPass` e `scenePass` renderizzano entrambi la coppia `(scene, camera)`: three riusa per loro la **stessa render list poolizzata**. Il collegamento che li fa annidare è `scenePass.contextNode = builtinAOContext(aoFactor)`, che lega gli oggetti della scene pass alla texture della normal pre-pass. Un oggetto poteva quindi far ri-scattare la normal pass **dentro** la scene pass; il render annidato azzera la lista con `begin()`, ma `_renderObjects` ha già catturato `il = renderList.length`, e le iterazioni successive leggono `undefined`.

La pipeline cattura l'eccezione e non disegna nulla. In WebGPU la texture del canvas è invalidata dopo il present, quindi **un frame senza disegno è nero**, non l'ultimo frame valido. Ripetuto su decine di frame, sono i secondi di nero.

**Fix.** `render-pipeline.js › guardPassReentrancy`: se un pass sta già renderizzando, un secondo pass restituisce `false` invece di eseguire. È la convenzione di three stesso — `ReflectorBaseNode` usa lo stesso meccanismo con `_inReflector`. `NodeFrame` annulla la registrazione e ritenta fuori dal contesto annidato; il dato non si perde perché il pass esterno ha già prodotto la sua texture in quel frame. Tre test di regressione, incluso il riarmo della guardia quando un pass lancia.

**Ipotesi verificate e scartate**, documentate per non ripercorrerle: compilazione delle pipeline del pass reflection (senza warmup se ne crea **una sola** salendo in quota, non un burst); resize della render target della reflection o della shadow map (uguagliando quei parametri fra profili lo stallo non cambiava); `needsUpdate` in `_applyWetness`; sovraccarico del fumo volumetrico — il difetto si presenta a wave 01 con 0 kill, quindi **senza fumo in scena**.

**Nota di metodo.** Questa classe di difetto **non è riproducibile sull'adapter software** di sviluppo: non c'è driver da resettare. È stata risolta solo grazie al log della console dell'utente. Da lì è nato il "referto del frame lento" descritto in §7 del piano performance.

## 3. Quarta tornata — cambio di tier e reflection (6 agosto 2026)

Contesto: la sessione di ottimizzazione ha reso raggiungibile un difetto preesistente e ne ha introdotto uno nuovo.

| ID | Sev. | Titolo | Fix |
|----|------|--------|-----|
| **Q1** | 🔴 | Cambio di tier automatico → ~2 s di freeze. `ExplosionSystem.setQuality` cambiava `light.visible`: in WebGPU il `lightsNode` aggrega le luci **visibili** dentro lo shader, quindi variarlo **ricompila ogni materiale della scena** — 39 pipeline create e distrutte a ogni switch | Set di luci fissato al boot al massimo `dynamicLights` fra i profili; il budget per profilo resta effettivo tramite il pool di allocazione. Misurato: **2200 ms → 36 ms**, pipeline costanti a 214 |
| **Q2** | 🟠 | Frammenti di un fotogramma precedente sul pavimento dopo un hitch. **Regressione introdotta dal throttle della reflection**, che limitava la staleness in *frame*: durante un hitch un solo frame resta a schermo per un secondo, con una reflection catturata prima | Soglia di deriva della posa stretta a .35 m / .05 rad (era 2 m / 0,35 rad ≈ 20°); un frame oltre 40 ms disattiva il throttle; scheduler resettato al cambio profilo e su frame fallito |
| **Q3** | 🟡 | `updateReflectionQuality` era **inefficace**: `resolutionScale` vive su `ReflectorBaseNode`, non sul `ReflectorNode` restituito da `reflector()`. Il budget del riflesso non aveva mai avuto effetto | Scritto sul nodo giusto, e poi ancorato all'altezza del buffer invece che al lato lungo: su schermi larghi la risoluzione verticale collassava a 512×214 su 3440×1440 |
| **Q4** | 🟡 | `VolumetricSmokeSystem.setQuality` ricostruiva i materiali al variare dei passi del raymarch: ~35 pipeline compilate nello stesso frame di Q1 | Entrambe le varianti precompilate al boot; `setQuality` scambia riferimenti |
| **Q5** | 🟡 | `Math.min(getMaxAnisotropy(), profile.anisotropy)` dà **`NaN`** se il profilo non espone il campo (es. `config.js` servito dalla cache del browser insieme a un `main.js` nuovo). `NaN` nel sampler descriptor è un errore di validazione WebGPU: muri, asfalto e casse smetterebbero di disegnarsi | Valore validato con `Number.isFinite`, fallback a 8, più `Math.max(1, …)` |
| **Q6** | 🟡 | `tools/smoke-boot.mjs` sostituiva stringhe in `index.html` che dopo la modularizzazione vivono in `src/main.js`: `SMOKE_WAVE` e `SMOKE_WEAPON` **non facevano più nulla, silenziosamente** | Le patch agganciano `src/main.js`; un'ancora mancante ora esce con errore invece di essere un no-op |
| **Q7** | 🟡 | Dead code in `applyWeaponDetail`: closure `attachIfNeeded` mai chiamata che duplicava il loop successivo, più quattro `const` inutilizzate | Rimossi |

Difetto ulteriore trovato nella stessa tornata e corretto: il **fumo volumetrico** consentiva fino a 16 puff con la camera dentro, cioè 16 raymarch a schermo pieno da 12 passi nello stesso frame. Un budget di copertura ora ne ammette 2 in ultra. Non era la causa di R1, ma era un difetto reale.

## 4. Terza tornata — armi, Apex e luci (4 agosto 2026)

Tutte chiuse tranne T1 e T2, che restano in §1 in attesa di verifica visiva.

| ID | Titolo | Fix |
|----|--------|-----|
| T3 | Tuning railgun duplicato (due fonti di verità) | `RAILGUN_TUNING` derivato da `WEAPON_TUNING.railgun` |
| T4 | Leak/duplicazione delle canne del minigun allo switch ULTRA | Cache dei due LOD, niente ricostruzione |
| T5 | Cella munizioni "piena" con arma a colpo singolo scarica | Cella 0 piena solo se `ammo > 0` |
| T6 | Cono del lanciafiamme: distanza XZ con direzione 3D → NaN-bypass | Direzione e offset proiettati su XZ, guardia su distanza ≈ 0 |
| T7 | Bonus munizioni di fine ondata solo alla riserva del pulse | `setWeaponAmmo` sull'arma attiva |
| T8 | `audio.flame()` allocava 2 burst di rumore per tick (20/s) | Throttle a ~1 ogni 0,12 s |
| T9 | `flameBurst` saturava il pool additivo da 720 particelle | Count per burst ridotto a ~5 |
| T10 | Salto in alto vicino ai muri → l'arena si scuriva | La "modalità edge-safe" **bypassava tutto il post-processing**. Bypass rimosso: resta solo lo swap del materiale delle pareti |

## 5. Seconda tornata — pausa, audio e HUD (3 agosto 2026)

Tutte chiuse.

| ID | Titolo | Fix |
|----|--------|-----|
| N1 | Lo switch ULTRA bloccava il main thread (B9 riaperto da un revert) | `heightToNormalAsync` chunked, rebuild con token di generazione |
| N2 | Input di gioco attivo in pausa | Gate sul `keydown` |
| N3 | Accuracy oltre il 100% con il melee | `damageDrone(..., countHit)` |
| N4 | Cooldown dry-fire sovrascritto dal loop | `fireBullet` gestisce da solo il cooldown |
| N5 | Copy della pausa contraddittorio | Testo allineato al comportamento reale |
| N6 | Toast senza tetto | Cap a 5 con espulsione del più vecchio |
| N7 | Scritture DOM per-frame (`sprinting`, `firing`) | Dirty-check |
| N8 | Mute non persistito, HUD non sincronizzato | `getStoredMuted` / `storeMuted` |
| N9 | Pan stereo incoerente su esplosioni e impatti | Helper `panForWorld` |
| N10 | Pareti che cambiavano colore avvicinandosi | Rimosso lo swap di materiale della modalità edge-safe |

## 6. Prima tornata — bug fondamentali (3 agosto 2026)

Tutte chiuse.

**Bug:** B1 gioco muto al primo avvio; B2 il menu di pausa non sospendeva la simulazione (si poteva morire in pausa); B3 raffica audio dopo un tab in background; B4 tunneling dei colpi nemici a FPS bassi; B5 reset di stato incompleto; B6 layout thrash DOM dei marker; B7 desync della UI durante la transizione ULTRA; B8 pickup munizioni consumato a riserva piena; B9 `heightToNormal` a 2048 bloccava il main thread.

**Pulizia:** C1 dead code; C2 telegraph da `DRONE_TUNING`; C3 pointer lock rilasciato sui pannelli di errore; C4 vettori temporanei riusati nel percorso caldo; C5 origine dei proiettili clampata entro l'arena.

**Struttura:** M1 copertura test; M2 magic number in `CONFIG`; M3 UX a costo nullo; M4 SRI sulle dipendenze; M6 CI minima. **M5** (rifattorizzazione di `bootGame()`) non è un bug ma lavoro aperto: avviato con l'estrazione di `textures.js` e proseguito con la modularizzazione in `src/`.

## 7. Validazione

```bash
npm test          # 103 test
npm run lint:tsl
npm run smoke     # anche con SMOKE_WAVE=9 e SMOKE_WEAPON=railgun
git diff --check
```

Quello che l'ambiente di sviluppo **non** può verificare: i pixel (adapter software, catture bianche), i tempi per frame, i timeout della GPU. Per quelli serve una macchina con GPU reale — vedi §7 del piano performance.

## 8. Lezioni apprese

1. **Un log della console vale dieci ipotesi.** R1 è stato risolto in un passaggio con lo stack reale, dopo tre ipotesi sbagliate formulate senza.
2. **Distinguere il sintomo dal difetto.** "Si blocca saltando verso il muro" ha avuto tre cause diverse in tre tornate (T10, Q1, R1). Lo stesso gesto non implica lo stesso bug.
3. **Un'ottimizzazione può rendere raggiungibile un difetto latente.** Q1 esisteva da sempre: è emerso solo quando una reflection più costosa ha iniziato a far scattare il downgrade automatico.
4. **Le patch basate su stringhe si rompono in silenzio.** Q6 è rimasto invisibile finché non è stata aggiunta un'asserzione sull'ancora.
5. **Verificare la geometria contro l'implementazione precedente**, usandola come oracolo, invece di ispezionarla a occhio.
