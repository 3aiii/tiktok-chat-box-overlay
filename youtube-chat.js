// YouTube live chat reader, fed into the same broadcast() as TikTok chat so
// both platforms land in one chat overlay. Uses youtubei.js (InnerTube, the
// API youtube.com itself calls) -- no API key or quota, read-only, works for
// any public live stream.
//
// Which stream to read:
//   YOUTUBE_VIDEO_ID  -- read this video's chat (needed for unlisted streams)
//   YOUTUBE_CHANNEL   -- otherwise, follow @handle/live: whatever the channel
//                        is streaming right now, re-checked until it goes live

const RETRY_NOT_LIVE_MS = 30000; // channel isn't live yet -- check again
const RETRY_ERROR_MS = 10000; // chat dropped or a request failed
const SEEN_IDS_LIMIT = 2000;

// youtubei.js is ESM-only; server.js is CommonJS.
let innertubePromise = null;
function getInnertube() {
  if (!innertubePromise) {
    innertubePromise = import('youtubei.js').then(async ({ Innertube, Log }) => {
      // Its parser prints a whole generated class to the console every time
      // YouTube ships a chat item type it doesn't know yet (gift views etc.).
      Log.setLevel(Log.Level.NONE);
      return Innertube.create();
    });
    innertubePromise.catch(() => (innertubePromise = null));
  }
  return innertubePromise;
}

function channelLiveUrl(channel) {
  const value = channel.trim();
  if (/^https?:\/\//.test(value)) return value.replace(/\/+$/, '') + (/\/live$/.test(value) ? '' : '/live');
  if (/^UC[\w-]{22}$/.test(value)) return `https://www.youtube.com/channel/${value}/live`;
  return `https://www.youtube.com/${value.startsWith('@') ? value : '@' + value}/live`;
}

// The channel's /live URL resolves to a watch page only while it's streaming.
async function findLiveVideoId(yt, channel) {
  const endpoint = await yt.resolveURL(channelLiveUrl(channel));
  return endpoint?.payload?.videoId || null;
}

// LiveChatTextMessage is a normal comment; LiveChatPaidMessage is a Super
// Chat, which still carries the viewer's text (shown as a plain comment).
function toChatMessage(item) {
  if (item.type !== 'LiveChatTextMessage' && item.type !== 'LiveChatPaidMessage') return null;
  const comment = item.message?.toString?.().trim() || '';
  if (!comment) return null;
  const name = String(item.author?.name || '').replace(/^@/, '');
  return {
    type: 'chat',
    platform: 'youtube',
    user: `yt:${item.author?.id || name}`,
    nickname: name,
    comment,
    avatarUrl: item.author?.thumbnails?.[0]?.url || '',
  };
}

function startYouTubeChat({ channel, videoId, onMessage, onState, log }) {
  const seenIds = new Set();
  let retryTimer = null;

  function retry(ms) {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, ms);
  }

  async function connect() {
    try {
      const yt = await getInnertube();
      const liveId = videoId || (await findLiveVideoId(yt, channel));
      if (!liveId) {
        onState(false, `ช่อง ${channel} ยังไม่ได้ไลฟ์`);
        retry(RETRY_NOT_LIVE_MS);
        return;
      }

      const info = await yt.getInfo(liveId);
      if (!info.basic_info.is_live) {
        onState(false, `วิดีโอ ${liveId} ไม่ได้ไลฟ์อยู่`);
        retry(RETRY_NOT_LIVE_MS);
        return;
      }

      const chat = info.getLiveChat();
      let stopped = false;
      const reconnect = (reason) => {
        if (stopped) return;
        stopped = true;
        try { chat.stop(); } catch {}
        log('youtube-state', { event: 'disconnected', videoId: liveId, reason });
        onState(false, 'หลุดจากแชท YouTube กำลังเชื่อมต่อใหม่...');
        retry(RETRY_ERROR_MS);
      };

      chat.on('start', () => {
        log('youtube-state', { event: 'connected', videoId: liveId, title: info.basic_info.title });
        onState(true, `เชื่อมต่อ YouTube แล้ว (${liveId})`);
      });
      chat.on('chat-update', (action) => {
        if (action.type !== 'AddChatItemAction' || !action.item) return;
        // A reconnect re-fetches the recent backlog; skip lines already shown.
        const id = action.item.id;
        if (id) {
          if (seenIds.has(id)) return;
          seenIds.add(id);
          if (seenIds.size > SEEN_IDS_LIMIT) seenIds.delete(seenIds.values().next().value);
        }
        try {
          const message = toChatMessage(action.item);
          if (message) onMessage(message);
        } catch (err) {
          log('error', { where: 'youtube-chat-handler', error: err.message });
        }
      });
      chat.on('end', () => reconnect('stream ended'));
      chat.on('error', (err) => reconnect(err?.message || String(err)));
      chat.start();
    } catch (err) {
      log('youtube-state', { event: 'connect-failed', error: err.message });
      onState(false, `เชื่อมต่อ YouTube ไม่ได้: ${err.message}`);
      retry(RETRY_ERROR_MS);
    }
  }

  connect();
}

module.exports = { startYouTubeChat };
