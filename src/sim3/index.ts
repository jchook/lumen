/**
 * LUMEN v3 — realtime orbital absorption.
 *
 * A torus arena of bodies at every scale, from specks to giants. Every body carries lumens (its
 * mass); radius grows with the square root of mass so area is mass. Bodies above `gravityMass` bend
 * space: everything falls toward them with softened Newtonian gravity and keeps its momentum, so
 * the small orbit the large, and the large drift slowly around each other.
 *
 * A light moves by burning: it flings a fraction of its own mass out the back as a new orb and
 * recoils the other way (momentum is conserved, so the exhaust is real food for whoever is chasing).
 * When two bodies overlap, lumens flow from the lighter into the heavier at a rate set by the
 * overlap. A body that runs dry is gone. Last light burning wins.
 *
 * Fixed timestep, seeded, headless. The renderer only interpolates.
 */

export type Kind = "orb" | "light";

export interface Body {
  id: number;
  kind: Kind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  mass: number;
  /** Lights only. */
  name: string;
  ai: boolean;
  alive: boolean;
  /** Pinned in place (tests and special boards). */
  anchored: boolean;
  /** Exhaust: the light that burned it, for colouring. */
  from: number;
  /** Seconds until this light may burn again. */
  cooldown: number;
}

export interface Config {
  width: number;
  height: number;
  /** Bodies seeded at the start, besides the lights. */
  orbs: number;
  /** Mass range of seeded bodies; the distribution is heavily skewed toward small. */
  orbMassMin: number;
  orbMassMax: number;
  /** How many of the seeded bodies are giants near orbMassMax, spaced apart. */
  giants: number;
  /** How many are middleweights (a fraction of a giant), the roaming hazards. */
  middleweights: number;
  /** Total lights, including the human (id 1). */
  players: number;
  startMass: number;
  /** Gravitational constant, px³/s² per unit mass. */
  G: number;
  /** Plummer softening, px. */
  soft: number;
  /** Orbs at or above this mass attract. */
  gravityMass: number;
  /** Lights only attract from here: growing doesn't hand you a vacuum cleaner. */
  lightGravityMass: number;
  /** Burns scale by √(startMass / mass), clamped: small lights are nimble, giants are sluggish. */
  agilityMin: number;
  agilityMax: number;
  maxAccel: number;
  maxSpeed: number;
  /** radius = radiusScale · √mass + radiusFloor, so specks are still catchable. */
  radiusScale: number;
  radiusFloor: number;
  /** Mass per second per px of overlap flowing from lighter to heavier. */
  absorbRate: number;
  /** Fraction of mass thrown out by a full-strength burn. */
  burnFraction: number;
  /** Speed of the exhaust relative to the light, px/s. */
  ejectSpeed: number;
  /** Seconds between burns. */
  burnCooldown: number;
  /** A light this small can no longer burn. */
  minBurnMass: number;
  /** Bodies below this mass vanish. */
  dust: number;
  /** Exhaust is a flare, not food: its mass halves every this many seconds. */
  exhaustHalfLife: number;
}

export const defaultConfig: Config = {
  width: 2400,
  height: 2400,
  orbs: 72,
  orbMassMin: 0.4,
  orbMassMax: 120,
  giants: 3,
  middleweights: 3,
  players: 4,
  startMass: 8,
  G: 2200,
  soft: 40,
  gravityMass: 30,
  lightGravityMass: 90,
  agilityMin: 0.4,
  agilityMax: 1.25,
  maxAccel: 500,
  maxSpeed: 400,
  radiusScale: 4,
  radiusFloor: 3,
  absorbRate: 2.5,
  burnFraction: 0.045,
  ejectSpeed: 900,
  burnCooldown: 0.2,
  minBurnMass: 0.5,
  dust: 0.05,
  exhaustHalfLife: 1.2,
};

