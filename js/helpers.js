function $(sel, root) { return (root || document).querySelector(sel); }
function el(tag, attrs, children) {
  const e = document.createElement(tag);
  if (attrs) {
    for (const k in attrs) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'html') e.innerHTML = attrs[k];
      else if (k.startsWith('on') && typeof attrs[k] === 'function') e.addEventListener(k.slice(2), attrs[k]);
      // `value` must be set as a PROPERTY, not an attribute: a <textarea>'s attribute
      // `value` is ignored (its text comes from children/.value), so setting the
      // attribute silently dropped every description. Setting .value works for both
      // <input> and <textarea>.
      else if (k === 'value') e.value = attrs[k] == null ? '' : attrs[k];
      else e.setAttribute(k, attrs[k]);
    }
  }
  (children || []).forEach(c => {
    if (c == null) return;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return e;
}

function blobToUrl(blob) {
  return blob ? URL.createObjectURL(blob) : '';
}

function showToast(msg, ms) {
  const t = el('div', { class: 'toast' }, [msg]);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms || 2200);
}

// Blocking, dismiss-proof loading overlay shown during slow work (photo compression).
// Returns the node — call .remove() when done.
function showSpinner(msg) {
  const overlay = el('div', { class: 'spinner-overlay' }, [
    el('div', { class: 'spinner-box' }, [
      el('div', { class: 'spinner' }),
      el('div', { class: 'spinner-msg' }, [msg || 'Working…'])
    ])
  ]);
  document.body.appendChild(overlay);
  return overlay;
}

// source: 'camera' → take a new photo; 'gallery' (or unset) → the device photo picker.
// For 'camera' with the in-app camera mode enabled (default), open our getUserMedia camera
// with the flash ON. If that camera can't open (permission/unsupported) we fall back to the
// native camera picker. In 'native' mode we always use the native picker.
async function pickImageFile({ multiple, source } = {}) {
  if (source === 'camera' && (typeof getCameraMode !== 'function' || getCameraMode() === 'app')
      && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    const res = await openInAppCamera();
    if (res !== 'fallback') return res;         // captured file(s), or [] if user closed it
    // else fall through to the native camera picker
  }
  return nativePickImageFile({ multiple, source });
}

// The original hidden <input type=file> picker (native camera or gallery).
function nativePickImageFile({ multiple, source } = {}) {
  return new Promise((resolve) => {
    // Explicitly list HEIC/HEIF so pickers that filter by accept don't grey them out.
    const attrs = { type: 'file', accept: 'image/*,.heic,.heif,.HEIC,.HEIF', class: 'file-input-hidden' };
    if (source === 'camera') attrs.capture = 'environment';
    const input = el('input', attrs);
    if (multiple) input.setAttribute('multiple', 'multiple');
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      const files = Array.from(input.files || []);
      input.remove();
      resolve(files);
    });
    input.addEventListener('cancel', () => { input.remove(); resolve([]); });
    input.click();
  });
}

