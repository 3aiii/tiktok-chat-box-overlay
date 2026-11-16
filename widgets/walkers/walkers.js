// Walkers (beta): a viewer whose Gifts today add up to `coins` gets a little
// cat wandering along the bottom of the screen -- its coat picked from their
// name, their profile picture and name on a tag above, their Comments in a
// speech bubble from then on. A Gift makes their cat jump and pops the Gift
// picture out of it; the more coins they've sent today, the bigger it gets.
// The top gifter of this live (by TikTok room) wears the crown. A cat stays
// on screen for the rest of the stream -- going quiet doesn't send it away.
// Totals come from Gift history, so reloading the overlay or restarting the
// server mid-stream doesn't reset anyone.
//
// Query params:
//   coins   -- Gift coins a viewer needs today before their cat appears
//              (default 100; 0 = everyone who chats gets one)
//   baht    -- EasyDonate baht a donor needs today for a cat (default 40).
//              Donors are their own cats -- their EasyDonate name can't be
//              matched to a TikTok account -- and their message is the bubble.
//   max     -- most walkers on screen at once (5-80, default 30); past that
//              the one quiet the longest leaves to make room
//   style   -- "sprite" (default): Carysaurus' pixel-art black cat, recoloured;
//              "svg": the cats drawn in code below
//   size    -- cat height in px (32-192; sprite default 72, snapped to half
//              steps of the 48px art -- 48 / 72 / 96 / 120 / 144 -- so the
//              pixels stay even; svg default 56)
//   bottom  -- px between the walkers' feet and the screen edge (default 16)
//   joins   -- 1 also spawns viewers who just joined (busy rooms get crowded)
//   demo    -- 1 spawns fake viewers who chat and gift, no server connection

const params = new URLSearchParams(location.search);
const MIN_COINS = params.has("coins") ? Math.max(0, Number(params.get("coins")) || 0) : 100;
const MIN_BAHT = params.has("baht") ? Math.max(0, Number(params.get("baht")) || 0) : 40;
const DONOR_PREFIX = "donate:";
const donorKey = (name) => DONOR_PREFIX + String(name || "").trim().toLowerCase();
const isDonor = (key) => key.startsWith(DONOR_PREFIX);
const clamp = (v, lo, hi, dflt) => (Number.isFinite(v) && v > 0 ? Math.min(hi, Math.max(lo, v)) : dflt);
const MAX_WALKERS = clamp(Number(params.get("max")), 5, 80, 30);
const STYLE = params.get("style") === "svg" ? "svg" : "sprite";
// Carysaurus "Black Cat" (free pack): one strip per animation, 48px frames,
// facing right -- walking left just mirrors it.
const SPRITES = {
  frame: 48,
  // head: per frame, how far (art px) the head sits from its usual spot
  // (ears at x 29-38, y 23), measured off the art, so the crown rides along
  idle: { url: "/widgets/walkers/sprites/black-idle.png", frames: 12, ms: 130, head: [[0, 0], [0, 0], [0, 0], [0, 0], [0, 1], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 1], [0, 0]] },
  run: { url: "/widgets/walkers/sprites/black-run.png", frames: 6, ms: 90, head: [[0, 0], [0, -1], [1, -1], [1, -1], [1, 0], [0, 0]] },
};

