// fight.js — 오브젝트 교전 분석을 세로 타임라인으로 표시.
// background가 보내는 { key, objective, verdict, reason, secondsTo } 를 받아
// 오브젝트 초상화 + 이름 + 판정 라벨을 라인 위에서 스폰까지 내려보낸다.

const OBJ_BASE =
  "https://raw.communitydragon.org/latest/game/assets/ux/minimap/icons";
const OBJ_ICON = {
  dragon: OBJ_BASE + "/dragon.png",
  elder: OBJ_BASE + "/dragon_elder.png",
  baron: OBJ_BASE + "/baron.png",
  herald: OBJ_BASE + "/riftherald.png",
  grubs: OBJ_BASE + "/grub.png",
};

const VERDICT_CLASS = {
  "매우 유리": "veryGood",
  유리: "good",
  호각: "even",
  불리: "bad",
  "매우 불리": "veryBad",
};

const WINDOW_SEC = 60; // 스폰 몇 초 전부터 타임라인에 표시하는지

const track = document.getElementById("track");
const marker = document.getElementById("marker");
const objIcon = document.getElementById("obj-icon");
const objName = document.getElementById("obj-name");
const verdictEl = document.getElementById("verdict");

let current = null; // { key, objective, verdict, endAt }
let hideTimer = null;

function update(data) {
  current = {
    key: data.key,
    objective: data.objective,
    verdict: data.verdict,
    // secondsTo 기준 스폰 시각 추정
    spawnAt: Date.now() + Math.max(0, data.secondsTo) * 1000,
  };
  objIcon.src = OBJ_ICON[data.key] || OBJ_ICON.dragon;
  objIcon.onerror = () => (objIcon.style.visibility = "hidden");
  objName.textContent = data.objective || "";
  verdictEl.textContent = data.verdict || "";
  verdictEl.className = "verdict " + (VERDICT_CLASS[data.verdict] || "even");
  track.classList.remove("hidden");

  if (hideTimer) clearTimeout(hideTimer);
  // 갱신 없으면 25초 뒤 숨김(오브젝트 지나감)
  hideTimer = setTimeout(() => track.classList.add("hidden"), 25000);
}

function render() {
  if (current && !track.classList.contains("hidden")) {
    const h = track.clientHeight || 460;
    const remain = Math.max(0, (current.spawnAt - Date.now()) / 1000);
    // 위(스폰 멀었음) → 아래(스폰 임박)
    const progress = Math.min(1, 1 - remain / WINDOW_SEC);
    const top = 14 + progress * (h - 28);
    marker.style.top = `${top}px`;
  }
  requestAnimationFrame(render);
}
requestAnimationFrame(render);

if (typeof overwolf !== "undefined") {
  overwolf.windows.onMessageReceived.addListener((msg) => {
    if (msg.id === "fight-update" && msg.content) update(msg.content);
  });
}

if (location.search.includes("demo")) {
  update({
    key: "baron",
    objective: "바론",
    verdict: "매우 유리",
    reason: "수적 우위 5:4",
    secondsTo: 45,
  });
}
