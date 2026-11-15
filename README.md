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

To also show YouTube live chat in the same overlay, set `YOUTUBE_CHANNEL` (your `@handle`) or
`YOUTUBE_VIDEO_ID` (for unlisted streams). No API key is needed; the server waits until the channel
goes live. Each chat line gets a colour dot before the name: cyan = TikTok, red = YouTube.

## Run

```bash
npm start
```

## Test without a live session (mock mode)

```powershell
$env:MOCK = "1"; $env:MOCK_CHAT = "1"; npm start
```

Generates fake chat, gift, and member-join events on intervals so you can preview the overlay and hear
TTS without an active TikTok live session. `MOCK=1` on its own only fires follow alerts; `MOCK_CHAT=1`
adds the rest.

Mock mode keeps its own Gift history in `logs/mock-gifts/`, never mixed with the real one. To fill
`/gifts` with 30 days of fake history first, run `npm run seed:gifts` (re-running replaces it).

### Testing Gift tiers on `/chat`

Every Gift shows up in the chat list, in order, and scrolls with it. One worth under 100 coins (tier 1)
is a plain line; 100 or more (tier 2) is an orange card; 1,000 or more (tier 3) is a gold card. A card's
moving effects run for its first 5s (tier 2) or 8s (tier 3), then it stays as a still card. Change the
thresholds with `?mid=` and `?big=` on the `/chat` URL.

Mock Gifts top out at 150 coins, so the default thresholds never show tier 3. Two ways to see all three:

**Lower the thresholds** so the mock Gifts cover every tier, then watch for a minute (one Gift every 8s):

```
http://localhost:8080/chat?mid=5&big=30
```

- Rose / Ice Cream Cone / Glow Stick, a few of them: tier 1 (plain line)
- Finger Heart: tier 2 (orange card)
- Doughnut: tier 3 (gold card)

**Send one by hand.** Open `http://localhost:8080/chat`, press F12, and paste into the Console:

```js
handleWsMessage({ type: "gift", nickname: "ทดสอบ", user: "t1", giftName: "Lion", repeatCount: 2, diamondCount: 59998, avatarUrl: "", giftImage: "" })
```

`diamondCount` picks the tier: `5` is tier 1, `240` tier 2, `59998` tier 3.

Things that look like bugs but aren't:

- A card's Gift picture and coin total never appear: the tab is in the background, where the browser
  pauses animations. Keep it in front. OBS browser sources aren't affected.
- Nothing changed after an edit: refresh the page (or the browser source in OBS).
- `/chat` also speaks through your speakers. Turn TTS off in the Panel if you'd rather it didn't.

## Who can reach the server

Both servers listen on `127.0.0.1`, so only this PC can open the overlays and the Panel. The Panel has
no login, so it also refuses:

- a request whose `Host` isn't this machine (a domain pointed at 127.0.0.1)
- a WebSocket from any page it didn't serve itself (another website open in the same browser)
- commands with the wrong shape (each is checked field by field in `request-guard.js`)

To use the Panel from a phone on the same Wi-Fi, set `BIND_HOST=0.0.0.0` in `.env` -- anyone on that
network can then use it too. Turn it back off after the stream.

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
  summary, and controlling the BRB timer. **`/gifts`** charts TikTok Gifts for today / yesterday / 7 / 30 days — diamonds per hour or day,
  per gift type, top gifters, recent Gifts, CSV export — from the Gift history in `logs/gifts-*.jsonl`
  (served by `/api/gift-events`). The Control Room shows `/gifts` and `/panel` in its sidebar; all three
  share `widgets/shared/dashboard.css` and a light/dark toggle.

### YouTube Music now playing (`/ytmusic`)

A pill-shaped card (spinning record art, title, artist) for the track playing in your own `music.youtube.com`
browser tab, plus the next song in its queue.
YouTube Music has no API for this, so a userscript in that tab reads the page and posts it to the server:

1. Install [Tampermonkey](https://www.tampermonkey.net/) in the browser you play music in.
2. With `npm start` running, open `http://localhost:8080/ytmusic.user.js` and click **Install**.
3. Play something on `music.youtube.com`, then add `http://localhost:8080/ytmusic` as a Browser Source.

Query options: `?theme=` (shared themes from `widgets/shared/themes.js`, e.g. `ocean`, `sunset`; default is dark + orange), `?next=0` (hide the
next-song line), `?demo=1` (fake track for positioning). The card hides as soon as the tab closes (or ~2 min after the tab stops reporting, e.g. a crash); a tab in the background keeps it alive. The queue
comes from the page's DOM, so a YouTube Music redesign can break it until the selectors in
`widgets/ytmusic/ytmusic.user.js` are updated; the current track itself comes from the Media Session API
and is more robust.

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
