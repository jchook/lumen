import { describe, expect, test } from "bun:test";
import {
  EMBER,
  ORB,
  SPARK,
  STAR,
  VOID,
  defaultConfig,
  grownRadius,
  makeOrb,
  newGame,
  playerRadius,
  pullDistance,
  spawnRate,
  step,
  travelCost,
  type GameState,
  type OrbKind,
  type SimConfig,
} from "./index";

// Hold 30 light: bigger than a star (r20), smaller than a void (r26).
const cfg: SimConfig = { ...defaultConfig, spawnPerTurn: 0, initialOrbs: 0, travelCost: 0, startLight: 30 };

/** Empty board with the player in the middle; add orbs by hand. */
function board(orbs: Array<[number, number, OrbKind]>): GameState {
  const s = newGame(1, cfg);
  for (const [x, y, kind] of orbs) s.orbs.push(makeOrb(s, x, y, kind));
  return s;
}

describe("pullDistance", () => {
  test("falls off with distance", () => {
    const near = pullDistance(50, 1, cfg);
    const mid = pullDistance(cfg.falloff, 1, cfg);
    const far = pullDistance(cfg.falloff * 3, 1, cfg);
    expect(near).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(far);
    expect(mid).toBeCloseTo(cfg.strength / 2);
  });

  test("scales with mass", () => {
    expect(pullDistance(300, 2, cfg)).toBeCloseTo(2 * pullDistance(300, 1, cfg));
  });

  test("never overshoots and never exceeds maxTravel", () => {
    expect(pullDistance(20, 10, cfg)).toBe(20);
    expect(pullDistance(200, 100, cfg)).toBe(cfg.maxTravel);
  });
});

