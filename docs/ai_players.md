# AI Player Specification

## Overview

AI-controlled players run server-side as virtual clients. They generate the same `place`, `rotate`, `remove`, `aim` commands as human players. No special code paths in the game simulation — the AI is purely an input generator.

Single-player mode is a multiplayer game with one human and N AI players. No separate single-player code path.

## Lobby Integration

The room creation and lobby screens gain AI player controls:

- **"Add AI" button** in the lobby, visible to the room creator. Adds an AI player to the next available slot (max 4 total players, human + AI combined).
- **"Remove AI" button** per AI slot.
- Each AI slot shows a **personality selector** (dropdown or cycle button) with options: Random, Hoarder, Saboteur, Defensive, Aggressive.
- Each AI slot shows a **difficulty slider**: 1–5.
- Default: Random personality, difficulty 3.
- AI players are assigned player colors like humans (blue, red, green, yellow by slot order).
- AI players display a 🤖 icon next to their color in the player list.
- The "Start Game" button works as before. AI players are active immediately.

For quick solo play, a **"Quick Play"** button on the main menu creates a room with 3 random AI opponents at difficulty 3 and starts immediately. No lobby.

## AI Architecture

Each AI player is an object on the server with its own state and decision loop.

```
AIPlayer {
  slot: 0-3
  personality: 'hoarder' | 'saboteur' | 'defensive' | 'aggressive'
  difficulty: 1-5

  // Virtual cursor
  cursorR: number
  cursorC: number
  targetR: number
  targetC: number
  cursorMoving: boolean

  // Timing
  lastActionTime: number        // ms timestamp of last arrow placement
  actionCooldown: number        // ms, derived from difficulty
  thinkInterval: number         // ms between decision cycles

  // Current intent
  pendingCommand: null | {type, r, c, dir}
}
```

### Decision Loop

The AI runs a `think()` function on a fixed interval (`thinkInterval`, roughly every 1–3 ticks depending on difficulty). Each think cycle:

1. **Perceive**: Sample a subset of mice and cats from the game state.
2. **Evaluate**: Score potential actions based on personality weights.
3. **Decide**: Pick the highest-scoring action (or do nothing).
4. **Queue**: Set `pendingCommand` and `targetR/targetC` for the cursor.

The cursor then moves toward the target. When it arrives and `actionCooldown` has elapsed, the command is submitted to the game as a normal player input.

## Perception

The AI does **not** evaluate every mouse and cat every cycle. It samples a limited view to simulate human attention.

| Difficulty | Mice sampled | Cats sampled | Lookahead (steps) |
|---|---|---|---|
| 1 | 3 | 1 | 5 |
| 2 | 5 | 2 | 8 |
| 3 | 8 | 3 | 12 |
| 4 | 12 | 5 | 18 |
| 5 | 20 | 8 | 25 |

Sampling is random but biased toward entities closer to the AI's rocket (within a radius). This simulates a human tendency to watch their own area.

## Path Projection

The core evaluation primitive. Given an entity at (r, c) with direction `dir`, simulate its movement for N steps using the current wall layout and all existing arrows. Returns the sequence of cells visited and the final state (reached a rocket, left the board conceptually, or looping).

This function already exists in the tick logic. Extract it into a reusable `projectPath(r, c, dir, steps, arrowMap, walls)` that returns `{ path: [{r,c}], reachedRocket: owner|null }`.

## Target Scoring

Each think cycle, the AI generates **candidate actions**: for each sampled entity, for each cell along its projected path, try placing an arrow in each of the 4 directions and re-project. Score each candidate.

### Scoring Function

```
score = mouseValue + catValue + arrowEconomy + personalityBonus
```

**mouseValue**: If the re-projected path now reaches the AI's own rocket, `+10`. If it previously reached the AI's rocket and this action breaks that, `-15`.

**catValue**: If a cat's re-projected path now avoids the AI's rocket, `+12`. If it now hits the AI's rocket, `-20`. If it now hits an opponent's rocket, `+3` (base, amplified by Saboteur personality).

**arrowEconomy**: Penalty for using an arrow when the AI already has 5 placed: `-2`. Bonus for reusing an existing arrow cell (rotate instead of new placement): `+3`.

**personalityBonus**: Additional weights applied per personality (see below).

The AI picks the candidate with the highest score. If no candidate exceeds a minimum threshold (e.g., 5), the AI does nothing this cycle.

## Personality Weights

Each personality multiplies specific scoring components:

