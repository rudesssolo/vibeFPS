# VIBE FPS — Piano di ottimizzazione performance

> Revisione: 7 agosto 2026 (sera) · Rendering WebGPU/TSL, fisica Cannon.js, audio WebAudio, HUD/DOM.

## Come leggere questo documento

- Ogni voce ha uno stato: **FATTO** (implementato e misurato) o **APERTO**.
- I riferimenti al codice sono `file › simbolo`, non numeri di riga: i numeri marciscono a ogni modifica.
- Le voci FATTO riportano il numero misurato, non una stima. Se un numero manca, è dichiarato.
- Prima di aggiungere una voce, leggere §7 "Metodo di misura": alcune metriche in questo ambiente non sono affidabili.

## 1. Diagnosi

> **Ragionata sulla struttura del frame, non misurata.** La prima misura su GPU reale (§7) dice che in ultra il frame costa 5-6,7 ms su un budget di 10 ms: su quell'hardware il throughput ha margine e il collo di bottiglia, se c'è, non morde. Vale ancora per i profili bassi e le macchine deboli, dove nessuno ha misurato. L'ordine di priorità sotto poggia su questa ipotesi non verificata.

Il collo di bottiglia è la **GPU**. Il frame attraversa la scena fino a quattro volte: shadow map, normal pre-pass, scene pass, reflection del pavimento. Il profilo autoLow riduce parametri ma non rimuove nessuna pass strutturale.

Secondo gruppo, **CPU**: i proiettili sono integrati da Cannon *e* sottoposti a sweep manuali; la separazione fra droni è O(n²); il fuoco automatico crea molti nodi WebAudio.

## 2. Stato complessivo

| § | Area | Priorità | Stato |
|---|---|---|---|
| 3 | Pipeline GPU e post-processing | P0 | APERTO (fatti: guardia di rientranza, gate del quad GTAO) |
| 4 | Reflection del pavimento | P0 | **FATTO** |
| 5 | Ombre | P0/P1 | APERTO |
| 6 | Smoke volumetrico | P1 | **FATTO** in parte (budget + varianti); instancing APERTO |
| 7 | Proiettili e fisica | P1 | APERTO |
| 8 | Droni e Apex | P1 | APERTO |
| 9 | Città, draw call e materiali | P1 | **FATTO** in parte (merge + atlas); LOD e instancing APERTI |
| 10 | Texture e memoria GPU | P1/P2 | **FATTO** solo l'anisotropia |
| 11 | Audio WebAudio | P2 | APERTO |
| 12 | Pausa, menu e idle | P2 | APERTO |
| 13 | Boot, warmup e armi | P2 | APERTO |
| 14 | Culling dei renderable dinamici | P2 | APERTO |
| 15 | HUD e DOM | P2 | **FATTO** |
| 16 | Selezione del profilo all'avvio | P1 | APERTO |

## 3. Fatto, con le misure

