#!/usr/bin/env node

/**
 * OpenClaw Agent v3 — Mesh node with POLLING-based shared folder sync.
 *
 * v2 used fs.watch which is silently broken in VMware VMs.
 * v3 uses a polling loop — scans ~/openclaw/shared/ every 2 seconds,
 * detects new/changed files by mtime+size, syncs over NATS. Bulletproof.
 *
 * SHARED FOLDER: ~/openclaw/shared/
 *   - Drop any file here — it syncs to all other nodes within 2 seconds
 *   - Screenshots land in shared/captures/
 *   - Same path on every machine. Drag it into your chat. Done.
 *
 * NATS subjects:
 *   openclaw.{node}.exec           — run a command on this node
 *   openclaw.{node}.capture        — screenshot, save to shared folder
 *   openclaw.{node}.heartbeat      — node status
 *   openclaw.sync.file             — file sync (all nodes)
 *   openclaw.sync.delete           — file deletion sync
 *   openclaw.broadcast             — messages to all nodes
 */

const { connect, StringCodec } = require('nats');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { NATS_URL } = require('./lib/nats-resolve');

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const NODE_ID = process.env.OPENCLAW_NODE_ID || os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, '-');
const SHARED_DIR = path.join(os.homedir(), 'openclaw', 'shared');
const CAPTURE_DIR = path.join(SHARED_DIR, 'captures');
const PLATFORM = os.platform();
const sc = StringCodec();

// Read role from .mesh-config if available
let NODE_ROLE = process.env.OPENCLAW_NODE_ROLE || '';
try {
  const meshConfig = path.join(os.homedir(), 'openclaw', '.mesh-config');
  if (fs.existsSync(meshConfig)) {
    const content = fs.readFileSync(meshConfig, 'utf8');
    const match = content.match(/^\s*OPENCLAW_NODE_ROLE\s*=\s*(.+)/m);
    if (match) NODE_ROLE = match[1].trim();
  }
} catch { /* best-effort */ }
if (!NODE_ROLE) NODE_ROLE = PLATFORM === 'darwin' ? 'lead' : 'worker';

// Polling interval in ms
const POLL_INTERVAL = 2000;

// Max file size to sync (10MB)
const MAX_SYNC_SIZE = 10 * 1024 * 1024;

// Track peers
const peers = {};

// File state tracking for polling — maps relativePath → { mtimeMs, size }
const knownFiles = new Map();

// Files recently written by sync — skip these in the poller to prevent echo
const recentSyncs = new Set();
const SYNC_COOLDOWN = 4000;

