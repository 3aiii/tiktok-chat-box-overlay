require('dotenv').config();
const { TikTokLiveConnection, WebcastEvent } = require('tiktok-live-connector');
const { WebSocketServer } = require('ws');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const { URL } = require('url');

const TIKTOK_USERNAME = process.env.TIKTOK_USERNAME || 'your_tiktok_username';
const WS_PORT = process.env.WS_PORT || 8081;
const HTTP_PORT = process.env.HTTP_PORT || 8080;
const MOCK_MODE = process.env.MOCK === '1';
const EASYDONATE_API_KEY = process.env.EASYDONATE_API_KEY || '';

// Self-hosted TTS engine (tts-engine-project, POST /v1/tts, {text, lang} ->
// streamed WAV). Switchable at runtime against the older Google proxy from
// the panel widget -- see ttsProvider below and the /tts route.
const TTS_ENGINE_URL = process.env.TTS_ENGINE_URL || 'http://127.0.0.1:8000/v1/tts';

// In-memory only, resets to 'google' on server restart -- same convention as
// timerState below. Switched via the panel's TTS provider control.
let ttsProvider = 'google'; // 'local' | 'google'

// Global on/off for reading chat aloud, in-memory only (resets to true on
// restart). Was a per-browser localStorage toggle button on chat.html itself;
// moved here + broadcast over WS so it can be controlled from the Setup page
// instead, same pattern as ttsProvider above.
let ttsEnabled = true;

// TTS playback speed (1.0 = normal, >1 = faster, <1 = slower), same
// in-memory/broadcast convention as ttsProvider and ttsEnabled above.
let ttsSpeed = 1.5;

// Whether the server currently has a live TikTok room connection (real mode)
// or is generating fake events (mock mode, always "connected"). Distinct from
// a browser's own WebSocket link to this server -- that can be open while
// TikTok itself is offline, which is exactly the case this flag exists to
// surface on the control room's LIVE badge.
let tiktokLiveConnected = MOCK_MODE;

// How many consecutive times connectToTikTok has failed since the last
// success; surfaced in tiktokConnectionPayload's detail so the control
// room's badge shows retry progress instead of a static offline message.
let tiktokReconnectAttempt = 0;

function tiktokConnectionPayload(detailOverride) {
  const payload = { type: 'tiktok-connection-state', connected: tiktokLiveConnected };
  if (!tiktokLiveConnected) {
    payload.detail =
      detailOverride ||
      (tiktokReconnectAttempt > 0
        ? `กำลังลองเชื่อมต่อใหม่ครั้งที่ ${tiktokReconnectAttempt} (ตรวจสอบว่า live อยู่และ username ถูกต้อง)`
        : undefined);
  }
  return payload;
}

