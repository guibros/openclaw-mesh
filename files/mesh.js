#!/usr/bin/env node

/**
 * mesh — CLI bridge for OpenClaw ↔ NATS mesh interaction.
 *
 * ARCHITECTURE:
 *   OpenClaw (via bash tool) → mesh CLI → NATS → agent.js on target node → result back
 *
 * This is a short-lived process: connects to NATS, sends the request,
 * waits for a response, prints the result, exits. No daemon. No state.
 *
 * SUBCOMMANDS:
 *   mesh status                          — show all online nodes
 *   mesh exec "<command>"                — run command on remote (Ubuntu) node
 *   mesh exec --node <id> "<command>"    — run command on specific node
 *   mesh capture                         — screenshot local machine
 *   mesh capture --node ubuntu           — screenshot remote node
 *   mesh ls [subdir]                     — list shared folder contents
 *   mesh put <filepath> [subdir]         — copy file into shared folder
 *   mesh broadcast "<message>"           — send message to all nodes
 *
 * ENVIRONMENT:
 *   OPENCLAW_NATS  — NATS server URL (default: nats://127.0.0.1:4222)
 */

const { connect, StringCodec, createInbox } = require('nats');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Config ──────────────────────────────────────────
const { NATS_URL, natsConnectOpts } = require('./lib/nats-resolve');
const SHARED_DIR = path.join(os.homedir(), 'openclaw', 'shared');
const LOCAL_NODE = os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, '-');
const sc = StringCodec();

// ─── Known nodes (for --node shortcuts) ──────────────
// Loaded dynamically from ~/openclaw/.mesh-aliases.json (if exists), else empty.
const NODE_ALIASES = (() => {
  try {
    const aliasFile = path.join(os.homedir(), 'openclaw', '.mesh-aliases.json');
    if (fs.existsSync(aliasFile)) {
      return JSON.parse(fs.readFileSync(aliasFile, 'utf8'));
    }
  } catch {}
  return {};
})();

/**
 * Resolve a node name — accepts aliases, full IDs, or "self"/"local"
 */
function resolveNode(name) {
  if (!name || name === 'self' || name === 'local') return LOCAL_NODE;
  const lower = name.toLowerCase();
  return NODE_ALIASES[lower] || lower;
}

/**
 * Find the "other" node (not this one) via NATS heartbeat discovery.
 * Subscribes to openclaw.*.heartbeat for up to 3s, returns first non-local node found.
 */
async function remoteNode(nc) {
  const sub = nc.subscribe('openclaw.*.heartbeat');
  const deadline = Date.now() + 3000;

  // Force-unsubscribe after deadline to prevent hanging if no messages arrive
  const timer = setTimeout(() => sub.unsubscribe(), 3000);

  for await (const msg of sub) {
    try {
      const hb = JSON.parse(sc.decode(msg.data));
      if (hb.node && hb.node !== LOCAL_NODE) {
        clearTimeout(timer);
        sub.unsubscribe();
        return hb.node;
      }
    } catch {}
    if (Date.now() >= deadline) break;
  }
  clearTimeout(timer);
  sub.unsubscribe();

  // Fallback: try aliases, then self
  const allNodes = Object.values(NODE_ALIASES);
  return allNodes.find(n => n !== LOCAL_NODE) || LOCAL_NODE;
}

// ─── Exec safety ─────────────────────────────────────

const DESTRUCTIVE_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*)?r[a-zA-Z]*f/,      // rm -rf, rm -fr, rm --recursive --force
  /\brm\s+(-[a-zA-Z]*)?f[a-zA-Z]*r/,       // rm -fr variants
  /\bmkfs\b/,                                // format filesystem
  /\bdd\s+.*of=/,                            // raw disk write
  /\b>\s*\/dev\/[sh]d/,                      // write to raw device
  /\bcurl\b.*\|\s*(ba)?sh/,                  // curl pipe to shell
  /\bwget\b.*\|\s*(ba)?sh/,                  // wget pipe to shell
  /\bchmod\s+(-[a-zA-Z]*\s+)?777\s+\//,     // chmod 777 on root paths
  /\b:(){ :\|:& };:/,                        // fork bomb
];

function checkExecSafety(command) {
  for (const pattern of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(command)) {
      console.error(`BLOCKED: Command matches destructive pattern.`);
      console.error(`  Command: ${command}`);
      console.error(`  Pattern: ${pattern}`);
      console.error(`\nIf this is intentional, SSH into the node and run it directly.`);
      process.exit(1);
    }
  }
}

// ─── NATS helpers ────────────────────────────────────

/**
 * Connect to NATS with a short timeout (this is a CLI tool, not a daemon).
 */
