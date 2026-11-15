require('dotenv').config();
const { TikTokLiveConnection, WebcastEvent, ControlEvent } = require('tiktok-live-connector');
const { WebSocketServer } = require('ws');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const { URL } = require('url');
const { startYouTubeChat } = require('./youtube-chat');

const TIKTOK_USERNAME = process.env.TIKTOK_USERNAME || 'your_tiktok_username';
const WS_PORT = process.env.WS_PORT || 8081;
const HTTP_PORT = process.env.HTTP_PORT || 8080;
const MOCK_MODE = process.env.MOCK === '1';
const EASYDONATE_API_KEY = process.env.EASYDONATE_API_KEY || '';

// Self-hosted TTS engine (tts-engine-project, POST /v1/tts, {text, lang} ->
// streamed WAV). Switchable at runtime against the older Google proxy -- see
// ttsProvider below and the /tts route.
const TTS_ENGINE_URL = process.env.TTS_ENGINE_URL || 'http://127.0.0.1:8000/v1/tts';

// TTS settings below are in-memory only (they reset on restart), changed from
// the Control Room or the Panel and broadcast to every page over WS.
let ttsProvider = 'google'; // 'local' | 'google'

// Global on/off for reading chat aloud.
let ttsEnabled = true;

// Playback rate: 1.0 = normal, >1 faster, <1 slower.
let ttsSpeed = 1.5;

// Fraction of Comments (0..1) that TTS reads aloud after the skip filters;
// the rest are only shown. Lets a busy chat be read "sometimes" instead of
// queueing every line.
let ttsReadChance = 1;

// Whether the server currently has a live TikTok room connection (real mode)
// or is generating fake events (mock mode, always "connected"). Distinct from
// a browser's own WebSocket link to this server -- that can be open while
// TikTok itself is offline, which is exactly the case this flag exists to
// surface on the control room's LIVE badge.
let tiktokLiveConnected = MOCK_MODE;

// The TikTok room of the live we're reading (each go-live gets a new one;
// reconnecting mid-live keeps it). Stamped on every Gift history entry, so
// "this live" survives a server restart -- /walkers crowns the top gifter of
// the current room.
let currentRoomId = MOCK_MODE ? 'mock' : '';

// How many consecutive times connectToTikTok has failed since the last
// success; surfaced in tiktokConnectionPayload's detail so the control
// room's badge shows retry progress instead of a static offline message.
let tiktokReconnectAttempt = 0;

function tiktokConnectionPayload(detailOverride) {
  const payload = { type: 'tiktok-connection-state', connected: tiktokLiveConnected, roomId: currentRoomId };
  if (!tiktokLiveConnected) {
    payload.detail =
      detailOverride ||
      (tiktokReconnectAttempt > 0
        ? `กำลังลองเชื่อมต่อใหม่ครั้งที่ ${tiktokReconnectAttempt} (ตรวจสอบว่า live อยู่และ username ถูกต้อง)`
        : undefined);
  }
  return payload;
}

// YouTube live chat is optional: off unless one of these is set in .env (see
// youtube-chat.js). Its connection state is tracked apart from TikTok's so
// one platform dropping doesn't mark the other offline.
const YOUTUBE_CHANNEL = (process.env.YOUTUBE_CHANNEL || '').trim();
const YOUTUBE_VIDEO_ID = (process.env.YOUTUBE_VIDEO_ID || '').trim();
const YOUTUBE_ENABLED = Boolean(YOUTUBE_CHANNEL || YOUTUBE_VIDEO_ID);
// MOCK_CHAT fakes YouTube chat too (see the mock block below), so the panel
// shows a "connected" YouTube badge for it instead of a real connection.
const YOUTUBE_MOCKED = MOCK_MODE && process.env.MOCK_CHAT === '1' && !YOUTUBE_ENABLED;
let youtubeState = YOUTUBE_MOCKED
  ? { connected: true, detail: 'MOCK: แชท YouTube ปลอม' }
  : { connected: false, detail: 'กำลังเชื่อมต่อ YouTube…' };

function youtubeConnectionPayload() {
  return { type: 'youtube-connection-state', enabled: YOUTUBE_ENABLED || YOUTUBE_MOCKED, ...youtubeState };
}

// Proxies Google Translate's TTS endpoint so the chat widget can fetch audio
// same-origin (Chrome's ORB blocks the browser hitting translate.google.com
// directly). No API key needed. Kept as a fallback alongside the local
// engine; pick between them via ttsProvider.
function proxyGoogleTts(text, res) {
  const ttsUrl =
    'https://translate.google.com/translate_tts?ie=UTF-8&tl=th&client=tw-ob&q=' +
    encodeURIComponent(text.slice(0, 200));

  const req = https
    .get(
      ttsUrl,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          Referer: 'https://translate.google.com/',
        },
      },
      (googleRes) => {
        if (googleRes.statusCode !== 200) {
          res.writeHead(502);
          res.end('TTS upstream error');
          googleRes.resume();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
        googleRes.pipe(res);
      }
    )
    .on('error', (err) => {
      console.error('Google TTS proxy error:', err.message);
      if (!res.headersSent) res.writeHead(502);
      res.end('TTS proxy failed');
    });

  // Without this, an upstream that accepts the connection but never sends a
  // response (or stalls mid-stream) leaves the client's <audio> element
  // waiting forever with no error/ended event -- the chat widget's TTS
  // queue then never advances and stays silent until the server restarts.
  req.setTimeout(15000, () => {
    req.destroy(new Error('TTS upstream timed out'));
  });
}

// Proxies the local TTS engine so the chat widget can fetch audio same-origin
// via a plain GET (the engine itself only accepts POST + a JSON body, which
// a browser <audio>/new Audio(url) element can't send).
function proxyLocalTts(text, lang, res) {
  const requestBody = JSON.stringify({ text, lang });
  const target = new URL(TTS_ENGINE_URL);

  const ttsReq = http.request(
    {
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(requestBody),
      },
    },
    (ttsRes) => {
      if (ttsRes.statusCode !== 200) {
        res.writeHead(502);
        res.end('TTS upstream error');
        ttsRes.resume();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'audio/wav' });
      ttsRes.pipe(res);
    }
  );

  ttsReq.on('error', (err) => {
    console.error('TTS proxy error (is tts-engine-project running?):', err.message);
    if (!res.headersSent) res.writeHead(502);
    res.end('TTS proxy failed');
  });

  // Same stall-protection as proxyGoogleTts above -- a hung local engine
  // would otherwise leave the client's TTS queue stuck silent forever.
  ttsReq.setTimeout(15000, () => {
    ttsReq.destroy(new Error('TTS engine timed out'));
  });

  ttsReq.write(requestBody);
  ttsReq.end();
}

// EasyDonate host isn't documented anywhere public -- overridable via env in
// case it turns out to differ once a real API key is available to test against.
const EASYDONATE_API_BASE_URL = process.env.EASYDONATE_API_BASE_URL || 'https://api.easydonate.app';

const MOCK_LEADERBOARD = [
  { name: 'น้องโปรยปลา', amount: 5428.15 },
  { name: 'sleeping', amount: 2040 },
  { name: 'kai_gamer', amount: 1580.5 },
  { name: 'pim.streamfan', amount: 990 },
  { name: 'tanawat_th', amount: 720 },
  { name: 'user_888', amount: 500 },
  { name: 'nampeung_99', amount: 350 },
  { name: 'boss_888', amount: 220 },
  { name: 'malee_cat', amount: 150 },
  { name: 'lek_fc', amount: 100 },
];

// Real donors who aren't tracked by the EasyDonate API but should still show
// up at the right rank -- kept in a gitignored file (not the repo) since it's
// this streamer's own donor data, not something to ship in source control.
const EXTRA_DONORS_FILE = process.env.EXTRA_DONORS_FILE || path.join(__dirname, 'extra-donors.json');

// Spellings of one donor's name that should count as a single entry, e.g.
// { "Chi": "ชิ" } folds "Chi" into "ชิ". Matched case-insensitively. Gitignored
// for the same reason as extra-donors.json.
const DONOR_ALIASES_FILE = process.env.DONOR_ALIASES_FILE || path.join(__dirname, 'donor-aliases.json');

function loadDonorAliases() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DONOR_ALIASES_FILE, 'utf8'));
    const aliases = new Map();
    for (const [alias, name] of Object.entries(parsed || {})) {
      aliases.set(alias.trim().toLowerCase(), name);
    }
    return aliases;
  } catch {
    return new Map();
  }
}

