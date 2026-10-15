# 구조와 프로토콜

## 1. 한눈에

```
 아이폰 (택1)                         PC: server.js                       PC 브라우저: 게임 페이지
 ─────────────                        ─────────────                       ───────────────────────
 Safari phone.html ──WebRTC 데이터 채널──────────────────────────────────▶ Net (net.js)
   80 B 패킷 60 Hz    (시그널링만 서버)                                      │ decodePacket
                  └─WS / HTTP 대체──▶ 자리(seat)별 중계 ──WS──────────────▶ │
 ZIG SIM Pro ─UDP 50000 (OSC|JSON)──▶ OSC 해독 → {type:'zig'} ──WS──────▶ ZigDriver (zigdrive.js)
 (시뮬레이터 sim.js는 페이지 안)                                            ▼
                                                                Controller (controller.js)
                                                                  Fusion → Calibration → ArmModel
                                                                  (+ 막기 보조 층, + ARKit 손 위치)
                                                                            ▼  칼 목표(몸 좌표)
                                                                SwordController 서보 → Rapier 240 Hz
                                                                            ▼
                                                                충돌 판정(베기·막기·적중) → 렌더(보간)
```

- 입력 샘플은 수신 시각(`recv`)과 폰 시각(`t`)을 같이 가진다. Fusion이 둘의 차이로 지연·떨림을 추정하고
  예측한다 (ZIG SIM OSC는 폰 시각이 없어서 `t = recv`).
- 물리는 240 Hz 고정 스텝, 각 하위 스텝 시각에서 목표를 다시 계산한다. 그리는 칼은 마지막 두 물리 상태 사이를
  보간(일정한 한 스텝 지연, 144 Hz 저더 43% → 11%).

## 2. 좌표계

| 이름 | 정의 |
|---|---|
| 기기 (iOS) | x = 화면 오른쪽, y = 화면 위쪽, z = 화면 밖. **폰 위쪽 = 칼끝**, 화면은 엄지 쪽을 보게 쥠 |
| 지구 (Core Motion식) | z 위. `Q_EW`(x축 −90°)로 three.js의 y-위 세계로 바꿈 |
| 몸 (게임) | 발 원점, y 위, **앞 = −z**, x 오른쪽. 가슴 `CHEST (0, 1.36, −0.04)`, 눈 `EYE (0, 1.62, −0.07)` |
| 칼 | 원점 = 오른손 쥐는 점, +y = 칼날(끝 `SWORD.tip` 1.02 m), +x = 앞날, +z = 칼면 법선 |

보정(`calib.js`): `칼(몸) = Y · Q_EW · q기기 · G`
- `G`: 칼 → 기기 (손에 쥔 방식). 기본값은 Y축 180°(세로, 위쪽이 칼끝, 화면이 엄지 쪽).
- `Y`: 몸 기준 정면. "화면 가운데를 겨눈 칼"이 −z가 되게 하는 yaw.
- 전체 보정 = 금색 목표 칼 6자세를 따라 하고 멈추면 캡처 → `Calibration.solveMulti` 최소제곱(G + yaw), 확인 단계.
  정면 재정렬(길게 누르기) = yaw만.

## 3. 입력 경로

### 3.1 사파리 컨트롤러 패킷 v1 (80 B, little-endian) — `phone.html` 작성, `net.js decodePacket` 해독

| 오프셋 | 형식 | 내용 |
|---|---|---|
| 0 | u8 | 1 (패킷 종류) |
| 1 | u8 | flags: bit0 방향 있음, bit1 중력 뺀 가속도 있음 |
| 2 | u16 | seq (손실 집계) |
| 4 | f64 | t: 폰 시각 ms (DeviceMotionEvent.timeStamp) |
| 12 | f32×3 | deviceorientation alpha, beta, gamma (°) |
| 24 | f32×3 | rotationRate alpha, beta, gamma (°/s) — **iOS에선 기기 x/y/z축 회전**(명세의 z/x/y가 아님) |
| 36 | f32×3 | acceleration (m/s², 중력 제외) |
| 48 | f32×3 | accelerationIncludingGravity (iOS는 부호 반대 → `accSign` 자동 감지) |
| 60 | f32 | event.interval (초) |
| 64 | f32 | oriAge: 방향 샘플 이후 경과 ms (deviceorientation이 ~17 ms 늦게 옴) |
| 68 | f32×2 | 패드 끌기 stick x, y (−1..1) |
| 76 | u32 | buttons (bit1 = 누르고 있음) |

