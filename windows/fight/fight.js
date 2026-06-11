// fight.js — background가 보내는 오브젝트 교전 분석 결과를 표시.

const VERDICT_CLASS = {
  "매우 유리": "veryGood",
  유리: "good",
  호각: "even",
  불리: "bad",
  "매우 불리": "veryBad",
};

const card = document.getElementById("card");
const objEl = document.getElementById("obj");
const verdictEl = document.getElementById("verdict");
const reasonEl = document.getElementById("reason");
const spawnEl = document.getElementById("spawn");

let hideTimer = null;

function update({ objective, verdict, reason, secondsTo }) {
  objEl.textContent = objective || "오브젝트";
  verdictEl.textContent = verdict || "";
  verdictEl.className = "verdict " + (VERDICT_CLASS[verdict] || "even");
  reasonEl.textContent = reason || "";
  spawnEl.textContent =
    secondsTo > 0 ? `스폰까지 ${secondsTo}s` : "스폰됨 — 지금 결정";
  card.classList.remove("hidden");

  // 갱신 없으면 20초 뒤 숨김(오브젝트 지나감)
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => card.classList.add("hidden"), 20000);
}

if (typeof overwolf !== "undefined") {
  overwolf.windows.onMessageReceived.addListener((msg) => {
    if (msg.id === "fight-update" && msg.content) update(msg.content);
  });
}

if (location.search.includes("demo")) {
  update({
    objective: "바론",
    verdict: "매우 유리",
    reason: "수적 우위 5:4 (적 1명 복귀 못 함) · 평균 레벨 +1.0",
    secondsTo: 45,
  });
}
