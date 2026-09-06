const MAX_LINES = 20;
const chatBox = document.getElementById("chat-box");

// On/off for reading chat aloud -- controlled from the Setup & links page
// (index.html) via WS broadcast (type "tts-enabled-state") instead of a
// button on this overlay itself, since chat.html runs as an OBS browser
// source with no convenient way to click anything on it.
let ttsEnabled = true;

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

// Collapses a repeated pattern inside a single message before reading it
// aloud. Two cases, kept to different rep counts:
// - the repeat spans the whole message ("5555555555" -> "55", "สวัสดี สวัสดี
//   สวัสดี" -> "สวัสดี สวัสดี"): keep 2 reps, since that's still a deliberate
//   repeated word/pattern rather than a single word.
// - the repeat is trailing elongation stuck onto a real word ("เก่งมากกกกกกก"
//   -> "เก่งมาก", "ฮ่าๆๆๆๆๆๆ" -> "ฮ่าๆ"): collapse to 1 rep, back to the plain
//   word, since here the repeat isn't the message's own content.
// Distinguished by match position: a match starting at index 0 has no word
// in front of it, so it's the whole-message case.
// Tries pattern lengths 1-24 chars (non-greedy, wide enough to cover a word
// plus its trailing space) and cuts anything repeating 3+ times. A sentinel
// space is appended before matching and stripped after: without it, a unit
// like "สวัสดี " (word + trailing space) never matches its last repetition,
// since the message ends right after that word with no space following.
function collapseRepeatsForSpeech(text) {
  const collapsed = (text + " ").replace(
    /(.{1,24}?)\1{2,}/g,
    (_match, group, offset) => group.repeat(offset === 0 ? 2 : 1)
  );
  return text.endsWith(" ") ? collapsed : collapsed.replace(/ $/, "");
}

// Comments matching this are still shown in chat but never read aloud.
// "หี" + any Thai tone mark (่ ้ ๊ ๋, U+0E48-U+0E4B) or with no tone mark at all, plus "แตด".
// The lookahead excludes words like "หีบ" where a consonant follows (i.e. "หี" isn't the whole syllable).
const BLOCKED_TTS_PATTERN = /หี[่-๋]?(?![ก-ฮ])|แตด/;

function containsBlockedWord(text) {
  return BLOCKED_TTS_PATTERN.test(text);
}

// Rejoins words that were spaced out one letter at a time to dodge word
// filters, e.g. "เ ก" or "G      A       Y" -> "เก" / "GAY". Splits on
// whitespace and glues back together any run of 2+ consecutive single-char
// tokens; anything that's already a normal (2+ char) word is left alone, so
// ordinary short sentences like "ไป กิน ข้าว" aren't touched.
function collapseSpacedSingleChars(text) {
  const tokens = text.split(/\s+/);
  const result = [];
  let i = 0;
  while (i < tokens.length) {
    if (tokens[i].length === 1) {
      let j = i;
      let combined = "";
      while (j < tokens.length && tokens[j].length === 1) {
        combined += tokens[j];
        j++;
      }
      result.push(j - i >= 2 ? combined : tokens[i]);
      i = j;
    } else {
      result.push(tokens[i]);
      i++;
    }
  }
  return result.join(" ");
}

// Comments containing "เกย์"/"เก" (as a standalone word, not part of words
// like "เก่งมาก" or "เกม") or "gay" in any casing are still shown in chat but
// never read aloud.
const GAY_WORD_PATTERN = /^(?:เกย์?|เก|gay)$/i;

function containsGayWord(text) {
  const normalized = collapseSpacedSingleChars(text);
  return normalized.split(/\s+/).some((word) => GAY_WORD_PATTERN.test(word));
}

// Comments containing a "+" are still shown in chat but never read aloud.
// Ordinary chat doesn't use "+" between numbers, so this only ever fires on
// junk like "๔๑+ ๔+๒ ๔๑๒๓๑+๒๑+๒๑+๔" -- meaningless digit strings, not a
// repeated pattern (so isGibberishSpam wouldn't catch it) and not a real word
// (so it isn't spoken meaningfully either).
function containsMathSymbolSpam(text) {
  return text.includes("+");
}

// Comments made of a short chunk repeated many times with inconsistent
// spacing (spam combos like "ตุก จะจะ ตุก จี๊ ๆ ๆ ตุก จะ จะ ตุก จี๊ ๆ ๆ ...")
// are still shown in chat but never read aloud. Plain repeats like
// "5555555555" or "สวัสดี สวัสดี สวัสดี" get shortened by
// collapseRepeatsForSpeech before this check ever runs, so by the time text
// reaches here it should already be short -- if a repeated chunk of 12+
// chars still survives (whitespace stripped, so spacing variants like
// "จะจะ" vs "จะ จะ" count as the same unit), that repetition couldn't be
// collapsed cleanly and the message is treated as spam instead of spoken.
const GIBBERISH_SPAM_PATTERN = /(.{2,24}?)\1{2,}/;

function isGibberishSpam(collapsedText) {
  const compact = collapsedText.replace(/\s+/g, "");
  const match = compact.match(GIBBERISH_SPAM_PATTERN);
  return !!match && match[0].length >= 12;
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
  if (data.type === "tts-enabled-state") {
    ttsEnabled = data.enabled;
    if (!ttsEnabled) stopSpeaking();
    return;
  }

  if (data.type === "tts-speed-state") {
    ttsSpeed = data.speed;
    return;
  }

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
  const collapsedComment = collapseRepeatsForSpeech(data.comment);
  if (
    !isSpamRepeat(userKey, data.comment) &&
    !containsBlockedWord(data.comment) &&
    !containsGayWord(data.comment) &&
    !containsMathSymbolSpam(data.comment) &&
    !isGibberishSpam(collapsedComment)
  ) {
    speak(`${data.nickname} ${collapsedComment}`);
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
// 1.0 = ปกติ, >1 = อ่านเร็วขึ้น, <1 = ช้าลง. Default matches the server's
// initial ttsSpeed; actual value is controlled from the Setup page and
// synced over WS (see "tts-speed-state" below), same pattern as ttsEnabled.
let ttsSpeed = 1.5;
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
  audio.playbackRate = ttsSpeed;
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
