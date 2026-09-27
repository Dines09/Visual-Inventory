// 360° panorama math shared by the capture screen, the stitcher and the viewer.
//
// World frame = the W3C DeviceOrientation frame: x = East, y = North, z = Up.
// lon  = heading measured from +y (north) toward +x (east), degrees, -180..180.
// lat  = elevation above the horizon, degrees, -90..90.
// Equirectangular images: u = lon/360 + 0.5 (0 = left edge), v = 0.5 - lat/180 (0 = top =
// straight up). Hotspots on a 360° scene store x = u*100 and y = v*100, so the same
// percent-based {x, y} fields used for flat photos work unchanged.
//
// Camera frame: x = image right, y = image up, z = towards the viewer (the camera looks
// along -z). Rotation matrices are row-major arrays of 9 numbers mapping camera → world.
(function (root) {
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function wrapDeg(d) { d = (d + 180) % 360; if (d < 0) d += 360; return d - 180; }
  function wrap01(u) { u = u % 1; return u < 0 ? u + 1 : u; }

  function dirFromLonLat(lon, lat) {
    const lo = lon * D2R, la = lat * D2R, c = Math.cos(la);
    return [c * Math.sin(lo), c * Math.cos(lo), Math.sin(la)];
  }
  function lonLatFromDir(d) {
    const n = Math.hypot(d[0], d[1], d[2]) || 1;
    return { lon: Math.atan2(d[0], d[1]) * R2D, lat: Math.asin(clamp(d[2] / n, -1, 1)) * R2D };
  }
  // Hotspot percent (x, y on the equirect image) ↔ lon/lat.
  function lonLatFromPct(x, y) { return { lon: (x / 100 - 0.5) * 360, lat: (0.5 - y / 100) * 180 }; }
  function pctFromLonLat(lon, lat) { return { x: wrap01(lon / 360 + 0.5) * 100, y: clamp(0.5 - lat / 180, 0, 1) * 100 }; }

  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function norm(a) { const n = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / n, a[1] / n, a[2] / n]; }
  function angleBetween(a, b) { return Math.acos(clamp(dot(norm(a), norm(b)), -1, 1)); }

  function mat3Mul(a, b) {
    const o = new Array(9);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
      o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
    return o;
  }
  function mat3T(m) { return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]; }
  function mat3Vec(m, v) {
    return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
  }
  function mat3TVec(m, v) {
    return [m[0] * v[0] + m[3] * v[1] + m[6] * v[2], m[1] * v[0] + m[4] * v[1] + m[7] * v[2], m[2] * v[0] + m[5] * v[1] + m[8] * v[2]];
  }
  function rotZ(deg) { const a = deg * D2R, c = Math.cos(a), s = Math.sin(a); return [c, -s, 0, s, c, 0, 0, 0, 1]; }
  // Rotation of angle |w| (radians) about axis w (Rodrigues).
  function rodrigues(w) {
    const t = Math.hypot(w[0], w[1], w[2]);
    if (t < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const k = [w[0] / t, w[1] / t, w[2] / t], c = Math.cos(t), s = Math.sin(t), v = 1 - c;
    return [
      c + k[0] * k[0] * v, k[0] * k[1] * v - k[2] * s, k[0] * k[2] * v + k[1] * s,
      k[1] * k[0] * v + k[2] * s, c + k[1] * k[1] * v, k[1] * k[2] * v - k[0] * s,
      k[2] * k[0] * v - k[1] * s, k[2] * k[1] * v + k[0] * s, c + k[2] * k[2] * v
    ];
  }
  // Re-orthonormalise a rotation (Gram-Schmidt on the columns) to stop numeric drift.
  function orthonormalize(m) {
    const x = norm([m[0], m[3], m[6]]);
    let y = [m[1], m[4], m[7]];
    const d = dot(x, y); y = norm([y[0] - d * x[0], y[1] - d * x[1], y[2] - d * x[2]]);
    const z = cross(x, y);
    return [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
  }

  // DeviceOrientation Euler angles (degrees) → device→world rotation, R = Rz(α)·Rx(β)·Ry(γ).
  function fromDeviceOrientation(alpha, beta, gamma) {
    const a = (alpha || 0) * D2R, b = (beta || 0) * D2R, g = (gamma || 0) * D2R;
    const cA = Math.cos(a), sA = Math.sin(a), cB = Math.cos(b), sB = Math.sin(b), cG = Math.cos(g), sG = Math.sin(g);
    return [
      cA * cG - sA * sB * sG, -cB * sA, cG * sA * sB + cA * sG,
      cG * sA + cA * sB * sG, cA * cB, sA * sG - cA * cG * sB,
      -cB * sG, sB, cB * cG
    ];
  }
  // Camera→world rotation for the rear camera, given the device rotation and the current
  // screen orientation angle (0 portrait, 90 / 270 landscape). The captured video frame is
  // oriented like the screen, so the image axes are the device axes rotated by -angle.
  function cameraFromDevice(Rdev, screenAngle) {
    return screenAngle ? mat3Mul(Rdev, rotZ(-screenAngle)) : Rdev.slice();
  }
  function forwardOf(R) { return [-R[2], -R[5], -R[8]]; }
  function upOf(R) { return [R[1], R[4], R[7]]; }
  function rightOf(R) { return [R[0], R[3], R[6]]; }
  // Heading / elevation / roll (degrees) of a camera rotation.
  function yprOf(R) {
    const f = forwardOf(R), ll = lonLatFromDir(f);
    const h = cross(f, [0, 0, 1]);
    let roll = 0;
    if (Math.hypot(h[0], h[1], h[2]) > 1e-3) {
      const hn = norm(h), r = rightOf(R);
      roll = Math.atan2(dot(cross(hn, r), f), dot(hn, r)) * R2D;
    }
    return { yaw: ll.lon, pitch: ll.lat, roll };
  }
  // Camera rotation that looks at (yaw, pitch) with the given roll — used to build targets
  // and synthetic test frames.
  function lookRotation(yaw, pitch, roll) {
    const f = dirFromLonLat(yaw, pitch);
    let right = cross(f, [0, 0, 1]);
    if (Math.hypot(right[0], right[1], right[2]) < 1e-6) { // looking straight up/down
      const yr = yaw * D2R; right = [Math.cos(yr), -Math.sin(yr), 0];
    }
    right = norm(right);
    let up = cross(right, f);
    if (roll) {
      const rr = (roll || 0) * D2R, c = Math.cos(rr), s = Math.sin(rr);
      const r2 = [right[0] * c + up[0] * s, right[1] * c + up[1] * s, right[2] * c + up[2] * s];
      const u2 = [up[0] * c - right[0] * s, up[1] * c - right[1] * s, up[2] * c - right[2] * s];
      right = r2; up = u2;
    }
    const back = [-f[0], -f[1], -f[2]];
    return [right[0], up[0], back[0], right[1], up[1], back[1], right[2], up[2], back[2]];
  }

  // Solve A x = b (A is n×n, row-major Float64Array) by Gaussian elimination with partial
  // pivoting. A and b are modified. Returns x or null if singular.
  function solveLinear(A, b, n) {
    for (let col = 0; col < n; col++) {
      let piv = col, best = Math.abs(A[col * n + col]);
      for (let r = col + 1; r < n; r++) { const v = Math.abs(A[r * n + col]); if (v > best) { best = v; piv = r; } }
      if (best < 1e-14) return null;
      if (piv !== col) {
        for (let c = 0; c < n; c++) { const t = A[col * n + c]; A[col * n + c] = A[piv * n + c]; A[piv * n + c] = t; }
        const t = b[col]; b[col] = b[piv]; b[piv] = t;
      }
      const d = A[col * n + col];
      for (let r = col + 1; r < n; r++) {
        const f = A[r * n + col] / d;
        if (!f) continue;
        for (let c = col; c < n; c++) A[r * n + c] -= f * A[col * n + c];
        b[r] -= f * b[col];
      }
    }
    const x = new Float64Array(n);
    for (let r = n - 1; r >= 0; r--) {
      let s = b[r];
      for (let c = r + 1; c < n; c++) s -= A[r * n + c] * x[c];
      x[r] = s / A[r * n + r];
    }
    return x;
  }

  root.PanoMath = {
    D2R, R2D, clamp, wrapDeg, wrap01,
    dirFromLonLat, lonLatFromDir, lonLatFromPct, pctFromLonLat,
    dot, cross, norm, angleBetween,
    mat3Mul, mat3T, mat3Vec, mat3TVec, rotZ, rodrigues, orthonormalize,
    fromDeviceOrientation, cameraFromDevice, forwardOf, upOf, rightOf, yprOf, lookRotation,
    solveLinear
  };
})(typeof window !== 'undefined' ? window : globalThis);
