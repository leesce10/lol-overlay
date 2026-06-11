// background.js — 앱의 두뇌.
// 1) LoL 실행 감지 → live_client_data 피처 등록
// 2) all_players 아이템을 폴링/이벤트로 받아 diff → 새 아이템 감지
// 3) 변화 발생 시 overlay 창에 메시지 전달
//
// ⚠️ 이 코드는 macOS에서 작성됐고 Windows + Overwolf에서 아직 미검증.
//    README의 "검증 절차" 참고. 함수명은 Overwolf 공식 API 기준.

const LOL_CLASS_ID = 5426;
const REQUIRED_FEATURES = ["live_client_data"];

// 테스트용 가짜 알림 (실서비스에선 false). 실제 동작만 사용.
const DEBUG_FAKE_CORE_ITEM = false;

// 진단: 화면에 데이터 수신 상태 표시 (문제 해결돼서 끔)
const DEBUG_STATUS = false;
let dbgFeat = "?",
  dbgUpd = 0,
  dbgLcd = 0,
  dbgPly = 0,
  dbgEv = 0,
  dbgDeaths = 0,
  dbgInfoKeys = "",
  dbgKeys = "";

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

let inGame = false; // 게임당 셋업 1회만 (onGameRunning 중복 호출 방지)

function onGameRunning(running) {
  if (running) {
    if (inGame) return; // 이미 셋업됨 → 중복 실행 방지
    inGame = true;
    log("LoL 실행 감지 → 오버레이 + 피처 등록");
    loadCoreItems();
    openOverlay();
    openTimeline(); // 미리 열어 리스너 준비 (메시지 유실 방지)
    registerFeatures();
    if (DEBUG_FAKE_CORE_ITEM) {
      // 테스트: 각각 따로 발사 + 단계별 로그 (하나 실패해도 나머지는 동작)
      log("DEBUG 모드 ON — 8초 후 아이템, 10초 타임라인, 12초 TTS");
      setTimeout(() => {
        log("DEBUG: 아이템 발사 (overlayId=" + overlayId + ")");
        try {
          notifyOverlay({
            championKey: "Ahri",
            itemID: 3157,
            itemName: "존야의 모래시계",
          });
        } catch (e) {
          log("DEBUG 아이템 에러:", e && e.message);
        }
      }, 8000);
      setTimeout(() => {
        log("DEBUG: 타임라인 발사");
        try {
          openTimeline(() => {
            pushRespawn({ championKey: "Vayne", name: "FAKE", totalSec: 40 });
            pushFight({
              key: "baron",
              objective: "바론",
              verdict: "매우 유리",
              reason: "테스트",
              secondsTo: 50,
            });
            log("DEBUG: 타임라인 push 완료 (timelineWinId=" + timelineWinId + ")");
          });
        } catch (e) {
          log("DEBUG 타임라인 에러:", e && e.message);
        }
      }, 10000);
      setTimeout(() => {
        log("DEBUG: TTS 발사");
        try {
          playTts("테스트 음성입니다. 우리팀이 교전에서 유리합니다.");
        } catch (e) {
          log("DEBUG TTS 에러:", e && e.message);
        }
      }, 12000);
    }
  } else {
    if (!inGame) return;
    inGame = false;
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
    dbgFeat = res && res.success ? "ok" : "fail";
  });
}

// 정보 업데이트(스냅샷) — all_players 아이템 변화 감지 + 게임시작 브리핑
let activeSummoner = null; // 내 소환사명 (active_player)

// 값이 문자열이면 JSON 파싱, 객체면 그대로 (onInfoUpdates2 vs getInfo 둘 다 대응)
function asObj(v) {
  if (v == null) return null;
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch (e) {
      return null;
    }
  }
  return v;
}