async function natsConnect() {
  try {
    return await connect(natsConnectOpts({ timeout: 5000 }));
  } catch (err) {
    console.error(`Error: Cannot connect to NATS at ${NATS_URL}`);
    console.error(`Is the NATS server running? Is Tailscale connected?`);
    process.exit(1);
  }
}

/**
 * Send a NATS request and wait for a response (with timeout).
 */
async function natsRequest(nc, subject, payload, timeoutMs = 120000) {
  try {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const msg = await nc.request(subject, sc.encode(data), { timeout: timeoutMs });
    return JSON.parse(sc.decode(msg.data));
  } catch (err) {
    if (err.code === '503' || err.message?.includes('503')) {
      console.error(`Error: No responder on subject "${subject}". Is the target node's agent running?`);
    } else if (err.code === 'TIMEOUT' || err.message?.includes('TIMEOUT')) {
      console.error(`Error: Request timed out after ${timeoutMs / 1000}s. The target node may be offline or the command is taking too long.`);
    } else {
      console.error(`Error: ${err.message}`);
    }
    process.exit(1);
  }
}

/**
 * Collect recent heartbeats to build node status.
 */
async function collectHeartbeats(nc, waitMs = 3000) {
  const nodes = {};
  const sub = nc.subscribe('openclaw.*.heartbeat');

  // Also grab our own status
  nodes[LOCAL_NODE] = {
    node: LOCAL_NODE, platform: os.platform(), status: 'online (local)',
    mem: { total: Math.round(os.totalmem() / 1048576), free: Math.round(os.freemem() / 1048576) },
    uptime: os.uptime(),
  };

  // Force-unsubscribe after deadline to prevent hanging if no messages arrive
  const timer = setTimeout(() => sub.unsubscribe(), waitMs);

  // Listen for heartbeats for a few seconds
  const deadline = Date.now() + waitMs;
  for await (const msg of sub) {
    try {
      const s = JSON.parse(sc.decode(msg.data));
      if (s.node !== LOCAL_NODE) {
        nodes[s.node] = s;
      }
    } catch {}
    if (Date.now() >= deadline) break;
  }
  clearTimeout(timer);
  sub.unsubscribe();
  return nodes;
}

// ─── Subcommands ─────────────────────────────────────

/**
 * mesh status — show online nodes with platform, memory, uptime, shared files.
 */
async function cmdStatus() {
  const nc = await natsConnect();
  console.log('Scanning mesh...\n');
  const nodes = await collectHeartbeats(nc, 3000);

  for (const [id, info] of Object.entries(nodes)) {
    const memFree = info.mem?.free || '?';
    const memTotal = info.mem?.total || '?';
    const upHours = info.uptime ? (info.uptime / 3600).toFixed(1) : '?';
    const shared = info.sharedFiles ?? '?';
    const role = info.role || (id === LOCAL_NODE ? 'LOCAL' : 'REMOTE');
    const local = id === LOCAL_NODE ? ' (this machine)' : '';

    console.log(`  ${info.status === 'online' || info.status === 'online (local)' ? '●' : '○'} ${id}${local}`);
    console.log(`    Platform:     ${info.platform}`);
    console.log(`    Role:         ${role}`);
    console.log(`    Memory:       ${memFree}MB free / ${memTotal}MB total`);
    console.log(`    Uptime:       ${upHours}h`);
    console.log(`    Shared files: ${shared}`);
    console.log('');
  }

  await nc.close();
}

/**
 * mesh exec "<command>" — run command on remote node.
 */
async function cmdExec(args) {
  // Parse --node flag
  let explicitNode = null;
  let command = '';

  let i = 0;
  while (i < args.length) {
    if (args[i] === '--node' && args[i + 1]) {
      explicitNode = resolveNode(args[i + 1]);
      i += 2;
    } else {
      command += (command ? ' ' : '') + args[i];
      i++;
    }
  }

  if (!command) {
    console.error('Usage: mesh exec [--node <name>] "<command>"');
    process.exit(1);
  }

  checkExecSafety(command);

  const nc = await natsConnect();
  const targetNode = explicitNode || await remoteNode(nc);
  const result = await natsRequest(nc, `openclaw.${targetNode}.exec`, command);

  // Print output cleanly
  if (result.output) process.stdout.write(result.output);
  if (result.exitCode !== 0) {
    console.error(`\n[exit code: ${result.exitCode}]`);
  }

  await nc.close();
  process.exit(result.exitCode || 0);
}

/**
 * mesh capture — take screenshot on a node.
 */
