#!/bin/bash
#
# openclaw-mesh setup — idempotent mesh deployer
#
# Called by: npx openclaw-mesh (via bin/cli.js)
# Or directly: FILES_DIR=/path/to/files sudo bash setup.sh [flags]
#
# Flags:
#   --nats-url <url>    NATS server URL (e.g. nats://10.0.0.5:4222)
#   --node-id  <id>     Node identifier (default: sanitized hostname)
#   --role     <role>   Node role: lead | worker (default: lead on macOS, worker on Linux)
#   --user     <name>   OS user to own openclaw files (default: auto-detect)
#
# Detects platform (macOS/Linux), installs what's missing, skips what's there.
# Safe to re-run any number of times.

set -e

# ── FILES_DIR: where agent.js, mesh.js, etc. live ──
# Set by cli.js, or derived from this script's location if run standalone
if [ -z "$FILES_DIR" ]; then
    SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
    FILES_DIR="$SCRIPT_DIR/files"
fi

if [ ! -d "$FILES_DIR" ]; then
    echo "ERROR: files/ directory not found at $FILES_DIR"
    echo "Run via: npx openclaw-mesh"
    exit 1
fi

# ============================================================
# CLI FLAGS
# ============================================================
CLI_NATS_URL=""
CLI_NODE_ID=""
CLI_ROLE=""
CLI_USER=""

while [ $# -gt 0 ]; do
    case "$1" in
        --nats-url) CLI_NATS_URL="$2"; shift 2 ;;
        --node-id)  CLI_NODE_ID="$2";  shift 2 ;;
        --role)     CLI_ROLE="$2";     shift 2 ;;
        --user)     CLI_USER="$2";     shift 2 ;;
        -h|--help)
            echo "Usage: sudo bash setup.sh [--nats-url URL] [--node-id ID] [--role lead|worker] [--user NAME]"
            exit 0 ;;
        *) echo "Unknown flag: $1"; exit 1 ;;
    esac
done

NATS_PORT=4222

# ============================================================
# COLORS + HELPERS
# ============================================================
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

ok()     { echo -e "  ${GREEN}[OK]${NC} $1"; }
skip()   { echo -e "  ${CYAN}[SKIP]${NC} $1 (already there)"; }
warn()   { echo -e "  ${YELLOW}[WARN]${NC} $1"; }
fail()   { echo -e "  ${RED}[FAIL]${NC} $1"; }
action() { echo -e "  ${CYAN}-->>${NC} $1"; }
header() { echo -e "\n${BOLD}=== $1 ===${NC}\n"; }

# ============================================================
# PHASE 1 — Platform Detection + Dynamic Resolution
# ============================================================
header "Phase 1: Platform Detection"

PLATFORM="$(uname -s)"
if [ "$PLATFORM" != "Darwin" ] && [ "$PLATFORM" != "Linux" ]; then
    fail "Unsupported platform: $PLATFORM"; exit 1
fi

# --- NODE_USER: flag → logname → SUDO_USER → whoami ---
if [ -n "$CLI_USER" ]; then
    NODE_USER="$CLI_USER"
elif [ -n "$(logname 2>/dev/null)" ]; then
    NODE_USER="$(logname 2>/dev/null)"
elif [ -n "$SUDO_USER" ]; then
    NODE_USER="$SUDO_USER"
else
    NODE_USER="$(whoami)"
fi

# --- NODE_ID: flag → sanitized hostname ---
if [ -n "$CLI_NODE_ID" ]; then
    NODE_ID="$CLI_NODE_ID"
else
    NODE_ID="$(hostname -s 2>/dev/null || hostname)"
    # Sanitize: lowercase, replace non-alphanum with dash, trim dashes
    NODE_ID="$(echo "$NODE_ID" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g; s/^-*//; s/-*$//')"
fi

# --- NODE_ROLE: flag → Darwin=lead, Linux=worker ---
if [ -n "$CLI_ROLE" ]; then
    NODE_ROLE="$CLI_ROLE"
elif [ "$PLATFORM" = "Darwin" ]; then
    NODE_ROLE="lead"
else
    NODE_ROLE="worker"
fi

# --- NODE_HOME: resolve from user ---
NODE_HOME="$(eval echo "~$NODE_USER")"
if [ "$NODE_HOME" = "~$NODE_USER" ] || [ ! -d "$NODE_HOME" ]; then
    fail "Cannot resolve home directory for user '$NODE_USER'"; exit 1
