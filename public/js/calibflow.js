// Guided calibration with on-screen target poses.
//
// A gold "target sword" is drawn in first person at an exact pose. The player copies it with the
// real phone and holds still; the pose is captured. The live sword stays hidden while capturing —
// matching against a sword drawn with a not-yet-calibrated mapping would bias the result.
// Six copied poses -> least-squares grip + heading (Calibration.solveMulti), then a check step
// where the live sword is shown and the player accepts (tap) or redoes (long press).
import { Quaternion, Vector3 } from 'three';
import { Calibration } from './calib.js';
import { ArmModel } from './armmodel.js';
import { quatAngle, poseFromDir, Q_EW } from './orient.js';

const HOLD = 1.0;                              // s of stillness to capture
export const RING_POS = new Vector3(0, 1.16, -3.0); // body frame: on the camera's centre ray
const V = (x, y, z) => new Vector3(x, y, z).normalize();

const STEPS = {
  intro: {
    title: '보정 준비',
    text: '폰을 칼자루처럼 세로로 쥐세요 (화면 위쪽 = 칼끝).\n노란 칼이 나타나면 실제 칼을 똑같이 들고 멈추면 됩니다.\n준비되면 폰 화면을 한 번 탭하세요.',
    wait: 'tap',
  },
  fwd: { title: '정면 겨누기', text: '화면 가운데 과녁을 칼끝으로 겨누세요.\n손등은 위로. 그대로 유지!', dir: null, edge: V(0, -1, 0), ring: true },
  up: { title: '칼 세우기', text: '노란 칼처럼 얼굴 앞에 칼을 똑바로 세우세요.\n칼날은 화면 쪽. 그대로 유지!', dir: V(0, 1, 0), edge: V(0, 0, -1) },
  fr: { title: '오른쪽 앞', text: '노란 칼처럼 칼끝을 오른쪽 앞으로 (45°).\n손등은 위로. 그대로 유지!', dir: V(0.7, 0.05, -0.7), edge: V(0, -1, 0) },
  fl: { title: '왼쪽 앞', text: '노란 칼처럼 칼끝을 왼쪽 앞으로 (45°).\n손등은 위로. 그대로 유지!', dir: V(-0.7, 0.05, -0.7), edge: V(0, -1, 0) },
  fu: { title: '위쪽 앞', text: '노란 칼처럼 칼끝을 비스듬히 위로 (45°).\n그대로 유지!', dir: V(0, 0.7, -0.7), edge: V(0, -1, 0) },
  fd: { title: '아래쪽 앞', text: '노란 칼처럼 칼끝을 살짝 아래로.\n그대로 유지!', dir: V(0, -0.3, -0.95), edge: V(0, -1, 0) },
  verify: { title: '확인', text: '', wait: 'verify' },
  done: { title: '보정 완료', text: '이제 휘둘러 보세요!\n언제든 폰 화면을 길게 누르면 정면을 다시 맞춥니다.', wait: 1.4 },
  headingDone: { title: '정면 재정렬 완료', text: '', wait: 0.6 },
};
const POSE_IDS = ['fwd', 'up', 'fr', 'fl', 'fu', 'fd'];

export class CalibFlow {
  /** suffix: of the overlay's element ids (two players' overlays on one page); voice: spoken prompts. */
  constructor({ ctrl, net, fx, sim, toast, view, onFinish, suffix = '', voice = true }) {
    this.ctrl = ctrl; this.net = net; this.fx = fx; this.sim = sim; this.toast = toast; this.view = view; this.onFinish = onFinish;
    this.suffix = suffix;
    this.active = false;
    this.steps = [];
    this.i = 0;
    this.stepTime = 0;
    this.caps = {};          // id -> device quaternion
    this.voice = voice;
    this.hold = 0;           // seconds held while the gates are satisfied
    this.buf = [];           // device quaternions during the current hold
    this.badTime = 0;
    this.result = null;
    this.targets = this._buildTargets();
    const $ = (id) => document.getElementById(id + suffix);
    this.el = {
      root: $('calib'), step: $('calStep'), title: $('calTitle'), text: $('calText'), arc: $('calArc'), hint: $('calHint'), ring: $('calRing'),
    };
  }

