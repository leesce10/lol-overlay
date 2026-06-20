// sync-ui.js — 빌드/실행 전에 공용 UI(windows/)와 아이콘을 electron/ 안으로 복사.
// 이유: 패키징된 .exe 안에서는 __dirname/../windows 경로가 깨지므로, 앱 폴더에
// 자체 포함시켜야 한다. windows/ 가 원본(단일 소스), 여기로 복사만 한다.
const fs = require("fs");
const path = require("path");

const root = __dirname;
const win = path.join(root, "..", "windows");
const ui = path.join(root, "ui");
fs.mkdirSync(ui, { recursive: true });

const copies = [
  [path.join(win, "overlay", "overlay.html"), path.join(ui, "overlay.html")],
  [path.join(win, "timeline", "timeline.html"), path.join(ui, "timeline.html")],
  [path.join(root, "..", "icons", "icon.png"), path.join(root, "icon.png")],
];
for (const [src, dst] of copies) {
  fs.copyFileSync(src, dst);
  console.log("synced:", path.relative(root, dst));
}
