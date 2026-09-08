import {
  alivePlayers,
  cloneState,
  grownRadius,
  human,
  inertia,
  makeOrb,
  playerById,
  playerRadius,
  reach,
  spawnOrb,
  spawnRate,
  travelCost,
} from "./board";
import {
  GUST,
  ORB,
  VOID,
  type EndReason,
  type GameState,
  type Orb,
  type OrbKind,
  type Player,
  type SimConfig,
  type SimEvent,
  type StepResult,
} from "./types";

type Body = { x: number; y: number; radius: number };

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

function clamp(o: Body, cfg: SimConfig): void {
  o.x = Math.min(cfg.width - o.radius, Math.max(o.radius, o.x));
  o.y = Math.min(cfg.height - o.radius, Math.max(o.radius, o.y));
}

function touching(a: Body, b: Body): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) < a.radius + b.radius;
}

/** Pull every orb toward (ax, ay) with the given mass. Moves them now and remembers it for drift. */
function attractOrbs(orbs: Orb[], ax: number, ay: number, mass: number, cfg: SimConfig): void {
  for (const o of orbs) {
    const ddx = ax - o.x;
    const ddy = ay - o.y;
    const dist = Math.hypot(ddx, ddy);
    if (dist === 0) continue;
    const d = pullDistance(dist, mass, cfg) * inertia(o.kind, cfg);
    const mx = (ddx / dist) * d;
    const my = (ddy / dist) * d;
    o.x += mx;
    o.y += my;
    o.dx += mx;
    o.dy += my;
    clamp(o, cfg);
  }
}

/** Other players are lights too: they get dragged toward the collection point, heavier ones less. */
function attractPlayers(players: Player[], ax: number, ay: number, mass: number, cfg: SimConfig): void {
  for (const p of players) {
    const ddx = ax - p.x;
    const ddy = ay - p.y;
    const dist = Math.hypot(ddx, ddy);
    if (dist === 0) continue;
    const d = pullDistance(dist, mass, cfg) * (cfg.playerBaseRadius / p.radius) * cfg.playerDrag;
    p.x += (ddx / dist) * d;
    p.y += (ddy / dist) * d;
    clamp(p, cfg);
  }
}

/** Push two bodies apart symmetrically until they just touch. */
function separate(a: Body, b: Body): void {
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
}

const fusible = (k: OrbKind) => k <= 3;

/**
 * Resolve every pair of touching orbs until the board is stable.
 * Same light kind → fuse into the next kind (star + star → void).
 * Void + anything → the void swallows it, banks its light, and grows. Void + void → one bigger void.
 * Everything else → nudge apart until they just touch.
 */