function withExtraEntry(list) {
  const aliases = loadDonorAliases();
  const merged = new Map();
  for (const entry of [...list, ...readJsonArray(EXTRA_DONORS_FILE)]) {
    const name = aliases.get(String(entry.name).trim().toLowerCase()) || String(entry.name).trim();
    // Case-insensitive key so "skyfall" and "Skyfall" sum into one entry,
    // shown with whichever spelling came first (the higher API amount).
    const key = name.toLowerCase();
    const existing = merged.get(key);
    if (existing) {
      existing.amount += Number(entry.amount) || 0;
    } else {
      merged.set(key, { name, amount: Number(entry.amount) || 0 });
    }
  }
  return [...merged.values()].sort((a, b) => b.amount - a.amount);
}

// A JSON array from a hand-edited file, or [] if it's missing or broken.
function readJsonArray(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// GET a URL and parse the JSON body; rejects on a non-200 status, a network
// error, or no response within 10s (a stalled API shouldn't hang the request).
function getJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: 10000 }, (apiRes) => {
      let body = '';
      apiRes.on('data', (chunk) => (body += chunk));
      apiRes.on('end', () => {
        if (apiRes.statusCode !== 200) {
          reject(new Error(`${new URL(url).host} returned ${apiRes.statusCode}: ${body.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error(`${new URL(url).host} parse error: ${err.message}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${new URL(url).host} timed out`)));
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// In-memory only, by design (see CONTEXT.md non-goals) -- resets on server
// restart, no file/db persistence. gifters is keyed by the viewer's @handle so a repeat
// donor's diamonds accumulate onto the same entry instead of splitting.
const stats = {
  comments: 0,
  gifts: 0,
  giftDiamonds: 0,
  viewers: new Set(),
  gifters: new Map(),
};

// Called from emitLiveEvent() so every chat/gift/member path -- mock and real
// alike -- updates the same counters without each call site remembering to.
function trackStats(message) {
  if (message.type === 'chat' || message.type === 'emote') {
    stats.comments++;
    if (message.user) stats.viewers.add(message.user);
  } else if (message.type === 'gift') {
    stats.gifts += message.repeatCount || 1;
    stats.giftDiamonds += message.diamondCount || 0;
    if (message.user) {
      const gifter = stats.gifters.get(message.user) || { nickname: message.nickname, diamonds: 0 };
      gifter.nickname = message.nickname;
      gifter.diamonds += message.diamondCount || 0;
      stats.gifters.set(message.user, gifter);
    }
  } else if (message.type === 'member') {
    if (message.user) stats.viewers.add(message.user);
  }
}

function buildSummaryPayload() {
  const topGifter = [...stats.gifters.values()].sort((a, b) => b.diamonds - a.diamonds)[0] || null;
  return {
    type: 'summary',
    comments: stats.comments,
    gifts: stats.gifts,
    giftDiamonds: stats.giftDiamonds,
    viewers: stats.viewers.size,
    topGifter,
  };
}

// ---------------------------------------------------------------------------
// Profanity filter: a matching Comment is dropped entirely -- not shown on the
// chat overlay, not read by TTS. Targets "ควย" and its dodge spellings
// (ขวย, ข็วย, ฆวย, ฆวษ์ย, ค ว ย, ค.ว.ย, ควววย ...) and "หี" with its
// dodges (หิ๋, หี่, แหย่หิ ...).
// ---------------------------------------------------------------------------

// Spaces, zero-width chars and punctuation people wedge between letters.
const PROFANITY_SEPARATORS = /[\s​-‍﻿.,\-_*~!?'"`|/\\+=:;()[\]{}<>^]+/g;
// [คขฆฅ] + ว + optional silent letter (ษ์, ส์ ...) + ย, with stray tone
// marks / ็ / ์ allowed around ว (ข็วย, ค่วย, คว์ย);
// or หี / หิ + tone mark (หิ๋) not followed by a consonant (keeps หีบ, หิ้ว);
// or แหย่ + หิ/หี in any form;
// or เงี่ยน with a silent ห / swapped tone (เหงี้ยน) -- tone mark required so
// the name เหงียน (Nguyen) still passes;
// or น้ำแตก and its misspellings (น้ามแตค);
// or ควย with ย swapped for a silent letter (ซวษ์, ขวษ์) -- plain ซวย stays allowed;
// or อม + ควย/ซวย;
// or หี spelled with a wedged silent letter (ฮฐ์ี, อฐ์ี, หฐ์ี), or with the
// vowel dropped (หด์);
// or ตูด spelled with ฏ (ตูฏ, ฏูด), or เลีย/เรีย + ตูด;
// or จับนม, or นม with a stray ์ (นม์).
const PROFANITY_PATTERN =
  /[คขฆฅ][็่-๋]*ว[็่-์]*(?:[ก-ฮ]์)?ย|ห(?:ี[่-๋]?|ิ[่-๋])(?![ก-ฮ])|แหย่ห[ิี]|เห?งี[่-๋]ยน|น้[ำา]ม?แต[กค]|[คขฆฅซ][็่-๋]*ว[็่-๋]*[ก-ฮ]์|อม[คขฆฅซ][็่-๋]*ว[็่-๋]*ย|[หฮอ][ก-ฮ]์[ิี]|ห[ก-ฮ]์|ฏู[ดฏ]|[ตฏ]ูฏ|เ[ลร]ีย[ตฏ]ู[ดฏ]|จับนม|นม์/;
// Real words that contain the pattern and must not be blocked.
const PROFANITY_ALLOWED = /ขวยเขิน|เขินขวย/g;
// Gujarati letters look like Thai (ખૂઐ ~ ขวย, યેત્ ~ เย็ด) and get used to
// spell profanity past the Thai patterns; no real viewer chats in Gujarati.
const PROFANITY_LOOKALIKE_SCRIPT = /[઀-૿]/;

function isProfaneComment(text) {
  if (PROFANITY_LOOKALIKE_SCRIPT.test(String(text || ''))) return true;
  const normalized = String(text || '')
    .replace(PROFANITY_SEPARATORS, '')
    .replace(/(.)\1+/g, '$1')
    .replace(PROFANITY_ALLOWED, '');
  return PROFANITY_PATTERN.test(normalized);
}


// ---------------------------------------------------------------------------
// Song requests (see docs/adr/0001-youtube-link-only-song-requests.md)
//
// A Song request is a YouTube link, never a title we search for -- search.list
// costs 100 quota units against a 10,000/day budget, which would silence the
// feature after ~100 requests mid-stream. videos.list costs 1, so link-only is
// effectively unmetered. The API key is required rather than optional: without
// it the feature is off, instead of running blind.
// ---------------------------------------------------------------------------
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';
const YOUTUBE_REGION = process.env.YOUTUBE_REGION || 'TH';
const SONG_MAX_DURATION_SEC = Number(process.env.SONG_MAX_DURATION_SEC || 600);
// Overridable so the test harness can point at a scratch file -- otherwise
// running the tests would overwrite the streamer's real curated Filler songs.
const FILLER_SONGS_FILE = process.env.FILLER_SONGS_FILE || path.join(__dirname, 'filler-songs.json');

// How many just-played videos stay un-requestable, so the same track cannot
// bounce straight back into the queue the moment it ends.
const RECENT_VIDEO_MEMORY = 20;

const YOUTUBE_LINK_PATTERNS = [
  /youtube\.com\/watch\?(?:[^\s]*&)?v=([A-Za-z0-9_-]{11})/i,
  /youtu\.be\/([A-Za-z0-9_-]{11})/i,
  /youtube\.com\/shorts\/([A-Za-z0-9_-]{11})/i,
  /youtube\.com\/live\/([A-Za-z0-9_-]{11})/i,
  /youtube\.com\/embed\/([A-Za-z0-9_-]{11})/i,
];

// A request has to be opted into with the command word. Without it every
// link anyone happens to paste in chat -- a clip they are talking about, a
// reply to someone else -- lands in the streamer's approval queue as noise.
const SONG_COMMAND = /^\s*\/music(?:\s|$)/i;

function extractVideoId(text) {
  for (const pattern of YOUTUBE_LINK_PATTERNS) {
    const match = pattern.exec(text);
    if (match) return match[1];
  }
  return null;
}

// ISO 8601 durations, which is the only format the API reports ("PT4M13S").
// The whole time section is optional: an in-progress live stream reports "P0D",
// which has to parse as 0 so it is refused as a live stream rather than as an
// unreadable duration.
function parseIsoDuration(iso) {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso || '');
  if (!match) return null;
  const [, d, h, m, sec] = match.map((v) => (v === undefined ? 0 : Number(v)));
  return d * 86400 + h * 3600 + m * 60 + sec;
}

// The three things only videos.list can tell us -- embeddable, length and
// region -- all fail *silently* on stream if unchecked: the player just shows a
// black rectangle mid-live with nothing explaining why. Checking here means a
// bad link is refused at request time instead of surfacing 40 minutes later.
function fetchVideoDetails(videoId) {
  return getJson(
    'https://www.googleapis.com/youtube/v3/videos' +
      `?part=snippet,contentDetails,status&id=${encodeURIComponent(videoId)}` +
      `&key=${encodeURIComponent(YOUTUBE_API_KEY)}`,
  );
}

// Returns { ok: true, song } or { ok: false, reason }. The reason is for the
// server log and the panel only -- a refusal is never sent back to the asker,
// since the room chat is read-only to us (see CONTEXT.md).
async function validateVideo(videoId) {
  const payload = await fetchVideoDetails(videoId);
  const item = payload.items && payload.items[0];
  if (!item) return { ok: false, reason: 'ไม่พบวิดีโอ (ถูกลบหรือเป็นส่วนตัว)' };

  if (item.status && item.status.embeddable === false) {
    return { ok: false, reason: 'เจ้าของปิดการฝัง (embed) ไว้' };
  }

  const durationSec = parseIsoDuration(item.contentDetails && item.contentDetails.duration);
  if (durationSec === null) return { ok: false, reason: 'อ่านความยาวไม่ได้' };
  if (durationSec === 0) return { ok: false, reason: 'เป็นไลฟ์สด ไม่ใช่คลิป' };
  if (durationSec > SONG_MAX_DURATION_SEC) {
    return { ok: false, reason: `ยาวเกิน ${Math.round(SONG_MAX_DURATION_SEC / 60)} นาที` };
  }

  const restriction = (item.contentDetails && item.contentDetails.regionRestriction) || {};
  const blockedHere = restriction.blocked && restriction.blocked.includes(YOUTUBE_REGION);
  const notAllowedHere = restriction.allowed && !restriction.allowed.includes(YOUTUBE_REGION);
  if (blockedHere || notAllowedHere) {
    return { ok: false, reason: `เล่นไม่ได้ในภูมิภาค ${YOUTUBE_REGION}` };
  }

  return {
    ok: true,
    song: {
      videoId,
      title: (item.snippet && item.snippet.title) || videoId,
      channel: (item.snippet && item.snippet.channelTitle) || '',
      durationSec,
    },
  };
}

// Filler songs are the one piece of song state written to disk. A viewer
// request is worth minutes and is trivially re-made; a Filler song is something
// the streamer curated and would resent rebuilding every stream.
let fillerSongs = readJsonArray(FILLER_SONGS_FILE);

function saveFillerSongs() {
  fs.writeFile(FILLER_SONGS_FILE, JSON.stringify(fillerSongs, null, 2), (err) => {
    if (err) console.error('Failed to save filler-songs.json:', err.message);
  });
}

// In-memory, deliberately: an approval given three hours ago was given in a
// moment that no longer exists, so a restart drops the queue rather than
// resuming it. Only fillerSongs above survives.
const songState = {
  enabled: false,
  pending: [], // awaiting the streamer's approval
  approved: [], // approved, waiting their turn
  nowPlaying: null,
  recentVideoIds: [],
};

let songSeq = 0;
function nextSongId() {
  songSeq += 1;
  return `s${Date.now().toString(36)}-${songSeq}`;
}

function songStatePayload() {
  return {
    type: 'song-state',
    enabled: songState.enabled,
    hasApiKey: Boolean(YOUTUBE_API_KEY),
    pending: songState.pending,
    approved: songState.approved,
    nowPlaying: songState.nowPlaying,
    fillers: fillerSongs,
  };
}

function isVideoTaken(videoId) {
  return (
    songState.pending.some((s) => s.videoId === videoId) ||
    songState.approved.some((s) => s.videoId === videoId) ||
    (songState.nowPlaying && songState.nowPlaying.videoId === videoId) ||
    songState.recentVideoIds.includes(videoId)
  );
}

// Round-robin over the fillers so a long dry spell does not replay the same one.
let fillerCursor = 0;
function nextFillerSong() {
  if (fillerSongs.length === 0) return null;
  const filler = fillerSongs[fillerCursor % fillerSongs.length];
  fillerCursor += 1;
  return { ...filler, id: nextSongId(), isFiller: true, nickname: null };
}

// An approved viewer request always wins over a Filler song; playing a viewer
// request consumes it, playing a Filler song does not.
function advanceSong() {
  const next = songState.approved.shift() || nextFillerSong();
  songState.nowPlaying = next || null;
  if (next) {
    songState.recentVideoIds.push(next.videoId);
    while (songState.recentVideoIds.length > RECENT_VIDEO_MEMORY) {
      songState.recentVideoIds.shift();
    }
  }
  broadcast(songStatePayload());
}

// Called from the CHAT handler for every Comment. Everything here is silent to
// the asker by design -- the per-viewer cap is a server-side filter that keeps
// the panel queue usable, not a rule viewers are told about.
async function handleSongRequestComment(user, nickname, comment) {
  if (!songState.enabled || !YOUTUBE_API_KEY) return;

  const text = comment || '';
  if (!SONG_COMMAND.test(text)) return;

  const videoId = extractVideoId(text);
  if (!videoId) return;

  if (songState.pending.some((s) => s.user === user)) {
    console.log(`[song] dropped ${nickname}: already has one pending`);
    return;
  }
  if (isVideoTaken(videoId)) {
    console.log(`[song] dropped ${nickname}: ${videoId} already queued or just played`);
    return;
  }

  try {
    const result = await validateVideo(videoId);
    if (!result.ok) {
      console.log(`[song] refused ${nickname} (${videoId}): ${result.reason}`);
      return;
    }
    // Re-checked after the await: the lookup took a network round-trip, and
    // another Comment from the same viewer (or for the same video) may have
    // landed in the meantime.
    if (songState.pending.some((s) => s.user === user) || isVideoTaken(videoId)) return;

    songState.pending.push({
      ...result.song,
      id: nextSongId(),
      user,
      nickname,
      isFiller: false,
      requestedAt: Date.now(),
    });
    console.log(`[song] queued "${result.song.title}" from ${nickname}`);
    broadcast(songStatePayload());
  } catch (err) {
    console.error(`[song] lookup failed for ${videoId}:`, err.message);
  }
}

// The streamer's own requests take the same path through validateVideo as a
// viewer's -- same checks, same refusals -- and differ only in where they land.
async function addFillerSong(link) {
  const videoId = extractVideoId(link || '');
  if (!videoId) return { ok: false, reason: 'ไม่พบลิงก์ YouTube ในข้อความ' };
  if (fillerSongs.some((f) => f.videoId === videoId)) {
    return { ok: false, reason: 'เพลงนี้อยู่ใน Filler แล้ว' };
  }
  const result = await validateVideo(videoId);
  if (!result.ok) return result;

  fillerSongs.push({ ...result.song, id: nextSongId() });
  saveFillerSongs();
  broadcast(songStatePayload());
  return { ok: true };
}

// Proxied (not called directly from the browser) so the EasyDonate API key
// never ships to the client. Falls back to mock data when no key is
// configured, so the /top-donate widget works out of the box.
// EasyDonate's leaderboard widget endpoint only returns as many donors as the
// widget's dashboard "count" setting (5 by default) and keys them by exact
// name, so "Skyfall" and "skyfall" split and anyone past rank 5 is lost.
// Building the board from the full donation history instead gives every donor,
// which withExtraEntry then merges by name/alias.
const DONATIONS_PAGE_SIZE = 100;

async function fetchDonationTotals() {
  const donations = [];
  for (let page = 1, totalPage = 1; page <= totalPage; page++) {
    const { data } = await getJson(
      `${EASYDONATE_API_BASE_URL}/api/v1/donations?size=${DONATIONS_PAGE_SIZE}&page=${page}`,
      { Authorization: `Bearer ${EASYDONATE_API_KEY}` },
    );
    totalPage = data?.totalPage || 1;
    donations.push(...(data?.histories || []));
  }
  return donations
    .filter((donation) => donation.status === 'SUCCESS')
    .map((donation) => ({ name: donation.donatorName || 'ไม่ระบุชื่อ', amount: Number(donation.amount) || 0 }));
}

// Every open /top-donate source polls every 15s and each poll pages through
// the whole donation history, so they share one fetch for a short while
// instead of each walking EasyDonate on its own.
const DONATIONS_CACHE_MS = 15000;
let donationsCache = { at: 0, promise: null };

function cachedDonationTotals() {
  if (!donationsCache.promise || Date.now() - donationsCache.at > DONATIONS_CACHE_MS) {
    const promise = fetchDonationTotals();
    donationsCache = { at: Date.now(), promise };
    promise.catch(() => {
      if (donationsCache.promise === promise) donationsCache = { at: 0, promise: null }; // retry next poll
    });
  }
  return donationsCache.promise;
}

async function handleLeaderboard(req, res) {
  if (!EASYDONATE_API_KEY) {
    sendJson(res, 200, { leaderboard: withExtraEntry(MOCK_LEADERBOARD), mock: true });
    return;
  }

  try {
    const leaderboard = withExtraEntry(await cachedDonationTotals());
    sendJson(res, 200, { leaderboard, mock: false });
  } catch (err) {
    console.error('EasyDonate leaderboard error:', err.message);
    sendJson(res, 502, { error: 'EasyDonate request failed' });
  }
}

// Individual donations, newest first, for /walkers: a live `donation` event
// for each new one and today's list for a freshly opened overlay. EasyDonate
// has no push, so the server polls the first page of the history -- a few
// rows every 10s, cheap next to /top-donate walking the whole thing.
const DONATION_POLL_MS = 10000;
const seenDonationIds = new Set();
let donationPollSeeded = false;

const toDonation = (d) => ({
  id: d.id,
  name: d.donatorName || 'ไม่ระบุชื่อ',
  amount: Number(d.amount) || 0,
  message: d.donateMessage || '',
  t: Date.parse(d.createdAt) || Date.now(),
});

async function pollDonations() {
  try {
    const { data } = await getJson(`${EASYDONATE_API_BASE_URL}/api/v1/donations?size=20&page=1`, {
      Authorization: `Bearer ${EASYDONATE_API_KEY}`,
    });
    // Oldest first, so two arriving together come out in order.
    for (const d of (data?.histories || []).slice().reverse()) {
      // Only SUCCESS counts as seen: a pending one gets announced once it clears.
      if (d.status !== 'SUCCESS' || seenDonationIds.has(d.id)) continue;
      seenDonationIds.add(d.id);
      // The first poll only learns what's already there -- no replaying old ones.
      if (donationPollSeeded) {
        const donation = toDonation(d);
        console.log(`[donation] ${donation.name} ${donation.amount} THB`);
        broadcast({ type: 'donation', ...donation });
      }
    }
    donationPollSeeded = true;
  } catch (err) {
    console.error('[donation] poll failed:', err.message);
  }
}

if (EASYDONATE_API_KEY && !MOCK_MODE) {
  pollDonations();
  setInterval(pollDonations, DONATION_POLL_MS);
}

// GET /api/donations-today -- SUCCESS donations since local midnight. Pages
// back only until it passes midnight, since the history is newest first.
async function handleDonationsToday(res) {
  if (!EASYDONATE_API_KEY || MOCK_MODE) {
    sendJson(res, 200, { donations: [], mock: true });
    return;
  }
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  try {
    const donations = [];
    for (let page = 1, totalPage = 1; page <= totalPage; page++) {
      const { data } = await getJson(`${EASYDONATE_API_BASE_URL}/api/v1/donations?size=${DONATIONS_PAGE_SIZE}&page=${page}`, {
        Authorization: `Bearer ${EASYDONATE_API_KEY}`,
      });
      totalPage = data?.totalPage || 1;
      const rows = data?.histories || [];
      for (const d of rows) {
        const donation = toDonation(d);
        if (d.status === 'SUCCESS' && donation.t >= midnight.getTime()) donations.push(donation);
      }
      if (!rows.length || toDonation(rows[rows.length - 1]).t < midnight.getTime()) break;
    }
    sendJson(res, 200, { donations, mock: false });
  } catch (err) {
    console.error('[donation] today list failed:', err.message);
    sendJson(res, 502, { error: 'EasyDonate request failed' });
  }
}

// YouTube Music now-playing, pushed by the ytmusic.user.js userscript running
// in the streamer's music.youtube.com tab (POST /api/ytmusic) and relayed to
// the /ytmusic widget. In-memory only; the tab re-sends every few seconds, so
// there's nothing worth keeping across a restart.
// Long on purpose: Chrome throttles a background tab's timers to about once a
// minute, so a paused, hidden YT Music tab may only check in that often. A
// tab that's actually closed says so itself ({ closed: true }), so this only
// matters for one that crashed.
const YTMUSIC_STALE_MS = 120000;
const YTMUSIC_MAX_BODY = 64 * 1024;
const YTMUSIC_MAX_QUEUE = 20;
let ytMusicState = { active: false, track: null, paused: true, positionSec: 0, durationSec: 0, queue: [], receivedAt: 0 };

function ytMusicStatePayload() {
  return { type: 'ytmusic-state', ...ytMusicState };
}

// The userscript is ours, but the endpoint is open to anything on the
// machine, so only known fields of the expected shape get through.
function cleanYtMusicString(value, max = 300) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function cleanYtMusicNumber(value) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function handleYtMusicUpdate(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end('Method not allowed');
    return;
  }
  let body = '';
  let tooLarge = false;
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > YTMUSIC_MAX_BODY) {
      tooLarge = true;
      req.destroy();
    }
  });
  req.on('end', () => {
    if (tooLarge) return;
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end('Invalid JSON');
      return;
    }
    if (!data || typeof data !== 'object') {
      res.writeHead(400);
      res.end('Expected a JSON object');
      return;
    }
    if (data.closed === true) {
      ytMusicState = { ...ytMusicState, active: false };
      broadcast(ytMusicStatePayload());
      res.writeHead(204);
      res.end();
      return;
    }
    const track = data.track && typeof data.track === 'object' && data.track.title
      ? {
          title: cleanYtMusicString(data.track.title),
          artist: cleanYtMusicString(data.track.artist),
          album: cleanYtMusicString(data.track.album),
          artwork: cleanYtMusicString(data.track.artwork, 1000),
        }
      : null;
    const queue = Array.isArray(data.queue)
      ? data.queue.slice(0, YTMUSIC_MAX_QUEUE).filter((item) => item && item.title).map((item) => ({
          title: cleanYtMusicString(item.title),
          artist: cleanYtMusicString(item.artist),
          duration: cleanYtMusicString(item.duration, 20),
          artwork: cleanYtMusicString(item.artwork, 1000),
        }))
      : [];
    ytMusicState = {
      active: true,
      track,
      paused: Boolean(data.paused),
      positionSec: cleanYtMusicNumber(data.positionSec),
      durationSec: cleanYtMusicNumber(data.durationSec),
      queue,
      // Stamped here rather than trusting the tab's clock; widgets extrapolate
      // the progress bar from it between updates.
      receivedAt: Date.now(),
    };
    broadcast(ytMusicStatePayload());
    res.writeHead(204);
    res.end();
  });
}