export type Ev =
  | { type: "absorb"; eater: number; food: number; amount: number }
  | { type: "gone"; id: number; kind: Kind; name: string; by: number }
  | { type: "burn"; id: number; x: number; y: number; dx: number; dy: number; mass: number }
  | { type: "win"; id: number }
  | { type: "over" };

export interface State {
  seed: number;
  rng: () => number;
  time: number;
  status: "playing" | "over" | "won";
  nextId: number;
  bodies: Body[];
}

// ---------- helpers ----------

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const radiusOf = (mass: number, cfg: Config): number => cfg.radiusScale * Math.sqrt(Math.max(0, mass)) + cfg.radiusFloor;

/** Shortest displacement from a to b on the torus. */
export function delta(ax: number, ay: number, bx: number, by: number, cfg: Config): [number, number] {
  let dx = bx - ax;
  let dy = by - ay;
  const w = cfg.width;
  const h = cfg.height;
  if (dx > w / 2) dx -= w;
  else if (dx < -w / 2) dx += w;
  if (dy > h / 2) dy -= h;
  else if (dy < -h / 2) dy += h;
  return [dx, dy];
}

export function dist(a: { x: number; y: number }, b: { x: number; y: number }, cfg: Config): number {
  const [dx, dy] = delta(a.x, a.y, b.x, b.y, cfg);
  return Math.hypot(dx, dy);
}

const wrap = (v: number, n: number): number => ((v % n) + n) % n;

export const human = (s: State): Body => s.bodies.find((b) => b.kind === "light" && !b.ai)!;
export const lights = (s: State): Body[] => s.bodies.filter((b) => b.kind === "light" && b.alive);
export const byId = (s: State, id: number): Body | undefined => s.bodies.find((b) => b.id === id);
export const attracts = (b: Body, cfg: Config): boolean => b.alive && b.mass >= (b.kind === "light" ? cfg.lightGravityMass : cfg.gravityMass);
export const attractors = (s: State, cfg: Config): Body[] => s.bodies.filter((b) => attracts(b, cfg));

/** How much of a full burn a light of this mass actually gets. */
export const agility = (mass: number, cfg: Config): number =>
  Math.min(cfg.agilityMax, Math.max(cfg.agilityMin, Math.sqrt(cfg.startMass / Math.max(0.01, mass))));

/** Δv a burn of `strength` gives a light of `mass`, px/s. */
export function burnDeltaV(mass: number, strength: number, cfg: Config): number {
  const k = Math.min(1, Math.max(0.15, strength));
  const f = cfg.burnFraction * k * agility(mass, cfg);
  return (cfg.ejectSpeed * f) / (1 - f);
}

function makeBody(s: State, kind: Kind, x: number, y: number, mass: number, extra: Partial<Body> = {}): Body {
  const b: Body = {
    id: s.nextId++,
    kind,
    x,
    y,
    vx: 0,
    vy: 0,
    mass,
    name: "",
    ai: false,
    alive: true,
    anchored: false,
    from: 0,
    cooldown: 0,
    ...extra,
  };
  s.bodies.push(b);
  return b;
}

/** Speed of a circular orbit at distance d around mass M (with softening). */
export function orbitalSpeed(M: number, d: number, cfg: Config): number {
  return Math.sqrt((cfg.G * M * d * d) / Math.pow(d * d + cfg.soft * cfg.soft, 1.5));
}

const NAMES = ["Umbra", "Nyx", "Sable", "Vesper", "Morrow", "Ash", "Dusk", "Rune"];

// ---------- setup ----------

