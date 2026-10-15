// Sensor fusion for the phone controller.
//
// Input : raw samples decoded from the phone packet (see net.js).
// Output: device orientation q (D->E), body angular velocity, earth-frame linear acceleration,
//         and a latency-compensated prediction poseAt(pcTime).
//
// iOS gives us a well-fused attitude (Core Motion) through deviceorientation, but only as
// Euler angles at ~60 Hz, which get unstable near beta = ±90° (phone upright — exactly how a
// sword hilt is held). So we integrate the gyro ourselves and pull toward the measured attitude
// with a complementary filter; isolated Euler glitches are rejected, persistent ones accepted.
import { Quaternion, Vector3 } from 'three';
import { eulerToQuat, expRot, logRot, quatAngle } from './orient.js';

const D2R = Math.PI / 180;
const PERMS = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
const SIGNS = [];
for (let i = 0; i < 8; i++) SIGNS.push([i & 1 ? -1 : 1, i & 2 ? -1 : 1, i & 4 ? -1 : 1]);

const _q = new Quaternion();
const _q2 = new Quaternion();
const _v = new Vector3();
const _w = new Vector3();

export class Fusion {
  constructor() {
    this.params = {
      blend: 0.25,        // complementary filter pull toward measured attitude per sample
      glitchDeg: 25,      // a jump bigger than this vs. gyro prediction is suspicious
      predictMs: 30,      // extra extrapolation to hide network + display latency
      maxPredictMs: 70,
      smoothMs: 20,       // >0: new samples correct the prediction smoothly over this time constant (adds lag);
                          //   on real Wi-Fi recordings 20 ms cut visible snaps 4-5x for ~+0.3° RMS (tools/jumps.mjs)
      stopAware: true,    // don't extrapolate a decelerating swing past its stopping point
      predictGateLo: 0.3, // rad/s: no extrapolation below this (it would only amplify tremor)
      predictGateHi: 1.2, // rad/s: full extrapolation above this
      staleMs: 150,       // no sample for this long = the stream stalled (Wi-Fi burst/power save)
      smoothLateMs: 10,   // ...but only for samples later than this (ms over the fastest delivery), fully from +30 ms
      staleHold: true,    // while stalled: true = hold the last prediction, false = fall back to the last sample
                          //   (falling back snapped the blade back, then forward again when the burst landed)
      staleExtraMs: 60,   // late data: keep extrapolating past maxPredictMs, slowing down with this time constant
      snapDeg: 180,       // with smoothMs: corrections bigger than this snap (180 = never: late bursts after a
                          //   Wi-Fi stall are big, and snapping them is exactly the jump)
      autoMap: true,      // auto-detect gyro axis/unit mapping
    };
    this.q = new Quaternion();       // device -> earth
    this.w = new Vector3();          // angular velocity, device frame, rad/s
    this.wDot = new Vector3();       // angular acceleration (smoothed), device frame, rad/s^2
    this.aE = new Vector3();         // linear acceleration (gravity removed), earth frame, m/s^2
    this.ready = false;
    this.advance = 1;                // d(predicted pose)/d(time) relative to the gyro rate (0 = frozen)
    this.tLast = 0;                  // phone clock, ms
    this.recvLast = 0;               // pc clock, ms
    this.off = null;                 // pc - phone clock offset (min-delay floor), ms
    this.glitchRun = 0;
    this.mapping = { perm: [0, 1, 2], sign: [1, 1, 1], scale: D2R, confident: false, err: null };
    this.accSign = 1;
    this._accVotes = 0;
    this._pairs = [];
    this._qMeasPrev = null;
    this._tMeasPrev = 0;
    this._lags = [];
    this._ivals = [];
    this._corr = new Quaternion();   // decaying correction (earth frame) hiding prediction jumps
    this._corrT = 0;
    this._corrTau = 0;               // time constant of the current correction (ms)
    this._qOld = new Quaternion();
    this._qNew = new Quaternion();
    this.stats = { rateHz: 0, lagMs: 0, lag95Ms: 0, errDeg: 0, glitches: 0, samples: 0 };
  }

  /**
   * Known platform quirks, applied before auto-detection has seen enough motion.
   * iOS Safari (verified on a real iPhone recording): rotationRate alpha/beta/gamma are rates about
   * device x/y/z (spec: z/x/y), and accelerationIncludingGravity has the opposite sign.
   */
  setPlatformHint(ua = '') {
    if (!/iPhone|iPad|iPod/.test(ua) || this.mapping.confident) return;
    this.mapping = { perm: [2, 0, 1], sign: [1, 1, 1], scale: D2R, confident: false, err: null, preset: 'ios' };
    this.accSign = -1;
    this._accVotes = -10;
  }