function processLcd(lcd) {
  if (!lcd) return;
  dbgLcd++;
  if (!dbgKeys) dbgKeys = Object.keys(lcd).join(",") || "(empty)";

  const ap = asObj(lcd.active_player);
  if (ap) activeSummoner = ap.riotIdGameName || ap.summonerName || activeSummoner;

  const gd = asObj(lcd.game_data);
  if (gd && typeof gd.gameTime === "number") {
    latestGameTime = gd.gameTime;
    maybeFightAnalysis();
  }

  const players = asObj(lcd.all_players);
  if (Array.isArray(players)) {
    dbgPly = players.length;
    latestPlayers = players;
    maybeBriefing(players);
    detectNewItems(players);
    updateRespawns(players);
  }

  const ev = asObj(lcd.events);
  if (ev && Array.isArray(ev.Events)) {
    dbgEv += ev.Events.length;
    handleKillEvents(ev.Events);
  }
}

// 변경 시 델타
overwolf.games.events.onInfoUpdates2.addListener((info) => {
  dbgUpd++;
  if (info && info.info) {
    if (!dbgInfoKeys) dbgInfoKeys = Object.keys(info.info).join(",") || "(empty)";
    if (info.info.live_client_data) processLcd(info.info.live_client_data);
  }
});

// 현재 전체 상태 폴링 (델타 누락 대비 — 2초마다)
setInterval(() => {
  if (!inGame) return;
  overwolf.games.events.getInfo((res) => {
    const lcd = res && (res.res || res.info);
    if (lcd && lcd.live_client_data) processLcd(lcd.live_client_data);
  });
}, 1000);

// 진단: 데이터 수신 상태를 아이템 창에 표시 (DEBUG_STATUS true일 때)
setInterval(() => {
  if (!DEBUG_STATUS || !overlayId) return;
  overwolf.windows.sendMessage(
    overlayId,
    "debug-status",
    {
      feat: dbgFeat,
      upd: dbgUpd,
      lcd: dbgLcd,
      ply: dbgPly,
      ev: dbgEv,
      deaths: dbgDeaths,
      me: activeSummoner || "?",
      infoKeys: dbgInfoKeys || "(none)",
      keys: dbgKeys || "(none)",
    },
    () => {}
  );
}, 2000);

// ---- 적 처치 → 복귀 타이머 ------------------------------------------------

let latestPlayers = [];
let latestGameTime = 0;
const processedKills = new Set();
const objectiveKills = {}; // { dragon: killTime, ... }
let lastFightFetch = 0;

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

const OBJ_EVENT = {
  DragonKill: "dragon",
  BaronKill: "baron",
  HeraldKill: "herald",
};

function handleKillEvents(events) {
  const mySide = myTeamSide(latestPlayers);
  for (const ev of events) {
    const key = `${ev.EventID}-${ev.EventName}`;

    // 오브젝트 처치 → 재스폰 계산용 기록
    const objKey = OBJ_EVENT[ev.EventName];
    if (objKey) {
      if (!processedKills.has(key)) {
        processedKills.add(key);
        objectiveKills[objKey] = ev.EventTime;
        log("오브젝트 처치:", objKey, "@", Math.round(ev.EventTime));
        // 처치되면 timeline의 해당 오브젝트 마커 제거
        if (timelineWinId) pushTimeline("fight-clear", { key: objKey });
      }
      continue;
    }

    if (ev.EventName !== "ChampionKill") continue;
    if (processedKills.has(key)) continue;
    processedKills.add(key);

    const victim = latestPlayers.find((p) => sameName(p, ev.VictimName));
    if (!victim) {
      log("처치 victim 매칭 실패:", ev.VictimName);
      continue;
    }
    if (!victim.team || victim.team === mySide) continue; // 적만
    if (latestGameTime >= LANE_PHASE_END) continue; // 라인전 끝나면 복귀 UI 끔

    // 부활 시간 + 라인복귀 이동. 곧 all_players의 실제 respawnTimer로 보정됨.
    const totalSec =
      Math.round(respawnSeconds(victim.level, latestGameTime)) +
      travelFor(latestGameTime, victim.position, hasBoots(victim));
    log("적 처치:", victim.championName, "복귀", totalSec, "초");
    openTimeline(() =>
      pushRespawn({
        championKey: championKeyOf(victim),
        name: victim.riotId || victim.summonerName,
        totalSec,
      })
    );
  }
}

