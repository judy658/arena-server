const http      = require("http");
const WebSocket = require("ws");
const WebSocketServer = WebSocket.Server;
const express   = require("express");

const port = Number(process.env.PORT || 3000);
const app  = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "ok", game: "Arena 1v1", uptime: process.uptime() });
});

const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

// --- SABİTLER ---
const ARENA_W       = 1280;
const ARENA_H       = 720;
const BULLET_SPEED  = 600;
const BULLET_DMG    = 20;
const MAX_HP        = 100;
const TICK_MS       = 20;
const RESPAWN_MS    = 3000;
const WIN_KILLS     = 5;
const BULLET_RADIUS = 5;
const PLAYER_RADIUS = 18;

const SPAWNS = [
  { x: 100, y: 360 },
  { x: 1180, y: 360 },
];

// Engeller: [x, y, genislik, yukseklik]
const OBSTACLES = [
  [180, 120, 75, 150],
  [180, 450, 75, 150],
  [1025, 120, 75, 150],
  [1025, 450, 75, 150],
];

// AABB - nokta çarpışma kontrolü (mermi için)
function bulletHitsObstacle(bx, by) {
  for (const obs of OBSTACLES) {
    const [ox, oy, ow, oh] = obs;
    if (bx + BULLET_RADIUS > ox && bx - BULLET_RADIUS < ox + ow &&
        by + BULLET_RADIUS > oy && by - BULLET_RADIUS < oy + oh) {
      return true;
    }
  }
  return false;
}

// AABB - daire çarpışma (oyuncu için)
function playerHitsObstacle(px, py) {
  for (const obs of OBSTACLES) {
    const [ox, oy, ow, oh] = obs;
    const cx = Math.max(ox, Math.min(px, ox + ow));
    const cy = Math.max(oy, Math.min(py, oy + oh));
    const dx = px - cx;
    const dy = py - cy;
    if (dx * dx + dy * dy < PLAYER_RADIUS * PLAYER_RADIUS) {
      return true;
    }
  }
  return false;
}

// --- ODA YÖNETİMİ ---
let waitingClient = null;
let rooms = [];

function createRoom(clientA, clientB) {
  const room = {
    id: Math.random().toString(36).slice(2),
    clients: [clientA, clientB],
    players: {},
    bullets: {},
    phase: "playing",
    winnerId: "",
    bulletCounter: 0,
    lastTick: Date.now(),
    loop: null,
  };

  [clientA, clientB].forEach((ws, idx) => {
    const spawn = SPAWNS[idx];
    room.players[ws.sessionId] = {
      sessionId:   ws.sessionId,
      x:           spawn.x,
      y:           spawn.y,
      angle:       0,
      hp:          MAX_HP,
      alive:       true,
      kills:       0,
      deaths:      0,
      playerIndex: idx,
    };
  });

  [clientA, clientB].forEach((ws, idx) => {
    send(ws, {
      type:        "joined",
      sessionId:   ws.sessionId,
      playerIndex: idx,
      state:       getState(room),
    });
  });

  room.loop = setInterval(() => tickRoom(room), TICK_MS);
  rooms.push(room);
  console.log("Oda olusturuldu: " + room.id);
  return room;
}

function getState(room) {
  return {
    phase:    room.phase,
    winnerId: room.winnerId,
    players:  room.players,
    bullets:  room.bullets,
  };
}