export function newGame(seed: number, cfg: Config = defaultConfig): State {
  const s: State = { seed, rng: mulberry32(seed), time: 0, status: "playing", nextId: 1, bodies: [] };
  const rng = s.rng;
  const cx = cfg.width / 2;
  const cy = cfg.height / 2;
  const ring = Math.min(cfg.width, cfg.height) * 0.3;
  // Giants on a loose ring, spaced apart. They move, but slowly: they only feel each other.
  const giants: Body[] = [];
  for (let i = 0; i < cfg.giants; i++) {
    const a = (i / cfg.giants) * Math.PI * 2 + rng() * 0.6;
    const r = ring * (0.8 + rng() * 0.4);
    const mass = cfg.orbMassMax * (0.6 + rng() * 0.4);
    giants.push(makeBody(s, "orb", wrap(cx + Math.cos(a) * r, cfg.width), wrap(cy + Math.sin(a) * r, cfg.height), mass));
  }
  const nearestGiant = (x: number, y: number): { g: Body; dx: number; dy: number; d: number } => {
    let best: { g: Body; dx: number; dy: number; d: number } | null = null;
    for (const g of giants) {
      const [dx, dy] = delta(g.x, g.y, x, y, cfg);
      const d = Math.hypot(dx, dy);
      if (!best || d < best.d) best = { g, dx, dy, d };
    }
    return best!;
  };
  /** A body at (x, y) with the circular speed of the nearest giant, so it orbits rather than falls. */
  const drifting = (kind: Kind, mass: number, x: number, y: number, extra: Partial<Body> = {}): Body => {
    const n = nearestGiant(x, y);
    const d = n.d || 1;
    const v = orbitalSpeed(n.g.mass, d, cfg);
    return makeBody(s, kind, x, y, mass, { vx: (-n.dy / d) * v + n.g.vx, vy: (n.dx / d) * v + n.g.vy, ...extra });
  };
  /** A spot at least `gap` from every giant's edge and every light, or the best found. */
  const openSpot = (gap: number): [number, number] => {
    let bx = 0;
    let by = 0;
    let best = -Infinity;
    for (let tries = 0; tries < 24; tries++) {
      const px = rng() * cfg.width;
      const py = rng() * cfg.height;
      let g = Infinity;
      for (const b of s.bodies) {
        if (b.mass < cfg.gravityMass && b.kind !== "light") continue;
        g = Math.min(g, dist({ x: px, y: py }, b, cfg) - radiusOf(b.mass, cfg));
      }
      if (g > best) {
        best = g;
        bx = px;
        by = py;
      }
      if (g >= gap) break;
    }
    return [bx, by];
  };
  // Lights: the human first, each in a comfortable orbit around a different giant.
  for (let i = 0; i < cfg.players; i++) {
    const g = giants[i % giants.length]!;
    const d = radiusOf(g.mass, cfg) + 240 + rng() * 80;
    const a = rng() * Math.PI * 2;
    drifting("light", cfg.startMass, wrap(g.x + Math.cos(a) * d, cfg.width), wrap(g.y + Math.sin(a) * d, cfg.height), {
      name: i === 0 ? "You" : NAMES[(i - 1) % NAMES.length]!,
      ai: i !== 0,
    });
  }
  // Middleweights: a quarter to a half of a giant, kept well away from everything heavy.
  for (let i = 0; i < cfg.middleweights; i++) {
    const mass = cfg.orbMassMax * (0.25 + rng() * 0.25);
    const [x, y] = openSpot(320);
    drifting("orb", mass, x, y);
  }
  // Everything else is lighter than a starting light's future: specks mostly, some morsels, a few
  // prizes that a grown light can take. None of these attract.
  for (let i = giants.length + cfg.middleweights; i < cfg.orbs; i++) {
    const u = rng();
    const top = Math.min(cfg.gravityMass * 0.6, cfg.orbMassMax * 0.15);
    const mass = u < 0.6 ? cfg.orbMassMin + rng() * 1.6 : u < 0.85 ? 2 + rng() * 4 : 6 + rng() * (top - 6);
    const [x, y] = openSpot(120);
    drifting("orb", mass, x, y);
  }
  return s;
}

export function cloneState(s: State): State {
  const c: State = { ...s, bodies: s.bodies.map((b) => ({ ...b })) };
  // Re-seed the rng to the same point by replaying is impractical; clones share determinism by not using rng after setup.
  return c;
}

