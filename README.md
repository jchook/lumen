# LUMEN

Tap an orb. Your light jumps to it and absorbs it. Every collection pulls the rest of the
universe toward that point, including the things that can eat you. Touching lights fuse.
Travelling costs light, and the universe runs out of it. The bigger light absorbs the smaller.
Opponents move when you move, and whoever is faster gets there first.

```bash
bun install
bun run dev        # http://localhost:3000, hot reload
bun test           # simulation rules
bun run typecheck
bun run build      # static bundle in dist/
```

## v2: gravitational influence (`src/sim2/`)

A rethink of the core after the v1 rules proved shallow (a one-step greedy bot was near optimal).
Two lights, alternating turns, full information, no randomness after setup. A tap jumps you to an orb
within reach and absorbs it; the landing is an impulse and the field keeps its momentum, so every
move plays out over many turns. Wells that overlap siphon lumens from the smaller light to the
larger. Big lights pull harder but jump shorter and pay more. The board is mirror-symmetric and the
light is finite; more lumens when it is gone wins. `search()` is alpha-beta negamax over plies.

`bun run depth` measures whether thinking further ahead keeps winning:

| matchup            | deeper wins |
| ------------------ | ----------- |
| depth 1 vs 2       | 67%         |
| depth 2 vs 3       | 63%         |
| depth 3 vs 4       | 71%         |
| depth 4 vs 5       | 56% (16 games) |
| depth 1 vs 4       | 75%         |

Leader at ply 12 wins 83% (depth-3 self-play). First mover wins 42%. In 87% of positions the top two
moves are within 3 lumens of each other. No renderer yet.

## Layout

- `src/sim/` — pure, headless game rules. No DOM. `step(state, tapId, cfg)` returns a new state
  plus an ordered list of events (collect, fuse, swallow, separate, spawn, blackout).
- `src/web/` — presentation. Canvas2D debug view with a tuning panel (`T` toggles it, `R` new board).
  Springs and particles live here; the sim never knows about them.
- `index.ts` — Bun dev server.

## Rules (current)

| Orb   | Worth | Fuses into | Notes                                   |
| ----- | ----- | ---------- | --------------------------------------- |
| mote  | +0.5  | spark      | plentiful, cheap stepping stones        |
| spark | +1    | ember      |                                         |
| ember | +3    | star       | shows its number                        |
| star  | +10   | **void**   | bigger than a young light: it eats you  |
| void  | 20+   | —          | swallows, grows, merges; eat it to cash |
| gust  | +0    | —          | +speed                                  |

- **One verb.** Tap an orb within reach. You jump there and absorb it. Every collection pulls the
  whole board toward that point, other players included. Heavy orbs move less (inertia).
- **Lumens decide who absorbs whom.** Every orb is worth lumens (a void carries the two stars that made
  it plus everything it swallowed) and every light holds lumens. On contact, more lumens absorbs fewer.
  An orb worth up to your lumens is food; one worth more eats you. Tap an opponent you outweigh
  (within reach) to hunt them: if they hop away first you land on empty space, otherwise contact
  decides. Opponents hunt you the same way. Equal lumens meeting you is a draw.
  Whether you can take an orb is decided as you leave; the trip can still fade you.
- **Light is fuel, score and size.** Travel costs light by distance and radius. Below zero you fade.
  Radius grows with light held. Everyone starts tiny (3 light) and on equal footing.
- **Speed and reach.** Effective speed = gust boosts × √(base / radius). Reach = `maxJump` × speed.
  Small fast lights are nimble; big ones lumber.
- **Simultaneous rounds.** Everyone picks a target from the same board. Arrivals resolve by distance ÷
  speed. First to an orb takes it; anyone else arrives late, pays the trip, and pulls up short of
  whoever is standing there.
- **The universe is finite.** Spawns fade to zero by `spawnFade` rounds. Stranded with nothing edible
  in reach is "dark". Absorb every opponent to win.

## Reading the board

Hovering an orb shows where your own tap would leave everything: dashed ghosts, lines for what
moves, a red ring on anything that would land on you, and the net lumens "if they hold". This is on
by default because the gravity rule is not something a person can simulate in their head, and the
game is about consequences, not guesswork. The opponent's reply stays hidden; "+ opponent reply" in
the tuning panel reveals it and is a cheat.

With that preview, a bot that sees only what you see wins 97% of level-1 games and 23% of level-10
games (`scratchpad/honest.ts` in the session; policy: one-step self-simulation, avoid landing dead,
keep clear of anything heavier).

## Fair starts

Roughly a third of raw boards are unwinnable from the first tap: a star within one pull of you, no
food in reach, or an opponent with a richer neighbourhood. `newFairGame` judges each board (food in
reach, no early threats, neighbourhood parity, and a cautious line that survives the opening rounds
against the real opponents) and rerolls the seed deterministically until one passes. The log says
when a start was rerolled and why.

## Difficulty ladder

Ten levels, persisted in the browser. Early levels: one dim opponent that never hunts and starts
with fewer lumens than you. Later: equal footing, then sharper opponents, then more of them. Win to
advance, lose to retry. `[` and `]` jump levels; untick "ladder" in the tuning panel for free play
with the opponent sliders. Opponent skill (`aiSkill`) controls hunting, danger judgement, dithering,
and deterministic sloppiness.

## Why those rules

Headless bot runs (`bun run bots`) drove each change:

- Gravity + fusion alone was nearly unlosable. Travel cost made taps decisions but never ended a run.
  Fading spawns gave an ending. Bigger-absorbs-smaller made it losable.
- Tappable opponents made every game a 2-round coin flip: whoever was one light bigger jumped on the
  other. Contact-only absorption, reach limits, an eat margin, and simultaneous arrival fixed that.
- With defaults and one opponent: random play dies in ~4 rounds; a one-round-lookahead bot wins ~75%
  in ~5 rounds, but it can see the opponent's move (the preview cheat), so humans will be slower.

`bun run grade [seeds]` grades fixed boards (spawning off) as levels: solvable, trap depth
(lookahead needed to survive), safe-tap fraction along the winning line, and score.

## Roadmap

1. ✅ Headless sim + tests.
2. ✅ Canvas2D debug view with sliders and hover preview. **Tune here until tapping is irresistible.**
3. WebGL renderer: bloom (half-res blur), fresnel rim, parallax starfield, radial distortion near voids.
4. Web Audio: rising pitch on chains, low thump on fusion.
