/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║   AssemblyGuard — Cloud Backend Server                       ║
 * ║   Receives data from Jetson Nano → serves dashboard          ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * DEPLOY TO RENDER.COM (free):
 *   1. Push this folder to a GitHub repo
 *   2. Go to render.com → New Web Service → connect your repo
 *   3. Build command:  npm install
 *   4. Start command:  node server.js
 *   5. Copy the URL (e.g. https://assemblyguard-xxxx.onrender.com)
 *   6. Paste it into jetson_ai.py  →  CLOUD_URL = "https://..."
 *
 * LOCAL TEST:
 *   npm install
 *   node server.js
 *   Open http://localhost:3000
 */

const express    = require("express");
const http       = require("http");
const { Server } = require("socket.io");
const cors       = require("cors");
const path       = require("path");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json({ limit: "10mb" }));   // large enough for base64 images
app.use(express.static(path.join(__dirname, "public")));

// ── In-memory store (no database needed for single-station MVP) ──────────────
// For production replace with SQLite or PostgreSQL
const store = {
  stations:  {},     // { station_id: { ...latestHeartbeat } }
  anomalies: [],     // newest first, capped at 500
  stats: {
    totalInspections: 0,
    totalAnomalies:   0,
    startTime:        Date.now(),
  },
};

// ─────────────────────────────────────────────
//  REST endpoints  (called by Jetson)
// ─────────────────────────────────────────────

/**
 * POST /api/heartbeat
 * Jetson sends this every 3 seconds with current status & part counts.
 * Body: { station_id, station_label, status, part_counts, fps, timestamp }
 */
app.post("/api/heartbeat", (req, res) => {
  const data = req.body;
  if (!data.station_id) return res.status(400).json({ error: "missing station_id" });

  store.stations[data.station_id] = {
    ...data,
    last_seen: Date.now(),
  };
  store.stats.totalInspections++;

  // Broadcast to all open dashboards instantly via WebSocket
  io.emit("heartbeat", data);

  res.json({ ok: true });
});

/**
 * POST /api/anomaly
 * Jetson sends this when an anomaly is detected.
 * Body: { station_id, station_label, status, details, confidence, timestamp, image_b64 }
 */
app.post("/api/anomaly", (req, res) => {
  const data = req.body;
  if (!data.station_id) return res.status(400).json({ error: "missing station_id" });

  const event = {
    id:            Date.now(),
    station_id:    data.station_id,
    station_label: data.station_label,
    status:        data.status,
    details:       data.details || [],
    confidence:    data.confidence || 0,
    timestamp:     data.timestamp,
    image_b64:     data.image_b64 || null,
  };

  store.anomalies.unshift(event);           // newest first
  if (store.anomalies.length > 500) store.anomalies.pop();
  store.stats.totalAnomalies++;

  // Push to all dashboards in real time
  io.emit("anomaly", event);

  console.log(`[ANOMALY] ${data.station_label} — ${(data.details || []).join(", ")}`);
  res.json({ ok: true, id: event.id });
});

// ─────────────────────────────────────────────
//  REST endpoints  (called by dashboard)
// ─────────────────────────────────────────────

/** GET /api/status  — initial page load, returns everything */
app.get("/api/status", (req, res) => {
  res.json({
    stations:  store.stations,
    anomalies: store.anomalies.slice(0, 100),   // last 100
    stats:     store.stats,
    uptime:    Math.floor((Date.now() - store.stats.startTime) / 1000),
  });
});

/** GET /api/anomalies?station=station_1&limit=50 */
app.get("/api/anomalies", (req, res) => {
  const { station, limit = 100 } = req.query;
  let list = store.anomalies;
  if (station) list = list.filter(a => a.station_id === station);
  res.json(list.slice(0, parseInt(limit)));
});

/** GET /api/health  — simple ping for uptime monitors */
app.get("/api/health", (_req, res) => res.json({ status: "ok", ts: Date.now() }));

// ─────────────────────────────────────────────
//  WebSocket
// ─────────────────────────────────────────────
io.on("connection", socket => {
  console.log(`[WS] Dashboard connected: ${socket.id}`);

  // Send full current state immediately on connect
  socket.emit("init", {
    stations:  store.stations,
    anomalies: store.anomalies.slice(0, 100),
    stats:     store.stats,
  });

  socket.on("disconnect", () => {
    console.log(`[WS] Dashboard disconnected: ${socket.id}`);
  });
});

// ─────────────────────────────────────────────
//  Serve dashboard HTML for any non-API route
// ─────────────────────────────────────────────
app.get("*", (req, res) => {
  if (req.path.startsWith("/api")) return res.status(404).json({ error: "not found" });
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ─────────────────────────────────────────────
//  Start
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║  AssemblyGuard Server running        ║`);
  console.log(`║  http://localhost:${PORT}              ║`);
  console.log(`╚══════════════════════════════════════╝\n`);
});