// The tab can't announce its own closing reliably, so silence is the signal.
setInterval(() => {
  if (ytMusicState.active && Date.now() - ytMusicState.receivedAt > YTMUSIC_STALE_MS) {
    ytMusicState = { ...ytMusicState, active: false };
    broadcast(ytMusicStatePayload());
  }
}, 5000);

// Each widget lives at its own path so it can be added as a separate Browser
// Source in OBS/Streamlabs and positioned independently.
const PAGE_ROUTES = {
  '/': 'index.html',
  '/chat': 'widgets/chat/chat.html',
  '/pinned': 'widgets/pinned/pinned.html',
  '/panel': 'widgets/panel/panel.html',
  '/top-donate': 'widgets/top-donate/top-donate.html',
  '/summary': 'widgets/summary/summary.html',
  '/gifts': 'widgets/gifts/gifts.html',
  '/timer': 'widgets/timer/timer.html',
  '/music': 'widgets/music/music.html',
  '/follow': 'widgets/follow/follow.html',
  '/ytmusic': 'widgets/ytmusic/ytmusic.html',
  '/walkers': 'widgets/walkers/walkers.html',
};

// Widget files (html/css/js under widgets/) and the bundled fonts, served
// locally so overlays work offline and Thai renders without system fonts.
const STATIC_ROOTS = {
  '/widgets/': path.join(__dirname, 'widgets'),
  '/fonts/': path.join(__dirname, 'fonts'),
};
const CONFETTI_FILE = path.join(__dirname, 'node_modules', 'canvas-confetti', 'dist', 'confetti.browser.js');

