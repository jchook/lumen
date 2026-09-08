import { describe, expect, test } from "bun:test";
import { agility, burn, defaultConfig, delta, dist, human, lights, newGame, orbitalSpeed, predict, radiusOf, step, type Config, type State } from "./index";
import { botTurn, decide } from "./bots";

const cfg: Config = { ...defaultConfig };
const empty = (seed = 1): State => ({ seed, rng: () => 0.5, time: 0, status: "playing", nextId: 1, bodies: [] });
const add = (s: State, kind: "orb" | "light", x: number, y: number, mass: number, extra: Partial<State["bodies"][number]> = {}) => {
  const b = { id: s.nextId++, kind, x, y, vx: 0, vy: 0, mass, name: "", ai: false, alive: true, anchored: false, from: 0, cooldown: 0, ...extra };
  s.bodies.push(b);
  return b;
};
const run = (s: State, seconds: number, c = cfg) => {
  const ev: ReturnType<typeof step> = [];
  for (let i = 0; i < Math.round(seconds * 60); i++) step(s, c, 1 / 60, ev);
  return ev;
};
const total = (s: State) => s.bodies.reduce((m, b) => m + b.mass, 0);

describe("torus", () => {
  test("delta takes the short way round", () => {
    expect(delta(10, 10, cfg.width - 10, 10, cfg)).toEqual([-20, 0]);
    expect(delta(cfg.width - 10, 5, 10, cfg.height - 5, cfg)).toEqual([20, -10]);
  });
  test("bodies wrap", () => {
    const s = empty();
    const b = add(s, "orb", cfg.width - 1, 5, 1, { vx: 120 });
    run(s, 0.1);
    expect(b.x).toBeLessThan(20);
  });
});

describe("gravity", () => {
  test("a circular orbit stays circular", () => {
    const s = empty();
    const sun = add(s, "orb", 1200, 1200, 200, { anchored: true });
    const d = 300;
    const v = orbitalSpeed(sun.mass, d, cfg);
    const o = add(s, "orb", 1200 + d, 1200, 1, { vy: v });
    run(s, 30);
    expect(Math.abs(dist(o, sun, cfg) - d)).toBeLessThan(d * 0.05);
  });
  test("light bodies don't attract", () => {
    const s = empty();
    add(s, "orb", 1000, 1000, 5);
    const o = add(s, "orb", 1100, 1000, 5);
    run(s, 2);
    expect(o.x).toBe(1100);
  });
  test("a heavy light attracts", () => {
    const s = empty();
    add(s, "light", 1000, 1000, cfg.lightGravityMass + 10, { name: "big", ai: true });
    const o = add(s, "orb", 1300, 1000, 1);
    run(s, 2);
    expect(o.x).toBeLessThan(1300);
  });
  test("softening bounds acceleration at the centre", () => {
    const s = empty();
    add(s, "orb", 1000, 1000, 200, { anchored: true });
    const o = add(s, "orb", 1001, 1000, 1);
    run(s, 0.5);
    expect(Math.hypot(o.vx, o.vy)).toBeLessThanOrEqual(cfg.maxSpeed);
  });
});