  /** Target sword poses (body frame) with the grip where the default arm model puts it. */
  _buildTargets() {
    const arm = new ArmModel();
    const out = {};
    for (const id of POSE_IDS) {
      const s = STEPS[id];
      let dir = s.dir;
      if (!dir) {
        // aim from the grip at the ring (two passes: the grip depends on the direction)
        dir = V(0, 0.03, -1);
        for (let k = 0; k < 3; k++) dir = RING_POS.clone().sub(arm.baseGrip(dir)).normalize();
      }
      const quat = poseFromDir(dir, s.edge);
      out[id] = { quat, dir: dir.clone(), grip: arm.baseGrip(dir) };
    }
    return out;
  }

  start(mode = 'full') {
    this.mode = mode;
    this.view.begin?.(mode);
    this.steps = mode === 'full' ? ['intro', ...POSE_IDS, 'verify', 'done'] : ['fwd', 'headingDone'];
    this.caps = {};
    this.result = null;
    this.i = 0;
    this.active = true;
    this.el.root.classList.remove('hidden');
    this._enter();
  }

  cancel() {
    this.active = false;
    this.view.end?.(this.mode);
    this.el.root.classList.add('hidden');
    this.view.showTarget(null);
    this.view.showRing(false);
    this.view.setLive(true);
  }

  get stepId() { return this.steps[this.i]; }

  _enter() {
    const id = this.stepId, d = STEPS[id];
    this.stepTime = 0; this.hold = 0; this.buf = []; this.badTime = 0;
    const capture = POSE_IDS.includes(id);
    const n = this.steps.filter((s) => POSE_IDS.includes(s)).length;
    const k = this.steps.slice(0, this.i + 1).filter((s) => POSE_IDS.includes(s)).length;
    this.el.step.textContent = capture ? `${this.mode === 'full' ? '보정' : '정면 재정렬'} ${k} / ${n}` : '';
    this.el.title.textContent = d.title;
    let text = d.text;
    if (id === 'verify') text = this._verifyText();
    this.el.text.textContent = text;
    this.el.hint.textContent = capture ? '노란 칼과 같은 자세로 멈추면 원이 차오릅니다' : '';
    this.el.ring.style.visibility = capture ? 'visible' : 'hidden';
    this._progress(0);
    // visuals: target sword while capturing; live sword only once calibrated
    const t = this.targets[id];
    this.view.showTarget(capture ? t.quat : id === 'verify' ? this.targets.fwd.quat : null, capture ? t.grip : this.targets.fwd.grip, id === 'verify');
    this.view.showRing(!!(d.ring || id === 'verify'));
    this._drawDiagram(capture ? t.dir : null);
    this.view.setLive(!capture && id !== 'intro');
    this.net.prompt(d.title, text, { tick: capture });
    if (this.voice && 'speechSynthesis' in window && (capture || id === 'intro' || id === 'done')) {
      try {
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(`${d.title}. ${text.split('\n')[0]}`);
        u.lang = 'ko-KR'; u.rate = 1.1;
        speechSynthesis.speak(u);
      } catch {}
    }
    this._simDone = false;
  }

  _verifyText() {
    const r = this.result;
    let q = '';
    if (r) {
      q = `\n보정 품질: 평균 오차 ${r.rms.toFixed(1)}°`;
      if (r.dropped.length) q += ` (${r.dropped.map((i) => STEPS[POSE_IDS[i]].title).join(', ')} 자세는 제외)`;
      if (r.rms > 12) q += '\n자세들이 서로 잘 안 맞습니다. 다시 하는 것을 권장합니다.';
    }
    return `이제 화면 속 칼이 손을 따라 움직입니다.\n과녁을 겨눠 보고 손과 같으면 폰 화면을 탭하세요.\n어긋나면 폰 화면을 길게 눌러 다시 보정합니다.${q}`;
  }

