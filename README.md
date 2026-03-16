# Arena Server - Railway Kurulum

## Adımlar

1. railway.app → New Project → Deploy from GitHub repo
   (veya: Install CLI → `railway up`)

2. Ortam değişkeni YOK, direkt çalışır.

3. Deploy bittikten sonra Railway sana bir URL verir:
   Örnek: https://arena-server-xxx.up.railway.app

4. Bu URL'yi Godot client'ındaki SERVER_URL değişkenine yaz.

## Colyseus Monitor
Sunucu durumunu görmek için:
https://arena-server-xxx.up.railway.app/colyseus

## Oyun Odası
- Oda adı: "arena"
- Max 2 oyuncu
- 2. oyuncu katılınca oyun otomatik başlar
- İlk 5 kill yapan kazanır
- Ölünce 3 saniye sonra respawn

## Mesajlar (client → server)
- "move" → { x, y, angle }
- "shoot" → { x, y, angle }

## State (server → client)
- players: Map<sessionId, Player>
  - x, y, angle, hp, alive, kills, deaths, playerIndex
- bullets: Map<id, Bullet>
  - x, y, vx, vy, ownerId
- phase: "waiting" | "playing" | "gameover"
- winnerId: string
