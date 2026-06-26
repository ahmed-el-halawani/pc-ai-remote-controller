"use strict";
// ponytail: one runnable check for the risky bit — node-pty capturing output
// in a chosen cwd on this OS, plus the ring-buffer cap. Run: node test_pty.js
const assert = require("assert");
const pty = require("node-pty");
const os = require("os");

// ring-buffer cap behaves like server.js (last N bytes)
const CAP = 10;
let buf = "";
for (const d of ["abcdef", "ghijkl"]) buf = (buf + d).slice(-CAP);
assert.strictEqual(buf, "cdefghijkl", "ring buffer should keep last CAP bytes");

// node-pty runs a command in a given cwd and we capture its stdout
const isWin = process.platform === "win32";
const tmp = os.tmpdir();
const { file, args } = isWin
  ? { file: process.env.ComSpec || "cmd.exe", args: ["/c", "cd"] } // prints cwd on Windows
  : { file: "pwd", args: [] };
const p = pty.spawn(file, args, { name: "xterm-color", cols: 80, rows: 30, cwd: tmp, env: process.env });
let out = "";
p.onData((d) => (out += d));
p.onExit(() => {
  assert.ok(out.toLowerCase().includes(tmp.toLowerCase().slice(0, 6)), `pty output should reflect cwd; got: ${out}`);
  console.log("test_pty: OK");
});
