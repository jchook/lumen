/**
 * Depth reward: does thinking further ahead keep winning?  bun scripts/depth.ts [games]
 * Plays depth-d against depth-(d+1) on mirrored boards, both colours, and reports win rates.
 * A shallow game plateaus immediately; a deep one rewards every extra ply.
 */
import { defaultConfig, newGame, play, search, type Config } from "../src/sim2";

const cfg: Config = { ...defaultConfig };
const N = Number(process.argv[2] ?? 24);

function match(dA: number, dB: number, seed: number, aFirst: boolean): { winner: "A" | "B" | "draw"; plies: number } {
  let s = newGame(seed, cfg);
  while (s.status === "playing") {
    const isA = (s.toMove === 0) === aFirst;
    const d = isA ? dA : dB;
    const m = search(s, d, cfg).move;
    const r = play(s, m, cfg);
    if (r.state === s) break;
    s = r.state;
  }
  const aId = aFirst ? 0 : 1;
  return { winner: s.winner === -1 ? "draw" : s.winner === aId ? "A" : "B", plies: s.ply };
}

function series(dA: number, dB: number): string {
  let a = 0, b = 0, d = 0, plies = 0;
  const t0 = performance.now();
  for (let seed = 1; seed <= N; seed++) {
    for (const first of [true, false]) {
      const r = match(dA, dB, seed, first);
      if (r.winner === "A") a++; else if (r.winner === "B") b++; else d++;
      plies += r.plies;
    }
  }
  const games = 2 * N;
  return `depth ${dA} vs depth ${dB}: deeper wins ${Math.round((100 * b) / games)}%  shallower ${Math.round((100 * a) / games)}%  draws ${Math.round((100 * d) / games)}%   avg plies ${(plies / games).toFixed(0)}   (${((performance.now() - t0) / 1000).toFixed(0)}s)`;
}

console.log(series(1, 2));
console.log(series(2, 3));
console.log(series(3, 4));
