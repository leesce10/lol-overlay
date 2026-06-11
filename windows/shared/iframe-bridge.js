// iframe-bridge.js — Overwolf 창 껍데기 공용 스크립트.
// background가 보내는 메시지를 iframe(웹 오버레이 페이지)으로 postMessage 전달.
// iframe이 아직 로드 전이면 큐에 담았다가 로드 후 flush (일회성 알림 유실 방지).

(function () {
  var f = document.getElementById("f");
  if (!f) return;
  var ready = false;
  var queue = [];

  f.addEventListener("load", function () {
    ready = true;
    for (var i = 0; i < queue.length; i++) {
      try {
        f.contentWindow.postMessage(queue[i], "*");
      } catch (e) {}
    }
    queue = [];
  });

  function forward(msg) {
    var m = { id: msg.id, content: msg.content };
    if (ready && f.contentWindow) {
      try {
        f.contentWindow.postMessage(m, "*");
      } catch (e) {}
    } else {
      queue.push(m);
    }
  }

  if (typeof overwolf !== "undefined") {
    overwolf.windows.onMessageReceived.addListener(forward);
  }
})();
