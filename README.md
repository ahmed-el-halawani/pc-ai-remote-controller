# PC AI Remote Controller

Drive AI coding CLIs (Claude Code, opencode, …) on your PC from your phone.

A single local web app that manages multiple **agent sessions** — each pinned to its own
workspace folder and running a chosen CLI — reachable from a phone PWA over ZeroTier. It does
**not** rebuild remote desktop; for live screen + full mouse/keyboard control it links out to
RustDesk. What it adds is the missing layer: per-session AI CLIs, an opencode *controller* that
spawns/assigns coder sessions, full per-agent controls (model/mode/effort/skills/files),
persistent reattachable sessions, a see-only screenshot view, and idle push notifications.

## Quick start

```sh
npm install
cp config.example.json config.json   # then edit: set a token, paths, ntfy topic
node server.js
```

Open `http://localhost:<port>?token=<your-token>` on the PC, or
`http://<PC-zerotier-ip>:<port>?token=<your-token>` from your phone, and "Add to Home Screen".

## Connectivity

Install ZeroTier on both PC and phone, join the same network. The server binds `0.0.0.0`; the
ZeroTier membership is the access gate, and the shared `token` is defense-in-depth.

See `config.example.json` for all options.
