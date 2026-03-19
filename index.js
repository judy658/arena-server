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

// Yük durumu endpoint'i — load balancing için
app.get("/status", (req, res) => {
  const playerCount = rooms.reduce((n, r) => n + r.clients.filter(c => c.readyState === c.OPEN).length, 0);
  const roomCount   = rooms.filter(r => r.phase !== "gameover").length;
  res.json({
    status:   "ok",
    players:  playerCount,
    rooms:    roomCount,
    capacity: 60,
    full:     playerCount >= 60,
  });
});

const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

const ARENA_W_SMALL = 1280;
const ARENA_H_SMALL = 720;
const ARENA_W_MEGA  = 3840;
const ARENA_H_MEGA  = 2160;
const BULLET_SPEED  = 600;
const BULLET_DMG    = 20;
const MAX_HP        = 100;
const TICK_MS       = 20;
const WIN_KILLS     = 5;
const BULLET_RADIUS = 5;
const PLAYER_RADIUS = 18;

const SPAWNS_SMALL = [
  { x: 100,  y: 360 },
  { x: 1180, y: 360 },
];
const SPAWNS_MEGA = [
  { x: 144,  y: 975 },
  { x: 3696, y: 975 },
];

const DOORS_MEGA = [
  { x: 1846, y: 668,  w: 145, h: 14 },  // üst kapı
  { x: 1846, y: 1536, w: 145, h: 14 },  // alt kapı
];

const SAND_CIRCLES_MEGA = [
  { x: 857,  y: 383,  r: 171 },
  { x: 2980, y: 383,  r: 171 },
  { x: 857,  y: 1773, r: 171 },
  { x: 2980, y: 1773, r: 171 },
];

const OBSTACLES_SMALL = [
  [180, 120, 75, 150],
  [180, 450, 75, 150],
  [1025, 120, 75, 150],
  [1025, 450, 75, 150],
];
const OBSTACLES_MEGA = [
  [408,  767,  58,  661],
  [870,  661,  100, 344],
  [870,  1111, 100, 344],
  [1516, 145,  100, 344],
  [2162, 145,  100, 344],
  [1516, 1654, 100, 344],
  [2162, 1654, 100, 344],
  [2861, 661,  100, 344],
  [2861, 1111, 100, 344],
  [3375, 767,  58,  661],
  [1556, 675,  290, 74],
  [1556, 1469, 290, 74],
  [1556, 675,  73,  868],
  [1991, 675,  290, 74],
  [1991, 1469, 290, 74],
  [2207, 675,  73,  868],
];
let OBSTACLES = OBSTACLES_SMALL;

function bulletHitsObstacle(bx, by, obstacles = OBSTACLES_SMALL, doors = [], doorsOpen = true) {
  for (const obs of obstacles) {
    const [ox, oy, ow, oh] = obs;
    if (bx + BULLET_RADIUS > ox && bx - BULLET_RADIUS < ox + ow &&
        by + BULLET_RADIUS > oy && by - BULLET_RADIUS < oy + oh) {
      return true;
    }
  }
  // Kapı kapalıysa mermi geçemesin
  if (!doorsOpen) {
    for (const d of doors) {
      if (bx + BULLET_RADIUS > d.x && bx - BULLET_RADIUS < d.x + d.w &&
          by + BULLET_RADIUS > d.y && by - BULLET_RADIUS < d.y + d.h) {
        return true;
      }
    }
  }
  return false;
}

function rayHitsObstacle(x1, y1, x2, y2, obstacles = OBSTACLES_SMALL) {
  const STEPS = 10;
  for (let i = 1; i <= STEPS; i++) {
    const t  = i / STEPS;
    const rx = x1 + (x2 - x1) * t;
    const ry = y1 + (y2 - y1) * t;
    for (const obs of obstacles) {
      const [ox, oy, ow, oh] = obs;
      if (rx > ox && rx < ox + ow && ry > oy && ry < oy + oh) return true;
    }
  }
  return false;
}

function playerHitsObstacle(px, py, radius = PLAYER_RADIUS, obstacles = OBSTACLES_SMALL) {
  for (const obs of obstacles) {
    const [ox, oy, ow, oh] = obs;
    const cx = Math.max(ox, Math.min(px, ox + ow));
    const cy = Math.max(oy, Math.min(py, oy + oh));
    const dx = px - cx;
    const dy = py - cy;
    if (dx * dx + dy * dy < radius * radius) return true;
  }
  return false;
}

// Her mod için ayrı kuyruk: { ws, elo }
const waitingQueues = {
  duel:      [],   // Normal Düello
  mega_duel: [],   // Mega Düello
};
let rooms = [];

