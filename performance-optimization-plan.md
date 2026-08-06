# VIBE FPS — Piano completo di ottimizzazione performance

> Revisione: 6 agosto 2026
> Scope: working tree corrente, rendering WebGPU/TSL, fisica Cannon.js, gameplay, audio WebAudio, HUD/DOM, texture, boot e memoria GPU.
> Stato: documento di analisi e pianificazione. Nessuna delle ottimizzazioni elencate qui è stata implementata da questo documento.

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

- npm test: 67 test passati;
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

- [src/main.js:275](src/main.js#L275)
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

- [src/main.js:615](src/main.js#L615)
- [src/main.js:617](src/main.js#L617)
- [src/main.js:2103](src/main.js#L2103)
- [vendor/three/build/three.webgpu.js:37254](vendor/three/build/three.webgpu.js#L37254)
- [vendor/three/build/three.webgpu.js:37386](vendor/three/build/three.webgpu.js#L37386)

generateMipmaps è attivo perché il materiale applica blur alla reflection. Questo aggiunge memoria e lavoro di filtraggio:

- [src/main.js:617](src/main.js#L617)
- [src/main.js:653](src/main.js#L653)

Anche autoLow mantiene il reflector, limitandosi a ridurre la risoluzione a 256:

- [src/config.js:20](src/config.js#L20)
- [src/config.js:24](src/config.js#L24)

### 4.2 Ottimizzazioni proposte

- disabilitare completamente la reflection in autoLow;
- aggiornare la reflection ogni 2–4 frame;
- aggiornare solo se la camera si è spostata oltre una soglia o ha ruotato abbastanza;
- usare una reflection statica quando il giocatore è fermo;
- limitare la risoluzione in pixel, non solo tramite una percentuale del drawing buffer;
- valutare mipmap solo in ultra;
- escludere dalla camera riflessa oggetti costosi o lontani.

### 4.3 Rischio

Aggiornare a frequenza ridotta può produrre un leggero ritardo nei riflessi di proiettili ed esplosioni. Il compromesso è accettabile nei profili bassi e durante menu/pausa.

## 5. P0/P1 — Ombre

### 5.1 Problema

La shadow map della luna è attiva a 1024² e autoUpdate è sempre true:

- [src/main.js:288](src/main.js#L288)
- [src/main.js:463](src/main.js#L463)
- [src/main.js:464](src/main.js#L464)
- [src/main.js:2117](src/main.js#L2117)

Molti oggetti statici e dinamici dichiarano castShadow. Anche le armi in prima persona sono costruite con castShadow true:

- [src/main.js:1312](src/main.js#L1312)
- [src/main.js:1317](src/main.js#L1317)

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

- [src/smoke-volume.js:131](src/smoke-volume.js#L131)
- [src/smoke-volume.js:157](src/smoke-volume.js#L157)
- [src/smoke-volume.js:179](src/smoke-volume.js#L179)

Ogni puff è una mesh separata e il frustum culling è disattivato:

- [src/smoke-volume.js:293](src/smoke-volume.js#L293)
- [src/smoke-volume.js:296](src/smoke-volume.js#L296)
- [src/smoke-volume.js:297](src/smoke-volume.js#L297)

Ogni frame densità e noise vengono copiati su tutti i vertici degli attributi dinamici:

- [src/smoke-volume.js:373](src/smoke-volume.js#L373)
- [src/smoke-volume.js:382](src/smoke-volume.js#L382)

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

### 6.3 Cambio qualità

setQuality ricostruisce i due materiali quando cambia il numero di passi:

- [src/smoke-volume.js:236](src/smoke-volume.js#L236)
- [src/smoke-volume.js:242](src/smoke-volume.js#L242)
- [src/smoke-volume.js:249](src/smoke-volume.js#L249)

Questo può compilare shader durante il gioco. Precompilare le varianti low/high o applicare il cambio durante una schermata di transizione.

## 7. P1 — Proiettili e fisica

### 7.1 Eliminare il body Cannon per i proiettili

I proiettili sono body dinamici con massa e shape:

- [src/main.js:3848](src/main.js#L3848)
- [src/main.js:3849](src/main.js#L3849)
- [src/main.js:3947](src/main.js#L3947)

Il codice esegue già sweep manuali contro droni/Apex e raycast Cannon contro statici/casse:

- [src/main.js:4260](src/main.js#L4260)
- [src/main.js:4266](src/main.js#L4266)
- [src/main.js:4277](src/main.js#L4277)
- [src/main.js:4288](src/main.js#L4288)

Proposta:

1. mantenere posizione, velocità e accelerazione in una struttura pool;
2. integrare manualmente posizione e gravità;
3. eseguire un unico segment sweep per frame;
4. risolvere prima target gameplay e poi collisioni statiche;
5. rimuovere il body dal mondo senza perdere il pool grafico.

La gravità va preservata: il mondo usa CONFIG.gravity:

- [src/main.js:570](src/main.js#L570)
- [src/main.js:571](src/main.js#L571)

### 7.2 Evitare i loop duplicati sui droni

Per ogni proiettile viene chiamato registerProjectileThreat, che percorre tutti i droni:

- [src/drone-system.js:531](src/drone-system.js#L531)
- [src/drone-system.js:537](src/drone-system.js#L537)

Subito dopo updateBullets percorre nuovamente tutti i droni:

- [src/main.js:4263](src/main.js#L4263)
- [src/main.js:4266](src/main.js#L4266)

Proposte:

- spatial hash 2D/3D con celle di 3–5 metri;
- query solo delle celle attraversate dal segmento;
- unificare threat detection e hit query quando possibile;
- aggiornare la minaccia a 30 Hz se non serve reazione per ogni frame;
- usare una lista di target vivi compatta.

### 7.3 Draw call dei proiettili

Il pool elimina il churn di allocazioni ma non il costo di rendering. Ogni proiettile può avere mesh, glow sprite e tracer:

- [src/main.js:3852](src/main.js#L3852)
- [src/main.js:3855](src/main.js#L3855)
- [src/main.js:3860](src/main.js#L3860)
- [src/main.js:3863](src/main.js#L3863)

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
- [src/main.js:628](src/main.js#L628)
- [src/main.js:635](src/main.js#L635)
- [src/main.js:636](src/main.js#L636)

Le pareti usano ulteriori mappe 1024 e cloni per ciascun lato:

- [src/main.js:699](src/main.js#L699)
- [src/main.js:704](src/main.js#L704)
- [src/main.js:715](src/main.js#L715)

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

- [src/main.js:489](src/main.js#L489)
- [src/main.js:506](src/main.js#L506)
- [src/main.js:527](src/main.js#L527)
- [src/main.js:547](src/main.js#L547)

Aggiungere cleanup dopo la generazione di entrambi i PMREM, verificando che le texture risultanti restino valide.

getCachedTexture è definito ma non usato:

- [src/textures.js:17](src/textures.js#L17)

Usarlo per texture realmente condivisibili oppure rimuoverlo per evitare una falsa aspettativa di caching.

## 11. P2 — Audio WebAudio

### 11.1 Fuoco automatico

playShoot crea una catena completa di nodi per ogni colpo:

- [src/audio-engine.js:615](src/audio-engine.js#L615)
- [src/audio-engine.js:623](src/audio-engine.js#L623)
- [src/audio-engine.js:627](src/audio-engine.js#L627)
- [src/audio-engine.js:646](src/audio-engine.js#L646)

La minigun ha fireRate 0.04, cioè 25 colpi al secondo:

- [src/config.js:187](src/config.js#L187)
- [src/config.js:192](src/config.js#L192)

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

- [src/main.js:4500](src/main.js#L4500)
- [src/main.js:4502](src/main.js#L4502)
- [src/main.js:4569](src/main.js#L4569)
- [src/main.js:4593](src/main.js#L4593)
- [src/main.js:4691](src/main.js#L4691)
- [src/main.js:4715](src/main.js#L4715)

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

- [src/main.js:3087](src/main.js#L3087)
- [src/main.js:3113](src/main.js#L3113)
- [src/main.js:3121](src/main.js#L3121)
- [src/main.js:3140](src/main.js#L3140)
- [src/main.js:3151](src/main.js#L3151)

Questo evita hitch durante il gameplay, ma aumenta il tempo di boot e compila anche contenuti che potrebbero non essere usati.

Proposte:

- compilare sempre la scena base e l’arma corrente;
- compilare gli effetti comuni;
- compilare armi e Apex solo quando sbloccati o in una schermata di transizione;
- mantenere warmup separati per profilo;
- misurare se la compilazione globale è davvero migliore del compile-on-demand.

### 13.2 Cache dei cinque modelli arma

applyWeaponDetail costruisce la variante corrente per tutte le cinque armi e conserva i LOD nascosti:

- [src/main.js:1777](src/main.js#L1777)
- [src/main.js:1813](src/main.js#L1813)
- [src/main.js:1838](src/main.js#L1838)

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

- smoke: [src/smoke-volume.js:297](src/smoke-volume.js#L297)
- hostile tracer: [src/main.js:3740](src/main.js#L3740)
- player tracer: [src/main.js:3863](src/main.js#L3863)
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

- [src/main.js:3026](src/main.js#L3026)
- [src/main.js:3030](src/main.js#L3030)

Ottimizzazioni residue:

- aggiornare marker solo per bersagli vicini o visibili;
- usare un canvas overlay quando il numero di marker cresce;
- evitare conversioni toFixed e stringhe se distanza/stato non cambiano;
- ridurre o disabilitare backdrop-filter e mix-blend-mode nei profili touch/low;
- nascondere completamente il layer target durante pausa/menu;
- mantenere le scritture del DOM fuori dal percorso per-frame quando non cambiano.

## 16. Ottimizzazioni già presenti da preservare

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

## 17. Piano di implementazione consigliato

### Fase 0 — Profilazione

1. Aggiungere performance marks per update gameplay, Cannon, proiettili, droni, effetti, audio, DOM e render.
2. Eseguire catture su GPU hardware.
3. Registrare baseline per idle, wave 1, minigun, esplosioni e wave 9.
4. Salvare draw call, GPU time, CPU time e texture memory.

### Fase 1 — GPU immediata

1. Pipeline low reale.
2. Reflection disattivata o aggiornata meno frequentemente.
3. Shadow update ridotto.
4. Test MSAA contro SMAA.
5. Disabilitazione viewmodel/VFX shadow.

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

## 18. Rischi da controllare

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

## 19. Definition of done

Un’ottimizzazione è considerata completata quando:

- il miglioramento è misurato su GPU hardware;
- CPU e GPU frame time sono confrontati con la baseline;
- non introduce errori console o risorse mancanti;
- i test automatici restano verdi;
- autoLow, autoHigh e ultra hanno comportamenti coerenti;
- il cambio qualità non crea hitch percepibili;
- le scene di combattimento intenso rispettano il budget FPS;
- il codice mantiene pooling, reset e cleanup verificabili.
