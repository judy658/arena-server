const http      = require("http");
const WebSocket = require("ws");
const WebSocketServer = WebSocket.Server;
const express   = require("express");

const port = Number(process.env.PORT || 3000);
const app  = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "ok", game: "Zortorant", uptime: process.uptime() });
});

const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

const ARENA_W       = 1280;
const ARENA_H       = 720;
const BULLET_SPEED  = 600;
const BULLET_DMG    = 20;
const MAX_HP        = 100;
const TICK_MS       = 20;
const WIN_KILLS     = 5;
const BULLET_RADIUS = 5;
const PLAYER_RADIUS = 18;

const SPAWNS = [
  { x: 100, y: 360 },
  { x: 1180, y: 360 },
];

const OBSTACLES = [
  [180, 120, 75, 150],
  [180, 450, 75, 150],
  [1025, 120, 75, 150],
  [1025, 450, 75, 150],
];

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

function playerHitsObstacle(px, py) {
  for (const obs of OBSTACLES) {
    const [ox, oy, ow, oh] = obs;
    const cx = Math.max(ox, Math.min(px, ox + ow));
    const cy = Math.max(oy, Math.min(py, oy + oh));
    const dx = px - cx;
    const dy = py - cy;
    if (dx * dx + dy * dy < PLAYER_RADIUS * PLAYER_RADIUS) return true;
  }
  return false;
}

let waitingQueue = [];  // {ws, elo} listesi
let rooms = [];

function makePlayer(ws, idx) {
  const spawn = SPAWNS[idx];
  return {
    sessionId:   ws.sessionId,
    x:           spawn.x,
    y:           spawn.y,
    angle:       0,
    hp:          MAX_HP,
    alive:       true,
    kills:       0,
    deaths:      0,
    playerIndex: idx,
    boosting:    false,
    weapon:      1,
    knifing:     false,
    frozen:      true,
    firing:      false,
    armorActive: false,
  };
}

