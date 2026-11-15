// Gift analytics for a date range, built from the server's gift history
// (/api/gift-events). All aggregating happens here; ranges that include today
// also append live Gifts from the WebSocket so the page doesn't refetch on
// every one.
//
// Query params:
//   demo    -- 1 uses generated history and keeps adding gifts, no server
//              connection (for checking the layout)

const params = new URLSearchParams(location.search);
const DEMO = params.get("demo") === "1";
const DAY_MS = 24 * 60 * 60 * 1000;
const TH_MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
const TH_DAYS = ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"];
// Cycled per gift type, biggest earner first -- same order as the mockup.
const TYPE_COLORS = ["var(--accent)", "var(--accent-2)", "var(--a-400)", "var(--a2-400)", "var(--a-300)", "var(--a2-300)"];
const AVATAR_TINTS = ["var(--a-300)", "var(--a2-300)", "var(--a-200)", "var(--a2-200)", "var(--n-300)"];

let range = "today";
let events = [];
let prevEvents = []; // the period before the picked range, for the stat-card deltas
let previousTotals = new Map();
// Regular fans always look at the last 30 days, whatever range is picked.
let fanEvents = [];
let fanTab = "regular";
const FAN_DAYS = 30;
const FAN_RECENT_DAYS = 7; // "new" = first Gift this recent; "lapsed" = none this recent