// ---- In-app camera (getUserMedia) with a REAL flash-at-capture ----
// Opens a full-screen live camera (rear). The flash is NOT a continuous torch: with flash
// set to ON, the torch is pulsed only for the moment of capture (turn on → let the LED reach
// brightness and exposure settle → grab the frame → turn off), mimicking a normal camera
// flash. A flash toggle lets the user turn this off. Resolves to the captured File(s), [] if
// the user closes it, or 'fallback' if the camera can't open (caller uses the native picker).
function openInAppCamera() {
  return new Promise((resolve) => {
    let stream = null, track = null, done = false;
    let torchSupported = false;
    let flashMode = true;   // true = flash fires at capture; false = no flash
    let capturing = false;

    const overlay = el('div', { class: 'camera-overlay' });
    const video = el('video', { autoplay: 'true', playsinline: 'true' });
    video.muted = true; video.playsInline = true; // properties (needed for iOS inline autoplay)
    video.setAttribute('playsinline', 'true'); // iOS: play inline, don't go fullscreen native
    const flashBtn = el('button', { class: 'cam-btn cam-flash', title: 'Flash' }, ['⚡ Flash On']);
    const shutter = el('button', { class: 'cam-shutter', title: 'Capture' });
    const closeBtn = el('button', { class: 'cam-btn cam-close', title: 'Close' }, ['✕']);

    function finish(files) {
      if (done) return; done = true;
      try { if (track) track.stop(); if (stream) stream.getTracks().forEach(t => t.stop()); } catch (e) {}
      overlay.remove();
      resolve(files === 'fallback' ? 'fallback' : (files || []));
    }

    // Momentarily set the torch on/off (used to pulse the flash at capture time only).
    async function setTorch(on) {
      if (!track || !torchSupported) return;
      try { await track.applyConstraints({ advanced: [{ torch: on }] }); }
      catch (e) { console.warn('Torch apply failed', e); }
    }

    function updateFlashBtn() {
      if (!torchSupported) { flashBtn.textContent = '⚡ No flash'; flashBtn.disabled = true; flashBtn.classList.add('unavailable'); return; }
      flashBtn.textContent = flashMode ? '⚡ Flash On' : '⚡ Flash Off';
      flashBtn.classList.toggle('active', flashMode);
    }

    async function start() {
      try {
        // Prefer the rear camera. Some Android browsers only expose torch when the camera is
        // opened WITHOUT a resolution constraint, so keep the request minimal.
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false
        });
      } catch (e) {
        console.warn('In-app camera unavailable, falling back', e);
        showToast('Camera needs HTTPS + permission — using phone camera');
        finish('fallback'); // caller then opens the native camera picker
        return;
      }
      video.srcObject = stream;
      track = stream.getVideoTracks()[0];

      // Read torch capability once the track is live, then make sure the torch starts OFF
      // (it should only fire at capture). Retry the capability read briefly — some devices
      // report it a moment after the stream goes live.
      const initFlash = async () => {
        const caps = (track.getCapabilities && track.getCapabilities()) || {};
        torchSupported = !!caps.torch;
        if (torchSupported) { await setTorch(false); }
        else { flashMode = false; showToast('This device/browser has no controllable flash'); }
        updateFlashBtn();
        if (!torchSupported) setTimeout(async () => {
          const c2 = (track.getCapabilities && track.getCapabilities()) || {};
          if (c2.torch) { torchSupported = true; flashMode = true; updateFlashBtn(); }
        }, 500);
      };
      if (video.readyState >= 2) initFlash();
      else video.addEventListener('loadeddata', initFlash, { once: true });
      video.play && video.play().catch(() => {});
    }

    function grabFrame() {
      const w = video.videoWidth, h = video.videoHeight;
      if (!w || !h) return null;
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(video, 0, 0, w, h);
      return canvas;
    }

    async function capture() {
      if (capturing) return;
      capturing = true;
      shutter.classList.add('busy');
      try {
        // Fire the flash only for the capture: torch ON → wait for LED brightness + exposure
        // to settle → grab → torch OFF.
        if (flashMode && torchSupported) {
          await setTorch(true);
          await new Promise(r => setTimeout(r, 350));
        }
        const canvas = grabFrame();
        if (flashMode && torchSupported) { await setTorch(false); }
        if (!canvas) { capturing = false; shutter.classList.remove('busy'); return; }
        canvas.toBlob((blob) => {
          if (!blob) { capturing = false; shutter.classList.remove('busy'); return; }
          const file = new File([blob], `photo-${Date.now()}.jpg`, { type: 'image/jpeg' });
          finish([file]);
        }, 'image/jpeg', 0.92);
      } catch (e) {
        console.warn('Capture failed', e);
        capturing = false; shutter.classList.remove('busy');
      }
    }

    flashBtn.addEventListener('click', () => { if (!flashBtn.disabled) { flashMode = !flashMode; updateFlashBtn(); } });
    shutter.addEventListener('click', capture);
    closeBtn.addEventListener('click', () => finish([]));

    overlay.appendChild(video);
    overlay.appendChild(el('div', { class: 'cam-topbar' }, [closeBtn, flashBtn]));
    overlay.appendChild(el('div', { class: 'cam-bottombar' }, [shutter]));
    document.body.appendChild(overlay);
    start();
  });
}