const CONTENT_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.png': 'image/png', // /walkers sprite sheets
};

function serveFile(res, filePath) {
  const contentType = CONTENT_TYPES[path.extname(filePath)];
  if (!contentType) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

const httpServer = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, `http://localhost:${HTTP_PORT}`);

  if (reqUrl.pathname === '/api/gift-events') {
    handleGiftEvents(reqUrl, res);
    return;
  }

  if (reqUrl.pathname === '/api/donations-today') {
    handleDonationsToday(res);
    return;
  }

  if (reqUrl.pathname === '/api/leaderboard') {
    handleLeaderboard(req, res);
    return;
  }

  if (reqUrl.pathname === '/api/ytmusic') {
    handleYtMusicUpdate(req, res);
    return;
  }

  // Served at a top-level *.user.js URL so opening it in a browser with
  // Tampermonkey brings up the install prompt; the port is patched in so the
  // installed script talks to this server even when HTTP_PORT isn't 8080.
  if (reqUrl.pathname === '/ytmusic.user.js') {
    fs.readFile(path.join(__dirname, 'widgets', 'ytmusic', 'ytmusic.user.js'), 'utf8', (err, source) => {
      if (err) {
        res.writeHead(500);
        res.end('Failed to load userscript');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(source.replace('"http://localhost:8080"', JSON.stringify(`http://localhost:${HTTP_PORT}`)));
    });
    return;
  }

  if (reqUrl.pathname === '/tts') {
    const text = reqUrl.searchParams.get('text') || '';
    if (!text) {
      res.writeHead(400);
      res.end('Missing text param');
      return;
    }
    if (ttsProvider === 'google') {
      proxyGoogleTts(text, res);
    } else {
      proxyLocalTts(text, 'th', res);
    }
    return;
  }

  if (reqUrl.pathname === '/vendor/confetti.js') {
    serveFile(res, CONFETTI_FILE);
    return;
  }

  for (const [prefix, root] of Object.entries(STATIC_ROOTS)) {
    if (!reqUrl.pathname.startsWith(prefix)) continue;
    // path.join collapses ".." segments; anything that still lands outside
    // the root (e.g. /widgets/../server.js) is refused.
    const filePath = path.join(root, decodeURIComponent(reqUrl.pathname.slice(prefix.length)));
    if (!filePath.startsWith(root + path.sep)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    serveFile(res, filePath);
    return;
  }

  const page = PAGE_ROUTES[reqUrl.pathname];
  if (page) {
    serveFile(res, path.join(__dirname, page));
    return;
  }
  res.writeHead(404);
  res.end('Not found');
});
httpServer.listen(HTTP_PORT, () => {
  console.log(`Overlay page: http://localhost:${HTTP_PORT}`);
});

