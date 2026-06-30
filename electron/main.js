// main.js — Electron 메인 프로세스.
// 1) Riot Live Client Data(로컬 API) 폴링 → 게임 감지 + 스냅샷
// 2) 투명/클릭통과/항상위 오버레이 창(overlay, timeline) 관리 + 배치
// 3) 숨은 engine 창에 데이터 전달, engine이 보낸 UI 메시지를 창으로 중계
//
// 데이터 출처는 Overwolf가 아니라 롤이 직접 띄우는 https://127.0.0.1:2999.
// UI(overlay.html/timeline.html)는 Overwolf 버전과 동일 파일을 그대로 재사용.

const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage } =
  require("electron");
const path = require("path");
const fs = require("fs");
const https = require("https");
const { autoUpdater } = require("electron-updater");

// ---- 설정(기능×채널 토글) 영속 저장 ----------------------------------------
const SETTINGS_DEFAULT = {
  briefing: { voice: true },
  itemAlert: { overlay: true, voice: true },
  respawn: { overlay: true, voice: true },
  objective: { overlay: true, voice: true },
  volume: 0.8,
  muted: false,
  tone: "banmal", // 음성 말투: "banmal"(친근한 반말, 기본) | "jondaetmal"(존댓말)
  voice: "female", // 목소리: "female"(여성, 기본) | "male"(남성)
};
let settings = { ...SETTINGS_DEFAULT };
function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}
function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsPath(), "utf8");
    settings = { ...SETTINGS_DEFAULT, ...JSON.parse(raw) };
  } catch (e) {
    settings = { ...SETTINGS_DEFAULT };
  }
}
function saveSettings(s) {
  settings = { ...SETTINGS_DEFAULT, ...s };
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  } catch (e) {
    console.log("[main] 설정 저장 실패:", e && e.message);
  }
  sendSettingsToEngine();
}
function sendSettingsToEngine() {
  if (engineReady && engineWin && !engineWin.isDestroyed())
    engineWin.webContents.send("settings", settings);
}

// UI/아이콘은 sync-ui.js가 빌드 전에 electron/ 안으로 복사(.exe 자체 포함)
const OVERLAY_HTML = path.join(__dirname, "ui", "overlay.html");
const TIMELINE_HTML = path.join(__dirname, "ui", "timeline.html");
const ENGINE_HTML = path.join(__dirname, "engine.html");
const ICON = path.join(__dirname, "icon.png");

// 오버레이 크기/배치 상수 (Overwolf 버전과 동일)
const OVERLAY_W = 760, OVERLAY_H = 220, SKILL_CLEARANCE = 480;
const TIMELINE_W = 240, TIMELINE_H = 600;

let overlayWin = null;
let timelineWin = null;
let engineWin = null;
let tray = null;
let engineReady = false;
let inGame = false;

// ---- 창 생성 --------------------------------------------------------------

function makeClickThroughWindow(file, width, height) {
  const win = new BrowserWindow({
    width, height, x: 0, y: 0,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    fullscreenable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload-overlay.js"),
      contextIsolation: false,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setIgnoreMouseEvents(true, { forward: true });
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(file);
  return win;
}

function makeEngineWindow() {
  const win = new BrowserWindow({
    width: 320, height: 200,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload-engine.js"),
      contextIsolation: false,
      nodeIntegration: false,
      backgroundThrottling: false,
      autoplayPolicy: "no-user-gesture-required", // 숨은 창 TTS 자동재생 허용
    },
  });
  win.loadFile(ENGINE_HTML);
  win.webContents.on("did-finish-load", () => {
    engineReady = true;
    sendSettingsToEngine(); // 엔진 준비되면 현재 설정 전달
  });
  return win;
}

// ---- 설정 창 ----------------------------------------------------------------
let settingsWin = null;
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 460,
    height: 580,
    title: "LoL Overlay 설정",
    resizable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, "preload-settings.js"),
      contextIsolation: false,
      nodeIntegration: false,
    },
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.loadFile(path.join(__dirname, "settings.html"));
  settingsWin.on("closed", () => (settingsWin = null));
}