// Pixel-art crown in the cat's own palette (its gold eyes, magenta, outline),
// drawn at the same pixel size so it looks like part of the sprite. The
// outline is traced around the shape rather than typed in.
const CROWN_PIXELS = [
  "g...h...g",
  "gg.ghg.gg",
  "ggggggggg",
  "ghggrgghg",
  "sssssssss",
];
const CROWN_COLORS = { g: "#fabc13", h: "#ffe27a", s: "#c09111", r: "#8c1f56", o: "#131313" };
const CROWN_SVG = (() => {
  const w = CROWN_PIXELS[0].length + 2;
  const h = CROWN_PIXELS.length + 2;
  const at = (x, y) => CROWN_PIXELS[y - 1]?.[x - 1] ?? ".";
  let rects = "";
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let c = at(x, y);
      if (c === "." && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => at(x + dx, y + dy) !== ".")) c = "o";
      if (c !== ".") rects += `<rect x="${x}" y="${y}" width="1.02" height="1.02" fill="${CROWN_COLORS[c]}"/>`;
    }
  }
  return `<svg class="pixel-crown" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges" aria-hidden="true">${rects}</svg>`;
})();
// The art only comes in black; these filters turn it into other coats
// (black, ginger, orange, grey, brown, cream). "brightness(1)" rather than
// "none" so a drop-shadow can still be appended.
const SPRITE_COATS = [
  "brightness(1)",
  "brightness(2.2) sepia(1) saturate(4) hue-rotate(-15deg)",
  "brightness(3) sepia(1) saturate(2.5) hue-rotate(-20deg)",
  "brightness(4.5) grayscale(1)",
  "brightness(2.6) sepia(1) saturate(1.2)",
  "invert(0.85) sepia(0.3)",
];
const SIZE =
  STYLE === "sprite"
    ? (SPRITES.frame / 2) * Math.max(2, Math.round(clamp(Number(params.get("size")), 32, 192, 72) / (SPRITES.frame / 2)))
    : clamp(Number(params.get("size")), 32, 192, 56);
const CAT_W = STYLE === "sprite" ? SIZE : SIZE * 1.385; // the SVG cat is 72 x 52
const SPAWN_JOINS = params.get("joins") === "1";
const DEMO = params.get("demo") === "1";
const BUBBLE_MS = 6000;
const BUBBLE_MAX_CHARS = 80;
// Coins today -> body scale: 10% bigger for every 100 coins past the first
// 100 (200 = 1.1x, 300 = 1.2x ...), capped so a whale doesn't cover the stream.
const SCALE_STEP_COINS = 100;
const SCALE_PER_STEP = 0.1;
const MAX_SCALE = 1.5;

const ground = document.getElementById("ground");
ground.style.setProperty("--ground-offset", `${Number(params.get("bottom")) || 16}px`);

const walkers = new Map(); // user key -> walker
const coinsToday = new Map(); // user key -> Gift coins since local midnight
let coinsDay = new Date().toDateString();
const coinsThisLive = new Map(); // user key -> Gift coins in the current room
let roomId = null; // unknown until the server's connection state arrives
let recentGifts = []; // Gift history of the last day, to rebuild a room's totals
const lastData = new Map(); // user key -> latest event, to respawn the crown holder
let crownKey = null;

const viewerKey = (data) => data.user || data.nickname;
// Today's coins, or this live's -- a live running past midnight shouldn't
// send its regulars' cats away when the day rolls over.
const eligible = (key) =>
  isDonor(key)
    ? (bahtToday.get(key) || 0) >= MIN_BAHT
    : Math.max(coinsToday.get(key) || 0, coinsThisLive.get(key) || 0) >= MIN_COINS;
const bahtToday = new Map(); // donor key -> EasyDonate baht since local midnight

// A new day starts everyone from zero, like the Gift history files do.
function rollDay() {
  const today = new Date().toDateString();
  if (today === coinsDay) return;
  coinsDay = today;
  coinsToday.clear();
  bahtToday.clear();
}

// Real cat coats rather than any hue -- a green cat looks wrong.
const COATS = [
  { coat: "#f2a65a", shade: "#cf7a33", belly: "#fff1dc" }, // orange
  { coat: "#9ba4ae", shade: "#6f7882", belly: "#eef1f3" }, // grey
  { coat: "#33323a", shade: "#1c1b20", belly: "#33323a", eye: "#e8c547" }, // black
  { coat: "#f8f6f1", shade: "#d6cfc3", belly: "#ffffff", eye: "#4f8fd8" }, // white
  { coat: "#efd6b0", shade: "#cfae80", belly: "#fff8ec" }, // cream
  { coat: "#8d5f3d", shade: "#5f3e26", belly: "#ead5bf" }, // brown
];

// Looks random, but the same viewer gets the same cat every time they come back.
function hashOf(key) {
  let h = 2166136261;
  for (const ch of key) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
  return h >>> 0;
}

