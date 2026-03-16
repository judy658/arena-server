const { Room } = require("colyseus");
const { Schema, MapSchema, type } = require("@colyseus/schema");

// --- SCHEMA SINIFLARI ---

class Bullet extends Schema {}
type("string")(Bullet.prototype, "id");
type("string")(Bullet.prototype, "ownerId");
type("float32")(Bullet.prototype, "x");
type("float32")(Bullet.prototype, "y");
type("float32")(Bullet.prototype, "vx");
type("float32")(Bullet.prototype, "vy");

class Player extends Schema {}
type("string")(Player.prototype, "sessionId");
type("float32")(Player.prototype, "x");
type("float32")(Player.prototype, "y");
type("float32")(Player.prototype, "angle");
type("int32")(Player.prototype, "hp");
type("boolean")(Player.prototype, "alive");
type("int32")(Player.prototype, "kills");
type("int32")(Player.prototype, "deaths");
type("int8")(Player.prototype, "playerIndex");

class ArenaState extends Schema {}
type({ map: Player })(ArenaState.prototype, "players");
type({ map: Bullet })(ArenaState.prototype, "bullets");
type("string")(ArenaState.prototype, "phase");
type("string")(ArenaState.prototype, "winnerId");

// --- SABİTLER ---
const ARENA_W       = 800;
const ARENA_H       = 600;
const BULLET_SPEED  = 600;   // px/sn
const BULLET_DMG    = 20;
const MAX_HP        = 100;
const TICK_MS       = 20;    // 50Hz sunucu döngüsü
const RESPAWN_MS    = 3000;
const WIN_KILLS     = 5;
const BULLET_RADIUS = 5;
const PLAYER_RADIUS = 18;

const SPAWNS = [
  { x: 150, y: 300 },
  { x: 650, y: 300 },
];

// --- ODA ---

class ArenaRoom extends Room {
  onCreate(options) {
    const state = new ArenaState();
    state.players  = new MapSchema();
    state.bullets  = new MapSchema();
    state.phase    = "waiting";
    state.winnerId = "";
    this.setState(state);
    this.setPatchRate(TICK_MS);

    this.bulletCounter = 0;
    this.gameLoop      = null;
    this.lastTick      = Date.now();
    this.maxClients    = 2;

    // Hareket mesajı
    this.onMessage("move", (client, data) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || !p.alive) return;
      p.x     = Math.max(PLAYER_RADIUS, Math.min(ARENA_W - PLAYER_RADIUS, data.x));
      p.y     = Math.max(PLAYER_RADIUS, Math.min(ARENA_H - PLAYER_RADIUS, data.y));
      p.angle = data.angle;
    });

    // Ateş mesajı
    this.onMessage("shoot", (client, data) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || !p.alive || this.state.phase !== "playing") return;

      const bid = "b_" + (++this.bulletCounter);
      const b   = new Bullet();
      b.id      = bid;
      b.ownerId = client.sessionId;
      b.x       = data.x;
      b.y       = data.y;
      b.vx      = Math.cos(data.angle) * BULLET_SPEED;
      b.vy      = Math.sin(data.angle) * BULLET_SPEED;
      this.state.bullets.set(bid, b);
    });

    console.log("ArenaRoom olusturuldu");
  }

  onJoin(client, options) {
    const idx   = this.clients.length - 1;
    const spawn = SPAWNS[idx] || SPAWNS[0];

    const p        = new Player();
    p.sessionId    = client.sessionId;
    p.x            = spawn.x;
    p.y            = spawn.y;
    p.angle        = 0;
    p.hp           = MAX_HP;
    p.alive        = true;
    p.kills        = 0;
    p.deaths       = 0;
    p.playerIndex  = idx;
    this.state.players.set(client.sessionId, p);

    console.log("Oyuncu katildi: " + client.sessionId + " (index:" + idx + ")");

    if (this.clients.length === 2) {
      this._startGame();
    }
  }

  onLeave(client, consented) {
    this.state.players.delete(client.sessionId);
    console.log("Oyuncu ayrildi: " + client.sessionId);

    if (this.state.phase === "playing") {
      this.state.phase = "gameover";
      this._stopLoop();
    }
  }

  onDispose() {
    this._stopLoop();
    console.log("ArenaRoom kapandi");
  }

  // --- OYUN AKIŞI ---

  _startGame() {
    this.state.phase    = "playing";
    this.state.winnerId = "";
    this.lastTick       = Date.now();

    let idx = 0;
    this.state.players.forEach((p) => {
      const spawn = SPAWNS[idx++] || SPAWNS[0];
      p.x     = spawn.x;
      p.y     = spawn.y;
      p.hp    = MAX_HP;
      p.alive = true;
    });

    this.gameLoop = setInterval(() => this._tick(), TICK_MS);
    console.log("Oyun basladi!");
  }

  _stopLoop() {
    if (this.gameLoop) {
      clearInterval(this.gameLoop);
      this.gameLoop = null;
    }
  }

  _tick() {
    const now = Date.now();
    const dt  = (now - this.lastTick) / 1000;
    this.lastTick = now;

    if (this.state.phase !== "playing") return;
    this._moveBullets(dt);
  }

  _moveBullets(dt) {
    const toRemove = [];

    this.state.bullets.forEach((b, bid) => {
      b.x += b.vx * dt;
      b.y += b.vy * dt;

      // Arena dışı → sil
      if (b.x < 0 || b.x > ARENA_W || b.y < 0 || b.y > ARENA_H) {
        toRemove.push(bid);
        return;
      }

      // Çarpışma kontrolü
      this.state.players.forEach((p) => {
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

            const killer = this.state.players.get(b.ownerId);
            if (killer) {
              killer.kills++;

              if (killer.kills >= WIN_KILLS) {
                this.state.phase    = "gameover";
                this.state.winnerId = killer.sessionId;
                this._stopLoop();
                console.log("Kazanan: " + killer.sessionId);
                return;
              }
            }

            // Respawn
            const pIndex = p.playerIndex;
            setTimeout(() => {
              if (this.state.phase !== "playing") return;
              const spawn = SPAWNS[pIndex] || SPAWNS[0];
              p.x     = spawn.x;
              p.y     = spawn.y;
              p.hp    = MAX_HP;
              p.alive = true;
            }, RESPAWN_MS);
          }
        }
      });
    });

    toRemove.forEach((bid) => this.state.bullets.delete(bid));
  }
}

module.exports = { ArenaRoom };