function getState(room) {
  return {
    phase:     room.phase,
    winnerId:  room.winnerId,
    countdown: room.countdown,
    eloChange: room.eloChange || 0,
    players:   room.players,
    bullets:   room.bullets,
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

// =====================
// ROUND SİSTEMİ
// =====================
function startRoundBreak(room) {
  console.log("Round break basliyor...");
  room.phase     = "roundbreak";
  room.countdown = 3;
  room.bullets   = {};

  Object.values(room.players).forEach((p) => {
    const spawn = SPAWNS[p.playerIndex] || SPAWNS[0];
    p.x      = spawn.x;
    p.y      = spawn.y;
    p.hp     = p.maxHp || MAX_HP;
    p.alive  = true;
    p.frozen = true;
  });

  broadcast(room, { type: "state", state: getState(room) });

  let count = 3;
  const iv = setInterval(() => {
    if (room.phase === "gameover") { clearInterval(iv); return; }

    count--;
    room.countdown = count;
    broadcast(room, { type: "state", state: getState(room) });
    console.log("Countdown: " + count);

    if (count <= 0) {
      clearInterval(iv);
      room.phase     = "playing";
      room.countdown = 0;
      Object.values(room.players).forEach((p) => { p.frozen = false; });
      broadcast(room, { type: "state", state: getState(room) });
      console.log("Round basladi!");
    }
  }, 1000);
}

// =====================
// ODA
// =====================
function createRoom(clientA, clientB) {
  const room = {
    id:            Math.random().toString(36).slice(2),
    clients:       [clientA, clientB],
    players:       {},
    bullets:       {},
    phase:         "waiting",
    winnerId:      "",
    countdown:     0,
    eloChange:     10,
    bulletCounter: 0,
    lastTick:      Date.now(),
    loop:          null,
  };

  room.players[clientA.sessionId] = makePlayer(clientA, 0);
  room.players[clientB.sessionId] = makePlayer(clientB, 1);

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

  // 500ms sonra ilk round başlat
  setTimeout(() => {
    if (room.clients.length === 2) startRoundBreak(room);
  }, 500);

  return room;
}

// =====================
// OYUN DÖNGÜSÜ
// =====================
function tickRoom(room) {
  if (room.phase !== "playing") return;
  const now = Date.now();
  const dt  = (now - room.lastTick) / 1000;
  room.lastTick = now;
  // Knockback hareketi uygula
  Object.values(room.players).forEach((p) => {
    if (p.knockbackTimer > 0) {
      p.knockbackTimer -= dt;
      const spd = 1.0 - Math.max(0, p.knockbackTimer / 0.2); // yavaşla
      const kx = (p.knockbackX || 0) * dt * (1 - spd * 0.5);
      const ky = (p.knockbackY || 0) * dt * (1 - spd * 0.5);
      p.x = Math.max(PLAYER_RADIUS, Math.min(ARENA_W - PLAYER_RADIUS, p.x + kx));
      p.y = Math.max(PLAYER_RADIUS, Math.min(ARENA_H - PLAYER_RADIUS, p.y + ky));
      if (p.knockbackTimer <= 0) {
        p.knockbackX = 0; p.knockbackY = 0;
      }
    }
  });
  moveBullets(room, dt);
  broadcast(room, { type: "state", state: getState(room) });
}

function applyDamage(room, target, attacker, dmg) {
  // Zırh aktifse hasarı yansıt
  if (target.armorActive && attacker) {
    const REFLECT = 20;
    attacker.hp -= REFLECT;
    if (attacker.hp <= 0) {
      attacker.hp = 0; attacker.alive = false; attacker.deaths++;
      target.kills++;
      if (target.kills >= WIN_KILLS) {
        room.phase = "gameover"; room.winnerId = target.sessionId;
        clearInterval(room.loop);
        broadcast(room, { type: "state", state: getState(room) });
        return false;
      }
      startRoundBreak(room);
      return false;
    }
    return false; // hasar yansıdı, hedefe gitmedi
  }
  // Normal hasar
  target.hp -= dmg;
  if (target.hp <= 0) {
    target.hp = 0; target.alive = false; target.deaths++;
    if (attacker) {
      attacker.kills++;
      if (attacker.kills >= WIN_KILLS) {
        room.phase = "gameover"; room.winnerId = attacker.sessionId;
        clearInterval(room.loop);
        broadcast(room, { type: "state", state: getState(room) });
        return false;
      }
    }
    startRoundBreak(room);
    return false;
  }
  return true;
}

function moveBullets(room, dt) {
  const toRemove = [];

  Object.entries(room.bullets).forEach(([bid, b]) => {
    b.x += b.vx * dt;
    b.y += b.vy * dt;

    if (b.x < 0 || b.x > ARENA_W || b.y < 0 || b.y > ARENA_H) {
      toRemove.push(bid); return;
    }
    if (bulletHitsObstacle(b.x, b.y)) {
      toRemove.push(bid); return;
    }

    Object.values(room.players).forEach((p) => {
      if (!p.alive || p.sessionId === b.ownerId) return;
      const dx = p.x - b.x, dy = p.y - b.y;
      if (Math.sqrt(dx*dx+dy*dy) < PLAYER_RADIUS + BULLET_RADIUS) {
        toRemove.push(bid);
        const killer = room.players[b.ownerId];
        applyDamage(room, p, killer, BULLET_DMG);
      }
    });
  });

  toRemove.forEach((bid) => delete room.bullets[bid]);
}

// =====================
// WEBSOCKET
// =====================
let sessionCounter = 0;

wss.on("connection", (ws) => {
  ws.sessionId = "p" + (++sessionCounter);
  ws.room      = null;
  console.log("Baglandi: " + ws.sessionId);

  const myElo = ws.elo || 0;
  
  // Kuyruktaki en yakın elolu rakibi bul
  let bestMatch = -1;
  let bestDiff  = Infinity;
  for (let i = 0; i < waitingQueue.length; i++) {
    const entry = waitingQueue[i];
    if (entry.ws.readyState !== entry.ws.OPEN) {
      waitingQueue.splice(i, 1); i--; continue;
    }
    const diff = Math.abs((entry.elo || 0) - myElo);
    if (diff < bestDiff) { bestDiff = diff; bestMatch = i; }
  }

  if (bestMatch >= 0) {
    const opponent = waitingQueue.splice(bestMatch, 1)[0];
    const room = createRoom(opponent.ws, ws);
    ws.room           = room;
    opponent.ws.room  = room;
  } else {
    waitingQueue.push({ ws, elo: myElo });
    send(ws, { type: "waiting", message: "Rakip aranıyor..." });
  }

  ws.on("message", (data) => {
    const room = ws.room;
    if (!room) return;

    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    const p = room.players[ws.sessionId];
    if (!p) return;

    if (msg.type === "elo") {
      ws.elo = msg.elo || 0;
      console.log(ws.sessionId + " elo: " + ws.elo);
    }

    if (msg.type === "character") {
      const maxHp = msg.characterId === "inferno" ? 120 : 100;
      p.maxHp      = maxHp;
      p.hp         = maxHp;
      p.characterId = msg.characterId || "murffy";
      console.log(ws.sessionId + " karakter: " + msg.characterId + " HP: " + maxHp);
    }

    if (msg.type === "move") {
      if (!p.frozen) {
        const nx = Math.max(PLAYER_RADIUS, Math.min(ARENA_W - PLAYER_RADIUS, msg.x));
        const ny = Math.max(PLAYER_RADIUS, Math.min(ARENA_H - PLAYER_RADIUS, msg.y));
        if (!playerHitsObstacle(nx, ny)) { p.x = nx; p.y = ny; }
      }
      p.angle       = msg.angle;
      p.boosting    = msg.boosting || false;
      p.weapon      = msg.weapon !== undefined ? msg.weapon : 1;
      p.knifing     = msg.knifing || false;
      p.armorActive = msg.armorActive || false;
      p.firing      = msg.firing || false;
    }

    if (msg.type === "shoot" && p.alive && !p.frozen && room.phase === "playing") {
      const bid = "b" + (++room.bulletCounter);
      room.bullets[bid] = {
        id: bid, ownerId: ws.sessionId,
        x: msg.x, y: msg.y,
        vx: Math.cos(msg.angle) * BULLET_SPEED,
        vy: Math.sin(msg.angle) * BULLET_SPEED,
      };
    }

    if (msg.type === "knife" && p.alive && !p.frozen && room.phase === "playing") {
      const KNIFE_RANGE = 60, KNIFE_DAMAGE = 70;
      Object.values(room.players).forEach((target) => {
        if (!target.alive || target.sessionId === ws.sessionId) return;
        const dx = target.x - msg.x, dy = target.y - msg.y;
        if (Math.sqrt(dx*dx+dy*dy) > KNIFE_RANGE + PLAYER_RADIUS) return;
        let angleDiff = Math.atan2(dy, dx) - msg.angle;
        while (angleDiff >  Math.PI) angleDiff -= 2*Math.PI;
        while (angleDiff < -Math.PI) angleDiff += 2*Math.PI;
        if (Math.abs(angleDiff) > Math.PI/3) return;
        applyDamage(room, target, p, KNIFE_DAMAGE);
      });
    }

    // Inferno - Alev Silahı (sürekli hasar)
    if (msg.type === "inferno_flame" && p.alive && !p.frozen && room.phase === "playing") {
      const range = msg.range || 80;
      const dmg   = msg.damage || 2;
      Object.values(room.players).forEach((target) => {
        if (!target.alive || target.sessionId === ws.sessionId) return;
        const dx = target.x - msg.x, dy = target.y - msg.y;
        const dist = Math.sqrt(dx*dx + dy*dy);
        if (dist > range + PLAYER_RADIUS) return;
        // Açı kontrolü - sadece önde olanı yakar
        let angleDiff = Math.atan2(dy, dx) - msg.angle;
        while (angleDiff >  Math.PI) angleDiff -= 2*Math.PI;
        while (angleDiff < -Math.PI) angleDiff += 2*Math.PI;
        if (Math.abs(angleDiff) > Math.PI / 2.5) return;
        applyDamage(room, target, p, dmg);
      });
    }

    // Inferno - Alev Patlaması (AOE)
    if (msg.type === "inferno_blast" && p.alive && !p.frozen && room.phase === "playing") {
      const range = msg.range || 120;
      const dmg   = msg.damage || 50;
      const KNOCKBACK_FORCE = 180; // piksel savurma
      // Blast yapanı blasting olarak işaretle (animasyon için)
      p.blasting = true;
      setTimeout(() => { if (p) p.blasting = false; }, 400);
      Object.values(room.players).forEach((target) => {
        if (!target.alive || target.sessionId === ws.sessionId) return;
        const dx = target.x - msg.x, dy = target.y - msg.y;
        const dist = Math.sqrt(dx*dx + dy*dy);
        if (dist > range + PLAYER_RADIUS) return;
        // Knockback — merkezden dışa doğru it
        const nx = dist > 0 ? dx / dist : 1;
        const ny = dist > 0 ? dy / dist : 0;
        const force = (1 - dist / (range + PLAYER_RADIUS)) * KNOCKBACK_FORCE;
        target.knockbackX = (target.knockbackX || 0) + nx * force;
        target.knockbackY = (target.knockbackY || 0) + ny * force;
        target.knockbackTimer = 0.2; // 200ms savurma
        applyDamage(room, target, p, dmg);
      });
    }
  });

  ws.on("close", () => {
    console.log("Ayrildi: " + ws.sessionId);
    // Kuyruktan çıkar
    const qi = waitingQueue.findIndex(e => e.ws === ws);
    if (qi >= 0) waitingQueue.splice(qi, 1);
    const room = ws.room;
    if (room && room.phase !== "gameover") {
      room.phase = "gameover";
      clearInterval(room.loop);
      broadcast(room, { type: "state", state: getState(room) });
    }
  });

  ws.on("error", (err) => console.error("WS hatasi: " + err.message));
});

server.listen(port, () => {
  console.log("Zortorant sunucu " + port + " portunda calisiyor");
});