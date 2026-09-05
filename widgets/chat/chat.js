const MAX_LINES = 20;
const chatBox = document.getElementById("chat-box");

// Toggle TTS on/off; persisted so a page refresh (or OBS reload) keeps the choice.
const ttsToggleBtn = document.getElementById("tts-toggle");
let ttsEnabled = localStorage.getItem("ttsEnabled") !== "off";

const TTS_ICON_ON =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M4 9v6h4l5 5V4L8 9H4z"/>' +
  '<path d="M16.5 8.5a5 5 0 0 1 0 7"/>' +
  '<path d="M19 6a9 9 0 0 1 0 12"/>' +
  "</svg>";
const TTS_ICON_OFF =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M4 9v6h4l5 5V4L8 9H4z"/>' +
  '<path d="M16 9l6 6"/>' +
  '<path d="M22 9l-6 6"/>' +
  "</svg>";

function renderTtsToggle() {
  ttsToggleBtn.innerHTML = ttsEnabled ? TTS_ICON_ON : TTS_ICON_OFF;
  ttsToggleBtn.classList.toggle("off", !ttsEnabled);
}

ttsToggleBtn.addEventListener("click", () => {
  ttsEnabled = !ttsEnabled;
  localStorage.setItem("ttsEnabled", ttsEnabled ? "on" : "off");
  renderTtsToggle();
  if (!ttsEnabled) stopSpeaking();
});

renderTtsToggle();

// Anti-spam: if the same person repeats the same comment more than 3
// times in a row, keep showing the chat bubble but stop reading it aloud.
const SPAM_REPEAT_LIMIT = 3;
const lastCommentByUser = new Map();

function isSpamRepeat(userKey, comment) {
  const prev = lastCommentByUser.get(userKey);
  const count = prev && prev.text === comment ? prev.count + 1 : 1;
  lastCommentByUser.set(userKey, { text: comment, count });
  return count > SPAM_REPEAT_LIMIT;
}

// Collapses a repeated pattern inside a single message down to 3 reps
// before reading it aloud, e.g. "####" -> "###", "#$@#$@#$@#$@" -> "#$@#$@#$@".
// Tries pattern lengths 1-12 chars (non-greedy) and cuts anything repeating 4+ times.
function collapseRepeatsForSpeech(text) {
  return text.replace(/(.{1,12}?)\1{3,}/g, (_match, group) => group.repeat(3));
}

// Comments matching this are still shown in chat but never read aloud.
// "หี" + any Thai tone mark (่ ้ ๊ ๋, U+0E48-U+0E4B) or with no tone mark at all, plus "แตด".
// The lookahead excludes words like "หีบ" where a consonant follows (i.e. "หี" isn't the whole syllable).
const BLOCKED_TTS_PATTERN = /หี[่-๋]?(?![ก-ฮ])|แตด/;

function containsBlockedWord(text) {
  return BLOCKED_TTS_PATTERN.test(text);
}

// Small confetti burst near the bottom-right chat box whenever a gift comes in.
// canvas-confetti is self-hosted via /vendor/confetti.js; skip quietly if it failed to load.
function celebrateGift() {
  if (typeof confetti !== "function") return;
  confetti({
    particleCount: 60,
    spread: 65,
    startVelocity: 45,
    origin: { x: 0.15, y: 0.85 },
    colors: ["#ffd54a", "#ff8a5c", "#ff5b7a", "#7c5cff"],
  });
}

function addChatLine(nickname, comment, avatarUrl) {
  const { line, bubble } = buildLine("", "@" + nickname, avatarUrl, null);
  line.querySelector(".nickname").textContent += " :";
  bubble.innerHTML = `<span class="comment">${escapeHtml(comment)}</span>`;
  pushLine(chatBox, line, MAX_LINES);
}