// Side-on cat facing right, 72 x 52. Far legs are drawn behind the body in
// the shade colour; class "b" marks the leg pair that swings opposite.
const CAT_SVG = `
  <svg class="cat" viewBox="0 0 72 52" aria-hidden="true">
    <g class="tail"><path d="M14 29 C 5 27, 2 15, 7 7" /></g>
    <rect class="leg shade" x="16" y="33" width="5" height="15" rx="2.5" />
    <rect class="leg b shade" x="39" y="33" width="5" height="15" rx="2.5" />
    <ellipse class="coat" cx="30" cy="30" rx="19" ry="11" />
    <ellipse class="belly" cx="33" cy="35" rx="12" ry="5" />
    <path class="stripe" d="M22 20 q2 4 0 8 M29 19 q2 4 0 8 M36 20 q2 4 0 8" />
    <rect class="leg b coat" x="21" y="33" width="5" height="15" rx="2.5" />
    <rect class="leg coat" x="44" y="33" width="5" height="15" rx="2.5" />
    <g class="head">
      <path class="coat" d="M44 13 L46 1 L54 8 Z" />
      <path class="coat" d="M55 8 L63 1 L64 13 Z" />
      <path class="ear-in" d="M46.5 10 L47.5 4 L51.5 7.5 Z" />
      <path class="ear-in" d="M57.5 7.5 L61.5 4 L62 10 Z" />
      <circle class="coat" cx="54" cy="17" r="11" />
      <path class="stripe" d="M51 7.5 l1 3 M54 7 v3.5 M57 7.5 l-1 3" />
      <g class="eyes">
        <ellipse class="eye" cx="49.5" cy="16" rx="1.7" ry="2.5" />
        <ellipse class="eye" cx="58.5" cy="16" rx="1.7" ry="2.5" />
      </g>
      <path class="nose" d="M52.6 20 h2.8 l-1.4 1.7 Z" />
      <path class="line" d="M54 21.7 q-1 1.6 -2.4 0.8 M54 21.7 q1 1.6 2.4 0.8" />
      <path class="whisker" d="M47 21 l-7 -1 M47 22.5 l-7 1 M61 21 l7 -1 M61 22.5 l7 1" />
    </g>
  </svg>`;

const random = (lo, hi) => lo + Math.random() * (hi - lo);
const screenWidth = () => window.innerWidth;

function buildWalker(key, data) {
  const node = document.createElement("div");
  node.className = `walker ${STYLE}-cat`;
  node.style.setProperty("--size", `${SIZE}px`);
  const hash = hashOf(key);
  if (STYLE === "sprite") return buildSpriteWalker(key, data, node, hash);
  const coat = COATS[hash % COATS.length];
  node.style.setProperty("--coat", coat.coat);
  node.style.setProperty("--shade", coat.shade);
  node.style.setProperty("--belly", coat.belly);
  if (coat.eye) node.style.setProperty("--eye", coat.eye);
  node.style.setProperty("--blink-delay", `-${(hash % 45) / 10}s`); // don't all blink in sync
  if ((hash >> 8) % 3 === 0 && coat.coat !== "#33323a") node.classList.add("tabby");
  return finishWalker(key, data, node, CAT_SVG);
}

function buildSpriteWalker(key, data, node, hash) {
  node.style.setProperty("--coat-filter", SPRITE_COATS[hash % SPRITE_COATS.length]);
  const w = finishWalker(key, data, node, '<div class="sprite"></div>');
  w.sprite = node.querySelector(".sprite");
  w.speed *= 1.8 * (SIZE / 96); // it's a run cycle -- slower looks like moonwalking
  w.phase = hash % 1000; // so a crowd doesn't step in unison
  w.anim = null;
  w.frame = -1;
  setFrame(w, "idle", performance.now());
  return w;
}

// Show the frame of `anim` due at time `now`. Only touches the style when
// the frame actually changes -- this runs every animation frame.
function setFrame(w, anim, now) {
  const a = SPRITES[anim];
  if (anim !== w.anim) {
    w.anim = anim;
    w.frame = -1;
    w.sprite.style.backgroundImage = `url("${a.url}")`;
    w.sprite.style.backgroundSize = `${a.frames * SIZE}px ${SIZE}px`;
  }
  const frame = Math.floor((now + w.phase) / a.ms) % a.frames;
  if (frame === w.frame) return;
  w.frame = frame;
  w.sprite.style.backgroundPosition = `${-frame * SIZE}px 0`;
  const [hx, hy] = a.head[frame];
  w.node.style.setProperty("--head-x", hx);
  w.node.style.setProperty("--head-y", hy);
}

