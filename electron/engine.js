// engine.js — 앱의 두뇌 (Electron 버전).
// main 프로세스가 Riot Live Client Data를 폴링해 lcd-update로 넘겨주면
// 여기서 분석 → overlay/timeline 창으로 메시지 전송(engineAPI.sendUi) + TTS 재생.
// 게임 데이터 로직은 Overwolf 버전(background.js)과 동일. I/O 경계만 교체.

const API_BASE = "https://lol-stats-kr.vercel.app";
const TEAM_ANALYSIS = "/api/live/team-analysis";
const engineAPI = window.engineAPI; // preload-engine.js가 노출

// 디버그 카운터(로깅용으로만 유지)
let dbgDeaths = 0;

// 플레이어별(팀:챔프 안정키) 본 아이템 합집합 + 직전 시야 여부
const prevItems = new Map();
const prevVisible = new Map();

// ---- 설정(기능×채널 토글). main이 settings.json 읽어 전달. 기본 전부 ON ----
let settings = {
  briefing: { voice: true },
  itemAlert: { overlay: true, voice: true },
  respawn: { overlay: true, voice: true },
  objective: { overlay: true, voice: true },
  volume: 0.8,
  muted: false,
  tone: "banmal", // 음성 말투: "banmal"(친근한 반말, 기본) | "jondaetmal"(존댓말)
  voice: "male", // 목소리: "male"(남성, 기본) | "female"(여성)
};
const voiceOn = (feat) => !settings.muted && settings[feat] && settings[feat].voice !== false;
const overlayOn = (feat) => settings[feat] && settings[feat].overlay !== false;

// ---- 존댓말 → 반말 변환 -----------------------------------------------------
// 모든 TTS 문장(로컬·서버 모두)은 존댓말로 작성된다. 기본 말투가 반말이라
// playTts에서 한 번에 변환한다. 문장은 정형 템플릿이라 종결어미 집합이 유한 →
// 문장 끝(구두점/공백/끝) 기준으로만 치환해 문장 중간 오변환을 막는다.
const BANMAL_RULES = [
  // 명령형(~세요) — 어간 변형이 필요해 명시적으로
  ["잡으세요", "잡아"],
  ["싸우세요", "싸워"],
  ["두세요", "둬"],
  ["가세요", "가"], // 풀어가세요 포함
  ["마세요", "마"],
  ["보세요", "봐"],
  ["굴리세요", "굴려"],
  ["노리세요", "노려"],
  ["하세요", "해"], // 교전/유지/조심/차단/피하세요 등
  // 합쇼체(~습니다)
  ["했습니다", "했어"],
  ["됩니다", "돼"],
  ["좋습니다", "좋아"],
  ["합니다", "해"],
  ["입니다", "이야"], // 전입니다 → 전이야
  // 해요체 서술(~요)
  ["이에요", "이야"],
  ["예요", "야"],
  ["했어요", "했어"],
  ["됐어요", "됐어"],
  ["어요", "어"],
  ["아요", "아"],
  ["해요", "해"], // 강/위험/중요/못/부족/비슷해요
  ["져요", "져"],
  ["서요", "서"],
  // 축약 모음 어간(방어적) — 노려요/켜요/와요/워요/줘요/봐요/대요
  ["려요", "려"],
  ["켜요", "켜"],
  ["와요", "와"],
  ["워요", "워"],
  ["줘요", "줘"],
  ["봐요", "봐"],
  ["대요", "대"],
].map(([from, to]) => [
  // 문장 끝(구두점/공백/문자열 끝)에 붙은 어미만 변환
  new RegExp(from + "(?=[.!?…,\\s]|$)", "g"),
  to,
]);
function toBanmal(text) {
  if (!text) return text;
  let out = text;
  for (const [re, to] of BANMAL_RULES) out = out.replace(re, to);
  return out;
}

function log(...args) {
  console.log("[engine]", ...args);
}

// ---- 게임 생애주기 (main 프로세스가 IPC로 알려줌) -------------------------

let activeSummoner = null; // 내 소환사명 (active_player)

