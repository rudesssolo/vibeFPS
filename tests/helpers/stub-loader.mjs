// Resolve hook: 'three' e 'three/tsl' puntano agli stub di test.
// Ogni altro specificatore segue la risoluzione normale di Node.
const ALIASES = new Map([
  ['three', './three-stub.mjs'],
  ['three/webgpu', './three-stub.mjs'],
  ['three/tsl', './tsl-stub.mjs'],
  ['three/addons/geometries/RoundedBoxGeometry.js', './rounded-box-stub.mjs'],
  ['three/addons/tsl/display/GTAONode.js', './display-node-stub.mjs'],
  ['three/addons/tsl/display/BloomNode.js', './display-node-stub.mjs'],
  ['three/addons/tsl/display/SMAANode.js', './display-node-stub.mjs']
]);

export function resolve(specifier, context, nextResolve) {
  const alias = ALIASES.get(specifier);
  if (alias) {
    return { shortCircuit: true, url: new URL(alias, import.meta.url).href };
  }
  return nextResolve(specifier, context);
}
