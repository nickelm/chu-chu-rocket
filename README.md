# Chu Chu Rocket

A web-based reimagining of Sega's ChuChu Rocket! (Dreamcast, 1999). Guide mice to your rocket by placing directional arrows on a grid. Avoid cats.

## How to Play

- **Click** a cell to place a right-facing arrow
- **Click** an existing arrow to rotate it 90°
- **Right-click** an arrow to remove it
- **Arrow keys** control the direction of your most recently placed arrow
- Mice (🐭) follow arrows and turn **right** when hitting walls
- Cats (🐱) follow arrows and turn **left** when hitting walls
- Mice entering your rocket = **+1 point**
- Cats entering your rocket = **−5 points** (never below 0)
- Cats eat mice on contact
- Max **5 arrows** at a time; placing a 6th removes the oldest
- Arrows expire after **20 seconds**
- Game lasts **5 minutes**

## Running

### Single player
Open `public/index.html` directly in a browser.

### Multiplayer (WebSocket)
```bash
npm install
npm start
```
Then open `http://localhost:3000` in your browser.

## Roadmap

- [x] Single-player grid with mice, arrows, rocket, scoring
- [x] Arrow limits (5 max, FIFO), arrow expiry (20s)
- [x] Cats (left-turning, penalty on rocket, eat mice)
- [x] Keyboard control for most recent arrow
- [ ] Powerups (speed up/slow down mice, extra arrows, etc.)
- [x] Multiplayer via WebSocket (up to 4 players, one device each)
- [ ] Touch controls optimized for iPad
- [ ] Sound effects

## Architecture

Vanilla JS + Canvas rendering with a Node.js/WebSocket server for multiplayer. Game loop runs a fixed-timestep simulation; rendering interpolates between ticks for smooth animation. No `shadowBlur` used (replaced with explicit glow shapes for cross-platform reliability).

## License

MIT License. See [LICENSE](LICENSE). Not affiliated with Sega.
