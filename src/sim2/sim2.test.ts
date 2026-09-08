import { describe, expect, test } from "bun:test";
import {
  EMBER,
  SPARK,
  STAR,
  VOID,
  bodyRadius,
  defaultConfig,
  jumpCostOf,
  lumensOf,
  newGame,
  options,
  play,
  reachOf,
  search,
  tick,
  wellRadius,
  type Config,
  type Orb,
  type State,
} from "./index";

const cfg: Config = { ...defaultConfig };

function empty(seed = 1, c: Config = cfg): State {
  const s = newGame(seed, { ...c, orbCount: 0 });
  return s;
}
function orb(s: State, x: number, y: number, kind: 1 | 2 | 3 | 4, vx = 0, vy = 0): Orb {
  const o: Orb = { id: s.nextId++, kind, x, y, vx, vy, radius: [0, 6, 10, 18, 24][kind]!, stored: kind === VOID ? 20 : 0 };
  s.orbs.push(o);
  return o;
}

describe("setup", () => {
  test("the board is mirror-symmetric, so both lights start with the same prospects", () => {
    const s = newGame(3, cfg);
    expect(s.orbs.length).toBe(cfg.orbCount);
    for (const o of s.orbs) {
      const twin = s.orbs.find((p) => p !== o && p.kind === o.kind && Math.abs(p.x - (cfg.width - o.x)) < 1e-6 && Math.abs(p.y - o.y) < 1e-6);
      expect(twin).toBeDefined();
    }
    expect(s.lights[0].lumens).toBe(s.lights[1].lumens);
  });

  test("setup is deterministic per seed", () => {
    expect(JSON.stringify(newGame(9, cfg))).toBe(JSON.stringify(newGame(9, cfg)));
  });
});

describe("moves", () => {
  test("a jump absorbs the orb, costs lumens by distance, and passes the turn", () => {
    const s = empty();
    const o = orb(s, s.lights[0].x + 100, s.lights[0].y, EMBER);
    const { state, events } = play(s, o.id, cfg);
    expect(state.toMove).toBe(1);
    expect(state.ply).toBe(1);
    expect(state.lights[0].lumens).toBeCloseTo(cfg.startLumens + 3 - jumpCostOf(s.lights[0], 100, cfg));
    expect(events.some((e) => e.type === "absorb" && e.value === 3)).toBe(true);
  });

  test("holding position is a legal move; the field still ticks", () => {
    const s = empty();
    orb(s, 400, 200, SPARK);
    const { state } = play(s, null, cfg);
    expect(state.toMove).toBe(1);
    expect(state.orbs[0]!.y).not.toBe(200); // pulled by the wells
  });

  test("out of reach or heavier than you is not an option", () => {
    const s = empty();
    const far = orb(s, s.lights[0].x + reachOf(s.lights[0], cfg) + 50, s.lights[0].y, SPARK);
    const heavy = orb(s, s.lights[0].x + 80, s.lights[0].y, STAR);
    expect(options(s, cfg).map((o) => o.id)).not.toContain(far.id);
    expect(options(s, cfg).map((o) => o.id)).not.toContain(heavy.id);
    expect(play(s, far.id, cfg).state).toBe(s);
  });

  test("reach shrinks and jumps cost more as you grow", () => {
    const small = { ...empty().lights[0], lumens: 5 };
    const big = { ...small, lumens: 45 };
    expect(reachOf(big, cfg)).toBeLessThan(reachOf(small, cfg));
    expect(jumpCostOf(big, 100, cfg)).toBeGreaterThan(jumpCostOf(small, 100, cfg));
    expect(wellRadius(big, cfg)).toBeGreaterThan(wellRadius(small, cfg));
  });
});

