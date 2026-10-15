// Cutting drills ("베기 수련"): one target at a time, a glowing arrow showing the cut to make, and a
// judge that reads the actual cut direction (where the edge travelled through the mat, seen from the
// player) and scores it.
import * as THREE from 'three';

// cut direction as seen by the player: angle in the frontal plane, 0° = left→right, 90° = upward
export const DRILLS = [
  { id: 'h-rl', name: '수평베기', sub: '오른쪽 → 왼쪽', angle: 180, rig: 'stand' },
  { id: 'h-lr', name: '수평베기', sub: '왼쪽 → 오른쪽', angle: 0, rig: 'stand' },
  { id: 'v-down', name: '수직 내려베기', sub: '위 → 아래 · 눕힌 짚단', angle: -90, rig: 'rack' },
  { id: 'kesa', name: '사선 내려베기', sub: '오른쪽 위 → 왼쪽 아래', angle: -135, rig: 'stand' },
  { id: 'gyaku-kesa', name: '역사선 내려베기', sub: '왼쪽 위 → 오른쪽 아래', angle: -45, rig: 'stand' },
  { id: 'kiriage', name: '올려베기', sub: '왼쪽 아래 → 오른쪽 위', angle: 45, rig: 'stand' },
  { id: 'gyaku-kiriage', name: '역 올려베기', sub: '오른쪽 아래 → 왼쪽 위', angle: 135, rig: 'stand' },
  { id: 'thrust', name: '찌르기', sub: '과녁 한가운데를 찌르세요', rig: 'disk' },
  { id: 'combo', name: '연속베기', sub: '사선 → 역사선 · 2초 안에', sequence: [-135, -45], rig: 'stand' },
];

// names for judging what the player actually did
const DIRECTIONS = [
  [180, '수평베기 (←)'], [0, '수평베기 (→)'], [-90, '수직 내려베기'], [90, '수직 올려베기'],
  [-135, '사선 내려베기 (↙)'], [-45, '역사선 내려베기 (↘)'], [45, '올려베기 (↗)'], [135, '역 올려베기 (↖)'],
];
const wrap = (a) => ((((a + 180) % 360) + 360) % 360) - 180;
const ARROWS = { 180: '←', 0: '→', '-90': '↓', 90: '↑', '-135': '↙', '-45': '↘', 45: '↗', 135: '↖' };

export const ZONE = new THREE.Vector3(6.6, 0, 2.6); // where the player stands (facing -z)
const GUIDE = 0x46d7ff;

export class Drills {
  constructor({ scene, targets, toast, sfx, haptic }) {
    this.scene = scene; this.targets = targets; this.toast = toast; this.sfx = sfx; this.haptic = haptic;
    this.params = { tolerance: 25, respawn: 1.4, comboWindow: 2.0 };
    this.index = 0;
    this.rig = null;
    this.active = false;
    this.respawnAt = 0;
    this.time = 0;
    this.stats = DRILLS.map(() => ({ tries: 0, ok: 0, errs: [] }));
    this.combo = null; // { step, t }
    this.lastHitT = -9;
    targets.stations.push({ name: '베기 수련', pos: ZONE.clone(), yaw: 0 });
    this._buildGuides();
    this._buildPanel();
    this.select(0);
  }

  get drill() { return DRILLS[this.index]; }

  // ------------------------------------------------------------------ rigs
  _rigPos(kind) {
    const z = ZONE.z;
    if (kind === 'rack') return new THREE.Vector3(ZONE.x, 0, z - 1.2);
    if (kind === 'disk') return new THREE.Vector3(ZONE.x, 0, z - 1.55);
    return new THREE.Vector3(ZONE.x, 0, z - 1.4);
  }

