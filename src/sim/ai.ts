import { alivePlayers, cloneState, effectiveSpeed, human, playerById, reach } from "./board";
import { arrive, beginRound, canEat, edibleTargets, endRound, inRange, settle, type Intent } from "./step";
import { GUST, type GameState, type RoundResult, type SimConfig, type SimEvent } from "./types";

const gap = (a: { x: number; y: number; radius: number }, b: { x: number; y: number; radius: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y) - a.radius - b.radius;

/** Time for `p` to reach (x, y). Lower arrives first. */
function eta(p: { x: number; y: number; radius: number; speed: number }, t: { x: number; y: number }, cfg: SimConfig): number {
  return Math.hypot(t.x - p.x, t.y - p.y) / effectiveSpeed(p, cfg);
}

/**
 * A computer opponent's tap, decided from the same board everyone else sees. One-step lookahead
 * over every orb it could survive landing on: maximise net light, discount orbs someone else
 * would reach first, close in on anyone smaller, and keep anyone bigger out of striking range.
 * Deterministic: ties break on the lowest target id. Returns null when it has no safe move.
 */
export function chooseTarget(state: GameState, actorId: number, cfg: SimConfig): number | null {
  const actor = playerById(state, actorId);
  if (!actor || !actor.alive) return null;
  const others = alivePlayers(state).filter((p) => p !== actor);
  const preyBefore = others.filter((p) => canEat(actor, p));
  const nearestPreyGap = preyBefore.length ? Math.min(...preyBefore.map((p) => gap(actor, p))) : null;
  let bestId: number | null = null;
  let best = -Infinity;
  for (const t of edibleTargets(state, actorId, cfg)) {
    const trial = cloneState(state);
    const ev: SimEvent[] = [];
    arrive(trial, { actor: actorId, orbId: t.id, x: t.x, y: t.y }, cfg, ev);
    settle(trial, cfg, ev);
    const me = playerById(trial, actorId)!;
    if (!me.alive) continue;
    let v = me.light - actor.light;
    if (t.kind === GUST) v += cfg.gustBoost * 8;
    for (const e of ev) if (e.type === "eat" && e.predator.id === actorId) v += 60;
    // Contest: if someone who can eat this orb would get there first, it's probably not ours.
    const myEta = eta(actor, t, cfg);
    for (const p of others) {
      if (canEat(p, t) && inRange(p, t, cfg) && eta(p, t, cfg) < myEta) {
        v = Math.min(v, 0) - 0.5;
        break;
      }
    }
    // Hunt: reward closing the gap to the nearest smaller player.
    if (nearestPreyGap !== null) {
      const prey = alivePlayers(trial).filter((p) => p !== me && canEat(me, p));
      if (prey.length) v += 0.04 * (nearestPreyGap - Math.min(...prey.map((p) => gap(me, p))));
    }
    // Danger: anything bigger than me that could reach me next move.
    for (const p of alivePlayers(trial)) {
      if (p === me || !canEat(p, me)) continue;
      const d = gap(p, me);
      const strike = reach(p, cfg) + 30;
      if (d < strike) v -= 80 * (1 - d / strike);
    }
    if (v > best || (v === best && bestId !== null && t.id < bestId)) {
      best = v;
      bestId = t.id;
    }
  }
  return bestId;
}

/**
 * A full round. Everyone picks a target from the same board, then arrivals resolve in order of
 * distance ÷ speed. First to an orb takes it; anyone else arrives to an empty spot having paid the
 * trip. Ties go to the bigger light. The last turn entry (actor 0) is the universe: spawns, endings.
 */
export function round(prev: GameState, targetId: number, cfg: SimConfig): RoundResult {
  const me = human(prev);
  const orb = prev.orbs.find((o) => o.id === targetId);
  if (prev.status !== "playing" || !me.alive || !orb || !inRange(me, orb, cfg)) return { state: prev, turns: [], events: [] };

  const intents: Array<Intent & { eta: number; light: number }> = [
    { actor: me.id, orbId: orb.id, x: orb.x, y: orb.y, eta: eta(me, orb, cfg), light: me.light },
  ];
  for (const p of prev.players) {
    if (!p.ai || !p.alive) continue;
    const id = chooseTarget(prev, p.id, cfg);
    if (id === null) continue;
    const o = prev.orbs.find((x) => x.id === id)!;
    intents.push({ actor: p.id, orbId: o.id, x: o.x, y: o.y, eta: eta(p, o, cfg), light: p.light });
  }
  intents.sort((a, b) => a.eta - b.eta || b.light - a.light || b.actor - a.actor);

  const state = cloneState(prev);
  state.turn += 1;
  beginRound(state, cfg);
  const turns: RoundResult["turns"] = [];
  for (const intent of intents) {
    if (state.status !== "playing") break;
    const events: SimEvent[] = [];
    arrive(state, intent, cfg, events);
    settle(state, cfg, events);
    turns.push({ actor: intent.actor, events });
  }
  const tail: SimEvent[] = [];
  endRound(state, cfg, tail);
  if (tail.length) turns.push({ actor: 0, events: tail });
  return { state, turns, events: turns.flatMap((t) => t.events) };
}
