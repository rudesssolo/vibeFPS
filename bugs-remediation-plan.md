# VIBE FPS — Registro dei bug

> Revisione: 7 agosto 2026 (sera) · Storico dei difetti trovati e corretti, e di quelli ancora aperti.

## Come leggere questo documento

- **§1 Aperti** è l'unica sezione che richiede azione. Il resto è storia chiusa, tenuta per non ripercorrere strade già battute.
- Gli ID sono per tornata: `B/C/M` prima, `N` seconda, `T` terza, `Q` quarta, `R` quinta, `S` sesta.
- I riferimenti al codice sono `file › simbolo`, non numeri di riga: i numeri marciscono a ogni modifica.
- Qui stanno i **difetti**. Gli interventi di performance stanno in `performance-optimization-plan.md`.

## 1. Aperti

**Nessuno.** La sesta tornata (§2) ha chiuso T1, T2, Q8 e S0…S9.

Quel che resta non sono difetti ma performance: varianti strutturali della pipeline (§4.1 del piano performance) e baseline su GPU hardware, incompleta.

Un reperto da confermare, aperto lì e non qui: `pipelineNuoveInGioco = 3` su hardware — tre shader compilati in gioco invece che al warmup, riproducibili. Diventa un bug solo se la misura discriminante lo conferma.

## 2. Sesta tornata (7 agosto 2026, sera)