function broadcast(room, msg) {
  const str = JSON.stringify(msg);
  room.clients.forEach((ws) => {
    if (ws.readyState === ws.OPEN) ws.send(str);
  });
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

// --- OYUN DÖNGÜSÜ ---
function tickRoom(room) {
  if (room.phase !== "playing") return;
  const now = Date.now();
  const dt  = (now - room.lastTick) / 1000;
  room.lastTick = now;
  moveBullets(room, dt);
  broadcast(room, { type: "state", state: getState(room) });
}

function moveBullets(room, dt) {
  const toRemove = [];

  Object.entries(room.bullets).forEach(([bid, b]) => {
    b.x += b.vx * dt;
    b.y += b.vy * dt;

    // Arena dışı
    if (b.x < 0 || b.x > ARENA_W || b.y < 0 || b.y > ARENA_H) {
      toRemove.push(bid);
      return;
    }

    // Engele çarptı mı?
    if (bulletHitsObstacle(b.x, b.y)) {
      toRemove.push(bid);
      return;
    }

    // Oyuncuya çarptı mı?
    Object.values(room.players).forEach((p) => {
      if (!p.alive || p.sessionId === b.ownerId) return;
      const dx   = p.x - b.x;
      const dy   = p.y - b.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < PLAYER_RADIUS + BULLET_RADIUS) {
        p.hp -= BULLET_DMG;
        toRemove.push(bid);
        if (p.hp <= 0) {
          p.hp    = 0;
          p.alive = false;
          p.deaths++;
          const killer = room.players[b.ownerId];
          if (killer) {
            killer.kills++;
            if (killer.kills >= WIN_KILLS) {
              room.phase    = "gameover";
              room.winnerId = killer.sessionId;
              clearInterval(room.loop);
              broadcast(room, { type: "state", state: getState(room) });
              return;
            }
          }
          const pRef = p;
          setTimeout(() => {
            if (room.phase !== "playing") return;
            const spawn = SPAWNS[pRef.playerIndex] || SPAWNS[0];
            pRef.x     = spawn.x;
            pRef.y     = spawn.y;
            pRef.hp    = MAX_HP;
            pRef.alive = true;
          }, RESPAWN_MS);
        }
      }
    });
  });

  toRemove.forEach((bid) => delete room.bullets[bid]);
}

// --- WEBSOCKET ---
let sessionCounter = 0;

wss.on("connection", (ws) => {
  ws.sessionId = "p" + (++sessionCounter);
  ws.room      = null;
  console.log("Baglandi: " + ws.sessionId);

  if (waitingClient && waitingClient.readyState === waitingClient.OPEN) {
    const room = createRoom(waitingClient, ws);
    ws.room            = room;
    waitingClient.room = room;
    waitingClient      = null;
  } else {
    waitingClient = ws;
    send(ws, { type: "waiting", message: "Rakip bekleniyor..." });
  }

  ws.on("message", (data) => {
    const room = ws.room;
    if (!room || room.phase !== "playing") return;
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    const p = room.players[ws.sessionId];
    if (!p) return;

    if (msg.type === "move" && p.alive) {
      const nx = Math.max(PLAYER_RADIUS, Math.min(ARENA_W - PLAYER_RADIUS, msg.x));
      const ny = Math.max(PLAYER_RADIUS, Math.min(ARENA_H - PLAYER_RADIUS, msg.y));
      // Engel kontrolü sunucu tarafında da yap
      if (!playerHitsObstacle(nx, ny)) {
        p.x = nx;
        p.y = ny;
      }
      p.angle = msg.angle;
    }

    if (msg.type === "shoot" && p.alive) {
      const bid = "b" + (++room.bulletCounter);
      room.bullets[bid] = {
        id:      bid,
        ownerId: ws.sessionId,
        x:       msg.x,
        y:       msg.y,
        vx:      Math.cos(msg.angle) * BULLET_SPEED,
        vy:      Math.sin(msg.angle) * BULLET_SPEED,
      };
    }
  });

  ws.on("close", () => {
    console.log("Ayrildi: " + ws.sessionId);
    if (waitingClient === ws) waitingClient = null;
    const room = ws.room;
    if (room && room.phase === "playing") {
      room.phase = "gameover";
      clearInterval(room.loop);
      broadcast(room, { type: "state", state: getState(room) });
    }
  });

  ws.on("error", (err) => console.error("WS hatasi: " + err.message));
});

server.listen(port, () => {
  console.log("Arena sunucu " + port + " portunda calisiyor");
});
