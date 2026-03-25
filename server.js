const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const G = require('./shared/game-logic.js');

const PORT = 5500;

// ── Room name generator ───────────────────────────────────
const ADJECTIVES = [
  'Crazy','Happy','Stupid','Dizzy','Grumpy','Sneaky','Turbulent','Confused',
  'Reckless','Fancy','Wobbly','Cosmic','Funky','Sleepy','Spicy','Bouncy',
  'Clumsy','Jolly','Zany','Fuzzy','Wacky','Sassy','Mighty','Tiny','Brave'
];
const NOUNS = [
  'Gopher','Camper','Lobster','Penguin','Waffle','Pretzel','Squid','Noodle',
  'Mango','Badger','Hamster','Cheese','Pickle','Donut','Cactus','Walrus',
  'Turnip','Biscuit','Parrot','Moose','Taco','Pumpkin','Otter','Falcon','Muffin'
];

function generateRoomName() {
  let name;
  let attempts = 0;
  do {
    const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
    name = `${adj} ${noun}`;
    attempts++;
  } while (rooms.has(name) && attempts < 100);
  return name;
}

// ── AI Player ─────────────────────────────────────────────

const PERSONALITIES = ['hoarder', 'saboteur', 'defensive', 'aggressive'];

const DIFFICULTY_TABLE = {
  //           miceSampled, catsSampled, lookahead, cursorSpeed, cooldown, accuracy, thinkInterval
  1: { mice: 3,  cats: 1, lookahead: 5,  speed: 2,  cooldown: 3000, accuracy: 0.50, thinkMs: 2500 },
  2: { mice: 5,  cats: 2, lookahead: 8,  speed: 3,  cooldown: 2000, accuracy: 0.65, thinkMs: 1800 },
  3: { mice: 8,  cats: 3, lookahead: 12, speed: 5,  cooldown: 1200, accuracy: 0.80, thinkMs: 1200 },
  4: { mice: 12, cats: 5, lookahead: 18, speed: 7,  cooldown: 800,  accuracy: 0.90, thinkMs: 800  },
  5: { mice: 20, cats: 8, lookahead: 25, speed: 10, cooldown: 400,  accuracy: 0.97, thinkMs: 500  },
};

const PERSONALITY_WEIGHTS = {
  //                     mouseOwn, catAway, catToOpponent, overwriteOpponent, multiMouse
  hoarder:    { mouseOwn: 1.5, catAway: 0.8, catToOpponent: 0.3, overwrite: 0.2, multiMouse: 2.0 },
  saboteur:   { mouseOwn: 0.8, catAway: 0.6, catToOpponent: 2.5, overwrite: 1.5, multiMouse: 0.5 },
  defensive:  { mouseOwn: 1.0, catAway: 2.0, catToOpponent: 0.2, overwrite: 0.3, multiMouse: 0.8 },
  aggressive: { mouseOwn: 1.0, catAway: 1.0, catToOpponent: 1.5, overwrite: 2.5, multiMouse: 1.0 },
};

const SCORE_THRESHOLD = 5;

class AIPlayer {
  constructor(slot, room, personality, difficulty) {
    this.slot = slot;
    this.room = room;
    this.personality = personality || PERSONALITIES[Math.floor(Math.random() * PERSONALITIES.length)];
    this.difficulty = Math.max(1, Math.min(5, difficulty || 3));

    const cfg = DIFFICULTY_TABLE[this.difficulty];
    this.maxMiceSampled = cfg.mice;
    this.maxCatsSampled = cfg.cats;
    this.lookahead = cfg.lookahead;
    this.cursorSpeed = cfg.speed; // cells per second
    this.actionCooldown = cfg.cooldown;
    this.accuracy = cfg.accuracy;
    this.thinkMs = cfg.thinkMs;

    this.weights = PERSONALITY_WEIGHTS[this.personality];

    // Virtual cursor
    this.cursorR = Math.floor(G.ROWS / 2);
    this.cursorC = Math.floor(G.COLS / 2);
    this.targetR = this.cursorR;
    this.targetC = this.cursorC;

    // Timing
    this.lastActionTime = 0;
    this.thinkTimer = null;

    // Queued action
    this.pendingCommand = null; // { r, c, dir }
  }

