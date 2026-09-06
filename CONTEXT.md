# tiktok-live-reader

A browser-source overlay that connects to a TikTok LIVE room and turns chat activity into on-screen cards and Thai text-to-speech.

## Language

**Comment**:
A chat message a viewer sends during the live.
_Avoid_: Message, text

**Gift**:
A paid item a viewer sends to the streamer, shown as its own card, distinct from a Comment.
_Avoid_: Donation

**Gift streak**:
A run of the same Gift sent repeatedly by holding the send button; collapses into a single announcement once it ends rather than one per tap.
_Avoid_: Combo, repeat

**Member join**:
The event of a viewer entering the room. Shown as a card, never spoken aloud.
_Avoid_: Viewer join, entrance

**Repeat flood**:
The same viewer sending the identical Comment more than 3 times in a row; suppressed from TTS (but still shown) from the 4th occurrence onward. A per-viewer, cross-Comment concept.
_Avoid_: Spam repeat, flood, duplicate

**Pattern collapse**:
A single Comment containing a character or short substring repeated 3+ times in a row (e.g. "####",
"#$@#$@#$@#$@", "เก่งมากกกกกกก"); trimmed before being spoken, never before being shown. Two cases,
trimmed to a different length depending on where the repeat sits:
- the repeat spans the *whole* Comment (starts at its first character, e.g. "5555555555", "สวัสดี
  สวัสดี สวัสดี") → trimmed to 2 reps
- the repeat is *trailing elongation stuck onto a real word* (e.g. "เก่งมากกกกกกก" → "เก่งมาก",
  "ฮ่าๆๆๆๆๆๆ" → "ฮ่าๆ") → trimmed to 1 rep, i.e. the plain word

A within-one-Comment, cosmetic concept — unrelated to Repeat flood despite the historical coincidence
noted in Flagged ambiguities below.
_Avoid_: Spam collapse, dedup

**Gibberish spam**:
A Comment made of a short chunk repeated 3+ times where the repeats aren't spaced *consistently* (e.g.
"ตุก จะจะ ตุก จี๊ ๆ ๆ ตุก จะ จะ ตุก จี๊ ๆ ๆ ตุก จะจะ ตุก จี๊ ๆ ๆ ตุก จะจะเตร" — "จะจะ" vs "จะ จะ" differ
in spacing between reps). Unlike Pattern collapse, the repeats aren't literally identical so they can't
be cleanly trimmed — the entire Comment is suppressed from TTS instead, same as a Blocked word.
_Avoid_: Combo spam, spam pattern

**Blocked word**:
A word or pattern that, if present in a Comment, prevents that Comment from being spoken — the Comment
is still shown. Beyond a fixed word/pattern list, this also covers two standalone match strategies:
a whole-word match on "เกย์"/"เก"/"gay" in any casing — including when spaced out one letter at a time
to dodge the filter (e.g. "เ ก", "G A Y") — and any Comment containing a "+" character (catches
meaningless digit/symbol strings like "๔๑+๔+๒..." that aren't a repeated pattern, so Gibberish spam
wouldn't catch them either). All suppress-only, same as every other Blocked word match.
_Avoid_: Banned word, filter word

**TTS toggle**:
The on/off control a streamer uses to mute/unmute all spoken output; persists across page refresh.
_Avoid_: Mute button

**TTS speed**:
Playback rate for spoken TTS (1.0 = normal, >1 faster, <1 slower). Server-held state, in-memory only,
resets to 1.5 on restart — same convention as TTS provider below. Switched from the same panel control
group as TTS toggle; synced to every connected client over WS.
_Avoid_: Playback rate, voice speed

**TTS provider**:
Which backend actually synthesizes speech for the `/tts` route: `local` (self-hosted `tts-engine-project`,
default) or `google` (Google Translate's unofficial endpoint, kept as a fallback). Switched from a control
in the panel; server-held state (`ttsProvider` in `server.js`), in-memory only, resets to `local` on server
restart. Distinct from **TTS toggle** — the toggle mutes speech entirely, this only picks which backend
speaks when it's on.
_Avoid_: TTS engine, voice engine

**Session stats summary**:
An on-demand snapshot of total Comments, total Gifts (count + diamonds), unique interacting viewers, and
the top gifter by diamonds, accumulated in-memory since the server started. Shown only when the streamer
clicks "แสดงสรุป" in the panel; there is no auto-display and no persistence across a server restart.
_Avoid_: Stream stats, analytics

**BRB Timer**:
A break countdown shown on its own overlay (`/timer`) and controlled from the panel: preset or custom
duration, start/pause/resume/reset, and a custom message. Server holds the single source of truth
(`timerState`, keyed on `endsAt` rather than a ticking counter) so every connected client — including one
that reloads or joins mid-countdown — computes the same remaining time and stays in sync. Resets to idle
on server restart, no persistence.
_Avoid_: Break screen, intermission timer

## Relationships

- A **Gift streak** resolves into exactly one Gift announcement
- A **Repeat flood**, a **Pattern collapse**, a **Gibberish spam**, and a **Blocked word** all suppress speech only — none hides a Comment or a Gift card
- The **TTS toggle**, when off, suppresses all speech regardless of Repeat flood, Pattern collapse, Gibberish spam, or Blocked word state
- **TTS speed** only changes how fast speech plays — it has no effect on whether a Comment is suppressed by any of the above

## Example dialogue

> **Dev:** "If a viewer's Comment matches a Blocked word, do we still show it in chat?"
> **Domain expert:** "Yes — Blocked word only affects TTS. The Comment card renders exactly as sent."
>
> **Dev:** "What happens to a Gift streak while it's still in progress?"
> **Domain expert:** "Nothing shows yet — we wait for the streak to end, then announce it once as a Gift with a total count."

## Flagged ambiguities

- "Spam" was used loosely to mean both a viewer flooding identical Comments and a single Comment
  containing a repeated character pattern — resolved: these are distinct concepts, **Repeat flood** and
  **Pattern collapse** respectively. They used to share the threshold value 3 by coincidence; that's
  since diverged — Pattern collapse now trims to 2 or 1 reps depending on where the repeat sits, while
  Repeat flood is still >3. Do not assume they're coupled, and do not couple them into one constant.