| Intervento | Codice | Risultato misurato |
|---|---|---|
| Throttle della reflection per profilo (2/4/2 frame) | `reflection-throttle.js › ReflectionScheduler` | il pass reflection vale ≈175–200 draw call, saltati sui frame non dovuti |
| `resolutionScale` scritto sul nodo giusto | `main.js › updateReflectionQuality` | il budget del riflesso non aveva **mai** avuto effetto: la target restava al `.3` del costruttore |
| Budget del riflesso ancorato all'**altezza** del buffer | `config.js › reflectorHeight` | su 3440×1440: 512×214 → **2580×1080** in ultra; risultato indipendente dall'aspect ratio |
| Throttle disattivato sui frame lenti; deriva max .35 m / .05 rad | `reflection-throttle.js › shouldUpdate` | zero frame lenti con reflection non allineata, su traiettoria di salto con hitch iniettati |
| Set di luci fissato al boot | `explosion-system.js › lightSlots` | cambio di tier **2200 ms → 36 ms**; pipeline costanti a 214 invece di 213→252→213 |
| Varianti del fumo precompilate al boot | `smoke-volume.js › variants` | ~35 pipeline in meno nel frame del cambio tier |
| Budget di copertura schermo del fumo | `smoke-volume.js › _applyCoverageBudget` | strati a schermo pieno: ultra **16 → 2**, autoHigh 10 → 2, autoLow 4 → 1 |
| Geometria skyline fusa per materiale | `facade-system.js › mergeSkyline` | mesh 333 → **13**; draw call di picco **1049 → 713** |
| Atlas dei numeri + materiale condiviso | `facade-system.js › buildNumberDecals` | texture in scena 147 → **91**; VRAM decal ~75 MB → ~19 MB |
| Anisotropia per profilo (4/8/16) invece del massimo adapter | `main.js` (costante `aniso`) | profilo di default da 16× a 8× sulle superfici più grandi; guadagno di fill non misurato |
| Dirty-check delle barre vitali sul valore mostrato | `hud-controller.js › _renderVitalBar` | **1202 → 380** scritture DOM su 300 frame di rigenerazione |
| Guardia di rientranza fra PassNode | `render-pipeline.js › guardPassReentrancy` | elimina lo schermo nero da `renderList[i] undefined` (bug R1) |
| Gate del quad GTAO quando l'AO è spenta | `render-pipeline.js › gateAoPass` | su autoLow il quad a schermo intero passa da 1 render **per frame** a **1 in totale** |
| Contatori di rendering nel visual checker | `main.js › recordDiagnostics` | draw call, pipeline, texture, frame time, referto del frame lento |

## 4. Aperto — P0

### 4.1 Pipeline GPU (§3)

`render-pipeline.js` costruisce sempre: normal pre-pass con MRT, GTAO, scene pass, bloom a 5 mip, poi heat haze, shockwave, flare, grading, SMAA, grain, vignette. autoLow non rimuove nulla di strutturale.

Tre difetti concreti:

1. ~~**GTAO gira sempre.**~~ **FATTO** (7 agosto, sera). `aoPass.enabled` era inerte: il `GTAONode` vendorizzato non la consulta in `updateBefore`, quindi il quad a schermo intero veniva disegnato a ogni frame anche con `gtaoSamples: 0`. Ora `render-pipeline.js › gateAoPass` intercetta `updateBefore` e salta il render quando l'AO è spenta; `aoBlend` è una uniform, così la texture non aggiornata non entra nell'immagine e riaccendere l'AO non ricompila niente. Misurato nei test: su autoLow **1 render in totale** invece di 1 per frame (il primo serve a dimensionare e riempire la render target una volta). Restano da rimuovere la render target e il quad, che è lavoro strutturale: vedi sotto.
2. **`heatSlotLimit` è letto quando il grafo viene costruito**, e in quel momento vale 0: `addHeatHaze` aggiunge solo il primo slot. `setQuality` cambia il valore ma non ricostruisce il grafo, quindi **ultra ha 1 slot di heat haze invece di 4** e gli slot 2-4 ricevono valori che nessuno legge. È un difetto visivo, non solo di costo.
3. **Doppio anti-aliasing:** il renderer chiede `antialias: true` e la pipeline applica anche SMAA.

**Da fare.** Varianti strutturali della pipeline per profilo, compilate in anticipo (cambiarla a runtime rischia hitch di compilazione). Misurare MSAA contro SMAA e sceglierne una sola per autoLow.

**Criteri di accettazione.** autoLow deve evitare almeno una pass; GTAO disabilitato deve produrre zero quad render **e** nessuna render target allocata (il gate arriva a un solo render, non a zero: il resto richiede varianti del grafo); bloom disabilitato zero render target; nessun hitch oltre 100 ms.

### 4.2 Ombre (§5)

`renderer.shadowMap.autoUpdate` è sempre `true`: la shadow map della luna si rigenera a ogni frame con tutti i caster.

Il caso più sprecato: `main.js › part()` imposta `castShadow = true` per default, quindi **l'intero modello dell'arma in prima persona** (~30-40 mesh in ultra, attaccate alla camera) entra nella shadow map. Lo stesso vale per tracer, debris e VFX.

**Da fare.** Invertire il default in `part()`; togliere castShadow a tracer/debris/VFX; separare caster statici da dinamici e congelare i primi dopo il boot; stringere la camera d'ombra da ±32 all'arena.

