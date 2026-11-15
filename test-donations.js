// Offline test for donations.js: a fake EasyDonate API in place of the real
// one, so it needs no API key and no network. Run with `npm test`.
const assert = require('assert');
const { createDonations } = require('./donations');

// A fake history, newest first like the real API, that counts its requests.
function fakeApi(rows) {
  const api = {
    rows,
    requests: [],
    fail: false,
    add(row) {
      api.rows.unshift(row);
    },
    fetchJson: async (url) => {
      if (api.fail) throw new Error('api down');
      const params = new URL(url).searchParams;
      const size = Number(params.get('size'));
      const page = Number(params.get('page'));
      api.requests.push({ size, page });
      return {
        data: {
          histories: api.rows.slice((page - 1) * size, page * size),
          totalPage: Math.max(1, Math.ceil(api.rows.length / size)),
        },
      };
    },
  };
  return api;
}

let nextId = 1;
const row = (name, amount, status = 'SUCCESS', createdAt = new Date(Date.now() - 60000 + nextId).toISOString()) => ({
  id: nextId++,
  donatorName: name,
  amount,
  status,
  donateMessage: `from ${name}`,
  createdAt,
});

function setup(rows, options = {}) {
  const api = fakeApi(rows);
  const announced = [];
  const donations = createDonations({
    apiKey: 'test',
    baseUrl: 'http://easydonate.test',
    fetchJson: api.fetchJson,
    onDonation: (d) => announced.push(d),
    ...options,
  });
  return { api, announced, donations };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('first read walks the whole history once, later reads cost nothing', async () => {
  // 250 rows = 3 pages of 100.
  const rows = Array.from({ length: 250 }, (_, i) => row(`donor${i % 7}`, 10));
  const { api, donations } = setup(rows);
  assert.strictEqual((await donations.all()).length, 250);
  assert.strictEqual(api.requests.length, 3);
  await donations.all();
  await donations.all();
  assert.strictEqual(api.requests.length, 3, 'reads after the first walk hit no API');
});

test('concurrent first reads share one walk', async () => {
  const { api, donations } = setup(Array.from({ length: 150 }, () => row('a', 1)));
  await Promise.all([donations.all(), donations.all(), donations.all()]);
  assert.strictEqual(api.requests.length, 2);
});

test('only SUCCESS donations are kept', async () => {
  const { donations } = setup([row('ok', 50), row('pending', 99, 'PENDING'), row('failed', 99, 'FAILED')]);
  const list = await donations.all();
  assert.deepStrictEqual(list.map((d) => d.name), ['ok']);
});

test('the backlog is never announced; a new donation is, once', async () => {
  const { api, announced, donations } = setup([row('old1', 10), row('old2', 20)]);
  await donations.poll(); // first poll = the walk
  assert.strictEqual(announced.length, 0);

  api.add(row('new', 40));
  await donations.poll();
  await donations.poll();
  assert.deepStrictEqual(announced.map((d) => [d.name, d.amount, d.message]), [['new', 40, 'from new']]);
  assert.strictEqual((await donations.all()).length, 3);
});

test('a poll reads one small page, not the history', async () => {
  const { api, donations } = setup(Array.from({ length: 250 }, () => row('a', 1)));
  await donations.poll();
  api.requests.length = 0;
  await donations.poll();
  assert.deepStrictEqual(api.requests, [{ size: 20, page: 1 }]);
});

test('a pending donation is announced when it clears', async () => {
  const pending = row('slow', 100, 'PENDING');
  const { announced, donations } = setup([pending]);
  await donations.poll();
  await donations.poll();
  assert.strictEqual(announced.length, 0);
  pending.status = 'SUCCESS';
  await donations.poll();
  assert.deepStrictEqual(announced.map((d) => d.name), ['slow']);
});

test('two arriving together are announced oldest first', async () => {
  const { api, announced, donations } = setup([row('old', 1)]);
  await donations.poll();
  api.add(row('first', 1));
  api.add(row('second', 1));
  await donations.poll();
  assert.deepStrictEqual(announced.map((d) => d.name), ['first', 'second']);
});

test('the resync walk finds what the first page missed', async () => {
  // Cleared while buried under 20+ newer rows, so no poll can ever see it.
  const buried = row('buried', 500, 'PENDING');
  const { api, announced, donations } = setup([buried], { resyncMs: -1 });
  await donations.poll();
  for (let i = 0; i < 25; i++) api.add(row(`filler${i}`, 1));
  await donations.poll();
  announced.length = 0;
  buried.status = 'SUCCESS';
  await donations.poll(); // resyncMs: -1 makes every poll end in a walk
  assert.deepStrictEqual(announced.map((d) => d.name), ['buried']);
  assert.ok((await donations.all()).some((d) => d.name === 'buried'));
});

test('a failed poll keeps what is already known', async () => {
  const { api, donations } = setup([row('a', 10), row('b', 20)]);
  await donations.poll();
  api.fail = true;
  await donations.poll(); // logs, doesn't throw
  assert.strictEqual((await donations.all()).length, 2);
  api.fail = false;
  api.add(row('c', 30));
  await donations.poll();
  assert.strictEqual((await donations.all()).length, 3);
});

test('a failed first walk rejects, and the next read tries again', async () => {
  const { api, donations } = setup([row('a', 10)]);
  api.fail = true;
  await assert.rejects(donations.all(), /api down/);
  api.fail = false;
  assert.strictEqual((await donations.all()).length, 1);
});

test('with nothing polling, a stale store refreshes in the background', async () => {
  const { api, donations } = setup([row('a', 10)]);
  await donations.all({ maxAgeMs: 15000 });
  api.add(row('b', 20));
  assert.strictEqual((await donations.all({ maxAgeMs: 15000 })).length, 1, 'fresh enough: no refetch');
  await new Promise((resolve) => setTimeout(resolve, 5));
  await donations.all({ maxAgeMs: 1 }); // stale: answers from memory, refreshes behind
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.strictEqual((await donations.all({ maxAgeMs: 15000 })).length, 2);
});

test('newest first', async () => {
  const { donations } = setup([
    row('newer', 1, 'SUCCESS', '2026-11-15T12:00:00Z'),
    row('older', 1, 'SUCCESS', '2026-11-14T12:00:00Z'),
  ]);
  assert.deepStrictEqual((await donations.all()).map((d) => d.name), ['newer', 'older']);
});

(async () => {
  const realError = console.error;
  let failed = 0;
  for (const { name, fn } of tests) {
    console.error = () => {}; // the failure paths log on purpose
    try {
      await fn();
      console.log(`  ok  ${name}`);
    } catch (err) {
      failed++;
      console.log(`FAIL  ${name}\n      ${err.message}`);
    } finally {
      console.error = realError;
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} donation tests passed`);
  process.exit(failed ? 1 : 0);
})();
