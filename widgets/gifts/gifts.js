// Gift analytics for a date range, built from the server's gift history
// (/api/gift-events). All aggregating happens here; "today" also appends
// live Gifts from the WebSocket so the page doesn't refetch on every one.
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
let previousTotals = new Map();

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

// ---------------------------------------------------------------- aggregate

function aggregate(list) {
  const gifters = new Map();
  const types = new Map();
  let diamonds = 0;
  let count = 0;
  for (const e of list) {
    diamonds += e.diamondCount;
    count += e.repeatCount;
    const g = gifters.get(e.user) || { user: e.user, nickname: e.nickname, avatarUrl: "", diamonds: 0, count: 0 };
    g.nickname = e.nickname || g.nickname;
    if (e.avatarUrl) g.avatarUrl = e.avatarUrl;
    g.diamonds += e.diamondCount;
    g.count += e.repeatCount;
    gifters.set(e.user, g);
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

// Hourly for a single day (from the first gift's hour to the last, or to
// now for today), daily for 7 / 30 days.
function buckets(list, bounds) {
  if (isSingleDay()) {
    const sums = new Array(24).fill(0);
    let first = 23;
    let last = 0;
    for (const e of list) {
      const hour = new Date(e.t).getHours();
      sums[hour] += e.diamondCount;
      first = Math.min(first, hour);
      last = Math.max(last, hour);
    }
    if (range === "today") last = Math.max(last, new Date().getHours());
    else if (!list.length) last = 23;
    first = Math.min(first, Math.max(0, last - 5)); // at least 6 bars so one gift isn't a single fat bar
    const out = [];
    for (let h = first; h <= last; h++) out.push({ label: pad2(h), title: `${pad2(h)}:00`, value: sums[h] });
    return out;
  }
  const days = Math.round((bounds.to - bounds.from) / DAY_MS);
  const sums = new Array(days).fill(0);
  for (const e of list) {
    const i = Math.floor((startOfDay(e.t) - bounds.from) / DAY_MS);
    if (i >= 0 && i < days) sums[i] += e.diamondCount;
  }
  return sums.map((value, i) => {
    const d = new Date(bounds.from + i * DAY_MS + 12 * 60 * 60 * 1000); // midday: safe across DST
    const label = days <= 7 ? `${TH_DAYS[d.getDay()]} ${d.getDate()}` : i % 5 === 0 ? String(d.getDate()) : "";
    return { label, title: thDate(d), value };
  });
}

// ---------------------------------------------------------------- render

function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
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

  document.getElementById("stat-diamonds").textContent = fmt(agg.diamonds);
  document.getElementById("stat-baht").textContent = `฿${fmt(agg.diamonds * rate)}`;
  document.getElementById("stat-baht-note").textContent = `อัตรา ฿${rate} / เพชร · ประมาณการ`;
  document.getElementById("stat-count").textContent = fmt(agg.count);
  document.getElementById("stat-gifters").textContent = `${fmt(agg.gifters.length)} คน`;

  // diamonds over time
  const barData = buckets(events, bounds);
  const peak = Math.max(...barData.map((b) => b.value));
  const max = Math.max(1, peak);
  document.getElementById("axis-label").textContent = isSingleDay() ? "รายชั่วโมง" : "รายวัน";
  const barsEl = document.getElementById("bars");
  barsEl.replaceChildren(
    ...barData.map((b) => {
      const bar = el("div", `bar${b.value > 0 && b.value === peak ? " peak" : ""}`);
      bar.title = `${b.title}: ${fmt(b.value)} เพชร`;
      const fill = el("div", "bar-fill");
      fill.style.height = `${(b.value / max) * 88}%`;
      bar.append(fill, el("span", "bar-label", b.label));
      return bar;
    }),
  );

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
    totals.set(g.user, key);
    const row = el("div", "gifter");
    if (previousTotals.size && previousTotals.get(g.user) !== key) row.classList.add("flash");
    const rank = el("span", `gifter-rank${i < 3 ? ` r${i + 1}` : ""}`, String(i + 1));
    const avatar = el("div", "gifter-avatar", escapeHtml((g.nickname || g.user || "?").charAt(0).toUpperCase()));
    avatar.style.background = AVATAR_TINTS[Math.min(i, AVATAR_TINTS.length - 1)];
    if (g.avatarUrl) {
      // Keep the initial until the photo has actually loaded.
      const img = createImg(g.avatarUrl);
      img.onload = () => avatar.replaceChildren(img);
    }
    const who = el(
      "div",
      "",
      `<div class="gifter-name">${escapeHtml(g.nickname || g.user)}</div>
       <div class="gifter-sub">@${escapeHtml(g.user)} · ${fmt(g.count)} gifts</div>`,
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
}

// ---------------------------------------------------------------- data

async function load() {
  previousTotals = new Map(); // a new range shouldn't flash every row
  if (DEMO) {
    events = demoEvents(rangeBounds(range));
  } else {
    const { from, to } = rangeBounds(range);
    try {
      const res = await fetch(`/api/gift-events?from=${from}&to=${to}`);
      events = (await res.json()).events || [];
    } catch {
      events = [];
      showToast("โหลดประวัติ Gift ไม่ได้");
    }
  }
  events.sort((a, b) => a.t - b.t);
  render();
}

function addLiveGift(e) {
  if (range !== "today") return;
  const { from, to } = rangeBounds("today");
  if (e.t < from || e.t >= to) return load(); // crossed midnight -- start the new day
  events.push(e);
  render();
}

bindSeg(document.getElementById("range"), (value) => {
  range = value;
  load();
});

document.getElementById("export").addEventListener("click", () => {
  const quote = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = ["time,user,nickname,gift,count,diamonds"].concat(
    events.map((e) => {
      const d = new Date(e.t);
      const time = `${ymd(d)} ${hhmm(d)}:${pad2(d.getSeconds())}`;
      return [time, quote(e.user), quote(e.nickname), quote(e.giftName), e.repeatCount, e.diamondCount].join(",");
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