// 복귀 + 오브젝트 교전을 하나의 timeline 창(세로선)에 통합
let timelineWinId = null;

// 분수대 → 라인 걸어오는 추정 시간(초). 라인마다 거리가 달라 다르게 잡음.
// 신발 아이템 ID (있으면 이동 빨라짐)
const BOOTS_IDS = new Set([
  1001, 3006, 3009, 3020, 3047, 3111, 3117, 3158,
]);
function hasBoots(p) {
  return (p.items || []).some((it) => BOOTS_IDS.has(it.itemID));
}

// 분수대→라인 이동(초). 게임 진행될수록 짧아짐. 탑/바텀/서폿 +5, 신발 있으면 -2.
function travelFor(gameSec, position, boots) {
  const min = (gameSec || 0) / 60;
  let t = min < 8 ? 15 : min < 20 ? 13 : 12;
  const pos = (position || "").toUpperCase();
  if (pos === "TOP" || pos === "BOTTOM" || pos === "UTILITY") t += 5;
  if (boots) t -= 2;
  return t;
}

const LANE_PHASE_END = 1200; // 20분 — 이후 라인복귀 UI 비활성화

function openTimeline(cb) {
  if (timelineWinId) {
    cb && cb();
    return;
  }
  overwolf.windows.obtainDeclaredWindow("timeline", (res) => {
    if (!res.success) return log("timeline 창 obtain 실패", res);
    timelineWinId = res.window.id;
    overwolf.windows.restore(timelineWinId, () => {
      positionTimeline();
      cb && cb();
    });
  });
}

// 좌측 사이드(세로 가운데쯤)에 배치
function positionTimeline() {
  overwolf.games.getRunningGameInfo((info) => {
    if (!info) return;
    const w = info.logicalWidth || info.width;
    const h = info.logicalHeight || info.height;
    if (!w || !h) return;
    const left = 8;
    const top = Math.max(40, Math.round((h - 600) / 2) - 90);
    overwolf.windows.changePosition(timelineWinId, left, top, () =>
      log("timeline 위치(좌측):", left, top, "(", w, "x", h, ")")
    );
  });
}

function pushTimeline(id, content) {
  if (timelineWinId)
    overwolf.windows.sendMessage(timelineWinId, id, content, () => {});
}
function pushRespawn(payload) {
  pushTimeline("respawn-add", payload);
}
function pushFight(payload) {
  pushTimeline("fight-update", payload);
}

// 적 사망 감지 → 복귀 타이머.
// 가장 확실한 신호: scores.deaths(사망 횟수) 증가 = 방금 죽음. (스코어보드 데이터라 항상 들어옴)
// respawnTimer가 들어오면 매 스냅샷 정확 보정, 아니면 죽는 순간 공식 추정(창이 카운트다운).
const prevDeaths = new Map();
function deathCount(p) {
  return (p.scores && (p.scores.deaths ?? p.scores.death)) || 0;
}
function updateRespawns(players) {
  if (latestGameTime >= LANE_PHASE_END) return; // 라인전 끝나면 복귀 UI 끔
  const mySide = myTeamSide(players);
  for (const p of players) {
    if (!p.team || p.team === mySide) continue; // 적만
    const name = p.riotId || p.summonerName || p.championName;
    const deaths = deathCount(p);
    const prev = prevDeaths.has(name) ? prevDeaths.get(name) : deaths;
    prevDeaths.set(name, deaths);

    const justDied = deaths > prev; // 사망 횟수 증가 = 방금 죽음
    const hasTimer = typeof p.respawnTimer === "number" && p.respawnTimer > 0;

    if (justDied) {
      dbgDeaths++;
      log("적 사망 감지:", name, "deaths", deaths);
    }

    // 죽는 순간 1회 발사 + (respawnTimer 있으면) 죽어있는 동안 매 스냅샷 정확 보정
    if (justDied || (hasTimer && p.isDead)) {
      // 부활 시간(정확) + 라인복귀 이동(게임시간 기준 추정)
      const respawn = hasTimer
        ? Math.ceil(p.respawnTimer)
        : Math.round(respawnSeconds(p.level, latestGameTime));
      const totalSec = respawn + travelFor(latestGameTime, p.position, hasBoots(p));
      openTimeline(() =>
        pushRespawn({ championKey: championKeyOf(p), name, totalSec })
      );
    }
  }
}