// Ensure directories
[SHARED_DIR, CAPTURE_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ─────────────────────────────────────────────
// AUDIT LOG
// ─────────────────────────────────────────────
const AUDIT_LOG = path.join(SHARED_DIR, 'mesh-audit.log');

function auditLog(action, detail) {
  const entry = `[${new Date().toISOString()}] [${NODE_ID}] ${action}: ${detail}\n`;
  try { fs.appendFileSync(AUDIT_LOG, entry); } catch { /* best-effort */ }
}

// ─────────────────────────────────────────────
// PATH SAFETY
// ─────────────────────────────────────────────
function isSafePath(relativePath) {
  const abs = path.resolve(SHARED_DIR, relativePath);
  return abs.startsWith(SHARED_DIR + path.sep) || abs === SHARED_DIR;
}

// ─────────────────────────────────────────────
// SCREENSHOT
// ─────────────────────────────────────────────
function screenshot(label = 'capture', region = null) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${NODE_ID}-${label}-${timestamp}.png`;
  const filepath = path.join(CAPTURE_DIR, filename);

  try {
    if (PLATFORM === 'darwin') {
      region
        ? execSync(`screencapture -R${region} -x "${filepath}"`)
        : execSync(`screencapture -x "${filepath}"`);
    } else {
      try { execSync(`scrot "${filepath}"`); }
      catch { execSync(`import -window root "${filepath}"`); }
    }
    const size = fs.statSync(filepath).size;
    console.log(`[${NODE_ID}] Screenshot: ${filepath} (${(size / 1024).toFixed(1)}KB)`);
    return filepath;
  } catch (err) {
    console.error(`[${NODE_ID}] Screenshot failed: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────
// HEALTH — gather system info for MC dashboard
// ─────────────────────────────────────────────
function gatherHealth() {
  const uptimeSeconds = Math.floor(os.uptime());
  const memTotal = Math.round(os.totalmem() / 1048576);
  const memFree = Math.round(os.freemem() / 1048576);

  // Disk usage (cross-platform)
  let diskPercent = 0;
  try {
    if (PLATFORM === 'darwin') {
      const df = execSync("df -h / | tail -1", { encoding: 'utf8', timeout: 5000 });
      const m = df.match(/(\d+)%/);
      if (m) diskPercent = parseInt(m[1], 10);
    } else {
      const df = execSync("df --output=pcent / | tail -1", { encoding: 'utf8', timeout: 5000 });
      const m = df.trim().match(/(\d+)/);
      if (m) diskPercent = parseInt(m[1], 10);
    }
  } catch { /* best-effort */ }

  // Tailscale IP
  let tailscaleIp = '—';
  try {
    tailscaleIp = execSync('tailscale ip -4', { encoding: 'utf8', timeout: 5000 }).trim();
  } catch { /* not on tailscale */ }

  // Services check
  const services = [];
  if (PLATFORM === 'darwin') {
    const macServices = [
      { name: 'mesh-agent', pattern: 'mesh-agent.js' },
      { name: 'mesh-task-daemon', pattern: 'mesh-task-daemon' },
      { name: 'mesh-bridge', pattern: 'mesh-bridge' },
      { name: 'memory-daemon', pattern: 'memory-daemon' },
      { name: 'mission-control', pattern: 'mission-control.*next|next.*mission-control' },
      { name: 'gateway', pattern: 'openclaw-gateway' },
    ];
    for (const { name, pattern } of macServices) {
      try {
        const out = execSync(`pgrep -f '${pattern}'`, { encoding: 'utf8', timeout: 2000 }).trim();
        const pids = out.split('\n').filter(Boolean);
        const pid = pids.length > 0 ? parseInt(pids[0], 10) : undefined;
        services.push({ name, status: pid ? 'active' : 'idle', pid });
      } catch {
        services.push({ name, status: 'down' });
      }
    }
  } else {
    for (const svc of ['nats', 'openclaw-agent']) {
      try {
        const out = execSync(`systemctl is-active ${svc}`, { encoding: 'utf8', timeout: 3000 }).trim();
        let pid;
        try {
          pid = parseInt(execSync(`systemctl show ${svc} -p MainPID --value`, { encoding: 'utf8', timeout: 3000 }).trim(), 10) || undefined;
        } catch { /* no pid */ }
        services.push({ name: svc, status: out === 'active' ? 'active' : out, pid });
      } catch {
        services.push({ name: svc, status: 'down' });
      }
    }
  }

  // Agent status — detect if a claude process is running
  let agentStatus = 'idle';
  let currentTask = null;
  let llm = null;
  let model = null;
  try {
    const ps = execSync("ps aux | grep -i 'claude' | grep -v grep", { encoding: 'utf8', timeout: 3000 });
    if (ps.trim().length > 0) {
      agentStatus = 'working';
      llm = 'anthropic';
      model = 'claude';
    }
  } catch { /* no claude process */ }

  // Capabilities
  const capabilities = ['exec', 'sync', 'capture'];
  try { execSync('which claude', { timeout: 2000 }); capabilities.push('claude-cli'); } catch {}
  try { execSync('which docker', { timeout: 2000 }); capabilities.push('docker'); } catch {}
  try { execSync('which node', { timeout: 2000 }); capabilities.push('node'); } catch {}
  if (PLATFORM === 'linux') {
    try { execSync('which scrot', { timeout: 2000 }); capabilities.push('scrot'); } catch {}
  }

  return {
    nodeId: NODE_ID,
    platform: PLATFORM,
    role: NODE_ROLE,
    tailscaleIp,
    diskPercent,
    mem: { total: memTotal, free: memFree },
    uptimeSeconds,
    services,
    agent: {
      status: agentStatus,
      currentTask,
      llm,
      model,
    },
    capabilities,
    stats: {
      tasksToday: 0,
      successRate: 1.0,
      tokenSpendTodayUsd: 0,
    },
  };
}

// ─────────────────────────────────────────────
// FILE SCANNING — recursive directory scan
// ─────────────────────────────────────────────
function scanDir(dir) {
  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...scanDir(full));
      } else {
        results.push(full);
      }
    }
  } catch { /* ignore permission errors */ }
  return results;
}

// ─────────────────────────────────────────────
// POLLING SYNC — the core loop
// ─────────────────────────────────────────────

/**
 * Scans ~/openclaw/shared/ every POLL_INTERVAL ms.
 * Compares file mtime+size against last known state.
 * Publishes new/changed files over NATS.
 * Detects deleted files and publishes deletions.
 */
