"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");
const os = require("os");
const express = require("express");
const { WebSocketServer } = require("ws");
const pty = require("node-pty");
const screenshot = require("screenshot-desktop");

// ---- config ---------------------------------------------------------------
const CFG_PATH = path.join(__dirname, "config.json");
if (!fs.existsSync(CFG_PATH)) {
  fs.copyFileSync(path.join(__dirname, "config.example.json"), CFG_PATH);
  console.warn("No config.json found — created one from config.example.json. Edit it (set a token!) and restart.");
}
const cfg = JSON.parse(fs.readFileSync(CFG_PATH, "utf8"));
const SESS_PATH = path.join(__dirname, "sessions.json");
const BUF_CAP = 100 * 1024; // ring buffer per session (~100KB of output)
const isWin = process.platform === "win32";

// ---- session registry -----------------------------------------------------
// id -> { meta:{id,name,cwd,agent,role}, pty, buf, subs:Set<ws>, busy, idleTimer }
const sessions = new Map();
let nextId = 1;

function persist() {
  const metas = [...sessions.values()].map((s) => s.meta);
  fs.writeFileSync(SESS_PATH, JSON.stringify(metas, null, 2));
}
function loadPersisted() {
  if (!fs.existsSync(SESS_PATH)) return;
  try {
    for (const meta of JSON.parse(fs.readFileSync(SESS_PATH, "utf8"))) {
      sessions.set(meta.id, { meta, pty: null, buf: "", subs: new Set(), busy: false, idleTimer: null });
      const n = parseInt(meta.id, 10);
      if (!isNaN(n) && n >= nextId) nextId = n + 1;
    }
  } catch (e) { console.warn("Could not load sessions.json:", e.message); }
}

function agentCommand(agentName, extraArgs = []) {
  const a = cfg.agents[agentName];
  if (!a) throw new Error(`Unknown agent '${agentName}'`);
  const cmd = a.command;
  const args = [...(a.args || []), ...extraArgs];
  // On Windows agents are often .cmd shims — run through the comspec shell.
  if (isWin) return { file: process.env.ComSpec || "cmd.exe", args: ["/c", cmd, ...args] };
  return { file: cmd, args };
}

function broadcast(s, msg) {
  const str = JSON.stringify(msg);
  for (const ws of s.subs) { try { ws.send(str); } catch {} }
}

function notify(text) {
  if (!cfg.ntfyTopic) return;
  fetch(`https://ntfy.sh/${cfg.ntfyTopic}`, { method: "POST", body: text }).catch(() => {});
}

function startPty(s, extraArgs = []) {
  const { file, args } = agentCommand(s.meta.agent, extraArgs);
  fs.mkdirSync(s.meta.cwd, { recursive: true });
  const p = pty.spawn(file, args, {
    name: "xterm-color", cols: 80, rows: 30, cwd: s.meta.cwd, env: process.env,
  });
  s.pty = p;
  s.busy = false;
  p.onData((d) => {
    s.buf = (s.buf + d).slice(-BUF_CAP);
    broadcast(s, { t: "o", d });
    // idle detection: quiet-after-busy -> one ntfy
    s.busy = true;
    clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(() => {
      if (s.busy) { notify(`${s.meta.agent} (${s.meta.name}) is waiting for input`); s.busy = false; }
    }, (cfg.idleSeconds || 20) * 1000);
  });
  p.onExit(() => {
    clearTimeout(s.idleTimer);
    s.pty = null;
    broadcast(s, { t: "exit" });
  });
  return p;
}

function ensureStarted(s) { if (!s.pty) startPty(s); return s.pty; }

function createSession({ name, cwd, agent, role }) {
  if (!cfg.agents[agent]) throw new Error(`Unknown agent '${agent}'`);
  const id = String(nextId++);
  const meta = { id, name: name || `${agent}-${id}`, cwd: path.resolve(cwd || cfg.workspacesRoot), agent, role: role || "coder" };
  const s = { meta, pty: null, buf: "", subs: new Set(), busy: false, idleTimer: null };
  sessions.set(id, s);
  startPty(s);
  persist();
  return meta;
}

function deleteSession(id) {
  const s = sessions.get(id);
  if (!s) return false;
  clearTimeout(s.idleTimer);
  if (s.pty) try { s.pty.kill(); } catch {}
  sessions.delete(id);
  persist();
  return true;
}

// ---- http app -------------------------------------------------------------
const app = express();
app.use(express.json());

// shared-token gate for everything except static shell + health
function tokenOk(req) {
  const t = req.query.token || req.headers["x-token"];
  return cfg.token && t === cfg.token;
}
app.get("/health", (_req, res) => res.json({ ok: true }));
app.use((req, res, next) => {
  if (req.path === "/" || req.path.startsWith("/static") || req.path === "/manifest.webmanifest" || req.path === "/sw.js") return next();
  if (!tokenOk(req)) return res.status(401).json({ error: "bad token" });
  next();
});

