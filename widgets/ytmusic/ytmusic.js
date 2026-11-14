// Pill-shaped now-playing card: current track + the single next one.
// Fed by ytmusic-state (pushed from ytmusic.user.js via server.js). Query string:
//   theme -- one of the shared themes; omit for the default dark + orange look
//   next  -- 0 hides the "next" line (default 1)
//   demo  -- 1 shows a fake track so the source can be positioned in OBS
const params = new URLSearchParams(location.search);
const SHOW_NEXT = params.get("next") !== "0";

if (params.get("theme")) applyCardTheme(params.get("theme")); // shared/themes.js

const pillEl = document.getElementById("pill");
const discEl = document.getElementById("disc");
const artImg = document.getElementById("art-img");
const titleEl = document.getElementById("title");
const artistEl = document.getElementById("artist");
const nextEl = document.getElementById("next");
const nextText = document.getElementById("next-text");

let shownTrackKey = null;

artImg.onerror = () => discEl.classList.add("empty");

// A title too long for the pill scrolls as a seamless loop: rest at the start,
// slide one full title-width (plus gap) left, which lands on an identical copy,
// so the next rest looks like the start again.
const MARQUEE_SPEED = 40; // px per second
const MARQUEE_PAUSE_MS = 2500;
let marqueeAnim = null;
let marqueeText = null;

function setTitle(text) {
  if (text === marqueeText) return; // heartbeats re-send the same track; don't restart the scroll
  marqueeText = text;
  layoutTitle();
}

function layoutTitle() {
  if (marqueeAnim) {
    marqueeAnim.cancel();
    marqueeAnim = null;
  }
  titleEl.classList.remove("scrolling");
  titleEl.textContent = marqueeText || "";
  if (titleEl.scrollWidth <= titleEl.clientWidth) return;

  const track = document.createElement("span");
  track.className = "marquee-track";
  const first = document.createElement("span");
  first.textContent = marqueeText;
  const copy = first.cloneNode(true);
  copy.setAttribute("aria-hidden", "true");
  track.append(first, copy);
  titleEl.replaceChildren(track);
  titleEl.classList.add("scrolling");

  const distance = first.offsetWidth; // includes the trailing gap from CSS
  const total = (distance / MARQUEE_SPEED) * 1000 + MARQUEE_PAUSE_MS;
  marqueeAnim = track.animate(
    [
      { transform: "translateX(0)" },
      { transform: "translateX(0)", offset: MARQUEE_PAUSE_MS / total },
      { transform: `translateX(-${distance}px)` },
    ],
    { duration: total, iterations: Infinity, easing: "linear" }
  );
}

// Kanit loads after first paint; measuring with the fallback font would get
// the overflow (and the scroll distance) wrong.
document.fonts.ready.then(() => {
  if (marqueeText) layoutTitle();
});

function render(state) {
  const track = state.active ? state.track : null;

  if (!track) {
    pillEl.classList.remove("show");
    shownTrackKey = null;
    marqueeText = null; // re-measure on return; nothing can be measured while hidden
    return;
  }

  const key = `${track.title}\u0000${track.artist}`;
  if (key !== shownTrackKey) {
    shownTrackKey = key;
    pillEl.classList.remove("swap");
    void pillEl.offsetWidth; // restart the swap animation
    pillEl.classList.add("swap");
  }

  pillEl.classList.add("show");
  pillEl.classList.toggle("paused", Boolean(state.paused));
  setTitle(track.title); // after .show, so the title has a width to measure against
  artistEl.textContent = track.artist;

  if (track.artwork) {
    if (artImg.src !== track.artwork) artImg.src = track.artwork;
    discEl.classList.remove("empty");
  } else {
    artImg.removeAttribute("src");
    discEl.classList.add("empty");
  }

  const next = SHOW_NEXT && state.queue && state.queue[0];
  nextEl.classList.toggle("show", Boolean(next));
  nextText.textContent = next ? (next.artist ? `${next.title} — ${next.artist}` : next.title) : "";
}

if (params.get("demo") === "1") {
  render({
    active: true,
    paused: false,
    // Long on purpose, so the demo also previews the title scroll.
    track: { title: "ชื่อเพลงตัวอย่างที่ยาวเกินการ์ด (Official Music Video) feat. ศิลปินรับเชิญ", artist: "ศิลปินตัวอย่าง", artwork: "" },
    queue: [{ title: "เพลงถัดไป 1", artist: "ศิลปิน A", duration: "3:41" }],
  });
} else {
  const setWsStatus = attachStatusIndicator();
  connectWS((data) => {
    if (data.type !== "ytmusic-state") return;
    render(data);
  }, setWsStatus);
}