fi

ok "$PLATFORM ($NODE_ROLE node, user=$NODE_USER, id=$NODE_ID)"

OPENCLAW_DIR="$NODE_HOME/openclaw"
SHARED_DIR="$OPENCLAW_DIR/shared"
BIN_DIR="$OPENCLAW_DIR/bin"
OPENCLAW_HOME="$NODE_HOME/.openclaw"
OPENCLAW_WORKSPACE="$OPENCLAW_HOME/workspace"
SKILL_DIR="$OPENCLAW_HOME/skills/mesh"

echo "  User: $NODE_USER | Home: $NODE_HOME | Role: $NODE_ROLE | ID: $NODE_ID"

if [ "$(id -u)" -ne 0 ]; then
    fail "Must run as root. Use: sudo $0"; exit 1
fi

# --- NATS_URL resolution chain: flag → env → openclaw.env → auto-detect ---
action "Resolving NATS URL..."
NATS_URL=""
if [ -n "$CLI_NATS_URL" ]; then
    NATS_URL="$CLI_NATS_URL"
    ok "NATS URL from --nats-url flag: $NATS_URL"
elif [ -n "$OPENCLAW_NATS" ]; then
    NATS_URL="$OPENCLAW_NATS"
    ok "NATS URL from OPENCLAW_NATS env: $NATS_URL"
elif [ -f "$OPENCLAW_HOME/openclaw.env" ] && grep -q '^OPENCLAW_NATS=' "$OPENCLAW_HOME/openclaw.env" 2>/dev/null; then
    NATS_URL="$(grep '^OPENCLAW_NATS=' "$OPENCLAW_HOME/openclaw.env" | head -1 | cut -d= -f2-)"
    ok "NATS URL from openclaw.env: $NATS_URL"
elif nc -z 127.0.0.1 "$NATS_PORT" 2>/dev/null; then
    NATS_URL="nats://127.0.0.1:$NATS_PORT"
    ok "NATS URL auto-detected (local): $NATS_URL"
else
    fail "Cannot determine NATS URL."
    echo "  Provide one of:"
    echo "    --nats-url nats://YOUR_NATS_IP:4222"
    echo "    export OPENCLAW_NATS=nats://YOUR_NATS_IP:4222"
    echo "    echo 'OPENCLAW_NATS=nats://YOUR_NATS_IP:4222' >> ~/.openclaw/openclaw.env"
    exit 1
fi

# ============================================================
# PHASE 2 — Infrastructure
# ============================================================
header "Phase 2: Infrastructure"

action "Checking Tailscale..."
if command -v tailscale &>/dev/null; then
    TS_IP=$(tailscale ip -4 2>/dev/null || true)
    [ -n "$TS_IP" ] && ok "Tailscale connected: $TS_IP" || warn "Tailscale not connected. Run 'sudo tailscale up'."
else
    warn "Tailscale not found. Install it first."
fi

action "Checking Node.js..."
if command -v node &>/dev/null; then
    ok "Node.js $(node -v)"
else
    if [ "$PLATFORM" = "Linux" ]; then
        action "Installing Node.js..."
        curl -fsSL https://deb.nodesource.com/setup_20.x 2>/dev/null | bash - 2>/dev/null
        apt-get install -y nodejs 2>/dev/null
        command -v node &>/dev/null && ok "Node.js $(node -v) installed" || fail "Node.js install failed"
    else
        warn "Install Node.js manually: https://nodejs.org"
    fi
fi

if [ "$PLATFORM" = "Linux" ]; then
    action "Checking NATS server..."
    if nc -z 127.0.0.1 $NATS_PORT 2>/dev/null; then
        skip "NATS server (port $NATS_PORT responding)"
    else
        if ! command -v nats-server &>/dev/null; then
            action "Installing NATS server..."
            NATS_VER="v2.10.24"
            cd /tmp
            curl -fsSL "https://github.com/nats-io/nats-server/releases/download/${NATS_VER}/nats-server-${NATS_VER}-linux-amd64.tar.gz" -o nats.tar.gz 2>/dev/null
            tar xzf nats.tar.gz
            cp nats-server-*/nats-server /usr/local/bin/
            rm -rf nats-server-* nats.tar.gz
        fi
        cat > /etc/systemd/system/nats.service << 'NATSEOF'