describe("burn", () => {
  test("recoils, conserves mass and momentum, spawns exhaust", () => {
    const s = empty();
    const me = add(s, "light", 500, 500, 10, { name: "You" });
    const ev: ReturnType<typeof step> = [];
    expect(burn(s, me.id, 1, 0, 1, cfg, ev)).toBe(true);
    const ex = s.bodies.find((b) => b.from === me.id)!;
    expect(ex).toBeDefined();
    expect(me.mass + ex.mass).toBeCloseTo(10, 9);
    expect(me.vx).toBeGreaterThan(0);
    expect(ex.vx).toBeLessThan(0);
    expect(me.vx * me.mass + ex.vx * ex.mass).toBeCloseTo(0, 6);
    expect(ex.x).toBeLessThan(me.x - radiusOf(me.mass, cfg));
    expect(ev[0]?.type).toBe("burn");
  });
  test("cooldown blocks a second burn until it expires", () => {
    const s = empty();
    const me = add(s, "light", 500, 500, 10, { name: "You" });
    expect(burn(s, me.id, 1, 0, 1, cfg)).toBe(true);
    expect(burn(s, me.id, 1, 0, 1, cfg)).toBe(false);
    run(s, cfg.burnCooldown + 0.02);
    expect(burn(s, me.id, 1, 0, 1, cfg)).toBe(true);
  });
  test("strength scales the cost, with a floor", () => {
    const a = empty();
    const b = empty();
    const pa = add(a, "light", 500, 500, 10, { name: "You" });
    const pb = add(b, "light", 500, 500, 10, { name: "You" });
    burn(a, pa.id, 1, 0, 1, cfg);
    burn(b, pb.id, 1, 0, 0.01, cfg);
    const ag = agility(10, cfg);
    expect(10 - pa.mass).toBeCloseTo(10 * cfg.burnFraction * ag, 9);
    expect(10 - pb.mass).toBeCloseTo(10 * cfg.burnFraction * 0.15 * ag, 9);
  });
  test("too small to burn", () => {
    const s = empty();
    const me = add(s, "light", 500, 500, cfg.minBurnMass, { name: "You" });
    expect(burn(s, me.id, 1, 0, 1, cfg)).toBe(false);
  });
  test("exhaust fades away on its own", () => {
    const s = empty();
    const me = add(s, "light", 500, 500, 10, { name: "You" });
    burn(s, me.id, 1, 0, 1, cfg);
    const ex = s.bodies.find((b) => b.from === me.id)!;
    const m0 = ex.mass;
    run(s, cfg.exhaustHalfLife);
    expect(ex.mass).toBeCloseTo(m0 / 2, 2);
    run(s, 12);
    expect(s.bodies.filter((b) => b.alive).length).toBe(1);
  });
  test("exhaust is not instantly re-absorbed by its light", () => {
    const s = empty();
    const me = add(s, "light", 500, 500, 10, { name: "You" });
    burn(s, me.id, 1, 0, 1, cfg);
    run(s, 0.2);
    expect(s.bodies.filter((b) => b.alive).length).toBe(2);
  });
});

describe("absorb", () => {
  test("heavier drains lighter on overlap, conserving mass", () => {
    const s = empty();
    const big = add(s, "light", 500, 500, 10, { name: "You" });
    const small = add(s, "orb", 500 + radiusOf(10, cfg), 500, 2);
    const before = total(s);
    const ev = run(s, 0.5);
    expect(total(s)).toBeCloseTo(before, 6);
    expect(big.mass).toBeGreaterThan(10);
    expect(small.mass).toBeLessThan(2);
    expect(ev.some((e) => e.type === "absorb")).toBe(true);
  });
  test("a drained orb vanishes and is swept", () => {
    const s = empty();
    add(s, "light", 500, 500, 10, { name: "You" });
    add(s, "orb", 505, 500, 1);
    const ev = run(s, 2);
    expect(ev.some((e) => e.type === "gone")).toBe(true);
    expect(s.bodies.length).toBe(1);
  });
  test("equal masses trade nothing", () => {
    const s = empty();
    const a = add(s, "light", 500, 500, 10, { name: "You" });
    const b = add(s, "light", 505, 500, 10, { name: "Umbra", ai: true });
    run(s, 1);
    expect(a.mass).toBe(10);
    expect(b.mass).toBe(10);
  });
  test("a heavier light absorbs a lighter one and wins", () => {
    const s = empty();
    add(s, "light", 500, 500, 12, { name: "You" });
    add(s, "light", 505, 500, 6, { name: "Umbra", ai: true });
    const ev = run(s, 5);
    expect(s.status).toBe("won");
    expect(ev.some((e) => e.type === "gone" && e.name === "Umbra")).toBe(true);
  });
  test("the human being absorbed ends the game", () => {
    const s = empty();
    add(s, "light", 500, 500, 6, { name: "You" });
    add(s, "light", 505, 500, 12, { name: "Umbra", ai: true });
    run(s, 5);
    expect(s.status).toBe("over");
    expect(human(s).alive).toBe(false);
  });
  test("absorbed mass carries its momentum", () => {
    const s = empty();
    const big = add(s, "light", 500, 500, 10, { name: "You" });
    add(s, "orb", 500 + radiusOf(10, cfg), 500, 5, { vx: -100 });
    run(s, 0.05);
    expect(big.vx).toBeLessThan(0);
  });
});

