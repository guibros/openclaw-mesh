---
name: mesh
description: >
  Multi-node mesh network for cross-machine file sharing, remote command execution,
  screenshots, and visual verification. Two nodes: macOS (lead) and Ubuntu (worker).
  Files dropped in ~/openclaw/shared/ auto-sync to all nodes via NATS.
  Use when you need to: run commands on the other machine, take screenshots on either
  node, share files between machines, verify visual output across nodes, or coordinate
  work across the mesh.
version: 1.0.0
user-invocable: true
metadata:
  openclaw:
    requires:
      bins:
        - mesh
    os:
      - macos
      - linux
---

# Mesh — Multi-Node Coordination

You have access to a **two-node mesh network** connected via NATS over Tailscale.

## Nodes

| Node | Platform | Role | Tailscale IP |
|------|----------|------|-------------|
| macOS (this machine) | darwin | **Lead** — orchestrates, delegates | 100.65.201.114 |
| Ubuntu | linux | **Worker** — executes, renders | 100.91.131.61 |

## Shared Folder

**`~/openclaw/shared/`** exists on both machines with identical contents.
Files placed here by either node are automatically synced to the other within seconds via NATS.

Use this folder for:
- Sharing code, configs, markdown, images between nodes
- Receiving screenshots from either node
- Passing build artifacts, test results, or renders between machines
- Any file that both nodes need access to

Screenshots are saved to `~/openclaw/shared/captures/`.

**The path is the same on both machines.** You can reference `~/openclaw/shared/whatever.png`
and it resolves correctly on both nodes.

## CLI — `mesh` command

The `mesh` CLI is available in your PATH. Use it via bash:

### Check mesh status
```bash
mesh status
```
Returns: which nodes are online, memory, uptime, number of shared files.

### Run a command on the Ubuntu node
```bash
mesh exec "ls -la /home/calos/projects/"
mesh exec "docker ps"
mesh exec "cat /etc/os-release"
```
Runs the command on the **remote** Ubuntu node and returns stdout/stderr.
Timeout: 30 seconds. For long-running tasks, background them.

### Take a screenshot on a specific node
```bash
mesh capture              # Screenshot this machine (macOS)
mesh capture --node ubuntu  # Screenshot the Ubuntu node
```
Screenshots are saved to `~/openclaw/shared/captures/` and auto-synced.
The command returns the file path.

### Health check the mesh
```bash
mesh health              # Check this node only
mesh health --all        # Check ALL nodes (local + remote)
mesh health --json       # Machine-readable JSON output
```
Checks every service: Tailscale, NATS, MeshCentral, Mumble, OpenClaw agent,
shared folder, mesh CLI, disk space, peer reachability.
Returns per-service status: ok / degraded / down.

### Self-repair the mesh
```bash
mesh repair              # Repair this node
mesh repair --all        # Repair ALL nodes (local + remote)
```
Runs health check first, then for each failed service:
- Restarts the systemd unit (Ubuntu) or LaunchDaemon (macOS)
- Recreates missing directories and fixes permissions
- Reconnects Tailscale if disconnected
- Clears stale logs and PID files
- Reports what it did and whether it worked

Requires sudo. Safe to re-run (idempotent).

### List shared files
```bash
mesh ls
mesh ls captures/
```

### Send a file to the shared folder
```bash
mesh put /path/to/local/file.txt
mesh put /path/to/image.png captures/
```
Copies the file into `~/openclaw/shared/` (optionally into a subdirectory).
It will auto-sync to the other node.

### Broadcast a message to all nodes
```bash
mesh broadcast "Build starting — do not reboot"
```

## When to use this skill

- **"Run this on Linux"** -> `mesh exec "<command>"`
- **"Check what the Ubuntu machine is showing"** -> `mesh capture --node ubuntu`
- **"Share this file with the other node"** -> `mesh put <file>`
- **"Is the other node online?"** -> `mesh status`
- **"Take a screenshot"** -> `mesh capture`
- **"Deploy to the Linux server"** -> `mesh exec` + `mesh put` for files
- **"Verify the UI on both platforms"** -> `mesh capture` + `mesh capture --node ubuntu`
- **"Is the mesh healthy?"** -> `mesh health --all`
- **"Something's broken / not responding"** -> `mesh health --all` then `mesh repair --all`
- **"Fix the mesh"** -> `mesh repair --all`
- **Before delegating work to the remote node** -> `mesh health --all` first
- **During heartbeat checks** -> `mesh health --json --all` for structured diagnostics
- **When a remote exec fails or times out** -> `mesh health` then `mesh repair` then retry
- Any cross-machine coordination

## Autonomous maintenance pattern

When using the mesh in HEARTBEAT.md or cron jobs, follow this pattern:

1. `mesh health --json --all` -- get structured status of entire mesh
2. If overall != "ok", run `mesh repair --all`
3. `mesh health --json --all` -- verify repair worked
4. If still broken, log the failure to `~/openclaw/shared/mesh-incidents.log`
   and alert the user
5. Only proceed with delegated work if mesh is healthy

This ensures the mesh self-heals before attempting cross-node operations.

## Security model

**Network isolation:** NATS listens on `0.0.0.0:4222` but is only reachable via Tailscale.
Tailscale is the authentication layer — no device outside the tailnet can connect.
There is no additional NATS auth (no tokens, no TLS) because the tailnet is the trust boundary.

**Exec audit log:** Every command run via `mesh exec` is logged to
`~/openclaw/shared/mesh-audit.log` with timestamp, node ID, command, and exit code.
This log auto-syncs to both nodes. Review it periodically.

**Destructive command blocklist:** The CLI blocks known-destructive patterns before they
reach the remote node:
- `rm -rf`, `mkfs`, `dd of=`, `curl|sh`, `chmod 777 /`, fork bombs
- If you need to run a blocked command, SSH into the node directly.

**Path traversal protection:** The agent validates all incoming file sync paths stay within
`~/openclaw/shared/`. Paths containing `../` that escape the shared directory are rejected
and logged to the audit log.

**Node discovery:** Use `mesh status` to discover online nodes dynamically.
Do not rely on hardcoded Tailscale IPs — they may change if nodes rejoin the tailnet.

## Anti-patterns — do NOT do these

- **Don't use `mesh exec` for long-running daemons.** The 30s timeout will kill them. Use systemd/launchd on the target node instead.
- **Don't sync files larger than 10MB via `mesh put`.** Use `scp` over Tailscale directly: `scp file calos@100.91.131.61:~/path/`
- **Don't run `mesh repair --all` in a tight loop.** It needs time for services to stabilize. Use the autonomous maintenance pattern with backoff.
- **Don't store secrets in `~/openclaw/shared/`.** It syncs to all nodes unencrypted over NATS. Use Tailscale's built-in file transfer for sensitive data.
- **Don't assume the shared folder is instant.** Polling interval is 2 seconds. If you write a file and immediately read it on the other node, it may not be there yet. Wait or verify.

## Important notes

- The Ubuntu node runs headless most of the time. Screenshots may show a terminal or desktop depending on session state.
- Commands on the remote node run as the `calos` user on Ubuntu.
- Max file sync size is 10MB per file. For larger files, use `scp` over Tailscale directly.
- The mesh agent runs as a systemd service (Ubuntu) and LaunchDaemon (macOS) — it survives reboots.