// ---------- actions ----------

/**
 * A light throws mass out behind it and recoils toward (dx, dy). `strength` in [0, 1] scales the
 * fraction of mass burned. Returns false when the light can't burn (cooling down, too small, dead).
 */
export function burn(s: State, id: number, dx: number, dy: number, strength: number, cfg: Config, ev: Ev[] = []): boolean {
  const b = byId(s, id);
  if (!b || b.kind !== "light" || !b.alive || b.cooldown > 0) return false;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return false;
  const k = Math.min(1, Math.max(0.15, strength));
  const f = cfg.burnFraction * k * agility(b.mass, cfg);
  const m = b.mass * f;
  if (b.mass - m < cfg.minBurnMass) return false;
  const ux = dx / len;
  const uy = dy / len;
  const rest = b.mass - m;
  // Momentum: rest · Δv = m · ejectSpeed.
  const dv = (cfg.ejectSpeed * m) / rest;
  const exR = radiusOf(m, cfg);
  const ex = makeBody(s, "orb", wrap(b.x - ux * (radiusOf(b.mass, cfg) + exR + 1), cfg.width), wrap(b.y - uy * (radiusOf(b.mass, cfg) + exR + 1), cfg.height), m, {
    vx: b.vx - ux * cfg.ejectSpeed,
    vy: b.vy - uy * cfg.ejectSpeed,
    from: b.id,
  });
  b.mass = rest;
  b.vx += ux * dv;
  b.vy += uy * dv;
  b.cooldown = cfg.burnCooldown;
  ev.push({ type: "burn", id: b.id, x: ex.x, y: ex.y, dx: ux, dy: uy, mass: m });
  return true;
}

// ---------- physics ----------

function gravity(s: State, cfg: Config, dt: number): void {
  const wells = attractors(s, cfg);
  for (const b of s.bodies) {
    if (b.anchored || !b.alive) continue;
    let ax = 0;
    let ay = 0;
    for (const w of wells) {
      if (w === b) continue;
      const [dx, dy] = delta(b.x, b.y, w.x, w.y, cfg);
      const d2 = dx * dx + dy * dy + cfg.soft * cfg.soft;
      const a = (cfg.G * w.mass) / d2;
      const d = Math.sqrt(d2);
      ax += (a * dx) / d;
      ay += (a * dy) / d;
    }
    const mag = Math.hypot(ax, ay);
    if (mag > cfg.maxAccel) {
      ax *= cfg.maxAccel / mag;
      ay *= cfg.maxAccel / mag;
    }
    b.vx += ax * dt;
    b.vy += ay * dt;
    const sp = Math.hypot(b.vx, b.vy);
    if (sp > cfg.maxSpeed) {
      b.vx *= cfg.maxSpeed / sp;
      b.vy *= cfg.maxSpeed / sp;
    }
  }
}

function move(s: State, cfg: Config, dt: number, ev: Ev[]): void {
  for (const b of s.bodies) {
    if (b.anchored || !b.alive) continue;
    b.x = wrap(b.x + b.vx * dt, cfg.width);
    b.y = wrap(b.y + b.vy * dt, cfg.height);
    if (b.cooldown > 0) b.cooldown = Math.max(0, b.cooldown - dt);
    if (b.from) {
      b.mass *= Math.pow(0.5, dt / cfg.exhaustHalfLife);
      if (b.mass <= cfg.dust) vanish(s, b, 0, ev);
    }
  }
}

function vanish(s: State, b: Body, by: number, ev: Ev[]): void {
  b.alive = false;
  b.mass = 0;
  ev.push({ type: "gone", id: b.id, kind: b.kind, name: b.name, by });
}

