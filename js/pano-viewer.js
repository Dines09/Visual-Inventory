// Interactive 360° viewer (WebGL). The equirectangular photo is mapped onto the inside of a
// sphere and viewed from its centre:
//   • drag to look around (with momentum), pinch / mouse-wheel / double-tap to zoom
//   • optional "look around by moving the phone" (gyroscope) mode
//   • DOM pins (hotspot markers) are projected onto the view every frame
// Renders only when something changed, so an idle view costs no battery.
(function (root) {
  const PM = root.PanoMath;
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;

  const VS = 'attribute vec3 aPos;attribute vec2 aUV;uniform mat4 uMVP;varying vec2 vUV;' +
    'void main(){vUV=aUV;gl_Position=uMVP*vec4(aPos,1.0);}';
  const FS = '#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\n' +
    'varying vec2 vUV;uniform sampler2D uTex;void main(){gl_FragColor=vec4(texture2D(uTex,vUV).rgb,1.0);}';

  function buildSphere(rows, cols) {
    const n = (rows + 1) * (cols + 1), pos = new Float32Array(n * 3), uv = new Float32Array(n * 2);
    let p = 0, t = 0;
    for (let r = 0; r <= rows; r++) {
      const v = r / rows, lat = 90 - v * 180;
      for (let c = 0; c <= cols; c++) {
        const u = c / cols, d = PM.dirFromLonLat((u - 0.5) * 360, lat);
        pos[p++] = d[0]; pos[p++] = d[1]; pos[p++] = d[2];
        uv[t++] = u; uv[t++] = v;
      }
    }
    const idx = new Uint16Array(rows * cols * 6);
    let k = 0;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const a = r * (cols + 1) + c, b = a + 1, d = a + cols + 1, e = d + 1;
      idx[k++] = a; idx[k++] = d; idx[k++] = b; idx[k++] = b; idx[k++] = d; idx[k++] = e;
    }
    return { pos, uv, idx };
  }

  function mat4Mul(a, b) { // column-major
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
    return o;
  }

  function easeInOut(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }

  function screenAngle() {
    if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
    return typeof window.orientation === 'number' ? window.orientation : 0;
  }

  class PanoViewer {
    constructor(opts = {}) {
      this.opts = opts;
      this.el = document.createElement('div');
      this.el.className = 'pano-view';
      this.canvas = document.createElement('canvas');
      this.canvas.className = 'pano-canvas';
      this.pinLayer = document.createElement('div');
      this.pinLayer.className = 'pano-pins';
      this.el.appendChild(this.canvas);
      this.el.appendChild(this.pinLayer);
      const s = opts.start || {};
      this.yaw = s.yaw || 0; this.pitch = s.pitch || 0;
      this.fov = s.fov || this.defaultFov();
      this.limits = opts.limits || null;
      this.pins = [];
      this.pointers = new Map();
      this.vel = null; this.anim = null; this.gyro = null;
      this.ready = false; this.destroyed = false;
      this._raf = 0;
      this._initGL();
      this._bindInput();
      this._ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this._resize()) : null;
      if (this._ro) this._ro.observe(this.el);
      this._onWinResize = () => this._resize();
      window.addEventListener('resize', this._onWinResize);
    }

    static supported() {
      try {
        const c = document.createElement('canvas');
        return !!(c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl'));
      } catch (e) { return false; }
    }

    defaultFov() {
      const w = (this.el && this.el.clientWidth) || window.innerWidth, h = (this.el && this.el.clientHeight) || window.innerHeight;
      return w < h ? 90 : 68;
    }
    fovLimits() {
      const w = this.el.clientWidth || 1, h = this.el.clientHeight || 1;
      return { min: 12, max: w < h ? 115 : 100 };
    }

    // ---------------------------------------------------------------- GL setup
    _initGL() {
      const attrs = { antialias: false, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'default' };
      let gl = this.canvas.getContext('webgl2', attrs);
      this.gl2 = !!gl;
      if (!gl) gl = this.canvas.getContext('webgl', attrs) || this.canvas.getContext('experimental-webgl', attrs);
      this.gl = gl;
      if (!gl) { this._showError('3D view is not supported on this device.'); return; }
      this.canvas.addEventListener('webglcontextlost', this._onLost = (e) => { e.preventDefault(); this.ready = false; this._glReady = false; });
      this.canvas.addEventListener('webglcontextrestored', this._onRestored = () => { this._setupGL(); if (this.blob) this.load(this.blob); });
      this._setupGL();
    }
    _setupGL() {
      const gl = this.gl;
      const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
      const prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
      gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { this._showError('Could not start the 3D view.'); return; }
      this.prog = prog;
      this.aPos = gl.getAttribLocation(prog, 'aPos');
      this.aUV = gl.getAttribLocation(prog, 'aUV');
      this.uMVP = gl.getUniformLocation(prog, 'uMVP');
      const m = buildSphere(64, 128);
      this.bPos = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.bPos); gl.bufferData(gl.ARRAY_BUFFER, m.pos, gl.STATIC_DRAW);
      this.bUV = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.bUV); gl.bufferData(gl.ARRAY_BUFFER, m.uv, gl.STATIC_DRAW);
      this.bIdx = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.bIdx); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.idx, gl.STATIC_DRAW);
      this.nIdx = m.idx.length;
      this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096;
      this.aniso = gl.getExtension('EXT_texture_filter_anisotropic') || gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic');
      this._glReady = true;
    }

    _showError(msg) {
      if (this._err) this._err.remove();
      this._err = document.createElement('div');
      this._err.className = 'pano-error';
      this._err.textContent = msg;
      this.el.appendChild(this._err);
    }

    // Load (or replace) the panorama image. Resolves once it is on screen.
    async load(blob) {
      this.blob = blob;
      if (!this.gl || !this._glReady) return;
      this.el.classList.add('loading');
      let src;
      try { src = await root.PanoStitch.decodeToBitmap(blob); }
      catch (e) { this._showError('Could not open this 360° photo.'); this.el.classList.remove('loading'); throw e; }
      if (this.destroyed) { if (src.close) src.close(); return; }
      const gl = this.gl;
      const sw = src.naturalWidth || src.width, sh = src.naturalHeight || src.height;
      let tw = Math.min(sw, this.maxTex), th = Math.min(Math.round(tw * sh / sw), this.maxTex);
      if (!this.gl2) { // WebGL1: mipmaps + REPEAT need power-of-two sizes
        const pot = (v) => Math.pow(2, Math.floor(Math.log2(v)));
        tw = pot(tw); th = pot(th);
      }
      let upload = src;
      if (tw !== sw || th !== sh) {
        const c = document.createElement('canvas');
        c.width = tw; c.height = th;
        const ctx = c.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(src, 0, 0, tw, th);
        upload = c;
      }
      // Small copy for pin colour sampling.
      const sc = document.createElement('canvas');
      sc.width = 256; sc.height = 128;
      sc.getContext('2d', { willReadFrequently: true }).drawImage(src, 0, 0, 256, 128);
      this.sampleCanvas = sc;

      if (this.tex) gl.deleteTexture(this.tex);
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, upload);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (this.aniso) gl.texParameterf(gl.TEXTURE_2D, this.aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(this.aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) || 1));
      this.tex = tex;
      if (src.close) src.close();
      if (upload !== src && upload.width) { upload.width = upload.height = 1; }
      this.ready = true;
      this.el.classList.remove('loading');
      this.el.classList.add('ready');
      this._resize();
      this.requestRender();
      if (this.opts.onLoad) this.opts.onLoad(this);
    }

    // ---------------------------------------------------------------- view math
    get view() { return { yaw: this.yaw, pitch: this.pitch, fov: this.fov }; }
    setView(v, silent) {
      if (v.yaw != null) this.yaw = PM.wrapDeg(v.yaw);
      if (v.pitch != null) this.pitch = v.pitch;
      if (v.fov != null) this.fov = v.fov;
      this._clamp();
      this.requestRender();
      if (!silent && this.opts.onViewChange) this.opts.onViewChange(this.view);
    }
    _clamp() {
      const fl = this.fovLimits();
      this.fov = PM.clamp(this.fov, fl.min, fl.max);
      let pMin = -89.9, pMax = 89.9;
      const L = this.limits;
      if (L) {
        const half = this.fov / 2 * 0.6;
        pMin = Math.max(pMin, (L.latMin != null ? L.latMin : -90) + half);
        pMax = Math.min(pMax, (L.latMax != null ? L.latMax : 90) - half);
        if (pMin > pMax) pMin = pMax = ((L.latMin || 0) + (L.latMax || 0)) / 2;
        if (L.lonMin != null && L.lonMax != null && L.lonMax - L.lonMin < 359) this.yaw = PM.clamp(PM.wrapDeg(this.yaw), L.lonMin, L.lonMax);
      }
      this.pitch = PM.clamp(this.pitch, pMin, pMax);
      this.yaw = PM.wrapDeg(this.yaw);
    }
    _basis() {
      const F = PM.dirFromLonLat(this.yaw, this.pitch), y = this.yaw * D2R;
      const Rt = [Math.cos(y), -Math.sin(y), 0], U = PM.cross(Rt, F);
      return { F, Rt, U };
    }
    _fpx() { return (this.el.clientHeight / 2) / Math.tan(this.fov / 2 * D2R); }
    // Project a world direction to container CSS pixels.
    project(d, B) {
      B = B || this._basis();
      const z = PM.dot(d, B.F);
      if (z <= 0.02) return null;
      const f = this._fpx(), W = this.el.clientWidth, H = this.el.clientHeight;
      return { x: W / 2 + f * PM.dot(d, B.Rt) / z, y: H / 2 - f * PM.dot(d, B.U) / z, z };
    }
    // Direction under a point given in client (page) coordinates.
    dirAtClient(clientX, clientY) {
      const r = this.el.getBoundingClientRect();
      return this._dirAt(clientX - r.left, clientY - r.top);
    }
    _dirAt(x, y) {
      const B = this._basis(), f = this._fpx(), W = this.el.clientWidth, H = this.el.clientHeight;
      const a = (x - W / 2) / f, b = -(y - H / 2) / f;
      return PM.norm([B.F[0] + a * B.Rt[0] + b * B.U[0], B.F[1] + a * B.Rt[1] + b * B.U[1], B.F[2] + a * B.Rt[2] + b * B.U[2]]);
    }
    lonLatAtClient(clientX, clientY) { return PM.lonLatFromDir(this.dirAtClient(clientX, clientY)); }

    // ---------------------------------------------------------------- pins
    addPin(el, lon, lat) {
      const p = { el, d: PM.dirFromLonLat(lon, lat) };
      el.style.left = '0px'; el.style.top = '0px';
      this.pins.push(p);
      this.pinLayer.appendChild(el);
      this._placePin(p, this._basis());
      return p;
    }
    movePin(el, lon, lat) {
      const p = this.pins.find(q => q.el === el);
      if (!p) return;
      p.d = PM.dirFromLonLat(lon, lat);
      this._placePin(p, this._basis());
    }
    removePin(el) { this.pins = this.pins.filter(p => p.el !== el); el.remove(); }
    clearPins() { this.pins.forEach(p => p.el.remove()); this.pins = []; }
    _placePin(p, B) {
      const s = this.project(p.d, B);
      if (!s || s.x < -60 || s.y < -60 || s.x > this.el.clientWidth + 60 || s.y > this.el.clientHeight + 60) {
        if (!p.hidden) { p.el.style.visibility = 'hidden'; p.hidden = true; }
        return;
      }
      if (p.hidden) { p.el.style.visibility = ''; p.hidden = false; }
      p.el.style.transform = `translate3d(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px, 0) translate(-50%, -100%)`;
    }

    // ---------------------------------------------------------------- rendering
    requestRender() {
      if (this._raf || this.destroyed) return;
      this._raf = requestAnimationFrame((t) => { this._raf = 0; this._frame(t); });
    }
    _frame(t) {
      let more = false;
      const moving = !!(this.anim || this.vel);
      const now = t || performance.now(), dt = this._lastT ? Math.min(50, now - this._lastT) : 16;
      this._lastT = now;
      if (this.anim) {
        const a = this.anim, k = PM.clamp((now - a.t0) / a.ms, 0, 1), e = easeInOut(k);
        this.yaw = a.from.yaw + a.dYaw * e;
        this.pitch = a.from.pitch + (a.to.pitch - a.from.pitch) * e;
        this.fov = a.from.fov + (a.to.fov - a.from.fov) * e;
        this._clamp();
        if (k >= 1) { this.anim = null; if (a.done) a.done(); } else more = true;
      } else if (this.vel && !this.pointers.size) {
        this.yaw += this.vel.yaw * dt; this.pitch += this.vel.pitch * dt;
        const decay = Math.exp(-dt / 320);
        this.vel.yaw *= decay; this.vel.pitch *= decay;
        this._clamp();
        if (Math.abs(this.vel.yaw) + Math.abs(this.vel.pitch) < 0.002) this.vel = null; else more = true;
      }
      this._draw();
      if (more) this.requestRender(); else this._lastT = 0;
      if (moving && this.opts.onViewChange) this.opts.onViewChange(this.view);
    }
    _draw() {
      const gl = this.gl;
      const B = this._basis();
      for (const p of this.pins) this._placePin(p, B);
      if (!gl || !this.ready || !this._glReady) return;
      const W = this.canvas.width, H = this.canvas.height;
      if (!W || !H) return;
      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const f = 1 / Math.tan(this.fov / 2 * D2R), asp = W / H, n = 0.05, fr = 10;
      const P = new Float32Array([f / asp, 0, 0, 0, 0, f, 0, 0, 0, 0, (fr + n) / (n - fr), -1, 0, 0, 2 * fr * n / (n - fr), 0]);
      const V = new Float32Array([B.Rt[0], B.U[0], -B.F[0], 0, B.Rt[1], B.U[1], -B.F[1], 0, B.Rt[2], B.U[2], -B.F[2], 0, 0, 0, 0, 1]);
      gl.useProgram(this.prog);
      gl.uniformMatrix4fv(this.uMVP, false, mat4Mul(P, V));
      gl.bindBuffer(gl.ARRAY_BUFFER, this.bPos);
      gl.enableVertexAttribArray(this.aPos);
      gl.vertexAttribPointer(this.aPos, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.bUV);
      gl.enableVertexAttribArray(this.aUV);
      gl.vertexAttribPointer(this.aUV, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.bIdx);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.disable(gl.CULL_FACE);
      gl.drawElements(gl.TRIANGLES, this.nIdx, gl.UNSIGNED_SHORT, 0);
    }
    _resize() {
      if (this.destroyed) return;
      const w = this.el.clientWidth, h = this.el.clientHeight;
      if (!w || !h) return; // detached / hidden — keep the last size
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const cw = Math.round(w * dpr), ch = Math.round(h * dpr);
      if (this.canvas.width !== cw || this.canvas.height !== ch) { this.canvas.width = cw; this.canvas.height = ch; }
      this._clamp();
      this.requestRender();
    }

    animateTo(to, ms, done) {
      const from = this.view;
      const target = { yaw: to.yaw != null ? to.yaw : from.yaw, pitch: to.pitch != null ? to.pitch : from.pitch, fov: to.fov != null ? to.fov : from.fov };
      const fl = this.fovLimits();
      target.fov = PM.clamp(target.fov, fl.min, fl.max);
      this.vel = null;
      this.anim = { from, to: target, dYaw: PM.wrapDeg(target.yaw - from.yaw), t0: performance.now(), ms: ms || 600, done };
      this._lastT = 0;
      this.requestRender();
    }
    // Turn to look at a direction (optionally zoom), e.g. to locate a hotspot.
    lookAt(lon, lat, fov, ms, done) { this.animateTo({ yaw: lon, pitch: lat, fov }, ms, done); }

    // ---------------------------------------------------------------- input
    _bindInput() {
      const el = this.el;
      const degPerPx = () => this.fov / Math.max(1, el.clientHeight);
      let drag = null, pinch = null, tap = null, lastTap = null, samples = [];

      const onDown = (e) => {
        if (e.target.closest && e.target.closest('.pin, .pano-ui')) return;
        if (e.button != null && e.button !== 0 && e.pointerType === 'mouse') return;
        try { el.setPointerCapture(e.pointerId); } catch (err) {}
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        this.anim = null; this.vel = null;
        if (this.pointers.size === 1) {
          drag = { x: e.clientX, y: e.clientY, yaw: this.yaw, pitch: this.pitch, off: this.gyro ? this.gyro.offset : 0 };
          tap = { x: e.clientX, y: e.clientY, t: performance.now(), moved: false };
          samples = [{ x: e.clientX, y: e.clientY, t: performance.now() }];
        } else if (this.pointers.size === 2) {
          const [a, b] = Array.from(this.pointers.values());
          pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, fov: this.fov, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
          drag = null; if (tap) tap.moved = true;
        }
      };
      const onMove = (e) => {
        if (!this.pointers.has(e.pointerId)) return;
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (this.pointers.size === 1 && drag) {
          const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
          if (tap && Math.hypot(dx, dy) > 7) tap.moved = true;
          const k = degPerPx();
          if (this.gyro) { this.gyro.offset = drag.off - dx * k; this._applyGyro(); }
          else { this.yaw = drag.yaw - dx * k; this.pitch = drag.pitch + dy * k; this._clamp(); }
          const now = performance.now();
          samples.push({ x: e.clientX, y: e.clientY, t: now });
          while (samples.length > 2 && now - samples[0].t > 90) samples.shift();
          this.requestRender();
          if (this.opts.onViewChange) this.opts.onViewChange(this.view);
        } else if (this.pointers.size >= 2 && pinch) {
          const [a, b] = Array.from(this.pointers.values());
          const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1, mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          const r = el.getBoundingClientRect(), mx = mid.x - r.left, my = mid.y - r.top;
          const anchor = this._dirAt(pinch.mid.x - r.left, pinch.mid.y - r.top);
          const fl = this.fovLimits();
          this.fov = PM.clamp(pinch.fov * pinch.dist / dist, fl.min, fl.max);
          // Keep the point that was under the fingers under the fingers.
          for (let it = 0; it < 2; it++) {
            const p = this.project(anchor);
            if (!p) break;
            const k = degPerPx();
            this.yaw += (p.x - mx) * k; this.pitch -= (p.y - my) * k;
            this._clamp();
          }
          pinch.mid = mid; pinch.dist = dist; pinch.fov = this.fov;
          this.requestRender();
          if (this.opts.onViewChange) this.opts.onViewChange(this.view);
        }
      };
      const onUp = (e) => {
        if (!this.pointers.has(e.pointerId)) return;
        this.pointers.delete(e.pointerId);
        if (this.pointers.size === 1) { // 2 → 1 finger: continue as a drag from here
          const p = Array.from(this.pointers.values())[0];
          drag = { x: p.x, y: p.y, yaw: this.yaw, pitch: this.pitch, off: this.gyro ? this.gyro.offset : 0 };
          pinch = null; samples = [{ x: p.x, y: p.y, t: performance.now() }];
          return;
        }
        if (this.pointers.size > 0) return;
        pinch = null;
        const now = performance.now();
        if (tap && !tap.moved && now - tap.t < 450) {
          this._handleTap(e.clientX, e.clientY, e.target, lastTap);
          lastTap = { x: e.clientX, y: e.clientY, t: now };
        } else if (drag && samples.length >= 2 && !this.gyro) {
          const a = samples[0], b = samples[samples.length - 1], dt = Math.max(8, b.t - a.t);
          if (now - b.t < 60) {
            const k = degPerPx();
            this.vel = { yaw: -(b.x - a.x) / dt * k, pitch: (b.y - a.y) / dt * k };
            this._lastT = 0;
            this.requestRender();
          }
        }
        drag = null; tap = null;
      };
      el.addEventListener('pointerdown', onDown);
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', onUp);
      el.addEventListener('pointercancel', onUp);
      el.addEventListener('wheel', (e) => {
        e.preventDefault();
        const r = el.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
        const anchor = this._dirAt(mx, my), fl = this.fovLimits();
        this.anim = null;
        this.fov = PM.clamp(this.fov * (e.deltaY > 0 ? 1.1 : 1 / 1.1), fl.min, fl.max);
        const p = this.project(anchor);
        if (p) { const k = degPerPx(); this.yaw += (p.x - mx) * k; this.pitch -= (p.y - my) * k; }
        this._clamp();
        this.requestRender();
        if (this.opts.onViewChange) this.opts.onViewChange(this.view);
      }, { passive: false });
    }

    _handleTap(clientX, clientY, target, lastTap) {
      const tapMode = this.opts.isTapMode && this.opts.isTapMode();
      const ll = this.lonLatAtClient(clientX, clientY);
      if (tapMode) { if (this.opts.onTap) this.opts.onTap(ll.lon, ll.lat, clientX, clientY, target); return; }
      const now = performance.now();
      if (lastTap && now - lastTap.t < 320 && Math.hypot(clientX - lastTap.x, clientY - lastTap.y) < 40) {
        // Double-tap: zoom in toward the tapped spot, or back out if already zoomed.
        const def = this.defaultFov();
        if (this.fov > def * 0.62) this.animateTo({ yaw: ll.lon, pitch: ll.lat, fov: Math.max(this.fovLimits().min, this.fov / 2.4) }, 420);
        else this.animateTo({ fov: def }, 420);
      }
    }

    // ---------------------------------------------------------------- gyroscope look-around
    static gyroAvailable() { return typeof DeviceOrientationEvent !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0); }
    async setGyro(on) {
      if (!on) {
        if (this._gyroHandler) window.removeEventListener('deviceorientation', this._gyroHandler);
        this._gyroHandler = null; this.gyro = null;
        return false;
      }
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        try { if (await DeviceOrientationEvent.requestPermission() !== 'granted') return false; } catch (e) { return false; }
      }
      this.vel = null; this.anim = null;
      this.gyro = { offset: null, lon: 0, lat: 0 };
      this._gyroHandler = (e) => {
        if (e.alpha == null && e.beta == null) return;
        const R = PM.cameraFromDevice(PM.fromDeviceOrientation(e.alpha, e.beta, e.gamma), screenAngle());
        const ll = PM.lonLatFromDir(PM.forwardOf(R));
        const g = this.gyro;
        if (!g) return;
        if (g.offset == null) g.offset = PM.wrapDeg(this.yaw - ll.lon);
        g.lon = ll.lon; g.lat = ll.lat;
        this._applyGyro();
      };
      window.addEventListener('deviceorientation', this._gyroHandler);
      return true;
    }
    _applyGyro() {
      const g = this.gyro;
      if (!g || g.offset == null) return;
      this.yaw = g.lon + g.offset; this.pitch = g.lat;
      this._clamp();
      this.requestRender();
      if (this.opts.onViewChange) this.opts.onViewChange(this.view);
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      if (this._raf) cancelAnimationFrame(this._raf);
      this.setGyro(false);
      window.removeEventListener('resize', this._onWinResize);
      if (this._ro) this._ro.disconnect();
      const gl = this.gl;
      if (gl) {
        try {
          if (this.tex) gl.deleteTexture(this.tex);
          [this.bPos, this.bUV, this.bIdx].forEach(b => b && gl.deleteBuffer(b));
          if (this.prog) gl.deleteProgram(this.prog);
          const lose = gl.getExtension('WEBGL_lose_context');
          if (lose) lose.loseContext();
        } catch (e) {}
      }
      this.canvas.width = this.canvas.height = 1;
      this.el.remove();
      this.pins = [];
    }
  }

  PanoViewer.screenAngle = screenAngle;
  root.PanoViewer = PanoViewer;
})(window);