  start() {
    // Place cursor at own rocket
    const myRocket = this.room.rockets.find(rk => rk.owner === this.slot);
    if (myRocket) {
      this.cursorR = myRocket.r;
      this.cursorC = myRocket.c;
      this.targetR = myRocket.r;
      this.targetC = myRocket.c;
    }
    this.thinkTimer = setInterval(() => this.think(), this.thinkMs);
  }

  stop() {
    if (this.thinkTimer) { clearInterval(this.thinkTimer); this.thinkTimer = null; }
  }

  // Called each game tick from serverTick — moves cursor, executes pending commands
  update() {
    if (this.room.state !== 'playing') return;

    // Move cursor toward target (Manhattan: horizontal first, then vertical)
    const cellsPerTick = this.cursorSpeed * (G.TICK_MS / 1000);
    let remaining = cellsPerTick;

    // Horizontal movement
    if (remaining > 0 && this.cursorC !== this.targetC) {
      const dc = this.targetC - this.cursorC;
      const step = Math.min(remaining, Math.abs(dc));
      this.cursorC += Math.sign(dc) * step;
      remaining -= step;
    }
    // Vertical movement
    if (remaining > 0 && this.cursorR !== this.targetR) {
      const dr = this.targetR - this.cursorR;
      const step = Math.min(remaining, Math.abs(dr));
      this.cursorR += Math.sign(dr) * step;
      remaining -= step;
    }

    // Execute pending command when cursor has arrived and cooldown elapsed
    if (this.pendingCommand && this.cursorR === this.targetR && this.cursorC === this.targetC) {
      const now = Date.now();
      if (now - this.lastActionTime >= this.actionCooldown) {
        const cmd = this.pendingCommand;
        this.pendingCommand = null;
        handlePlace(null, this.room, this.slot, cmd.r, cmd.c);
        // Set direction on the placed arrow
        const arrow = this.room.arrows.find(a => a.r === cmd.r && a.c === cmd.c && a.owner === this.slot);
        if (arrow) arrow.dir = cmd.dir;
        this.lastActionTime = now;
      }
    }
  }