async function cmdCapture(args) {
  let targetNode = LOCAL_NODE;
  let label = 'capture';

  let i = 0;
  while (i < args.length) {
    if (args[i] === '--node' && args[i + 1]) {
      targetNode = resolveNode(args[i + 1]);
      i += 2;
    } else if (args[i] === '--label' && args[i + 1]) {
      label = args[i + 1];
      i += 2;
    } else {
      i++;
    }
  }

  const nc = await natsConnect();
  const result = await natsRequest(nc, `openclaw.${targetNode}.capture`, { label });

  if (result.sharedPath) {
    console.log(result.sharedPath);
  } else if (result.screenshotPath) {
    console.log(result.screenshotPath);
  } else {
    console.error('Screenshot failed — no path returned.');
    process.exit(1);
  }

  await nc.close();
}

/**
 * mesh ls [subdir] — list shared folder contents.
 */
function cmdLs(args) {
  const subdir = args[0] || '';
  const resolved = path.resolve(SHARED_DIR, subdir);
  if (!resolved.startsWith(SHARED_DIR)) {
    console.error('Error: path traversal blocked');
    process.exit(1);
  }
  const target = resolved;

  if (!fs.existsSync(target)) {
    console.error(`Not found: ${target}`);
    process.exit(1);
  }

  const stat = fs.statSync(target);
  if (!stat.isDirectory()) {
    // Single file — show info
    console.log(`${target} (${(stat.size / 1024).toFixed(1)}KB, ${stat.mtime.toISOString()})`);
    return;
  }

  // List directory recursively with sizes
  listDir(target, '');
}

function listDir(dir, prefix) {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      console.log(`${prefix}${entry.name}/`);
      listDir(full, prefix + '  ');
    } else {
      const size = fs.statSync(full).size;
      const sizeStr = size < 1024 ? `${size}B` : size < 1048576 ? `${(size / 1024).toFixed(1)}KB` : `${(size / 1048576).toFixed(1)}MB`;
      console.log(`${prefix}${entry.name}  (${sizeStr})`);
    }
  }
}

/**
 * mesh put <filepath> [subdir] — copy file into shared folder.
 */
function cmdPut(args) {
  const srcPath = args[0];
  const destSubdir = args[1] || '';

  if (!srcPath) {
    console.error('Usage: mesh put <filepath> [subdir]');
    process.exit(1);
  }

  if (!fs.existsSync(srcPath)) {
    console.error(`Not found: ${srcPath}`);
    process.exit(1);
  }

  const resolvedDest = path.resolve(SHARED_DIR, destSubdir);
  if (!resolvedDest.startsWith(SHARED_DIR)) {
    console.error('Error: path traversal blocked');
    process.exit(1);
  }
  const destDir = resolvedDest;
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

  const filename = path.basename(srcPath);
  const destPath = path.join(destDir, filename);

  fs.copyFileSync(srcPath, destPath);
  const relPath = path.relative(SHARED_DIR, destPath);
  console.log(`~/openclaw/shared/${relPath}`);
  console.log(`(will sync to other nodes automatically)`);
}

/**
 * mesh broadcast "<message>" — send to all nodes.
 */
async function cmdBroadcast(args) {
  const message = args.join(' ');
  if (!message) {
    console.error('Usage: mesh broadcast "<message>"');
    process.exit(1);
  }

  const nc = await natsConnect();
  nc.publish('openclaw.broadcast', sc.encode(JSON.stringify({
    fromNode: LOCAL_NODE,
    message,
    timestamp: new Date().toISOString(),
  })));

  // Give it a moment to flush
  await nc.flush();
  console.log(`Broadcast sent: "${message}"`);
  await nc.close();
}

/**
 * mesh health [--json] [--all] — run health check on this node or all nodes.
 *
 * --all: also runs health on remote node via NATS exec.
 * --json: structured JSON output for programmatic parsing.
 */
async function cmdHealth(args) {
  const jsonMode = args.includes('--json');
  const allNodes = args.includes('--all');
  const scriptDir = path.join(os.homedir(), 'openclaw', 'bin');
  const healthScript = path.join(scriptDir, 'mesh-health.sh');

  if (!fs.existsSync(healthScript)) {
    console.error(`Health script not found at ${healthScript}`);
    console.error('Run install-mesh-skill.sh to install.');
    process.exit(1);
  }

  // Run local health check
  const localArgs = jsonMode ? '--json' : '';
  try {
    const { execSync } = require('child_process');
    const output = execSync(`bash "${healthScript}" ${localArgs}`, {
      encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe']
    });
    process.stdout.write(output);
  } catch (err) {
    // exit code 1 = unhealthy, still valid output
    if (err.stdout) process.stdout.write(err.stdout);
    if (err.stderr) process.stderr.write(err.stderr);
  }

  // If --all, discover remote nodes via heartbeat and check each
  if (allNodes) {
    const nc = await natsConnect();
    const nodes = await collectHeartbeats(nc, 3000);
    const remoteIds = Object.keys(nodes).filter(id => id !== LOCAL_NODE);

    if (remoteIds.length === 0) {
      console.error('No remote nodes discovered via heartbeat.');
    }

    for (const remote of remoteIds) {
      if (!jsonMode) console.log(`\n── Remote node: ${remote} ──\n`);
      try {
        const remoteCmd = `bash ~/openclaw/bin/mesh-health.sh ${localArgs}`;
        const result = await natsRequest(nc, `openclaw.${remote}.exec`, remoteCmd, 20000);
        if (result.output) process.stdout.write(result.output);
      } catch (e) {
        console.error(`Could not reach remote node ${remote} for health check.`);
      }
    }
    await nc.close();
  }
}