function startPolling(nc) {
  // Initial scan — populate known state without syncing
  // (avoids flooding NATS on startup with all existing files)
  const initialFiles = scanDir(SHARED_DIR);
  for (const absPath of initialFiles) {
    try {
      const stat = fs.statSync(absPath);
      const rel = path.relative(SHARED_DIR, absPath);
      knownFiles.set(rel, { mtimeMs: stat.mtimeMs, size: stat.size });
    } catch { /* ignore */ }
  }
  console.log(`[${NODE_ID}] Poller: indexed ${knownFiles.size} existing files`);

  // Poll loop
  setInterval(() => {
    // 1. Scan for new/changed files
    const currentFiles = new Set();
    const allFiles = scanDir(SHARED_DIR);

    for (const absPath of allFiles) {
      const rel = path.relative(SHARED_DIR, absPath);
      currentFiles.add(rel);

      // Skip files we just received from sync
      if (recentSyncs.has(rel)) continue;

      try {
        const stat = fs.statSync(absPath);
        const prev = knownFiles.get(rel);

        // New or changed?
        if (!prev || prev.mtimeMs !== stat.mtimeMs || prev.size !== stat.size) {
          // Skip if too big
          if (stat.size > MAX_SYNC_SIZE) continue;

          // Read and publish
          const content = fs.readFileSync(absPath).toString('base64');
          nc.publish('openclaw.sync.file', sc.encode(JSON.stringify({
            fromNode: NODE_ID,
            relativePath: rel,
            base64: content,
            size: stat.size,
            timestamp: new Date().toISOString(),
          })));

          console.log(`[${NODE_ID}] Synced → ${rel} (${(stat.size / 1024).toFixed(1)}KB)`);
          knownFiles.set(rel, { mtimeMs: stat.mtimeMs, size: stat.size });
        }
      } catch { /* file might have been deleted between scan and read */ }
    }

    // 2. Detect deletions
    for (const [rel] of knownFiles) {
      if (!currentFiles.has(rel) && !recentSyncs.has(rel)) {
        nc.publish('openclaw.sync.delete', sc.encode(JSON.stringify({
          fromNode: NODE_ID,
          relativePath: rel,
          timestamp: new Date().toISOString(),
        })));
        console.log(`[${NODE_ID}] Synced delete → ${rel}`);
        knownFiles.delete(rel);
      }
    }

  }, POLL_INTERVAL);

  console.log(`[${NODE_ID}] Poller: scanning every ${POLL_INTERVAL}ms`);
}

// ─────────────────────────────────────────────
// RECEIVE SYNC — write incoming files to disk
// ─────────────────────────────────────────────
function receiveFile(data) {
  const { fromNode, relativePath, base64 } = data;
  if (fromNode === NODE_ID) return;
  if (!isSafePath(relativePath)) {
    console.error(`[${NODE_ID}] BLOCKED path traversal in sync: ${relativePath}`);
    auditLog('BLOCKED_SYNC', `path traversal attempt: ${relativePath} from ${fromNode}`);
    return;
  }

  const absPath = path.join(SHARED_DIR, relativePath);
  const dir = path.dirname(absPath);

  // Mark so our poller ignores it
  recentSyncs.add(relativePath);
  setTimeout(() => recentSyncs.delete(relativePath), SYNC_COOLDOWN);

  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(absPath, Buffer.from(base64, 'base64'));

    // Update known state so poller doesn't re-send it
    const stat = fs.statSync(absPath);
    knownFiles.set(relativePath, { mtimeMs: stat.mtimeMs, size: stat.size });

    console.log(`[${NODE_ID}] Received ← ${relativePath} from ${fromNode}`);
  } catch (err) {
    console.error(`[${NODE_ID}] Receive failed: ${err.message}`);
  }
}

