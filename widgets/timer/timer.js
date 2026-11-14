applyCardTheme(new URLSearchParams(location.search).get("theme")); // e.g. /timer?theme=ocean

const cardEl = document.getElementById("card");
const clockEl = document.getElementById("clock");
const statusEl = document.getElementById("status");

const STATUS_LABELS = {
  idle: "นับถอยหลัง",
  running: "นับถอยหลัง",
  paused: "หยุดชั่วคราว",
  ended: "หมดเวลาแล้ว!",
};

let tickTimer = null;

function render(state) {
  statusEl.textContent = STATUS_LABELS[state.status] || STATUS_LABELS.idle;
  cardEl.classList.toggle("running", state.status === "running");
  cardEl.classList.toggle("ended", state.status === "ended");
  cardEl.classList.toggle("paused", state.status === "paused");

  // Only "running" needs a local tick; the other states are fixed snapshots.
  clearInterval(tickTimer);
  const draw = () => (clockEl.textContent = timerClockText(state));
  draw();
  if (state.status === "running") tickTimer = setInterval(draw, 250);
}

const setWsStatus = attachStatusIndicator();

connectWS((data) => {
  if (data.type !== "timer-state") return;
  render(data);
}, setWsStatus);
