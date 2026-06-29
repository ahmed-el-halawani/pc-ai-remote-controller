"use strict";
// Drives the Claude Code CLI headlessly (`claude -p --output-format stream-json`)
// so the same chat GUI can wrap it, instead of scraping its TUI. Claude persists
// the conversation as a JSONL transcript we read for history; the live `claude -p`
// process streams the in-progress turn. See `claude --help` (print/SDK mode).
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const isWin = process.platform === "win32";
const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const running = {}; // ccSid -> child process (for busy + abort)

const slug = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, "-"); // matches Claude's project dir naming
const transcriptPath = (ccSid, cwd) => path.join(CLAUDE_HOME, "projects", slug(cwd), ccSid + ".jsonl");
const ts = (o) => (o && o.timestamp ? Date.parse(o.timestamp) : Date.now()) || Date.now();

// read the transcript JSONL -> messages in the chat GUI's part shape
function getMessages(ccSid, cwd) {
  const p = transcriptPath(ccSid, cwd);
  if (!cwd || !fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const results = {}; // tool_use_id -> tool_result
  for (const o of lines)
    if (o.type === "user" && o.message && Array.isArray(o.message.content))
      for (const b of o.message.content) if (b.type === "tool_result") results[b.tool_use_id] = b;

  const msgs = [];
  for (const o of lines) {
    const m = o.message;
    if (o.type === "user" && m && typeof m.content === "string" && m.content.trim()) {
      msgs.push({ info: { id: o.uuid, role: "user", time: { created: ts(o) } }, parts: [{ type: "text", text: m.content }] });
    } else if (o.type === "assistant" && m && Array.isArray(m.content)) {
      const parts = [];
      for (const b of m.content) {
        if (b.type === "text" && b.text) parts.push({ type: "text", text: b.text });
        else if (b.type === "thinking" && b.thinking) parts.push({ type: "reasoning", text: b.thinking });
        else if (b.type === "tool_use") {
          const r = results[b.id];
          const out = r ? (typeof r.content === "string" ? r.content : JSON.stringify(r.content)) : "";
          parts.push({ type: "tool", tool: b.name, callID: b.id, state: { status: r ? "completed" : "running", input: b.input || {}, output: out, title: b.name } });
        }
      }
      if (parts.length) msgs.push({ info: { id: o.uuid, role: "assistant", time: { created: ts(o), completed: ts(o) }, agent: o.agent || "claude", finish: "stop" }, parts });
    }
  }
  // while a turn is live, leave its last assistant message "incomplete" so the GUI keeps loading
  if (running[ccSid]) { const last = msgs[msgs.length - 1]; if (last && last.info.role === "assistant") { delete last.info.completed; delete last.info.time.completed; last.info.finish = "tool-calls"; } }
  return msgs;
}

// run one turn; prompt goes on stdin (no arg-quoting); onLine ticks per stream-json line
function send(ccSid, text, opts, cwd, onLine) {
  const first = !fs.existsSync(transcriptPath(ccSid, cwd));
  const a = ["-p", "--output-format", "stream-json", "--include-partial-messages", "--verbose"];
  a.push(first ? "--session-id" : "--resume", ccSid);
  if (opts.model) a.push("--model", opts.model);
  if (opts.mode) a.push("--permission-mode", opts.mode);
  if (opts.effort) a.push("--effort", opts.effort);
  const file = isWin ? (process.env.ComSpec || "cmd.exe") : "claude";
  const args = isWin ? ["/c", "claude", ...a] : a;
  return new Promise((resolve, reject) => {
    fs.mkdirSync(cwd, { recursive: true });
    const child = spawn(file, args, { cwd, windowsHide: true });
    running[ccSid] = child;
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d.toString(); let i;
      while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) onLine(line); }
    });
    child.on("error", (e) => { delete running[ccSid]; reject(e); });
    child.on("exit", () => { delete running[ccSid]; resolve({ ok: true }); });
    child.stdin.write(text || ""); child.stdin.end();
  });
}

const abort = (ccSid) => { const c = running[ccSid]; if (c) { try { c.kill(); } catch {} delete running[ccSid]; return true; } return false; };
const isBusy = (ccSid) => !!running[ccSid];

module.exports = { getMessages, send, abort, isBusy, transcriptPath };