function resolveFusions(state: GameState, cfg: SimConfig, events: SimEvent[]): void {
  for (let iter = 0; iter < 64; iter++) {
    let pair: [number, number] | null = null;
    outer: for (let i = 0; i < state.orbs.length; i++) {
      for (let j = i + 1; j < state.orbs.length; j++) {
        if (touching(state.orbs[i]!, state.orbs[j]!)) {
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
      const result = makeOrb(state, (a.x + b.x) / 2, (a.y + b.y) / 2, VOID);
      result.radius = Math.sqrt(a.radius ** 2 + b.radius ** 2);
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
    if (a.kind === b.kind && fusible(a.kind)) {
      const kind = (a.kind + 1) as OrbKind;
      const result = makeOrb(state, (a.x + b.x) / 2, (a.y + b.y) / 2, kind);
      result.dx = (a.dx + b.dx) / 2;
      result.dy = (a.dy + b.dy) / 2;
      state.orbs.splice(j, 1);
      state.orbs.splice(i, 1);
      state.orbs.push(result);
      events.push({ type: "fuse", a: { ...a }, b: { ...b }, result: { ...result } });
      continue;
    }
    separate(a, b);
    events.push({ type: "separate", a: { ...a }, b: { ...b } });
  }
}

/** Light an orb is worth when a player absorbs it. Voids hand over everything they banked. */
function worth(o: Orb): number {
  return ORB[o.kind].value + o.stored;
}

function absorbOrb(state: GameState, p: Player, orb: Orb, by: "tap" | "overlap", cfg: SimConfig, events: SimEvent[]): void {
  state.orbs.splice(state.orbs.indexOf(orb), 1);
  const value = worth(orb);
  p.light += value;
  p.score += value;
  p.radius = playerRadius(p.light, cfg);
  events.push({ type: "collect", actor: p.id, orb: { ...orb }, by, value });
  if (orb.kind === GUST) {
    p.speed += cfg.gustBoost;
    events.push({ type: "boost", actor: p.id, speed: p.speed });
  }
}

function eliminate(
  state: GameState,
  victim: Player,
  reason: EndReason,
  events: SimEvent[],
  by?: Orb,
  byPlayer?: Player,
): void {
  victim.alive = false;
  events.push({ type: "eliminate", player: { ...victim }, reason, by, byPlayer });
  if (victim === human(state)) {
    state.status = "over";
    events.push({ type: "blackout", reason, by, byPlayer, at: { x: victim.x, y: victim.y } });
  }
}

/** One player absorbs another and takes everything they hold. */
function eat(state: GameState, predator: Player, prey: Player, cfg: SimConfig, events: SimEvent[]): void {
  const value = Math.max(0, prey.light);
  events.push({ type: "eat", predator: { ...predator }, prey: { ...prey }, value });
  eliminate(state, prey, "eaten", events, undefined, { ...predator });
  predator.light += value;
  predator.score += value;
  predator.radius = playerRadius(predator.light, cfg);
}

/**
 * Players touching players: a clearly bigger light absorbs the smaller (see eatMargin).
 * Exactly equal lights: a draw if one is you. Near-equal: they bounce.
 */
function resolvePlayers(state: GameState, cfg: SimConfig, events: SimEvent[]): void {
  for (let iter = 0; iter < 16; iter++) {
    let acted = false;
    const ps = alivePlayers(state);
    outer: for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) {
        const a = ps[i]!;
        const b = ps[j]!;
        if (!touching(a, b)) continue;
        if (Math.abs(a.radius - b.radius) < 1e-6 && (a === human(state) || b === human(state))) {
          state.status = "draw";
          events.push({ type: "draw", a: { ...a }, b: { ...b } });
          return;
        }
        if (!canEat(a, b, cfg) && !canEat(b, a, cfg)) {
          separate(a, b);
          continue;
        }
        const [big, small] = a.radius > b.radius ? [a, b] : [b, a];
        eat(state, big, small, cfg, events);
        acted = true;
        break outer;
      }
    }
    if (!acted) return;
  }
}

/** Every player eats the orbs it overlaps, or is eaten by any orb bigger than itself. */
function resolvePlayerOrbs(state: GameState, cfg: SimConfig, events: SimEvent[]): void {
  for (const p of state.players) {
    if (!p.alive) continue;
    for (let iter = 0; iter < 64; iter++) {
      const orb = state.orbs.find((o) => touching(o, p));
      if (!orb) break;
      if (orb.radius > p.radius) {
        eliminate(state, p, "absorbed", events, { ...orb });
        break;
      }
      absorbOrb(state, p, orb, "overlap", cfg, events);
    }
  }
}

/** Can this player absorb that body on contact? Orbs of equal size are food; players need a clear size edge. */
export function canEat(actor: Player, target: { radius: number; ai?: boolean }, cfg: SimConfig): boolean {
  return "ai" in target ? target.radius * (1 + cfg.eatMargin) < actor.radius : target.radius <= actor.radius;
}

/** Is this jump within the actor's reach? */
export function inRange(actor: Player, target: { x: number; y: number }, cfg: SimConfig): boolean {
  return Math.hypot(target.x - actor.x, target.y - actor.y) <= reach(actor, cfg);
}

/**
 * Orbs that `actor` could tap and survive the landing. Players are never tap targets:
 * you absorb an opponent by contact only, by landing beside them or pulling them onto you.
 */
export function edibleTargets(state: GameState, actorId: number, cfg: SimConfig): Orb[] {
  const actor = playerById(state, actorId);
  if (!actor || !actor.alive) return [];
  return state.orbs.filter((o) => canEat(actor, o, cfg) && inRange(actor, o, cfg));
}

// ---------- round phases ----------

/** Carry drift from last round and let voids pull. Once per round. */
export function beginRound(state: GameState, cfg: SimConfig): void {
  for (const o of state.orbs) {
    o.dx *= cfg.drift;
    o.dy *= cfg.drift;
    o.x += o.dx;
    o.y += o.dy;
    clamp(o, cfg);
  }
  for (const v of state.orbs) {
    if (v.kind !== VOID) continue;
    const m = ORB[VOID].mass * cfg.voidPull;
    attractOrbs(
      state.orbs.filter((o) => o !== v),
      v.x,
      v.y,
      m,
      cfg,
    );
    attractPlayers(alivePlayers(state), v.x, v.y, m, cfg);
  }
}

/** Where a player is heading this round. */
export interface Intent {
  actor: number;
  orbId: number;
  /** The orb's position when the decision was made; where you land if it's gone by the time you arrive. */
  x: number;
  y: number;
}

/**
 * One player's arrival: pay for the trip, land, and absorb the orb if it is still there.
 * Landing on something bigger is jumping into its mouth. A collection pulls the whole board.
 */
export function arrive(state: GameState, intent: Intent, cfg: SimConfig, events: SimEvent[]): void {
  const actor = playerById(state, intent.actor);
  if (!actor || !actor.alive || state.status !== "playing") return;
  const orb = state.orbs.find((o) => o.id === intent.orbId);
  let dest: { x: number; y: number } = orb ?? intent;
  if (!orb) {
    // Too late. Pull up short of whoever is standing where the light was, rather than into them.
    const blocker = alivePlayers(state).find((p) => p !== actor && Math.hypot(p.x - intent.x, p.y - intent.y) < p.radius + actor.radius);
    if (blocker) {
      const full = Math.hypot(intent.x - actor.x, intent.y - actor.y);
      const short = Math.max(0, full - (blocker.radius + actor.radius + 6));
      dest = { x: actor.x + ((intent.x - actor.x) / (full || 1)) * short, y: actor.y + ((intent.y - actor.y) / (full || 1)) * short };
    }
  }
  const dist = Math.hypot(dest.x - actor.x, dest.y - actor.y);
  const cost = travelCost(dist, actor.radius, cfg);
  actor.light -= cost;
  events.push({ type: "travel", actor: actor.id, dist, cost });
  actor.x = dest.x;
  actor.y = dest.y;
  if (!orb) {
    events.push({ type: "miss", actor: actor.id, orbId: intent.orbId, at: { x: intent.x, y: intent.y } });
    return;
  }
  if (orb.radius > actor.radius) {
    eliminate(state, actor, "absorbed", events, { ...orb });
    return;
  }
  absorbOrb(state, actor, orb, "tap", cfg, events);
  const grown = actor.radius - cfg.playerBaseRadius;
  const mass = ORB[orb.kind].mass + cfg.playerPull * (grown / 10);
  attractOrbs(state.orbs, actor.x, actor.y, mass, cfg);
  attractPlayers(
    alivePlayers(state).filter((p) => p !== actor),
    actor.x,
    actor.y,
    mass,
    cfg,
  );
}

/** Let the board come to rest: fusions, who eats whom, who faded. */
export function settle(state: GameState, cfg: SimConfig, events: SimEvent[]): void {
  if (state.status !== "playing") return;
  resolveFusions(state, cfg, events);
  resolvePlayers(state, cfg, events);
  if (state.status !== "playing") return;
  resolvePlayerOrbs(state, cfg, events);
  for (const p of state.players) {
    if (p.alive && p.light < 0) eliminate(state, p, "faded", events);
  }
}

/** Fresh light, fading with every round, then check for an ending. */
export function endRound(state: GameState, cfg: SimConfig, events: SimEvent[]): void {
  if (state.status !== "playing") return;
  state.spawnBank += spawnRate(state.turn, cfg);
  while (state.spawnBank >= 1) {
    state.spawnBank -= 1;
    const spawned = spawnOrb(state, cfg);
    if (spawned) events.push({ type: "spawn", orb: { ...spawned } });
  }
  const me = human(state);
  const rivals = state.players.filter((p) => p.ai && p.alive);
  if (cfg.opponents > 0 && rivals.length === 0) {
    state.status = "won";
    events.push({ type: "win" });
    return;
  }
  if (edibleTargets(state, me.id, cfg).length === 0) eliminate(state, me, "dark", events);
}

/**
 * One tap by one player with nobody else moving. Pure. This is the single-player game and the
 * primitive opponents use to evaluate their options; `round` in ai.ts is the multiplayer round.
 */
export function step(prev: GameState, targetId: number, cfg: SimConfig, actorId: number = human(prev).id): StepResult {
  const events: SimEvent[] = [];
  if (prev.status !== "playing") return { state: prev, events };
  const actor = playerById(prev, actorId);
  const orb = prev.orbs.find((o) => o.id === targetId);
  if (!actor || !actor.alive || !orb || !inRange(actor, orb, cfg)) return { state: prev, events };
  const state = cloneState(prev);
  const isHuman = actorId === human(prev).id;
  if (isHuman) {
    state.turn += 1;
    beginRound(state, cfg);
  }
  arrive(state, { actor: actorId, orbId: orb.id, x: orb.x, y: orb.y }, cfg, events);
  settle(state, cfg, events);
  if (isHuman) endRound(state, cfg, events);
  return { state, events };
}
