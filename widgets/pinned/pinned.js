const pinWrap = document.getElementById("pin-wrap");
const setWsStatus = attachStatusIndicator();

function setPinnedCard(nickname, comment, avatarUrl, autoUnpinMs) {
  const { line, bubble } = buildLine("pin-line", "@" + nickname, avatarUrl, null);
  bubble.innerHTML = `<span class="comment">${escapeHtml(comment)}</span>`;

  if (autoUnpinMs > 0) {
    const track = document.createElement("div");
    track.className = "pin-progress";
    const fill = document.createElement("div");
    fill.className = "pin-progress-fill";
    fill.style.animationDuration = `${autoUnpinMs}ms`;
    track.appendChild(fill);
    bubble.appendChild(track);
  }

  pinWrap.replaceChildren(line);
  pinWrap.classList.add("show");
}

function clearPinnedCard() {
  pinWrap.classList.remove("show");
}

connectWS((data) => {
  if (data.type === "pin") {
    setPinnedCard(data.nickname, data.comment, data.avatarUrl, data.autoUnpinMs);
  } else if (data.type === "unpin") {
    clearPinnedCard();
  }
}, setWsStatus);
