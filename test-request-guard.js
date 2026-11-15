// Offline test for request-guard.js. Run with `npm test`.
const assert = require('assert');
const { createRequestGuard, cleanCommand } = require('./request-guard');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const local = createRequestGuard({ bindHost: '127.0.0.1', httpPort: 8080 });
const lan = createRequestGuard({ bindHost: '0.0.0.0', httpPort: 8080 });

test('bound to loopback: only loopback names in Host', () => {
  for (const host of ['localhost:8080', '127.0.0.1:8080', '[::1]:8081', 'LOCALHOST:8081', 'obs.localhost:8080']) {
    assert.ok(local.isAllowedHost(host), host);
  }
  for (const host of ['evil.example:8080', '192.168.1.20:8080', '', undefined]) {
    assert.ok(!local.isAllowedHost(host), String(host));
  }
});

test('bound to the LAN: any Host', () => {
  assert.ok(lan.isAllowedHost('192.168.1.20:8080'));
  assert.ok(!lan.isAllowedHost(''));
});

test('WebSocket from our own pages is allowed', () => {
  assert.ok(local.isAllowedOrigin('http://localhost:8080', 'localhost:8081'));
  // shared.js dials ws://localhost even from a page opened as 127.0.0.1
  assert.ok(local.isAllowedOrigin('http://127.0.0.1:8080', 'localhost:8081'));
});

test('WebSocket from any other page is refused', () => {
  for (const origin of ['https://evil.example', 'http://localhost:3000', 'http://localhost', 'null', 'file://', 'chrome-extension://abc']) {
    assert.ok(!local.isAllowedOrigin(origin, 'localhost:8081'), origin);
  }
});

test('WebSocket with no Origin (not a browser) is allowed', () => {
  assert.ok(local.isAllowedOrigin(undefined, 'localhost:8081'));
});

test('LAN mode: a page from the same LAN host, but not a different one', () => {
  assert.ok(lan.isAllowedOrigin('http://192.168.1.20:8080', '192.168.1.20:8081'));
  assert.ok(!lan.isAllowedOrigin('http://192.168.1.99:8080', '192.168.1.20:8081'));
  assert.ok(!lan.isAllowedOrigin('https://evil.example:8080', '192.168.1.20:8081'));
});

test('malformed and unknown commands are dropped', () => {
  for (const message of [null, 42, 'pin', [], {}, { type: 'nope' }, { type: 'constructor' }, { type: '__proto__' }, { type: 'toString' }]) {
    assert.strictEqual(cleanCommand(message), null, JSON.stringify(message));
  }
});

test('timer-start needs a sane duration', () => {
  assert.deepStrictEqual(cleanCommand({ type: 'timer-start', durationMs: 300000 }), { type: 'timer-start', durationMs: 300000 });
  for (const durationMs of ['abc', null, NaN, Infinity, -5, 0, 500, 25 * 60 * 60 * 1000]) {
    assert.strictEqual(cleanCommand({ type: 'timer-start', durationMs }), null, String(durationMs));
  }
});

test('pin keeps only its own fields, trimmed and typed', () => {
  const clean = cleanCommand({
    type: 'pin',
    nickname: 'n'.repeat(500),
    comment: 'hello',
    avatarUrl: 'javascript:alert(1)',
    autoUnpinMs: 1e12,
    extra: '<script>',
  });
  assert.deepStrictEqual(Object.keys(clean).sort(), ['autoUnpinMs', 'avatarUrl', 'comment', 'nickname', 'type']);
  assert.strictEqual(clean.nickname.length, 100);
  assert.strictEqual(clean.avatarUrl, '');
  assert.strictEqual(clean.autoUnpinMs, 60 * 60 * 1000);
  assert.strictEqual(cleanCommand({ type: 'pin', avatarUrl: 'https://p16.tiktokcdn.com/a.jpg' }).avatarUrl, 'https://p16.tiktokcdn.com/a.jpg');
});

test('ids, links and settings are type-checked', () => {
  assert.strictEqual(cleanCommand({ type: 'song-approve', id: { $ne: 1 } }), null);
  assert.deepStrictEqual(cleanCommand({ type: 'song-approve', id: 's1-2' }), { type: 'song-approve', id: 's1-2' });
  assert.strictEqual(cleanCommand({ type: 'filler-add', link: 'x'.repeat(501) }), null);
  assert.strictEqual(cleanCommand({ type: 'set-tts-provider', provider: 'evil' }), null);
  assert.strictEqual(cleanCommand({ type: 'set-tts-speed', speed: 9 }), null);
  assert.deepStrictEqual(cleanCommand({ type: 'set-tts-enabled', enabled: 'yes' }), { type: 'set-tts-enabled', enabled: false });
  assert.strictEqual(cleanCommand({ type: 'timer-set-message', message: 'm'.repeat(999) }).message.length, 200);
});

test('overlay-log keeps a few short scalar fields', () => {
  const clean = cleanCommand({ type: 'overlay-log', event: 'rendered', logId: 7, error: 'e'.repeat(999), nested: { a: 1 } });
  assert.deepStrictEqual(Object.keys(clean).sort(), ['error', 'event', 'logId', 'type']);
  assert.strictEqual(clean.error.length, 300);
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} request guard tests passed`);
process.exit(failed ? 1 : 0);
