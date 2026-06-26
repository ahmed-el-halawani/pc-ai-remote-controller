"use strict";
// End-to-end self-check: boots the server, creates a 'shell' session, drives it
// over WebSocket, verifies output capture + reattach replay, then deletes it.
// Run: node test_session.js   (needs a 'shell' agent in config.json)
const assert = require("assert");
const { spawn } = require("child_process");
const WebSocket = require("ws");

const cfg = JSON.parse(require("fs").readFileSync(__dirname + "/config.json", "utf8"));
const TOKEN = cfg.token;
// Uses the configured port; assumes no other instance is already running on it.
const srv = spawn(process.execPath, ["server.js"], { cwd: __dirname, stdio: "inherit" });
const BASE = `http://localhost:${cfg.port}`;
const WSBASE = `ws://localhost:${cfg.port}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (p, opt) => {
  const r = await fetch(BASE + p + (p.includes("?") ? "&" : "?") + "token=" + TOKEN,
    { headers: { "Content-Type": "application/json" }, ...opt });
  return r.json();
};

(async () => {
  let id;
  try {
    await sleep(1500);
    const meta = await j("/sessions", { method: "POST", body: JSON.stringify({ agent: "shell", name: "test" }) });
    id = meta.id;
    assert.ok(id, "session created");

    const ws = new WebSocket(`${WSBASE}/ws?session=${id}&token=${TOKEN}`);
    let out = "";
    ws.on("message", (d) => (out += JSON.parse(d).d || ""));
    await new Promise((res) => ws.on("open", res));
    await sleep(800);
    ws.send(JSON.stringify({ t: "i", d: "echo ponytail-marker-42\r" }));
    await sleep(1500);
    assert.ok(out.includes("ponytail-marker-42"), "pty output captured over WS:\n" + out.slice(-200));
    ws.close();

    // reattach: new socket should replay the buffer (pty kept running)
    await sleep(300);
    const ws2 = new WebSocket(`${WSBASE}/ws?session=${id}&token=${TOKEN}`);
    let replay = "";
    ws2.on("message", (d) => (replay += JSON.parse(d).d || ""));
    await new Promise((res) => ws2.on("open", res));
    await sleep(600);
    assert.ok(replay.includes("ponytail-marker-42"), "reattach replays buffer");
    ws2.close();

    const list = await j("/sessions");
    assert.ok(list.find((s) => s.id === id && s.alive), "session still alive after detach");

    await j("/sessions/" + id, { method: "DELETE" });
    console.log("test_session: OK");
    process.exitCode = 0;
  } catch (e) {
    console.error("test_session: FAIL", e.message);
    process.exitCode = 1;
  } finally {
    if (id) await j("/sessions/" + id, { method: "DELETE" }).catch(() => {});
    srv.kill();
  }
})();