describe("step", () => {
  test("tap collects the orb, scores it, moves and grows the player", () => {
    const s = board([[100, 100, STAR]]);
    const id = s.orbs[0]!.id;
    const { state, events } = step(s, id, cfg);
    expect(state.score).toBe(ORB[STAR].value);
    expect(state.player).toMatchObject({ x: 100, y: 100 });
    expect(state.light).toBe(cfg.startLight + ORB[STAR].value);
    expect(state.player.radius).toBeCloseTo(playerRadius(state.light, cfg));
    expect(state.orbs).toHaveLength(0);
    expect(state.turn).toBe(1);
    expect(events[1]).toMatchObject({ type: "collect", by: "tap", value: 10 });
  });

  test("travel costs light by distance and radius; running out ends the run", () => {
    const fuel: SimConfig = { ...cfg, travelCost: 1, startLight: 10 };
    const s = newGame(1, fuel);
    s.orbs.push(makeOrb(s, 400, 100, SPARK)); // 300px straight up
    const { state, events } = step(s, s.orbs[0]!.id, fuel);
    const expectedCost = travelCost(300, s.player.radius, fuel);
    expect(events[0]).toMatchObject({ type: "travel", dist: 300 });
    expect((events[0] as { cost: number }).cost).toBeCloseTo(expectedCost);
    expect(state.light).toBeCloseTo(10 - expectedCost + 1);
    expect(state.score).toBe(1);
    // Cost grows with radius.
    expect(travelCost(100, fuel.playerBaseRadius * 2, fuel)).toBeCloseTo(2 * travelCost(100, fuel.playerBaseRadius, fuel));

    const broke: SimConfig = { ...fuel, startLight: 1 };
    const b = newGame(1, broke);
    b.orbs.push(makeOrb(b, 400, 100, SPARK));
    const dead = step(b, b.orbs[0]!.id, broke);
    expect(dead.state.status).toBe("over");
    expect(dead.events.at(-1)).toMatchObject({ type: "blackout", reason: "faded" });
  });

  test("does not mutate the previous state", () => {
    const s = board([[100, 100, SPARK], [700, 700, SPARK]]);
    const snapshot = JSON.stringify(s);
    step(s, s.orbs[0]!.id, cfg);
    expect(JSON.stringify(s)).toBe(snapshot);
  });

  test("remaining orbs are pulled toward the collection point", () => {
    const noPlayerPull = { ...cfg, playerPull: 0 };
    const s = board([[400, 100, SPARK], [400, 700, EMBER]]);
    const { state } = step(s, s.orbs[0]!.id, noPlayerPull);
    const ember = state.orbs[0]!;
    expect(ember.y).toBeLessThan(700);
    expect(ember.x).toBe(400);
    expect(700 - ember.y).toBeCloseTo(pullDistance(600, ORB[SPARK].mass, noPlayerPull));
  });

  test("drift carries a fraction of last turn's motion", () => {
    // Two far-apart anchors to tap, and one orb whose motion we watch.
    const s = board([[100, 400, SPARK], [700, 400, SPARK], [400, 790, SPARK]]);
    const first = step(s, s.orbs[0]!.id, cfg).state;
    const watched = first.orbs.find((o) => o.id === 3)!;
    const secondTap = first.orbs.find((o) => o.id === 2)!.id;
    const noDrift = step(first, secondTap, { ...cfg, drift: 0 }).state;
    const withDrift = step(first, secondTap, { ...cfg, drift: 1 }).state;
    const a = noDrift.orbs.find((o) => o.id === 3)!;
    const b = withDrift.orbs.find((o) => o.id === 3)!;
    const moved = (o: { x: number; y: number }) => Math.hypot(o.x - watched.x, o.y - watched.y);
    expect(moved(b)).toBeGreaterThan(moved(a));
  });

  test("two sparks pulled together fuse into an ember", () => {
    // Anchor at the top; two sparks either side of the vertical line under it, close enough to meet.
    const s = board([[400, 50, STAR], [393, 600, SPARK], [407, 600, SPARK]]);
    const { state, events } = step(s, s.orbs[0]!.id, cfg);
    expect(events.some((e) => e.type === "fuse")).toBe(true);
    expect(state.orbs).toHaveLength(1);
    expect(state.orbs[0]!.kind).toBe(EMBER);
  });

  test("two stars fusing create a void", () => {
    const s = board([[400, 50, SPARK], [385, 600, STAR], [415, 600, STAR], [780, 780, SPARK]]);
    const { state } = step(s, s.orbs[0]!.id, cfg);
    expect(state.orbs.map((o) => o.kind).sort()).toEqual([SPARK, VOID]);
    expect(state.status).toBe("playing");
  });

  test("mismatched kinds touching are pushed apart, not fused", () => {
    const s = board([[400, 50, SPARK], [392, 600, SPARK], [408, 600, EMBER]]);
    const { state, events } = step(s, s.orbs[0]!.id, cfg);
    expect(events.some((e) => e.type === "separate")).toBe(true);
    expect(state.orbs).toHaveLength(2);
    const [a, b] = state.orbs;
    expect(Math.hypot(a!.x - b!.x, a!.y - b!.y)).toBeGreaterThanOrEqual(ORB[SPARK].radius + ORB[EMBER].radius);
  });

  test("a void swallows what it touches, banks the light, and grows", () => {
    const s = board([[400, 50, SPARK], [400, 600, VOID], [380, 640, EMBER], [780, 780, SPARK]]);
    const { state, events } = step(s, s.orbs[0]!.id, cfg);
    expect(events.some((e) => e.type === "swallow")).toBe(true);
    expect(state.status).toBe("playing");
    const v = state.orbs.find((o) => o.kind === VOID)!;
    expect(v.swallowed).toBe(1);
    expect(v.stored).toBe(ORB[EMBER].value);
    expect(v.radius).toBeCloseTo(grownRadius(ORB[VOID].radius, ORB[EMBER].radius, cfg));
  });

  test("two voids touching merge into one bigger void", () => {
    const s = board([[400, 50, SPARK], [380, 600, VOID], [420, 600, VOID], [780, 780, SPARK]]);
    s.orbs[1]!.stored = 4;
    s.orbs[2]!.stored = 6;
    const { state, events } = step(s, s.orbs[0]!.id, cfg);
    expect(state.status).toBe("playing");
    expect(events.some((e) => e.type === "merge")).toBe(true);
    const voids = state.orbs.filter((o) => o.kind === VOID);
    expect(voids).toHaveLength(1);
    expect(voids[0]!.stored).toBe(10);
    expect(voids[0]!.radius).toBeGreaterThan(ORB[VOID].radius);
  });

  test("a big enough player eats a void and claims what it banked", () => {
    const rich: SimConfig = { ...cfg, startLight: 100 }; // r = 29 > void 26
    const s = newGame(1, rich);
    s.orbs.push(makeOrb(s, 500, 400, VOID));
    s.orbs.push(makeOrb(s, 780, 780, SPARK));
    s.orbs[0]!.stored = 25;
    const { state, events } = step(s, s.orbs[0]!.id, rich);
    expect(state.status).toBe("playing");
    expect(state.score).toBe(25);
    expect(events.some((e) => e.type === "collect" && e.value === 25)).toBe(true);
  });

  test("orbs pulled onto the player are absorbed in the same turn", () => {
    const s = board([[400, 400, EMBER], [400, 440, SPARK]]);
    const { state, events } = step(s, s.orbs[0]!.id, cfg);
    expect(state.orbs).toHaveLength(0);
    expect(state.score).toBe(ORB[EMBER].value + ORB[SPARK].value);
    expect(events.filter((e) => e.type === "collect" && e.by === "overlap")).toHaveLength(1);
  });

  test("anything bigger than you absorbs you, whether you tap it or it is pulled onto you", () => {
    const tapVoid = board([[400, 400, VOID]]);
    const t = step(tapVoid, tapVoid.orbs[0]!.id, cfg);
    expect(t.state.status).toBe("over");
    expect(t.events.at(-1)).toMatchObject({ type: "blackout", reason: "absorbed" });

    const pulled = board([[400, 400, STAR], [400, 460, VOID]]);
    const { state, events } = step(pulled, pulled.orbs[0]!.id, cfg);
    expect(state.status).toBe("over");
    expect(events.at(-1)).toMatchObject({ type: "blackout", reason: "absorbed" });

    // A fresh player (10 light, r ≈ 18.7) is smaller than a star (r 20).
    const small: SimConfig = { ...cfg, startLight: 10 };
    const fresh = newGame(1, small);
    fresh.orbs.push(makeOrb(fresh, 600, 400, STAR));
    expect(step(fresh, fresh.orbs[0]!.id, small).state.status).toBe("over");
  });

  test("a finished game ignores taps", () => {
    const s = board([[400, 400, SPARK]]);
    s.status = "over";
    expect(step(s, s.orbs[0]!.id, cfg).state).toBe(s);
  });

  test("spawn rate fades to zero and an empty field ends the run", () => {
    const c: SimConfig = { ...cfg, spawnPerTurn: 2, spawnFade: 10 };
    expect(spawnRate(0, c)).toBe(2);
    expect(spawnRate(5, c)).toBe(1);
    expect(spawnRate(10, c)).toBe(0);
    expect(spawnRate(50, c)).toBe(0);
    expect(spawnRate(50, { ...c, spawnFade: 0 })).toBe(2);

    // Fractional rates accumulate: at turn 5 the rate is 1/tap, so exactly one orb per tap.
    const s = board([[100, 100, SPARK], [700, 700, SPARK]]);
    s.turn = 4;
    const { state, events } = step(s, s.orbs[0]!.id, c);
    expect(events.filter((e) => e.type === "spawn")).toHaveLength(1);
    expect(state.status).toBe("playing");

    // No spawns left and nothing on the field: dark.
    const last = board([[400, 300, SPARK]]);
    last.turn = 99;
    const end = step(last, last.orbs[0]!.id, c);
    expect(end.state.status).toBe("over");
    expect(end.events.at(-1)).toMatchObject({ type: "blackout", reason: "dark" });
  });

  test("spawning keeps the board fed and is deterministic per seed", () => {
    const c: SimConfig = { ...defaultConfig, initialOrbs: 10, spawnPerTurn: 2 };
    const play = () => {
      let s = newGame(42, c);
      for (let i = 0; i < 5 && s.status === "playing"; i++) s = step(s, s.orbs[0]!.id, c).state;
      return s;
    };
    const a = play();
    const b = play();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.orbs.length).toBeGreaterThan(0);
  });
});

describe("newGame", () => {
  test("places orbs inside the board and away from the player", () => {
    const s = newGame(7, defaultConfig);
    expect(s.orbs).toHaveLength(defaultConfig.initialOrbs);
    for (const o of s.orbs) {
      expect(o.x).toBeGreaterThan(0);
      expect(o.y).toBeGreaterThan(0);
      expect(o.x).toBeLessThan(defaultConfig.width);
      expect(o.y).toBeLessThan(defaultConfig.height);
      expect(Math.hypot(o.x - s.player.x, o.y - s.player.y)).toBeGreaterThan(s.player.radius + 100);
    }
  });
});
