const MAX_ROWS = 40;
const listEl = document.getElementById("list");
const emptyEl = document.getElementById("empty");
const emptyTextEl = document.getElementById("empty-text");
const pinnedBar = document.getElementById("pinned-bar");
const pinnedBarNick = document.getElementById("pinned-bar-nick");
const pinnedBarComment = document.getElementById("pinned-bar-comment");
const pinnedBarAuto = document.getElementById("pinned-bar-auto");
const searchInput = document.getElementById("search");
const autoUnpinGroup = document.getElementById("auto-unpin");
let pinnedRow = null;
let autoUnpinTimer = null;
let ws = null;

autoUnpinGroup.querySelectorAll("button").forEach((btn) => {
  btn.addEventListener("click", () => {
    autoUnpinGroup.dataset.value = btn.dataset.value;
    autoUnpinGroup.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
  });
});

// Case-insensitive substring match against nickname/comment. Applied both
// on every keystroke and to each newly arriving row so live chat keeps
// respecting whatever's currently typed in the search box.
function matchesSearch(row) {
  const q = searchInput.value.trim().toLowerCase();
  if (!q) return true;
  return (
    row.dataset.nickname.toLowerCase().includes(q) ||
    row.dataset.comment.toLowerCase().includes(q)
  );
}

function applyFilter() {
  let visibleCount = 0;
  Array.from(listEl.children).forEach((row) => {
    const visible = matchesSearch(row);
    row.style.display = visible ? "" : "none";
    if (visible) visibleCount++;
  });
  const hasRows = listEl.children.length > 0;
  if (!hasRows) {
    emptyTextEl.textContent = "รอคอมเมนต์เข้ามา…";
    emptyEl.style.display = "flex";
  } else if (visibleCount === 0) {
    emptyTextEl.textContent = "ไม่พบคอมเมนต์ที่ตรงกับคำค้น";
    emptyEl.style.display = "flex";
  } else {
    emptyEl.style.display = "none";
  }
}

searchInput.addEventListener("input", applyFilter);

function addRow(nickname, comment, avatarUrl) {
  const row = document.createElement("div");
  row.className = "row";
  row.dataset.nickname = nickname;
  row.dataset.comment = comment;
  row.dataset.avatarUrl = avatarUrl || "";

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  if (avatarUrl) {
    const img = document.createElement("img");
    img.src = avatarUrl;
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.onerror = () => img.remove();
    avatar.appendChild(img);
  }

  const text = document.createElement("div");
  text.className = "text";
  const nick = document.createElement("div");
  nick.className = "nickname";
  nick.textContent = nickname;
  const body = document.createElement("div");
  body.className = "comment";
  body.textContent = comment;
  text.appendChild(nick);
  text.appendChild(body);

  const flag = document.createElement("span");
  flag.className = "pin-flag";
  flag.textContent = "📌 pinned";
  flag.style.display = "none";

  row.appendChild(avatar);
  row.appendChild(text);
  row.appendChild(flag);

  row.addEventListener("click", () => togglePin(row, flag));

  listEl.prepend(row);
  while (listEl.children.length > MAX_ROWS) {
    const last = listEl.lastChild;
    if (last === pinnedRow) break; // never drop the currently pinned row
    listEl.removeChild(last);
  }
  applyFilter();
}

function togglePin(row, flag) {
  if (row === pinnedRow) {
    unpin();
    return;
  }

  if (pinnedRow) {
    pinnedRow.classList.remove("pinned");
    pinnedRow.querySelector(".pin-flag").style.display = "none";
  }
  row.classList.add("pinned");
  flag.style.display = "inline";
  pinnedRow = row;
  pinnedBarNick.textContent = row.dataset.nickname;
  pinnedBarComment.textContent = row.dataset.comment;
  pinnedBar.classList.add("show");

  const autoMs = Number(autoUnpinGroup.dataset.value);
  ws.send({
    type: "pin",
    nickname: row.dataset.nickname,
    comment: row.dataset.comment,
    avatarUrl: row.dataset.avatarUrl,
    autoUnpinMs: autoMs,
  });

  clearTimeout(autoUnpinTimer);
  if (autoMs > 0) {
    pinnedBarAuto.textContent = `⏱ auto ${autoMs / 1000}s`;
    pinnedBarAuto.style.display = "inline";
    autoUnpinTimer = setTimeout(unpin, autoMs);
  } else {
    pinnedBarAuto.style.display = "none";
  }
}

function unpin() {
  clearTimeout(autoUnpinTimer);
  if (pinnedRow) {
    pinnedRow.classList.remove("pinned");
    pinnedRow.querySelector(".pin-flag").style.display = "none";
    pinnedRow = null;
  }
  pinnedBar.classList.remove("show");
  ws.send({ type: "unpin" });
}

pinnedBar.querySelector("#pinned-bar-clear").addEventListener("click", unpin);

const setWsStatus = attachStatusIndicator();

ws = connectWS((data) => {
  if (data.type !== "chat") return;
  addRow(data.nickname, data.comment, data.avatarUrl);
}, setWsStatus);