  think() {
    if (this.room.state !== 'playing') return;
    // Don't think while cursor is still moving or we have a pending command
    if (this.pendingCommand) return;

    const room = this.room;
    const myRocket = room.rockets.find(rk => rk.owner === this.slot && rk.active);
    if (!myRocket) return;

    const arrowMap = G.buildArrowMap(room.arrows);
    const myArrowCount = room.arrows.filter(a => a.owner === this.slot).length;

    // ── Perceive: sample mice and cats biased toward own rocket ──
    const sampledMice = this._sampleEntities(room.mice, this.maxMiceSampled, myRocket);
    const sampledCats = this._sampleEntities(room.cats, this.maxCatsSampled, myRocket);

    let bestScore = -Infinity;
    let bestCandidate = null;

    // ── Evaluate mice candidates ──
    for (const mouse of sampledMice) {
      const basePath = G.projectPath(mouse.r, mouse.c, mouse.dir, this.lookahead, arrowMap, room.walls, room.rockets, 1);

      for (const cell of basePath.path) {
        // Skip rocket cells
        if (room.rockets.some(rk => rk.r === cell.r && rk.c === cell.c)) continue;

        for (let dir = 0; dir < 4; dir++) {
          // Build hypothetical arrow map
          const testMap = Object.assign({}, arrowMap);
          testMap[`${cell.r},${cell.c}`] = dir;

          const newPath = G.projectPath(mouse.r, mouse.c, mouse.dir, this.lookahead, testMap, room.walls, room.rockets, 1);

          let score = 0;

          // mouseValue
          if (newPath.reachedRocket === this.slot) {
            score += 10 * this.weights.mouseOwn;
          } else if (basePath.reachedRocket === this.slot && newPath.reachedRocket !== this.slot) {
            score -= 15;
          }

          // Multi-mouse corridor: count other sampled mice that also reach own rocket
          let multiCount = 0;
          for (const otherMouse of sampledMice) {
            if (otherMouse === mouse) continue;
            const otherNew = G.projectPath(otherMouse.r, otherMouse.c, otherMouse.dir, this.lookahead, testMap, room.walls, room.rockets, 1);
            if (otherNew.reachedRocket === this.slot) multiCount++;
          }
          if (multiCount > 0) score += multiCount * 5 * this.weights.multiMouse;

          // Arrow economy
          const existingOwn = room.arrows.find(a => a.r === cell.r && a.c === cell.c && a.owner === this.slot);
          if (existingOwn) {
            score += 3; // rotate bonus
          } else if (myArrowCount >= G.MAX_ARROWS) {
            score -= 2;
          }

          // Overwrite opponent arrow bonus
          const opponentArrow = room.arrows.find(a => a.r === cell.r && a.c === cell.c && a.owner !== this.slot);
          if (opponentArrow) {
            // Can't actually place on opponent arrow (handlePlace blocks it), skip
            continue;
          }

          if (score > bestScore) {
            bestScore = score;
            bestCandidate = { r: cell.r, c: cell.c, dir };
          }
        }
      }
    }

    // ── Evaluate cat candidates ──
    for (const cat of sampledCats) {
      const basePath = G.projectPath(cat.r, cat.c, cat.dir, this.lookahead, arrowMap, room.walls, room.rockets, 3);

      for (const cell of basePath.path) {
        if (room.rockets.some(rk => rk.r === cell.r && rk.c === cell.c)) continue;

        for (let dir = 0; dir < 4; dir++) {
          const testMap = Object.assign({}, arrowMap);
          testMap[`${cell.r},${cell.c}`] = dir;

          const newPath = G.projectPath(cat.r, cat.c, cat.dir, this.lookahead, testMap, room.walls, room.rockets, 3);

          let score = 0;

          // catValue: deflect away from own rocket
          if (basePath.reachedRocket === this.slot && newPath.reachedRocket !== this.slot) {
            score += 12 * this.weights.catAway;
          }
          // catValue: now hits own rocket (bad)
          if (newPath.reachedRocket === this.slot && basePath.reachedRocket !== this.slot) {
            score -= 20;
          }
          // catValue: redirect toward opponent rocket
          if (newPath.reachedRocket !== null && newPath.reachedRocket !== this.slot) {
            score += 3 * this.weights.catToOpponent;
          }

          // Arrow economy
          const existingOwn = room.arrows.find(a => a.r === cell.r && a.c === cell.c && a.owner === this.slot);
          if (existingOwn) {
            score += 3;
          } else if (myArrowCount >= G.MAX_ARROWS) {
            score -= 2;
          }

          const opponentArrow = room.arrows.find(a => a.r === cell.r && a.c === cell.c && a.owner !== this.slot);
          if (opponentArrow) continue;

          if (score > bestScore) {
            bestScore = score;
            bestCandidate = { r: cell.r, c: cell.c, dir };
          }
        }
      }
    }

    // ── Decide ──
    if (!bestCandidate || bestScore < SCORE_THRESHOLD) return;

    // Apply accuracy: chance to pick a random non-optimal direction
    if (Math.random() > this.accuracy) {
      const dirs = [0, 1, 2, 3].filter(d => d !== bestCandidate.dir);
      bestCandidate.dir = dirs[Math.floor(Math.random() * dirs.length)];
    }

    // Queue command and set cursor target
    this.pendingCommand = bestCandidate;
    this.targetR = bestCandidate.r;
    this.targetC = bestCandidate.c;
  }