describe("field", () => {
  test("momentum: an orb keeps moving after the impulse that pushed it", () => {
    const s = empty();
    orb(s, 200, 400, SPARK); // the jump target, next to player 0 at (200,400)
    const watched = orb(s, 400, 100, SPARK); // far from both wells' strong pull
    const one = play(s, s.orbs[0]!.id, cfg).state;
    const w1 = one.orbs.find((o) => o.id === watched.id)!;
    expect(Math.hypot(w1.vx, w1.vy)).toBeGreaterThan(0);
    const two = play(one, null, cfg).state; // opponent holds; the orb still moves
    const w2 = two.orbs.find((o) => o.id === watched.id)!;
    expect(Math.hypot(w2.x - w1.x, w2.y - w1.y)).toBeGreaterThan(0.5);
  });

  test("same kinds that meet fuse, momentum averaged; star + star is a void that banks 20", () => {
    const s = empty();
    orb(s, 386, 400, SPARK, 3, 0);
    orb(s, 396, 400, SPARK, -3, 0);
    tick(s, cfg, []);
    expect(s.orbs.map((o) => o.kind)).toEqual([EMBER]);
    const v = empty();
    orb(v, 385, 400, STAR);
    orb(v, 405, 400, STAR);
    tick(v, cfg, []);
    expect(v.orbs[0]!.kind).toBe(VOID);
    expect(lumensOf(v.orbs[0]!)).toBe(20);
  });

  test("a void swallows what it touches and grows", () => {
    const s = empty();
    orb(s, 400, 400, VOID);
    orb(s, 430, 400, EMBER);
    tick(s, cfg, []);
    expect(s.orbs).toHaveLength(1);
    expect(s.orbs[0]!.stored).toBe(23);
    expect(s.orbs[0]!.radius).toBeGreaterThan(24);
  });

  test("a light absorbs light that falls into its body, and is absorbed by anything heavier", () => {
    const s = empty();
    const l = s.lights[0];
    orb(s, l.x + bodyRadius(l, cfg) + 2, l.y, SPARK);
    tick(s, cfg, []);
    expect(s.orbs).toHaveLength(0);
    expect(l.lumens).toBe(cfg.startLumens + 1);

    const t = empty();
    orb(t, t.lights[0].x + 5, t.lights[0].y, STAR);
    const ev: ReturnType<typeof play>["events"] = [];
    tick(t, cfg, ev);
    expect(t.status).toBe("over");
    expect(t.winner).toBe(1);
  });
});

describe("influence", () => {
  test("overlapping wells siphon lumens from the smaller light to the larger, and can drain it", () => {
    const s = empty();
    s.lights[0].lumens = 30;
    s.lights[1].lumens = 5;
    s.lights[1].x = s.lights[0].x + 60; // deep overlap
    s.lights[1].y = s.lights[0].y;
    const before = s.lights[1].lumens;
    tick(s, cfg, []);
    expect(s.lights[1].lumens).toBeLessThan(before);
    expect(s.lights[0].lumens).toBeGreaterThan(30);
    let t = s;
    for (let i = 0; i < 40 && t.status === "playing"; i++) {
      const ev: ReturnType<typeof play>["events"] = [];
      tick(t, cfg, ev);
    }
    expect(t.status).toBe("over");
    expect(t.winner).toBe(0);
  });

  test("wells that do not overlap leave each other alone", () => {
    const s = empty();
    s.lights[0].lumens = 30;
    tick(s, cfg, []);
    expect(s.lights[1].lumens).toBe(cfg.startLumens);
  });
});

describe("ending and search", () => {
  test("the game ends when the light is gone or the clock runs out; more lumens wins", () => {
    const s = empty();
    s.lights[0].lumens = 8;
    orb(s, s.lights[0].x + 60, s.lights[0].y, SPARK);
    const { state } = play(s, s.orbs[0]!.id, cfg);
    expect(state.status).toBe("over");
    expect(state.winner).toBe(0);

    const c = { ...cfg, maxPly: 1 };
    const t = empty(1, c);
    orb(t, 400, 100, SPARK);
    orb(t, 400, 700, SPARK);
    const r = play(t, null, c);
    expect(r.state.status).toBe("over");
    expect(r.state.winner).toBe(-1);
  });

  test("search returns a legal move and prefers the obviously better one at depth 1", () => {
    const s = empty();
    const good = orb(s, s.lights[0].x + 60, s.lights[0].y, EMBER);
    orb(s, s.lights[0].x - 60, s.lights[0].y, SPARK);
    const r = search(s, 1, cfg);
    expect(r.move).toBe(good.id);
  });
});
