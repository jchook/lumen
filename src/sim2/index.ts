/**
 * LUMEN v2 — gravitational influence.
 *
 * Two lights on a fixed field. Alternating turns, full information, no randomness after setup.
 * A tap jumps you to an orb within reach and absorbs it; the landing is an impulse that sets the
 * whole field moving. Every ply the field then ticks: orbs accelerate toward every well, keep their
 * momentum, collide and fuse. Wells that overlap siphon light from the smaller to the larger.
 * The game ends when the light is gone or the clock runs out; more lumens wins.
 */

export type Kind = 1 | 2 | 3 | 4; // spark, ember, star, void
export const SPARK: Kind = 1;
export const EMBER: Kind = 2;
export const STAR: Kind = 3;
export const VOID: Kind = 4;

export const ORB: Record<Kind, { name: string; value: number; radius: number }> = {
  1: { name: "spark", value: 1, radius: 6 },
  2: { name: "ember", value: 3, radius: 10 },
  3: { name: "star", value: 10, radius: 18 },
  4: { name: "void", value: 0, radius: 24 },
};

export interface Orb {
  id: number;
  kind: Kind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  /** Voids: light banked from what they swallowed (starts at the two stars that made it). */
  stored: number;
}

export interface Light {
  id: number; // 0 = first player, 1 = second
  name: string;
  alive: boolean;
  x: number;
  y: number;
  lumens: number;
}

export interface State {
  seed: number;
  ply: number;
  /** Whose turn it is: 0 or 1. */
  toMove: 0 | 1;
  status: "playing" | "over";
  winner: -1 | 0 | 1; // -1 = draw or not over
  lights: [Light, Light];
  orbs: Orb[];
  nextId: number;
}

export interface Config {
  width: number;
  height: number;
  /** Starting lumens for both lights. */
  startLumens: number;
  /** Orbs on the board at the start, and their mix. */
  orbCount: number;
  mix: { spark: number; ember: number; star: number };
  /** Gravity: acceleration toward a well = G × lumens / (d² + soft²), capped. */
  G: number;
  soft: number;
  maxAccel: number;
  /** Void pull, as lumens-equivalent. */
  voidMass: number;
  /** Velocity kept per tick (0–1). */
  damping: number;
  /** Landing impulse: px/tick per lumen collected, at distance 0; halves at `impulseFalloff`. */
  impulse: number;
  impulseFalloff: number;
  /** Jump reach at start; shrinks as √(start / lumens). */
  reach: number;
  /** Lumens per 100px jumped at start size; grows as √(lumens / start). */
  jumpCost: number;
  /** Well radius = wellBase + wellGrowth × √lumens. Bodies overlap-absorb at body radius. */
  wellBase: number;
  wellGrowth: number;
  bodyBase: number;
  bodyGrowth: number;
  /** Fraction of the lumen difference siphoned per ply at full overlap. */
  siphon: number;
  /** Plies before the universe goes dark. */
  maxPly: number;
}

export const defaultConfig: Config = {
  width: 800,
  height: 800,
  startLumens: 5,
  orbCount: 26,
  mix: { spark: 0.55, ember: 0.33, star: 0.12 },
  G: 9000,
  soft: 60,
  maxAccel: 14,
  voidMass: 30,
  damping: 0.86,
  impulse: 2.2,
  impulseFalloff: 220,
  reach: 260,
  jumpCost: 0.6,
  wellBase: 40,
  wellGrowth: 14,
  bodyBase: 9,
  bodyGrowth: 2.2,
  siphon: 0.12,
  maxPly: 60,
};

// ---------- helpers ----------

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const lumensOf = (o: Orb): number => ORB[o.kind].value + o.stored;
export const wellRadius = (l: Light, cfg: Config): number => cfg.wellBase + cfg.wellGrowth * Math.sqrt(Math.max(0, l.lumens));
export const bodyRadius = (l: Light, cfg: Config): number => cfg.bodyBase + cfg.bodyGrowth * Math.sqrt(Math.max(0, l.lumens));
export const reachOf = (l: Light, cfg: Config): number => cfg.reach * Math.sqrt(cfg.startLumens / Math.max(0.5, l.lumens));
export const jumpCostOf = (l: Light, dist: number, cfg: Config): number =>
  cfg.jumpCost * (dist / 100) * Math.sqrt(Math.max(0.5, l.lumens) / cfg.startLumens);

export function me(s: State): Light {
  return s.lights[s.toMove];
}
export function them(s: State): Light {
  return s.lights[1 - s.toMove]!;
}

export function clone(s: State): State {
  return { ...s, lights: [{ ...s.lights[0] }, { ...s.lights[1] }], orbs: s.orbs.map((o) => ({ ...o })) };
}

