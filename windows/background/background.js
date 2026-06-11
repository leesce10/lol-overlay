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
    briefingSent = false;
    activeSummoner = null;
    lastBriefing = null;
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

// 정보 업데이트(스냅샷) — all_players 아이템 변화 감지 + 게임시작 브리핑
let activeSummoner = null; // 내 소환사명 (active_player)

overwolf.games.events.onInfoUpdates2.addListener((info) => {
  if (!info || !info.info || !info.info.live_client_data) return;
  const lcd = info.info.live_client_data;

  // active_player 로 내 소환사명 확보 (우리팀 판별용)
  if (lcd.active_player) {
    try {
      const ap = JSON.parse(lcd.active_player);
      activeSummoner = ap.riotIdGameName || ap.summonerName || activeSummoner;
    } catch (e) {
      /* ignore */
    }
  }

  // 게임 시간
  if (lcd.game_data) {
    try {
      const gd = JSON.parse(lcd.game_data);
      if (typeof gd.gameTime === "number") latestGameTime = gd.gameTime;
    } catch (e) {
      /* ignore */
    }
  }

  // all_players 는 JSON 문자열로 들어온다.
  if (lcd.all_players) {
    let players;
    try {
      players = JSON.parse(lcd.all_players);
    } catch (e) {
      log("all_players 파싱 실패", e);
      return;
    }
    latestPlayers = players;
    maybeBriefing(players);
    detectNewItems(players);
  }

  // 킬 이벤트 → 적 부활 타이머
  if (lcd.events) {
    try {
      const parsed = JSON.parse(lcd.events);
      handleKillEvents(parsed.Events || []);
    } catch (e) {
      /* ignore */
    }
  }
});

// ---- 적 처치 → 복귀 타이머 ------------------------------------------------

let latestPlayers = [];
let latestGameTime = 0;
const processedKills = new Set();

// 부활 대기시간(초): 레벨별 기본값 × (1 + 시간증가계수). 레벨·게임시간은 화면에 보임.
function respawnSeconds(level, gameSec) {
  const BRW = [
    10, 10, 12, 12, 14, 16, 20, 25, 28.5, 32.5, 35, 37.5, 40, 42.5, 45, 47.5,
    50, 52.5,
  ];
  const lvl = Math.max(1, Math.min(18, Math.round(level || 1)));
  const min = (gameSec || 0) / 60;
  const tif = min > 15 ? Math.min(0.5, (min - 15) * 0.02) : 0;
  return BRW[lvl - 1] * (1 + tif);
}

function handleKillEvents(events) {
  const mySide = myTeamSide(latestPlayers);
  for (const ev of events) {
    if (ev.EventName !== "ChampionKill") continue;
    const key = `${ev.EventID}-${ev.EventName}`;
    if (processedKills.has(key)) continue;
    processedKills.add(key);

    const victim = latestPlayers.find(
      (p) => (p.riotId || p.summonerName) === ev.VictimName
    );
    if (!victim) continue;
    if (!victim.team || victim.team === mySide) continue; // 적만

    const respawn = respawnSeconds(victim.level, latestGameTime);
    const totalSec = Math.round(respawn) + 12; // + 라인 복귀 이동(추정)
    log("적 처치:", victim.championName, "복귀 예상", totalSec, "초");
    openRespawn(() =>
      pushRespawn({
        championKey: championKeyOf(victim),
        name: victim.riotId || victim.summonerName,
        totalSec,
      })
    );
  }
}

let respawnWinId = null;

function openRespawn(cb) {
  overwolf.windows.obtainDeclaredWindow("respawn", (res) => {
    if (!res.success) return log("respawn 창 obtain 실패", res);
    respawnWinId = res.window.id;
    overwolf.windows.restore(respawnWinId, () => cb && cb());
  });
}

function pushRespawn(payload) {
  if (respawnWinId) {
    overwolf.windows.sendMessage(respawnWinId, "respawn-add", payload, () => {});
  }
}

// ---- 게임 시작 조합 브리핑 ------------------------------------------------