// Broadcast chat events to any connected overlay pages
const wss = new WebSocketServer({ port: WS_PORT });
console.log(`WebSocket server listening on ws://localhost:${WS_PORT}`);

// Gift history: every Gift appended to logs/gifts-YYYY-MM-DD.jsonl (local
// date), unlike the in-memory session `stats`, so /gifts can show today /
// yesterday / 7 / 30 days and survives a server restart. One file per day
// keeps a range read to the handful of files it actually covers. MOCK=1 uses
// its own folder (seeded by `npm run seed:gifts`) so fake Gifts never mix
// into the real history.
const GIFT_LOG_DIR = path.join(__dirname, 'logs', MOCK_MODE ? 'mock-gifts' : '');
fs.mkdirSync(GIFT_LOG_DIR, { recursive: true });

const DAY_MS = 24 * 60 * 60 * 1000;

// Local date, not UTC, so one evening's stream lands in one file.
function localDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function giftLogFile(date) {
  return path.join(GIFT_LOG_DIR, `gifts-${localDateKey(date)}.jsonl`);
}

function recordGift(message) {
  const now = new Date();
  const entry = {
    t: now.getTime(),
    roomId: currentRoomId,
    userId: message.userId || '',
    user: message.user,
    nickname: message.nickname,
    avatarUrl: message.avatarUrl || '',
    giftName: message.giftName,
    giftImage: message.giftImage || '',
    repeatCount: message.repeatCount || 1,
    diamondCount: message.diamondCount || 0,
  };
  fs.appendFile(giftLogFile(now), JSON.stringify(entry) + '\n', (err) => {
    if (err) console.error('[gift-log] write failed:', err.message);
  });
}

// One day's gifts; a missing file just means no gifts that day, and a
// half-written last line (a crash mid-append) is skipped.
async function readGiftDay(date) {
  let text;
  try {
    text = await fs.promises.readFile(giftLogFile(date), 'utf8');
  } catch {
    return [];
  }
  const events = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // skip it
    }
  }
  return events;
}

// GET /api/gift-events?from=<ms>&to=<ms> -- raw events in [from, to); the
// page does the aggregating (per hour/day, per gift type, per gifter).
// Capped at 31 days so a bad query can't read the whole folder.
async function handleGiftEvents(reqUrl, res) {
  const to = Number(reqUrl.searchParams.get('to')) || Date.now();
  const from = Number(reqUrl.searchParams.get('from')) || to - DAY_MS;
  if (from >= to || to - from > 31 * DAY_MS) {
    sendJson(res, 400, { error: 'invalid range' });
    return;
  }
  const days = [];
  const day = new Date(from);
  day.setHours(0, 0, 0, 0);
  while (day.getTime() < to) {
    days.push(new Date(day));
    day.setDate(day.getDate() + 1);
  }
  const events = (await Promise.all(days.map(readGiftDay))).flat().filter((e) => e.t >= from && e.t < to);
  sendJson(res, 200, { events });
}

// Gift history backup: GIFT_BACKUP_DIR (e.g. a OneDrive / Google Drive
// folder that syncs itself) gets a copy of every gifts-*.jsonl, so the
// history survives a dead disk or a deleted logs/ folder. Copies on startup
// and hourly, and only files that changed since the last copy. Off when
// unset, and never in MOCK mode -- mock Gifts aren't worth keeping.
const GIFT_BACKUP_DIR = (process.env.GIFT_BACKUP_DIR || '').trim();
const GIFT_BACKUP_INTERVAL_MS = 60 * 60 * 1000;

async function backupGiftHistory() {
  try {
    await fs.promises.mkdir(GIFT_BACKUP_DIR, { recursive: true });
    const names = (await fs.promises.readdir(GIFT_LOG_DIR)).filter((n) => /^gifts-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n));
    let copied = 0;
    for (const name of names) {
      const src = path.join(GIFT_LOG_DIR, name);
      const dest = path.join(GIFT_BACKUP_DIR, name);
      const srcStat = await fs.promises.stat(src);
      const destStat = await fs.promises.stat(dest).catch(() => null);
      // The log is append-only, so a size match means nothing new to copy.
      if (destStat && destStat.size === srcStat.size) continue;
      await fs.promises.copyFile(src, dest);
      copied++;
    }
    if (copied) console.log(`[gift-backup] copied ${copied} file(s) to ${GIFT_BACKUP_DIR}`);
  } catch (err) {
    console.error('[gift-backup] failed:', err.message);
  }
}

if (GIFT_BACKUP_DIR && !MOCK_MODE) {
  backupGiftHistory();
  setInterval(backupGiftHistory, GIFT_BACKUP_INTERVAL_MS);
}

// Live log: one JSON object per line in logs/live-YYYY-MM-DD.jsonl, written
// for the whole session so a "my comment never showed up" report can be
// traced after the fact. Each comment can be followed through three stages:
//   tiktok-raw  -- what arrived on TikTok's websocket (before the connector
//                  decides what to do with it)
//   broadcast   -- what the server sent to overlays, with a `logId`
//   overlay     -- what an overlay page reports it actually rendered (same `logId`)
// A comment missing from tiktok-raw never reached us at all.
const LIVE_LOG_DIR = path.join(__dirname, 'logs');
let liveLogStream = null;
let liveLogDate = null;

function liveLog(stage, data) {
  const now = new Date();
  const date = localDateKey(now);
  try {
    if (date !== liveLogDate) {
      if (liveLogStream) liveLogStream.end();
      fs.mkdirSync(LIVE_LOG_DIR, { recursive: true });
      liveLogStream = fs.createWriteStream(path.join(LIVE_LOG_DIR, `live-${date}.jsonl`), { flags: 'a' });
      liveLogStream.on('error', (err) => console.error('[live-log] write failed:', err.message));
      liveLogDate = date;
    }
    liveLogStream.write(JSON.stringify({ t: now.toISOString(), stage, ...data }) + '\n');
  } catch (err) {
    console.error('[live-log] failed:', err.message);
  }
}

