import { nextRandom } from "./rng";
import { ORB, type GameState, type Orb, type OrbKind, type SimConfig } from "./types";

/** Spawn weights for new orbs. */
const KIND_WEIGHTS: ReadonlyArray<[OrbKind, number]> = [
  [1, 0.7],
  [2, 0.25],
  [3, 0.05],
];

export function rollKind(state: { rng: number }): OrbKind {
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

/** Spawn rate at a given turn: fades linearly from spawnPerTurn to zero at spawnFade taps. */
export function spawnRate(turn: number, cfg: SimConfig): number {
  if (cfg.spawnFade <= 0) return cfg.spawnPerTurn;
  return cfg.spawnPerTurn * Math.max(0, 1 - turn / cfg.spawnFade);
}

export function makeOrb(state: GameState, x: number, y: number, kind: OrbKind): Orb {
  return { id: state.nextId++, x, y, kind, radius: ORB[kind].radius, dx: 0, dy: 0, swallowed: 0, stored: 0 };
}

/** A void that has eaten `prey` grows by area. */
export function grownRadius(radius: number, preyRadius: number, cfg: SimConfig): number {
  return Math.sqrt(radius * radius + cfg.voidAppetite * preyRadius * preyRadius);
}

/**
 * Find a spot for a new orb that isn't crowding the player or other orbs.
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
  const minFromPlayer = state.player.radius + 110;
  for (let i = 0; i < attempts; i++) {
    const x = margin + nextRandom(state) * (cfg.width - 2 * margin);
    const y = margin + nextRandom(state) * (cfg.height - 2 * margin);
    if (Math.hypot(x - state.player.x, y - state.player.y) < minFromPlayer) continue;
    let ok = true;
    for (const o of state.orbs) {
      if (Math.hypot(x - o.x, y - o.y) < r + o.radius + 26) {
        ok = false;
        break;
      }
    }
    if (ok) return { x, y };
  }
  return null;
}

export function spawnOrb(state: GameState, cfg: SimConfig): Orb | null {
  const kind = rollKind(state);
  const spot = findSpawnSpot(state, kind, cfg);
  if (!spot) return null;
  const orb = makeOrb(state, spot.x, spot.y, kind);
  state.orbs.push(orb);
  return orb;
}

export function newGame(seed: number, cfg: SimConfig): GameState {
  const state: GameState = {
    seed,
    rng: seed >>> 0,
    turn: 0,
    score: 0,
    light: cfg.startLight,
    status: "playing",
    spawnBank: 0,
    nextId: 1,
    player: { x: cfg.width / 2, y: cfg.height / 2, radius: playerRadius(cfg.startLight, cfg) },
    orbs: [],
  };
  for (let i = 0; i < cfg.initialOrbs; i++) spawnOrb(state, cfg);
  return state;
}

export function cloneState(s: GameState): GameState {
  return {
    ...s,
    player: { ...s.player },
    orbs: s.orbs.map((o) => ({ ...o })),
  };
}
