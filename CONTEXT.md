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

**Spoken nickname**:
The form of a viewer's nickname that TTS reads, distinct from the nickname shown on the card, which is
always the raw one. Digits and symbols are dropped so a handle isn't spelled out one character at a
time. One exception: a nickname that is words with a run of digits stuck on the end ("user4512512512",
"user_4512512512", "Toy Chan 12345") keeps the first 3 of them and is read as "user451" -- dropping them
entirely would make every default handle sound like the same viewer called "user". Digits scattered
through a nickname rather than trailing it ("daweqwe78874515q5e1878q122zxc") are still dropped in full. A nickname with nothing but digits and symbols has no
Spoken nickname, and the Comment is read on its own.
_Avoid_: Clean name, display name

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

**Song request**:
A YouTube link someone wants played on stream, asked for with the `/music` command. Usually a viewer's,
arriving as a Comment -- and when it does, it is a Comment first and stays one, shown on the chat overlay
like any other; what makes it a Song request is that it *additionally* enters a queue. The streamer can
make one too, which is how a Filler song gets in. A bare link is not a request: without the command it is
an ordinary Comment, because viewers paste links they are talking about far more often than links they
want played. The command alone isn't enough either: the video has to be embeddable, within the length cap,
and playable in the streamer's region, or the request is refused rather than queued. A Song request never
reaches the stream's audio on its own -- the streamer approves each one first, though their own are
approved the moment they're made.
_Avoid_: Song, track, YouTube link, DJ request

**Filler song**:
A Song request made by the streamer and marked to replay, so it fills the air whenever the queue of
viewer requests runs dry. It is not a separate list with its own rules -- it goes through exactly the
same link check and approval as any other Song request, and differs only in who asked for it and that
playing it doesn't consume it. The distinction is about *who asked and whether it repeats*, never about
a second way into the stream's audio.
_Avoid_: Playlist, fallback playlist, backup track, default song

## Relationships

- A **Gift streak** resolves into exactly one Gift announcement
- A **Repeat flood**, a **Pattern collapse**, a **Gibberish spam**, and a **Blocked word** all suppress speech only — none hides a Comment or a Gift card
- The **TTS toggle**, when off, suppresses all speech regardless of Repeat flood, Pattern collapse, Gibberish spam, or Blocked word state
- A **Song request** is still a Comment — being one doesn't hide it from the chat overlay, but it is never spoken: its body is a URL, which TTS reads out one character at a time
- A **Song request** is refused at the moment it's made (not silently dropped later) when the video fails any playability check
- A viewer holds at most one **Song request** awaiting approval at a time. This is a silent server-side filter, not a rule viewers are told about — a viewer who pastes more links simply has the extras dropped, and is never notified
- A refused **Song request** is refused silently. Nothing is shown, spoken, or sent back to the asker — the room's chat is read-only to us, so there is no channel to answer on even if we wanted one
- The queue is the streamer's view, not the audience's. What the audience sees is only what is currently playing
- The same video can't sit in the queue twice, or be re-requested right after playing — a second asker is refused, not queued behind the first
- No **Song request** becomes audio without an explicit streamer approval, no matter who sent it
- Playback never begins on its own either. An idle session stays silent until the streamer starts it, even with **Filler songs** waiting — approving a request counts as starting it
- A **Filler song** is only ever heard when no approved viewer **Song request** is waiting — a viewer request always wins
- Playing a **Filler song** doesn't remove it; playing a viewer **Song request** does
- The queue of **Song requests** dies with the server; **Filler songs** outlive it. A viewer's request is worth minutes and is easily re-made, while a Filler song is something the streamer curated and would resent rebuilding every stream
- A **Song request** approved before a restart is not honoured after one — approval was given in a moment that no longer exists
- A **Song request** and the **TTS toggle** are independent — a playing song doesn't mute TTS, and TTS doesn't pause a song. Streamers who take Song requests turn TTS off themselves; nothing enforces it
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
