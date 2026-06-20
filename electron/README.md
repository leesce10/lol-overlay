# LoL Overlay — Electron 버전 (Overwolf 불필요)

롤 인게임 오버레이를 **Overwolf 없이** 자체 데스크탑 앱으로 띄운다.
데이터는 롤이 직접 띄우는 로컬 API(`https://127.0.0.1:2999/liveclientdata/allgamedata`)에서
직접 읽는다(ToS 안전). UI(`../windows/overlay`, `../windows/timeline`)와 분석 로직은
Overwolf 버전과 동일한 파일을 재사용한다.

## 구조

```
electron/
  main.js            # 메인: LCD 폴링, 창 관리/배치, IPC 중계, 트레이
  preload-engine.js  # 숨은 engine 창에 engineAPI 노출
  preload-overlay.js # overlay/timeline 창: IPC 'msg' → window.postMessage
  engine.html        # 숨은 창 (분석 + TTS)
  engine.js          # 두뇌 (background.js 포팅, Overwolf I/O만 교체)
../windows/overlay/overlay.html   # 적 아이템 토스트 (재사용)
../windows/timeline/timeline.html # 복귀+오브젝트 타임라인 (재사용)
```

## 개발 실행 (macOS/Windows)

```bash
cd electron
npm install
npm start
```

롤 게임(또는 연습/봇전)에 들어가면 오버레이가 자동으로 뜬다. 게임이 없으면
대기 상태로 떠 있다(트레이 아이콘에서 종료).

> ⚠️ **전체화면(exclusive fullscreen)에서는 오버레이가 안 그려진다.** 롤을
> **테두리 없음(Borderless)** 또는 창 모드로 설정해야 한다. (대부분 유저 기본값)

## 배포용 빌드 (.exe, Windows)

```bash
cd electron
npm install
npm run dist     # dist/ 에 NSIS 설치 파일(.exe) 생성
```

- 친구에게 `dist/LoL Overlay Setup x.y.z.exe`만 주면 설치됨. Overwolf/화이트리스트 불필요.
- 서명 안 한 .exe는 Windows SmartScreen이 "알 수 없는 게시자" 경고 → "추가 정보 → 실행".
  경고를 없애려면 코드서명 인증서 필요(연 ~$100~200).

## 동작 요약

1. `main.js`가 1초마다 로컬 LCD API 폴링 → 응답 있으면 게임 중으로 보고 창 표시.
2. 스냅샷을 `{active_player, all_players, game_data, events}`로 매핑해 engine에 전달.
3. `engine.js`가 분석(적 아이템/복귀/오브젝트 교전/브리핑) 후 `sendUi`로 창에 메시지,
   TTS는 engine 창에서 직접 재생(autoplay 허용).
4. 게임 종료(API 응답 끊김) → 창 숨김 + 상태 초기화.