// ---------- setup ----------

export function newGame(seed: number, cfg: Config = defaultConfig): State {
  const rnd = mulberry(seed);
  const lights: [Light, Light] = [
    { id: 0, name: "you", alive: true, x: cfg.width * 0.25, y: cfg.height * 0.5, lumens: cfg.startLumens },
    { id: 1, name: "Umbra", alive: true, x: cfg.width * 0.75, y: cfg.height * 0.5, lumens: cfg.startLumens },
  ];
  const s: State = { seed, ply: 0, toMove: 0, status: "playing", winner: -1, lights, orbs: [], nextId: 1 };
  // Mirror-symmetric board: whatever one light gets, the other gets reflected. Fair by construction.
  const half = Math.ceil(cfg.orbCount / 2);
  for (let i = 0; i < half; i++) {
    for (let attempt = 0; attempt < 60; attempt++) {
      const r = rnd();
      const kind: Kind = r < cfg.mix.star ? STAR : r < cfg.mix.star + cfg.mix.ember ? EMBER : SPARK;
      const x = 30 + rnd() * (cfg.width / 2 - 60);
      const y = 30 + rnd() * (cfg.height - 60);
      const ok = s.orbs.every((o) => Math.hypot(o.x - x, o.y - y) > o.radius + ORB[kind].radius + 24) &&
        lights.every((l) => Math.hypot(l.x - x, l.y - y) > bodyRadius(l, cfg) + ORB[kind].radius + 50) &&
        Math.abs(x - cfg.width / 2) > ORB[kind].radius + 14;
      if (!ok) continue;
      s.orbs.push({ id: s.nextId++, kind, x, y, vx: 0, vy: 0, radius: ORB[kind].radius, stored: 0 });
      s.orbs.push({ id: s.nextId++, kind, x: cfg.width - x, y, vx: 0, vy: 0, radius: ORB[kind].radius, stored: 0 });
      break;
    }
  }
  return s;
}

// ---------- rules ----------

export interface Ev {
  type: "jump" | "absorb" | "fuse" | "swallow" | "siphon" | "eliminated" | "over";
  who?: number;
  value?: number;
  at?: { x: number; y: number };
  note?: string;
}

/** Orbs the mover may jump to: within reach, and not something that would absorb them. */
export function options(s: State, cfg: Config = defaultConfig): Orb[] {
  const l = me(s);
  if (!l.alive) return [];
  const r = reachOf(l, cfg);
  return s.orbs.filter((o) => Math.hypot(o.x - l.x, o.y - l.y) <= r && lumensOf(o) <= l.lumens);
}

function absorbOrb(s: State, l: Light, o: Orb, ev: Ev[]): void {
  s.orbs.splice(s.orbs.indexOf(o), 1);
  const v = lumensOf(o);
  l.lumens += v;
  ev.push({ type: "absorb", who: l.id, value: v, at: { x: o.x, y: o.y } });
}

function eliminate(s: State, l: Light, why: string, ev: Ev[]): void {
  l.alive = false;
  l.lumens = 0;
  ev.push({ type: "eliminated", who: l.id, note: why });
  s.status = "over";
  s.winner = (1 - l.id) as 0 | 1;
  ev.push({ type: "over" });
}

