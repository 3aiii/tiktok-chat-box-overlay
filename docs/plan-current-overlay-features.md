# Plan: TikTok live overlay — chat, gift, member, TTS

## Goal

Give a Thai-speaking streamer a browser-source overlay that shows live chat/gift/join activity and reads
chat comments aloud in Thai, without paid APIs.

## Decisions to grill

1. **TTS provider**: use Google Translate's unofficial `translate_tts` endpoint (free, no key), proxied
   through our own `/tts` server route to dodge Chrome's ORB block. Alternative considered and rejected:
   Google Cloud TTS / Azure TTS (both need paid API keys).
2. **Gift streak collapsing**: only broadcast a gift event once `repeatEnd === 1` for streakable gifts
   (`gift.type === 1`), to avoid one card per tap during a held-down gift streak.
3. **Repeat flood / Pattern collapse scope**: both only mute TTS — chat cards always render every message
   unfiltered. Two independent mechanisms sharing threshold 3 by coincidence, not by design:
   - **Repeat flood**: per-viewer identical-Comment repeat >3 in a row → stop reading repeats
   - **Pattern collapse**: in-Comment repeated pattern (chars or short substrings) collapsed to 3 reps before speaking
4. **Blocked-word list**: hardcoded regex in `overlay.html` (`หี` + optional tone mark when it's the whole
   syllable, plus `แตด`) — never spoken, always still shown in chat.
5. **Member joins**: shown as cards, deliberately never read aloud.
6. **Config**: `.env` + `dotenv`, no config file beyond that; `MOCK_MODE` for local testing without a live
   TikTok session.

## Out of scope (explicit non-goals)

- Multi-room / multi-streamer support
- Persisted history (everything is in-memory/localStorage, resets on refresh)
- Paid TTS providers

## Not yet implemented (open, not a non-goal)

- Viewer count / like count / question events — likely to be added incrementally, same pattern as
  Gift and Member join (pick one, confirm real event field names via debug logging, wire up server + overlay)
