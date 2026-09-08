/**
 * Balance sweep for v3: bots only, many seeds.
 *
 *   bun scripts/arena.ts [games] [seconds]
 *
 * Reports how often anyone gets absorbed, how long games last, and how mass is distributed at the
 * end. The human slot is driven by the same bot brain so it's a fair n-way fight.
 */
import { defaultConfig, human, lights, newGame, step, burn, type Config } from "../src/sim3";
import { botTurn, decide, defaultStyle, type Memories } from "../src/sim3/bots";

const games = Number(process.argv[2] ?? 30);
const seconds = Number(process.argv[3] ?? 180);
const cfg: Config = { ...defaultConfig };
const dt = 1 / 30;

let kills = 0;
let finished = 0;
let durations: number[] = [];
let biggest: number[] = [];
let humanWins = 0;
let burns = 0;
for (let g = 1; g <= games; g++) {
  const s = newGame(g, cfg);
  const mem: Memories = new Map();
  const me = human(s);
  const start = lights(s).length;
  let t = 0;
  while (s.status === "playing" && t < seconds) {
    for (const it of botTurn(s, cfg, dt, defaultStyle, mem)) if (burn(s, it.id, it.dx, it.dy, it.strength, cfg)) burns++;
    // Human slot thinks like a bot too.
    const phase = (me.id * 0.137) % defaultStyle.think;
    if (Math.floor((s.time - phase) / defaultStyle.think) !== Math.floor((s.time - dt - phase) / defaultStyle.think)) {
      const it = decide(s, me.id, cfg, defaultStyle, mem);
      if (it && burn(s, me.id, it.dx, it.dy, it.strength, cfg)) burns++;
    }
    step(s, cfg, dt);
    t += dt;
  }
  const alive = lights(s).length;
  kills += start - alive;
  if (s.status !== "playing") {
    finished++;
    durations.push(t);
  }
  if (s.status === "won") humanWins++;
  const masses = s.bodies.filter((b) => b.kind === "light").map((b) => b.mass).sort((a, b) => b - a);
  biggest.push(masses[0]!);
}
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
console.log(`games ${games}  cap ${seconds}s`);
console.log(`lights absorbed per game: ${(kills / games).toFixed(2)} of ${cfg.players - 1} possible`);
console.log(`games that ended:         ${finished}/${games}  (mean ${avg(durations).toFixed(0)}s)`);
console.log(`human-slot wins:          ${humanWins}/${games}`);
console.log(`biggest light at end:     mean ${avg(biggest).toFixed(1)}  (start ${cfg.startMass})`);
console.log(`burns per game:           ${(burns / games).toFixed(0)}`);
