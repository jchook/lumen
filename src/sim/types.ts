/** Orb kinds. 1–3 are collectible light; 4 is a void created by fusing two stars. */
export type OrbKind = 1 | 2 | 3 | 4;

export const SPARK: OrbKind = 1;
export const EMBER: OrbKind = 2;
export const STAR: OrbKind = 3;
export const VOID: OrbKind = 4;

export interface OrbStats {
  readonly name: string;
  /** Light gained when collected. */
  readonly value: number;
  /** Gravitational strength when this orb is collected (or, for voids, every turn). */
  readonly mass: number;
  readonly radius: number;
}

export const ORB: Readonly<Record<OrbKind, OrbStats>> = {
  1: { name: "spark", value: 1, mass: 1, radius: 6 },
  2: { name: "ember", value: 3, mass: 2.2, radius: 10 },
  3: { name: "star", value: 10, mass: 5, radius: 20 },
  4: { name: "void", value: 0, mass: 8, radius: 26 },
};

export interface Orb {
  id: number;
  x: number;
  y: number;
  kind: OrbKind;
  /** Current radius. Fixed per kind except for voids, which grow with what they eat. */
  radius: number;
  /** Displacement applied last turn; carried forward as drift. */
  dx: number;
  dy: number;
  /** Voids only: orbs swallowed so far. */
  swallowed: number;
  /** Voids only: light banked from what it swallowed. Eat the void to claim it. */
  stored: number;
}

export interface Player {
  x: number;
  y: number;
  radius: number;
}

export type Status = "playing" | "over";

export interface GameState {
  seed: number;
  /** Mutable PRNG state; advanced by step(). */
  rng: number;
  turn: number;
  /** Total light ever collected. This is the run's score. */
  score: number;
  /** Light you currently hold. Fuel for travel and the basis for your radius. Run ends below zero. */
  light: number;
  status: Status;
  /** Fractional spawns carried between turns so a fading spawn rate stays smooth and deterministic. */
  spawnBank: number;
  nextId: number;
  player: Player;
  orbs: Orb[];
}

export interface SimConfig {
  width: number;
  height: number;
  /** Base displacement (px) an orb of mass 1 receives at distance 0. */
  strength: number;
  /** Distance (px) at which pull has halved. */
  falloff: number;
  /** Hard cap on displacement per turn (px). */
  maxTravel: number;
  /** Fraction of last turn's displacement carried into this turn (0–1). */
  drift: number;
  /** Extra mass the player's own growth contributes, per 10px of radius gained. */
  playerPull: number;
  /** Strength of a void's pull every turn, as a multiplier on `strength`. */
  voidPull: number;
  /** Orbs spawned per tap at the start of a run. */
  spawnPerTurn: number;
  /** Taps until the universe stops spawning; the rate fades linearly. 0 = never fades. */
  spawnFade: number;
  initialOrbs: number;
  playerBaseRadius: number;
  /** Player radius = base + growth * sqrt(light). */
  playerGrowth: number;
  /** Light you start a run holding. */
  startLight: number;
  /** Lumens spent per 100px travelled at base radius. Scales linearly with radius / base. */
  travelCost: number;
  /** How much a void grows per meal: new area = area + appetite × prey area. */
  voidAppetite: number;
}

export const defaultConfig: SimConfig = {
  width: 800,
  height: 800,
  strength: 90,
  falloff: 220,
  maxTravel: 150,
  drift: 0.35,
  playerPull: 0.5,
  voidPull: 0.6,
  spawnPerTurn: 2,
  spawnFade: 60,
  initialOrbs: 14,
  playerBaseRadius: 14,
  playerGrowth: 1.5,
  startLight: 10,
  travelCost: 1,
  voidAppetite: 2,
};

export type SimEvent =
  | { type: "travel"; dist: number; cost: number }
  | { type: "collect"; orb: Orb; by: "tap" | "overlap"; value: number }
  | { type: "fuse"; a: Orb; b: Orb; result: Orb }
  | { type: "swallow"; void_: Orb; orb: Orb }
  | { type: "merge"; a: Orb; b: Orb; result: Orb }
  | { type: "separate"; a: Orb; b: Orb }
  | { type: "spawn"; orb: Orb }
  /** The run ended. `by` is the orb that absorbed the player, when that is the reason. */
  | { type: "blackout"; by?: Orb; reason: "absorbed" | "faded" | "dark"; at: { x: number; y: number } };

export interface StepResult {
  state: GameState;
  events: SimEvent[];
}
