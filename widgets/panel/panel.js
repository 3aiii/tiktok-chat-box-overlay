const MAX_ROWS = 40;
const listEl = document.getElementById("list");
const emptyEl = document.getElementById("empty");
const emptyTextEl = document.getElementById("empty-text");
const pinnedBar = document.getElementById("pinned-bar");
const pinnedBarNick = document.getElementById("pinned-bar-nick");
const pinnedBarComment = document.getElementById("pinned-bar-comment");
const pinnedBarAuto = document.getElementById("pinned-bar-auto");
const searchInput = document.getElementById("search");
let pinnedRow = null;
let autoUnpinMs = 30000;
let autoUnpinTimer = null;
let pinCountdown = null;
let ws = null;

bindSeg(document.getElementById("auto-unpin"), (ms) => (autoUnpinMs = Number(ms)));

// Case-insensitive substring match against nickname/comment. Applied both
// on every keystroke and to each newly arriving row so live chat keeps
// respecting whatever's currently typed in the search box.
function matchesSearch(row) {
  const q = searchInput.value.trim().toLowerCase();
  if (!q) return true;
  return row.dataset.nickname.toLowerCase().includes(q) || row.dataset.comment.toLowerCase().includes(q);
}

function applyFilter() {
  let visibleCount = 0;
  Array.from(listEl.children).forEach((row) => {
    const visible = matchesSearch(row);
    row.style.display = visible ? "" : "none";
    if (visible) visibleCount++;
  });
  if (!listEl.children.length) {
    emptyTextEl.textContent = "รอคอมเมนต์เข้ามา…";
    emptyEl.style.display = "flex";
  } else if (visibleCount === 0) {
    emptyTextEl.textContent = `ไม่พบคอมเมนต์ที่ตรงกับ “${searchInput.value.trim()}”`;
    emptyEl.style.display = "flex";
  } else {
    emptyEl.style.display = "none";
  }
}

searchInput.addEventListener("input", applyFilter);

// tag: optional { label, className } shown between the name and the text
// (GIFT for gifts, YT for YouTube comments).
function addRow(nickname, comment, avatarUrl, tag) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "row-comment";
  row.dataset.nickname = nickname;
  row.dataset.comment = comment;
  row.dataset.avatarUrl = avatarUrl || "";

  const now = new Date();
  const time = document.createElement("span");
  time.className = "row-time";
  time.textContent = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;

  const body = document.createElement("span");
  body.className = "row-body";
  const nick = document.createElement("b");
  nick.textContent = nickname;
  body.appendChild(nick);
  if (tag) {
    const tagEl = document.createElement("span");
    tagEl.className = `tag ${tag.className}`;
    tagEl.textContent = tag.label;
    body.appendChild(tagEl);
  }
  body.appendChild(document.createTextNode(comment));

  row.append(time, body);
  row.addEventListener("click", () => togglePin(row));

  listEl.prepend(row);
  while (listEl.children.length > MAX_ROWS) {
    const last = listEl.lastChild;
    if (last === pinnedRow) break; // never drop the currently pinned row
    listEl.removeChild(last);
  }
  applyFilter();
}

function togglePin(row) {
  if (row === pinnedRow) {
    unpin();
    return;
  }

  if (pinnedRow) pinnedRow.classList.remove("pinned");
  row.classList.add("pinned");
  pinnedRow = row;
  pinnedBarNick.textContent = row.dataset.nickname;
  pinnedBarComment.textContent = row.dataset.comment;
  pinnedBar.classList.add("show");

  ws.send({
    type: "pin",
    nickname: row.dataset.nickname,
    comment: row.dataset.comment,
    avatarUrl: row.dataset.avatarUrl,
    autoUnpinMs,
  });

  clearTimeout(autoUnpinTimer);
  clearInterval(pinCountdown);
  if (autoUnpinMs > 0) {
    const endsAt = Date.now() + autoUnpinMs;
    const tick = () => (pinnedBarAuto.textContent = formatClock(endsAt - Date.now()));
    tick();
    pinCountdown = setInterval(tick, 250);
    autoUnpinTimer = setTimeout(unpin, autoUnpinMs);
  } else {
    pinnedBarAuto.textContent = "ค้างไว้";
  }
}

function unpin() {
  clearTimeout(autoUnpinTimer);
  clearInterval(pinCountdown);
  if (pinnedRow) {
    pinnedRow.classList.remove("pinned");
    pinnedRow = null;
  }
  pinnedBar.classList.remove("show");
  ws.send({ type: "unpin" });
}

document.getElementById("pinned-bar-clear").addEventListener("click", unpin);