  _sampleEntities(entities, maxCount, myRocket) {
    if (entities.length <= maxCount) return [...entities];

    // Weight by inverse distance to own rocket (closer = more likely sampled)
    const weighted = entities.map(e => {
      const dist = Math.abs(e.r - myRocket.r) + Math.abs(e.c - myRocket.c);
      return { entity: e, weight: 1 / (1 + dist) };
    });

    // Weighted random sampling without replacement
    const sampled = [];
    const pool = [...weighted];
    for (let i = 0; i < maxCount && pool.length > 0; i++) {
      const totalWeight = pool.reduce((sum, w) => sum + w.weight, 0);
      let rand = Math.random() * totalWeight;
      let picked = pool.length - 1;
      for (let j = 0; j < pool.length; j++) {
        rand -= pool[j].weight;
        if (rand <= 0) { picked = j; break; }
      }
      sampled.push(pool[picked].entity);
      pool.splice(picked, 1);
    }
    return sampled;
  }
}

// ── Rooms ─────────────────────────────────────────────────
const rooms = new Map();
const clients = new Map(); // ws → { roomName, slot }

function createRoom(ws, playerName) {
  const name = generateRoomName();
  const room = {
    name,
    state: 'lobby',
    players: new Map(), // ws → { slot, name }
    mice: [],
    cats: [],
    arrows: [],
    scores: [0, 0, 0, 0],
    rockets: [],       // { r, c, owner, active }
    walls: G.initWalls(),
    tickCount: 0,
    timeLeft: G.GAME_TIME,
    tickTimer: null,
    timerTimer: null,
    absorb: [],
    aiPlayers: [],
    aiSlots: new Set(),
  };

  const slot = 0;
  const pName = playerName || 'Player 1';
  room.players.set(ws, { slot, name: pName });
  rooms.set(name, room);
  clients.set(ws, { roomName: name, slot });

  send(ws, {
    type: 'room_created',
    roomName: name,
    slot,
    playerName: pName,
  });
}

function joinRoom(ws, roomName, playerName) {
  const room = rooms.get(roomName);
  if (!room) return send(ws, { type: 'error', message: 'Room not found' });
  const totalPlayers = room.players.size + room.aiSlots.size;
  if (totalPlayers >= 4) return send(ws, { type: 'error', message: 'Room is full' });

  // Find first available slot
  const taken = new Set();
  for (const p of room.players.values()) taken.add(p.slot);
  for (const s of room.aiSlots) taken.add(s);
  let slot = -1;
  for (let i = 0; i < 4; i++) { if (!taken.has(i)) { slot = i; break; } }
  if (slot === -1) return send(ws, { type: 'error', message: 'Room is full' });

  const pName = playerName || `Player ${slot + 1}`;
  room.players.set(ws, { slot, name: pName });
  clients.set(ws, { roomName, slot });

  // Build player list (humans + AI)
  const players = [];
  for (const p of room.players.values()) {
    players.push({ slot: p.slot, name: p.name, ai: false });
  }
  for (const ai of room.aiPlayers) {
    const aiName = ai.personality.charAt(0).toUpperCase() + ai.personality.slice(1);
    players.push({ slot: ai.slot, name: aiName, ai: true, personality: ai.personality, difficulty: ai.difficulty });
  }

  send(ws, {
    type: 'room_joined',
    roomName,
    slot,
    players,
  });

  // Broadcast to others
  broadcastToRoom(room, { type: 'player_joined', slot, name: pName }, ws);

  // If game is already running (late join), send game state
  if (room.state === 'playing') {
    // Place a rocket for the late joiner
    const rocketPos = findRocketPosition(room);
    if (rocketPos) {
      room.rockets.push({ r: rocketPos.r, c: rocketPos.c, owner: slot, active: true });
    }
    send(ws, {
      type: 'game_started',
      rockets: room.rockets,
    });
  }
}