/**
 * mesh repair [--all] — self-repair this node (or all nodes).
 *
 * Runs health check first, then fixes every failed service.
 * Requires sudo for service restarts.
 * --all: also repairs the remote node via NATS exec.
 */
async function cmdRepair(args) {
  const allNodes = args.includes('--all');
  const scriptDir = path.join(os.homedir(), 'openclaw', 'bin');
  const repairScript = path.join(scriptDir, 'mesh-repair.sh');

  if (!fs.existsSync(repairScript)) {
    console.error(`Repair script not found at ${repairScript}`);
    console.error('Run install-mesh-skill.sh to install.');
    process.exit(1);
  }

  // Run local repair (needs sudo for service restarts)
  try {
    const { execSync } = require('child_process');
    execSync(`sudo bash "${repairScript}"`, {
      encoding: 'utf8', timeout: 120000, stdio: 'inherit'
    });
  } catch (err) {
    // repair may exit non-zero if some repairs failed
  }

  // If --all, discover remote nodes via heartbeat and repair each
  if (allNodes) {
    const nc = await natsConnect();
    const nodes = await collectHeartbeats(nc, 3000);
    const remoteIds = Object.keys(nodes).filter(id => id !== LOCAL_NODE);

    if (remoteIds.length === 0) {
      console.error('No remote nodes discovered via heartbeat.');
    }

    for (const remote of remoteIds) {
      console.log(`\n══ Remote repair: ${remote} ══\n`);
      try {
        const result = await natsRequest(nc,
          `openclaw.${remote}.exec`,
          `bash ~/openclaw/bin/mesh-repair.sh`,
          120000
        );
        if (result.output) process.stdout.write(result.output);
      } catch (e) {
        console.error(`Could not reach remote node ${remote} for repair.`);
        console.error('SSH in and run: sudo bash openclaw/bin/mesh-repair.sh');
      }
    }
    await nc.close();
  }
}

/**
 * mesh help — show usage.
 */
function cmdHelp() {
  console.log([
    '',
    'mesh -- OpenClaw multi-node mesh CLI',
    '',
    'USAGE:',
    '  mesh status                             Show online nodes',
    '  mesh exec "<command>"                   Run command on remote node',
    '  mesh exec --node <n> "<command>"        Run command on specific node',
    '  mesh capture                            Screenshot this machine',
    '  mesh capture --node ubuntu              Screenshot remote node',
    '  mesh ls [subdir]                        List shared folder',
    '  mesh put <file> [subdir]                Copy file to shared folder',
    '  mesh broadcast "<message>"              Send message to all nodes',
    '  mesh health                             Health check this node',
    '  mesh health --all                       Health check ALL nodes',
    '  mesh health --json                      Health check (JSON output)',
    '  mesh repair                             Self-repair this node',
    '  mesh repair --all                       Self-repair ALL nodes',
    '',
    'NODE ALIASES:',
    '  Node aliases loaded from ~/openclaw/.mesh-aliases.json',
    '',
    'SHARED FOLDER:',
    '  ~/openclaw/shared/  -- auto-synced between all nodes via NATS',
    '',
    'ENVIRONMENT:',
    '  OPENCLAW_NATS  -- NATS server URL (default: nats://127.0.0.1:4222)',
    '',
  ].join('\n'));
}

// --- Main dispatch ---------------------------------------------------

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  switch (cmd) {
    case 'status':    return cmdStatus();
    case 'exec':      return cmdExec(args);
    case 'capture':   return cmdCapture(args);
    case 'ls':        return cmdLs(args);
    case 'put':       return cmdPut(args);
    case 'broadcast': return cmdBroadcast(args);
    case 'health':    return cmdHealth(args);
    case 'repair':    return cmdRepair(args);
    case 'help':
    case '--help':
    case '-h':        return cmdHelp();
    default:
      if (!cmd) return cmdHelp();
      console.error(`Unknown command: ${cmd}`);
      console.error(`Run "mesh help" for usage.`);
      process.exit(1);
  }
}

main().catch(err => {
  console.error(`mesh error: ${err.message}`);
  process.exit(1);
});