[Unit]
Description=NATS Server
After=network.target tailscaled.service
[Service]
ExecStart=/usr/local/bin/nats-server -p 4222 --addr 0.0.0.0
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
NATSEOF
        systemctl daemon-reload
        systemctl enable --now nats
        sleep 2
        nc -z 127.0.0.1 $NATS_PORT 2>/dev/null && ok "NATS running on :$NATS_PORT" || fail "NATS not responding"
    fi
fi

action "Checking NATS npm package..."
mkdir -p "$OPENCLAW_DIR"
chown "$NODE_USER" "$OPENCLAW_DIR"
if [ -d "$OPENCLAW_DIR/node_modules/nats" ]; then
    skip "NATS npm package"
else
    action "Installing NATS npm package..."
    cd "$OPENCLAW_DIR"
    [ -f package.json ] || su "$NODE_USER" -c "cd $OPENCLAW_DIR && npm init -y" 2>/dev/null
    su "$NODE_USER" -c "cd $OPENCLAW_DIR && npm install nats" 2>/dev/null
    [ -d "$OPENCLAW_DIR/node_modules/nats" ] && ok "NATS npm package" || fail "npm install nats failed"
fi

# ============================================================
# PHASE 3 — Agent + Shared Folder + Service
# ============================================================
header "Phase 3: Agent Deployment"

mkdir -p "$SHARED_DIR/captures" "$BIN_DIR"
chown -R "$NODE_USER" "$OPENCLAW_DIR"

action "Deploying agent.js..."
cp "$FILES_DIR/agent.js" "$OPENCLAW_DIR/agent.js"
chown "$NODE_USER" "$OPENCLAW_DIR/agent.js"
chmod +x "$OPENCLAW_DIR/agent.js"
ok "agent.js -> $OPENCLAW_DIR/agent.js"

action "Writing .mesh-config..."
MESH_CONFIG="$OPENCLAW_DIR/.mesh-config"
cat > "$MESH_CONFIG" << CFGEOF
# openclaw-mesh node configuration — auto-generated by setup.sh
# Re-run setup.sh to regenerate, or edit manually.
OPENCLAW_NATS=$NATS_URL
OPENCLAW_NODE_ID=$NODE_ID
OPENCLAW_NODE_ROLE=$NODE_ROLE
CFGEOF
chown "$NODE_USER" "$MESH_CONFIG"
ok ".mesh-config -> $MESH_CONFIG"

action "Installing auto-start service..."
if [ "$PLATFORM" = "Linux" ]; then
    # Enable lingering so user services survive logout
    action "Enabling loginctl linger for $NODE_USER..."
    if command -v loginctl &>/dev/null; then
        loginctl enable-linger "$NODE_USER" 2>/dev/null && ok "loginctl linger enabled for $NODE_USER" || warn "loginctl enable-linger failed (non-fatal)"
    fi

    cat > /etc/systemd/system/openclaw-agent.service << SVCEOF
[Unit]
Description=OpenClaw Mesh Agent
After=network.target nats.service tailscaled.service
Wants=nats.service
[Service]
Type=simple
User=$NODE_USER
WorkingDirectory=$OPENCLAW_DIR
Environment=OPENCLAW_NATS=$NATS_URL
Environment=OPENCLAW_NODE_ID=$NODE_ID
Environment=OPENCLAW_NODE_ROLE=$NODE_ROLE
Environment=HOME=$NODE_HOME
Environment=PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$OPENCLAW_DIR/bin
ExecStart=$(which node) $OPENCLAW_DIR/agent.js
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
SVCEOF
    systemctl daemon-reload
    systemctl enable openclaw-agent
    systemctl restart openclaw-agent
    sleep 6
    systemctl is-active --quiet openclaw-agent && \
        ok "Agent running (systemd, PID $(systemctl show -p MainPID --value openclaw-agent))" || \
        warn "Agent service installed but not running"
else
    PLIST="/Library/LaunchDaemons/com.openclaw.agent.plist"
    NODE_BIN=$(which node)
    cat > "$PLIST" << PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.openclaw.agent</string>
    <key>UserName</key>
    <string>$NODE_USER</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>$OPENCLAW_DIR/agent.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$OPENCLAW_DIR</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>OPENCLAW_NATS</key>
        <string>$NATS_URL</string>
        <key>OPENCLAW_NODE_ID</key>
        <string>$NODE_ID</string>
        <key>OPENCLAW_NODE_ROLE</key>
        <string>$NODE_ROLE</string>
        <key>HOME</key>
        <string>$NODE_HOME</string>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$OPENCLAW_DIR/bin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/openclaw-agent.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/openclaw-agent.err</string>
