import { describe, expect, test } from "bun:test";
import {
  EMBER,
  GUST,
  MOTE,
  ORB,
  SPARK,
  STAR,
  VOID,
  defaultConfig,
  effectiveSpeed,
  grownRadius,
  human,
  inertia,
  lumens,
  makeOrb,
  newGame,
  playerById,
  playerRadius,
  pullDistance,
  reach,
  round,
  spawnRate,
  step,
  travelCost,
  type GameState,
  type OrbKind,
  type SimConfig,
} from "./index";

// Hold 15 lumens: more than a star (10), fewer than a void (20). No spawns, no travel cost, no rivals.
const cfg: SimConfig = {
  ...defaultConfig,
  spawnPerTurn: 0,
  initialOrbs: 0,
  travelCost: 0,
  startLight: 15,
  opponents: 0,
  maxJump: 0,
  gustChance: 0,
};

/** Empty board with the human in the middle; add orbs by hand. */
function board(orbs: Array<[number, number, OrbKind]>, c: SimConfig = cfg): GameState {
  const s = newGame(1, c);
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

describe("step (single player)", () => {
  test("tap collects the orb, scores it, moves and grows the player", () => {
    const s = board([[100, 100, STAR]]);
    const { state, events } = step(s, s.orbs[0]!.id, cfg);
    const me = human(state);
    expect(me.score).toBe(ORB[STAR].value);
    expect(me.light).toBe(cfg.startLight + ORB[STAR].value);
    expect(me).toMatchObject({ x: 100, y: 100 });
    expect(me.radius).toBeCloseTo(playerRadius(me.light, cfg));
    expect(state.orbs).toHaveLength(0);
    expect(state.turn).toBe(1);
    expect(events[0]).toMatchObject({ type: "travel" });
    expect(events[1]).toMatchObject({ type: "collect", by: "tap", value: 10 });
  });

  test("travel costs light by distance and radius; running out ends the run", () => {
    const fuel: SimConfig = { ...cfg, travelCost: 1, startLight: 10 };
    const s = board([[400, 100, SPARK]], fuel); // 300px straight up
    const { state, events } = step(s, s.orbs[0]!.id, fuel);
    const expectedCost = travelCost(300, human(s).radius, fuel);
    expect(events[0]).toMatchObject({ type: "travel", dist: 300 });
    expect((events[0] as { cost: number }).cost).toBeCloseTo(expectedCost);
    expect(human(state).light).toBeCloseTo(10 - expectedCost + 1);
    expect(travelCost(100, fuel.playerBaseRadius * 2, fuel)).toBeCloseTo(2 * travelCost(100, fuel.playerBaseRadius, fuel));

    const broke: SimConfig = { ...fuel, startLight: 1 };
    const b = board([[400, 100, SPARK]], broke);
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
    expect(ember.x).toBe(400);
    expect(700 - ember.y).toBeCloseTo(pullDistance(600, ORB[SPARK].mass, noPlayerPull) * inertia(EMBER, noPlayerPull));
    expect(inertia(STAR, cfg)).toBeLessThan(inertia(SPARK, cfg));
    expect(inertia(MOTE, cfg)).toBeGreaterThan(inertia(SPARK, cfg));
  });

  test("drift carries a fraction of last round's motion into the next", () => {
    const s = board([[100, 400, SPARK], [700, 400, SPARK], [400, 790, SPARK]]);
    const first = step(s, s.orbs[0]!.id, cfg).state;
    const watched = first.orbs.find((o) => o.id === 3)!;
    const secondTap = first.orbs.find((o) => o.id === 2)!.id;
    const noDrift = step(first, secondTap, { ...cfg, drift: 0 }).state;
    const withDrift = step(first, secondTap, { ...cfg, drift: 1 }).state;
    const moved = (o: { x: number; y: number }) => Math.hypot(o.x - watched.x, o.y - watched.y);
    expect(moved(withDrift.orbs.find((o) => o.id === 3)!)).toBeGreaterThan(moved(noDrift.orbs.find((o) => o.id === 3)!));
  });

  test("two sparks pulled together fuse into an ember; two motes make a spark", () => {
    const s = board([[400, 50, STAR], [393, 600, SPARK], [407, 600, SPARK]]);
    const { state, events } = step(s, s.orbs[0]!.id, cfg);
    expect(events.some((e) => e.type === "fuse")).toBe(true);
    expect(state.orbs).toHaveLength(1);
    expect(state.orbs[0]!.kind).toBe(EMBER);

    const m = board([[400, 50, STAR], [396, 600, MOTE], [404, 600, MOTE]]);
    expect(step(m, m.orbs[0]!.id, cfg).state.orbs.map((o) => o.kind)).toEqual([SPARK]);
  });

  test("two stars fusing create a void; gusts never fuse", () => {
    const s = board([[400, 50, SPARK], [385, 600, STAR], [415, 600, STAR], [780, 780, SPARK]]);
    const { state } = step(s, s.orbs[0]!.id, cfg);
    expect(state.orbs.map((o) => o.kind).sort()).toEqual([SPARK, VOID]);

    const g = board([[400, 50, SPARK], [395, 600, GUST], [405, 600, GUST]]);
    const r = step(g, g.orbs[0]!.id, cfg);
    expect(r.state.orbs.filter((o) => o.kind === GUST)).toHaveLength(2);
    expect(r.events.some((e) => e.type === "separate")).toBe(true);
  });

  test("mismatched kinds touching are pushed apart, not fused", () => {
    const still: SimConfig = { ...cfg, strength: 0 }; // no pull, so they stay overlapping until separated
    const s = board([[400, 50, SPARK], [393, 600, SPARK], [407, 600, EMBER]], still);
    const { state, events } = step(s, s.orbs[0]!.id, still);
    expect(events.some((e) => e.type === "separate")).toBe(true);
    const [a, b] = state.orbs;
    expect(Math.hypot(a!.x - b!.x, a!.y - b!.y)).toBeGreaterThanOrEqual(ORB[SPARK].radius + ORB[EMBER].radius);
  });

  test("a void swallows what it touches, banks the light, and grows", () => {
    const s = board([[400, 50, SPARK], [400, 600, VOID], [380, 640, EMBER], [780, 780, SPARK]]);
    const { state, events } = step(s, s.orbs[0]!.id, cfg);
    expect(events.some((e) => e.type === "swallow")).toBe(true);
    const v = state.orbs.find((o) => o.kind === VOID)!;
    expect(v.stored).toBe(2 * ORB[STAR].value + ORB[EMBER].value);
    expect(v.radius).toBeCloseTo(grownRadius(ORB[VOID].radius, ORB[EMBER].radius, cfg));
  });

  test("two voids touching merge into one bigger void", () => {
    const s = board([[400, 50, SPARK], [380, 600, VOID], [420, 600, VOID], [780, 780, SPARK]]);
    s.orbs[1]!.stored = 4;
    s.orbs[2]!.stored = 6;
    const { state, events } = step(s, s.orbs[0]!.id, cfg);
    expect(events.some((e) => e.type === "merge")).toBe(true);
    const voids = state.orbs.filter((o) => o.kind === VOID);
    expect(voids).toHaveLength(1);
    expect(voids[0]!.stored).toBe(10);
  });

  test("a big enough player eats a void and claims what it banked", () => {
    const rich: SimConfig = { ...cfg, startLight: 30 }; // more lumens than a void holding 25
    const s = board([[500, 400, VOID], [780, 780, SPARK]], rich);
    s.orbs[0]!.stored = 25;
    const { state, events } = step(s, s.orbs[0]!.id, rich);
    expect(state.status).toBe("playing");
    expect(human(state).score).toBe(25);
    expect(events.some((e) => e.type === "collect" && e.value === 25)).toBe(true);
  });

  test("orbs pulled onto the player are absorbed in the same round", () => {
    const s = board([[400, 400, EMBER], [400, 440, SPARK]]);
    const { state, events } = step(s, s.orbs[0]!.id, cfg);
    expect(state.orbs).toHaveLength(0);
    expect(human(state).score).toBe(ORB[EMBER].value + ORB[SPARK].value);
    expect(events.filter((e) => e.type === "collect" && e.by === "overlap")).toHaveLength(1);
  });

  test("anything with more lumens than you absorbs you, whether you tap it or it is pulled onto you", () => {
    expect(lumens(makeOrb(newGame(1, cfg), 0, 0, VOID))).toBe(2 * ORB[STAR].value);
    const tapVoid = board([[400, 400, VOID]]);
    const t = step(tapVoid, tapVoid.orbs[0]!.id, cfg);
    expect(t.state.status).toBe("over");
    expect(t.events.at(-1)).toMatchObject({ type: "blackout", reason: "absorbed" });

    const pulled = board([[400, 400, STAR], [400, 460, VOID]]);
    expect(step(pulled, pulled.orbs[0]!.id, cfg).state.status).toBe("over");

    const small: SimConfig = { ...cfg, startLight: 5 }; // fewer lumens than a star
    const fresh = board([[600, 400, STAR]], small);
    expect(step(fresh, fresh.orbs[0]!.id, small).state.status).toBe("over");
    const exact: SimConfig = { ...cfg, startLight: 10 }; // an orb worth exactly your light is still food
    const tie = board([[600, 400, STAR], [780, 780, SPARK]], exact);
    expect(step(tie, tie.orbs[0]!.id, exact).state.status).toBe("playing");
  });

  test("gusts add speed, and speed extends reach", () => {
    const s = board([[450, 400, GUST], [780, 780, SPARK]]);
    const before = reach(human(s), { ...cfg, maxJump: 300 });
    const { state, events } = step(s, s.orbs[0]!.id, cfg);
    const me = human(state);
    expect(me.speed).toBeCloseTo(1 + cfg.gustBoost);
    expect(events.some((e) => e.type === "boost")).toBe(true);
    expect(reach(me, { ...cfg, maxJump: 300 })).toBeGreaterThan(before);
    expect(effectiveSpeed({ radius: 28, speed: 1 }, cfg)).toBeLessThan(effectiveSpeed({ radius: 14, speed: 1 }, cfg));
  });

  test("reach shrinks as you grow; out-of-reach taps are not moves", () => {
    const ranged: SimConfig = { ...cfg, maxJump: 150 };
    const s = board([[400, 100, SPARK], [400, 480, SPARK]], ranged); // 300px and 80px away
    expect(reach(human(s), ranged)).toBeCloseTo(150 * effectiveSpeed(human(s), ranged));
    expect(step(s, s.orbs[0]!.id, ranged).state).toBe(s);
    expect(step(s, s.orbs[1]!.id, ranged).state).not.toBe(s);
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
    expect(spawnRate(50, { ...c, spawnFade: 0 })).toBe(2);

    const s = board([[100, 100, SPARK], [700, 700, SPARK]], c);
    s.turn = 4;
    const { state, events } = step(s, s.orbs[0]!.id, c);
    expect(events.filter((e) => e.type === "spawn")).toHaveLength(1);
    expect(state.status).toBe("playing");

    const last = board([[400, 300, SPARK]], c);
    last.turn = 99;
    const end = step(last, last.orbs[0]!.id, c);
    expect(end.state.status).toBe("over");
    expect(end.events.at(-1)).toMatchObject({ type: "blackout", reason: "dark" });
  });

  test("spawning is deterministic per seed", () => {
    const c: SimConfig = { ...defaultConfig, initialOrbs: 10, spawnPerTurn: 2, opponents: 0 };
    const play = () => {
      let s = newGame(42, c);
      for (let i = 0; i < 5 && s.status === "playing"; i++) {
        const t = s.orbs.find((o) => o.radius <= human(s).radius)!;
        s = step(s, t.id, c).state;
      }
      return s;
    };
    expect(JSON.stringify(play())).toBe(JSON.stringify(play()));
  });
});

describe("opponents", () => {
  const vs: SimConfig = { ...cfg, opponents: 1 };

  test("newGame rings the human with named opponents on equal footing", () => {
    const s = newGame(1, { ...vs, opponents: 2 });
    expect(s.players.map((p) => p.id)).toEqual([-1, -2, -3]);
    for (const p of s.players.slice(1)) {
      expect(p.ai).toBe(true);
      expect(p.light).toBe(human(s).light);
      expect(p.radius).toBe(human(s).radius);
      expect(Math.hypot(p.x - human(s).x, p.y - human(s).y)).toBeCloseTo(0.36 * 800);
    }
  });

  test("everyone moves in the same round; the closer light wins a contested orb and the other misses", () => {
    // Human at (400,400), rival at (400,112). Contested orb 100px from the human, 188px from the rival.
    const s = board([[400, 300, EMBER], [780, 780, SPARK]], vs);
    const r = round(s, s.orbs[0]!.id, vs);
    const moves = r.turns.filter((t) => t.actor !== 0);
    expect(moves.map((t) => t.actor)).toEqual([-1, -2]);
    expect(moves[0]!.events.some((e) => e.type === "collect")).toBe(true);
    expect(moves[1]!.events.some((e) => e.type === "miss")).toBe(true);
    // The loser pulls up short of the winner instead of landing in its mouth.
    expect(playerById(r.state, -2)!.alive).toBe(true);
    expect(r.state.status).toBe("playing");
    expect(r.state.turn).toBe(1);

    // Reversed: orb 88px from the rival, 200px from the human.
    const s2 = board([[400, 200, EMBER], [780, 780, SPARK]], vs);
    const r2 = round(s2, s2.orbs[0]!.id, vs);
    const moves2 = r2.turns.filter((t) => t.actor !== 0);
    expect(moves2.map((t) => t.actor)).toEqual([-2, -1]);
    expect(moves2[0]!.events.some((e) => e.type === "collect")).toBe(true);
    expect(moves2[1]!.events.some((e) => e.type === "miss")).toBe(true);
    expect(human(r2.state).score).toBe(0);
    expect(human(r2.state).alive).toBe(true);
  });

  test("speed decides races: a gust-boosted light beats a closer slow one", () => {
    const s = board([[400, 250, EMBER]], vs); // 150 from human, 138 from rival: rival would win at equal speed
    human(s).speed = 1.5;
    const r = round(s, s.orbs[0]!.id, vs);
    expect(r.turns[0]!.actor).toBe(-1);
    expect(human(r.state).score).toBe(ORB[EMBER].value);
  });

  test("the opponent's decision comes from the same board as yours, not from your result", () => {
    const s = board([[400, 300, EMBER], [400, 700, SPARK]], vs);
    const r = round(s, s.orbs[1]!.id, vs); // human goes south; rival should take the ember uncontested
    expect(r.turns.find((t) => t.actor === -2)!.events.some((e) => e.type === "collect")).toBe(true);
  });

  test("a collection pulls other players toward it, heavier ones less", () => {
    const s = board([[400, 700, STAR]], vs);
    const rival = s.players[1]!;
    const startY = rival.y;
    const { state } = step(s, s.orbs[0]!.id, vs);
    expect(playerById(state, rival.id)!.y).toBeGreaterThan(startY);
  });

  test("the light with more lumens eats the other on contact, takes their light, and wins", () => {
    const s = board([], vs);
    const me = human(s);
    me.light = 100;
    me.radius = playerRadius(100, vs);
    const rival = s.players[1]!;
    s.orbs.push(makeOrb(s, rival.x + 5, rival.y, SPARK)); // landing here overlaps the rival
    const { state, events } = step(s, s.orbs[0]!.id, vs);
    expect(events.some((e) => e.type === "eat" && e.predator.id === me.id)).toBe(true);
    expect(playerById(state, rival.id)!.alive).toBe(false);
    expect(human(state).light).toBeCloseTo(100 + 1 + vs.startLight);
    expect(state.status).toBe("won");
  });

  test("landing next to an opponent with more lumens gets you eaten", () => {
    const s = board([], vs);
    const rival = s.players[1]!;
    rival.light = 100;
    rival.radius = playerRadius(100, vs);
    s.orbs.push(makeOrb(s, rival.x + 5, rival.y, SPARK));
    const { state, events } = step(s, s.orbs[0]!.id, vs);
    expect(state.status).toBe("over");
    expect(events.at(-1)).toMatchObject({ type: "blackout", reason: "eaten" });
  });

  test("two equal lights meeting is a draw; one lumen more is enough to absorb", () => {
    const s = board([], vs);
    const rival = s.players[1]!;
    s.orbs.push(makeOrb(s, rival.x + 5, rival.y, GUST)); // worth nothing, so light stays equal
    const r = step(s, s.orbs[0]!.id, vs); // single-actor step: the rival stays put
    expect(r.state.status).toBe("draw");
    expect(r.events.some((e) => e.type === "draw")).toBe(true);

    const edge = board([[780, 780, SPARK]], vs);
    const rival2 = edge.players[1]!;
    rival2.light = vs.startLight - 1;
    rival2.radius = playerRadius(rival2.light, vs);
    edge.orbs.push(makeOrb(edge, rival2.x + 5, rival2.y, GUST));
    const r2 = step(edge, edge.orbs[1]!.id, vs);
    expect(r2.events.some((e) => e.type === "eat")).toBe(true);
    expect(r2.state.status).toBe("won");
  });

  test("you can hunt an opponent you outweigh; one you don't is not a target", () => {
    const s = board([[780, 780, SPARK]], vs);
    const rival = s.players[1]!;
    rival.light = 5;
    rival.radius = playerRadius(5, vs);
    const hunt = step(s, rival.id, vs); // single-actor: the rival cannot hop away
    expect(hunt.events.some((e) => e.type === "eat" && e.predator.id === -1)).toBe(true);
    expect(hunt.state.status).toBe("won");

    rival.light = 100;
    rival.radius = playerRadius(100, vs);
    expect(step(s, rival.id, vs).state).toBe(s);
    expect(round(s, rival.id, vs).turns).toHaveLength(0);
  });

  test("a hunted opponent that hops away first leaves you landing on empty space", () => {
    const s = board([], vs);
    const rival = s.players[1]!;
    rival.light = 5;
    rival.radius = playerRadius(5, vs);
    // The rival's escape orb is right next to it, so it arrives long before you do.
    s.orbs.push(makeOrb(s, rival.x + 40, rival.y, SPARK));
    s.orbs.push(makeOrb(s, 780, 780, SPARK));
    const r = round(s, rival.id, vs);
    const mine = r.turns.find((t) => t.actor === -1)!;
    expect(mine.events.some((e) => e.type === "miss")).toBe(true);
    expect(playerById(r.state, rival.id)!.alive).toBe(true);
    expect(r.state.status).toBe("playing");
  });

  test("a stranded opponent with no food can still be hunted, so the game does not stall", () => {
    const s = board([[780, 780, SPARK]], vs);
    const rival = s.players[1]!;
    rival.light = 0.2;
    rival.radius = playerRadius(0.2, vs);
    const r = round(s, rival.id, vs);
    expect(r.state.status).toBe("won");
  });
});

describe("newGame", () => {
  test("places orbs inside the board and away from every player", () => {
    const s = newGame(7, { ...defaultConfig, opponents: 2 });
    expect(s.orbs).toHaveLength(defaultConfig.initialOrbs);
    for (const o of s.orbs) {
      expect(o.x).toBeGreaterThan(0);
      expect(o.y).toBeGreaterThan(0);
      expect(o.x).toBeLessThan(defaultConfig.width);
      expect(o.y).toBeLessThan(defaultConfig.height);
      for (const p of s.players) expect(Math.hypot(o.x - p.x, o.y - p.y)).toBeGreaterThan(p.radius + 50);
    }
  });
});
