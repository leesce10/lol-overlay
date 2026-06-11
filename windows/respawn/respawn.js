// respawn.js — 처치한 적들의 복귀 타이머를 좌측 세로 트랙에 표시.
// background가 보내는 { championKey, name, totalSec } 를 받아 자체적으로 카운트다운.

const DDRAGON_VERSION = "15.7.1";
const CHAMP_ICON = (key) =>
  `https://ddragon.leagueoflegends.com/cdn/${DDRAGON_VERSION}/img/champion/${key}.png`;

const track = document.getElementById("track");
const TRACK_PAD = 24; // 위/아래 여백(px)

// 진행 중 타이머: key -> { championKey, endAt, totalMs, el, img, sec }
const timers = new Map();

function addTimer({ championKey, name, totalSec }) {
  const id = name || championKey;
  // 이미 있으면 갱신
  let t = timers.get(id);
  const now = Date.now();
  if (!t) {
    const el = document.createElement("div");
    el.className = "respawn-entry";
    const img = document.createElement("img");
    img.src = CHAMP_ICON(championKey);
    img.onerror = () => (img.style.visibility = "hidden");
    const sec = document.createElement("div");
    sec.className = "sec";
    el.appendChild(img);
    el.appendChild(sec);
    track.appendChild(el);
    t = { championKey, el, img, sec };
    timers.set(id, t);
  }
  t.totalMs = totalSec * 1000;
  t.endAt = now + t.totalMs;
}

function render() {
  const now = Date.now();
  const h = track.clientHeight || 460;
  for (const [id, t] of timers) {
    const remainMs = t.endAt - now;
    const remainSec = Math.ceil(remainMs / 1000);
    if (remainMs <= -1000) {
      // "복귀" 표시 1초 뒤 제거
      t.el.remove();
      timers.delete(id);
      continue;
    }
    const back = remainMs <= 0;
    const progress = back ? 1 : 1 - remainMs / t.totalMs; // 0(처치직후)→1(복귀)
    const top = TRACK_PAD + progress * (h - TRACK_PAD * 2 - 24);
    t.el.style.top = `${top}px`;
    t.el.classList.toggle("back", back);
    t.sec.textContent = back ? "복귀" : `${remainSec}s`;
  }
  requestAnimationFrame(render);
}
requestAnimationFrame(render);

if (typeof overwolf !== "undefined") {
  overwolf.windows.onMessageReceived.addListener((msg) => {
    if (msg.id === "respawn-add" && msg.content) addTimer(msg.content);
  });
}

// 브라우저 demo
if (location.search.includes("demo")) {
  addTimer({ championKey: "Fiora", name: "fiora", totalSec: 48 });
}