// Proxies Google Translate's TTS endpoint so the chat widget can fetch audio
// same-origin (Chrome's ORB blocks the browser hitting translate.google.com
// directly). No API key needed. Kept as a fallback alongside the local
// engine; pick between them via ttsProvider.
function proxyGoogleTts(text, res) {
  const ttsUrl =
    'https://translate.google.com/translate_tts?ie=UTF-8&tl=th&client=tw-ob&q=' +
    encodeURIComponent(text.slice(0, 200));

  https
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

// EasyDonate's exact response shape isn't public without a real API key to test
// against, so this normalizes a handful of plausible shapes (array directly,
// or nested under data/items/leaderboard) and field name variants into
// { name, amount }[] the widget can render regardless of which one shows up.
function normalizeLeaderboard(payload) {
  const list = Array.isArray(payload)
    ? payload
    : payload?.data?.items || payload?.data || payload?.leaderboard || payload?.items || [];
  return list
    .map((entry) => ({
      name: entry.name || entry.nickname || entry.donorName || entry.donor?.name || 'ไม่ระบุชื่อ',
      amount: Number(entry.amount ?? entry.total ?? entry.sum ?? entry.totalAmount ?? 0),
    }))
    .filter((entry) => entry.amount > 0)
    .sort((a, b) => b.amount - a.amount);
}

// Hard-coded on top of whatever EasyDonate reports -- a real donor
// (Huffy, 300 THB) who isn't tracked by the EasyDonate API but should still
// show up on the leaderboard at the right rank.
const EXTRA_LEADERBOARD_ENTRY = { name: 'Huffy', amount: 300 };

function withExtraEntry(list) {
  return [...list, EXTRA_LEADERBOARD_ENTRY].sort((a, b) => b.amount - a.amount);
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// In-memory only, by design (see CONTEXT.md non-goals) -- resets on server
// restart, no file/db persistence. gifters is keyed by uniqueId so a repeat
// donor's diamonds accumulate onto the same entry instead of splitting.
const stats = {
  comments: 0,
  gifts: 0,
  giftDiamonds: 0,
  viewers: new Set(),
  gifters: new Map(),
};

// Called from broadcast() so every chat/gift/member path -- mock and real
// alike -- updates the same counters without each call site remembering to.
function trackStats(message) {
  if (message.type === 'chat') {
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

// Proxied (not called directly from the browser) so the EasyDonate API key
// never ships to the client. Falls back to mock data when no key is
// configured, so the /top-donate widget works out of the box.
function handleLeaderboard(req, res) {
  if (!EASYDONATE_API_KEY) {
    sendJson(res, 200, { leaderboard: withExtraEntry(MOCK_LEADERBOARD), mock: true });
    return;
  }

  https
    .get(
      `${EASYDONATE_API_BASE_URL}/api/v1/widgets/leaderboard`,
      { headers: { Authorization: `Bearer ${EASYDONATE_API_KEY}` } },
      (apiRes) => {
        let body = '';
        apiRes.on('data', (chunk) => (body += chunk));
        apiRes.on('end', () => {
          if (apiRes.statusCode !== 200) {
            console.error('EasyDonate leaderboard error:', apiRes.statusCode, body);
            sendJson(res, 502, { error: 'EasyDonate API error', status: apiRes.statusCode });
            return;
          }
          try {
            const leaderboard = withExtraEntry(normalizeLeaderboard(JSON.parse(body)));
            sendJson(res, 200, { leaderboard, mock: false });
          } catch (err) {
            console.error('EasyDonate leaderboard parse error:', err.message);
            sendJson(res, 502, { error: 'Failed to parse EasyDonate response' });
          }
        });
      }
    )
    .on('error', (err) => {
      console.error('EasyDonate leaderboard request error:', err.message);
      sendJson(res, 502, { error: 'EasyDonate request failed' });
    });
}

// Serves each overlay widget's page (see PAGE_ROUTES below) plus static
// assets, so each one can be added as its own Browser Source in OBS/Streamlabs
const httpServer = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, `http://localhost:${HTTP_PORT}`);

  if (reqUrl.pathname === '/api/leaderboard') {
    handleLeaderboard(req, res);
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

  // Serve the bundled Kanit font files so the overlay renders Thai text
  // consistently without depending on system fonts.
  if (reqUrl.pathname.startsWith('/fonts/') && reqUrl.pathname.endsWith('.ttf')) {
    const fontFile = path.basename(reqUrl.pathname);
    const fontPath = path.join(__dirname, 'fonts', fontFile);
    fs.readFile(fontPath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Font not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'font/ttf' });
      res.end(data);
    });
    return;
  }

  // Serve canvas-confetti from node_modules instead of a CDN so the overlay
  // works fully offline / without external requests.
  if (reqUrl.pathname === '/vendor/confetti.js') {
    const confettiPath = path.join(__dirname, 'node_modules', 'canvas-confetti', 'dist', 'confetti.browser.js');
    fs.readFile(confettiPath, (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end('Failed to load confetti.js');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(data);
    });
    return;
  }

  // Generic static serve for the split widget files. Each widget lives in its
  // own folder (widgets/chat/chat.html, chat.css, chat.js, ...) alongside a
  // shared/ folder for code common to all of them, so this resolves the full
  // path under widgets/ rather than just the basename.
  const WIDGET_CONTENT_TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };
  if (reqUrl.pathname.startsWith('/widgets/')) {
    const ext = path.extname(reqUrl.pathname);
    const contentType = WIDGET_CONTENT_TYPES[ext];
    if (!contentType) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    // path.join collapses ".." segments, and this check rejects anything
    // that still climbs outside widgets/ afterwards -- prevents requests
    // like /widgets/../server.js from escaping the widgets folder.
    const widgetsRoot = path.join(__dirname, 'widgets');
    const widgetPath = path.join(widgetsRoot, decodeURIComponent(reqUrl.pathname.slice('/widgets/'.length)));
    if (!widgetPath.startsWith(widgetsRoot + path.sep)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    fs.readFile(widgetPath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Widget file not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    });
    return;
  }

  // Each split overlay widget lives at its own path so it can be added as a
  // separate Browser Source in OBS/Streamlabs and scaled/positioned independently.
  const PAGE_ROUTES = {
    '/': 'index.html',
    '/chat': 'widgets/chat/chat.html',
    '/pinned': 'widgets/pinned/pinned.html',
    '/panel': 'widgets/panel/panel.html',
    '/top-donate': 'widgets/top-donate/top-donate.html',
    '/summary': 'widgets/summary/summary.html',
    '/timer': 'widgets/timer/timer.html',
  };
  const page = PAGE_ROUTES[reqUrl.pathname];
  if (!page) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  fs.readFile(path.join(__dirname, page), (err, data) => {
    if (err) {
      res.writeHead(500);
      res.end('Failed to load page');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(data);
  });
});
httpServer.listen(HTTP_PORT, () => {
  console.log(`Overlay page: http://localhost:${HTTP_PORT}`);
});

