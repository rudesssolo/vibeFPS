// L1 — Internazionalizzazione dell'interfaccia. Dizionari flat per chiave;
// la lingua di default è l'inglese (richiesta demo), l'italiano è selezionabile
// dal pannello settings e persistito in localStorage (vedi config.js).
//
// Convenzioni:
// - le chiavi con prefisso HTML nel nome ("Html") contengono markup e vanno
//   applicate con innerHTML; tutte le altre con textContent;
// - i segnaposto {nome} vengono interpolati da t(key, vars);
// - chiave mancante → fallback all'inglese → fallback alla chiave stessa.
import { getStoredLanguage, storeLanguage } from './config.js';

const en = {
  // HUD statico
  'hud.hintHtml': '<kbd>WASD</kbd> MOVE · <kbd>SHIFT</kbd> SPRINT · <kbd>SPACE</kbd> JUMP · <kbd>R</kbd> RELOAD · <kbd>RMB</kbd> MELEE · <kbd>M</kbd> AUDIO · <kbd>ESC</kbd> PAUSE',
  'mission.label': 'ACTIVE OBJECTIVE',
  'mission.objective': 'NEUTRALIZE THE DRONES',
  'vitals.health': 'HEALTH',
  'vitals.shield': 'SHIELD',
  'vitals.stamina': 'STAMINA',
  'weapon.reloading': 'RELOADING',
  'hud.wave': 'WAVE {wave}',

  // Audio / mute
  'sound.onHtml': 'AUDIO: IMMERSIVE · <b>M</b> MUTE',
  'sound.offHtml': 'AUDIO: <b class="danger-text">MUTED</b> · M ENABLE',
  'mute.badgeHtml': ' · <span class="danger-text"><b>AUDIO MUTED</b> — press M to re-enable</span>',

  // Overlay (start / pausa / reset)
  'overlay.brief.start': 'Enter the urban combat zone, neutralize the sentinel units and survive increasingly aggressive waves. Procedural 3D audio, PBR materials, dynamic lighting and real-time physics.',
  'overlay.cta.start': 'INITIALIZE SIMULATION',
  'overlay.cta.resume': 'RESUME SIMULATION',
  'overlay.keysHtml': '<kbd>WASD</kbd> move · <kbd>SHIFT</kbd> sprint · <kbd>SPACE</kbd> jump · <kbd>R</kbd> reload · LMB fire · RMB melee',
  'overlay.headphones': '◆ HEADPHONES RECOMMENDED',
  'overlay.audioNote': '· audio engages when entering the simulation',
  'overlay.title.paused': 'LINK&nbsp;PAUSED',
  'overlay.sub.paused': 'SIMULATION SUSPENDED · COMBAT STATE PRESERVED',
  'overlay.brief.paused': 'WAVE {wave} · SCORE {score} · The simulation is suspended: physics, drones and progression are frozen until you return.',
  'overlay.title.reset': 'LEVEL RESET',
  'overlay.sub.reset': 'SIMULATION READY · NEW RUN CONFIGURED',
  'overlay.brief.reset': 'WAVE {wave} · SCORE {score} · Press the button to re-enter combat.',
  'loading.initial': 'WAITING FOR THE GRAPHICS LINK...',

  // Errori GPU / renderer
  'gpu.title': 'WEBGPU REQUIRED',
  'gpu.sub': 'GRAPHICS LINK UNAVAILABLE · SIMULATION BLOCKED',
  'gpu.brief': 'The simulation uses WebGPU exclusively. Update your browser or enable WebGPU on this device to continue.',
  'gpu.cta': 'WEBGPU UNAVAILABLE',
  'gpu.warning': 'WEBGPU WARNING',
  'gpu.lost': 'The WebGPU device was lost. Reload the page after checking the graphics driver.',
  'gpu.noAdapter': 'The browser did not provide a usable WebGPU adapter/device.',
  'gpu.noNavigator': 'This browser does not expose navigator.gpu.',
  'gpu.notWebgpu': 'The active renderer is not WebGPU.',
  'gpu.default': 'This device does not expose WebGPU or cannot create a compatible device.',
  'fail.title': 'RENDERER OFFLINE',
  'fail.sub': 'SAFETY STATE · THE SIMULATION CANNOT CONTINUE',
  'fail.build': 'RENDERER // OFFLINE',
  'fail.timeout': 'BOOT TIMEOUT · INITIALIZATION DID NOT COMPLETE. RELOAD THE PAGE.',
  'fail.error': 'BOOT ERROR · INITIALIZATION INTERRUPTED. RELOAD THE PAGE.',
  'fail.degraded': 'SIMULATION DEGRADED · POST-PROCESSING BYPASS',

  // Banner ondata / stato giocatore
  'wave.subtitle': 'HOSTILE CONTACTS DETECTED',
  'wave.lost.title': 'LINK LOST',
  'wave.lost.sub': 'NEURAL RECALIBRATION IN PROGRESS',
  'wave.restored.title': 'LINK RESTORED',
  'wave.restored.sub': 'COMBAT SYSTEMS OPERATIONAL',
  'wave.reset.sub': 'SIMULATION RESTARTED',

  // Toast (prefissi in grassetto restano nei call site)
  'toast.scanner': '{count} HOSTILE SIGNATURES ACQUIRED',
  'toast.ammo': '+{amount} AMMO',
  'toast.resupply': 'RESUPPLY',
  'toast.unit': 'UNIT {id}',
  'toast.neutralized': 'NEUTRALIZED',
  'toast.heal': 'HEALTH +{amount}',
  'toast.critical': 'CRITICAL INTEGRITY',
  'toast.warning': 'WARNING',
  'toast.waveBonus': 'SHIELD +{shield} · AMMO +{ammo}',
  'toast.reload': 'MAG CHANGE',
  'toast.reset': 'LEVEL RESET',
  'toast.system': 'SYSTEM',
  'toast.mission': 'TEST AREA ACTIVE',
  'toast.missionLabel': 'MISSION',
  'toast.renderLabel': 'RENDER',
  'score.kill': 'SENTINEL DOWN',
  'score.impact': 'IMPACT',

  // Pannello settings
  'settings.title': 'SIMULATION SETTINGS',
  'settings.music': 'MUSIC',
  'settings.sfx': 'EFFECTS',
  'settings.ambience': 'AMBIENCE',
  'settings.sensitivity': 'SENSITIVITY',
  'settings.reset': 'RESET LEVEL',
  'settings.qualityAria': 'Graphics quality',
  'settings.langAria': 'Language'
};

