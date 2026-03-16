const http    = require("http");
const express = require("express");
const colyseus = require("colyseus");
const monitor  = require("@colyseus/monitor").monitor;
const { ArenaRoom } = require("./ArenaRoom");

const port = Number(process.env.PORT || 3000);
const app  = express();
app.use(express.json());

// Sağlık kontrolü - Railway bunu kullanır
app.get("/", (req, res) => {
  res.json({ status: "ok", game: "Arena 1v1", uptime: process.uptime() });
});

// Colyseus monitor - sunucu durumunu görmek için
app.use("/colyseus", monitor());

const server     = http.createServer(app);
const gameServer = new colyseus.Server({ server });

gameServer.define("arena", ArenaRoom);

gameServer.listen(port).then(() => {
  console.log("Arena sunucu " + port + " portunda calisiyor");
}).catch((err) => {
  console.error("Sunucu baslatma hatasi:", err);
  process.exit(1);
});
