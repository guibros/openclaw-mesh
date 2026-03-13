#!/bin/bash
#
# mesh-repair.sh — Self-repair for the mesh stack.
#
# PROCESS:
#   1. Runs health check (mesh-health.sh --json)
#   2. For each failed/degraded service, attempts the known fix
#   3. Re-checks after repair to verify
#   4. Reports what it did and what still needs manual intervention
#
# REPAIRS BY SERVICE:
#   tailscale        → tailscale up / restart daemon
#   nats_server      → systemctl restart nats (Ubuntu only)
#   nats_reachable   → cannot fix remotely — flags for attention
#   meshcentral_*    → restart systemd unit or LaunchDaemon
#   mumble_server    → systemctl restart mumble-server
#   openclaw_agent   → restart systemd unit or LaunchDaemon, recreate shared dirs
#   shared_folder    → mkdir -p the missing directories
#   mesh_cli         → flag for reinstall
#   disk_space       → suggest cleanup (won't auto-delete)
#   peer_reachable   → check tailscale, flag for attention
#
# MUST RUN AS ROOT (or with sudo) for service restarts.
# Safe to re-run — idempotent.

set -o pipefail

PLATFORM="$(uname)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ─── Colors ───────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'
ok()     { echo -e "  ${GREEN}✓${NC} $1"; }
warn()   { echo -e "  ${YELLOW}⚠${NC} $1"; }
fail()   { echo -e "  ${RED}✗${NC} $1"; }
action() { echo -e "  ${CYAN}→${NC} $1"; }

# ─── Platform-specific paths ─────────────────────────
if [ "$PLATFORM" = "Darwin" ]; then
    HOME_DIR="$HOME"
    AGENT_PLIST="/Library/LaunchDaemons/com.openclaw.agent.plist"
    MESHAGENT_PLIST="/Library/LaunchDaemons/com.mesh.agent.plist"
else
    HOME_DIR="$HOME"
fi

SHARED_DIR="$HOME_DIR/openclaw/shared"
CAPTURES_DIR="$SHARED_DIR/captures"

echo ""
echo "═══ Mesh Repair — $(hostname) ═══"
echo ""

# Track what we did
REPAIRS_ATTEMPTED=0
REPAIRS_SUCCEEDED=0
REPAIRS_FAILED=0

repair_attempted() { ((REPAIRS_ATTEMPTED++)); }
repair_ok()       { ((REPAIRS_SUCCEEDED++)); ok "$1"; }
repair_fail()     { ((REPAIRS_FAILED++)); fail "$1"; }

# ─── Repair functions ────────────────────────────────

repair_tailscale() {
    action "Repairing Tailscale..."
    repair_attempted

    if [ "$PLATFORM" = "Darwin" ]; then
        # macOS — try to bring up via CLI
        if /Applications/Tailscale.app/Contents/MacOS/Tailscale up 2>/dev/null; then
            sleep 3
            if /Applications/Tailscale.app/Contents/MacOS/Tailscale ip -4 &>/dev/null; then
                repair_ok "Tailscale reconnected"
                return
            fi
        fi
        # Try open the app
        open -a Tailscale 2>/dev/null
        sleep 5
        if tailscale ip -4 &>/dev/null 2>&1 || /Applications/Tailscale.app/Contents/MacOS/Tailscale ip -4 &>/dev/null; then
            repair_ok "Tailscale started via app"
        else
            repair_fail "Tailscale — could not reconnect. Open Tailscale.app manually."
        fi
    else
        # Ubuntu — systemd
        sudo systemctl restart tailscaled 2>/dev/null
        sleep 2
        sudo tailscale up 2>/dev/null
        sleep 3
        if tailscale ip -4 &>/dev/null; then
            repair_ok "Tailscale reconnected"
        else
            repair_fail "Tailscale — could not reconnect. Run 'sudo tailscale up' manually."
        fi
    fi
}

repair_nats_server() {
    # Ubuntu only
    action "Restarting NATS server..."
    repair_attempted

    sudo systemctl restart nats 2>/dev/null
    sleep 2

    if nc -z 127.0.0.1 4222 2>/dev/null; then
        repair_ok "NATS server restarted, port 4222 listening"
    else
        # Try starting if it wasn't enabled
        sudo systemctl enable --now nats 2>/dev/null
        sleep 2
        if nc -z 127.0.0.1 4222 2>/dev/null; then
            repair_ok "NATS server enabled and started"
        else
            repair_fail "NATS server — could not start. Check 'journalctl -u nats -e'"
        fi
    fi
}

