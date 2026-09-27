// 360° stitcher: turns the guided-capture photos (each tagged with the phone's orientation)
// into one equirectangular panorama, fully on-device and offline.
//
// Pipeline
//   1. Gyro placement  – every photo starts at the orientation the motion sensors reported.
//   2. Alignment       – for every overlapping pair, small patches of both photos are
//                        re-projected onto a common tangent plane and matched by normalised
//                        cross-correlation (coarse-to-fine). The pairwise offsets feed a global
//                        least-squares solve for a small rotation correction per photo plus the
//                        lens focal length (which web cameras don't report). Closing the 360°
//                        loop is what pins down the focal length. Gyro readings act as priors so
//                        texture-less areas (blank walls) stay where the sensors put them.
//   3. Exposure        – per-photo gains so auto-exposure differences don't show as bands.
//   4. Compositing     – every output pixel is traced back into each photo that sees it and
//                        blended with feathered weights (sharper toward photo centres to keep
//                        parallax ghosting narrow).
//   5. Hole filling    – anything not photographed (usually straight up/down) is filled with a
//                        smooth push-pull blur so there are no black holes.
//
// The core (align / composite / fillHoles) is pure JS on typed arrays so it can be tested
// outside the browser; the browser wrappers at the bottom handle canvas encode/decode.
(function (root) {
  const PM = root.PanoMath;
  const { D2R, R2D } = PM;

  // ---------------------------------------------------------------- capture targets
  // Rows of target directions (degrees). The equator row is taken first; the tilted rows
  // and the straight up/down shots complete the sphere. 4:3 camera frames are wide enough
  // (≈45°+ across) for 8 shots per tilted row; narrow 16:9 video frames (≈34–40° across,
  // often cropped further by stabilisation) need 10 so the rows meet without holes.
  const TARGET_LAYOUTS = {
    wide: [
      { pitch: 0, count: 12 }, { pitch: 48, count: 8 }, { pitch: -48, count: 8 },
      { pitch: 90, count: 1 }, { pitch: -90, count: 1 }
    ],
    narrow: [
      { pitch: 0, count: 12 }, { pitch: 45, count: 10 }, { pitch: -45, count: 10 },
      { pitch: 90, count: 1 }, { pitch: -90, count: 1 }
    ]
  };
  const TARGET_ROWS = TARGET_LAYOUTS.wide;
  // aspect = short side / long side of the camera frame (0.5625 for 16:9, 0.75 for 4:3).
  function makeTargets(yaw0, aspect) {
    const rows = aspect && aspect < 0.68 ? TARGET_LAYOUTS.narrow : TARGET_LAYOUTS.wide;
    const out = [];
    rows.forEach((r, row) => {
      for (let k = 0; k < r.count; k++) {
        const yaw = PM.wrapDeg((yaw0 || 0) + k * 360 / r.count);
        out.push({ id: out.length, row, yaw, pitch: r.pitch, dir: PM.dirFromLonLat(yaw, r.pitch), done: false });
      }
    });
    return out;
  }

  // ---------------------------------------------------------------- grayscale pyramids
  function grayFromRGBA(data, w, h) {
    const g = new Uint8Array(w * h);
    for (let i = 0, p = 0; i < g.length; i++, p += 4) g[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
    return g;
  }
  function downsample2(g, w, h) {
    const w2 = Math.max(1, w >> 1), h2 = Math.max(1, h >> 1), o = new Uint8Array(w2 * h2);
    for (let y = 0; y < h2; y++) {
      const r0 = (y * 2) * w, r1 = Math.min(h - 1, y * 2 + 1) * w;
      for (let x = 0; x < w2; x++) {
        const x0 = x * 2, x1 = Math.min(w - 1, x0 + 1);
        o[y * w2 + x] = (g[r0 + x0] + g[r0 + x1] + g[r1 + x0] + g[r1 + x1] + 2) >> 2;
      }
    }
    return { g: o, w: w2, h: h2 };
  }
  // levels[0] ≈ 400px on the long side (fine matching), [1] half, [2] quarter (coarse).
  function grayPyramid(g0, w0, h0) {
    const levels = [{ g: g0, w: w0, h: h0 }];
    for (let i = 1; i < 3; i++) { const p = levels[i - 1]; levels.push(downsample2(p.g, p.w, p.h)); }
    return levels;
  }

  // ---------------------------------------------------------------- geometry helpers
  // Tangent basis at d: e1 = "right", e2 = "up" as seen from inside the sphere.
  function tangentBasis(d) {
    let e1 = PM.cross(d, [0, 0, 1]);
    if (Math.hypot(e1[0], e1[1], e1[2]) < 1e-6) e1 = [1, 0, 0];
    e1 = PM.norm(e1);
    const e2 = PM.norm(PM.cross(e1, d));
    return { e1, e2 };
  }
  // Is world direction d inside the frame (with a fractional margin)?
  function insideFrame(fr, f, d, margin) {
    const R = fr.R;
    const cz = R[2] * d[0] + R[5] * d[1] + R[8] * d[2];
    if (cz > -1e-6) return false;
    const cx = R[0] * d[0] + R[3] * d[1] + R[6] * d[2], cy = R[1] * d[0] + R[4] * d[1] + R[7] * d[2];
    const u = fr.w / 2 + f * cx / -cz, v = fr.h / 2 - f * cy / -cz;
    const mx = fr.w * margin, my = fr.h * margin;
    return u >= mx && u <= fr.w - mx && v >= my && v <= fr.h - my;
  }

  // Render an N×N patch of a frame's gray level onto the tangent plane at m (basis e1, e2),
  // res radians per patch pixel, shifted by (offA, offB) radians. Invalid pixels are NaN.
  function renderPatch(fr, lvl, f, m, e1, e2, res, N, offA, offB, out) {
    const L = fr.gray[lvl], g = L.g, gw = L.w, gh = L.h;
    const fs = f * gw / fr.w, cx = gw / 2, cy = gh / 2, R = fr.R;
    const half = N / 2;
    for (let i = 0; i < N; i++) {
      const b = (half - i - 0.5) * res + offB;
      for (let j = 0; j < N; j++) {
        const a = (j - half + 0.5) * res + offA;
        const dx = m[0] + a * e1[0] + b * e2[0], dy = m[1] + a * e1[1] + b * e2[1], dz = m[2] + a * e1[2] + b * e2[2];
        const cz = R[2] * dx + R[5] * dy + R[8] * dz;
        const k = i * N + j;
        if (cz > -1e-4) { out[k] = NaN; continue; }
        const iz = fs / -cz;
        const sx = cx + (R[0] * dx + R[3] * dy + R[6] * dz) * iz - 0.5;
        const sy = cy - (R[1] * dx + R[4] * dy + R[7] * dz) * iz - 0.5;
        if (sx < 0.5 || sy < 0.5 || sx > gw - 1.5 || sy > gh - 1.5) { out[k] = NaN; continue; }
        const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0, p = y0 * gw + x0;
        const t = g[p] + (g[p + 1] - g[p]) * fx, u = g[p + gw] + (g[p + gw + 1] - g[p + gw]) * fx;
        out[k] = t + (u - t) * fy;
      }
    }
    return out;
  }

  // Normalised cross-correlation of P(p) against Q(p + (dx, dy)). -2 = not enough data.
  function ncc(P, Q, N, dx, dy, minCount) {
    let n = 0, sp = 0, sq = 0, spp = 0, sqq = 0, spq = 0;
    const i0 = Math.max(0, -dy), i1 = Math.min(N, N - dy), j0 = Math.max(0, -dx), j1 = Math.min(N, N - dx);
    for (let i = i0; i < i1; i++) {
      const rp = i * N, rq = (i + dy) * N + dx;
      for (let j = j0; j < j1; j++) {
        const p = P[rp + j], q = Q[rq + j];
        if (p !== p || q !== q) continue;
        n++; sp += p; sq += q; spp += p * p; sqq += q * q; spq += p * q;
      }
    }
    if (n < minCount) return { s: -2, n };
    const vp = spp - sp * sp / n, vq = sqq - sq * sq / n;
    if (vp < n * 6 || vq < n * 6) return { s: -2, n }; // flat / texture-less
    return { s: (spq - sp * sq / n) / Math.sqrt(vp * vq), n, mp: sp / n, mq: sq / n };
  }
  function nccSearch(P, Q, N, range, minCount) {
    const W = 2 * range + 1, scores = new Float32Array(W * W).fill(-2);
    let best = { s: -2 }, bx = 0, by = 0;
    for (let dy = -range; dy <= range; dy++) for (let dx = -range; dx <= range; dx++) {
      const r = ncc(P, Q, N, dx, dy, minCount);
      scores[(dy + range) * W + dx + range] = r.s;
      if (r.s > best.s) { best = r; bx = dx; by = dy; }
    }
    if (best.s <= -1) return null;
    const at = (x, y) => (x < -range || x > range || y < -range || y > range) ? -2 : scores[(y + range) * W + x + range];
    const sub = (a, c, b) => {
      if (a <= -1 || b <= -1) return 0;
      const den = a - 2 * c + b;
      return den < 0 ? PM.clamp(0.5 * (a - b) / den, -0.5, 0.5) : 0;
    };
    return {
      dx: bx + sub(at(bx - 1, by), best.s, at(bx + 1, by)),
      dy: by + sub(at(bx, by - 1), best.s, at(bx, by + 1)),
      score: best.s, mp: best.mp, mq: best.mq, n: best.n, edge: Math.abs(bx) === range || Math.abs(by) === range
    };
  }

  // Overlap sample points for a frame pair: centroid of the shared area plus two points along
  // its long axis (so roll errors are observable too).
  function overlapPoints(fi, fj, f) {
    const Fi = PM.forwardOf(fi.R), Fj = PM.forwardOf(fj.R);
    if (PM.angleBetween(Fi, Fj) > 85 * D2R) return null;
    const m = PM.norm([Fi[0] + Fj[0], Fi[1] + Fj[1], Fi[2] + Fj[2]]);
    const { e1, e2 } = tangentBasis(m);
    const pts = [];
    const G = 25, span = 38 * D2R;
    for (let a = 0; a < G; a++) for (let b = 0; b < G; b++) {
      const ta = Math.tan((a / (G - 1) * 2 - 1) * span), tb = Math.tan((b / (G - 1) * 2 - 1) * span);
      const d = PM.norm([m[0] + ta * e1[0] + tb * e2[0], m[1] + ta * e1[1] + tb * e2[1], m[2] + ta * e1[2] + tb * e2[2]]);
      if (insideFrame(fi, f, d, 0.05) && insideFrame(fj, f, d, 0.05)) pts.push(d);
    }
    if (pts.length < 6) return null;
    let c = [0, 0, 0];
    for (const p of pts) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
    c = PM.norm(c);
    const tb = tangentBasis(c);
    let sxx = 0, sxy = 0, syy = 0;
    const proj = pts.map(p => { const k = PM.dot(p, c) || 1; const x = PM.dot(p, tb.e1) / k, y = PM.dot(p, tb.e2) / k; sxx += x * x; sxy += x * y; syy += y * y; return [x, y]; });
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy), ax = [Math.cos(th), Math.sin(th)];
    let ext = 0;
    for (const [x, y] of proj) ext = Math.max(ext, Math.abs(x * ax[0] + y * ax[1]));
    const out = [c];
    if (ext > 9 * D2R) {
      for (const sgn of [-1, 1]) {
        const t = sgn * ext * 0.55;
        const d = PM.norm([c[0] + t * (ax[0] * tb.e1[0] + ax[1] * tb.e2[0]), c[1] + t * (ax[0] * tb.e1[1] + ax[1] * tb.e2[1]), c[2] + t * (ax[0] * tb.e1[2] + ax[1] * tb.e2[2])]);
        if (insideFrame(fi, f, d, 0.04) && insideFrame(fj, f, d, 0.04)) out.push(d);
      }
    }
    return { center: c, points: out, area: pts.length };
  }

  // Coarse-to-fine offset of frame j relative to frame i at the pair's overlap points.
  const COARSE = { lvl: 2, res: 0.6 * D2R, N: 32 };
  const FINE = { lvl: 0, res: 0.2 * D2R, N: 48 };
  function measurePair(fi, fj, i, j, f, ov, coarseRange, bufs) {
    const out = [];
    const cb = tangentBasis(ov.center);
    renderPatch(fi, COARSE.lvl, f, ov.center, cb.e1, cb.e2, COARSE.res, COARSE.N, 0, 0, bufs.cP);
    renderPatch(fj, COARSE.lvl, f, ov.center, cb.e1, cb.e2, COARSE.res, COARSE.N, 0, 0, bufs.cQ);
    const cr = nccSearch(bufs.cP, bufs.cQ, COARSE.N, coarseRange, COARSE.N * COARSE.N * 0.08);
    if (!cr || cr.score < 0.45 || cr.edge) return out;
    const a0 = cr.dx * COARSE.res, b0 = -cr.dy * COARSE.res;
    for (const d of ov.points) {
      const { e1, e2 } = tangentBasis(d);
      // Medium step: re-centre at this point with the coarse offset, small search.
      renderPatch(fi, COARSE.lvl, f, d, e1, e2, COARSE.res, COARSE.N, 0, 0, bufs.cP);
      renderPatch(fj, COARSE.lvl, f, d, e1, e2, COARSE.res, COARSE.N, a0, b0, bufs.cQ);
      const mr = nccSearch(bufs.cP, bufs.cQ, COARSE.N, 2, COARSE.N * COARSE.N * 0.08);
      if (!mr || mr.score < 0.45) continue;
      const a1 = a0 + mr.dx * COARSE.res, b1 = b0 - mr.dy * COARSE.res;
      renderPatch(fi, FINE.lvl, f, d, e1, e2, FINE.res, FINE.N, 0, 0, bufs.fP);
      renderPatch(fj, FINE.lvl, f, d, e1, e2, FINE.res, FINE.N, a1, b1, bufs.fQ);
      const fr = nccSearch(bufs.fP, bufs.fQ, FINE.N, 3, FINE.N * FINE.N * 0.1);
      if (!fr || fr.score < 0.55 || fr.edge) continue;
      out.push({
        i, j, d, e1, e2,
        da: a1 + fr.dx * FINE.res, db: b1 - fr.dy * FINE.res,
        score: fr.score, w: PM.clamp((fr.score - 0.5) / 0.4, 0.05, 1),
        mi: fr.mp, mj: fr.mq
      });
    }
    return out;
  }

  // Small rotation vector of a (near-identity) rotation matrix.
  function logRot(R) {
    const c = PM.clamp((R[0] + R[4] + R[8] - 1) / 2, -1, 1), th = Math.acos(c);
    const k = th < 1e-8 ? 0.5 : th / (2 * Math.sin(th));
    return [(R[7] - R[5]) * k, (R[2] - R[6]) * k, (R[3] - R[1]) * k];
  }

  // Least-squares update. Unknowns: ω_k (3 per frame, camera coords) and s (focal log-scale).
  function solveUpdate(frames, R0, meas, f, f0, opts) {
    const N = frames.length, n = 3 * N + 1, S = 3 * N;
    const sigMeas = 0.15 * D2R, wMeas = 1 / (sigMeas * sigMeas);
    const rows = [];
    for (const m of meas) {
      const Ri = frames[m.i].R, Rj = frames[m.j].R, Fi = PM.forwardOf(Ri), Fj = PM.forwardOf(Rj);
      const ci = PM.dot(m.d, Fi), cj = PM.dot(m.d, Fj);
      for (let comp = 0; comp < 2; comp++) {
        const e = comp ? m.e2 : m.e1, de = PM.cross(m.d, e);
        const ai = PM.mat3TVec(Ri, de), aj = PM.mat3TVec(Rj, de);
        rows.push({
          m, idx: [3 * m.i, 3 * m.i + 1, 3 * m.i + 2, 3 * m.j, 3 * m.j + 1, 3 * m.j + 2, S],
          val: [ai[0], ai[1], ai[2], -aj[0], -aj[1], -aj[2], opts.fixFocal ? 0 : ci * PM.dot(Fi, e) - cj * PM.dot(Fj, e)],
          rhs: comp ? m.db : m.da
        });
      }
    }
    const solveOnce = (rowW) => {
      const A = new Float64Array(n * n), b = new Float64Array(n);
      rows.forEach((r, ri) => {
        const w = r.m.w * wMeas * rowW[ri];
        for (let a = 0; a < 7; a++) {
          const ia = r.idx[a], va = r.val[a] * w;
          b[ia] += va * r.rhs;
          for (let c = 0; c < 7; c++) A[ia * n + r.idx[c]] += va * r.val[c];
        }
      });
      // Priors toward the gyro orientation: tilt is gravity-referenced (tight), heading
      // drifts (loose). Expressed in world axes, rotated into each camera's frame.
      const st = (opts.sigmaTilt || 1.5) * D2R, sy = (opts.sigmaYaw || 4) * D2R;
      const Dw = [1 / (st * st), 1 / (st * st), 1 / (sy * sy)];
      for (let k = 0; k < N; k++) {
        const R = frames[k].R;
        const eps = logRot(PM.mat3Mul(PM.mat3T(R0[k]), R));
        const Dk = new Array(9).fill(0);
        for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
          let s = 0;
          for (let a = 0; a < 3; a++) s += R[a * 3 + r] * Dw[a] * R[a * 3 + c];
          Dk[r * 3 + c] = s;
        }
        for (let r = 0; r < 3; r++) {
          for (let c = 0; c < 3; c++) A[(3 * k + r) * n + 3 * k + c] += Dk[r * 3 + c];
          b[3 * k + r] -= Dk[r * 3] * eps[0] + Dk[r * 3 + 1] * eps[1] + Dk[r * 3 + 2] * eps[2];
        }
      }
      const tau = Math.log(f / f0), ss = opts.fixFocal ? 1e-4 : 0.25;
      A[S * n + S] += 1 / (ss * ss);
      b[S] -= tau / (ss * ss);
      return PM.solveLinear(A, b, n);
    };
    const rowW = new Float64Array(rows.length).fill(1);
    let x = solveOnce(rowW);
    if (!x) return null;
    // One robust re-weighting pass (Cauchy-style) against bad matches.
    const res = rows.map(r => { let s = 0; for (let a = 0; a < 7; a++) s += r.val[a] * x[r.idx[a]]; return Math.abs(s - r.rhs) * R2D; });
    const sorted = res.slice().sort((a, b) => a - b), med = sorted[sorted.length >> 1] || 0;
    const thr = Math.max(0.3, 3 * med);
    let reweighted = false;
    res.forEach((r, k) => { if (r > thr) { rowW[k] = (thr / r) * (thr / r); reweighted = true; } });
    if (reweighted) x = solveOnce(rowW) || x;
    const final = rows.map(r => { let s = 0; for (let a = 0; a < 7; a++) s += r.val[a] * x[r.idx[a]]; return Math.abs(s - r.rhs) * R2D; });
    return { x, medianResidual: med, finalMedian: final.slice().sort((a, b) => a - b)[final.length >> 1] || 0 };
  }

  function solveGains(N, meas) {
    const A = new Float64Array(N * N), b = new Float64Array(N);
    for (const m of meas) {
      if (!(m.mi > 8 && m.mj > 8)) continue;
      const w = m.w, r = Math.log(m.mj) - Math.log(m.mi);
      A[m.i * N + m.i] += w; A[m.j * N + m.j] += w; A[m.i * N + m.j] -= w; A[m.j * N + m.i] -= w;
      b[m.i] += w * r; b[m.j] -= w * r;
    }
    for (let k = 0; k < N; k++) A[k * N + k] += 0.2;
    const x = PM.solveLinear(A, b, N);
    return Array.from({ length: N }, (_, k) => x ? PM.clamp(Math.exp(x[k]), 0.55, 1.8) : 1);
  }

  async function yieldUI() { await new Promise(r => setTimeout(r, 0)); }

  // Refine frames[k].R in place and estimate the focal length (pixels at full frame size).
  // Returns { f, gains, report }.
  async function align(frames, f0, opts = {}) {
    const N = frames.length, progress = opts.onProgress || (() => {});
    const report = { pairs: 0, iterations: [] };
    if (N < 2) return { f: f0, gains: frames.map(() => 1), report };
    const R0 = frames.map(fr => fr.R.slice());
    const bufs = {
      cP: new Float32Array(COARSE.N * COARSE.N), cQ: new Float32Array(COARSE.N * COARSE.N),
      fP: new Float32Array(FINE.N * FINE.N), fQ: new Float32Array(FINE.N * FINE.N)
    };
    let f = f0, lastMeas = [];
    const iters = opts.iterations || 3;
    for (let it = 0; it < iters; it++) {
      const pairs = [];
      for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
        const ov = overlapPoints(frames[i], frames[j], f);
        if (ov) pairs.push({ i, j, ov });
      }
      report.pairs = pairs.length;
      const meas = [];
      for (let p = 0; p < pairs.length; p++) {
        const { i, j, ov } = pairs[p];
        meas.push(...measurePair(frames[i], frames[j], i, j, f, ov, it === 0 ? 10 : 4, bufs));
        if (p % 4 === 3) { progress((it + (p + 1) / pairs.length) / iters); await yieldUI(); }
      }
      if (meas.length < 2) { report.iterations.push({ measurements: meas.length, skipped: true }); break; }
      const sol = solveUpdate(frames, R0, meas, f, f0, opts);
      if (!sol) break;
      for (let k = 0; k < N; k++) {
        const w = [sol.x[3 * k], sol.x[3 * k + 1], sol.x[3 * k + 2]];
        frames[k].R = PM.orthonormalize(PM.mat3Mul(frames[k].R, PM.rodrigues(w)));
      }
      if (!opts.fixFocal) f = PM.clamp(f * (1 + sol.x[3 * N]), f0 * 0.6, f0 * 1.6);
      lastMeas = meas;
      report.iterations.push({ measurements: meas.length, median: sol.medianResidual, after: sol.finalMedian, f });
      progress((it + 1) / iters);
      await yieldUI();
    }
    const gains = opts.noGains ? frames.map(() => 1) : solveGains(N, lastMeas);
    return { f, gains, report };
  }

  // ---------------------------------------------------------------- compositing
  // Angular bounds of a frame on the equirect: { latMin, latMax, lonStart, lonSpan }.
  function frameBounds(fr, f) {
    const R = fr.R, w = fr.w, h = fr.h, pts = [], n = 20;
    const push = (u, v) => {
      const c = [(u - w / 2), -(v - h / 2), -f];
      pts.push(PM.lonLatFromDir(PM.mat3Vec(R, c)));
    };
    for (let k = 0; k <= n; k++) { const t = k / n; push(t * w, 0); push(t * w, h); push(0, t * h); push(w, t * h); }
    let latMin = 90, latMax = -90;
    for (const p of pts) { latMin = Math.min(latMin, p.lat); latMax = Math.max(latMax, p.lat); }
    const hasN = insideFrame(fr, f, [0, 0, 1], 0), hasS = insideFrame(fr, f, [0, 0, -1], 0);
    if (hasN) latMax = 90;
    if (hasS) latMin = -90;
    if (hasN || hasS) return { latMin: latMin - 1, latMax: latMax + 1, lonStart: -180, lonSpan: 360 };
    const lons = pts.map(p => p.lon).sort((a, b) => a - b);
    let gap = 360 - (lons[lons.length - 1] - lons[0]), start = lons[0];
    for (let k = 1; k < lons.length; k++) { const g = lons[k] - lons[k - 1]; if (g > gap) { gap = g; start = lons[k]; } }
    return { latMin: latMin - 1, latMax: latMax + 1, lonStart: start - 1.5, lonSpan: Math.min(360, 360 - gap + 3) };
  }

  const FULL_W = 1000; // weight quantisation (weight sums are stored as Uint16)
  // Blend all frames into a W×H RGBA buffer. getRGBA(frame) → { data, w, h } (async OK).
  async function composite(frames, f, W, H, getRGBA, opts = {}) {
    const out = new Uint8ClampedArray(W * H * 4), wsum = new Uint16Array(W * H);
    const sinLon = new Float32Array(W), cosLon = new Float32Array(W), sinLat = new Float32Array(H), cosLat = new Float32Array(H);
    for (let x = 0; x < W; x++) { const l = ((x + 0.5) / W - 0.5) * 2 * Math.PI; sinLon[x] = Math.sin(l); cosLon[x] = Math.cos(l); }
    for (let y = 0; y < H; y++) { const l = (0.5 - (y + 0.5) / H) * Math.PI; sinLat[y] = Math.sin(l); cosLat[y] = Math.cos(l); }
    const progress = opts.onProgress || (() => {});
    const gains = opts.gains || frames.map(() => 1);
    for (let k = 0; k < frames.length; k++) {
      const fr = frames[k], bnd = frameBounds(fr, f), img = await getRGBA(fr, k);
      const src = img.data, iw = img.w, ih = img.h, sc = iw / fr.w, fs = f * sc, cx = iw / 2, cy = ih / 2;
      const R = fr.R, g = gains[k];
      const hx = iw / 2, hy = ih / 2, feather = 0.32;
      const y0 = Math.max(0, Math.floor((0.5 - bnd.latMax / 180) * H)), y1 = Math.min(H - 1, Math.ceil((0.5 - bnd.latMin / 180) * H));
      const x0 = Math.floor((bnd.lonStart / 360 + 0.5) * W), xn = Math.min(W, Math.ceil(bnd.lonSpan / 360 * W) + 2);
      for (let y = y0; y <= y1; y++) {
        const sLa = sinLat[y], cLa = cosLat[y], row = y * W;
        for (let xi = 0; xi < xn; xi++) {
          let x = x0 + xi; x = ((x % W) + W) % W;
          const dx = cLa * sinLon[x], dy = cLa * cosLon[x], dz = sLa;
          const cz = R[2] * dx + R[5] * dy + R[8] * dz;
          if (cz > -0.02) continue;
          const iz = fs / -cz;
          const u = cx + (R[0] * dx + R[3] * dy + R[6] * dz) * iz, v = cy - (R[1] * dx + R[4] * dy + R[7] * dz) * iz;
          if (u < 1 || v < 1 || u > iw - 1 || v > ih - 1) continue;
          // Feathered weight: 1 in the middle, easing to 0 over the outer `feather` of each side.
          const nx = Math.abs(u - hx) / hx, ny = Math.abs(v - hy) / hy;
          let wx = (1 - nx) / feather, wy = (1 - ny) / feather;
          wx = wx > 1 ? 1 : wx; wy = wy > 1 ? 1 : wy;
          let wgt = wx * wy; wgt = wgt * wgt * (3 - 2 * wgt);
          // Every real pixel gets at least weight 1, so frame corners (where the squared
          // feather rounds to 0) still count as covered instead of falling back to the blur.
          const q = Math.max(1, Math.round(wgt * wgt * FULL_W));
          const i = row + x, W0 = wsum[i], Wn = W0 + q;
          if (Wn > 65535) continue;
          const sx = u - 0.5, sy = v - 0.5, ix = sx | 0, iy = sy | 0, fx = sx - ix, fy = sy - iy;
          const p00 = (iy * iw + ix) * 4, p10 = p00 + 4, p01 = p00 + iw * 4, p11 = p01 + 4;
          const a = (1 - fx) * (1 - fy), b = fx * (1 - fy), c = (1 - fx) * fy, d = fx * fy;
          const r = (src[p00] * a + src[p10] * b + src[p01] * c + src[p11] * d) * g;
          const gg = (src[p00 + 1] * a + src[p10 + 1] * b + src[p01 + 1] * c + src[p11 + 1] * d) * g;
          const bb = (src[p00 + 2] * a + src[p10 + 2] * b + src[p01 + 2] * c + src[p11 + 2] * d) * g;
          const o = i * 4, t = q / Wn;
          out[o] = out[o] + (r - out[o]) * t;
          out[o + 1] = out[o + 1] + (gg - out[o + 1]) * t;
          out[o + 2] = out[o + 2] + (bb - out[o + 2]) * t;
          wsum[i] = Wn;
        }
      }
      progress((k + 1) / frames.length);
      await yieldUI();
    }
    return { data: out, wsum };
  }

  // Fill uncovered / weakly-covered pixels with a smooth push-pull interpolation (computed at
  // 1/4 resolution, then bilinearly upsampled) and feather it into the covered area.
  // `solidAt` = weight sum treated as fully covered.
  function fillHoles(data, wsum, W, H, solidAt) {
    const T = solidAt || 12; // trust real photo data even where only a frame's faint edge covers it
    const F = 4, w0 = Math.ceil(W / F), h0 = Math.ceil(H / F);
    // Level 0: premultiplied colour + coverage (0..1).
    let lv = { w: w0, h: h0, c: new Float32Array(w0 * h0 * 3), a: new Float32Array(w0 * h0) };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, a = Math.min(1, wsum[i] / T);
      if (!a) continue;
      const j = ((y / F) | 0) * w0 + ((x / F) | 0);
      lv.a[j] += a; lv.c[j * 3] += data[i * 4] * a; lv.c[j * 3 + 1] += data[i * 4 + 1] * a; lv.c[j * 3 + 2] += data[i * 4 + 2] * a;
    }
    for (let j = 0; j < w0 * h0; j++) {
      const a = lv.a[j];
      if (a > 0) { lv.c[j * 3] /= a; lv.c[j * 3 + 1] /= a; lv.c[j * 3 + 2] /= a; }
      lv.a[j] = Math.min(1, a / (F * F));
    }
    // Push: build coarser levels.
    const pyr = [lv];
    while (lv.w > 2 || lv.h > 2) {
      const w = Math.max(1, Math.ceil(lv.w / 2)), h = Math.max(1, Math.ceil(lv.h / 2));
      const nx = { w, h, c: new Float32Array(w * h * 3), a: new Float32Array(w * h) };
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let sa = 0, r = 0, g = 0, b = 0;
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
          const sx = (x * 2 + dx) % lv.w, sy = Math.min(lv.h - 1, y * 2 + dy), s = sy * lv.w + sx, a = lv.a[s];
          sa += a; r += lv.c[s * 3] * a; g += lv.c[s * 3 + 1] * a; b += lv.c[s * 3 + 2] * a;
        }
        const j = y * w + x;
        if (sa > 0) { nx.c[j * 3] = r / sa; nx.c[j * 3 + 1] = g / sa; nx.c[j * 3 + 2] = b / sa; }
        nx.a[j] = Math.min(1, sa);
      }
      pyr.push(nx); lv = nx;
    }
    // Pull: fill each level from the (upsampled) coarser one.
    const sample = (L, fx, fy, out) => {
      fx = fx - 0.5; fy = PM.clamp(fy - 0.5, 0, L.h - 1);
      const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
      const xa = ((x0 % L.w) + L.w) % L.w, xb = (xa + 1) % L.w, ya = y0, yb = Math.min(L.h - 1, y0 + 1);
      for (let ch = 0; ch < 3; ch++) {
        const t = L.c[(ya * L.w + xa) * 3 + ch] * (1 - tx) + L.c[(ya * L.w + xb) * 3 + ch] * tx;
        const u = L.c[(yb * L.w + xa) * 3 + ch] * (1 - tx) + L.c[(yb * L.w + xb) * 3 + ch] * tx;
        out[ch] = t + (u - t) * ty;
      }
    };
    const tmp = [0, 0, 0];
    for (let l = pyr.length - 2; l >= 0; l--) {
      const L = pyr[l], C = pyr[l + 1], sx = C.w / L.w, sy = C.h / L.h;
      for (let y = 0; y < L.h; y++) for (let x = 0; x < L.w; x++) {
        const j = y * L.w + x, a = L.a[j];
        if (a >= 1) continue;
        sample(C, (x + 0.5) * sx, (y + 0.5) * sy, tmp);
        for (let ch = 0; ch < 3; ch++) L.c[j * 3 + ch] = L.c[j * 3 + ch] * a + tmp[ch] * (1 - a);
        L.a[j] = 1;
      }
    }
    const base = pyr[0];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, a = Math.min(1, wsum[i] / T), o = i * 4;
      if (a < 1) {
        sample(base, (x + 0.5) / F, (y + 0.5) / F, tmp);
        const s = a * a * (3 - 2 * a);
        data[o] = data[o] * s + tmp[0] * (1 - s);
        data[o + 1] = data[o + 1] * s + tmp[1] * (1 - s);
        data[o + 2] = data[o + 2] * s + tmp[2] * (1 - s);
      }
      data[o + 3] = 255;
    }
  }

  // Rotate every frame about the vertical axis so frame `k` (usually the first) faces lon 0 —
  // then the panorama opens looking where the user started.
  function recenterYaw(frames, k) {
    const f = PM.forwardOf(frames[k || 0].R), yaw = Math.atan2(f[0], f[1]) * R2D;
    const Rz = PM.rotZ(yaw); // world rotation by +yaw about z (counter-clockwise) cancels heading
    for (const fr of frames) fr.R = PM.mat3Mul(Rz, fr.R);
    return yaw;
  }

  // ================================================================ browser wrappers
  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  function canvasToBlob(c, type, q) {
    return new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('Could not encode the panorama')), type || 'image/jpeg', q || 0.9));
  }
  async function decodeToBitmap(blob) {
    if (typeof createImageBitmap === 'function') {
      try { return await createImageBitmap(blob); } catch (e) { /* fall through */ }
    }
    return await new Promise((res, rej) => {
      const img = new Image(), url = URL.createObjectURL(blob);
      img.onload = () => { res(img); setTimeout(() => URL.revokeObjectURL(url), 1000); };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Could not read image')); };
      img.src = url;
    });
  }

  // Gray pyramid for a captured canvas (long side ≈ 400px).
  function grayPyramidFromCanvas(canvas) {
    const w = canvas.width, h = canvas.height, s = 400 / Math.max(w, h);
    const gw = Math.max(8, Math.round(w * s)), gh = Math.max(8, Math.round(h * s));
    const c = makeCanvas(gw, gh), ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, 0, 0, gw, gh);
    const g = grayFromRGBA(ctx.getImageData(0, 0, gw, gh).data, gw, gh);
    return grayPyramid(g, gw, gh);
  }

  // Default output size. 4096×2048 decodes/renders comfortably on every phone; the optional
  // high-detail mode (Settings) uses 6144×3072 where the device can take it.
  function outputSize() {
    let hi = false;
    try { hi = localStorage.getItem('vi-pano-hd') === '1'; } catch (e) {}
    return hi && !isIOS() ? { W: 6144, H: 3072 } : { W: 4096, H: 2048 };
  }
  function isIOS() {
    return /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  // frames: [{ blob, w, h, R, gray }] from the capture screen. Returns { blob, meta }.
  async function stitchCapture(frames, opts = {}) {
    const report = opts.onProgress || (() => {});
    const { W, H } = opts.size || outputSize();
    const longFov = (opts.longFovGuess || 63) * D2R;
    const f0 = (Math.max(frames[0].w, frames[0].h) / 2) / Math.tan(longFov / 2);
    report('align', 0);
    const al = await align(frames, f0, { onProgress: p => report('align', p) });
    console.info('360 stitch: frames', frames.length, 'focal', (al.f / f0).toFixed(3) + '× guess', JSON.stringify(al.report));
    recenterYaw(frames, 0);
    report('blend', 0);
    const decodeCanvas = makeCanvas(8, 8), dctx = decodeCanvas.getContext('2d', { willReadFrequently: true });
    const comp = await composite(frames, al.f, W, H, async (fr) => {
      const bmp = await decodeToBitmap(fr.blob);
      const w = bmp.width, h = bmp.height;
      if (decodeCanvas.width !== w || decodeCanvas.height !== h) { decodeCanvas.width = w; decodeCanvas.height = h; }
      dctx.drawImage(bmp, 0, 0);
      if (bmp.close) bmp.close();
      return { data: dctx.getImageData(0, 0, w, h).data, w, h };
    }, { gains: al.gains, onProgress: p => report('blend', p) });
    report('finish', 0.2);
    await yieldUI();
    fillHoles(comp.data, comp.wsum, W, H);
    report('finish', 0.6);
    await yieldUI();
    const out = makeCanvas(W, H);
    out.getContext('2d').putImageData(new ImageData(comp.data, W, H), 0, 0);
    comp.data = null;
    const blob = await canvasToBlob(out, 'image/jpeg', 0.9);
    out.width = out.height = 1; // release the big backing store right away
    report('finish', 1);
    const hfov = 2 * Math.atan((Math.min(frames[0].w, frames[0].h) / 2) / al.f) * R2D;
    return {
      blob,
      meta: { width: W, height: H, frames: frames.length, hfov: Math.round(hfov * 10) / 10, source: 'capture', startYaw: 0, startPitch: 0 },
      report: al.report
    };
  }

  // ---- Import a panorama photo from the gallery -------------------------------------------
  // Handles (a) full 2:1 equirectangular 360° photos, (b) Google Photo Sphere partial spheres
  // (GPano XMP crop metadata), and (c) regular wide phone panoramas (the caller supplies how
  // far around they go). Anything else is reported as notPano.
  async function readGPano(file) {
    try {
      const head = await file.slice(0, 512 * 1024).arrayBuffer();
      let txt = '';
      const u8 = new Uint8Array(head);
      for (let i = 0; i < u8.length; i += 8192) txt += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
      if (txt.indexOf('GPano') < 0) return null;
      const num = (k) => { const m = txt.match(new RegExp('GPano:' + k + '(?:="|>)\\s*(-?\\d+)')); return m ? parseInt(m[1], 10) : null; };
      const g = {
        fullW: num('FullPanoWidthPixels'), fullH: num('FullPanoHeightPixels'),
        left: num('CroppedAreaLeftPixels'), top: num('CroppedAreaTopPixels'),
        cropW: num('CroppedAreaImageWidthPixels'), cropH: num('CroppedAreaImageHeightPixels')
      };
      return g.fullW && g.fullH && g.cropW && g.cropH ? g : null;
    } catch (e) { return null; }
  }

  function classifyPanorama(w, h) {
    const r = w / h;
    if (r >= 1.9 && r <= 2.1) return 'sphere';
    if (r > 2.1) return 'wide';
    return 'flat';
  }

  // opts.coverage: horizontal degrees for a 'wide' panorama (180/270/360).
  async function importPanorama(file, opts = {}) {
    const src = await decodeToBitmap(file);
    const sw = src.naturalWidth || src.width, sh = src.naturalHeight || src.height;
    const gp = await readGPano(file);
    const kind = gp ? 'sphere' : classifyPanorama(sw, sh);
    if (kind === 'flat') { if (src.close) src.close(); return { notPano: true, width: sw, height: sh }; }
    const { W: maxW } = opts.size || outputSize();
    // Placement of the source image on the full equirect, in equirect-fraction units.
    let rect, fullW;
    if (gp) {
      const k = sw / gp.cropW; // the file may have been resized after capture
      fullW = gp.fullW * k;
      rect = { x: gp.left / gp.fullW, y: gp.top / gp.fullH, w: gp.cropW / gp.fullW, h: gp.cropH / gp.fullH };
    } else if (kind === 'sphere') {
      fullW = sw; rect = { x: 0, y: 0, w: 1, h: 1 };
    } else {
      const cov = PM.clamp(opts.coverage || 360, 60, 360);
      const vfov = Math.min(170, cov * sh / sw);
      fullW = sw * 360 / cov;
      rect = { x: 0.5 - cov / 720, y: 0.5 - vfov / 360, w: cov / 360, h: vfov / 180 };
    }
    let W = Math.min(maxW, Math.max(1024, Math.round(fullW / 2) * 2));
    if (W % 2) W++;
    const H = W / 2;
    const canvas = makeCanvas(W, H), ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    const dx = rect.x * W, dy = rect.y * H, dw = rect.w * W, dh = rect.h * H;
    ctx.drawImage(src, dx, dy, dw, dh);
    if (src.close) src.close();
    const full = rect.w >= 0.999 && rect.h >= 0.999;
    if (!full) {
      // Coverage mask (feathered 1% at the photo edges), then push-pull fill the rest.
      const img = ctx.getImageData(0, 0, W, H), ws = new Uint16Array(W * H), fe = W * 0.01;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const ex = Math.min(x - dx, dx + dw - x), ey = Math.min(y - dy, dy + dh - y);
        if (ex <= 0 || ey <= 0) continue;
        ws[y * W + x] = Math.round(Math.min(1, ex / fe, ey / fe) * FULL_W);
      }
      fillHoles(img.data, ws, W, H, FULL_W);
      ctx.putImageData(img, 0, 0);
    }
    const blob = await canvasToBlob(canvas, 'image/jpeg', 0.9);
    canvas.width = canvas.height = 1;
    const latMax = 90 - rect.y * 180, latMin = 90 - (rect.y + rect.h) * 180;
    const lonMin = (rect.x - 0.5) * 360, lonMax = (rect.x + rect.w - 0.5) * 360;
    return {
      blob,
      meta: {
        width: W, height: H, source: 'import', startYaw: full ? 0 : (lonMin + lonMax) / 2, startPitch: 0,
        limits: full ? null : { latMin, latMax, lonMin: rect.w >= 0.999 ? -180 : lonMin, lonMax: rect.w >= 0.999 ? 180 : lonMax }
      }
    };
  }

  // Render a normal (perspective) picture out of an equirect — used for the location tile
  // cover and scene thumbnails.
  async function renderPerspective(blobOrSource, opts = {}) {
    const yaw = opts.yaw || 0, pitch = opts.pitch || 0, hfov = (opts.hfov || 90) * D2R;
    const ow = opts.width || 640, oh = opts.height || 480;
    const src = blobOrSource instanceof Blob ? await decodeToBitmap(blobOrSource) : blobOrSource;
    const sw = 1024, sh = 512;
    const sc = makeCanvas(sw, sh), sctx = sc.getContext('2d', { willReadFrequently: true });
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(src, 0, 0, sw, sh);
    if (blobOrSource instanceof Blob && src.close) src.close();
    const s = sctx.getImageData(0, 0, sw, sh).data;
    const oc = makeCanvas(ow, oh), octx = oc.getContext('2d'), od = octx.createImageData(ow, oh);
    const R = PM.lookRotation(yaw, pitch, 0), fpx = (ow / 2) / Math.tan(hfov / 2);
    for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
      const d = PM.mat3Vec(R, [x + 0.5 - ow / 2, -(y + 0.5 - oh / 2), -fpx]);
      const ll = PM.lonLatFromDir(d);
      const u = (ll.lon / 360 + 0.5) * sw - 0.5, v = PM.clamp((0.5 - ll.lat / 180) * sh - 0.5, 0, sh - 1.001);
      const x0 = Math.floor(u), y0 = Math.floor(v), fx = u - x0, fy = v - y0;
      const xa = ((x0 % sw) + sw) % sw, xb = (xa + 1) % sw;
      const o = (y * ow + x) * 4;
      for (let c = 0; c < 3; c++) {
        const t = s[(y0 * sw + xa) * 4 + c] * (1 - fx) + s[(y0 * sw + xb) * 4 + c] * fx;
        const u2 = s[((y0 + 1) * sw + xa) * 4 + c] * (1 - fx) + s[((y0 + 1) * sw + xb) * 4 + c] * fx;
        od.data[o + c] = t + (u2 - t) * fy;
      }
      od.data[o + 3] = 255;
    }
    octx.putImageData(od, 0, 0);
    return canvasToBlob(oc, 'image/jpeg', 0.85);
  }

  root.PanoStitch = {
    TARGET_ROWS, TARGET_LAYOUTS, makeTargets,
    grayFromRGBA, grayPyramid, grayPyramidFromCanvas,
    align, composite, fillHoles, frameBounds, recenterYaw, insideFrame,
    stitchCapture, importPanorama, classifyPanorama, readGPano, renderPerspective,
    decodeToBitmap, outputSize, isIOS
  };
})(typeof window !== 'undefined' ? window : globalThis);
