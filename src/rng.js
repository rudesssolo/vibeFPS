// PRNG lineare congruenziale deterministico (LCG), condiviso da tutti i
// generatori procedurali del progetto (texture, facciate, droni, stelle).
// Stesso seed -> stessa sequenza: le scene rimangono riproducibili.
export function makeRng(seed) {
  // L1: seed normalizzato — intero positivo in [1, 2147483646]. Prima, un seed
  // negativo passava dritto e l'LCG produceva output negativi (violando il
  // contratto [0,1) dei test), e il seed 0 collideva silenziosamente con il
  // seed 1. Ora valori non validi (0, negativi, NaN, undefined) cadono su un
  // default fisso e deterministico.
  let value = Number.isInteger(seed) && seed > 0 ? (seed % 2147483646) || 1 : 8119;
  return () => {
    value = (value * 16807) % 2147483647;
    return (value - 1) / 2147483646;
  };
}
