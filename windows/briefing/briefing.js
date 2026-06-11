// briefing.js — 게임 시작 시 양팀 조합을 받아 백엔드에 분석 요청 →
// 게임플랜을 화면에 표시하고 TTS로 브리핑한다.
//
// 데이터 흐름:
//   background(참가자 수집) --window message--> 여기 --HTTP--> lol-stats /api/live/team-analysis
// 브라우저 demo: briefing.html?demo=1 로 열면 샘플 조합으로 실제 prod API 호출 + TTS.

const $ = (id) => document.getElementById(id);

function setEdge(edge) {
  const el = $("edge");
  el.className = "edge " + edge;
  el.textContent =
    edge === "ahead" ? "조합 우위" : edge === "behind" ? "조합 열세" : "조합 호각";
}

function fill(ulId, items, empty) {
  const ul = $(ulId);
  ul.innerHTML = "";
  const list = items && items.length ? items : empty ? [empty] : [];
  for (const t of list) {
    const li = document.createElement("li");
    li.textContent = t;
    ul.appendChild(li);
  }
}

// ---- TTS -----------------------------------------------------------------

let ttsAudio = null;

// 브라우저 기본 음성 (성우 TTS 실패 시 폴백)
function fallbackSpeak(text) {
  if (typeof speechSynthesis === "undefined") return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "ko-KR";
    u.rate = 1.05;
    const ko = speechSynthesis.getVoices().find((v) => v.lang.startsWith("ko"));
    if (ko) u.voice = ko;
    speechSynthesis.speak(u);
  } catch (e) {
    console.warn("TTS 실패", e);
  }
}

// 서버의 성우급 TTS(mp3) 재생
function speak(text) {
  if (!text) return;
  const url =
    window.LOLSTATS.API_BASE +
    "/api/live/tts?voice=female&text=" +
    encodeURIComponent(text);
  try {
    if (!ttsAudio) ttsAudio = new Audio();
    ttsAudio.src = url;
    ttsAudio.play().catch(() => fallbackSpeak(text));
  } catch (e) {
    fallbackSpeak(text);
  }
}

// ---- 렌더 ----------------------------------------------------------------

let lastTts = "";

function render(data) {
  const b = data.briefing;
  if (!b) {
    $("status").textContent = "조합 정보가 부족해 브리핑을 생성하지 못했습니다.";
    return;
  }
  setEdge(b.compEdge);
  fill("plan", b.gamePlan, "특이사항 없음 — 기본에 충실하게");
  fill("ourS", b.ourStrengths, "뚜렷한 강점 없음");
  fill("theirS", b.theirStrengths, "뚜렷한 강점 없음");

  // 전적 폼은 아직 추정(mock)이므로 음성으로 단정하지 않고 작게만 표시
  if (data.source === "mock") {
    $("laneNote").textContent =
      "※ 라인별 전적 폼/팀운은 추정치입니다 (실데이터는 Riot 키 승인 후).";
  }

  $("status").hidden = true;
  $("body").hidden = false;

  lastTts = b.tts;
  speak(b.tts);
}

// ---- API 호출 ------------------------------------------------------------

async function analyze(payload) {
  const url = window.LOLSTATS.API_BASE + window.LOLSTATS.TEAM_ANALYSIS;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

function run(payload) {
  $("status").hidden = false;
  $("body").hidden = true;
  $("status").textContent = "조합 분석 중…";
  analyze(payload)
    .then(render)
    .catch((e) => {
      $("status").textContent = "분석 실패: " + e.message;
    });
}

// ---- 버튼 ----------------------------------------------------------------

$("replay").addEventListener("click", () => speak(lastTts));
$("close").addEventListener("click", () => {
  if (typeof overwolf !== "undefined") {
    overwolf.windows.getCurrentWindow((r) =>
      overwolf.windows.close(r.window.id)
    );
  } else {
    window.close();
  }
});

// ---- 진입점 --------------------------------------------------------------

const SAMPLE = {
  myTeamId: 100,
  participants: [
    { riotId: "나#KR1", championKey: "Darius", teamId: 100, position: "TOP" },
    { championKey: "Sejuani", teamId: 100, position: "JUNGLE" },
    { championKey: "Orianna", teamId: 100, position: "MIDDLE" },
    { championKey: "Jinx", teamId: 100, position: "BOTTOM" },
    { championKey: "Leona", teamId: 100, position: "UTILITY" },
    { championKey: "Fiora", teamId: 200, position: "TOP" },
    { championKey: "Graves", teamId: 200, position: "JUNGLE" },
    { championKey: "Zed", teamId: 200, position: "MIDDLE" },
    { championKey: "Ezreal", teamId: 200, position: "BOTTOM" },
    { championKey: "Lulu", teamId: 200, position: "UTILITY" },
  ],
};

if (location.search.includes("demo")) {
  // 브라우저: voices 로드 후 실행 (TTS 음성 목록 비동기 로드)
  if (typeof speechSynthesis !== "undefined") {
    speechSynthesis.onvoiceschanged = () => {};
  }
  setTimeout(() => run(SAMPLE), 300);
} else if (typeof overwolf !== "undefined") {
  // background가 보내는 참가자 명단 수신
  overwolf.windows.onMessageReceived.addListener((msg) => {
    if (msg.id === "briefing-data" && msg.content) run(msg.content);
  });
  // 창이 떴음을 background에 알려 데이터 요청 (background가 보관 중이면 즉시 전송)
  overwolf.windows.sendMessage &&
    overwolf.windows.getMainWindow &&
    (() => {
      try {
        const bg = overwolf.windows.getMainWindow();
        if (bg && bg.requestBriefing) bg.requestBriefing();
      } catch (e) {
        /* background가 push 방식이면 무시 */
      }
    })();
}
