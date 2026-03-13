#!/usr/bin/env node

/**
 * openclaw-mesh CLI — entry point for `npx openclaw-mesh`
 *
 * Flow:
 *   1. Resolve the files/ directory and setup.sh relative to this package
 *   2. Check if running as root (required for service install)
 *   3. If not root, re-exec with sudo
 *   4. Spawn setup.sh with FILES_DIR in the environment
 *   5. Forward exit code
 */

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// ── Package paths ──
// cli.js lives in bin/, package root is one level up
const PKG_ROOT = path.join(__dirname, '..');
const SETUP_SCRIPT = path.join(PKG_ROOT, 'setup.sh');
const FILES_DIR = path.join(PKG_ROOT, 'files');

// ── Sanity checks ──
if (!fs.existsSync(SETUP_SCRIPT)) {
  console.error('ERROR: setup.sh not found at', SETUP_SCRIPT);
  console.error('Package may be corrupted. Reinstall with: npm install -g openclaw-mesh');
  process.exit(1);
}

if (!fs.existsSync(FILES_DIR)) {
  console.error('ERROR: files/ directory not found at', FILES_DIR);
  console.error('Expected at:', FILES_DIR);
  process.exit(1);
}

// ── Forward CLI args to setup.sh ──
const userArgs = process.argv.slice(2);

// ── Root check ──
// Services (systemd, LaunchDaemons, sudoers) require root to install.
// If not root, re-exec with sudo, passing FILES_DIR through.
if (process.getuid() !== 0) {
  console.log('Mesh setup requires root for service installation.');
  console.log('Re-running with sudo...\n');

  const result = spawnSync('sudo', [
    'bash', SETUP_SCRIPT, ...userArgs
  ], {
    stdio: 'inherit',
    env: { ...process.env, FILES_DIR },
  });

  process.exit(result.status || 0);
}

// ── Already root: run setup directly ──
const result = spawnSync('bash', [SETUP_SCRIPT, ...userArgs], {
  stdio: 'inherit',
  env: { ...process.env, FILES_DIR },
});

process.exit(result.status || 0);