</dict>
</plist>
PLISTEOF
    rm -f /tmp/openclaw-agent.log /tmp/openclaw-agent.err
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load -w "$PLIST"
    sleep 6
    pgrep -f "node.*agent.js" &>/dev/null && \
        ok "Agent running (LaunchDaemon, PID $(pgrep -f 'node.*agent.js' | head -1))" || \
        warn "Agent plist installed but not running — check /tmp/openclaw-agent.err"
fi

# --- Sudoers for headless repair (remote NATS exec has no tty) ---
action "Configuring passwordless service management for mesh repair..."
SUDOERS_FILE="/etc/sudoers.d/openclaw-mesh"
if [ -f "$SUDOERS_FILE" ]; then
    skip "Sudoers rules"
else
    if [ "$PLATFORM" = "Linux" ]; then
        cat > "$SUDOERS_FILE" << SUDEOF
# OpenClaw mesh — allow agent to restart services without password
$NODE_USER ALL=(ALL) NOPASSWD: /bin/systemctl restart openclaw-agent
$NODE_USER ALL=(ALL) NOPASSWD: /bin/systemctl restart nats
$NODE_USER ALL=(ALL) NOPASSWD: /bin/systemctl start openclaw-agent
$NODE_USER ALL=(ALL) NOPASSWD: /bin/systemctl start nats
$NODE_USER ALL=(ALL) NOPASSWD: /bin/systemctl stop openclaw-agent
$NODE_USER ALL=(ALL) NOPASSWD: /usr/bin/killall -9 node
SUDEOF
    else
        cat > "$SUDOERS_FILE" << SUDEOF
# OpenClaw mesh — allow agent to restart services without password
$NODE_USER ALL=(ALL) NOPASSWD: /bin/launchctl load *
$NODE_USER ALL=(ALL) NOPASSWD: /bin/launchctl unload *
$NODE_USER ALL=(ALL) NOPASSWD: /usr/bin/killall -9 node
SUDEOF
    fi
    chmod 0440 "$SUDOERS_FILE"
    visudo -cf "$SUDOERS_FILE" 2>/dev/null && ok "Sudoers rules installed" || {
        fail "Sudoers syntax error — removing"
        rm -f "$SUDOERS_FILE"
    }
fi

# ============================================================
# PHASE 4 — Mesh CLI + Health + Repair
# ============================================================
header "Phase 4: Mesh CLI + Health + Repair"

action "Deploying mesh CLI..."
cp "$FILES_DIR/mesh.js" "$BIN_DIR/mesh.js"
cat > "$BIN_DIR/mesh" << 'MESHWRAP'
#!/bin/bash
export NODE_PATH="$HOME/openclaw/node_modules:$NODE_PATH"
exec node "$HOME/openclaw/bin/mesh.js" "$@"
MESHWRAP
chmod +x "$BIN_DIR/mesh" "$BIN_DIR/mesh.js"
ok "mesh CLI"

action "Deploying health + repair..."
cp "$FILES_DIR/mesh-health.sh" "$BIN_DIR/mesh-health.sh"
cp "$FILES_DIR/mesh-repair.sh" "$BIN_DIR/mesh-repair.sh"
chmod +x "$BIN_DIR/mesh-health.sh" "$BIN_DIR/mesh-repair.sh"
chown -R "$NODE_USER" "$BIN_DIR"
ok "Health + Repair"

add_path() {
    local p="$1"
    [ -f "$p" ] || return 0
    grep -q 'openclaw/bin' "$p" 2>/dev/null && { skip "PATH in $(basename $p)"; return; }
    echo -e '\n# OpenClaw mesh CLI\nexport PATH="$HOME/openclaw/bin:$PATH"' >> "$p"
    ok "PATH updated in $(basename $p)"
}
if [ "$PLATFORM" = "Darwin" ]; then
    add_path "$NODE_HOME/.zshrc"; add_path "$NODE_HOME/.zprofile"
else
    add_path "$NODE_HOME/.bashrc"; add_path "$NODE_HOME/.profile"
fi

