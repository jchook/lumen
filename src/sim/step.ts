import { cloneState, grownRadius, makeOrb, playerRadius, spawnOrb, spawnRate, travelCost } from "./board";
import {
  ORB,
  VOID,
  type GameState,
  type Orb,
  type OrbKind,
  type SimConfig,
  type SimEvent,
  type StepResult,
} from "./types";

/**
 * Displacement an orb receives toward an attractor of the given mass at `dist` px.
 * Soft falloff: full pull at 0, half at `falloff`, a third at 2*falloff.
 * Never overshoots the attractor and never exceeds maxTravel.
 */
export function pullDistance(dist: number, mass: number, cfg: SimConfig): number {
  if (dist <= 0) return 0;
  const raw = (cfg.strength * mass) / (1 + dist / cfg.falloff);
  return Math.min(raw, cfg.maxTravel, dist);
}

function clampToBoard(o: Orb, cfg: SimConfig): void {
  const r = o.radius;
  o.x = Math.min(cfg.width - r, Math.max(r, o.x));
  o.y = Math.min(cfg.height - r, Math.max(r, o.y));
}

function overlapping(a: Orb, b: Orb): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) < a.radius + b.radius;
}

/** Pull every orb toward (ax, ay) with the given mass, adding to its pending displacement. */
function attract(orbs: Orb[], ax: number, ay: number, mass: number, cfg: SimConfig): void {
  for (const o of orbs) {
    const ddx = ax - o.x;
    const ddy = ay - o.y;
    const dist = Math.hypot(ddx, ddy);
    if (dist === 0) continue;
    const d = pullDistance(dist, mass, cfg);
    o.dx += (ddx / dist) * d;
    o.dy += (ddy / dist) * d;
  }
}

/**
 * Resolve every pair of touching orbs until the board is stable.
 * Same kind → fuse into the next kind (star + star → void).
 * Void + light → the void swallows it, banks its light, and grows.
 * Void + void → one bigger void.
 * Different kinds → nudge apart until they just touch.
 */
function resolveFusions(state: GameState, cfg: SimConfig, events: SimEvent[]): void {
  for (let iter = 0; iter < 64; iter++) {
    let pair: [number, number] | null = null;
    outer: for (let i = 0; i < state.orbs.length; i++) {
      for (let j = i + 1; j < state.orbs.length; j++) {
        if (overlapping(state.orbs[i]!, state.orbs[j]!)) {
          pair = [i, j];
          break outer;
        }
      }
    }
    if (!pair) return;
    const [i, j] = pair;
    const a = state.orbs[i]!;
    const b = state.orbs[j]!;

    if (a.kind === VOID && b.kind === VOID) {
      const [big, small] = a.radius >= b.radius ? [a, b] : [b, a];
      const result = makeOrb(state, (a.x + b.x) / 2, (a.y + b.y) / 2, VOID);
      result.radius = Math.sqrt(big.radius ** 2 + small.radius ** 2);
      result.swallowed = a.swallowed + b.swallowed;
      result.stored = a.stored + b.stored;
      result.dx = (a.dx + b.dx) / 2;
      result.dy = (a.dy + b.dy) / 2;
      state.orbs.splice(j, 1);
      state.orbs.splice(i, 1);
      state.orbs.push(result);
      events.push({ type: "merge", a: { ...a }, b: { ...b }, result: { ...result } });
      continue;
    }
    if (a.kind === VOID || b.kind === VOID) {
      const [v, prey] = a.kind === VOID ? [a, b] : [b, a];
      v.swallowed += 1;
      v.stored += ORB[prey.kind].value;
      v.radius = grownRadius(v.radius, prey.radius, cfg);
      state.orbs.splice(state.orbs.indexOf(prey), 1);
      events.push({ type: "swallow", void_: { ...v }, orb: { ...prey } });
      continue;
    }

    if (a.kind === b.kind) {
      const kind = (a.kind + 1) as OrbKind;
      const result = makeOrb(state, (a.x + b.x) / 2, (a.y + b.y) / 2, kind);
      // Fused orb inherits the pair's average momentum.
      result.dx = (a.dx + b.dx) / 2;
      result.dy = (a.dy + b.dy) / 2;
      state.orbs.splice(j, 1);
      state.orbs.splice(i, 1);
      state.orbs.push(result);
      events.push({ type: "fuse", a: { ...a }, b: { ...b }, result: { ...result } });
      continue;
    }

    // Mismatched kinds: push apart symmetrically until just touching.
    const target = a.radius + b.radius + 0.5;
    let nx = b.x - a.x;
    let ny = b.y - a.y;
    let dist = Math.hypot(nx, ny);
    if (dist < 1e-6) {
      nx = 1;
      ny = 0;
      dist = 1;
    }
    const push = (target - dist) / 2;
    a.x -= (nx / dist) * push;
    a.y -= (ny / dist) * push;
    b.x += (nx / dist) * push;
    b.y += (ny / dist) * push;
    events.push({ type: "separate", a: { ...a }, b: { ...b } });
  }
}

