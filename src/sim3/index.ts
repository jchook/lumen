/**
 * LUMEN v3 — realtime orbital absorption.
 *
 * A torus arena with a few suns. Every body carries lumens (its mass); radius grows with the square
 * root of mass so area is mass. Bodies above `gravityMass` bend space: everything else falls toward
 * them with softened Newtonian gravity and keeps its momentum, so orbs and lights orbit.
 *
 * A light moves by burning: it flings a fraction of its own mass out the back as a new orb and
 * recoils the other way (momentum is conserved, so the exhaust is real food for whoever is chasing).
 * When two bodies overlap, lumens flow from the lighter into the heavier at a rate set by the
 * overlap. A body that runs dry is gone. Last light burning wins.
 *
 * Fixed timestep, seeded, headless. The renderer only interpolates.
 */

export type Kind = "sun" | "orb" | "light";

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
  /** Suns don't move. */
  anchored: boolean;
  /** Exhaust: the light that burned it, for colouring. */
  from: number;
  /** Seconds until this light may burn again. */
  cooldown: number;
}

export interface Config {
  width: number;
  height: number;
  suns: number;
  sunMass: number;
  orbs: number;
  orbMassMin: number;
  orbMassMax: number;
  /** Total lights, including the human (id 1). */
  players: number;
  startMass: number;
  /** Gravitational constant, px³/s² per unit mass. */
  G: number;
  /** Plummer softening, px. */
  soft: number;
  /** Bodies at or above this mass attract. */
  gravityMass: number;
  maxAccel: number;
  maxSpeed: number;
  /** radius = radiusScale · √mass */
  radiusScale: number;
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
  /** Suns radiate what they've eaten back out as orbs: mass per second per sun while above sunMass. */
  wind: number;
  /** Seconds between wind orbs. */
  windEvery: number;
}

export const defaultConfig: Config = {
  width: 2400,
  height: 2400,
  suns: 3,
  sunMass: 400,
  orbs: 80,
  orbMassMin: 0.4,
  orbMassMax: 5,
  players: 4,
  startMass: 8,
  G: 2500,
  soft: 40,
  gravityMass: 40,
  maxAccel: 600,
  maxSpeed: 500,
  radiusScale: 4,
  absorbRate: 2.5,
  burnFraction: 0.04,
  ejectSpeed: 500,
  burnCooldown: 0.15,
  minBurnMass: 0.5,
  dust: 0.05,
  wind: 0.8,
  windEvery: 1.5,
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

export const radiusOf = (mass: number, cfg: Config): number => cfg.radiusScale * Math.sqrt(Math.max(0, mass));

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
export const attractors = (s: State, cfg: Config): Body[] => s.bodies.filter((b) => b.mass >= cfg.gravityMass);

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
  // Suns on a loose ring around the arena centre, jittered.
  const suns: Body[] = [];
  const cx = cfg.width / 2;
  const cy = cfg.height / 2;
  const ring = Math.min(cfg.width, cfg.height) * 0.3;
  for (let i = 0; i < cfg.suns; i++) {
    const a = (i / cfg.suns) * Math.PI * 2 + rng() * 0.6;
    const r = ring * (0.8 + rng() * 0.4);
    suns.push(makeBody(s, "sun", wrap(cx + Math.cos(a) * r, cfg.width), wrap(cy + Math.sin(a) * r, cfg.height), cfg.sunMass, { anchored: true }));
  }
  const placeInOrbit = (kind: Kind, mass: number, sun: Body, d: number, angle: number, extra: Partial<Body> = {}): Body => {
    const x = wrap(sun.x + Math.cos(angle) * d, cfg.width);
    const y = wrap(sun.y + Math.sin(angle) * d, cfg.height);
    const v = orbitalSpeed(sun.mass, d, cfg);
    return makeBody(s, kind, x, y, mass, { vx: -Math.sin(angle) * v, vy: Math.cos(angle) * v, ...extra });
  };
  // Lights: the human first, spaced around different suns at a comfortable orbit.
  for (let i = 0; i < cfg.players; i++) {
    const sun = suns[i % suns.length]!;
    const d = radiusOf(sun.mass, cfg) + 220 + rng() * 80;
    placeInOrbit("light", cfg.startMass, sun, d, rng() * Math.PI * 2, {
      name: i === 0 ? "You" : NAMES[(i - 1) % NAMES.length]!,
      ai: i !== 0,
    });
  }
  // Orbs: prograde orbits, heavy tail of small ones.
  for (let i = 0; i < cfg.orbs; i++) {
    const sun = suns[Math.floor(rng() * suns.length)]!;
    const t = rng();
    const mass = cfg.orbMassMin + (cfg.orbMassMax - cfg.orbMassMin) * t * t;
    const d = radiusOf(sun.mass, cfg) + 40 + rng() * (ring * 0.9);
    placeInOrbit("orb", mass, sun, d, rng() * Math.PI * 2);
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
  const f = cfg.burnFraction * k;
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

function move(s: State, cfg: Config, dt: number): void {
  for (const b of s.bodies) {
    if (b.anchored || !b.alive) continue;
    b.x = wrap(b.x + b.vx * dt, cfg.width);
    b.y = wrap(b.y + b.vy * dt, cfg.height);
    if (b.cooldown > 0) b.cooldown = Math.max(0, b.cooldown - dt);
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

/** Suns don't keep what they eat: the excess comes back out as slow orbs on a rising orbit. */
function solarWind(s: State, cfg: Config, dt: number): void {
  const slot = Math.floor(s.time / cfg.windEvery);
  if (slot === Math.floor((s.time - dt) / cfg.windEvery)) return;
  for (const sun of s.bodies) {
    if (sun.kind !== "sun") continue;
    const excess = sun.mass - cfg.sunMass;
    if (excess <= 0) continue;
    const m = Math.min(excess, cfg.wind * cfg.windEvery);
    if (m < cfg.dust * 4) continue;
    const a = (sun.id * 2.399 + slot * 1.618) % (Math.PI * 2);
    const d = radiusOf(sun.mass, cfg) + radiusOf(m, cfg) + 24;
    const v = orbitalSpeed(sun.mass, d, cfg) * 1.12;
    sun.mass -= m;
    makeBody(s, "orb", wrap(sun.x + Math.cos(a) * d, cfg.width), wrap(sun.y + Math.sin(a) * d, cfg.height), m, {
      vx: -Math.sin(a) * v,
      vy: Math.cos(a) * v,
    });
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
  move(s, cfg, dt);
  absorb(s, cfg, dt, ev);
  solarWind(s, cfg, dt);
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
