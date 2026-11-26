/** A uniform random number in [0, 1). */
export type Random = () => number;

/**
 * mulberry32: a small, fast 32-bit PRNG. Its state is one integer, and every operation is exact
 * integer arithmetic, so the same seed gives the same sequence everywhere.
 */
export function mulberry32(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * A 32-bit seed for one stream (FNV-1a of `<seed>:<label>`). Each coin gets its own stream, so
 * adding a coin doesn't change the others' prices.
 */
export function seedFor(seed: number, label: string): number {
  let hash = 0x811c9dc5;
  for (const char of `${seed}:${label}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** A standard normal draw (Box–Muller). Always takes exactly two numbers from `random`. */
export function gaussian(random: Random): number {
  const u = 1 - random(); // (0, 1]: log(0) would be -Infinity
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** A random seed for a run nobody asked to reproduce. */
export function randomSeed(): number {
  return Math.floor(Math.random() * 4_294_967_296);
}