function leaveRoom(ws) {
  const client = clients.get(ws);
  if (!client) return;
  const room = rooms.get(client.roomName);
  if (!room) { clients.delete(ws); return; }

  const playerInfo = room.players.get(ws);
  room.players.delete(ws);
  clients.delete(ws);

  if (room.state === 'playing' && playerInfo) {
    // Remove their arrows
    room.arrows = room.arrows.filter(a => a.owner !== playerInfo.slot);
    // Mark rocket as inactive
    for (const rk of room.rockets) {
      if (rk.owner === playerInfo.slot) rk.active = false;
    }
  }

  broadcastToRoom(room, { type: 'player_left', slot: playerInfo ? playerInfo.slot : -1 });

  // Garbage collect empty rooms (no humans left)
  if (room.players.size === 0) {
    if (room.tickTimer) clearInterval(room.tickTimer);
    if (room.timerTimer) clearInterval(room.timerTimer);
    for (const ai of room.aiPlayers) ai.stop();
    room.aiPlayers = [];
    room.aiSlots.clear();
    rooms.delete(room.name);
  }
}

function listRooms(ws) {
  const list = [];
  for (const room of rooms.values()) {
    const total = room.players.size + room.aiSlots.size;
    if (total < 4) {
      list.push({
        name: room.name,
        playerCount: total,
        state: room.state,
      });
    }
  }
  send(ws, { type: 'room_list', rooms: list });
}

// ── Rocket placement ──────────────────────────────────────
function findRocketPosition(room) {
  const occupied = new Set();
  for (const rk of room.rockets) occupied.add(`${rk.r},${rk.c}`);
  for (const sp of G.SPAWN_POINTS) occupied.add(`${sp.r},${sp.c}`);
  for (const sp of G.CAT_SPAWN_POINTS) occupied.add(`${sp.r},${sp.c}`);

  const candidates = [];
  for (let r = 1; r < G.ROWS - 1; r++) {
    for (let c = 1; c < G.COLS - 1; c++) {
      if (occupied.has(`${r},${c}`)) continue;
      // Check Manhattan distance >= 3 from all existing rockets
      let tooClose = false;
      for (const rk of room.rockets) {
        if (Math.abs(r - rk.r) + Math.abs(c - rk.c) < 3) { tooClose = true; break; }
      }
      if (!tooClose) candidates.push({ r, c });
    }
  }
  if (candidates.length === 0) {
    // Fallback: just pick any non-occupied interior cell
    for (let r = 1; r < G.ROWS - 1; r++) {
      for (let c = 1; c < G.COLS - 1; c++) {
        if (!occupied.has(`${r},${c}`)) return { r, c };
      }
    }
    return null;
  }
  return candidates[Math.floor(Math.random() * candidates.length)];
}

// ── Game logic ────────────────────────────────────────────
function startGameInRoom(room) {
  room.state = 'playing';
  room.mice = [];
  room.cats = [];
  room.arrows = [];
  room.scores = [0, 0, 0, 0];
  room.tickCount = 0;
  room.timeLeft = G.GAME_TIME;
  room.rockets = [];
  room.absorb = [];

  // Place rockets for all players (human + AI)
  const allSlots = [];
  for (const p of room.players.values()) allSlots.push(p.slot);
  for (const s of room.aiSlots) allSlots.push(s);
  allSlots.sort((a, b) => a - b);

  for (let i = 0; i < allSlots.length; i++) {
    const slot = allSlots[i];
    let pos;
    if (i === 0) {
      pos = { r: 4, c: 5 }; // center
    } else {
      pos = findRocketPosition(room);
    }
    if (pos) {
      room.rockets.push({ r: pos.r, c: pos.c, owner: slot, active: true });
    }
  }

  // Start AI think loops
  for (const ai of room.aiPlayers) ai.start();

  // Broadcast game_started
  broadcastToRoom(room, {
    type: 'game_started',
    rockets: room.rockets,
  });

  // Start tick loop
  room.tickTimer = setInterval(() => serverTick(room), G.TICK_MS);
  room.timerTimer = setInterval(() => {
    room.timeLeft--;
    if (room.timeLeft <= 0) endGameInRoom(room);
  }, 1000);
}