document.getElementById("show-summary").addEventListener("click", () => {
  ws.send({ type: "show-summary" });
  showToast("ส่ง Session summary ขึ้น /summary แล้ว");
});

// ---- TTS controls (same server state as the Control Room's Settings) ----
// Optimistic like the Control Room: update now, the server's broadcast reconciles.
const ttsEnabledSwitch = document.getElementById("tts-enabled");
const ttsSpeedGroup = document.getElementById("tts-speed");
const ttsProviderGroup = document.getElementById("tts-provider");
const ttsStatusEl = document.getElementById("tts-status");
const ttsState = { enabled: true, provider: "local", speed: 1.5 };

function renderTts() {
  ttsEnabledSwitch.classList.toggle("on", ttsState.enabled);
  setSegActive(ttsSpeedGroup, ttsState.speed);
  setSegActive(ttsProviderGroup, ttsState.provider);
  const engine = ttsState.provider === "google" ? "Google Translate" : "Local engine";
  ttsStatusEl.textContent = ttsState.enabled
    ? `กำลังอ่าน · ${engine} · ${ttsState.speed.toFixed(2)}×`
    : "ปิดเสียงอ่านทั้งหมด";
}

function setTts(change, message) {
  Object.assign(ttsState, change);
  renderTts();
  ws.send(message);
}

ttsEnabledSwitch.addEventListener("click", () => {
  const enabled = !ttsState.enabled;
  setTts({ enabled }, { type: "set-tts-enabled", enabled });
});
bindSeg(ttsSpeedGroup, (value) => {
  const speed = Number(value);
  setTts({ speed }, { type: "set-tts-speed", speed });
});
bindSeg(ttsProviderGroup, (provider) => setTts({ provider }, { type: "set-tts-provider", provider }));

// ---- BRB Timer controls ----
const timerReadout = document.getElementById("timer-readout");
const timerStatusEl = document.getElementById("timer-status");
const timerMinInput = document.getElementById("timer-min");
const timerSecInput = document.getElementById("timer-sec");
const timerMessageInput = document.getElementById("timer-message");
let timerTickInterval = null;

const TIMER_STATUS = {
  idle: "พร้อมเริ่ม · แสดงบน /timer",
  running: "กำลังนับถอยหลังบน /timer",
  paused: "หยุดชั่วคราว",
  ended: "หมดเวลา — กลับมาไลฟ์ได้เลย",
};

function customDurationMs() {
  const min = Number(timerMinInput.value) || 0;
  const sec = Number(timerSecInput.value) || 0;
  return (min * 60 + sec) * 1000;
}

document.querySelectorAll("#timer-presets button").forEach((btn) => {
  btn.addEventListener("click", () => {
    const ms = Number(btn.dataset.ms);
    timerMinInput.value = Math.floor(ms / 60000);
    timerSecInput.value = (ms % 60000) / 1000;
    ws.send({ type: "timer-start", durationMs: ms });
  });
});

document.getElementById("timer-start").addEventListener("click", () => {
  ws.send({ type: "timer-start", durationMs: customDurationMs() });
});
document.getElementById("timer-pause").addEventListener("click", () => ws.send({ type: "timer-pause" }));
document.getElementById("timer-resume").addEventListener("click", () => ws.send({ type: "timer-resume" }));
document.getElementById("timer-reset").addEventListener("click", () => ws.send({ type: "timer-reset" }));
timerMessageInput.addEventListener("change", () => {
  ws.send({ type: "timer-set-message", message: timerMessageInput.value });
});

function renderTimerState(state) {
  if (document.activeElement !== timerMessageInput) {
    timerMessageInput.value = state.message;
  }
  timerStatusEl.textContent = TIMER_STATUS[state.status] || "";
  timerReadout.classList.toggle("running", state.status === "running");
  timerReadout.classList.toggle("ended", state.status === "ended");

  clearInterval(timerTickInterval);
  const draw = () => (timerReadout.textContent = timerClockText(state));
  draw();
  if (state.status === "running") timerTickInterval = setInterval(draw, 250);
}

// ---- Song request controls ----
const songEnabledGroup = document.getElementById("song-enabled");
const songNoKeyEl = document.getElementById("song-nokey");
const songNowEl = document.getElementById("song-now");
const songIdleEl = document.getElementById("song-idle");
const songNowTitle = document.getElementById("song-now-title");
const songNowBy = document.getElementById("song-now-by");
const fillerLinkInput = document.getElementById("filler-link");
const fillerErrorEl = document.getElementById("filler-error");

bindSeg(songEnabledGroup, (value) => ws.send({ type: "set-song-enabled", enabled: value === "on" }));