| ID | Sev. | Titolo | Causa e fix |
|----|------|--------|-------------|
| **S5** | 🔴 | Le colonne cilindriche erano attraversabili | `CANNON.Cylinder` è costruito lungo **Z**, `THREE.CylinderGeometry` lungo **Y**: senza rotazione i corpi restavano coricati e la colonna diventava un cilindro orizzontale che iniziava sopra la testa del collider. Rotazione di −90° attorno a X applicata alla **forma**, non al corpo, così `body.quaternion` resta identità per chi legge l'orientamento. Verificato con un A/B in browser: senza rotazione il giocatore non veniva respinto (0,90 → 0,90 m), con rotazione sì |
| **T1** | 🔴 | I visuali degli archetipi Apex non venivano renderizzati | Le parti erano già nel gruppo visivo ma nessuno l'aveva verificato — e quell'aggiunta aveva introdotto un difetto nuovo: le decorazioni **additive** entravano nella shadow map, proiettando blocchi opachi al posto di un bagliore. Filtro dei caster ora per materiale (`drone-system.js › applyShadowFlags`), valido anche per archetipi futuri |
| **T2** | 🟠 | Il drop di un'arma poteva sparire per sempre | Gating estratto in `weapon-drops.js › WeaponDropRegistry`. Il buco residuo era la **railgun**: guardia `wave !== 1` e nessun rilascio alla scadenza, quindi l'unica arma irrecuperabile. Ora segue la regola delle altre (ondate 1, 5, 9) |
| **S1** | 🟠 | In WebGPU `MeshBasicMaterial` **non è unlit** | three lo converte in `MeshBasicNodeMaterial`, che dichiara `lights = true` e passa da `BasicLightingModel.indirect()`, dove `indirectDiffuse.mulAssign(ambientOcclusion)` prende l'AO della pipeline. **47 materiali** emissivi uscivano più scuri del dichiarato. Introdotto `materials.js › unlitBasic` (`lights = false`); nessun `new THREE.MeshBasicMaterial` resta in `src/`, e un test lo impedisce |
| **S0** | 🟠 | La luna era un disco nero con pale a ventaglio | Due difetti sovrapposti: luna e alone **complanari** (z-fighting a scacchi lungo gli spigoli dei settori), e sotto — per S1 — la luna era **nera**, perché per la GTAO un disco isolato col cielo 30 unità dietro è occlusione quasi totale. Alone spostato a 372 con raggio scalato; materiali `lights = false` |
| **S2** | 🟠 | Un Apex fuori inquadratura perdeva la barra della vita | `.target-marker.offscreen .target-health { display: none }` è giusta per i droni ma si applicava anche agli Apex, e nel gauntlet almeno due dei quattro sono sempre fuori campo. Override a specificità maggiore per i soli Apex. Il percorso JS era già corretto |
| **S4** | 🟠 | Il blink del WRAITH era muto e quasi invisibile | `onApexContact(apex, 'blink')` finiva in un callback vuoto in `main.js`: l'evento veniva lanciato e buttato via. L'unico effetto visivo, l'afterimage, è figlia del gruppo e quindi si spostava **con** l'Apex, marcando solo l'arrivo. Aggiunti `audio-engine.js › apexBlink` (due stadi, pan diversi: dice da dove a dove) e sagome poolizzate ai due capi del salto, più uno sfarfallio su due frequenze incommensurabili |
| **S7** | 🟡 | L'acqua allagava anche sotto gli oggetti solidi | La maschera non sapeva nulla degli ostacoli, quindi la lamina passava **sotto il jump pad**. La sua piastra luminosa, 29 cm più in alto, ci si specchiava dentro: un riflesso corretto per uno specchio — spostato di `2h/tan θ`, cioè oltre due metri a 15° di inclinazione — ma assurdo per un oggetto poggiato a terra, che sembrava sdoppiato. Le impronte a terra dei corpi statici sono ora raccolte **mentre vengono create** (`main.js › staticFootprints`) e sottratte alla maschera, non alla geometria: così geometria, `isPuddle` e increspature restano d'accordo. Verificato in browser: 0 punti d'acqua su 24 799 campionati dentro le 13 impronte |
| **S9** | 🟠 | Chiazze poligonali scure sulle increspature | Il riflesso si campiona a uv deformate dalla normale per far vedere il moto dell'onda, ma lo scostamento era `normalView.xy × 0.22` e le normali arrivano a inclinarsi di .96: l'offset raggiungeva il **22% dello schermo**, quindi il campionamento usciva dalla texture del riflesso e ne tornava il colore del bordo — a chiazze, lungo gli spigoli dei triangoli. Scostamento ridotto a .045 e uv **clampate**; un test cade se il clamp sparisce |
| **S8** | 🟠 | Il riflesso nelle pozze sembrava una copia solida fuori prospettiva | L'acqua mostrava il riflesso **×2,1, nitido, con opacità .76 a qualunque angolo**: uno specchio che amplifica, più luminoso della sorgente. L'immagine speculare di un oggetto alto `h` è spostata di `2h/tan θ` — oltre due metri per la piastra del jump pad a 15° — e a quella intensità non si leggeva come riflesso ma come un secondo pad. Sostituita con la riflettanza di Fresnel (Schlick, esponente 4 invece di 5 per ammorbidire): dal 210% fisso a **7% a 2,5 m e 81% a 30 m**. Anche l'opacità segue l'angolo, così a piombo la lamina resta trasparente e sotto si vede l'asfalto invece di una macchia scura |
| **S6** | 🟠 | Pozzanghere finte sopra quelle vere | `createIndustrialSetDressing` posava 17 ellissi piatte chiamate `puddle` a y=.058, **sopra** la lamina d'acqua (.045): riflettevano l'environment map invece della scena, non reagivano a nulla e coprivano quelle nuove. Rimosse. Nella stessa tornata: il contorno usciva a scalini perché `maskAt` campionava a vicino più prossimo con texel larghi quanto una cella (94% di campioni adiacenti identici in transizione → 0,4% con l'interpolazione bilineare) |
| **S3** | 🟡 | Gli Apex di tier 2 e 3 erano identici a quelli di tier 1 | `buildApexVisual` ignorava `stats.tier`. Ora ogni archetipo cresce lungo **la propria abilità** più una cresta dorsale di `tier` pinne. Corretti due difetti latenti emersi facendolo: lo sfasamento delle orbite VEX era fisso a 3 (dal tier 2 si sarebbero sovrapposte) e `applyApexDamage` nascondeva una sola piastra d'armatura |
| **Q8** | 🟡 | `aoPass.enabled = false` inerte, guardia `!== undefined` sempre vera | `render-pipeline.js › gateAoPass` intercetta `updateBefore` e salta il render del quad quando l'AO è spenta, dopo un frame che inizializza la render target. `aoBlend` è una uniform, quindi spegnere l'AO non ricompila i materiali. Chiuso **solo come difetto**: la render target resta, eliminarla è §4.1 del piano performance |

**Verifica.** Test di regressione per ognuno, più tre smoke in browser reale (wave 1, wave 9, railgun/ULTRA). Quello che qui **non** si può verificare sono i pixel: per T1, S0 e S1 la causa è stata letta nella sorgente vendorizzata di three, non dedotta, e ciò che è misurabile — grafo della scena, conteggi di mesh, flag delle ombre, campo della maschera — è sotto test.

## 3. Quinta tornata — schermo nero (7 agosto 2026)

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

## 4. Quarta tornata — cambio di tier e reflection (6 agosto 2026)

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

## 5. Terza tornata — armi, Apex e luci (4 agosto 2026)

Tutte chiuse. T1 e T2 sono state le ultime, il 7 agosto sera: vedi §1.1 per il fix conclusivo e la verifica.

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

## 6. Seconda tornata — pausa, audio e HUD (3 agosto 2026)

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

## 7. Prima tornata — bug fondamentali (3 agosto 2026)

Tutte chiuse.

**Bug:** B1 gioco muto al primo avvio; B2 il menu di pausa non sospendeva la simulazione (si poteva morire in pausa); B3 raffica audio dopo un tab in background; B4 tunneling dei colpi nemici a FPS bassi; B5 reset di stato incompleto; B6 layout thrash DOM dei marker; B7 desync della UI durante la transizione ULTRA; B8 pickup munizioni consumato a riserva piena; B9 `heightToNormal` a 2048 bloccava il main thread.

**Pulizia:** C1 dead code; C2 telegraph da `DRONE_TUNING`; C3 pointer lock rilasciato sui pannelli di errore; C4 vettori temporanei riusati nel percorso caldo; C5 origine dei proiettili clampata entro l'arena.

**Struttura:** M1 copertura test; M2 magic number in `CONFIG`; M3 UX a costo nullo; M4 SRI sulle dipendenze; M6 CI minima. **M5** (rifattorizzazione di `bootGame()`) non è un bug ma lavoro aperto: avviato con l'estrazione di `textures.js` e proseguito con la modularizzazione in `src/`.

## 8. Validazione

```bash
npm test          # 39 test
npm run lint:tsl
npm run smoke     # anche con SMOKE_WAVE=9 e SMOKE_WEAPON=railgun
git diff --check
```

I test sono raggruppati per comportamento, non per asserzione: un caso copre un
invariante intero e ogni `assert` porta il proprio messaggio, così un fallimento
resta localizzabile senza moltiplicare i `test()`.

**Non** verificabile qui: pixel (adapter software, catture bianche), tempi per frame, timeout della GPU. Serve una GPU reale — §7 del piano performance.

**Verificabile qui**, ed è ciò che ha chiuso T1: la struttura del grafo della scena. Costruire le mesh con three reale in Chromium e contarle non dipende dal backend, come i contatori di draw call. Non dice se un Apex è *bello*; dice se è *presente e distinto*, che era la sostanza del difetto.

## 9. Lezioni apprese

1. **Un log della console vale dieci ipotesi.** R1 è stato risolto in un passaggio con lo stack reale, dopo tre ipotesi sbagliate formulate senza.
2. **Distinguere il sintomo dal difetto.** "Si blocca saltando verso il muro" ha avuto tre cause diverse in tre tornate (T10, Q1, R1). Lo stesso gesto non implica lo stesso bug.
3. **Un'ottimizzazione può rendere raggiungibile un difetto latente.** Q1 esisteva da sempre: è emerso solo quando una reflection più costosa ha iniziato a far scattare il downgrade automatico.
4. **Le patch basate su stringhe si rompono in silenzio.** Q6 è rimasto invisibile finché non è stata aggiunta un'asserzione sull'ancora.
5. **Verificare la geometria contro l'implementazione precedente**, usandola come oracolo, invece di ispezionarla a occhio.
6. **"Serve una GPU reale" spesso vuol dire "serve solo per l'ultimo passo".** T1 e T2 sono rimasti aperti settimane in attesa di una verifica visiva; la parte verificabile — grafo della scena, calendario dei drop — si controllava qui, e conteneva ancora due difetti reali (caster additivi, railgun irrecuperabile). Separare la parte misurabile prima di rimandare tutto.
7. **Un nome può mentire quanto un flag.** In WebGPU `MeshBasicMaterial` non è unlit: three lo fa passare da un modello di illuminazione e lo moltiplica per l'AO. Quarantasette materiali "emissivi" erano più scuri del dichiarato e nessuno se n'era accorto, perché sembravano semplicemente una scelta artistica. Quando il rendering non torna, leggere la classe che il renderer usa davvero, non quella che si è scritta.
8. **Un sintomo può nasconderne un altro.** Separare i due dischi complanari della luna non l'ha "sistemata": ha tolto l'alone che la copriva e ha mostrato che il disco era nero da sempre. Un fix che cambia il sintomo senza spiegarlo del tutto va guardato una seconda volta.
9. **Una proprietà che non fa niente è peggio di una proprietà assente.** `aoPass.enabled` e la guardia `!== undefined` costruita attorno davano l'impressione che l'AO si spegnesse su autoLow. Se un flag di libreria non è consultato, o lo si consulta noi o lo si toglie.
10. **Non costruire l'effetto dove non lo si può osservare.** Le pozzanghere sono nate come maschera campionata nel fragment shader: non si vedeva nulla e non c'era modo di scoprire perché, perché i pixel qui non sono leggibili. Rifatte come geometria con le onde calcolate sulla CPU, ogni cosa che decide il risultato — triangoli, estensione, quota dei vertici — è misurabile fuori dal browser. Quando l'ambiente non può osservare un percorso, spostare la logica su un percorso che può.
11. **Un test che non si è visto fallire non dimostra niente.** Il campionamento a vicino più prossimo e la deformazione della maschera sono stati verificati rimettendo il difetto e controllando che il test cadesse.