/** One physics tick: wells pull, momentum carries, walls bounce, then collisions resolve. */
export function tick(s: State, cfg: Config, ev: Ev[]): void {
  const wells: Array<{ x: number; y: number; mass: number }> = [];
  for (const l of s.lights) if (l.alive) wells.push({ x: l.x, y: l.y, mass: l.lumens });
  for (const v of s.orbs) if (v.kind === VOID) wells.push({ x: v.x, y: v.y, mass: cfg.voidMass + v.stored * 0.5 });
  for (const o of s.orbs) {
    let ax = 0;
    let ay = 0;
    for (const w of wells) {
      const dx = w.x - o.x;
      const dy = w.y - o.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < 1) continue;
      const d = Math.sqrt(d2);
      const a = Math.min(cfg.maxAccel, (cfg.G * w.mass) / (d2 + cfg.soft * cfg.soft));
      ax += (dx / d) * a;
      ay += (dy / d) * a;
    }
    // Heavy things are harder to move.
    const inertia = 1 / Math.sqrt(Math.max(1, lumensOf(o)));
    o.vx = (o.vx + ax * inertia) * cfg.damping;
    o.vy = (o.vy + ay * inertia) * cfg.damping;
    o.x += o.vx;
    o.y += o.vy;
    if (o.x < o.radius) {
      o.x = o.radius;
      o.vx = Math.abs(o.vx) * 0.5;
    } else if (o.x > cfg.width - o.radius) {
      o.x = cfg.width - o.radius;
      o.vx = -Math.abs(o.vx) * 0.5;
    }
    if (o.y < o.radius) {
      o.y = o.radius;
      o.vy = Math.abs(o.vy) * 0.5;
    } else if (o.y > cfg.height - o.radius) {
      o.y = cfg.height - o.radius;
      o.vy = -Math.abs(o.vy) * 0.5;
    }
  }
  // Voids are pulled toward the lights too: a big well draws its own hazards in.
  for (const v of s.orbs) {
    if (v.kind !== VOID) continue;
    for (const l of s.lights) {
      if (!l.alive) continue;
      const dx = l.x - v.x;
      const dy = l.y - v.y;
      const d2 = dx * dx + dy * dy;
      const d = Math.sqrt(d2) || 1;
      const a = Math.min(cfg.maxAccel * 0.5, (cfg.G * l.lumens) / (d2 + cfg.soft * cfg.soft)) * 0.25;
      v.vx += (dx / d) * a;
      v.vy += (dy / d) * a;
    }
  }
  collide(s, cfg, ev);
  // Lights absorb what touches their body, or are absorbed by anything heavier that does.
  for (const l of s.lights) {
    if (!l.alive) continue;
    const br = bodyRadius(l, cfg);
    for (let guard = 0; guard < 32; guard++) {
      const o = s.orbs.find((o) => Math.hypot(o.x - l.x, o.y - l.y) < br + o.radius);
      if (!o) break;
      if (lumensOf(o) > l.lumens) {
        eliminate(s, l, `absorbed by a ${ORB[o.kind].name}`, ev);
        return;
      }
      absorbOrb(s, l, o, ev);
    }
  }
  siphon(s, cfg, ev);
}

function collide(s: State, cfg: Config, ev: Ev[]): void {
  for (let iter = 0; iter < 48; iter++) {
    let hit: [Orb, Orb] | null = null;
    outer: for (let i = 0; i < s.orbs.length; i++) {
      for (let j = i + 1; j < s.orbs.length; j++) {
        const a = s.orbs[i]!;
        const b = s.orbs[j]!;
        if (Math.hypot(a.x - b.x, a.y - b.y) < a.radius + b.radius) {
          hit = [a, b];
          break outer;
        }
      }
    }
    if (!hit) return;
    const [a, b] = hit;
    if (a.kind === VOID || b.kind === VOID) {
      const [v, prey] = a.kind === VOID ? [a, b] : [b, a];
      v.stored += lumensOf(prey);
      v.radius = Math.sqrt(v.radius ** 2 + prey.radius ** 2 * 1.5);
      s.orbs.splice(s.orbs.indexOf(prey), 1);
      ev.push({ type: "swallow", at: { x: v.x, y: v.y }, value: lumensOf(prey) });
      continue;
    }
    if (a.kind === b.kind) {
      const kind = (a.kind + 1) as Kind;
      const result: Orb = {
        id: s.nextId++,
        kind,
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2,
        vx: (a.vx + b.vx) / 2,
        vy: (a.vy + b.vy) / 2,
        radius: ORB[kind].radius,
        stored: kind === VOID ? 2 * ORB[STAR].value : 0,
      };
      s.orbs.splice(s.orbs.indexOf(a), 1);
      s.orbs.splice(s.orbs.indexOf(b), 1);
      s.orbs.push(result);
      ev.push({ type: "fuse", at: { x: result.x, y: result.y }, value: lumensOf(result) });
      continue;
    }
    // Bounce: separate and swap the normal components of velocity.
    const nx = b.x - a.x;
    const ny = b.y - a.y;
    const d = Math.hypot(nx, ny) || 1;
    const ux = nx / d;
    const uy = ny / d;
    const push = (a.radius + b.radius - d) / 2 + 0.5;
    a.x -= ux * push;
    a.y -= uy * push;
    b.x += ux * push;
    b.y += uy * push;
    const va = a.vx * ux + a.vy * uy;
    const vb = b.vx * ux + b.vy * uy;
    a.vx += (vb - va) * ux * 0.8;
    a.vy += (vb - va) * uy * 0.8;
    b.vx += (va - vb) * ux * 0.8;
    b.vy += (va - vb) * uy * 0.8;
  }
}

