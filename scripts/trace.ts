// One bot-only game, printing light masses every 10 s to see where the mass goes.
import { defaultConfig, human, newGame, step, burn, type Config } from "../src/sim3";
import { botTurn, decide, defaultStyle, type Memories } from "../src/sim3/bots";
const cfg: Config = { ...defaultConfig };
const seed = Number(process.argv[2] ?? 1);
const s = newGame(seed, cfg);
const me = human(s);
const dt = 1 / 30;
const mem: Memories = new Map();
let next = 0;
let burns = 0;
while (s.status === "playing" && s.time < 180) {
  for (const it of botTurn(s, cfg, dt, defaultStyle, mem)) if (burn(s, it.id, it.dx, it.dy, it.strength, cfg)) burns++;
  const phase = (me.id * 0.137) % defaultStyle.think;
  if (Math.floor((s.time - phase) / defaultStyle.think) !== Math.floor((s.time - dt - phase) / defaultStyle.think)) {
    const it = decide(s, me.id, cfg, defaultStyle, mem);
    if (it && burn(s, me.id, it.dx, it.dy, it.strength, cfg)) burns++;
  }
  for (const e of step(s, cfg, dt)) {
    if (e.type === "gone" && e.kind === "light") {
      const by = s.bodies.find((b) => b.id === e.by);
      console.log(`      ${s.time.toFixed(1)}s ${e.name} absorbed by ${by?.name || `a ${by?.mass.toFixed(0)}-lumen body`} (${by?.mass.toFixed(0)})`);
    }
  }
  if (s.time >= next) {
    next += 10;
    const ls = s.bodies.filter((b) => b.kind === "light").map((b) => `${b.name} ${b.mass.toFixed(1)}${b.alive ? "" : "†"}`).join("  ");
    const orbs = s.bodies.filter((b) => b.kind === "orb" && b.alive);
    const exhaust = orbs.filter((b) => b.from);
    console.log(`${s.time.toFixed(0).padStart(4)}s  ${ls}   orbs ${orbs.length} (exhaust ${exhaust.length}, mass ${orbs.reduce((m, b) => m + b.mass, 0).toFixed(1)})  burns ${burns}`);
  }
}
console.log(s.status);
