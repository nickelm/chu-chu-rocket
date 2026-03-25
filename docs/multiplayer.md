# Multiplayer Specification

## Overview

Add real-time multiplayer (up to 4 players) to the existing single-player Chu Chu Rocket game. Players connect via separate devices (phone, tablet, laptop) to a shared game session hosted on a DigitalOcean droplet. The server runs the authoritative simulation; clients send arrow-placement commands and receive state updates.

## Architecture

**Server**: Node.js + `ws` (WebSocket library). No framework. Single `server.js` file. Runs the game tick loop and broadcasts state.

**Client**: The existing `index.html`, extended with a WebSocket connection layer and a lobby screen. No build step.

**Hosting**: DigitalOcean droplet. Serve the static `index.html` from the same Node process (use `http` module to serve files, then upgrade to WebSocket). Single port (e.g., 3000). No nginx needed for now.

**Protocol**: JSON messages over WebSocket. All game logic runs server-side. Clients are dumb renderers + input forwarders.

## Lobby

### Creating a Game

The landing screen shows two options: **Create Game** and **Join Game**.

Creating a game generates a room with a randomly assigned funny name from a hardcoded list of ~50 two-word combinations. Format: `{Adjective} {Noun}`. Examples: Crazy Gopher, Happy Camper, Stupid Lobster, Dizzy Penguin, Grumpy Waffle, Sneaky Pretzel, Turbulent Squid, Confused Noodle, Reckless Mango, Fancy Badger.

The creator enters the room automatically as Player 1 (blue). The lobby view shows:

- Room name (large, prominent)
- Player list (slots 1–4, showing connected players with their color)
- A "Start Game" button visible only to the creator (Player 1)
- A shareable room code or URL fragment (e.g., `?room=crazy-gopher`)

### Joining a Game

