const assert = require('assert');
const { withVaultWriteGate, buildCronVaultPolicy, TELEBOT_VAULT_GATE } = require('../src/vault-write-policy');
const { buildCronContext } = require('../src/brain2-cron');

assert(TELEBOT_VAULT_GATE.includes('DEFAULT = KHÔNG ghi vault'));
assert(TELEBOT_VAULT_GATE.includes('[CẦN NGUỒN]'));
assert(!TELEBOT_VAULT_GATE.includes('lưu vào Brain2 nếu phù hợp'));

const gated = withVaultWriteGate('hello anh');
assert(gated.includes('[TELEBOT VAULT GATE'));
assert(gated.includes('hello anh'));
assert.strictEqual(withVaultWriteGate(gated), gated, 'idempotent gate');

const cron = buildCronContext(
  { jobId: '09h-ndd-reflect', question: 'NDD?' },
  '12 người, insight X'
);
assert(cron.includes('CẤM') || cron.includes('KHÔNG lưu'));
assert(!cron.includes('lưu vào Brain2 nếu phù hợp'));
assert(cron.includes('12 người, insight X'));
assert(buildCronVaultPolicy('09h-ndd-reflect').includes('09h-ndd-reflect'));

console.log('vault-write-policy + buildCronContext OK');