/** Overlapping bodies: lumens flow from lighter to heavier. Equal masses trade nothing. */
function absorb(s: State, cfg: Config, dt: number, ev: Ev[]): void {
  const bs = s.bodies;
  for (let i = 0; i < bs.length; i++) {
    const a = bs[i]!;
    if (!a.alive) continue;
    for (let j = i + 1; j < bs.length; j++) {
      const b = bs[j]!;
      if (!b.alive || a.mass === b.mass) continue;
      const [big, small] = a.mass > b.mass ? [a, b] : [b, a];
      const d = dist(a, b, cfg);
      const overlap = radiusOf(big.mass, cfg) + radiusOf(small.mass, cfg) - d;
      if (overlap <= 0) continue;
      const amount = Math.min(small.mass, cfg.absorbRate * overlap * dt);
      if (amount <= 0) continue;
      // Momentum carries over with the mass.
      if (!big.anchored) {
        const total = big.mass + amount;
        big.vx = (big.vx * big.mass + small.vx * amount) / total;
        big.vy = (big.vy * big.mass + small.vy * amount) / total;
      }
      big.mass += amount;
      small.mass -= amount;
      ev.push({ type: "absorb", eater: big.id, food: small.id, amount });
      if (small.mass <= cfg.dust) {
        big.mass += small.mass;
        vanish(s, small, big.id, ev);
      }
    }
  }
}

function finish(s: State, ev: Ev[]): void {
  const me = s.bodies.find((b) => b.kind === "light" && !b.ai);
  const rivals = s.bodies.filter((b) => b.kind === "light" && b.ai);
  if (me && !me.alive) {
    s.status = "over";
    ev.push({ type: "over" });
  } else if (me && rivals.length > 0 && rivals.every((r) => !r.alive)) {
    s.status = "won";
    ev.push({ type: "win", id: me.id });
  }
}

/** Advance the world by `dt` seconds. Mutates `s`; returns the events of this step. */
export function step(s: State, cfg: Config, dt: number, ev: Ev[] = []): Ev[] {
  if (s.status !== "playing") return ev;
  gravity(s, cfg, dt);
  move(s, cfg, dt, ev);
  absorb(s, cfg, dt, ev);
  // Sweep the dead so the pair loop stays cheap.
  s.bodies = s.bodies.filter((b) => b.alive || b.kind === "light");
  s.time += dt;
  finish(s, ev);
  return ev;
}

/**
 * Where `b` will be if it never burns: positions sampled every `dt` for `seconds`, under the
 * current attractors (which are assumed not to move). Cheap enough to run per bot per decision.
 */
export function predict(s: State, b: Body, cfg: Config, seconds: number, dt = 0.1): Array<{ x: number; y: number }> {
  const wells = attractors(s, cfg).filter((w) => w !== b);
  let { x, y, vx, vy } = b;
  const out: Array<{ x: number; y: number }> = [];
  for (let t = 0; t < seconds; t += dt) {
    let ax = 0;
    let ay = 0;
    for (const w of wells) {
      const [dx, dy] = delta(x, y, w.x, w.y, cfg);
      const d2 = dx * dx + dy * dy + cfg.soft * cfg.soft;
      const a = (cfg.G * w.mass) / d2;
      const d = Math.sqrt(d2);
      ax += (a * dx) / d;
      ay += (a * dy) / d;
    }
    const mag = Math.hypot(ax, ay);
    if (mag > cfg.maxAccel) {
      ax *= cfg.maxAccel / mag;
      ay *= cfg.maxAccel / mag;
    }
    vx += ax * dt;
    vy += ay * dt;
    x = wrap(x + vx * dt, cfg.width);
    y = wrap(y + vy * dt, cfg.height);
    out.push({ x, y });
  }
  return out;
}

/** Everything heavier than `b` that could reach it: for camera and threat display. */
export function threats(s: State, b: Body, cfg: Config): Array<{ body: Body; d: number }> {
  return s.bodies
    .filter((o) => o.alive && o !== b && o.mass > b.mass)
    .map((o) => ({ body: o, d: dist(b, o, cfg) - radiusOf(o.mass, cfg) - radiusOf(b.mass, cfg) }))
    .sort((p, q) => p.d - q.d);
}