let briefingSent = false;
let lastBriefing = null;

// rawChampionName "game_character_displayname_Aatrox" → "Aatrox" (Data Dragon 키)
function championKeyOf(p) {
  const raw = p.rawChampionName || "";
  const m = raw.match(/_([A-Za-z]+)$/);
  if (m) return m[1];
  return p.championName || undefined;
}

function buildParticipants(players) {
  return players.map((p) => ({
    riotId: p.riotId || p.summonerName,
    championKey: championKeyOf(p),
    championName: p.championName,
    teamId: p.team === "CHAOS" ? 200 : 100, // ORDER=블루=100
    position: p.position || undefined,
  }));
}

function myTeamId(participants) {
  if (!activeSummoner) return 100;
  const me = participants.find(
    (p) => p.riotId && p.riotId.startsWith(activeSummoner)
  );
  return me ? me.teamId : 100;
}

function maybeBriefing(players) {
  if (briefingSent || !Array.isArray(players) || players.length < 2) return;
  briefingSent = true;

  const participants = buildParticipants(players);
  const payload = { myTeamId: myTeamId(participants), participants };

  const url = window.LOLSTATS.API_BASE + window.LOLSTATS.TEAM_ANALYSIS;
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
    .then((r) => r.json())
    .then((data) => {
      lastBriefing = data;
      log("브리핑 수신:", data.briefing && data.briefing.compEdge);
      openBriefing(() => pushBriefing());
    })
    .catch((e) => {
      log("브리핑 요청 실패", e);
      briefingSent = false; // 다음 스냅샷에서 재시도
    });
}

let briefingWinId = null;

function openBriefing(cb) {
  overwolf.windows.obtainDeclaredWindow("briefing", (res) => {
    if (!res.success) return log("briefing 창 obtain 실패", res);
    briefingWinId = res.window.id;
    overwolf.windows.restore(briefingWinId, () => cb && cb());
  });
}

function pushBriefing() {
  if (briefingWinId && lastBriefing) {
    overwolf.windows.sendMessage(briefingWinId, "briefing-data", lastBriefing, () => {});
  }
}

// briefing 창이 늦게 떠서 데이터를 놓친 경우 당겨갈 수 있도록 노출
window.requestBriefing = pushBriefing;

// 이벤트(킬/드래곤 등) — 2차에서 활용. 지금은 로깅만.
overwolf.games.events.onNewEvents.addListener((e) => {
  log("event:", JSON.stringify(e));
});

// ---- 적 아이템 구매 감지 --------------------------------------------------
// LoL은 적이 시야에 들어와야 그 적의 아이템 정보가 갱신된다(탭 스코어보드와 동일).
// 그 변화를 diff로 잡아 "보였을 때 새 아이템"을 알린다. 클라이언트가 이미 아는
// 정보만 사용하므로 ToS 준수.

function myTeamSide(players) {
  if (!activeSummoner) return "ORDER";
  const me = players.find((p) =>
    (p.riotId || p.summonerName || "").startsWith(activeSummoner)
  );
  return me ? me.team : "ORDER";
}

function detectNewItems(players) {
  if (!Array.isArray(players)) return;
  const mySide = myTeamSide(players);

  players.forEach((p) => {
    const name = p.summonerName || p.riotId || "unknown";
    const allItems = p.items || [];
    const items = allItems.map((it) => it.itemID);
    const curr = new Set(items);
    const prev = prevItems.get(name);
    const isEnemy = p.team && p.team !== mySide;

    // prev가 있어야(=두 번째 스냅샷부터) 변화로 인정 → 시작 아이템은 알리지 않음
    if (prev && isEnemy) {
      const added = items.filter((id) => !prev.has(id));
      added.forEach((itemID) => {
        const meta = allItems.find((it) => it.itemID === itemID);
        if (meta && meta.consumable) return; // 포션/와드 등 소비템 제외(노이즈)
        notifyOverlay({
          championName: p.championName,
          championKey: championKeyOf(p), // DDragon 아이콘용 (예: "Zed")
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
