// Guided 360° capture. The user just turns on the spot: the phone's motion sensors show where
// the next photo is needed (a dot on the live camera view), and a photo is taken automatically
// once the ring is on the dot and the phone is steady. Each photo is stored with the exact
// orientation it was taken at, then PanoStitch aligns and blends them into one 360° image.
//
// openPanoCapture() resolves to { blob, meta } (the finished equirectangular JPEG),
// 'import' if the user chose to import a 360° photo instead, or null if cancelled.
function openPanoCapture() {
  const PM = window.PanoMath, PS = window.PanoStitch;
  const R2D = 180 / Math.PI;
  const LONG_FOV_GUESS = 63;       // degrees across the long side of a phone video frame
  const ALIGN_DEG = 3.2;           // how close the ring must be to a dot
  const HOLD_MS = 420;             // steady time before the shot fires
  const MAX_SPEED = 24;            // °/s — faster than this counts as "moving"

  return new Promise((resolve) => {
    const overlay = el('div', { class: 'fs-overlay pano-capture' });
    const stage = el('div', { class: 'pc-stage' });
    overlay.appendChild(stage);

    let finished = false, stream = null, video = null, raf = 0, orientHandler = null, wakeLock = null;
    let R = null, lastOriT = 0, speed = 0, gotSensor = false;
    let targets = [], frames = [], holdStart = 0, capturing = false, frameW = 0, frameH = 0;
    let lastMsg = '', stitchCancelled = false, previewViewer = null;

    function stopCamera() {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      if (orientHandler) { window.removeEventListener('deviceorientation', orientHandler); orientHandler = null; }
      if (stream) { try { stream.getTracks().forEach(t => t.stop()); } catch (e) {} stream = null; }
      if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; }
    }
    function cleanup() {
      stopCamera();
      if (previewViewer) { previewViewer.destroy(); previewViewer = null; }
      stitchCancelled = true;
    }
    function finish(result) {
      if (finished) return;
      finished = true;
      cleanup();
      overlay.remove();
      resolve(result);
    }
    // Hardware Back closes the capture like ✕ does.
    overlay.__onClose = () => { if (!finished) { finished = true; cleanup(); resolve(null); } };

    // ------------------------------------------------------------ screens
    function card(children) {
      stage.innerHTML = '';
      stage.appendChild(el('div', { class: 'pc-card-wrap' }, [el('div', { class: 'pc-card glass' }, children)]));
    }

    function showIntro() {
      card([
        el('div', { class: 'pc-hero' }, [icon('orbit', 34)]),
        el('h2', {}, ['Capture a 360° photo']),
        el('p', { class: 'pc-lead' }, ['Stand in one spot and turn slowly. Point the ring at each dot — photos are taken automatically.']),
        el('ul', { class: 'pc-tips' }, [
          el('li', {}, [icon('rotate', 18), el('span', {}, ['Turn around the phone, not your body — keep it close to your chest.'])]),
          el('li', {}, [icon('camera', 18), el('span', {}, ['Hold the phone upright (portrait) the whole time.'])]),
          el('li', {}, [icon('sparkles', 18), el('span', {}, ['Good light helps. You can tap Done early — gaps are blended in.'])])
        ]),
        el('button', { class: 'btn block', onclick: startCapture }, [icon('camera', 20), 'Start capture']),
        el('button', { class: 'btn secondary block', onclick: () => finish('import') }, [icon('upload', 20), 'Import a 360° photo instead']),
        el('button', { class: 'btn ghost block', onclick: () => finish(null) }, ['Cancel'])
      ]);
    }

    function showProblem(title, text) {
      stopCamera();
      card([
        el('div', { class: 'pc-hero warn' }, [icon('alert', 32)]),
        el('h2', {}, [title]),
        el('p', { class: 'pc-lead' }, [text]),
        el('button', { class: 'btn block', onclick: () => finish('import') }, [icon('upload', 20), 'Import a 360° photo']),
        el('button', { class: 'btn ghost block', onclick: () => finish(null) }, ['Close'])
      ]);
    }

    // ------------------------------------------------------------ live capture
    async function startCapture() {
      // iOS needs motion permission from inside the tap handler — ask before anything else.
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        try {
          const p = await DeviceOrientationEvent.requestPermission();
          if (p !== 'granted') { showProblem('Motion access needed', 'Allow "Motion & Orientation" access so the app knows which way the phone points. You can also import a 360° photo.'); return; }
        } catch (e) { /* older iOS: no prompt needed */ }
      }
      if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        showProblem('Camera unavailable', 'The camera only works when the app is opened over a secure (https://) link. You can still import a 360° photo.');
        return;
      }
      stage.innerHTML = '';
      stage.appendChild(el('div', { class: 'pc-loading' }, [el('div', { class: 'spinner' }), el('div', {}, ['Starting camera…'])]));
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } },
          audio: false
        });
      } catch (e) {
        console.warn('pano camera failed', e);
        showProblem('Camera unavailable', 'Allow camera access for this app, then try again. You can also import a 360° photo.');
        return;
      }
      if (finished) { stopCamera(); return; }
      orientHandler = (e) => {
        if (e.alpha == null || e.beta == null) return;
        const Rc = PM.cameraFromDevice(PM.fromDeviceOrientation(e.alpha, e.beta, e.gamma), PanoViewer.screenAngle());
        const now = performance.now();
        if (R && lastOriT) {
          const a = PM.angleBetween(PM.forwardOf(R), PM.forwardOf(Rc)) * R2D, dt = Math.max(4, now - lastOriT);
          speed = speed * 0.75 + (a / dt * 1000) * 0.25;
        }
        R = Rc; lastOriT = now; gotSensor = true;
      };
      window.addEventListener('deviceorientation', orientHandler);
      try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
      buildLiveUI();
      // No sensor events within ~1.5 s → this device/browser can't do guided capture.
      setTimeout(() => {
        if (!finished && !gotSensor && stream) showProblem('No motion sensor found', 'Guided 360° capture needs a phone with a gyroscope. You can import a 360° photo taken with another app or a 360° camera instead.');
      }, 1600);
    }

    let ui = null;
    function buildLiveUI() {
      stage.innerHTML = '';
      video = el('video', { class: 'pc-video', autoplay: 'true', playsinline: 'true' });
      video.muted = true; video.playsInline = true;
      video.srcObject = stream;
      video.play && video.play().catch(() => {});
      const canvas = el('canvas', { class: 'pc-overlay' });
      const counter = el('div', { class: 'pc-count glass' }, ['0 / 0']);
      const doneBtn = el('button', { class: 'btn small pc-done', disabled: 'disabled', onclick: () => askDone() }, [icon('check', 18), 'Done']);
      const undoBtn = el('button', { class: 'pc-icon-btn glass', title: 'Undo last photo', onclick: undoLast }, [icon('restore', 20)]);
      const msg = el('div', { class: 'pc-msg glass' }, ['Waiting for motion sensor…']);
      const map = el('canvas', { class: 'pc-map', width: '360', height: '180' });
      const flash = el('div', { class: 'pc-flash' });
      stage.appendChild(video);
      stage.appendChild(canvas);
      stage.appendChild(flash);
      stage.appendChild(el('div', { class: 'pc-top' }, [
        el('button', { class: 'pc-icon-btn glass', title: 'Close', onclick: () => confirmClose() }, [icon('close', 22)]),
        counter,
        doneBtn
      ]));
      stage.appendChild(el('div', { class: 'pc-bottom' }, [msg, el('div', { class: 'pc-map-row' }, [undoBtn, el('div', { class: 'pc-map-wrap glass' }, [map])])]));
      ui = { canvas, counter, doneBtn, undoBtn, msg, map, flash };
      raf = requestAnimationFrame(loop);
    }

    function confirmClose() {
      if (frames.length && !confirm('Discard this 360° capture?')) return;
      finish(null);
    }
    function askDone() {
      if (frames.length < 2) return;
      const eqDone = targets.filter(t => t.row === 0 && t.done).length, eqAll = targets.filter(t => t.row === 0).length;
      if (eqDone < eqAll && !confirm(`Only ${frames.length} photos so far — parts that weren't photographed will be blurred. Finish anyway?`)) return;
      goStitch();
    }
    function undoLast() {
      const f = frames.pop();
      if (!f) return;
      const t = targets.find(x => x.id === f.targetId);
      if (t) t.done = false;
      updateCounter();
    }
    function updateCounter() {
      if (!ui) return;
      ui.counter.textContent = `${frames.length} / ${targets.length}`;
      if (frames.length >= 2) ui.doneBtn.removeAttribute('disabled'); else ui.doneBtn.setAttribute('disabled', 'disabled');
      ui.undoBtn.style.visibility = frames.length ? 'visible' : 'hidden';
    }
    function setMsg(t) { if (ui && t !== lastMsg) { ui.msg.textContent = t; lastMsg = t; } }

    function loop() {
      raf = requestAnimationFrame(loop);
      if (!ui || !video) return;
      const cv = ui.canvas, W = cv.clientWidth, H = cv.clientHeight, dpr = Math.min(2, window.devicePixelRatio || 1);
      if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
      const ctx = cv.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!R || !vw) { setMsg(R ? 'Starting camera…' : 'Waiting for motion sensor…'); return; }
      if (!targets.length) {
        targets = PS.makeTargets(PM.yprOf(R).yaw, Math.min(vw, vh) / Math.max(vw, vh));
        overlay.__targets = targets; // inspection hook for automated tests
        updateCounter();
      }
      const landscape = window.innerWidth > window.innerHeight;
      // Screen mapping of the (object-fit: cover) video.
      const s = Math.max(W / vw, H / vh), fGuess = (Math.max(vw, vh) / 2) / Math.tan(LONG_FOV_GUESS / 2 * Math.PI / 180), fs = fGuess * s;
      const F = PM.forwardOf(R), ypr = PM.yprOf(R);
      const toScreen = (d) => {
        const c = PM.mat3TVec(R, d);
        if (-c[2] < 0.08) return null;
        return { x: W / 2 + fs * c[0] / -c[2], y: H / 2 - fs * c[1] / -c[2] };
      };
      // Nearest target still needed.
      let best = null, bestAng = 1e9;
      for (const t of targets) {
        if (t.done) continue;
        const a = PM.angleBetween(F, t.dir) * R2D;
        if (a < bestAng) { bestAng = a; best = t; }
      }
      // Dots.
      const now = performance.now();
      for (const t of targets) {
        const p = toScreen(t.dir);
        if (!p) continue;
        if (t.done) {
          ctx.fillStyle = 'rgba(52,199,123,0.9)';
          ctx.beginPath(); ctx.arc(p.x, p.y, 7, 0, Math.PI * 2); ctx.fill();
        } else if (t === best) {
          const pulse = 1 + 0.12 * Math.sin(now / 180);
          ctx.fillStyle = 'rgba(255,255,255,0.95)';
          ctx.beginPath(); ctx.arc(p.x, p.y, 13 * pulse, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = 'rgba(91,140,255,1)';
          ctx.beginPath(); ctx.arc(p.x, p.y, 7, 0, Math.PI * 2); ctx.fill();
        } else {
          ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(p.x, p.y, 7, 0, Math.PI * 2); ctx.stroke();
        }
      }
      // Reticle + hold progress.
      const cx = W / 2, cy = H / 2;
      const nearPole = best && Math.abs(best.pitch) > 70;
      const rollOk = nearPole || Math.abs(ypr.roll) < 12;
      const steady = speed < MAX_SPEED;
      const aligned = best && bestAng < ALIGN_DEG && rollOk && steady && !landscape;
      ctx.lineWidth = 3;
      ctx.strokeStyle = aligned ? 'rgba(255,255,255,1)' : 'rgba(255,255,255,0.7)';
      ctx.beginPath(); ctx.arc(cx, cy, 26, 0, Math.PI * 2); ctx.stroke();
      if (aligned && !capturing) {
        if (!holdStart) holdStart = now;
        const k = Math.min(1, (now - holdStart) / HOLD_MS);
        ctx.strokeStyle = 'rgba(91,140,255,1)'; ctx.lineWidth = 5;
        ctx.beginPath(); ctx.arc(cx, cy, 26, -Math.PI / 2, -Math.PI / 2 + k * Math.PI * 2); ctx.stroke();
        if (k >= 1) { holdStart = 0; capture(best); }
      } else if (!capturing) holdStart = 0;
      // Level guide when tilted sideways.
      if (!rollOk) {
        const r = ypr.roll * Math.PI / 180;
        ctx.strokeStyle = 'rgba(255,176,32,0.95)'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(cx - 70 * Math.cos(r), cy + 70 * Math.sin(r)); ctx.lineTo(cx + 70 * Math.cos(r), cy - 70 * Math.sin(r)); ctx.stroke();
      }
      // Arrow toward the next dot when it's off-screen or far away.
      if (best) {
        const p = toScreen(best.dir);
        const off = !p || p.x < 30 || p.y < 90 || p.x > W - 30 || p.y > H - 200;
        if (off || bestAng > 25) {
          const c = PM.mat3TVec(R, best.dir);
          let ax = c[0], ay = -c[1]; const n = Math.hypot(ax, ay) || 1; ax /= n; ay /= n;
          const rad = Math.min(W, H) * 0.3, px = cx + ax * rad, py = cy + ay * rad, ang = Math.atan2(ay, ax);
          ctx.save(); ctx.translate(px, py); ctx.rotate(ang);
          ctx.fillStyle = 'rgba(255,255,255,0.95)';
          ctx.beginPath(); ctx.moveTo(18, 0); ctx.lineTo(-10, -13); ctx.lineTo(-4, 0); ctx.lineTo(-10, 13); ctx.closePath(); ctx.fill();
          ctx.restore();
        }
      }
      if (landscape) setMsg('Turn your phone upright (portrait)');
      else if (!best) setMsg('All done — tap Done');
      else if (!rollOk) setMsg('Keep the phone level');
      else if (!steady) setMsg('Slow down a little');
      else if (capturing) setMsg('Got it!');
      else if (aligned) setMsg('Hold still…');
      else if (bestAng < 12) setMsg('Line the ring up with the dot');
      else setMsg(frames.length ? 'Turn to the next dot' : 'Point the ring at the dot to start');
      drawMap();
    }

    function drawMap() {
      const c = ui.map, ctx = c.getContext('2d'), W = c.width, H = c.height;
      ctx.clearRect(0, 0, W, H);
      const yaw0 = targets.length ? targets[0].yaw : 0;
      const px = (lon, lat) => [((PM.wrapDeg(lon - yaw0) / 360) + 0.5) * W, (0.5 - lat / 180) * H];
      ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 1;
      for (let k = 1; k < 4; k++) { ctx.beginPath(); ctx.moveTo(0, H * k / 4); ctx.lineTo(W, H * k / 4); ctx.stroke(); }
      for (const f of frames) {
        const ll = PM.lonLatFromDir(PM.forwardOf(f.R));
        const [x, y] = px(ll.lon, ll.lat);
        const w = Math.min(W, 42 / Math.max(0.25, Math.cos(ll.lat * Math.PI / 180)) / 360 * W), h = 60 / 180 * H;
        ctx.fillStyle = 'rgba(91,140,255,0.45)';
        ctx.fillRect(x - w / 2, y - h / 2, w, h);
        if (x - w / 2 < 0) ctx.fillRect(x - w / 2 + W, y - h / 2, w, h);
        if (x + w / 2 > W) ctx.fillRect(x - w / 2 - W, y - h / 2, w, h);
      }
      for (const t of targets) {
        const [x, y] = px(t.yaw, t.pitch);
        ctx.fillStyle = t.done ? 'rgba(52,199,123,1)' : 'rgba(255,255,255,0.7)';
        ctx.beginPath(); ctx.arc(x, PM.clamp(y, 5, H - 5), 4, 0, Math.PI * 2); ctx.fill();
      }
      if (R) {
        const ll = PM.lonLatFromDir(PM.forwardOf(R)), [x, y] = px(ll.lon, ll.lat);
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(x, PM.clamp(y, 6, H - 6), 9, 0, Math.PI * 2); ctx.stroke();
      }
    }

    async function capture(t) {
      if (capturing || !video) return;
      capturing = true;
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!frameW) { frameW = vw; frameH = vh; }
      const c = document.createElement('canvas');
      c.width = frameW; c.height = frameH;
      c.getContext('2d').drawImage(video, 0, 0, frameW, frameH);
      const Rshot = R.slice();
      t.done = true;
      if (navigator.vibrate) navigator.vibrate(18);
      ui.flash.classList.remove('on'); void ui.flash.offsetWidth; ui.flash.classList.add('on');
      try {
        const gray = PS.grayPyramidFromCanvas(c);
        const blob = await new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('encode')), 'image/jpeg', 0.92));
        frames.push({ blob, w: frameW, h: frameH, R: Rshot, gray, targetId: t.id });
      } catch (e) {
        console.warn('capture failed', e);
        t.done = false;
      }
      c.width = c.height = 1;
      capturing = false;
      updateCounter();
      if (targets.every(x => x.done)) goStitch();
    }

    // ------------------------------------------------------------ stitching + preview
    async function goStitch() {
      if (finished) return;
      stopCamera();
      ui = null; video = null;
      stitchCancelled = false;
      const bar = el('div', { class: 'pc-progress-fill' });
      const pct = el('div', { class: 'pc-pct' }, ['0%']);
      const stageTxt = el('div', { class: 'pc-stage-txt' }, ['Aligning photos…']);
      card([
        el('div', { class: 'pc-hero spin' }, [icon('orbit', 34)]),
        el('h2', {}, ['Building your 360° photo']),
        el('p', { class: 'pc-lead' }, [`Stitching ${frames.length} photos on this phone. Keep the app open — this takes a few seconds.`]),
        stageTxt,
        el('div', { class: 'pc-progress' }, [bar]),
        pct,
        el('button', { class: 'btn ghost block', onclick: () => { stitchCancelled = true; } }, ['Cancel'])
      ]);
      const STAGES = { align: [0, 0.5, 'Aligning photos…'], blend: [0.5, 0.92, 'Blending…'], finish: [0.92, 1, 'Finishing…'] };
      try {
        const res = await PS.stitchCapture(frames, {
          longFovGuess: LONG_FOV_GUESS,
          onProgress: (st, p) => {
            if (stitchCancelled) throw new Error('cancelled');
            const [a, b, txt] = STAGES[st] || STAGES.finish;
            const v = a + (b - a) * p;
            bar.style.width = (v * 100).toFixed(1) + '%';
            pct.textContent = Math.round(v * 100) + '%';
            stageTxt.textContent = txt;
          }
        });
        if (finished) return;
        showPreview(res);
      } catch (e) {
        if (finished) return;
        if (e && e.message === 'cancelled') { finish(null); return; }
        console.error('stitch failed', e);
        card([
          el('div', { class: 'pc-hero warn' }, [icon('alert', 32)]),
          el('h2', {}, ['Could not build the 360° photo']),
          el('p', { class: 'pc-lead' }, ['This phone ran out of memory or the photos could not be processed. Try again with fewer photos, or import a 360° photo.']),
          el('button', { class: 'btn block', onclick: () => goStitch() }, ['Try again']),
          el('button', { class: 'btn ghost block', onclick: () => finish(null) }, ['Close'])
        ]);
      }
    }

    function showPreview(res) {
      stage.innerHTML = '';
      previewViewer = new PanoViewer({ start: { yaw: 0, pitch: 0 } });
      stage.appendChild(previewViewer.el);
      previewViewer.load(res.blob).catch(() => {});
      stage.appendChild(el('div', { class: 'pc-top' }, [
        el('div', { class: 'pc-count glass' }, ['Preview — drag to look around'])
      ]));
      stage.appendChild(el('div', { class: 'pc-preview-bar glass' }, [
        el('button', {
          class: 'btn secondary', onclick: () => {
            if (!confirm('Discard this 360° photo and capture again?')) return;
            previewViewer.destroy(); previewViewer = null;
            frames = []; targets = []; frameW = frameH = 0; R = null; gotSensor = false;
            startCapture();
          }
        }, [icon('restore', 18), 'Retake']),
        el('button', {
          class: 'btn', onclick: () => {
            previewViewer.destroy(); previewViewer = null;
            finish({ blob: res.blob, meta: res.meta });
          }
        }, [icon('check', 18), 'Use this 360°'])
      ]));
    }

    showOverlay(overlay, { onBackdrop: false });
    showIntro();
  });
}

