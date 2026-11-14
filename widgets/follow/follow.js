// Pill-shaped follow alert: one alert per new follower, queued.
// Fed by the WS message { type: 'follow', user, nickname, avatarUrl }.
// Query string:
//   seconds -- how long each alert stays fully shown (2.5-10, default 4)
//   accent  -- hex without '#', main colour (default FF8A3D orange)
//   demo    -- 1 loops sample names without a live connection (for positioning in OBS)
const params = new URLSearchParams(location.search);
const HOLD_MS = Math.min(10, Math.max(2.5, Number(params.get("seconds")) || 4)) * 1000;
const GAP_MS = 700; // empty time between two alerts
const MAX_QUEUE = 30; // a follow raid shouldn't keep alerts running for an hour

// Timeline of one alert (ms after the previous step). Matches the CSS transitions.
const STEPS = [
  ["enter", 0],   // circle pops in
  ["open", 420],  // stretches into a pill, ring draws
  ["show", 520],  // waves, confetti, name, chip
  ["leave", null], // null = HOLD_MS
  ["close", 320], // pill shrinks back to a circle
  ["gone", 480],  // circle pops out
];

const rootStyle = document.documentElement.style;
const accentParam = params.get("accent");
if (accentParam && /^([0-9a-f]{3}|[0-9a-f]{6})$/i.test(accentParam)) {
  const hex = accentParam.length === 3 ? accentParam.split("").map((c) => c + c).join("") : accentParam;
  const n = parseInt(hex, 16);
  const rgb = `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
  rootStyle.setProperty("--accent", `#${hex}`);
  rootStyle.setProperty("--accent-line", `rgba(${rgb}, 0.4)`);
  rootStyle.setProperty("--accent-glow", `rgba(${rgb}, 0.28)`);
}

const $ = (id) => document.getElementById(id);
const stageEl = $("stage");
const nameEl = $("name");
const initialEl = $("initial");
const imgEl = $("avatar-img");

// ---- one-time decoration: confetti pieces and floating hearts ----
(function buildDecor() {
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue("--accent").trim();
  const soft = css.getPropertyValue("--accent-soft").trim();
  const palette = [accent, soft, "#FFFFFF", "#FF4D6D"];

  const confetti = $("confetti");
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2 + (i % 2 ? 0.2 : -0.12);
    const d = 48 + ((i * 37) % 5) * 9;
    const sq = i % 3 === 0;
    const w = sq ? 6 : 3.5;
    const h = sq ? 6 : 9;
    const s = document.createElement("span");
    s.style.cssText =
      `left:${-w / 2}px;top:${-h / 2}px;width:${w}px;height:${h}px;` +
      `border-radius:${sq ? "50%" : "2px"};background:${palette[i % palette.length]};` +
      `--x:${Math.round(Math.cos(a) * d)}px;--y:${Math.round(Math.sin(a) * d)}px;` +
      `--r:${(i % 2 ? 1 : -1) * (200 + i * 25)}deg;--dl:${(i % 4) * 30}ms`;
    confetti.appendChild(s);
  }

  const HEART = "M12 21s-7.5-4.6-9.8-9C.6 8.6 2.6 4.5 6.6 4.5c2.3 0 3.8 1.3 5.4 3.2 1.6-1.9 3.1-3.2 5.4-3.2 4 0 6 4.1 4.4 7.5C19.5 16.4 12 21 12 21z";
  const hearts = $("hearts");
  [
    { s: 12, x: "-10px", d: "0s", c: "#FF4D6D" },
    { s: 9, x: "8px", d: ".45s", c: "#FFFFFF" },
    { s: 11, x: "-2px", d: ".9s", c: "#FF7A93" },
    { s: 8, x: "12px", d: "1.35s", c: soft },
  ].forEach((h) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", h.s);
    svg.setAttribute("height", h.s);
    svg.style.setProperty("--hx", h.x);
    svg.style.setProperty("--hd", h.d);
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", HEART);
    path.setAttribute("fill", h.c);
    svg.appendChild(path);
    hearts.appendChild(svg);
  });
})();

// Thai vowels/tone marks must stay attached to their consonant, so split by
// grapheme rather than by code point.
function graphemes(s) {
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    return Array.from(new Intl.Segmenter("th", { granularity: "grapheme" }).segment(s), (g) => g.segment);
  }
  return s.match(/.[ัิ-ฺ็-๎]*/gu) || [];
}

function setPhase(phase) {
  stageEl.className = `p-${phase}`;
}

function fill(follower) {
  const name = follower.nickname || follower.user || "";
  const chars = graphemes(name);
  nameEl.replaceChildren(
    ...chars.map((c, i) => {
      const span = document.createElement("span");
      span.className = "ch";
      span.textContent = c === " " ? " " : c;
      span.style.setProperty("--d", `${180 + i * 35}ms`);
      return span;
    })
  );
  nameEl.title = name;
  initialEl.textContent = (chars[0] || "?").toUpperCase();

  imgEl.classList.remove("loaded");
  imgEl.onload = () => imgEl.classList.add("loaded");
  imgEl.onerror = () => imgEl.classList.remove("loaded");
  if (follower.avatarUrl) imgEl.src = follower.avatarUrl;
  else imgEl.removeAttribute("src");
}

// ---- alert queue ----
const queue = [];
const seen = new Set(); // TikTok can resend the same follow; alert once per user per session
let busy = false;

function enqueue(follower) {
  const key = follower.user || follower.nickname;
  if (!key || seen.has(key)) return;
  seen.add(key);
  if (queue.length >= MAX_QUEUE) queue.shift();
  queue.push(follower);
  if (!busy) next();
}

function next() {
  const follower = queue.shift();
  if (!follower) {
    busy = false;
    return;
  }
  busy = true;
  fill(follower);

  let t = 0;
  STEPS.forEach(([phase, delay]) => {
    t += delay === null ? HOLD_MS : delay;
    setTimeout(() => setPhase(phase), t);
  });
  setTimeout(next, t + GAP_MS);
}

if (params.get("demo") === "1") {
  // Covers the cases worth eyeballing: photo vs. initial fallback (no avatar),
  // Thai marks, emoji (incl. ZWJ), and a name long enough to hit the ellipsis.
  const SAMPLE = [
    { nickname: "มินนี่จัง", avatar: true },
    { nickname: "BossKung", avatar: true },
    { nickname: "น้องฟ้า", avatar: false },
    { nickname: "ปลาทูทอด กรอบนอกนุ่มใน ม.4/3 ห้องคิง", avatar: true },
    { nickname: "Nutty_TH", avatar: false },
    { nickname: "🐱น้องแมว🐱", avatar: true },
    { nickname: "👨‍👩‍👧 family", avatar: false },
    { nickname: "KaoNiew", avatar: true },
  ];
  let n = 0;
  const pushSample = () => {
    const s = SAMPLE[n % SAMPLE.length];
    enqueue({
      user: "demo-" + n, // unique per round so the dedupe doesn't swallow the loop
      nickname: s.nickname,
      avatarUrl: s.avatar ? `https://i.pravatar.cc/150?u=${encodeURIComponent(s.nickname)}` : "",
    });
    n++;
  };
  pushSample();
  setInterval(() => { if (!busy && !queue.length) pushSample(); }, 500);
} else {
  const setWsStatus = attachStatusIndicator();
  connectWS((data) => {
    if (data.type !== "follow") return;
    enqueue(data);
  }, setWsStatus);
}