// 게임 종료 시 상태 초기화(다음 판 깨끗하게)
function resetState() {
  prevItems.clear();
  prevVisible.clear();
  prevDeaths.clear();
  processedKills.clear();
  for (const k in objectiveKills) delete objectiveKills[k];
  for (const k in fightTtsSpoken) delete fightTtsSpoken[k];
  loggedEventTypes.clear();
  briefingSent = false;
  lastBriefing = null;
  activeSummoner = null;
  latestPlayers = [];
  latestGameTime = 0;
  lastFightFetch = 0;
  lanePhaseOver = false;
  loggedMe = false;
  grubsCleared = false;
  dbgDeaths = 0;
  log("게임 종료 → 상태 초기화");
}

// 값이 문자열이면 JSON 파싱, 객체면 그대로
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

// main이 보내주는 Riot Live Client Data 스냅샷.
// 키는 main이 {active_player, all_players, game_data, events} 형태로 맞춰서 보냄.
function processLcd(lcd) {
  if (!lcd) return;

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
    latestPlayers = players;
    maybeBriefing(players);
    detectNewItems(players);
    updateRespawns(players);
  }

  const ev = asObj(lcd.events);
  if (ev && Array.isArray(ev.Events)) {
    handleKillEvents(ev.Events);
  }
}

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

// 복귀 + 오브젝트 교전 timeline 창은 main이 항상 띄워둠 → 항상 전송 가능
let timelineWinId = true;

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

const LANE_PHASE_END = 960; // 16분 — 안전망(정글이거나 타워 이벤트 놓쳤을 때)
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

// main이 창을 항상 띄워두므로 즉시 콜백(호출부 수정 최소화용 래퍼)
function openTimeline(cb) {
  cb && cb();
}