const fmt = (n) => Math.round(n).toLocaleString("en-US");
const thDate = (d) => `${d.getDate()} ${TH_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const hhmm = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const isSingleDay = () => range === "today" || range === "yesterday";

function startOfDay(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function rangeBounds(name) {
  const today = startOfDay(Date.now());
  const tomorrow = today + DAY_MS;
  if (name === "yesterday") return { from: today - DAY_MS, to: today };
  if (name === "7d") return { from: today - 6 * DAY_MS, to: tomorrow };
  if (name === "30d") return { from: today - 29 * DAY_MS, to: tomorrow };
  return { from: today, to: tomorrow };
}

// The period each range is compared against, and how the delta names it.
// Today is cut at the same clock time yesterday (in render), so a stream
// that's half over isn't measured against all of yesterday.
function previousBounds(name) {
  const { from, to } = rangeBounds(name);
  const len = to - from;
  return { from: from - len, to: from };
}
const PREV_LABEL = {
  today: "จากเมื่อวานช่วงเดียวกัน",
  yesterday: "จากวันก่อนหน้า",
  "7d": "จาก 7 วันก่อนหน้า",
  "30d": "จาก 30 วันก่อนหน้า",
};

// ---------------------------------------------------------------- aggregate

// Gift history has named a viewer three ways over time: nickname only, then
// the @handle, now TikTok's userId (which survives a handle change). Returns
// a function giving each Gift the strongest identity the list links it to,
// so one viewer's Gifts from before and after a change aren't split. A link
// pointing two ways (one nickname used by two handles) is ambiguous and
// dropped rather than guessed.
function identityResolver(list) {
  const idByHandle = new Map();
  const idByNickname = new Map();
  const handleByNickname = new Map();
  const link = (map, from, to) => {
    if (!from || !to) return;
    const seen = map.get(from);
    map.set(from, seen === undefined || seen === to ? to : null);
  };
  for (const e of list) {
    link(idByHandle, e.user, e.userId);
    link(idByNickname, e.nickname, e.userId);
    link(handleByNickname, e.nickname, e.user);
  }
  return (e) => {
    const user = e.user || handleByNickname.get(e.nickname) || "";
    const userId = e.userId || idByHandle.get(user) || (!e.user && idByNickname.get(e.nickname)) || "";
    const key = userId ? `id:${userId}` : user ? `@${user}` : `nickname:${e.nickname}`;
    return { key, user };
  };
}

function aggregate(list) {
  const gifters = new Map();
  const types = new Map();
  const identify = identityResolver(list);
  let diamonds = 0;
  let count = 0;
  for (const e of list) {
    diamonds += e.diamondCount;
    count += e.repeatCount;
    const { key, user } = identify(e);
    const g = gifters.get(key) || { key, user, nickname: e.nickname, avatarUrl: "", diamonds: 0, count: 0 };
    // The list is oldest first, so the latest handle / nickname wins.
    g.user = user || g.user;
    g.nickname = e.nickname || g.nickname;
    if (e.avatarUrl) g.avatarUrl = e.avatarUrl;
    g.diamonds += e.diamondCount;
    g.count += e.repeatCount;
    gifters.set(key, g);
    const t = types.get(e.giftName) || { name: e.giftName, image: "", count: 0, diamonds: 0 };
    if (e.giftImage) t.image = e.giftImage;
    t.count += e.repeatCount;
    t.diamonds += e.diamondCount;
    types.set(e.giftName, t);
  }
  return {
    diamonds,
    count,
    gifters: [...gifters.values()].sort((a, b) => b.diamonds - a.diamonds || b.count - a.count),
    types: [...types.values()].sort((a, b) => b.diamonds - a.diamonds || b.count - a.count),
  };
}

// Per viewer over the fan window: which days they gifted, first / last Gift.
// Each tab is a different question to ask before going live -- who always
// shows up, who just started, and which regular has gone quiet.
function fanLists(list) {
  const identify = identityResolver(list);
  const firstDay = startOfDay(Date.now()) - (FAN_DAYS - 1) * DAY_MS;
  const fans = new Map();
  for (const e of list) {
    const { key, user } = identify(e);
    const f = fans.get(key) || { key, user, nickname: e.nickname, avatarUrl: "", days: new Set(), first: e.t, last: e.t, diamonds: 0 };
    f.user = user || f.user;
    f.nickname = e.nickname || f.nickname;
    if (e.avatarUrl) f.avatarUrl = e.avatarUrl;
    f.days.add(Math.floor((startOfDay(e.t) - firstDay) / DAY_MS));
    f.last = e.t;
    f.diamonds += e.diamondCount;
    fans.set(key, f);
  }
  const recent = startOfDay(Date.now()) - (FAN_RECENT_DAYS - 1) * DAY_MS;
  const all = [...fans.values()];
  const byLoyalty = (a, b) => b.days.size - a.days.size || b.diamonds - a.diamonds;
  return {
    regular: all.filter((f) => f.days.size >= 2 && f.last >= recent).sort(byLoyalty),
    new: all.filter((f) => f.first >= recent).sort((a, b) => b.first - a.first),
    lapsed: all.filter((f) => f.days.size >= 2 && f.last < recent).sort(byLoyalty),
  };
}

// Hourly for a single day (from the first gift's hour to the last, or to
// now for today), daily for 7 / 30 days.
function buckets(list, bounds) {
  if (isSingleDay()) {
    const sums = new Array(24).fill(0);
    const counts = new Array(24).fill(0);
    let first = 23;
    let last = 0;
    for (const e of list) {
      const hour = new Date(e.t).getHours();
      sums[hour] += e.diamondCount;
      counts[hour] += e.repeatCount;
      first = Math.min(first, hour);
      last = Math.max(last, hour);
    }
    if (range === "today") last = Math.max(last, new Date().getHours());
    else if (!list.length) last = 23;
    first = Math.min(first, Math.max(0, last - 5)); // at least 6 bars so one gift isn't a single fat bar
    const out = [];
    for (let h = first; h <= last; h++) {
      out.push({ label: pad2(h), title: `${pad2(h)}:00 – ${pad2((h + 1) % 24)}:00`, value: sums[h], count: counts[h] });
    }
    return out;
  }
  const days = Math.round((bounds.to - bounds.from) / DAY_MS);
  const sums = new Array(days).fill(0);
  const counts = new Array(days).fill(0);
  for (const e of list) {
    const i = Math.floor((startOfDay(e.t) - bounds.from) / DAY_MS);
    if (i < 0 || i >= days) continue;
    sums[i] += e.diamondCount;
    counts[i] += e.repeatCount;
  }
  return sums.map((value, i) => {
    const d = new Date(bounds.from + i * DAY_MS + 12 * 60 * 60 * 1000); // midday: safe across DST
    const label = days <= 7 ? `${TH_DAYS[d.getDay()]} ${d.getDate()}` : i % 5 === 0 ? String(d.getDate()) : "";
    return { label, title: `${TH_DAYS[d.getDay()]} ${thDate(d)}`, value, count: counts[i] };
  });
}

// A round axis top just above the peak (1 / 2 / 2.5 / 5 x 10^n steps), so
// the gridlines read as clean numbers instead of 0 / 411 / 822.
function niceTicks(peak, count = 4) {
  const raw = Math.max(1, peak) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)); // no 0.25-diamond ticks
  const top = Math.max(step, Math.ceil(Math.max(1, peak) / step) * step);
  const ticks = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Math.round(v * 100) / 100);
  return { top, ticks };
}

const compact = (n) => (n >= 10000 ? `${Math.round(n / 1000)}K` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K` : fmt(n));

