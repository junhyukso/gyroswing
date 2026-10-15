// Convex slicing for cuttable targets: split a convex point set by a plane, and build
// render geometry where the original outer surface stays smooth and cut faces are flat.
import * as THREE from 'three';
import { ConvexHull } from 'three/addons/math/ConvexHull.js';

const key = (p) => `${Math.round(p.x * 1e5)},${Math.round(p.y * 1e5)},${Math.round(p.z * 1e5)}`;

function dedupe(points) {
  const m = new Map();
  for (const p of points) m.set(key(p), p);
  return [...m.values()];
}

/** Unique points actually on the hull (ConvexHull.vertices may include interior input points). */
export function hullPoints(hull) {
  const m = new Map();
  for (const f of hull.faces) {
    let e = f.edge;
    do { const p = e.head().point; m.set(key(p), p); e = e.next; } while (e !== f.edge);
  }
  return [...m.values()].map((p) => p.clone());
}

export function hullVolume(hull) {
  let v = 0;
  for (const f of hull.faces) {
    const pts = [];
    let e = f.edge;
    do { pts.push(e.head().point); e = e.next; } while (e !== f.edge);
    for (let i = 1; i < pts.length - 1; i++) v += pts[0].dot(new THREE.Vector3().crossVectors(pts[i], pts[i + 1])) / 6;
  }
  return Math.abs(v);
}

export function pointsVolume(points) { return hullVolume(new ConvexHull().setFromPoints(points)); }

/** Split convex `points` (local) by plane (point p0, normal n). Returns {a, b} (a: side n points to) or null. */
export function slicePoints(points, p0, n, minVolume = 1.5e-5) {
  const hull = new ConvexHull().setFromPoints(points);
  const A = [], B = [];
  const seen = new Set();
  for (const p of hullPoints(hull)) {
    const d = n.dot(_tmp.subVectors(p, p0));
    if (d >= 0) A.push(p.clone());
    if (d <= 0) B.push(p.clone());
  }
  for (const f of hull.faces) {
    let e = f.edge;
    do {
      const p = e.tail().point, q = e.head().point;
      const k = key(p) < key(q) ? key(p) + '|' + key(q) : key(q) + '|' + key(p);
      if (!seen.has(k)) {
        seen.add(k);
        const dp = n.dot(_tmp.subVectors(p, p0)), dq = n.dot(_tmp.subVectors(q, p0));
        if ((dp > 0 && dq < 0) || (dp < 0 && dq > 0)) {
          const x = p.clone().lerp(q, dp / (dp - dq));
          A.push(x); B.push(x.clone());
        }
      }
      e = e.next;
    } while (e !== f.edge);
  }
  const a = dedupe(A), b = dedupe(B);
  if (a.length < 4 || b.length < 4) return null;
  const ha = new ConvexHull().setFromPoints(a), hb = new ConvexHull().setFromPoints(b);
  const va = hullVolume(ha), vb = hullVolume(hb);
  if (va < minVolume || vb < minVolume) return null;
  return { a: hullPoints(ha), b: hullPoints(hb), va, vb };
}
const _tmp = new THREE.Vector3();

/**
 * Geometry with two groups: 0 = outer surface (smooth, `outerNormal(p)`), 1 = cut faces (flat).
 * isOuter(faceNormal, faceCentroid) decides which faces belong to the original surface.
 */
export function pieceGeometry(points, { isOuter, outerNormal, outerUV, cutUVScale = 6 }) {
  const hull = new ConvexHull().setFromPoints(points);
  const out = { p: [], n: [], uv: [] }, cut = { p: [], n: [], uv: [] };
  const fn = new THREE.Vector3(), tu = new THREE.Vector3(), tv = new THREE.Vector3(), nn = new THREE.Vector3();
  for (const f of hull.faces) {
    const pts = [];
    let e = f.edge;
    do { pts.push(e.head().point); e = e.next; } while (e !== f.edge);
    fn.copy(f.normal);
    const outer = isOuter(fn, f.midpoint);
    const dst = outer ? out : cut;
    // planar UV basis for cut faces
    tu.set(1, 0, 0); if (Math.abs(fn.x) > 0.9) tu.set(0, 1, 0);
    tu.addScaledVector(fn, -tu.dot(fn)).normalize();
    tv.crossVectors(fn, tu);
    for (let i = 1; i < pts.length - 1; i++) {
      let tri = [pts[0], pts[i], pts[i + 1]];
      const cn = new THREE.Vector3().crossVectors(_tmp.subVectors(tri[1], tri[0]), new THREE.Vector3().subVectors(tri[2], tri[0]));
      if (cn.dot(fn) < 0) tri = [tri[0], tri[2], tri[1]];
      for (const p of tri) {
        dst.p.push(p.x, p.y, p.z);
        if (outer) {
          outerNormal(p, nn);
          if (nn.dot(fn) < 0.2) nn.copy(fn); // flat end caps etc.
          dst.n.push(nn.x, nn.y, nn.z);
          const uv = outerUV(p, fn);
          dst.uv.push(uv[0], uv[1]);
        } else {
          dst.n.push(fn.x, fn.y, fn.z);
          dst.uv.push(p.dot(tu) * cutUVScale, p.dot(tv) * cutUVScale);
        }
      }
    }
  }
  const g = new THREE.BufferGeometry();
  const P = [...out.p, ...cut.p], N = [...out.n, ...cut.n], U = [...out.uv, ...cut.uv];
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  g.addGroup(0, out.p.length / 3, 0);
  g.addGroup(out.p.length / 3, cut.p.length / 3, 1);
  g.computeBoundingSphere();
  return g;
}