describe("agility", () => {
  test("a small light gets more from a burn than a big one", () => {
    const a = empty();
    const b = empty();
    const small = add(a, "light", 500, 500, cfg.startMass, { name: "You" });
    const big = add(b, "light", 500, 500, cfg.startMass * 9, { name: "You" });
    burn(a, small.id, 1, 0, 1, cfg);
    burn(b, big.id, 1, 0, 1, cfg);
    expect(small.vx).toBeGreaterThan(big.vx * 1.5);
  });
  test("a heavy light doesn't attract until lightGravityMass", () => {
    const s = empty();
    add(s, "light", 1000, 1000, cfg.gravityMass + 5, { name: "big", ai: true });
    const o = add(s, "orb", 1200, 1000, 1);
    run(s, 2);
    expect(o.x).toBe(1200);
  });
});

describe("setup", () => {
  test("is deterministic and reasonably sized", () => {
    const a = newGame(7, cfg);
    const b = newGame(7, cfg);
    expect(a.bodies).toEqual(b.bodies);
    expect(a.bodies.filter((x) => x.mass >= cfg.gravityMass).length).toBeGreaterThanOrEqual(cfg.giants);
    expect(lights(a).length).toBe(cfg.players);
    expect(human(a).name).toBe("You");
    expect(a.bodies.filter((x) => x.kind === "orb").length).toBe(cfg.orbs);
    const masses = a.bodies.filter((x) => x.kind === "orb").map((x) => x.mass);
    expect(masses.filter((m) => m < 2).length).toBeGreaterThan(masses.length / 3);
  });
  test("nothing starts overlapping anything that could eat it", () => {
    for (const seed of [3, 4, 5]) {
      const s = newGame(seed, cfg);
      for (const a of s.bodies)
        for (const b of s.bodies) {
          if (a === b || a.mass <= b.mass) continue;
          expect(dist(a, b, cfg)).toBeGreaterThan(radiusOf(a.mass, cfg) + radiusOf(b.mass, cfg));
        }
    }
  });
  test("a whole game stays alive without input for a while", () => {
    const s = newGame(11, cfg);
    run(s, 20);
    expect(human(s).alive).toBe(true);
    expect(total(s)).toBeGreaterThan(0);
  });
});

describe("bots", () => {
  test("flee from a heavier neighbour", () => {
    const s = empty();
    const bot = add(s, "light", 500, 500, 5, { name: "Umbra", ai: true });
    add(s, "light", 560, 500, 20, { name: "You", vx: -50 });
    const it = decide(s, bot.id, cfg)!;
    expect(it).not.toBeNull();
    expect(it.dx).toBeLessThan(0);
  });
  test("chase a worthwhile orb", () => {
    const s = empty();
    const bot = add(s, "light", 500, 500, 5, { name: "Umbra", ai: true });
    add(s, "orb", 700, 500, 3);
    const it = decide(s, bot.id, cfg)!;
    expect(it.dx).toBeGreaterThan(0);
  });
  test("ignore crumbs that cost more than they give", () => {
    const s = empty();
    const bot = add(s, "light", 500, 500, 50, { name: "Umbra", ai: true });
    add(s, "orb", 700, 500, 0.5);
    expect(decide(s, bot.id, cfg)).toBeNull();
  });
  test("botTurn spreads decisions over time", () => {
    const s = newGame(5, cfg);
    let burns = 0;
    const frames = 600;
    for (let i = 0; i < frames; i++) {
      step(s, cfg, 1 / 60);
      burns += botTurn(s, cfg, 1 / 60).length;
    }
    expect(burns).toBeGreaterThan(0);
    expect(burns).toBeLessThan((frames / 60 / 0.35) * (cfg.players - 1));
  });
});

describe("predict", () => {
  test("follows the real path", () => {
    const s = newGame(2, cfg);
    const me = human(s);
    const path = predict(s, me, cfg, 2, 1 / 60);
    run(s, 2);
    const end = path[path.length - 1]!;
    expect(dist(end, me, cfg)).toBeLessThan(8);
  });
});
