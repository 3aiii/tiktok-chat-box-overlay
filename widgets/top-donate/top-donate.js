const POLL_MS = 15000; // how often to re-fetch the leaderboard from the API
const CYCLE_MS = 3000; // how long each rank stays on screen before the next slides in
const ROW_GAP_PX = 12; // must match #track's `gap` in top-donate.css
const trackEl = document.getElementById("track");
const emptyEl = document.getElementById("empty");

let leaderboard = [];
let currentIndex = 0; // index into `leaderboard` of the entry currently on screen

// Freshly-fetched data waiting to be applied. Fetching runs on its own timer,
// independent of the slide cycle; new data only ever gets swapped in at the
// wrap-around boundary in advance() below, and always via the same slide
// transition as a normal rank change -- so a data refresh never cuts an
// animation short, it just becomes the next stop on the ride.
let pendingLeaderboard = null;

function sameLeaderboard(a, b) {
  return a.length === b.length && a.every((entry, i) => entry.name === b[i].name && entry.amount === b[i].amount);
}

function formatAmount(amount) {
  return amount.toLocaleString("th-TH", { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + " " + "฿";
}

function makeRow(entry, rank) {
  const row = document.createElement("div");
  row.className = `row rank-${rank}`;
  row.innerHTML = `
    <span class="name"><span class="rank">${rank})</span></span>
    <span class="amount"></span>
  `;
  row.querySelector(".name").appendChild(document.createTextNode(entry.name));
  row.querySelector(".amount").textContent = formatAmount(entry.amount);
  return row;
}

function showEmptyState() {
  emptyEl.style.display = leaderboard.length === 0 ? "block" : "none";
}

// Draws exactly the current entry with no transition -- used for first load
// and whenever the list is (re)populated from empty, where there's no
// existing slide to carry over from.
function renderCurrent() {
  trackEl.style.transition = "none";
  trackEl.style.transform = "translateX(0)";
  trackEl.innerHTML = "";
  if (leaderboard.length > 0) {
    trackEl.appendChild(makeRow(leaderboard[currentIndex], currentIndex + 1));
  }
  showEmptyState();
}

// Slides from whatever's on screen to the next entry -- normally the next
// rank in the same leaderboard, or, at the end of the list, rank #1 of
// whatever the latest fetched data is (freshest data wins right as the loop
// comes back around). The track only ever holds the outgoing + incoming row,
// so both a plain rank change and a data refresh play out as the exact same
// animated slide.
function advance() {
  if (leaderboard.length === 0) return;

  let nextIndex = currentIndex + 1;
  let nextLeaderboard = leaderboard;
  if (nextIndex >= leaderboard.length) {
    nextIndex = 0;
    if (pendingLeaderboard) {
      nextLeaderboard = pendingLeaderboard;
      pendingLeaderboard = null;
    }
  }

  if (nextLeaderboard.length === 0) {
    leaderboard = nextLeaderboard;
    currentIndex = 0;
    renderCurrent();
    return;
  }

  trackEl.appendChild(makeRow(nextLeaderboard[nextIndex], nextIndex + 1));
  void trackEl.offsetWidth; // force reflow so the transition below actually animates
  trackEl.style.transition = "transform 0.9s cubic-bezier(0.22, 0.8, 0.28, 1)";
  // Percentage translateX resolves against the track's own width (one row),
  // not the gap between flex children -- add it explicitly so the slide
  // clears the gap and lands flush on the incoming row instead of resting
  // half-in-the-gap.
  trackEl.style.transform = `translateX(calc(-100% - ${ROW_GAP_PX}px))`;

  setTimeout(() => {
    leaderboard = nextLeaderboard;
    currentIndex = nextIndex;
    trackEl.removeChild(trackEl.firstElementChild);
    trackEl.style.transition = "none";
    trackEl.style.transform = "translateX(0)";
    showEmptyState();
  }, 900);
}

async function refresh() {
  try {
    const res = await fetch("/api/leaderboard");
    const data = await res.json();
    const next = (data.leaderboard || []).slice(0, 10);
    if (sameLeaderboard(next, leaderboard)) return;

    if (leaderboard.length === 0) {
      // Nothing rendered yet (first load, or list was empty) -- no
      // transition in flight to protect, so apply immediately.
      leaderboard = next;
      currentIndex = 0;
      renderCurrent();
    } else {
      pendingLeaderboard = next;
    }
  } catch (err) {
    console.error("Failed to load leaderboard:", err.message);
  }
}

refresh();
setInterval(advance, CYCLE_MS);
setInterval(refresh, POLL_MS);
