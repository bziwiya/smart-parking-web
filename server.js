import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import path from "path";
import { fileURLToPath } from "url";
import sqlite3 from "sqlite3";
import { Server } from "socket.io";
import http from "http";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data.sqlite");

sqlite3.verbose();
const db = new sqlite3.Database(DB_PATH);

function nowIso() {
  return new Date().toISOString();
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

async function initDb() {
  await dbRun(`
    CREATE TABLE IF NOT EXISTS spots (
      id INTEGER PRIMARY KEY,
      label TEXT NOT NULL,
      isOccupied INTEGER NOT NULL DEFAULT 0,
      lastUpdated TEXT NOT NULL
    );
  `);
  await dbRun(`
    CREATE TABLE IF NOT EXISTS gate (
      id INTEGER PRIMARY KEY CHECK (id=1),
      status TEXT NOT NULL,           -- OPEN | CLOSED
      lastUpdated TEXT NOT NULL
    );
  `);
  await dbRun(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );
  `);

  const spotCount = await dbGet("SELECT COUNT(*) AS c FROM spots;");
  if (!spotCount || spotCount.c === 0) {
    const N = 12; // demo car park size
    for (let i = 1; i <= N; i++) {
      await dbRun(
        "INSERT INTO spots (id,label,isOccupied,lastUpdated) VALUES (?,?,?,?)",
        [i, `P${String(i).padStart(2, "0")}`, 0, nowIso()]
      );
    }
  }

  const gateRow = await dbGet("SELECT * FROM gate WHERE id=1;");
  if (!gateRow) {
    await dbRun("INSERT INTO gate (id,status,lastUpdated) VALUES (1,?,?)", [
      "CLOSED",
      nowIso(),
    ]);
  }
}

async function logEvent(type, message) {
  await dbRun("INSERT INTO events (type,message,createdAt) VALUES (?,?,?)", [
    type,
    message,
    nowIso(),
  ]);
}

async function getSpots() {
  return await dbAll("SELECT * FROM spots ORDER BY id ASC;");
}

async function getGate() {
  return await dbGet("SELECT * FROM gate WHERE id=1;");
}

async function getFirstFreeSpot() {
  return await dbGet(
    "SELECT id,label,isOccupied,lastUpdated FROM spots WHERE isOccupied=0 ORDER BY id ASC LIMIT 1;"
  );
}

async function getFirstOccupiedSpot() {
  return await dbGet(
    "SELECT id,label,isOccupied,lastUpdated FROM spots WHERE isOccupied=1 ORDER BY id ASC LIMIT 1;"
  );
}

async function setGate(status) {
  await dbRun("UPDATE gate SET status=?, lastUpdated=? WHERE id=1", [
    status,
    nowIso(),
  ]);
  await logEvent("GATE", `Gate set to ${status}`);
}

async function setSpot(spotId, occupied) {
  await dbRun(
    "UPDATE spots SET isOccupied=?, lastUpdated=? WHERE id=?",
    [occupied ? 1 : 0, nowIso(), spotId]
  );
  await logEvent(
    "SENSOR",
    `Spot ${spotId} -> ${occupied ? "OCCUPIED" : "FREE"}`
  );
}

async function stats() {
  const rows = await dbGet(
    `SELECT
       SUM(CASE WHEN isOccupied=1 THEN 1 ELSE 0 END) AS occupied,
       SUM(CASE WHEN isOccupied=0 THEN 1 ELSE 0 END) AS free,
       COUNT(*) AS total
     FROM spots;`
  );
  const occupancyRate =
    rows.total === 0 ? 0 : Math.round((rows.occupied / rows.total) * 100);
  return { ...rows, occupancyRate };
}

// --- App ---
const app = express();
app.use(helmet({ contentSecurityPolicy: false })); // keep simple for local demo
app.use(morgan("dev"));
app.use(express.json({ limit: "256kb" }));

// Static site (landing + dashboard)
app.use(express.static(path.join(__dirname, "public")));

// Healthcheck
app.get("/api/health", (req, res) => res.json({ ok: true, time: nowIso() }));

// Spots
app.get("/api/spots", async (req, res) => {
  res.json({ spots: await getSpots() });
});

app.get("/api/stats", async (req, res) => {
  res.json(await stats());
});

app.post("/api/sensor", async (req, res) => {
  const { spotId, occupied } = req.body || {};
  const id = Number(spotId);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "spotId must be a positive integer" });
  }
  if (typeof occupied !== "boolean") {
    return res.status(400).json({ error: "occupied must be boolean" });
  }
  const existing = await dbGet("SELECT id FROM spots WHERE id=?", [id]);
  if (!existing) return res.status(404).json({ error: "spot not found" });

  await setSpot(id, occupied);

  const s = await stats();
  // Simple “automation”: if full, close gate; otherwise keep it closed unless explicitly opened.
  if (s.free === 0) await setGate("CLOSED");

  broadcastState();
  res.json({ ok: true });
});

// Gate
app.get("/api/gate", async (req, res) => {
  res.json({ gate: await getGate() });
});

app.post("/api/gate/open", async (req, res) => {
  const s = await stats();
  if (s.free === 0) return res.status(409).json({ error: "Parking is full" });
  await setGate("OPEN");
  broadcastState();
  res.json({ ok: true });
});

app.post("/api/gate/close", async (req, res) => {
  await setGate("CLOSED");
  broadcastState();
  res.json({ ok: true });
});

// Simulated entry/exit events.
// Entry: open if there is a free spot; then close automatically.
app.post("/api/gate/car-entry", async (req, res) => {
  const freeSpot = await getFirstFreeSpot();
  if (!freeSpot) {
    await setGate("CLOSED");
    await logEvent("ACCESS", "Car entry blocked: parking full");
    broadcastState();
    return res.status(409).json({ error: "Parking is full" });
  }

  await setGate("OPEN");
  await setSpot(freeSpot.id, true);
  await logEvent("ACCESS", `Car entry accepted: spot ${freeSpot.label} assigned`);
  broadcastState();
  setTimeout(async () => {
    await setGate("CLOSED");
    broadcastState();
  }, 1500);
  res.json({ ok: true, spotId: freeSpot.id, spotLabel: freeSpot.label });
});

// Exit: open briefly, then close.
app.post("/api/gate/car-exit", async (req, res) => {
  const occupiedSpot = await getFirstOccupiedSpot();
  if (!occupiedSpot) {
    await setGate("CLOSED");
    await logEvent("ACCESS", "Car exit blocked: no occupied spot");
    broadcastState();
    return res.status(409).json({ error: "No occupied spot to release" });
  }

  await setGate("OPEN");
  await setSpot(occupiedSpot.id, false);
  await logEvent("ACCESS", `Car exit processed: spot ${occupiedSpot.label} released`);
  broadcastState();
  setTimeout(async () => {
    await setGate("CLOSED");
    broadcastState();
  }, 1500);
  res.json({ ok: true, spotId: occupiedSpot.id, spotLabel: occupiedSpot.label });
});

// Event log
app.get("/api/events", async (req, res) => {
  const limit = Math.min(200, Math.max(10, Number(req.query.limit || 50)));
  const rows = await dbAll(
    "SELECT * FROM events ORDER BY id DESC LIMIT ?",
    [limit]
  );
  res.json({ events: rows });
});

// --- Real-time (Socket.IO) ---
const httpServer = http.createServer(app);
const io = new Server(httpServer);

async function broadcastState() {
  const [spots, gate, s, events] = await Promise.all([
    getSpots(),
    getGate(),
    stats(),
    dbAll("SELECT * FROM events ORDER BY id DESC LIMIT 20"),
  ]);
  io.emit("state", { spots, gate, stats: s, events });
}

io.on("connection", async (socket) => {
  socket.emit("state", {
    spots: await getSpots(),
    gate: await getGate(),
    stats: await stats(),
    events: await dbAll("SELECT * FROM events ORDER BY id DESC LIMIT 20"),
  });
});

// Start
await initDb();
await logEvent("SYSTEM", "Server started");
httpServer.listen(PORT, () => {
  console.log(`Smart Parking Web running on http://localhost:${PORT}`);
});
