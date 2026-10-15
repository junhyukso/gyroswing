# "검 손잡이" iOS 앱 설계 (ZIG SIM Pro 대체)

맥에서 Xcode로 만들 네이티브 아이폰 앱. 지금 손 위치는 ZIG SIM Pro(유료 앱)의 ARKit 스트림으로 얻는데(README
"ZIG SIM 모드", docs/ARCHITECTURE.md 3.2), 그 앱의 한계 때문에 우리가 직접 만든다.
이 문서는 앱을 만드는 Claude가 읽고 바로 시작할 수 있게 쓴 것 — 게임 쪽 규약, 패킷 명세, 서버·게임 쪽 수정, 검증 방법.

## 1. 왜 / 무엇을 더 잘해야 하나

| ZIG SIM의 한계 (실측) | 우리 앱에서 |
|---|---|
| OSC에 폰 시각이 없음(타임태그=즉시) → 게임이 도착 시각으로만 처리, Wi-Fi 몰림이 그대로 떨림 | 모든 샘플에 폰 시각(`CMDeviceMotion.timestamp`, `ARFrame.timestamp`, 같은 시계) → Fusion이 지연·떨림을 추정/보정 |
| 60 Hz 상한, 자세와 ARKit이 한 번들에 | Core Motion 100–120 Hz, ARKit 60 Hz는 자기 시각과 함께 |
| ARKit 추적 상태 없음 → 특징점 수로 표류를 추측(`arkit.js`의 복잡한 '눈 감고 움직임' 규칙) | `trackingState`(normal / limited: excessiveMotion·insufficientFeatures·relocalizing)를 그대로 보냄 |
| 자리(1P/2P) 지정 불가 → 버튼 누르고 그 폰 터치로 주인 정함 | 게임 화면의 자리 QR을 앱으로 찍으면 그 자리로 |
| 게임 → 폰이 불가능 (안내 문구·진동 없음) | `prompt` 표시, Core Haptics로 맞음·부딪힘 진동 |
| 터치가 값 하나짜리 OSC 키로 닿아 있는 동안만 옴(탭/길게를 게임이 추측) | 앱이 탭·길게·끌기를 직접 판정해 사파리 컨트롤러와 같은 메시지로 보냄 |

## 2. 게임 쪽 규약 (반드시 맞출 것)

- **쥐는 법**: 세로, **폰 위쪽 = 칼끝**, 화면이 엄지 쪽(오른손으로 앞을 겨누면 화면이 왼쪽). 세로 고정.
- **자세**: `CMAttitude.quaternion` (x, y, z, w) 그대로. 게임은 이것을 **기기 → 기준(z 위)** 회전으로 쓴다(ZIG SIM과 동일).
  - 확인법: 앱 디버그 화면에서 `q⁻¹ · (0, 0, −1)`(기준 → 기기로 돌린 아래 방향)이 `CMDeviceMotion.gravity`와 같아야 함.
  - 기준 프레임: `.xArbitraryZVertical` 권장(자기장 안 씀 → PC·스피커 근처에서 yaw가 갑자기 튀지 않음. yaw 표류는
    게임의 정면 재정렬·ARKit 정렬이 흡수).
- **자이로**: `CMDeviceMotion.rotationRate` (rad/s, 기기 좌표).
- **가속도**: 게임이 원하는 건 **운동 가속도 m/s², 운동 방향**(기기 좌표) = `−9.81 × userAcceleration`.
  (Core Motion `userAcceleration`은 g 단위에 부호가 반대 — ZIG 녹화로 맞춘 사실.) 확인법: 폰을 화면 쪽(+z)으로 밀면 +z.
- **ARKit**: `ARWorldTrackingConfiguration`, `worldAlignment = .gravity`(y 위), 평면 탐지·조명 추정 끔, 60 fps 포맷.
  보낼 것: `frame.camera.transform`의 위치(열 3, m)와 회전 `simd_quatf(transform)` (x, y, z, w) — ZIG SIM과 같은 값.
  게임은 "카메라 축 = 기기 축을 z축으로 +90° 돌린 것"을 가정(`arkit.js` `CAM_FROM_DEV`) — 세로로 쥔 폰의
  `camera.transform`이 그렇다. 특징점 수 = `frame.rawFeaturePoints?.points.count`.
- **렌즈 → 손잡이**: 게임이 카메라 위치에서 손 쥐는 점으로 옮김. iPhone 15 Pro 실측 `[-0.023, -0.091, 0.005]` m
  (`arkit.js` `gripOffset`). 기종마다 다르므로 앱이 `hello`에 기종 id(예: `iPhone16,1`)를 보낸다.
- 시각: `CMDeviceMotion.timestamp`와 `ARFrame.timestamp`는 같은 시계(부팅 후 초). 패킷엔 초(f64)로, 게임이 ms로 바꿈.

## 3. 전송 설계 (권장)

```
 앱 ──UDP <PC>:50000  "GSW2" 센서 패킷 100–120 Hz──▶ server.js ──WS(binary)──▶ 그 자리의 게임 페이지(들)
 앱 ◀─WS ws://<PC>:8080/ws?role=phone&seat=<id>──▶ server.js ◀──────────────▶ 게임 (텍스트 JSON, 사파리와 같은 메시지)
```

