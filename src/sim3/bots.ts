/**
 * Scripted lights. Three instincts, checked in order: escape anything heavier that is pulling you
 * in, chase a lighter body when its mass beats the burns it will take to reach it, otherwise coast
 * and let gravity do the work. Every burn is paid in mass, so the price is always computed first.
 */
import { byId, delta, plan, predict, radiusOf, setGoal, type Body, type Config, type State, type Trait } from "./index";

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
  /** Only hunt a rival lighter than mass ÷ margin. */
  margin: number;
  /** Whether it hunts lights at all. */
  huntsLights: boolean;
  /** No hunting lights before this many seconds: everyone gets an opening. */
  huntAfter: number;
}

export const defaultStyle: BotStyle = { sense: 520, fear: 140, greed: 1.8, think: 0.55, horizon: 5, margin: 1.4, huntsLights: true, huntAfter: 25 };

/** Temperaments. A hunter takes close fights; a grazer never hunts lights; a coward keeps its distance. */
export const STYLES: Record<Trait, BotStyle> = {
  rival: defaultStyle,
  hunter: { ...defaultStyle, sense: 640, fear: 110, greed: 1.4, margin: 1.3, huntAfter: 15 },
  grazer: { ...defaultStyle, greed: 1.6, fear: 170, huntsLights: false },
  coward: { ...defaultStyle, fear: 260, greed: 2.0, margin: 2.5 },
};
export const styleOf = (b: Body): BotStyle => STYLES[b.trait] ?? defaultStyle;

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

/**
 * Decide for one light. Escapes come back as a direct burn; chases are handed to the autopilot via
 * setGoal and return null.
 */
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
    setGoal(s, id, null);
    mem.delete(id);
    return { dx: ox * 0.5 + tx * 0.85, dy: oy * 0.5 + ty * 0.85, strength: 1 };
  }

  // Chase: rehearse a trip to each lighter body in range with the shared autopilot and keep the
  // best mass gained after paying for it. Commit until it's eaten or has cost more than it's worth.
  const m = mem.get(id);
  if (b.goal && b.goal.follow) {
    const t = byId(s, b.goal.follow);
    if (t && t.alive && t.mass < b.mass && m && b.spent < t.mass / style.greed) {
      // Still worth it, unless the route now runs through something heavier.
      const again = plan(s, b, b.goal, cfg, style.horizon, 0.2);
      if (!again.blocked) return null;
    }
    setGoal(s, id, null);
  }
  let best: { gain: number; id: number } | null = null;
  for (const o of s.bodies) {
    if (o === b || !o.alive || o.mass >= b.mass || o.anchored || o.from) continue;
    // Hunting a rival is only worth it with a clear margin: a close race is lost on burn cost.
    if (o.kind === "light" && (!style.huntsLights || s.time < style.huntAfter || o.mass > b.mass / style.margin)) continue;
    const [dx0, dy0] = delta(b.x, b.y, o.x, o.y, cfg);
    if (Math.hypot(dx0, dy0) > style.sense) continue;
    const p = plan(s, b, { x: o.x, y: o.y, follow: o.id }, cfg, style.horizon, 0.2);
    if (!p.arrives || p.blocked) continue;
    const gain = o.mass - p.cost * style.greed;
    if (gain <= 0) continue;
    if (!best || gain > best.gain) best = { gain, id: o.id };
  }
  if (!best) {
    mem.delete(id);
    return null;
  }
  mem.set(id, { target: best.id, spent: 0 });
  setGoal(s, id, { x: 0, y: 0, follow: best.id });
  return null;
}

/** Bots think on their own clocks so a hundred lights don't all burn on the same frame. */
export function botTurn(s: State, cfg: Config, dt: number, style: BotStyle = defaultStyle, mem: Memories = new Map()): Array<{ id: number } & Intent> {
  const out: Array<{ id: number } & Intent> = [];
  for (const b of s.bodies) {
    if (b.kind !== "light" || !b.ai || !b.alive) continue;
    const mine = style === defaultStyle ? styleOf(b) : style;
    const phase = (b.id * 0.137) % mine.think;
    const before = Math.floor((s.time - dt - phase) / mine.think);
    const after = Math.floor((s.time - phase) / mine.think);
    if (after === before) continue;
    const it = decide(s, b.id, cfg, mine, mem);
    if (it) out.push({ id: b.id, ...it });
  }
  return out;
}