function receiveDelete(data) {
  const { fromNode, relativePath } = data;
  if (fromNode === NODE_ID) return;
  if (!isSafePath(relativePath)) {
    console.error(`[${NODE_ID}] BLOCKED path traversal in delete: ${relativePath}`);
    auditLog('BLOCKED_DELETE', `path traversal attempt: ${relativePath} from ${fromNode}`);
    return;
  }

  const absPath = path.join(SHARED_DIR, relativePath);

  recentSyncs.add(relativePath);
  setTimeout(() => recentSyncs.delete(relativePath), SYNC_COOLDOWN);

  try {
    if (fs.existsSync(absPath)) {
      fs.unlinkSync(absPath);
      knownFiles.delete(relativePath);
      console.log(`[${NODE_ID}] Deleted ← ${relativePath} (from ${fromNode})`);
    }
  } catch (err) {
    console.error(`[${NODE_ID}] Delete failed: ${err.message}`);
  }
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────
async function main() {
  console.log(`\n[${NODE_ID}] ═══ OpenClaw Agent v3 Starting ═══`);
  console.log(`[${NODE_ID}] Platform:   ${PLATFORM}`);
  console.log(`[${NODE_ID}] NATS:       ${NATS_URL}`);
  console.log(`[${NODE_ID}] Shared:     ${SHARED_DIR}`);
  console.log(`[${NODE_ID}] Captures:   ${CAPTURE_DIR}`);
  console.log(`[${NODE_ID}] Poll rate:  ${POLL_INTERVAL}ms`);

  // Connect to NATS with infinite retry
  let nc;
  while (true) {
    try {
      nc = await connect({ servers: NATS_URL, timeout: 5000 });
      break;
    } catch (err) {
      console.log(`[${NODE_ID}] NATS connect failed, retrying in 5s...`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  console.log(`[${NODE_ID}] Connected to NATS`);

  // ── HEARTBEAT ──────────────────────────────
  setInterval(() => {
    nc.publish(`openclaw.${NODE_ID}.heartbeat`, sc.encode(JSON.stringify({
      node: NODE_ID, platform: PLATFORM, role: NODE_ROLE, status: 'online',
      uptime: os.uptime(),
      mem: {
        total: Math.round(os.totalmem() / 1048576),
        free: Math.round(os.freemem() / 1048576),
      },
      sharedFiles: knownFiles.size,
      timestamp: new Date().toISOString(),
    })));
  }, 10000);

  // ── EXEC SAFETY — server-side blocklist ──────
  const EXEC_BLOCKLIST = [
    /rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\//, // rm -rf /
    /mkfs/, /dd\s+if=/, /:\(\)\{.*\|.*\}/, // destructive
    />\s*\/dev\/sd/, /shutdown/, /reboot/, /init\s+[06]/,
    /chmod\s+(-R\s+)?777\s+\//, /chown\s+(-R\s+)?.*\s+\//,
  ];

  function isExecSafe(cmd) {
    for (const pattern of EXEC_BLOCKLIST) {
      if (pattern.test(cmd)) return false;
    }
    return true;
  }

  // ── EXEC ───────────────────────────────────
  const execSub = nc.subscribe(`openclaw.${NODE_ID}.exec`);
  (async () => {
    for await (const msg of execSub) {
      const cmd = sc.decode(msg.data);
      if (!isExecSafe(cmd)) {
        auditLog('EXEC_BLOCKED', cmd);
        console.log(`[${NODE_ID}] BLOCKED dangerous command: ${cmd}`);
        if (msg.reply) msg.respond(sc.encode(JSON.stringify({
          node: NODE_ID, command: cmd, output: 'Command blocked by server-side safety filter', exitCode: 126,
        })));
        continue;
      }
      auditLog('EXEC', cmd);
      console.log(`[${NODE_ID}] Exec: ${cmd}`);
      try {
        const out = execSync(cmd, { timeout: 120000, encoding: 'utf8', cwd: os.homedir() });
        auditLog('EXEC_OK', `exit=0 cmd=${cmd}`);
        if (msg.reply) msg.respond(sc.encode(JSON.stringify({
          node: NODE_ID, command: cmd, output: out.substring(0, 10000), exitCode: 0,
        })));
      } catch (err) {
        auditLog('EXEC_FAIL', `exit=${err.status || 1} cmd=${cmd}`);
        if (msg.reply) msg.respond(sc.encode(JSON.stringify({
          node: NODE_ID, command: cmd, output: err.stdout || err.stderr || err.message, exitCode: err.status || 1,
        })));
      }
    }
  })();

  // ── CAPTURE ────────────────────────────────
  const capSub = nc.subscribe(`openclaw.${NODE_ID}.capture`);
  (async () => {
    for await (const msg of capSub) {
      const req = JSON.parse(sc.decode(msg.data));
      const imgPath = screenshot(req.label || 'capture', req.region || null);
      if (msg.reply) msg.respond(sc.encode(JSON.stringify({
        node: NODE_ID,
        screenshotPath: imgPath,
        sharedPath: imgPath ? `~/openclaw/shared/captures/${path.basename(imgPath)}` : null,
        timestamp: new Date().toISOString(),
      })));
    }
  })();

  // ── FILE SYNC — receive ────────────────────
  const syncSub = nc.subscribe('openclaw.sync.file');
  (async () => {
    for await (const msg of syncSub) {
      try {
        receiveFile(JSON.parse(sc.decode(msg.data)));
      } catch (err) {
        console.error(`[${NODE_ID}] Sync error: ${err.message}`);
      }
    }
  })();

  // ── DELETE SYNC ────────────────────────────
  const delSub = nc.subscribe('openclaw.sync.delete');
  (async () => {
    for await (const msg of delSub) {
      try {
        receiveDelete(JSON.parse(sc.decode(msg.data)));
      } catch (err) {
        console.error(`[${NODE_ID}] Delete error: ${err.message}`);
      }
    }
  })();

  // ── PEER HEARTBEAT ─────────────────────────
  const hbSub = nc.subscribe('openclaw.*.heartbeat');
  (async () => {
    for await (const msg of hbSub) {
      const s = JSON.parse(sc.decode(msg.data));
      if (s.node !== NODE_ID) {
        peers[s.node] = { ...s, lastSeen: Date.now() };
        // Only log peer updates once per minute to reduce noise
        if (!peers[s.node].lastLogged || Date.now() - peers[s.node].lastLogged > 60000) {
          console.log(`[${NODE_ID}] Peer: ${s.node} (${s.platform}, ${s.mem?.free || '?'}MB free, ${s.sharedFiles ?? '?'} shared files)`);
          peers[s.node].lastLogged = Date.now();
        }
      }
    }
  })();

  // ── BROADCAST ──────────────────────────────
  const bcSub = nc.subscribe('openclaw.broadcast');
  (async () => {
    for await (const msg of bcSub) {
      const d = JSON.parse(sc.decode(msg.data));
      console.log(`[${NODE_ID}] Broadcast: ${d.message || JSON.stringify(d)}`);
    }
  })();

  // ── HEALTH RESPONDER ─────────────────────────
  // Cache health data — gatherHealth() is expensive (~10 execSync calls),
  // so we refresh on a timer and respond instantly from cache.
  let cachedHealth = null;
  const refreshHealth = () => {
    try { cachedHealth = gatherHealth(); }
    catch (err) { console.error(`[${NODE_ID}] Health refresh error: ${err.message}`); }
  };
  refreshHealth(); // initial
  setInterval(refreshHealth, 10000); // refresh every 10s

  const healthSub = nc.subscribe(`mesh.node.${NODE_ID}.health`);
  (async () => {
    for await (const msg of healthSub) {
      if (msg.reply) {
        msg.respond(sc.encode(JSON.stringify(cachedHealth || { error: 'not ready' })));
      }
    }
  })();
  console.log(`  mesh.node.${NODE_ID}.health  — health responder (cached, 10s refresh)`);

  // ── START POLLER ───────────────────────────
  startPolling(nc);

  // ── NATS RECONNECT HANDLING ────────────────
  (async () => {
    for await (const s of nc.status()) {
      console.log(`[${NODE_ID}] NATS status: ${s.type}`);
    }
  })();

  // ── STARTUP ────────────────────────────────
  nc.publish(`openclaw.${NODE_ID}.heartbeat`, sc.encode(JSON.stringify({
    node: NODE_ID, platform: PLATFORM, status: 'online',
    event: 'startup', timestamp: new Date().toISOString(),
  })));

  console.log(`[${NODE_ID}] ═══ Agent v3 Ready ═══`);
  console.log(`[${NODE_ID}] Listening:`);
  console.log(`  openclaw.${NODE_ID}.exec      — run commands`);
  console.log(`  openclaw.${NODE_ID}.capture   — screenshot → shared folder`);
  console.log(`  openclaw.sync.file             — file sync`);
  console.log(`  openclaw.sync.delete           — deletion sync`);
  console.log(`  openclaw.broadcast             — broadcast`);
  console.log(`\n[${NODE_ID}] SHARED FOLDER: ${SHARED_DIR}`);
  console.log(`[${NODE_ID}] Drop files → auto-syncs in ≤${POLL_INTERVAL / 1000}s\n`);

  const shutdown = async (sig) => {
    console.log(`[${NODE_ID}] ${sig} received, shutting down...`);
    auditLog('SHUTDOWN', sig);
    await nc.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(err => {
  console.error('Agent failed:', err.message);
  process.exit(1);
});
