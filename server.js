"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");
const os = require("os");
const express = require("express");
const { execFile } = require("child_process");
const { WebSocketServer } = require("ws");
const pty = require("node-pty");

// Native Windows screen grab via PowerShell + System.Drawing (no native dep).
function captureScreen() {
  return new Promise((resolve, reject) => {
    if (!isWin) return reject(new Error("screenshot only implemented on Windows"));
    const out = path.join(os.tmpdir(), "pcair-shot.jpg");
    execFile("powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "screen-capture.ps1"), "-Out", out],
      (err) => err ? reject(err) : fs.readFile(out, (e, buf) => e ? reject(e) : resolve(buf)));
  });
}

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
const CLAUDE_HOME = cfg.claudeHome || path.join(os.homedir(), ".claude");

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

// register the controller session (meta only; pty starts when first opened)
function ensureControllerSession() {
  if ([...sessions.values()].some((s) => s.meta.role === "controller")) return;
  const c = cfg.controller;
  if (!c || !cfg.agents[c.agent]) return;
  const id = String(nextId++);
  const meta = { id, name: "controller", cwd: path.resolve(c.cwd || cfg.workspacesRoot), agent: c.agent, role: "controller" };
  sessions.set(id, { meta, pty: null, buf: "", subs: new Set(), busy: false, idleTimer: null });
  persist();
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

// skills: user dirs + every installed Claude plugin + project (.claude/skills under cwd)
function readFrontmatter(file) {
  try {
    const txt = fs.readFileSync(file, "utf8").slice(0, 4000);
    const m = txt.match(/^---\s*([\s\S]*?)\r?\n---/);
    const lines = (m ? m[1] : "").split(/\r?\n/);
    const grab = (k) => {
      for (let i = 0; i < lines.length; i++) {
        const r = lines[i].match(new RegExp("^" + k + ":\\s*(.*)$"));
        if (!r) continue;
        let v = r[1].trim();
        if (v && !/^[>|][-+]?$/.test(v)) return v.replace(/^["']|["']$/g, ""); // inline value
        const out = []; // YAML block scalar (>, |): collect following indented lines
        for (let j = i + 1; j < lines.length; j++) {
          if (/^\s+\S/.test(lines[j])) out.push(lines[j].trim());
          else if (lines[j].trim() === "") continue;
          else break;
        }
        return out.join(" ").trim();
      }
      return "";
    };
    return { name: grab("name"), description: grab("description"), trigger: grab("trigger") };
  } catch { return {}; }
}
function scanSkillsDir(dir, source, seen, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const skillDir = path.join(dir, e.name);
    const key = path.resolve(skillDir);
    if (seen.has(key)) continue;
    const md = path.join(skillDir, "SKILL.md");
    if (!fs.existsSync(md)) continue;
    seen.add(key);
    const fm = readFrontmatter(md);
    out.push({ category: "skill", name: e.name, description: fm.description || "", source, invoke: fm.trigger || "/" + e.name });
  }
}
// collect configured MCP server names from claude config files + opencode (dynamic)
async function collectMcps(agent, cwd) {
  const names = new Set();
  const grab = (obj) => { if (obj && typeof obj === "object") for (const k of Object.keys(obj)) names.add(k); };
  const tryFile = (p, pick) => { try { pick(JSON.parse(fs.readFileSync(p, "utf8"))); } catch {} };
  if (cwd) tryFile(path.join(path.resolve(cwd), ".mcp.json"), (j) => grab(j.mcpServers || j));
  tryFile(path.join(CLAUDE_HOME, "settings.json"), (j) => grab(j.mcpServers));
  tryFile(path.join(os.homedir(), ".claude.json"), (j) => {
    grab(j.mcpServers);
    if (cwd && j.projects) grab((j.projects[path.resolve(cwd)] || {}).mcpServers);
  });
  if (agent === "opencode") { try { grab((await require("./opencode").getConfig()).mcp); } catch {} }
  return [...names].map((n) => ({ category: "mcp", name: n, description: "", source: "mcp", invoke: "" }));
}
app.get("/skills", async (req, res) => {
  const a = cfg.agents[req.query.agent] || {};
  const agent = req.query.agent, cwd = req.query.cwd;
  const out = [], seen = new Set();
  // skills: user-configured dirs
  for (const d of a.skillsDirs || []) scanSkillsDir(d, "user", seen, out);
  if (cfg.globalSkillsDir) scanSkillsDir(cfg.globalSkillsDir, "user", seen, out);
  // skills + plugins: installed Claude plugins
  if (a.claudeSkills) {
    try {
      const idx = JSON.parse(fs.readFileSync(path.join(CLAUDE_HOME, "plugins", "installed_plugins.json"), "utf8"));
      for (const [key, installs] of Object.entries(idx.plugins || {})) {
        const pluginName = key.split("@")[0];
        const version = (installs[0] || {}).version || "";
        out.push({ category: "plugin", name: pluginName, description: version ? "v" + version : "", source: "installed", invoke: "" });
        for (const inst of installs) {
          if (inst.installPath) scanSkillsDir(path.join(inst.installPath, "skills"), "plugin:" + pluginName, seen, out);
        }
      }
    } catch {}
  }
  // skills: project skills under the session's cwd
  if (cwd) scanSkillsDir(path.join(path.resolve(cwd), ".claude", "skills"), "project", seen, out);
  // built-in skills (Claude binary-embedded; from editable config list)
  if (a.claudeSkills) for (const n of cfg.builtinSkills || []) out.push({ category: "builtin", name: n, description: "built-in", source: "built-in", invoke: "/" + n });
  // mcp servers (dynamic from config files + opencode)
  try { out.push(...await collectMcps(agent, cwd)); } catch {}
  res.json(out);
});

// see-only screenshot (cached)
let shotBuf = null, shotAt = 0;
app.get("/screen.jpg", async (_req, res) => {
  try {
    if (!shotBuf || Date.now() - shotAt > (cfg.screenshotMs || 1000)) {
      shotBuf = await captureScreen();
      shotAt = Date.now();
    }
    res.set("Content-Type", "image/jpeg").set("Cache-Control", "no-store").send(shotBuf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- opencode chat (GUI wrapper over the opencode HTTP API) ---------------
const opencode = require("./opencode");
app.get("/oc/models", async (_req, res) => {
  try { res.json(await opencode.listModels()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/oc/session", async (req, res) => {
  try { res.json(await opencode.createSession(path.resolve(req.body.cwd || cfg.workspacesRoot), req.body.title)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/oc/messages", async (req, res) => {
  try { res.json(await opencode.getMessages(req.query.sid)); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/oc/send", async (req, res) => {
  try { res.json(await opencode.sendMessage(req.body.sid, req.body.model, req.body.parts)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// proxy opencode-stored file parts (images/attachments) so the phone can load them
app.get("/oc/file", async (req, res) => {
  try {
    await opencode.start();
    const r = await fetch(opencode.BASE + req.query.url);
    if (!r.ok) return res.status(404).end();
    res.set("Content-Type", r.headers.get("content-type") || "application/octet-stream");
    res.send(Buffer.from(await r.arrayBuffer()));
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
  ensureControllerSession();
  server.listen(cfg.port, "0.0.0.0", () => {
    const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i.family === "IPv4" && !i.internal).map((i) => i.address);
    console.log(`PC AI Remote Controller on :${cfg.port}`);
    console.log(`  local:   http://localhost:${cfg.port}?token=${cfg.token}`);
    for (const ip of ips) console.log(`  network: http://${ip}:${cfg.port}?token=${cfg.token}`);
  });
}

module.exports = { createSession, deleteSession, sessions }; // for tests