function serverTick(room) {
  room.tickCount++;
  room.absorb = [];
  const arrowMap = G.buildArrowMap(room.arrows);

  // Move mice
  for (const m of room.mice) G.moveEntity(m, arrowMap, room.walls, 1);
  // Move cats
  for (const c of room.cats) G.moveEntity(c, arrowMap, room.walls, 3);

  // Mice → rockets
  room.mice = room.mice.filter(m => {
    for (const rk of room.rockets) {
      if (rk.active && m.r === rk.r && m.c === rk.c) {
        room.scores[rk.owner]++;
        room.absorb.push({ r: m.r, c: m.c, type: 'mouse' });
        return false;
      }
    }
    return true;
  });

  // Cats → rockets
  room.cats = room.cats.filter(c => {
    for (const rk of room.rockets) {
      if (rk.active && c.r === rk.r && c.c === rk.c) {
        room.scores[rk.owner] = Math.max(0, room.scores[rk.owner] - G.CAT_PENALTY);
        room.absorb.push({ r: c.r, c: c.c, type: 'cat' });
        return false;
      }
    }
    return true;
  });

  // Cats eat mice
  const catPositions = new Set(room.cats.map(c => `${c.r},${c.c}`));
  room.mice = room.mice.filter(m => {
    if (catPositions.has(`${m.r},${m.c}`)) {
      room.absorb.push({ r: m.r, c: m.c, type: 'eaten' });
      return false;
    }
    return true;
  });

  // Spawning
  if (room.tickCount % G.MOUSE_SPAWN_INTERVAL === 0) {
    G.spawnMouse(room.mice, room.cats);
    if (Math.random() < 0.35) G.spawnMouse(room.mice, room.cats);
  }
  if (room.tickCount % G.CAT_SPAWN_INTERVAL === 0 && room.mice.length >= room.cats.length * 3) {
    G.spawnCat(room.cats, room.mice);
  }

  // Update AI cursors and execute pending commands
  for (const ai of room.aiPlayers) ai.update();

  // Expire arrows
  const now = Date.now();
  room.arrows = room.arrows.filter(a => now - a.placedAt < G.ARROW_LIFETIME);

  // Broadcast tick
  const cursors = room.aiPlayers.map(ai => ({ slot: ai.slot, r: ai.cursorR, c: ai.cursorC, ai: true }));
  broadcastToRoom(room, {
    type: 'tick',
    mice: room.mice,
    cats: room.cats,
    arrows: room.arrows,
    scores: room.scores,
    timeLeft: room.timeLeft,
    tickCount: room.tickCount,
    absorb: room.absorb,
    cursors,
  });
}

function endGameInRoom(room) {
  room.state = 'finished';
  if (room.tickTimer) { clearInterval(room.tickTimer); room.tickTimer = null; }
  if (room.timerTimer) { clearInterval(room.timerTimer); room.timerTimer = null; }
  for (const ai of room.aiPlayers) ai.stop();

  broadcastToRoom(room, {
    type: 'game_over',
    scores: room.scores,
  });

  // Clean up room after a delay
  setTimeout(() => {
    if (rooms.has(room.name) && room.state === 'finished') {
      rooms.delete(room.name);
      // Disconnect remaining clients from room tracking
      for (const ws of room.players.keys()) {
        clients.delete(ws);
      }
    }
  }, 10000);
}

