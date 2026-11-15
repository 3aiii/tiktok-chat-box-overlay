// EasyDonate donations, held in memory. The API has no push and no "since"
// filter, so the only ways to learn anything are to page through the whole
// history or to look at its first page. This walks the history once, then
// keeps up from the first page -- a few rows every 10s -- instead of every
// /top-donate poll re-reading every donation ever made.
//
// A full walk still happens every DONATION_RESYNC_MS, to catch what the first
// page can miss: a donation that cleared after 20 newer ones pushed it off the
// page, or a burst of more than 20 between two polls.

const DONATION_POLL_MS = 10000;
const DONATION_RESYNC_MS = 10 * 60 * 1000;
const DONATIONS_PAGE_SIZE = 100;
const DONATIONS_POLL_SIZE = 20;

const toDonation = (d) => ({
  id: d.id,
  name: d.donatorName || 'ไม่ระบุชื่อ',
  amount: Number(d.amount) || 0,
  message: d.donateMessage || '',
  t: Date.parse(d.createdAt) || Date.now(),
});

// Rows are keyed by id; the fallback only matters if the API ever omits one,
// where a shared `undefined` key would fold every donation into a single row.
const donationKey = (d) => String(d.id ?? `${d.createdAt}|${d.donatorName}|${d.amount}`);

// fetchJson(url, headers) -> parsed body. onDonation(donation) fires once for
// each donation that turns up after the first walk (never for the backlog).
function createDonations({ apiKey, baseUrl, fetchJson, onDonation = () => {}, resyncMs = DONATION_RESYNC_MS }) {
  let store = new Map(); // key -> donation, SUCCESS only
  let loadedAt = 0; // 0 until the first walk finishes
  let walking = null; // the walk in progress, shared by everyone waiting on it
  let addedDuringWalk = null; // keys the poll added while a walk was running
  const announced = new Set();

  async function fetchPage(page, size) {
    const { data } = await fetchJson(`${baseUrl}/api/v1/donations?size=${size}&page=${page}`, {
      Authorization: `Bearer ${apiKey}`,
    });
    return { rows: data?.histories || [], totalPage: data?.totalPage || 1 };
  }

  // Only SUCCESS counts: a pending one is announced once it clears.
  function announce(key, donation) {
    if (announced.has(key)) return;
    announced.add(key);
    if (loadedAt) onDonation(donation);
  }

  async function walk() {
    addedDuringWalk = new Map();
    try {
      const fresh = new Map();
      for (let page = 1, totalPage = 1; page <= totalPage; page++) {
        const result = await fetchPage(page, DONATIONS_PAGE_SIZE);
        totalPage = result.totalPage;
        for (const d of result.rows) {
          if (d.status === 'SUCCESS') fresh.set(donationKey(d), toDonation(d));
        }
      }
      // A donation the poll picked up after this walk had already read page 1
      // isn't in `fresh`; dropping it would hide it until the next walk.
      for (const [key, donation] of addedDuringWalk) {
        if (!fresh.has(key)) fresh.set(key, donation);
      }
      // Oldest first, so two found together are announced in order.
      for (const [key, donation] of [...fresh].sort((a, b) => a[1].t - b[1].t)) announce(key, donation);
      store = fresh;
      loadedAt = Date.now();
    } finally {
      addedDuringWalk = null;
    }
  }

  function refresh() {
    if (!walking) {
      walking = walk().finally(() => {
        walking = null;
      });
    }
    return walking;
  }

  // One look at the first page. Called on a timer by start(); a failure keeps
  // what's already known rather than emptying the leaderboard.
  async function poll() {
    try {
      if (!loadedAt) {
        await refresh();
        return;
      }
      const { rows } = await fetchPage(1, DONATIONS_POLL_SIZE);
      for (const d of rows.slice().reverse()) {
        const key = donationKey(d);
        if (d.status !== 'SUCCESS' || store.has(key)) continue;
        const donation = toDonation(d);
        store.set(key, donation);
        if (addedDuringWalk) addedDuringWalk.set(key, donation);
        announce(key, donation);
      }
      if (Date.now() - loadedAt > resyncMs) await refresh();
    } catch (err) {
      console.error('[donation] poll failed:', err.message);
    }
  }

  // Every SUCCESS donation, newest first. Waits for the first walk; after
  // that it answers from memory. `maxAgeMs` is for when nothing is polling
  // (MOCK mode): a stale store is refreshed in the background.
  async function all({ maxAgeMs = Infinity } = {}) {
    if (!loadedAt) {
      await refresh();
    } else if (Date.now() - loadedAt > maxAgeMs) {
      refresh().catch((err) => console.error('[donation] refresh failed:', err.message));
    }
    return [...store.values()].sort((a, b) => b.t - a.t);
  }

  function start() {
    poll();
    return setInterval(poll, DONATION_POLL_MS);
  }

  return { all, poll, start };
}

module.exports = { createDonations };