// Sends to every connected page; returns how many got it.
function broadcast(payload) {
  const message = JSON.stringify(payload);
  let delivered = 0;
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) {
      client.send(message);
      delivered++;
    }
  });
  return delivered;
}

// Only these get a logId and a live-log line -- the ones a "my comment never
// showed up" report is about. Joins and follows are too frequent to be worth it.
const LOGGED_EVENT_TYPES = new Set(['chat', 'emote', 'gift']);
let nextLogId = 1;

// Something a viewer did (chat, emote, gift, member join, follow), from TikTok,
// YouTube or mock alike. Counts it, records Gifts, then sends it out. State
// syncs (timer, songs, TTS settings) skip this and call broadcast() directly.
function emitLiveEvent(event) {
  trackStats(event);
  if (event.type === 'gift') recordGift(event);
  if (!LOGGED_EVENT_TYPES.has(event.type)) {
    broadcast(event);
    return;
  }
  const logged = { ...event, logId: nextLogId++ };
  const delivered = broadcast(logged);
  liveLog('broadcast', {
    logId: logged.logId,
    type: logged.type,
    user: logged.user,
    nickname: logged.nickname,
    comment: logged.comment,
    giftName: logged.giftName,
    emoteCount: logged.emoteImages?.length,
    clients: delivered,
  });
}

// In-memory only, same as `stats` -- resets on server restart. `endsAt` (not
// a countdown value) is the source of truth while running so every client
// computes its own remaining time from `endsAt - Date.now()` instead of the
// server pushing a tick every second.
const timerState = {
  status: 'idle', // idle | running | paused | ended
  durationMs: 5 * 60000,
  endsAt: null,
  remainingMs: null,
  message: 'พักเบรกสักครู่ เดี๋ยวกลับมา',
};

function timerStatePayload() {
  return { type: 'timer-state', ...timerState };
}

// Single authoritative running -> ended transition, checked here instead of
// leaving every open /timer browser source to independently decide it hit
// zero (they'd all fire around the same time but not necessarily agree).
setInterval(() => {
  if (timerState.status === 'running' && Date.now() >= timerState.endsAt) {
    timerState.status = 'ended';
    timerState.endsAt = null;
    broadcast(timerStatePayload());
  }
}, 250);

// Everything a page needs to show the current state, resent to each page as
// it connects -- otherwise reloading /timer mid-countdown (or opening /panel
// late) would show defaults until the next change.
const STATE_PAYLOADS = [
  timerStatePayload,
  () => ({ type: 'tts-provider-state', provider: ttsProvider }),
  () => ({ type: 'tts-enabled-state', enabled: ttsEnabled }),
  () => ({ type: 'tts-speed-state', speed: ttsSpeed }),
  () => ({ type: 'tts-read-chance-state', chance: ttsReadChance }),
  tiktokConnectionPayload,
  youtubeConnectionPayload,
  songStatePayload,
  ytMusicStatePayload,
];

// Pages send commands upstream: pin/unpin, show the summary, the BRB timer,
// song requests and fillers, TTS settings, and overlay-log reports.
let nextClientId = 1;

wss.on('connection', (ws) => {
  const clientId = nextClientId++;
  liveLog('ws-client', { clientId, event: 'connected', total: wss.clients.size });
  ws.on('close', () => liveLog('ws-client', { clientId, event: 'closed', total: wss.clients.size }));

  STATE_PAYLOADS.forEach((payload) => ws.send(JSON.stringify(payload())));

  ws.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.type === 'overlay-log') {
      // Reports from overlay pages (rendered / handler error / page hello);
      // logged only, never rebroadcast.
      const { type, ...report } = message;
      liveLog('overlay', { clientId, ...report });
    } else if (message.type === 'pin' || message.type === 'unpin') {
      broadcast(message);
    } else if (message.type === 'show-summary') {
      broadcast(buildSummaryPayload());
    } else if (message.type === 'timer-start') {
      timerState.durationMs = message.durationMs;
      timerState.endsAt = Date.now() + message.durationMs;
      timerState.remainingMs = null;
      timerState.status = 'running';
      broadcast(timerStatePayload());
    } else if (message.type === 'timer-pause') {
      if (timerState.status !== 'running') return;
      timerState.remainingMs = timerState.endsAt - Date.now();
      timerState.endsAt = null;
      timerState.status = 'paused';
      broadcast(timerStatePayload());
    } else if (message.type === 'timer-resume') {
      if (timerState.status !== 'paused') return;
      timerState.endsAt = Date.now() + timerState.remainingMs;
      timerState.remainingMs = null;
      timerState.status = 'running';
      broadcast(timerStatePayload());
    } else if (message.type === 'timer-reset') {
      timerState.status = 'idle';
      timerState.endsAt = null;
      timerState.remainingMs = null;
      broadcast(timerStatePayload());
    } else if (message.type === 'timer-set-message') {
      timerState.message = message.message;
      broadcast(timerStatePayload());
    } else if (message.type === 'set-song-enabled') {
      songState.enabled = !!message.enabled;
      // Turning the feature off clears what is waiting but leaves whatever is
      // playing alone -- cutting the audio mid-track would be the more
      // surprising behaviour of the two.
      if (!songState.enabled) {
        songState.pending = [];
        songState.approved = [];
      }
      broadcast(songStatePayload());
    } else if (message.type === 'song-approve') {
      const index = songState.pending.findIndex((s) => s.id === message.id);
      if (index === -1) return;
      const [song] = songState.pending.splice(index, 1);
      songState.approved.push(song);
      // Nothing playing means this one starts now rather than waiting for an
      // end-of-song event that will never arrive.
      if (!songState.nowPlaying) {
        advanceSong();
      } else {
        broadcast(songStatePayload());
      }
    } else if (message.type === 'song-reject') {
      // Covers both lists: the panel offers the same remove button on a song
      // waiting for approval and on one already approved but not yet played.
      const pendingIndex = songState.pending.findIndex((s) => s.id === message.id);
      if (pendingIndex !== -1) {
        songState.pending.splice(pendingIndex, 1);
      } else {
        const approvedIndex = songState.approved.findIndex((s) => s.id === message.id);
        if (approvedIndex === -1) return;
        songState.approved.splice(approvedIndex, 1);
      }
      broadcast(songStatePayload());
    } else if (message.type === 'song-start') {
      // Distinct from song-skip even though both land on advanceSong: nothing
      // ever starts playing on its own, so the first song of a session needs an
      // explicit start. Guarded on idle so a mis-click can't cut a live track.
      if (songState.nowPlaying) return;
      advanceSong();
    } else if (message.type === 'song-skip') {
      advanceSong();
    } else if (message.type === 'song-stop') {
      songState.nowPlaying = null;
      broadcast(songStatePayload());
    } else if (message.type === 'song-ended') {
      // Sent by the /music widget when the player reports ENDED. Guarded on the
      // id so a stale widget (one that reconnected after we already moved on)
      // cannot skip the song that is currently playing.
      if (!songState.nowPlaying || songState.nowPlaying.id !== message.id) return;
      advanceSong();
    } else if (message.type === 'song-error') {
      if (!songState.nowPlaying || songState.nowPlaying.id !== message.id) return;
      console.error(`[song] player error on ${songState.nowPlaying.videoId}, skipping`);
      advanceSong();
    } else if (message.type === 'filler-add') {
      addFillerSong(message.link).then((result) => {
        if (!result.ok) {
          ws.send(JSON.stringify({ type: 'filler-add-failed', reason: result.reason }));
        }
      });
    } else if (message.type === 'filler-remove') {
      const next = fillerSongs.filter((f) => f.id !== message.id);
      if (next.length === fillerSongs.length) return;
      fillerSongs = next;
      saveFillerSongs();
      broadcast(songStatePayload());
    } else if (message.type === 'set-tts-provider') {
      if (message.provider !== 'local' && message.provider !== 'google') return;
      ttsProvider = message.provider;
      broadcast({ type: 'tts-provider-state', provider: ttsProvider });
    } else if (message.type === 'set-tts-enabled') {
      ttsEnabled = !!message.enabled;
      broadcast({ type: 'tts-enabled-state', enabled: ttsEnabled });
    } else if (message.type === 'set-tts-speed') {
      const speed = Number(message.speed);
      if (!Number.isFinite(speed) || speed < 0.5 || speed > 3) return;
      ttsSpeed = speed;
      broadcast({ type: 'tts-speed-state', speed: ttsSpeed });
    } else if (message.type === 'set-tts-read-chance') {
      const chance = Number(message.chance);
      if (!Number.isFinite(chance) || chance < 0 || chance > 1) return;
      ttsReadChance = chance;
      broadcast({ type: 'tts-read-chance-state', chance: ttsReadChance });
    }
  });
});

