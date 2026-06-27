# PC AI Remote Controller

Drive AI coding CLIs (Claude Code, opencode, …) on your PC from your phone.

A single local web app that manages multiple **agent sessions** — each pinned to its own
workspace folder and running a chosen CLI — reachable from a phone PWA over ZeroTier. It does
**not** rebuild remote desktop; for live screen + full mouse/keyboard control it links out to
RustDesk. What it adds is the missing layer.

## Features

- **Sessions** — create as many as you want; each has its own folder + chosen agent. They are
  **persistent and reattachable**: an agent keeps running when the phone disconnects, and
  reopening replays recent output.
- **Controller (opencode)** — a session you chat with for small tasks (make a folder, find an
  image…) that can also **spawn new sessions and assign a coding CLI** as the master coder via
  the `ctl` command. New sessions appear on the phone automatically.
- **Full per-agent controls** — switch model / mode / effort, mention skills (agent-specific +
  global), and mention files (`@path`) — rendered per agent from a config descriptor and
  injected into the live CLI.
- **See-only screen** — a low-fps screenshot view to watch what's happening; a button links out
  to RustDesk for true GUI control.
- **Idle push** — when an agent goes quiet waiting for you, it pings your phone via ntfy.
- **opencode chat GUI** — opencode sessions open a Claude-mobile-style chat (bubbles +
  tool-call cards + model picker + paste/attach), driven by opencode's HTTP API
  (`opencode serve`, proxied via `/oc/*`). A **CLI** toggle drops back to the raw terminal.
- **PWA** — open a URL, "Add to Home Screen". No app store.

## Quick start

```sh
npm install
# config.json is auto-created from config.example.json on first run — then edit it:
#   set a long random "token", check workspacesRoot / globalSkillsDir / paths,
#   optionally set ntfyTopic and rustdeskId.
node server.js
```

Open the URL it prints:
- on the PC: `http://localhost:<port>?token=<token>`
- from your phone: `http://<PC-zerotier-ip>:<port>?token=<token>` → Add to Home Screen.

## Connectivity (ZeroTier)

Install ZeroTier on PC and phone, join the same network. The server binds `0.0.0.0`; ZeroTier
membership is the access gate and the shared `token` is defense-in-depth (required on every
request and WebSocket).

## Configuration (`config.json`)

| key | meaning |
|-----|---------|
| `port` / `token` | server port / shared secret required on every request |
| `workspacesRoot` | default folder the picker starts in |
| `globalSkillsDir` | skills shown for every agent (e.g. `~/.claude/skills`) |
| `screenshotMs` | screen refresh interval (ms) |
| `idleSeconds` | quiet time before an idle ntfy fires |
| `ntfyTopic` | ntfy.sh topic for push (blank = off) |
| `rustdeskId` | RustDesk peer id for the launch button |
| `controller` | `{ agent, cwd }` — the orchestrator session, auto-registered on boot |
| `agents` | per-agent descriptors: `command`, `args`, `fileMention`, `skillsDirs`, `models`/`modes`/`efforts` (each `{label, slash\|text\|flag}`) |

Add a new agent later = one entry under `agents` (and, if it's an interactive CLI on PATH,
nothing else).

## Orchestration (`ctl`)

The controller (opencode) drives these; see `controller/AGENTS.md`:

```sh
node ctl.js new --agent claude --cwd "C:/path/to/project" --name myfeature
node ctl.js ls
node ctl.js rm <id>
```

## Tests

```sh
node test_pty.js       # node-pty capture + ring buffer
node test_session.js   # boot + create/WS I/O/reattach/delete (needs a 'shell' agent in config)
```

## Not included (by design)

Live video + remote mouse/keyboard (use RustDesk), a native phone app (the PWA covers it),
accounts/relay (ZeroTier + token is enough for single-user). Respawning live agents across a
**server** restart is not done — session *metadata* persists and a pty restarts when you
reopen the session.
