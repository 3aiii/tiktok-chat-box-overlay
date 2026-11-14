// Helpers shared by the widget and dashboard pages. Plain globals on purpose:
// there's no bundler, and each page is its own OBS/browser source anyway.

// Match the WS_PORT set in server.js
const WS_URL = "ws://localhost:8081";

// Returns a stable { send } wrapper rather than the raw WebSocket, since the
// underlying socket is replaced on every auto-reconnect -- a caller holding on
// to the return value would otherwise send on a closed socket after the first
// disconnect.
// onStatus(connected: boolean), if given, fires on open and on close/error.
function connectWS(onMessage, onStatus) {
  let socket;

  function open() {
    socket = new WebSocket(WS_URL);
    socket.onopen = () => onStatus && onStatus(true);
    socket.onmessage = (event) => onMessage(JSON.parse(event.data));
    socket.onclose = () => {
      onStatus && onStatus(false);
      setTimeout(open, 3000);
    };
  }
  open();

  return {
    send: (payload) => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(payload));
      }
    },
  };
}

// Small fixed-corner dot, hidden while connected and only surfacing when the
// WS drops/reconnects -- so it stays out of the way on stream but still
// flags a real problem. Returns setStatus(connected) to pass as connectWS's
// onStatus callback.
function attachStatusIndicator() {
  const el = document.createElement("div");
  el.id = "ws-status";
  el.innerHTML = '<span class="ws-status-dot"></span><span class="ws-status-text">reconnecting…</span>';
  const style = document.createElement("style");
  style.textContent = `
    #ws-status {
      position: fixed;
      top: 10px;
      left: 10px;
      display: none;
      align-items: center;
      gap: 6px;
      background: rgba(0, 0, 0, 0.6);
      color: #fff;
      font-family: "Kanit", "Segoe UI", "Sarabun", sans-serif;
      font-size: 11px;
      font-weight: 600;
      padding: 5px 10px;
      border-radius: 999px;
      z-index: 9999;
    }
    #ws-status.show { display: flex; }
    .ws-status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #ff5b5b;
      box-shadow: 0 0 8px 1px rgba(255, 91, 91, 0.8);
      animation: ws-status-pulse 1s ease-in-out infinite;
    }
    @keyframes ws-status-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.35; }
    }
  `;
  document.head.appendChild(style);
  document.body.appendChild(el);

  return function setStatus(connected) {
    el.classList.toggle("show", !connected);
  };
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// An <img> for a TikTok/YouTube CDN URL. no-referrer matters: the CDNs refuse
// hotlinked images that send our localhost referrer.
function createImg(src, className) {
  const img = document.createElement("img");
  if (className) img.className = className;
  img.src = src;
  img.alt = "";
  img.referrerPolicy = "no-referrer";
  return img;
}

// Real TikTok profile picture only -- no letter-avatar fallback. Returns null
// when there's no avatarUrl, or removes itself from the DOM if the CDN image
// fails to load.
function createAvatar(avatarUrl) {
  if (!avatarUrl) return null;
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  const img = createImg(avatarUrl);
  img.onerror = () => avatar.remove();
  avatar.appendChild(img);
  return avatar;
}

function buildLine(extraClass, nickname, avatarUrl, icon) {
  const line = document.createElement("div");
  line.className = extraClass ? `chat-line ${extraClass}` : "chat-line";

  const header = document.createElement("div");
  header.className = "line-header";
  const avatar = createAvatar(avatarUrl);
  if (avatar) header.appendChild(avatar);
  if (icon) header.appendChild(icon);
  const nick = document.createElement("span");
  nick.className = "nickname";
  nick.textContent = nickname;
  header.appendChild(nick);

  const bubble = document.createElement("div");
  bubble.className = "bubble";

  line.appendChild(header);
  line.appendChild(bubble);
  return { line, bubble };
}

function pushLine(container, line, maxLines) {
  container.prepend(line);
  while (container.children.length > maxLines) {
    container.removeChild(container.lastChild);
  }
  // Only fade the top edge once messages actually overflow the box -- otherwise
  // a single early comment gets faded for no reason.
  container.classList.toggle("overflowing", container.scrollHeight > container.clientHeight);
}

const pad2 = (n) => String(n).padStart(2, "0");

// 125000 -> "02:05"
function formatClock(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  return `${pad2(Math.floor(totalSeconds / 60))}:${pad2(totalSeconds % 60)}`;
}

// What the BRB clock reads for a server timer-state; running is the only
// state that changes on its own, so callers re-check it on a tick.
function timerClockText(state) {
  if (state.status === "running") return formatClock(state.endsAt - Date.now());
  if (state.status === "paused") return formatClock(state.remainingMs);
  if (state.status === "ended") return "00:00";
  return formatClock(state.durationMs);
}
