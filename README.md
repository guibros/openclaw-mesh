# openclaw-mesh

One command. Full mesh deployment. Idempotent.

## Install

```bash
npx openclaw-mesh
```

That's it. Detects macOS or Ubuntu, installs what's missing, skips what's there.

## What it does

| Phase | Description |
|-------|-------------|
| 1 | Detect platform (macOS lead / Ubuntu worker) |
| 2 | Verify infrastructure (Tailscale, NATS, Node.js) |
| 3 | Deploy agent.js + shared folder + auto-start service |
| 4 | Install mesh CLI + health check + self-repair |
| 5 | Wire into OpenClaw (skill, workspace, HEARTBEAT) |
| 6 | Run health verification |

## After install

```bash
mesh status          # see online nodes
mesh health --all    # check all nodes
mesh repair --all    # fix broken services
mesh exec "cmd"      # run command on remote node
```

## Architecture

- **Tailscale** — encrypted WireGuard tunnel between nodes
- **NATS** — message bus for commands, heartbeats, file sync
- **Agent v3** — polling-based shared folder sync over NATS
- **MeshCentral** — remote desktop / terminal access
- **Mumble** — voice (Ubuntu server)

## Requirements

- Node.js >= 18
- Tailscale connected on both nodes
- `sudo` access (installs systemd/LaunchDaemon services)

## Safe to re-run

Every phase checks existing state first. Run it 10 times — same result.

## License

MIT