전송: WebRTC 데이터 채널 `s`(비신뢰·비순서, 센서) + `c`(신뢰, 텍스트) 우선. 사파리가 자가서명 인증서로 WSS를
거부해서 폰은 HTTPS fetch로 offer를 올리고(`POST /rtc/offer`), 게임이 WS로 answer, 서버가 `<uuid>.local` 후보를
실제 IP로 바꿔 줌. 실패하면 WS, 그것도 안 되면 `POST /up` HTTP 폴링.

### 3.2 ZIG SIM Pro (UDP, 기본 50000) — `server.js startZig` → `zigdrive.js`

OSC 번들(기본) 또는 JSON. 서버가 `{ device:{name, uuid, …}, sensordata:{<키>: [값…]} }`로 바꿔 `{type:'zig', d, at}` 전달.
게임이 쓰는 키와 규약 (녹화로 맞춤, `tools/zig-frames.mjs`):

| 키 | 규약 |
|---|---|
| `quaternion` [x,y,z,w] | Core Motion 자세, **기기 → 기준(z 위)** |
| `gyro` [x,y,z] | rad/s, 기기 좌표 (CMDeviceMotion.rotationRate) |
| `accel` [x,y,z] | g 단위 사용자 가속도, **부호 반대** → 게임이 ×(−9.81) 해서 m/s² 운동 가속도로 |
| `arkitposition` [x,y,z], `arkitrotation` [x,y,z,w] | ARKit 카메라 포즈(세계, m). 카메라 축 = 기기 축을 z축 +90° 돌린 것 |
| `arkitfeaturepoints` | 점 구름 → 서버가 개수 `{count}`로 줄임 |
| `touch01`, `touch02`, `touchradius0`, `touchforce0` | 손가락이 **닿아 있는 동안만** 값 하나씩 (터치 0의 x, y, 반경, 힘) |
| `deviceinfo` (OSC 주소 `/<uuid>/deviceinfo`) | name, uuid, os, osversion, 화면 w, h — 번들마다 옴 |

- OSC 번들에 타임태그 없음(즉시=1) → 폰 시각 없음. 60 Hz가 상한.
- 터치: 650 ms 이상 = 길게(재정렬), 400 ms 미만 후 뗌 = 탭, 뗌 판정은 50 ms 무입력 후.
- ARKit 하이브리드(`arkit.js`): 팔 모델 손 위치를 기본으로, ARKit을 **믿을 수 있을 때만** 그쪽으로 당김.
  세계 정렬 `W = rot · C · att⁻¹`(느릴 때만 갱신), 렌즈→손잡이 오프셋(iPhone 15 Pro 실측 `[-0.023, -0.091, 0.005]` m),
  기본 자세에서 팔 모델에 다시 묶음(몸이 움직여도 손이 따라가지 않게). 믿음 규칙은 docs/DEV-NOTES.md.

### 3.3 시뮬레이터 (`sim.js`)

iOS 형식 샘플을 만들고 네트워크 지연·지터·끊김을 흉내 냄. 마우스 조작, `swing(name)` 대본 스윙
(vertical, diagonal, horizontal, rising, thrust), `holdPose(q)`. 보정 흐름은 시뮬레이터면 스스로 자세를 잡음.

## 4. 컨트롤러 (`controller.js`)

`push(s)`(사파리) / `pushAttitude(s)`(Core Motion 자세) → `target(t, out)` → `{pos, quat, w, v, dir}` (몸 좌표).