// Broadcast chat events to any connected overlay pages
const wss = new WebSocketServer({ port: WS_PORT });
console.log(`WebSocket server listening on ws://localhost:${WS_PORT}`);

function broadcast(payload) {
  trackStats(payload);
  const message = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) {
      client.send(message);
    }
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

// The panel widget sends messages upstream: pin/unpin a comment, request the
// current session stats snapshot to show on /summary, or control the BRB timer.
wss.on('connection', (ws) => {
  // Sync-on-connect: without this, reloading /timer mid-countdown (or opening
  // /panel late) would show idle/zero until the next control action instead
  // of picking up wherever the countdown actually is.
  ws.send(JSON.stringify(timerStatePayload()));
  ws.send(JSON.stringify({ type: 'tts-provider-state', provider: ttsProvider }));
  ws.send(JSON.stringify({ type: 'tts-enabled-state', enabled: ttsEnabled }));
  ws.send(JSON.stringify({ type: 'tts-speed-state', speed: ttsSpeed }));
  ws.send(JSON.stringify(tiktokConnectionPayload()));

  ws.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.type === 'pin' || message.type === 'unpin') {
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
    }
  });
});

if (MOCK_MODE) {
  console.log('MOCK mode: generating fake chat messages instead of connecting to TikTok.');

  const mockUsers = ['nampeung_99', 'kai_gamer', 'pim.streamfan', 'tanawat_th', 'user_888'];
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

  const mockAvatar = (nickname) => `https://i.pravatar.cc/150?u=${encodeURIComponent(nickname)}`;

  const mockGifts = [
    { name: 'Rose', image: 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/968820bc85e274713c795a6aef3f7c67~tplv-obj.png' },
    { name: 'Ice Cream Cone', image: 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/968820bc85e274713c795a6aef3f7c67~tplv-obj.png' },
    { name: 'Glow Stick', image: '' },
  ];

  setInterval(() => {
    const nickname = mockUsers[Math.floor(Math.random() * mockUsers.length)];
    const message = {
      type: 'chat',
      user: nickname,
      nickname,
      avatarUrl: mockAvatar(nickname),
      comment: mockComments[Math.floor(Math.random() * mockComments.length)],
    };
    console.log(`[MOCK] ${message.nickname}: ${message.comment}`);
    broadcast(message);
  }, 2500);

  setInterval(() => {
    const gift = mockGifts[Math.floor(Math.random() * mockGifts.length)];
    const nickname = mockUsers[Math.floor(Math.random() * mockUsers.length)];
    const message = {
      type: 'gift',
      user: nickname,
      nickname,
      avatarUrl: mockAvatar(nickname),
      giftName: gift.name,
      giftImage: gift.image,
      repeatCount: Math.floor(Math.random() * 5) + 1,
    };
    console.log(`[MOCK] ${message.nickname} sent ${message.giftName} x${message.repeatCount}`);
    broadcast(message);
  }, 8000);

  setInterval(() => {
    const nickname = mockUsers[Math.floor(Math.random() * mockUsers.length)];
    const message = {
      type: 'member',
      user: nickname,
      nickname,
      avatarUrl: mockAvatar(nickname),
    };
    console.log(`[MOCK] ${message.nickname} joined`);
    broadcast(message);
  }, 5000);
} else {
  const tiktokConnection = new TikTokLiveConnection(TIKTOK_USERNAME, {});

  function connectToTikTok() {
    tiktokConnection.connect()
      .then((state) => {
        console.log(`Connected to TikTok live room ${state.roomId} (@${TIKTOK_USERNAME})`);
        tiktokLiveConnected = true;
        tiktokReconnectAttempt = 0;
        broadcast(tiktokConnectionPayload());
      })
      .catch((err) => {
        console.error('Failed to connect to TikTok live:', err.message);
        console.error('Retrying in 10s... (make sure the account is live and the username is correct)');
        tiktokLiveConnected = false;
        tiktokReconnectAttempt++;
        broadcast(tiktokConnectionPayload());
        setTimeout(connectToTikTok, 10000);
      });
  }
  connectToTikTok();

  tiktokConnection.on(WebcastEvent.CHAT, (data) => {
    const message = {
      type: 'chat',
      user: data.user?.uniqueId,
      nickname: data.user?.nickname,
      comment: data.content,
      avatarUrl: data.user?.avatarThumb?.urlList?.[0] || '',
    };
    console.log(`${message.nickname}: ${message.comment}`);
    broadcast(message);
  });

  tiktokConnection.on(WebcastEvent.GIFT, (data) => {
    // Streakable gifts (gift.type === 1) re-fire on every tap while the
    // sender holds the button, with a rising repeatCount. Only broadcast
    // once the streak actually ends (repeatEnd === 1) so we announce the
    // final combo instead of spamming one line per tap.
    if (data.gift?.type === 1 && data.repeatEnd !== 1) return;

    const message = {
      type: 'gift',
      user: data.user?.uniqueId,
      nickname: data.user?.nickname,
      avatarUrl: data.user?.avatarThumb?.urlList?.[0] || '',
      giftName: data.gift?.name || 'ของขวัญ',
      giftImage: data.gift?.image?.urlList?.[0] || '',
      repeatCount: data.repeatCount || 1,
      diamondCount: (data.gift?.diamondCount || 0) * (data.repeatCount || 1),
    };
    console.log(`${message.nickname} sent ${message.giftName} x${message.repeatCount}`);
    broadcast(message);
  });

  tiktokConnection.on(WebcastEvent.MEMBER, (data) => {
    const message = {
      type: 'member',
      user: data.user?.uniqueId,
      nickname: data.user?.nickname,
      avatarUrl: data.user?.avatarThumb?.urlList?.[0] || '',
    };
    if (!message.nickname) return;
    console.log(`${message.nickname} joined`);
    broadcast(message);
  });

  tiktokConnection.on(WebcastEvent.DISCONNECTED, () => {
    console.log('Disconnected from TikTok live. Retrying...');
    tiktokLiveConnected = false;
    broadcast(tiktokConnectionPayload('หลุดจากไลฟ์ กำลังเชื่อมต่อใหม่...'));
    setTimeout(connectToTikTok, 5000);
  });
}
