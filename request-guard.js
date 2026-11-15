// Who may talk to the server, and what a page may tell it.
//
// The server runs on the streamer's own PC and trusts every command it gets:
// the Panel's pin, timer, song and TTS controls have no login. So it keeps
// strangers out at three points:
//   - it listens on 127.0.0.1 only (BIND_HOST), not the whole LAN
//   - a request whose Host isn't this machine is refused, so a web page whose
//     domain is pointed at 127.0.0.1 (DNS rebinding) can't read the API
//   - a WebSocket from a page this server didn't serve is refused, so any
//     site open in the streamer's browser can't drive the Panel through
//     ws://localhost (the browser lets pages open WebSockets anywhere)
// What does get through is then checked command by command (cleanCommand).

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function isLoopbackName(hostname) {
  const name = String(hostname || '').toLowerCase();
  return LOOPBACK_NAMES.has(name) || name.endsWith('.localhost');
}

// "localhost:8080" / "[::1]:8081" -> hostname, without the port.
function hostnameOf(hostHeader) {
  const value = String(hostHeader || '').trim().toLowerCase();
  if (value.startsWith('[')) return value.slice(0, value.indexOf(']') + 1);
  return value.split(':')[0];
}

function createRequestGuard({ bindHost, httpPort }) {
  const loopbackOnly = isLoopbackName(bindHost);

  // Bound to loopback: only a loopback name in Host. Bound to the LAN on
  // purpose (BIND_HOST=0.0.0.0, e.g. for a Panel on a phone): any Host, since
  // the LAN address the phone uses can't be known ahead of time.
  function isAllowedHost(hostHeader) {
    const hostname = hostnameOf(hostHeader);
    if (!hostname) return false;
    return loopbackOnly ? isLoopbackName(hostname) : true;
  }

  // A WebSocket's Origin is the page that opened it: it has to be one of our
  // pages (same host as the WebSocket, on the HTTP port). localhost and
  // 127.0.0.1 count as the same machine -- shared.js always dials
  // ws://localhost even when the page was opened as 127.0.0.1. No Origin
  // means a non-browser client (a script on this machine), which could reach
  // the server anyway.
  function isAllowedOrigin(originHeader, hostHeader) {
    if (!originHeader) return true;
    let origin;
    try {
      origin = new URL(originHeader);
    } catch {
      return false; // includes "null": sandboxed frames, file:// pages
    }
    if (origin.protocol !== 'http:' && origin.protocol !== 'https:') return false;
    if ((origin.port || (origin.protocol === 'https:' ? '443' : '80')) !== String(httpPort)) return false;
    const pageHost = origin.hostname.toLowerCase();
    const socketHost = hostnameOf(hostHeader).replace(/^\[|\]$/g, '');
    if (isLoopbackName(pageHost) && isLoopbackName(socketHost)) return true;
    return pageHost === socketHost && !loopbackOnly;
  }

  return { isAllowedHost, isAllowedOrigin };
}

// ---------------------------------------------------------------------------
// Commands pages send over the WebSocket. Each is rebuilt from the fields it's
// allowed to have, with types and sizes checked, so nothing a page invents is
// stored or rebroadcast as-is. Returns null for anything malformed or unknown.
// ---------------------------------------------------------------------------

const MAX_TIMER_MS = 24 * 60 * 60 * 1000;
const MAX_AUTO_UNPIN_MS = 60 * 60 * 1000;

const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
const id = (value) => (typeof value === 'string' && value.length > 0 && value.length <= 64 ? value : null);
const httpUrl = (value) => {
  if (typeof value !== 'string' || value.length > 2000) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? value : '';
  } catch {
    return '';
  }
};

// Each entry: (message) -> the clean command, or null to drop it.
const COMMANDS = {
  // Reports from overlay pages (rendered / handler error / hello). Logged
  // only; capped so one page can't fill the live log.
  'overlay-log': (m) => {
    const report = {};
    for (const [key, value] of Object.entries(m).slice(0, 12)) {
      if (key === 'type') continue;
      if (typeof value === 'string') report[key] = value.slice(0, 300);
      else if (typeof value === 'number' || typeof value === 'boolean') report[key] = value;
    }
    return { type: 'overlay-log', ...report };
  },

  pin: (m) => {
    const autoUnpinMs = Number(m.autoUnpinMs) || 0;
    return {
      type: 'pin',
      nickname: text(m.nickname, 100),
      comment: text(m.comment, 500),
      avatarUrl: httpUrl(m.avatarUrl),
      autoUnpinMs: Math.min(MAX_AUTO_UNPIN_MS, Math.max(0, Math.round(autoUnpinMs))),
    };
  },
  unpin: () => ({ type: 'unpin' }),
  'show-summary': () => ({ type: 'show-summary' }),

  'timer-start': (m) => {
    const durationMs = Number(m.durationMs);
    if (!Number.isFinite(durationMs) || durationMs < 1000 || durationMs > MAX_TIMER_MS) return null;
    return { type: 'timer-start', durationMs: Math.round(durationMs) };
  },
  'timer-pause': () => ({ type: 'timer-pause' }),
  'timer-resume': () => ({ type: 'timer-resume' }),
  'timer-reset': () => ({ type: 'timer-reset' }),
  'timer-set-message': (m) => (typeof m.message === 'string' ? { type: 'timer-set-message', message: m.message.slice(0, 200) } : null),

  'set-song-enabled': (m) => ({ type: 'set-song-enabled', enabled: m.enabled === true }),
  'song-approve': (m) => (id(m.id) ? { type: 'song-approve', id: m.id } : null),
  'song-reject': (m) => (id(m.id) ? { type: 'song-reject', id: m.id } : null),
  'song-start': () => ({ type: 'song-start' }),
  'song-skip': () => ({ type: 'song-skip' }),
  'song-stop': () => ({ type: 'song-stop' }),
  'song-ended': (m) => (id(m.id) ? { type: 'song-ended', id: m.id } : null),
  'song-error': (m) => (id(m.id) ? { type: 'song-error', id: m.id } : null),
  'filler-add': (m) => (typeof m.link === 'string' && m.link.length <= 500 ? { type: 'filler-add', link: m.link } : null),
  'filler-remove': (m) => (id(m.id) ? { type: 'filler-remove', id: m.id } : null),

  'set-tts-provider': (m) => (m.provider === 'local' || m.provider === 'google' ? { type: 'set-tts-provider', provider: m.provider } : null),
  'set-tts-enabled': (m) => ({ type: 'set-tts-enabled', enabled: m.enabled === true }),
  'set-tts-speed': (m) => {
    const speed = Number(m.speed);
    return Number.isFinite(speed) && speed >= 0.5 && speed <= 3 ? { type: 'set-tts-speed', speed } : null;
  },
  'set-tts-read-chance': (m) => {
    const chance = Number(m.chance);
    return Number.isFinite(chance) && chance >= 0 && chance <= 1 ? { type: 'set-tts-read-chance', chance } : null;
  },
};

function cleanCommand(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  const clean = Object.prototype.hasOwnProperty.call(COMMANDS, message.type) ? COMMANDS[message.type] : null;
  return clean ? clean(message) : null;
}

module.exports = { createRequestGuard, cleanCommand, isLoopbackName };
