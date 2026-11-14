// Pill-shaped top-donate card: cycles through the top 10 one rank at a
// time. Data from GET /api/leaderboard -> { leaderboard: [{ name, amount }] }.
// Query string:
//   seconds -- how long each rank stays on screen (default 3.5, min 2)
//   accent  -- hex without '#', colour for ranks 4-10 (default FF8A3D orange)
//   demo    -- 1 uses fake data so the source can be positioned in OBS
const POLL_MS = 15000;
const OUT_MS = 380; // length of the exit transition before the next rank is swapped in

const params = new URLSearchParams(location.search);
const HOLD_MS = Math.max(2, Number(params.get("seconds")) || 3.5) * 1000;
const accentParam = params.get("accent");
if (accentParam && /^[0-9a-f]{3,8}$/i.test(accentParam)) {
  document.documentElement.style.setProperty("--accent", `#${accentParam}`);
}

// Gold / silver / bronze.
const MEDALS = {
  1: { c1: "#FFF1BF", c2: "#F5C451", glow: "rgba(245,196,81,0.32)", sheen: "rgba(255,236,170,0.28)" },
  2: { c1: "#FFFFFF", c2: "#CDD3DE", glow: "rgba(213,217,226,0.22)", sheen: "rgba(255,255,255,0.22)" },
  3: { c1: "#FAD7B5", c2: "#DD9A66", glow: "rgba(227,163,116,0.26)", sheen: "rgba(250,215,181,0.22)" },
};

const pillEl = document.getElementById("pill");
const labelEl = document.getElementById("label");
const nameEl = document.getElementById("name");
const amountEl = document.getElementById("amount");
const plainRankEl = document.getElementById("plain-rank");
const dotsEl = document.getElementById("dots");

let leaderboard = [];
let pending = null; // fresh data, applied at the next rank change so nothing jumps mid-display
let index = 0;
let holdTimer = null;
let countRaf = 0;

function formatAmount(n) {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function sameLeaderboard(a, b) {
  return a.length === b.length && a.every((e, i) => e.name === b[i].name && e.amount === b[i].amount);
}

function setPhase(phase) {
  pillEl.classList.remove("phase-in", "phase-out", "phase-pre");
  pillEl.classList.add(`phase-${phase}`);
}

function renderDots() {
  if (dotsEl.children.length !== leaderboard.length) {
    dotsEl.replaceChildren(...leaderboard.map(() => document.createElement("span")));
  }
  [...dotsEl.children].forEach((d, i) => d.classList.toggle("on", i === index));
}

function countUp(target) {
  cancelAnimationFrame(countRaf);
  const t0 = performance.now();
  const step = (now) => {
    const p = Math.min(1, Math.max(0, (now - t0 - 280) / 900));
    amountEl.textContent = formatAmount(target * (1 - Math.pow(1 - p, 3)));
    if (p < 1) countRaf = requestAnimationFrame(step);
  };
  amountEl.textContent = formatAmount(0);
  countRaf = requestAnimationFrame(step);
}

// Writes the entry at `index` into the pill and sets the rank's colours.
function fill() {
  const entry = leaderboard[index];
  const rank = index + 1;
  const medal = MEDALS[rank];
  const pillStyle = pillEl.style;

  pillEl.classList.remove("r1", "r2", "r3", "rest", "top");
  if (medal) {
    pillEl.classList.add(`r${rank}`, "top");
    pillStyle.setProperty("--m-c1", medal.c1);
    pillStyle.setProperty("--m-c2", medal.c2);
    pillStyle.setProperty("--m-glow", medal.glow);
    pillStyle.setProperty("--m-sheen", medal.sheen);
  } else {
    pillEl.classList.add("rest");
    ["--m-c1", "--m-c2", "--m-glow", "--m-sheen"].forEach((p) => pillStyle.removeProperty(p));
  }

  labelEl.textContent = `TOP DONATE · อันดับ ${rank}`;
  nameEl.textContent = entry.name;
  plainRankEl.textContent = rank;
  renderDots();
  countUp(entry.amount);
}

function enter() {
  setPhase("pre");
  fill();
  // Two frames so the parked "pre" position is painted before transitioning in.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    setPhase("in");
    schedule();
  }));
}

function schedule() {
  clearTimeout(holdTimer);
  holdTimer = setTimeout(advance, HOLD_MS);
}

function advance() {
  setPhase("out");
  setTimeout(() => {
    if (pending) {
      leaderboard = pending;
      pending = null;
      index = 0; // start again from #1 when the ranking changes
    } else {
      index = (index + 1) % leaderboard.length;
    }
    if (leaderboard.length === 0) {
      pillEl.classList.remove("show");
      return;
    }
    enter();
  }, OUT_MS);
}

function apply(next) {
  if (sameLeaderboard(next, pending || leaderboard)) return;
  if (leaderboard.length === 0) {
    leaderboard = next;
    index = 0;
    if (next.length) {
      pillEl.classList.add("show");
      enter();
    }
  } else {
    pending = next; // swapped in on the next advance()
  }
}

async function refresh() {
  try {
    const res = await fetch("/api/leaderboard");
    const data = await res.json();
    apply((data.leaderboard || []).slice(0, 10));
  } catch (err) {
    console.error("Failed to load leaderboard:", err.message);
  }
}

if (params.get("demo") === "1") {
  apply([2500, 1800, 1200, 950, 700, 520, 400, 300, 200, 100].map((amount, i) => ({ name: `ชื่อผู้โดเนท ${i + 1}`, amount })));
} else {
  refresh();
  setInterval(refresh, POLL_MS);
}