  select(i) {
    this.index = (i + DRILLS.length) % DRILLS.length;
    const d = this.drill;
    this.targets.removeTagged('drill');
    if (!this.rig || this.rig.kind !== d.rig) {
      this.rig?.dispose();
      const p = this._rigPos(d.rig);
      this.rig = d.rig === 'rack' ? this.targets.createRackRig(p.x, p.z)
        : d.rig === 'disk' ? this.targets.createDiskRig(p.x, p.z)
        : this.targets.createStandRig(p.x, p.z);
    }
    this._spawn();
    this.combo = null;
    this._updateGuide();
    this._renderPanel();
  }
  next() { this.select(this.index + 1); this.sfx.play('tick'); this.toast(`${this.drill.name} · ${this.drill.sub}`); }
  prev() { this.select(this.index - 1); this.sfx.play('tick'); this.toast(`${this.drill.name} · ${this.drill.sub}`); }

  _spawn() {
    this.targets.removeTagged('drill');
    this.respawnAt = 0;
    if (this.rig.kind === 'stand') this.spawned = this.targets.spawnStandingMat(this.rig, 'drill');
    else if (this.rig.kind === 'rack') this.spawned = this.targets.spawnLyingMat(this.rig, 'drill');
    else this.spawned = null;
    this.spawnPos = this.spawned ? this.spawned.body.translation() : null;
    this.combo = null;
    this._updateGuide();
  }