1. **Fusion**: 자이로 적분 + 자세 보정, 오일러 특이점 튐 제거, 축/단위 자동 감지, 지연 추정·예측(회전속도로 켜짐),
   끊김 중 예측 유지(`staleHold`), 보정 완화(`smoothMs`).
2. **떨림 필터**: 속도 적응형 저역 통과(멈추면 2 Hz, 움직이면 풀림).
3. **ArmModel**: 칼 방향 → 손 위치(보정한 자세들 RBF 보간), 가속도로 찌르기·손 이동(ZUPT), 팔 개입도
   (스윙 중 손 속도: 손목 1.0–1.4 m/s, 팔 2.5–3.5 m/s) → 베기 유효 질량.
4. **막기 보조**(막기 수련에서 공격이 올 때만): 막기 자세 원형, 옆 막기 의도, 공격 높이 맞추기, 막기 손 배치.
   ARKit 기준이 잡혀 있으면 전부 끔(`assistWithArkit`).
5. **ARKit 섞기**: `_arkitBlend` — 믿음(trust)에 따라 손 오프셋을 ARKit 손 쪽으로.

## 5. 물리 (`swordctl.js`, Rapier)

- 칼 = 동적 강체(날 볼록 껍질 0.8 kg + 가드·손잡이·폼멜, CCD). 목표로 속도 서보: 위치 kLin 38, 회전 kAng 50,
  힘 500 N·토크 220 N·m 한도(무게감), 따라잡기 회전 9 rad/s 한도. 0.5 s 넘게 0.65 m 이상 벗어나면 순간이동 복구.
- 충돌 그룹(`world.js GROUPS`): STATIC, SWORD, PLAYER, TARGET, DEBRIS, ENEMY. 대결은 비트 6–9를 따로 씀
  (`fighter.js DUEL`: 각자의 칼·몸).
- 베기(`targets.js`): 접촉 훅에서 칼날 수직 속도·날 정렬·½·m_eff·v² ≥ 70 J면 실제로 자름(짚단을 두 조각으로).

## 6. 서버 (`server.js`)

| 경로 | 내용 |
|---|---|
| `GET /` , `/duel` | 게임, 대결 페이지 (HTTP 8080, localhost는 보안 컨텍스트) |
| `GET /phone` | 폰 컨트롤러 (HTTPS 8443만, HTTP로 오면 리다이렉트) |
| `GET /info` | IP, 포트, 폰 URL, 연결 수, ZIG 통계 |
| `GET /qr.svg[?seat=<id>&p=<n>]` | 폰 URL QR (자리 있으면 `?seat=&p=` 붙음) |
| `GET /ca.crt` | 로컬 CA (iOS에 설치해 신뢰하면 경고 없음) |
| `POST /rtc/offer?id=&for=&seat=` · `GET /rtc/answer?id=` | WebRTC 시그널링 |
| `POST /up?id=&seat=[&t=1]` | HTTP 대체 업링크 (응답 = 쌓인 다운링크 메시지) |
| `POST /rec` · `GET /rec/<이름>` | 녹화 저장 / 읽기 (localhost만) |
| WS `/ws?role=game|phone[&seat=]` | 중계. 자리가 같은 것끼리만 (자리 없음 = 단일 플레이) |
| WS `/ws?role=duel&room=&side=host|guest` | 대결 방: 방장↔2P JSON 중계, `{type:'peer'}` 알림 |
| UDP `--zig` (50000) | ZIG SIM. 기기(uuid)별 주인 자리(`zig-claim` 후 터치한 폰) |

### 메시지 (텍스트 JSON)

- 폰 → 게임: `hello {ua, mode}`, `started`, `btn {name:'tap'}`, `btn {name:'hold', down}`, `pong {t}`, `cam*`(진단)
- 게임 → 폰: `ping {t}`, `rtt {ms}`, `prompt {title, text, color?, tick?}`, `haptic {n, gap}`, `rtc-reoffer {for}`
- 게임 → 서버: `rtc-answer {id, from, sdp}`, `zig-claim`, `zig-release`
- 서버 → 게임: `phones {count}`, `rtc-offer {id, sdp, for}`, `zig {d, at}`, `zig-assigned {name}`, `zig-free {name}`
- keep-alive: 게임이 RTC `s` 채널로 10 ms마다 1바이트 (PC Wi-Fi 절전으로 생기는 100–200 ms 멈춤 방지, 폰은 무시)

