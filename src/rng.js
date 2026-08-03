// PRNG lineare congruenziale deterministico (LCG), condiviso da tutti i
// generatori procedurali del progetto (texture, facciate, droni, stelle).
// Stesso seed -> stessa sequenza: le scene rimangono riproducibili.
export function makeRng(seed) {
  let value = seed || 1;
  return () => {
    value = (value * 16807) % 2147483647;
    return (value - 1) / 2147483646;
  };
}