document.getElementById("song-start").addEventListener("click", () => ws.send({ type: "song-start" }));
document.getElementById("song-skip").addEventListener("click", () => ws.send({ type: "song-skip" }));
document.getElementById("song-stop").addEventListener("click", () => ws.send({ type: "song-stop" }));

function addFiller() {
  const link = fillerLinkInput.value.trim();
  if (!link) return;
  fillerErrorEl.style.display = "none";
  ws.send({ type: "filler-add", link });
  fillerLinkInput.value = "";
}
document.getElementById("filler-add").addEventListener("click", addFiller);
fillerLinkInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") addFiller();
});

function formatDuration(sec) {
  return `${Math.floor(sec / 60)}:${pad2(sec % 60)}`;
}

// One row shape for all three lists -- they differ only in the subtitle (none
// for fillers) and which buttons hang off the end.
function songRow(song, subtitle, buttons) {
  const row = document.createElement("div");
  row.className = "song-row";

  const text = document.createElement("div");
  text.className = "song-row-text";
  const title = document.createElement("div");
  title.className = "song-row-title";
  title.textContent = song.title;
  text.appendChild(title);
  if (subtitle) {
    const sub = document.createElement("div");
    sub.className = "song-row-sub";
    sub.textContent = `${subtitle} · ${formatDuration(song.durationSec)}`;
    text.appendChild(sub);
  }
  row.appendChild(text);

  const btns = document.createElement("div");
  btns.className = "song-row-btns";
  buttons.forEach(({ label, className, onClick }) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `btn btn-sm ${className}`;
    btn.textContent = label;
    btn.addEventListener("click", onClick);
    btns.appendChild(btn);
  });
  row.appendChild(btns);
  return row;
}

// Fills one song list (pending / approved / fillers) plus its count and empty note.
function renderSongList(name, songs, subtitleOf, buttonsOf) {
  document.getElementById(`${name}-count`).textContent = songs.length;
  document.getElementById(`${name}-empty`).style.display = songs.length ? "none" : "block";
  document.getElementById(name).replaceChildren(...songs.map((song) => songRow(song, subtitleOf(song), buttonsOf(song))));
}

const send = (message) => () => ws.send(message);

function renderSongState(state) {
  songNoKeyEl.style.display = state.hasApiKey ? "none" : "block";
  setSegActive(songEnabledGroup, state.enabled ? "on" : "off");

  if (state.nowPlaying) {
    songNowTitle.textContent = state.nowPlaying.title;
    songNowBy.textContent = state.nowPlaying.isFiller ? "Filler" : state.nowPlaying.nickname;
  }
  songNowEl.classList.toggle("show", Boolean(state.nowPlaying));

  // Nothing plays on its own, so offer an explicit start -- but only when there
  // is actually something for it to play.
  const canStart = !state.nowPlaying && (state.approved.length > 0 || state.fillers.length > 0);
  songIdleEl.classList.toggle("show", canStart);

  renderSongList("song-pending", state.pending, (song) => song.nickname, (song) => [
    { label: "อนุมัติ", className: "btn-primary", onClick: send({ type: "song-approve", id: song.id }) },
    { label: "ปฏิเสธ", className: "", onClick: send({ type: "song-reject", id: song.id }) },
  ]);
  renderSongList("song-approved", state.approved, (song) => song.nickname, (song) => [
    { label: "เอาออก", className: "", onClick: send({ type: "song-reject", id: song.id }) },
  ]);
  renderSongList("filler-list", state.fillers, () => null, (song) => [
    { label: "ลบ", className: "", onClick: send({ type: "filler-remove", id: song.id }) },
  ]);
}

ws = connectWS((data) => {
  switch (data.type) {
    case "timer-state":
      return renderTimerState(data);
    case "song-state":
      return renderSongState(data);
    case "filler-add-failed":
      fillerErrorEl.textContent = data.reason;
      fillerErrorEl.style.display = "block";
      return;
    case "tts-enabled-state":
      ttsState.enabled = data.enabled;
      return renderTts();
    case "tts-speed-state":
      ttsState.speed = Number(data.speed);
      return renderTts();
    case "tts-provider-state":
      ttsState.provider = data.provider;
      return renderTts();
    case "gift":
      return addRow(data.nickname, `ส่ง ${data.giftName} ×${data.repeatCount || 1}`, data.avatarUrl, {
        label: "GIFT",
        className: "tag-accent",
      });
    case "chat":
      return addRow(data.nickname, data.comment, data.avatarUrl, data.platform === "youtube" ? { label: "YT", className: "tag-olive" } : null);
  }
}, attachStatusIndicator());

renderTts();