function pushTimeline(id, content) {
  engineAPI.sendUi("timeline", id, content);
}
function pushRespawn(payload) {
  if (!overlayOn("respawn")) return; // 복귀 오버레이 꺼짐
  pushTimeline("respawn-add", payload);
}
function pushFight(payload) {
  if (!overlayOn("objective")) return; // 교전 오버레이 꺼짐
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
      // 라인복귀 음성(죽는 순간 1회)
      const cn = p.championName || championKeyOf(p) || name;
      playTts(
        `상대 ${cn}${josa(cn, "이", "가")} 죽었어요. 지금 라인 주도권을 잡으세요.`,
        "respawn"
      );
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

// 표시/분석 우선순위 정렬용: 임박(0~30초) > 살아있음 > 멀리 임박(31~60초)
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

// 판정의 지배 요인 하나를 핵심 숫자와 함께 자연스러운 말로
function fightReasonSpoken(res) {
  const nd = res.numbersDiff || 0;
  if (nd >= 1) {
    const late = res.enemy && res.enemy.lateReturns;
    if (late) return `적 ${late}명이 아직 복귀하지 못했어요.`;
    return `한타 인원이 ${Math.round(nd)}명 더 많아요.`;
  }
  if (nd <= -1) {
    const late = res.my && res.my.lateReturns;
    if (late) return `아군 ${late}명이 제때 복귀하지 못해요.`;
    return `한타 인원이 ${Math.round(-nd)}명 부족해요.`;
  }
  const ld = res.avgLevelDiff || 0;
  if (Math.abs(ld) >= 0.5)
    return ld > 0
      ? `평균 레벨이 ${ld.toFixed(1)} 앞서요.`
      : `평균 레벨이 ${(-ld).toFixed(1)} 뒤져요.`;
  const gd = res.goldDiff || 0;
  if (Math.abs(gd) >= 800) {
    const amount = Math.round(Math.abs(gd) / 100) * 100; // 100단위 반올림
    return gd > 0 ? `아이템 골드 ${amount} 앞서요.` : `아이템 골드 ${amount} 뒤져요.`;
  }
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
  if (!voiceOn("objective")) return; // 교전 음성 꺼짐
  // 남은 시간으로 단계 결정: ~60초 전 / ~30초 전 / 소환 직후
  const sec = obj.secondsTo;
  const stage = sec >= 40 ? "60" : sec >= 5 ? "30" : "spawn";
  const inst = fightInstanceId(obj.key);
  if (!fightTtsSpoken[inst]) fightTtsSpoken[inst] = new Set();
  if (fightTtsSpoken[inst].has(stage)) return;
  fightTtsSpoken[inst].add(stage);
  const text = buildFightTts(res, stage, obj.label, sec);
  log("교전 TTS:", stage, text);
  playTts(text, "objective");
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

  // 창 안의 모든 오브젝트를 각각 분석 → 오브젝트별 독립 마커. 상단 교체는
  // 타임라인이 "소환 완료" 시점에 처리(바론이 다 올라오면 전령 제거).
  upcoming.forEach((obj) => {
    fetch(API_BASE + "/api/live/fight-analysis", {
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
            // 숫자 근거(이미 계산됨) — 타임라인 카드에 표시
            myEff: res.my && res.my.effective,
            enemyEff: res.enemy && res.enemy.effective,
            myLate: res.my && res.my.lateReturns,
            enemyLate: res.enemy && res.enemy.lateReturns,
            levelDiff: res.avgLevelDiff,
            goldDiff: res.goldDiff,
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
  // 내 라인 맞라인 코칭용: 내가 누구인지(챔프/포지션) 같이 보냄
  const meP = players.find((p) => sameName(p, activeSummoner));
  const me = meP
    ? { championKey: championKeyOf(meP), position: meP.position || undefined }
    : undefined;
  const payload = { myTeamId: myTeamId(participants), participants, me };

  const url = API_BASE + TEAM_ANALYSIS;
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
    .then((r) => r.json())
    .then((data) => {
      lastBriefing = data;
      const b = data && data.briefing;
      const tts = b && b.tts;
      log("브리핑:", b && b.compEdge, "| 1부:", !!tts, "| 2부:", !!(b && b.laneTts));
      if (tts) {
        playTts(tts, "briefing"); // 1부 — 팀 5:5 (시작 직후)
        // 2부 — 내 라인 코칭. 약 3초 텀 두고 재생(요즘 라인전 빨라 짧게)
        if (b.laneTts) setTimeout(() => playTts(b.laneTts, "briefing"), 3000);
      } else {
        briefingSent = false; // 브리핑 못 만들면 다음 스냅샷서 재시도
      }
    })
    .catch((e) => {
      log("브리핑 요청 실패", e);
      briefingSent = false; // 다음 스냅샷에서 재시도
    });
}

// engine(숨은 렌더러)에서 TTS 직접 재생 → 창·클릭 불필요
let briefingAudio = null;
// 저수준 재생: 말투/목소리를 직접 받아 합성·재생(게이트 없음).
// tone: "banmal"|"jondaetmal", voice: "female"|"male"
function speak(text, { voice, tone } = {}) {
  if (!text) return;
  if ((tone ?? settings.tone) !== "jondaetmal") text = toBanmal(text); // 기본: 친근한 반말
  const v = voice ?? settings.voice ?? "male";
  const url =
    API_BASE +
    "/api/live/tts?voice=" +
    encodeURIComponent(v) +
    "&text=" +
    encodeURIComponent(text);
  try {
    if (!briefingAudio) briefingAudio = new Audio();
    briefingAudio.src = url;
    briefingAudio.volume = Math.max(0, Math.min(1, settings.volume ?? 0.8));
    briefingAudio.play().catch((e) => log("TTS 재생 실패:", e && e.message));
  } catch (e) {
    log("TTS 오류:", e);
  }
}

// category: 기능별 음성 on/off 게이트("briefing"/"itemAlert"/"respawn"/"objective")
function playTts(text, category) {
  if (category && !voiceOn(category)) return; // 해당 기능 음성 꺼짐 / 음소거
  speak(text, { voice: settings.voice, tone: settings.tone });
}

// 설정 창의 "테스트 재생" — 폼의 현재(미저장) 말투/목소리로 샘플 재생(게이트 무시)
function playTestVoice(cfg) {
  cfg = cfg || {};
  const sample =
    "상대 정글러가 위쪽에서 내려오고 있어요. 지금 라인을 빼고 갱킹을 조심하세요.";
  speak(sample, { voice: cfg.voice || "male", tone: cfg.tone || "banmal" });
}

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
    const isEnemy = p.team && p.team !== mySide;
    // 안정 키(팀:챔프) — riotId/소환사명이 스냅샷마다 흔들려도 안 바뀜(중복 알림 방지)
    const key = `${p.team || "?"}:${championKeyOf(p) || p.riotId || p.summonerName || "?"}`;
    const allItems = p.items || [];
    const ids = allItems.map((it) => it.itemID);

    // 시야 밖이면 목록이 비거나 줄어듦 → 기록 축소 금지 + "직전에 안 보였음" 표시
    if (!ids.length) {
      prevVisible.set(key, false);
      return;
    }
    const wasVisible = prevVisible.get(key) === true;
    prevVisible.set(key, true);

    const seen = prevItems.get(key); // 지금까지 본 아이템 합집합(절대 축소 안 함)
    // 첫 관측: 기존/시작 아이템은 알리지 않고 기록만
    if (!seen) {
      prevItems.set(key, new Set(ids));
      return;
    }

    ids.forEach((itemID) => {
      if (seen.has(itemID)) return; // 이미 본 아이템(중복 알림 방지)
      seen.add(itemID); // 봤다고 기록 → 같은 아이템 다신 안 울림
      if (!isEnemy) return; // 적만 알림
      // 방금 시야로 (다시) 들어온 경우: 그동안 산 아이템 따라잡기 → 알림 안 함(한꺼번에 폭발 방지)
      if (!wasVisible) return;
      const meta = allItems.find((it) => it.itemID === itemID);
      if (meta && meta.consumable) return; // 포션/와드 등 소비템 제외
      const core = !!(coreItemIds && coreItemIds.has(itemID));
      log(
        "적 새 아이템:", p.championName, "id", itemID,
        meta ? meta.displayName : "", "| core:", core,
        "| coreLoaded:", !!coreItemIds
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

// ---- 오버레이 전송 (창 배치/생성은 main이 담당) ---------------------------

// 한글 받침 유무로 조사 선택 (이/가, 을/를)
function josa(word, withBatchim, withoutBatchim) {
  const w = (word || "").trim();
  if (!w) return withoutBatchim;
  const last = w.charCodeAt(w.length - 1);
  if (last < 0xac00 || last > 0xd7a3) return withoutBatchim; // 한글 아니면 받침 없음 취급
  return (last - 0xac00) % 28 !== 0 ? withBatchim : withoutBatchim;
}

function notifyOverlay(payload) {
  log("새 아이템:", payload.championName, payload.itemName);
  if (overlayOn("itemAlert")) engineAPI.sendUi("overlay", "new-item", payload); // 토스트
  // 음성 알림(별도 채널)
  const champ = payload.championName;
  const item = payload.itemName;
  if (champ && item) {
    playTts(
      `상대 ${champ}${josa(champ, "이", "가")} ${item}${josa(item, "을", "를")} 구매했습니다. 인지하고 플레이하세요!`,
      "itemAlert"
    );
  }
}

// ---- main(IPC) 연동 -------------------------------------------------------

engineAPI.onGameStart(() => {
  log("게임 시작 감지 → 상태/마커 초기화 + 코어 아이템 로드");
  // 이전 게임/세션의 잔여 마커(바론·용·복귀 등) 제거 — 창이 세션 내내 유지되므로 필수
  resetState();
  engineAPI.sendUi("timeline", "reset", { v: 1 });
  engineAPI.sendUi("overlay", "reset", { v: 1 });
  loadCoreItems();
});
engineAPI.onLcd((lcd) => processLcd(lcd));
engineAPI.onSettings((s) => {
  if (s) settings = { ...settings, ...s };
  log("설정 갱신:", JSON.stringify(settings));
});
engineAPI.onTestVoice((cfg) => playTestVoice(cfg));
engineAPI.onGameEnd(() => resetState());