  /** Top and side view sketches of the target blade direction (exact angles, unlike perspective). */
  _drawDiagram(dir) {
    const box = document.getElementById('calDiagram' + this.suffix);
    if (!box) return;
    box.style.display = dir ? 'flex' : 'none';
    if (!dir) return;
    const L = 46;
    const line = (x1, y1, x2, y2, cls) => `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" class="${cls}"/>`;
    // top view: forward (toward the screen) is up
    const hx = 0, hy = 4;
    const tx = hx + dir.x * L, ty = hy + dir.z * L;
    document.getElementById('calTop' + this.suffix).innerHTML =
      line(-34, -52, 34, -52, 'screen') + '<text x="38" y="-48" class="screentxt">화면</text>' +
      '<ellipse cx="0" cy="20" rx="24" ry="9" class="body"/><circle cx="0" cy="20" r="8" class="body"/>' +
      line(hx, hy, tx, ty, 'sword') + `<circle cx="${tx.toFixed(1)}" cy="${ty.toFixed(1)}" r="5" class="tip"/>` +
      `<circle cx="${hx}" cy="${hy}" r="5" class="hand"/>`;
    // side view: the screen is to the right, up is up
    const sx = -6, sy = -2;
    const ex = sx - dir.z * L, ey = sy - dir.y * L;
    document.getElementById('calSide' + this.suffix).innerHTML =
      line(52, -36, 52, 36, 'screen') + '<text x="30" y="-42" class="screentxt">화면</text>' +
      '<circle cx="-24" cy="-38" r="7" class="body"/>' + line(-24, -30, -24, 14, 'body') + line(-24, 14, -32, 50, 'body') + line(-24, 14, -16, 50, 'body') +
      line(-24, -22, sx, sy, 'body') +
      line(sx, sy, ex, ey, 'sword') + `<circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="5" class="tip"/>` +
      `<circle cx="${sx}" cy="${sy}" r="5" class="hand"/>`;
  }

  _progress(p) {
    this.el.arc.style.width = `${Math.max(0, Math.min(1, p)) * 100}%`;
    this.el.ring.classList.toggle('ok', p > 0);
  }

  _next() {
    this.i++;
    if (this.i >= this.steps.length) { this._finish(); return; }
    this._enter();
  }

  _finish() {
    this.active = false;
    this._drawDiagram(null);
    this.view.end?.(this.mode);
    this.el.root.classList.add('hidden');
    this.view.showTarget(null);
    this.view.showRing(false);
    this.view.setLive(true);
    this.net.prompt('검술', '휘두르세요!\n길게 누르기 = 정면 재정렬');
    if (this.sim?.enabled) this.sim.hold(new Vector3(0, 0.35, -1), new Vector3(0, -1, 0), 0.6);
    this.onFinish?.(this.mode);
  }

  /** Phone tap / Enter. */
  onTap() {
    if (!this.active) return;
    const d = STEPS[this.stepId];
    if (d.wait === 'tap' || d.wait === 'verify') this._next();
  }

  /** Phone long press / C during verify: redo. */
  onHold() {
    if (!this.active) return false;
    if (STEPS[this.stepId].wait === 'verify') { this.start('full'); return true; }
    return false;
  }

  _avgQuat() {
    // sign-aligned normalized mean of the last ~0.5 s of the hold
    const n = Math.min(this.buf.length, 30);
    const ref = this.buf[this.buf.length - 1];
    const acc = new Quaternion(0, 0, 0, 0);
    for (let i = this.buf.length - n; i < this.buf.length; i++) {
      const q = this.buf[i];
      const s = q.x * ref.x + q.y * ref.y + q.z * ref.z + q.w * ref.w < 0 ? -1 : 1;
      acc.x += s * q.x; acc.y += s * q.y; acc.z += s * q.z; acc.w += s * q.w;
    }
    return acc.normalize();
  }

  _capture(q) {
    const id = this.stepId;
    this.fx.sfx.play('chime');
    this.net.haptic(1);
    this.caps[id] = q.clone();
    if (this.mode !== 'full') {
      if (!this.ctrl.calib.recenter(q)) { this._retry('칼끝이 너무 위나 아래를 향했습니다. 과녁을 수평으로 겨눠 주세요.'); return; }
      this._next();
      return;
    }
    if (id === POSE_IDS[POSE_IDS.length - 1]) this._solve();
    this._next();
  }

