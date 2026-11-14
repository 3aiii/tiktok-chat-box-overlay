// Shared by the streamer-facing pages (Control Room, /gifts, /panel): saved
// settings, the light/dark theme, segmented-button wiring and the toast.
// Loaded in <head>, before first paint, so the page never flashes the wrong
// theme.

// localStorage is shared by the Control Room and the pages it embeds (same
// origin). It can throw (blocked storage, private windows), in which case a
// setting just falls back to its default and doesn't persist.
function readSetting(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeSetting(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // blocked storage
  }
}

// ---- theme: dark unless the streamer switched to light ----
// ("lr-theme" used to default to light; a "light" saved back then is ignored.)
const THEME_KEY = "lr-theme-mode";

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === "light" ? "light" : "dark";
}

function setTheme(theme) {
  applyTheme(theme);
  writeSetting(THEME_KEY, theme);
}

applyTheme(readSetting(THEME_KEY, "dark"));

// ---- diamonds -> baht, set in the Control Room's Settings, read by /gifts ----
const BAHT_RATE_KEY = "lr-baht-rate";
const DEFAULT_BAHT_RATE = 0.18;

function bahtRate() {
  const value = Number(readSetting(BAHT_RATE_KEY, DEFAULT_BAHT_RATE));
  return Number.isFinite(value) ? value : DEFAULT_BAHT_RATE;
}

// Another page (or the embedding Control Room) changed a setting.
window.addEventListener("storage", (event) => {
  if (event.key === THEME_KEY) applyTheme(readSetting(THEME_KEY, "dark"));
});

// ---- segmented buttons (.seg / .choice-grid) ----
// Marks the button whose data-value matches as active.
function setSegActive(group, value) {
  group.querySelectorAll("button[data-value]").forEach((b) => b.classList.toggle("active", b.dataset.value === String(value)));
}

// Calls onPick(value) when a button is clicked, after marking it active.
function bindSeg(group, onPick) {
  group.querySelectorAll("button[data-value]").forEach((btn) => {
    btn.addEventListener("click", () => {
      setSegActive(group, btn.dataset.value);
      onPick(btn.dataset.value);
    });
  });
}

// ---- bottom-center toast, created on first use ----
let toastEl = null;
let toastTimer = null;
function showToast(text) {
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.className = "toast";
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = text;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2200);
}
