"use strict";
// Thin wrapper over the local control API, for the controller agent (opencode)
// to spawn/list/kill coder sessions. Reads token+port from config.json next to it.
//   node ctl.js new --agent claude --cwd <path> [--name x] [--role coder]
//   node ctl.js ls
//   node ctl.js rm <id>
const fs = require("fs"), path = require("path");
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
const base = `http://localhost:${cfg.port}`, token = cfg.token;
const [, , cmd, ...rest] = process.argv;

function flags(arr) {
  const o = { _: [] };
  for (let i = 0; i < arr.length; i++) {
    if (arr[i].startsWith("--")) o[arr[i].slice(2)] = arr[++i];
    else o._.push(arr[i]);
  }
  return o;
}
const api = (p, opt) =>
  fetch(base + p + (p.includes("?") ? "&" : "?") + "token=" + token,
    { headers: { "Content-Type": "application/json" }, ...opt }).then((r) => r.json());

(async () => {
  if (cmd === "new") {
    const f = flags(rest);
    if (!f.agent) throw new Error("--agent required");
    console.log(JSON.stringify(await api("/sessions", {
      method: "POST",
      body: JSON.stringify({ agent: f.agent, cwd: f.cwd, name: f.name, role: f.role }),
    })));
  } else if (cmd === "ls") {
    console.log(JSON.stringify(await api("/sessions"), null, 2));
  } else if (cmd === "rm") {
    const id = flags(rest)._[0];
    if (!id) throw new Error("usage: ctl rm <id>");
    console.log(JSON.stringify(await api("/sessions/" + id, { method: "DELETE" })));
  } else {
    console.log("usage: ctl new --agent <a> --cwd <path> [--name x] [--role coder] | ctl ls | ctl rm <id>");
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