**Già presenti, non rifarli:** `shadowSize` 512 su autoLow, e i caster della skyline limitati ai primi 22 edifici.

## 5. Aperto — P1

| Voce | Cosa c'è ora | Da fare |
|---|---|---|
| **§6 Smoke** | ogni puff è una mesh separata, `frustumCulled = false`, densità e noise riscritti su tutti i vertici a ogni frame | InstancedMesh con attributi per-istanza; bounding sphere conservativo e culling riattivato; su autoLow 4-6 passi (oggi 8) e self-shadow rimosso |
| **§7.1 Proiettili** | body Cannon dinamici *più* sweep manuali per ogni proiettile | integrazione manuale in un pool, un solo segment sweep per frame, rimozione dal solver |
| **§7.2 Query droni** | `registerProjectileThreat` percorre tutti i droni per ogni proiettile, poi `updateBullets` li ripercorre | spatial hash 2D con celle di 3-5 m; threat a 30 Hz |
| **§7.3 Draw call proiettili** | ogni proiettile ha mesh + glow sprite + tracer | mesh instanziata per tipo; buffer instanziato per i tracer |
| **§8.1 Separazione droni** | O(n²) in `drone-system.js › update` | spatial grid. **Priorità reale bassa**: con ≤9 droni sono 81 confronti |
| **§8.2 Materiali droni** | ogni drone crea 6 materiali (core, eye, halo, ring, 2 thruster): ~54 con 9 droni | palette condivisa per archetipo; colori come uniform o attributi per-istanza |
| **§8.3 Churn fra ondate** | `clear()` distrugge gruppi, marker e materiali a ogni ondata | pool persistente, reset di visibilità e vita |
| **§9 resto** | fasce, antenne e beacon sono geometria fusa ma non instanziata; nessun LOD | InstancedMesh per gli elementi ripetuti; LOD low-poly per edifici lontani; niente decal/fasce su autoLow; skyline lontana fuori dai caster d'ombra |
| **§16 Profilo all'avvio** | `autoTier` parte sempre da `autoHigh`; nessun controllo hardware; ULTRA senza watchdog e persistito senza rivalidazione; auto non raggiunge mai ultra | seed da `adapter.info` (già letto da `visual-check.mjs`) oppure primo avvio in autoLow; watchdog anche in ULTRA |

## 6. Aperto — P2

| Voce | Cosa c'è ora | Da fare |
|---|---|---|
| **§10.1 Texture** | asfalto e muri generati a 1024², mappe clonate per lato | 512² sui profili non ultra; mappe condivise con UV scaling |
| **§10.2 Cache facciate** | le mappe base 1024 restano in cache anche in ultra | rilasciarle dopo un periodo senza cambio qualità |
| **§10.3 Cleanup** | `createEnvironment` non dispone geometrie e materiali dei pannelli dopo i due PMREM; `textures.js › getCachedTexture` è definito e mai usato | cleanup dopo i PMREM; usare o rimuovere l'helper |
| **§11 Audio** | `audio-engine.js › playShoot` crea 7 nodi per colpo; la minigun spara 25 colpi/s | voce loopata per il corpo della minigun, pool di nodi, tetto di voci per categoria |
| **§12 Pausa** | in pausa restano attivi render, atmosfera, meteo, vapore, flicker, animazioni e audio | render a 15-30 FPS; saltare i sistemi decorativi. Marker (20 Hz) e radar (10 Hz) sono **già** esclusi |
| **§13.1 Precompile** | il boot compila tutti i materiali della scena | compilare scena base e arma corrente; il resto allo sblocco |
| **§13.2 Armi** | i LOD di tutte e cinque le armi restano in memoria | costruzione lazy; niente castShadow sui viewmodel |
| **§13.3 Bundle** | Three e Cannon caricati interi, senza tree-shaking | build step esmodularizzato, mantenendo la modalità offline |
| **Pozzanghere** | `water-system.js` costruisce una mesh con le sole celle bagnate più una fascia di sfumatura (celle da 28 cm): ~14k triangoli su autoHigh, ~23k in ultra. Le onde muovono i vertici sulla CPU, con la normale dalla derivata analitica e un **indice spaziale a bucket** da 2 m | +1 draw call. CPU in ultra con **14 onde** simultanee: **0,90 ms/frame** (era 1,65 scorrendo tutti i vertici), **0,0005 ms** ad acqua ferma. L'indice è verificato contro il calcolo diretto: scarto 2,6·10⁻⁸. Il displacement nel vertex shader costerebbe meno, ma qui nessuno potrebbe dimostrare che avvenga — i pixel non sono leggibili |
| **§14 Culling** | `frustumCulled = false` su smoke, tracer del giocatore e ostili, pioggia, traffico, pool particellare e debris | bounding volume conservativo o culling a livello di batch |
| **Trio visivo rinviato** | muri con `side: DoubleSide` su box chiusi (overdraw doppio, anche nella shadow map); clearcoat del pavimento attivo su autoLow; `backdrop-filter: blur()` su tre pannelli HUD sopra un canvas che cambia ogni frame | tre modifiche da un'ora in tutto, ma cambiano l'aspetto: serve l'approvazione visiva |