// Every Comment, from either platform, goes through here so the profanity
// filter, chat overlay, TTS and song requests treat TikTok and YouTube alike.
function handleIncomingComment(message) {
  if (isProfaneComment(message.comment)) {
    liveLog('filtered', { reason: 'profanity', platform: message.platform, user: message.user, content: message.comment });
    console.log(`[filtered] ${message.nickname}: ${message.comment}`);
    return;
  }
  console.log(`${message.platform === 'youtube' ? '[yt] ' : ''}${message.nickname}: ${message.comment}`);
  // A Song request is a Comment first and stays one -- it is shown like any
  // other, and only *additionally* considered for the queue. The flag tells
  // the chat overlay not to read the link aloud.
  emitLiveEvent({ ...message, isSongRequest: SONG_COMMAND.test(message.comment || '') });
  handleSongRequestComment(message.user, message.nickname, message.comment);
}

if (YOUTUBE_ENABLED) {
  startYouTubeChat({
    channel: YOUTUBE_CHANNEL,
    videoId: YOUTUBE_VIDEO_ID,
    onMessage: handleIncomingComment,
    onState: (connected, detail) => {
      if (connected !== youtubeState.connected) console.log(`[yt] ${detail}`);
      youtubeState = { connected, detail };
      broadcast(youtubeConnectionPayload());
    },
    log: liveLog,
  });
}

