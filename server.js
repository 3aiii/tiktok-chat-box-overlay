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

// Proxies Google Translate's TTS endpoint so overlay.html can fetch audio
// same-origin (Chrome's ORB blocks the browser hitting translate.google.com
// directly).
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
      console.error('TTS proxy error:', err.message);
      if (!res.headersSent) res.writeHead(502);
      res.end('TTS proxy failed');
    });
}

// Serve overlay.html so it can be added as a Browser Source in OBS/Streamlabs
const httpServer = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, `http://localhost:${HTTP_PORT}`);

  if (reqUrl.pathname === '/tts') {
    const text = reqUrl.searchParams.get('text') || '';
    if (!text) {
      res.writeHead(400);
      res.end('Missing text param');
      return;
    }
    proxyGoogleTts(text, res);
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

  const filePath = path.join(__dirname, 'overlay.html');
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(500);
      res.end('Failed to load overlay.html');
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
  const message = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) {
      client.send(message);
    }
  });
}

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
  ];

  const mockGifts = [
    { name: 'Rose', image: 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/968820bc85e274713c795a6aef3f7c67~tplv-obj.png' },
    { name: 'Ice Cream Cone', image: 'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/968820bc85e274713c795a6aef3f7c67~tplv-obj.png' },
    { name: 'Glow Stick', image: '' },
  ];

  setInterval(() => {
    const message = {
      type: 'chat',
      user: mockUsers[Math.floor(Math.random() * mockUsers.length)],
      nickname: mockUsers[Math.floor(Math.random() * mockUsers.length)],
      comment: mockComments[Math.floor(Math.random() * mockComments.length)],
    };
    console.log(`[MOCK] ${message.nickname}: ${message.comment}`);
    broadcast(message);
  }, 2500);

  setInterval(() => {
    const gift = mockGifts[Math.floor(Math.random() * mockGifts.length)];
    const message = {
      type: 'gift',
      user: mockUsers[Math.floor(Math.random() * mockUsers.length)],
      nickname: mockUsers[Math.floor(Math.random() * mockUsers.length)],
      avatarUrl: '',
      giftName: gift.name,
      giftImage: gift.image,
      repeatCount: Math.floor(Math.random() * 5) + 1,
    };
    console.log(`[MOCK] ${message.nickname} sent ${message.giftName} x${message.repeatCount}`);
    broadcast(message);
  }, 8000);

  setInterval(() => {
    const message = {
      type: 'member',
      user: mockUsers[Math.floor(Math.random() * mockUsers.length)],
      nickname: mockUsers[Math.floor(Math.random() * mockUsers.length)],
      avatarUrl: '',
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
      })
      .catch((err) => {
        console.error('Failed to connect to TikTok live:', err.message);
        console.error('Retrying in 10s... (make sure the account is live and the username is correct)');
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
    setTimeout(() => tiktokConnection.connect().catch(() => {}), 5000);
  });
}
