# CLAUDE.md

## Project Overview

Chu Chu Rocket — a browser-based grid game inspired by Sega's ChuChu Rocket! (1999).
Single HTML file (`index.html`), no build tools, no dependencies. Vanilla JS + Canvas.

## Architecture

- **Fixed-timestep simulation**: game state advances in discrete ticks (`TICK_MS`).
- **Interpolated rendering**: `requestAnimationFrame` draws between ticks using linear interpolation for smooth motion. Mice/cat positions are interpolated from `(prevR, prevC)` to `(r, c)` based on elapsed time since last tick.
- **No `shadowBlur`**: canvas `shadowBlur` causes rendering artifacts in some environments. All glow effects use explicit radial gradients or semi-transparent shapes instead.
- **Entity model**: mice, cats, and arrows are plain objects in arrays. Arrows have `owner` (player index) and `placedAt` timestamp for expiry.
- **Wall model**: walls stored as a `Set` of `"r,c,dir"` strings. Each wall segment is recorded on both sides.
- **Coordinate system**: grid is `COLS × ROWS` (12×9). Direction enum: UP=0, RIGHT=1, DOWN=2, LEFT=3.

## Key Constants

| Constant | Value | Purpose |
|---|---|---|
| TICK_MS | 500 | Simulation tick interval (ms) |
| MAX_ARROWS | 5 | Per-player arrow limit |
| ARROW_LIFETIME | 20000 | Arrow expiry (ms) |
| MAX_MICE | 100 | Max simultaneous mice |
| MAX_CATS | 8 | Max simultaneous cats |
| MOUSE_SPAWN_INTERVAL | 3 | Ticks between mouse spawn attempts |
| CAT_SPAWN_INTERVAL | 25 | Ticks between cat spawn attempts |
| CAT_PENALTY | 5 | Score deduction per cat entering rocket |
| GAME_TIME | 300 | Game duration (seconds) |

## Entity Behavior

- **Mice** (🐭): Follow arrows. Turn **right** on wall collision. Entering rocket = +1 score.
- **Cats** (🐱, rendered larger): Follow arrows. Turn **left** on wall collision (opposite of mice). Entering rocket = −5 score (never below 0). Cats also eat mice on contact (💥 effect).
- Both mice and cats are redirected by arrows (matching the original game).
- Cats spawn from corners every 25 ticks; max 8 on board.

## Arrow System

- Arrows colored by **player**, not by direction. Player colors: `["#4fc3f7", "#ff6b6b", "#69f0ae", "#ffd93d"]`.
- Max 5 per player; placing 6th removes oldest (FIFO).
- Rotating resets expiry timer.
- Arrows render **on top** of mice/cats (drawn last) with a dark backing circle.
- Arrow keys control direction of the most recently placed arrow.
- Players can only rotate/remove their own arrows.

## Multiplayer Prep

- Each arrow has an `owner` (player index 0–3).
- Rocket positions will differ per player (four corners or similar).
- Multiplayer will use WebSocket with authoritative server tick.

## Planned Features

- **Powerups**: spawn on grid cells, trigger effects (speed boost, slow, extra arrow slot, etc.).
- **Touch controls**: tap to place, tap to rotate. Swipe-to-set-direction as alternative.

## Code Style

- Vanilla JS, no frameworks, no build step.
- All game state in module-level variables (will move to a `GameState` object for multiplayer).
- Canvas for rendering; no DOM elements for game entities.
- `requestAnimationFrame` for draw loop, `setInterval` for tick loop.
