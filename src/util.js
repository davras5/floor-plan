// Small helpers shared by several modules.

// Seeded random numbers in [0, 1) (mulberry32), so generated content looks the same on every load.
export function seededRandom(seed) {
  return function () {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Frame-rate independent smoothing of `from` toward `to` (rate: 1/s, higher is snappier).
export const damp = (from, to, rate, dt) => from + (to - from) * (1 - Math.exp(-rate * dt));

export const easeOutCubic = (t) => 1 - (1 - t) ** 3;
