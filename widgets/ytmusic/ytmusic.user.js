// ==UserScript==
// @name         TikTok Live Reader - YouTube Music bridge
// @namespace    tiktok-live-reader
// @version      1.1.0
// @description  Sends the track playing on music.youtube.com (and what's queued next) to the local overlay server for the /ytmusic widget.
// @match        https://music.youtube.com/*
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  "use strict";

  // Rewritten by server.js to match its HTTP_PORT when installed from
  // http://localhost:<port>/ytmusic.user.js.
  const SERVER = "http://localhost:8080";
  const POLL_MS = 1000;
  // Re-send even when nothing changed, so the server can tell the tab is still
  // open (it drops the card after ~2 min of silence) and the widget's progress
  // bar gets re-anchored against drift.
  const HEARTBEAT_MS = 5000;
  // A jump this far from where playback should be is a seek, worth sending
  // right away instead of waiting for the heartbeat.
  const SEEK_THRESHOLD_SEC = 2;
  const MAX_QUEUE = 20;

  const text = (root, selector) => {
    const el = root && root.querySelector(selector);
    return el ? (el.getAttribute("title") || el.textContent || "").trim() : "";
  };

  // Lazy-loaded thumbnails sit on a 1x1 data: placeholder until scrolled into
  // view; those are worse than no image at all.
  const imgSrc = (root, selector) => {
    const el = root && root.querySelector(selector);
    const src = el ? el.currentSrc || el.src || "" : "";
    return src.startsWith("http") ? src : "";
  };

  function readTrack() {
    // Media Session is what YT Music hands to Windows' media flyout, so it's
    // the most stable source; the player bar DOM is the fallback.
    const md = navigator.mediaSession && navigator.mediaSession.metadata;
    if (md && md.title) {
      const artwork = md.artwork && md.artwork.length ? md.artwork[md.artwork.length - 1].src : "";
      return { title: md.title, artist: md.artist || "", album: md.album || "", artwork };
    }
    const bar = document.querySelector("ytmusic-player-bar");
    const title = text(bar, ".title");
    if (!title) return null;
    // Byline reads "Artist • Album • Year".
    const [artist = "", album = ""] = text(bar, ".byline").split("•").map((s) => s.trim());
    return { title, artist, album, artwork: imgSrc(bar, "img.image") };
  }

  function readQueue(track) {
    // A song with a video counterpart renders both versions, with the inactive
    // one tucked under #counterpart-renderer -- skip those or every such song
    // would show up twice.
    const items = [...document.querySelectorAll("ytmusic-player-queue ytmusic-player-queue-item")].filter(
      (el) => !el.closest("#counterpart-renderer")
    );
    let current = items.findIndex((el) => el.hasAttribute("selected"));
    if (current === -1 && track) {
      current = items.findIndex((el) => text(el, ".song-title") === track.title);
    }
    // Without knowing where we are in the queue, "next" would be a guess.
    if (current === -1) return [];
    return items.slice(current + 1, current + 1 + MAX_QUEUE).map((el) => ({
      title: text(el, ".song-title"),
      artist: text(el, ".byline"),
      duration: text(el, ".duration"),
      artwork: imgSrc(el, "img"),
    })).filter((item) => item.title);
  }

  function snapshot() {
    const video = document.querySelector("video");
    const track = video ? readTrack() : null;
    return {
      track,
      paused: !video || video.paused,
      positionSec: video && isFinite(video.currentTime) ? video.currentTime : 0,
      durationSec: video && isFinite(video.duration) ? video.duration : 0,
      queue: track ? readQueue(track) : [],
    };
  }

  let lastSignature = "";
  let lastSentAt = 0;
  let lastSent = null;

  function send(state) {
    GM_xmlhttpRequest({
      method: "POST",
      url: `${SERVER}/api/ytmusic`,
      headers: { "Content-Type": "application/json" },
      data: JSON.stringify(state),
      timeout: 3000,
      // The overlay server not running is the normal case outside a stream,
      // so stay quiet about it.
      onerror: () => {},
      ontimeout: () => {},
    });
  }

  function tick() {
    const state = snapshot();
    const now = Date.now();
    const { positionSec, ...rest } = state;
    const signature = JSON.stringify(rest);

    let seeked = false;
    if (lastSent && !lastSent.paused && !state.paused) {
      const expected = lastSent.positionSec + (now - lastSentAt) / 1000;
      seeked = Math.abs(positionSec - expected) > SEEK_THRESHOLD_SEC;
    }

    if (signature !== lastSignature || seeked || now - lastSentAt >= HEARTBEAT_MS) {
      send(state);
      lastSignature = signature;
      lastSentAt = now;
      lastSent = state;
    }
  }

  // Chrome throttles timers in background tabs (down to once a minute after a
  // few minutes hidden), so the interval alone goes quiet whenever the YT
  // Music tab isn't the one on screen. Media events keep firing while audio
  // plays regardless, so they drive updates too. Media events don't bubble,
  // hence capture on document, which also survives the <video> being swapped.
  let lastTickAt = 0;
  function throttledTick() {
    const now = Date.now();
    if (now - lastTickAt < POLL_MS - 100) return;
    lastTickAt = now;
    tick();
  }
  setInterval(throttledTick, POLL_MS);
  document.addEventListener("timeupdate", throttledTick, true);
  // State changes go out immediately; tick() itself skips unchanged state.
  for (const type of ["play", "pause", "seeked", "loadedmetadata", "ended"]) {
    document.addEventListener(type, tick, true);
  }

  // Lets the card hide right away instead of waiting out the server's
  // stale timeout. Best effort -- a crashed tab never gets here.
  window.addEventListener("pagehide", () => send({ closed: true }));
})();