## 7. Metodo di misura

```bash
npm test && npm run lint:tsl && npm run smoke      # gate obbligatori
VISUAL_GPU=hardware VISUAL_PERF=1 VISUAL_SECONDS=60 npm run visual:check -- combat autoHigh
```

Il visual checker stampa median FPS, 1% low, max long task **e** i contatori di rendering (draw call medi/min/picco, cadenza della reflection, dimensione della sua target).

**Cosa è affidabile con l'adapter software (SwiftShader) usato in sviluppo:**

- ✅ **Conteggi** — draw call, pipeline, texture, triangoli, render object. Indipendenti dall'adapter.
- ❌ **Tempi** — `maxFrameMs` è dominato dal fill rate software: a bassa quota un singolo frame supera i 6 secondi e maschera qualunque stallo. Non trarne conclusioni.
- ❌ **Pixel** — le catture escono bianche. Il visual checker le marca "non autorevoli" e non asserisce.
- ❌ **Timeout della GPU** — non riproducibili: non c'è driver da resettare.

**`VISUAL_GPU=hardware` non serve a niente sotto WSL2** (provato il 7 agosto). Toglie i flag SwiftShader, ma l'adapter resta `google swiftshader`: dietro non c'è una GPU. In più Chromium prova un'istanza Vulkan e la perde → centinaia di `OperationError: Instance dropped`, un `createBuffer failed, size (2160) is too large` (2160 byte non sono grandi per nessuno: è la risposta di un device morto) e cattura nera. **È la firma di un device perso, non un difetto del gioco.** Effetto collaterale utile: sotto quella perdita il post-processing ha loggato **una volta sola** su ~190 frame falliti, senza latch nel fallback scuro. Il recupero di R1 regge anche fuori dai test.

**La GPU vera si raggiunge dall'host, non da WSL.** `./startServer.sh` serve la pagina; il browser Windows la apre su `localhost:8080` e usa la sua GPU. La diagnostica necessaria è già in pagina, il visual checker headless non serve.

**Diagnostica in gioco.** Con `?visualTest=<idle|storm|combat>&quality=<autoLow|autoHigh|ultra>` sono attivi `window.__vibeDiagnostics` e gli hook `__vibeTeleport`, `__vibeExplode`, `__vibeStall`, `__vibeForceTier`, `__vibeOff`, `__vibeScene`. Valori fuori lista sono ignorati **in silenzio** e non attivano nulla. In gioco normale su `window` non esiste niente.

