import { round } from "./ai";
import { human, newGame, reach } from "./board";
import { allTargets, canEat, edibleTargets } from "./step";
import { lumens, type GameState, type Player, type SimConfig } from "./types";

/** What a player can see from where they stand at the start. */
export interface Neighbourhood {
  /** Lumens of food within reach. */
  food: number;
  /** Edible orbs within reach. */
  count: number;
  /** Anything that outweighs this player within reach plus a pull's margin. */
  threats: number;
}

export function neighbourhood(state: GameState, p: Player, cfg: SimConfig): Neighbourhood {
  const edible = edibleTargets(state, p.id, cfg);
  const margin = reach(p, cfg) + 70;
  let threats = 0;
  for (const o of state.orbs) {
    if (canEat(p, o)) continue;
    if (Math.hypot(o.x - p.x, o.y - p.y) - o.radius <= margin) threats++;
  }
  return { food: edible.reduce((a, o) => a + lumens(o), 0), count: edible.length, threats };
}

export interface FairnessReport {
  fair: boolean;
  reasons: string[];
  you: Neighbourhood;
  rivals: Neighbourhood[];
}

/**
 * A fair start: you have real food in reach, nothing that can eat you is close enough to be pulled
 * onto you early, no opponent starts with a clearly richer neighbourhood, and a cautious line
 * survives the opening rounds against the actual opponents.
 */
export function judge(state: GameState, cfg: SimConfig, openingRounds = 4): FairnessReport {
  const me = human(state);
  const you = neighbourhood(state, me, cfg);
  const rivals = state.players.filter((p) => p.ai).map((p) => neighbourhood(state, p, cfg));
  const reasons: string[] = [];
  if (you.count < 3) reasons.push("too little in reach");
  if (you.food < 2.5) reasons.push("not enough food in reach");
  if (you.threats > 0) reasons.push("something that outweighs you is too close");
  for (const [i, r] of rivals.entries()) {
    if (r.food > you.food * 1.5 + 1) reasons.push(`opponent ${i + 1} starts richer`);
  }
  if (reasons.length === 0 && !survivesOpening(state, cfg, openingRounds)) reasons.push("no safe opening line");
  return { fair: reasons.length === 0, reasons, you, rivals };
}

/** Can a one-round-lookahead player avoid death for `rounds` rounds? */
function survivesOpening(start: GameState, cfg: SimConfig, rounds: number): boolean {
  let s = start;
  for (let i = 0; i < rounds && s.status === "playing"; i++) {
    let bestId = -1;
    let best = -Infinity;
    for (const t of allTargets(s, human(s).id, cfg)) {
      const r = round(s, t.id, cfg);
      const dies = r.events.some((e) => (e.type === "blackout" && e.reason !== "dark") || e.type === "draw");
      if (dies) continue;
      const v = human(r.state).light - human(s).light;
      if (v > best) {
        best = v;
        bestId = t.id;
      }
    }
    if (bestId < 0) return false;
    s = round(s, bestId, cfg).state;
  }
  return true;
}

/**
 * Generate a board from `seed`, rerolling to the next seed until it is fair. Deterministic: the same
 * seed always lands on the same board. Returns the board and the seed actually used.
 */
export function newFairGame(seed: number, cfg: SimConfig, attempts = 30): { state: GameState; seed: number; tries: number; report: FairnessReport } {
  let s = seed >>> 0;
  let last: { state: GameState; seed: number; tries: number; report: FairnessReport } | null = null;
  for (let i = 0; i < attempts; i++) {
    const state = newGame(s, cfg);
    const report = judge(state, cfg);
    last = { state, seed: s, tries: i + 1, report };
    if (report.fair) return last;
    s = (s + 0x9e3779b1) >>> 0;
  }
  return last!;
}
