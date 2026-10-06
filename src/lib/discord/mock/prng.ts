/**
 * Deterministic randomness for the demo world.
 * Only integer ops and basic IEEE-754 arithmetic are used (no Math.random / exp / log / sin / pow), because the
 * results of those transcendental functions may differ between JS engines and would change ids and timestamps.
 */

/** FNV-1a with a murmur3 finaliser: 32-bit hash of a string. */
export function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max], both inclusive. */
  int(min: number, max: number): number;
  chance(probability: number): boolean;
  pick<T>(items: readonly T[]): T;
  /** Picks an entry with probability proportional to its weight. */
  weighted<T>(entries: readonly (readonly [T, number])[]): T;
  /** Fisher-Yates; returns a new array. */
  shuffle<T>(items: readonly T[]): T[];
}

/** mulberry32 seeded from a string. Equal seeds produce equal sequences. */
export function createRng(seed: string): Rng {
  let state = hashString(seed);

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));

  return {
    next,
    int,
    chance: (probability) => next() < probability,
    pick: (items) => {
      if (items.length === 0) throw new Error('rng.pick: empty list');
      return items[int(0, items.length - 1)];
    },
    weighted: (entries) => {
      let total = 0;
      for (const entry of entries) total += entry[1];
      let r = next() * total;
      for (const entry of entries) {
        r -= entry[1];
        if (r < 0) return entry[0];
      }
      return entries[entries.length - 1][0];
    },
    shuffle: (items) => {
      const out = items.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = int(0, i);
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
  };
}
