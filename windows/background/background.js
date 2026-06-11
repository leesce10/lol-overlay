// background.js — 앱의 두뇌.
// 1) LoL 실행 감지 → live_client_data 피처 등록
// 2) all_players 아이템을 폴링/이벤트로 받아 diff → 새 아이템 감지
// 3) 변화 발생 시 overlay 창에 메시지 전달
//
// ⚠️ 이 코드는 macOS에서 작성됐고 Windows + Overwolf에서 아직 미검증.
//    README의 "검증 절차" 참고. 함수명은 Overwolf 공식 API 기준.

const LOL_CLASS_ID = 5426;
const REQUIRED_FEATURES = ["live_client_data"];

// 플레이어별 이전 아이템 집합 (summonerName -> Set<itemID>)
const prevItems = new Map();

function log(...args) {
  console.log("[bg]", ...args);
}

// ---- 게임 실행 감지 -------------------------------------------------------

function classIdFromGameInfo(info) {
  if (!info || !info.id) return null;
  return Math.floor(info.id / 10);
}

function isLol(info) {
  return classIdFromGameInfo(info) === LOL_CLASS_ID;
}

function onGameRunning(running) {
  if (running) {
    log("LoL 실행 감지 → 오버레이 + 피처 등록");
    openOverlay();
    registerFeatures();
  } else {
    log("LoL 종료 → 상태 초기화");
    prevItems.clear();
  }
}

overwolf.games.onGameInfoUpdated.addListener((res) => {
  if (res && res.gameInfo && isLol(res.gameInfo)) {
    onGameRunning(res.gameInfo.isRunning);
  }
});

overwolf.games.getRunningGameInfo((info) => {
  if (info && info.isRunning && isLol(info)) onGameRunning(true);
});

// ---- live_client_data 피처 등록 ------------------------------------------

function registerFeatures() {
  overwolf.games.events.setRequiredFeatures(REQUIRED_FEATURES, (res) => {
    log("setRequiredFeatures:", JSON.stringify(res));
  });
}

// 정보 업데이트(스냅샷) — all_players 아이템 변화 감지
overwolf.games.events.onInfoUpdates2.addListener((info) => {
  if (!info || !info.info || !info.info.live_client_data) return;
  const lcd = info.info.live_client_data;

  // all_players 는 JSON 문자열로 들어온다.
  if (lcd.all_players) {
    let players;
    try {
      players = JSON.parse(lcd.all_players);
    } catch (e) {
      log("all_players 파싱 실패", e);
      return;
    }
    detectNewItems(players);
  }
});

// 이벤트(킬/드래곤 등) — 2차에서 활용. 지금은 로깅만.
overwolf.games.events.onNewEvents.addListener((e) => {
  log("event:", JSON.stringify(e));
});

// ---- 아이템 diff 로직 -----------------------------------------------------

function detectNewItems(players) {
  if (!Array.isArray(players)) return;

  players.forEach((p) => {
    const name = p.summonerName || p.riotId || "unknown";
    const items = (p.items || []).map((it) => it.itemID);
    const curr = new Set(items);
    const prev = prevItems.get(name);

    if (prev) {
      const added = items.filter((id) => !prev.has(id));
      added.forEach((itemID) => {
        const meta = (p.items || []).find((it) => it.itemID === itemID);
        // TODO: 내 맞라인만 필터링 (position/team 비교). 지금은 전체 알림.
        notifyOverlay({
          summonerName: name,
          championName: p.championName,
          team: p.team, // "ORDER" | "CHAOS"
          position: p.position, // "MIDDLE" 등 (소환사의 협곡에서 제공)
          itemID,
          itemName: meta ? meta.displayName : String(itemID),
        });
      });
    }
    prevItems.set(name, curr);
  });
}

// ---- 오버레이 창 제어 -----------------------------------------------------

let overlayId = null;

function openOverlay() {
  overwolf.windows.obtainDeclaredWindow("overlay", (res) => {
    if (!res.success) return log("overlay 창 obtain 실패", res);
    overlayId = res.window.id;
    overwolf.windows.restore(overlayId, () => log("overlay 표시"));
  });
}

function notifyOverlay(payload) {
  log("새 아이템:", payload.championName, payload.itemName);
  if (!overlayId) return;
  overwolf.windows.sendMessage(overlayId, "new-item", payload, () => {});
}