// Ask the user whether to take a new photo or pick from the gallery, then return the
// selected file(s). Cancelling the chooser resolves to []. Used everywhere a photo is added.
function pickImageWithChoice({ multiple } = {}) {
  return new Promise((resolve) => {
    const overlay = el('div', { class: 'modal-overlay centered' });
    let done = false;
    const finish = (files) => { if (done) return; done = true; overlay.remove(); resolve(files || []); };
    async function via(source) {
      const files = await pickImageFile({ multiple, source });
      finish(files);
    }
    // Two big tap tiles. "Take photo" is placed on the RIGHT (thumb-friendly for right-hand
    // use); "Choose from gallery" on the left.
    const galleryTile = el('button', { class: 'photo-choice-tile', onclick: () => via('gallery') }, [
      el('div', { class: 'pct-icon' }, ['🖼️']),
      el('div', { class: 'pct-label' }, ['Choose from gallery'])
    ]);
    const cameraTile = el('button', { class: 'photo-choice-tile primary', onclick: () => via('camera') }, [
      el('div', { class: 'pct-icon' }, ['📷']),
      el('div', { class: 'pct-label' }, ['Take photo'])
    ]);
    const sheet = el('div', { class: 'modal-sheet' }, [
      el('h2', {}, ['Add photo']),
      el('div', { class: 'photo-choice-grid' }, [galleryTile, cameraTile]),
      el('div', { class: 'btn-row', style: 'margin-top:14px;' }, [
        el('button', { class: 'btn secondary', onclick: () => finish([]) }, ['Cancel'])
      ])
    ]);
    overlay.appendChild(sheet);
    showOverlay(overlay);
  });
}

// #11 — Photo compression at capture.
// Phone cameras produce 3–8 MB, ~4000px JPEGs. That resolution is wasted for this
// use case (viewing box contents on a phone), and 100–200 of them would bloat
// IndexedDB and slow loading. So every photo is re-encoded on a canvas the moment
// it's picked, BEFORE it is stored:
//   • item photos (default): longest edge 1280px, JPEG quality 0.72  → typically ~120–250 KB each
//   • cover photos: longest edge 1600px, quality 0.82 (callers pass these) → sharper for pin placement
// Net effect: ~10–30× smaller than the original. 200 item photos land around 30–50 MB
// total instead of several hundred MB, keeping storage light and the app fast.
// Thumbnails for grids/lists are made separately (see makeThumb) so full-res images
// are only decoded when a photo is opened full-screen.
// Downscale + re-encode a picked image to JPEG. `rotate` (0/90/180/270) bakes in a
// rotation (used by the rotate feature). Decoding path: try createImageBitmap first — it
// handles more source formats than <img> (notably HEIC on iOS Safari, which <img> can't
// draw to a canvas) and is faster — then fall back to <img>. Always outputs JPEG so HEIC
// never reaches storage.
async function downscaleImage(file, maxDim = 1280, quality = 0.72, rotate = 0) {
  const src = await decodeImageSource(file);
  const sw = src.width, sh = src.height;
  let w = sw, h = sh;
  if (w > maxDim || h > maxDim) {
    if (w >= h) { h = Math.round(h * maxDim / w); w = maxDim; }
    else { w = Math.round(w * maxDim / h); h = maxDim; }
  }
  const rot = ((rotate % 360) + 360) % 360;
  const swap = rot === 90 || rot === 270;
  const canvas = document.createElement('canvas');
  canvas.width = swap ? h : w;
  canvas.height = swap ? w : h;
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(rot * Math.PI / 180);
  ctx.drawImage(src.el, -w / 2, -h / 2, w, h);
  ctx.restore();
  if (src.close) src.close();
  return await new Promise((resolve, reject) =>
    canvas.toBlob(b => b ? resolve(b) : reject(new Error('encode failed')), 'image/jpeg', quality));
}