function finishWalker(key, data, node, catHtml) {
  node.innerHTML = `
    <div class="grow"><div class="hop"><div class="flip"><div class="body">${catHtml}</div></div></div></div>
    <div class="name"><span></span></div>
    <div class="bubble"></div>`;
  const fromLeft = Math.random() < 0.5;
  const w = {
    key,
    node,
    nameTag: node.querySelector(".name"),
    nameEl: node.querySelector(".name span"),
    bubble: node.querySelector(".bubble"),
    bubbleTimer: 0,
    x: fromLeft ? -CAT_W * 1.5 : screenWidth() + CAT_W * 0.5,
    target: random(CAT_W, screenWidth() - CAT_W * 2),
    speed: random(45, 85), // px per second
    restUntil: 0,
    lastSeen: Date.now(),
    avatarUrl: "",
  };
  setIdentity(w, data);
  node.style.transform = `translateX(${w.x}px)`;
  ground.appendChild(node);
  return w;
}

function setIdentity(w, data) {
  const name = data.nickname || data.user || "?";
  w.nameEl.textContent = name;
  if (data.avatarUrl && data.avatarUrl !== w.avatarUrl) {
    w.avatarUrl = data.avatarUrl;
    w.nameTag.querySelector("img")?.remove();
    const img = createImg(data.avatarUrl);
    img.onerror = () => img.remove();
    w.nameTag.prepend(img);
  }
}

// The walker for this viewer, spawning one (and evicting the quietest if the
// screen is full) when they don't have one yet.
function walkerFor(data) {
  const key = viewerKey(data);
  if (!key) return null;
  let w = walkers.get(key);
  if (!w) {
    if (walkers.size >= MAX_WALKERS) {
      const candidates = [...walkers.values()].filter((w) => w.key !== crownKey);
      const quietest = candidates.reduce((a, b) => (a.lastSeen <= b.lastSeen ? a : b));
      removeWalker(quietest);
    }
    w = buildWalker(key, data);
    walkers.set(key, w);
  } else {
    setIdentity(w, data);
  }
  w.lastSeen = Date.now();
  return w;
}

function removeWalker(w) {
  walkers.delete(w.key);
  w.node.classList.add("leaving");
  setTimeout(() => w.node.remove(), 700);
}

// text, or a node (a sticker image) in place of it
function say(w, text, node) {
  clearTimeout(w.bubbleTimer);
  if (node) w.bubble.replaceChildren(node);
  else w.bubble.textContent = text.length > BUBBLE_MAX_CHARS ? `${text.slice(0, BUBBLE_MAX_CHARS)}…` : text;
  w.bubble.classList.add("show");
  // stop to talk -- unless still walking in from off-screen
  if (w.x >= 0 && w.x <= screenWidth() - CAT_W) w.restUntil = performance.now() + 2500;
  w.bubbleTimer = setTimeout(() => w.bubble.classList.remove("show"), BUBBLE_MS);
}

function applyScale(w) {
  // Donors grow on the same curve, one step per MIN_BAHT (40 -> 80 -> 120 ...).
  const steps = isDonor(w.key)
    ? Math.max(0, Math.floor((bahtToday.get(w.key) || 0) / Math.max(1, MIN_BAHT)) - 1)
    : Math.max(0, Math.floor((coinsToday.get(w.key) || 0) / SCALE_STEP_COINS) - 1);
  w.node.style.setProperty("--scale", Math.min(MAX_SCALE, 1 + steps * SCALE_PER_STEP).toFixed(2));
}

