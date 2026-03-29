#!/usr/bin/env node

/**
 * nats-resolve.test.js — Unit tests for files/lib/nats-resolve.js
 *
 * Tests the 4-step NATS URL/token resolution chain.
 *
 * Run: node --test test/nats-resolve.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

function freshRequire() {
  const modPath = require.resolve('../files/lib/nats-resolve');
  delete require.cache[modPath];
  return require('../files/lib/nats-resolve');
}

describe('nats-resolve', () => {
  const origEnv = {};
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-nats-test-'));
    origEnv.OPENCLAW_NATS = process.env.OPENCLAW_NATS;
    origEnv.OPENCLAW_NATS_TOKEN = process.env.OPENCLAW_NATS_TOKEN;
    origEnv.HOME = process.env.HOME;
    delete process.env.OPENCLAW_NATS;
    delete process.env.OPENCLAW_NATS_TOKEN;
  });

  afterEach(() => {
    if (origEnv.OPENCLAW_NATS !== undefined) process.env.OPENCLAW_NATS = origEnv.OPENCLAW_NATS;
    else delete process.env.OPENCLAW_NATS;
    if (origEnv.OPENCLAW_NATS_TOKEN !== undefined) process.env.OPENCLAW_NATS_TOKEN = origEnv.OPENCLAW_NATS_TOKEN;
    else delete process.env.OPENCLAW_NATS_TOKEN;
    if (origEnv.HOME !== undefined) process.env.HOME = origEnv.HOME;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves URL from OPENCLAW_NATS env var', () => {
    process.env.OPENCLAW_NATS = 'nats://env-override:4222';
    const mod = freshRequire();
    assert.equal(mod.NATS_URL, 'nats://env-override:4222');
  });

  it('resolves URL from ~/.openclaw/openclaw.env', () => {
    process.env.HOME = tmpDir;
    const dir = path.join(tmpDir, '.openclaw');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'openclaw.env'), 'OPENCLAW_NATS=nats://envfile:4222\n');
    const mod = freshRequire();
    assert.equal(mod.NATS_URL, 'nats://envfile:4222');
  });

  it('resolves URL from ~/openclaw/.mesh-config', () => {
    process.env.HOME = tmpDir;
    const dir = path.join(tmpDir, 'openclaw');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.mesh-config'), 'OPENCLAW_NATS=nats://meshcfg:4222\n');
    const mod = freshRequire();
    assert.equal(mod.NATS_URL, 'nats://meshcfg:4222');
  });

  it('falls back to localhost', () => {
    process.env.HOME = tmpDir;
    const mod = freshRequire();
    assert.equal(mod.NATS_URL, 'nats://127.0.0.1:4222');
  });

  it('strips quotes from env file values', () => {
    process.env.HOME = tmpDir;
    const dir = path.join(tmpDir, '.openclaw');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'openclaw.env'), 'OPENCLAW_NATS="nats://quoted:4222"\n');
    const mod = freshRequire();
    assert.equal(mod.NATS_URL, 'nats://quoted:4222');
  });

  it('resolves token from env var', () => {
    process.env.OPENCLAW_NATS = 'nats://x:4222';
    process.env.OPENCLAW_NATS_TOKEN = 'secret';
    const mod = freshRequire();
    assert.equal(mod.NATS_TOKEN, 'secret');
  });

  it('token is null when not configured', () => {
    process.env.HOME = tmpDir;
    const mod = freshRequire();
    assert.equal(mod.NATS_TOKEN, null);
  });

  it('natsConnectOpts includes servers and token', () => {
    process.env.OPENCLAW_NATS = 'nats://test:4222';
    process.env.OPENCLAW_NATS_TOKEN = 'tok';
    const mod = freshRequire();
    const opts = mod.natsConnectOpts({ timeout: 3000 });
    assert.equal(opts.servers, 'nats://test:4222');
    assert.equal(opts.token, 'tok');
    assert.equal(opts.timeout, 3000);
  });

  it('natsConnectOpts omits token when null', () => {
    process.env.OPENCLAW_NATS = 'nats://test:4222';
    process.env.HOME = tmpDir;
    const mod = freshRequire();
    const opts = mod.natsConnectOpts();
    assert.equal(opts.token, undefined);
  });

  it('env var takes priority over file', () => {
    process.env.OPENCLAW_NATS = 'nats://env-wins:4222';
    process.env.HOME = tmpDir;
    const dir = path.join(tmpDir, '.openclaw');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'openclaw.env'), 'OPENCLAW_NATS=nats://file-loses:4222\n');
    const mod = freshRequire();
    assert.equal(mod.NATS_URL, 'nats://env-wins:4222');
  });
});
