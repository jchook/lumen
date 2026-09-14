/**
 * One hunter that never gives up (a follow goal, as a tap does) against a bot victim orbiting a
 * giant, in an otherwise empty sky:
 *
 *   bun scripts/chase.ts [key=value ...]
 *
 * For each pairing: whether and when the victim is caught, what the chase cost the hunter, and how
 * many times the two touched. The way to check the hunter-versus-victim numbers.
 */
import { defaultConfig, newGame, step, burn, setGoal, orbitalSpeed, radiusOf, type Config, type Body, type State } from "../src/sim3";
import { botTurn, defaultStyle, type Memories } from "../src/sim3/bots";

const cfg: Config = { ...defaultConfig, prizeEvery: 0, flareEvery: 0, roundSeconds: 0 };
for (const a of process.argv.slice(2)) {
  const [k, v] = a.split("=");
  if (k && v !== undefined) (cfg as unknown as Record<string, number>)[k] = Number(v);
}
const dt = 1 / 30;
function body(s: State, id: number, kind: Body["kind"], x: number, y: number, mass: number, extra: Partial<Body> = {}): Body {
  const b: Body = { id, kind, x, y, vx: 0, vy: 0, mass, name: "", ai: false, alive: true, anchored: false, from: 0, cooldown: 0, goal: null, queue: [], spent: 0, trait: "rival", prize: false, warp: 0, push: false, fed: 0, ...extra };
  s.bodies.push(b);
  return b;
}
function run(M: number, m: number, push: boolean, trait: Body["trait"], seconds = 40) {
  const s = newGame(1, cfg);
  s.bodies = [];
  s.time = 30;
  body(s, 3, "orb", 1200, 1200, 100);
  const R = radiusOf(100, cfg) + 200;
  const v = body(s, 2, "light", 1200 + R, 1200, m, { ai: true, name: "V", trait, vy: orbitalSpeed(100, R, cfg) });
  const h = body(s, 1, "light", 1200 + R + 350, 1200 + 200, M, { name: "You", push });
  const mem: Memories = new Map();
  const t0 = s.time;
  let touches = 0;
  while (s.time - t0 < seconds && v.alive && h.alive) {
    for (const it of botTurn(s, cfg, dt, defaultStyle, mem)) burn(s, it.id, it.dx, it.dy, it.strength, cfg);
    if (!h.goal || h.goal.follow !== 2) setGoal(s, 1, { x: 0, y: 0, follow: 2 });
    if (step(s, cfg, dt).some((e) => e.type === "absorb" && e.eater === 1 && e.food === 2)) touches++;
  }
  return { caught: v.alive ? -1 : s.time - t0, M: h.mass, m: v.mass, touches };
}
for (const push of [false, true]) {
  for (const trait of ["rival", "coward"] as const) {
    for (const [M, m] of [[40, 12], [25, 12], [60, 10], [40, 30]] as const) {
      const r = run(M, m, push, trait);
      const lost = (a: number, b: number) => `${((1 - b / a) * 100).toFixed(0).padStart(4)}%`;
      console.log(`${push ? "push  " : "cruise"} ${trait.padEnd(6)} ${String(M).padStart(3)} vs ${String(m).padStart(3)}: ${r.caught < 0 ? "no catch   " : `caught ${r.caught.toFixed(1).padStart(4)}s`}  hunter lost ${lost(M, r.M)}  victim lost ${lost(m, r.m)}  touches ${String(r.touches).padStart(3)}`);
    }
  }
}