// One crown, on this live's top gifter. They get a cat even if they've been
// quiet (or the overlay just reloaded), as long as they've reached the coin
// threshold today.
function updateCrown() {
  crownKey = null;
  let best = 0;
  for (const [key, coins] of coinsThisLive) {
    if (coins > best && eligible(key)) [crownKey, best] = [key, coins];
  }
  if (crownKey && !walkers.has(crownKey) && lastData.has(crownKey)) {
    applyScale(walkerFor(lastData.get(crownKey)));
  }
  for (const w of walkers.values()) {
    const wear = w.key === crownKey;
    if (wear === w.node.classList.contains("has-crown")) continue;
    w.node.classList.toggle("has-crown", wear);
    if (wear) {
      const crown = document.createElement("div");
      crown.className = "crown";
      if (STYLE === "sprite") crown.innerHTML = CROWN_SVG;
      else crown.textContent = "👑";
      w.node.querySelector(".body").appendChild(crown);
    } else {
      w.node.querySelector(".crown")?.remove();
    }
  }
}

function bounce(w) {
  // restart the jump even if the last one is still playing
  w.node.classList.remove("jump");
  void w.node.offsetWidth;
  w.node.classList.add("jump");
  setTimeout(() => w.node.classList.remove("jump"), 1500);
}

function celebrate(w, data) {
  applyScale(w);
  updateCrown();
  bounce(w);
  if (data.giftImage) {
    const pop = createImg(data.giftImage, "gift-pop");
    pop.addEventListener("animationend", () => pop.remove());
    w.node.appendChild(pop);
  }
  const times = data.repeatCount > 1 ? ` ×${data.repeatCount}` : "";
  say(w, `ส่ง ${data.giftName || "Gift"}${times} 🎁`);
}

// An EasyDonate donation (polled by the server). Same deal as Gifts: the
// donation that takes today's total past MIN_BAHT brings the cat in.
function handleDonation(data) {
  const key = donorKey(data.name);
  bahtToday.set(key, (bahtToday.get(key) || 0) + (data.amount || 0));
  if (!eligible(key)) return;
  const w = walkerFor({ user: key, nickname: data.name });
  w.nameTag.classList.add("donor");
  applyScale(w);
  bounce(w);
  say(w, data.message || `โดเนท ฿${fmtBaht(data.amount)}`);
}

const fmtBaht = (n) => Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 2 });

function handle(data) {
  if (data.type === "tiktok-connection-state") return setRoom(data.roomId);
  rollDay();
  if (data.type === "donation") return handleDonation(data);
  const key = viewerKey(data);
  if (!key) return;
  if (data.nickname) lastData.set(key, data);
  if (data.type === "gift") {
    coinsToday.set(key, (coinsToday.get(key) || 0) + (data.diamondCount || 0));
    coinsThisLive.set(key, (coinsThisLive.get(key) || 0) + (data.diamondCount || 0));
    if (!eligible(key)) return; // not there yet -- the cat appears on the Gift that crosses it
    const w = walkerFor(data);
    celebrate(w, data);
    return;
  }
  if (!eligible(key)) return; // chatting alone doesn't earn a cat
  if (data.type === "chat") {
    if (data.isSongRequest) return; // "/music <link>" isn't worth a bubble
    const w = walkerFor(data);
    applyScale(w);
    updateCrown();
    if (data.comment) say(w, data.comment);
  } else if (data.type === "emote") {
    const w = walkerFor(data);
    applyScale(w);
    updateCrown();
    const img = (data.emoteImages || [])[0];
    if (img) say(w, "", createImg(img));
  } else if (data.type === "member" && SPAWN_JOINS) {
    applyScale(walkerFor(data));
    updateCrown();
  }
}

// The last day of Gift history: today's totals (who has earned a cat) now,
// and this live's totals once the server says which room we're in. A day
// back rather than from midnight, so a live that started before midnight
// still counts in full for the crown.
async function loadRecentGifts() {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  try {
    const res = await fetch("/api/donations-today");
    for (const d of (await res.json()).donations || []) {
      const key = donorKey(d.name);
      bahtToday.set(key, (bahtToday.get(key) || 0) + (d.amount || 0));
    }
  } catch (err) {
    console.warn("[walkers] couldn't load today's donations:", err.message);
  }
  try {
    const res = await fetch(`/api/gift-events?from=${Date.now() - 24 * 60 * 60 * 1000}&to=${Date.now() + 1000}`);
    recentGifts = (await res.json()).events || [];
  } catch (err) {
    console.warn("[walkers] couldn't load recent Gifts:", err.message);
  }
  for (const e of recentGifts) {
    const key = viewerKey(e);
    if (!key) continue;
    if (e.nickname) lastData.set(key, e);
    if (e.t >= midnight.getTime()) coinsToday.set(key, (coinsToday.get(key) || 0) + (e.diamondCount || 0));
  }
}