// Pick a panorama from the gallery and turn it into an equirectangular 360° image.
// Resolves to { blob, meta }, 'flat' if the photo isn't a panorama (caller may add it as a
// normal photo — the File is in .file), or null.
async function importPanoramaFlow() {
  const files = await nativePickImageFile({ source: 'gallery' });
  const file = files && files[0];
  if (!file) return null;
  let kind, w, h;
  const spinner = showSpinner('Reading photo…');
  try {
    const bmp = await PanoStitch.decodeToBitmap(file);
    w = bmp.naturalWidth || bmp.width; h = bmp.naturalHeight || bmp.height;
    if (bmp.close) bmp.close();
    kind = (await PanoStitch.readGPano(file)) ? 'sphere' : PanoStitch.classifyPanorama(w, h);
  } catch (e) {
    console.error('import pano failed', e);
    showToast('Could not read that photo');
    return null;
  } finally { spinner.remove(); }
  if (kind === 'flat') return { flat: true, file };
  let coverage = 360;
  if (kind === 'wide') {
    coverage = await askPanoramaCoverage(w, h);
    if (!coverage) return null;
  }
  const sp = showSpinner('Preparing 360° view…');
  try {
    const res = await PanoStitch.importPanorama(file, { coverage });
    return res.notPano ? { flat: true, file } : res;
  } catch (e) {
    console.error('import pano failed', e);
    showToast('Could not prepare that panorama');
    return null;
  } finally { sp.remove(); }
}

