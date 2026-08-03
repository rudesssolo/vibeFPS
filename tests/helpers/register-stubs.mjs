// I moduli di gioco importano 'three' e 'three/tsl', che in pagina sono risolti
// dall'importmap di index.html. Node non conosce le importmap: questo hook
// rimappa quei due specificatori su stub minimali, così la logica pura dei
// sistemi (pool, contatori, cicli di vita) è testabile senza WebGPU né browser.
//
// Registrato da `npm test` con --import.
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register(pathToFileURL(new URL('./stub-loader.mjs', import.meta.url).pathname));