ipcMain.handle("get-settings", () => settings);
ipcMain.on("save-settings", (_e, s) => saveSettings(s));
// 설정 창 "테스트 재생" → 엔진이 폼의 현재 말투/목소리로 샘플 재생
ipcMain.on("test-voice", (_e, cfg) => {
  if (engineReady && engineWin && !engineWin.isDestroyed())
    engineWin.webContents.send("test-voice", cfg);
});

// 게임 해상도(주 모니터) 기준 배치 — Overwolf 버전 좌표 그대로
function positionWindows() {
  const d = screen.getPrimaryDisplay();
  const { x, y, width: W, height: H } = d.bounds;
  // overlay: 가운데 하단(스킬창 위)
  overlayWin.setBounds({
    x: x + Math.round((W - OVERLAY_W) / 2) - 70,
    y: y + Math.round(H - SKILL_CLEARANCE - OVERLAY_H),
    width: OVERLAY_W, height: OVERLAY_H,
  });
  // timeline: 좌측(세로 가운데쯤)
  timelineWin.setBounds({
    x: x + 8,
    y: y + Math.max(40, Math.round((H - TIMELINE_H) / 2) - 90),
    width: TIMELINE_W, height: TIMELINE_H,
  });
}

// ---- 게임 생애주기 --------------------------------------------------------

function startGame() {
  inGame = true;
  positionWindows();
  overlayWin.showInactive(); // 포커스 안 뺏게
  timelineWin.showInactive();
  if (engineReady) engineWin.webContents.send("game-start");
  console.log("[main] 게임 시작 감지 → 오버레이 표시");
}

function endGame() {
  inGame = false;
  if (overlayWin) overlayWin.hide();
  if (timelineWin) timelineWin.hide();
  if (engineReady) engineWin.webContents.send("game-end");
  console.log("[main] 게임 종료 → 오버레이 숨김");
}

// ---- Live Client Data 폴링 ------------------------------------------------

