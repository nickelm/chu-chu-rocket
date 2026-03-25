// Shared game logic for Chu Chu Rocket — used by both server and client.
// UMD wrapper: Node.js gets module.exports, browser gets window.GameLogic.
(function(exports) {

// ── Constants ──────────────────────────────────────────────
const COLS = 12, ROWS = 9;
const TICK_MS = 500;
const GAME_TIME = 300;
const MAX_MICE = 100;
const MAX_CATS = 8;
const MOUSE_SPAWN_INTERVAL = 3;
const CAT_SPAWN_INTERVAL = 25;
const CAT_PENALTY = 5;
const MAX_ARROWS = 5;
const ARROW_LIFETIME = 20000;
const ARROW_LOCK_TIME = 5000;

const DIR = { UP: 0, RIGHT: 1, DOWN: 2, LEFT: 3 };
const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];

const SPAWN_POINTS = [
  { r:0, c:0, dir:DIR.RIGHT }, { r:0, c:11, dir:DIR.DOWN },
  { r:8, c:0, dir:DIR.UP },    { r:8, c:11, dir:DIR.LEFT },
  { r:0, c:5, dir:DIR.DOWN },  { r:4, c:0, dir:DIR.RIGHT },
  { r:8, c:6, dir:DIR.UP },    { r:4, c:11, dir:DIR.LEFT },
  { r:0, c:3, dir:DIR.DOWN },  { r:0, c:9, dir:DIR.LEFT },
  { r:8, c:3, dir:DIR.RIGHT }, { r:8, c:9, dir:DIR.UP },
];

const CAT_SPAWN_POINTS = [
  { r:0, c:0, dir:DIR.DOWN },  { r:0, c:11, dir:DIR.LEFT },
  { r:8, c:0, dir:DIR.RIGHT }, { r:8, c:11, dir:DIR.UP },
];

// ── Walls ──────────────────────────────────────────────────
function addWall(walls, r, c, dir) {
  walls.add(`${r},${c},${dir}`);
  const nr = r + DY[dir], nc = c + DX[dir];
  if (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS) {
    walls.add(`${nr},${nc},${(dir + 2) % 4}`);
  }
}

function hasWall(walls, r, c, dir) {
  const nr = r + DY[dir], nc = c + DX[dir];
  if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) return true;
  return walls.has(`${r},${c},${dir}`);
}

function initWalls() {
  const walls = new Set();
  addWall(walls, 2, 3, DIR.DOWN); addWall(walls, 2, 4, DIR.DOWN);
  addWall(walls, 4, 7, DIR.DOWN); addWall(walls, 4, 8, DIR.DOWN);
  addWall(walls, 6, 2, DIR.RIGHT); addWall(walls, 7, 2, DIR.RIGHT);
  addWall(walls, 1, 9, DIR.DOWN);
  addWall(walls, 5, 5, DIR.RIGHT); addWall(walls, 5, 5, DIR.DOWN);
  addWall(walls, 3, 0, DIR.RIGHT);
  addWall(walls, 6, 10, DIR.DOWN);
  return walls;
}

// ── Arrow helpers ──────────────────────────────────────────
function buildArrowMap(arrows) {
  const m = {};
  for (const a of arrows) m[`${a.r},${a.c}`] = a.dir;
  return m;
}

function getMostRecentArrow(arrows, playerId) {
  const mine = arrows.filter(a => a.owner === playerId);
  if (mine.length === 0) return null;
  return mine.reduce((a, b) => a.placedAt > b.placedAt ? a : b);
}

// ── Entity movement ────────────────────────────────────────
// turnOnWall: +1 for mice (turn right), +3 for cats (turn left)
function moveEntity(entity, arrowMap, walls, turnOnWall) {
  entity.prevR = entity.r;
  entity.prevC = entity.c;
  const key = `${entity.r},${entity.c}`;
  if (arrowMap[key] !== undefined) entity.dir = arrowMap[key];
  if (!hasWall(walls, entity.r, entity.c, entity.dir)) {
    entity.r += DY[entity.dir];
    entity.c += DX[entity.dir];
  } else {
    entity.dir = (entity.dir + turnOnWall) % 4;
  }
}

// ── Spawning ───────────────────────────────────────────────
function spawnMouse(mice, cats) {
  if (mice.length >= MAX_MICE) return null;
  const shuffled = [...SPAWN_POINTS].sort(() => Math.random() - 0.5);
  for (const sp of shuffled) {
    if (!mice.some(m => m.r === sp.r && m.c === sp.c) &&
        !cats.some(c => c.r === sp.r && c.c === sp.c)) {
      const mouse = { r: sp.r, c: sp.c, dir: sp.dir, prevR: sp.r, prevC: sp.c, id: Math.random() };
      mice.push(mouse);
      return mouse;
    }
  }
  return null;
}

function spawnCat(cats, mice) {
  if (cats.length >= MAX_CATS) return null;
  const shuffled = [...CAT_SPAWN_POINTS].sort(() => Math.random() - 0.5);
  for (const sp of shuffled) {
    if (!cats.some(c => c.r === sp.r && c.c === sp.c) &&
        !mice.some(m => m.r === sp.r && m.c === sp.c)) {
      const cat = { r: sp.r, c: sp.c, dir: sp.dir, prevR: sp.r, prevC: sp.c, id: Math.random() };
      cats.push(cat);
      return cat;
    }
  }
  return null;
}

// ── Exports ────────────────────────────────────────────────
exports.COLS = COLS;
exports.ROWS = ROWS;
exports.TICK_MS = TICK_MS;
exports.GAME_TIME = GAME_TIME;
exports.MAX_MICE = MAX_MICE;
exports.MAX_CATS = MAX_CATS;
exports.MOUSE_SPAWN_INTERVAL = MOUSE_SPAWN_INTERVAL;
exports.CAT_SPAWN_INTERVAL = CAT_SPAWN_INTERVAL;
exports.CAT_PENALTY = CAT_PENALTY;
exports.MAX_ARROWS = MAX_ARROWS;
exports.ARROW_LIFETIME = ARROW_LIFETIME;
exports.ARROW_LOCK_TIME = ARROW_LOCK_TIME;
exports.DIR = DIR;
exports.DX = DX;
exports.DY = DY;
exports.SPAWN_POINTS = SPAWN_POINTS;
exports.CAT_SPAWN_POINTS = CAT_SPAWN_POINTS;
exports.addWall = addWall;
exports.hasWall = hasWall;
exports.initWalls = initWalls;
exports.buildArrowMap = buildArrowMap;
exports.getMostRecentArrow = getMostRecentArrow;
exports.moveEntity = moveEntity;
exports.spawnMouse = spawnMouse;
exports.spawnCat = spawnCat;

})(typeof module !== 'undefined' ? module.exports : (window.GameLogic = {}));