function addGiftLine(nickname, giftName, repeatCount, avatarUrl, giftImage) {
  // const badge = createBadge("badge-gift", "🎁");
  const { line, bubble } = buildLine("gift-line", "@" + nickname, avatarUrl, null);
  const times = repeatCount > 1 ? ` <span class="gift-count">x${repeatCount}</span>` : "";
  bubble.innerHTML = `<span class="comment">ส่ง ${escapeHtml(giftName)}${times}</span>`;

  // if (giftImage) {
  //   const icon = document.createElement("img");
  //   icon.className = "gift-icon";
  //   icon.src = giftImage;
  //   icon.alt = "";
  //   icon.referrerPolicy = "no-referrer";
  //   icon.onerror = () => icon.remove();
  //   bubble.appendChild(icon);
  // }

  pushLine(chatBox, line, MAX_LINES);
}

const setWsStatus = attachStatusIndicator();

connectWS((data) => {
  if (data.type === "gift") {
    addGiftLine(data.nickname, data.giftName, data.repeatCount, data.avatarUrl, data.giftImage);
    celebrateGift();
    const times = data.repeatCount > 1 ? ` ${data.repeatCount} ชิ้น` : "";
    speak(`ขอบคุณ ${data.nickname} ที่ส่ง ${data.giftName}${times}`);
    return;
  }

  if (data.type === "member") return;

  if (data.type !== "chat") return;
  addChatLine(data.nickname, data.comment, data.avatarUrl);
  const userKey = data.user || data.nickname;
  if (!isSpamRepeat(userKey, data.comment) && !containsBlockedWord(data.comment)) {
    speak(`${data.nickname} ${collapseRepeatsForSpeech(data.comment)}`);
  }
}, setWsStatus);

// Thai TTS via a self-hosted engine (tts-engine-project, POST /v1/tts),
// proxied through our own server (see proxyLocalTts in server.js) so the
// browser can fetch it same-origin with a plain GET. Long text is still
// split into chunks and queued to play one after another (avoids
// overlapping audio when multiple chat messages arrive close together);
// 200 chars is just a reasonable chunk size now, not an upstream limit.
const TTS_CHUNK_LIMIT = 200;
const TTS_VOLUME = 0.4; // 0.0 (เงียบ) - 1.0 (เต็ม)
const TTS_SPEED = 1.50; // 1.0 = ปกติ, >1 = อ่านเร็วขึ้น, <1 = ช้าลง
const speakQueue = [];
let isSpeaking = false;
let currentAudio = null;

function speak(text) {
  if (!ttsEnabled) return;
  speakQueue.push(text);
  if (!isSpeaking) processQueue();
}

// Drops any queued messages and immediately silences whatever's playing
// right now — used when the user toggles TTS off mid-speech.
function stopSpeaking() {
  speakQueue.length = 0;
  if (currentAudio) {
    currentAudio.onended = null;
    currentAudio.onerror = null;
    currentAudio.pause();
    currentAudio = null;
  }
  isSpeaking = false;
}

function processQueue() {
  if (speakQueue.length === 0) {
    isSpeaking = false;
    return;
  }
  isSpeaking = true;
  const chunks = splitForTts(speakQueue.shift(), TTS_CHUNK_LIMIT);
  playChunks(chunks, 0, processQueue);
}

function splitForTts(text, maxLen) {
  const chunks = [];
  let rest = text;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf(" ", maxLen);
    if (cut <= 0) cut = maxLen;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function playChunks(chunks, i, onDone) {
  if (i >= chunks.length) {
    onDone();
    return;
  }
  // Same-origin proxy in server.js — calling translate.google.com directly
  // from the browser gets blocked by Chrome's ORB (net::ERR_BLOCKED_BY_ORB).
  const url = "/tts?text=" + encodeURIComponent(chunks[i]);
  const audio = new Audio(url);
  audio.volume = TTS_VOLUME;
  audio.playbackRate = TTS_SPEED;
  currentAudio = audio;
  const next = () => playChunks(chunks, i + 1, onDone);
  audio.onended = next;
  audio.onerror = () => {
    console.warn("Google TTS โหลดเสียงไม่สำเร็จ ข้ามท่อนนี้ไป:", chunks[i]);
    next();
  };
  audio.play().catch((err) => {
    console.warn("audio.play() ถูกบล็อก:", err.name, err.message);
    next();
  });
}