| Component | Hoarder | Saboteur | Defensive | Aggressive |
|---|---|---|---|---|
| Mouse → own rocket | ×1.5 | ×0.8 | ×1.0 | ×1.0 |
| Cat → away from own rocket | ×0.8 | ×0.6 | ×2.0 | ×1.0 |
| Cat → toward opponent rocket | ×0.3 | ×2.5 | ×0.2 | ×1.5 |
| Overwrite opponent arrow | ×0.2 | ×1.5 | ×0.3 | ×2.5 |
| Multi-mouse corridor | ×2.0 | ×0.5 | ×0.8 | ×1.0 |

**Multi-mouse corridor**: Bonus when a single arrow placement would redirect 2+ mice toward the AI's rocket. Hoarders love this.

**Overwrite opponent arrow**: Bonus for placing on a cell where an opponent already has an arrow. Aggressive players seek this.

## Cursor Movement

The AI has a virtual cursor that moves on the grid. This is visible to all players (rendered as a small colored crosshair or reticle).

**Movement speed** (cells per second):

| Difficulty | Speed |
|---|---|
| 1 | 2 |
| 2 | 3 |
| 3 | 5 |
| 4 | 7 |
| 5 | 10 |

Cursor moves in a straight line (Manhattan path: horizontal first, then vertical) from current position to target. Movement is updated each tick.

While the cursor is in transit, the AI cannot place arrows. This is the primary rate limiter.

## Action Cooldown

Minimum time between consecutive arrow placements:

| Difficulty | Cooldown (ms) |
|---|---|
| 1 | 3000 |
| 2 | 2000 |
| 3 | 1200 |
| 4 | 800 |
| 5 | 400 |

The cooldown starts after an arrow is placed, not after the decision is made. Cursor travel time is additional.

## Accuracy

Probability that the AI places the **optimal** arrow direction vs. a random suboptimal one:

| Difficulty | Accuracy |
|---|---|
| 1 | 50% |
| 2 | 65% |
| 3 | 80% |
| 4 | 90% |
| 5 | 97% |

When inaccurate, the AI picks a random direction that is not the optimal one. This simulates mis-clicks or poor spatial reasoning.

## Think Interval

How often the AI re-evaluates the board:

| Difficulty | Interval (ms) |
|---|---|
| 1 | 2500 |
| 2 | 1800 |
| 3 | 1200 |
| 4 | 800 |
| 5 | 500 |

## AI Lifecycle

1. **Room creation**: AI players are instantiated with their personality and difficulty.
2. **Game start**: AI cursor placed at its rocket position. Think loop starts.
3. **Each think cycle**: Perceive → score → decide → move cursor → execute.
4. **Game end**: AI stops. Scores are final.
5. **Room teardown**: AI objects are garbage collected with the room.

## Rendering (Client-Side)

- AI cursors are visible to all players: a small colored `+` or `◎` that moves smoothly across the grid.
- AI arrows look identical to human arrows (same color, same expiry ring).
- The player list in the HUD shows 🤖 next to AI names.
- AI "names" are generated: the personality name (e.g., "Hoarder", "Saboteur") displayed next to the 🤖 icon.

## Message Protocol Additions

### Client → Server

| Type | Fields | Notes |
|---|---|---|
| `add_ai` | `personality?`, `difficulty?` | Defaults: random, 3 |
| `remove_ai` | `slot` | Remove AI from slot |
| `set_ai_personality` | `slot`, `personality` | Change before game starts |
| `set_ai_difficulty` | `slot`, `difficulty` | Change before game starts |

### Server → Client

The `tick` message gains a `cursors` field:

```json
{
  "type": "tick",
  "cursors": [
    {"slot": 1, "r": 3.4, "c": 7.0, "ai": true},
    {"slot": 2, "r": 6.0, "c": 2.8, "ai": true}
  ]
}
```

Cursor positions are floats (interpolated between cells for smooth movement). Only AI cursors are broadcast — human cursor positions are local.

The `room_joined` and `player_joined` messages include an `ai` boolean and `personality` string for AI slots.

## Consolidation: Removing Single-Player Mode

The current single-player code path in `index.html` is replaced entirely:

- **Quick Play button** on the main menu → creates a local-feel game: connects to server, creates room, adds 3 AI (random personality, difficulty 3), starts immediately.
- If the server is unreachable, show an error. No offline fallback for now.
- All game logic lives on the server. The client is always a networked renderer.

This eliminates the duplicated simulation code. One tick loop, one entity model, one arrow system.