"Join Game" shows a list of available rooms (rooms that exist and have fewer than 4 players and haven't started yet). Clicking a room joins it. Alternatively, a player can enter a room name manually or use a direct URL.

Players can join a game **after it has started** if there are fewer than 4 players. Late joiners get a rocket placed at a random unoccupied position and start with 0 score. The game does not pause.

### Player Assignment

Players are assigned the first available slot (0–3) and the corresponding color: blue, red, green, yellow. Disconnected players free their slot. Their arrows are removed. Their rocket stays but is inert (mice/cats pass through it with no effect).

## Server-Side Game State

The server owns all state. One `Room` object per active game:

```
Room {
  name: string
  state: 'lobby' | 'playing' | 'finished'
  players: Map<socketId, { slot: 0-3, name?: string }>
  rockets: Array<{r, c, owner}> — one per connected player
  mice: Array<{r, c, dir, prevR, prevC, id}>
  cats: Array<{r, c, dir, prevR, prevC, id}>
  arrows: Array<{r, c, dir, owner, placedAt}>
  scores: [0, 0, 0, 0]
  tickCount: number
  timeLeft: number
  walls: Set (same as current)
}
```

### Tick Loop

When a room is in `playing` state, the server runs `setInterval(tick, TICK_MS)`. Each tick:

1. Move mice (same logic as current client).
2. Move cats (same logic).
3. Check each rocket for mice (score for that rocket's owner) and cats (penalty for that rocket's owner).
4. Cats eat mice on contact.
5. Spawn mice and cats per existing intervals.
6. Expire arrows.
7. Broadcast tick state to all clients in the room.

### Broadcast Message (server → client)

Sent every tick:

```json
{
  "type": "tick",
  "mice": [{"r":0,"c":3,"dir":1,"prevR":0,"prevC":2,"id":"..."}],
  "cats": [...],
  "arrows": [{"r":1,"c":5,"dir":2,"owner":0,"placedAt":1234567}],
  "rockets": [{"r":4,"c":5,"owner":0}, ...],
  "scores": [12, 5, 0, 0],
  "timeLeft": 243,
  "absorb": [{"r":4,"c":5,"type":"mouse"}, ...]
}
```

The `absorb` array contains events from this tick only (mice/cats entering rockets, mice eaten) so clients can play the shrink/burst animation.

## Client-Side Changes

### Lobby UI

Add a lobby screen (HTML/CSS, same retro aesthetic) that appears before the game canvas. The lobby connects to the server via WebSocket on load.

### Input → Server

The client no longer modifies local game state. Instead, it sends commands:

```json
{"type": "place", "r": 3, "c": 7}
{"type": "rotate", "r": 3, "c": 7}
{"type": "remove", "r": 3, "c": 7}
{"type": "aim", "dir": 0}
```

- `place`: Place a new arrow at (r, c). Server handles FIFO eviction.
- `rotate`: Rotate the player's existing arrow at (r, c). Server rejects if it's not theirs.
- `remove`: Remove the player's arrow at (r, c). Server rejects if it's not theirs.
- `aim`: Set the direction of the player's most recent arrow (keyboard input).

### Rendering

The client receives full state each tick and renders it using the existing interpolated draw loop. The only change: arrows from other players are visible and use that player's color. The client does **not** run its own simulation — it only interpolates between received tick states for smooth rendering.

### HUD Changes

- Show all players' scores in the HUD, color-coded.
- Show player count (e.g., "2/4").
- Show room name.

## Rocket Placement

Each player gets one rocket. Placement rules:

- Player 1's rocket defaults to center (current position) if they're first.
- Subsequent rockets are placed at random empty cells that are at least 3 cells away from any existing rocket and not on a wall or spawn point.
- If a player disconnects, their rocket becomes inert (drawn dimmed, no scoring/penalty).

## Arrow Ownership Rules

- Players can only rotate or remove their own arrows.
- All arrows are visible to all players, colored by owner.
- A player's arrows are rendered slightly brighter/larger to them than other players' arrows (client-side distinction using the `owner` field).
- Arrow limit (5) is per player.
- Arrows from different players can coexist on the same cell. In that case, the most recently placed arrow takes effect (last-write-wins for gameplay, but both are visible).

## Message Types Summary

### Client → Server

| Type | Fields | Notes |
|------|--------|-------|
| `create_room` | — | Server responds with room name |
| `join_room` | `room` | Join by name |
| `start_game` | — | Only room creator (slot 0) |
| `place` | `r`, `c` | Place arrow |
| `rotate` | `r`, `c` | Rotate own arrow |
| `remove` | `r`, `c` | Remove own arrow |
| `aim` | `dir` | Set most recent arrow direction |

### Server → Client

| Type | Fields | Notes |
|------|--------|-------|
| `room_created` | `room`, `slot` | After create |
| `room_joined` | `room`, `slot`, `players` | After join |
| `player_joined` | `slot` | Broadcast to room |
| `player_left` | `slot` | Broadcast to room |
| `game_started` | `rockets`, `walls` | Initial state |
| `tick` | Full state (see above) | Every TICK_MS |
| `game_over` | `scores` | Final scores |
| `error` | `message` | Rejection reason |

## File Structure

```
chuchu-rocket/
├── .gitignore
├── CLAUDE.md
├── README.md
├── package.json          ← new: { "dependencies": { "ws": "^8" } }
├── server.js             ← new: Node.js WebSocket server + static file serving
└── index.html            ← modified: lobby UI + WebSocket client layer
```

No build step. `node server.js` starts everything. Client connects to `ws://host:3000`.

## Deployment

On the DigitalOcean droplet:

1. Clone the repo.
2. `npm install` (installs `ws`).
3. `node server.js` (or use `pm2` for persistence).
4. Firewall: open port 3000 (or 80 if you bind there).
5. Players navigate to `http://<droplet-ip>:3000`.

## Out of Scope (for now)

- HTTPS/WSS (add later with Let's Encrypt + reverse proxy).
- Player names (just use colors for now).
- Spectator mode.
- Powerups.
- Reconnection handling (disconnect = leave).
- Persistent rooms (rooms are garbage-collected when empty).