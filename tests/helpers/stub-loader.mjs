// Resolve hook: 'three' e 'three/tsl' puntano agli stub di test.
// Ogni altro specificatore segue la risoluzione normale di Node.
const ALIASES = new Map([
  ['three', './three-stub.mjs'],
  ['three/webgpu', './three-stub.mjs'],
  ['three/tsl', './tsl-stub.mjs']
]);

export function resolve(specifier, context, nextResolve) {
  const alias = ALIASES.get(specifier);
  if (alias) {
    return { shortCircuit: true, url: new URL(alias, import.meta.url).href };
  }
  return nextResolve(specifier, context);
}