// Interactive crop modal. Shows the image with a draggable/resizable crop rectangle;
// on "Crop" it outputs a new JPEG blob of the selected region. onDone(blob) is called with
// the result (or the modal is simply cancelled). Works for both a Blob and a File input.
function openCropModal(fileOrBlob, onDone) {
  const overlay = el('div', { class: 'modal-overlay centered' });
  const stage = el('div', { class: 'crop-stage' });
  const imgEl = el('img', { class: 'crop-img', draggable: 'false' });
  const box = el('div', { class: 'crop-box' }, [
    el('div', { class: 'crop-handle nw' }), el('div', { class: 'crop-handle ne' }),
    el('div', { class: 'crop-handle sw' }), el('div', { class: 'crop-handle se' })
  ]);
  stage.appendChild(imgEl); stage.appendChild(box);

  const url = URL.createObjectURL(fileOrBlob);
  imgEl.src = url;

  // Crop rect in stage (displayed) pixels.
  let rect = { x: 0, y: 0, w: 0, h: 0 };
  function layoutBox() {
    box.style.left = rect.x + 'px'; box.style.top = rect.y + 'px';
    box.style.width = rect.w + 'px'; box.style.height = rect.h + 'px';
  }
  imgEl.onload = () => {
    const dw = imgEl.clientWidth, dh = imgEl.clientHeight;
    // Start with an 80% centred crop.
    rect = { x: dw * 0.1, y: dh * 0.1, w: dw * 0.8, h: dh * 0.8 };
    layoutBox();
  };

  // Drag the box body to move; drag a handle to resize.
  let mode = null, sx = 0, sy = 0, orig = null;
  function bounds() { return { W: imgEl.clientWidth, H: imgEl.clientHeight }; }
  function onDown(e) {
    const handle = e.target.classList.contains('crop-handle') ? e.target : null;
    mode = handle ? 'resize-' + handle.classList[1] : (e.target === box ? 'move' : null);
    if (!mode) return;
    e.preventDefault(); e.stopPropagation();
    sx = e.clientX; sy = e.clientY; orig = { ...rect };
    box.setPointerCapture(e.pointerId);
  }
  function onMove(e) {
    if (!mode) return;
    const { W, H } = bounds();
    const dx = e.clientX - sx, dy = e.clientY - sy;
    let r = { ...orig };
    if (mode === 'move') {
      r.x = Math.max(0, Math.min(W - r.w, orig.x + dx));
      r.y = Math.max(0, Math.min(H - r.h, orig.y + dy));
    } else {
      if (mode.includes('e')) r.w = Math.max(30, Math.min(W - orig.x, orig.w + dx));
      if (mode.includes('s')) r.h = Math.max(30, Math.min(H - orig.y, orig.h + dy));
      if (mode.includes('w')) { const nx = Math.max(0, Math.min(orig.x + orig.w - 30, orig.x + dx)); r.w = orig.x + orig.w - nx; r.x = nx; }
      if (mode.includes('n')) { const ny = Math.max(0, Math.min(orig.y + orig.h - 30, orig.y + dy)); r.h = orig.y + orig.h - ny; r.y = ny; }
    }
    rect = r; layoutBox();
  }
  function onUp() { mode = null; }
  box.addEventListener('pointerdown', onDown);
  box.addEventListener('pointermove', onMove);
  box.addEventListener('pointerup', onUp);
  box.addEventListener('pointercancel', onUp);

  async function doCrop() {
    const scaleX = imgEl.naturalWidth / imgEl.clientWidth;
    const scaleY = imgEl.naturalHeight / imgEl.clientHeight;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(rect.w * scaleX));
    c.height = Math.max(1, Math.round(rect.h * scaleY));
    const src = await decodeImageSource(fileOrBlob);
    c.getContext('2d').drawImage(src.el, rect.x * scaleX, rect.y * scaleY, rect.w * scaleX, rect.h * scaleY, 0, 0, c.width, c.height);
    if (src.close) src.close();
    c.toBlob(b => { URL.revokeObjectURL(url); overlay.remove(); onDone && onDone(b); }, 'image/jpeg', 0.85);
  }

  overlay.appendChild(el('div', { class: 'modal-sheet crop-sheet' }, [
    el('h2', {}, ['Crop photo']),
    stage,
    el('div', { class: 'btn-row', style: 'margin-top:12px;' }, [
      el('button', { class: 'btn secondary', onclick: () => { URL.revokeObjectURL(url); overlay.remove(); } }, ['Cancel']),
      el('button', { class: 'btn', onclick: doCrop }, ['Crop'])
    ])
  ]));
  showOverlay(overlay);
}