# Symlink into /usr/local/bin so mesh works IMMEDIATELY — no "source ~/.bashrc" needed
action "Symlinking mesh tools to /usr/local/bin..."
mkdir -p /usr/local/bin 2>/dev/null || true
if ln -sf "$BIN_DIR/mesh" /usr/local/bin/mesh 2>/dev/null && \
   ln -sf "$BIN_DIR/mesh-health.sh" /usr/local/bin/mesh-health 2>/dev/null && \
   ln -sf "$BIN_DIR/mesh-repair.sh" /usr/local/bin/mesh-repair 2>/dev/null; then
    ok "mesh, mesh-health, mesh-repair available globally"
else
    warn "Could not symlink to /usr/local/bin (SIP?). Use: source ~/.zshrc"
fi

# ============================================================
# PHASE 5 — OpenClaw Integration
# ============================================================
header "Phase 5: OpenClaw Integration"

mkdir -p "$SKILL_DIR" "$OPENCLAW_WORKSPACE" "$OPENCLAW_HOME/skills"
chown -R "$NODE_USER" "$OPENCLAW_HOME"

action "Installing mesh skill..."
cp "$FILES_DIR/SKILL.md" "$SKILL_DIR/SKILL.md"
chown -R "$NODE_USER" "$SKILL_DIR"
ok "Skill -> $SKILL_DIR/SKILL.md"

action "Linking shared folder..."
WS_LINK="$OPENCLAW_WORKSPACE/shared"
if [ -L "$WS_LINK" ]; then skip "Workspace symlink"
elif [ -d "$WS_LINK" ]; then warn "shared/ is a real dir, skipping symlink"
else ln -s "$SHARED_DIR" "$WS_LINK"; ok "Symlink: workspace/shared -> $SHARED_DIR"
fi

action "Checking HEARTBEAT.md..."
HB="$OPENCLAW_WORKSPACE/HEARTBEAT.md"
if [ -f "$HB" ] && grep -q "Mesh maintenance" "$HB" 2>/dev/null; then
    skip "HEARTBEAT mesh section"
else
    echo "" >> "$HB"
    cat "$FILES_DIR/HEARTBEAT-snippet.md" >> "$HB"
    chown "$NODE_USER" "$HB"
    ok "HEARTBEAT.md updated"
fi

# ============================================================
# PHASE 6 — Verification
# ============================================================
header "Phase 6: Verification"

# Extract host:port from NATS_URL for connectivity check
NATS_HOST="$(echo "$NATS_URL" | sed 's|^nats://||; s|:.*||')"
NATS_CHECK_PORT="$(echo "$NATS_URL" | sed 's|^nats://||; s|.*:||')"
[ -z "$NATS_CHECK_PORT" ] && NATS_CHECK_PORT="$NATS_PORT"

action "Checking NATS connectivity ($NATS_HOST:$NATS_CHECK_PORT)..."
if nc -z "$NATS_HOST" "$NATS_CHECK_PORT" 2>/dev/null; then
    ok "NATS reachable at $NATS_HOST:$NATS_CHECK_PORT"
else
    warn "NATS not reachable at $NATS_HOST:$NATS_CHECK_PORT — agent may fail to connect"
fi

action "Running health check..."
su "$NODE_USER" -c "export PATH='$BIN_DIR:$PATH'; export NODE_PATH='$OPENCLAW_DIR/node_modules'; bash '$BIN_DIR/mesh-health.sh'" 2>/dev/null || true

header "Bootstrap Complete"
echo ""
echo "  Platform:  $PLATFORM ($NODE_ROLE)"
echo "  Node ID:   $NODE_ID"
echo "  NATS:      $NATS_URL"
echo "  Agent:     $OPENCLAW_DIR/agent.js (auto-starts on boot)"
echo "  Config:    $OPENCLAW_DIR/.mesh-config"
echo "  Shared:    $SHARED_DIR (synced between nodes)"
echo "  CLI:       $BIN_DIR/mesh"
echo "  Skill:     $SKILL_DIR/SKILL.md"
echo ""
echo "  Open a new terminal and run:"
echo "    mesh status       # online nodes"
echo "    mesh health --all # check everything"
echo "    mesh repair --all # fix broken services"
echo ""

exit 0

# ============================================================
# COMPRESSED ARCHIVE — everything below is the base64-encoded
# tar.gz containing the files/ directory. The script extracts
# this automatically on run. Do not edit below this line.
# ============================================================