// ---------------------------------------------------------------- render

function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
}

function avatarEl(person, i) {
  const avatar = el("div", "gifter-avatar", escapeHtml((person.nickname || person.user || "?").charAt(0).toUpperCase()));
  avatar.style.background = AVATAR_TINTS[Math.min(i, AVATAR_TINTS.length - 1)];
  if (person.avatarUrl) {
    // Keep the initial until the photo has actually loaded.
    const img = createImg(person.avatarUrl);
    img.onload = () => avatar.replaceChildren(img);
  }
  return avatar;
}

function daysAgo(t) {
  const n = Math.round((startOfDay(Date.now()) - startOfDay(t)) / DAY_MS);
  return n === 0 ? "วันนี้" : n === 1 ? "เมื่อวาน" : `${n} วันก่อน`;
}

const FAN_EMPTY = {
  regular: "ยังไม่มีใครส่ง Gift เกิน 1 วันในสัปดาห์นี้",
  new: `ไม่มีคนส่ง Gift ครั้งแรกใน ${FAN_RECENT_DAYS} วันนี้`,
  lapsed: `ไม่มีแฟนประจำที่หายไปเกิน ${FAN_RECENT_DAYS} วัน`,
};

function renderFans() {
  const lists = fanLists(fanEvents);
  document.querySelectorAll("#fan-tab button").forEach((b) => {
    b.textContent = `${{ regular: "ประจำ", new: "ใหม่", lapsed: "หายไป" }[b.dataset.value]} ${lists[b.dataset.value].length}`;
  });
  const rows = lists[fanTab].slice(0, 10).map((f, i) => {
    const row = el("div", "fan");
    const tag = fanTab === "regular" && f.first >= startOfDay(Date.now()) - (FAN_RECENT_DAYS - 1) * DAY_MS ? `<span class="fan-tag">ใหม่</span>` : "";
    const who = el(
      "div",
      "",
      `<div class="gifter-name">${escapeHtml(f.nickname || f.user)}${tag}</div>
       <div class="gifter-sub">${f.user ? `@${escapeHtml(f.user)} · ` : ""}ล่าสุด ${daysAgo(f.last)}</div>`,
    );
    const strip = el("div", "fan-days");
    for (let d = 0; d < FAN_DAYS; d++) strip.appendChild(el("span", f.days.has(d) ? "on" : ""));
    const stat = el("div", "fan-stat", `<b>${fmt(f.days.size)} วัน</b><div>${fmt(f.diamonds)} เพชร</div>`);
    row.append(avatarEl(f, i), who, strip, stat);
    return row;
  });
  document.getElementById("fans").replaceChildren(...(rows.length ? rows : [el("div", "empty", FAN_EMPTY[fanTab])]));
}