// A new room is a new live: rebuild its totals from history (non-empty when
// the overlay or server restarted mid-live) and hand the crown over.
function setRoom(id) {
  if (!id || id === roomId) return;
  roomId = id;
  coinsThisLive.clear();
  for (const e of recentGifts) {
    const key = viewerKey(e);
    if (key && e.roomId === id) coinsThisLive.set(key, (coinsThisLive.get(key) || 0) + (e.diamondCount || 0));
  }
  updateCrown();
}

// ---------------------------------------------------------------- movement

// Walk to a random spot, stand around a bit, pick another. Each walker only
// writes its transform while it's actually moving.
let lastFrame = performance.now();
function tick(now) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000); // a hidden tab shouldn't teleport everyone
  lastFrame = now;
  const maxX = screenWidth() - CAT_W;
  for (const w of walkers.values()) {
    const resting = now < w.restUntil;
    const gap = w.target - w.x;
    if (!resting && Math.abs(gap) > 1) {
      const step = Math.sign(gap) * Math.min(Math.abs(gap), w.speed * dt);
      w.x += step;
      w.node.classList.add("walking");
      w.node.classList.toggle("facing-left", step < 0);
      w.node.style.transform = `translateX(${w.x.toFixed(1)}px)`;
      if (w.sprite) setFrame(w, "run", now);
    } else {
      w.node.classList.remove("walking");
      if (w.sprite) setFrame(w, "idle", now);
      if (!resting) {
        w.restUntil = now + random(800, 4500);
        w.target = Math.max(0, Math.min(maxX, w.x + random(-500, 500)));
      }
    }
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);


// ---------------------------------------------------------------- start

if (DEMO) {
  setRoom("demo");
  const names = ["PloyPloy", "มะปราง", "Toy Chan", "บอสใหญ่", "nn.min", "ฟ้าใส", "kiki_88", "น้ำผึ้ง", "โอ๊ต", "Night Owl 🦉", "พิม 🌸", "ไก่ เกมเมอร์"];
  const lines = ["สวัสดีค่าพี่", "มาแล้วว", "5555 ตลกมาก", "เพลงนี้เพราะมาก", "พี่กินข้าวยัง", "❤️❤️❤️", "ไลฟ์ถึงกี่โมงครับ", "สู้ๆนะ"];
  const gifts = [["Rose", 1], ["Finger Heart", 5], ["Perfume", 20], ["Hand Hearts", 100], ["Galaxy", 1000]];
  const ROSE = "https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/968820bc85e274713c795a6aef3f7c67~tplv-obj.png";
  const viewer = () => {
    const nickname = names[Math.floor(Math.random() * names.length)];
    return { user: nickname, nickname, avatarUrl: `https://i.pravatar.cc/150?u=${encodeURIComponent(nickname)}` };
  };
  setInterval(() => handle({ type: "chat", ...viewer(), comment: lines[Math.floor(Math.random() * lines.length)] }), 1800);
  setInterval(() => {
    const [giftName, diamonds] = gifts[Math.floor(Math.random() ** 2 * gifts.length)];
    const repeatCount = 1 + Math.floor(Math.random() * 5);
    handle({ type: "gift", ...viewer(), giftName, giftImage: ROSE, repeatCount, diamondCount: diamonds * repeatCount });
  }, 2000); // often enough that someone reaches the coin threshold quickly
  const donors = ["แจนยัวมาย", "Skyfall", "ชิ", "น้องโปรยปลา"];
  const notes = ["เน็ตอย่าแกง", "สู้ๆนะคะ", "", "ค่าขนมน้องแมว"];
  setInterval(() => {
    const i = Math.floor(Math.random() * donors.length);
    handle({ type: "donation", name: donors[i], amount: [20, 40, 50, 100][Math.floor(Math.random() * 4)], message: notes[i] });
  }, 6000);
} else {
  // History first, so the first Comments after a reload already know who
  // qualifies, and the room state (sent on connect) can rebuild this live.
  loadRecentGifts().then(() => connectWS(handle, attachStatusIndicator()));
}
