// preload-engine.js — 숨은 engine 창에 IPC 다리를 놓는다.
// contextIsolation:false 라 window에 직접 노출(우리 신뢰 코드만 로드).
const { ipcRenderer } = require("electron");

window.engineAPI = {
  onGameStart: (cb) => ipcRenderer.on("game-start", () => cb()),
  onGameEnd: (cb) => ipcRenderer.on("game-end", () => cb()),
  onLcd: (cb) => ipcRenderer.on("lcd-update", (_e, lcd) => cb(lcd)),
  onSettings: (cb) => ipcRenderer.on("settings", (_e, s) => cb(s)),
  onTestVoice: (cb) => ipcRenderer.on("test-voice", (_e, cfg) => cb(cfg)),
  // engine → main → overlay/timeline 창으로 전달
  sendUi: (target, id, content) =>
    ipcRenderer.send("ui-message", { target, id, content }),
};
