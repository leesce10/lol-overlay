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
    maybeClearGrubs();
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

// 이벤트 객체의 모든 문자열 필드에서 포탑 이름을 찾는다(필드명 차이에 견고)
function findTurretName(ev) {
  if (typeof ev.TurretKilled === "string") return ev.TurretKilled;
  for (const v of Object.values(ev)) {
    if (typeof v === "string" && /Turret_T[12]_[LCR]_/.test(v)) return v;
  }
  return "";
}

const loggedEventTypes = new Set(); // 이벤트 종류별 1회 구조 로그(진단)
function handleKillEvents(events) {
  const mySide = myTeamSide(latestPlayers);
  for (const ev of events) {
    const key = `${ev.EventID}-${ev.EventName}`;

    // 진단: 처음 보는 이벤트 종류는 전체 구조를 한 번 로깅
    if (ev.EventName && !loggedEventTypes.has(ev.EventName)) {
      loggedEventTypes.add(ev.EventName);
      log("이벤트 수신:", ev.EventName, JSON.stringify(ev));
    }

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

    // 내 라인 1차 타워 파괴 → 라인전 종료로 간주(복귀 UI 끔)
    if (ev.EventName === "TurretKilled" || /turret/i.test(ev.EventName || "")) {
      if (!processedKills.has(key)) {
        processedKills.add(key);
        const tname = findTurretName(ev);
        const m = tname.match(/Turret_T[12]_([LCR])_/);
        const myLane = myLaneLetter();
        const laneMatch = !!(m && myLane && m[1] === myLane);
        log(
          "타워 파괴:", tname, "| 라인:", m ? m[1] : "?",
          "| 내라인:", myLane, "| 일치:", laneMatch
        );
        // 내 라인 타워 파괴, 또는 내 라인을 모를 때(봇/블라인드 등)는 첫 타워로 종료
        if (laneMatch || !myLane) {
          lanePhaseOver = true;
          log("→ 라인복귀 UI 종료(lanePhaseOver=true)");
        }
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
    if (!isMyLaneOpponent(victim)) continue; // 내 라인 상대만
    if (lanePhaseDone()) continue; // 라인전 끝나면 복귀 UI 끔

    // 부활 시간 + 라인복귀 이동. 곧 all_players의 실제 respawnTimer로 보정됨.
    const totalSec =
      Math.round(respawnSeconds(victim.level, latestGameTime)) +
      travelFor(latestGameTime, victim.position, bootTier(victim));
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
const T1_BOOTS = 1001; // 기본 신발(티어1)
const BOOTS_IDS = new Set([
  1001, 3006, 3009, 3020, 3047, 3111, 3117, 3158,
]);
// 0=없음, 1=기본 신발, 2=2티어(업그레이드) 신발
function bootTier(p) {
  const ids = (p.items || []).map((it) => it.itemID);
  if (ids.some((id) => BOOTS_IDS.has(id) && id !== T1_BOOTS)) return 2;
  if (ids.includes(T1_BOOTS)) return 1;
  return 0;
}

// 분수대→라인 이동(초). 게임 진행될수록 짧아짐.
// 탑/바텀/서폿 +5, 신발 -2, 2티어 신발 추가 -1.
function travelFor(gameSec, position, boots) {
  const min = (gameSec || 0) / 60;
  let t = min < 8 ? 15 : min < 20 ? 13 : 12;
  const pos = (position || "").toUpperCase();
  if (pos === "TOP" || pos === "BOTTOM" || pos === "UTILITY") t += 5;
  if (boots >= 1) t -= 2;
  if (boots >= 2) t -= 1;
  return t;
}

const LANE_PHASE_END = 1200; // 20분 — 안전망(정글이거나 타워 이벤트 놓쳤을 때)
let lanePhaseOver = false; // 내 라인 1차 타워 파괴 시 true

// 포지션 → 라인 문자 (L=탑, C=미드, R=바텀·서폿). 정글/불명은 null
function laneLetterOf(pos) {
  const p = (pos || "").toUpperCase();
  if (p === "TOP") return "L";
  if (p === "MIDDLE" || p === "MID") return "C";
  if (p === "BOTTOM" || p === "UTILITY") return "R";
  return null;
}

// 내 라인 문자
function myLaneLetter() {
  if (!activeSummoner) return null;
  const me = latestPlayers.find((p) => sameName(p, activeSummoner));
  return laneLetterOf(me && me.position);
}

// 이 적이 내 라인 상대인지. 내 포지션이 정글/불명이면 전부 표시(폴백)
function isMyLaneOpponent(enemy) {
  const mine = myLaneLetter();
  if (!mine) return true;
  return laneLetterOf(enemy.position) === mine;
}

// 라인복귀 UI를 더 보여줄지: 내 라인 타워가 깨졌거나 20분 지났으면 종료
function lanePhaseDone() {
  return lanePhaseOver || latestGameTime >= LANE_PHASE_END;
}

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
let loggedMe = false;
function updateRespawns(players) {
  if (!loggedMe && activeSummoner) {
    const me = players.find((p) => sameName(p, activeSummoner));
    if (me) {
      loggedMe = true;
      log("내 정보:", activeSummoner, "| position:", JSON.stringify(me.position), "| team:", me.team);
    }
  }
  if (lanePhaseDone()) return; // 라인전 끝나면 복귀 UI 끔
  const mySide = myTeamSide(players);
  for (const p of players) {
    if (!p.team || p.team === mySide) continue; // 적만
    if (!isMyLaneOpponent(p)) continue; // 내 라인 상대만
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
      const totalSec = respawn + travelFor(latestGameTime, p.position, bootTier(p));
      openTimeline(() =>
        pushRespawn({ championKey: championKeyOf(p), name, totalSec })
      );
    }
  }
}

// ---- 오브젝트 교전 분석 ---------------------------------------------------
// 스폰 스케줄(초, 추정). 처치 이벤트로 재스폰 계산.
// 유충은 처치 이벤트가 없어 6:00 1회만(시간 기반으로 마커 정리). 용만 재스폰.
const OBJ_SCHEDULE = [
  // noKillEvent: 처치 이벤트가 안 와서 "살아있음" 추적 불가 → 스폰 직후 잠깐만 노출
  { key: "grubs", label: "유충", first: 480, respawn: null, noKillEvent: true }, // 8:00
  { key: "herald", label: "전령", first: 960, respawn: null }, // 16:00
  { key: "dragon", label: "드래곤", first: 300, respawn: 300 },
  { key: "baron", label: "바론", first: 1200, respawn: 360 },
];

// 오브젝트 그룹/우선순위: 상단(유충<전령<바론)은 한 슬롯 공유 → 높은 것만 표시
const OBJ_GROUP = {
  grubs: "up", herald: "up", baron: "up", dragon: "down", elder: "down",
};
const OBJ_PRIORITY = { grubs: 1, herald: 2, baron: 3, dragon: 1, elder: 2 };

// 창 안의 오브젝트 중 그룹별 최우선 1개씩만 선택(상단 1 + 하단 1)
function selectObjectives(upcoming) {
  const best = {};
  for (const o of upcoming) {
    const g = OBJ_GROUP[o.key] || "down";
    if (!best[g] || (OBJ_PRIORITY[o.key] || 0) > (OBJ_PRIORITY[best[g].key] || 0))
      best[g] = o;
  }
  return Object.values(best);
}

// 단일 마커 우선순위: 임박(0~30초) > 살아있음 > 멀리 임박(31~60초)
function objRank(secondsTo) {
  if (secondsTo > 30) return 2000 + secondsTo; // 멀리 임박: 가장 후순위
  if (secondsTo > 0) return secondsTo; // 임박: 최우선
  return 1000 - secondsTo; // 살아있음(음수): 임박 다음
}

function objectivesInWindow(gameTime, win) {
  const out = [];
  for (const d of OBJ_SCHEDULE) {
    const killed = objectiveKills[d.key];
    let spawnAt;
    if (killed == null) spawnAt = d.first;
    else if (d.respawn != null) spawnAt = killed + d.respawn;
    else continue; // 1회성(전령 등)인데 이미 처치됨
    const secondsTo = Math.round(spawnAt - gameTime);
    if (secondsTo > win) continue; // 아직 60초보다 멀음
    // 유충은 처치 이벤트가 없어 스폰 직후 20초까지만, 나머지는 처치 전까지 계속(살아있음)
    if (d.noKillEvent && secondsTo <= -20) continue;
    out.push({ key: d.key, label: d.label, secondsTo });
  }
  return out.sort((a, b) => objRank(a.secondsTo) - objRank(b.secondsTo));
}

// ---- 오브젝트 교전 TTS ----------------------------------------------------
// 같은 오브젝트 인스턴스(스폰 1회)당 60초 전 / 30초 전 / 소환 직후 1번씩 음성 설명.
const fightTtsSpoken = {}; // instanceId -> Set(stage)

function fightInstanceId(objKey) {
  const killed = objectiveKills[objKey];
  return objKey + ":" + (killed == null ? "first" : Math.round(killed));
}

function verdictPhrase(v) {
  switch (v) {
    case "매우 유리":
      return "지금 교전하면 크게 이득이에요.";
    case "유리":
      return "교전 걸기 좋아요.";
    case "불리":
      return "지금은 싸움을 피하는 게 좋아요.";
    case "매우 불리":
      return "무리하게 싸우지 마세요.";
    default:
      return "전력이 비등하니 신중하게 가세요.";
  }
}

// 판정의 지배 요인 하나를 자연스러운 말로
function fightReasonSpoken(res) {
  const nd = res.numbersDiff || 0;
  if (nd >= 1) {
    const late = res.enemy && res.enemy.lateReturns;
    if (late) return `적 ${late}명이 아직 복귀하지 못했어요.`;
    return "한타 인원이 우리가 더 많아요.";
  }
  if (nd <= -1) {
    const late = res.my && res.my.lateReturns;
    if (late) return `아군 ${late}명이 제때 복귀하지 못해요.`;
    return "한타 인원이 상대가 더 많아요.";
  }
  const ld = res.avgLevelDiff || 0;
  if (Math.abs(ld) >= 0.5)
    return ld > 0 ? "평균 레벨이 우리가 앞서요." : "평균 레벨이 상대가 앞서요.";
  const gd = res.goldDiff || 0;
  if (Math.abs(gd) >= 800)
    return gd > 0 ? "아이템이 우리가 더 좋아요." : "아이템이 상대가 더 좋아요.";
  return "양 팀 전력이 비슷해요.";
}

function buildFightTts(res, stage, label, sec) {
  const reason = fightReasonSpoken(res);
  const verdict = verdictPhrase(res.verdict);
  let lead;
  if (stage === "60") lead = `잠시 뒤 ${label}이 생성됩니다.`;
  else if (stage === "30") lead = `${label} 생성 30초 전입니다.`;
  else lead = sec <= 0 ? `${label}이 생성됐어요.` : `${label}이 곧 생성됩니다.`;
  return `${lead} ${reason} ${verdict}`;
}

function maybeFightTts(res, obj) {
  // 남은 시간으로 단계 결정: ~60초 전 / ~30초 전 / 소환 직후
  const sec = obj.secondsTo;
  const stage = sec >= 40 ? "60" : sec >= 5 ? "30" : "spawn";
  const inst = fightInstanceId(obj.key);
  if (!fightTtsSpoken[inst]) fightTtsSpoken[inst] = new Set();
  if (fightTtsSpoken[inst].has(stage)) return;
  fightTtsSpoken[inst].add(stage);
  const text = buildFightTts(res, stage, obj.label, sec);
  log("교전 TTS:", stage, text);
  playTts(text);
}

// 유충은 처치 이벤트가 없어 시간 기반으로 마커 정리(스폰 8:00 → ~9:00 제거)
let grubsCleared = false;
function maybeClearGrubs() {
  if (grubsCleared) return;
  if (latestGameTime >= 540) {
    grubsCleared = true;
    if (timelineWinId) pushTimeline("fight-clear", { key: "grubs" });
  }
}

// 스폰 60초 전부터 8초마다(임박 시 3초) 창 안의 모든 오브젝트를 각각 분석·갱신.
// 살아있는 오브젝트(처치 전)는 계속 창에 남아 마커가 유지된다.
function maybeFightAnalysis() {
  if (!latestPlayers.length) return;
  const upcoming = objectivesInWindow(latestGameTime, 60);
  if (!upcoming.length) return;

  const now = Date.now();
  // 스폰 임박(양수 12초 이내)일 때만 더 촘촘히(소환 직후 TTS를 제때 발사)
  const s0 = upcoming[0].secondsTo;
  const soon = s0 > 0 && s0 <= 12;
  if (now - lastFightFetch < (soon ? 3000 : 8000)) return; // 스로틀
  lastFightFetch = now;

  const mySide = myTeamSide(latestPlayers);
  const myTeamId = mySide === "CHAOS" ? 200 : 100;
  const players = latestPlayers.map((p) => ({
    teamId: p.team === "CHAOS" ? 200 : 100,
    level: p.level,
    items: (p.items || []).map((it) => it.itemID),
    isDead: !!p.isDead,
    respawnTimer: p.respawnTimer || 0,
  }));

  // 그룹별 최우선 오브젝트만 분석(상단 슬롯 1 + 하단 슬롯 1) → 독립 마커 유지
  selectObjectives(upcoming).forEach((obj) => {
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
        maybeFightTts(res, obj);
      })
      .catch((e) => log("교전 분석 실패", e));
  });
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
let DDRAGON_VER = "15.7.1"; // 최신 버전으로 동적 교체(아이콘/코어목록 일치)
let coreItemIds = null;
function loadCoreItems() {
  if (coreItemIds) return;
  fetch("https://ddragon.leagueoflegends.com/api/versions.json")
    .then((r) => r.json())
    .then((vers) => {
      if (Array.isArray(vers) && vers[0]) DDRAGON_VER = vers[0];
      log("DDRAGON 버전:", DDRAGON_VER);
      return fetch(
        `https://ddragon.leagueoflegends.com/cdn/${DDRAGON_VER}/data/en_US/item.json`
      );
    })
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
    const name = p.riotId || p.summonerName || p.championName || "unknown";
    const allItems = p.items || [];
    const ids = allItems.map((it) => it.itemID);
    // 시야 밖이면 목록이 비거나 줄어듦 → 기록 축소 금지(빈 스냅샷은 무시)
    if (!ids.length) return;

    const seen = prevItems.get(name); // 지금까지 본 아이템 합집합(절대 축소 안 함)
    const isEnemy = p.team && p.team !== mySide;

    // 첫 관측: 기존/시작 아이템은 알리지 않고 기록만
    if (!seen) {
      prevItems.set(name, new Set(ids));
      return;
    }

    ids.forEach((itemID) => {
      if (seen.has(itemID)) return; // 이미 본 아이템(중복 알림 방지)
      seen.add(itemID); // 봤다고 기록 → 같은 아이템 다신 안 울림
      if (!isEnemy) return; // 적만 알림
      const meta = allItems.find((it) => it.itemID === itemID);
      if (meta && meta.consumable) return; // 포션/와드 등 소비템 제외
      const core = !!(coreItemIds && coreItemIds.has(itemID));
      log(
        "적 새 아이템:", p.championName, "id", itemID,
        meta ? meta.displayName : "", "| core:", core,
        "| coreLoaded:", !!coreItemIds, "| overlayId:", overlayId
      );
      if (!core) return; // 코어(완성) 아이템만
      notifyOverlay({
        championName: p.championName,
        championKey: championKeyOf(p), // DDragon 아이콘용 (예: "Zed")
        itemID,
        itemName: meta ? meta.displayName : String(itemID),
        ver: DDRAGON_VER,
      });
    });
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
