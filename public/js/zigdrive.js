// ZIG SIM Pro (iOS app with ARKit) as the controller: its Core Motion attitude goes through the same
// fusion / calibration / arm model as the Safari page's samples, ARKit adds the real hand position while
// it can be trusted (arkit.js), and touches become taps / holds like the controller page's.
import { Quaternion, Vector3 } from 'three';

const ZIG_ACC = -9.81; // Core Motion user acceleration: in g, pointing against the motion (tools/zig-frames.mjs)

export function zigTouching(sd) {
  if (Array.isArray(sd.touch)) return sd.touch.length > 0;
  // OSC: one value per address — touch01 / touch02 (x, y of touch 0), touchradius0, touchforce0 — and
  // only while a finger is down (rec 06-37-59)
  return Object.keys(sd).some((k) => /^touch\d/i.test(k));
}

export class ZigDriver {
  /** ctrl: Controller; onEvent: (msg) => void gets { type: 'btn', name: 'tap' | 'hold', down } like the phone page's. */
  constructor({ ctrl, onEvent }) {
    this.ctrl = ctrl;
    this.onEvent = onEvent;
    this.lastAt = -1e9;
    this.touchAt = null; this.touchLast = 0; this.held = false;
  }

  get live() { return performance.now() - this.lastAt < 500; }
  get touching() { return this.touchAt !== null; }

  /** One ZIG SIM message's sensordata; t = sample time on the game clock (ms; OSC carries no phone time). */
  drive(sd, t) {
    const now = performance.now();
    // touches -> tap (short) / hold (long), released only after 50 ms without touch data: a dropped or
    // touch-less packet doesn't split a hold
    const touching = zigTouching(sd);
    if (touching) this.touchLast = now;
    if (touching && this.touchAt === null) { this.touchAt = now; this.held = false; }
    if (touching && !this.held && now - this.touchAt > 650) { this.held = true; this.onEvent({ type: 'btn', name: 'hold', down: true }); }
    if (!touching && this.touchAt !== null && now - this.touchLast > 50) {
      if (!this.held && this.touchLast - this.touchAt < 400) this.onEvent({ type: 'btn', name: 'tap' });
      this.touchAt = null;
    }
    const att = new Quaternion(...sd.quaternion).normalize();
    const w = new Vector3(...(sd.gyro || [0, 0, 0]));
    const a = new Vector3(...(sd.accel || [0, 0, 0])).multiplyScalar(ZIG_ACC);
    this.ctrl.pushAttitude({ t, recv: t, q: att, w, a, stickX: 0, stickY: 0, buttons: this.touchAt !== null ? 1 : 0 });
    if (sd.arkitposition && sd.arkitrotation) this.ctrl.pushArkit({ t, recv: t, pos: sd.arkitposition, rot: sd.arkitrotation, att, w: w.length(), fp: sd.arkitfeaturepoints?.count ?? 0 });
    this.lastAt = now;
  }
}