// ── Arrow operations ──────────────────────────────────────
function handlePlace(ws, room, slot, r, c) {
  if (room.state !== 'playing') return;
  if (r < 0 || r >= G.ROWS || c < 0 || c >= G.COLS) return;
  // Can't place on any rocket
  if (room.rockets.some(rk => rk.r === r && rk.c === c)) return;

  // Block if another player's arrow occupies this cell
  const otherArrow = room.arrows.find(a => a.r === r && a.c === c && a.owner !== slot);
  if (otherArrow) return;

  const existing = room.arrows.find(a => a.r === r && a.c === c && a.owner === slot);
  if (existing) {
    // Rotate
    const age = Date.now() - existing.placedAt;
    if (age >= G.ARROW_LOCK_TIME) return; // locked
    existing.dir = (existing.dir + 1) % 4;
  } else {
    // Place new
    const mine = room.arrows.filter(a => a.owner === slot);
    if (mine.length >= G.MAX_ARROWS) {
      const oldest = mine.reduce((a, b) => a.placedAt < b.placedAt ? a : b);
      room.arrows.splice(room.arrows.indexOf(oldest), 1);
    }
    room.arrows.push({ r, c, dir: G.DIR.RIGHT, owner: slot, placedAt: Date.now() });
  }
}

function handleRemove(ws, room, slot, r, c) {
  if (room.state !== 'playing') return;
  const idx = room.arrows.findIndex(a => a.r === r && a.c === c && a.owner === slot);
  if (idx !== -1) room.arrows.splice(idx, 1);
}

function handleRotateCCW(ws, room, slot, r, c) {
  if (room.state !== 'playing') return;
  const existing = room.arrows.find(a => a.r === r && a.c === c && a.owner === slot);
  if (!existing) return;
  if (Date.now() - existing.placedAt >= G.ARROW_LOCK_TIME) return;
  existing.dir = (existing.dir + 3) % 4;
}

function handleAim(ws, room, slot, dir) {
  if (room.state !== 'playing') return;
  if (dir < 0 || dir > 3) return;
  const recent = G.getMostRecentArrow(room.arrows, slot);
  if (recent) {
    const age = Date.now() - recent.placedAt;
    if (age >= G.ARROW_LOCK_TIME) return;
    recent.dir = dir;
  }
}

// ── WebSocket helpers ─────────────────────────────────────
function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcastToRoom(room, msg, exclude) {
  const data = JSON.stringify(msg);
  for (const ws of room.players.keys()) {
    if (ws !== exclude && ws.readyState === 1) ws.send(data);
  }
}

// ── HTTP server (static files) ────────────────────────────
const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';

  // Serve from public/ or shared/
  let filePath;
  if (urlPath.startsWith('/shared/')) {
    filePath = path.join(__dirname, urlPath);
  } else {
    filePath = path.join(__dirname, 'public', urlPath);
  }

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