// ---- 오브젝트 교전 분석 ---------------------------------------------------
// 스폰 스케줄(초, 추정). 처치 이벤트로 재스폰 계산.
// 유충은 스폰 패턴이 복잡(다중 스폰)해 오탐이 잦아 제외. 용/바론/전령만.
const OBJ_SCHEDULE = [
  { key: "herald", label: "전령", first: 840, respawn: null },
  { key: "dragon", label: "드래곤", first: 300, respawn: 300 },
  { key: "baron", label: "바론", first: 1200, respawn: 360 },
];

function objectivesInWindow(gameTime, win) {
  const out = [];
  for (const d of OBJ_SCHEDULE) {
    const killed = objectiveKills[d.key];
    let spawnAt;
    if (killed == null) spawnAt = d.first;
    else if (d.respawn != null) spawnAt = killed + d.respawn;
    else continue;
    const secondsTo = Math.round(spawnAt - gameTime);
    if (secondsTo <= win && secondsTo > -20)
      out.push({ key: d.key, label: d.label, secondsTo });
  }
  return out.sort((a, b) => a.secondsTo - b.secondsTo);
}

// 스폰 60초 전부터, 8초마다 교전 분석 갱신
function maybeFightAnalysis() {
  if (!latestPlayers.length) return;
  const upcoming = objectivesInWindow(latestGameTime, 60);
  if (!upcoming.length) return;

  const now = Date.now();
  if (now - lastFightFetch < 8000) return; // 스로틀
  lastFightFetch = now;

  const obj = upcoming[0];
  const mySide = myTeamSide(latestPlayers);
  const myTeamId = mySide === "CHAOS" ? 200 : 100;
  const players = latestPlayers.map((p) => ({
    teamId: p.team === "CHAOS" ? 200 : 100,
    level: p.level,
    items: (p.items || []).map((it) => it.itemID),
    isDead: !!p.isDead,
    respawnTimer: p.respawnTimer || 0,
  }));

  fetch(window.LOLSTATS.API_BASE + "/api/live/fight-analysis", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      secondsToObjective: Math.max(0, obj.secondsTo),
      gameTime: latestGameTime,
      myTeamId,
      objective: obj.label,
      players,
    }),
  })
    .then((r) => r.json())
    .then((res) => {
      log("교전 분석:", obj.label, res.verdict);
      openTimeline(() =>
        pushFight({
          key: obj.key,
          objective: obj.label,
          verdict: res.verdict,
          reason: res.reason,
          secondsTo: obj.secondsTo,
        })
      );
    })
    .catch((e) => log("교전 분석 실패", e));
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
      const tts = data && data.briefing && data.briefing.tts;
      log("브리핑:", data.briefing && data.briefing.compEdge, "| TTS:", !!tts);
      // 창 띄우지 않고 background에서 바로 음성 재생 (autoplay 제약 없음)
      if (tts) playTts(tts);
      else briefingSent = false; // 브리핑 못 만들면 다음 스냅샷서 재시도
    })
    .catch((e) => {
      log("브리핑 요청 실패", e);
      briefingSent = false; // 다음 스냅샷에서 재시도
    });
}

