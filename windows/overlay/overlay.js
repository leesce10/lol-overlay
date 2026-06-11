// overlay.js — background에서 받은 "새 아이템" 알림을 토스트로 표시.
// Data Dragon CDN에서 아이템 아이콘을 가져온다.

// TODO: 패치 버전을 동적으로(최신) 가져오기. 지금은 고정.
const DDRAGON_VERSION = "15.1.1";
const ITEM_ICON = (id) =>
  `https://ddragon.leagueoflegends.com/cdn/${DDRAGON_VERSION}/img/item/${id}.png`;

const toasts = document.getElementById("toasts");

function teamLabel(team) {
  return team === "CHAOS" ? "레드" : team === "ORDER" ? "블루" : "";
}

function showToast({ championName, itemName, itemID, team }) {
  const el = document.createElement("div");
  el.className = "toast";

  const img = document.createElement("img");
  img.src = ITEM_ICON(itemID);
  img.onerror = () => {
    img.style.visibility = "hidden";
  };

  const text = document.createElement("div");
  text.className = "text";
  const who = championName || "상대";
  text.innerHTML = `${teamLabel(team)} <b>${who}</b> 아이템 완성<br/>${itemName}`;

  el.appendChild(img);
  el.appendChild(text);
  toasts.appendChild(el);

  // 5초 후 제거 (CSS out 애니메이션과 맞춤)
  setTimeout(() => el.remove(), 5000);
}

// background → overlay 메시지 수신 (Overwolf 런타임에서만)
if (typeof overwolf !== "undefined") {
  overwolf.windows.onMessageReceived.addListener((msg) => {
    if (msg.id === "new-item" && msg.content) {
      showToast(msg.content);
    }
  });
}

// 개발용: ?demo=1 로 열면 더미 토스트 한 번 표시 (브라우저에서도 확인 가능)
if (location.search.includes("demo")) {
  showToast({
    championName: "Ahri",
    itemName: "존야의 모래시계",
    itemID: 3157,
    team: "CHAOS",
  });
}