## 7. 대결 (`/duel`)

- **자리**: 방 코드 6글자 `R`, 자리 id `R+'a'`(1P), `R+'b'`(2P). 각 자리 = `Seat`(Net + Controller + CalibFlow + ZigDriver).
  같은 PC의 2P는 보정을 `gyrosword.calib.v2.p2`에 따로 저장.
- **방장(host)**: 물리 세계 하나에 대결자 둘(`Fighter`). 2P가 다른 PC로 들어오면(`peer`) 자기 2P 자리를 닫고(폰이 그 PC로 감)
  1P 전체 화면, 나가면 다시 화면 분할.
- **2P 컴퓨터(guest, `/duel?join=R`)**: 자기 자리의 입력·보정을 직접 하고, 칼 목표를 보냄. 그림은 방장 스냅숏으로.
- 방장 ← 2P: `tgt {p, q, v, w, inv, sx, sy}`(~120 Hz, 몸 좌표 목표·팔 개입도·이동), `seat {live, cal, calibrated, via}`, `tap`
- 방장 → 2P: `snap {st, w, r, b, win, s0, f:[{p:[x,z], y, sp, sq, hp, ts}], ev:[…]}`(60 Hz, 2P는 28 ms 늦춰 보간),
  `prompt`, `haptic`. 이벤트: `clash {p, s, n}`, `hit {a, d, z, kind, dmg, p, s}`, `touch`
- 방장은 2P 목표를 받은 속도로 최대 50 ms 앞으로 밀어 씀.
- **상태**: lobby → (둘 다 탭) countdown 3 s → fight → ko 2.6 s → 다음 라운드 | matchEnd(2승) → 둘 다 탭.
- **판정** (`duel.js hit`): 칼과 상대 몸(몸통 캡슐·머리 공)이 **새로 닿을 때만**, 그 칼 자체의 접점 속도로.
  베기: 칼날 수직 속도·날 정렬(0.55 미만 = 칼등 ×0.35)·팔 개입도로 질량 0.35–1.5 kg → ½mv²/70 J × 25, 최대 35, 머리 ×1.5.
  찌르기: 끝 22 cm 안에서 칼날 방향 속도 > 2.5 m/s, 팔 질량, 20 J 기준. 최소 3 미만은 'touch'. 적중 후 0.45 s 쿨다운.
- **거리**: 1.8 m에서 시작, 칼끝 속도 5→12 m/s에 따라 최대 0.4 m 내딛기, 항상 서로 마주 봄, 최소 간격 1 m.
- **화면**: 플레이어 i의 카메라는 레이어 0과 1+i. 상대 기사는 상대 카메라 레이어, 1인칭 팔·보정 칼은 자기 레이어,
  칼은 둘 다(자기 보정 중엔 자기 화면에서 숨김). 화면 분할 = 뷰포트·시저 + 카메라마다 후처리 체인(`makeComposer`), AO 끔.

## 8. 렌더

`world.js`: 하늘·안개·태양 그림자, 모래·울타리·소품, 후처리(RenderPass → GTAO(반해상도) → Bloom → Output → SMAA).
GTAO는 투명 물체(궤적·유령 칼·흐려지는 팔)를 법선 패스에서 숨겨야 어두워지지 않음. 화질 자동(`quality.js`):
GPU 시간이 화면 주기 예산을 넘으면 high → medium → low.

## 9. 녹화 (F9) 형식

`recordings/rec-<시각>.json`:
`{ version, started, meta: {calib, stances, params}, samples: [해독된 v1 패킷 + recv], events: [폰 텍스트 메시지·zig·drill + recv], mapping, accSign }`.
막기 수련은 공격 시작·결과(`type:'drill'`)도 기록. 재생 도구가 이 형식을 읽는다 (docs/DEV-NOTES.md).