function lcdRequest() {
  return new Promise((resolve, reject) => {
    const req = https.get(
      {
        hostname: "127.0.0.1",
        port: 2999,
        path: "/liveclientdata/allgamedata",
        rejectUnauthorized: false, // 롤 로컬 API는 자체서명 인증서
        timeout: 2000,
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

// Riot 키(camelCase) → engine이 기대하는 키로 매핑
function mapLcd(d) {
  return {
    active_player: d.activePlayer,
    all_players: d.allPlayers,
    game_data: d.gameData,
    events: d.events,
  };
}

function pollLcd() {
  lcdRequest()
    .then((data) => {
      if (!data || !data.allPlayers) return; // 로딩 중 등
      if (!inGame) startGame();
      if (engineReady && engineWin && !engineWin.isDestroyed()) {
        engineWin.webContents.send("lcd-update", mapLcd(data));
      }
    })
    .catch(() => {
      if (inGame) endGame();
    });
}

// ---- IPC 중계 (engine → overlay/timeline) ---------------------------------

ipcMain.on("ui-message", (_e, { target, id, content }) => {
  const w = target === "overlay" ? overlayWin : timelineWin;
  if (w && !w.isDestroyed()) w.webContents.send("msg", { id, content });
});

// ---- 자동 업데이트 (GitHub Release) ---------------------------------------
// idle | checking | available | downloading | downloaded | latest | error
let updateStatus = "idle";
let updateError = "";

function setUpdateStatus(s, err) {
  updateStatus = s;
  updateError = err || "";
  rebuildTray();
}

function setupUpdater() {
  autoUpdater.autoDownload = true; // 백그라운드에서 받아둠
  autoUpdater.autoInstallOnAppQuit = true; // 종료 시 자동 설치
  autoUpdater.on("checking-for-update", () => setUpdateStatus("checking"));
  autoUpdater.on("update-available", () => setUpdateStatus("downloading"));
  autoUpdater.on("update-not-available", () => setUpdateStatus("latest"));
  autoUpdater.on("download-progress", () => {
    if (updateStatus !== "downloading") setUpdateStatus("downloading");
  });
  autoUpdater.on("update-downloaded", () => setUpdateStatus("downloaded"));
  autoUpdater.on("error", (e) => setUpdateStatus("error", e && e.message));
}

function checkForUpdates() {
  if (!app.isPackaged) {
    setUpdateStatus("error", "개발 모드에서는 업데이트 확인 불가");
    return;
  }
  setUpdateStatus("checking");
  autoUpdater.checkForUpdates().catch((e) => setUpdateStatus("error", e && e.message));
}

// ---- 트레이 (업데이트 + 종료) ---------------------------------------------

function updateMenuItem() {
  switch (updateStatus) {
    case "checking":
      return { label: "업데이트 확인 중…", enabled: false };
    case "downloading":
      return { label: "업데이트 다운로드 중…", enabled: false };
    case "downloaded":
      return {
        label: "✅ 업데이트 설치하고 재시작",
        click: () => {
          isQuitting = true;
          // 종료를 막던 핸들러 제거 + 창/트레이 강제 정리 → 설치 프로그램이 닫을 게 없음
          app.removeAllListeners("window-all-closed");
          try {
            if (tray) tray.destroy();
            BrowserWindow.getAllWindows().forEach((w) => {
              try { w.destroy(); } catch (e) {}
            });
          } catch (e) {}
          // isSilent=false → 설치 프로그램이 앱 종료를 기다린 뒤 옛 파일을 지움.
          //   (true=무인이면 닫기 대기를 건너뛰어 "Failed to uninstall old application
          //    files: 2"(파일 잠금) 발생). isForceRunAfter=true → 설치 후 재실행.
          // 창/트레이는 위에서 이미 정리했으므로 "닫을 수 없음" 대화상자는 안 뜬다.
          setImmediate(() => autoUpdater.quitAndInstall(false, true));
        },
      };
    case "latest":
      return { label: "최신 버전입니다 (다시 확인)", click: checkForUpdates };
    case "error":
      return { label: "업데이트 확인 실패 (다시 시도)", click: checkForUpdates };
    default:
      return { label: "업데이트 확인", click: checkForUpdates };
  }
}

function rebuildTray() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: `LoL Overlay v${app.getVersion()}${updateStatus === "downloaded" ? " (업데이트 준비됨)" : ""}`,
        enabled: false,
      },
      { type: "separator" },
      { label: "⚙️ 설정 (기능 켜기/끄기)", click: openSettings },
      { type: "separator" },
      updateMenuItem(),
      { type: "separator" },
      { label: "종료", click: () => app.quit() },
    ])
  );
  tray.setToolTip(
    updateStatus === "downloaded"
      ? "LoL Overlay — 업데이트 준비됨 (트레이에서 설치)"
      : "LoL Overlay (lol-stats)"
  );
}

function makeTray() {
  let img = nativeImage.createFromPath(ICON);
  if (img.isEmpty()) img = nativeImage.createEmpty();
  tray = new Tray(img);
  rebuildTray();
}

// ---- 앱 시작 --------------------------------------------------------------

let isQuitting = false;
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.whenReady().then(() => {
    if (app.dock) app.dock.hide(); // macOS dev: 독 아이콘 숨김
    engineWin = makeEngineWindow();
    overlayWin = makeClickThroughWindow(OVERLAY_HTML, OVERLAY_W, OVERLAY_H);
    timelineWin = makeClickThroughWindow(TIMELINE_HTML, TIMELINE_W, TIMELINE_H);
    makeTray();
    setInterval(pollLcd, 1000);
    setupUpdater();
    if (app.isPackaged) checkForUpdates(); // 시작 시 1회 자동 확인
    console.log("[main] LoL Overlay 시작 — 게임 대기 중");
  });

  // 오버레이 창은 숨김 상태로 유지하므로 종료하지 않는다.
  app.on("window-all-closed", () => {});
}
