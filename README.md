# lol-overlay

LoL 인게임 오버레이 데스크톱 앱. **Overwolf** 기반. lol-stats 프로젝트의 동반 앱이며, 백엔드·전적 분석은 [lol-stats](https://github.com/leesce10/lol-stats)를 재사용한다. (기획서: lol-stats `docs/features/ingame-overlay.md`)

## ⚠️ 플랫폼: Windows 전용

**Overwolf는 Windows에서만 실행된다.** macOS/Linux에서는 코드 작성만 가능하고, **실제 실행·테스트는 Windows(또는 Windows VM)에서만** 된다. ([Overwolf 공식](https://dev.overwolf.com/ow-native/guides/dev-tools/non-windows-dev/))

> 현재 이 저장소의 코드는 macOS에서 작성됐으며 **Windows에서 아직 검증되지 않았다.** 아래 검증 절차를 Windows에서 한 번 통과시켜야 "동작 확인" 상태가 된다.

## 기능

### A. 아이템 오버레이 (1차)
상대 라이너가 **새 아이템을 완성**하면 화면 위에 **아이템 아이콘 + 한 줄 텍스트** 토스트.
- 데이터: `live_client_data`의 `all_players` 아이템(`itemID`, `displayName`). **로컬, Riot 키 불필요.**

### B. 게임 시작 조합 브리핑 + TTS
게임 시작 시 양팀 챔피언을 모아 백엔드([lol-stats `/api/live/team-analysis`](https://lol-stats-kr.vercel.app/api/live/team-analysis))로 보내고, **우리팀 관점의 게임플랜을 패널 + 음성(TTS)으로** 브리핑한다.
- 조합 분석(강점/약점/타이밍/게임플랜)은 **챔피언 데이터 기반 실데이터 — Riot 키 불필요.**
- 라인별 전적 폼·팀운은 아직 추정(mock)이며 **음성으로는 말하지 않는다**(가짜 숫자 방지). 실데이터는 Riot 프로덕션 키 승인 후.
- TTS는 브라우저/Overwolf의 `speechSynthesis`(ko-KR) 사용.

> 브라우저 demo: `windows/briefing/briefing.html?demo=1` 를 열면 샘플 조합으로 **실제 prod API를 호출**해 패널 렌더 + 음성 재생까지 확인 가능(Mac에서도 동작).

## 구조

```
manifest.json              Overwolf 앱 매니페스트 (game id 5426 = LoL)
windows/
  background/              두뇌: 게임 감지 → 피처 등록 → 아이템 diff → 오버레이에 전달
  overlay/                 투명·클릭스루·항상위 창. 토스트로 아이템 표시
icons/                     icon.png / icon_gray.png (아직 없음 — 추가 필요)
```

## 검증 절차 (Windows에서)

1. **Overwolf 클라이언트 설치** + 개발자 계정.
2. `icons/icon.png`, `icons/icon_gray.png` 추가 (매니페스트가 참조 — 없으면 로드 실패).
3. Overwolf 설정 → **"개발자 옵션" 활성화** → **"Load unpacked extension"** 로 이 폴더 선택.
4. League of Legends 한 판 시작.
5. 확인 포인트:
   - 오버레이 창이 인게임에 뜨는가 (투명/클릭스루)
   - 콘솔(`[bg]` 로그)에서 `setRequiredFeatures` 성공 + `all_players` 수신 여부
   - 상대가 아이템 완성 시 토스트가 뜨는가
6. UI만 빠르게 보려면: 브라우저로 `windows/overlay/overlay.html?demo=1` 열면 더미 토스트 1개 표시.

## 알려진 TODO / 미검증 지점

- [ ] `icons/` 아이콘 파일 추가
- [ ] `all_players` 아이템이 **완성 아이템만** vs 구성요소 포함인지 Windows에서 확인 → 노이즈면 완성템 필터
- [ ] **내 맞라인만 필터링** (지금은 전체 플레이어 알림). `position`/`team`으로 매칭
- [ ] Data Dragon 패치 버전 동적화 (`overlay.js`의 `DDRAGON_VERSION` 하드코딩)
- [ ] 윈도우 메시지 전달(`sendMessage`/`onMessageReceived`) Windows에서 동작 확인
- [ ] `.opk` 패키징 + 코드서명 + 자동업데이트 (배포 단계)

## 백엔드 연동 (2차)

팀 전적 분석은 lol-stats 백엔드의 신규 `/api/live/*`를 호출한다. Riot API 키는 **앱에 넣지 않고** 백엔드에만 둔다.