// ── WebSocket server ──────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const client = clients.get(ws);

    switch (msg.type) {
      case 'create_room':
        if (client) leaveRoom(ws);
        createRoom(ws, msg.name);
        break;

      case 'join_room':
        if (client) leaveRoom(ws);
        joinRoom(ws, msg.room, msg.name);
        break;

      case 'list_rooms':
        listRooms(ws);
        break;

      case 'leave_room':
        leaveRoom(ws);
        break;

      case 'start_game': {
        if (!client) return;
        const room = rooms.get(client.roomName);
        if (!room || room.state !== 'lobby') return;
        // Only creator (slot 0) can start
        if (client.slot !== 0) return send(ws, { type: 'error', message: 'Only the room creator can start' });
        startGameInRoom(room);
        break;
      }

      case 'place': {
        if (!client) return;
        const room = rooms.get(client.roomName);
        if (room) handlePlace(ws, room, client.slot, msg.r, msg.c);
        break;
      }

      case 'rotate': {
        if (!client) return;
        const room = rooms.get(client.roomName);
        if (room) handlePlace(ws, room, client.slot, msg.r, msg.c); // rotate = same as place on existing
        break;
      }

      case 'remove': {
        if (!client) return;
        const room = rooms.get(client.roomName);
        if (room) handleRemove(ws, room, client.slot, msg.r, msg.c);
        break;
      }

      case 'aim': {
        if (!client) return;
        const room = rooms.get(client.roomName);
        if (room) handleAim(ws, room, client.slot, msg.dir);
        break;
      }

      case 'rotate_ccw': {
        if (!client) return;
        const room = rooms.get(client.roomName);
        if (room) handleRotateCCW(ws, room, client.slot, msg.r, msg.c);
        break;
      }

      case 'cursor': {
        if (!client) return;
        const room = rooms.get(client.roomName);
        if (room) {
          broadcastToRoom(room, { type: 'cursor', slot: client.slot, r: msg.r, c: msg.c }, ws);
        }
        break;
      }

      case 'add_ai': {
        if (!client) return;
        const room = rooms.get(client.roomName);
        if (!room || room.state !== 'lobby') return;
        if (client.slot !== 0) return send(ws, { type: 'error', message: 'Only the room creator can add AI' });
        const total = room.players.size + room.aiSlots.size;
        if (total >= 4) return send(ws, { type: 'error', message: 'Room is full' });
        // Find next free slot
        const taken = new Set();
        for (const p of room.players.values()) taken.add(p.slot);
        for (const s of room.aiSlots) taken.add(s);
        let aiSlot = -1;
        for (let i = 0; i < 4; i++) { if (!taken.has(i)) { aiSlot = i; break; } }
        if (aiSlot === -1) return;
        const ai = new AIPlayer(aiSlot, room, msg.personality, msg.difficulty);
        room.aiPlayers.push(ai);
        room.aiSlots.add(aiSlot);
        const aiName = ai.personality.charAt(0).toUpperCase() + ai.personality.slice(1);
        broadcastToRoom(room, { type: 'player_joined', slot: aiSlot, name: aiName, ai: true, personality: ai.personality, difficulty: ai.difficulty });
        break;
      }

      case 'remove_ai': {
        if (!client) return;
        const room = rooms.get(client.roomName);
        if (!room || room.state !== 'lobby') return;
        if (client.slot !== 0) return;
        const slot = msg.slot;
        if (!room.aiSlots.has(slot)) return;
        room.aiSlots.delete(slot);
        room.aiPlayers = room.aiPlayers.filter(ai => ai.slot !== slot);
        broadcastToRoom(room, { type: 'player_left', slot });
        break;
      }

      case 'quick_play': {
        if (client) leaveRoom(ws);
        createRoom(ws, msg.name || 'Player 1');
        const room = rooms.get(clients.get(ws).roomName);
        if (!room) return;
        // Add 3 AI players
        for (let i = 0; i < 3; i++) {
          const taken = new Set();
          for (const p of room.players.values()) taken.add(p.slot);
          for (const s of room.aiSlots) taken.add(s);
          let aiSlot = -1;
          for (let j = 0; j < 4; j++) { if (!taken.has(j)) { aiSlot = j; break; } }
          if (aiSlot === -1) break;
          const ai = new AIPlayer(aiSlot, room, null, 3);
          room.aiPlayers.push(ai);
          room.aiSlots.add(aiSlot);
        }
        // Send player info so client knows about AI slots
        const players = [];
        for (const p of room.players.values()) players.push({ slot: p.slot, name: p.name, ai: false });
        for (const ai of room.aiPlayers) {
          const aiName = ai.personality.charAt(0).toUpperCase() + ai.personality.slice(1);
          players.push({ slot: ai.slot, name: aiName, ai: true, personality: ai.personality, difficulty: ai.difficulty });
        }
        send(ws, { type: 'quick_play_ready', players });
        startGameInRoom(room);
        break;
      }
    }
  });

  ws.on('close', () => {
    leaveRoom(ws);
  });
});

server.listen(PORT, () => {
  console.log(`Chu Chu Rocket server running on http://localhost:${PORT}`);
});
