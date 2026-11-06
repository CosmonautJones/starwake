// Split-lane divider visuals: a spine of tall rock plates standing across the widened tube,
// with lane lights down both faces (accent on the safe side, orange on the risky side) and a
// chevron on the nose pointing into each channel, so the fork reads from a distance.
// Gameplay (colliders) lives in js/flight/world.js; this only draws what they describe.

import * as THREE from 'three';
import { rockMaterial, rockVariants } from './rocks.js';

const RISK = '#ff8a3a';
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3();

function chevronGeo(w, h, t) {
  // ">" pointing along +x, centred on the origin, in the xy plane
  const s = new THREE.Shape();
  s.moveTo(-w / 2, h / 2); s.lineTo(-w / 2 + t, h / 2); s.lineTo(w / 2, 0); s.lineTo(-w / 2 + t, -h / 2); s.lineTo(-w / 2, -h / 2); s.lineTo(w / 2 - t, 0); s.closePath();
  return new THREE.ShapeGeometry(s);
}

/**
 * @param {object} item  world item of type 'divider' (item.split = the Course split)
 * @param {import('../flight/course.js').Course} course
 * @returns {{ object: THREE.Group, dispose(): void }}
 */
export function buildDivider(item, course, { accent = '#5ee7ff', quality = 'high' } = {}) {
  const sp = item.split, L = course.length;
  const root = new THREE.Group();
  root.name = 'divider';
  const origin = item.pos;
  const frame = (u) => {
    const f = course.frameAt(u);
    const ax = (sp.axis === 'up' ? f.U : f.R).clone().multiplyScalar(sp.side);
    const cross = (sp.axis === 'up' ? f.R : f.U).clone();
    const centre = f.pos.clone().addScaledVector(ax, sp.offset);
    return { f, ax, cross, centre };
  };
  const len = (sp.u1 - sp.u0) * L;
  const reach = Math.sqrt(Math.max(0, sp.width * sp.width - sp.offset * sp.offset));

  // ---- rock plates: overlapping, tall and thin, taper to a blade at both ends
  const kind = sp.kind === 'ice' ? 'ice' : 'dark';
  const geos = rockVariants(kind, 6);
  const mat = rockMaterial(kind);
  const plates = Math.max(3, Math.round(len / (quality === 'low' ? 18 : 13)));
  for (let i = 0; i <= plates; i++) {
    const u = sp.u0 + (i / plates) * (sp.u1 - sp.u0);
    const { f, ax, cross, centre } = frame(u);
    const e = Math.min(i, plates - i);
    const taper = e === 0 ? 0.45 : e === 1 ? 0.75 : 1;
    const h = (i * 7919) % 13 / 13; // cheap per-plate variety
    const basis = new THREE.Matrix4().makeBasis(ax, cross, f.T);
    _q.setFromRotationMatrix(basis).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler((h - 0.5) * 0.25, 0, (h - 0.5) * 0.3)));
    _s.set((sp.thick + 2) * taper * (0.9 + h * 0.3), reach * (1.02 + h * 0.12), 15 + h * 6);
    _p.copy(centre).sub(origin);
    const mesh = new THREE.Mesh(geos[i % geos.length], mat);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.compose(_p, _q, _s);
    root.add(mesh);
  }

  // ---- lane lights down both faces, and a chevron on the nose for each channel
  const lightGeo = new THREE.OctahedronGeometry(1.1, 0);
  const mk = (color, count) => {
    const m = new THREE.InstancedMesh(lightGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(2.2), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, toneMapped: false }), count);
    m.frustumCulled = false;
    root.add(m);
    return m;
  };
  const step = 22, nL = Math.max(2, Math.floor(len / step));
  const rows = [-0.45, 0, 0.45];
  const safe = mk(accent, (nL + 1) * rows.length), risky = mk(RISK, (nL + 1) * rows.length);
  let k = 0;
  for (let i = 0; i <= nL; i++) {
    const { f, ax, cross, centre } = frame(sp.u0 + (i / nL) * (sp.u1 - sp.u0));
    for (const r of rows) {
      const y = cross.clone().multiplyScalar(r * reach);
      _q.identity(); _s.setScalar(1);
      _p.copy(centre).addScaledVector(ax, -(sp.thick + 2.5)).add(y).sub(origin);
      safe.setMatrixAt(k, _m.compose(_p, _q, _s));
      _p.copy(centre).addScaledVector(ax, sp.thick + 2.5).add(y).sub(origin);
      risky.setMatrixAt(k, _m.compose(_p, _q, _s));
      k++;
    }
    void f;
  }
  const chevMats = [];
  const chev = chevronGeo(9, 12, 2.6);
  {
    const { f, ax, cross, centre } = frame(sp.u0);
    // on the nose, facing the oncoming racers
    const facing = f.T.clone().negate();
    for (const s of [-1, 1]) {
      const color = s < 0 ? accent : RISK;
      const m = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(2.4), side: THREE.DoubleSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, toneMapped: false });
      chevMats.push(m);
      for (const y of [-0.3, 0.3]) {
        const mesh = new THREE.Mesh(chev, m);
        // chevron's +x points into the channel on side s; its normal faces down the tube
        const xDir = ax.clone().multiplyScalar(s), yDir = cross.clone();
        const zDir = new THREE.Vector3().crossVectors(xDir, yDir);
        if (zDir.dot(facing) < 0) yDir.negate(), zDir.negate();
        mesh.matrixAutoUpdate = false;
        _q.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xDir, yDir, zDir));
        _p.copy(centre).addScaledVector(facing, 4 + sp.thick).addScaledVector(ax, s * 9).addScaledVector(cross, y * reach).sub(origin);
        mesh.matrix.compose(_p, _q, _s.setScalar(1.3));
        root.add(mesh);
      }
    }
  }
  return {
    object: root,
    dispose() {
      root.removeFromParent();
      lightGeo.dispose(); chev.dispose();
      safe.material.dispose(); risky.material.dispose();
      for (const m of chevMats) m.dispose();
    },
  };
}
