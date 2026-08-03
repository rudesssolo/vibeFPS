// Stub di 'three/tsl' per i test Node.
//
// I nodi TSL sono costruttori di grafo che si compongono per concatenazione
// (`.mul().div().toVar()`, ...). Per il test non serve valutare il grafo: serve
// che il CODICE che lo costruisce venga eseguito davvero — così un simbolo non
// importato o una chiamata errata falliscono anche fuori dal browser.
//
// Un Proxy che risponde a qualunque proprietà e a qualunque chiamata
// restituendo se stesso soddisfa l'intera catena.

const node = new Proxy(function stubNode() {}, {
  get(target, property) {
    if (property === Symbol.toPrimitive || property === 'valueOf') return () => 0;
    if (property === Symbol.iterator) return undefined;
    return node;
  },
  apply() { return node; },
  construct() { return node; },
  has() { return true; }
});

/** Fn(cb) restituisce un callable che esegue cb: il corpo dello shader gira. */
export const Fn = callback => (...args) => callback(...args);

/** Loop esegue il corpo una volta, così anche il codice interno viene eseguito. */
export function Loop(count, callback) {
  if (typeof count === 'function') return count();
  if (typeof callback === 'function') callback();
  return node;
}

// Tutti gli altri simboli TSL usati dai moduli di gioco. Sono sia funzioni sia
// valori-nodo, e il Proxy copre entrambi gli usi.
export const abs = node;
export const attribute = node;
export const builtinAOContext = node;
export const cameraPosition = node;
export const color = node;
export const colorToDirection = node;
export const convertToTexture = node;
export const directionToColor = node;
export const dot = node;
export const exp = node;
export const float = node;
export const fract = node;
export const hash = node;
export const instancedBufferAttribute = node;
export const length = node;
export const max = node;
export const min = node;
export const mix = node;
export const modelPosition = node;
export const modelScale = node;
export const mrt = node;
export const normalize = node;
export const normalView = node;
export const pass = node;
export const positionGeometry = node;
export const positionWorld = node;
export const pow = node;
export const reflector = node;
export const renderOutput = node;
export const sample = node;
export const saturate = node;
export const screenCoordinate = node;
export const screenUV = node;
export const sin = node;
export const smoothstep = node;
export const sqrt = node;
export const triNoise3D = node;
export const uniform = node;
export const uv = node;
export const vec2 = node;
export const vec3 = node;
export const vec4 = node;
