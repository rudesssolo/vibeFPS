# VIBE FPS — Piano completo di ottimizzazione performance

> Revisione: 6 agosto 2026
> Scope: working tree corrente, rendering WebGPU/TSL, fisica Cannon.js, gameplay, audio WebAudio, HUD/DOM, texture, boot e memoria GPU.
> Stato: documento di analisi e pianificazione. Le voci implementate sono marcate **[FATTO]** e documentate in una sottosezione "Stato" della rispettiva sezione; tutto il resto non è stato implementato. Già applicati: §4 (throttle della reflection, correzione di `resolutionScale`, regressione §4.5 corretta, causa dell'hitch risolta §4.6), §6.3 (varianti del fumo precompilate), §10.4 (anisotropia per profilo), §15.1 (dirty-check delle barre vitali), §18 Fase 0 (contatori di draw call nel visual checker).

## 1. Esito sintetico

Il collo di bottiglia principale è la GPU: il frame combina più render pass completi, una reflection della scena, post-processing costoso e smoke volumetrico raymarched. Il profilo autoLow riduce diversi parametri, ma non rimuove realmente alcuni passaggi strutturali.

Il secondo gruppo di problemi è CPU: i proiettili vengono integrati da Cannon.js e contemporaneamente sottoposti a sweep manuali; la separazione tra droni è O(n²); il fuoco automatico crea molti nodi WebAudio.

L’ordine con il miglior rapporto rischio/beneficio è:

1. misurare separatamente CPU, GPU, draw call e memoria;
2. creare una pipeline grafica realmente minimale per autoLow;
3. ridurre reflection, ombre e smoke;
4. rimuovere i proiettili dal solver fisico e introdurre broadphase gameplay;
5. ridurre draw call e materiali unici di droni, città e proiettili;
6. ottimizzare audio, pausa, boot e gestione della memoria.

## 2. Baseline e metodo di verifica

La baseline automatica corrente è:

- npm test: 96 test passati (67 alla stesura del documento, +13 scheduler della reflection, +4 barre vitali/anisotropia, +9 frame lenti e soglia di deriva, +3 varianti precompilate del fumo);
- npm run lint:tsl: OK;
- npm run smoke: boot WebGPU headless completato senza errori o risorse mancanti;
- git diff --check: nessun errore di whitespace.

La cattura visuale headless non è stata usata come benchmark numerico: il browser gira con SwiftShader/software e le prove hanno prodotto una cattura bianca o timeout durante la stabilizzazione dello screenshot. Per decisioni di performance occorre usare un adapter hardware reale:

    VISUAL_GPU=hardware VISUAL_PERF=1 VISUAL_SECONDS=60 npm run visual:check -- combat autoHigh

Il benchmark deve essere eseguito almeno in questi scenari:

| Scenario | Cosa misura |
|---|---|
| idle/menu | costo base di scena, reflection, post-processing e HUD |
| wave 1 | costo di una scena di combattimento normale |
| minigun con 30–40 proiettili | fisica, draw call, audio e particelle |
| esplosione multipla | smoke, bloom, luci, debris e overdraw |
| wave 9/gauntlet | Apex, minion, separazione e marker |
| ultra/autoHigh/autoLow | efficacia reale dei profili |

Metriche da registrare:

- CPU frame time e suddivisione per simulazione, audio, DOM e rendering;
- GPU frame time per pass;
- numero di draw call e pipeline/material binding;
- pixel renderizzati e risoluzione effettiva;
- memoria GPU e numero/dimensione delle texture;
- median FPS, 1% low e massimo long task;
- spike durante cambio qualità, cambio ondata e prima esplosione.

Il budget già documentato nel README è median 60 FPS, 1% low almeno 50 FPS e nessun long task oltre 100 ms.

## 3. P0 — Pipeline GPU e post-processing

### 3.1 Problema

Il controller costruisce sempre:

1. normal pre-pass con MRT;
2. GTAO;
3. seconda pass della scena;
4. bloom;
5. heat haze, shockwave, flare, grading, SMAA, grain e vignette.

Riferimenti:

- [src/render-pipeline.js:113](src/render-pipeline.js#L113)
- [src/render-pipeline.js:120](src/render-pipeline.js#L120)
- [src/render-pipeline.js:125](src/render-pipeline.js#L125)
- [src/render-pipeline.js:133](src/render-pipeline.js#L133)
- [src/render-pipeline.js:145](src/render-pipeline.js#L145)

autoLow imposta gtaoSamples a zero e assegna aoPass.enabled, ma il GTAONode vendorizzato non controlla quella proprietà prima di eseguire la quad render. Il pass e la sua render target restano quindi attivi:

- [src/render-pipeline.js:404](src/render-pipeline.js#L404)
- [vendor/three/examples/jsm/tsl/display/GTAONode.js:270](vendor/three/examples/jsm/tsl/display/GTAONode.js#L270)
- [vendor/three/examples/jsm/tsl/display/GTAONode.js:304](vendor/three/examples/jsm/tsl/display/GTAONode.js#L304)

Il bloom mantiene cinque mip e un high-pass, due blur per mip e composite:

- [vendor/three/examples/jsm/tsl/display/BloomNode.js:122](vendor/three/examples/jsm/tsl/display/BloomNode.js#L122)
- [vendor/three/examples/jsm/tsl/display/BloomNode.js:299](vendor/three/examples/jsm/tsl/display/BloomNode.js#L299)

### 3.2 Ottimizzazione proposta

Creare almeno due varianti strutturali della pipeline:

- autoLow: render diretto oppure una sola composizione; niente normal pre-pass, GTAO, bloom, SMAA e reflection;
- autoHigh: pipeline intermedia con reflection ridotta, GTAO a bassa risoluzione e bloom con meno mip;
- ultra: pipeline completa.

La selezione deve avvenire tramite pipeline già compilate o tramite due grafi compilati in anticipo. Cambiare continuamente la struttura durante il gameplay rischia hitch di compilazione; il cambio qualità deve essere raro e coperto da warmup.

### 3.3 Effetti che oggi non sono veri early-out

Molti effetti vengono moltiplicati per una uniform a zero, ma il compilatore non è obbligato a eliminare tutta la matematica:

- grain calcola sin, dot e fract anche quando l’intensità è minima;
- shockwave calcola distanza, smoothstep e sample anche quando la strength è zero;
- heat haze calcola almeno uno slot anche quando il profilo imposta zero slot;
- cinematic grade esegue più texture sample in ogni pixel.

Inoltre heatSlotLimit viene usato in condizioni JavaScript durante la costruzione del grafo, quando il valore iniziale è zero. Cambiarlo in setQuality non ricostruisce il grafo: i profili high/ultra non ottengono necessariamente i quattro slot previsti, mentre autoLow continua a includere il primo slot.

Riferimenti:

- [src/render-pipeline.js:97](src/render-pipeline.js#L97)
- [src/render-pipeline.js:160](src/render-pipeline.js#L160)
- [src/render-pipeline.js:201](src/render-pipeline.js#L201)
- [src/render-pipeline.js:240](src/render-pipeline.js#L240)
- [src/render-pipeline.js:404](src/render-pipeline.js#L404)

Soluzioni:

- non aggiungere il nodo quando l’effetto è disattivato nel profilo;
- oppure creare grafi per profilo;
- oppure usare un ramo TSL uniforme verificando il costo generato;
- non usare un valore uniforme a zero come sostituto di una vera rimozione del pass.

### 3.4 Anti-aliasing

Il renderer richiede antialiasing e la pipeline applica anche SMAA:

- [src/main.js:276](src/main.js#L276)
- [src/render-pipeline.js:145](src/render-pipeline.js#L145)

Misurare tre configurazioni:

1. MSAA del renderer senza SMAA;
2. SMAA senza antialiasing del renderer;
3. entrambi, solo se la qualità visiva giustifica il costo.

Per autoLow scegliere una sola tecnica.

### 3.5 Criteri di accettazione

- autoLow deve evitare almeno un render completo della scena rispetto ad autoHigh;
- GTAO disabilitato deve produrre zero quad render dedicati;
- bloom disabilitato deve produrre zero render target e zero pass bloom;
- nessun peggioramento visivo critico su weapon view, HUD e leggibilità dei nemici;
- nessun hitch superiore a 100 ms durante il normale combattimento.

## 4. P0 — Reflection del pavimento

### 4.1 Problema

Il reflector crea una camera virtuale e renderizza la scena completa nella render target ogni frame quando il pavimento è visibile:

- [src/main.js:647](src/main.js#L647)
- [src/main.js:656](src/main.js#L656)
- [src/main.js:706](src/main.js#L706)
- [vendor/three/build/three.webgpu.js:37254](vendor/three/build/three.webgpu.js#L37254)
- [vendor/three/build/three.webgpu.js:37386](vendor/three/build/three.webgpu.js#L37386)

generateMipmaps è attivo perché il materiale applica blur alla reflection. Questo aggiunge memoria e lavoro di filtraggio:

- [src/main.js:656](src/main.js#L656)
- [src/main.js:706](src/main.js#L706)

Anche autoLow mantiene il reflector, limitandosi a ridurre la risoluzione a 256:

- [src/config.js:31](src/config.js#L31)
- [src/config.js:35](src/config.js#L35)

### 4.2 Ottimizzazioni proposte

- ~~disabilitare completamente la reflection in autoLow~~ → scartata, vedi §4.4;
- **[FATTO]** aggiornare la reflection ogni 2–4 frame;
- ~~aggiornare solo se la camera si è spostata oltre una soglia o ha ruotato abbastanza~~ → adottata solo come trigger aggiuntivo, non come unico gate (§4.4);
- ~~usare una reflection statica quando il giocatore è fermo~~ → scartata, vedi §4.4;
- **[FATTO]** limitare la risoluzione in pixel, non solo tramite una percentuale del drawing buffer;
- valutare mipmap solo in ultra;
- escludere dalla camera riflessa oggetti costosi o lontani.

### 4.3 Rischio

Aggiornare a frequenza ridotta può produrre un leggero ritardo nei riflessi di proiettili ed esplosioni. Il compromesso è accettabile nei profili bassi e durante menu/pausa.

### 4.4 Stato: implementato (throttle + fix di resolutionScale)

Cosa è stato applicato:

- uno scheduler puro decide su quali frame il reflector può renderizzare — [src/reflection-throttle.js:47](src/reflection-throttle.js#L47);
- il gate per-frame commuta `updateBeforeType` tra `FRAME` e `NONE`: `NodeFrame.updateNode()` non ha un ramo per `NONE`, quindi `updateBefore` non viene eseguito e la render target conserva l'ultimo contenuto valido, senza toccare materiale o grafo (nessun rischio di ricompilazione) — [src/main.js:4900](src/main.js#L4900);
- l'intervallo è un parametro di profilo: 2 / 4 / 2 per autoHigh / autoLow / ultra — [src/config.js:11](src/config.js#L11);
- `reflectionScheduler.reset()` in resetLevel: dopo un teletrasporto il frame successivo rigenera la reflection — [src/main.js:4470](src/main.js#L4470).

Bug latente trovato durante l'intervento: `resolutionScale` esiste solo su `ReflectorBaseNode`, non sul `ReflectorNode` restituito da `reflector()`. La riga che lo assegnava creava una proprietà mai letta, quindi **`reflectorSize` non ha mai avuto effetto** e la render target è sempre rimasta al `.3` del costruttore su tutti e tre i profili. Corretto in [src/main.js:2153](src/main.js#L2153); a 1080p la target passa da 576×324 a 256×144 su autoLow (5× meno pixel), da 720×405 a 512×288 su autoHigh, e resta invariata su ultra.

Misure (adapter software, quindi indicative sui rapporti e non sui tempi):

| Profilo | Render della reflection | Draw call (min / picco) |
|---|---|---|
| autoLow | 1 ogni 3.94 frame | 511 / 689 |
| autoHigh | 1 ogni 2.00 frame | 523 / 699 |
| ultra | 1 ogni 2.00 frame | 640 / 812 |

Il divario min/picco isola il costo del pass: **≈175–200 draw call**, cioè il 22–25% del frame. Va riconfermato su GPU hardware.

Deviazioni deliberate dal §4.2:

- la reflection **non** è disattivata in autoLow: l'asfalto bagnato è la cifra visiva della scena e a blur mip .32 e strength .34 un aggiornamento a 15 Hz non è distinguibile. Se la verifica su hardware smentisse questa ipotesi, il ripiego è `reflectorInterval: 3`;
- niente reflection statica a camera ferma: congelare la target smetterebbe di mostrare esplosioni, tracer e droni nel pavimento. Lo scheduler mette quindi un tetto alla *staleness* invece di trattenere la target;
- la deriva della camera è misurata rispetto alla posa dell'ultimo render, non al frame precedente: un flick rapido accumula e forza da solo un refresh anticipato, e un teletrasporto non può mostrare la reflection di un altro punto dell'arena.

Restano aperti: mipmap solo in ultra ed esclusione degli oggetti lontani dalla camera riflessa.

### 4.5 Regressione corretta: staleness contata in frame

Segnalata dopo il primo test in gioco: saltando molto in alto verso la parete VIBE il rendering si bloccava per circa un secondo e, alla ripresa, il pavimento mostrava in sovraimpressione frammenti di un frame precedente (linee della griglia, grattacieli).

Causa: lo scheduler limitava la staleness in **frame**. "Due frame" sono 33 ms a 60 FPS e sono impercettibili, ma durante un hitch un singolo frame resta a schermo per un secondo — e per tutto quel secondo l'asfalto somma via `emissiveNode` una reflection catturata *prima* dell'hitch. L'hitch era preesistente; il throttle gli ha dato una firma visiva vistosa, da cui il "non era mai successo prima".

Correzioni:

- **soglia di deriva della posa stretta a .35 m e .05 rad** (~3°), da 2 m e .35 rad (~20°). È questa la garanzia vera: una reflection riusata deve provenire da una posa percettivamente identica, e allora è corretta anche se quel frame resta a schermo per un secondo. Le soglie larghe lasciavano passare esattamente il caso segnalato;
- un frame oltre `SLOW_FRAME_MS` (40 ms, cioè 25 FPS) disattiva il throttle — [src/reflection-throttle.js:34](src/reflection-throttle.js#L34). Da sola questa regola **non basta**: la decisione usa la durata del frame *precedente*, quindi il primo frame di un hitch le sfugge — ed è proprio quello che resta a schermo. Serve insieme alla soglia di deriva;
- il gate del throttle vive fuori dal `try` del frame loop, quindi un frame fallito resettava nulla: ora il `catch` rimette `reflectionAllowed` a true e azzera lo scheduler, così il render di fallback non compone una target obsoleta su una scena diversa;
- il throttle intercetta `updateBefore` invece di commutare `updateBeforeType`. Commutare il tipo di update lascia a three.js la decisione su quante volte invocarlo, e il contatore non coincideva con le decisioni dello scheduler; ora il gate è esplicito e conta le invocazioni reali.

**Invariante verificata.** Il sintomo si riduce a una proprietà controllabile: *nessun frame lento deve riusare una reflection presa da una posa oltre la soglia di deriva*. Il contatore `staleReflectionFrames` la misura in gioco ([src/main.js:4667](src/main.js#L4667)) e uno script percorre la traiettoria di un salto verso la parete VIBE — camera che sale, avanza e ruota — iniettando hitch da 1 s **dopo** la decisione sulla reflection, cioè nel caso peggiore in cui il frame precedente era veloce. L'hitch è iniettato, quindi il risultato non dipende dalla velocità della GPU:

    traiettoria: 15 pose · frame osservati=45 · frame lenti=6
    frame lenti con reflection non allineata: 0

Compromesso accettato: in movimento la deriva impone il refresh prima dell'intervallo (a 10 m/s la soglia di .35 m scatta ogni ~2 frame), quindi il risparmio in corsa si dimezza. Resta intero dove è sicuro: camera ferma, mira, menu e pausa — che è anche il contesto del §12.

**Confermato in gioco su GPU reale** (6 agosto 2026): freeze e artefatto non più riproducibili, performance complessive migliorate. Storia completa del difetto in `bugs-remediation-plan.md` §17.

### 4.6 Causa dell'hitch: il cambio di tier automatico

Lo stallo non è causato dal throttle. La catena, ricostruita con misure e non per ipotesi:

1. la correzione di `resolutionScale` (§4.4) ha reso effettivo `reflectorSize`. A 1080p con DPR 1 la reflection di autoHigh passa da 576×324 a 1024×576, cioè **3,2× più pixel**: dove il `.3` accidentale era più conservativo, ora il profilo costa di più;
2. salendo in quota la camera specchiata inquadra per la prima volta la città e il picco di draw call passa da **813 a 1073** (~260 in più);
3. gli FPS scendono sotto 50 e dopo ~3 s scatta il **downgrade automatico autoHigh→autoLow**, che prima non scattava;
4. il downgrade porta `dynamicLights` da 4 a 2 e `ExplosionSystem.setQuality` cambiava `light.visible`. In WebGPU il `lightsNode` aggrega le luci **visibili** dentro lo shader, quindi variare quel set **ricompila ogni materiale della scena**.

Misure sul cambio di tier (adapter software, 420×320; i conteggi di pipeline sono indipendenti dall'adapter):

| | pipeline | switch ↓ | switch ↑ |
|---|---|---|---|
| prima | 213 → **252** → 213 | **2200 ms** | 486 ms |
| dopo | **214 costante** | 36–40 ms | 33–38 ms |

Trentanove pipeline create e distrutte a ogni switch. È esattamente il pericolo già descritto nel commento di `precompileAllMaterials` ([src/main.js:3162](src/main.js#L3162)), che però riguardava solo il compile-time del boot.

Correzioni:

- **il set di luci visibili è fissato al boot** al massimo `dynamicLights` fra i profili e non cambia più; il budget per profilo resta effettivo perché `lightLimit` governa quante luci vengono davvero accese nel pool di allocazione — [src/explosion-system.js:243](src/explosion-system.js#L243);
- **le due varianti del fumo volumetrico sono precompilate al boot** e `setQuality` scambia riferimenti invece di ricostruire i materiali: il numero di passi del raymarch finisce nel corpo dello shader, quindi cambiarlo compilava altre ~35 pipeline nello stesso frame. Questo chiude anche il §6.3 — [src/smoke-volume.js:113](src/smoke-volume.js#L113).

Due ipotesi verificate e **scartate**, utili per non ripercorrerle: la compilazione delle pipeline del pass reflection (senza warmup se ne crea **1 sola** salendo in quota, non un burst) e il resize della render target della reflection o della shadow map (rendendo `reflectorSize` e `shadowSize` uguali fra i profili lo stallo non cambiava).

Resta applicato anche il warmup del pass reflection ([src/main.js:3227](src/main.js#L3227)): la render target `HalfFloatType` del reflector ha comunque pipeline proprie e precompilarle durante il caricamento costa ~2 s di boot su adapter software. Non è la causa dell'hitch, ma evita che quelle compilazioni cadano in gioco.

La riduzione strutturale dei 260 draw call resta il §9 (atlas dei decal, merge della skyline, esclusione della città lontana dalla camera riflessa); abbassare `reflectorSize` di autoHigh è la leva per non far scattare più il downgrade.

## 5. P0/P1 — Ombre

### 5.1 Problema

La shadow map della luna è attiva a 1024² e autoUpdate è sempre true:

- [src/main.js:289](src/main.js#L289)
- [src/main.js:495](src/main.js#L495)
- [src/main.js:496](src/main.js#L496)
- [src/main.js:2171](src/main.js#L2171)

Molti oggetti statici e dinamici dichiarano castShadow. Anche le armi in prima persona sono costruite con castShadow true:

- [src/main.js:706](src/main.js#L706)
- [src/main.js:706](src/main.js#L706)

### 5.2 Ottimizzazioni proposte

- generare una shadow map statica dopo il boot;
- impostare autoUpdate false e riattivare needsUpdate solo quando serve;
- separare caster statici e caster dinamici;
- aggiornare le ombre dinamiche a frequenza ridotta;
- disabilitare castShadow su armi viewmodel, tracer, debris, pickup e VFX;
- lasciare in shadow map solo droni grandi, casse e geometria vicina;
- usare 512² in autoLow e valutare una camera shadow più stretta.

Nota: se casse e droni devono proiettare ombre realmente dinamiche, non è corretto congelare tutta la shadow map. In quel caso usare una shadow map statica per ambiente più una soluzione dinamica più piccola o meno frequente.

## 6. P1 — Smoke volumetrico

### 6.1 Problema

Il fragment shader di ogni puff esegue un loop di raymarch e un loop interno di self-shadow:

- [src/smoke-volume.js:151](src/smoke-volume.js#L151)
- [src/smoke-volume.js:177](src/smoke-volume.js#L177)
- [src/smoke-volume.js:199](src/smoke-volume.js#L199)

Ogni puff è una mesh separata e il frustum culling è disattivato:

- [src/smoke-volume.js:307](src/smoke-volume.js#L307)
- [src/smoke-volume.js:310](src/smoke-volume.js#L310)
- [src/smoke-volume.js:312](src/smoke-volume.js#L312)

Ogni frame densità e noise vengono copiati su tutti i vertici degli attributi dinamici:

- [src/smoke-volume.js:387](src/smoke-volume.js#L387)
- [src/smoke-volume.js:396](src/smoke-volume.js#L396)

### 6.2 Ottimizzazioni proposte

Implementazione preferita:

- usare InstancedMesh o un geometry buffer instanziato;
- mantenere un solo draw per materiale FrontSide e uno per BackSide;
- spostare density, noiseTime, color, origin e seed su attributi per-istanza;
- aggiornare una sola instance buffer invece di molti attributi per vertice;
- usare un bounding sphere conservativo e riattivare il frustum culling;
- limitare i puff in base alla copertura schermo, non solo al conteggio;
- scartare puff piccoli e lontani prima di aggiornare attributi e shader.

Profilo autoLow:

- 4–6 passi raymarch;
- self-shadow disabilitato oppure un solo passo;
- fallback a sprite o billboard per esplosioni lontane;
- massimo una o due istanze visibili per esplosione;
- disabilitare il fumo se il GPU frame time supera la soglia.

### 6.3 Cambio qualità — **[FATTO]**

setQuality ricostruiva i due materiali quando cambiava il numero di passi, compilando shader durante il gioco. La previsione era corretta: misurato, contribuiva ~35 pipeline nello stesso frame del cambio di tier.

Risolto precompilando entrambe le varianti al boot; `setQuality` ora scambia riferimenti a materiali già pronti e non costruisce né distrugge nulla — [src/smoke-volume.js:113](src/smoke-volume.js#L113), [src/smoke-volume.js:256](src/smoke-volume.js#L256). Le quattro combinazioni (due lati × due qualità) restano nel render graph a scala 0 per il warmup.

Contesto completo e misure nel §4.6.

## 7. P1 — Proiettili e fisica

### 7.1 Eliminare il body Cannon per i proiettili

I proiettili sono body dinamici con massa e shape:

- [src/main.js:3935](src/main.js#L3935)
- [src/main.js:3936](src/main.js#L3936)
- [src/main.js:4034](src/main.js#L4034)

Il codice esegue già sweep manuali contro droni/Apex e raycast Cannon contro statici/casse:

- [src/main.js:4276](src/main.js#L4276)
- [src/main.js:4350](src/main.js#L4350)
- [src/main.js:4364](src/main.js#L4364)
- [src/main.js:4375](src/main.js#L4375)

Proposta:

1. mantenere posizione, velocità e accelerazione in una struttura pool;
2. integrare manualmente posizione e gravità;
3. eseguire un unico segment sweep per frame;
4. risolvere prima target gameplay e poi collisioni statiche;
5. rimuovere il body dal mondo senza perdere il pool grafico.

La gravità va preservata: il mondo usa CONFIG.gravity:

- [src/main.js:602](src/main.js#L602)
- [src/main.js:603](src/main.js#L603)

### 7.2 Evitare i loop duplicati sui droni

Per ogni proiettile viene chiamato registerProjectileThreat, che percorre tutti i droni:

- [src/drone-system.js:531](src/drone-system.js#L531)
- [src/drone-system.js:537](src/drone-system.js#L537)

Subito dopo updateBullets percorre nuovamente tutti i droni:

- [src/main.js:4347](src/main.js#L4347)
- [src/main.js:4350](src/main.js#L4350)

Proposte:

- spatial hash 2D/3D con celle di 3–5 metri;
- query solo delle celle attraversate dal segmento;
- unificare threat detection e hit query quando possibile;
- aggiornare la minaccia a 30 Hz se non serve reazione per ogni frame;
- usare una lista di target vivi compatta.

### 7.3 Draw call dei proiettili

Il pool elimina il churn di allocazioni ma non il costo di rendering. Ogni proiettile può avere mesh, glow sprite e tracer:

- [src/main.js:3939](src/main.js#L3939)
- [src/main.js:3942](src/main.js#L3942)
- [src/main.js:3947](src/main.js#L3947)
- [src/main.js:3950](src/main.js#L3950)

Proposte:

- una mesh instanziata per proiettili normali;
- una mesh instanziata per missili;
- un buffer instanziato per tracer con due estremi per istanza;
- un singolo materiale per colore/tipo;
- culling manuale dei tracer oppure bounding volume aggiornato.

## 8. P1 — Droni e Apex

### 8.1 Separazione O(n²)

La steering separation confronta ogni drone con tutti gli altri:

- [src/drone-system.js:596](src/drone-system.js#L596)
- [src/drone-system.js:598](src/drone-system.js#L598)

Proposte:

- spatial grid con vicini nelle otto celle adiacenti;
- aggiornare la separazione a 30 Hz e integrare il risultato;
- calcolare la repulsione solo per droni entro il raggio;
- mantenere array alive separati dall’array degli oggetti allocati.

### 8.2 Materiali e shadow

Ogni drone crea un MeshPhysicalMaterial per il core e materiali separati per eye, halo, ring e thruster:

- [src/drone-system.js:428](src/drone-system.js#L428)
- [src/drone-system.js:446](src/drone-system.js#L446)
- [src/drone-system.js:455](src/drone-system.js#L455)
- [src/drone-system.js:462](src/drone-system.js#L462)

Molte parti impostano castShadow e receiveShadow:

- [src/drone-system.js:471](src/drone-system.js#L471)

Proposte:

- palette di materiali condivisi per archetipo/colore;
- colori emissivi tramite uniform o attributi per-istanza;
- instancing di wing, ring, thruster ed eye;
- shadow solo sul core dei droni vicini;
- MeshStandardMaterial per parti lontane o poco visibili.

### 8.3 Churn tra ondate

clear rimuove i gruppi, elimina i marker e dispone i materiali:

- [src/drone-system.js:63](src/drone-system.js#L63)
- [src/drone-system.js:67](src/drone-system.js#L67)

Proposte:

- pool persistente di droni e marker;
- visibility/health reset invece di dispose e ricreazione;
- materiali condivisi non distrutti a ogni ondata;
- lista compatta degli oggetti attivi;
- riuso degli slot per minion e split.

## 9. P1 — Città, draw call e materiali

La skyline crea 56 edifici con lower/upper, fasce, tetti, antenne, beacon e decal separate:

- [src/facade-system.js:367](src/facade-system.js#L367)
- [src/facade-system.js:383](src/facade-system.js#L383)
- [src/facade-system.js:399](src/facade-system.js#L399)
- [src/facade-system.js:425](src/facade-system.js#L425)

Ottimizzazioni:

- combinare la geometria statica per materiale;
- usare InstancedMesh per fasce, antenne e beacon;
- creare un LOD low-poly per edifici lontani;
- usare un singolo atlas per tutti i numeri;
- usare un materiale decal condiviso;
- rimuovere decal e fasce in autoLow;
- usare MeshStandardMaterial per edifici lontani;
- escludere la skyline lontana da shadow caster.

Il costo di ogni decal è anche trasparente e quindi soggetto a overdraw:

- [src/facade-system.js:431](src/facade-system.js#L431)
- [src/facade-system.js:435](src/facade-system.js#L435)

## 10. P1/P2 — Texture e memoria GPU

### 10.1 Texture procedurali

L’asfalto viene generato a 1024² con un loop per pixel e poi convertito in normal/roughness/metalness:

- [src/textures.js:184](src/textures.js#L184)
- [src/textures.js:192](src/textures.js#L192)
- [src/main.js:681](src/main.js#L681)
- [src/main.js:688](src/main.js#L688)
- [src/main.js:706](src/main.js#L706)

Le pareti usano ulteriori mappe 1024 e cloni per ciascun lato:

- [src/main.js:706](src/main.js#L706)
- [src/main.js:706](src/main.js#L706)
- [src/main.js:706](src/main.js#L706)

Proposte:

- 512² per autoLow/autoHigh;
- 1024² solo per ultra o superfici realmente vicine;
- generare le mappe in worker o a chunk se la qualità cambia durante il gioco;
- usare mappe condivise con UV scaling invece di duplicare texture;
- usare rumore/procedural shader per dettagli secondari;
- rilasciare canvas, ImageData e array temporanei dopo il trasferimento GPU quando non servono più.

### 10.2 Facade map cache

Il passaggio a ultra crea mappe 2048, mentre le mappe base 1024 restano intenzionalmente in cache:

- [src/facade-system.js:319](src/facade-system.js#L319)
- [src/facade-system.js:322](src/facade-system.js#L322)

Questo accelera il ritorno ad auto ma aumenta il picco VRAM. Proposte:

- mantenere la cache base solo su dispositivi con memoria sufficiente;
- rilasciare la cache base dopo un periodo senza cambio qualità;
- eseguire un controllo di memoria/adapter tier;
- non costruire mappe ultra se il frame time è già oltre soglia.

### 10.3 Resource cleanup

createEnvironment costruisce un envScene temporaneo e genera due PMREM, ma non dispone esplicitamente geometrie e materiali dei pannelli dopo l’upload:

- [src/main.js:521](src/main.js#L521)
- [src/main.js:538](src/main.js#L538)
- [src/main.js:559](src/main.js#L559)
- [src/main.js:579](src/main.js#L579)

Aggiungere cleanup dopo la generazione di entrambi i PMREM, verificando che le texture risultanti restino valide.

getCachedTexture è definito ma non usato:

- [src/textures.js:17](src/textures.js#L17)

Usarlo per texture realmente condivisibili oppure rimuoverlo per evitare una falsa aspettativa di caching.

### 10.4 Anisotropia — **[FATTO]**

Voce non presente nella stesura originale, emersa dalla revisione del codice.

Tutte le texture procedurali venivano create con il massimo dell'adapter (di norma 16×). È il campionamento più caro della scena: l'asfalto è un piano visto radente con `repeat ≈ 27` che campiona quattro mappe (map, normal, roughness, metalness), e i quattro muri ne clonano altre tre.

Ora il tetto arriva dal profilo — 4 / 8 / 16 per autoLow / autoHigh / ultra — ed è applicato con `Math.min` sul massimo dell'adapter:

- [src/config.js:17](src/config.js#L17)
- [src/main.js:370](src/main.js#L370)

Il valore è letto **una sola volta al boot**, dal profilo iniziale. Cambiarlo a runtime richiederebbe `needsUpdate` su ogni texture, cioè un re-upload completo, e i passaggi autoHigh↔autoLow avvengono in gioco senza schermata di transizione: sarebbe un hitch peggiore del guadagno. Di conseguenza il valore di autoLow oggi non viene mai usato — diventerà effettivo se verrà implementato il §16 (seed del profilo iniziale).

Effetto pratico: il profilo di default scende da 16× a 8×. Il guadagno è di fill-rate, quindi non compare nei contatori di draw call e va misurato su GPU hardware.

## 11. P2 — Audio WebAudio

### 11.1 Fuoco automatico

playShoot crea una catena completa di nodi per ogni colpo:

- [src/audio-engine.js:615](src/audio-engine.js#L615)
- [src/audio-engine.js:623](src/audio-engine.js#L623)
- [src/audio-engine.js:627](src/audio-engine.js#L627)
- [src/audio-engine.js:646](src/audio-engine.js#L646)

La minigun ha fireRate 0.04, cioè 25 colpi al secondo:

- [src/config.js:202](src/config.js#L202)
- [src/config.js:207](src/config.js#L207)

Proposte:

- una voce loopata per il corpo della minigun;
- pitch/gain modulati dalla velocità di fuoco;
- pool di oscillator, gain, filter e panner;
- massimo di voci simultanee per categoria;
- voice stealing per impatti ripetuti;
- AudioWorklet o buffer pre-renderizzati per eventi ad alta frequenza.

### 11.2 Parti già ottimizzate

L’aggiornamento dei drone hum è già limitato a circa 10 Hz e riusa vettori temporanei:

- [src/audio-engine.js:571](src/audio-engine.js#L571)
- [src/audio-engine.js:584](src/audio-engine.js#L584)
- [src/audio-engine.js:590](src/audio-engine.js#L590)

Questa strategia va mantenuta anche per gli altri suoni continui.

## 12. P2 — Pausa, menu e idle

La pausa sospende la simulazione, ma mantiene rendering, atmosfera, weather, vapore, animazioni e audio:

- [src/main.js:4679](src/main.js#L4679)
- [src/main.js:4681](src/main.js#L4681)
- [src/main.js:4748](src/main.js#L4748)
- [src/main.js:4772](src/main.js#L4772)
- [src/main.js:4870](src/main.js#L4870)
- [src/main.js:4906](src/main.js#L4906)

Proposte:

- render a 15–30 FPS durante pausa/menu;
- saltare weather, facade, traffic e animazioni decorative quando nessun elemento cambia;
- aggiornare reflection solo su variazione della camera;
- mantenere audio musica a frequenza ridotta;
- effettuare un render immediato quando si apre/chiude il menu;
- ripristinare 60 FPS alla ripresa del pointer lock.

Il throttling non deve essere applicato mentre la schermata è usata dal visual checker o durante una transizione grafica.

## 13. P2 — Boot, shader warmup e armi

### 13.1 Precompile globale

Il boot forza tutti i mesh visibili, disabilita temporaneamente il frustum culling e compila tutti i materiali:

- [src/main.js:3105](src/main.js#L3105)
- [src/main.js:3188](src/main.js#L3188)
- [src/main.js:3183](src/main.js#L3183)
- [src/main.js:3215](src/main.js#L3215)
- [src/main.js:3238](src/main.js#L3238)

Questo evita hitch durante il gameplay, ma aumenta il tempo di boot e compila anche contenuti che potrebbero non essere usati.

Proposte:

- compilare sempre la scena base e l’arma corrente;
- compilare gli effetti comuni;
- compilare armi e Apex solo quando sbloccati o in una schermata di transizione;
- mantenere warmup separati per profilo;
- misurare se la compilazione globale è davvero migliore del compile-on-demand.

### 13.2 Cache dei cinque modelli arma

applyWeaponDetail costruisce la variante corrente per tutte le cinque armi e conserva i LOD nascosti:

- [src/main.js:706](src/main.js#L706)
- [src/main.js:706](src/main.js#L706)
- [src/main.js:706](src/main.js#L706)

Gli oggetti nascosti non generano draw call, ma mantengono geometrie, materiali e pipeline in memoria.

Proposte:

- costruire lazy l’arma non ancora sbloccata;
- mantenere in cache solo l’arma corrente e l’ultima usata su dispositivi low;
- disporre il LOD precedente quando la memoria è scarsa;
- evitare castShadow per tutti i componenti della viewmodel;
- mantenere il doppio LOD solo su ultra.

### 13.3 Dipendenze vendorizzate

Il browser carica bundle completi di Three WebGPU/Core, TSL e Cannon senza tree-shaking:

- [index.html:396](index.html#L396)
- [index.html:399](index.html#L399)
- [index.html:407](index.html#L407)
- [index.html:409](index.html#L409)

Il costo è soprattutto startup, parse e compile JS, non frame time. In una fase successiva:

- introdurre un build step esmodularizzato;
- tree-shakare Three e addon non usati;
- comprimere gli asset statici;
- mantenere comunque la modalità offline vendorizzata.

## 14. P2 — Culling e renderable dinamici

Diversi oggetti disabilitano il frustum culling perché il bounding volume non viene aggiornato:

- smoke: [src/smoke-volume.js:312](src/smoke-volume.js#L312)
- hostile tracer: [src/main.js:3827](src/main.js#L3827)
- player tracer: [src/main.js:3950](src/main.js#L3950)
- rain: [src/weather-system.js:101](src/weather-system.js#L101)
- traffic: [src/atmosphere-system.js:120](src/atmosphere-system.js#L120)

Per ogni sistema:

- usare bounding sphere conservativo se il numero di oggetti è piccolo;
- usare un buffer instanziato con culling a livello di batch;
- dividere i batch per area dell’arena;
- cullare manualmente linee e particelle oltre la distanza utile;
- evitare di disabilitare il culling come soluzione permanente.

Rain, traffic e particle pool sono già batched o instanziati; il beneficio maggiore è atteso per tracer, smoke e proiettili.

## 15. P2 — HUD e DOM

Il controller HUD usa già dirty-check:

- [src/hud-controller.js:45](src/hud-controller.js#L45)
- [src/hud-controller.js:49](src/hud-controller.js#L49)

Anche i marker sono aggiornati a 20 Hz:

- [src/main.js:2191](src/main.js#L2191)
- [src/main.js:3101](src/main.js#L3101)

Il dirty-check però confrontava i valori grezzi in virgola mobile. Scudo e stamina si rigenerano di frazioni di punto per frame (~.2 e ~.32 a 60 FPS), quindi la guardia non filtrava nulla e riscriveva `style.width` e `textContent` a ogni frame per un risultato visivamente identico.

Ottimizzazioni residue:

- aggiornare marker solo per bersagli vicini o visibili;
- usare un canvas overlay quando il numero di marker cresce;
- evitare conversioni toFixed e stringhe se distanza/stato non cambiano;
- ridurre o disabilitare backdrop-filter e mix-blend-mode nei profili touch/low;
- nascondere completamente il layer target durante pausa/menu;
- **[FATTO]** mantenere le scritture del DOM fuori dal percorso per-frame quando non cambiano.

### 15.1 Stato: dirty-check sulle barre vitali

Il confronto avviene ora su ciò che finisce davvero nel DOM invece che sul float:

- il numero è l'intero mostrato (`Math.ceil`), quindi il confronto è esatto e non c'è alcuna differenza visiva;
- la larghezza della barra è quantizzata a `BAR_STEP_PERCENT = .5`, cioè ~1 px su una barra da 200 px;
- la stringa non viene nemmeno costruita quando il valore non cambia;
- lo stato vive in `this.last`, quindi `invalidateCache()` continua a forzare il ridisegno al cambio lingua.

Riferimenti: [src/hud-controller.js:9](src/hud-controller.js#L9), [src/hud-controller.js:178](src/hud-controller.js#L178).

Misura: 300 frame con scudo e stamina in rigenerazione simultanea passano da 1202 a 380 scritture DOM (**−68%**). L'unico compromesso è il passo di .5 punti percentuali sulla larghezza: portarlo a 0 conserverebbe solo il guadagno esatto sul testo.

## 16. P1 — Selezione del profilo all'avvio

### 16.1 Problema

Nessun controllo hardware precede la scelta del profilo: il gioco parte sempre da autoHigh e reagisce solo dopo aver misurato un frame rate basso.

Il tier iniziale è una costante:

- [src/graphics-manager.js:10](src/graphics-manager.js#L10)
- [src/graphics-manager.js:56](src/graphics-manager.js#L56)

Gli unici due ingressi della scelta sono la preferenza persistita e il flag allowUltra:

- [src/graphics-manager.js:9](src/graphics-manager.js#L9)
- [src/config.js:329](src/config.js#L329)
- [src/main.js:2167](src/main.js#L2167)

L'euristica di dispositivo decide soltanto se ULTRA viene offerto, e misura RAM, numero di core e densità di pixel — non la GPU, che è il collo di bottiglia descritto al §1:

- [src/main.js:346](src/main.js#L346)
- [src/main.js:350](src/main.js#L350)

L'adapter WebGPU è già disponibile dopo renderer.init() ma non viene mai interrogato: di navigator.gpu si verifica solo l'esistenza, e l'unica query di capability serve ad alzare l'anisotropia al massimo:

- [src/main.js:4964](src/main.js#L4964)
- [src/main.js:370](src/main.js#L370)

L'adattamento è reattivo e più lento di quanto sembri. Il campionamento parte solo a partita avviata e con elapsed > 5; servono 6 finestre da .5 s sotto 50 FPS per scendere (~3 s) e 20 finestre sopra 58 FPS per risalire (~10 s), con un cooldown di 30 campioni (~15 s):

- [src/main.js:4887](src/main.js#L4887)
- [src/graphics-manager.js:76](src/graphics-manager.js#L76)
- [src/graphics-manager.js:83](src/graphics-manager.js#L83)

Conseguenze:

1. una GPU debole gioca i primi secondi di partita in autoHigh, cioè proprio nel profilo che il §3 descrive come non realmente ridotto;
2. ULTRA non ha rete di sicurezza: updateFPS esce subito quando la modalità non è auto, la scelta è persistita e viene riapplicata a ogni boot senza nuova validazione, e allowUltra blocca solo i dispositivi touch (un desktop con GPU integrata datata può selezionarlo) — [src/graphics-manager.js:63](src/graphics-manager.js#L63), [src/main.js:706](src/main.js#L706);
3. l'auto-tier oscilla solo tra autoHigh e autoLow: una macchina potente in modalità auto non raggiunge mai ultra.

### 16.2 Ottimizzazioni proposte

- inizializzare autoTier da adapter.info (vendor/architecture) letto dopo renderer.init(): il visual checker esegue già esattamente questa query — [tools/visual-check.mjs:135](tools/visual-check.mjs#L135);
- in alternativa, senza classificare le GPU: primo avvio in autoLow, affidandosi al percorso di upgrade già esistente;
- accorciare la finestra di downgrade nei primi secondi di partita (es. 3 finestre invece di 6 finché elapsed < 30);
- watchdog anche in ULTRA: sotto soglia per N secondi, proporre il rientro in auto invece di restare bloccati;
- rivalidare la preferenza ULTRA persistita quando cambiano adapter o dispositivo;
- permettere ad auto di salire fino a ultra su hardware stabilmente oltre soglia.

### 16.3 Rischio

Classificare le GPU dalla stringa vendor è fragile: va usata come suggerimento iniziale, mai come blocco. Partire in autoLow penalizza la prima impressione sulle macchine potenti, quindi il tempo di salita va misurato prima di adottarlo come default.

## 17. Ottimizzazioni già presenti da preservare

- pool di proiettili player e hostile;
- pool di particelle additive;
- debris instanziato;
- weather con buffer unico e trigonometria ridotta;
- traffic instanziato;
- dirty-check HUD;
- marker a 20 Hz;
- drone hum aggiornato a circa 10 Hz;
- facade rebuild asincrono e chunked;
- profili di qualità con budget separati per smoke, rain, dynamic lights e resolution;
- point light delle esplosioni senza shadow cubiche;
- reset e riuso delle risorse grafiche principali;
- test automatici per qualità, smoke, pipeline e sistemi gameplay.

## 18. Piano di implementazione consigliato

### Fase 0 — Profilazione

1. Aggiungere performance marks per update gameplay, Cannon, proiettili, droni, effetti, audio, DOM e render.
2. Eseguire catture su GPU hardware.
3. Registrare baseline per idle, wave 1, minigun, esplosioni e wave 9.
4. **[PARZIALE]** Salvare draw call, GPU time, CPU time e texture memory. Draw call
   (media/min/picco), cadenza della reflection e dimensione della sua target sono
   ora stampati dal visual checker; GPU time per pass, ripartizione CPU e memoria
   texture restano da strumentare. I contatori vivono dietro `visualDebug`, quindi
   esistono solo con `?visualTest=...` — [src/main.js:4607](src/main.js#L4607),
   [tools/visual-check.mjs:119](tools/visual-check.mjs#L119).

### Fase 1 — GPU immediata

1. Pipeline low reale.
2. **[FATTO]** Reflection aggiornata meno frequentemente (§4.4). Non disattivata in autoLow: deviazione motivata nella stessa sezione.
3. Shadow update ridotto.
4. Test MSAA contro SMAA.
5. Disabilitazione viewmodel/VFX shadow.
6. Seed del profilo iniziale e watchdog ULTRA (§16): determina quale profilo
   viene realmente eseguito, quindi va deciso prima di interpretare le misure
   degli altri interventi.

### Fase 2 — Combat runtime

1. Proiettili fuori da Cannon.
2. Spatial grid per target e separation.
3. Tracer/proiettili instanziati.
4. Smoke con istanze e culling reale.
5. Prewarm delle varianti smoke senza compilazione durante il frame di gioco.

### Fase 3 — Scena e memoria

1. Palette materiali drone/Apex.
2. Pool persistente tra ondate.
3. Atlas decal città.
4. LOD/merge della skyline.
5. Texture 512 nei profili non ultra.
6. Cleanup envScene e politica di cache VRAM.

### Fase 4 — Audio, pause e startup

1. Voce continua per minigun.
2. Voice cap e pooling audio.
3. Render throttling in pausa/menu.
4. Warmup selettivo.
5. Lazy loading delle armi.
6. Valutazione di bundle/tree-shaking.

### Fase 5 — Verifica

1. Ripetere la matrice di benchmark.
2. Verificare che autoLow non cambi il gameplay.
3. Verificare wave 9 e mega boss.
4. Verificare cambio profilo e ritorno da ultra.
5. Eseguire npm test, npm run lint:tsl, npm run smoke e visual check hardware.
6. Controllare regressioni visive su reflection, smoke, HUD e ombre.

## 19. Rischi da controllare

| Area | Rischio | Mitigazione |
|---|---|---|
| pipeline low | perdita di leggibilità/contrasto | screenshot A/B e test combattimento |
| reflection throttling | riflesso in ritardo | soglia movimento camera |
| shadow freeze | ombre dinamiche obsolete | shadow layer dinamico ridotto |
| smoke instancing | variante FrontSide/BackSide errata | test camera dentro/fuori puff |
| proiettili manuali | differenze con gravità/collisioni | test sweep e collisioni statiche |
| pooling droni | stato residuo tra ondate | reset completo e test wave |
| atlas decal | UV o orientamento errato | screenshot skyline |
| audio pooling | voci bloccate o click | voice stealing e test burst |
| lazy warmup | hitch al primo uso | warmup sullo sblocco |
| profilo iniziale | classificazione GPU errata o prima impressione degradata | seed come suggerimento, A/B sul tempo di salita |

## 20. Definition of done

Un’ottimizzazione è considerata completata quando:

- il miglioramento è misurato su GPU hardware;
- CPU e GPU frame time sono confrontati con la baseline;
- non introduce errori console o risorse mancanti;
- i test automatici restano verdi;
- autoLow, autoHigh e ultra hanno comportamenti coerenti;
- il cambio qualità non crea hitch percepibili;
- le scene di combattimento intenso rispettano il budget FPS;
- il codice mantiene pooling, reset e cleanup verificabili.