function makePlayer(ws, idx, isMega = false) {
  const spawns = isMega ? SPAWNS_MEGA : SPAWNS_SMALL;
  const spawn = spawns[idx] || spawns[0];
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
    doorsOpen: room.doorsOpen || false,
    winnerId:  room.winnerId,
    countdown: room.countdown,
    shopTimer: room.shopTimer || 0,
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
  room.countdown = 0;
  room.shopTimer = 0;
  room.bullets   = {};

  Object.values(room.players).forEach((p) => {
    const spawnList = room.isMega ? SPAWNS_MEGA : SPAWNS_SMALL;
    const spawn = spawnList[p.playerIndex] || spawnList[0];
    p.x      = spawn.x;
    p.y      = spawn.y;
    p.hp     = p.maxHp || MAX_HP;
    p.alive  = true;
    p.frozen = true;
  });

  broadcast(room, { type: "state", state: getState(room) });

  // 3 saniye "SONRAKİ ROUND" göster, sonra 8'den geri say
  setTimeout(() => {
    if (room.phase === "gameover") return;

    let count = 8;
    room.shopTimer = count;
    broadcast(room, { type: "state", state: getState(room) });

    const iv = setInterval(() => {
      if (room.phase === "gameover") { clearInterval(iv); return; }
      count--;
      room.shopTimer = count;
      broadcast(room, { type: "state", state: getState(room) });
      console.log("Countdown: " + count);

      if (count <= 0) {
        clearInterval(iv);
        room.phase     = "playing";
        room.shopTimer = 0;
        Object.values(room.players).forEach((p) => { p.frozen = false; });
        broadcast(room, { type: "state", state: getState(room) });
        console.log("Round basladi!");
      }
    }, 1000);
  }, 3000);
}

