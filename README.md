# LUMEN

Tap an orb. Your light jumps to it and absorbs it. Every collection pulls the rest of the
universe toward that point, including the things that can eat you. Touching lights fuse.
Travelling costs light, and the universe runs out of it. The bigger light absorbs the smaller.

```bash
bun install
bun run dev        # http://localhost:3000, hot reload
bun test           # simulation rules
bun run typecheck
bun run build      # static bundle in dist/
```

## Layout

- `src/sim/` — pure, headless game rules. No DOM. `step(state, tapId, cfg)` returns a new state
  plus an ordered list of events (collect, fuse, swallow, separate, spawn, blackout).
- `src/web/` — presentation. Canvas2D debug view with a tuning panel (`T` toggles it, `R` new board).
  Springs and particles live here; the sim never knows about them.
- `index.ts` — Bun dev server.

## Rules (current)

| Orb   | Value | Fuses into |
| ----- | ----- | ---------- |
| spark | +1    | ember      |
| ember | +3    | star       |
| star  | +10   | **void**   |

- **The bigger light absorbs the smaller.** Anything with a larger radius than yours eats you on
  contact, whether you tap it or gravity drags it onto you. Once you outgrow it, it is food.
  A fresh player (10 light, r≈19) is smaller than a star (r20) and a void (r26).
- Same kind touching → fuse. Different kinds → nudged apart.
- A void pulls every turn, swallows what it touches, banks that light, and grows by area
  (`voidAppetite`). Two voids merge. Eat a void and you claim everything it banked.
- **Light is fuel and score.** You start holding 10. A tap costs `travelCost × dist/100 × radius/base`
  lumens, so a bigger light is heavier to move. Below zero you fade. Total light ever gathered is the score.
- Player radius = base + growth × √(light held). Anything overlapping the player is absorbed for free.
- **The universe is finite.** Spawns fade linearly from `spawnPerTurn` to zero at `spawnFade` taps.
  An empty field ends the run ("dark").

## Why those rules

Headless bot runs (`bun scripts/bots.ts`) showed:

- Gravity + fusion alone is nearly unlosable: a greedy bot survived 300 taps in 90% of runs.
- Travel cost makes every tap a decision and kills sloppy play, but careful play stays net positive forever.
- Fading spawns give every run an ending, but only a timer, not a loss.
- Bigger-absorbs-smaller is what makes it losable. With defaults: random taps die in ~4; always tapping
  the biggest orb dies in ~6 (absorbed 70%); nearest-orb play is absorbed in 44% of runs; a one-tap
  lookahead survives 85% and scores ~127. Depth-2 and depth-3 lookahead survive 91% and 98%, so most
  traps are one move deep and the rest reward thinking ahead.

`bun scripts/grade.ts [seeds]` grades fixed boards (spawning off) as levels: solvable, trap depth
(lookahead needed to survive), safe-tap fraction along the winning line, and score.

Fusing before collecting is worth more than collecting (two sparks = 2, one ember = 3) and pulled-in
orbs cost no travel, so skilled play is engineering fusions and chain pulls, not just hopping to the nearest orb.

## Attraction rule

`pull = min(strength × mass / (1 + dist / falloff), maxTravel, dist)` toward the collection point,
plus `drift × last displacement` as momentum. Voids add their own pull. All three constants are
sliders in the panel; config persists in localStorage and "copy config" dumps it as JSON.

## Roadmap

1. ✅ Headless sim + tests.
2. ✅ Canvas2D debug view with sliders and hover preview. **Tune here until tapping is irresistible.**
3. WebGL renderer: bloom (half-res blur), fresnel rim, parallax starfield, radial distortion near voids.
4. Web Audio: rising pitch on chains, low thump on fusion.
