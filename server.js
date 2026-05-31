const path = require("path");
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { MongoClient } = require("mongodb");
const { WebSocketServer } = require("ws");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || "zikr_pool";

if (!MONGODB_URI) {
  console.error("Missing MONGODB_URI env var.");
  process.exit(1);
}

let db;
let wsServer;

function getSessionDefaults() {
  return {
    active: false,
    zikrName: "SubhanAllah",
    target: 100000,
    ytLink: "https://youtu.be/6MnZRf3fu_M?si=RGUIbfMesaabC9iw",
    pin: "786"
  };
}

async function getState() {
  const sessionCol = db.collection("session");
  const usersCol = db.collection("users");
  const sessionDoc = (await sessionCol.findOne({ _id: "active" })) || getSessionDefaults();
  const usersArr = await usersCol.find({}).toArray();
  const users = {};
  for (const u of usersArr) {
    users[u._id] = { count: u.count || 0, history: u.history || [] };
  }
  return { session: sessionDoc, users };
}

async function broadcastState() {
  if (!wsServer) return;
  const state = await getState();
  const msg = JSON.stringify({ type: "state", payload: state });
  wsServer.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(msg);
    }
  });
}

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/state", async (req, res) => {
  const state = await getState();
  res.json(state);
});

app.post("/api/admin/session", async (req, res) => {
  const { zikrName, target, ytLink, pin } = req.body || {};
  if (!zikrName || !target || !pin) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  const sessionCol = db.collection("session");
  await sessionCol.updateOne(
    { _id: "active" },
    {
      $set: {
        _id: "active",
        active: true,
        zikrName,
        target: Number(target),
        ytLink: ytLink || "https://youtu.be/6MnZRf3fu_M",
        pin: String(pin)
      }
    },
    { upsert: true }
  );
  await broadcastState();
  res.json({ ok: true });
});

app.post("/api/admin/reset", async (req, res) => {
  const sessionCol = db.collection("session");
  const usersCol = db.collection("users");
  await sessionCol.updateOne(
    { _id: "active" },
    { $set: { _id: "active", ...getSessionDefaults(), active: false } },
    { upsert: true }
  );
  await usersCol.deleteMany({});
  await broadcastState();
  res.json({ ok: true });
});

app.post("/api/admin/remove", async (req, res) => {
  const { nick } = req.body || {};
  if (!nick) return res.status(400).json({ error: "Missing nick" });
  const usersCol = db.collection("users");
  await usersCol.deleteOne({ _id: nick });
  await broadcastState();
  res.json({ ok: true });
});

app.post("/api/participant/login", async (req, res) => {
  const { nick, pin } = req.body || {};
  if (!nick) return res.status(400).json({ error: "Missing nick" });
  const sessionCol = db.collection("session");
  const sessionDoc = (await sessionCol.findOne({ _id: "active" })) || getSessionDefaults();
  if (!sessionDoc.active) return res.status(403).json({ error: "No active session" });
  if (String(pin) !== String(sessionDoc.pin)) return res.status(403).json({ error: "Invalid PIN" });
  const usersCol = db.collection("users");
  await usersCol.updateOne(
    { _id: nick },
    { $setOnInsert: { _id: nick, count: 0, history: [] } },
    { upsert: true }
  );
  await broadcastState();
  res.json({ ok: true });
});

app.post("/api/participant/add", async (req, res) => {
  const { nick, delta } = req.body || {};
  if (!nick || !delta) return res.status(400).json({ error: "Missing nick or delta" });
  const usersCol = db.collection("users");
  await usersCol.updateOne(
    { _id: nick },
    {
      $inc: { count: Number(delta) },
      $push: { history: { $each: [Number(delta)], $slice: -100 } }
    },
    { upsert: true }
  );
  await broadcastState();
  res.json({ ok: true });
});

app.post("/api/participant/undo", async (req, res) => {
  const { nick } = req.body || {};
  if (!nick) return res.status(400).json({ error: "Missing nick" });
  const usersCol = db.collection("users");
  const user = await usersCol.findOne({ _id: nick });
  if (!user || !user.history || user.history.length === 0) {
    return res.json({ ok: true, undone: 0 });
  }
  const last = user.history[user.history.length - 1];
  await usersCol.updateOne(
    { _id: nick },
    {
      $inc: { count: -Number(last) },
      $set: { history: user.history.slice(0, -1) }
    }
  );
  await broadcastState();
  res.json({ ok: true, undone: last });
});

const server = app.listen(PORT, async () => {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(DB_NAME);
  wsServer = new WebSocketServer({ server });
  wsServer.on("connection", async (socket) => {
    const state = await getState();
    socket.send(JSON.stringify({ type: "state", payload: state }));
  });
  console.log("Zikr app server running on http://localhost:" + PORT);
});

server.on("error", (err) => {
  console.error("Server error:", err);
});