// background(숨은 페이지)에서 TTS 직접 재생 → 창·클릭 불필요
let briefingAudio = null;
function playTts(text) {
  const url =
    window.LOLSTATS.API_BASE +
    "/api/live/tts?voice=female&text=" +
    encodeURIComponent(text);
  try {
    if (!briefingAudio) briefingAudio = new Audio();
    briefingAudio.src = url;
    briefingAudio.play().catch((e) => log("TTS 재생 실패:", e && e.message));
  } catch (e) {
    log("TTS 오류:", e);
  }
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

// 이름 비교: 태그(#KR1) 떼고 소문자로. riotId/summonerName/riotIdGameName 모두 시도
function nameKey(s) {
  return (s || "").split("#")[0].trim().toLowerCase();
}
function sameName(player, name) {
  const k = nameKey(name);
  if (!k) return false;
  return [player.riotId, player.summonerName, player.riotIdGameName].some(
    (c) => nameKey(c) === k
  );
}

function myTeamSide(players) {
  if (!activeSummoner) return "ORDER";
  const me = players.find((p) => sameName(p, activeSummoner));
  return me ? me.team : "ORDER";
}

// 코어(완성) 아이템 ID 집합 — Data Dragon에서 1회 로드. 하위 구성요소는 제외.
let coreItemIds = null;
function loadCoreItems() {
  if (coreItemIds) return;
  fetch(
    "https://ddragon.leagueoflegends.com/cdn/15.7.1/data/en_US/item.json"
  )
    .then((r) => r.json())
    .then((j) => {
      const set = new Set();
      for (const [id, it] of Object.entries(j.data)) {
        const into = it.into || [];
        const total = (it.gold && it.gold.total) || 0;
        const purchasable = it.gold && it.gold.purchasable;
        const tags = it.tags || [];
        // 완성템(into 없음) + 충분히 비쌈 + 소비/장신구 아님
        if (
          purchasable &&
          into.length === 0 &&
          total >= 1600 &&
          !tags.includes("Consumable") &&
          !tags.includes("Trinket")
        ) {
          set.add(Number(id));
        }
      }
      coreItemIds = set;
      log("코어 아이템 목록 로드:", set.size);
    })
    .catch((e) => log("item.json 로드 실패", e));
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
        if (meta && meta.consumable) return; // 포션/와드 등 소비템 제외
        if (!coreItemIds || !coreItemIds.has(itemID)) return; // 코어(완성) 아이템만
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

const OVERLAY_W = 760;
const OVERLAY_H = 220;
// 화면 하단에서 토스트 아래 가장자리까지 거리(px). 클수록 더 위로. (스킬창 조금 위)
const SKILL_CLEARANCE = 480;

function openOverlay() {
  overwolf.windows.obtainDeclaredWindow("overlay", (res) => {
    if (!res.success) return log("overlay 창 obtain 실패", res);
    overlayId = res.window.id;
    overwolf.windows.restore(overlayId, () => positionOverlay());
  });
}

// 게임 해상도 기준 가운데 하단(스킬창 위 ~100px)에 강제 배치 (manifest 캐시 무시)
function positionOverlay() {
  overwolf.games.getRunningGameInfo((info) => {
    if (!info) return;
    const w = info.logicalWidth || info.width;
    const h = info.logicalHeight || info.height;
    if (!w || !h) return;
    // 가운데 정렬 + 살짝 왼쪽으로(텍스트가 오른쪽으로 길어 무게중심 보정)
    const left = Math.round((w - OVERLAY_W) / 2) - 70;
    // 창 아래쪽 가장자리(= 토스트 위치)가 화면 바닥에서 SKILL_CLEARANCE 만큼 위
    const top = Math.round(h - SKILL_CLEARANCE - OVERLAY_H);
    overwolf.windows.changePosition(overlayId, left, top, () =>
      log("overlay 위치:", left, top, "(", w, "x", h, ")")
    );
  });
}

function notifyOverlay(payload) {
  log("새 아이템:", payload.championName, payload.itemName);
  if (!overlayId) return;
  overwolf.windows.sendMessage(overlayId, "new-item", payload, () => {});
}
