// preload-overlay.js — overlay/timeline 창용.
// main이 보내는 'msg' IPC를 window.postMessage로 바꿔서, 기존 HTML의
// 브라우저 경로(window.addEventListener("message", ...))가 그대로 받게 한다.
const { ipcRenderer } = require("electron");

ipcRenderer.on("msg", (_e, data) => {
  window.postMessage(data, "*");
});