- **센서는 UDP**: TCP(WebSocket)는 Wi-Fi 손실(~0.6%) 때 재전송이 뒤 패킷을 묶어 세움(200 ms+). 늦은 센서 패킷은 버리는 게 맞다.
  (사파리 컨트롤러가 WebRTC 비신뢰 채널을 쓰는 이유와 같음.) 서버는 이미 UDP 50000을 듣는다(ZIG SIM용).
- **제어는 WebSocket**(HTTP 포트, 인증서 불필요): `ws://<PC IP>:8080/ws?role=phone&seat=<자리 id>`(자리 없으면 `seat` 생략 =
  단일 플레이). 서버가 이미 자리별로 중계하므로 **서버 수정 없이** 동작.
  - 앱 → 게임: `{"type":"hello","ua":"GyroSwordGrip/1.0 (iPhone16,1; iOS 26.5)","mode":"grip"}`,
    `{"type":"btn","name":"tap"}`, `{"type":"btn","name":"hold","down":true|false}`, `{"type":"pong","t":<받은 t>}`
  - 게임 → 앱: `{"type":"ping","t"}`(→ 바로 pong), `{"type":"rtt","ms"}`, `{"type":"prompt","title","text","color"?,"tick"?}`,
    `{"type":"haptic","n":1..5,"gap":ms}` (n = 세기·횟수, 맞음 4–5, 부딪힘 1–3)
  - 끊기면 1 s 간격으로 재접속. 게임 페이지가 새로 고쳐져도 UDP는 그대로 흐름.
- **페어링**: 게임 화면의 QR = `https://<PC IP>:8443/phone?seat=<id>&p=<번호>` (단일 플레이는 `seat` 없음).
  카메라는 ARKit이 쓰므로 **ARFrame.capturedImage에 Vision `VNDetectBarcodesRequest`**로 QR을 읽는다(별도 카메라 세션 불필요).
  QR에서 IP·자리·번호를 얻고, 포트는 `GET http://<IP>:8080/info`(`httpPort`, `zig.port`)로 — 실패하면 기본 8080/50000.
  마지막 서버를 기억, 수동 IP 입력도.

### 3.1 센서 패킷 "GSW2" (little-endian, 144 B)

| 오프셋 | 형식 | 내용 |
|---|---|---|
| 0 | char[4] | `GSW2` |
| 4 | char[16] | 자리 id ASCII, 나머지 NUL (빈 값 = 단일 플레이) |
| 20 | u32 | seq |
| 24 | u32 | flags: bit0 터치 중, bit1 ARKit 포즈 있음, bit2 이 패킷에 새 ARFrame, bit3 길게 누르는 중 |
| 28 | f64 | tMotion (s, `CMDeviceMotion.timestamp`) |
| 36 | f32×4 | 자세 쿼터니언 x, y, z, w (기기 → 기준) |
| 52 | f32×3 | 자이로 rad/s (기기) |
| 64 | f32×3 | 운동 가속도 m/s² = −9.81 × userAcceleration (기기) |
| 76 | f32×3 | 중력 (g, `CMDeviceMotion.gravity`) — 검증용 |
| 88 | f64 | tArkit (s, 마지막 ARFrame.timestamp) |
| 96 | f32×3 | ARKit 카메라 위치 (m, 세계, y 위) |
| 108 | f32×4 | ARKit 카메라 회전 x, y, z, w |
| 124 | u16 | 특징점 수 |
| 126 | u8 | 추적 상태: 0 notAvailable, 1 limited, 2 normal |
| 127 | u8 | limited 이유: 0 없음, 1 initializing, 2 excessiveMotion, 3 insufficientFeatures, 4 relocalizing |
| 128 | f32×2 | 이동 스틱 x, y (−1..1, 끌기) |
| 136 | f32×2 | 터치 위치 x, y (0..1, 터치 중일 때) |

모션 업데이트마다 1개 송신(최신 ARKit 포즈를 같이 실음, `flags.bit2`로 새 프레임 표시).

### 3.2 서버·게임 쪽 수정 (이 저장소에서 같이 할 일)

1. `server.js` `startZig` UDP 핸들러 맨 앞: `buf.length >= 144 && buf.toString('ascii', 0, 4) === 'GSW2'`이면
   자리 = `seatParam(buf.toString('ascii', 4, 20).replace(/\0+$/, ''))` → `toGames(buf, true, 자리)` 하고 끝(OSC 해독 안 함).
2. `net.js` `_onBinary`: 첫 4바이트가 `GSW2`면 `decodeGrip` → `lastSampleAt` 갱신(자리 "연결됨"이 되게) →
   `this.onGrip?.(s)`; 녹화 중이면 `events`에 `{type:'grip', ...해독값, recv}`.