// Decode any supported image blob/file into a drawable source {el, width, height, close?}.
function decodeImageSource(file) {
  return new Promise(async (resolve, reject) => {
    // Preferred: createImageBitmap (broad format support incl. HEIC on modern iOS).
    if (typeof createImageBitmap === 'function') {
      try {
        const bmp = await createImageBitmap(file);
        resolve({ el: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close && bmp.close() });
        return;
      } catch (e) { /* fall through to <img> */ }
    }
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => resolve({ el: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read this image (unsupported format?)')); };
    img.src = url;
  });
}

// ---- Instant photo add with background compression ----
// The user should NOT wait for canvas re-encoding when adding a photo. Strategy:
//   1. Store the ORIGINAL picked file immediately (no decode/encode) so it appears at once.
//   2. In the background, downscale+re-encode it to a small JPEG and swap the stored blob in
//      place (same record id) so long-term storage stays light.
// `saveBlob(blob)` must persist the blob and return the stored record (with an id) — used
// both for the instant original and, later, for the compressed replacement (via `replace`).
//
// Returns the record from the instant save so the UI can show it right away. The background
// compression runs detached; when it finishes it calls `replace(record, smallBlob)`.
async function addPhotoInstant(file, { save, replace, maxDim = 1280, quality = 0.72 }) {
  // Instant: keep the original bytes as a JPEG-ish blob. Phone camera output is already a
  // JPEG/HEIC File (a Blob), so we can store it directly with zero processing.
  const record = await save(file);
  // Background: compress and swap. Never blocks the caller.
  compressInBackground(file, record, replace, maxDim, quality);
  return record;
}

// Fire-and-forget: downscale `file` and replace the stored blob for `record`. Failures are
// non-fatal — the original (larger) blob simply stays.
function compressInBackground(file, record, replace, maxDim, quality) {
  // Defer so the current tap/render finishes first and the photo shows instantly.
  const run = () => downscaleImage(file, maxDim, quality)
    .then(small => { if (small) return replace(record, small); })
    .catch(err => console.warn('Background compress failed; keeping original', err));
  if (window.requestIdleCallback) requestIdleCallback(() => run(), { timeout: 1500 });
  else setTimeout(run, 50);
}

function makeThumb(blob, maxDim = 300, quality = 0.7) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        if (width >= height) { height = Math.round(height * maxDim / width); width = maxDim; }
        else { width = Math.round(width * maxDim / height); height = maxDim; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob(b => { URL.revokeObjectURL(url); resolve(b); }, 'image/jpeg', quality);
    };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(dataUrl) {
  const [meta, b64] = dataUrl.split(',');
  const mime = meta.match(/data:(.*?);/)[1];
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function safeFileName(name) {
  return (name || 'export').replace(/[\\/:*?"<>|]/g, '_').trim() || 'export';
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
