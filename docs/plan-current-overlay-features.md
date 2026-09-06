# Plan: TikTok live overlay — chat, gift, member, TTS

## Goal

Give a Thai-speaking streamer a browser-source overlay that shows live chat/gift/join activity and reads
chat comments aloud in Thai, without paid APIs.

## Decisions to grill

1. **TTS provider**: switchable at runtime from the panel between `local` (self-hosted `tts-engine-project`,
   `POST /v1/tts`, default) and `google` (Google Translate's unofficial `translate_tts` endpoint, kept as a
   fallback). Both proxied through our own `/tts` server route so the browser can fetch audio same-origin
   with a plain GET regardless of which is selected; server holds the current choice in memory, resets to
   `local` on restart. Requires the local engine running separately
   (`uvicorn tts_engine.app:app`, see `D:\Work Space\Code Study\work-shop\2026\tts-engine-project`) for the
   `local` option to work. Alternatives considered and rejected: Google Cloud TTS / Azure TTS (both need
   paid API keys).
2. **Gift streak collapsing**: only broadcast a gift event once `repeatEnd === 1` for streakable gifts
   (`gift.type === 1`), to avoid one card per tap during a held-down gift streak.
3. **Repeat flood / Pattern collapse scope**: both only mute TTS — chat cards always render every message
   unfiltered. Two independent mechanisms that used to share threshold 3 by coincidence, since diverged:
   - **Repeat flood**: per-viewer identical-Comment repeat >3 in a row → stop reading repeats
   - **Pattern collapse**: in-Comment repeated pattern (chars or short substrings), 3+ reps in a row,
     collapsed before speaking — to 2 reps if the repeat spans the whole Comment, to 1 rep (the plain
     word) if it's trailing elongation stuck onto a real word (e.g. "เก่งมากกกกกกก" → "เก่งมาก")
4. **Blocked-word list**: `widgets/chat/chat.js` (moved here when `overlay.html` was split into the
   current widget-per-page structure — no longer inline in `overlay.html`, which has since been
   deleted). Hardcoded regex for `หี` + optional tone mark when it's the whole syllable, plus `แตด`;
   plus a standalone-word match for "เกย์"/"เก"/"gay" in any casing (including single-letter-spaced
   evasion like "เ ก"/"G A Y"); plus any Comment containing a "+" character. All never spoken, always
   still shown in chat.
5. **Gibberish spam**: a Comment made of a short chunk repeated 3+ times with *inconsistent* spacing
   between reps (e.g. "ตุก จะจะ ตุก จี๊ ๆ ๆ ตุก จะ จะ ตุก จี๊ ๆ ๆ ...") can't be cleanly collapsed like
   Pattern collapse above, since the reps aren't literally identical — the whole Comment is suppressed
   from TTS instead, same as a Blocked word.
6. **TTS speed**: playback rate for spoken TTS, same server-held/panel-controlled/WS-synced pattern as
   TTS provider above (`ttsSpeed` in `server.js`, in-memory, resets to 1.5 on restart).
7. **Member joins**: shown as cards, deliberately never read aloud.
8. **Config**: `.env` + `dotenv`, no config file beyond that; `MOCK_MODE` for local testing without a live
   TikTok session.

## Out of scope (explicit non-goals)

- Multi-room / multi-streamer support
- Persisted history (everything is in-memory/localStorage, resets on refresh)
- Paid TTS providers

## Not yet implemented (open, not a non-goal)

- Viewer count / like count / question events — likely to be added incrementally, same pattern as
  Gift and Member join (pick one, confirm real event field names via debug logging, wire up server + overlay)

## Session stats summary (implemented)

9. **Trigger**: manual only — a button in the panel widget sends `show-summary` over WS; the server
   snapshots its in-memory counters and broadcasts a `summary` message. No auto-display on `DISCONNECTED`
   (rejected for now — can revisit if the streamer wants it).
10. **Storage**: plain counters on the server (`stats` object in `server.js`), incremented from inside
   `broadcast()` so both mock and real event paths update them for free. Resets on server restart, same
   as everything else — no file/db persistence (see non-goals).
11. **Gift value**: shown in diamonds (`gift.diamondCount * repeatCount`), not baht — diamonds is what the
   TikTok event actually reports; converting to baht would need a rate that isn't available server-side.

## BRB Timer (implemented)

12. **Sync model**: server holds `endsAt` (an epoch timestamp), not a ticking counter — clients compute
    their own remaining time from `endsAt - Date.now()` on a local interval. WS traffic is limited to
    control events (start/pause/resume/reset/message), not a per-second tick broadcast.
13. **Sync-on-connect**: every new WS connection immediately receives the current `timerState` — this is
    what makes reloading `/timer` (or opening `/panel` late) resume mid-countdown instead of resetting to
    zero. Verified: a client joining ~2s after a 10s countdown started receives `endsAt` reflecting ~8s
    remaining, not the original 10s.
14. **Expiry**: a single server-side `setInterval` (250ms) flips `running` → `ended`, so all clients agree
    on the moment it ended instead of each browser source deciding independently.
15. **Trigger surface**: folded into the existing `/panel` (not a separate control page) — same reasoning
    as `show-summary`: one tab for the streamer to watch during a live. Duration presets (1/5/10/15 min)
    start immediately on click; a custom minute/second input pairs with a separate Start button.
16. **Storage**: `timerState` in `server.js`, in-memory, resets on server restart — same non-goal as
    everything else in this project.
