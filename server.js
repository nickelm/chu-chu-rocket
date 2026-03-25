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
  if (room.players.size >= 4) return send(ws, { type: 'error', message: 'Room is full' });

  // Find first available slot
  const taken = new Set();
  for (const p of room.players.values()) taken.add(p.slot);
  let slot = -1;
  for (let i = 0; i < 4; i++) { if (!taken.has(i)) { slot = i; break; } }
  if (slot === -1) return send(ws, { type: 'error', message: 'Room is full' });

  const pName = playerName || `Player ${slot + 1}`;
  room.players.set(ws, { slot, name: pName });
  clients.set(ws, { roomName, slot });

  // Build player list
  const players = [];
  for (const p of room.players.values()) {
    players.push({ slot: p.slot, name: p.name });
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

  // Garbage collect empty rooms
  if (room.players.size === 0) {
    if (room.tickTimer) clearInterval(room.tickTimer);
    if (room.timerTimer) clearInterval(room.timerTimer);
    rooms.delete(room.name);
  }
}

function listRooms(ws) {
  const list = [];
  for (const room of rooms.values()) {
    if (room.players.size < 4) {
      list.push({
        name: room.name,
        playerCount: room.players.size,
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

  // Place rockets for each player
  // First player gets center
  const playerSlots = [];
  for (const p of room.players.values()) playerSlots.push(p.slot);
  playerSlots.sort((a, b) => a - b);

  for (let i = 0; i < playerSlots.length; i++) {
    const slot = playerSlots[i];
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
  if (room.tickCount % G.CAT_SPAWN_INTERVAL === 0) G.spawnCat(room.cats, room.mice);

  // Expire arrows
  const now = Date.now();
  room.arrows = room.arrows.filter(a => now - a.placedAt < G.ARROW_LIFETIME);

  // Broadcast tick
  broadcastToRoom(room, {
    type: 'tick',
    mice: room.mice,
    cats: room.cats,
    arrows: room.arrows,
    scores: room.scores,
    timeLeft: room.timeLeft,
    tickCount: room.tickCount,
    absorb: room.absorb,
  });
}

function endGameInRoom(room) {
  room.state = 'finished';
  if (room.tickTimer) { clearInterval(room.tickTimer); room.tickTimer = null; }
  if (room.timerTimer) { clearInterval(room.timerTimer); room.timerTimer = null; }

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
    }
  });

  ws.on('close', () => {
    leaveRoom(ws);
  });
});

server.listen(PORT, () => {
  console.log(`Chu Chu Rocket server running on http://localhost:${PORT}`);
});