  // ------------------------------------------------------------------ guide visuals
  _buildGuides() {
    // cyan reads against straw (gold didn't)
    const mat = new THREE.MeshBasicMaterial({ color: GUIDE, transparent: true, opacity: 0.85, depthTest: false, side: THREE.DoubleSide });
    this.guideMat = mat;
    const arrow = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.045), mat);
    shaft.position.x = -0.04;
    const shape = new THREE.Shape();
    shape.moveTo(0, 0.08); shape.lineTo(0.15, 0); shape.lineTo(0, -0.08); shape.closePath();
    const head = new THREE.Mesh(new THREE.ShapeGeometry(shape), mat);
    head.position.x = 0.27;
    arrow.add(shaft, head);
    arrow.traverse((o) => { o.renderOrder = 8; o.userData.noAO = true; });
    this.arrow = arrow;
    this.scene.add(arrow);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.008, 8, 40), mat);
    ring.renderOrder = 8; ring.userData.noAO = true;
    this.ring = ring;
    this.scene.add(ring);
    arrow.visible = ring.visible = false;
  }

  _guideCenter() {
    const k = this.rig.kind;
    if (k === 'disk') return this.rig.center.clone().add(new THREE.Vector3(0, 0, 0.02));
    if (k === 'rack') return new THREE.Vector3(this.rig.x, this.rig.top + 0.07, this.rig.z + 0.09);
    return new THREE.Vector3(this.rig.x, 1.3, this.rig.z + 0.09);
  }

  _targetAngle() {
    const d = this.drill;
    if (d.sequence) return d.sequence[this.combo?.step ?? 0];
    return d.angle;
  }

  _updateGuide() {
    if (!this.arrow) return;
    const c = this._guideCenter();
    const isDisk = this.rig?.kind === 'disk';
    this.arrow.visible = this.active && !isDisk;
    this.ring.visible = this.active && isDisk;
    this.ring.position.copy(c);
    this.arrow.position.copy(c);
    this.arrow.rotation.set(0, 0, THREE.MathUtils.degToRad(this._targetAngle() ?? 0));
  }

  // ------------------------------------------------------------------ judging
  /** Frontal-plane angle (deg) of a world direction, for a player facing -z. */
  _angleOf(dir) { return THREE.MathUtils.radToDeg(Math.atan2(dir.y, dir.x)); }

  _nameOf(angle) {
    let best = DIRECTIONS[0], bd = 999;
    for (const d of DIRECTIONS) { const e = Math.abs(wrap(angle - d[0])); if (e < bd) { bd = e; best = d; } }
    return best[1];
  }

  _record(ok, err) {
    const st = this.stats[this.index];
    st.tries++;
    if (ok) st.ok++;
    if (err !== null) { st.errs.push(err); if (st.errs.length > 30) st.errs.shift(); }
    this._renderPanel();
  }

  /** A drill mat was cut. ev: { vdir, align, energy, speed } */
  onCut(ev) {
    if (!this.active) return;
    const d = this.drill;
    const ang = this._angleOf(ev.vdir);
    const frontal = Math.hypot(ev.vdir.x, ev.vdir.y);
    const target = this._targetAngle();
    const err = Math.abs(wrap(ang - target));
    const ok = frontal > 0.5 && err <= this.params.tolerance;
    const detail = `오차 ${err.toFixed(0)}° · 정렬 ${(ev.align * 100).toFixed(0)}% · ${ev.energy.toFixed(0)} J`;
    if (d.sequence) {
      const step = this.combo?.step ?? 0;
      if (ok && step === 0) {
        this.combo = { step: 1, t: this.time };
        this._updateGuide();
        this.toast(`1타 성공! 이어서 ${ARROWS[d.sequence[1]] ?? ''} 역사선 · ${detail}`, 1500);
        this.sfx.play('chime');
        return; // no respawn: cut what's left on the stand
      }
      if (ok && step === 1) {
        this._record(true, err);
        this._flash(true);
        this.toast(`연속베기 성공! ${detail}`, 1600);
      } else {
        this._record(false, err);
        this._flash(false);
        this.toast(`${step === 1 ? '2타' : '1타'} 방향이 달라요 — ${this._nameOf(ang)}로 판정 (${detail})`, 1800);
      }
      this.combo = null;
      this.respawnAt = this.time + this.params.respawn;
      return;
    }
    this._record(ok, err);
    this._flash(ok);
    if (ok) this.toast(`${d.name} 성공! ${detail}`, 1500);
    else this.toast(`방향이 달라요 — ${this._nameOf(ang)}로 판정 (목표 ${ARROWS[target]}) · ${detail}`, 1900);
    this.respawnAt = this.time + this.params.respawn;
  }

  /** Blade hit a drill mat but didn't cut (energy/alignment): count the attempt. */
  onMiss() {
    if (!this.active || this.time - this.lastHitT < 0.6) return;
    this.lastHitT = this.time;
    this._record(false, null);
  }

  /** Thrust target hit. point (world), v (blade velocity at the point), bladeDir (world) */
  onDiskHit(point, v, bladeDir) {
    if (!this.active || this.drill.rig !== 'disk' || this.time - this.lastHitT < 0.5) return;
    this.lastHitT = this.time;
    const speed = v.length();
    if (speed < 1.5) return;
    const along = Math.abs(v.dot(bladeDir)) / speed;
    const c = this.rig.center;
    const off = Math.hypot(point.x - c.x, point.y - c.y);
    const isThrust = along > 0.7;
    // painted rings (radius 0.17): gold bull 3.7 cm, red ring to 7 cm, then 10.4 / 13.7 / 17 cm
    const ok = isThrust && off <= 0.07 && speed >= 2.5;
    this._record(ok, null);
    this._flash(ok);
    const where = off <= 0.037 ? '정중앙' : off <= 0.07 ? '중앙' : off <= this.rig.radius ? `중앙에서 ${(off * 100).toFixed(0)}cm` : '빗나감';
    if (!isThrust) this.toast(`찌르기가 아니라 베기로 맞았어요 (${where})`, 1500);
    else if (speed < 2.5) this.toast(`더 힘차게 찌르세요 (${speed.toFixed(1)} m/s · ${where})`, 1500);
    else this.toast(ok ? `찌르기 성공! ${where} · ${speed.toFixed(1)} m/s` : `${where} — 가운데를 노리세요`, 1500);
    if (ok) { this.sfx.play('chime'); this.haptic?.(2); }
  }

  _flash(ok) {
    this.guideMat.color.setHex(ok ? 0x7dff9a : 0xff6a5a);
    this._flashUntil = this.time + 0.6;
  }

  // ------------------------------------------------------------------ panel
  _buildPanel() {
    const el = document.createElement('div');
    el.id = 'drill';
    el.className = 'drillpanel hidden';
    el.innerHTML = `
      <div class="dhead"><span class="dname"></span><span class="didx"></span></div>
      <div class="dsub"></div>
      <div class="dbody"><svg viewBox="-50 -50 100 100" width="84" height="84" class="darrow"></svg>
        <div class="dstats"></div></div>
      <div class="dhint">폰 탭 · N = 다음 종목 &nbsp; B = 이전</div>`;
    document.body.appendChild(el);
    this.panel = el;
  }

  _renderPanel() {
    const el = this.panel, d = this.drill, st = this.stats[this.index];
    el.querySelector('.dname').textContent = d.name;
    el.querySelector('.didx').textContent = `${this.index + 1} / ${DRILLS.length}`;
    el.querySelector('.dsub').textContent = d.sub;
    const svg = el.querySelector('.darrow');
    if (d.rig === 'disk') {
      svg.innerHTML = '<circle r="34" class="dring"/><circle r="20" class="dring"/><circle r="7" class="dbull"/>';
    } else {
      const angles = d.sequence || [d.angle];
      svg.innerHTML = '<circle r="44" class="dbg"/>' + angles.map((a, k) => {
        const r = THREE.MathUtils.degToRad(a);
        const off = angles.length > 1 ? (k === 0 ? -9 : 9) : 0;
        const ox = -Math.sin(r) * off, oy = -Math.cos(r) * off;
        const x1 = -Math.cos(r) * 32 + ox, y1 = Math.sin(r) * 32 + oy, x2 = Math.cos(r) * 32 + ox, y2 = -Math.sin(r) * 32 + oy;
        return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="dline${k}" marker-end="url(#ah${k})"/>`;
      }).join('') + '<defs><marker id="ah0" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="4" markerHeight="4" orient="auto"><path d="M0,0 L10,5 L0,10 z" class="dhead0"/></marker><marker id="ah1" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="4" markerHeight="4" orient="auto"><path d="M0,0 L10,5 L0,10 z" class="dhead1"/></marker></defs>';
    }
    const avg = st.errs.length ? st.errs.reduce((a, b) => a + b, 0) / st.errs.length : null;
    el.querySelector('.dstats').innerHTML =
      `<div><b>${st.ok}</b> / ${st.tries} 성공</div>` +
      (st.tries ? `<div>성공률 ${Math.round((100 * st.ok) / st.tries)}%</div>` : '<div>&nbsp;</div>') +
      (avg !== null ? `<div>평균 방향 오차 ${avg.toFixed(0)}°</div>` : '');
  }

  // ------------------------------------------------------------------ per frame
  update(dt, playerPos) {
    this.time += dt;
    const near = Math.hypot(playerPos.x - ZONE.x, playerPos.z - ZONE.z) < 2.2;
    if (near !== this.active) {
      this.active = near;
      this.panel.classList.toggle('hidden', !near);
      this._updateGuide();
    }
    if (this._flashUntil && this.time > this._flashUntil) { this.guideMat.color.setHex(GUIDE); this._flashUntil = 0; }
    if (this.combo && this.time - this.combo.t > this.params.comboWindow) {
      this._record(false, null);
      this.toast('연속베기: 2타가 늦었어요', 1400);
      this.combo = null;
      this.respawnAt = this.time + 0.4;
      this._updateGuide();
    }
    if (this.respawnAt && this.time > this.respawnAt) this._spawn();
    // a mat knocked off the rack (or pushed far) without a cut comes back
    if (!this.respawnAt && this.spawned && this.spawnPos) {
      const pcs = this.targets.piecesTagged('drill');
      if (pcs.length === 1) {
        const t = pcs[0].body.translation();
        if (t.y < 0.45 || Math.hypot(t.x - this.spawnPos.x, t.z - this.spawnPos.z) > 0.6) this.respawnAt = this.time + 1.0;
      }
    }
    // gentle pulse on the guide
    const pulse = 0.65 + 0.25 * Math.sin(this.time * 5);
    this.guideMat.opacity = pulse;
  }
}