// =====================
// ODA
// =====================
function createRoom(clientA, clientB, mode = "duel") {
  const isMega = mode === "mega_duel";
  const room = {
    id:            Math.random().toString(36).slice(2),
    clients:       [clientA, clientB],
    players:       {},
    bullets:       {},
    phase:         "waiting",
    doorsOpen:     false,
    winnerId:      "",
    countdown:     0,
    eloChange:     10,
    bulletCounter: 0,
    lastTick:      Date.now(),
    loop:          null,
    isMega:        isMega,
    arenaW:        isMega ? ARENA_W_MEGA : ARENA_W_SMALL,
    arenaH:        isMega ? ARENA_H_MEGA : ARENA_H_SMALL,
    winKills:      WIN_KILLS,
    obstacles:     isMega ? OBSTACLES_MEGA : OBSTACLES_SMALL,
  };

  room.players[clientA.sessionId] = makePlayer(clientA, 0, isMega);
  room.players[clientB.sessionId] = makePlayer(clientB, 1, isMega);

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
  // startRoundBreak mod mesajı gelince tetiklenecek

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
      p.x = Math.max(PLAYER_RADIUS, Math.min((room.arenaW || ARENA_W_SMALL) - PLAYER_RADIUS, p.x + kx));
      p.y = Math.max(PLAYER_RADIUS, Math.min((room.arenaH || ARENA_H_SMALL) - PLAYER_RADIUS, p.y + ky));
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
      if (target.kills >= (room.winKills || WIN_KILLS)) {
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
      if (attacker.kills >= (room.winKills || WIN_KILLS)) {
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

    if (b.x < 0 || b.x > room.arenaW || b.y < 0 || b.y > room.arenaH) {
      toRemove.push(bid); return;
    }
    const doors = room.isMega ? DOORS_MEGA : [];
    if (bulletHitsObstacle(b.x, b.y, room.obstacles || OBSTACLES_SMALL, doors, room.doorsOpen !== false)) {
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

function tryMatchmaking(ws, mode) {
  const queue = waitingQueues[mode];
  if (!queue) return;

  const myElo = ws.elo || 0;

  // Aynı moddaki kuyruktaki en yakın elolu rakibi bul
  let bestMatch = -1;
  let bestDiff  = Infinity;
  for (let i = 0; i < queue.length; i++) {
    const entry = queue[i];
    if (entry.ws === ws) continue;
    if (entry.ws.readyState !== entry.ws.OPEN) {
      queue.splice(i, 1); i--; continue;
    }
    const diff = Math.abs((entry.elo || 0) - myElo);
    if (diff < bestDiff) { bestDiff = diff; bestMatch = i; }
  }

  if (bestMatch >= 0) {
    const opponent = queue.splice(bestMatch, 1)[0];
    const room = createRoom(opponent.ws, ws, mode);
    ws.room          = room;
    opponent.ws.room = room;
    console.log("Eslestirme: " + ws.sessionId + " vs " + opponent.ws.sessionId + " | mod: " + mode);
  } else {
    queue.push({ ws, elo: myElo });
    send(ws, { type: "waiting", message: "Rakip aranıyor..." });
    console.log("Kuyruga eklendi: " + ws.sessionId + " | mod: " + mode);
  }
}

wss.on("connection", (ws) => {
  ws.sessionId = "p" + (++sessionCounter);
  ws.room      = null;
  ws.mode      = null;
  console.log("Baglandi: " + ws.sessionId);
  // Mod bilgisi gelene kadar bekle — matchmaking "search" mesajında tetiklenir

  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    if (msg.type === "ping") {
      send(ws, { type: "pong", t: msg.t });
      return;
    }

    // --- Maç arama: mod bilgisiyle kuyruğa gir ---
    if (msg.type === "search") {
      if (ws.room) return; // zaten odada
      const mode = msg.mode === "mega_duel" ? "mega_duel" : "duel";
      ws.mode = mode;
      ws.elo  = msg.elo || 0;
      tryMatchmaking(ws, mode);
      return;
    }

    // Bundan sonraki mesajlar oda gerektirir
    const room = ws.room;
    if (!room) return;
    const p = room.players[ws.sessionId];
    if (!p) return;

    if (msg.type === "mode") {
      // Artık sadece win_kills güncellemesi için kullanılıyor,
      // isMega/arenaW/obstacles createRoom'da zaten doğru set edildi.
      room.winKills = msg.win_kills || WIN_KILLS;
      if (room.phase === "waiting") startRoundBreak(room);
      console.log("win_kills guncellendi: " + room.winKills);
    }

    if (msg.type === "door") {
      room.doorsOpen = msg.open === true;
      broadcast(room, { type: "state", state: getState(room) });
    }

    if (msg.type === "elo") {
      ws.elo = msg.elo || 0;
      console.log(ws.sessionId + " elo: " + ws.elo);
    }

    if (msg.type === "character") {
      const maxHp = msg.characterId === "inferno" ? 120 : 100;
      p.maxHp       = maxHp;
      p.hp          = maxHp;
      p.characterId = msg.characterId || "murffy";
      console.log(ws.sessionId + " karakter: " + msg.characterId + " HP: " + maxHp);
    }

    if (msg.type === "move") {
      if (!p.frozen) {
        const pr  = p.characterId === "inferno" ? 32 : PLAYER_RADIUS;
        const arW = room.arenaW || ARENA_W_SMALL;
        const arH = room.arenaH || ARENA_H_SMALL;
        const nx  = Math.max(pr, Math.min(arW - pr, msg.x));
        const ny  = Math.max(pr, Math.min(arH - pr, msg.y));
        if (!playerHitsObstacle(nx, ny, pr, room.obstacles || OBSTACLES_SMALL)) {
          // Kum alanı hız kontrolü (sadece mega modda)
          if (room.isMega) {
            const BASE_SPEED   = 250;
            const SAND_MULT    = 0.45;
            const BOOST_MULT   = p.boosting ? 2.0 : 1.0;
            const CHAR_MULT    = p.characterId === "inferno" ? 0.8 : 1.0;
            const inSand       = SAND_CIRCLES_MEGA.some(sc => {
              const dx = nx - sc.x, dy = ny - sc.y;
              return dx*dx + dy*dy < sc.r * sc.r;
            });
            const maxSpeed = BASE_SPEED * CHAR_MULT * (inSand ? SAND_MULT : 1.0) * BOOST_MULT;
            const dx = nx - p.x, dy = ny - p.y;
            const dist = Math.sqrt(dx*dx + dy*dy);
            // Tick başına max hareket mesafesi (TICK_MS/1000 saniye)
            const maxDist = maxSpeed * (TICK_MS / 1000) * 6; // 6 tick tolerans
            if (dist <= maxDist + pr) {
              p.x = nx; p.y = ny;
            } else {
              // Çok hızlı gitmeye çalışıyorsa kum yönünde sınırla
              p.x = p.x + (dx / dist) * maxDist;
              p.y = p.y + (dy / dist) * maxDist;
            }
          } else {
            p.x = nx; p.y = ny;
          }
        }
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
        if (rayHitsObstacle(msg.x, msg.y, target.x, target.y, room.obstacles || OBSTACLES_SMALL)) return;
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
    // Tüm mod kuyruklarından çıkar
    for (const queue of Object.values(waitingQueues)) {
      const qi = queue.findIndex(e => e.ws === ws);
      if (qi >= 0) queue.splice(qi, 1);
    }
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