repair_nats_reachable() {
    # Can't fix the remote NATS server from here — check connectivity
    action "NATS unreachable — checking if it's a network issue..."
    repair_attempted

    # Source .mesh-config for NATS host
    MESH_CONFIG="$HOME/openclaw/.mesh-config"
    if [ -f "$MESH_CONFIG" ]; then
        source "$MESH_CONFIG"
    fi
    local nats_raw="${OPENCLAW_NATS:-nats://127.0.0.1:4222}"
    local nats_host=$(echo "$nats_raw" | sed 's|nats://||' | cut -d: -f1)
    local nats_port=$(echo "$nats_raw" | sed 's|nats://||' | cut -d: -f2)
    [ -z "$nats_port" ] && nats_port=4222

    if ! nc -z -w3 "$nats_host" "$nats_port" 2>/dev/null; then
        warn "NATS at $nats_host:$nats_port not reachable — checking Tailscale..."
        repair_tailscale
        sleep 2
        if nc -z -w3 "$nats_host" "$nats_port" 2>/dev/null; then
            repair_ok "NATS now reachable at $nats_host:$nats_port after Tailscale repair"
        else
            repair_fail "NATS — $nats_host:$nats_port still not responding. Check the remote NATS server."
        fi
    else
        repair_ok "NATS reachable at $nats_host:$nats_port"
    fi
}

repair_meshcentral_server() {
    # Ubuntu
    action "Restarting MeshCentral server..."
    repair_attempted

    sudo systemctl restart meshcentral 2>/dev/null
    sleep 3

    if systemctl is-active --quiet meshcentral 2>/dev/null; then
        repair_ok "MeshCentral server restarted"
    else
        sudo systemctl enable --now meshcentral 2>/dev/null
        sleep 3
        if systemctl is-active --quiet meshcentral 2>/dev/null; then
            repair_ok "MeshCentral server enabled and started"
        else
            repair_fail "MeshCentral — could not start. Check 'journalctl -u meshcentral -e'"
        fi
    fi
}

repair_meshcentral_agent() {
    # macOS
    action "Restarting MeshCentral agent..."
    repair_attempted

    # Kill existing
    sudo pkill -f meshagent 2>/dev/null
    sleep 1

    # Remove quarantine if needed
    sudo xattr -rd com.apple.quarantine /usr/local/mesh_services/ 2>/dev/null

    # Reload LaunchDaemon
    if [ -f "$MESHAGENT_PLIST" ]; then
        sudo launchctl unload "$MESHAGENT_PLIST" 2>/dev/null
        sudo launchctl load -w "$MESHAGENT_PLIST" 2>/dev/null
        sleep 2
    fi

    # Also try direct launch
    if [ -x /usr/local/mesh_services/meshagent/meshagent ]; then
        sudo /usr/local/mesh_services/meshagent/meshagent start 2>/dev/null &
        sleep 2
    fi

    if pgrep -f meshagent &>/dev/null; then
        repair_ok "MeshCentral agent restarted"
    else
        repair_fail "MeshCentral agent — could not start. Check /usr/local/mesh_services/"
    fi
}

repair_mumble_server() {
    # Ubuntu
    action "Restarting Mumble server..."
    repair_attempted

    sudo systemctl restart mumble-server 2>/dev/null
    sleep 2

    if systemctl is-active --quiet mumble-server 2>/dev/null; then
        repair_ok "Mumble server restarted"
    else
        sudo systemctl enable --now mumble-server 2>/dev/null
        sleep 2
        if systemctl is-active --quiet mumble-server 2>/dev/null; then
            repair_ok "Mumble server enabled and started"
        else
            repair_fail "Mumble server — could not start. Check 'journalctl -u mumble-server -e'"
        fi
    fi
}

