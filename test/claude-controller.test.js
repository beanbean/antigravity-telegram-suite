/**
 * Claude Code engine — vault lock + ask/RO + prompt gate.
 * Uses fake CLIs for process-path coverage; never calls real Claude.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fakeClaudeBin = path.join(os.tmpdir(), `telebot-fake-claude-${process.pid}`);
const fakeClaudeArgs = path.join(os.tmpdir(), `telebot-fake-claude-args-${process.pid}.json`);
const fakeNow = new Date();
const pad = (n) => String(n).padStart(2, '0');
const nowString = `${fakeNow.getFullYear()}-${pad(fakeNow.getMonth() + 1)}-${pad(fakeNow.getDate())} ${pad(fakeNow.getHours())}:${pad(fakeNow.getMinutes())}:${pad(fakeNow.getSeconds())}`;
fs.writeFileSync(
  fakeClaudeBin,
  `#!/bin/sh
printf '%s' "$@" > "${fakeClaudeArgs}"
if [ "$FAKE_CLAUDE_MODE" = "slow" ]; then
  trap 'sleep 0.15; exit 143' TERM
  printf '%s\\n' '{"type":"system","subtype":"init","session_id":"fake-slow"}'
  while true; do sleep 1; done
fi
if [ "$FAKE_CLAUDE_MODE" = "medium" ]; then
  printf '%s\\n' '{"type":"system","subtype":"init","session_id":"fake-medium"}'
  sleep 0.4
  printf '%s\\n' '{"type":"result","subtype":"success","result":"medium ok","session_id":"fake-medium","duration_ms":400}'
  exit 0
fi
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"fake-ask"}'
printf '%s\\n' '{"type":"result","subtype":"success","result":"ask ok","session_id":"fake-ask","duration_ms":1}'
`,
  'utf8'
);
fs.chmodSync(fakeClaudeBin, 0o755);
process.env.CLAUDE_BIN = fakeClaudeBin;
process.env.CLAUDE_TIMEOUT = '1000';

const claude = require('../src/claude-controller');
const {
  checkVaultLock,
  acquireVaultLock,
  releaseVaultLock,
  buildPrompt,
  resolveDefaultWorkspace,
  LOCK_AI,
  LOCK_TTL_MS,
  cancelSession,
  isSessionActive,
  getSessionInfo,
} = claude;
const { withVaultWriteGate } = require('../src/vault-write-policy');

function mkVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-lock-'));
  fs.writeFileSync(path.join(root, '_handoff.md'), '# handoff\n', 'utf8');
  return root;
}

function cleanup(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
}

async function main() {
  // --- resolveDefaultWorkspace ---
  {
    const prev = process.env.CLAUDE_WORK_DIR;
    delete process.env.CLAUDE_WORK_DIR;
    const d = resolveDefaultWorkspace();
    assert.ok(d.endsWith(path.join('Projects', 'nexmeOS')), `default should be Projects/nexmeOS, got ${d}`);

    process.env.CLAUDE_WORK_DIR = os.homedir();
    const projects = path.join(os.homedir(), 'Projects', 'nexmeOS');
    if (fs.existsSync(projects)) {
      const remapped = resolveDefaultWorkspace();
      assert.strictEqual(path.resolve(remapped), path.resolve(projects), 'HOME env should remap to Projects/nexmeOS when present');
    }

    process.env.CLAUDE_WORK_DIR = path.join(os.tmpdir(), 'custom-claude-ws');
    assert.strictEqual(resolveDefaultWorkspace(), process.env.CLAUDE_WORK_DIR, 'custom env kept');
    if (prev === undefined) delete process.env.CLAUDE_WORK_DIR;
    else process.env.CLAUDE_WORK_DIR = prev;
    console.log('✓ resolveDefaultWorkspace');
  }

  // --- lock free / acquire / release ---
  {
    const vault = mkVault();
    try {
      const free = checkVaultLock(vault);
      assert.strictEqual(free.ok, true, 'empty vault lock ok');

      const acq = acquireVaultLock(vault, 'unit-test-claude');
      assert.strictEqual(acq.ok, true, 'acquire ok');
      assert.ok(acq.ownerId, 'ownerId set');
      assert.ok(fs.existsSync(path.join(vault, '.nexmeos-lock')), 'lock file exists');

      const raw = fs.readFileSync(path.join(vault, '.nexmeos-lock'), 'utf8');
      assert.ok(raw.includes(`ai: ${LOCK_AI}`), `lock ai is ${LOCK_AI}`);
      assert.ok(raw.includes('unit-test-claude'), 'session label stored');

      const blocked = acquireVaultLock(vault, 'other');
      assert.strictEqual(blocked.ok, false, 'second acquire blocked');
      assert.ok(blocked.lockedBy, 'lockedBy present');

      const sameOwner = checkVaultLock(vault, { ownerId: acq.ownerId });
      assert.strictEqual(sameOwner.ok, true, 'same owner check ok');
      assert.strictEqual(checkVaultLock(vault, { ownerId: 'not-me' }).ok, false, 'other owner blocked');
      assert.strictEqual(releaseVaultLock(vault, 'wrong-owner'), false, 'wrong owner cannot release');
      assert.strictEqual(releaseVaultLock(vault, acq.ownerId), true, 'owner releases');
      assert.ok(!fs.existsSync(path.join(vault, '.nexmeos-lock')), 'lock file gone');
      assert.strictEqual(checkVaultLock(vault).ok, true, 'free after release');
    } finally {
      cleanup(vault);
    }
    console.log('✓ vault lock acquire/release');
  }

  // --- stale lock (> TTL) can be taken ---
  {
    const vault = mkVault();
    try {
      const lp = path.join(vault, '.nexmeos-lock');
      const old = new Date(Date.now() - LOCK_TTL_MS - 60_000);
      const started = `${old.getFullYear()}-${pad(old.getMonth() + 1)}-${pad(old.getDate())} ${pad(old.getHours())}:${pad(old.getMinutes())}:${pad(old.getSeconds())}`;
      fs.writeFileSync(lp, `ai: cursor\nsession: "stale"\nstarted: "${started}"\nowner_id: "old"\n`, 'utf8');

      const chk = checkVaultLock(vault);
      assert.strictEqual(chk.ok, true, 'stale lock reported ok');
      assert.strictEqual(chk.stale, true, 'stale flag');

      const acq = acquireVaultLock(vault, 'after-stale');
      assert.strictEqual(acq.ok, true, 'can acquire over stale');
      assert.ok(fs.readFileSync(lp, 'utf8').includes(`ai: ${LOCK_AI}`), 'replaced with claude-code');
      releaseVaultLock(vault, acq.ownerId);
    } finally {
      cleanup(vault);
    }
    console.log('✓ stale lock reclaim');
  }

  // --- buildPrompt ask vs agent ---
  {
    const agent = buildPrompt('làm việc A', { vaultRoot: '/tmp/vault', readOnly: false });
    assert.ok(agent.includes('[TELEBOT VAULT GATE'), 'gate prepended');
    assert.ok(agent.includes('làm việc A'), 'user prompt kept');
    assert.ok(agent.includes('Khôi'), 'Khôi identity');
    assert.ok(!agent.includes('READ-ONLY'), 'agent not RO');
    assert.ok(agent.includes('claude-code') || agent.includes('Single Driver'), 'lock / driver note');

    const ask = buildPrompt('phân tích X', { vaultRoot: '/tmp/vault', readOnly: true });
    assert.ok(ask.includes('READ-ONLY') || ask.includes('read-only') || ask.includes('Ask'), 'ask RO note');
    assert.ok(ask.includes('KHÔNG ghi') || ask.includes('không ghi'), 'ask forbids write');
    assert.ok(ask.includes('phân tích X'), 'ask user text');
    const gated = withVaultWriteGate('phân tích X');
    assert.strictEqual(withVaultWriteGate(gated), gated, 'vault gate helper is idempotent');
    console.log('✓ buildPrompt agent/ask');
  }

  // --- sendToClaude ask skips lock and enforces CLI plan mode ---
  {
    const vault = mkVault();
    const lockPath = path.join(vault, '.nexmeos-lock');
    try {
      fs.writeFileSync(lockPath, `ai: antigravity\nsession: "an"\nstarted: "${nowString}"\nowner_id: "an-1"\n`, 'utf8');

      await assert.rejects(
        claude.sendToClaude('should fail lock', { chatId: 'test-chat', workDir: vault, mode: undefined, skipLock: false }),
        (err) => err.code === 'VAULT_LOCKED' && (String(err.message).includes('antigravity') || String(err.message).includes('khoá'))
      );

      const result = await claude.sendToClaude('ask despite foreign lock', { chatId: 'ask-chat', workDir: vault, mode: 'ask', skipLock: false });
      assert.strictEqual(result.text, 'ask ok', 'ask fake CLI response');
      assert.strictEqual(result.sessionId, 'fake-ask', 'ask session captured');
      assert.strictEqual(fs.existsSync(lockPath), true, 'ask leaves foreign lock untouched');
      const argv = fs.readFileSync(fakeClaudeArgs, 'utf8');
      assert.ok(argv.includes('--permission-modeplan'), 'ask passes CLI plan permission mode');
      console.log('✓ sendToClaude ask skips lock + plan mode + agent VAULT_LOCKED');
    } finally {
      cleanup(vault);
    }
  }

  // --- spawn failure releases an acquired lock ---
  {
    const vault = mkVault();
    const previous = process.env.CLAUDE_BIN;
    process.env.CLAUDE_BIN = '/definitely/missing/claude';
    try {
      // CLAUDE_BIN is read at module load. A missing cwd still exercises the
      // child-process spawn error path without calling the real Claude binary.
      await assert.rejects(
        claude.sendToClaude('missing workspace', {
          chatId: 'spawn-chat',
          workDir: path.join(vault, 'missing-workspace'),
          skipLock: true,
        }),
        /Spawn failed|Claude exited/
      );
    } finally {
      process.env.CLAUDE_BIN = previous;
      cleanup(vault);
    }
    console.log('✓ spawn failure path');
  }

  // --- cancel/close race keeps the replacement request and lock intact ---
  {
    const vault = mkVault();
    const chatId = 'race-chat';
    let requestA;
    try {
      process.env.FAKE_CLAUDE_MODE = 'slow';
      requestA = claude.sendToClaude('request A', { chatId, workDir: vault });
      for (let i = 0; i < 50 && !isSessionActive(chatId); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.strictEqual(isSessionActive(chatId), true, 'request A should be active');
      assert.strictEqual(cancelSession(chatId), true, 'request A should cancel');
      await assert.rejects(requestA, /cancelled/);

      process.env.FAKE_CLAUDE_MODE = 'medium';
      const requestB = claude.sendToClaude('request B', { chatId, workDir: vault });
      await new Promise((resolve) => setTimeout(resolve, 220));
      const duringB = getSessionInfo(chatId);
      assert.strictEqual(duringB.isActive, true, 'request B should remain active after request A closes');
      assert.strictEqual(duringB.sessionId, 'fake-medium', 'request A close must not overwrite request B session');
      const resultB = await requestB;
      assert.strictEqual(resultB.text, 'medium ok', 'request B should complete');
      assert.strictEqual(checkVaultLock(vault).ok, true, 'request B cleanup should release its lock');
    } finally {
      delete process.env.FAKE_CLAUDE_MODE;
      if (isSessionActive(chatId)) cancelSession(chatId);
      cleanup(vault);
    }
    console.log('✓ cancel/close race keeps replacement request state');
  }

  // --- timeout releases the lock immediately ---
  {
    const vault = mkVault();
    const chatId = 'timeout-chat';
    try {
      process.env.FAKE_CLAUDE_MODE = 'slow';
      const timeoutMs = 1000;
      await assert.rejects(
        claude.sendToClaude('timeout request', { chatId, workDir: vault, timeoutMs }),
        /Timeout 1s/
      );
      assert.strictEqual(checkVaultLock(vault).ok, true, 'timeout must release the vault lock');
      assert.strictEqual(isSessionActive(chatId), false, 'timeout must clear active session');
    } finally {
      delete process.env.FAKE_CLAUDE_MODE;
      if (isSessionActive(chatId)) cancelSession(chatId);
      cleanup(vault);
    }
    console.log('✓ timeout releases lock and clears session');
  }

  console.log('✅ claude-controller tests passed');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    try { fs.rmSync(fakeClaudeBin, { force: true }); } catch (_) {}
    try { fs.rmSync(fakeClaudeArgs, { force: true }); } catch (_) {}
  });