  _solve() {
    const c = this.caps, T = this.targets;
    const pairs = POSE_IDS.map((id) => ({ q: c[id], S: T[id].quat }));
    // "aim at the screen centre" means a different elevation for every monitor height: take the
    // elevation the player actually used (gravity is exact) and keep only heading/roll from that pose
    const top = new Vector3(0, 1, 0).applyQuaternion(c.fwd).applyQuaternion(Q_EW);
    const e = Math.asin(Math.max(-1, Math.min(1, top.y)));
    pairs[0].S = poseFromDir(new Vector3(0, Math.sin(e), -Math.cos(e)), STEPS.fwd.edge);
    let init = Calibration.solve(c.up, c.fwd);
    if (!init.ok) init = { G: this.ctrl.calib.G.clone(), yaw: this.ctrl.calib.headingFor(c.fwd) ?? 0 };
    const sol = Calibration.solveMulti(pairs, init);
    this.result = sol;
    this.ctrl.calib.apply(sol);
    this.ctrl.arm.resetStances();
    this.ctrl.save();
    console.info('[calib] residuals', sol.residuals.map((r) => r.toFixed(1)), 'rms', sol.rms.toFixed(2), 'dropped', sol.dropped);
  }

  _retry(msg) {
    this.fx.sfx.play('error');
    this.toast(msg);
    this.el.hint.textContent = msg;
    this.net.prompt('다시 한 번', msg);
    this.stepTime = 0; this.hold = 0; this.buf = []; this._simDone = false;
  }

  update(dt) {
    if (!this.active) return;
    this.stepTime += dt;
    const id = this.stepId, d = STEPS[id];
    // simulator plays the player: copy the shown pose / tap (driven by step time, so it's deterministic)
    if (this.sim?.enabled && !this._simDone) {
      if (POSE_IDS.includes(id) && this.stepTime > 0.4) { this.sim.holdPose(this.targets[id].quat); this._simDone = true; }
      else if ((d.wait === 'tap' || d.wait === 'verify') && this.stepTime > 1.2) { this._simDone = true; this.onTap(); return; }
    }
    if (typeof d.wait === 'number') { if (this.stepTime > d.wait) this._next(); return; }
    if (!POSE_IDS.includes(id) || !this.ctrl.ready) return;

    const f = this.ctrl.fusion;
    const q = f.q;
    // gate 1: blade elevation (phone top = tip, so this only needs gravity) near the target's
    const top = new Vector3(0, 1, 0).applyQuaternion(q).applyQuaternion(Q_EW); // device +y in world (y up)
    const elev = Math.asin(Math.max(-1, Math.min(1, top.y))) * 57.3;
    const tElev = Math.asin(this.targets[id].dir.y) * 57.3;
    const elevOk = Math.abs(elev - tElev) < (id === 'fwd' ? 35 : 22); // screen-centre aim depends on monitor height
    // gate 2: actually moved since the previous pose
    const prevId = this.steps[this.i - 1];
    const prev = this.caps[prevId];
    const moved = !prev || quatAngle(prev, q) * 57.3 > 20;
    // gate 3: still
    const still = this.ctrl.wSmooth < 0.35;
    const minRead = this.mode === 'full' ? (id === 'fwd' ? 1.6 : 1.0) : 0.3;

    if (this.stepTime > minRead && elevOk && moved && still) {
      this.hold += dt;
      this.buf.push(q.clone());
      this.badTime = 0;
    } else {
      this.hold = Math.max(0, this.hold - dt * 2);
      if (!still) this.buf = [];
      if (this.stepTime > minRead && still) this.badTime += dt;
    }
    this._progress(this.hold / HOLD);
    this.view.setTargetState(this.hold > 0 ? 'ok' : 'idle');
    if (this.badTime > 1.2) {
      this.el.hint.textContent = !moved ? '이전 자세 그대로입니다. 노란 칼 자세로 옮겨 주세요.'
        : elev < tElev ? '칼끝을 조금 더 올리세요' : '칼끝을 조금 더 내리세요';
    }
    if (this.hold >= HOLD && this.buf.length) this._capture(this._avgQuat());
  }
}
