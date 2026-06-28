"use strict";
// Manages one shared `opencode serve` process and proxies its HTTP API, so the
// phone can drive opencode as a real chat (sessions, messages, models) instead
// of scraping its TUI. See https://opencode.ai/docs/server/
const { spawn, execFile } = require("child_process");

const isWin = process.platform === "win32";
const PORT = 4096;
const BASE = `http://127.0.0.1:${PORT}`;
let proc = null, ready = null, modelsCache = null;

function start() {
  if (ready) return ready;
  proc = spawn("opencode serve --port " + PORT + " --hostname 127.0.0.1", { shell: true, windowsHide: true });
  proc.on("exit", () => { proc = null; ready = null; });
  ready = new Promise((resolve, reject) => {
    const t0 = Date.now();
    const poll = () => fetch(BASE + "/global/health")
      .then((r) => r.ok ? resolve() : retry())
      .catch(retry);
    const retry = () => (Date.now() - t0 > 25000) ? reject(new Error("opencode serve did not start")) : setTimeout(poll, 400);
    setTimeout(poll, 800);
  });
  return ready;
}

async function oc(path, opt) {
  await start();
  const r = await fetch(BASE + path, opt);
  if (!r.ok) throw new Error(`opencode ${path} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r;
}
const ocJson = (path, opt) => oc(path, opt).then((r) => r.json());

// `opencode models` lists the available (authenticated) models as provider/model lines.
function listModels() {
  if (modelsCache) return Promise.resolve(modelsCache);
  return new Promise((resolve) => {
    const file = isWin ? "cmd" : "sh";
    const args = isWin ? ["/c", "opencode", "models"] : ["-c", "opencode models"];
    execFile(file, args, { timeout: 20000, maxBuffer: 4 << 20, windowsHide: true }, (_err, stdout) => {
      const lines = (stdout || "").split(/\r?\n/).map((l) => l.trim())
        .filter((l) => /^[\w.-]+\/[\w.\-:]+$/.test(l)); // provider/model lines only
      if (lines.length) modelsCache = lines;
      resolve(lines);
    });
  });
}

const createSession = (dir, title) =>
  ocJson(`/session?directory=${encodeURIComponent(dir)}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: title || "chat" }),
  });

const getMessages = (sid) => ocJson(`/session/${sid}/message`);
const getConfig = () => ocJson(`/config`); // { mcp, plugin, agent, command, ... }
const getProviders = () => ocJson(`/config/providers`); // { providers:[{id,models:{id:{variants,capabilities}}}], default }
const getAgents = () => ocJson(`/agent`); // [{name, mode:"primary"|"subagent", ...}]
const abort = (sid) => oc(`/session/${sid}/abort`, { method: "POST" }).then(() => true).catch(() => false);

function sendMessage(sid, model, parts, opts = {}) {
  const body = { parts };
  if (model && model.includes("/")) {
    const i = model.indexOf("/");
    body.model = { providerID: model.slice(0, i), modelID: model.slice(i + 1) };
  }
  if (opts.variant) body.variant = opts.variant; // reasoning effort (low/medium/high/…)
  if (opts.agent) body.agent = opts.agent;       // mode: build / plan
  return ocJson(`/session/${sid}/message`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

// proxy a binary file part (image/attachment) the opencode server stored
const fileUrl = (sid, partUrl) => BASE + partUrl; // opencode part.url is a server-relative path

module.exports = { start, listModels, createSession, getMessages, getConfig, getProviders, getAgents, sendMessage, abort, BASE, ocJson };