Tre dettagli che cambiano cosa si sta misurando: `visualTest` non genera gameplay (`combat` = un'esplosione ogni 2,4 s in un punto fisso, `storm` = un fulmine ogni 4 s, `idle` = niente); `?quality=` mette `graphicsManager` in modalità `diagnostic` e **blocca il cambio di tier**, che è ciò che serve per una misura stabile; **Esc mette in pausa** (B2/N5), quindi interrompe la finestra di misura.

Un frame oltre 200 ms stampa un **referto** in console con draw call, triangoli, pipeline e texture *nuove*, stato di reflection e post-processing. Distingue una compilazione da un upload da un problema di fill: è così che è stata trovata la causa dello schermo nero. `slowFrames` conta invece i frame oltre 40 ms, che non stampano nulla.

### Prima misura su GPU hardware (7 agosto 2026) — **parziale**

Browser Windows, finestre di 60 s, ultrawide 3440×1440, monitor a 100 Hz.

| Scenario | avg FPS | frame max | slow >40 ms | draw call avg/min/peak | reflection | pipeline nuove in gioco |
|---|---|---|---|---|---|---|
| `combat/ultra` · canvas 1,19:1 | 99,6 | 85 ms | 3 | 392 / 214 / 850 | 3157/5974 (52,9%) @1282×1080 | **3** |
| `combat/ultra` · canvas pieno | 98,2 | 88 ms | 3 | 417 / 218 / 838 | 3193/5890 (54,2%) @2580×1080 | **3** |

**Confermato** — sono conteggi, indipendenti dalla dimensione del canvas. `postProcessingFailures` **0** su ~11 800 frame: R1 chiuso, nessun frame saltato e quindi nessun nero. `staleReflectionFrames` **0**: l'invariante di Q2 tiene su hardware. Reflection al 52-54%, cioè un frame su due, come dichiara il throttle di ultra.

**Gli FPS medi però misurano il vsync, non il renderer.** 99,6 e 98,2 sono il cap dei 100 Hz: fra i due run l'area della reflection raddoppia e il frame rate non si muove. Con vsync disattivato: **~150-200 FPS** (misura grossolana), cioè **5-6,7 ms per frame** contro un budget di 10 — **33-50% di margine in ultra**.

Due conseguenze, valide per *questa* GPU e non generalizzabili:

- **Il throughput non è il collo di bottiglia qui.** §3 (pipeline) e §5 (ombre) servono ai profili bassi e alle macchine deboli, dove nessuno ha misurato.
- **Gli hitch sì.** A 5-6,7 ms per frame uno stallo da 88 ms sono ~9 frame persi: è l'unica cosa percepibile su questo hardware.

**Reperto aperto: `pipelineNuoveInGioco = 3`**, dove deve essere 0 — tre shader compilati in gioco invece che al warmup. Riproducibile: esattamente 3 in entrambi i run, con esattamente 3 frame oltre 40 ms. La corrispondenza 3↔3 suggerisce un frame lento per compilazione ma **non è dimostrata**. È la firma di Q1 in scala ridotta (lì: 39 pipeline, 2200 ms). Ipotesi da verificare, non da assumere: la cache delle pipeline è indicizzata anche sul formato colore del render context, quindi un materiale precompilato per la scene pass ne vuole una propria quando entra per la prima volta nella render target HalfFloat del reflector.

**Da fare, in ordine di valore.**

| Run | Come | Cosa decide |
|---|---|---|
| **B** | `?visualTest=idle&quality=ultra`, 60 s **solo camminando** | Se `pipelineNuoveInGioco` resta 0 sono i VFX e l'ipotesi HalfFloat regge; se sale, è sbagliata |
| **C** | Chrome con `--disable-gpu-vsync --disable-frame-rate-limit` | Il tetto vero, con la diagnostica: senza, ogni ottimizzazione futura risulterà "senza effetto" perché il numero è il monitor |
| **D** | `storm`, `autoHigh`, `autoLow` + gioco reale (wave 1, minigun, wave 9) | Completa la matrice. `autoLow` è il proxy delle macchine deboli, dove §3 e §5 contano davvero |

## 8. Lezioni apprese

Regole ricavate da errori realmente commessi. Valgono per chiunque continui il lavoro.

1. **Misurare, non dedurre.** Tre ipotesi plausibili sulla causa di un freeze — compilazione di pipeline, resize di render target, `needsUpdate` sui materiali — sono state tutte smentite dai contatori. La causa era un'altra.
2. **Un throttle deve ragionare in tempo, non in frame.** "Due frame" sono impercettibili a 60 FPS e vistosissimi durante un hitch da un secondo.
3. **Non cambiare il set di luci visibili a runtime.** In WebGPU il `lightsNode` aggrega le luci *visibili* nello shader: variarlo ricompila ogni materiale della scena.
4. **Non ricostruire materiali durante il gioco.** Precompilare le varianti al boot e scambiare riferimenti.
5. **Due `pass(scene, camera)` condividono la render list.** Se possono annidarsi serve una guardia di rientranza che restituisca `false` — è la convenzione di three, la usa anche `ReflectorBaseNode`.
6. **In WebGPU un frame senza disegno è nero**, non l'ultimo frame valido: la texture del canvas viene invalidata dopo il present.
7. **Quando si fonde geometria, usare il codice originale come oracolo.** Costruire davvero le mesh e leggerne le `matrixWorld` invece di ricalcolare le trasformazioni, poi confrontare col risultato precedente (per i decal: scarto massimo 1,8·10⁻⁶ su 224 vertici).
8. **Un'ottimizzazione che cambia il risultato non è un'ottimizzazione.** L'indice a bucket delle pozzanghere è stato accettato solo dopo averlo confrontato col calcolo diretto su tutti i vertici: scarto 2,6·10⁻⁸, cioè precisione float.
9. **Ancorare un parametro di qualità a una grandezza con significato visivo.** `reflectorSize` sul lato lungo faceva dipendere la qualità dall'aspect ratio; `reflectorHeight` no.
10. **Una metrica che non reagisce al carico non sta misurando il carico.** Raddoppiando i pixel della reflection gli FPS non si sono mossi: non era headroom, era il vsync a 100 Hz. Prima di accettare un numero come baseline, verificare che *possa* peggiorare. Il dato utile è arrivato solo disattivando il vsync — e ha ribaltato l'ordine delle priorità (§9).
11. **Un flag di libreria non consultato è peggio di un flag assente.** `aoPass.enabled` dava l'impressione che l'AO si spegnesse su autoLow: il `GTAONode` non lo legge. O lo si consulta noi, o si toglie.

## 9. Ordine consigliato

Riordinato dopo la prima misura su hardware: con 33-50% di margine in ultra, il lavoro sul *throughput* non è più il primo. Gli **hitch** lo sono — sono l'unica cosa percepibile su una macchina con margine.

1. **Run B di §7** — un run da 60 s, decide se le 3 pipeline compilate in gioco sono un difetto da inseguire o rumore di prima esecuzione.
2. **Le 3 pipeline in gioco**, se B le conferma: 88 ms sono ~9 frame persi a 100 Hz. Massimo rapporto valore/rischio del piano.
3. **Trio visivo** (§6, ultima riga) — un'ora, nessun rischio tecnico, serve solo l'approvazione visiva.
4. **§5 Ombre** — iniziare dal default di `part()`, che è puro spreco a prescindere dal margine.
5. **Run D di §7 su `autoLow`** — prima di toccare §3. È il proxy delle macchine deboli, le uniche dove il throughput può ancora essere il problema.
6. **§3 Pipeline** — il più grosso e il più rischioso, e ora anche il meno urgente su hardware come quello misurato. Con i numeri di autoLow in mano, non prima.
7. **§7 Proiettili** e **§9 instancing** — il resto, per impatto decrescente.

## 10. Rischi da controllare

| Area | Rischio | Mitigazione |
|---|---|---|
| pipeline low | perdita di leggibilità o contrasto | screenshot A/B in combattimento |
| shadow freeze | ombre dinamiche obsolete | layer dinamico separato |
| smoke instancing | variante FrontSide/BackSide errata | test con camera dentro e fuori dal puff |
| proiettili manuali | differenze con gravità e collisioni | test di sweep e collisione statica |
| pooling droni | stato residuo fra ondate | reset completo verificato da test |
| audio pooling | voci bloccate o click | voice stealing e test di raffica |
| profilo iniziale | classificazione GPU errata | `adapter.info` come suggerimento, mai come blocco |

## 11. Definition of done

Un intervento è completo quando: il miglioramento è misurato con una metrica affidabile (§7); i test restano verdi; non compaiono errori in console; i tre profili restano coerenti; il cambio di qualità non produce hitch percepibili; e la voce in §3 riporta il numero ottenuto.
