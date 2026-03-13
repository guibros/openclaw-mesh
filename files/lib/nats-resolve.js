/**
 * nats-resolve.js — Shared NATS URL resolver for the OpenClaw mesh.
 *
 * Every CJS script in ~/openclaw/bin/ that connects to NATS should
 * require() this module instead of hardcoding URLs.
 *
 * Resolution order:
 *   1. $OPENCLAW_NATS env var (set by launchd/systemd service definitions)
 *   2. ~/.openclaw/openclaw.env file (user-editable, persists across sessions)
 *   3. ~/openclaw/.mesh-config (written by setup.sh)
 *   4. Fallback: nats://127.0.0.1:4222
 *
 * Usage:
 *   const { NATS_URL } = require('./lib/nats-resolve');
 *   const nc = await connect({ servers: NATS_URL, timeout: 5000 });
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Fallback — last resort if all config sources are missing.
const NATS_FALLBACK = 'nats://127.0.0.1:4222';

/**
 * Resolve the NATS server URL using a 4-step chain.
 * Called once at module load time — the result is cached as NATS_URL.
 */
function resolveNatsUrl() {
  // 1. Environment variable (highest priority — set by service definitions)
  if (process.env.OPENCLAW_NATS) return process.env.OPENCLAW_NATS;

  // 2. Read from ~/.openclaw/openclaw.env (user-editable config file)
  try {
    const envFile = path.join(os.homedir(), '.openclaw', 'openclaw.env');
    if (fs.existsSync(envFile)) {
      const content = fs.readFileSync(envFile, 'utf8');
      const match = content.match(/^\s*OPENCLAW_NATS\s*=\s*(.+)/m);
      if (match) { const v = match[1].trim().replace(/^["']|["']$/g, ''); if (v) return v; }
    }
  } catch {
    // File unreadable — fall through silently
  }

  // 3. Read from ~/openclaw/.mesh-config (written by setup.sh)
  try {
    const meshConfig = path.join(os.homedir(), 'openclaw', '.mesh-config');
    if (fs.existsSync(meshConfig)) {
      const content = fs.readFileSync(meshConfig, 'utf8');
      const match = content.match(/^\s*OPENCLAW_NATS\s*=\s*(.+)/m);
      if (match) { const v = match[1].trim().replace(/^["']|["']$/g, ''); if (v) return v; }
    }
  } catch {
    // File unreadable — fall through silently
  }

  // 4. Localhost fallback
  return NATS_FALLBACK;
}

/**
 * Resolve the NATS auth token using the same chain.
 * Returns null if no token is configured (backward compatible).
 */
function resolveNatsToken() {
  if (process.env.OPENCLAW_NATS_TOKEN) return process.env.OPENCLAW_NATS_TOKEN;

  try {
    const envFile = path.join(os.homedir(), '.openclaw', 'openclaw.env');
    if (fs.existsSync(envFile)) {
      const content = fs.readFileSync(envFile, 'utf8');
      const match = content.match(/^\s*OPENCLAW_NATS_TOKEN\s*=\s*(.+)/m);
      if (match) { const v = match[1].trim().replace(/^["']|["']$/g, ''); if (v) return v; }
    }
  } catch {}

  try {
    const meshConfig = path.join(os.homedir(), 'openclaw', '.mesh-config');
    if (fs.existsSync(meshConfig)) {
      const content = fs.readFileSync(meshConfig, 'utf8');
      const match = content.match(/^\s*OPENCLAW_NATS_TOKEN\s*=\s*(.+)/m);
      if (match) { const v = match[1].trim().replace(/^["']|["']$/g, ''); if (v) return v; }
    }
  } catch {}

  return null;
}

// Resolve once at require() time — all consumers get the same value
const NATS_URL = resolveNatsUrl();
const NATS_TOKEN = resolveNatsToken();

function natsConnectOpts(extra = {}) {
  const opts = { servers: NATS_URL, ...extra };
  if (NATS_TOKEN) opts.token = NATS_TOKEN;
  return opts;
}

module.exports = { NATS_URL, NATS_TOKEN, resolveNatsUrl, resolveNatsToken, natsConnectOpts };