/** Overlapping wells: the larger light draws lumens from the smaller, faster the deeper the overlap. */
function siphon(s: State, cfg: Config, ev: Ev[]): void {
  const [a, b] = s.lights;
  if (!a.alive || !b.alive || s.status !== "playing") return;
  const d = Math.hypot(a.x - b.x, a.y - b.y);
  const ra = wellRadius(a, cfg);
  const rb = wellRadius(b, cfg);
  const overlap = ra + rb - d;
  if (overlap <= 0) return;
  const f = Math.min(1, overlap / (2 * Math.min(ra, rb)));
  const [big, small] = a.lumens >= b.lumens ? [a, b] : [b, a];
  const amount = Math.min(small.lumens, cfg.siphon * f * Math.max(0.5, big.lumens - small.lumens));
  if (amount <= 0) return;
  small.lumens -= amount;
  big.lumens += amount;
  ev.push({ type: "siphon", who: big.id, value: amount });
  if (small.lumens <= 0.05) eliminate(s, small, `drained by ${big.name}`, ev);
}

function finish(s: State, cfg: Config, ev: Ev[]): void {
  if (s.status !== "playing") return;
  const lightLeft = s.orbs.some((o) => o.kind !== VOID);
  if (s.ply >= cfg.maxPly || !lightLeft) {
    s.status = "over";
    const [a, b] = s.lights;
    s.winner = Math.abs(a.lumens - b.lumens) < 1e-9 ? -1 : a.lumens > b.lumens ? 0 : 1;
    ev.push({ type: "over", note: lightLeft ? "the clock ran out" : "the light is gone" });
  }
}

/**
 * One ply. targetId = an orb id to jump to, or null to hold position (the field still ticks).
 * Returns the same state object if the move is illegal.
 */
export function play(prev: State, targetId: number | null, cfg: Config = defaultConfig): { state: State; events: Ev[] } {
  const events: Ev[] = [];
  if (prev.status !== "playing") return { state: prev, events };
  const target = targetId === null ? null : options(prev, cfg).find((o) => o.id === targetId);
  if (targetId !== null && !target) return { state: prev, events };
  const s = clone(prev);
  const l = me(s);
  if (target) {
    const o = s.orbs.find((x) => x.id === target.id)!;
    const dist = Math.hypot(o.x - l.x, o.y - l.y);
    l.lumens -= jumpCostOf(l, dist, cfg);
    l.x = o.x;
    l.y = o.y;
    events.push({ type: "jump", who: l.id, value: dist });
    absorbOrb(s, l, o, events);
    // Landing impulse: everything lurches toward the point where the light vanished.
    const kick = cfg.impulse * lumensOf(o);
    for (const q of s.orbs) {
      const dx = l.x - q.x;
      const dy = l.y - q.y;
      const d = Math.hypot(dx, dy) || 1;
      const k = (kick / (1 + d / cfg.impulseFalloff)) / Math.sqrt(Math.max(1, lumensOf(q)));
      q.vx += (dx / d) * k;
      q.vy += (dy / d) * k;
    }
    if (l.lumens <= 0) {
      eliminate(s, l, "faded on the jump", events);
      return { state: s, events };
    }
  }
  s.ply += 1;
  tick(s, cfg, events);
  if (s.status === "playing") {
    s.toMove = (1 - s.toMove) as 0 | 1;
    finish(s, cfg, events);
  }
  return { state: s, events };
}

// ---------- search ----------

/** Static evaluation from player `who`'s view: lumen lead, plus light that is closer to me than to them. */
export function evaluate(s: State, who: 0 | 1, cfg: Config = defaultConfig): number {
  const a = s.lights[who];
  const b = s.lights[1 - who]!;
  if (s.status === "over") return s.winner === who ? 1000 : s.winner === -1 ? 0 : -1000;
  let field = 0;
  for (const o of s.orbs) {
    if (o.kind === VOID) continue;
    const da = Math.hypot(o.x - a.x, o.y - a.y);
    const db = Math.hypot(o.x - b.x, o.y - b.y);
    field += lumensOf(o) * (db - da) / (da + db + 1);
  }
  return a.lumens - b.lumens + 0.35 * field;
}

/** Fixed-depth negamax with alpha-beta. Depth counts plies. */
export function search(s: State, depth: number, cfg: Config = defaultConfig, alpha = -Infinity, beta = Infinity): { value: number; move: number | null } {
  const who = s.toMove;
  if (depth === 0 || s.status !== "playing") return { value: evaluate(s, who, cfg), move: null };
  const moves: Array<number | null> = [...options(s, cfg).map((o) => o.id), null];
  let best = -Infinity;
  let bestMove: number | null = null;
  for (const m of moves) {
    const r = play(s, m, cfg);
    if (r.state === s) continue;
    // Opponent to move next (or the game ended): negate their value.
    const v = r.state.status !== "playing" ? evaluate(r.state, who, cfg) : -search(r.state, depth - 1, cfg, -beta, -alpha).value;
    if (v > best) {
      best = v;
      bestMove = m;
    }
    alpha = Math.max(alpha, v);
    if (alpha >= beta) break;
  }
  return { value: best, move: bestMove };
}