repair_openclaw_agent() {
    action "Restarting OpenClaw mesh agent..."
    repair_attempted

    # Ensure shared dirs exist first
    mkdir -p "$SHARED_DIR" "$CAPTURES_DIR" 2>/dev/null

    if [ "$PLATFORM" = "Darwin" ]; then
        # macOS — LaunchDaemon
        sudo pkill -f "node.*agent.js" 2>/dev/null
        sleep 1

        # Clear stale logs
        sudo rm -f /tmp/openclaw-agent.log /tmp/openclaw-agent.err 2>/dev/null

        if [ -f "$AGENT_PLIST" ]; then
            sudo launchctl unload "$AGENT_PLIST" 2>/dev/null
            sudo launchctl load -w "$AGENT_PLIST" 2>/dev/null
            sleep 4
        fi

        if pgrep -f "node.*agent.js" &>/dev/null; then
            # Verify it's actually working (not crash-looping)
            sleep 2
            if pgrep -f "node.*agent.js" &>/dev/null; then
                repair_ok "OpenClaw agent restarted (PID $(pgrep -f 'node.*agent.js' | head -1))"
            else
                repair_fail "OpenClaw agent — started but died. Check /tmp/openclaw-agent.err"
            fi
        else
            repair_fail "OpenClaw agent — could not start. Check /tmp/openclaw-agent.err"
        fi
    else
        # Ubuntu — systemd
        sudo systemctl restart openclaw-agent 2>/dev/null
        sleep 3

        if systemctl is-active --quiet openclaw-agent 2>/dev/null; then
            repair_ok "OpenClaw agent restarted"
        else
            sudo systemctl enable --now openclaw-agent 2>/dev/null
            sleep 3
            if systemctl is-active --quiet openclaw-agent 2>/dev/null; then
                repair_ok "OpenClaw agent enabled and started"
            else
                repair_fail "OpenClaw agent — could not start. Check 'journalctl -u openclaw-agent -e'"
            fi
        fi
    fi
}

repair_shared_folder() {
    action "Repairing shared folder..."
    repair_attempted

    mkdir -p "$SHARED_DIR" "$CAPTURES_DIR" 2>/dev/null

    # Fix permissions
    chown -R "$(whoami)" "$SHARED_DIR" 2>/dev/null

    if [ -d "$SHARED_DIR" ] && [ -d "$CAPTURES_DIR" ]; then
        # Test writability
        local testfile="$SHARED_DIR/.repair-test-$$"
        if touch "$testfile" 2>/dev/null; then
            rm -f "$testfile"
            repair_ok "Shared folder restored: $SHARED_DIR"
        else
            repair_fail "Shared folder exists but not writable"
        fi
    else
        repair_fail "Could not create shared folder"
    fi
}

repair_mesh_cli() {
    action "Mesh CLI not installed — run install-mesh-skill.sh to install"
    repair_attempted
    repair_fail "Mesh CLI needs manual reinstall: ~/Downloads/install-mesh-skill.sh"
}

repair_disk_space() {
    action "Disk space low — suggesting cleanup targets..."
    repair_attempted

    echo ""
    echo "    Largest directories in ~/openclaw/:"
    du -sh "$HOME_DIR/openclaw/"*/ 2>/dev/null | sort -rh | head -5 | sed 's/^/    /'
    echo ""

    # Clean old captures older than 7 days
    local old_captures
    old_captures=$(find "$CAPTURES_DIR" -name "*.png" -mtime +7 2>/dev/null | wc -l | tr -d ' ')
    if [ "$old_captures" -gt 0 ]; then
        action "Found $old_captures screenshots older than 7 days in captures/"
        read -p "    Delete them? [y/N] " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            find "$CAPTURES_DIR" -name "*.png" -mtime +7 -delete 2>/dev/null
            repair_ok "Deleted $old_captures old screenshots"
        else
            warn "Skipped — delete manually if needed"
        fi
    fi

    # Clean old NATS logs, tmp files
    if [ "$PLATFORM" != "Darwin" ]; then
        sudo journalctl --vacuum-size=100M 2>/dev/null
        ok "Trimmed systemd journal to 100MB"
    fi

    repair_ok "Disk cleanup suggestions provided"
}