3. `zigdrive.js`를 일반화(또는 `GripDriver` 추가): 
   `ctrl.pushAttitude({ t: tMotion·1000, recv, q, w, a, stickX, stickY, buttons })`,
   `ctrl.pushArkit({ t: tArkit·1000, recv, pos, rot, att: q, w: |자이로|, fp, tracking })` (새 ARFrame일 때만).
   폰 시각이 있으므로 Fusion이 지연을 추정한다(ZIG는 `t = recv`였음). ARKit이 자이로보다 얼마나 늦은지도
   `tMotion − tArkit`로 정확히 알 수 있음 → `arkit.js` `lead`(지금은 ZIG에서 잰 0.05 s 추정값) 대신 사용.
4. `arkit.js`: `tracking`이 limited(excessiveMotion·insufficientFeatures)·relocalizing이면 '눈 감음'으로 바로 끊고,
   normal로 돌아온 뒤 재인식 튐을 기다림. 특징점 누적 규칙은 보조로 남김.
5. `main.js`(단일)·`seat.js`(대결): `net.onGrip` 연결. 터치는 앱이 `btn` 메시지로 보내므로 추측 불필요.
6. `tools/zig-replay.mjs` 등이 `grip` 이벤트도 읽게.

### 3.2-대안: 0단계 (게임 수정 없이 바로 확인)

ZIG SIM과 같은 OSC 번들을 UDP 50000으로 보내면 지금 게임이 그대로 받는다(서버가 마지막 주소 조각을 키로 씀):
`/ZIGSIM/<uuid>/quaternion ,ffff` · `gyro ,fff`(rad/s) · `accel ,fff`(**g 단위 userAcceleration 원래 부호**) ·
`arkitposition ,fff` · `arkitrotation ,ffff` · `arkitfeaturepoints ,f…`(점마다 3개, 서버가 개수로) ·
`touch01 ,f`·`touch02 ,f`(닿아 있는 동안만) · `/<uuid>/deviceinfo ,ssssii`(이름, uuid, os, 버전, 화면 w, h).
번들 타임태그는 1(즉시)이면 됨. 대결에선 자리 패널의 "ZIG SIM으로 연결" 후 폰 터치로 자리를 잡는다.
앱 뼈대·센서 규약을 먼저 검증할 때만 쓰고, 본 구현은 GSW2로.

## 4. 앱 구성 (Swift, SwiftUI)

- `MotionSource`: `CMMotionManager`, `deviceMotionUpdateInterval = 1/120`, `.xArbitraryZVertical`, 전용 `OperationQueue`.
- `ArSource`: `ARSession` + `ARSessionDelegate.session(_:didUpdate:)` — 최신 포즈·시각·특징점·추적 상태를 잠금으로 보관.
  QR 찾는 동안만 몇 프레임마다 Vision 바코드 검사. 화면에 카메라 영상은 안 띄움(배터리·발열).
- `Link`: `NWConnection`(UDP, `.udp`)로 센서 송신, `URLSessionWebSocketTask`로 제어. 재접속, RTT 표시.
- `Pad`(화면 전체): 탭(< 400 ms, 거의 안 움직임) → `btn tap`; 650 ms 누름 → `btn hold down:true`, 뗌 → `down:false`;
  끌기 → 스틱(시작점 기준, 반경 ~80 pt). 두 번 탭(= 대결의 전체 보정)은 게임이 탭 두 번으로 판정하니 탭만 보내면 됨.
- `Haptics`: `CHHapticEngine` 짧은 transient, `n`에 따라 세기/횟수.
- 화면: 게임 `prompt`를 크게, 연결 상태·주기·RTT·ARKit 추적 상태·자리("1P")·손목 스트랩 안내.
- `UIApplication.shared.isIdleTimerDisabled = true`, 세로 고정, 백그라운드로 가면 센서·ARKit 정지.
- Info.plist: `NSCameraUsageDescription`(ARKit), `NSMotionUsageDescription`, `NSLocalNetworkUsageDescription`,
  `NSAppTransportSecurity.NSAllowsLocalNetworking = true`(ws:// 로컬), `UIRequiredDeviceCapabilities: arkit`.
- 개인 개발자 팀으로 서명해 사용자 폰(iPhone 15 Pro, LiDAR 있음)에 설치.

## 5. 검증 순서

1. 맥에서 서버 실행(`npm install && npm start`), 브라우저로 `http://localhost:8080` (macOS 방화벽이 node를 물으면 허용).
2. 앱 디버그 화면: 중력 확인(2장), 가속도 부호(화면 쪽으로 밀면 +z), 모션 ~120 Hz, ARKit 60 Hz·normal.
3. (선택) 0단계 OSC로 지금 게임의 ZIG SIM 모드가 그대로 움직이는지.
4. GSW2 + 서버·게임 수정 → 단일 플레이 보정·베기, `/duel`에서 자리 QR로 1P/2P 각각.
5. F9 녹화 → `tools/zig-replay.mjs`(grip 이벤트 지원 후)로 ARKit 믿음·오프셋을 ZIG 녹화와 비교
   (docs/DEV-NOTES.md 6절의 수치가 기준). 예상: 폰 시각 덕에 떨림 감소, 추적 상태 덕에 표류 구간을 더 정확히 끊음.
6. 실기기 테스트는 사용자가 함 — 끝나면 무엇을 해 보라고 할지(동작·녹화)를 구체적으로 안내.
