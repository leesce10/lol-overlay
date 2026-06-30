// preload-settings.js — 설정 창에 안전한 API 노출
const { ipcRenderer } = require("electron");

window.settingsAPI = {
  get: () => ipcRenderer.invoke("get-settings"),
  save: (s) => ipcRenderer.send("save-settings", s),
};