// A regular phone "Panorama" photo covers less than a full circle — ask how far round it goes.
function askPanoramaCoverage(w, h) {
  return new Promise((resolve) => {
    const overlay = el('div', { class: 'modal-overlay centered' });
    let done = false;
    const pick = (v) => { if (done) return; done = true; overlay.remove(); resolve(v); };
    overlay.__onClose = () => { if (!done) { done = true; resolve(null); } };
    const guess = w / h > 5.5 ? 360 : w / h > 3.6 ? 270 : 180;
    const opt = (deg, label) => el('button', { class: 'choice-row' + (deg === guess ? ' suggested' : ''), onclick: () => pick(deg) }, [
      el('div', { class: 'choice-deg' }, [deg + '°']),
      el('div', { class: 'choice-text' }, [el('div', { class: 'choice-title' }, [label]), deg === guess ? el('div', { class: 'choice-sub' }, ['Best guess for this photo']) : null])
    ]);
    overlay.appendChild(el('div', { class: 'modal-sheet' }, [
      el('div', { class: 'sheet-grabber' }),
      el('h2', {}, ['How far around does this panorama go?']),
      el('p', { class: 'sheet-sub' }, ['This is a regular wide panorama, not a full 360° sphere. Pick how far you turned while taking it.']),
      opt(360, 'Full circle'), opt(270, 'Three-quarter turn'), opt(180, 'Half turn'),
      el('div', { class: 'btn-row' }, [el('button', { class: 'btn secondary', onclick: () => pick(null) }, ['Cancel'])])
    ]));
    showOverlay(overlay);
  });
}

// Full "get me a 360° photo" flow used by New Location and "Add scene": capture (or import).
// Resolves to { blob, meta } or null. { flat: true, file } when an import turned out to be a
// normal photo.
async function obtainPanorama(mode) {
  let res = mode === 'import' ? 'import' : await openPanoCapture();
  if (res === 'import') res = await importPanoramaFlow();
  return res || null;
}