// Diamonds per hour / day: round gridlines with their values on the left, the
// peak labelled on its cap and named in the line above, and a tooltip per
// column -- the whole column is the hover target, not just the (maybe tiny) bar.
function renderBars(data, total) {
  const peakIndex = data.reduce((best, b, i) => (b.value > data[best].value ? i : best), 0);
  const peak = data[peakIndex]?.value || 0;
  const { top, ticks } = niceTicks(peak);
  const unit = isSingleDay() ? "ชั่วโมง" : "วัน";

  document.getElementById("axis-label").textContent = isSingleDay() ? "รายชั่วโมง · เพชร" : "รายวัน · เพชร";
  document.getElementById("chart-summary").innerHTML = peak
    ? `${unit}ที่ได้มากสุด <b>${escapeHtml(data[peakIndex].title)}</b> · ${fmt(peak)} เพชร (${Math.round((peak / total) * 100)}% ของทั้งหมด)`
    : "ยังไม่มี Gift ในช่วงนี้";

  document.getElementById("grid").replaceChildren(
    ...ticks.map((v) => {
      const line = el("div", "grid-line", `<span>${compact(v)}</span>`);
      line.style.bottom = `${(v / top) * 100}%`;
      return line;
    }),
  );

  const tip = document.getElementById("chart-tip");
  tip.hidden = true; // its column is about to be replaced, and won't fire mouseleave
  const barsEl = document.getElementById("bars");
  barsEl.replaceChildren(
    ...data.map((b, i) => {
      const col = el("div", `bar${b.value && i === peakIndex ? " peak" : ""}`);
      if (b.value) {
        const fill = el("div", "bar-fill");
        fill.style.height = `${(b.value / top) * 100}%`;
        if (i === peakIndex) fill.appendChild(el("span", "bar-value", compact(b.value)));
        col.appendChild(fill);
      }
      col.appendChild(el("span", "bar-label", b.label));
      col.addEventListener("mouseenter", () => {
        tip.innerHTML = `<div class="tip-title">${escapeHtml(b.title)}</div>
          <div><b>${fmt(b.value)}</b> เพชร</div>
          <div class="muted">${fmt(b.count)} gifts</div>`;
        tip.hidden = false;
        const plot = barsEl.getBoundingClientRect();
        const box = col.getBoundingClientRect();
        const x = box.left + box.width / 2 - plot.left;
        tip.style.left = `${Math.min(Math.max(x, tip.offsetWidth / 2), plot.width - tip.offsetWidth / 2)}px`;
      });
      col.addEventListener("mouseleave", () => (tip.hidden = true));
      return col;
    }),
  );
}

function renderDelta(id, now, before) {
  const node = document.getElementById(id);
  const label = PREV_LABEL[range];
  if (!before) {
    node.className = "stat-delta";
    node.textContent = now ? `ช่วงก่อนหน้าไม่มี Gift` : "";
    return;
  }
  const pct = Math.round(((now - before) / before) * 100);
  const dir = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
  node.className = `stat-delta ${dir}`;
  node.innerHTML = `<span class="delta-arrow">${{ up: "▲", down: "▼", flat: "■" }[dir]}</span> ${Math.abs(pct)}% ${label}`;
  node.title = `ช่วงก่อนหน้า: ${fmt(before)}`;
}

