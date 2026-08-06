  import * as THREE from 'three/webgpu';
  import {
    color, dot, instancedBufferAttribute, max, mix, sin,
    positionGeometry, reflector, smoothstep, uniform, vec3
  } from 'three/tsl';
  import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
  import { RectAreaLightTexturesLib } from 'three/addons/lights/RectAreaLightTexturesLib.js';
  import { FacadeSystem } from './facade-system.js';
  import { DroneSystem } from './drone-system.js';
  import { ExplosionSystem } from './explosion-system.js';
  import { AudioEngine } from './audio-engine.js';
  import { HudController } from './hud-controller.js';
  import { GraphicsManager } from './graphics-manager.js';
  import { RenderPipelineController } from './render-pipeline.js';
  import { AtmosphereSystem } from './atmosphere-system.js';
  import { WeatherSystem } from './weather-system.js';
  import { makeRng } from './rng.js';
  import { constrainBodyToSquare } from './player-collision.js';
  import { getStoredSensitivity, storeSensitivity, getStoredQualityMode, APEX_TUNING, ENDGAME_TUNING, RAILGUN_TUNING, WEAPON_TUNING, QUALITY_PROFILES, getBossEncounter } from './config.js';
  import { t, getLanguage, setLanguage } from './i18n.js';

  // L1: applica subito la lingua persistita (default inglese) ai testi statici
  // marcati con data-i18n / data-i18n-html, prima ancora del boot grafico.
  function applyStaticStrings() {
    for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
    for (const el of document.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
  }
  document.documentElement.lang = getLanguage();
  applyStaticStrings();
  import {
    canvasToNormalTexture, makePbrMaps, makeMetalPanelTexture, makeWoodTexture,
    makeBrushedCanvas, makeAsphaltCanvas, makeHazardCanvas, makeKoreanSignCanvas,
    makeSmokeCanvas, makeGlowCanvas
  } from './textures.js';

  const visualParams = new URLSearchParams(window.location.search);
  const visualTestMode = ['idle', 'storm', 'combat'].includes(visualParams.get('visualTest'))
    ? visualParams.get('visualTest')
    : null;
  const visualQualityKey = ['autoLow', 'autoHigh', 'ultra'].includes(visualParams.get('quality'))
    ? visualParams.get('quality')
    : null;
  const visualDebug = visualTestMode !== null;
  const requestedVisualSeed = Number(visualParams.get('seed'));
  const visualSeed = Number.isFinite(requestedVisualSeed) && requestedVisualSeed > 0
    ? Math.floor(requestedVisualSeed)
    : 7301;

  const loadingUI = (() => {
    const overlay = document.getElementById('overlay');
    const label = document.getElementById('loading-label');
    const percent = document.getElementById('loading-percent');
    const detail = document.getElementById('loading-detail');
    const fill = document.getElementById('loading-fill');
    let ready = false;
    // Progresso "target" (impostato da update) e progresso "display" (animato):
    // la barra insegue il target con un'ease ed esegue un auto-creep quando il
    // carico è bloccante (es. shader warmup), così non sembra mai congelata.
    let target = 0;
    let display = 0;
    let rafId = null;
    let creeping = true; // auto-creep attivo subito: la barra "respira" anche in boot
    // Un timer lascia respirare il main thread anche quando il rendering sta
    // compilando risorse, senza dipendere dalla schedulazione di rAF.
    const nextFrame = () => new Promise(resolve => setTimeout(resolve, 0));

    const render = () => {
      fill.style.width = `${Math.round(display * 1000) / 10}%`;
      percent.textContent = `${Math.round(display * 100)}%`;
    };

    const tick = () => {
      let next = display;
      if (display < target) {
        // Ease verso il target: avanza in modo fluido e "respira".
        next = display + (target - display) * 0.18 + 0.006;
      } else if (creeping) {
        // Auto-creep: movimento lento e continuo, mai oltre il 98%, così la
        // barra resta viva anche mentre il warmup occupa il main thread.
        next = display + 0.006;
      }
      if (creeping && next > 0.98) next = Math.min(next, 0.98);
      if (next > display) display = next;
      render();
      const cap = creeping ? 0.98 : target;
      if (display < cap - 0.0005 || display < target - 0.0005) {
        rafId = requestAnimationFrame(tick);
      } else {
        rafId = null;
      }
    };

    const ensureTick = () => { if (rafId === null) rafId = requestAnimationFrame(tick); };

    const update = (progress, nextLabel, nextDetail) => {
      target = Math.max(0, Math.min(1, progress));
      if (nextLabel) label.textContent = nextLabel;
      if (nextDetail) detail.textContent = nextDetail;
      ensureTick();
    };
    const showModal = (nextLabel, nextDetail) => {
      overlay.classList.add('is-loading');
      overlay.style.display = 'flex';
      creeping = true;
      // Avvia il ciclo: parte da 0 e si muove subito verso il target.
      update(0, nextLabel, nextDetail);
    };
    const hideModal = ({ hideOverlay = false } = {}) => {
      overlay.classList.remove('is-loading');
      creeping = false;
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
      if (hideOverlay) overlay.style.display = 'none';
      else if (ready) overlay.style.display = 'flex';
    };
    const finishBoot = () => {
      ready = true;
      creeping = false;
      target = 1;
      display = 1;
      render();
      label.textContent = 'SYSTEM READY';
      detail.textContent = 'LINK GRAFICO OPERATIVO · CONFIGURAZIONE PRONTA';
      overlay.classList.remove('is-loading');
      overlay.classList.add('ready');
      overlay.style.display = 'flex';
    };
    // Avvia subito il ciclo di auto-creep: la barra "respira" fin dal primo
    // frame, anche prima del primo update, così non resta mai statica a 0%.
    ensureTick();
    return { nextFrame, update, showModal, hideModal, finishBoot };
  })();

  function showWebGPUUnavailable(message = t('gpu.default')) {
    const overlay = document.getElementById('overlay');
    const warning = document.getElementById('gpu-warning');
    const title = overlay?.querySelector('h1');
    const subtitle = overlay?.querySelector('.sub');
    const brief = overlay?.querySelector('.brief');
    const cta = overlay?.querySelector('.cta');
    const build = overlay?.querySelector('.build');
    if (!overlay) return;
    // C3: se il pointer lock è ancora attivo il cursore resta catturato e
    // l'overlay di recovery non è interagibile: rilascialo sempre.
    document.exitPointerLock?.();
    overlay.classList.remove('is-loading');
    overlay.classList.add('ready', 'gpu-unavailable');
    overlay.style.display = 'flex';
    if (title) title.textContent = t('gpu.title');
    if (subtitle) subtitle.textContent = t('gpu.sub');
    if (brief) brief.textContent = t('gpu.brief');
    if (build) build.textContent = 'BUILD 2.6.08 // WEBGPU OFFLINE';
    if (warning) {
      warning.hidden = false;
      warning.textContent = `${t('gpu.warning')} · ${message}`;
    }
    if (cta) {
      cta.textContent = t('gpu.cta');
      cta.setAttribute('aria-disabled', 'true');
      cta.tabIndex = -1;
    }
  }

  async function bootGame() {

  /* ============================================================
     1. CONFIG E COSTANTI DI GIOCO
     ============================================================ */
  const CONFIG = {
    arenaSize: 40,        // lato dell'arena (X/Z)
    floorMargin: 7,       // fascia di pavimento oltre i muri perimetrali
    wallHeight: 10.5,     // altezza dei muri: +50% rispetto all'arena originale (7m)
    wallThick: 1,

    playerRadius: 0.5,    // raggio del collider del giocatore
    eyeHeight: 1.6,       // altezza della camera rispetto al centro del corpo
    moveSpeed: 10,        // velocità di camminata (m/s)
    sprintSpeed: 14.5,   // scatto tattico
    jumpSpeed: 8.5,       // velocità verticale del salto

    padSize: 3,           // lato del jump pad
    padHeight: 0.4,       // spessore del jump pad
    padPos: { x: -8, z: -6 },
    padBoost: 11,         // spinta verticale del jump pad (m/s)

    bulletRadius: 0.12,
    bulletSpeed: 60,      // proiettili veloci (m/s)
    bulletMass: 0.6,
    bulletLifetime: 1.6,  // secondi prima che il proiettile si dissolva
    fireRate: 0.12,       // secondi tra un colpo e l'altro
    meleeDamage: 75,
    meleeRange: 2.25,
    meleeRadius: 0.72,
    meleeCooldown: 0.5,
    meleeDuration: 0.34,
    killHeal: 12,
    ammoDropAmount: 24,
    ammoDropLifetime: 35,
    magazineSize: 30,
    reserveAmmo: 180,
    reloadTime: 1.35,
    bulletDamage: 34,

    spawnPos: { x: 0, y: 2, z: 8 },
    gravity: -9.82,

    // Salute, scudo ed energia (M2: costanti condivise tra logica e HUD)
    maxHealth: 100,
    maxShield: 75,
    maxStamina: 100,
    maxLives: 3,             // vite totali a inizio run (i boss Apex droppano cuori)
    heartDropLifetime: 35,   // secondi prima che un cuore si dissolva
    shieldRegen: 9,          // punti scudo al secondo fuori combattimento
    shieldRegenDelay: 4.5,   // secondi senza subire danni prima della rigenerazione
    sprintDrain: 25,         // energia al secondo in scatto
    staminaRegenGround: 19,  // energia al secondo a terra
    staminaRegenAir: 9,      // energia al secondo in aria
    comboWindow: 3.2,        // secondi per mantenere il combo
    comboKillStep: 0.25,     // incremento combo per kill
    comboMax: 5,
    killScore: 100,          // punteggio base per kill
    impactScore: 12,         // punteggio per impatto
    waveBonusShield: 25,     // scudo bonus al completare un'ondata
    waveBonusAmmo: 60,       // munizioni bonus al completare un'ondata
    hostileDmgBase: 8,       // danno base colpo nemico
    hostileDmgWave: 1.1,     // danno extra per onda
    hostileHitRadiusSq: 0.52 // raggio di collisione giocatore ^2 (≈0.72m)
  };
  const floorSize = CONFIG.arenaSize + CONFIG.floorMargin * 2;

  // Parametri grafici (regolabili senza toccare la logica)
  const GRAPHICS = {
    toneMapping: 'ACES',          // 'ACES' | 'Neutral' (fotorealistico)
    exposure: 1.1,
    bloom: { strength: 0.55, radius: 0.5, threshold: 0.85 },  // soglia alta: bloom selettivo (solo emissivi/colpi)
    vignette: { offset: 0.8, darkness: 0.92 },
    gtao: {                       // ambient occlusion (contatto leggero)
      enabled: true,
      radius: 0.7,
      distanceExponent: 1.0,
      thickness: 0.12,
      distanceFallOff: 1.0,
      scale: 2.0,
      samples: 10,                // campioni limitati: costo GPU contenuto
      blendIntensity: 1.0
    },
    grain: { enabled: true, amount: 0.01 },
    rain: { enabled: true, count: 450, height: 18 },
    fogColor: 0x111116,
    fogDensity: 0.015,
    lights: {
      ambient:   { color: 0x1a2a5a, intensity: 0.4 },
      hemisphere: { sky: 0x1a2b6b, ground: 0x0c0818, intensity: 0.5 },
      moon:      { color: 0xa9c4ff, intensity: 0.75, pos: [-60, 90, -110] },
      rim:       { color: 0xff5a2d, intensity: 0.25, pos: [70, 30, 90] },
      neon: [
        { color: 0x00e5ff, intensity: 10, distance: 26, pos: [0, 4.5, -17] },
        { color: 0xff2d95, intensity: 8,  distance: 22, pos: [17, 4, 0] },
        { color: 0xff7b2d, intensity: 5,  distance: 18, pos: [-17, 3.5, 2] }
      ]
    },
    reflectiveFloor: true,
    // Il reflector viene sfocato tramite mipmap prima di essere miscelato con
    // l'asfalto: riflessi bagnati leggibili, ma mai da superficie a specchio.
    reflector: { strength: 0.34, blur: 0.32 }
  };

  // Gruppi di collisione (bitmask)
  const COLLISION = { STATIC: 1, CRATE: 2, PLAYER: 4, BULLET: 8 };


  /* ============================================================
     2. RENDERER, SCENA, CAMERA E POST-PROCESSING
     ============================================================ */
  // G2: forza la GPU dedicata su sistemi dual-GPU (laptop), se presente.
  const renderer = new THREE.WebGPURenderer({ antialias: true, powerPreference: 'high-performance' });
  // Three.js configures an alternate backend internally. Nulling the private
  // fallback hook is intentional here: this application is WebGPU-only and a
  // missing adapter must reach the menu warning instead of silently changing
  // rendering APIs.
  renderer._getFallback = null;
  loadingUI.update(.08, 'GPU BOOT', 'GPU is vibing... initializing the WebGPU device');
  let renderScale = Math.min(window.devicePixelRatio, 1.35);
  renderer.setPixelRatio(renderScale);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // Performance: limit pixelRatio cap and reduce shadow filtering cost via lighter shadow type when autoLow.
  renderer.shadowMap.autoUpdate = true;
  renderer.toneMapping = GRAPHICS.toneMapping === 'Neutral' ? THREE.NeutralToneMapping : THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = GRAPHICS.exposure;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const detachRendererCanvas = () => {
    if (renderer.domElement?.parentNode) renderer.domElement.remove();
  };

  const showRendererFailure = message => {
    const overlay = document.getElementById('overlay');
    if (!overlay) return;
    const build = document.querySelector('#overlay .build');
    const cta = document.querySelector('#overlay .cta');
    const title = document.querySelector('#overlay h1');
    const subtitle = document.querySelector('#overlay .sub');
    // C3: rilascia il pointer lock per rendere l'overlay di recovery interagibile.
    document.exitPointerLock?.();
    if (build) build.textContent = t('fail.build');
    if (cta) cta.textContent = message;
    if (title) title.textContent = t('fail.title');
    if (subtitle) subtitle.textContent = t('fail.sub');
    // Un errore GPU non deve lasciare un canvas congelato senza spiegazione:
    // mostra sempre il pannello di recovery anche se il gioco era già avviato.
    overlay.classList.remove('is-loading');
    overlay.classList.add('ready');
    overlay.style.display = 'flex';
  };
  renderer.onDeviceLost = () => {
    renderer.setAnimationLoop(null);
    detachRendererCanvas();
    showWebGPUUnavailable(t('gpu.lost'));
  };
  try {
    await renderer.init();
  } catch (error) {
    console.warn('VIBE WebGPU unavailable', error);
    detachRendererCanvas();
    showWebGPUUnavailable(t('gpu.noAdapter'));
    return;
  }
  loadingUI.update(.24, 'GPU ONLINE', 'Device and canvas allocated — the vibe is loud and clear');

  if (renderer.coordinateSystem !== THREE.WebGPUCoordinateSystem) {
    detachRendererCanvas();
    showWebGPUUnavailable(t('gpu.notWebgpu'));
    return;
  }
  renderer.domElement.id = 'game-canvas';
  document.body.appendChild(renderer.domElement);
  const rendererBackend = 'WEBGPU';
  document.querySelector('#overlay .build').textContent = `BUILD 2.6.08 // ${rendererBackend}`;

  // Anisotropia massima per texture nitide in prospettiva
  const aniso = renderer.getMaxAnisotropy();

  const scene = new THREE.Scene();
  const skyTime = uniform(0);
  scene.background = new THREE.Color(0x05060d);
  scene.fog = new THREE.FogExp2(GRAPHICS.fogColor, GRAPHICS.fogDensity);

  // Un near plane più corto evita che superfici vicine vengano tagliate quando
  // il giocatore si muove rasente ai muri perimetrali.
  const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 500);
  camera.rotation.order = 'YXZ';

  const renderPipeline = new RenderPipelineController({
    renderer,
    scene,
    camera,
    graphics: GRAPHICS,
    onPersistentFailure() {
      showRendererFailure(t('fail.degraded'));
    }
  });
  loadingUI.update(.32, 'PIPELINE', 'Preparing GTAO, bloom, SMAA and reflections...');

  /* ============================================================
     3. AMBIENTE NOTTURNO CYBERPUNK
     ============================================================ */
  // Cielo: cupola con gradiente notturno + bagliore all'orizzonte + alone lunare
  function createNightSky() {
    const moonDir = new THREE.Vector3(...GRAPHICS.lights.moon.pos).normalize();
    const direction = positionGeometry.normalize();
    const height = direction.y;
    let skyColor = mix(color(0x2a1245), color(0x0b1030), smoothstep(-.02, .18, height));
    skyColor = mix(skyColor, color(0x050614), smoothstep(.18, .6, height));
    const glowFactor = smoothstep(-.05, .04, height).mul(smoothstep(.04, .3, height).oneMinus());
    skyColor = mix(skyColor, color(0xff4a2a), glowFactor.mul(.55));
    skyColor = mix(skyColor, vec3(.012, .012, .02), smoothstep(0, -.15, height));
    const moonDot = max(dot(direction, uniform(moonDir)), 0);
    const moonHalo = moonDot.pow(20).mul(.55).add(moonDot.pow(120).mul(.45));
    skyColor = skyColor.add(vec3(.55, .7, 1).mul(moonHalo));
    const skyMaterial = new THREE.MeshBasicNodeMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false
    });
    skyMaterial.colorNode = skyColor;
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(390, 48, 24),
      skyMaterial
    );
    sky.frustumCulled = false;
    scene.add(sky);
  }

  // Stelle
  function createStars() {
    const count = 650;
    const pos = new Float32Array(count * 3);
    const rand = makeRng(1234);
    for (let i = 0; i < count; i++) {
      const y = 20 + rand() * 330;
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(380 * 380 - y * y);
      pos[i * 3]     = Math.cos(a) * r;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = Math.sin(a) * r;
    }
    const positionAttribute = new THREE.InstancedBufferAttribute(pos, 3);
    const starMaterial = new THREE.PointsNodeMaterial({
      positionNode: instancedBufferAttribute(positionAttribute),
      size: 1.4, sizeAttenuation: false,
      color: 0xbfd4ff, transparent: true,
      opacityNode: sin(skyTime.mul(1.37)).mul(.08).add(.88),
      depthWrite: false, fog: false, alphaToCoverage: true
    });
    // Punti instanziati: Sprite + PointsNodeMaterial + object.count è il pattern
    // ufficiale "Instanced Points" del renderer WebGPU di three.js r184
    // (vedi examples/webgpu_instance_points.html). object.count guida il numero
    // di istanze; positionNode/sizeNode/colorNode leggono gli attributi
    // instanziati, quindi non va rimossa la proprietà count.
    const stars = new THREE.Sprite(starMaterial);
    stars.count = count;
    stars.frustumCulled = false;
    scene.add(stars);
  }

  // Luna con alone
  function createMoon() {
    const moonPos = new THREE.Vector3(...GRAPHICS.lights.moon.pos).normalize().multiplyScalar(360);
    const moon = new THREE.Mesh(
      new THREE.CircleGeometry(13, 32),
      new THREE.MeshBasicMaterial({ color: 0xdce9ff, fog: false })
    );
    moon.position.copy(moonPos);
    moon.lookAt(0, 0, 0);
    scene.add(moon);

    const halo = new THREE.Mesh(
      new THREE.CircleGeometry(30, 32),
      new THREE.MeshBasicMaterial({
        color: 0x7fb0ff, transparent: true, opacity: 0.35,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false
      })
    );
    halo.position.copy(moonPos);
    halo.lookAt(0, 0, 0);
    scene.add(halo);
  }


  // Luci: ambiente, luna (ombra), rim calda, neon colorati
  let moonLight = null;
  function createLights() {
    scene.add(new THREE.AmbientLight(GRAPHICS.lights.ambient.color, GRAPHICS.lights.ambient.intensity));
    scene.add(new THREE.HemisphereLight(
      GRAPHICS.lights.hemisphere.sky,
      GRAPHICS.lights.hemisphere.ground,
      GRAPHICS.lights.hemisphere.intensity
    ));

    const moonDir = new THREE.Vector3(...GRAPHICS.lights.moon.pos).normalize();
    moonLight = new THREE.DirectionalLight(GRAPHICS.lights.moon.color, GRAPHICS.lights.moon.intensity);
    moonLight.position.copy(moonDir).multiplyScalar(50);
    moonLight.castShadow = true;
    moonLight.shadow.mapSize.set(1024, 1024);
    moonLight.shadow.camera.left = -32;
    moonLight.shadow.camera.right = 32;
    moonLight.shadow.camera.top = 32;
    moonLight.shadow.camera.bottom = -32;
    moonLight.shadow.camera.near = 1;
    moonLight.shadow.camera.far = 90;
    moonLight.shadow.bias = -0.0004;
    moonLight.shadow.radius = 6;
    moonLight.shadow.camera.updateProjectionMatrix();
    scene.add(moonLight);

    const rim = new THREE.DirectionalLight(GRAPHICS.lights.rim.color, GRAPHICS.lights.rim.intensity);
    rim.position.set(...GRAPHICS.lights.rim.pos);
    scene.add(rim);

    for (const nl of GRAPHICS.lights.neon) {
      const pl = new THREE.PointLight(nl.color, nl.intensity, nl.distance, 2);
      pl.position.set(...nl.pos);
      scene.add(pl);
    }
  }

  // Ambiente IBL (PMREM): riflessi colorati sui metalli
  let weaponEnvironment = null;
  function createEnvironment() {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene();
    envScene.background = new THREE.Color(0x0a0d1a);

    // Pannelli luminosi di varia dimensione e intensità (soft box colorate)
    const panels = [
      { color: 0x00e5ff, intensity: 6, w: 5,  h: 9,  pos: [0, 6, 14],  yaw: Math.PI },
      { color: 0xff2d95, intensity: 6, w: 5,  h: 9,  pos: [0, 6, -14], yaw: 0 },
      { color: 0xff7b2d, intensity: 4, w: 4,  h: 6,  pos: [14, 4, 0],  yaw: -Math.PI / 2 },
      { color: 0x7b2dff, intensity: 4, w: 4,  h: 6,  pos: [-14, 4, 0], yaw: Math.PI / 2 },
      { color: 0xa9c4ff, intensity: 2, w: 3,  h: 3,  pos: [6, 10, 8],  yaw: -0.8 },
      { color: 0xffffff, intensity: 3, w: 2,  h: 2,  pos: [-6, 10, -8], yaw: 0.8 },
      { color: 0xffd166, intensity: 2, w: 2,  h: 2,  pos: [8, 2, -10], yaw: 0.4 },
      { color: 0x00e5ff, intensity: 3, w: 2,  h: 6,  pos: [-10, 3, 8],  yaw: 2.2 },
      { color: 0xff2d95, intensity: 3, w: 2,  h: 6,  pos: [10, 3, 10],  yaw: -2.2 }
    ];
    for (const p of panels) {
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(p.w, p.h),
        new THREE.MeshBasicMaterial({ color: p.color })
      );
      mesh.material.color.multiplyScalar(Math.min(p.intensity, 4) * 0.25);
      mesh.position.set(...p.pos);
      mesh.rotation.y = p.yaw;
      envScene.add(mesh);
    }
    // Pavimento scuro nella scena env (per il ground reflect)
    const floorEnv = new THREE.Mesh(
      new THREE.PlaneGeometry(floorSize, floorSize),
      new THREE.MeshStandardMaterial({ color: 0x0d0f16, roughness: 0.4, metalness: 0.6 })
    );
    floorEnv.rotation.x = -Math.PI / 2;
    floorEnv.position.y = -0.5;
    envScene.add(floorEnv);

    // Preserve the arena's established IBL exactly. Weapon reflections use a
    // second PMREM below, so this pass cannot alter the arena's lighting.
    scene.environment = pmrem.fromScene(envScene, 0.04).texture;
    scene.environmentIntensity = 0.6;

    // Thin studio strips create elongated highlights on small gun surfaces.
    // They are added only after the arena PMREM has been baked.
    const weaponReflectionPanels = [
      { color: 0xeaf5ff, w: .7, h: 10, pos: [-4, 5, 7], yaw: 2.65 },
      { color: 0x65edff, w: .5, h: 8, pos: [5, 4, 5], yaw: -2.4 },
      { color: 0xff70bb, w: .6, h: 7, pos: [-6, 3.5, -4], yaw: .8 },
      { color: 0xffd19b, w: 5, h: .5, pos: [0, 9, -5], yaw: .1 }
    ];
    for (const panel of weaponReflectionPanels) {
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(panel.w, panel.h),
        new THREE.MeshBasicMaterial({ color: panel.color })
      );
      mesh.position.set(...panel.pos);
      mesh.rotation.y = panel.yaw;
      envScene.add(mesh);
    }
    weaponEnvironment = pmrem.fromScene(envScene, 0.025).texture;
    pmrem.dispose();
  }

  createNightSky();
  createStars();
  loadingUI.update(.46, 'ATMOSPHERE', 'Charging the sky, stars and rain...');
  createMoon();
  createLights();
  createEnvironment();
  const atmosphereSystem = new AtmosphereSystem({
    scene,
    timeNode: skyTime,
    seed: visualSeed,
    onThunder: () => audio.thunder()
  });
  const weatherSystem = new WeatherSystem({ scene, floorSize, height: GRAPHICS.rain.height, seed: visualSeed + 2616 });
  const facadeSystem = new FacadeSystem({ scene, anisotropy: aniso, resolution: 1024, buildingCount: 56 });
  loadingUI.update(.62, 'CITY GRID', 'Generating facades and the city grid...');

  /* ============================================================
     4. MONDO DI FISICA (Cannon.js)
     ============================================================ */
  const world = new CANNON.World();
  world.gravity.set(0, CONFIG.gravity, 0);
  world.broadphase = new CANNON.SAPBroadphase(world);
  world.allowSleep = true;
  world.defaultContactMaterial.friction = 0.2;
  world.solver.iterations = 8;
  world.solver.tolerance = 0.002;

  const matGround = new CANNON.Material('ground');
  const matPlayer = new CANNON.Material('player');
  const matBullet = new CANNON.Material('bullet');
  world.addContactMaterial(new CANNON.ContactMaterial(matGround, matPlayer, { friction: 0, restitution: 0 }));
  world.addContactMaterial(new CANNON.ContactMaterial(matGround, matBullet, { friction: 0.1, restitution: 0 }));

  // Elenco di { body, mesh } da sincronizzare ad ogni frame
  const synced = [];

  function addBody(body, mesh, syncMesh = true) {
    world.addBody(body);
    if (mesh) {
      scene.add(mesh);
      if (syncMesh) synced.push({ body, mesh });
    }
    return body;
  }

  function addStaticBox(x, y, z, sx, sy, sz, mesh) {
    const body = new CANNON.Body({ mass: 0, material: matGround });
    body.addShape(new CANNON.Box(new CANNON.Vec3(sx / 2, sy / 2, sz / 2)));
    body.position.set(x, y, z);
    body.collisionFilterGroup = COLLISION.STATIC;
    body.collisionFilterMask = -1;
    return addBody(body, mesh, false);
  }

  /* ============================================================
     5. ARENA: PAVIMENTO, MURI, OSTACOLI, NEON E JUMP PAD
     ============================================================ */
  // Le funzioni di texture procedurale (canvasToNormalTexture, makePbrMaps,
  // makeAsphaltCanvas, ...) sono estratte in src/textures.js (M5).

  // Pavimento: asfalto bagnato riflettente (ReflectorNode WebGPU/TSL)
  // Il pavimento continua oltre la faccia esterna dei muri: il bordo della
  // texture/reflector non deve mai finire nel frustum mentre si corre rasenti
  // al perimetro.
  let floorReflection = null;
  if (GRAPHICS.reflectiveFloor) {
    floorReflection = reflector({ resolutionScale: .3, generateMipmaps: true, bounces: false, samples: 0 });
  } else {
    const floorMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(floorSize, floorSize),
      new THREE.MeshStandardMaterial({ color: 0x0b0e15, roughness: 0.15, metalness: 0.3, envMapIntensity: 1.2 })
    );
    floorMesh.rotation.x = -Math.PI / 2;
    scene.add(floorMesh);
  }

  // Strato PBR sopra la riflessione: evita l'effetto specchio e restituisce asfalto bagnato credibile.
  const asphaltCanvas = makeAsphaltCanvas();   // 1024 di default (review demo)
  const asphaltMap = new THREE.CanvasTexture(asphaltCanvas);
  asphaltMap.colorSpace = THREE.SRGBColorSpace;
  asphaltMap.wrapS = asphaltMap.wrapT = THREE.RepeatWrapping;
  const asphaltRepeat = floorSize / CONFIG.arenaSize * 5;
  asphaltMap.repeat.set(asphaltRepeat, asphaltRepeat);
  asphaltMap.anisotropy = aniso;
  const asphaltNormal = canvasToNormalTexture(asphaltCanvas, 2.2, [asphaltRepeat, asphaltRepeat], aniso);
  const asphaltPbr = makePbrMaps(asphaltCanvas, [asphaltRepeat, asphaltRepeat], aniso, 1024);
  const asphaltMaterialOptions = {
    map: asphaltMap, normalMap: asphaltNormal,
    roughnessMap: asphaltPbr.roughnessMap, metalnessMap: asphaltPbr.metalnessMap,
    color: 0x8290a1,
    roughness: .54, metalness: .06, clearcoat: .42, clearcoatRoughness: .38,
    transparent: !floorReflection, opacity: floorReflection ? 1 : .72,
    depthWrite: Boolean(floorReflection), envMapIntensity: .8
  };
  const asphaltMaterial = floorReflection
    ? new THREE.MeshPhysicalNodeMaterial(asphaltMaterialOptions)
    : new THREE.MeshPhysicalMaterial(asphaltMaterialOptions);
  weatherSystem.registerWetMaterial(asphaltMaterial, { dryRoughness: .54, wetRoughness: .38 });
  // Il pavimento NON ha più un materiale "edge safe" senza riflesso: il piano
  // dello specchio è orizzontale, quindi la distanza dai muri non influenza la
  // stabilità del reflector. Lo swap serviva solo a fermarne l'aggiornamento e
  // il risultato era un riflesso che sparisce camminando lungo il perimetro.
  if (floorReflection) {
    // Il livello mip sfuma dettagli e contorni prima della somma HDR: neon,
    // proiettili ed esplosioni restano presenti come bagliori diffusi.
    asphaltMaterial.emissiveNode = floorReflection
      .blur(GRAPHICS.reflector.blur)
      .rgb.mul(GRAPHICS.reflector.strength);
  }
  const asphaltSkin = new THREE.Mesh(
    // Il pavimento invade leggermente lo spessore dei muri: in questo modo un
    // eventuale piccolo errore di integrazione non apre una fessura nera lungo
    // il perimetro.
    new THREE.PlaneGeometry(floorSize, floorSize),
    asphaltMaterial
  );
  asphaltSkin.rotation.x = -Math.PI / 2;
  asphaltSkin.position.y = .035;
  asphaltSkin.receiveShadow = true;
  if (floorReflection) asphaltSkin.add(floorReflection.target);
  scene.add(asphaltSkin);

  // Corpo fisico del pavimento (senza mesh: il visual è il riflettore)
  addStaticBox(0, -0.5, 0, floorSize, 1, floorSize, null);
  loadingUI.update(.72, 'ARENA', 'PBR materials, reflective floor and collisions...');

  // Griglia neon sul pavimento (geometria reale -> si riflette correttamente)
  (function createFloorGrid() {
    const n = 5;
    const spacing = CONFIG.arenaSize / (n + 1);
    const mat = new THREE.MeshStandardMaterial({ color: 0x0d0f14, emissive: 0x00e5ff, emissiveIntensity: 0.3, roughness: 0.5 });
    for (let i = 1; i <= n; i++) {
      const p = -CONFIG.arenaSize / 2 + i * spacing;
      const a = new THREE.Mesh(new THREE.BoxGeometry(CONFIG.arenaSize - 0.2, 0.02, 0.035), mat);
      a.position.set(0, 0.07, p);
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.02, CONFIG.arenaSize - 0.2), mat);
      b.position.set(p, 0.07, 0);
      scene.add(a, b);
    }
  })();

  // Muri perimetrali con pannelli metallici
  const wallConfigs = [
    { size: [CONFIG.arenaSize, CONFIG.wallHeight, CONFIG.wallThick], pos: [0, CONFIG.wallHeight / 2, -CONFIG.arenaSize / 2] },  // Nord
    { size: [CONFIG.arenaSize, CONFIG.wallHeight, CONFIG.wallThick], pos: [0, CONFIG.wallHeight / 2,  CONFIG.arenaSize / 2] },  // Sud
    { size: [CONFIG.wallThick, CONFIG.wallHeight, CONFIG.arenaSize], pos: [-CONFIG.arenaSize / 2, CONFIG.wallHeight / 2, 0] },  // Ovest
    { size: [CONFIG.wallThick, CONFIG.wallHeight, CONFIG.arenaSize], pos: [ CONFIG.arenaSize / 2, CONFIG.wallHeight / 2, 0] }   // Est
  ];
  const baseWallCanvas = makeMetalPanelTexture();   // 1024 di default (review)
  const baseWallPbr = makePbrMaps(baseWallCanvas, [1, 1], aniso);
  // La normal map a 1024 è condivisa tra i 4 muri: la conversione height→normal
  // (~1M pixel) gira UNA sola volta al boot; ogni muro clona la texture e
  // imposta solo il proprio repeat.
  const baseWallNormal = canvasToNormalTexture(baseWallCanvas, 1.1, [1, 1], aniso);
  for (const w of wallConfigs) {
    const rx = w.size[0] > w.size[2] ? 9 : 4;
    const tex = new THREE.CanvasTexture(baseWallCanvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(rx, 2);
    tex.anisotropy = aniso;
    const nrm = baseWallNormal.clone();
    nrm.repeat.set(rx, 2);
    nrm.needsUpdate = true;
    const roughnessMap = baseWallPbr.roughnessMap.clone();
    const metalnessMap = baseWallPbr.metalnessMap.clone();
    roughnessMap.repeat.set(rx, 2);
    metalnessMap.repeat.set(rx, 2);
    const mat = new THREE.MeshStandardMaterial({
      map: tex, normalMap: nrm,
      roughnessMap, metalnessMap,
      // Le pareti non possono dipendere solo dalla luce radente: sul bordo la
      // faccia interna può non ricevere il contributo diretto della luna e
      // diventare nera. Un metallo meno speculare e un'emissione blu minima
      // mantengono leggibili pannelli e giunti anche in quel caso limite.
      color: 0x8699ad,
      roughness: 0.62, metalness: 0.28, envMapIntensity: 1.05,
      emissive: 0x183149, emissiveIntensity: 0.72,
      side: THREE.DoubleSide
    });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...w.size), mat);
    mesh.position.set(...w.pos);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    addStaticBox(w.pos[0], w.pos[1], w.pos[2], w.size[0], w.size[1], w.size[2], mesh);
  }

  // Scatole-ostacolo (dinamiche: vengono spostate dai proiettili)
  const crateConfigs = [
    { size: 2,   pos: [  7, 1,     -5], kind: 'chrome' },
    { size: 2,   pos: [ -5, 1,      3], kind: 'metal' },
    { size: 3,   pos: [ 12, 1.5,    9], kind: 'metal' },
    { size: 2,   pos: [-12, 1,    -11], kind: 'wood' },
    { size: 1.5, pos: [  4, 0.75, -14], kind: 'metal' },
    { size: 1.5, pos: [  4, 2.25, -14], kind: 'metal' },   // pila di due scatole
    { size: 2.5, pos: [-15, 1.25,  8], kind: 'metal' },
    { size: 1.2, pos: [ 13, 0.6, -11], kind: 'metal' },
    { size: 1.2, pos: [ 13, 1.8, -11], kind: 'wood' }      // pila piccola
  ];
  // Casse-ostacolo: cromata, metallo spazzolato, legno scurito (bordi smussati)
  const woodCanvas = makeWoodTexture();
  const woodMap = new THREE.CanvasTexture(woodCanvas);
  woodMap.colorSpace = THREE.SRGBColorSpace;
  const woodNormal = canvasToNormalTexture(woodCanvas, 1.5, [1, 1], aniso);
  const brushedCanvas = makeBrushedCanvas();
  const brushedNormal = canvasToNormalTexture(brushedCanvas, 0.9, [1, 1], aniso);
  const woodPbr = makePbrMaps(woodCanvas, [1, 1], aniso);
  const brushedPbr = makePbrMaps(brushedCanvas, [1, 1], aniso);
  const crateMats = {
    chrome: new THREE.MeshStandardMaterial({ color: 0xcfd6e2, metalness: 1.0, roughness: 0.12, envMapIntensity: 1.6 }),
    metal:  new THREE.MeshStandardMaterial({ color: 0x262c38, metalness: 0.85, roughness: 0.32, envMapIntensity: 1.2, normalMap: brushedNormal, roughnessMap: brushedPbr.roughnessMap, metalnessMap: brushedPbr.metalnessMap }),
    wood:   new THREE.MeshStandardMaterial({ map: woodMap, normalMap: woodNormal, roughness: 0.82, metalness: 0.05, envMapIntensity: 0.4, roughnessMap: woodPbr.roughnessMap })
  };
  crateConfigs.forEach((cfg) => {
    const mesh = new THREE.Mesh(
      new RoundedBoxGeometry(cfg.size, cfg.size, cfg.size, 3, Math.min(0.08, cfg.size * 0.05)),
      crateMats[cfg.kind]
    );
    mesh.position.set(...cfg.pos);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    const body = new CANNON.Body({ mass: 15, material: matGround });
    body.addShape(new CANNON.Box(new CANNON.Vec3(cfg.size / 2, cfg.size / 2, cfg.size / 2)));
    body.position.set(...cfg.pos);
    body.vibeSpawn = { x: cfg.pos[0], y: cfg.pos[1], z: cfg.pos[2] };
    body.collisionFilterGroup = COLLISION.CRATE;
    body.collisionFilterMask = -1;
    body.linearDamping = 0.05;
    body.angularDamping = 0.1;
    addBody(body, mesh);
  });

  /* ---- Strutture extra: piattaforma, rampa, colonne, coperture, piedistallo ---- */
  function addStaticCylinder(x, y, z, radius, height, mesh) {
    const body = new CANNON.Body({ mass: 0, material: matGround });
    body.addShape(new CANNON.Cylinder(radius, radius, height, 16));
    body.position.set(x, y, z);
    body.collisionFilterGroup = COLLISION.STATIC;
    body.collisionFilterMask = -1;
    return addBody(body, mesh, false);
  }

  function addStaticBoxRotated(x, y, z, sx, sy, sz, axis, angle, mesh) {
    const body = new CANNON.Body({ mass: 0, material: matGround });
    body.addShape(new CANNON.Box(new CANNON.Vec3(sx / 2, sy / 2, sz / 2)));
    body.position.set(x, y, z);
    body.quaternion.setFromAxisAngle(new CANNON.Vec3(axis[0], axis[1], axis[2]), angle);
    body.collisionFilterGroup = COLLISION.STATIC;
    body.collisionFilterMask = -1;
    return addBody(body, mesh, false);
  }


  // Piattaforma rialzata (con bordo luminescente soft)
  const platformMesh = new THREE.Mesh(
    new THREE.BoxGeometry(6, 2, 6),
    new THREE.MeshStandardMaterial({ color: 0x2a303c, metalness: 0.7, roughness: 0.5, envMapIntensity: 0.9 })
  );
  platformMesh.position.set(7, 1, -10);
  platformMesh.castShadow = true;
  platformMesh.receiveShadow = true;
  scene.add(platformMesh);
  addStaticBox(7, 1, -10, 6, 2, 6, null);

  const platformEdgeMat = new THREE.MeshStandardMaterial({ color: 0x0d0f14, emissive: 0x00e5ff, emissiveIntensity: 0.35, roughness: 0.5 });
  for (const ex of [-1, 1]) {
    const e1 = new THREE.Mesh(new THREE.BoxGeometry(6.1, 0.06, 0.06), platformEdgeMat);
    e1.position.set(7, 2.06, -10 + ex * 2.98);
    scene.add(e1);
    const e2 = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 6.1), platformEdgeMat);
    e2.position.set(7 + ex * 2.98, 2.06, -10);
    scene.add(e2);
  }

  // Rampa (pendenza ~22°) che porta alla piattaforma, lato ovest
  const rampAngle = Math.atan2(2, 5);
  const rampLen = Math.sqrt(5 * 5 + 2 * 2);
  const hazardTex = new THREE.CanvasTexture(makeHazardCanvas());
  hazardTex.colorSpace = THREE.SRGBColorSpace;
  hazardTex.wrapS = hazardTex.wrapT = THREE.RepeatWrapping;
  hazardTex.repeat.set(3, 1);
  const rampMesh = new THREE.Mesh(
    new THREE.BoxGeometry(rampLen, 0.4, 5),
    new THREE.MeshStandardMaterial({ map: hazardTex, roughness: 0.8 })
  );
  rampMesh.position.set(1.5, 0.78, -10);
  rampMesh.rotation.z = rampAngle;
  rampMesh.castShadow = true;
  rampMesh.receiveShadow = true;
  scene.add(rampMesh);
  addStaticBoxRotated(1.5, 0.78, -10, rampLen, 0.4, 5, [0, 0, 1], rampAngle, null);

  // Colonne cilindriche
  const pillarMat = new THREE.MeshStandardMaterial({ color: 0x20242e, metalness: 0.75, roughness: 0.4, envMapIntensity: 1.0, normalMap: brushedNormal });
  for (const [px, pz] of [[-12, 4], [3, 9], [-6, 13]]) {
    const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 4, 24), pillarMat);
    pillar.position.set(px, 2, pz);
    pillar.castShadow = true;
    pillar.receiveShadow = true;
    scene.add(pillar);
    addStaticCylinder(px, 2, pz, 0.6, 4, null);
  }

  // Coperture basse (da saltare)
  const coverMat = new THREE.MeshStandardMaterial({ color: 0x262c38, metalness: 0.7, roughness: 0.5, envMapIntensity: 0.9 });
  for (const [cx, cz] of [[0, 4], [-9, 2]]) {
    const cover = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.9, 0.4), coverMat);
    cover.position.set(cx, 0.45, cz);
    cover.castShadow = true;
    cover.receiveShadow = true;
    scene.add(cover);
    addStaticBox(cx, 0.45, cz, 3.2, 0.9, 0.4, null);
  }

  // Piedistallo centrale con cristallo fluttuante
  const pedestal = new THREE.Mesh(
    new THREE.CylinderGeometry(1.5, 1.8, 0.6, 24),
    new THREE.MeshStandardMaterial({ color: 0x1c212b, metalness: 0.8, roughness: 0.35, envMapIntensity: 1.0 })
  );
  pedestal.position.set(0, 0.3, 0);
  pedestal.castShadow = true;
  pedestal.receiveShadow = true;
  scene.add(pedestal);
  addStaticCylinder(0, 0.3, 0, 1.8, 0.6, null);

  const crystalMat = new THREE.MeshStandardMaterial({ color: 0x0f2233, emissive: 0x00e5ff, emissiveIntensity: 2.0, roughness: 0.2, metalness: 0.1 });
  const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.5), crystalMat);
  crystal.position.set(0, 1.5, 0);
  crystal.castShadow = true;
  scene.add(crystal);

  // Jump Pad neon (base smussata)
  const padBaseMesh = new THREE.Mesh(
    new RoundedBoxGeometry(CONFIG.padSize, 0.3, CONFIG.padSize, 3, 0.05),
    new THREE.MeshStandardMaterial({ color: 0x141821, roughness: 0.5, metalness: 0.7, envMapIntensity: 0.8 })
  );
  padBaseMesh.position.set(CONFIG.padPos.x, 0.15, CONFIG.padPos.z);
  padBaseMesh.castShadow = true;
  padBaseMesh.receiveShadow = true;
  scene.add(padBaseMesh);

  const padGlowMat = new THREE.MeshStandardMaterial({ color: 0xff2d95, emissive: 0xff2d95, emissiveIntensity: 0.8, roughness: 0.4 });
  const padGlowMesh = new THREE.Mesh(
    new THREE.BoxGeometry(CONFIG.padSize - 0.1, 0.06, CONFIG.padSize - 0.1),
    padGlowMat
  );
  padGlowMesh.position.set(CONFIG.padPos.x, 0.33, CONFIG.padPos.z);
  scene.add(padGlowMesh);

  const padRing = new THREE.Mesh(
    new THREE.RingGeometry(CONFIG.padSize * 0.6, CONFIG.padSize * 0.66, 48),
    new THREE.MeshBasicMaterial({ color: 0xff2d95, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })
  );
  padRing.rotation.x = -Math.PI / 2;
  padRing.position.set(CONFIG.padPos.x, 0.38, CONFIG.padPos.z);
  scene.add(padRing);

  const padArrowMat = new THREE.MeshBasicMaterial({ color: 0xff7b2d });
  const padArrow = new THREE.Mesh(new THREE.ConeGeometry(0.55, 0.9, 4), padArrowMat);
  padArrow.position.set(CONFIG.padPos.x, 0.8, CONFIG.padPos.z);
  scene.add(padArrow);

  const arrowGlow = new THREE.Mesh(
    new THREE.ConeGeometry(1.15, 1.9, 4),
    new THREE.MeshBasicMaterial({ color: 0xff7b2d, transparent: true, opacity: 0.14, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  arrowGlow.position.set(CONFIG.padPos.x, 0.95, CONFIG.padPos.z);
  scene.add(arrowGlow);

  // Corpo fisico del jump pad (invariato)
  const padBody = addStaticBox(CONFIG.padPos.x, CONFIG.padHeight / 2, CONFIG.padPos.z, CONFIG.padSize, CONFIG.padHeight, CONFIG.padSize, null);

  // Strisce LED neon lungo i muri
  (function createNeonStrips() {
    const stripSpecs = [
      { color: 0x00e5ff, y: 0.1 },
      { color: 0xff2d95, y: 6.85 }
    ];
    for (const w of wallConfigs) {
      const isX = w.size[0] > w.size[2];
      const sign = isX ? Math.sign(w.pos[2]) : Math.sign(w.pos[0]);
      for (const s of stripSpecs) {
        const geo = isX
          ? new THREE.BoxGeometry(CONFIG.arenaSize - 0.3, 0.05, 0.05)
          : new THREE.BoxGeometry(0.05, 0.05, CONFIG.arenaSize - 0.3);
        const strip = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x0d0f14, emissive: s.color, emissiveIntensity: 1.5, roughness: 0.5 }));
        // `sign` punta verso l'esterno; il lato visibile dal giocatore è
        // quello opposto, quindi le strip devono stare sulla faccia interna.
        if (isX) strip.position.set(0, s.y, w.pos[2] - sign * 0.53);
        else strip.position.set(w.pos[0] - sign * 0.53, s.y, 0);
        scene.add(strip);
      }
    }
  })();

  // G3: insegne neon con flicker discreto (fase e velocità per insegna).
  const flickerSigns = [];
  const reactiveNeonLights = [];

  // Insegna neon "VIBE" sul muro ovest
  (function createSign() {
    const sw = 256, sh = 128;
    const c = document.createElement('canvas');
    c.width = sw; c.height = sh;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, sw, sh);
    ctx.font = 'bold 74px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = '#ff2d95';
    ctx.shadowBlur = 16;
    ctx.fillStyle = '#ff2d95';
    ctx.fillText('VIBE', sw / 2, sh / 2);
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#ffd6ee';
    ctx.fillText('VIBE', sw / 2, sh / 2);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(5, 2.5),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide })
    );
    sign.position.set(-19.35, 3.5, -4);
    sign.rotation.y = Math.PI / 2;
    scene.add(sign);
    flickerSigns.push({ material: sign.material, phase: 0, speed: 6.1 });

    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 2.9, 5.4),
      new THREE.MeshStandardMaterial({ color: 0x0a0d13, metalness: 0.8, roughness: 0.4 })
    );
    frame.position.set(-19.47, 3.5, -4);
    scene.add(frame);

    // Finto volumetric light shaft sotto l'insegna
    const shaft = new THREE.Mesh(
      new THREE.PlaneGeometry(2.4, 7),
      new THREE.MeshBasicMaterial({ color: 0xff2d95, transparent: true, opacity: 0.07, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })
    );
    shaft.position.set(-19.25, 2.0, -4);
    shaft.rotation.y = Math.PI / 2;
    shaft.rotation.z = 0.08;
    scene.add(shaft);
  })();

  // Luci ad area fisiche (soft box) per illuminazione fotorealistica
  THREE.RectAreaLightNode.setLTC(RectAreaLightTexturesLib.init());
  (function createAreaLights() {
    // Insegna VIBE -> soft box magenta
    const signLight = new THREE.RectAreaLight(0xff2d95, 2.0, 5.2, 2.6);
    signLight.position.set(-18.7, 3.5, -4);
    signLight.lookAt(0, 3.5, -4);
    scene.add(signLight);
    reactiveNeonLights.push({ light: signLight, base: 2, phase: 0 });

    // Jump pad -> soft box magenta dall'alto
    const padLight = new THREE.RectAreaLight(0xff2d95, 1.6, 6, 6);
    padLight.position.set(CONFIG.padPos.x, 3.2, CONFIG.padPos.z);
    padLight.lookAt(CONFIG.padPos.x, 0, CONFIG.padPos.z);
    scene.add(padLight);
    reactiveNeonLights.push({ light: padLight, base: 1.6, phase: 1.8 });

    // Striscia LED est -> soft box ciano
    const stripLight = new THREE.RectAreaLight(0x00e5ff, 1.0, 9, 0.5);
    stripLight.position.set(19.3, 0.45, 0);
    stripLight.lookAt(17, 0.45, 0);
    scene.add(stripLight);
    reactiveNeonLights.push({ light: stripLight, base: 1, phase: 3.4 });
  })();


  // Posiziona un'insegna neon su una parete (normale rivolta verso l'arena)
  function createNeonSign(text, colorHex, normal, pos, scale = 1) {
    const tex = new THREE.CanvasTexture(makeKoreanSignCanvas(text, colorHex));
    tex.colorSpace = THREE.SRGBColorSpace;
    const w = (1.15 + text.length * 0.62) * scale;
    const h = 0.9 * scale;
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide })
    );
    sign.position.set(pos[0], pos[1], pos[2]);
    sign.lookAt(pos[0] + normal[0], pos[1] + normal[1], pos[2] + normal[2]);
    scene.add(sign);
    flickerSigns.push({ material: sign.material, phase: Math.random() * Math.PI * 2, speed: 4.5 + Math.random() * 3.5 });

    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(w + 0.3, h + 0.3, 0.12),
      new THREE.MeshStandardMaterial({ color: 0x0a0d13, metalness: 0.8, roughness: 0.4 })
    );
    frame.position.set(pos[0] - normal[0] * 0.12, pos[1] - normal[1] * 0.12, pos[2] - normal[2] * 0.12);
    // Il telaio deve seguire l'orientamento dell'insegna: senza questa rotazione
    // il box resta sottile solo lungo Z, quindi sui muri est/ovest (normale ±X)
    // appariva PERPENDICOLARE alla parete invece che aderente (bug di review).
    frame.lookAt(pos[0] + normal[0], pos[1] + normal[1], pos[2] + normal[2]);
    scene.add(frame);
  }

  // Insegne coreane neon dentro l'arena
  function createArenaSigns() {
    createNeonSign('서울', '#00e5ff', [0, 0, 1], [-6, 2.6, -19.35]);
    createNeonSign('카페', '#ff2d95', [0, 0, 1], [7, 4.2, -19.35]);
    createNeonSign('호텔', '#ffd166', [0, 0, -1], [-4, 2.8, 19.35]);
    createNeonSign('노래방', '#ff2d95', [0, 0, -1], [8, 4.6, 19.35], 1.15);
    createNeonSign('포차', '#ff7b2d', [1, 0, 0], [-19.35, 2.4, 6]);
    createNeonSign('주차', '#ffffff', [1, 0, 0], [-19.35, 4.8, -12]);
    createNeonSign('커피', '#00e5ff', [-1, 0, 0], [19.35, 3.0, -5]);
    createNeonSign('치킨', '#ff2d95', [-1, 0, 0], [19.35, 5.2, 8]);
  }
  createArenaSigns();

  /* ---- Set dressing urbano: pozzanghere, tubature, fari, cavi e vapore ---- */
  const animatedSteam = [];
  (function createIndustrialSetDressing() {
    const rand = makeRng(8119);
    const puddleMat = new THREE.MeshPhysicalMaterial({
      color: 0x09131d, roughness: .08, metalness: .05, clearcoat: 1,
      clearcoatRoughness: .04, transparent: true, opacity: .62,
      envMapIntensity: 2, depthWrite: false
    });
    weatherSystem.registerWetMaterial(puddleMat, { dryRoughness: .18, wetRoughness: .045, animatedNormal: true });
    for (let i=0;i<17;i++) {
      const puddle = new THREE.Mesh(new THREE.CircleGeometry(.45+rand()*1.4,18),puddleMat);
      puddle.rotation.x=-Math.PI/2;
      puddle.scale.y=.35+rand()*.5;
      puddle.rotation.z=rand()*Math.PI;
      puddle.position.set(-17+rand()*34,.058,-17+rand()*34);
      scene.add(puddle);
    }

    // Griglie di scolo e piccoli marker stradali rompono le grandi superfici uniformi.
    const grateMat = new THREE.MeshStandardMaterial({color:0x090c11,metalness:.92,roughness:.3});
    for (const [gx,gz,rot] of [[-4,11,.2],[10,4,-.7],[-13,-3,.9],[14,-14,.1]]) {
      const grate=new THREE.Group();
      const rim=new THREE.Mesh(new THREE.BoxGeometry(1.45,.05,.7),grateMat); rim.position.y=.07; grate.add(rim);
      for(let i=-3;i<=3;i++){const slot=new THREE.Mesh(new THREE.BoxGeometry(.07,.025,.58),new THREE.MeshBasicMaterial({color:0x010205}));slot.position.set(i*.18,.105,0);grate.add(slot);}
      grate.position.set(gx,0,gz); grate.rotation.y=rot; scene.add(grate);
    }

    const pipeMat=new THREE.MeshStandardMaterial({color:0x313a43,metalness:.88,roughness:.28,normalMap:brushedNormal,envMapIntensity:1.1});
    const pipeDark=new THREE.MeshStandardMaterial({color:0x11151a,metalness:.75,roughness:.42});
    function pipe(x,y,z,len,axis,r=.13,mat=pipeMat){
      const m=new THREE.Mesh(new THREE.CylinderGeometry(r,r,len,12),mat);m.position.set(x,y,z);
      if(axis==='x')m.rotation.z=Math.PI/2;if(axis==='z')m.rotation.x=Math.PI/2;
      m.castShadow=true;m.receiveShadow=true;scene.add(m);return m;
    }
    // Le tubature restano oltre la faccia interna del muro: il loro volume
    // non può quindi entrare nella camera quando il giocatore percorre il
    // perimetro rasente alla parete.
    const wallDress = CONFIG.arenaSize / 2 - CONFIG.wallThick / 2 + .15;
    pipe(-wallDress,2.0,5,25,'z',.16); pipe(-wallDress,2.38,5,25,'z',.09,pipeDark);
    pipe(wallDress,1.7,-3,30,'z',.14); pipe(wallDress,3.2,-11,8,'y',.18);
    pipe(8,6.55,-wallDress,17,'x',.13); pipe(-10,6.25,wallDress,15,'x',.18,pipeDark);
    for(const [x,z] of [[-wallDress,-7],[wallDress,8],[-wallDress,14]]){
      for(let i=0;i<3;i++){const clamp=new THREE.Mesh(new THREE.TorusGeometry(.22,.035,8,16),pipeDark);clamp.position.set(x,2+i*.18,z);clamp.rotation.x=Math.PI/2;scene.add(clamp);}
    }

    // Cavi sospesi curvi, volutamente irregolari.
    const cableMat=new THREE.MeshStandardMaterial({color:0x050608,roughness:.8,metalness:.15});
    const cablePaths=[
      [[-19,5,-16],[-12,4.1,-17],[-5,5.6,-19]],
      [[19,5.8,15],[12,4.5,18],[4,5.4,19]],
      [[-18,6.1,19],[-7,4.8,18],[3,6.2,19]]
    ];
    for(const points of cablePaths){const curve=new THREE.CatmullRomCurve3(points.map(p=>new THREE.Vector3(...p)));const cable=new THREE.Mesh(new THREE.TubeGeometry(curve,28,.025,6,false),cableMat);scene.add(cable);}

    // Fari industriali con cono volumetrico simulato.
    const lampMat=new THREE.MeshStandardMaterial({color:0x1b222b,metalness:.85,roughness:.3});
    const beamMat=new THREE.MeshBasicMaterial({color:0x9fefff,transparent:true,opacity:.025,blending:THREE.AdditiveBlending,depthWrite:false,side:THREE.DoubleSide});
    for(const [lx,lz] of [[-14,-14],[14,13],[-14,13]]){
      const housing=new THREE.Mesh(new RoundedBoxGeometry(1.2,.16,.55,2,.05),lampMat);housing.position.set(lx,6.35,lz);housing.castShadow=true;scene.add(housing);
      const panel=new THREE.Mesh(new THREE.PlaneGeometry(.9,.3),new THREE.MeshBasicMaterial({color:0xbaf7ff}));panel.rotation.x=Math.PI/2;panel.position.set(lx,6.25,lz);scene.add(panel);
      const light=new THREE.PointLight(0xa8ecff,3.2,10,2);light.position.set(lx,6,lz);scene.add(light);
      const beam=new THREE.Mesh(new THREE.ConeGeometry(3.2,6.1,24,1,true),beamMat);beam.position.set(lx,3.25,lz);scene.add(beam);
    }

    // Texture di vapore: rumore di fumo (cumulo con grumi e buchi) invece del
    // puff radiale liscio, per un aspetto più organico e meno "cartoon".
    const smokeTex=new THREE.CanvasTexture(makeSmokeCanvas(128));
    smokeTex.colorSpace=THREE.SRGBColorSpace;
    for(const [vx,vz] of [[-4,11],[10,4],[-13,-3]]){
      for(let i=0;i<12;i++){
        const mat=new THREE.SpriteMaterial({map:smokeTex,color:0xc9ebf3,transparent:true,opacity:0,depthWrite:false,blending:THREE.NormalBlending});
        const sprite=new THREE.Sprite(mat);scene.add(sprite);
        animatedSteam.push({sprite,mat,base:new THREE.Vector3(vx,.12,vz),phase:i/12,speed:.12+rand()*.08,drift:(rand()-.5)*.7});
      }
    }

    // Barriere modulari e bollard luminosi: silhouette più credibili a livello strada.
    const barrierMat=new THREE.MeshStandardMaterial({color:0x252c35,metalness:.72,roughness:.46,envMapIntensity:1});
    for(const [bx,bz,rot] of [[-14,15,0],[15,-4,Math.PI/2],[-2,-16,0]]){
      const group=new THREE.Group();
      const beam=new THREE.Mesh(new RoundedBoxGeometry(3,.42,.35,2,.06),barrierMat);beam.position.y=.78;beam.castShadow=true;group.add(beam);
      for(const sx of [-1,1]){const foot=new THREE.Mesh(new THREE.BoxGeometry(.32,.8,.7),barrierMat);foot.position.set(sx*1.12,.4,0);foot.castShadow=true;group.add(foot);}
      const led=new THREE.Mesh(new THREE.BoxGeometry(2.5,.035,.37),new THREE.MeshBasicMaterial({color:0xffb347}));led.position.set(0,.82,.01);group.add(led);
      group.position.set(bx,0,bz);group.rotation.y=rot;scene.add(group);
      addStaticBoxRotated(bx,.5,bz,3,1,.7,[0,1,0],rot,null);
    }
  })();

  /* ============================================================
     6. GIOCATORE
     ============================================================ */
  const playerBody = new CANNON.Body({ mass: 80, material: matPlayer, allowSleep: false });
  playerBody.addShape(new CANNON.Sphere(CONFIG.playerRadius));
  playerBody.position.set(CONFIG.spawnPos.x, CONFIG.spawnPos.y, CONFIG.spawnPos.z);
  playerBody.fixedRotation = true;          // la sfera non deve rotolare
  playerBody.updateMassProperties();
  playerBody.collisionFilterGroup = COLLISION.PLAYER;
  playerBody.collisionFilterMask = COLLISION.STATIC | COLLISION.CRATE | COLLISION.PLAYER;
  world.addBody(playerBody);

  // Il solver può lasciare la sfera leggermente oltre due muri quando si
  // entra in diagonale nell'angolo. Il limite logico è quindi più interno
  // della faccia interna del muro e viene applicato anche alla telecamera.
  // Così né la sfera né il suo near plane possono attraversare il perimetro.
  const arenaHalf = CONFIG.arenaSize / 2;
  const arenaInnerFace = arenaHalf - CONFIG.wallThick / 2;
  const playerBoundaryMargin = CONFIG.playerRadius + .22;
  const playerArenaLimit = arenaInnerFace - playerBoundaryMargin;
  const cameraArenaLimit = arenaInnerFace - .12;

  function markBodyAabbDirty(body) {
    body.aabbNeedsUpdate = true;
    // cannon.js 0.6 does not expose updateAABB on every Body build; the
    // world will rebuild dirty broadphase bounds on its next step.
    body.updateAABB?.();
  }

  function constrainPlayerToArena() {
    const { corrected, positionCorrected } = constrainBodyToSquare(
      playerBody,
      playerArenaLimit,
      CONFIG.spawnPos
    );
    if (positionCorrected) {
      markBodyAabbDirty(playerBody);
    }
    return corrected;
  }

  function resetPlayerBody() {
    playerBody.position.set(CONFIG.spawnPos.x, CONFIG.spawnPos.y, CONFIG.spawnPos.z);
    playerBody.velocity.set(0, 0, 0);
    markBodyAabbDirty(playerBody);
    wasGrounded = false;
    wasOnPad = false;
    lastVerticalVelocity = 0;
  }

  function sanitizeDynamicBodies() {
    for (const { body } of synced) {
      if (body.mass <= 0) continue;
      const fallback = body.vibeSpawn || { x: 0, y: 1, z: 0 };
      const finite = Number.isFinite(body.position.x)
        && Number.isFinite(body.position.y)
        && Number.isFinite(body.position.z)
        && Number.isFinite(body.velocity.x)
        && Number.isFinite(body.velocity.y)
        && Number.isFinite(body.velocity.z)
        && Number.isFinite(body.quaternion.x)
        && Number.isFinite(body.quaternion.y)
        && Number.isFinite(body.quaternion.z)
        && Number.isFinite(body.quaternion.w)
        && Number.isFinite(body.angularVelocity.x)
        && Number.isFinite(body.angularVelocity.y)
        && Number.isFinite(body.angularVelocity.z)
        && Number.isFinite(body.force.x)
        && Number.isFinite(body.force.y)
        && Number.isFinite(body.force.z)
        && Number.isFinite(body.torque.x)
        && Number.isFinite(body.torque.y)
        && Number.isFinite(body.torque.z);
      if (!finite) {
        body.position.set(fallback.x, fallback.y, fallback.z);
        body.velocity.set(0, 0, 0);
        body.quaternion.set(0, 0, 0, 1);
        body.angularVelocity.set(0, 0, 0);
        body.force.set(0, 0, 0);
        body.torque.set(0, 0, 0);
        markBodyAabbDirty(body);
      }

      const shape = body.shapes[0];
      const radius = Number.isFinite(shape?.boundingSphereRadius) ? shape.boundingSphereRadius : .5;
      const limit = Math.max(0.5, arenaInnerFace - radius - .02);
      const { positionCorrected } = constrainBodyToSquare(body, limit, fallback);
      if (positionCorrected) {
        markBodyAabbDirty(body);
      }
    }
  }

  function constrainCameraToArena() {
    // La camera segue il corpo, ma l'head-bob può aggiungere qualche
    // centimetro: applica un secondo limite prima che il frame venga renderizzato.
    if (!Number.isFinite(camera.position.x)
      || !Number.isFinite(camera.position.y)
      || !Number.isFinite(camera.position.z)
      || camera.position.y < 0.1
      || camera.position.y > 100) {
      resetPlayerBody();
      camera.position.set(CONFIG.spawnPos.x, CONFIG.spawnPos.y + CONFIG.eyeHeight, CONFIG.spawnPos.z);
    }
    // Un movimento del mouse o un frame corrotto non deve mai propagare NaN
    // nella matrice della camera: una singola rotazione non finita può rendere
    // nero l'intero passaggio post-processing.
    if (!Number.isFinite(yaw)) yaw = 0;
    if (!Number.isFinite(pitch)) pitch = 0;
    pitch = THREE.MathUtils.clamp(pitch, -Math.PI / 2 + .01, Math.PI / 2 - .01);
    const x = THREE.MathUtils.clamp(camera.position.x, -cameraArenaLimit, cameraArenaLimit);
    const z = THREE.MathUtils.clamp(camera.position.z, -cameraArenaLimit, cameraArenaLimit);
    camera.position.x = Number.isFinite(x) ? x : 0;
    camera.position.z = Number.isFinite(z) ? z : CONFIG.spawnPos.z;
  }

  // Orientamento della camera (yaw = rotazione orizzontale, pitch = verticale)
  // M3: la sensibilità del mouse è regolabile nel pannello settings e persistita.
  let mouseSensitivity = getStoredSensitivity();
  let yaw = 0;
  let pitch = 0;
  let wasOnPad = false;
  let wasGrounded = false;
  let isGrounded = false;
  let isSprinting = false;
  let lastVerticalVelocity = 0;
  let nextFootstep = 0;
  let bobPhase = 0;

  // --- MOBILE / TOUCH (rilevato presto, serve anche per il dettaglio armi) ---
  // Rileva un dispositivo "touch-primary" (telefono/tablet), non un PC con
  // touchscreen: basta (pointer: coarse) E (hover: none). Un portatile con
  // touchscreen ha comunque un mouse/trackpad (hover) e non deve attivare la
  // modalità touch né il guard di rotazione.
  const touchMode = typeof matchMedia === 'function'
    && matchMedia('(pointer: coarse)').matches
    && matchMedia('(hover: none)').matches;
  // Device "high-end": su touch consente il profilo ULTRA (heuristic CPU/RAM/DPR).
  const highEndDevice = !!(navigator && navigator.deviceMemory && navigator.deviceMemory >= 8
    && navigator.hardwareConcurrency && navigator.hardwareConcurrency >= 8
    && (window.devicePixelRatio || 1) >= 2.5);

  /* ============================================================
     7. ARMA CYBERPUNK, MUZZLE FLASH E INPUT
     ============================================================ */
  const gun = new THREE.Group();
  const railgunView = new THREE.Group();
  const minigunView = new THREE.Group();
  const rpgView = new THREE.Group();
  const flameView = new THREE.Group();
  // Mappa per la visibilità dell'arma in prima persona (1 gruppi per arma).
  const weaponViews = { pulse: gun, railgun: railgunView, minigun: minigunView, rpg: rpgView, flame: flameView };

  // Livello di dettaglio delle armi: su ULTRA i modelli diventano molto più
  // ricchi geometricamente e graficamente. Il valore iniziale viene letto dalla
  // persistenza (ma solo se il dispositivo lo consente) e, se l'utente cambia
  // profilo a runtime, i modelli vengono ricostruiti (vedi applyProfile).
  let weaponDetailUltra = (getStoredQualityMode() === 'ultra') && !(touchMode && !highEndDevice);

  // Helper per costruire un pezzo con pos/rot/scale e ombra cast.
  function part(geometry, material, position, rotation, scale, noShadow) {
    const mesh = new THREE.Mesh(geometry, material);
    if (position) mesh.position.set(position[0], position[1], position[2]);
    if (rotation) mesh.rotation.set(rotation[0], rotation[1], rotation[2]);
    if (scale) mesh.scale.set(scale[0], scale[1], scale[2]);
    if (!noShadow) mesh.castShadow = true;
    return mesh;
  }

  // Every first-person weapon uses the same physically based surface language:
  // brushed structural metal, coated armour, dark polymer and a polished trim.
  // Keeping these values in one factory prevents one gun from looking flat while
  // another reflects the environment correctly.
  function createWeaponMaterials({ armour, frame, trim, polymer, glow, glowHot }) {
    const normalScale = new THREE.Vector2(.16, .16);
    return {
      armour: new THREE.MeshPhysicalMaterial({
        color: armour, metalness: .9, roughness: .2,
        clearcoat: .72, clearcoatRoughness: .12,
        envMap: weaponEnvironment, envMapIntensity: 2.35,
        normalMap: brushedNormal, normalScale,
        iridescence: .08, iridescenceIOR: 1.35
      }),
      frame: new THREE.MeshPhysicalMaterial({
        color: frame, metalness: .94, roughness: .28,
        clearcoat: .38, clearcoatRoughness: .2,
        envMap: weaponEnvironment, envMapIntensity: 2.0, normalMap: brushedNormal,
        normalScale: new THREE.Vector2(.11, .11)
      }),
      trim: new THREE.MeshPhysicalMaterial({
        color: trim, metalness: .98, roughness: .13,
        clearcoat: .82, clearcoatRoughness: .08,
        envMap: weaponEnvironment, envMapIntensity: 2.8
      }),
      polymer: new THREE.MeshPhysicalMaterial({
        color: polymer, metalness: .18, roughness: .43,
        clearcoat: .48, clearcoatRoughness: .24,
        envMap: weaponEnvironment, envMapIntensity: 1.35
      }),
      glow: new THREE.MeshBasicMaterial({
        color: glow, toneMapped: false, blending: THREE.AdditiveBlending
      }),
      glowHot: new THREE.MeshBasicMaterial({
        color: glowHot, toneMapped: false, blending: THREE.AdditiveBlending
      }),
      glass: new THREE.MeshPhysicalMaterial({
        color: glow, emissive: glow, emissiveIntensity: .55,
        metalness: .05, roughness: .06, clearcoat: 1,
        clearcoatRoughness: .03, envMap: weaponEnvironment, envMapIntensity: 3.2,
        transparent: true, opacity: .72, depthWrite: false,
        side: THREE.DoubleSide
      })
    };
  }

  function addCoolingFins(meshes, material, count, startZ, spacing, width, y, height = .012) {
    for (let i = 0; i < count; i++) {
      meshes.push(part(new THREE.BoxGeometry(width, height, .018), material, [0, y, startZ - i * spacing]));
    }
  }

  function addFasteners(meshes, material, positions, radius = .006) {
    for (const [x, y, z, rx = Math.PI / 2] of positions) {
      meshes.push(part(new THREE.CylinderGeometry(radius, radius, .009, 8), material, [x, y, z], [rx, 0, 0]));
    }
  }

  // --- VX-9 PULSE RIFLE -----------------------------------------------------
  function buildPulseGun(ultra) {
    if (!ultra) return buildPulseGunLite();
    return buildPulseGunUltra();
  }
  function buildPulseGunLite() {
    const meshes = [];
    const materials = createWeaponMaterials({
      armour: 0x283340, frame: 0x080c12, trim: 0x7d91a7,
      polymer: 0x10151d, glow: 0x00dfff, glowHot: 0xb9fbff
    });
    const { armour: metal, frame: dark, glow: strip, glass } = materials;
    meshes.push(
      part(new RoundedBoxGeometry(0.07, 0.11, 0.42, 2, 0.012), metal),
      part(new THREE.BoxGeometry(0.05, 0.15, 0.09), dark, [0, -0.13, 0.03], [0.25, 0, 0]),
      part(new THREE.CylinderGeometry(0.02, 0.026, 0.34, 12), dark, [0, 0.015, -0.34], [Math.PI / 2, 0, 0]),
      part(new THREE.BoxGeometry(0.05, 0.06, 0.24), metal, [0, 0.02, -0.3]),
      part(new THREE.BoxGeometry(0.02, 0.035, 0.09), dark, [0, 0.075, -0.05]),
      part(new THREE.BoxGeometry(0.012, 0.018, 0.24), strip, [0.041, 0.0, -0.05]),
      part(new RoundedBoxGeometry(.055, .13, .09, 2, .01), dark, [0, -0.12, -0.1], [-0.12, 0, 0]),
      part(new THREE.TorusGeometry(.038, .008, 7, 12, Math.PI), metal, [0, -0.075, -0.015], [0, Math.PI / 2, Math.PI / 2]),
      part(new THREE.PlaneGeometry(.045, .028), glass, [0, .112, -0.065], null, null, true),
      part(new THREE.TorusGeometry(.034, .006, 6, 16), dark, [0, .112, -0.065], null, [1, .72, 1])
    );
    return meshes;
  }

  // VX-9 dettagliato (solo ULTRA): più parti, sfaccettature e accent luminosi.
  function buildPulseGunUltra() {
    const meshes = [];
    const materials = createWeaponMaterials({
      armour: 0x314050, frame: 0x070b11, trim: 0xb26a25,
      polymer: 0x111923, glow: 0x00dfff, glowHot: 0xc9fcff
    });
    const {
      armour: metal, frame: dark, trim: bronze,
      glow: strip, glowHot: stripHot, glass
    } = materials;

    meshes.push(part(new RoundedBoxGeometry(0.075, 0.1, 0.44, 3, 0.014), metal, [0, 0.01, 0.0]));
    meshes.push(part(new THREE.BoxGeometry(0.012, 0.06, 0.3), dark, [0.045, 0.02, 0.02]));
    meshes.push(part(new THREE.BoxGeometry(0.06, 0.045, 0.3), dark, [0, -0.045, 0.04]));
    for (let i = 0; i < 7; i++) {
      meshes.push(part(new THREE.BoxGeometry(0.015, 0.012, 0.012), dark, [0, 0.062, -0.02 + i * 0.045]));
    }
    meshes.push(part(new THREE.CylinderGeometry(0.02, 0.02, 0.4, 20), dark, [0, 0.025, -0.36], [Math.PI / 2, 0, 0]));
    meshes.push(part(new THREE.CylinderGeometry(0.03, 0.03, 0.05, 20), bronze, [0, 0.025, -0.56], [Math.PI / 2, 0, 0]));
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      meshes.push(part(new THREE.BoxGeometry(0.006, 0.012, 0.02), dark, [Math.cos(a) * 0.03, 0.025 + Math.sin(a) * 0.03, -0.56], [0, 0, a], null, true));
    }
    meshes.push(part(new THREE.BoxGeometry(0.05, 0.05, 0.26), metal, [0, 0.005, -0.32]));
    for (let i = 0; i < 5; i++) {
      meshes.push(part(new THREE.BoxGeometry(0.004, 0.03, 0.012), dark, [0.026, 0.005, -0.4 + i * 0.05]));
    }
    meshes.push(part(new THREE.CylinderGeometry(0.028, 0.036, 0.16, 8), metal, [0, -0.13, 0.03], [0.2, 0, 0], [1, 1, 0.9]));
    meshes.push(part(new THREE.BoxGeometry(0.05, 0.14, 0.05), dark, [0, -0.13, 0.011], [0.2, 0, 0]));
    meshes.push(part(new RoundedBoxGeometry(0.056, 0.14, 0.1, 3, 0.012), dark, [0, -0.13, -0.1], [-0.12, 0, 0]));
    meshes.push(part(new THREE.BoxGeometry(0.06, 0.02, 0.11), bronze, [0, -0.205, -0.1], [-0.12, 0, 0]));
    meshes.push(part(new THREE.BoxGeometry(0.02, 0.05, 0.006), stripHot, [0, -0.13, -0.05], [-0.12, 0, 0], null, true));
    meshes.push(part(new THREE.TorusGeometry(0.04, 0.009, 8, 20, Math.PI), metal, [0, -0.08, -0.015], [0, Math.PI / 2, Math.PI / 2], null, true));
    meshes.push(part(new THREE.BoxGeometry(0.012, 0.03, 0.02), bronze, [0, -0.055, -0.015]));
    meshes.push(part(new THREE.BoxGeometry(0.02, 0.02, 0.06), dark, [0.045, 0.045, 0.14]));
    meshes.push(part(new THREE.TorusGeometry(0.036, 0.007, 8, 24), dark, [0, 0.115, -0.06], null, [1, 0.7, 1], true));
    meshes.push(part(new THREE.PlaneGeometry(0.05, 0.03), glass, [0, 0.115, -0.06], null, null, true));
    meshes.push(part(new THREE.BoxGeometry(0.012, 0.018, 0.26), strip, [0.041, 0.0, -0.05], null, null, true));
    meshes.push(part(new THREE.BoxGeometry(0.012, 0.018, 0.26), stripHot, [-0.041, 0.0, -0.05], null, null, true));
    meshes.push(part(new THREE.CylinderGeometry(0.014, 0.014, 0.2, 16), stripHot, [0.05, 0.0, 0.0], [Math.PI / 2, 0, 0], null, true));
    for (const [x, y, z] of [[0, 0.05, 0.1], [0, 0.05, -0.1], [0.03, -0.02, 0.15]]) {
      meshes.push(part(new THREE.CylinderGeometry(0.006, 0.006, 0.012, 8), bronze, [x, y, z], [Math.PI / 2, 0, 0]));
    }
    // Floating side armour and a polished charging rail break up the old boxy
    // silhouette and catch long cyan/magenta streaks from the IBL panels.
    for (const x of [-.052, .052]) {
      meshes.push(part(new RoundedBoxGeometry(.014, .072, .24, 2, .005), metal, [x, .005, -.12], [0, 0, x > 0 ? -.08 : .08]));
      meshes.push(part(new THREE.BoxGeometry(.006, .014, .21), strip, [x * 1.08, .012, -.12], null, null, true));
    }
    addCoolingFins(meshes, bronze, 5, -.23, .052, .092, .068, .009);
    addFasteners(meshes, bronze, [[-.041, .052, .12], [.041, .052, .12], [-.041, -.03, -.05], [.041, -.03, -.05]], .005);
    return meshes;
  }

  // --- RAILGUN ---------------------------------------------------------------
  function buildRailgun(ultra) {
    if (!ultra) return buildRailgunLite();
    return buildRailgunUltra();
  }
  function buildRailgunLite() {
    const meshes = [];
    const materials = createWeaponMaterials({
      armour: 0x28465e, frame: 0x050c15, trim: 0x9c6330,
      polymer: 0x0a111a, glow: 0x54eaff, glowHot: 0xd7fcff
    });
    const { armour: railMetal, frame: railDark, glow: railGlow } = materials;
    meshes.push(part(new RoundedBoxGeometry(.13, .16, .48, 3, .018), railMetal));
    meshes.push(part(new THREE.BoxGeometry(.1, .17, .2), railDark, [0, -.12, .13], [.18, 0, 0]));
    for (const x of [-.075, .075]) {
      meshes.push(part(new THREE.BoxGeometry(.035, .045, .68), railDark, [x, .025, -.48]));
    }
    for (const [z, idx] of [[-.3, 0], [-.53, 1], [-.76, 2]]) {
      meshes.push(part(new THREE.TorusGeometry(.072, .012, 8, 18), idx === 1 ? railGlow : railMetal, [0, .025, z], null, [1, .72, 1]));
    }
    meshes.push(part(new THREE.BoxGeometry(.018, .018, .72), railGlow, [0, .045, -.48], null, null, true));
    meshes.push(part(new THREE.BoxGeometry(.018, .04, .12), railGlow, [0, .13, -.06], null, null, true));
    return meshes;
  }

  // RAILGUN dettagliato (solo ULTRA): doppia rotaia segmentata, bobine alternate,
  // conduit di rame, nucleo energetico, alette di raffreddamento e accent luminosi.
  function buildRailgunUltra() {
    const meshes = [];
    const materials = createWeaponMaterials({
      armour: 0x31536b, frame: 0x040a12, trim: 0xbd7228,
      polymer: 0x0a111b, glow: 0x51eaff, glowHot: 0xe2fdff
    });
    const {
      armour: railMetal, frame: railDark, trim: copper,
      glow: railGlow, glowHot: railGlowHot, glass
    } = materials;

    meshes.push(part(new RoundedBoxGeometry(.14, .17, .5, 3, .02), railMetal));
    meshes.push(part(new THREE.BoxGeometry(.12, .02, .42), railDark, [0, .09, -.02]));
    meshes.push(part(new THREE.BoxGeometry(.02, .04, .3), railDark, [0, .06, -.05]));
    for (const x of [-.08, .08]) {
      for (let i = 0; i < 6; i++) {
        meshes.push(part(new THREE.BoxGeometry(.02, .028, .09), railDark, [x, .035, -.02 - i * .13]));
      }
      meshes.push(part(new THREE.CylinderGeometry(.012, .012, .7, 12), copper, [x, .02, -.48], [Math.PI / 2, 0, 0]));
    }
    for (let i = 0; i < 6; i++) {
      const z = -.12 - i * .13;
      const glow = i % 2 === 0 ? railGlowHot : railGlow;
      meshes.push(part(new THREE.TorusGeometry(.078, .014, 10, 24), glow, [0, .035, z], null, [1, .72, 1], true));
    }
    meshes.push(part(new THREE.CylinderGeometry(.02, .02, .72, 16), railGlowHot, [0, .05, -.48], [Math.PI / 2, 0, 0], null, true));
    meshes.push(part(new THREE.BoxGeometry(.04, .05, .03), railDark, [0, .13, .18]));
    meshes.push(part(new THREE.BoxGeometry(.02, .05, .02), railGlowHot, [0, .13, .18], null, null, true));
    meshes.push(part(new THREE.BoxGeometry(.02, .05, .12), railGlow, [0, .14, -.06], null, null, true));
    meshes.push(part(new THREE.BoxGeometry(.1, .18, .22), railDark, [0, -.14, .14], [.18, 0, 0]));
    meshes.push(part(new THREE.BoxGeometry(.08, .03, .06), railMetal, [0, -.24, .15], [.18, 0, 0]));
    for (let i = 0; i < 5; i++) {
      meshes.push(part(new THREE.BoxGeometry(.17, .012, .03), railDark, [0, .065, -.5 - i * .08]));
    }
    meshes.push(part(new THREE.CylinderGeometry(.03, .04, .15, 8), railDark, [0, -.15, .05], [.2, 0, 0]));
    meshes.push(part(new THREE.BoxGeometry(.012, .02, .4), railGlow, [.075, 0, -.05], null, null, true));
    meshes.push(part(new THREE.BoxGeometry(.012, .02, .4), railGlow, [-.075, 0, -.05], null, null, true));
    for (const [x, y, z] of [[.05, .08, .1], [-.05, .08, .1], [.05, .08, -.1], [-.05, .08, -.1]]) {
      meshes.push(part(new THREE.CylinderGeometry(.006, .006, .014, 8), copper, [x, y, z], [Math.PI / 2, 0, 0]));
    }
    // Split muzzle forks, focusing crystal and rear charge display.
    for (const x of [-.085, .085]) {
      meshes.push(part(new RoundedBoxGeometry(.026, .052, .2, 2, .006), railMetal, [x, .025, -.83]));
      meshes.push(part(new THREE.BoxGeometry(.008, .024, .16), railGlow, [x * .94, .025, -.84], null, null, true));
    }
    meshes.push(part(new THREE.OctahedronGeometry(.036, 1), glass, [0, .04, -.82], [0, 0, Math.PI / 4], null, true));
    meshes.push(part(new RoundedBoxGeometry(.074, .05, .022, 2, .006), railDark, [0, .135, .08]));
    meshes.push(part(new THREE.PlaneGeometry(.055, .03), glass, [0, .135, .067], null, null, true));
    addFasteners(meshes, copper, [[-.058, .082, .18], [.058, .082, .18], [-.058, .082, -.18], [.058, .082, -.18]], .005);
    return meshes;
  }

  // --- VULCAN (MINIGUN) ------------------------------------------------------
  // Rotera molto veloce: un gruppo `barrel` con più canne che ruota nel loop.
  let minigunBarrel = null;
  function buildMinigunView(ultra) {
    const meshes = [];
    const materials = createWeaponMaterials({
      armour: 0x343a42, frame: 0x080a0d, trim: 0xc46c25,
      polymer: 0x15171b, glow: 0xff7a25, glowHot: 0xffd08a
    });
    const {
      armour: metal, frame: dark, trim: accent, polymer,
      glow, glowHot, glass
    } = materials;

    // Motor housing and removable side armour.
    meshes.push(part(new RoundedBoxGeometry(.16, .17, .48, 4, .025), metal));
    meshes.push(part(new RoundedBoxGeometry(.12, .18, .17, 3, .018), polymer, [0, -.105, .14], [.18, 0, 0]));
    meshes.push(part(new RoundedBoxGeometry(.025, .105, .3, 2, .008), dark, [.09, .005, -.03]));
    meshes.push(part(new RoundedBoxGeometry(.025, .105, .3, 2, .008), dark, [-.09, .005, -.03]));
    meshes.push(part(new THREE.CylinderGeometry(.055, .065, .2, ultra ? 20 : 12), metal, [0, .075, .13], [Math.PI / 2, 0, 0]));
    meshes.push(part(new THREE.CylinderGeometry(.036, .036, .025, 16), glow, [0, .076, .24], [Math.PI / 2, 0, 0], null, true));

    // The previous barrels were vertical cylinders. They now run along the
    // firing axis and are braced by a rotating central shaft and support rings.
    const barrel = new THREE.Group();
    const barrelGeometry = new THREE.CylinderGeometry(.012, .016, .7, ultra ? 16 : 10);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const tube = new THREE.Mesh(barrelGeometry, i % 2 ? dark : metal);
      tube.position.set(Math.cos(a) * .055, Math.sin(a) * .055, -.48);
      tube.rotation.x = Math.PI / 2;
      tube.castShadow = true;
      barrel.add(tube);
      const collar = new THREE.Mesh(new THREE.CylinderGeometry(.021, .021, .055, 12), accent);
      collar.position.set(Math.cos(a) * .055, Math.sin(a) * .055, -.82);
      collar.rotation.x = Math.PI / 2;
      collar.castShadow = true;
      barrel.add(collar);
    }
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(.013, .013, .72, 12), accent);
    shaft.position.z = -.47;
    shaft.rotation.x = Math.PI / 2;
    barrel.add(shaft);
    for (const z of [-.22, -.55]) {
      const brace = new THREE.Mesh(new THREE.TorusGeometry(.063, .011, 10, ultra ? 28 : 18), dark);
      brace.position.z = z;
      barrel.add(brace);
    }
    const muzzle = new THREE.Mesh(new THREE.CylinderGeometry(.08, .08, .055, ultra ? 24 : 14, 1, true), metal);
    muzzle.position.z = -.84;
    muzzle.rotation.x = Math.PI / 2;
    barrel.add(muzzle);
    const muzzleLip = new THREE.Mesh(new THREE.TorusGeometry(.079, .012, 10, ultra ? 28 : 18), accent);
    muzzleLip.position.z = -.87;
    barrel.add(muzzleLip);
    meshes.push(barrel);

    // Side drum, visible feed belt, grip and holographic round counter.
    meshes.push(part(new THREE.CylinderGeometry(.085, .085, .1, ultra ? 24 : 14), dark, [.12, -.015, .13], [0, 0, Math.PI / 2]));
    meshes.push(part(new THREE.CylinderGeometry(.06, .06, .105, ultra ? 24 : 14), accent, [.12, -.015, .13], [0, 0, Math.PI / 2]));
    for (let i = 0; i < 5; i++) {
      meshes.push(part(new RoundedBoxGeometry(.025, .018, .035, 1, .004), accent, [.08 - i * .022, .005 + i * .006, .1 - i * .012], [0, 0, -.22]));
    }
    meshes.push(part(new RoundedBoxGeometry(.055, .15, .075, 3, .012), polymer, [0, -.145, .08], [.2, 0, 0]));
    meshes.push(part(new THREE.TorusGeometry(.032, .006, 8, 18, Math.PI), accent, [0, -.075, .04], [0, Math.PI / 2, Math.PI / 2]));
    meshes.push(part(new RoundedBoxGeometry(.065, .045, .02, 2, .006), dark, [0, .125, .02]));
    meshes.push(part(new THREE.PlaneGeometry(.048, .028), glass, [0, .125, .008], null, null, true));
    meshes.push(part(new THREE.BoxGeometry(.012, .018, .25), glow, [.086, .035, -.04], null, null, true));

    if (ultra) {
      addCoolingFins(meshes, accent, 6, .05, .05, .17, .09, .009);
      for (const x of [-.09, .09]) {
        meshes.push(part(new THREE.CylinderGeometry(.008, .008, .26, 10), glowHot, [x, -.045, -.04], [Math.PI / 2, 0, 0], null, true));
      }
      addFasteners(meshes, accent, [[-.08, .06, .16], [.08, .06, .16], [-.08, -.04, -.12], [.08, -.04, -.12]], .0055);
    }
    return { meshes, barrel };
  }

  // --- HELLSTORM (RPG) -------------------------------------------------------
  function buildRPGView(ultra) {
    const meshes = [];
    const materials = createWeaponMaterials({
      armour: 0x39483c, frame: 0x070b08, trim: 0xd7a12c,
      polymer: 0x151c16, glow: 0xffba32, glowHot: 0xfff0a8
    });
    const {
      armour: tube, frame: dark, trim: accent, polymer,
      glow, glowHot, glass
    } = materials;

    // Layered launch tube with a true dark bore and polished blast bell.
    meshes.push(part(new THREE.CylinderGeometry(.075, .085, .76, ultra ? 28 : 16), tube, [0, 0, -.25], [Math.PI / 2, 0, 0]));
    meshes.push(part(new THREE.CylinderGeometry(.096, .125, .13, ultra ? 28 : 16, 1, true), dark, [0, 0, -.69], [Math.PI / 2, 0, 0]));
    meshes.push(part(new THREE.TorusGeometry(.124, .013, 10, ultra ? 32 : 18), accent, [0, 0, -.76]));
    meshes.push(part(new THREE.CircleGeometry(.077, ultra ? 28 : 16), dark, [0, 0, -.767], null, null, true));
    meshes.push(part(new THREE.CylinderGeometry(.09, .075, .08, ultra ? 24 : 14), tube, [0, 0, .17], [Math.PI / 2, 0, 0]));

    // Armoured saddle, shoulder stock and ergonomic fire controls.
    meshes.push(part(new RoundedBoxGeometry(.14, .09, .28, 3, .018), tube, [0, -.015, -.05]));
    meshes.push(part(new RoundedBoxGeometry(.11, .065, .28, 3, .014), polymer, [0, .01, .22]));
    meshes.push(part(new RoundedBoxGeometry(.055, .15, .075, 3, .012), polymer, [0, -.14, .09], [.2, 0, 0]));
    meshes.push(part(new THREE.TorusGeometry(.034, .006, 8, 18, Math.PI), accent, [0, -.075, .055], [0, Math.PI / 2, Math.PI / 2]));
    for (const z of [-.16, .04]) {
      meshes.push(part(new THREE.TorusGeometry(.09, .011, 9, ultra ? 28 : 18), accent, [0, 0, z], null, [1, .94, 1]));
    }

    // Offset thermal optic and illuminated range ladder.
    meshes.push(part(new RoundedBoxGeometry(.075, .07, .22, 3, .012), dark, [.095, .08, -.06]));
    meshes.push(part(new THREE.CylinderGeometry(.033, .04, .06, 18), accent, [.095, .08, -.19], [Math.PI / 2, 0, 0]));
    meshes.push(part(new THREE.CircleGeometry(.031, 18), glass, [.095, .08, -.222], null, null, true));
    meshes.push(part(new RoundedBoxGeometry(.052, .038, .018, 2, .005), dark, [.095, .13, .025]));
    meshes.push(part(new THREE.PlaneGeometry(.038, .024), glass, [.095, .13, .014], null, null, true));
    meshes.push(part(new THREE.BoxGeometry(.012, .02, .32), glow, [-.076, .048, -.15], null, null, true));

    if (ultra) {
      for (const x of [-.082, .082]) {
        for (let i = 0; i < 5; i++) {
          meshes.push(part(new RoundedBoxGeometry(.018, .035, .055, 1, .004), i % 2 ? tube : dark, [x, -.005, -.23 + i * .075]));
        }
      }
      addCoolingFins(meshes, accent, 5, -.28, .055, .15, .087, .008);
      addFasteners(meshes, accent, [[-.062, .05, .23], [.062, .05, .23], [-.062, -.05, -.02], [.062, -.05, -.02]], .0055);
      meshes.push(part(new THREE.BoxGeometry(.01, .018, .22), glowHot, [.078, -.045, -.18], null, null, true));
    }
    return meshes;
  }

  // --- PYRE (FLAMETHROWER) ---------------------------------------------------
  function buildFlameView(ultra) {
    const meshes = [];
    const materials = createWeaponMaterials({
      armour: 0x533421, frame: 0x0d0705, trim: 0xcf6323,
      polymer: 0x1c100b, glow: 0xff481c, glowHot: 0xffd078
    });
    const {
      armour: tank, frame: dark, trim: copper, polymer,
      glow, glowHot, glass
    } = materials;

    // Central valve block with twin pressurised fuel canisters.
    meshes.push(part(new RoundedBoxGeometry(.13, .15, .38, 4, .022), dark, [0, 0, -.04]));
    for (const x of [-.09, .09]) {
      meshes.push(part(new THREE.CylinderGeometry(.052, .052, .35, ultra ? 24 : 14), tank, [x, -.005, -.015], [Math.PI / 2, 0, 0]));
      for (const z of [-.11, .08]) {
        meshes.push(part(new THREE.TorusGeometry(.053, .009, 9, ultra ? 24 : 16), copper, [x, -.005, z]));
      }
      meshes.push(part(new THREE.SphereGeometry(.052, ultra ? 18 : 10, ultra ? 12 : 8, 0, Math.PI * 2, 0, Math.PI / 2), tank, [x, -.005, -.19], [Math.PI / 2, 0, 0]));
    }

    // Long injection nozzle, heat cage and four-pronged burner crown.
    meshes.push(part(new THREE.CylinderGeometry(.022, .03, .48, ultra ? 20 : 12), copper, [0, .01, -.43], [Math.PI / 2, 0, 0]));
    for (const z of [-.27, -.42, -.57]) {
      meshes.push(part(new THREE.TorusGeometry(.052, .009, 9, ultra ? 24 : 16), dark, [0, .01, z]));
    }
    for (const [x, y] of [[-.045, 0], [.045, 0], [0, -.035], [0, .055]]) {
      meshes.push(part(new THREE.CylinderGeometry(.006, .006, .34, 8), tank, [x, y + .01, -.43], [Math.PI / 2, 0, 0]));
    }
    meshes.push(part(new THREE.CylinderGeometry(.04, .052, .075, 16, 1, true), dark, [0, .01, -.69], [Math.PI / 2, 0, 0]));
    meshes.push(part(new THREE.TorusGeometry(.05, .01, 10, 24), copper, [0, .01, -.73]));
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2;
      meshes.push(part(new RoundedBoxGeometry(.012, .012, .09, 1, .003), copper, [Math.cos(a) * .043, .01 + Math.sin(a) * .043, -.75], [0, 0, a]));
    }
    meshes.push(part(new THREE.SphereGeometry(.021, 12, 8), glowHot, [0, .027, -.765], null, null, true));

    // Pistol grip, pressure gauge and a real curved fuel hose.
    meshes.push(part(new RoundedBoxGeometry(.055, .145, .075, 3, .012), polymer, [0, -.14, .1], [.2, 0, 0]));
    meshes.push(part(new THREE.TorusGeometry(.034, .006, 8, 18, Math.PI), copper, [0, -.075, .06], [0, Math.PI / 2, Math.PI / 2]));
    meshes.push(part(new THREE.CylinderGeometry(.038, .038, .022, 18), copper, [.105, .09, -.08], [0, 0, Math.PI / 2]));
    meshes.push(part(new THREE.CircleGeometry(.032, 18), glass, [.117, .09, -.08], [0, Math.PI / 2, 0], null, true));
    const hoseCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(.09, .025, .12), new THREE.Vector3(.14, .06, .02),
      new THREE.Vector3(.13, .07, -.16), new THREE.Vector3(.045, .035, -.27)
    ]);
    meshes.push(part(new THREE.TubeGeometry(hoseCurve, ultra ? 20 : 12, .008, 8, false), polymer));
    meshes.push(part(new THREE.BoxGeometry(.012, .018, .25), glow, [-.072, .04, -.02], null, null, true));

    if (ultra) {
      addCoolingFins(meshes, copper, 6, -.28, .052, .12, .072, .009);
      addFasteners(meshes, copper, [[-.052, .052, .12], [.052, .052, .12], [-.052, -.052, -.12], [.052, -.052, -.12]], .005);
      meshes.push(part(new THREE.BoxGeometry(.012, .018, .27), glowHot, [.072, .04, -.02], null, null, true));
    }
    return meshes;
  }

  // Flash di sparo (additivo, raccolto dal bloom) — tenuti separati dai modelli
  // così i riferimenti restano stabili tra una ricostruzione e l'altra.
  function createWeaponMuzzleFlash(colorValue, radius, position) {
    const material = new THREE.MeshBasicMaterial({
      color: colorValue, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
      toneMapped: false
    });
    const mesh = new THREE.Mesh(new THREE.OctahedronGeometry(radius, 1), material);
    mesh.position.set(...position);
    mesh.rotation.z = Math.PI / 4;
    mesh.frustumCulled = false;
    return mesh;
  }
  const flashMesh = createWeaponMuzzleFlash(0xaef4ff, .06, [0, .015, -.58]);
  const railFlashMesh = createWeaponMuzzleFlash(0xffb247, .1, [0, .04, -1.01]);
  const minigunFlashMesh = createWeaponMuzzleFlash(0xffd08a, .075, [0, 0, -.9]);
  const rpgFlashMesh = createWeaponMuzzleFlash(0xffe0a0, .13, [0, 0, -.82]);
  const flameFlashMesh = createWeaponMuzzleFlash(0xff6a25, .09, [0, .025, -.8]);
  const weaponFlashMeshes = {
    pulse: flashMesh,
    railgun: railFlashMesh,
    minigun: minigunFlashMesh,
    rpg: rpgFlashMesh,
    flame: flameFlashMesh
  };

  const muzzleLight = new THREE.PointLight(0x9ff5ff, 0, 14, 2);
  muzzleLight.position.set(0.25, -0.18, -0.9);
  const muzzleFxWorld = new THREE.Vector3();

  function triggerMuzzleFlash(id, intensity, scale) {
    const flash = weaponFlashMeshes[id];
    const view = weaponViews[id];
    if (!flash || !view) return;
    flash.material.opacity = .96;
    flash.scale.setScalar(scale);
    muzzleLight.color.set(id === 'pulse' ? 0x9ff5ff : id === 'railgun' ? 0xffb247 : 0xff7a32);
    muzzleLight.intensity = intensity;
    muzzleLight.position.set(
      view.position.x + flash.position.x,
      view.position.y + flash.position.y,
      view.position.z + flash.position.z
    );
    muzzleLight.getWorldPosition(muzzleFxWorld);
    renderPipeline.triggerLensFlare(muzzleFxWorld, Math.min(.7, intensity / 70), muzzleLight.color.getHex(), .2);
    if (id === 'rpg' || id === 'flame') {
      renderPipeline.triggerHeatHaze(muzzleFxWorld, id === 'rpg' ? .7 : .35, id === 'rpg' ? 24 : 36, .3);
    }
  }

  // Cache di entrambi i LOD per evitare dispose/rebuild a ogni switch.
  const weaponCache = { pulse: {}, railgun: {}, minigun: {}, rpg: {}, flame: {} };
  function getWeaponMeshes(id, ultra) {
    const key = ultra ? 'ultra' : 'lite';
    if (weaponCache[id][key]) return weaponCache[id][key];
    let meshes;
    let barrel = null;
    if (id === 'pulse') meshes = buildPulseGun(ultra);
    else if (id === 'railgun') meshes = buildRailgun(ultra);
    else if (id === 'minigun') { const built = buildMinigunView(ultra); meshes = built.meshes; barrel = built.barrel; }
    else if (id === 'rpg') meshes = buildRPGView(ultra);
    else if (id === 'flame') meshes = buildFlameView(ultra);
    weaponCache[id][key] = { meshes, barrel };
    return weaponCache[id][key];
  }
  function disposeMesh(root) {
    const geometries = new Set();
    const materials = new Set();
    root.traverse(object => {
      if (object.geometry) geometries.add(object.geometry);
      if (Array.isArray(object.material)) object.material.forEach(material => materials.add(material));
      else if (object.material) materials.add(object.material);
    });
    geometries.forEach(geometry => geometry.dispose());
    materials.forEach(material => material.dispose());
  }
  function applyWeaponDetail() {
    const ultra = weaponDetailUltra;
    for (const [id, view] of Object.entries(weaponViews)) {
      const protectedFlash = weaponFlashMeshes[id];
      // Hide instead of dispose: keep old LOD cached.
      for (const child of [...view.children]) {
        if (child === protectedFlash) continue;
        child.visible = false;
      }
    }
    // Retrieve from cache or build once
    const pulseCached = getWeaponMeshes('pulse', ultra);
    const railCached = getWeaponMeshes('railgun', ultra);
    const miniCached = getWeaponMeshes('minigun', ultra);
    const rpgCached = getWeaponMeshes('rpg', ultra);
    const flameCached = getWeaponMeshes('flame', ultra);
    // Ensure cached meshes are attached and visible
    const attachIfNeeded = (view, cached) => {
      for (const m of cached.meshes) {
        if (m.parent !== view) view.add(m);
        m.visible = true;
      }
      // Hide other LOD
      const otherKey = ultra ? 'lite' : 'ultra';
      const viewCache = weaponCache[Object.keys(weaponViews).find(k => weaponViews[k]===view)];
      // Instead hide the alternate meshes if they exist and are not current
      // (they remain in scene but invisible — zero draw cost via frustum cull).
      if (viewCache && viewCache[otherKey]) {
        for (const m of viewCache[otherKey].meshes) {
          if (m !== cached.meshes.find(x => x===m)) m.visible = false;
        }
      }
    };
    // For minigun barrel reference
    // First ensure pulse meshes are correctly attached
    for (const [id, view] of Object.entries(weaponViews)) {
      const cached = getWeaponMeshes(id, ultra);
      for (const m of cached.meshes) {
        if (m.parent !== view) view.add(m);
        m.visible = true;
      }
      const otherKey = ultra ? 'lite' : 'ultra';
      if (weaponCache[id][otherKey]) {
        for (const m of weaponCache[id][otherKey].meshes) {
          // Don't hide the current ultra meshes again
          if (!cached.meshes.includes(m)) m.visible = false;
        }
      }
    }
    minigunBarrel = miniCached.barrel;
  }

  gun.position.set(0.25, -0.21, -0.45);
  railgunView.position.set(.25, -.21, -.45);
  minigunView.position.set(.25, -.21, -.45);
  rpgView.position.set(.25, -.21, -.45);
  flameView.position.set(.25, -.21, -.45);
  railgunView.visible = false;
  minigunView.visible = false;
  rpgView.visible = false;
  flameView.visible = false;
  applyWeaponDetail();
  camera.add(gun, railgunView, minigunView, rpgView, flameView, muzzleLight);
  scene.add(camera);   // necessario affinché arma e luce annesse vengano renderizzate

  let gunRecoil = 0;   // rinculo visivo dell'arma
  let reloadDip = 0;   // G5: abbassamento dell'arma durante la ricarica
  let crosshairFireTimer = 0;
  // N7: stato precedente per il dirty-check delle classi DOM nel frame loop.
  let hudSprinting = false;
  let crosshairFiring = false;

  /* ============================================================
     7B. STATO DI GIOCO, HUD E MOTORE AUDIO PROCEDURALE
     ============================================================ */
  const overlayEl = document.getElementById('overlay');
  const crosshairEl = document.getElementById('crosshair');
  const hudEl = document.getElementById('hud');
  const gameHudEl = document.getElementById('game-hud');
  const targetLayerEl = document.getElementById('target-layer');
  const hitmarkerEl = document.getElementById('hitmarker');
  const waveBannerEl = document.getElementById('wave-banner');
  const scorePopEl = document.getElementById('score-pop');
  const damageVignetteEl = document.getElementById('damage-vignette');
  const radarCanvas = document.getElementById('radar');
  const radarCtx = radarCanvas.getContext('2d');
  const bossBarEl = document.getElementById('boss-bar');
  let hudVisibility = null;

  const gameState = {
    health: CONFIG.maxHealth, shield: CONFIG.maxShield, stamina: CONFIG.maxStamina,
    ammo: CONFIG.magazineSize, reserve: CONFIG.reserveAmmo,
    weapon: 'pulse', railgunUnlocked: false,
    railgunAmmo: 0, railgunReserve: 0,
    minigunUnlocked: false, minigunAmmo: 0, minigunReserve: 0,
    rpgUnlocked: false, rpgAmmo: 0, rpgReserve: 0,
    flameUnlocked: false, flameAmmo: 0, flameReserve: 0,
    reloading: false, reloadTimer: 0,
    score: 0, combo: 1, comboTimer: 0,
    wave: 1, waveKills: 0, waveTargets: 5, waveDelay: 0,
    dead: false, respawnTimer: 0, lastDamage: -99,
    shots: 0, hits: 0, started: false,
    gameOver: false,
    victory: false,
    lives: CONFIG.maxLives, maxLives: CONFIG.maxLives
  };

  // Helper per l'accesso uniforme allo stato di ogni arma (caricatore, riserva,
  // sblocco). Il pulse usa le chiavi base `ammo`/`reserve`; le altre armi
  // usano `<id>Ammo` / `<id>Reserve` / `<id>Unlocked`.
  function weaponUnlocked(id) {
    if (id === 'pulse') return true;
    if (id === 'railgun') return gameState.railgunUnlocked;
    if (id === 'minigun') return gameState.minigunUnlocked;
    if (id === 'rpg') return gameState.rpgUnlocked;
    if (id === 'flame') return gameState.flameUnlocked;
    return false;
  }
  function weaponAmmo(id) {
    return id === 'pulse' ? gameState.ammo : (gameState[`${id}Ammo`] ?? 0);
  }
  function weaponReserve(id) {
    return id === 'pulse' ? gameState.reserve : (gameState[`${id}Reserve`] ?? 0);
  }
  function setWeaponAmmo(id, ammo, reserve) {
    if (id === 'pulse') { gameState.ammo = ammo; gameState.reserve = reserve; }
    else { gameState[`${id}Ammo`] = ammo; gameState[`${id}Reserve`] = reserve; }
  }
  function unlockWeapon(id) {
    if (id === 'railgun') gameState.railgunUnlocked = true;
    else if (id === 'minigun') gameState.minigunUnlocked = true;
    else if (id === 'rpg') gameState.rpgUnlocked = true;
    else if (id === 'flame') gameState.flameUnlocked = true;
  }
  function weaponTuning(id) { return WEAPON_TUNING[id] || WEAPON_TUNING.pulse; }
  // Elenco delle armi sbloccate, in ordine di "slot" (1-5).
  function availableWeapons() {
    return ['pulse', 'railgun', 'minigun', 'rpg', 'flame'].filter(weaponUnlocked);
  }

  const hudController = new HudController();
  hudController.maxShield = CONFIG.maxShield;
  hudController.maxLives = CONFIG.maxLives;
  const audio = AudioEngine.getInstance(muted => hudController.setMuted(muted));
  // N8: l'HUD riflette subito il mute persistito (prima restava su IMMERSIVE).
  hudController.setMuted(audio.muted);

  function restartClass(el,name){el.classList.remove(name);void el.offsetWidth;el.classList.add(name);}
  // N9/A2: pan stereo coerente con la posizione a schermo della sorgente sonora
  // (esplosioni e impatti seguono lo stesso schema di enemyShot/telegraph).
  function panForWorld(position) {
    if (!position
      || !Number.isFinite(position.x)
      || !Number.isFinite(position.y)
      || !Number.isFinite(position.z)) return 0;
    panProjection.set(position.x, position.y, position.z).project(camera);
    if (!Number.isFinite(panProjection.x)) return 0;
    return Math.max(-.85, Math.min(.85, panProjection.x));
  }
  const panProjection = new THREE.Vector3();
  function toast(message){hudController.toast(message);}
  function showWave(title=t('hud.wave',{wave:String(gameState.wave).padStart(2,'0')}),subtitle=t('wave.subtitle')){
    waveBannerEl.querySelector('strong').textContent=title;waveBannerEl.querySelector('span').textContent=subtitle;restartClass(waveBannerEl,'show');audio.ui();
  }
  function showHitmarker(kill=false){hitmarkerEl.classList.toggle('kill',kill);restartClass(hitmarkerEl,'active');audio.hit(kill);}
  function showScore(amount,label){scorePopEl.textContent=`+${amount} ${label}`;restartClass(scorePopEl,'show');}
  // P1: updateHUD() viene chiamata ogni frame da updateGameplay (rigenerazione
  // shield/stamina/combo). Lo spread {...gameState} allocava un oggetto nuovo a
  // frame; ora lo snapshot è un oggetto riusato compilato sul posto.
  const hudSnapshot = {};
  function updateHUD(){
    // Espone all'HUD lo stato dell'arma corrente (munizioni, riserva, nome,
    // capienza caricatore) così il render è uniforme per tutte le 5 armi.
    const w = gameState.weapon;
    const tuning = weaponTuning(w);
    Object.assign(hudSnapshot, gameState);
    hudSnapshot._ammo = weaponAmmo(w);
    hudSnapshot._reserve = weaponReserve(w);
    hudSnapshot._weaponName = t(tuning.nameKey);
    hudSnapshot._magazineSize = tuning.magazineSize;
    hudController.render(hudSnapshot);
    hudController.renderBoss(droneSystem.getBossHudState());
  }

  function setWeapon(nextWeapon, announce = true) {
    const next = WEAPON_TUNING[nextWeapon] ? nextWeapon : 'pulse';
    if (!weaponUnlocked(next)) {
      if (announce) toast(`<b>ARMORY</b> · ${t('toast.weaponLocked')}`);
      return false;
    }
    if (gameState.weapon === next) {
      for (const id of Object.keys(weaponViews)) weaponViews[id].visible = (id === next);
      return true;
    }
    gameState.weapon = next;
    gameState.reloading = false;
    gameState.reloadTimer = 0;
    for (const id of Object.keys(weaponViews)) weaponViews[id].visible = (id === next);
    if (announce) {
      const tuning = weaponTuning(next);
      toast(`<b>${t(tuning.nameKey)}</b> · ${tuning.displayName ? `${tuning.displayName} ONLINE` : t(next === 'railgun' ? 'toast.railgunReady' : 'toast.pulseReady')}`);
      audio.ui();
    }
    updateHUD();
    return true;
  }

  function syncHudVisibility() {
    const visible = isGameplayActive();
    if (hudVisibility === visible) return;
    hudVisibility = visible;
    crosshairEl.style.display = visible ? 'block' : 'none';
    hudEl.style.display = visible ? 'block' : 'none';
    gameHudEl.style.display = visible ? 'block' : 'none';
    targetLayerEl.style.display = visible ? 'block' : 'none';
    // La barra del boss segue la visibilità dell'HUD (orologio di pausa).
    bossBarEl.style.display = visible ? '' : 'none';
    // I controlli touch compaiono solo durante l'azione su dispositivi touch.
    if (touchMode) touchControlsEl.classList.toggle('active', visible);
    // Mirino: visibile anche in modalità touch (viewfinder deploy su mobile).
    if (touchMode) crosshairEl.style.display = visible ? 'block' : 'none';
  }

  // L1: copy dell'overlay di pausa/reset centralizzato, così il cambio lingua
  // runtime può rigenerarlo senza duplicare stringhe nei call site.
  function applyOverlayStateCopy(resetVariant = false) {
    if (!gameState.started) return; // start: coperto dai data-i18n statici
    const gameOver = gameState.gameOver === true;
    const victory = gameState.victory === true;
    overlayEl.querySelector('h1').innerHTML = victory
      ? t('overlay.title.victory')
      : gameOver ? t('overlay.title.gameOver')
      : t(resetVariant ? 'overlay.title.reset' : 'overlay.title.paused');
    overlayEl.querySelector('.sub').textContent = victory
      ? t('overlay.sub.victory')
      : gameOver ? t('overlay.sub.gameOver')
      : t(resetVariant ? 'overlay.sub.reset' : 'overlay.sub.paused');
    overlayEl.querySelector('.brief').textContent = t(
      victory ? 'overlay.brief.victory'
        : gameOver ? 'overlay.brief.gameOver'
          : (resetVariant ? 'overlay.brief.reset' : 'overlay.brief.paused'),
      {
        wave: String(gameState.wave).padStart(2, '0'),
        score: String(Math.round(gameState.score)).padStart(6, '0')
      }
    );
    overlayEl.querySelector('.cta').textContent = t(victory || gameOver ? 'overlay.cta.restart' : 'overlay.cta.resume');
  }

  // L1: cambio lingua runtime — testi statici (data-i18n), HUD dinamico,
  // selezione nel pannello settings e copy dell'overlay di pausa se visibile.
  function applyLanguage(lang) {
    const next = setLanguage(lang);
    document.documentElement.lang = next;
    applyStaticStrings();
    hudController.invalidateCache();
    updateHUD();
    hudController.setMuted(audio.muted);
    settingsPanelRef?.syncLanguage?.(next);
    if (!isGameplayActive()) applyOverlayStateCopy(false);
  }

  function startReload(){
    if(!gameState.started||gameState.reloading||gameState.dead)return;
    const w = gameState.weapon;
    const tuning = weaponTuning(w);
    const ammo = weaponAmmo(w);
    const reserve = weaponReserve(w);
    if (ammo >= tuning.magazineSize || reserve <= 0) return;
    gameState.reloading = true;
    gameState.reloadTimer = tuning.reloadTime;
    audio.reload();
    toast(`<b>${t(tuning.nameKey)}</b> · ${t('toast.reload')}`);
    updateHUD();
  }
  function completeReload(){
    const w = gameState.weapon;
    const tuning = weaponTuning(w);
    const ammo = weaponAmmo(w);
    const reserve = weaponReserve(w);
    const needed = tuning.magazineSize - ammo;
    const taken = Math.min(needed, reserve);
    setWeaponAmmo(w, ammo + taken, reserve - taken);
    gameState.reloading=false;audio.ui();updateHUD();
  }

  const explosionSystem = new ExplosionSystem({
    scene,
    onShockwave(position) {
      renderPipeline.triggerShockwave(position);
      renderPipeline.triggerLensFlare(position, 1.1, 0xffa05c, .48);
      renderPipeline.triggerHeatHaze(position, 1, 18, .7);
    },
    onCameraImpulse(amount) {
      cameraDamageKick = Math.min(.2, cameraDamageKick + amount);
    }
  });
  loadingUI.update(.84, 'COMBAT SYSTEMS', 'Particles, drones and impact systems...');

  const reflectionBufferSize = new THREE.Vector2();
  function updateReflectionQuality(profile) {
    if (!floorReflection) return;
    renderer.getDrawingBufferSize(reflectionBufferSize);
    const longestSide = Math.max(1, reflectionBufferSize.x, reflectionBufferSize.y);
    floorReflection.resolutionScale = Math.min(1, profile.reflectorSize / longestSide);
  }

  const graphicsManager = new GraphicsManager({
    allowUltra: !(touchMode && !highEndDevice),
    applyProfile(profile, { mode, initial }) {
      renderScale = Math.min(window.devicePixelRatio, profile.pixelRatio);
      renderer.setPixelRatio(renderScale);
      renderer.setSize(window.innerWidth, window.innerHeight);
      if (moonLight) {
        moonLight.shadow.mapSize.set(profile.shadowSize, profile.shadowSize);
        if (moonLight.shadow.map) { moonLight.shadow.map.dispose(); moonLight.shadow.map = null; }
      }
      updateReflectionQuality(profile);
      renderPipeline.setQuality(profile);
      facadeSystem.setQuality(profile);
      atmosphereSystem.setQuality(profile);
      weatherSystem.setQuality(profile);
      explosionSystem.setQuality(profile);
      // Ricostruisce i modelli delle armi quando si passa da/a ULTRA.
      if (mode === 'ultra' !== weaponDetailUltra) {
        weaponDetailUltra = mode === 'ultra';
        applyWeaponDetail();
      }
      if (!initial) toast(`<b>${t('toast.renderLabel')}</b> · ${profile.name}`);
    },
    onStatus(status) { hudController.setGraphicsStatus(`${rendererBackend} · ${status}`); },
    onTransition(state) {
      if (state.active) {
        loadingUI.showModal(state.label, state.detail);
        loadingUI.update(state.progress, state.label, state.detail);
      } else {
        loadingUI.hideModal({ hideOverlay: isGameplayActive() });
        syncHudVisibility();
      }
    }
  });
  graphicsManager.init();
  if (visualQualityKey) {
    const profile = QUALITY_PROFILES[visualQualityKey];
    graphicsManager.profile = profile;
    graphicsManager.applyProfile(profile, { mode: visualQualityKey === 'ultra' ? 'ultra' : 'auto', initial: true });
    graphicsManager.mode = 'diagnostic';
    graphicsManager.onStatus(profile.name, visualQualityKey === 'ultra' ? 'ultra' : 'auto');
  }
  const visualBurstPosition = new THREE.Vector3(0, .3, -6);
  let lastVisualEvent = -99;
  loadingUI.update(.92, 'FINAL CHECK', 'Syncing HUD and graphics profiles...');
  const settingsPanelRef = hudController.mountSettings(overlayEl, {
    qualityMode: graphicsManager.mode,
    language: getLanguage(),
    mix: audio.mix,
    sensitivity: mouseSensitivity,
    allowUltra: !(touchMode && !highEndDevice),
    onLanguage: lang => applyLanguage(lang),
    onQuality: mode => {
      graphicsManager.setMode(mode);
      // Riallinea la selezione visiva allo stato reale (setMode può ignorare la
      // richiesta durante la transizione ULTRA, vedi B7).
      settingsPanelRef?.syncMode?.(graphicsManager.mode);
    },
    onMix: partial => audio.setMix(partial),
    onSensitivity: value => {
      mouseSensitivity = value;
      storeSensitivity(value);
    },
    onReset: resetLevel
  });

  /* ============================================================
     7C. UNITÀ SENTINELLA, FUOCO NEMICO E LOOP A ONDATE
     ============================================================ */
  const hostileShots=[];
  // Geometria del nucleo e materiali sono CONDIVISI (vedi shotCoreMaterial /
  // shotTrailMaterial); mesh, sprite e geometria del tracer vengono riciclati
  // dal pool P3 (acquireShotEntry/releaseShotEntry, sezione 10).
  function disposeHostileShot(shot) {
    scene.remove(shot.mesh, shot.trail);
    // P3: l'entry torna nel pool (mesh/sprite/trail riciclati); solo gli
    // eccedenti il tetto vengono distrutti.
    releaseShotEntry(shot);
  }
  const ammoPickups=[];
  const ammoPickupGeometry = new THREE.OctahedronGeometry(.22, 0);
  const ammoPickupRingGeometry = new THREE.TorusGeometry(.3, .028, 6, 18);
  const ammoPickupMaterial = new THREE.MeshStandardMaterial({
    color: 0xffc857, emissive: 0x8a4d00, emissiveIntensity: 1.8,
    metalness: .55, roughness: .28
  });
  const ammoPickupRingMaterial = new THREE.MeshBasicMaterial({
    color: 0xffe2a0, transparent: true, opacity: .82,
    blending: THREE.AdditiveBlending, depthWrite: false
  });
  // Cuore = pickup di una vita: ogni Apex (boss d'ondata) ne lascia cadere uno.
  // Geometria/materiali condivisi (come ammoPickup*): i cuori a terra non
  // allocano risorse per istanza.
  const heartPickups=[];
  const heartShape = new THREE.Shape();
  heartShape.moveTo(.5, .5);
  heartShape.bezierCurveTo(.5, .5, .4, 0, 0, 0);
  heartShape.bezierCurveTo(-.6, 0, -.6, .7, -.6, .7);
  heartShape.bezierCurveTo(-.6, 1.1, -.3, 1.54, .5, 1.9);
  heartShape.bezierCurveTo(1.2, 1.54, 1.6, 1.1, 1.6, .7);
  heartShape.bezierCurveTo(1.6, .7, 1.6, 0, 1, 0);
  heartShape.bezierCurveTo(.7, 0, .5, .5, .5, .5);
  const heartGeometry = new THREE.ExtrudeGeometry(heartShape, {
    depth: .16, bevelEnabled: true, bevelSize: .05, bevelThickness: .05, bevelSegments: 3
  });
  const heartRingGeometry = new THREE.TorusGeometry(.5, .03, 6, 24);
  const heartMaterial = new THREE.MeshStandardMaterial({
    color: 0xff3b5c, emissive: 0x9a0a2c, emissiveIntensity: 1.6, metalness: .4, roughness: .3
  });
  const heartRingMaterial = new THREE.MeshBasicMaterial({
    color: 0xff8fa5, transparent: true, opacity: .7,
    blending: THREE.AdditiveBlending, depthWrite: false
  });

  function spawnHeartDrop(position) {
    const group = new THREE.Group();
    const heart = new THREE.Mesh(heartGeometry, heartMaterial);
    // Centra la shape (x 0..1.6, y 0..1.9) sull'origine del gruppo: la translate
    // va scalata SULLA scala del mesh (p' = position + scale*p), altrimenti il
    // cuore finisce ~0.7u più in basso (mezzo sotto il pavimento).
    heart.position.set(-.16, -.19, 0);
    heart.scale.setScalar(.2);
    group.add(heart);
    const ring = new THREE.Mesh(heartRingGeometry, heartRingMaterial);
    ring.rotation.x = Math.PI / 2;
    ring.scale.setScalar(.62);
    group.add(ring);
    const startY = Math.max(.85, Number.isFinite(position?.y) ? position.y : .85);
    group.position.set(
      Number.isFinite(position?.x) ? position.x : playerBody.position.x,
      startY,
      Number.isFinite(position?.z) ? position.z : playerBody.position.z
    );
    group.traverse(object => { if (object.isMesh) object.castShadow = true; });
    scene.add(group);
    heartPickups.push({ group, age: 0, startY, baseY: .68, phase: Math.random() * Math.PI * 2 });
  }

  function updateHeartPickups(delta, time) {
    for (let i = heartPickups.length - 1; i >= 0; i--) {
      const pickup = heartPickups[i];
      pickup.age += delta;
      const settle = Math.min(1, pickup.age / .45);
      pickup.group.position.y = THREE.MathUtils.lerp(pickup.startY, pickup.baseY, settle)
        + Math.sin(time * 3.1 + pickup.phase) * .08;
      pickup.group.rotation.y += delta * 1.8;
      // A vite piene il cuore resta a terra (coerente con B8 per le munizioni):
      // non viene consumato né spamma toast finché il giocatore sta sopra.
      if (gameState.lives < gameState.maxLives
        && pickup.group.position.distanceToSquared(playerBody.position) <= 1.15 * 1.15) {
        gameState.lives = Math.min(gameState.maxLives, gameState.lives + 1);
        audio.pickup();
        toast(`<b>${t('toast.heart')}</b> · ${t('toast.lifeGained')}`);
        updateHUD();
        scene.remove(pickup.group);
        heartPickups.splice(i, 1);
        continue;
      }
      if (pickup.age >= CONFIG.heartDropLifetime) {
        scene.remove(pickup.group);
        heartPickups.splice(i, 1);
      }
    }
  }

  function clearHeartPickups() {
    for (const pickup of heartPickups) scene.remove(pickup.group);
    heartPickups.length = 0;
  }
  // Drop unico del primo Apex: visuale distinta dal normale rifornimento, con
  // rotaie parallele e bobine energetiche in stile railgun arena shooter.
  const railgunPickups=[];
  const railgunPickupBodyGeometry = new RoundedBoxGeometry(.14,.18,1.08,3,.02);
  const railgunPickupRailGeometry = new THREE.BoxGeometry(.035,.045,1.2);
  const railgunPickupCoilGeometry = new THREE.TorusGeometry(.105,.018,8,18);
  const railgunPickupBodyMaterial = new THREE.MeshStandardMaterial({
    color: 0x243746, emissive: 0x063a52, emissiveIntensity: 1.25,
    metalness: .92, roughness: .2
  });
  const railgunPickupRailMaterial = new THREE.MeshBasicMaterial({
    color: 0x9efaff, toneMapped: false, blending: THREE.AdditiveBlending
  });
  const railgunPickupCoilMaterial = new THREE.MeshBasicMaterial({
    color: 0x00e5ff, toneMapped: false, blending: THREE.AdditiveBlending
  });
  const playerTarget = new THREE.Vector3();
  const hostilePlayerPoint = new THREE.Vector3();
  const hostileFrom = new CANNON.Vec3();
  const hostileTo = new CANNON.Vec3();
  // Sweep segmento→punto per il hit test dei colpi nemici contro il giocatore
  // (riveled da B4): evita il tunneling a FPS bassi, come già fatto per i
  // proiettili del giocatore contro i droni.
  const hostileSegment = new THREE.Line3();
  const hostileClosest = new THREE.Vector3();
  let aliveEnemyCount = 0;
  let apexSpawned = false;
  let railgunDropSpawned = false;
  // S7: cooldown del danno da contatto della carica VANGUARD (una volta per
  // ~0.9s invece di ogni frame: 16 frame di overlap facevano ~350 danno).
  let apexChargeContactCooldown = 0;
  const droneSystem = new DroneSystem({
    scene,
    camera,
    targetLayer: targetLayerEl,
    targetProvider: () => playerTarget.set(playerBody.position.x, playerBody.position.y + .5, playerBody.position.z),
    // M9: limite dell'arena dei droni derivato dalla stessa geometria del
    // giocatore (arenaSize/wallThick/playerRadius): se l'arena cambia, il volo
    // dei droni segue i muri invece di restare a ±18 fisso.
    arenaLimit: playerArenaLimit,
    onFire: drone => spawnHostileShot(drone),
    onTelegraph: drone => {
      const projected = drone.position.clone().project(camera);
      audio.droneTelegraph(Math.max(-.9, Math.min(.9, projected.x)));
    },
    onApexAttack: (apex, type) => handleApexAttack(apex, type),
    onApexContact: () => {},
    onApexMine: apex => spawnVexMines(apex),
    onApexSummon: apex => summonMinions(apex),
    onApexShockwave: apex => apexShockwave(apex),
    onApexTelegraph: apex => audio.apexTelegraph(panForWorld(apex.group.position))
  });
  const drones = droneSystem.drones;
  const hostileRay=new CANNON.Ray(),hostileHit=new CANNON.RaycastResult();


  function spawnWave(announce=true){
    // S6: i campi minati VEX non devono sopravvivere al cambio d'ondata.
    clearVexMines();
    const encounter=getBossEncounter(gameState.wave);
    const count=encounter.kind==='standard'?Math.min(4+gameState.wave,9):0;
    gameState.waveTargets=encounter.kind==='standard'?count:encounter.bossCount;
    gameState.waveKills=0;gameState.waveDelay=0;
    apexSpawned=false;
    aliveEnemyCount=droneSystem.spawnWave(gameState.wave,count);
    // A3: stinger audio distintivo solo per le nuove ondate annunciate.
    if(announce&&encounter.kind==='standard'){showWave();audio.waveStart();}
    if(encounter.kind==='standard')toast(`<b>SCANNER</b> · ${t('toast.scanner',{count})}`);
    else spawnApexUnit();
    updateHUD();
  }

  function spawnHostileShot(drone,dmg){
    // P3: entry riciclato dal pool — niente mesh/geometrie/cloni allocati.
    const entry=acquireShotEntry(hostileShotGeometry,0xff3155,.5,.7);
    const origin=drone.group.position;
    shotAimTmp.set(playerBody.position.x,playerBody.position.y+.55,playerBody.position.z).sub(origin);
    if(shotAimTmp.lengthSq()>.0001)shotAimTmp.normalize();
    entry.vel.copy(shotAimTmp).multiplyScalar(18+gameState.wave*.65);
    entry.pos.copy(origin);entry.prev.copy(origin);entry.rayFrom.copy(origin);
    entry.age=0;entry.dmg=dmg;entry.rayToggle=false;
    entry.mesh.position.copy(origin);
    scene.add(entry.mesh);scene.add(entry.trail);
    hostileShots.push(entry);
    shotCamTmp.copy(origin).project(camera);
    audio.enemyShot(Math.max(-.85,Math.min(.85,shotCamTmp.x)));
  }

  // --- Apex Sentinel: stato (mine VEX + onde d'urto) e helper ---
  const vexMines=[];           // mine EMP di VEX (danneggiano una volta armate)
  const apexShockwaves=[];     // anelli visivi dell'onda d'urto di VEX

  function spawnApexUnit(){
    const encounter=getBossEncounter(gameState.wave);
    apexSpawned=true;
    if(encounter.kind==='gauntlet'){
      const apexes=droneSystem.spawnApexSquad(gameState.wave);
      showWave(t('apex.gauntlet.title'),t('apex.gauntlet.subtitle'));
      audio.apexGauntletStart();
      toast(`<b>APX-COUNCIL</b> · ${t('toast.gauntlet')}`);
      updateHUD();
      return apexes;
    }
    if(encounter.kind==='final'){
      const mega=droneSystem.spawnMegaBoss(gameState.wave);
      showWave(t('apex.final.title'),t('apex.final.subtitle'));
      audio.megaBossStart();
      toast(`<b>OMEGA</b> · ${t('toast.mega',{name:t(mega.nameKey)})}`);
      updateHUD();
      return [mega];
    }
    // Crea l'Apex standard dell'ondata corrente: scende dall'alto.
    const apex=droneSystem.spawnApex(gameState.wave);
    showWave(t('apex.title',{name:t(apex.nameKey),tier:apex.tier}),t('apex.subtitle'));
    audio.apexStart();
    toast(`<b>APX-T${apex.tier}</b> · ${t('toast.apex',{name:t(apex.nameKey)})}`);
    updateHUD();
    return [apex];
  }

  function damageApex(apex,amount,position,countHit=true){
    if(!apex||!apex.alive)return;
    const result=droneSystem.applyApexDamage(apex,amount);
    if(countHit)gameState.hits++;
    gameState.comboTimer=CONFIG.comboWindow;
    showHitmarker(result.killed);
    const impactPosition=result.position||position||apex.group.position;
    const apexi18n=t(apex.nameKey);
    if(result.armorBroken){toast(`<b>${apexi18n}</b> · ${t('toast.armor')}`);audio.apexArmorBreak(panForWorld(impactPosition));}
    if(result.phaseChanged){toast(`<b>${apexi18n}</b> · ${t('toast.phase')}`);audio.apexPhase(panForWorld(impactPosition));}
    if(result.killed){
      // S5: l'eliminazione dell'Apex conta nell'obiettivo dell'ondata e alza
      // il combo come per i droni (prima la barra missione restava a 5/5).
      gameState.waveKills++;
      gameState.combo=Math.min(CONFIG.comboMax,gameState.combo+CONFIG.comboKillStep);
      const bossScore=apex.mega?ENDGAME_TUNING.megaBoss.scoreKill:APEX_TUNING.scoreKill;
      const earned=Math.round(bossScore*gameState.combo);
      gameState.score+=earned;
      showScore(earned,t(apex.mega?'score.mega':'score.apex'));
      audio.apexKill(panForWorld(impactPosition));
      const healed=Math.min(APEX_TUNING.healKill,Math.max(0,CONFIG.maxHealth-gameState.health));
      gameState.health+=healed;
      spawnAmmoDrop(impactPosition);
      spawnAmmoDrop({x:impactPosition.x+(apex.random()>.5?1.4:-1.4),y:impactPosition.y,z:impactPosition.z+(apex.random()>.5?1.2:-1.2)});
      // Ogni boss d'ondata lascia cadere un cuore: una vita recuperabile.
      spawnHeartDrop(impactPosition);
      // Il boss dell'ondata 1 è la ricompensa di progressione: lascia una
      // railgun persistente, raccolta dal giocatore entrando nel suo raggio.
      if(gameState.wave===1)spawnRailgunDrop(impactPosition);
      // I boss successivi droppano le armi nuove: VULCAN, HELLSTORM, PYRE.
      // Ogni spawnWeaponDrop gating internamente sull'onda (ogni 4, stesso
      // archetipo) e sullo stato di sblocco: se il drop è mancato/scaduto,
      // riappare alla prossima ondata dello stesso archetipo (T2).
      spawnWeaponDrop('minigun',impactPosition);
      spawnWeaponDrop('rpg',impactPosition);
      spawnWeaponDrop('flame',impactPosition);
      explosionSystem.explode(impactPosition,apex.coreMaterial.emissive.getHex());
      // Secondo scoppio più ampio per la kill speciale (post-frame).
      window.setTimeout(()=>{
        if(!gameState.dead&&!apex.alive)explosionSystem.explode(impactPosition,apex.coreMaterial.emissive.getHex());
      },60);
      toast(`<b>${apexi18n}</b> · ${t(apex.mega?'toast.megaDown':'toast.apexDown')}`);
      if(healed>0)toast(`<b>RECOVERY</b> · ${t('toast.heal',{amount:healed})}`);
      if(apex.archetypeId==='vex')spawnMinis(impactPosition,apex);
    }else{
      gameState.score+=Math.round(CONFIG.impactScore*gameState.combo);
      showScore(Math.round(CONFIG.impactScore*gameState.combo),t('score.impact'));
      audio.playImpact({pan:panForWorld(impactPosition)});
    }
    updateHUD();
  }

  function spawnApexProjectile(apex,vel,color){
    // P3: entry riciclato dal pool (chiave geometria Apex/colore/.55/.75).
    const entry=acquireShotEntry(apexShotGeometry,color,.55,.75);
    const origin=apex.group.position;
    entry.vel.copy(vel);
    entry.pos.copy(origin);entry.prev.copy(origin);entry.rayFrom.copy(origin);
    entry.age=0;entry.dmg=apex.damage;entry.rayToggle=false;
    entry.mesh.position.copy(origin);
    scene.add(entry.mesh);scene.add(entry.trail);
    hostileShots.push(entry);
  }

  const axisY=new THREE.Vector3(0,1,0);
  function handleApexAttack(apex,type){
    const color=apex.coreMaterial.emissive.getHex();
    if(type==='charge'){audio.apexCharge();return;}
    if(type==='megaSpiral'){
      const count=28+apex.megaPhase*4;
      for(let i=0;i<count;i++){
        const a=i/count*Math.PI*2+elapsed*.7;
        const vel=new THREE.Vector3(Math.cos(a),Math.sin(i*.9)*.12,Math.sin(a)).multiplyScalar(14+apex.megaPhase);
        spawnApexProjectile(apex,vel,color);
      }
      audio.megaSpiral();
      return;
    }
    if(type==='megaLance'){
      const base=new THREE.Vector3(
        playerBody.position.x-apex.group.position.x,
        (playerBody.position.y+.5)-apex.group.position.y,
        playerBody.position.z-apex.group.position.z
      ).normalize();
      const rays=7+apex.megaPhase*2;
      for(let i=0;i<rays;i++){
        const offset=i-(rays-1)/2;
        const d=base.clone().applyAxisAngle(axisY,offset*.055);
        spawnApexProjectile(apex,d.multiplyScalar(23),0xffffff);
      }
      audio.megaLance();
      return;
    }
    if(type==='megaBombard'){
      const count=8+apex.megaPhase*2;
      for(let i=0;i<count;i++){
        const target=new THREE.Vector3(
          playerBody.position.x+(apex.random()-.5)*10,
          playerBody.position.y+.5,
          playerBody.position.z+(apex.random()-.5)*10
        );
        const d=target.sub(apex.group.position).normalize().multiplyScalar(12+apex.random()*4);
        spawnApexProjectile(apex,d,i%2?color:0xff4f5f);
      }
      audio.megaBombard();
      return;
    }
    if(type==='radial'){
      const count=12+Math.min(6,apex.tier*2);
      for(let i=0;i<count;i++){
        const a=i/count*Math.PI*2;
        const vel=new THREE.Vector3(Math.cos(a),0,Math.sin(a)).multiplyScalar(12.5);
        vel.y=.5;
        spawnApexProjectile(apex,vel,color);
      }
      audio.apexBarrage();
      return;
    }
    if(type==='burst'){
      const base=new THREE.Vector3(
        playerBody.position.x-apex.group.position.x,
        (playerBody.position.y+.5)-apex.group.position.y,
        playerBody.position.z-apex.group.position.z
      ).normalize();
      for(let i=-1;i<=1;i++){
        const d=base.clone().applyAxisAngle(axisY,i*.16);
        spawnApexProjectile(apex,d.multiplyScalar(16),color);
      }
      audio.apexShot(panForWorld(apex.group.position));
      return;
    }
    // shot singolo a distanza
    const dir=new THREE.Vector3(
      playerBody.position.x-apex.group.position.x,
      (playerBody.position.y+.5)-apex.group.position.y,
      playerBody.position.z-apex.group.position.z
    );
    if(dir.lengthSq()>.0001)dir.normalize();
    spawnApexProjectile(apex,dir.multiplyScalar(17),color);
    audio.apexShot(panForWorld(apex.group.position));
  }

  function spawnMinis(position,apex){
    const count=APEX_TUNING.vexSplitMinis;
    for(let i=0;i<count;i++){
      const mini=droneSystem.createDrone(droneSystem.drones.length,2);
      mini.health=Math.max(40,Math.round(60+gameState.wave*6));mini.maxHealth=mini.health;
      mini.group.scale.setScalar(.6);mini.radius=.42;
      mini.state='engage';mini.stateTimer=0;
      const x=position.x+(i?1:-1)*1.1,z=position.z+(i===0?0:.9);
      mini.anchor.set(x,position.y||2.5,z);mini.position.set(x,position.y||2.5,z);mini.group.position.copy(mini.position);
      droneSystem.drones.push(mini);
    }
    // I rinforzi entrano nel conteggio dell'obiettivo: senza questo waveKills
    // superava waveTargets (obiettivo "7/5" e barra di missione oltre il 100%).
    gameState.waveTargets+=count;
    audio.apexSplit();
    toast(`<b>${t(apex.nameKey)}</b> · ${t('toast.split')}`);
    updateHUD();
  }

  function summonMinions(apex){
    const count=apex.mega?6:apex.tier>=2?4:APEX_TUNING.sentinelMinions;
    for(let i=0;i<count;i++){
      const mini=droneSystem.createDrone(droneSystem.drones.length,count);
      mini.health=Math.max(80,Math.round(90+gameState.wave*10));mini.maxHealth=mini.health;
      mini.group.scale.setScalar(.88);mini.radius=.68;
      const a=i/count*Math.PI*2+apex.phase;
      const x=apex.group.position.x+Math.cos(a)*2.6,z=apex.group.position.z+Math.sin(a)*2.6;
      mini.anchor.set(x,apex.group.position.y,z);mini.position.set(x,apex.group.position.y,z);mini.group.position.copy(mini.position);
      droneSystem.drones.push(mini);
    }
    // Come per spawnMinis: i minion sono bersagli aggiuntivi dell'ondata.
    gameState.waveTargets+=count;
    audio.apexSummon();
    toast(`<b>${t(apex.nameKey)}</b> · ${t('toast.summon',{count})}`);
    updateHUD();
  }

  // Geometrie e materiali delle mine sono condivisi come per i pickup munizioni
  // (ammoPickupGeometry): prima ogni mina allocava 2 geometrie + 2 materiali che
  // nessuno dei tre punti di rimozione liberava.
  const vexMineGeometry=new THREE.SphereGeometry(.2,10,8);
  const vexMineRingGeometry=new THREE.TorusGeometry(.34,.03,6,16);
  const vexMineMaterial=new THREE.MeshStandardMaterial({color:0xffc857,emissive:0x8a4d00,emissiveIntensity:2,metalness:.5,roughness:.3});
  const vexMineRingMaterial=new THREE.MeshBasicMaterial({color:0xffe2a0,transparent:true,opacity:.85,blending:THREE.AdditiveBlending,depthWrite:false});

  function spawnVexMines(apex){
    const count=apex.tier>=2?3:APEX_TUNING.vexMineCount;
    for(let i=0;i<count;i++){
      const mine=new THREE.Mesh(vexMineGeometry,vexMineMaterial);
      const ring=new THREE.Mesh(vexMineRingGeometry,vexMineRingMaterial);
      const group=new THREE.Group();
      group.add(mine,ring);
      const a=i/Math.max(1,count)*Math.PI*2+apex.random()*1.2;
      const r=3.5+apex.random()*2;
      group.position.set(apex.group.position.x+Math.cos(a)*r,.45,apex.group.position.z+Math.sin(a)*r);
      scene.add(group);
      vexMines.push({group,ring,age:0,arm:1.3,exploded:false,life:25,phase:Math.random()*Math.PI*2});
    }
    audio.apexMine();
  }

  function updateVexMines(delta,time){
    for(let i=vexMines.length-1;i>=0;i--){
      const m=vexMines[i];
      m.age+=delta;
      m.group.rotation.y+=delta*2;
      m.group.position.y=.45+Math.sin(time*3+m.phase)*.06;
      // Le mine si "armano" dopo arm secondi, poi esplodono a contatto col giocatore.
      if(m.age>=m.arm&&!m.exploded&&m.group.position.distanceToSquared(playerBody.position)<=2.2*2.2){
        m.exploded=true;
        const pos=m.group.position.clone();
        scene.remove(m.group);
        vexMines.splice(i,1);
        damagePlayer(CONFIG.hostileDmgBase+gameState.wave*CONFIG.hostileDmgWave+6);
        explosionSystem.explode(pos,0xffc857);
        audio.apexMineBoom(panForWorld(pos));
      }
      if(m.age>=m.life){scene.remove(m.group);vexMines.splice(i,1);}
    }
  }

  function clearVexMines(){
    for(const m of vexMines)scene.remove(m.group);
    vexMines.length=0;
  }

  function apexShockwave(apex){
    // Anello visivo espanso + spinta sul giocatore + danno.
    const geo=new THREE.RingGeometry(.5,.8,32);
    const mat=new THREE.MeshBasicMaterial({
      color:apex.coreMaterial.emissive.getHex(),
      transparent:true,opacity:.85,side:THREE.DoubleSide,
      blending:THREE.AdditiveBlending,depthWrite:false
    });
    const ring=new THREE.Mesh(geo,mat);
    ring.position.copy(apex.group.position);
    ring.position.y=1.1;
    ring.rotation.x=-Math.PI/2;
    scene.add(ring);
    apexShockwaves.push({mesh:ring,age:0,life:.7});
    const push=new CANNON.Vec3(
      apex.group.position.x-playerBody.position.x,
      0,
      apex.group.position.z-playerBody.position.z
    );
    const len=Math.hypot(push.x,push.z);
    if(len>.01){push.x/=len;push.z/=len;}
    const force=apex.mega?14:7;
    playerBody.velocity.x+=push.x*force;
    playerBody.velocity.z+=push.z*force;
    damagePlayer(apex.mega?22:8);
    if(apex.mega)audio.megaShockwave();else audio.apexShockwave();
  }

  function updateApexShockwaves(delta){
    for(let i=apexShockwaves.length-1;i>=0;i--){
      const s=apexShockwaves[i];
      s.age+=delta;
      const t=Math.min(1,s.age/s.life);
      s.mesh.scale.setScalar(1+t*6);
      s.mesh.material.opacity=(1-t)*.85;
      if(t>=1){scene.remove(s.mesh);s.mesh.geometry.dispose();s.mesh.material.dispose();apexShockwaves.splice(i,1);}
    }
  }

  function spawnAmmoDrop(position) {
    const mesh = new THREE.Group();
    const core = new THREE.Mesh(ammoPickupGeometry, ammoPickupMaterial);
    const ring = new THREE.Mesh(ammoPickupRingGeometry, ammoPickupRingMaterial);
    ring.rotation.x = Math.PI / 2;
    mesh.add(core, ring);
    const startY = Math.max(.55, Number.isFinite(position?.y) ? position.y : .55);
    mesh.position.set(
      Number.isFinite(position?.x) ? position.x : playerBody.position.x,
      startY,
      Number.isFinite(position?.z) ? position.z : playerBody.position.z
    );
    mesh.castShadow = true;
    scene.add(mesh);
    ammoPickups.push({ mesh, age: 0, startY, baseY: .42, phase: Math.random() * Math.PI * 2 });
  }

  function spawnRailgunDrop(position) {
    if (gameState.wave !== 1 || gameState.railgunUnlocked || railgunDropSpawned) return;
    const group = new THREE.Group();
    const body = new THREE.Mesh(railgunPickupBodyGeometry, railgunPickupBodyMaterial);
    const rails = [-.105, .105].map(x => {
      const rail = new THREE.Mesh(railgunPickupRailGeometry, railgunPickupRailMaterial);
      rail.position.set(x, .055, 0);
      return rail;
    });
    const coils = [-.28, 0, .28].map(z => {
      const coil = new THREE.Mesh(railgunPickupCoilGeometry, railgunPickupCoilMaterial);
      coil.rotation.x = Math.PI / 2;
      coil.position.set(0, .055, z);
      coil.scale.y = .62;
      return coil;
    });
    group.add(body, ...rails, ...coils);
    group.rotation.y = Math.PI * .25;
    group.rotation.z = -.16;
    const startY = Math.max(.85, Number.isFinite(position?.y) ? position.y : .85);
    group.position.set(
      Number.isFinite(position?.x) ? position.x : playerBody.position.x,
      startY,
      Number.isFinite(position?.z) ? position.z : playerBody.position.z
    );
    group.traverse(object => { if (object.isMesh) object.castShadow = true; });
    scene.add(group);
    railgunPickups.push({ group, coils, age: 0, startY, baseY: .68, phase: Math.random() * Math.PI * 2 });
    railgunDropSpawned = true;
    toast(`<b>${t('weapon.railgun')}</b> · ${t('toast.railgunDrop')}`);
  }

  function updateRailgunPickups(delta, time) {
    for (let i = railgunPickups.length - 1; i >= 0; i--) {
      const pickup = railgunPickups[i];
      pickup.age += delta;
      const settle = Math.min(1, pickup.age / .65);
      pickup.group.position.y = THREE.MathUtils.lerp(pickup.startY, pickup.baseY, settle)
        + Math.sin(time * 3.1 + pickup.phase) * .1;
      pickup.group.rotation.y += delta * 1.5;
      for (const coil of pickup.coils) coil.rotation.z += delta * 4.2;

      if (pickup.group.position.distanceToSquared(playerBody.position) <= 1.65 * 1.65) {
        gameState.railgunUnlocked = true;
        gameState.railgunAmmo = RAILGUN_TUNING.magazineSize;
        gameState.railgunReserve = RAILGUN_TUNING.reserveAmmo;
        scene.remove(pickup.group);
        railgunPickups.splice(i, 1);
        setWeapon('railgun', false);
        audio.railgunPickup();
        toast(`<b>${t('weapon.railgun')}</b> · ${t('toast.railgunReady')}`);
        updateHUD();
        continue;
      }
      if (pickup.age >= RAILGUN_TUNING.pickupLifetime) {
        scene.remove(pickup.group);
        railgunPickups.splice(i, 1);
      }
    }
  }

  function clearRailgunPickups() {
    for (const pickup of railgunPickups) scene.remove(pickup.group);
    railgunPickups.length = 0;
  }

  // --- Drop delle armi nuove (VULCAN/HELLSTORM/PYRE) dai boss dopo il primo. ---
  // Ogni arma viene sbloccata una volta sola (wave 2/3/4) e, se il giocatore
  // la raccoglie, resta in possesso per la run. Riusa la stessa logica del
  // drop railgun ma con un visuale dedicato per arma.
  const weaponPickups = [];
  const weaponDropSpawned = { minigun: false, rpg: false, flame: false };
  const wpMetal = new THREE.MeshStandardMaterial({ color: 0x2a3a46, metalness: .9, roughness: .3, emissive: 0x0a2a3a, emissiveIntensity: .4 });
  const wpDark = new THREE.MeshStandardMaterial({ color: 0x0c0f13, metalness: .92, roughness: .4 });
  const wpAccent = new THREE.MeshBasicMaterial({ color: 0xffb24a, toneMapped: false, blending: THREE.AdditiveBlending });

  function buildWeaponPickupVisual(id) {
    const group = new THREE.Group();
    if (id === 'minigun') {
      const drum = new THREE.Mesh(new THREE.CylinderGeometry(.15, .15, .12, 12), wpMetal);
      drum.rotation.x = Math.PI / 2;
      group.add(drum);
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2;
        const b = new THREE.Mesh(new THREE.CylinderGeometry(.026, .026, .32, 8), wpDark);
        b.rotation.x = Math.PI / 2;
        b.position.set(Math.cos(a) * .11, Math.sin(a) * .11, -.16);
        group.add(b);
      }
      const ring = new THREE.Mesh(new THREE.TorusGeometry(.15, .02, 8, 18), wpAccent);
      ring.rotation.x = Math.PI / 2;
      group.add(ring);
    } else if (id === 'rpg') {
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(.1, .1, .62, 14), wpDark);
      tube.rotation.x = Math.PI / 2;
      group.add(tube);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(.1, .02, 8, 20), wpAccent);
      ring.rotation.x = Math.PI / 2;
      group.add(ring);
      const nose = new THREE.Mesh(new THREE.ConeGeometry(.09, .16, 12), wpMetal);
      nose.rotation.x = -Math.PI / 2;
      nose.position.z = -.38;
      group.add(nose);
    } else {
      const tank = new THREE.Mesh(new THREE.CylinderGeometry(.11, .11, .16, 12), wpMetal);
      tank.rotation.z = Math.PI / 2;
      group.add(tank);
      const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(.032, .032, .22, 8), wpDark);
      nozzle.rotation.x = Math.PI / 2;
      nozzle.position.z = -.22;
      group.add(nozzle);
      const flameG = new THREE.Mesh(new THREE.SphereGeometry(.05, 8, 8), wpAccent);
      flameG.position.z = -.34;
      group.add(flameG);
    }
    group.traverse(o => { if (o.isMesh) o.castShadow = true; });
    return group;
  }

  function spawnWeaponDrop(id, position) {
    if (id === 'railgun') { spawnRailgunDrop(position); return; }
    const tuning = WEAPON_TUNING[id];
    // T2: la guardia era `wave === unlockWave` (solo onda 2/3/4). Dato che il
    // roster cicla ogni 4 ondate (2,6,10 = stesso archetipo), si riapre il drop
    // alle ondate successive dello stesso archetipo finché l'arma non è stata
    // raccolta — evita il soft-lock se il primo drop scade/è mancato.
    const waveOk = gameState.wave >= tuning.unlockWave
      && (gameState.wave - tuning.unlockWave) % 4 === 0;
    if (!tuning || !waveOk || weaponUnlocked(id) || weaponDropSpawned[id]) return;
    const group = buildWeaponPickupVisual(id);
    group.rotation.y = Math.PI * .25;
    group.rotation.z = -.16;
    const startY = Math.max(.85, Number.isFinite(position?.y) ? position.y : .85);
    group.position.set(
      Number.isFinite(position?.x) ? position.x : playerBody.position.x,
      startY,
      Number.isFinite(position?.z) ? position.z : playerBody.position.z
    );
    scene.add(group);
    weaponPickups.push({ id, group, age: 0, startY, baseY: .68, phase: Math.random() * Math.PI * 2 });
    weaponDropSpawned[id] = true;
    toast(`<b>${t(tuning.nameKey)}</b> · ${t('toast.weaponDrop')}`);
  }

  function updateWeaponPickups(delta, time) {
    for (let i = weaponPickups.length - 1; i >= 0; i--) {
      const pickup = weaponPickups[i];
      pickup.age += delta;
      const settle = Math.min(1, pickup.age / .65);
      pickup.group.position.y = THREE.MathUtils.lerp(pickup.startY, pickup.baseY, settle)
        + Math.sin(time * 3.1 + pickup.phase) * .1;
      pickup.group.rotation.y += delta * 1.8;

      if (pickup.group.position.distanceToSquared(playerBody.position) <= 1.65 * 1.65) {
        const tuning = WEAPON_TUNING[pickup.id];
        unlockWeapon(pickup.id);
        setWeaponAmmo(pickup.id, tuning.magazineSize, tuning.reserveAmmo);
        scene.remove(pickup.group);
        weaponPickups.splice(i, 1);
        setWeapon(pickup.id, false);
        audio.railgunPickup();
        toast(`<b>${t(tuning.nameKey)}</b> · ${t('toast.weaponReady')}`);
        updateHUD();
        continue;
      }
      if (pickup.age >= RAILGUN_TUNING.pickupLifetime) {
        scene.remove(pickup.group);
        weaponPickups.splice(i, 1);
        // T2: il drop è scaduto senza essere raccolto → riapri la possibilità
        // di un nuovo drop alla prossima ondata dello stesso archetipo.
        weaponDropSpawned[pickup.id] = false;
      }
    }
  }

  function clearWeaponPickups() {
    for (const pickup of weaponPickups) scene.remove(pickup.group);
    weaponPickups.length = 0;
  }

  function updateAmmoPickups(delta, time) {
    for (let i = ammoPickups.length - 1; i >= 0; i--) {
      const pickup = ammoPickups[i];
      pickup.age += delta;
      const settle = Math.min(1, pickup.age / .45);
      pickup.mesh.position.y = THREE.MathUtils.lerp(pickup.startY, pickup.baseY, settle)
        + Math.sin(time * 3.4 + pickup.phase) * .06;
      pickup.mesh.rotation.y += delta * 2.8;
      pickup.mesh.children[1].rotation.z += delta * 3.7;

      if (pickup.mesh.position.distanceToSquared(playerBody.position) <= 1.15 * 1.15) {
        // Il rifornimento riempie la riserva dell'arma AGGANCIATA (quella in
        // mano). Vale B8: a riserva piena il pickup resta a terra.
        const w = gameState.weapon;
        const tuning = weaponTuning(w);
        const reserve = weaponReserve(w);
        // Armi con riserva (pulse, minigun, rpg, flame): riempie la riserva.
        const room = tuning.reserveAmmo - reserve;
        if (room > 0) {
          const amount = Math.min(CONFIG.ammoDropAmount, room);
          setWeaponAmmo(w, weaponAmmo(w), reserve + amount);
          audio.pickup();
          toast(`<b>${t(tuning.nameKey)}</b> · ${t('toast.ammo',{amount})}`);
          updateHUD();
          scene.remove(pickup.mesh);
          ammoPickups.splice(i, 1);
        }
        continue;
      }
      if (pickup.age >= CONFIG.ammoDropLifetime) {
        scene.remove(pickup.mesh);
        ammoPickups.splice(i, 1);
      }
    }
  }

  function clearAmmoPickups() {
    for (const pickup of ammoPickups) scene.remove(pickup.mesh);
    ammoPickups.length = 0;
  }

  // N3: countHit distingue i colpi d'arma da fuoco dal melee: l'accuracy HUD
  // è hits/shots e il melee non consuma un colpo (prima poteva superare il 100%).
  function damageDrone(drone,amount,position,countHit=true){
    if(!drone.alive)return;
    const result=droneSystem.applyDamage(drone,amount);if(countHit)gameState.hits++;gameState.comboTimer=CONFIG.comboWindow;showHitmarker(result.killed);
    const impactPosition = result.position || position || drone.group.position;
    if(result.killed){
      gameState.waveKills++;gameState.combo=Math.min(CONFIG.comboMax,gameState.combo+CONFIG.comboKillStep);
      const earned=Math.round(CONFIG.killScore*gameState.combo);gameState.score+=earned;showScore(earned,t('score.kill'));audio.explode(panForWorld(impactPosition));
      const healed = Math.min(CONFIG.killHeal, Math.max(0, CONFIG.maxHealth - gameState.health));
      gameState.health += healed;
      spawnAmmoDrop(impactPosition);
      explosionSystem.explode(impactPosition,drone.id%2?0xff4f9f:0x66efff);
      toast(`<b>${t('toast.unit',{id:String(drone.id).padStart(2,'0')})}</b> · ${t('toast.neutralized')}`);
      if (healed > 0) toast(`<b>RECOVERY</b> · ${t('toast.heal',{amount:healed})}`);
    }else{gameState.score+=Math.round(CONFIG.impactScore*gameState.combo);showScore(Math.round(CONFIG.impactScore*gameState.combo),t('score.impact'));audio.playImpact({pan:panForWorld(impactPosition)});}
    updateHUD();
  }

  function damagePlayer(amount){
    if(gameState.dead)return;
    let remaining=amount;if(gameState.shield>0){const absorbed=Math.min(gameState.shield,remaining);gameState.shield-=absorbed;remaining-=absorbed;}
    gameState.health=Math.max(0,gameState.health-remaining);gameState.lastDamage=elapsed;audio.hurt();restartClass(damageVignetteEl,'flash');cameraDamageKick=Math.min(.16,cameraDamageKick+.055);
    if(gameState.health<=0){
      // Ogni morte consuma una vita ("Link lost"): a vite esaurite la run
      // termina e riparte pulita dall'ondata 1 (vedi respawn in updateGameplay).
      gameState.lives=Math.max(0,gameState.lives-1);
      gameState.dead=true;
      gameState.combo=1;
      if(gameState.lives<=0){
        // Link terminato: la run finisce. Niente respawn automatico — allo
        // scadere del timer apriamo il menu GAME OVER (vedi endGameOver).
        gameState.gameOver=true;
        gameState.respawnTimer=2.4;
        showWave(t('wave.gameOver.title'),t('wave.gameOver.sub'));
        toast(`<b>${t('toast.warning')}</b> · ${t('toast.gameOver')}`);
      }else{
        gameState.respawnTimer=2.2;
        showWave(t('wave.lost.title'),t('wave.lost.sub'));
        toast(`<b>${t('toast.warning')}</b> · ${t('toast.lifeLost',{lives:gameState.lives})}`);
      }
    }
    updateHUD();
  }

  function respawnPlayer(){
    gameState.health=CONFIG.maxHealth;gameState.shield=CONFIG.maxShield;gameState.stamina=CONFIG.maxStamina;gameState.dead=false;resetPlayerBody();showWave(t('wave.restored.title'),t('wave.restored.sub'));
  }

  // GAME OVER: vite esaurite — la run termina qui. Congela la simulazione e
  // apre l'overlay in stato di fine partita (titolo GAME OVER, CTA = RESTART
  // RUN). Su desktop esce dal pointer lock così il CTA è cliccabile.
  function endGameOver(){
    if (touchMode) playing = false;
    clearPlayerInput();
    // L14: i cuori a terra non devono restare congelati dietro l'overlay
    // GAME OVER — puliti subito, già coperti da clearHeartPickups nel reset.
    clearHeartPickups();
    syncHudVisibility();
    overlayEl.style.display = 'flex';
    applyOverlayStateCopy(false);
    if (!touchMode && document.pointerLockElement) document.exitPointerLock();
  }

  function endVictory(){
    if(gameState.victory)return;
    gameState.victory=true;
    if(touchMode)playing=false;
    clearPlayerInput();
    clearHostileShots();
    audio.victory();
    showWave(t('wave.victory.title'),t('wave.victory.sub'));
    syncHudVisibility();
    overlayEl.style.display='flex';
    applyOverlayStateCopy(false);
    if(!touchMode&&document.pointerLockElement)document.exitPointerLock();
  }

  function updateDrones(delta,time){
    if (!gameState.started && !isGameplayActive()) return;
    // N7: gli spawn dei minion/split aggiungono droni durante la run; il flag
    // apexSpawned evita che ogni frame provi a ri-generare l'Apex dell'ondata.
    aliveEnemyCount=droneSystem.update(delta,time,{active:isGameplayActive(),dead:gameState.dead});
    const apexAliveCount=droneSystem.updateApex(delta,time,{active:isGameplayActive(),dead:gameState.dead});
    // Carica VANGUARD: danno da contatto mentre è in carica.
    if(apexChargeContactCooldown>0)apexChargeContactCooldown-=delta;
    for(const apex of droneSystem.apexes){
      if(apex.alive&&apex.state==='charge'&&apex.chargeDir&&isGameplayActive()&&!gameState.dead){
        const dx=apex.group.position.x-playerBody.position.x;
        const dz=apex.group.position.z-playerBody.position.z;
        if(apexChargeContactCooldown<=0&&dx*dx+dz*dz<(apex.radius+.75)*(apex.radius+.75)){
          damagePlayer(APEX_TUNING.chargeContactDmg);
          apexChargeContactCooldown=.9;
        }
      }
    }
    if(aliveEnemyCount===0&&gameState.waveDelay<=0){
      if(!apexSpawned)spawnApexUnit();
      else if(apexAliveCount===0)gameState.waveDelay=gameState.wave===ENDGAME_TUNING.finalWave?4.2:2.8;
    }
    updateVexMines(delta,time);
    updateApexShockwaves(delta);
  }

  function updateHostileShots(delta){
    hostilePlayerPoint.set(playerBody.position.x,playerBody.position.y+.5,playerBody.position.z);
    for(let i=hostileShots.length-1;i>=0;i--){const s=hostileShots[i];
      if(!Number.isFinite(s.age)||!isFiniteVector3(s.pos)||!isFiniteVector3(s.prev)||!isFiniteVector3(s.vel)){
        disposeHostileShot(s);hostileShots.splice(i,1);continue;
      }
      s.age+=delta;s.prev.copy(s.pos);s.pos.addScaledVector(s.vel,delta);s.mesh.position.copy(s.pos);
      const attr=s.trail.geometry.attributes.position;attr.setXYZ(0,s.prev.x,s.prev.y,s.prev.z);attr.setXYZ(1,s.pos.x,s.pos.y,s.pos.z);attr.needsUpdate=true;
      let remove=s.age>2.5;
      // Hit test sweep segmento→punto (B4): traduce il movimento del colpo tra
      // prev e pos in un segmento, così a FPS bassi il proiettile non salta sopra
      // il giocatore. .52 = raggio di collisione effettivo ^2 (≈0.72m).
      if(!remove){hostileSegment.start.copy(s.prev);hostileSegment.end.copy(s.pos);hostileSegment.closestPointToPoint(hostilePlayerPoint,true,hostileClosest);if(hostileClosest.distanceToSquared(hostilePlayerPoint)<CONFIG.hostileHitRadiusSq){damagePlayer(s.dmg||(CONFIG.hostileDmgBase+gameState.wave*CONFIG.hostileDmgWave));remove=true;}}
      if(!remove){s.rayToggle=!s.rayToggle;if(s.rayToggle){hostileFrom.set(s.rayFrom.x,s.rayFrom.y,s.rayFrom.z);hostileTo.set(s.pos.x,s.pos.y,s.pos.z);if(hostileRay.intersectWorld(world,{mode:CANNON.Ray.CLOSEST,result:hostileHit,from:hostileFrom,to:hostileTo,collisionFilterGroup:COLLISION.BULLET,collisionFilterMask:COLLISION.STATIC|COLLISION.CRATE}))remove=true;else s.rayFrom.copy(s.pos);}}
      if(remove){disposeHostileShot(s);hostileShots.splice(i,1);}
    }
  }

  let markerTimer = 0;
  function updateTargetMarkers(delta){
    markerTimer -= delta;
    if (markerTimer > 0) return;
    markerTimer = 0.05; // 20Hz throttled
    droneSystem.updateMarkers();
  }

  function updateRadar(time){
    const c=radarCtx,w=radarCanvas.width,h=radarCanvas.height,cx=w/2,cy=h/2,range=21,scale=(w*.43)/range;
    // Avoid shadowBlur per blip (expensive) — batch without shadows, use solid colors
    c.clearRect(0,0,w,h);
    c.save();c.translate(cx,cy);c.strokeStyle='rgba(87,224,239,.13)';c.lineWidth=1.5;for(const r of [.28,.56,.84]){c.beginPath();c.arc(0,0,w*.5*r,0,Math.PI*2);c.stroke();}
    const sweep=time*1.3-Math.PI/2;c.strokeStyle='rgba(103,245,255,.32)';c.lineWidth=1;c.beginPath();c.moveTo(0,0);c.lineTo(Math.cos(sweep)*w*.43,Math.sin(sweep)*w*.43);c.stroke();
    function mapPoint(wx,wz){const dx=wx-playerBody.position.x,dz=wz-playerBody.position.z;return {x:(dx*Math.cos(yaw)-dz*Math.sin(yaw))*scale,y:-(-dx*Math.sin(yaw)-dz*Math.cos(yaw))*scale};}
    const pad=mapPoint(CONFIG.padPos.x,CONFIG.padPos.z);c.fillStyle='#ff2d95';c.fillRect(pad.x-4,pad.y-4,8,8);
    for(const d of drones){if(!d.alive)continue;const p=mapPoint(d.group.position.x,d.group.position.z);const dist2=p.x*p.x+p.y*p.y;if(dist2> (w*.44)*(w*.44))continue;c.fillStyle='#ff465f';c.fillRect(p.x-4,p.y-4,8,8);}
    // Apex: tutti i boss del gauntlet hanno un blip indipendente.
    for(const rApex of droneSystem.apexes){
      if(!rApex.alive)continue;
      const p=mapPoint(rApex.group.position.x,rApex.group.position.z);
      if(p.x*p.x+p.y*p.y> (w*.46)*(w*.46)) continue;
      const pulse=1+.15*Math.sin(time*4);
      const size=(rApex.mega?10:5+Math.min(3,rApex.tier))*pulse;
      c.fillStyle=rApex.coreMaterial?('#'+rApex.coreMaterial.emissive.getHex().toString(16).padStart(6,'0')):'#ff4f5f';
      c.beginPath();c.arc(p.x,p.y,size,0,Math.PI*2);c.fill();
    }
    c.fillStyle='#8ef9ff';c.beginPath();c.moveTo(0,-10);c.lineTo(7,8);c.lineTo(0,5);c.lineTo(-7,8);c.closePath();c.fill();c.restore();
  }

  function updateGameplay(delta,time){
    meleeCooldown=Math.max(0,meleeCooldown-delta);
    meleeTimer=Math.max(0,meleeTimer-delta);
    if(gameState.reloading){gameState.reloadTimer-=delta;if(gameState.reloadTimer<=0)completeReload();}
    if(gameState.comboTimer>0){gameState.comboTimer-=delta;if(gameState.comboTimer<=0)gameState.combo=1;}
    if(time-gameState.lastDamage>CONFIG.shieldRegenDelay&&gameState.shield<CONFIG.maxShield&&!gameState.dead)gameState.shield=Math.min(CONFIG.maxShield,gameState.shield+delta*CONFIG.shieldRegen);
    if(gameState.waveDelay>0&&!gameState.dead){
      gameState.waveDelay-=delta;
      if(gameState.waveDelay<=0){
        if(gameState.wave>=ENDGAME_TUNING.finalWave){endVictory();}
        else{
          gameState.wave++;
          gameState.shield=Math.min(CONFIG.maxShield,gameState.shield+CONFIG.waveBonusShield);
          const wb=gameState.weapon,wbt=weaponTuning(wb),wbr=weaponReserve(wb);
          setWeaponAmmo(wb,weaponAmmo(wb),Math.min(wbt.reserveAmmo,wbr+CONFIG.waveBonusAmmo));
          toast(`<b>${t('hud.wave',{wave:String(gameState.wave).padStart(2,'0')})}</b> · ${t('toast.waveBonus',{shield:CONFIG.waveBonusShield,ammo:CONFIG.waveBonusAmmo})}`);
          spawnWave(true);
        }
      }
    }
    if(gameState.dead){
      gameState.respawnTimer-=delta;
      if(gameState.respawnTimer<=0){
        // Vite esaurite → GAME OVER: si congela la simulazione e si apre l'overlay.
        if(gameState.lives<=0)endGameOver();
        else respawnPlayer();
      }
    }
    updateHUD();
  }

  spawnWave(false);
  loadingUI.update(.94, 'SHADER WARMUP', 'Precompiling graphics pipelines...');
  // G1: precompila TUTTI i materiali in scena prima del loop di animazione.
  // renderer.compileAsync() da solo non basta: _projectObject() salta gli
  // oggetti con visible===false, i frustum-culled fuori dal frustum della
  // camera e i materiali con visible===false. Quei mesh, alla prima visibilità
  // a run-time, compilerebbero su più frame in renderObjectDirect (updateBeforeNode
  // / build) bloccando il main thread ~3-4s. Qui forziamo visione totale,
  // compiliamo e ripristiniamo lo stato originale in finally.
  // La scena include la camera (scene.add(camera)), quindi anche le armi/
  // railgun nascosti attaccati alla camera vengono coperti dal traverse.
  async function precompileAllMaterials() {
    const restore = [];
    // Passo 1 — luci e loro antenati: MAI forzare visible=true su questi nodi.
    // compileAsync() costruisce il render list che aggrega le luci visibili nel
    // lightsNode; se a compile-time il set di luci differisse dal runtime, ogni
    // materiale verrebbe ricompilato al primo frame di gioco (freeze) e i
    // renderObject stale venirebbero riusati con slot di luce disallineati
    // (effetto: scena più scura). Luce nascosta = stessa luce assente a runtime
    // E a compile: il set resta identico.
    const lightPaths = new Set();
    scene.traverse((object) => {
      if (object.isLight) {
        for (let ancestor = object.parent; ancestor; ancestor = ancestor.parent) lightPaths.add(ancestor);
      }
    });
    // Passo 2 — forzo la copertura totale dei MESH (non delle luci):
    //  - visible=true su renderable e contenitori nascosti (compila anche gli
    //    oggetti che al boot hanno visible=false: railgun, rail beam, ondate
    //    d'urto, puff fumo...);
    //  - frustumCulled=false su ogni renderable (i mesh fuori dal frustum della
    //    camera di boot: facciate, ambiente, droni sparsi per l'arena...);
    //  - material.visible=true per i materiali nascosti.
    // Lo stato originale viene ripristinato in finally.
    scene.traverse((object) => {
      if (!object.isLight && !lightPaths.has(object) && object.visible === false) {
        object.visible = true;
        restore.push(() => { object.visible = false; });
      }
      if (object.isMesh || object.isSprite || object.isPoints || object.isLine || object.isLineSegments || object.isInstancedMesh) {
        if (object.frustumCulled === true) {
          object.frustumCulled = false;
          restore.push(() => { object.frustumCulled = true; });
        }
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
          if (material && material.visible === false) {
            material.visible = true;
            restore.push(() => { material.visible = false; });
          }
        }
      }
    });
    try {
      await renderer.compileAsync(scene, camera);
    } catch (error) {
      console.warn('VIBE shader warmup skipped', error);
    } finally {
      for (let i = restore.length - 1; i >= 0; i--) restore[i]();
    }
  }
  // G1: il loading screen e l'input utente restano bloccati finché questa
  // await non risolve: finishBoot() (che mostra il CTA) arriva dopo, e il loop
  // di animazione parte solo a bootGame() completato.
  await precompileAllMaterials();
  try {
    renderPipeline.render(0, 0);
  } catch (error) {
    console.warn('VIBE pipeline warmup skipped', error);
  }
  loadingUI.update(.96, 'BOOT COMPLETE', 'Final scene sync...');
  loadingUI.finishBoot();

  /* ============================================================
     8. INPUT: POINTER LOCK, MOUSE E TASTIERA
     ============================================================ */
  const keys = {};
  let locked = false;
  let gameStartLoading = false;
  let jumpQueued = false;
  let triggerDown = false;
  let fireCooldown = 0;
  // T8: throttle del suono del lanciafiamme (il fuoco è ~20 tick/s; il suono
  // viene riprodotto al massimo ogni ~0.12s per limitare la creazione di nodi).
  let flameSoundTimer = 0;

  // --- MOBILE / TOUCH ---------------------------------------------------------
  // touchMode/highEndDevice sono rilevati in alto (danno anche il dettaglio armi).
  let playing = false;
  // Spazio di input touch: verrà consumato da updatePlayer / fire loop / HUD.
  const touchInput = {
    moveX: 0, moveZ: 0,   // joystick sinistro (movimento)
    aimX: 0, aimY: 0,     // joystick destro (mira)
    fire: false, jump: false, melee: false, reload: false, sprint: false, weapon: false
  };
  // True quando la simulazione è attiva (desktop: pointer lock; touch: playing).
  const isGameplayActive = () => (touchMode ? playing : locked)
    && gameState.started && !gameStartLoading && !gameState.victory;
  // Input attivo (solo pointer lock / playing, senza gameState.started né
  // gameStartLoading): usato dal flusso di avvio, che è proprio ciò che imposta
  // gameState.started = true e che tiene gameStartLoading = true durante l'asincrono.
  const isInputActive = () => (touchMode ? playing : locked);
  // Elementi DOM dei controlli touch.
  const touchControlsEl = document.getElementById('touch-controls');
  const touchLStickEl = document.getElementById('touch-l-joystick');
  const touchRStickEl = document.getElementById('touch-r-joystick');
  const touchLThumbEl = document.getElementById('touch-l-thumb');
  const touchRThumbEl = document.getElementById('touch-r-thumb');
  const touchBtnFire = document.getElementById('touch-btn-fire');
  const touchBtnMelee = document.getElementById('touch-btn-melee');
  const touchBtnReload = document.getElementById('touch-btn-reload');
  const touchBtnWeapon = document.getElementById('touch-btn-weapon');
  const touchBtnJump = document.getElementById('touch-btn-jump');
  const touchBtnSprint = document.getElementById('touch-btn-sprint');
  const touchBtnPause = document.getElementById('touch-btn-pause');
  const rotateOverlayEl = document.getElementById('rotate-overlay');
  // Stato per-josystick (tracciato per touch.identifier).
  const leftStick = { id: null, anchorX: 0, anchorY: 0 };
  const rightStick = { id: null, anchorX: 0, anchorY: 0, lastX: 0, lastY: 0 };
  const STICK_RADIUS = 46; // raggio (px) dello stick virtuale
  const AIM_SENSITIVITY = 0.0044;

  async function beginSimulationStart() {
    if (gameStartLoading || gameState.started) return;
    gameStartLoading = true;
    loadingUI.showModal('LINK STARTUP', 'Preparing the simulation...');
    try {
      await loadingUI.nextFrame();
      if (!isInputActive()) return;
      try {
        await audio.start();
      } catch (error) {
        console.warn('VIBE audio startup skipped', error);
      }
      loadingUI.update(.32, 'AUDIO LINK', 'Activating the procedural audio engine...');
      await loadingUI.nextFrame();
      if (!isInputActive()) return;
      loadingUI.update(.64, 'COMBAT READY', 'Syncing physics, HUD and tactical systems...');
      await loadingUI.nextFrame();
      if (!isInputActive()) return;
      loadingUI.update(.86, 'FINAL SYNC', 'Opening the combat channel...');
      await new Promise(resolve => setTimeout(resolve, 110));
      if (!isInputActive()) return;
      gameState.started = true;
      syncHudVisibility();
      hudController.beginOnboardingFade();
      showWave();
      toast(`<b>${t('toast.missionLabel')}</b> · ${t('toast.mission')}`);
      loadingUI.update(1, 'LINK ACTIVE', 'Simulation operational');
      await loadingUI.nextFrame();
      await new Promise(resolve => setTimeout(resolve, 180));
      loadingUI.hideModal({ hideOverlay: true });
    } finally {
      gameStartLoading = false;
      if (!gameState.started) loadingUI.hideModal();
      // La visibilità HUD dipende da !gameStartLoading: va ricalcolata solo ora
      // che il flag è stato azzerato, altrimenti l'HUD resterebbe nascosto.
      syncHudVisibility();
    }
  }

  document.addEventListener('keydown', (e) => {
    // Space/frecce vengono soppressi per non far scrollare la pagina, ma NON
    // quando il focus è su un controllo del pannello settings: lì servono per
    // regolare slider e pulsanti da tastiera.
    const onPanelControl = e.target instanceof HTMLElement
      && e.target.closest('input, button, .settings-panel');
    if (!onPanelControl && ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
      e.preventDefault();
    }
    if (e.repeat) return;
    keys[e.code] = true;
    // N2: niente input di gioco con il menu aperto o il round non attivo: il
    // salto in coda e la ricarica partono solo a simulazione effettivamente
    // in corso (prima un Space in pausa saltava al rientro, R ricaricava a
    // simulazione congelata).
    const gameplayInput = isGameplayActive();
    if (e.code === 'Space' && gameplayInput) jumpQueued = true;
    if (e.code === 'KeyR' && gameplayInput) startReload();
    if (e.code === 'KeyQ' && gameplayInput) cycleWeapon(1);
    // Scorrimento armi con i numeri da 1 in avanti sulla tastiera.
    if (e.code === 'Digit1' && gameplayInput) setWeapon('pulse');
    if (e.code === 'Digit2' && gameplayInput && weaponUnlocked('railgun')) setWeapon('railgun');
    if (e.code === 'Digit3' && gameplayInput && weaponUnlocked('minigun')) setWeapon('minigun');
    if (e.code === 'Digit4' && gameplayInput && weaponUnlocked('rpg')) setWeapon('rpg');
    if (e.code === 'Digit5' && gameplayInput && weaponUnlocked('flame')) setWeapon('flame');
    if (e.code === 'KeyM') audio.toggle();
    if (visualDebug) {
      const systemKey = { KeyF: 'atmosphere', KeyG: 'weather' }[e.code];
      if (systemKey) {
        const system = systemKey === 'atmosphere' ? atmosphereSystem : weatherSystem;
        const enabled = system.fxOverrides[systemKey] === false;
        system.setFxOverrides({ [systemKey]: enabled });
        toast(`FX DEBUG · ${systemKey.toUpperCase()} ${enabled ? 'ON' : 'OFF'}`);
      }
      const fxKey = { KeyH: 'flare', KeyJ: 'heatHaze', KeyK: 'grain', KeyL: 'vignette', KeyC: 'grade' }[e.code];
      if (fxKey) {
        const enabled = renderPipeline.fxOverrides[fxKey] === false;
        renderPipeline.setFxOverrides({ [fxKey]: enabled });
        toast(`FX DEBUG · ${fxKey.toUpperCase()} ${enabled ? 'ON' : 'OFF'}`);
      }
    }
  });
  document.addEventListener('keyup', (e) => { keys[e.code] = false; });

  document.addEventListener('mousemove', (e) => {
    if (touchMode || !locked) return;
    const movementX = Number.isFinite(e.movementX) ? e.movementX : 0;
    const movementY = Number.isFinite(e.movementY) ? e.movementY : 0;
    yaw   -= movementX * 0.0022 * mouseSensitivity;
    pitch -= movementY * 0.0022 * mouseSensitivity;
    const limit = Math.PI / 2 - 0.01;
    pitch = Math.max(-limit, Math.min(limit, pitch));
  });

  document.addEventListener('mousedown', (e) => {
    if (touchMode || !locked || !gameState.started || gameStartLoading) return;
    if (e.button === 2) {
      e.preventDefault();
      meleeAttack();
      return;
    }
    if (e.button !== 0) return;
    triggerDown = true;
    fireBullet();
  });
  document.addEventListener('mouseup', (e) => {
    if (e.button === 0) triggerDown = false;
  });
  document.addEventListener('contextmenu', (e) => e.preventDefault());

  // Scorrimento delle armi con la rotella del mouse: cicla tra le armi
  // effettivamente disponibili (la railgun solo se sbloccata).
  function cycleWeapon(direction) {
    const available = availableWeapons();
    const idx = available.indexOf(gameState.weapon);
    const next = available[(idx + direction + available.length) % available.length];
    setWeapon(next);
  }
  document.addEventListener('wheel', (e) => {
    if (touchMode || !locked || !gameState.started || gameStartLoading || e.deltaY === 0) return;
    cycleWeapon(e.deltaY > 0 ? 1 : -1);
  }, { passive: true });

  // Avvio simulazione: su desktop chiede il pointer lock; su touch imposta
  // "playing" (niente pointer lock) e blocca l'orientamento in landscape.
  function startGame(event) {
    if (event.target.closest('.settings-panel')) return;
    audio.start().catch(error => console.warn('VIBE audio startup skipped', error));
    // GAME OVER: il CTA riavvia una run pulita prima di rientrare in simulazione.
    if (gameState.gameOver || gameState.victory) {
      gameState.gameOver = false;
      gameState.victory = false;
      resetLevel();
    }
    if (touchMode) {
      playing = true;
      requestLandscape();
      syncHudVisibility();
      // Chiude il menu subito, anche al resume: beginSimulationStart() esce
      // presto quando la partita è già partita e non riaprirebbe l'overlay.
      overlayEl.style.display = 'none';
      beginSimulationStart();
    } else {
      const req = document.body.requestPointerLock();
      if (req && typeof req.catch === 'function') req.catch(() => console.warn('VIBE pointer lock request rejected — overlay stays open'));
    }
  }
  overlayEl.addEventListener('click', startGame);

  document.addEventListener('pointerlockchange', () => {
    if (touchMode) return;
    locked = document.pointerLockElement === document.body;
    overlayEl.style.display = locked && gameState.started ? 'none' : 'flex';
    syncHudVisibility();
    if (locked) triggerDown = false;   // nessun colpo accidentale al rientro
    if (locked && !gameState.started) {
      beginSimulationStart();
    }
    if(locked)hudController.beginOnboardingFade();
    if (!locked) clearPlayerInput();
    if (!locked && gameState.started) {
      // N5: la pausa congela davvero la simulazione (B2) — il testo lo dichiara.
      applyOverlayStateCopy(false);
    }
  });

  // --- Orientamento obbligatorio landscape (solo touch) ----------------------
  function isPortrait() {
    return typeof window.orientation === 'number'
      ? Math.abs(window.orientation) === 90 ? false : true
      : (window.innerHeight > window.innerWidth);
  }
  // Pausa (touch): equivalente della pausa desktop (Esc → rilascio pointer
  // lock) ma senza pointer lock — congelando la simulazione e mostrando
  // l'overlay. È il target del pulsante PAUSE touch e del guard di rotazione.
  function pauseGame() {
    if (!isGameplayActive()) return;
    playing = false;
    clearPlayerInput();
    syncHudVisibility();
    overlayEl.style.display = 'flex';
    applyOverlayStateCopy(false);
  }

  function updateRotateGuard() {
    if (!touchMode) return;
    const portrait = isPortrait();
    rotateOverlayEl.hidden = !portrait;
    document.body.classList.toggle('rotate-blocked', portrait);
    // Se il gioco è in corsa e il dispositivo torna in portrait, metti in pausa.
    if (portrait && playing && gameState.started) pauseGame();
  }
  function requestLandscape() {
    if (typeof screen !== 'undefined' && screen.orientation && screen.orientation.lock) {
      screen.orientation.lock('landscape').catch(() => {});
    }
    if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  }
  window.addEventListener('orientationchange', updateRotateGuard);
  window.addEventListener('resize', updateRotateGuard);
  updateRotateGuard();

  // --- Gestione touch: doppio stick + pulsanti ------------------------------
  document.addEventListener('touchstart', (e) => {
    if (!touchMode || !isGameplayActive()) return;
    e.preventDefault();
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      // Mira (joystick destro): tocco sulla metà destra dello schermo.
      if (t.clientX > window.innerWidth * 0.5 && rightStick.id === null) {
        rightStick.id = t.identifier;
        rightStick.anchorX = t.clientX;
        rightStick.anchorY = t.clientY;
        rightStick.lastX = t.clientX;
        rightStick.lastY = t.clientY;
        touchRStickEl.style.left = `${t.clientX}px`;
        touchRStickEl.style.top = `${t.clientY}px`;
        touchRStickEl.classList.add('active');
        touchRThumbEl.style.transform = 'translate(0,0)';
        continue;
      }
      // Movimento (joystick sinistro): tocco sulla metà sinistra dello schermo.
      if (t.clientX <= window.innerWidth * 0.5 && leftStick.id === null) {
        leftStick.id = t.identifier;
        leftStick.anchorX = t.clientX;
        leftStick.anchorY = t.clientY;
        touchLStickEl.style.left = `${t.clientX}px`;
        touchLStickEl.style.top = `${t.clientY}px`;
        touchLStickEl.classList.add('active');
        touchLThumbEl.style.transform = 'translate(0,0)';
        touchInput.moveX = 0;
        touchInput.moveZ = 0;
        continue;
      }
    }
  }, { passive: false });

  document.addEventListener('touchmove', (e) => {
    if (!touchMode || !isGameplayActive()) return;
    e.preventDefault();
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      if (t.identifier === leftStick.id) {
        let dx = t.clientX - leftStick.anchorX;
        let dy = t.clientY - leftStick.anchorY;
        const d = Math.hypot(dx, dy);
        const mag = Math.min(1, d / STICK_RADIUS);
        if (d > 0.001) { dx /= d; dy /= d; }
        touchInput.moveX = dx * mag;
        touchInput.moveZ = dy * mag;
        touchLThumbEl.style.transform = `translate(${dx * mag * STICK_RADIUS}px, ${dy * mag * STICK_RADIUS}px)`;
      } else if (t.identifier === rightStick.id) {
        // Mira con delta incrementale rispetto all'evento precedente: usare la
        // distanza assoluta dall'ancor (anchorX/anchorY) sommandola a ogni
        // touchmove faceva ruotare la camera in modo quadratico (∝ drag² e
        // rate di eventi) e la faceva derapare con un dito fermo.
        const dx = t.clientX - rightStick.lastX;
        const dy = t.clientY - rightStick.lastY;
        rightStick.lastX = t.clientX;
        rightStick.lastY = t.clientY;
        const d = Math.hypot(dx, dy);
        const mag = Math.min(1, d / STICK_RADIUS);
        // Mira: il delta viene convertito in rotazione camera.
        yaw   -= dx * AIM_SENSITIVITY * mouseSensitivity;
        pitch -= dy * AIM_SENSITIVITY * mouseSensitivity;
        const limit = Math.PI / 2 - 0.01;
        pitch = Math.max(-limit, Math.min(limit, pitch));
        touchRThumbEl.style.transform = `translate(${dx * mag}px, ${dy * mag}px)`;
      }
    }
  }, { passive: false });

  function endTouch(e) {
    if (!touchMode) return;
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      if (t.identifier === leftStick.id) {
        leftStick.id = null;
        touchLStickEl.classList.remove('active');
        touchInput.moveX = 0;
        touchInput.moveZ = 0;
      } else if (t.identifier === rightStick.id) {
        rightStick.id = null;
        rightStick.lastX = 0;
        rightStick.lastY = 0;
        touchRStickEl.classList.remove('active');
      }
    }
  }
  document.addEventListener('touchend', endTouch);
  document.addEventListener('touchcancel', endTouch);

  // Arma: tieni premuto per il fuoco automatico (come il mouse).
  touchBtnFire.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); if (isGameplayActive()) { triggerDown = true; fireBullet(); } }, { passive: false });
  touchBtnFire.addEventListener('touchend', (e) => { e.preventDefault(); e.stopPropagation(); triggerDown = false; }, { passive: false });
  touchBtnFire.addEventListener('touchcancel', (e) => { triggerDown = false; });
  // Melee: tap singolo.
  touchBtnMelee.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); if (isGameplayActive()) meleeAttack(); }, { passive: false });
  // Ridica e cambio arma: tap singolo.
  touchBtnReload.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); if (isGameplayActive()) startReload(); }, { passive: false });
  touchBtnWeapon.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); if (isGameplayActive()) cycleWeapon(1); }, { passive: false });
  // Salto: tap singolo.
  touchBtnJump.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); if (isGameplayActive()) jumpQueued = true; }, { passive: false });
  // Sprint: tieni premuto per correre.
  touchBtnSprint.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); if (isGameplayActive()) touchInput.sprint = true; }, { passive: false });
  touchBtnSprint.addEventListener('touchend', (e) => { e.preventDefault(); e.stopPropagation(); touchInput.sprint = false; }, { passive: false });
  touchBtnSprint.addEventListener('touchcancel', (e) => { touchInput.sprint = false; });
  // Pausa: tap singolo sul pulsante PAUSE (in alto a destra).
  touchBtnPause.addEventListener('touchstart', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (isGameplayActive()) pauseGame();
  }, { passive: false });

  window.addEventListener('blur', () => {
    clearPlayerInput();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearPlayerInput();
      // Al ritorno non recuperare il tempo trascorso in background con una
      // raffica di step fisici che bloccherebbe il rendering.
      accumulator = 0;
    }
  });

  function clearPlayerInput() {
    for (const key in keys) keys[key] = false;
    jumpQueued = false;
    triggerDown = false;
    isSprinting = false;
    touchInput.moveX = 0;
    touchInput.moveZ = 0;
    touchInput.fire = false;
    touchInput.jump = false;
    touchInput.melee = false;
    touchInput.reload = false;
    touchInput.sprint = false;
    touchInput.weapon = false;
    leftStick.id = null;
    rightStick.id = null;
    touchLStickEl?.classList.remove('active');
    touchRStickEl?.classList.remove('active');
  }

  /* ============================================================
     9. RILEVAMENTO DEL TERRENO (RAYCAST) E MOVIMENTO
     ============================================================ */
  const groundRay = new CANNON.Ray();
  const rayFrom = new CANNON.Vec3();
  const rayTo = new CANNON.Vec3();
  const groundHit = new CANNON.RaycastResult();

  function groundCheck() {
    rayFrom.set(playerBody.position.x, playerBody.position.y, playerBody.position.z);
    rayTo.set(rayFrom.x, rayFrom.y - (CONFIG.playerRadius + 0.35), rayFrom.z);
    const hasHit = groundRay.intersectWorld(world, {
      mode: CANNON.Ray.CLOSEST,
      result: groundHit,
      from: rayFrom,
      to: rayTo,
      collisionFilterGroup: COLLISION.PLAYER,
      collisionFilterMask: COLLISION.STATIC | COLLISION.CRATE
    });
    return hasHit ? groundHit : null;
  }

  function updatePlayer(delta) {
    if (gameState.dead || !isGameplayActive()) {
      playerBody.velocity.x = 0; playerBody.velocity.z = 0; jumpQueued = false; isSprinting = false;
      return;
    }
    // 1) Terreno sotto i piedi
    const hit = groundCheck();
    const onGround = !!hit;
    isGrounded = onGround;
    const onPad = onGround && hit.body === padBody;
    if (onGround && !wasGrounded && lastVerticalVelocity < -2.2) {
      audio.land(Math.min(1.5, Math.abs(lastVerticalVelocity) / 8));
      // G4: la camera "incassa" l'atterraggio in proporzione alla velocità.
      landingKick = Math.min(1, Math.abs(lastVerticalVelocity) / 11);
    }
    wasGrounded = onGround;

    // 2) Movimento orizzontale (relativo alla direzione dello sguardo)
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);  // avanti
    const rx =  Math.cos(yaw), rz = -Math.sin(yaw);  // destra
    let mx = 0, mz = 0;
    if (keys['KeyW'] || keys['ArrowUp'])    { mx += fx; mz += fz; }
    if (keys['KeyS'] || keys['ArrowDown'])  { mx -= fx; mz -= fz; }
    if (keys['KeyD'] || keys['ArrowRight']) { mx += rx; mz += rz; }
    if (keys['KeyA'] || keys['ArrowLeft'])  { mx -= rx; mz -= rz; }
    // Joystick sinistro (touch): il pollice verso l'alto avanza, a destra straface.
    // moveX = orizzontale (destra +), moveZ = verticale (su = -). Si somma ai tasti.
    if (touchMode) {
      mx += -touchInput.moveZ * fx + touchInput.moveX * rx;
      mz += -touchInput.moveZ * fz + touchInput.moveX * rz;
    }
    const len = Math.hypot(mx, mz);
    if (len > 0) { mx /= len; mz /= len; }
    const sprintHeld = (keys['ShiftLeft'] || keys['ShiftRight']) || touchInput.sprint;
    isSprinting = sprintHeld && len > 0 && onGround && gameState.stamina > 1;
    const targetSpeed = isSprinting ? CONFIG.sprintSpeed : CONFIG.moveSpeed;
    playerBody.velocity.x = mx * targetSpeed;
    playerBody.velocity.z = mz * targetSpeed;
    if (isSprinting) gameState.stamina = Math.max(0, gameState.stamina - delta * CONFIG.sprintDrain);
    else gameState.stamina = Math.min(CONFIG.maxStamina, gameState.stamina + delta * (onGround ? CONFIG.staminaRegenGround : CONFIG.staminaRegenAir));
    if (onGround && len > 0 && isGameplayActive() && elapsed >= nextFootstep) {
      audio.playFootstep({ sprint: isSprinting });
      nextFootstep = elapsed + (isSprinting ? .31 : .43);
    }

    // 3) Salto (solo da terra e non sul jump pad)
    if (jumpQueued) {
      jumpQueued = false;
      if (onGround && !onPad) { playerBody.velocity.y = CONFIG.jumpSpeed; audio.jump(); }
    }

    // 4) Jump pad: spinta verticale ad ogni atterraggio
    if (onPad && !wasOnPad) {
      playerBody.velocity.y = CONFIG.padBoost;
      playerBody.velocity.x = 0;
      playerBody.velocity.z = 0;
      audio.pad();
    }
    wasOnPad = onPad;

    // 5) Respawn di sicurezza
    if (playerBody.position.y < -20) {
      resetPlayerBody();
    }
    lastVerticalVelocity = playerBody.velocity.y;
  }

  /* ============================================================
     10. ARMA DA FUOCO, PROIETTILI E TRACER
     ============================================================ */
  const bulletGeo = new THREE.SphereGeometry(CONFIG.bulletRadius, 12, 10);
  // Nucleo del proiettile: additivo, non tone-mapped e quasi bianco, così supera
  // la soglia del bloom (0.85) e produce un vero alone luminoso + riflesso.
  const bulletMat = new THREE.MeshBasicMaterial({
    color: 0xffffff, toneMapped: false, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false
  });
  // Halo radiale condiviso per i proiettili "glowing" (nucleo + coda morbida).
  const glowTex = new THREE.CanvasTexture(makeGlowCanvas(64));
  // I colori in gioco sono pochi e fissi (colpo del giocatore, colpo dei droni,
  // tinta dell'Apex corrente): i materiali vengono creati una volta per colore e
  // riusati. Creare un SpriteMaterial per proiettile significava decine di
  // materiali al secondo, ognuno con la propria voce nella cache delle pipeline.
  const glowMaterials = new Map();
  function glowMaterial(colorHex) {
    let material = glowMaterials.get(colorHex);
    if (!material) {
      material = new THREE.SpriteMaterial({
        map: glowTex, color: colorHex, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false
      });
      glowMaterials.set(colorHex, material);
    }
    return material;
  }
  function makeGlowSprite(colorHex, scale) {
    const sprite = new THREE.Sprite(glowMaterial(colorHex));
    sprite.scale.setScalar(scale);
    return sprite;
  }

  // Risorse condivise dei colpi ostili (usate da spawnHostileShot e
  // spawnApexProjectile nella sezione 7C, entrambi invocati a runtime).
  // Prima ogni colpo allocava geometria + materiale + materiale del tracer.
  const hostileShotGeometry = new THREE.SphereGeometry(.105, 8, 6);
  const apexShotGeometry = new THREE.SphereGeometry(.135, 8, 6);
  const shotCoreMaterials = new Map();
  const shotTrailMaterials = new Map();
  function shotCoreMaterial(colorHex) {
    let material = shotCoreMaterials.get(colorHex);
    if (!material) {
      material = new THREE.MeshBasicMaterial({
        color: colorHex, toneMapped: false, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false
      });
      shotCoreMaterials.set(colorHex, material);
    }
    return material;
  }
  function shotTrailMaterial(colorHex, opacity) {
    // Chiave colore+opacità: due sorgenti diverse possono condividere il colore
    // ma non l'opacità, e una cache sul solo colore restituirebbe il materiale
    // sbagliato al secondo chiamante.
    const key = `${colorHex}:${opacity}`;
    let material = shotTrailMaterials.get(key);
    if (!material) {
      material = new THREE.LineBasicMaterial({
        color: colorHex, transparent: true, opacity, toneMapped: false,
        blending: THREE.AdditiveBlending, depthWrite: false
      });
      shotTrailMaterials.set(key, material);
    }
    return material;
  }
  // P3: pool dei colpi ostili (droni e Apex). Le barrages Apex schierano 12-40
  // colpi in un istante e prima ognuno allocava mesh, sprite, BufferGeometry e
  // Float32Array del trail. Gli entry vengono riciclati per chiave
  // (geometria/colore/scala glow/opacity trail); i materiali sono quelli
  // cachati sopra. Il primo utilizzo avviene sempre a runtime (gameplay), dopo
  // l'inizializzazione di queste costanti.
  const shotPools = new Map();
  const MAX_POOLED_SHOTS = 64;
  const shotAimTmp = new THREE.Vector3();
  const shotCamTmp = new THREE.Vector3();
  function shotPoolKey(geometry, colorHex, glowScale, trailOpacity) {
    return `${geometry === apexShotGeometry ? 'A' : 'H'}:${colorHex}:${glowScale}:${trailOpacity}`;
  }
  function acquireShotEntry(geometry, colorHex, glowScale, trailOpacity) {
    const key = shotPoolKey(geometry, colorHex, glowScale, trailOpacity);
    let pool = shotPools.get(key);
    if (!pool) { pool = []; shotPools.set(key, pool); }
    const entry = pool.pop();
    if (entry) return entry;
    const mesh = new THREE.Mesh(geometry, shotCoreMaterial(colorHex));
    mesh.add(makeGlowSprite(colorHex, glowScale));
    const lineGeo = new THREE.BufferGeometry();
    const attr = new THREE.Float32BufferAttribute(new Float32Array(6), 3);
    attr.setUsage(THREE.DynamicDrawUsage);
    lineGeo.setAttribute('position', attr);
    const trail = new THREE.Line(lineGeo, shotTrailMaterial(colorHex, trailOpacity));
    // Il segmento si muove ogni frame senza ricalcolo del bounding sphere:
    // il frustum culling va disattivato per non farlo sparire erroneamente.
    trail.frustumCulled = false;
    return {
      poolKey: key,
      mesh, trail,
      pos: new THREE.Vector3(),
      prev: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      // P3: origine dell'ultimo raycast muro eseguito: i raycast viaggiano a
      // frame alterni (metà del costo) ma il segmento testato è accumulato,
      // quindi niente tunnelling oltre pareti/casse.
      rayFrom: new THREE.Vector3(),
      rayToggle: false,
      age: 0,
      dmg: 0
    };
  }
  function releaseShotEntry(entry) {
    const pool = shotPools.get(entry.poolKey);
    if (pool && pool.length < MAX_POOLED_SHOTS) pool.push(entry);
    else entry.trail.geometry.dispose();
  }
  // Traccia della railgun: un raggio arancione luminoso e persistente per 1
  // secondo. Core (linea brillante) + alone volumetrico (cilindro additivo) +
  // sprite di impatto condividono il ciclo di vita e decadono insieme.
  const railBeamPositionAttribute = new THREE.Float32BufferAttribute(new Float32Array(6), 3);
  const railBeamGeometry = new THREE.BufferGeometry();
  railBeamGeometry.setAttribute('position', railBeamPositionAttribute);
  const railBeamMaterial = new THREE.LineBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0, toneMapped: false, blending: THREE.AdditiveBlending, depthWrite: false });
  const railBeamGlowMaterial = new THREE.LineBasicMaterial({ color: 0xff8c00, transparent: true, opacity: 0, toneMapped: false, blending: THREE.AdditiveBlending, depthWrite: false });
  const railBeam = new THREE.Line(railBeamGeometry, railBeamMaterial);
  const railBeamGlow = new THREE.Line(railBeamGeometry, railBeamGlowMaterial);
  // Alone volumetrico del raggio: cilindro additivo orientato lungo la direzione.
  const railBeamCylinder = new THREE.Mesh(
    new THREE.CylinderGeometry(.05, .05, 1, 12, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xff6a00, transparent: true, opacity: 0, toneMapped: false, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })
  );
  railBeamCylinder.visible = false;
  const railImpactSprite = makeGlowSprite(0xffa040, .72);
  railBeam.visible = false;
  railBeamGlow.visible = false;
  railImpactSprite.visible = false;
  scene.add(railBeamGlow, railBeam, railBeamCylinder, railImpactSprite);
  let railBeamTimer = 0;
  const RAIL_BEAM_DURATION = 1.0;
  const railCylinderUp = new THREE.Vector3(0, 1, 0);
  const railCylinderDir = new THREE.Vector3();
  const railCylinderQuat = new THREE.Quaternion();
  function showRailBeam(start, end) {
    railBeamPositionAttribute.setXYZ(0, start.x, start.y, start.z);
    railBeamPositionAttribute.setXYZ(1, end.x, end.y, end.z);
    railBeamPositionAttribute.needsUpdate = true;
    railBeamMaterial.opacity = 1;
    railBeamGlowMaterial.opacity = .85;
    railBeam.visible = true;
    railBeamGlow.visible = true;
    // Orienta il cilindro da start a end lungo la direzione del raggio.
    railCylinderDir.copy(end).sub(start);
    const len = railCylinderDir.length();
    railBeamCylinder.position.copy(start).addScaledVector(railCylinderDir, 0.5);
    railBeamCylinder.scale.set(1, len, 1);
    railCylinderQuat.setFromUnitVectors(railCylinderUp, railCylinderDir.normalize());
    railBeamCylinder.quaternion.copy(railCylinderQuat);
    railBeamCylinder.material.opacity = .5;
    railBeamCylinder.visible = true;
    railImpactSprite.position.copy(end);
    railImpactSprite.visible = true;
    railImpactSprite.material.opacity = 1;
    railImpactSprite.scale.setScalar(.72);
    railBeamTimer = RAIL_BEAM_DURATION;
  }
  function updateRailBeam(delta) {
    if (railBeamTimer <= 0) return;
    railBeamTimer = Math.max(0, railBeamTimer - delta);
    const fade = Math.min(1, railBeamTimer / RAIL_BEAM_DURATION);
    railBeamMaterial.opacity = fade;
    railBeamGlowMaterial.opacity = fade * .85;
    railBeamCylinder.material.opacity = fade * .5;
    railImpactSprite.material.opacity = fade;
    railImpactSprite.scale.setScalar(.38 + fade * .34);
    if (railBeamTimer <= 0) {
      railBeam.visible = false;
      railBeamGlow.visible = false;
      railBeamCylinder.visible = false;
      railImpactSprite.visible = false;
      railImpactSprite.material.opacity = 1;
    }
  }
  function clearRailBeam() {
    railBeamTimer = 0;
    railBeam.visible = false;
    railBeamGlow.visible = false;
    railBeamCylinder.visible = false;
    railImpactSprite.visible = false;
    railBeamMaterial.opacity = 0;
    railBeamGlowMaterial.opacity = 0;
    railBeamCylinder.material.opacity = 0;
    railImpactSprite.material.opacity = 1;
  }
  const bullets = [];
  // P2: pool dei proiettili del giocatore. La VULCAN spara 25 colpi/s e con
  // lifetime 1.6s si arrivano a ~40 colpi vivi: prima ogni colpo allocava
  // CANNON.Body + Sphere shape, Mesh, sprite glow, BufferGeometry del tracer e
  // Float32Array, per poi distruggere tutto all'impatto (churn GC + draw call).
  // Ora body/mesh/tracer vengono riciclati per tipo ('bullet'/'missile', che
  // differiscono per raggio shape, colore glow e materiale del tracer).
  const bulletPools = { bullet: [], missile: [] };
  const MAX_POOLED_BULLETS = 48;
  function makeBulletEntry(type) {
    const body = new CANNON.Body({ mass: CONFIG.bulletMass, material: matBullet, allowSleep: false });
    body.addShape(new CANNON.Sphere(type === 'missile' ? .16 : CONFIG.bulletRadius));
    body.collisionFilterGroup = COLLISION.BULLET;
    body.collisionFilterMask = COLLISION.STATIC | COLLISION.CRATE;
    const mesh = new THREE.Mesh(bulletGeo, bulletMat);
    // Halo luminoso additivo attaccato al proiettile: il bloom lo raccoglie e
    // forma l'alone attorno al colpo (e compare nel riflesso del pavimento).
    mesh.add(makeGlowSprite(type === 'missile' ? 0xffc24a : 0x8fe8ff, type === 'missile' ? 0.9 : 0.55));
    const tracerGeo = new THREE.BufferGeometry();
    const tracerAttr = new THREE.Float32BufferAttribute(new Float32Array(6), 3);
    tracerAttr.setUsage(THREE.DynamicDrawUsage);
    tracerGeo.setAttribute('position', tracerAttr);
    const tracer = new THREE.Line(tracerGeo, shotTrailMaterial(type === 'missile' ? 0xffc24a : 0xffffff, 1));
    // Il segmento si muove ogni frame senza ricalcolo del bounding sphere:
    // il frustum culling va disattivato per non farlo sparire erroneamente.
    tracer.frustumCulled = false;
    const entry = {
      body, mesh, tracer,
      age: 0,
      hit: false,
      impactSet: false,
      impact: new CANNON.Vec3(),
      prev: new CANNON.Vec3(),
      targetHit: false,
      targetRef: null,
      damage: 0,
      type
    };
    // Il listener resta legato all'entry per tutta la sua vita nel pool: il
    // record è sempre lo stesso oggetto, quindi `entry.hit` resta corretto
    // anche dopo il riuso (il body sparisce dal mondo mentre è nel pool,
    // quindi non riceve eventi di collisione da inattivo).
    body.addEventListener('collide', () => { entry.hit = true; });
    return entry;
  }
  function acquireBulletEntry(type) {
    return bulletPools[type].pop() || makeBulletEntry(type);
  }
  const meleeOrigin = new THREE.Vector3();
  const meleeDirection = new THREE.Vector3();
  const meleeTarget = new THREE.Vector3();
  const meleeImpact = new THREE.Vector3();
  let meleeCooldown = 0;
  let meleeTimer = 0;

  function fireBullet() {
    if (!gameState.started || gameStartLoading || gameState.dead || gameState.reloading || meleeTimer > 0) return;
    const w = gameState.weapon;
    if (w === 'railgun') { fireRailgun(); return; }
    if (w === 'minigun') { fireMinigun(); return; }
    if (w === 'rpg') { fireRPG(); return; }
    if (w === 'flame') { fireFlame(); return; }
    // --- PULSE (VX-9) ---
    // Il cooldown va verificato QUI e non solo nel ramo di fuoco automatico: il
    // gestore mousedown chiamava fireBullet() senza controllarlo, quindi
    // cliccando rapidamente si superava CONFIG.fireRate (cadenza limitata solo
    // dalla frequenza degli eventi del mouse).
    if (fireCooldown > 0) return;
    if (gameState.ammo <= 0) { audio.dry(); startReload(); fireCooldown = .2; return; }
    gameState.ammo--;
    gameState.shots++;
    fireCooldown = CONFIG.fireRate;
    audio.playShoot();
    // N7: la classe 'firing' la applica il dirty-check nel loop (prossimo frame).
    crosshairFireTimer = .1;
    updateHUD();
    bulletDir.set(0, 0, -1).applyQuaternion(camera.quaternion);
    spawnProjectile(bulletDir, CONFIG.bulletSpeed, CONFIG.bulletDamage);
    // Muzzle flash + rinculo
    triggerMuzzleFlash('pulse', 30, 2.2 + Math.random() * 1.5);
    gunRecoil = 0.06;
  }

  // Crea (o ricicla dal pool, vedi P2) un proiettile — body fisico + mesh +
  // tracer — e lo aggiunge alla lista. `damage` è il danno applicato in
  // updateBullets al contatto; `type` abilita comportamenti speciali (es.
  // 'missile' per l'RPG con esplosione ad area).
  function spawnProjectile(dir, speed, damage, type = 'bullet') {
    bulletOrigin.copy(camera.position).addScaledVector(dir, 0.6);
    // C5: clamp dell'origine entro i limiti dell'arena (come camera e corpi), così
    // un colpo sparato con la schiena al muro non nasce dentro/oltre la parete.
    bulletOrigin.x = THREE.MathUtils.clamp(bulletOrigin.x, -arenaInnerFace + .2, arenaInnerFace - .2);
    bulletOrigin.z = THREE.MathUtils.clamp(bulletOrigin.z, -arenaInnerFace + .2, arenaInnerFace - .2);

    // P2: riuso dell'entry — il body e le risorse grafiche non vengono
    // riallocati, vanno solo resettati posizione/velocità/flag.
    const bullet = acquireBulletEntry(type);
    const body = bullet.body;
    body.position.set(bulletOrigin.x, bulletOrigin.y, bulletOrigin.z);
    body.velocity.set(dir.x * speed, dir.y * speed, dir.z * speed);
    body.angularVelocity.set(0, 0, 0);
    body.quaternion.set(0, 0, 0, 1);
    body.force.set(0, 0, 0);
    body.torque.set(0, 0, 0);
    // AABB subito aggiornato alla nuova posizione: il broadphase (SAP) la usa
    // già al primo step dopo il reinserimento nel mondo.
    body.aabbNeedsUpdate = true;
    body.computeAABB();
    body.wakeUp();
    world.addBody(body);

    bullet.mesh.position.copy(bulletOrigin);
    scene.add(bullet.mesh);
    scene.add(bullet.tracer);

    bullet.age = 0;
    bullet.hit = false;
    bullet.impactSet = false;
    bullet.prev.set(bulletOrigin.x, bulletOrigin.y, bulletOrigin.z);
    bullet.targetHit = false;
    bullet.targetRef = null;
    bullet.damage = damage;
    bullets.push(bullet);
    return bullet;
  }

  // --- VULCAN (MINIGUN): cadenza altissima, canne che ruotano, leggero spread. ---
  function fireMinigun() {
    if (fireCooldown > 0) return;
    const tuning = WEAPON_TUNING.minigun;
    if (gameState.minigunAmmo <= 0) { audio.dry(); if (gameState.minigunReserve > 0) startReload(); fireCooldown = .2; return; }
    gameState.minigunAmmo--;
    gameState.shots++;
    fireCooldown = tuning.fireRate;
    audio.playShoot();
    crosshairFireTimer = .1;
    updateHUD();
    bulletDir.set(0, 0, -1).applyQuaternion(camera.quaternion);
    // Spread leggero per la raffica.
    bulletDir.x += (Math.random() - .5) * tuning.spread * 2;
    bulletDir.y += (Math.random() - .5) * tuning.spread * 2;
    bulletDir.normalize();
    spawnProjectile(bulletDir, tuning.bulletSpeed, tuning.damage);
    triggerMuzzleFlash('minigun', 26, 1.8 + Math.random() * 1.2);
    gunRecoil = .04;
  }

  // --- HELLSTORM (RPG): un razzo che esplode a contatto. ---
  function fireRPG() {
    if (fireCooldown > 0) return;
    const tuning = WEAPON_TUNING.rpg;
    if (gameState.rpgAmmo <= 0) {
      if (gameState.rpgReserve <= 0) {
        if (fireCooldown <= 0) { audio.dry(); fireCooldown = .5; }
        return;
      }
      audio.dry();
      startReload();
      fireCooldown = .3;
      return;
    }
    gameState.rpgAmmo--;
    gameState.shots++;
    fireCooldown = tuning.cooldown;
    audio.railgun(panForWorld(camera.position)); // riuso boato lanciatore
    crosshairFireTimer = .18;
    updateHUD();
    bulletDir.set(0, 0, -1).applyQuaternion(camera.quaternion);
    spawnProjectile(bulletDir, tuning.bulletSpeed, tuning.damage, 'missile');
    triggerMuzzleFlash('rpg', 40, 2.2);
    gunRecoil = .12;
  }

  // --- PYRE (FLAMETHROWER): getto corto e largo, danno in continuo entro il
  // cono. Ogni tick applica il danno a ogni nemico nel raggio/cono. ---
  function fireFlame() {
    if (fireCooldown > 0) return;
    const tuning = WEAPON_TUNING.flame;
    if (gameState.flameAmmo <= 0) { audio.dry(); if (gameState.flameReserve > 0) startReload(); fireCooldown = .2; return; }
    gameState.flameAmmo--;
    fireCooldown = tuning.fireRate;
    crosshairFireTimer = .1;
    updateHUD();
    // Danno ai droni nel cono (distanza ORizzontale + angolo orizzontale).
    // T6: sia la direzione di mira sia l'offset sono proiettati sul piano XZ,
    // così un drone sopra/sotto il giocatore non bypassa il cono (prima
    // flameOffset.y=0 zeroizzava il vettore → normalize()=NaN → falso positivo).
    // `flameAim` è locale: `bulletDir` resta 3D per la fiamma visiva (spawnFlameBurst).
    flameAim.set(0, 0, -1).applyQuaternion(camera.quaternion).setY(0).normalize();
    const origin = camera.position;
    const cosCone = Math.cos(tuning.cone);
    for (const drone of drones) {
      if (!drone.alive) continue;
      flameOffset.copy(drone.group.position).sub(origin);
      flameOffset.y = 0;
      const dist = flameOffset.length();
      if (dist > tuning.range || dist < .001) continue; // dist≈0 (sopra) → fuori cono
      flameOffset.normalize();
      if (flameOffset.dot(flameAim) < cosCone) continue;
      damageDrone(drone, tuning.damage, drone.group.position.clone(), false);
    }
    // Anche tutti gli Apex se nel cono.
    for (const apex of droneSystem.apexes) {
      if (!apex.alive) continue;
      flameOffset.copy(apex.group.position).sub(origin);
      flameOffset.y = 0;
      const dist = flameOffset.length();
      if (dist <= tuning.range && dist >= .001) {
        flameOffset.normalize();
        if (flameOffset.dot(flameAim) >= cosCone) {
          damageApex(apex, tuning.damage, apex.group.position.clone(), false);
        }
      }
    }
    // Fiamma visiva (particelle corte e larghe).
    spawnFlameBurst();
    // T8: suono del lanciafiamme throttled (niente 2 noise-burst per tick).
    flameSoundTimer -= tuning.fireRate;
    if (flameSoundTimer <= 0) { audio.flame(); flameSoundTimer = .12; }
    triggerMuzzleFlash('flame', 22, 1.6 + Math.random() * .8);
    gunRecoil = .02;
  }

  // Getto di fiamma visivo: delega al pool additivo di ExplosionSystem.
  function spawnFlameBurst() {
    explosionSystem.flameBurst(camera.position, bulletDir);
  }

  function meleeAttack() {
    if (!isGameplayActive() || gameState.dead || meleeCooldown > 0) return;
    meleeCooldown = CONFIG.meleeCooldown;
    meleeTimer = CONFIG.meleeDuration;
    audio.melee();

    camera.getWorldDirection(meleeDirection);
    meleeOrigin.copy(camera.position);
    let closestDrone = null;
    let closestApex = null;
    let closestDistance = CONFIG.meleeRange;
    const hitRadius = CONFIG.meleeRadius;
    for (const drone of drones) {
      if (!drone.alive) continue;
      meleeTarget.copy(drone.position).sub(meleeOrigin);
      const along = meleeTarget.dot(meleeDirection);
      if (along < .1 || along > CONFIG.meleeRange) continue;
      const distanceSquared = Math.max(0, meleeTarget.lengthSq() - along * along);
      const radius = hitRadius + drone.radius;
      if (distanceSquared > radius * radius || along >= closestDistance) continue;
      closestDrone = drone;
      closestDistance = along;
    }
    // Il melee può colpire anche l'Apex (raggio più ampio).
    for (const apexTarget of droneSystem.apexes) {
      if (!apexTarget.alive) continue;
      meleeTarget.copy(apexTarget.group.position).sub(meleeOrigin);
      const along = meleeTarget.dot(meleeDirection);
      if (along > .1 && along < CONFIG.meleeRange) {
        const distanceSquared = Math.max(0, meleeTarget.lengthSq() - along * along);
        const radius = hitRadius + apexTarget.radius;
        if (distanceSquared <= radius * radius && along < closestDistance) {
          closestDistance = along;
          closestApex = apexTarget;
        }
      }
    }
    if (closestApex) {
      meleeImpact.copy(meleeOrigin).addScaledVector(meleeDirection, closestDistance);
      damageApex(closestApex, CONFIG.meleeDamage, meleeImpact, false);
    } else if (closestDrone) {
      meleeImpact.copy(meleeOrigin).addScaledVector(meleeDirection, closestDistance);
      // N3: il melee non è un colpo esploso — non entra nel conteggio accuracy.
      damageDrone(closestDrone, CONFIG.meleeDamage, meleeImpact, false);
    }
  }

  const bulletRay = new CANNON.Ray();
  const bulletHit = new CANNON.RaycastResult();
  const railRay = new CANNON.Ray();
  const railHit = new CANNON.RaycastResult();
  const railFrom = new CANNON.Vec3();
  const railTo = new CANNON.Vec3();
  const bulletSegment = new THREE.Line3();
  const bulletClosest = new THREE.Vector3();
  // C4: temp vector riusati per direzione e origine del colpo (niente allocazioni
  // per colpo nel percorso caldo di fireBullet).
  const bulletDir = new THREE.Vector3();
  const bulletOrigin = new THREE.Vector3();
  const flameOffset = new THREE.Vector3();
  const flameAim = new THREE.Vector3();
  const railDirection = new THREE.Vector3();
  const railOrigin = new THREE.Vector3();
  const railEnd = new THREE.Vector3();
  const railTargetPoint = new THREE.Vector3();
  const railTargetOffset = new THREE.Vector3();

  function isFiniteVector3(value) {
    return Boolean(value)
      && Number.isFinite(value.x)
      && Number.isFinite(value.y)
      && Number.isFinite(value.z);
  }

  function fireRailgun() {
    if (!gameState.started || gameStartLoading || gameState.dead || gameState.reloading || meleeTimer > 0) return;
    if (fireCooldown > 0) return;
    if (gameState.railgunAmmo <= 0) {
      // L12: nessuna munizione E nessuna riserva: un solo "click" secco e un
      // cooldown lungo, così il loop di auto-fire non riproduce il dry ~5/s
      // mentre il grilletto resta premuto (startReload non può partire).
      if (gameState.railgunReserve <= 0) {
        if (fireCooldown <= 0) { audio.dry(); fireCooldown = .5; }
        return;
      }
      audio.dry();
      startReload();
      fireCooldown = .2;
      return;
    }

    gameState.railgunAmmo--;
    gameState.shots++;
    fireCooldown = RAILGUN_TUNING.cooldown;
    camera.getWorldDirection(railDirection);
    railOrigin.copy(camera.position);
    railEnd.copy(railOrigin).addScaledVector(railDirection, RAILGUN_TUNING.range);

    // Il raggio si ferma sulla prima parete/cassa, come un colpo reale: il
    // controllo è istantaneo e non crea un body fisico da aggiornare.
    railFrom.set(railOrigin.x, railOrigin.y, railOrigin.z);
    railTo.set(railEnd.x, railEnd.y, railEnd.z);
    const blocked = railRay.intersectWorld(world, {
      mode: CANNON.Ray.CLOSEST,
      result: railHit,
      from: railFrom,
      to: railTo,
      collisionFilterGroup: COLLISION.BULLET,
      collisionFilterMask: COLLISION.STATIC | COLLISION.CRATE
    });
    let maxRange = RAILGUN_TUNING.range;
    if (blocked && isFiniteVector3(railHit.hitPointWorld)) {
      maxRange = Math.min(maxRange, Math.hypot(
        railHit.hitPointWorld.x - railOrigin.x,
        railHit.hitPointWorld.y - railOrigin.y,
        railHit.hitPointWorld.z - railOrigin.z
      ));
      railEnd.copy(railDirection).multiplyScalar(maxRange).add(railOrigin);
    }

    let closestDrone = null;
    let closestApex = null;
    let closestDistance = maxRange;
    for (const drone of drones) {
      if (!drone.alive) continue;
      railTargetOffset.copy(drone.position).sub(railOrigin);
      const along = railTargetOffset.dot(railDirection);
      if (along <= .1 || along > closestDistance) continue;
      const perpendicularSq = Math.max(0, railTargetOffset.lengthSq() - along * along);
      const hitRadius = drone.radius + .2;
      if (perpendicularSq > hitRadius * hitRadius) continue;
      closestDrone = drone;
      closestApex = null;
      closestDistance = along;
    }
    // La railgun può ferire gli Apex, ma conserva il loro ruolo: il oneshot è
    // riservato ai droni semplici sopra, mentre qui usa un danno dedicato.
    for (const apexTarget of droneSystem.apexes) {
      if (!apexTarget.alive) continue;
      railTargetOffset.copy(apexTarget.position).sub(railOrigin);
      const along = railTargetOffset.dot(railDirection);
      if (along > .1 && along <= closestDistance) {
        const perpendicularSq = Math.max(0, railTargetOffset.lengthSq() - along * along);
        if (perpendicularSq <= (apexTarget.radius + .24) ** 2) {
          closestApex = apexTarget;
          closestDrone = null;
          closestDistance = along;
        }
      }
    }

    if (closestDrone || closestApex) {
      railTargetPoint.copy(railOrigin).addScaledVector(railDirection, closestDistance);
      railEnd.copy(railTargetPoint);
      if (closestDrone) damageDrone(closestDrone, RAILGUN_TUNING.damage, railTargetPoint.clone());
      else damageApex(closestApex, RAILGUN_TUNING.apexDamage, railTargetPoint.clone());
    }
    audio.railgun(panForWorld(railEnd));
    showRailBeam(railOrigin, railEnd);
    explosionSystem.sparkBurst(railEnd, closestDrone || closestApex ? 0xffb347 : 0xff8c00, 24);
    crosshairFireTimer = .18;
    gunRecoil = .11;
    triggerMuzzleFlash('railgun', 44, 1.8);
    updateHUD();
  }

  function disposeBullet(bullet) {
    scene.remove(bullet.mesh, bullet.tracer);
    world.removeBody(bullet.body);
    bullet.targetRef = null;
    // P2: l'entry torna nel pool per il riuso (body, shape, mesh, sprite e
    // geometria del tracer restano intatti; i materiali sono condivisi). Solo
    // gli eccedenti il tetto del pool vengono distrutti.
    const pool = bulletPools[bullet.type];
    if (pool.length < MAX_POOLED_BULLETS) pool.push(bullet);
    else bullet.tracer.geometry.dispose();
  }

  function updateBullets(delta) {
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i];
      // Cannon può propagare un valore non finito dopo una collisione
      // degenerata. Rimuovere subito quel proiettile evita coordinate NaN nei
      // tracer, negli effetti e nella pipeline grafica.
      if (!Number.isFinite(b.age)
        || !isFiniteVector3(b.body?.position)
        || !isFiniteVector3(b.body?.velocity)
        || !isFiniteVector3(b.prev)) {
        disposeBullet(b);
        bullets.splice(i, 1);
        continue;
      }
      b.age += delta;

      // Sweep: raycast tra la posizione precedente e quella attuale,
      // per evitare il tunnelling dei proiettili veloci.
      if (!b.hit) {
        droneSystem.registerProjectileThreat(b.prev,b.body.position);
        bulletSegment.start.set(b.prev.x,b.prev.y,b.prev.z);
        bulletSegment.end.set(b.body.position.x,b.body.position.y,b.body.position.z);
        for (const drone of drones) {
          if (!drone.alive) continue;
          bulletSegment.closestPointToPoint(drone.group.position,true,bulletClosest);
          if (bulletClosest.distanceToSquared(drone.group.position) <= drone.radius * drone.radius) {
            b.hit=true;b.targetHit=true;b.impact.set(bulletClosest.x,bulletClosest.y,bulletClosest.z);b.impactSet=true;
            b.targetRef = drone;
            damageDrone(drone,b.damage,bulletClosest.clone());
            break;
          }
        }
        // Sweep contro tutti gli Apex (wave 9 ne schiera quattro insieme).
        for (const apexDrone of droneSystem.apexes) {
          if (b.hit || !apexDrone.alive) continue;
          bulletSegment.closestPointToPoint(apexDrone.group.position,true,bulletClosest);
          if (bulletClosest.distanceToSquared(apexDrone.group.position) <= apexDrone.radius * apexDrone.radius) {
            b.hit=true;b.targetHit=true;b.impact.set(bulletClosest.x,bulletClosest.y,bulletClosest.z);b.impactSet=true;
            b.targetRef = apexDrone;
            damageApex(apexDrone,b.damage,bulletClosest.clone());
          }
        }
      }
      if (!b.hit) {
        const hasHit = bulletRay.intersectWorld(world, {
          mode: CANNON.Ray.CLOSEST,
          result: bulletHit,
          from: b.prev,
          to: b.body.position,
          collisionFilterGroup: COLLISION.BULLET,
          collisionFilterMask: COLLISION.STATIC | COLLISION.CRATE
        });
        if (hasHit) {
          b.hit = true;
          b.impact.copy(bulletHit.hitPointWorld);
          b.impactSet = true;
        }
      }

      // Tracer: segmento posizione precedente -> attuale
      const attr = b.tracer.geometry.attributes.position;
      attr.setXYZ(0, b.prev.x, b.prev.y, b.prev.z);
      attr.setXYZ(1, b.body.position.x, b.body.position.y, b.body.position.z);
      attr.needsUpdate = true;

      b.prev.copy(b.body.position);

      // Impatto rilevato dal motore fisico: usa la posizione corrente
      if (b.hit && !b.impactSet) {
        b.impact.copy(b.body.position);
        b.impactSet = true;
      }

      if (b.hit) {
        const impact = new THREE.Vector3(b.impact.x, b.impact.y, b.impact.z);
        if (b.type === 'missile') {
          // HELLSTORM: esplosione ad area sul punto di impatto. Il bersaglio
          // colpito in diretta è già stato danneggiato dallo sweep: lo si
          // esclude per evitare il doppio danno (220 + 220).
          explosionSystem.explode(impact, 0xffc857);
          audio.explode(panForWorld(impact));
          const blastRadius = WEAPON_TUNING.rpg.blastRadius;
          const blastRadiusSq = blastRadius * blastRadius;
          for (const drone of drones) {
            if (!drone.alive || drone === b.targetRef) continue;
            if (drone.group.position.distanceToSquared(impact) <= blastRadiusSq) {
              damageDrone(drone, b.damage, drone.group.position.clone());
            }
          }
          for (const apexM of droneSystem.apexes) {
            if (apexM.alive && apexM !== b.targetRef && apexM.group.position.distanceToSquared(impact) <= blastRadiusSq) {
              damageApex(apexM, b.damage, apexM.group.position.clone());
            }
          }
        } else {
          explosionSystem.sparkBurst(impact, b.targetHit ? 0x72efff : 0xffd19a, b.targetHit ? 14 : 9);
          if (!b.targetHit) audio.playImpact({ pan: panForWorld(impact) });
        }
      }

      if (b.hit || b.age >= CONFIG.bulletLifetime) {
        disposeBullet(b);
        bullets.splice(i, 1);
        continue;
      }

      b.mesh.position.copy(b.body.position);
      b.mesh.quaternion.copy(b.body.quaternion);
    }
  }

  function clearBullets() {
    for (const bullet of bullets) {
      disposeBullet(bullet);
    }
    bullets.length = 0;
  }

  function clearHostileShots() {
    for (const shot of hostileShots) disposeHostileShot(shot);
    hostileShots.length = 0;
  }

  function resetLevel() {
    const wasStarted = gameState.started;
    clearPlayerInput();
    clearBullets();
    clearHostileShots();
    clearAmmoPickups();
    clearRailgunPickups();
    clearWeaponPickups();
    clearHeartPickups();
    clearRailBeam();
    explosionSystem.reset();
    renderPipeline.reset();
    atmosphereSystem.reset();
    weatherSystem.reset();

    gameState.health = CONFIG.maxHealth;
    gameState.shield = CONFIG.maxShield;
    gameState.stamina = CONFIG.maxStamina;
    gameState.lives = CONFIG.maxLives;
    gameState.maxLives = CONFIG.maxLives;
    gameState.gameOver = false;
    gameState.victory = false;
    gameState.ammo = CONFIG.magazineSize;
    gameState.reserve = CONFIG.reserveAmmo;
    gameState.weapon = 'pulse';
    gameState.railgunUnlocked = false;
    gameState.railgunAmmo = 0;
    gameState.railgunReserve = 0;
    gameState.minigunUnlocked = false;
    gameState.minigunAmmo = 0;
    gameState.minigunReserve = 0;
    gameState.rpgUnlocked = false;
    gameState.rpgAmmo = 0;
    gameState.rpgReserve = 0;
    gameState.flameUnlocked = false;
    gameState.flameAmmo = 0;
    gameState.flameReserve = 0;
    gameState.reloading = false;
    gameState.reloadTimer = 0;
    gameState.score = 0;
    gameState.combo = 1;
    gameState.comboTimer = 0;
    gameState.wave = 1;
    gameState.waveKills = 0;
    gameState.waveTargets = 5;
    gameState.waveDelay = 0;
    gameState.dead = false;
    gameState.respawnTimer = 0;
    gameState.lastDamage = -99;
    // L13: il dirty-check del crosshair (lo stato 'firing') va azzerato col
    // reset — prima la classe poteva restare appiccicata fino a ~0.18s dopo.
    crosshairFireTimer = 0;
    crosshairFiring = false;
    gameState.shots = 0;
    gameState.hits = 0;
    gameState.started = wasStarted;
    railgunDropSpawned = false;
    weaponDropSpawned.minigun = false;
    weaponDropSpawned.rpg = false;
    weaponDropSpawned.flame = false;

    elapsed = 0;
    lastVisualEvent = -99;
    accumulator = 0;
    fpsFrames = 0;
    fpsTimer = 0;
    radarTimer = 0;
    ammoDropTimer = 10;
    yaw = 0;
    pitch = 0;
    cameraDamageKick = 0;
    landingKick = 0;
    bobPhase = 0;
    isGrounded = false;
    nextFootstep = 0;
    fireCooldown = 0;
    meleeCooldown = 0;
    meleeTimer = 0;
    gunRecoil = 0;
    muzzleLight.intensity = 0;
    for (const flash of Object.values(weaponFlashMeshes)) {
      flash.material.opacity = 0;
      flash.scale.setScalar(1);
    }
    for (const id of Object.keys(weaponViews)) weaponViews[id].visible = (id === 'pulse');
    clearVexMines();
    for (const s of apexShockwaves) { scene.remove(s.mesh); s.mesh.geometry.dispose(); s.mesh.material.dispose(); }
    apexShockwaves.length = 0;
    resetPlayerBody();
    spawnWave(false);
    updateHUD();
    syncHudVisibility();
    if (wasStarted) {
      showWave(t('overlay.title.reset'), t('wave.reset.sub'));
      toast(`<b>${t('toast.system')}</b> · ${t('toast.reset')}`);
      if (!isGameplayActive()) applyOverlayStateCopy(true);
    }
  }

  /* ============================================================
     11. LOOP DI GIOCO
     ============================================================ */
  const frameTimer = new THREE.Timer();
  frameTimer.connect(document);
  const FIXED_STEP = 1 / 60;
  const MAX_FRAME_DELTA = 0.1;
  const MAX_PHYSICS_STEPS = 6;
  let accumulator = 0;
  let elapsed = 0;
  let cameraDamageKick = 0;
  let landingKick = 0;   // G4: impatto d'atterraggio sulla camera
  let radarTimer = 0;
  let fpsFrames = 0;
  let fpsTimer = 0;
  // Rifornimento periodico: ogni 10s un drop di munizioni in posizione casuale,
  // così il giocatore non resta mai a secco.
  let ammoDropTimer = 10;
  let frameErrorCount = 0;
  let degradedNoticeShown = false;

  function animate() {
    try {
    frameTimer.update();
    const rawDelta = frameTimer.getDelta();
    const delta = Number.isFinite(rawDelta)
      ? Math.min(Math.max(rawDelta, 0), MAX_FRAME_DELTA)
      : 0;
    elapsed += delta;
    // Non accumulare più di un frame di simulazione: dopo un tab sospeso o
    // un frame fallito il gioco deve recuperare senza migliaia di step fisici.
    accumulator = Math.min(accumulator + delta, FIXED_STEP * MAX_PHYSICS_STEPS);
    syncHudVisibility();

    // B2: la simulazione è "attiva" solo con pointer lock + partita avviata.
    // Con il menu di pausa aperto il gioco è davvero sospeso: niente step fisici,
    // niente droni, niente colpi in volo, niente timer di gioco. Rendering, camera,
    // HUD, pioggia/vapore e musica restano attivi.
    const gameplayActive = isGameplayActive();
    if (gameplayActive) {
      // Correggi subito eventuali residui dello step precedente prima che il
      // movimento e il raycast del terreno li possano riutilizzare.
      constrainPlayerToArena();
      sanitizeDynamicBodies();
      updatePlayer(delta);
      // updatePlayer imposta l'intento del frame. Filtralo anche prima dello
      // step: sul bordo esatto rimuove solo la componente verso il muro e lascia
      // intatta quella tangenziale, evitando jitter e blocchi nello scorrimento.
      constrainPlayerToArena();

      // Fisica a passo fisso: singolo world.step con substeps interni
      // invece di loop manuale — Cannon.js gestisce accumulator internamente.
      const stepsNeeded = Math.min(MAX_PHYSICS_STEPS, Math.floor(accumulator / FIXED_STEP));
      if (stepsNeeded > 0) {
        world.step(FIXED_STEP, accumulator, stepsNeeded);
        accumulator -= stepsNeeded * FIXED_STEP;
        // Clamp una sola volta dopo tutti gli step
        constrainPlayerToArena();
        sanitizeDynamicBodies();
      }
      if (accumulator >= FIXED_STEP) accumulator %= FIXED_STEP;

      // Fuoco continuo tenendo premuto il tasto.
      // N4: fireBullet gestisce da solo il cooldown (colpo, colpo a secco,
      // ricarica); sovrascriverlo qui annullava la pausa del dry-fire.
      fireCooldown -= delta;
      if (triggerDown && fireCooldown <= 0) fireBullet();

      updateDrones(delta, elapsed);
      // S4: i pickup (cuori, munizioni, railgun) non sono collezionabili durante
      // la finestra di morte/respawn — il corpo non deve "raccogliere" nulla.
      if (!gameState.dead) {
        updateAmmoPickups(delta, elapsed);
        updateRailgunPickups(delta, elapsed);
        updateWeaponPickups(delta, elapsed);
        updateHeartPickups(delta, elapsed);
        // Rifornimento periodico: ogni 10s un drop di munizioni in una posizione
        // casuale dell'arena, per non restare mai senza munizioni.
        ammoDropTimer -= delta;
        if (ammoDropTimer <= 0) {
          ammoDropTimer = 10;
          const limit = arenaInnerFace - 1.5;
          spawnAmmoDrop({
            x: (Math.random() * 2 - 1) * limit,
            z: (Math.random() * 2 - 1) * limit
          });
        }
      }
      updateBullets(delta);
      updateHostileShots(delta);
      updateGameplay(delta, elapsed);

      // Sincronizza le mesh con i body fisici
      for (const o of synced) {
        o.mesh.position.copy(o.body.position);
        o.mesh.quaternion.copy(o.body.quaternion);
      }
    } else {
      // Pausa o pre-start: congela la fisica e scarta il tempo accumulato, così
      // al rientro non scattano raffiche di step arretrati.
      accumulator = 0;
    }

    explosionSystem.update(delta,camera);
    updateRailBeam(delta);
    // A1: mix attenuato con il menu di pausa aperto (dirty-check interno).
    audio.setMenuDuck(!isGameplayActive() && gameState.started);
    audio.update({
      aliveEnemies:aliveEnemyCount,
      wave:gameState.wave,
      health:gameState.health,
      combo:gameState.combo,
      apexAlive:droneSystem.apexes.some(apex=>apex.alive),
      finalBossAlive:droneSystem.apexes.some(apex=>apex.alive&&apex.mega)
    });

    // Jump pad: pulsazione soft + rotazione freccia
    padGlowMat.emissiveIntensity = 0.7 + Math.sin(elapsed * 2.5) * 0.2;
    padArrow.rotation.y += delta * 1.5;

    if (visualTestMode === 'storm' && elapsed - lastVisualEvent > 4) {
      atmosphereSystem.triggerLightning();
      lastVisualEvent = elapsed;
    } else if (visualTestMode === 'combat' && elapsed - lastVisualEvent > 2.4) {
      explosionSystem.explode(visualBurstPosition, 0xff7b2d);
      lastVisualEvent = elapsed;
    }
    const lightningFlash = atmosphereSystem.update(delta, elapsed);
    weatherSystem.update(delta, elapsed);
    renderPipeline.setLightningFlash(lightningFlash);
    if (moonLight) moonLight.intensity = GRAPHICS.lights.moon.intensity * (1 + lightningFlash * 1.2);
    facadeSystem.update(elapsed, lightningFlash);

    // G3: flicker delle insegne neon — battito luminoso lento più rari cali
    // brevi. Throttled: update every 2nd frame (~30Hz) to halve setScalar cost.
    if ((fpsFrames & 1) === 0) {
      for (const neon of flickerSigns) {
        const wave = Math.sin(elapsed * neon.speed + neon.phase) * Math.sin(elapsed * 1.73 + neon.phase * 2.31);
        const dip = Math.sin(elapsed * 29.7 + neon.phase * 13.1) > .9975 ? .38 : 0;
        neon.material.color.setScalar(Math.max(.52, .87 + wave * .13 - dip + lightningFlash * .18));
      }
      for (const reactive of reactiveNeonLights) {
        const breath = .9 + Math.sin(elapsed * .8 + reactive.phase) * .08;
        reactive.light.intensity = reactive.base * (breath + lightningFlash * .28);
      }
    }

    // Cristallo centrale: fluttuazione e rotazione
    crystal.position.y = 1.5 + Math.sin(elapsed * 2) * 0.12;
    crystal.rotation.y += delta * 0.8;

    // Camera in prima persona (+ head bob)
    camera.position.set(
      playerBody.position.x,
      playerBody.position.y + CONFIG.eyeHeight,
      playerBody.position.z
    );
    camera.rotation.y = yaw;
    camera.rotation.x = pitch;

    const speed = Math.hypot(playerBody.velocity.x, playerBody.velocity.z);
    // L10: con il gioco in pausa non si avanza il bob (moving=false) — prima
    // velocity/isGrounded restavano congelati e il bob continuava dietro
    // l'overlay.
    const moving = isGameplayActive() && isGrounded && speed > 1.5;
    if (moving) bobPhase += delta * (7 + speed * 0.35);
    else bobPhase *= Math.max(0, 1 - delta * 6);
    const bobAmp = Math.min(speed / CONFIG.moveSpeed, 1) * 0.032;
    camera.position.y += Math.sin(bobPhase) * bobAmp;
    camera.position.x += Math.cos(bobPhase * 0.5) * bobAmp * 0.5;
    // G4: abbassamento morbido e recupero rapido dopo un atterraggio.
    landingKick = Math.max(0, landingKick - delta * 2.6);
    // L8: dip monotono — sin(kick·π/2) va da 0 (impatto nullo) a 1 (impatto
    // massimo). Prima sin(kick·π) era ~0 a kick=1.0 (atterraggio più duro),
    // quindi il dip cresceva mentre il kick decadeva: intuito invertito.
    camera.position.y -= Math.sin(landingKick * Math.PI * 0.5) * .085;
    constrainCameraToArena();
    camera.rotation.z = Math.sin(bobPhase * .5) * bobAmp * .32;
    cameraDamageKick = Math.max(0, cameraDamageKick - delta * .8);
    camera.rotation.x += Math.sin(elapsed * 46) * cameraDamageKick;
    const targetFov = isSprinting ? 81 : 75;
    camera.fov += (targetFov - camera.fov) * Math.min(1, delta * 7);
    camera.updateProjectionMatrix();

    // Muzzle flash e rinculo
    muzzleLight.intensity = Math.max(0, muzzleLight.intensity - delta * 200);
    for (const flash of Object.values(weaponFlashMeshes)) {
      flash.material.opacity = Math.max(0, flash.material.opacity - delta * 14);
      flash.scale.multiplyScalar(Math.max(0, 1 - delta * 14));
    }
    gunRecoil = Math.max(0, gunRecoil - delta * 0.35);
    gun.position.z = -0.45 + gunRecoil;
    gun.position.x = 0.25 + Math.cos(bobPhase * .5) * bobAmp * .85;
    gun.position.y = -0.21 - Math.abs(Math.sin(bobPhase)) * bobAmp * .72 - (isSprinting ? .035 : 0);
    const meleeProgress = meleeTimer > 0 ? 1 - meleeTimer / CONFIG.meleeDuration : 0;
    const meleeSwing = meleeTimer > 0 ? Math.sin(meleeProgress * Math.PI) : 0;
    // G5: l'arma scende e si inclina durante il cambio caricatore.
    reloadDip = THREE.MathUtils.lerp(reloadDip, gameState.reloading ? 1 : 0, Math.min(1, delta * 7));
    gun.position.y -= reloadDip * .085;
    gun.rotation.x = -meleeSwing * 1.12 - reloadDip * .55;
    gun.rotation.y = meleeSwing * .38;
    gun.rotation.z = Math.cos(bobPhase * .5) * bobAmp * .65 + meleeSwing * .18;
    // Le altre armi in prima persona seguono bob/rinculo del pulse.
    const viewX = gun.position.x;
    const viewY = gun.position.y;
    const viewZ = gun.position.z;
    for (const id of ['railgun', 'minigun', 'rpg', 'flame']) {
      const v = weaponViews[id];
      v.position.x = viewX;
      v.position.y = viewY;
      v.position.z = viewZ;
      v.rotation.copy(gun.rotation);
    }
    // VULCAN: le canne ruotano velocemente quando si spara (o in idle lento).
    if (minigunBarrel) {
      const spin = gameState.weapon === 'minigun' && (triggerDown || fireCooldown < WEAPON_TUNING.minigun.fireRate * 2)
        ? 22 : 1.2;
      minigunBarrel.rotation.z += delta * spin;
    }
    // N7: dirty-check — le classi DOM si aggiornano solo quando lo stato cambia.
    if (hudSprinting !== isSprinting) { hudSprinting = isSprinting; gameHudEl.classList.toggle('sprinting', isSprinting); }
    crosshairFireTimer = Math.max(0, crosshairFireTimer - delta);
    const crosshairActive = crosshairFireTimer > 0;
    if (crosshairFiring !== crosshairActive) { crosshairFiring = crosshairActive; crosshairEl.classList.toggle('firing', crosshairActive); }

    // Vapore dai tombini: sprite morbidi con deriva e dissolvenza non sincronizzata.
    for (const p of animatedSteam) {
      const life = (elapsed * p.speed + p.phase) % 1;
      p.sprite.position.set(p.base.x + p.drift * life, p.base.y + life * 2.8, p.base.z + Math.sin(life * 5 + p.phase * 9) * .18);
      p.sprite.scale.setScalar(.28 + life * 1.6);
      p.mat.opacity = Math.sin(life * Math.PI) * .16;
      p.mat.rotation = elapsed * .08 + p.phase;
    }

    if (isGameplayActive()) updateTargetMarkers(delta);
    if (gameState.started) audio.updateDroneHums(drones, camera, delta);
    radarTimer -= delta;
    if (isGameplayActive() && radarTimer <= 0) { updateRadar(elapsed); radarTimer = .1; }
    fpsFrames++; fpsTimer += delta;
    if (fpsTimer >= .5) {
      const measuredFps = Math.round(fpsFrames / fpsTimer);
      hudController.setFPS(measuredFps);
      if(gameState.started&&elapsed>5)graphicsManager.updateFPS(measuredFps,.5);
      fpsFrames = 0; fpsTimer = 0;
    }

    // Render WebGPU/TSL con GTAO, bloom, SMAA, grana, grading, shockwave e vignetta.
    // La posizione del giocatore non modifica mai né questo percorso né i
    // materiali illuminati dell'arena.
    renderPipeline.render(delta, elapsed);
    explosionSystem.finishWarmup();
    frameErrorCount = 0;
    } catch (error) {
      // Resilienza del motore: un errore isolato in un frame non deve uccidere
      // il loop di rendering. Se l'errore persiste, ferma la simulazione in
      // modo controllato invece di lasciare la pagina bloccata.
      frameErrorCount++;
      if (frameErrorCount === 1) console.error('VIBE frame error', error);
      // Questo fallback riguarda errori della simulazione esterni alla pipeline;
      // gli errori post-processing vengono isolati e ritentati dal controller.
      accumulator = Math.min(accumulator, FIXED_STEP);
      try {
        renderer.setRenderTarget(null);
        renderer.setMRT?.(null);
        renderer.render(scene, camera);
      } catch (fallbackError) {
        if (frameErrorCount === 1) console.error('VIBE fallback render error', fallbackError);
      }
      if (frameErrorCount >= 60 && !degradedNoticeShown) {
        degradedNoticeShown = true;
        showRendererFailure(t('fail.degraded'));
      }
    }
  }
  renderer.setAnimationLoop(animate);

  /* ============================================================
     12. RESIZE
     ============================================================ */
  let resizePending = false;
  function scheduleResize() {
    if (resizePending) return;
    resizePending = true;
    requestAnimationFrame(() => {
      resizePending = false;
      const width = Math.max(1, Math.floor(window.innerWidth));
      const height = Math.max(1, Math.floor(window.innerHeight));
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
      renderPipeline.resize(width, height);
      if (graphicsManager.profile) updateReflectionQuality(graphicsManager.profile);
    });
  }
  window.addEventListener('resize', scheduleResize, { passive: true });
  window.visualViewport?.addEventListener('resize', scheduleResize, { passive: true });
  }

  const webGPUAvailable = typeof navigator !== 'undefined'
    && navigator.gpu
    && typeof navigator.gpu.requestAdapter === 'function';
  if (!webGPUAvailable) {
    showWebGPUUnavailable(t('gpu.noNavigator'));
  } else {
    // Watchdog: se il boot non completa entro il timeout (es. un errore silenzioso
    // o una risorsa che non risolve), mostra il pannello di recovery invece di
    // lasciare la barra di caricamento bloccata.
    let bootFinished = false;
    const bootWatchdog = setTimeout(() => {
      if (!bootFinished) {
        console.warn('VIBE boot watchdog: timeout durante l\'inizializzazione');
        showRendererFailure(t('fail.timeout'));
      }
    }, 120000);
    try {
      await bootGame();
      bootFinished = true;
      clearTimeout(bootWatchdog);
    } catch (error) {
      bootFinished = true;
      clearTimeout(bootWatchdog);
      console.error('VIBE boot error', error);
      showRendererFailure(t('fail.error'));
    }
  }
