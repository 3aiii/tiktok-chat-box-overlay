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
2. Open `http://localhost:8080` (the Control Room) in a regular browser tab — it links to every
   overlay's Browser Source URL (`/chat`, `/pinned`, `/top-donate`, `/timer`) and holds the TTS
   provider/on-off/speed controls.
3. In OBS/Streamlabs: add a new **Browser Source** for each overlay page you want, using its URL from
   the Control Room. Resize/position each one over your scene independently.
4. Control TTS (mute, provider, speed) from the Control Room tab, not from inside OBS — the overlay
   pages themselves have no on-page controls.
5. TTS audio plays through the `/chat` page's own audio — capture it in OBS via that Browser Source's
   audio output (or desktop audio capture).

## How it works

- **`server.js`** connects to the TikTok room via `tiktok-live-connector`, normalizes chat/gift/member
  events, and rebroadcasts them over a local WebSocket to every connected page. It also proxies TTS
  (`/tts` — switchable at runtime between a self-hosted local engine, `tts-engine-project`, and a
  Google Translate fallback, with playback speed also configurable) and `canvas-confetti`
  (`/vendor/confetti.js`) so nothing hits external CDNs at runtime, and serves the EasyDonate
  leaderboard (`/api/leaderboard`, falling back to mock data when no API key is set).
- Each overlay is its own page, added as a separate OBS/Streamlabs Browser Source and positioned
  independently: `/chat` (chat/gift cards + TTS), `/pinned` (a single pinned comment shown large),
  `/top-donate` (EasyDonate leaderboard, auto-cycling), `/timer` (BRB countdown). They live under
  `widgets/<name>/<name>.html`, sharing common helpers (`connectWS`, avatar/badge rendering, etc.) from
  `widgets/shared/`.
- **`/`** is the streamer-facing Control Room (`index.html`) — links to every Browser Source URL, TTS
  provider/on-off/speed controls, and the EasyDonate leaderboard status, all synced live over the same
  WebSocket. **`/panel`** is a second streamer-only page for pinning comments, showing the session stats
  summary, and controlling the BRB timer.

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
