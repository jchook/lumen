import { nextRandom } from "./rng";
import { GUST, ORB, STAR, VOID, type GameState, type Orb, type OrbKind, type Player, type SimConfig } from "./types";

/** Spawn weights for light orbs (gusts roll separately). */
const KIND_WEIGHTS: ReadonlyArray<[OrbKind, number]> = [
  [0, 0.5],
  [1, 0.3],
  [2, 0.18],
  [3, 0.02],
];

/** Heavy orbs are sluggish: a star barely budges, a mote zips. */
export function inertia(kind: OrbKind, cfg: SimConfig): number {
  return Math.min(1.3, Math.pow(ORB[kind].mass, -cfg.inertia));
}

export function rollKind(state: { rng: number }, cfg: SimConfig): OrbKind {
  if (nextRandom(state) < cfg.gustChance) return GUST;
  let r = nextRandom(state);
  for (const [kind, w] of KIND_WEIGHTS) {
    if (r < w) return kind;
    r -= w;
  }
  return 1;
}

export function playerRadius(light: number, cfg: SimConfig): number {
  return cfg.playerBaseRadius + cfg.playerGrowth * Math.sqrt(Math.max(0, light));
}

/** Lumens it costs to move `dist` px at the given radius. Bigger light is heavier to move. */
export function travelCost(dist: number, radius: number, cfg: SimConfig): number {
  return cfg.travelCost * (dist / 100) * (radius / cfg.playerBaseRadius);
}

/** How fast this light moves: gust boosts, damped by size. Only ratios matter (who arrives first). */
export function effectiveSpeed(p: { radius: number; speed: number }, cfg: SimConfig): number {
  return p.speed * Math.sqrt(cfg.playerBaseRadius / p.radius);
}

/** How far this player can jump right now. Fast, small lights are nimble; big ones lumber. */
export function reach(p: { radius: number; speed: number }, cfg: SimConfig): number {
  return cfg.maxJump <= 0 ? Infinity : cfg.maxJump * effectiveSpeed(p, cfg);
}

/** Spawn rate at a given round: fades linearly from spawnPerTurn to zero at spawnFade rounds. */
export function spawnRate(turn: number, cfg: SimConfig): number {
  if (cfg.spawnFade <= 0) return cfg.spawnPerTurn;
  return cfg.spawnPerTurn * Math.max(0, 1 - turn / cfg.spawnFade);
}

export function makeOrb(state: GameState, x: number, y: number, kind: OrbKind): Orb {
  // A void is two stars' worth of light folded into the dark.
  const stored = kind === VOID ? 2 * ORB[STAR].value : 0;
  return { id: state.nextId++, x, y, kind, radius: ORB[kind].radius, dx: 0, dy: 0, swallowed: 0, stored };
}

/** A void that has eaten `prey` grows by area. */
export function grownRadius(radius: number, preyRadius: number, cfg: SimConfig): number {
  return Math.sqrt(radius * radius + cfg.voidAppetite * preyRadius * preyRadius);
}

/** The human player. Always players[0]. */
export function human(state: GameState): Player {
  return state.players[0]!;
}

export function alivePlayers(state: GameState): Player[] {
  return state.players.filter((p) => p.alive);
}

export function playerById(state: GameState, id: number): Player | undefined {
  return state.players.find((p) => p.id === id);
}

/**
 * Find a spot for a new orb that isn't crowding any player or other orbs.
 * Returns null if the board is too full to place one.
 */
export function findSpawnSpot(
  state: GameState,
  kind: OrbKind,
  cfg: SimConfig,
  attempts = 40,
): { x: number; y: number } | null {
  const r = ORB[kind].radius;
  const margin = r + 8;
  const players = alivePlayers(state);
  for (let i = 0; i < attempts; i++) {
    const x = margin + nextRandom(state) * (cfg.width - 2 * margin);
    const y = margin + nextRandom(state) * (cfg.height - 2 * margin);
    let ok = true;
    for (const p of players) {
      if (Math.hypot(x - p.x, y - p.y) < p.radius + 60) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    for (const o of state.orbs) {
      if (Math.hypot(x - o.x, y - o.y) < r + o.radius + 18) {
        ok = false;
        break;
      }
    }
    if (ok) return { x, y };
  }
  return null;
}

export function spawnOrb(state: GameState, cfg: SimConfig): Orb | null {
  const kind = rollKind(state, cfg);
  const spot = findSpawnSpot(state, kind, cfg);
  if (!spot) return null;
  const orb = makeOrb(state, spot.x, spot.y, kind);
  state.orbs.push(orb);
  return orb;
}

function makePlayer(id: number, name: string, ai: boolean, x: number, y: number, cfg: SimConfig): Player {
  const light = ai && cfg.opponentLight > 0 ? cfg.opponentLight : cfg.startLight;
  return { id, name, ai, alive: true, x, y, radius: playerRadius(light, cfg), light, score: 0, speed: 1 };
}

const OPPONENT_NAMES = ["Umbra", "Nyx", "Erebus", "Sable", "Dusk", "Vesper", "Nocturne", "Shade"];

export function newGame(seed: number, cfg: SimConfig): GameState {
  const cx = cfg.width / 2;
  const cy = cfg.height / 2;
  const players: Player[] = [makePlayer(-1, "you", false, cx, cy, cfg)];
  // Opponents ring the human at equal angles, well out of reach on round one.
  const ring = 0.36 * Math.min(cfg.width, cfg.height);
  for (let i = 0; i < cfg.opponents; i++) {
    const a = -Math.PI / 2 + (i / Math.max(1, cfg.opponents)) * Math.PI * 2;
    const name = OPPONENT_NAMES[i % OPPONENT_NAMES.length]!;
    players.push(makePlayer(-2 - i, name, true, cx + Math.cos(a) * ring, cy + Math.sin(a) * ring, cfg));
  }
  const state: GameState = {
    seed,
    rng: seed >>> 0,
    turn: 0,
    status: "playing",
    spawnBank: 0,
    nextId: 1,
    players,
    orbs: [],
  };
  for (let i = 0; i < cfg.initialOrbs; i++) spawnOrb(state, cfg);
  return state;
}

export function cloneState(s: GameState): GameState {
  return {
    ...s,
    players: s.players.map((p) => ({ ...p })),
    orbs: s.orbs.map((o) => ({ ...o })),
  };
}
