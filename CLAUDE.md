# GyroSword — Claude 작업 안내

아이폰을 칼자루로 쓰는 1인칭 물리 검술 게임(목표: Half Sword 같은 손맛). 웹 기술만 씀:
three.js r186 + Rapier 0.21(compat, wasm 내장), **빌드 없음**(ES 모듈 + importmap), Node 서버 하나(`server.js`).

- 사용자는 한국어로 대화함. **사용자에게 보이는 글(UI 문구, 안내, 보고)은 한국어**, 코드 주석·식별자는 영어.
- 사용자가 방향을 정함(엔진·기기·카메라 사용 여부 등). 큰 방향 전환은 제안만 하고 고르게 할 것.

## 먼저 읽을 문서

| 문서 | 내용 |
|---|---|
| `README.md` | 기능, 조작, 수련장, ZIG SIM 모드, 대결, 튜닝 결과 (사용자용, 한국어) |
| `docs/ARCHITECTURE.md` | 데이터 흐름, 좌표계, 폰 패킷·WS 메시지·서버 엔드포인트, 멀티플레이 프로토콜, 물리·렌더 구조 |
| `docs/DEV-NOTES.md` | 실기기로 확인된 사실과 수치, 시도했다 버린 것, 함정, QA·녹화 재생 방법 |
| `docs/GRIP-APP.md` | ZIG SIM을 대체할 iOS 네이티브 "검 손잡이" 앱 설계 (맥에서 진행) |

## 실행

```
npm install
npm start          # 게임 http://localhost:8080 · 대결 /duel · 폰 https://<LAN IP>:8443/phone · ZIG SIM UDP 50000
node server.js --http 8090 --https 8453 --zig 50001   # 시험용 두 번째 서버 (사용자 서버를 건드리지 않고 QA)
npm test           # 단위 테스트 (node --test)
npm run bench      # 폰→칼 파이프라인 오차 벤치
```

`certs/`(로컬 CA와 서버 인증서, 개인키 포함)는 첫 실행 때 자동 생성된다. 폰은 경고 화면에서 "웹 사이트 방문".

## 코드 지도

| 파일 | 역할 |
|---|---|
| `server.js` | HTTP/HTTPS, 인증서, 폰↔게임 중계(WebRTC 시그널링·WS·HTTP 대체), 자리(seat)별 중계, 대결 방(room) 중계, ZIG SIM UDP(OSC/JSON) 수신, 녹화 저장 |
| `public/phone.html` | 사파리 컨트롤러: DeviceMotion → 80바이트 패킷 60 Hz, 터치 패드(탭·길게·끌기), 햅틱, 카메라 진단 |
| `public/js/main.js` | 단일 플레이 게임 루프 (훈련장 1–6번) |
| `public/js/duel.js`, `fighter.js`, `seat.js` | 대결(로컬 멀티): 라운드·판정·화면 분할 / 대결자(몸·칼·기사 모습) / 한 사람의 입력 |
| `public/js/net.js` | 게임 쪽 링크: 패킷 해독, RTT, 프롬프트·햅틱, 녹화, keep-alive |
| `public/js/controller.js` | 폰 샘플 → 칼 목표(몸 좌표): fusion → calib → armmodel → (ARKit) |
| `public/js/fusion.js` | 센서 융합·예측·끊김 처리 (사파리 패킷 `push`, Core Motion 자세 `pushAttitude`) |
| `public/js/calib.js`, `calibflow.js`, `calvisuals.js` | 그립·정면 보정(6자세 최소제곱), 보정 화면 흐름, 금색 목표 칼 |
| `public/js/armmodel.js` | 칼 방향 → 손 위치 (자세 RBF, 찌르기, 막기 자세 층) |
| `public/js/arkit.js`, `zigdrive.js` | ZIG SIM: ARKit 손 위치를 믿을 때만 섞기 / ZIG 메시지 → 컨트롤러 입력·탭/길게 |
| `public/js/swordctl.js` | 물리 칼 서보 (힘·토크 한도 = 무게감) |
| `public/js/targets.js`, `slicer.js`, `drills.js`, `blockdrill.js` | 짚단 절단, 표적들, 베기 수련, 막기 수련(목각 기사) |
| `public/js/world.js`, `quality.js`, `perf.js`, `fx.js`, `arms.js` | 경기장·후처리, 화질 자동, 프로파일러, 효과음·궤적·불꽃, 1인칭 팔 |
| `public/js/sim.js`, `synth.js` | 가짜 폰(iOS 형식 센서 + 네트워크 지연) — 폰 없이 전체 경로 시험 |
| `public/qa/*.js` | 브라우저 QA 하네스 (막기 녹화 재생, 성능, 저더) |
| `tools/*.mjs` | 녹화 분석·재생·튜닝 도구 (README "개발" 절, docs/DEV-NOTES.md) |
| `test/*.test.js` | 수학·보정·융합·팔 모델 단위 테스트 |

## 일하는 방식

- **실기기 녹화가 기준.** 사용자가 게임에서 F9로 녹화 → `recordings/rec-*.json` (git 제외, PC마다 따로) →
  `tools/*.mjs`나 `public/qa` 하네스로 재생·분석 → 수정 → **같은 녹화로 전후 비교** → 실기기 재시험 요청.
- 튜닝 값을 바꾸면 근거(측정값, 녹화 이름)를 주석에 남긴다 — 기존 코드가 다 그렇게 돼 있음.
- 폰 없이 QA: 시뮬레이터(`btnSim`, `M` 키, 대결은 `/duel?sim`), `?manual` + `game.advance(ms)` / `duel.advance(ms)`
  (가상 시간, 결정적, 폰으로 메시지 안 보냄), `?timer`(숨은 탭에서도 루프), `?pump`(뒤 탭도 60 Hz).
- 화면을 바꿨으면 브라우저 패널로 확인(스크린샷). 서버 코드를 바꿨으면 서버 재시작 필요(정적 파일은 F5만).

## 하지 말 것 / 함정

- `certs/`(개인키), `recordings/`(폰 카메라 사진이 들어갈 수 있음), `node_modules/`는 커밋 금지 (.gitignore 있음).
- 시스템 설정(Wi-Fi 절전 등)은 직접 바꾸지 않는다 — 사용자가 실행할 스크립트(`tools/wifi-lowlatency.bat`)나 안내로.
- 사용자 폰이 연결된 동안 브라우저 패널에서 `phone.html`을 열지 말 것(가짜 폰이 WebRTC를 가로챔).
  QA용 게임 페이지는 `?manual`이나 `?mute`로 — 아니면 사용자 폰의 연결 요청에 응답해 버린다.
- 브라우저 패널이 숨겨지면 rAF가 멈추고 창 크기가 0 → `?timer`/`?pump` + 창 크기 지정(resize).
- 셸 heredoc으로 JS를 고치면 `\n`·백슬래시가 깨지는 일이 있었다 → 편집 도구나 파이썬 스크립트 *파일*로.
- Rapier.js: 구면/일반 관절에 모터 메서드 없음(수동 스프링), 관절로 이은 물체끼리 충돌함(`setContactsEnabled(false)`),
  충돌 훅 안에서 world를 건드리면 안 됨(스텝 전에 스냅숏), `body.mass()`는 다음 스텝까지 갱신 안 됨.
- three.js: `slerpQuaternions(a, b)`에 출력과 같은 객체를 넣으면 깨짐(`copy().slerp()`), 레이어는 자식에게 상속 안 됨.