function render() {
  const bounds = rangeBounds(range);
  const agg = aggregate(events);
  const rate = bahtRate();

  const from = thDate(new Date(bounds.from));
  const label = {
    today: `วันนี้ · ${from}`,
    yesterday: `เมื่อวาน · ${from}`,
  }[range] || `${from} – ${thDate(new Date(bounds.to - DAY_MS))}`;
  document.getElementById("range-label").textContent = `${label} · ${fmt(events.length)} รายการ${DEMO ? " · ข้อมูลตัวอย่าง" : ""}`;

  const prevList = range === "today" ? prevEvents.filter((e) => e.t < Date.now() - DAY_MS) : prevEvents;
  const prev = aggregate(prevList);
  renderDelta("delta-diamonds", agg.diamonds, prev.diamonds);
  renderDelta("delta-count", agg.count, prev.count);
  renderDelta("delta-gifters", agg.gifters.length, prev.gifters.length);
  document.getElementById("stat-diamonds").textContent = fmt(agg.diamonds);
  document.getElementById("stat-baht").textContent = `฿${fmt(agg.diamonds * rate)}`;
  document.getElementById("stat-baht-note").textContent = `อัตรา ฿${rate} / เพชร · ประมาณการ`;
  document.getElementById("stat-count").textContent = fmt(agg.count);
  document.getElementById("stat-gifters").textContent = `${fmt(agg.gifters.length)} คน`;

  // diamonds over time
  renderBars(buckets(events, bounds), agg.diamonds);

  // by gift type
  const typesEl = document.getElementById("types");
  const topTypes = agg.types.slice(0, 6);
  const typeMax = Math.max(1, ...topTypes.map((t) => t.diamonds));
  typesEl.replaceChildren(
    ...(topTypes.length
      ? topTypes.map((t, i) => {
          const color = TYPE_COLORS[i % TYPE_COLORS.length];
          const unit = t.count ? Math.round(t.diamonds / t.count) : 0;
          const row = el("div", "type");
          const dot = el("div", "type-dot");
          dot.style.background = color;
          if (t.image) {
            const img = createImg(t.image);
            img.onerror = () => img.remove();
            dot.appendChild(img);
          }
          const mid = el(
            "div",
            "",
            `<div class="type-top"><b>${escapeHtml(t.name)}</b><span>×${fmt(t.count)} · ${fmt(unit)} เพชร</span></div>
             <div class="type-track"><div class="type-fill" style="width:${(t.diamonds / typeMax) * 100}%;background:${color}"></div></div>`,
          );
          row.append(dot, mid, el("b", "type-total", fmt(t.diamonds)));
          return row;
        })
      : [el("div", "empty", "ยังไม่มี Gift ในช่วงนี้")]),
  );

  // top gifters
  const topEl = document.getElementById("top");
  const totals = new Map();
  const topRows = agg.gifters.slice(0, 8).map((g, i) => {
    const key = `${g.diamonds}:${g.count}`;
    totals.set(g.key, key);
    const row = el("div", "gifter");
    if (previousTotals.size && previousTotals.get(g.key) !== key) row.classList.add("flash");
    const rank = el("span", `gifter-rank${i < 3 ? ` r${i + 1}` : ""}`, String(i + 1));
    const avatar = avatarEl(g, i);
    const who = el(
      "div",
      "",
      `<div class="gifter-name">${escapeHtml(g.nickname || g.user)}</div>
       <div class="gifter-sub">${g.user ? `@${escapeHtml(g.user)} · ` : ""}${fmt(g.count)} gifts</div>`,
    );
    const share = agg.diamonds ? Math.round((g.diamonds / agg.diamonds) * 100) : 0;
    const amount = el("div", "gifter-amount", `<b>${fmt(g.diamonds)}</b><div>${share}%</div>`);
    row.append(rank, avatar, who, amount);
    return row;
  });
  previousTotals = totals;
  topEl.replaceChildren(...(topRows.length ? topRows : [el("div", "empty", "ยังไม่มีใครส่ง Gift ในช่วงนี้")]));

  // recent
  const recentEl = document.getElementById("recent");
  const recent = events.slice(-8).reverse();
  recentEl.replaceChildren(
    ...(recent.length
      ? recent.map((e) =>
          el(
            "div",
            "recent-row",
            `<span class="recent-time">${hhmm(new Date(e.t))}</span>
             <span class="recent-text"><b>${escapeHtml(e.nickname || e.user)}</b> ส่ง ${escapeHtml(e.giftName)} ×${fmt(e.repeatCount)}</span>
             <span class="recent-plus">+${fmt(e.diamondCount)}</span>`,
          ),
        )
      : [el("div", "empty", "—")]),
  );
  document.getElementById("live-flag").classList.toggle("off", range !== "today");
  renderFans();
}

// ---------------------------------------------------------------- data

async function fetchEvents(bounds) {
  if (DEMO) return demoEvents(bounds);
  const { from, to } = bounds;
  const res = await fetch(`/api/gift-events?from=${from}&to=${to}`);
  return (await res.json()).events || [];
}

async function load() {
  previousTotals = new Map(); // a new range shouldn't flash every row
  try {
    const [list, prev, fans] = await Promise.all([
      fetchEvents(rangeBounds(range)),
      fetchEvents(previousBounds(range)),
      range === "30d" ? null : fetchEvents(rangeBounds("30d")),
    ]);
    events = list.sort((a, b) => a.t - b.t);
    prevEvents = prev;
    fanEvents = fans ? fans.sort((a, b) => a.t - b.t) : events.slice();
  } catch {
    events = [];
    prevEvents = [];
    fanEvents = [];
    showToast("โหลดประวัติ Gift ไม่ได้");
  }
  render();
}

function addLiveGift(e) {
  const { from, to } = rangeBounds("today");
  if (e.t < from || e.t >= to) return load(); // crossed midnight -- start the new day
  fanEvents.push(e);
  if (range === "today" || range === "7d" || range === "30d") events.push(e);
  render();
}

