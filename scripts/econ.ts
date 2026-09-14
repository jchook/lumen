/**
 * The round's economy and shape, bots only, run to the bell (the human slot is a bot too):
 *
 *   bun scripts/econ.ts [games] [key=value ...]
 *
 * Every 30 s: free food on the board (count and mass), mass in wells, mass in lights, the leader
 * and the runner-up, lights standing. Then how often lights drift with no goal, and each game's
 * final standings. Config overrides on the command line, e.g. `aura=1 flareReturn=0` for the old
 * rules.
 */
import { defaultConfig, human, lights, newGame, step, burn, type Config } from "../src/sim3";
import { botTurn, defaultStyle, type Memories } from "../src/sim3/bots";

const games = Number(process.argv[2] ?? 10);
const cfg: Config = { ...defaultConfig };
for (const a of process.argv.slice(3)) {
  const [k, v] = a.split("=");
  if (k && v !== undefined) (cfg as unknown as Record<string, number>)[k] = Number(v);
}
const dt = 1 / 30;
const rows = new Map<number, number[]>();
let idle = 0;
let ticks = 0;
const finals: string[] = [];
for (let seed = 1; seed <= games; seed++) {
  const s = newGame(seed, cfg);
  human(s).ai = true;
  const mem: Memories = new Map();
  let next = 0;
  while (s.status === "playing" && s.time < 180) {
    for (const it of botTurn(s, cfg, dt, defaultStyle, mem)) burn(s, it.id, it.dx, it.dy, it.strength, cfg);
    step(s, cfg, dt);
    for (const b of s.bodies) if (b.kind === "light" && b.alive) { ticks++; if (!b.goal) idle++; }
    if (s.time < next) continue;
    const free = s.bodies.filter((b) => b.kind === "orb" && b.alive && !b.from && b.mass < cfg.gravityMass && b.warp <= 0);
    const heavy = s.bodies.filter((b) => b.kind === "orb" && b.alive && b.mass >= cfg.gravityMass);
    const ls = lights(s).map((b) => b.mass).sort((a, b) => b - a);
    let r = rows.get(next);
    if (!r) rows.set(next, (r = [0, 0, 0, 0, 0, 0, 0, 0]));
    r[0]! += free.length;
    r[1]! += free.reduce((m, b) => m + b.mass, 0);
    r[2]! += heavy.reduce((m, b) => m + b.mass, 0);
    r[3]! += ls.reduce((m, b) => m + b, 0);
    r[4]! += ls[0] ?? 0;
    r[5]! += ls[1] ?? 0;
    r[6]! += ls.length;
    r[7]! += 1;
    next += 30;
  }
  finals.push(`${seed}: ${lights(s).map((b) => b.mass.toFixed(0)).sort((a, b) => Number(b) - Number(a)).join("/") || "none"}`);
}
console.log("   t  free  freeMass  wellMass  lightMass   1st   2nd  standing");
for (const [t, r] of rows) {
  const n = r[7]!;
  const f = (i: number, w: number, d = 1) => (r[i]! / n).toFixed(d).padStart(w);
  console.log(`${String(t).padStart(4)}  ${f(0, 4)}  ${f(1, 8)}  ${f(2, 8)}  ${f(3, 9)}  ${f(4, 4, 0)}  ${f(5, 4, 0)}  ${f(6, 8)}`);
}
console.log(`lights drifting with no goal: ${((idle / ticks) * 100).toFixed(0)}% of the time`);
console.log(`final standings: ${finals.join("  ")}`);