  /** Restore a mapping confirmed earlier on this device. */
  restoreMapping(m) {
    if (!m || !Array.isArray(m.perm) || !Array.isArray(m.sign)) return;
    this.mapping = { perm: m.perm, sign: m.sign, scale: m.scale, confident: true, err: m.err ?? null, restored: true };
  }

  reset() {
    this.ready = false;
    this.off = null;
    this.tLast = 0;
    this._lags = [];
    this._ivals = [];
    this._qMeasPrev = null;
    this.glitchRun = 0;
  }

  /** raw [rr.beta, rr.gamma, rr.alpha] -> device-frame rad/s using current mapping */
  mapGyro(raw, out) {
    const m = this.mapping;
    return out.set(
      m.sign[0] * raw[m.perm[0]] * m.scale,
      m.sign[1] * raw[m.perm[1]] * m.scale,
      m.sign[2] * raw[m.perm[2]] * m.scale,
    );
  }

  /** Clock bookkeeping shared by both input paths; returns the sample's lateness (ms) or null to drop it. */
  _clock(s) {
    const t = s.t;
    // a new phone session (page reload restarts its clock) or a long dropout: start over
    if (this.ready && (t < this.tLast - 500 || t - this.tLast > 5000)) this.reset();
    // ---- clock offset: floor of (recv - send), allowed to creep up slowly
    const o = s.recv - t;
    if (this.off === null || o < this.off) this.off = o;
    else this.off += Math.min(100, Math.max(0, s.recv - this.recvLast)) * 0.002;
    const lag = s.recv - t - this.off;
    this._lags.push(lag); if (this._lags.length > 120) this._lags.shift();
    if (this.ready && t <= this.tLast) return null;
    return lag;
  }

  /**
   * Samples that already carry the attitude (ZIG SIM app = Core Motion): s = { t, recv, q (device ->
   * reference, z up — same convention as push()'s earth frame), w (device-frame rad/s), a (device-frame
   * m/s², direction of motion) }. Conventions fitted on a recording: tools/zig-frames.mjs.
   */
  pushAttitude(s) {
    const lag = this._clock(s);
    if (lag === null) return;
    const t = s.t;
    const smoothing = this.ready && this.params.smoothMs > 0;
    if (smoothing) this.poseAt(s.recv, this._qOld);
    const dt = this.ready ? Math.min(0.05, (t - this.tLast) / 1000) : 0;
    if (this.ready) { this._ivals.push(t - this.tLast); if (this._ivals.length > 60) this._ivals.shift(); }
    if (this.ready && dt > 0.004) { _v.copy(s.w).sub(this.w).multiplyScalar(1 / dt); this.wDot.lerp(_v, 0.5); }
    this.q.copy(s.q).normalize();
    this.w.copy(s.w);
    this.ready = true;
    this.mapping.confident = true;
    this.aE.copy(s.a).applyQuaternion(this.q);
    this._finish(s, lag, smoothing);
  }

