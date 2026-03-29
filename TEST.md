# Test Suite — openclaw-mesh

## Quick Start

```bash
npm test
# or
node --test test/*.test.js
```

## Test Runner

Node.js built-in test runner (`node:test`) + `assert/strict`. Zero dependencies — no test framework to install. Requires Node 22+ (same as the project).

## Tests

| File | Module | Tests | What it covers |
|------|--------|-------|----------------|
| `test/nats-resolve.test.js` | `files/lib/nats-resolve.js` | 10 | 4-step URL resolution (env var > openclaw.env > .mesh-config > localhost), token resolution, quote stripping, natsConnectOpts merging, priority ordering |
| `test/exec-safety.test.js` | `files/mesh.js` + `files/agent.js` | 12 | Destructive command blocking (rm -rf, mkfs, dd, curl\|bash, wget\|bash, chmod 777), safe command allowlisting, agent allowlist/blocklist validation |

## How exec-safety Tests Work

`mesh.js` and `agent.js` are script-only files (no `module.exports`). The exec-safety tests extract the regex patterns directly from the source files using string matching, then test the patterns in isolation:

```javascript
// Read the source, extract the DESTRUCTIVE_PATTERNS array
const meshSource = fs.readFileSync('files/mesh.js', 'utf-8');
const patternBlock = meshSource.match(/const DESTRUCTIVE_PATTERNS = \[([\s\S]*?)\];/);
const DESTRUCTIVE_PATTERNS = eval(`[${patternBlock[1]}]`);
```

This means tests break if the pattern variable is renamed or restructured — which is a feature, not a bug. Any change to safety-critical regex should force a test review.

## Writing New Tests

```javascript
#!/usr/bin/env node
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('my feature', () => {
  it('works', () => {
    assert.equal(1 + 1, 2);
  });
});
```

Save as `test/my-feature.test.js`, then `npm test` picks it up automatically via the `test/*.test.js` glob.

## CI

GitHub Actions runs on every push/PR to `main`. See `.github/workflows/test.yml`.

## Coverage Gaps (known)

| Module | LOC | Reason |
|--------|-----|--------|
| `files/mesh.js` (commands) | 566 | Command handlers (`cmdExec`, `cmdLs`, `cmdPut`, etc.) need NATS mocking — script has no exports |
| `files/agent.js` (daemon) | 633 | Long-running daemon with polling loops, NATS subscriptions — needs integration test harness |
| `bin/cli.js` | 64 | Spawns setup.sh with sudo — hard to unit test |
| `setup.sh` | 509 | System-level bash (systemd, launchctl) — requires integration environment |
| `files/mesh-health.sh` | 303 | System service checks — requires running services |
| `files/mesh-repair.sh` | 490 | Service restart logic — requires running services |

To expand coverage on `mesh.js` and `agent.js`, add `module.exports` at the end of each file to expose testable functions without changing behavior.