app.get("/sessions", (_req, res) => {
  res.json([...sessions.values()].map((s) => ({ ...s.meta, alive: !!s.pty })));
});
app.post("/sessions", (req, res) => {
  try { res.json(createSession(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete("/sessions/:id", (req, res) => {
  res.json({ ok: deleteSession(req.params.id) });
});

// agent capability descriptors (without command internals) for the UI
app.get("/agents", (_req, res) => {
  const out = {};
  for (const [k, a] of Object.entries(cfg.agents)) {
    out[k] = { models: a.models || [], modes: a.modes || [], efforts: a.efforts || [], fileMention: !!a.fileMention };
  }
  res.json(out);
});

// option-apply: write a slash/text into the pty, or respawn with launch args
app.post("/apply", (req, res) => {
  const s = sessions.get(req.body.session);
  if (!s) return res.status(404).json({ error: "no session" });
  if (req.body.respawnArgs) {
    if (s.pty) try { s.pty.kill(); } catch {}
    s.buf = "";
    startPty(s, req.body.respawnArgs);
    return res.json({ ok: true, respawned: true });
  }
  if (typeof req.body.send === "string") { ensureStarted(s).write(req.body.send + "\r"); return res.json({ ok: true }); }
  if (typeof req.body.write === "string") { ensureStarted(s).write(req.body.write); return res.json({ ok: true }); } // no Enter (e.g. @file)
  res.status(400).json({ error: "nothing to apply" });
});

// folder/file picker
app.get("/fs", (req, res) => {
  const dir = path.resolve(req.query.path || cfg.workspacesRoot);
  const all = req.query.mode === "all";
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => all || e.isDirectory())
      .map((e) => ({ name: e.name, dir: e.isDirectory() }))
      .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
    res.json({ path: dir, parent: path.dirname(dir), entries });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post("/fs", (req, res) => {
  try {
    const target = path.join(path.resolve(req.body.path), req.body.name);
    fs.mkdirSync(target, { recursive: true });
    res.json({ path: target });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// skills: agent-specific dirs + global dir
app.get("/skills", (req, res) => {
  const a = cfg.agents[req.query.agent] || {};
  const out = [];
  const scan = (d, source) => {
    try {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) out.push({ name: e.name, source });
        else if (e.name.endsWith(".md")) out.push({ name: e.name.replace(/\.md$/, ""), source });
      }
    } catch {}
  };
  for (const d of a.skillsDirs || []) scan(d, "agent");
  if (cfg.globalSkillsDir) scan(cfg.globalSkillsDir, "global");
  res.json(out);
});

// see-only screenshot (cached)
let shotBuf = null, shotAt = 0;
app.get("/screen.jpg", async (_req, res) => {
  try {
    if (!shotBuf || Date.now() - shotAt > (cfg.screenshotMs || 1000)) {
      shotBuf = await screenshot({ format: "jpg" });
      shotAt = Date.now();
    }
    res.set("Content-Type", "image/jpeg").set("Cache-Control", "no-store").send(shotBuf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// rustdesk launch info for the UI button
app.get("/rustdesk", (_req, res) => res.json({ id: cfg.rustdeskId || "" }));

app.use("/static", express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/manifest.webmanifest", (_req, res) => res.sendFile(path.join(__dirname, "public", "manifest.webmanifest")));
app.get("/sw.js", (_req, res) => res.sendFile(path.join(__dirname, "public", "sw.js")));

// ---- websocket terminal ---------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname !== "/ws" || url.searchParams.get("token") !== cfg.token) { socket.destroy(); return; }
  const s = sessions.get(url.searchParams.get("session"));
  if (!s) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => attach(ws, s));
});
function attach(ws, s) {
  ensureStarted(s);
  s.subs.add(ws);
  if (s.buf) ws.send(JSON.stringify({ t: "o", d: s.buf })); // replay
  ws.on("message", (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === "i" && s.pty) s.pty.write(m.d);
    else if (m.t === "r" && s.pty) try { s.pty.resize(m.cols, m.rows); } catch {}
  });
  ws.on("close", () => s.subs.delete(ws)); // pty keeps running -> reattachable
}

// ---- boot -----------------------------------------------------------------
if (require.main === module) {
  loadPersisted();
  server.listen(cfg.port, "0.0.0.0", () => {
    const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i.family === "IPv4" && !i.internal).map((i) => i.address);
    console.log(`PC AI Remote Controller on :${cfg.port}`);
    console.log(`  local:   http://localhost:${cfg.port}?token=${cfg.token}`);
    for (const ip of ips) console.log(`  network: http://${ip}:${cfg.port}?token=${cfg.token}`);
  });
}

module.exports = { createSession, deleteSession, sessions }; // for tests
