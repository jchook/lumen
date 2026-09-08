/**
 * Orb kinds. 0–3 are collectible light and fuse upward (mote → spark → ember → star);
 * 4 is a void created by fusing two stars; 5 is a gust, worth no light but a burst of speed.
 */
export type OrbKind = 0 | 1 | 2 | 3 | 4 | 5;

export const MOTE: OrbKind = 0;
export const SPARK: OrbKind = 1;
export const EMBER: OrbKind = 2;
export const STAR: OrbKind = 3;
export const VOID: OrbKind = 4;
export const GUST: OrbKind = 5;

export interface OrbStats {
  readonly name: string;
  /** Light gained when collected. */
  readonly value: number;
  /** Gravitational strength when this orb is collected (or, for voids, every round). */
  readonly mass: number;
  readonly radius: number;
}

export const ORB: Readonly<Record<OrbKind, OrbStats>> = {
  0: { name: "mote", value: 0.5, mass: 0.4, radius: 3.5 },
  1: { name: "spark", value: 1, mass: 1, radius: 6 },
  2: { name: "ember", value: 3, mass: 2.2, radius: 10 },
  3: { name: "star", value: 10, mass: 5, radius: 20 },
  4: { name: "void", value: 0, mass: 8, radius: 26 },
  5: { name: "gust", value: 0, mass: 0.6, radius: 7 },
};

/** Lumens an orb carries: its worth, plus whatever a void has banked. This decides who absorbs whom. */
export function lumens(o: { kind: OrbKind; stored: number }): number {
  return ORB[o.kind].value + o.stored;
}

export interface Orb {
  id: number;
  x: number;
  y: number;
  kind: OrbKind;
  /** Current radius. Fixed per kind except for voids, which grow with what they eat. */
  radius: number;
  /** Displacement received last round; a fraction carries forward as drift. */
  dx: number;
  dy: number;
  /** Voids only: orbs swallowed so far. */
  swallowed: number;
  /** Voids only: light banked, starting with the two stars that made it. Eat the void to claim it. */
  stored: number;
}

/**
 * A light on the board that makes moves: the human (always players[0]) or a computer opponent.
 * Player ids are negative so they never collide with orb ids.
 */
export interface Player {
  id: number;
  name: string;
  ai: boolean;
  alive: boolean;
  x: number;
  y: number;
  radius: number;
  /** Light held: fuel for travel and the basis for radius. Below zero you fade. */
  light: number;
  /** Total light ever gathered. The run's score. */
  score: number;
  /** Speed multiplier from gusts. Effective speed also falls with size. */
  speed: number;
}

export type Status = "playing" | "over" | "won" | "draw";

export interface GameState {
  seed: number;
  /** Mutable PRNG state; advanced by the sim. */
  rng: number;
  /** Rounds played. Everyone moves once per round, simultaneously. */
  turn: number;
  status: Status;
  /** Fractional spawns carried between rounds so a fading spawn rate stays smooth and deterministic. */
  spawnBank: number;
  nextId: number;
  /** players[0] is the human. */
  players: Player[];
  orbs: Orb[];
}

export interface SimConfig {
  width: number;
  height: number;
  /** Base displacement (px) an orb of mass 1 receives at distance 0. */
  strength: number;
  /** Distance (px) at which pull has halved. */
  falloff: number;
  /** Hard cap on displacement from a single pull (px). */
  maxTravel: number;
  /** Fraction of last round's displacement carried into this round (0–1). */
  drift: number;
  /** Heavy orbs move less: displacement × mass^-inertia. 0 = everything moves alike. */
  inertia: number;
  /** Extra mass the player's own growth contributes, per 10px of radius gained. */
  playerPull: number;
  /** Strength of a void's pull every round, as a multiplier on `strength`. */
  voidPull: number;
  /** Orbs spawned per round at the start of a run. */
  spawnPerTurn: number;
  /** Rounds until the universe stops spawning; the rate fades linearly. 0 = never fades. */
  spawnFade: number;
  initialOrbs: number;
  /** Chance a spawned orb is a gust. */
  gustChance: number;
  /** Speed added by each gust. */
  gustBoost: number;
  playerBaseRadius: number;
  /** Player radius = base + growth * sqrt(light). */
  playerGrowth: number;
  /** Light every player starts a run holding. Opponents start on equal footing. */
  startLight: number;
  /** Lumens spent per 100px travelled at base radius. Scales linearly with radius / base. */
  travelCost: number;
  /** How much a void grows per meal: new area = area + appetite × prey area. */
  voidAppetite: number;
  /** Number of computer opponents. Absorb them all to win. */
  opponents: number;
  /** How strongly collections drag other players, relative to orbs (0–1). */
  playerDrag: number;
  /** Reach of a jump at base size and speed 1 (px); actual reach scales with effective speed. 0 = unlimited. */
  maxJump: number;
}

export const defaultConfig: SimConfig = {
  width: 800,
  height: 800,
  strength: 90,
  falloff: 220,
  maxTravel: 150,
  drift: 0.35,
  inertia: 0.5,
  playerPull: 0.5,
  voidPull: 0.6,
  spawnPerTurn: 3,
  spawnFade: 60,
  initialOrbs: 28,
  gustChance: 0.08,
  gustBoost: 0.25,
  playerBaseRadius: 10,
  playerGrowth: 1.5,
  startLight: 3,
  travelCost: 1,
  voidAppetite: 2,
  opponents: 1,
  playerDrag: 0.5,
  maxJump: 240,
};

export type EndReason = "absorbed" | "eaten" | "faded" | "dark";

export type SimEvent =
  | { type: "travel"; actor: number; dist: number; cost: number }
  | { type: "collect"; actor: number; orb: Orb; by: "tap" | "overlap"; value: number }
  /** Arrived to find the orb already taken. Travel was still paid. */
  | { type: "miss"; actor: number; orbId: number; at: { x: number; y: number } }
  /** A gust: speed went up. */
  | { type: "boost"; actor: number; speed: number }
  | { type: "fuse"; a: Orb; b: Orb; result: Orb }
  | { type: "swallow"; void_: Orb; orb: Orb }
  | { type: "merge"; a: Orb; b: Orb; result: Orb }
  | { type: "separate"; a: Orb; b: Orb }
  | { type: "spawn"; orb: Orb }
  /** A player absorbed another player and took all their light. */
  | { type: "eat"; predator: Player; prey: Player; value: number }
  /** Two equal lights met. If one is the human, the game is a draw. */
  | { type: "draw"; a: Player; b: Player }
  /** A player left the board. `by` / `byPlayer` name what absorbed them, when that is the reason. */
  | { type: "eliminate"; player: Player; reason: EndReason; by?: Orb; byPlayer?: Player }
  /** The human's run ended. */
  | { type: "blackout"; reason: EndReason; by?: Orb; byPlayer?: Player; at: { x: number; y: number } }
  /** Every opponent has been absorbed. */
  | { type: "win" };

export interface StepResult {
  state: GameState;
  events: SimEvent[];
}

/** What each player did this round, in arrival order; the last entry (actor 0) is the universe: spawns, endings. */
export interface RoundResult {
  state: GameState;
  turns: Array<{ actor: number; events: SimEvent[] }>;
  /** All events of the round, flattened in order. */
  events: SimEvent[];
}