if (MOCK_MODE) {
  console.log(`MOCK mode: generating fake follows${process.env.MOCK_CHAT === '1' ? ' and chat traffic' : ''} instead of connecting to TikTok.`);

  const mockUsers = [
    'nampeung_99', 'kai_gamer', 'pim.streamfan', 'tanawat_th', 'user_888', 'น้องแมว ม.4/3',
    // Emoji nicknames: plain, ZWJ sequence, flag, skin tone, variation selector.
    '🐱น้องแมว🐱', '👨‍👩‍👧 family', '🇹🇭 thai', '👍🏽ok', '❤️ใจ',
  ];
  const mockComments = [
    'สวัสดีค่า มาดูตั้งแต่ต้นเลย',
    '5555 ตลกมาก',
    'ไลฟ์วันนี้กี่โมงจบ',
    'เก่งมากกก',
    'ทำไมเสียงเบาจัง',
    'ขอลิงก์หน่อย',
    'อยู่มาดูตลอดเลยค่ะ',
    'พี่ครับ ฿.฿.฿.฿.฿.฿. ตุก จะจะ ตุก จี๊ ๆ ๆ ตุก จะ จะ ตุก จี๊ ๆ ๆ ตุก จะจะ ตุก จี๊ ๆ ๆ ตุก จะจะเตร',
    '5555555555',
    'สวัสดี สวัสดี สวัสดี',
    'ฮ่าๆๆๆๆๆๆๆๆๆๆๆๆๆๆ',
    'เก่งมาก เก่งมาก เก่งมาก เก่งมาก',
    'จัดไป จัดไป จัดไป จัดไป จัดไป',
    'เก่งมากกกกกกก',
    'เก เก  เก เก เก เก เก เก เก เก เก เก เก',
    'ดี ก ก ก   กก ก ก  ก     ก  ปแผ ๔๑+ ๔+๒ ๔๑๒๓๑+๒๑+๒๑+๔ +ูู๑๒ ฿',
    'เล่นเก',
  ];

  const randomItem = (list) => list[Math.floor(Math.random() * list.length)];
  const mockAvatar = (nickname) => `https://i.pravatar.cc/150?u=${encodeURIComponent(nickname)}`;
  const mockViewer = (nickname) => ({ platform: 'tiktok', user: nickname, nickname, avatarUrl: mockAvatar(nickname) });

  const mockGifts = [
    { name: 'Rose', diamonds: 1, image: 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/968820bc85e274713c795a6aef3f7c67~tplv-obj.png' },
    { name: 'Ice Cream Cone', diamonds: 1, image: '' },
    { name: 'Glow Stick', diamonds: 1, image: '' },
    { name: 'Finger Heart', diamonds: 5, image: '' },
    { name: 'Doughnut', diamonds: 30, image: '' },
  ];

  // Chat-overlay traffic (chat, song requests, stickers, gifts, joins) is
  // opt-in with MOCK_CHAT=1 so plain MOCK=1 only fires follow alerts. Chat goes
  // through handleIncomingComment like the real thing, profanity filter included.
  if (process.env.MOCK_CHAT === '1') {
    setInterval(() => {
      handleIncomingComment({ type: 'chat', ...mockViewer(randomItem(mockUsers)), comment: randomItem(mockComments) });
    }, 2500);

    // YouTube chat, shaped like youtube-chat.js's messages (yt:-prefixed user,
    // handle without "@").
    const mockYoutubeUsers = ['Somchai_TH', 'lofi_listener', 'มะม่วงหวาน', 'GamerBoy99', 'น้องหมี 🐻'];
    const mockYoutubeComments = [
      'มาจาก YouTube ครับ 👋',
      'ดูจากยูทูปอยู่ ภาพชัดมาก',
      'hello from YouTube!',
      'ขอเพลงด้วยครับ',
      'ไลฟ์ทุกวันเลยไหมคะ',
      '555555 ฮามาก',
      'ควย', // dropped by the profanity filter -- never reaches the overlay
    ];
    setInterval(() => {
      const nickname = randomItem(mockYoutubeUsers);
      handleIncomingComment({
        type: 'chat',
        platform: 'youtube',
        user: `yt:${nickname}`,
        nickname,
        avatarUrl: mockAvatar('yt-' + nickname),
        comment: randomItem(mockYoutubeComments),
      });
    }, 3700);

    // Song requests get their own stream rather than being sprinkled into
    // mockComments, and are cycled instead of randomised, so a short session
    // exercises every refusal path (too long, live stream, missing video,
    // duplicate) instead of depending on luck. All ids are real videos.
    const mockSongLinks = [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ', // ok
      'https://youtu.be/9bZkp7q19f0', // ok -- short link form
      'https://www.youtube.com/watch?v=kJQP7kiw5Fk', // ok
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ', // refused: already requested
      'https://www.youtube.com/watch?v=jfKfPfyJRdk', // refused: 1407-day live archive
      'https://www.youtube.com/watch?v=JGwWNGJdvx8', // ok
      'https://www.youtube.com/watch?v=4xDzrJKXOOY', // refused: in-progress live stream
      'https://www.youtube.com/watch?v=fJ9rUzIMcZQ', // ok
      'https://www.youtube.com/watch?v=zzzzzzzzzzz', // refused: no such video
      'https://www.youtube.com/watch?v=OPf0YbXqDm0', // ok
      'https://www.youtube.com/shorts/60ItHLz5WEA', // ok -- shorts form
      'https://www.youtube.com/watch?v=RgKAFK5djSk', // ok
      'https://www.youtube.com/watch?v=CevxZvSJLk8', // ok
      'https://www.youtube.com/watch?v=hT_nvWreIhg', // ok
    ];

    let mockSongIndex = 0;
    setInterval(() => {
      const nickname = mockUsers[mockSongIndex % mockUsers.length];
      const link = mockSongLinks[mockSongIndex % mockSongLinks.length];
      mockSongIndex += 1;
      handleIncomingComment({ type: 'chat', ...mockViewer(nickname), comment: `/music ${link}` });
    }, 9000);

    setInterval(() => {
      const viewer = mockViewer(randomItem(mockUsers));
      console.log(`[MOCK] ${viewer.nickname} sent a sticker`);
      emitLiveEvent({ type: 'emote', ...viewer, emoteImages: [mockAvatar('sticker-' + Math.floor(Math.random() * 5))] });
    }, 11000);

    setInterval(() => {
      const gift = randomItem(mockGifts);
      const repeatCount = Math.floor(Math.random() * 5) + 1;
      const viewer = mockViewer(randomItem(mockUsers));
      console.log(`[MOCK] ${viewer.nickname} sent ${gift.name} x${repeatCount}`);
      emitLiveEvent({
        type: 'gift',
        ...viewer,
        giftName: gift.name,
        giftImage: gift.image,
        repeatCount,
        diamondCount: gift.diamonds * repeatCount,
      });
    }, 8000);

    setInterval(() => {
      const viewer = mockViewer(randomItem(mockUsers));
      console.log(`[MOCK] ${viewer.nickname} joined`);
      emitLiveEvent({ type: 'member', ...viewer });
    }, 5000);
  }

  // /follow alerts once per user per session, so reusing the nickname as the
  // user id would stop the alerts after every mock name had followed once.
  let mockFollowSeq = 0;
  setInterval(() => {
    mockFollowSeq += 1;
    const viewer = { ...mockViewer(randomItem(mockUsers)), user: `mock-follow-${mockFollowSeq}` };
    console.log(`[MOCK] ${viewer.nickname} followed`);
    emitLiveEvent({ type: 'follow', ...viewer });
  }, 15000);
} else {
  const tiktokConnection = new TikTokLiveConnection(TIKTOK_USERNAME, {});

  function connectToTikTok() {
    tiktokConnection.connect()
      .then((state) => {
        console.log(`Connected to TikTok live room ${state.roomId} (@${TIKTOK_USERNAME})`);
        liveLog('tiktok-state', { event: 'connected', roomId: state.roomId, username: TIKTOK_USERNAME });
        tiktokLiveConnected = true;
        tiktokReconnectAttempt = 0;
        currentRoomId = String(state.roomId || '');
        broadcast(tiktokConnectionPayload());
      })
      .catch((err) => {
        console.error('Failed to connect to TikTok live:', err.message);
        liveLog('tiktok-state', { event: 'connect-failed', error: err.message });
        console.error('Retrying in 10s... (make sure the account is live and the username is correct)');
        tiktokLiveConnected = false;
        tiktokReconnectAttempt++;
        broadcast(tiktokConnectionPayload());
        setTimeout(connectToTikTok, 10000);
      });
  }
  connectToTikTok();

  // The viewer's @handle. tiktok-live-connector 2.x decodes with the v3
  // proto, where it's `displayId`; `uniqueId` was the v2 name and is now
  // always undefined -- which merged every gifter into one Gift history entry.
  const tiktokHandle = (user) => user?.displayId || user?.uniqueId || '';

  // TikTok's numeric account id. Unlike the @handle it never changes, so Gift
  // history keys a viewer on it. "0" is what an unset int64 decodes to.
  const tiktokUserId = (user) => {
    const id = String(user?.id || '');
    return id === '0' ? '' : id;
  };

  // The viewer fields every TikTok event carries, in our message shape.
  const tiktokViewer = (data) => ({
    platform: 'tiktok',
    userId: tiktokUserId(data.user),
    user: tiktokHandle(data.user),
    nickname: data.user?.nickname,
    avatarUrl: data.user?.avatarThumb?.urlList?.[0] || '',
  });

  tiktokConnection.on(WebcastEvent.CHAT, (data) => {
    // Wrapped in try/catch so a malformed event (unexpected field shape from
    // TikTok) logs and moves on instead of silently dropping the comment with
    // no trace -- this is the only place a "comment never showed up" report
    // could originate from on our side.
    try {
      handleIncomingComment({ type: 'chat', ...tiktokViewer(data), comment: data.content });
    } catch (err) {
      liveLog('error', { where: 'chat-handler', user: tiktokHandle(data?.user), content: data?.content, error: err.message });
      console.error('[chat] CHAT handler threw for raw event', {
        handle: tiktokHandle(data?.user),
        nickname: data?.user?.nickname,
        content: data?.content,
        error: err.stack || err.message,
      });
    }
  });

  tiktokConnection.on(WebcastEvent.GIFT, (data) => {
    // Streakable gifts (gift.type === 1) re-fire on every tap while the
    // sender holds the button, with a rising repeatCount. Only broadcast
    // once the streak actually ends (repeatEnd === 1) so we announce the
    // final combo instead of spamming one line per tap.
    if (data.gift?.type === 1 && data.repeatEnd !== 1) return;

    const message = {
      type: 'gift',
      ...tiktokViewer(data),
      giftName: data.gift?.name || 'ของขวัญ',
      giftImage: data.gift?.image?.urlList?.[0] || '',
      repeatCount: data.repeatCount || 1,
      diamondCount: (data.gift?.diamondCount || 0) * (data.repeatCount || 1),
    };
    console.log(`${message.nickname} sent ${message.giftName} x${message.repeatCount}`);
    emitLiveEvent(message);
  });

  tiktokConnection.on(WebcastEvent.MEMBER, (data) => {
    const message = { type: 'member', ...tiktokViewer(data) };
    if (!message.nickname) return;
    console.log(`${message.nickname} joined`);
    emitLiveEvent(message);
  });

  tiktokConnection.on(WebcastEvent.FOLLOW, (data) => {
    const message = { type: 'follow', ...tiktokViewer(data) };
    if (!message.nickname) return;
    console.log(`${message.nickname} followed`);
    emitLiveEvent(message);
  });

  // Without an ERROR listener the connector swallows these silently -- and a
  // websocket frame that fails to decode takes every comment in it down with it.
  tiktokConnection.on(ControlEvent.ERROR, ({ info, exception }) => {
    // Connect failures are already logged by connectToTikTok's retry path.
    if (info === 'Error while connecting') return;
    console.error('[tiktok] connector error:', info, exception?.stack || exception);
    liveLog('error', { where: 'connector', info, error: exception?.message || String(exception) });
  });

  // A single message that fails protobuf decoding is skipped by the connector
  // with no event at all, so a viewer whose comments trip it just never shows
  // up. Log those here so a "their chat never appeared" report has a trace.
  // Methods the connector has no proto schema for are dropped the same way
  // (no decodedData, no decodeError). If TikTok moves comments to a new
  // message type, this is the only place it shows up. Logged once per method.
  const unknownMethodsSeen = new Set();
  // High-volume types with nothing a viewer typed; left out of the raw log so
  // the comments aren't buried under thousands of likes and viewer counts.
  const NOISY_RAW_METHODS = new Set(['WebcastLikeMessage', 'WebcastRoomUserSeqMessage', 'WebcastMemberMessage']);
  tiktokConnection.on(ControlEvent.WEBSOCKET_CONNECTED, (wsClient) => {
    wsClient.on('protoMessageFetchResult', (result) => {
      for (const m of result.messages || []) {
        if (m.decodeError) {
          console.error(`[tiktok] failed to decode ${m.method}:`, m.decodeError.message);
          liveLog('tiktok-raw', { method: m.method, decodeError: m.decodeError.message });
        } else if (!m.decodedData) {
          if (!unknownMethodsSeen.has(m.method)) {
            unknownMethodsSeen.add(m.method);
            console.warn(`[tiktok] unknown message type ${m.method} (no schema, dropped by connector)`);
          }
          liveLog('tiktok-raw', { method: m.method, unknown: true });
        } else if (!NOISY_RAW_METHODS.has(m.method)) {
          const d = m.decodedData.data || {};
          liveLog('tiktok-raw', {
            method: m.method,
            msgId: d.common?.msgId,
            user: tiktokHandle(d.user),
            nickname: d.user?.nickname,
            content: d.content,
          });
        }
      }
    });
  });

  // Sticker/emote comments (subscriber stickers) arrive as their own event,
  // not CHAT, and carry only images -- no text.
  tiktokConnection.on(WebcastEvent.EMOTE, (data) => {
    try {
      const message = {
        type: 'emote',
        ...tiktokViewer(data),
        emoteImages: (data.emoteList || [])
          .map((emote) => emote?.image?.urlList?.[0])
          .filter(Boolean),
      };
      console.log(`[emote] ${message.nickname}: ${message.emoteImages.length} sticker(s)`);
      if (message.emoteImages.length) emitLiveEvent(message);
    } catch (err) {
      liveLog('error', { where: 'emote-handler', user: tiktokHandle(data?.user), error: err.message });
      console.error('[emote] EMOTE handler threw', {
        handle: tiktokHandle(data?.user),
        error: err.stack || err.message,
      });
    }
  });

  // DISCONNECTED lives on ControlEvent; WebcastEvent.DISCONNECTED is undefined.
  tiktokConnection.on(ControlEvent.DISCONNECTED, () => {
    console.log('Disconnected from TikTok live. Retrying...');
    liveLog('tiktok-state', { event: 'disconnected' });
    tiktokLiveConnected = false;
    broadcast(tiktokConnectionPayload('หลุดจากไลฟ์ กำลังเชื่อมต่อใหม่...'));
    setTimeout(connectToTikTok, 5000);
  });
}

// Exposed only so the offline test harness can drive a Comment through the
// song request path without a live TikTok room. Nothing in the server itself
// reads this.
module.exports = { handleSongRequestComment };
