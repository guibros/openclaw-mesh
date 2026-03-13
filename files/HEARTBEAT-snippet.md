# Mesh Health (add to ~/.openclaw/workspace/HEARTBEAT.md)

## Mesh maintenance check

Every heartbeat, verify the mesh is operational:

1. Run `mesh health --json --all` silently
2. Parse the JSON — check if `overall` is `"ok"` for each node
3. If any node shows `"degraded"` or `"down"`:
   a. Run `mesh repair --all`
   b. Wait 10 seconds, then `mesh health --json --all` again
   c. If still broken, append a timestamped entry to `~/openclaw/shared/mesh-incidents.log`:
      ```
      [2026-03-02T14:30:00Z] UNRESOLVED: ubuntu/nats_server down after repair attempt
      ```
   d. If the issue persists across 3 consecutive heartbeats, escalate:
      send a message to the user noting which services are down and what was tried.
4. If all healthy: HEARTBEAT_OK (no output needed)

**Priority**: Run this check BEFORE any task that involves the remote node.
If mesh is unhealthy, do not delegate work to the remote node — do it locally or queue it.
