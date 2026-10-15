// One player's input on this page (multiplayer): the phone link for their seat — the Safari controller
// opened from the seat's QR, or a ZIG SIM phone claimed by touching it — the controller (fusion ->
// calibration -> arm model) and their calibration overlay. Buttons follow the single-player ones, plus a
// double tap for a full calibration (no keyboard per player).
import { Quaternion, Vector3 } from 'three';
import { Net } from './net.js';
import { Controller } from './controller.js';
import { CalibFlow } from './calibflow.js';
import { ZigDriver } from './zigdrive.js';
import { SimPhone, poseFromDir } from './sim.js';
import { ArmModel } from './armmodel.js';

const idleQuat = poseFromDir(new Vector3(0, 0.35, -1), new Vector3(0, -1, 0));

export class Seat {
  /**
   * id: seat id (QR / server routing); n: player number (1, 2); store: calibration storage suffix;
   * suffix: calibration overlay element ids; view: calibration visuals; sim: drive by a simulated phone.
   * onButton(kind): 'tap' | 'double' | 'hold' outside calibration.
   */
  constructor({ id, n, store = '', suffix, fx, toast, view, sim = false, clock = () => performance.now(), onButton, onCalibrated }) {
    this.id = id; this.n = n; this.toast = toast; this.clock = clock;
    this.onButton = onButton;
    this.net = new Net({ seat: id });
    this.ctrl = new Controller({ store });
    this.zig = new ZigDriver({ ctrl: this.ctrl, onEvent: (m) => this._event(m) });
    this.zigWaiting = false; this.zigFree = null; this.zigName = null;
    this.sim = new SimPhone((s) => this.ctrl.push(s));
    this.sim.clock = clock;
    if (sim) { this.sim.setEnabled(true); this.net.muted = true; }
    this.net.onSample = (s) => { if (!this.sim.enabled) this.ctrl.push(s); };
    this.net.onEvent = (m) => this._event(m);
    this.flow = new CalibFlow({ ctrl: this.ctrl, net: this.net, fx, sim: this.sim, toast, view, suffix, voice: false,
      onFinish: (mode) => { toast(`${n}P ${mode === 'full' ? '보정 완료' : '정면 재정렬 완료'}`); onCalibrated?.(mode); } });
    this._tapAt = -1e9; this._tapTimer = 0;
  }

  /** Phone data is arriving (or the simulator runs). */
  get live() { return this.sim.enabled || this.net.receiving || this.zig.live; }
  get via() { return this.sim.enabled ? '시뮬레이터' : this.net.receiving ? `폰 · ${this.net.transport}` : this.zig.live ? `ZIG SIM${this.zigName ? ` · ${this.zigName}` : ''}` : ''; }
  get stick() { return this.sim.enabled ? this.sim.stick : this.ctrl.stick; }
  get calibrated() { return this.ctrl.calib.gripCalibrated; }

  _event(m) {
    if (m.type === 'zig') {
      const sd = m.d?.sensordata;
      if (sd?.quaternion && !this.sim.enabled && !this.net.receiving) { this.zig.drive(sd, this.clock()); this.zigName = m.d?.device?.name || this.zigName; }
    } else if (m.type === 'zig-assigned') {
      this.zigWaiting = false; this.zigName = m.name;
      this.toast(`${this.n}P: ZIG SIM 연결 — ${m.name}`, 2000);
    } else if (m.type === 'zig-free') {
      this.zigFree = { name: m.name, at: performance.now() };
    } else if (m.type === 'hello') {
      this.ctrl.fusion.setPlatformHint(m.ua);
    } else if (m.type === 'btn' && m.name === 'tap') {
      if (this.flow.active) { this.flow.onTap(); return; }
      // a second tap within 0.45 s = double tap (full calibration); otherwise a tap, a moment later
      const now = performance.now();
      clearTimeout(this._tapTimer);
      if (now - this._tapAt < 450) { this._tapAt = -1e9; this.onButton?.('double'); return; }
      this._tapAt = now;
      this._tapTimer = setTimeout(() => this.onButton?.('tap'), 460);
    } else if (m.type === 'btn' && m.name === 'hold' && m.down) {
      if (this.flow.active) this.flow.onHold();
      else this.onButton?.('hold');
    }
  }

  /** Ask the server for the next touched ZIG SIM phone. */
  claimZig() { this.zigWaiting = true; this.net.sendServer({ type: 'zig-claim' }); }

  /** Body-frame sword target at time t (ms). */
  target(t, out) {
    if (this.ctrl.ready) this.ctrl.target(t, out);
    else {
      out.quat.copy(idleQuat);
      out.dir.set(0, 1, 0).applyQuaternion(idleQuat);
      this.ctrl.arm.grip(out.dir, out.pos);
      out.w.set(0, 0, 0); out.v.set(0, 0, 0);
    }
    return out;
  }

  update(now, dt) {
    this.sim.update(now);
    this.flow.update(dt);
  }

  /** Hand the seat to another page (a guest PC took it): a claimed ZIG SIM phone stays with the seat id. */
  close() {
    clearTimeout(this._tapTimer);
    if (this.flow.active) this.flow.cancel();
    this.net.close();
  }
}

export const emptyTarget = () => ({ pos: new Vector3(), quat: new Quaternion(), w: new Vector3(), v: new Vector3(), dir: new Vector3() });

const _idleArm = new ArmModel();
/** The sword resting in a low guard (no phone yet). */
export function idleTarget(out) {
  out.quat.copy(idleQuat);
  out.dir.set(0, 1, 0).applyQuaternion(idleQuat);
  _idleArm.grip(out.dir, out.pos);
  out.w.set(0, 0, 0); out.v.set(0, 0, 0);
  return out;
}