/** Light an orb is worth when the player absorbs it. Voids hand over everything they banked. */
function worth(o: Orb): number {
  return ORB[o.kind].value + o.stored;
}

/** The bigger light absorbs the smaller. Whatever overlaps the player is eaten, or eats the player. */
function collectOverlaps(state: GameState, cfg: SimConfig, events: SimEvent[]): void {
  for (let iter = 0; iter < 64; iter++) {
    const p = state.player;
    const idx = state.orbs.findIndex((o) => Math.hypot(o.x - p.x, o.y - p.y) < p.radius + o.radius);
    if (idx < 0) return;
    const orb = state.orbs[idx]!;
    if (orb.radius > p.radius) {
      state.status = "over";
      events.push({ type: "blackout", reason: "absorbed", by: { ...orb }, at: { x: orb.x, y: orb.y } });
      return;
    }
    state.orbs.splice(idx, 1);
    const value = worth(orb);
    state.score += value;
    state.light += value;
    p.radius = playerRadius(state.light, cfg);
    events.push({ type: "collect", orb: { ...orb }, by: "overlap", value });
  }
}

/**
 * One tap. Pure: returns a new state and the list of things that happened, in order.
 * Order of operations:
 *   1. Player pays light to travel, jumps to the tapped orb and absorbs it.
 *   2. Every other orb is pulled toward that point (plus drift and void pull).
 *   3. Touching orbs fuse / swallow / separate until stable.
 *   4. Anything now overlapping the player is absorbed.
 *   5. New light spawns, less of it every tap. When the field is empty the run ends.
 */
export function step(prev: GameState, tapId: number, cfg: SimConfig): StepResult {
  const events: SimEvent[] = [];
  if (prev.status !== "playing") return { state: prev, events };
  const tappedIdx = prev.orbs.findIndex((o) => o.id === tapId);
  if (tappedIdx < 0) return { state: prev, events };
  const tapped = prev.orbs[tappedIdx]!;
  if (tapped.radius > prev.player.radius) {
    // Tapping something bigger than you is jumping into its mouth.
    const state = cloneState(prev);
    state.status = "over";
    state.player.x = tapped.x;
    state.player.y = tapped.y;
    state.turn += 1;
    events.push({ type: "blackout", reason: "absorbed", by: { ...tapped }, at: { x: tapped.x, y: tapped.y } });
    return { state, events };
  }

  const state = cloneState(prev);
  state.turn += 1;

  // 1. Travel, then collect.
  const orb = state.orbs.splice(tappedIdx, 1)[0]!;
  const dist = Math.hypot(orb.x - state.player.x, orb.y - state.player.y);
  const cost = travelCost(dist, state.player.radius, cfg);
  state.light -= cost;
  events.push({ type: "travel", dist, cost });
  const value = worth(orb);
  state.score += value;
  state.light += value;
  state.player.x = orb.x;
  state.player.y = orb.y;
  state.player.radius = playerRadius(state.light, cfg);
  events.push({ type: "collect", orb: { ...orb }, by: "tap", value });

  // 2. Gravity. Start from drift, then add the collection pull and any void pulls.
  for (const o of state.orbs) {
    o.dx *= cfg.drift;
    o.dy *= cfg.drift;
  }
  const grown = state.player.radius - cfg.playerBaseRadius;
  const mass = ORB[orb.kind].mass + cfg.playerPull * (grown / 10);
  attract(state.orbs, orb.x, orb.y, mass, cfg);
  for (const v of state.orbs) {
    if (v.kind !== VOID) continue;
    attract(
      state.orbs.filter((o) => o !== v),
      v.x,
      v.y,
      ORB[VOID].mass * cfg.voidPull,
      cfg,
    );
  }
  for (const o of state.orbs) {
    const len = Math.hypot(o.dx, o.dy);
    if (len > cfg.maxTravel) {
      o.dx *= cfg.maxTravel / len;
      o.dy *= cfg.maxTravel / len;
    }
    o.x += o.dx;
    o.y += o.dy;
    clampToBoard(o, cfg);
  }

  // 3–4. Consequences.
  resolveFusions(state, cfg, events);
  if (state.status === "playing") collectOverlaps(state, cfg, events);
  if (state.status === "playing" && state.light < 0) {
    state.status = "over";
    events.push({ type: "blackout", reason: "faded", at: { x: state.player.x, y: state.player.y } });
  }
  if (state.status !== "playing") return { state, events };

  // 5. Fresh light, fading with every tap.
  state.spawnBank += spawnRate(state.turn, cfg);
  while (state.spawnBank >= 1) {
    state.spawnBank -= 1;
    const spawned = spawnOrb(state, cfg);
    if (spawned) events.push({ type: "spawn", orb: { ...spawned } });
  }
  if (!state.orbs.some((o) => o.radius <= state.player.radius)) {
    state.status = "over";
    events.push({ type: "blackout", reason: "dark", at: { x: state.player.x, y: state.player.y } });
  }
  return { state, events };
}