const it = {
  // HUD statico
  'hud.hintHtml': '<kbd>WASD</kbd> MUOVI · <kbd>SHIFT</kbd> SCATTO · <kbd>SPAZIO</kbd> SALTA · <kbd>R</kbd> RICARICA · <kbd>MOUSE DX</kbd> MELEE · <kbd>M</kbd> AUDIO · <kbd>ESC</kbd> PAUSA',
  'mission.label': 'OBIETTIVO ATTIVO',
  'mission.objective': 'NEUTRALIZZA I DRONI',
  'vitals.health': 'VITA',
  'vitals.shield': 'SCUDO',
  'vitals.stamina': 'ENERGIA',
  'weapon.reloading': 'RICARICA IN CORSO',
  'hud.wave': 'ONDATA {wave}',

  // Audio / mute
  'sound.onHtml': 'AUDIO: IMMERSIVE · <b>M</b> MUTE',
  'sound.offHtml': 'AUDIO: <b class="danger-text">MUTED</b> · M ENABLE',
  'mute.badgeHtml': ' · <span class="danger-text"><b>AUDIO MUTED</b> — premi M per riattivare</span>',

  // Overlay (start / pausa / reset)
  'overlay.brief.start': 'Entra nel poligono urbano, neutralizza le unità sentinella e sopravvivi a ondate sempre più aggressive. Audio 3D procedurale, materiali PBR, illuminazione dinamica e fisica in tempo reale.',
  'overlay.cta.start': 'INIZIALIZZA SIMULAZIONE',
  'overlay.cta.resume': 'RIPRENDI SIMULAZIONE',
  'overlay.keysHtml': '<kbd>WASD</kbd> muovi · <kbd>SHIFT</kbd> scatto · <kbd>SPAZIO</kbd> salta · <kbd>R</kbd> ricarica · mouse sx spara · mouse dx melee',
  'overlay.headphones': '◆ CUFFIE CONSIGLIATE',
  'overlay.audioNote': '· il suono si attiva entrando nella simulazione',
  'overlay.title.paused': 'LINK&nbsp;PAUSED',
  'overlay.sub.paused': 'SIMULAZIONE SOSPESA · STATO DI COMBATTIMENTO CONSERVATO',
  'overlay.brief.paused': 'ONDATA {wave} · SCORE {score} · La simulazione è sospesa: fisica, droni e progressione sono congelati fino al rientro.',
  'overlay.title.reset': 'LEVEL RESET',
  'overlay.sub.reset': 'SIMULAZIONE PRONTA · NUOVA RUN CONFIGURATA',
  'overlay.brief.reset': 'ONDATA {wave} · SCORE {score} · Premi il pulsante per rientrare nel combattimento.',
  'loading.initial': 'IN ATTESA DEL LINK GRAFICO...',

  // Errori GPU / renderer
  'gpu.title': 'WEBGPU RICHIESTO',
  'gpu.sub': 'LINK GRAFICO NON DISPONIBILE · SIMULAZIONE BLOCCATA',
  'gpu.brief': 'La simulazione usa esclusivamente WebGPU. Aggiorna il browser o abilita WebGPU sul dispositivo per continuare.',
  'gpu.cta': 'WEBGPU NON DISPONIBILE',
  'gpu.warning': 'AVVISO WEBGPU',
  'gpu.lost': 'Il device WebGPU è stato perso. Ricarica la pagina dopo aver verificato il driver grafico.',
  'gpu.noAdapter': 'Il browser non ha fornito un adapter/device WebGPU utilizzabile.',
  'gpu.noNavigator': 'Questo browser non espone navigator.gpu.',
  'gpu.notWebgpu': 'Il renderer attivo non è WebGPU.',
  'gpu.default': 'Questo dispositivo non espone WebGPU o non riesce a creare un device compatibile.',
  'fail.title': 'RENDERER OFFLINE',
  'fail.sub': 'STATO DI SICUREZZA · LA SIMULAZIONE NON PUÒ CONTINUARE',
  'fail.build': 'RENDERER // OFFLINE',
  'fail.timeout': 'BOOT TIMEOUT · INIZIALIZZAZIONE NON COMPLETATA. RICARICA LA PAGINA.',
  'fail.error': 'BOOT ERROR · INIZIALIZZAZIONE INTERROTTA. RICARICA LA PAGINA.',
  'fail.degraded': 'SIMULATION DEGRADED · POST-PROCESSING BYPASS',

  // Banner ondata / stato giocatore
  'wave.subtitle': 'CONTATTI OSTILI RILEVATI',
  'wave.lost.title': 'LINK LOST',
  'wave.lost.sub': 'RICALIBRAZIONE NEURALE IN CORSO',
  'wave.restored.title': 'LINK RESTORED',
  'wave.restored.sub': 'SISTEMI DI COMBATTIMENTO OPERATIVI',
  'wave.reset.sub': 'SIMULAZIONE RIAVVIATA',

  // Toast
  'toast.scanner': '{count} FIRME OSTILI ACQUISITE',
  'toast.ammo': '+{amount} MUNIZIONI',
  'toast.resupply': 'RIFORNIMENTO',
  'toast.unit': 'UNITÀ {id}',
  'toast.neutralized': 'NEUTRALIZZATA',
  'toast.heal': 'VITA +{amount}',
  'toast.critical': 'INTEGRITÀ CRITICA',
  'toast.warning': 'AVVISO',
  'toast.waveBonus': 'SCUDO +{shield} · MUNIZIONI +{ammo}',
  'toast.reload': 'CAMBIO CARICATORE',
  'toast.reset': 'LIVELLO RESETTATO',
  'toast.system': 'SISTEMA',
  'toast.mission': 'AREA DI TEST ATTIVA',
  'toast.missionLabel': 'MISSIONE',
  'toast.renderLabel': 'RENDER',
  'score.kill': 'SENTINEL DOWN',
  'score.impact': 'IMPATTO',

  // Pannello settings
  'settings.title': 'SIMULATION SETTINGS',
  'settings.music': 'MUSICA',
  'settings.sfx': 'EFFETTI',
  'settings.ambience': 'AMBIENTE',
  'settings.sensitivity': 'SENSIBILITÀ',
  'settings.reset': 'RESET LIVELLO',
  'settings.qualityAria': 'Qualità grafica',
  'settings.langAria': 'Lingua interfaccia'
};

export const STRINGS = Object.freeze({ en: Object.freeze(en), it: Object.freeze(it) });
export const AVAILABLE_LANGUAGES = Object.freeze(['en', 'it']);

// Lettura lazy dello storage: il modulo resta importabile in contesti senza
// localStorage (test Node) e la lingua corrente si decide al primo uso.
let currentLanguage = null;

function ensureLanguage() {
  if (currentLanguage === null) currentLanguage = getStoredLanguage();
  return currentLanguage;
}

export function getLanguage() {
  return ensureLanguage();
}

export function setLanguage(lang) {
  currentLanguage = lang === 'it' ? 'it' : 'en';
  storeLanguage(currentLanguage);
  return currentLanguage;
}

export function t(key, vars = null) {
  const lang = ensureLanguage();
  let template = STRINGS[lang][key] ?? STRINGS.en[key];
  if (template === undefined) return key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      template = template.replaceAll(`{${name}}`, String(value));
    }
  }
  return template;
}
