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
mesh status                        # see online nodes
mesh exec "cmd"                    # run command on remote node
mesh exec --node ubuntu "cmd"      # run on specific node
mesh capture                       # screenshot local machine
mesh capture --node ubuntu         # screenshot remote node
mesh ls [subdir]                   # list shared folder contents
mesh put <filepath> [subdir]       # copy file into shared folder
mesh broadcast "message"           # send message to all nodes
mesh health --all                  # check all nodes
mesh repair --all                  # fix broken services
```

## Architecture

- **Tailscale** — encrypted WireGuard tunnel between nodes
- **NATS** — message bus for commands, heartbeats, file sync
- **Agent v3** — long-running daemon on each node: file sync, command execution, health reporting, screenshots

## NATS Configuration

The NATS server URL is resolved via a 4-step chain (first match wins):

| Priority | Source | Example |
|----------|--------|---------|
| 1 | `$OPENCLAW_NATS` env var | Set by systemd/launchd service |
| 2 | `~/.openclaw/openclaw.env` file | User-editable config |
| 3 | `~/openclaw/.mesh-config` file | Written by setup.sh |
| 4 | Fallback | `nats://127.0.0.1:4222` |

Auth tokens follow the same chain via `$OPENCLAW_NATS_TOKEN` / `OPENCLAW_NATS_TOKEN=` in config files.

## File Sync

Agent v3 polls `~/openclaw/shared/` every 2 seconds for changes. When a file is added or modified, it's published to all nodes over NATS. Synced files land in the same `~/openclaw/shared/` path on every connected node.

| Setting | Value |
|---------|-------|
| Poll interval | 2 seconds |
| Max file size | 10 MB |
| Change detection | mtime + size comparison |
| Echo prevention | 4-second cooldown per file after receiving a sync |
| Binary support | Yes (base64-encoded over NATS) |

## Command Safety

Both the mesh CLI and the agent enforce command safety filters.

**Mesh CLI** (`mesh exec`) blocks destructive patterns before sending to NATS:

- `rm -rf` / `rm -fr` — recursive force delete
- `mkfs` — filesystem format
- `dd ... of=` — raw disk write
- `curl | bash` / `wget | sh` — pipe-to-shell
- `chmod 777 /` — open permissions on root paths
- Fork bombs

If a command matches, it's blocked with an explanation. Run it via SSH directly if intentional.

**Agent** uses a dual-layer filter on incoming commands:

- **Allowlist** — only whitelisted command prefixes are accepted (ls, cat, git, node, npm, etc.)
- **Blocklist** — even allowed commands are rejected if they match dangerous patterns

All command executions are logged to `~/openclaw/mesh-audit.log`.

## Node Aliases

Create `~/openclaw/.mesh-aliases.json` to define shorthand names:

```json
{
  "ubuntu": "calos-ubuntu-server",
  "mac": "guis-macbook-pro"
}
```

Then use `mesh exec --node ubuntu "cmd"` instead of the full hostname.

## Health & Repair

**`mesh health`** checks: Tailscale connectivity, NATS server, Node.js, agent service, disk usage, memory.

**`mesh repair`** auto-fixes: restarts failed services (systemd on Linux, launchd on macOS), re-enables disabled units, fixes file permissions.

Both scripts work locally or remotely via `--node` or `--all` flags.

## Requirements

- Node.js >= 22
- Tailscale connected on both nodes
- `sudo` access (installs systemd/LaunchDaemon services)

## Testing

```bash
npm test
```

See [TEST.md](TEST.md) for details on the test suite.

## Safe to re-run

Every phase checks existing state first. Run it 10 times — same result.

## License

MIT
