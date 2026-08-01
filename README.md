# TikTok Live Chat Reader (Thai TTS + Overlay)

Real-time TikTok LIVE chat overlay for OBS/Streamlabs. Shows chat, gift, and viewer-join events as
styled cards, and reads chat comments aloud in Thai.

## Install

```bash
npm install
```

## Configure

Copy `.env.example` to `.env` and fill in your TikTok username:

```
TIKTOK_USERNAME=your_tiktok_username
WS_PORT=8081
HTTP_PORT=8080
```

The account must be **currently live** or the connection will fail (it retries automatically every
10 seconds, so you can start the server before going live).

## Run

```bash
npm start
```

## Test without a live session (mock mode)

```powershell
$env:MOCK = "1"; npm start
```

Generates fake chat, gift, and member-join events on intervals so you can preview the overlay and hear
TTS without an active TikTok live session.

## Use with OBS/Streamlabs

1. Run `npm start` and leave it running.
2. In OBS/Streamlabs: add a new **Browser Source** → URL `http://localhost:8080`.
3. Resize/position it over your scene as needed.
4. To interact with the TTS mute button while it's a Browser Source, right-click the source → **Interact**.
5. TTS audio plays through the overlay page's own audio — capture it in OBS via the Browser Source's
   audio output (or desktop audio capture).

## How it works

- **`server.js`** connects to the TikTok room via `tiktok-live-connector`, normalizes chat/gift/member
  events, and rebroadcasts them over a local WebSocket. It also serves `overlay.html` and proxies
  Google Translate's TTS endpoint (`/tts`) and `canvas-confetti` (`/vendor/confetti.js`) so the overlay
  works without hitting external CDNs at runtime.
- **`overlay.html`** is a single-file frontend: renders chat/gift/member cards, drives TTS playback, and
  has a mute toggle (persisted in `localStorage`).

See [`CONTEXT.md`](./CONTEXT.md) for the project's domain language (Gift streak, Repeat flood, Pattern
collapse, etc.) and [`docs/plan-current-overlay-features.md`](./docs/plan-current-overlay-features.md)
for the design decisions behind them.

## Notes / caveats

- Uses `tiktok-live-connector` v2 (unofficial). Connecting with just a username is free, but it relies on
  a third-party signing service ([Euler Stream](https://www.eulerstream.com/)) that has a free rate limit —
  heavy or frequent reconnects may get throttled; a paid `signApiKey` lifts that limit.
- Being an unofficial, reverse-engineered library, it can break if TikTok changes its internal protocol.
- TTS uses Google Translate's public `translate_tts` endpoint (free, no API key, no official SLA). If it
  ever becomes unreliable, switching to a paid provider (Google Cloud TTS, Azure TTS) is the fallback path.
