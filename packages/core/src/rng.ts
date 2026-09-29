/** 确定性 PRNG（xorshift32）。游戏逻辑禁止使用 Math.random()。 */
export function createRng(seed: number): () => number {
  let s = seed >>> 0;
  if (s === 0) s = 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}

/** 返回 [0, bound) 的整数。 */
export function rngInt(rand: () => number, bound: number): number {
  return Math.floor(rand() * bound) >>> 0;
}
