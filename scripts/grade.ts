/**
 * Grade fixed boards by how much thought they demand.
 *
 *   bun scripts/grade.ts [seed ...]        default: seeds 1–20
 *
 * A "level" is a seed with spawning off, so the board is fully determined and the game tree is finite.
 * For each board we report:
 *   - solvable: some tap sequence survives until the field is cleared (or nothing edible remains).
 *   - trap depth: the smallest lookahead a light-greedy player needs to survive. 1 = every fatal tap is
 *     visibly fatal one move out; 3 = you have to think three taps ahead somewhere on the best line.
 *   - safe fraction: along the winning line, the share of available taps that don't lead to death within
 *     `trap depth` moves. Low = narrow path.
 *   - score: light gathered on that line.
 */
import { defaultConfig, edibleTargets, human, newGame, round, type GameState, type SimConfig } from "../src/sim";

const cfg: SimConfig = { ...defaultConfig, spawnPerTurn: 0, spawnFade: 0, initialOrbs: 16, opponents: Number(process.env.OPPONENTS ?? 1) };
const MAX_DEPTH = 4;
const DEAD = -1e9;

const edible = (s: GameState) => edibleTargets(s, human(s).id, cfg);
const isDeath = (r: ReturnType<typeof round>) =>
  r.state.status === "over" && r.events.some((e) => e.type === "blackout" && e.reason !== "dark");

/** Best achievable light delta within `depth` taps, or DEAD if every line dies. */
function value(s: GameState, depth: number): number {
  if (s.status !== "playing" || depth === 0) return 0;
  let best = DEAD;
  for (const o of edible(s)) {
    const r = round(s, o.id, cfg);
    if (isDeath(r)) continue;
    const v = human(r.state).light - human(s).light + value(r.state, depth - 1);
    if (v > best) best = v;
  }
  return best;
}

function playLine(seed: number, depth: number): { survived: boolean; score: number; safe: number; moves: number } {
  let s = newGame(seed, cfg);
  let safeSum = 0;
  let moves = 0;
  while (s.status === "playing") {
    if (s.status !== "playing") break;
    const options = edible(s);
    let bestId: number | null = null;
    let best = DEAD;
    let safe = 0;
    for (const o of options) {
      const r = round(s, o.id, cfg);
      const v = isDeath(r) ? DEAD : human(r.state).light - human(s).light + value(r.state, depth - 1);
      if (v > DEAD / 2) safe++;
      if (v > best) {
        best = v;
        bestId = o.id;
      }
    }
    if (bestId === null) return { survived: false, score: human(s).score, safe: safeSum / Math.max(1, moves), moves };
    safeSum += safe / options.length;
    moves++;
    const r = round(s, bestId, cfg);
    if (isDeath(r)) return { survived: false, score: human(r.state).score, safe: safeSum / moves, moves };
    s = r.state;
  }
  return { survived: true, score: human(s).score, safe: safeSum / Math.max(1, moves), moves };
}

const seeds = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n));
const list = seeds.length ? seeds : Array.from({ length: 20 }, (_, i) => i + 1);

console.log("seed   solvable  trap depth  safe taps  score  taps");
for (const seed of list) {
  let result: ReturnType<typeof playLine> | null = null;
  let depth = 0;
  for (let d = 1; d <= MAX_DEPTH; d++) {
    const r = playLine(seed, d);
    if (r.survived) {
      result = r;
      depth = d;
      break;
    }
    result = r;
  }
  const solvable = result!.survived;
  console.log(
    `${String(seed).padStart(4)}   ${solvable ? "yes" : "no "}       ${solvable ? String(depth).padStart(3) : ` >${MAX_DEPTH}`}        ${(result!.safe * 100).toFixed(0).padStart(3)}%    ${String(result!.score).padStart(4)}   ${String(result!.moves).padStart(3)}`,
  );
}
