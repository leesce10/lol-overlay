// overlay.js — background에서 받은 "새 아이템" 알림을 토스트로 표시.
// Data Dragon CDN에서 아이템 아이콘을 가져온다.

// TODO: 패치 버전을 동적으로(최신) 가져오기. 지금은 고정.
const DDRAGON_VERSION = "15.1.1";
const ITEM_ICON = (id) =>
  `https://ddragon.leagueoflegends.com/cdn/${DDRAGON_VERSION}/img/item/${id}.png`;
const CHAMP_ICON = (key) =>
  `https://ddragon.leagueoflegends.com/cdn/${DDRAGON_VERSION}/img/champion/${key}.png`;

const toasts = document.getElementById("toasts");

function showToast({ championKey, itemName, itemID }) {
  const el = document.createElement("div");
  el.className = "toast";

  const badge = document.createElement("span");
  badge.className = "enemy-badge";
  badge.textContent = "적";

  // 챔피언 아이콘 ("적" 옆)
  const champImg = document.createElement("img");
  champImg.className = "champ";
  if (championKey) champImg.src = CHAMP_ICON(championKey);
  champImg.onerror = () => {
    champImg.style.display = "none";
  };

  // 아이템 아이콘
  const itemImg = document.createElement("img");
  itemImg.className = "item";
  itemImg.src = ITEM_ICON(itemID);
  itemImg.onerror = () => {
    itemImg.style.visibility = "hidden";
  };

  const text = document.createElement("div");
  text.className = "text";
  text.innerHTML = `<b>${itemName}</b> 구매`;

  el.appendChild(badge);
  el.appendChild(champImg);
  el.appendChild(itemImg);
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
    championKey: "Ahri",
    itemName: "존야의 모래시계",
    itemID: 3157,
  });
}