  push(s) {
    const lag = this._clock(s);
    if (lag === null) return;
    const t = s.t;
    const smoothing = this.ready && this.params.smoothMs > 0;
    if (smoothing) this.poseAt(s.recv, this._qOld);
    const dt = this.ready ? Math.min(0.05, (t - this.tLast) / 1000) : 0;
    if (this.ready) { this._ivals.push(t - this.tLast); if (this._ivals.length > 60) this._ivals.shift(); }

    const raw = [s.rrB, s.rrG, s.rrA];
    const wNew = this.mapGyro(raw, _w);
    const hasOri = (s.flags & 1) !== 0;

    let qMeas = null;
    if (hasOri) {
      qMeas = eulerToQuat(s.alpha, s.beta, s.gamma, new Quaternion());
      // gyro mapping self-check: angular velocity implied by successive attitudes
      if (this.params.autoMap && this._qMeasPrev) {
        const dtm = (t - s.oriAge - this._tMeasPrev) / 1000;
        if (dtm > 0.005 && dtm < 0.06) {
          _q.copy(this._qMeasPrev).invert().multiply(qMeas);
          const wq = logRot(_q, new Vector3()).divideScalar(dtm);
          if (wq.length() > 1.2 && wq.length() < 25) {
            this._pairs.push([raw, wq]);
            if (this._pairs.length >= 150) this._evalMapping();
          }
        }
      }
      this._qMeasPrev = qMeas.clone();
      this._tMeasPrev = t - s.oriAge;
    }

    if (!this.ready) {
      if (!qMeas) return;
      this.q.copy(qMeas);
      this.w.copy(wNew);
      this.ready = true;
    } else {
      // predict with trapezoidal angular velocity
      _v.copy(this.w).add(wNew).multiplyScalar(0.5);
      expRot(_v.x, _v.y, _v.z, dt, _q);
      this.q.multiply(_q).normalize();
      if (qMeas) {
        const age = Math.min(0.05, Math.max(0, s.oriAge / 1000));
        expRot(wNew.x, wNew.y, wNew.z, age, _q2);
        qMeas.multiply(_q2);
        const err = quatAngle(this.q, qMeas) / D2R;
        this.stats.errDeg = this.stats.errDeg * 0.9 + err * 0.1;
        let a = this.params.blend;
        if (err > this.params.glitchDeg) {
          this.glitchRun++;
          this.stats.glitches++;
          a = this.glitchRun > 4 ? 1 : 0;
        } else this.glitchRun = 0;
        this.q.slerp(qMeas, a).normalize();
      } else {
        this._tiltCorrect(s, wNew, dt);
      }
      if (dt > 0.004) {
        _v.copy(wNew).sub(this.w).multiplyScalar(1 / dt);
        this.wDot.lerp(_v, 0.5);
      }
      this.w.copy(wNew);
    }

    // ---- gravity sign convention (some iOS versions invert accelerationIncludingGravity)
    const gMag = Math.hypot(s.gx, s.gy, s.gz);
    if (gMag > 8 && gMag < 11.5 && this.w.length() < 0.5) {
      _v.set(0, 0, 1).applyQuaternion(_q.copy(this.q).invert()); // up in device frame
      const d = (s.gx * _v.x + s.gy * _v.y + s.gz * _v.z) / gMag;
      if (Math.abs(d) > 0.8) {
        this._accVotes = Math.max(-30, Math.min(30, this._accVotes + Math.sign(d)));
        if (this._accVotes >= 10) this.accSign = 1;
        if (this._accVotes <= -10) this.accSign = -1;
      }
    }
    if (s.flags & 2) this.aE.set(s.ax, s.ay, s.az).multiplyScalar(this.accSign).applyQuaternion(this.q);
    else this.aE.set(0, 0, 0);
    this._finish(s, lag, smoothing);
  }

  /** After a sample: timing state, and the smoothing correction that hides prediction jumps. */
  _finish(s, lag, smoothing) {
    this.tLast = s.t;
    this.recvLast = s.recv;
    this.stats.samples++;
    if (smoothing) {
      this._corr.identity();
      this._rawPose(s.recv, this._qNew);
      // corr · new = old  ->  corr = old · new⁻¹ (earth frame)
      this._corr.copy(this._qOld).multiply(this._qNew.invert());
      if (this._corr.w < 0) { this._corr.x *= -1; this._corr.y *= -1; this._corr.z *= -1; this._corr.w *= -1; }
      if (quatAngle(this._corr, _q.identity()) > this.params.snapDeg * Math.PI / 180) this._corr.identity(); // big jumps (resync) snap
      this._corrT = s.recv;
      // smooth only what late data causes: a sample on time corrects at once (no added lag), one that
      // was held up (a Wi-Fi burst) blends in over smoothMs
      const late = Math.max(0, Math.min(1, (lag - this.params.smoothLateMs) / 30));
      this._corrTau = this.params.smoothMs * late;
    }
  }

  /** Fallback when no attitude is available: Mahony-style tilt correction from gravity. */
  _tiltCorrect(s, w, dt) {
    const gMag = Math.hypot(s.gx, s.gy, s.gz);
    if (gMag < 7 || gMag > 12.5 || w.length() > 3) return;
    const meas = new Vector3(s.gx, s.gy, s.gz).multiplyScalar(this.accSign / gMag);
    const pred = new Vector3(0, 0, 1).applyQuaternion(_q.copy(this.q).invert());
    const c = new Vector3().crossVectors(pred, meas).multiplyScalar(2.0 * dt);
    expRot(c.x, c.y, c.z, 1, _q2);
    this.q.multiply(_q2).normalize();
  }