bindSeg(document.getElementById("range"), (value) => {
  range = value;
  load();
});

bindSeg(document.getElementById("fan-tab"), (value) => {
  fanTab = value;
  renderFans();
});

document.getElementById("export").addEventListener("click", () => {
  const quote = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = ["time,userId,user,nickname,gift,count,diamonds"].concat(
    events.map((e) => {
      const d = new Date(e.t);
      const time = `${ymd(d)} ${hhmm(d)}:${pad2(d.getSeconds())}`;
      return [time, quote(e.userId), quote(e.user), quote(e.nickname), quote(e.giftName), e.repeatCount, e.diamondCount].join(",");
    }),
  );
  const a = document.createElement("a");
  // BOM so Excel opens the Thai nicknames as UTF-8
  a.href = URL.createObjectURL(new Blob(["﻿" + lines.join("\n")], { type: "text/csv" }));
  a.download = `gifts-${range}-${ymd(new Date())}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  showToast(`ดาวน์โหลด ${a.download} (${fmt(events.length)} รายการ)`);
});

// Baht rate is edited in the Control Room's Settings (same localStorage).
window.addEventListener("storage", (event) => {
  if (event.key === BAHT_RATE_KEY) render();
});

// ---------------------------------------------------------------- demo

const DEMO_USERS = [
  ["ploy.ploy", "PloyPloy"], ["maprang_kk", "มะปราง"], ["toychan", "Toy Chan 12345"], ["bigboss.th", "บอสใหญ่"],
  ["nnmin", "nn.min"], ["fahsai", "ฟ้าใส"], ["kiki_88", "kiki_88"], ["user4512512512", "user4512512512"],
];
const DEMO_GIFTS = [["Rose", 1, 40], ["Finger Heart", 5, 22], ["Rosa", 10, 14], ["Perfume", 20, 10], ["Hand Hearts", 100, 8], ["Galaxy", 1000, 2]];

function demoGift(t) {
  const [user, nickname] = DEMO_USERS[Math.floor(Math.random() ** 2 * DEMO_USERS.length)];
  let r = Math.random() * DEMO_GIFTS.reduce((s, g) => s + g[2], 0);
  const gift = DEMO_GIFTS.find((g) => (r -= g[2]) < 0) || DEMO_GIFTS[0];
  const repeatCount = gift[1] <= 10 ? 1 + Math.floor(Math.random() * 20) : 1 + Math.floor(Math.random() * 3);
  return {
    t,
    user,
    nickname,
    avatarUrl: `https://i.pravatar.cc/150?u=${encodeURIComponent(user)}`,
    giftName: gift[0],
    giftImage: "",
    repeatCount,
    diamondCount: gift[1] * repeatCount,
  };
}

// Evening-heavy, like a real live: most gifts land between 19:00 and 23:00.
// Today is spread over the last 8 hours instead, so it isn't empty before
// the evening.
function demoEvents({ from, to }) {
  const end = Math.min(to, Date.now());
  const today = startOfDay(Date.now());
  const out = [];
  for (let day = from; day < end; day += DAY_MS) {
    const n = 30 + Math.floor(Math.random() * 50);
    for (let i = 0; i < n; i++) {
      const t =
        day === today
          ? end - Math.random() ** 0.6 * 8 * 60 * 60 * 1000
          : day + (Math.random() < 0.8 ? 19 + Math.random() * 4 : 13 + Math.random() * 6) * 60 * 60 * 1000;
      if (t >= from && t < end) out.push(demoGift(t));
    }
  }
  return out;
}

// ---------------------------------------------------------------- start

load();

if (DEMO) {
  setInterval(() => addLiveGift(demoGift(Date.now())), 2500);
} else {
  connectWS((data) => {
    if (data.type !== "gift") return;
    addLiveGift({
      t: Date.now(),
      userId: data.userId || "",
      user: data.user,
      nickname: data.nickname,
      avatarUrl: data.avatarUrl || "",
      giftName: data.giftName,
      giftImage: data.giftImage || "",
      repeatCount: data.repeatCount || 1,
      diamondCount: data.diamondCount || 0,
    });
  }, attachStatusIndicator());
}
