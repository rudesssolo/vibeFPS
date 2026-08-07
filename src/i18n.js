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
  'hud.hintHtml': '<kbd>WASD</kbd> MOVE · <kbd>SHIFT</kbd> SPRINT · <kbd>SPACE</kbd> JUMP · <kbd>R</kbd> RELOAD · <kbd>Q</kbd> SWITCH WEAPON · <kbd>RMB</kbd> MELEE · <kbd>M</kbd> AUDIO · <kbd>ESC</kbd> PAUSE',
  'mission.label': 'ACTIVE OBJECTIVE',
  'mission.objective': 'NEUTRALIZE HOSTILES',
  'crystal.hud.defend': 'DEFEND VIBE CORE · {health}%',
  'crystal.hud.destroyed': 'VIBE CORE DESTROYED · REWARD LOST',
  'crystal.hud.boost': '2× DAMAGE ACTIVE · {seconds}s',
  'vitals.health': 'HEALTH',
  'vitals.shield': 'SHIELD',
  'vitals.stamina': 'STAMINA',
  'vitals.lives': 'LIVES',
  'vitals.title': 'VITAL SYSTEMS',
  'vitals.state': 'COMBAT READY',
  'weapon.reloading': 'RELOADING',
  'weapon.pulse': 'VX-9 PULSE',
  'weapon.railgun': 'RAILGUN',
  'weapon.minigun': 'VULCAN MINIGUN',
  'weapon.rpg': 'HELLSTORM RPG',
  'weapon.flame': 'PYRE FLAMETHROWER',
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
  'overlay.title.gameOver': 'GAME&nbsp;OVER',
  'overlay.sub.gameOver': 'NEURAL LINK DESTROYED · ALL LIVES CONSUMED',
  'overlay.brief.gameOver': 'WAVE {wave} · SCORE {score} · The neural link is severed. Restart the run from wave 1 to re-enter the arena.',
  'overlay.title.victory': 'ARENA&nbsp;SECURED',
  'overlay.sub.victory': 'OMEGA OVERLORD DESTROYED · SIMULATION COMPLETE',
  'overlay.brief.victory': 'FINAL SCORE {score} · You survived the Apex Council and terminated the Omega Overlord. The combat demo is complete.',
  'overlay.cta.restart': 'RESTART RUN',
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
  'fail.degraded': 'RENDER PIPELINE UNSTABLE · RELOAD TO RECOVER',

  // Banner ondata / stato giocatore
  'wave.subtitle': 'HOSTILE CONTACTS DETECTED',
  'wave.lost.title': 'LINK LOST',
  'wave.lost.sub': 'NEURAL RECALIBRATION IN PROGRESS',
  'wave.gameOver.title': 'LINK TERMINATED',
  'wave.gameOver.sub': 'NEURAL BACKUP DEPLETED · RUN OVER',
  'wave.victory.title': 'OMEGA TERMINATED',
  'wave.victory.sub': 'ALL HOSTILE COMMAND SIGNATURES ERASED',
  'wave.restored.title': 'LINK RESTORED',
  'wave.restored.sub': 'COMBAT SYSTEMS OPERATIONAL',
  'wave.reset.sub': 'SIMULATION RESTARTED',

  // Apex Sentinel (nemico speciale di fine ondata)
  'apex.vanguard': 'VANGUARD',
  'apex.wraith': 'WRAITH',
  'apex.vex': 'VEX',
  'apex.sentinel': 'SENTINEL PRIME',
  'apex.council': 'APEX COUNCIL',
  'apex.overlord': 'OMEGA OVERLORD',
  'apex.title': 'APEX {name} · T{tier}',
  'apex.subtitle': 'ELITE HOSTILE UNIT DETECTED · PRIORITY TARGET',
  'apex.gauntlet.title': 'APEX COUNCIL · T3',
  'apex.gauntlet.subtitle': 'FOUR ELITE SIGNATURES · SURVIVE THE GAUNTLET',
  'apex.final.title': 'OMEGA OVERLORD',
  'apex.final.subtitle': 'FINAL THREAT · COLOSSAL COMMAND UNIT DESCENDING',

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
  'score.apex': 'APEX DOWN',
  'score.mega': 'OMEGA DESTROYED',
  'toast.apex': '{name} DETECTED',
  'toast.apexDown': 'APEX FORCE TERMINATED',
  'toast.gauntlet': 'ALL FOUR APEX UNITS DEPLOYED',
  'toast.mega': '{name} DETECTED · FINAL THREAT',
  'toast.megaDown': 'COMMAND CORE ANNIHILATED',
  'toast.armor': 'FRONTAL ARMOR DESTROYED',
  'toast.phase': 'CRITICAL PHASE ENGAGED',
  'toast.split': 'CORE FRAGMENTED · MINI UNITS SPAWNED',
  'toast.summon': '{count} REINFORCEMENTS DEPLOYED',
  'toast.railgunDrop': 'RAILGUN CACHE LOCATED',
  'toast.railgunReady': 'RAILGUN ONLINE · Q TO SWITCH',
  'toast.pulseReady': 'PULSE ONLINE',
  'toast.weaponLocked': 'WEAPON NOT RECOVERED',
  'toast.weaponDrop': 'NEW WEAPON DROP DETECTED',
  'toast.weaponReady': 'WEAPON RECOVERED · READY',
  'toast.lifeLost': '{lives} LIVE(S) REMAINING',
  'toast.heart': 'SENTINEL CORE',
  'toast.lifeGained': 'LIFE RESTORED +1',
  'toast.gameOver': 'ALL LIVES DEPLETED · LINK SEVERED',
  'crystal.toast.defend': 'DEFEND THE VIBE CORE · SURVIVE FOR 2× DAMAGE',
  'crystal.toast.rebuilt': 'VIBE CORE RECONSTRUCTED · DEFEND FOR 2× DAMAGE',
  'crystal.toast.warning': 'CORE INTEGRITY {health}%',
  'crystal.toast.destroyed': 'VIBE CORE DESTROYED · WAVE REWARD LOST',
  'crystal.toast.secured': 'CORE SECURED · DOUBLE DAMAGE FOR 30 SECONDS',
  'crystal.toast.expired': 'DOUBLE DAMAGE EXPIRED',
  'crystal.destroyed.title': 'VIBE CORE DESTROYED',
  'crystal.destroyed.sub': 'COMPLETE THE WAVE · NO REWARD',
  'crystal.secured.title': 'VIBE CORE SECURED',
  'crystal.secured.sub': 'DOUBLE DAMAGE ONLINE · 30 SECONDS',

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
  'hud.hintHtml': '<kbd>WASD</kbd> MUOVI · <kbd>SHIFT</kbd> SCATTO · <kbd>SPAZIO</kbd> SALTA · <kbd>R</kbd> RICARICA · <kbd>Q</kbd> CAMBIA ARMA · <kbd>MOUSE DX</kbd> MELEE · <kbd>M</kbd> AUDIO · <kbd>ESC</kbd> PAUSA',
  'mission.label': 'OBIETTIVO ATTIVO',
  'mission.objective': 'NEUTRALIZZA GLI OSTILI',
  'crystal.hud.defend': 'DIFENDI IL NUCLEO VIBE · {health}%',
  'crystal.hud.destroyed': 'NUCLEO VIBE DISTRUTTO · PREMIO PERSO',
  'crystal.hud.boost': 'DANNI 2× ATTIVI · {seconds}s',
  'vitals.health': 'VITA',
  'vitals.shield': 'SCUDO',
  'vitals.stamina': 'ENERGIA',
  'vitals.lives': 'VITE',
  'vitals.title': 'SISTEMI VITALI',
  'vitals.state': 'COMBATTIMENTO PRONTO',
  'weapon.reloading': 'RICARICA IN CORSO',
  'weapon.pulse': 'VX-9 PULSE',
  'weapon.railgun': 'RAILGUN',
  'weapon.minigun': 'VULCAN MINIGUN',
  'weapon.rpg': 'HELLSTORM RPG',
  'weapon.flame': 'PYRE LANCIAFIAMME',
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
  'overlay.title.gameOver': 'GAME&nbsp;OVER',
  'overlay.sub.gameOver': 'LINK NEURALE DISTRUTTO · VITE ESAURITE',
  'overlay.brief.gameOver': 'ONDATA {wave} · SCORE {score} · Il link neurale è interrotto. Riavvia la run dall\'ondata 1 per rientrare nell\'arena.',
  'overlay.title.victory': 'ARENA&nbsp;SICURA',
  'overlay.sub.victory': 'OMEGA OVERLORD DISTRUTTO · SIMULAZIONE COMPLETATA',
  'overlay.brief.victory': 'PUNTEGGIO FINALE {score} · Hai superato il Consiglio Apex e annientato l\'Omega Overlord. La demo di combattimento è completa.',
  'overlay.cta.restart': 'RIAVVIA RUN',
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
  'fail.degraded': 'PIPELINE GRAFICA INSTABILE · RICARICA PER RIPRISTINARE',

  // Banner ondata / stato giocatore
  'wave.subtitle': 'CONTATTI OSTILI RILEVATI',
  'wave.lost.title': 'LINK LOST',
  'wave.lost.sub': 'RICALIBRAZIONE NEURALE IN CORSO',
  'wave.gameOver.title': 'LINK TERMINATED',
  'wave.gameOver.sub': 'BACKUP NEURALE ESAURITO · RUN TERMINATA',
  'wave.victory.title': 'OMEGA TERMINATO',
  'wave.victory.sub': 'TUTTE LE FIRME DI COMANDO OSTILI SONO STATE CANCELLATE',
  'wave.restored.title': 'LINK RESTORED',
  'wave.restored.sub': 'SISTEMI DI COMBATTIMENTO OPERATIVI',
  'wave.reset.sub': 'SIMULAZIONE RIAVVIATA',

  // Apex Sentinel (nemico speciale di fine ondata)
  'apex.vanguard': 'VANGUARD',
  'apex.wraith': 'WRAITH',
  'apex.vex': 'VEX',
  'apex.sentinel': 'SENTINEL PRIME',
  'apex.council': 'CONSIGLIO APEX',
  'apex.overlord': 'OMEGA OVERLORD',
  'apex.title': 'APEX {name} · T{tier}',
  'apex.subtitle': 'UNITÀ OSTILE ELITE RILEVATA · OBIETTIVO PRIORITARIO',
  'apex.gauntlet.title': 'CONSIGLIO APEX · T3',
  'apex.gauntlet.subtitle': 'QUATTRO FIRME ELITE · SOPRAVVIVI AL GAUNTLET',
  'apex.final.title': 'OMEGA OVERLORD',
  'apex.final.subtitle': 'MINACCIA FINALE · UNITÀ DI COMANDO COLOSSALE IN DISCESA',

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
  'score.apex': 'APEX ELIMINATO',
  'score.mega': 'OMEGA DISTRUTTO',
  'toast.apex': '{name} RILEVATO',
  'toast.apexDown': 'FORZA APEX NEUTRALIZZATA',
  'toast.gauntlet': 'TUTTE E QUATTRO LE UNITÀ APEX SCHIERATE',
  'toast.mega': '{name} RILEVATO · MINACCIA FINALE',
  'toast.megaDown': 'NUCLEO DI COMANDO ANNICHILITO',
  'toast.armor': 'ARMATURA FRONTALE DISTRUTTA',
  'toast.phase': 'FASE CRITICA ATTIVATA',
  'toast.split': 'NUCLEO FRAMMENTATO · UNITÀ MINI SCHIERATE',
  'toast.summon': '{count} RINFORZI SCHIERATI',
  'toast.railgunDrop': 'CACHE RAILGUN LOCALIZZATA',
  'toast.railgunReady': 'RAILGUN ONLINE · Q PER CAMBIARE',
  'toast.pulseReady': 'PULSE ONLINE',
  'toast.weaponLocked': 'ARMA NON RECUPERATA',
  'toast.weaponDrop': 'NUOVA ARMA DROPPATA',
  'toast.weaponReady': 'ARMA RECUPERATA · PRONTA',
  'toast.lifeLost': '{lives} VITE RIMANENTI',
  'toast.heart': 'NUCLEO SENTINELLA',
  'toast.lifeGained': 'VITA RIPRISTINATA +1',
  'toast.gameOver': 'VITE ESAURITE · LINK INTERROTTO',
  'crystal.toast.defend': 'DIFENDI IL NUCLEO VIBE · SOPRAVVIVI PER DANNI 2×',
  'crystal.toast.rebuilt': 'NUCLEO VIBE RICOSTRUITO · DIFENDILO PER DANNI 2×',
  'crystal.toast.warning': 'INTEGRITÀ NUCLEO {health}%',
  'crystal.toast.destroyed': 'NUCLEO VIBE DISTRUTTO · PREMIO ONDATA PERSO',
  'crystal.toast.secured': 'NUCLEO SALVO · DANNI DOPPI PER 30 SECONDI',
  'crystal.toast.expired': 'DANNI DOPPI TERMINATI',
  'crystal.destroyed.title': 'NUCLEO VIBE DISTRUTTO',
  'crystal.destroyed.sub': 'COMPLETA L’ONDATA · NESSUN PREMIO',
  'crystal.secured.title': 'NUCLEO VIBE SALVO',
  'crystal.secured.sub': 'DANNI DOPPI ONLINE · 30 SECONDI',

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