  _evalMapping() {
    const pairs = this._pairs;
    // require excitation on every axis, otherwise permutations are ambiguous
    const ex = [0, 0, 0];
    for (const [, wq] of pairs) { ex[0] += wq.x * wq.x; ex[1] += wq.y * wq.y; ex[2] += wq.z * wq.z; }
    const tot = ex[0] + ex[1] + ex[2];
    if (Math.min(...ex) / tot < 0.04) { this._pairs = pairs.slice(-80); return; }
    let best = null;
    const cur = this.mapping;
    let curErr = 0;
    for (const scale of [D2R, 1]) {
      for (const perm of PERMS) {
        for (const sign of SIGNS) {
          let e = 0, n = 0;
          for (const [raw, wq] of pairs) {
            const x = sign[0] * raw[perm[0]] * scale - wq.x;
            const y = sign[1] * raw[perm[1]] * scale - wq.y;
            const z = sign[2] * raw[perm[2]] * scale - wq.z;
            e += x * x + y * y + z * z;
            n += wq.lengthSq();
          }
          const err = e / n;
          if (!best || err < best.err) best = { perm, sign, scale, err };
          if (scale === cur.scale && perm.join() === cur.perm.join() && sign.join() === cur.sign.join()) curErr = err;
        }
      }
    }
    const same = best.scale === cur.scale && best.perm.join() === cur.perm.join() && best.sign.join() === cur.sign.join();
    if (!same && best.err < 0.35 && best.err < curErr * 0.5) {
      this.mapping = { perm: best.perm, sign: best.sign, scale: best.scale, confident: best.err < 0.2, err: best.err };
      if (this.mapping.confident) this.onMappingConfirmed?.(this.mapping);
      console.info('[fusion] gyro mapping switched', this.mapping, 'previous err', curErr.toFixed(3));
    } else {
      const was = this.mapping.confident;
      this.mapping.err = curErr;
      this.mapping.confident = curErr < 0.2;
      if (this.mapping.confident && !was) this.onMappingConfirmed?.(this.mapping);
    }
    this._pairs = [];
  }

  /** Predicted device orientation at pc time `now` (ms), with jump smoothing. */
  poseAt(now, outQ) {
    if (!this._rawPose(now, outQ)) return false;
    const tau = this._corrTau;
    if (tau > 0 && this._corr.w < 0.999999) {
      const k = Math.exp(-Math.max(0, now - this._corrT) / tau);
      _q2.identity().slerp(this._corr, k);
      outQ.premultiply(_q2);
    }
    return true;
  }

  _rawPose(now, outQ) {
    if (!this.ready) { outQ.identity(); return false; }
    const stale = now - this.recvLast > this.params.staleMs;
    let h = (now - (this.tLast + this.off) + this.params.predictMs) / 1000;
    const hMax = this.params.maxPredictMs / 1000, tau = this.params.staleExtraMs / 1000;
    // how fast the predicted pose still moves with time (1 = with the gyro rate): the sword servo's
    // velocity feed-forward must follow it — a frozen pose fed the last angular velocity made the
    // physics blade fly off by itself during Wi-Fi stalls (then the rescue teleported it back)
    this.advance = 1;
    // past the normal horizon (the data is late): carry on, but slowing down — a stalled stream
    // mid-swing then lands closer to where the blade really is
    if (h > hMax && tau > 0) { this.advance = Math.exp(-(h - hMax) / tau); h = hMax + tau * (1 - this.advance); }
    else if (h > hMax) { h = hMax; this.advance = 0; }
    h = Math.max(-0.05, h);
    if (stale && !this.params.staleHold) { h = Math.min(h, 0); this.advance = 0; }
    // rotation over the horizon: w·h + ½·wDot·h², but a decelerating swing must not be
    // extrapolated past the point where it stops (that is what overshoots at the end of a cut)
    const w = this.w, a = this.wDot;
    const wl = w.length();
    let rx = w.x * h, ry = w.y * h, rz = w.z * h;
    if (this.params.stopAware && h > 0 && wl > 1e-3) {
      const along = (a.x * w.x + a.y * w.y + a.z * w.z) / wl; // signed accel along w
      if (along < 0) {
        const tStop = wl / -along;
        const he = h < tStop ? h - (0.5 * h * h) / tStop : 0.5 * tStop;
        rx = (w.x / wl) * wl * he; ry = (w.y / wl) * wl * he; rz = (w.z / wl) * wl * he;
      }
    }
    if (h > 0) {
      const g = Math.max(0, Math.min(1, (wl - this.params.predictGateLo) / Math.max(1e-6, this.params.predictGateHi - this.params.predictGateLo)));
      const k = g * g * (3 - 2 * g);
      rx *= k; ry *= k; rz *= k;
    }
    const ang = Math.hypot(rx, ry, rz);
    if (ang < 1e-9) _q.set(0, 0, 0, 1);
    else { const sn = Math.sin(ang / 2) / ang; _q.set(rx * sn, ry * sn, rz * sn, Math.cos(ang / 2)); }
    outQ.copy(this.q).multiply(_q);
    return true;
  }

  /** Angular velocity in earth frame. */
  angVelEarth(out) { return out.copy(this.w).applyQuaternion(this.q); }

  updateStats() {
    const iv = this._ivals;
    if (iv.length > 5) this.stats.rateHz = 1000 / (iv.reduce((a, b) => a + b, 0) / iv.length);
    const lags = this._lags.slice().sort((a, b) => a - b);
    if (lags.length) {
      this.stats.lagMs = lags[Math.floor(lags.length / 2)];
      this.stats.lag95Ms = lags[Math.floor(lags.length * 0.95)];
    }
  }
}