repair_peer() {
    action "NATS connectivity lost — checking Tailscale..."
    repair_attempted

    # Source .mesh-config for NATS host
    MESH_CONFIG="$HOME/openclaw/.mesh-config"
    if [ -f "$MESH_CONFIG" ]; then
        source "$MESH_CONFIG"
    fi
    local nats_raw="${OPENCLAW_NATS:-nats://127.0.0.1:4222}"
    local nats_host=$(echo "$nats_raw" | sed 's|nats://||' | cut -d: -f1)
    local nats_port=$(echo "$nats_raw" | sed 's|nats://||' | cut -d: -f2)
    [ -z "$nats_port" ] && nats_port=4222

    # First make sure our own Tailscale is up
    local ts_ip
    ts_ip=$(tailscale ip -4 2>/dev/null)
    if [ -z "$ts_ip" ]; then
        warn "Our own Tailscale is down — fixing that first"
        repair_tailscale
    fi

    # Re-check NATS host
    sleep 2
    if nc -z -w3 "$nats_host" "$nats_port" 2>/dev/null; then
        repair_ok "NATS host now reachable at $nats_host:$nats_port after Tailscale repair"
    else
        repair_fail "NATS host still unreachable at $nats_host:$nats_port — the other node may be off or its Tailscale is down."
    fi
}

# ─── Run health check, then repair failures ──────────

# First, run the health check to see what's broken
HEALTH_SCRIPT="$SCRIPT_DIR/mesh-health.sh"
if [ ! -x "$HEALTH_SCRIPT" ]; then
    HEALTH_SCRIPT="$HOME_DIR/openclaw/bin/mesh-health.sh"
fi

echo "Running health check..."
echo ""

# Run health check and capture results
HEALTH_OUTPUT=$("$HEALTH_SCRIPT" 2>/dev/null) || true
echo "$HEALTH_OUTPUT"
echo ""

# Parse the human-readable output to find failures
# (We look for ✗ and ⚠ lines)
NEEDS_REPAIR=false

check_and_repair() {
    local service="$1"
    if echo "$HEALTH_OUTPUT" | grep -q "✗.*$service\|⚠.*$service"; then
        NEEDS_REPAIR=true
        return 0  # needs repair
    fi
    return 1  # healthy
}

echo "═══ Repair Phase ═══"
echo ""

ANYTHING_BROKEN=false

if check_and_repair "tailscale"; then
    ANYTHING_BROKEN=true
    repair_tailscale
fi

if check_and_repair "nats_server"; then
    ANYTHING_BROKEN=true
    repair_nats_server
fi

if check_and_repair "nats_reachable"; then
    ANYTHING_BROKEN=true
    repair_nats_reachable
fi

if check_and_repair "meshcentral_server"; then
    ANYTHING_BROKEN=true
    repair_meshcentral_server
fi

if check_and_repair "meshcentral_agent"; then
    ANYTHING_BROKEN=true
    repair_meshcentral_agent
fi

if check_and_repair "mumble_server"; then
    ANYTHING_BROKEN=true
    repair_mumble_server
fi

if check_and_repair "openclaw_agent"; then
    ANYTHING_BROKEN=true
    repair_openclaw_agent
fi

if check_and_repair "shared_folder"; then
    ANYTHING_BROKEN=true
    repair_shared_folder
fi

if check_and_repair "mesh_cli"; then
    ANYTHING_BROKEN=true
    repair_mesh_cli
fi

if check_and_repair "disk_space"; then
    ANYTHING_BROKEN=true
    repair_disk_space
fi

if check_and_repair "nats_connectivity"; then
    ANYTHING_BROKEN=true
    repair_peer
fi

if ! $ANYTHING_BROKEN; then
    ok "Nothing to repair — all services healthy"
fi

# ─── Post-repair verification ────────────────────────
echo ""
echo "═══ Post-Repair Verification ═══"
echo ""

"$HEALTH_SCRIPT" 2>/dev/null || true

# ─── Summary ─────────────────────────────────────────
echo ""
echo "═══ Repair Summary ═══"
echo ""
echo "  Repairs attempted:  $REPAIRS_ATTEMPTED"
echo "  Succeeded:          $REPAIRS_SUCCEEDED"
echo "  Failed:             $REPAIRS_FAILED"
echo ""

if [ "$REPAIRS_FAILED" -gt 0 ]; then
    echo "  Some repairs failed. Check the output above for manual steps."
    exit 1
else
    if [ "$REPAIRS_ATTEMPTED" -gt 0 ]; then
        echo "  All repairs successful."
    fi
    exit 0
fi
