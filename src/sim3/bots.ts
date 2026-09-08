/**
 * Scripted lights. Three instincts, checked in order: escape anything heavier that is pulling you
 * in, chase a lighter body when its mass beats the burns it will take to reach it, otherwise coast
 * and let gravity do the work. Every burn is paid in mass, so the price is always computed first.
 */
import { burnDeltaV, byId, delta, predict, radiusOf, type Body, type Config, type State } from "./index";

export interface Intent {
  dx: number;
  dy: number;
  strength: number;
}

export interface BotStyle {
  /** How far a bot notices things, px. */
  sense: number;
  /** Threat gap (px) under which it burns away. */
  fear: number;
  /** An orb must be worth this many times the burns it costs to reach. */
  greed: number;
  /** Seconds between decisions. */
  think: number;
  /** Seconds the bot is willing to spend on an intercept. */
  horizon: number;
}

export const defaultStyle: BotStyle = { sense: 520, fear: 140, greed: 1.8, think: 0.55, horizon: 3 };

/** What a bot remembers between decisions: the body it's committed to and what it has paid so far. */
export interface Memory {
  target: number;
  spent: number;
}
export type Memories = Map<number, Memory>;

/** Mass spent on `n` full burns from `mass` (agility included). */
export function burnCost(mass: number, n: number, cfg: Config): number {
  let m = mass;
  for (let i = 0; i < n; i++) m -= m * cfg.burnFraction * Math.min(cfg.agilityMax, Math.max(cfg.agilityMin, Math.sqrt(cfg.startMass / Math.max(0.01, m))));
  return mass - m;
}

export function decide(s: State, id: number, cfg: Config, style: BotStyle = defaultStyle, mem: Memories = new Map()): Intent | null {
  const b = byId(s, id);
  if (!b || !b.alive || b.cooldown > 0) return null;
  const myR = radiusOf(b.mass, cfg);

  // Escape: look a few seconds down our free-fall path. If it grazes anything heavier, burn
  // prograde with a little outward, which is the cheap way to raise an orbit. Heavier lights that
  // aren't wells can't pull us, so for those only a close, closing approach counts.
  const path = predict(s, b, cfg, style.horizon);
  let worst: { gap: number; body: Body; dx: number; dy: number } | null = null;
  for (const o of s.bodies) {
    if (o === b || !o.alive || o.mass <= b.mass) continue;
    const oR = radiusOf(o.mass, cfg);
    const [dx, dy] = delta(b.x, b.y, o.x, o.y, cfg);
    const gapNow = Math.hypot(dx, dy) - oR - myR;
    let gap = gapNow;
    if (o.mass >= cfg.gravityMass) {
      for (let i = 0; i < path.length; i++) {
        const p = path[i]!;
        const [px, py] = delta(p.x, p.y, o.x, o.y, cfg);
        const g = Math.hypot(px, py) - oR - myR;
        if (g < gap) gap = g;
      }
    } else {
      const rvx = o.vx - b.vx;
      const rvy = o.vy - b.vy;
      const closing = -(rvx * dx + rvy * dy) / (Math.hypot(dx, dy) || 1);
      if (closing <= 0 || gapNow > style.fear) continue;
    }
    if (gap < style.fear * 0.35 && (!worst || gap < worst.gap)) worst = { gap, body: o, dx, dy };
  }
  if (worst) {
    const { dx, dy, body: o } = worst;
    const len = Math.hypot(dx, dy) || 1;
    const rvx = b.vx - o.vx;
    const rvy = b.vy - o.vy;
    const cross = rvx * dy - rvy * dx;
    const side = cross >= 0 ? 1 : -1;
    const ox = -dx / len;
    const oy = -dy / len;
    const tx = -oy * side;
    const ty = ox * side;
    return { dx: ox * 0.5 + tx * 0.85, dy: oy * 0.5 + ty * 0.85, strength: 1 };
  }

  // Chase: predict both paths under gravity and aim at the point of closest approach. Commit to a
  // target until it's eaten or it has cost more than it's worth, so mass isn't dribbled away on
  // second thoughts.
  const dv = burnDeltaV(b.mass, 1, cfg);
  const m = mem.get(id);
  const committed = m ? byId(s, m.target) : undefined;
  const stillWorth = committed && committed.alive && committed.mass < b.mass && m!.spent < committed.mass / style.greed;
  const candidates = stillWorth ? [committed!] : s.bodies;
  let best: { gain: number; dx: number; dy: number; n: number; id: number } | null = null;
  for (const o of candidates) {
    if (o === b || !o.alive || o.mass >= b.mass || o.anchored || o.from) continue;
    const [dx0, dy0] = delta(b.x, b.y, o.x, o.y, cfg);
    const d0 = Math.hypot(dx0, dy0);
    if (d0 > style.sense) continue;
    const reach = myR + radiusOf(o.mass, cfg);
    const q = predict(s, o, cfg, style.horizon);
    let miss = Infinity;
    let at = 0;
    let mx = 0;
    let my = 0;
    for (let i = 0; i < path.length && i < q.length; i++) {
      const [px, py] = delta(path[i]!.x, path[i]!.y, q[i]!.x, q[i]!.y, cfg);
      const g = Math.hypot(px, py) - reach;
      if (g <= miss) {
        miss = g;
        at = (i + 1) * 0.1;
        mx = px;
        my = py;
      }
    }
    if (miss < 0) {
      // Free lunch: we're already going to hit it.
      if (!best || o.mass > best.gain) best = { gain: o.mass, dx: mx, dy: my, n: 0, id: o.id };
      continue;
    }
    const n = Math.ceil((miss + reach * 0.5) / Math.max(0.3, at) / dv);
    const cost = burnCost(b.mass, n, cfg);
    const gain = o.mass - cost * style.greed;
    if (gain <= 0) continue;
    if (!best || gain > best.gain) best = { gain, dx: mx, dy: my, n, id: o.id };
  }
  if (!best) {
    mem.delete(id);
    return null;
  }
  if (!m || m.target !== best.id) mem.set(id, { target: best.id, spent: 0 });
  if (best.n === 0) return null;
  const strength = Math.min(1, best.n / 3);
  mem.get(id)!.spent += b.mass * cfg.burnFraction * Math.max(0.15, strength);
  return { dx: best.dx, dy: best.dy, strength };
}

/** Bots think on their own clocks so a hundred lights don't all burn on the same frame. */
export function botTurn(s: State, cfg: Config, dt: number, style: BotStyle = defaultStyle, mem: Memories = new Map()): Array<{ id: number } & Intent> {
  const out: Array<{ id: number } & Intent> = [];
  for (const b of s.bodies) {
    if (b.kind !== "light" || !b.ai || !b.alive) continue;
    const phase = (b.id * 0.137) % style.think;
    const before = Math.floor((s.time - dt - phase) / style.think);
    const after = Math.floor((s.time - phase) / style.think);
    if (after === before) continue;
    const it = decide(s, b.id, cfg, style, mem);
    if (it) out.push({ id: b.id, ...it });
  }
  return out;
}
