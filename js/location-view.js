let lvState = null; // per-location-view transient state
// Modes persist across in-place re-renders (e.g. after a layout rotate/front/back) so a
// toggle the user turned ON stays ON until they turn it OFF. Reset when the location changes.
let lvModes = { locationId: null, addMode: false, relocateMode: false, layoutMode: false };
// The zoom/pan the user has set persists across in-place re-renders (e.g. after saving a
// hotspot) so the canvas doesn't snap back to the fit-everything view. Reset per location.
let lvViewport = { locationId: null, scale: 0, tx: 0, ty: 0 };

async function renderLocationView() {
  hideNudgePad(); // drop any stale relocate pad from a previous render
  const loc = await DB.getLocation(state.locationId);
  if (!loc) { goHome(); return; }

  if (lvModes.locationId !== loc.id) {
    lvModes = { locationId: loc.id, addMode: false, relocateMode: false, layoutMode: false };
  }

  lvState = {
    scale: 1, tx: 0, ty: 0,
    canvasW: 0, canvasH: 0,          // total canvas size (bounding box of all pages)
    markerType: loc.type === 'diagram' ? 'annotation' : 'box',
    addMode: lvModes.addMode,
    relocateMode: lvModes.relocateMode,
    layoutMode: lvModes.layoutMode,  // when ON, drag whole pages to reposition them
    highlightAnno: false,            // #16 highlight-all-annotations dim mode
    pages: [],                       // [{ page, block, img, pinLayer, w, h }]
    loc
  };

  const isAnno = lvState.markerType === 'annotation';

  const topbar = el('div', { class: 'topbar' }, [
    el('button', { class: 'icon-btn', onclick: () => history.back() }, ['←']),
    el('h1', {}, [loc.name]),
    // #16: annotation-only — highlight all annotations (dim the diagram behind them).
    isAnno ? el('button', { class: 'icon-btn', title: 'Highlight annotations', onclick: () => toggleAnnoHighlight() }, ['💡']) : null,
    el('button', { class: 'icon-btn', title: 'Search hotspots', onclick: () => toggleBrowse(loc) }, ['🔍']),
    el('button', { class: 'icon-btn', title: 'Export Excel', onclick: () => exportLocationExcel(loc) }, ['📊']),
    el('button', { class: 'icon-btn', title: 'Edit Location', onclick: () => openEditLocationModal(loc) }, ['✏️'])
  ]);
  root.appendChild(topbar);

  const viewWrap = el('div', { class: 'view', style: 'padding:0;overflow:hidden;' });
  root.appendChild(viewWrap);

  // Load pages (v3). Older data was migrated so there is always ≥1 page unless the
  // location was created with no photo yet.
  let pages = await DB.getPagesForLocation(loc.id);

  if (!pages.length) {
    viewWrap.appendChild(el('div', { class: 'no-photo-placeholder' }, [
      el('div', { style: 'font-size:40px;' }, ['📷']),
      el('div', {}, ['No photo yet. Add a photo of this location to start tagging.']),
      el('button', {
        class: 'btn', onclick: async () => {
          const files = await pickImageWithChoice();
          if (files[0]) {
            const file = files[0];
            // Instant: store the original, compress+swap in the background.
            const pg = await addPhotoInstant(file, {
              save: (blob) => DB.addPage({ locationId: loc.id, photo: blob, order: 0 }),
              replace: (rec, small) => { rec.photo = small; return DB.updatePage(rec); },
              maxDim: 1600, quality: 0.82
            });
            if (!loc.coverPhoto) {
              loc.coverPhoto = file; await DB.updateLocation(loc); // home thumbnail
              compressInBackground(file, loc, (l, small) => { l.coverPhoto = small; return DB.updateLocation(l); }, 1600, 0.82);
            }
            render();
          }
        }
      }, ['Add Photo'])
    ]));
    return;
  }

  const viewer = el('div', { class: 'location-viewer' });
  viewWrap.appendChild(viewer);
  const stage = el('div', { class: 'stage stage-multi' });
  viewer.appendChild(stage);

  lvState.viewer = viewer;
  lvState.stage = stage;

  // Build a positioned block per page, load each image, then set the view. On the FIRST open
  // of a location we fit the whole canvas; on an in-place re-render (e.g. after saving a
  // hotspot) we RESTORE the zoom/pan the user had, so the canvas doesn't snap back to the
  // fit-everything view.
  await buildPages(loc, pages, stage);
  fitCanvasToScreen();                 // always compute baseScale (used for zoom clamps)
  if (lvViewport.locationId === loc.id && lvViewport.scale > 0) {
    lvState.scale = lvViewport.scale;
    lvState.tx = lvViewport.tx;
    lvState.ty = lvViewport.ty;
  } else {
    lvViewport = { locationId: loc.id, scale: lvState.scale, tx: lvState.tx, ty: lvState.ty };
  }
  applyTransform(stage);

  // Viewer-level zoom/pan + tap-to-create. On tap we work out which page was hit and the
  // tap's % within that page's image.
  setupZoomPan(viewer, stage, null, () => {}, (clientX, clientY, targetEl) => {
    if (targetEl && targetEl.closest('.pin, .location-toolbar, .nudge-pad-circle, .add-hint')) return;
    if (lvState.layoutMode) return;              // layout mode drags pages, never creates
    if (!lvState.addMode) return;
    const hit = pageAtPoint(clientX, clientY);
    if (!hit) return;
    handleTapCreate(loc, hit.page.id, hit.relX * 100, hit.relY * 100, hit.entry);
  });

  const addLabelOn = isAnno ? 'Tap image to add a dot' : 'Tap image to add a box';
  const hint = el('div', { class: 'add-hint' }, [addLabelOn]);
  hint.style.display = 'none';
  viewer.appendChild(hint);
  lvState.hint = hint;
  lvState.addLabelOn = addLabelOn;

  // Toggles: Add, Relocate, Layout.
  const addToggle = makeToggle(isAnno ? 'Add' : 'Add box');
  const relocateToggle = makeToggle('Relocate');
  const layoutToggle = makeToggle('Layout');

  function refreshToggle() {
    addToggle.classList.toggle('on', lvState.addMode);
    relocateToggle.classList.toggle('on', lvState.relocateMode);
    layoutToggle.classList.toggle('on', lvState.layoutMode);
    viewer.classList.toggle('add-mode', lvState.addMode);
    viewer.classList.toggle('relocate-mode', lvState.relocateMode);
    viewer.classList.toggle('layout-mode', lvState.layoutMode);
    hint.style.display = (lvState.addMode || lvState.relocateMode || lvState.layoutMode) ? 'block' : 'none';
    hint.textContent = lvState.layoutMode ? 'Drag a photo to position it'
      : lvState.relocateMode ? 'Tap a marker to nudge it, or drag it'
      : addLabelOn;
    // Persist the current modes so an in-place render() (e.g. after a layout rotate) keeps
    // whatever the user had toggled on.
    lvModes.addMode = lvState.addMode;
    lvModes.relocateMode = lvState.relocateMode;
    lvModes.layoutMode = lvState.layoutMode;
  }
  lvState.refreshToggle = refreshToggle;
  addToggle.addEventListener('click', () => { lvState.addMode = !lvState.addMode; if (lvState.addMode) { lvState.relocateMode = lvState.layoutMode = false; } hideNudgePad(); refreshToggle(); });
  relocateToggle.addEventListener('click', () => { lvState.relocateMode = !lvState.relocateMode; if (lvState.relocateMode) { lvState.addMode = lvState.layoutMode = false; } hideNudgePad(); refreshToggle(); });
  layoutToggle.addEventListener('click', () => { lvState.layoutMode = !lvState.layoutMode; if (lvState.layoutMode) { lvState.addMode = lvState.relocateMode = false; } hideNudgePad(); refreshToggle(); });

  const toolbar = el('div', { class: 'location-toolbar' }, [
    addToggle, relocateToggle, layoutToggle,
    el('button', { class: 'btn secondary small', title: 'Add another photo', onclick: () => addPageFlow(loc) }, ['+ Photo'])
  ]);
  viewer.appendChild(toolbar);
  refreshToggle();
}

function makeToggle(label) {
  return el('button', { class: 'toggle-btn' }, [
    el('span', { class: 'toggle-track' }, [el('span', { class: 'toggle-knob' })]),
    el('span', { class: 'toggle-label' }, [label])
  ]);
}

// Build one .page-block per page positioned at its offset; load images and record sizes.
// Returns after all images have loaded so the canvas bounding box is known.
async function buildPages(loc, pages, stage) {
  stage.innerHTML = '';
  lvState.pages = [];
  await Promise.all(pages.map(page => new Promise((resolve) => {
    const block = el('div', { class: 'page-block' });
    block.style.left = (page.offsetX || 0) + 'px';
    block.style.top = (page.offsetY || 0) + 'px';
    block.style.zIndex = String(page.order || 0); // front/back layering (#5)
    block.dataset.pageId = page.id;
    const img = el('img', { class: 'cover-img', draggable: 'false' });
    const pinLayer = el('div', { class: 'pin-layer' });
    block.appendChild(img);
    block.appendChild(pinLayer);
    // Corner resize handles (visible only in layout mode via CSS). Dragging a corner scales
    // the photo uniformly about its centre — an alternative to the two-finger pinch.
    ['nw', 'ne', 'sw', 'se'].forEach(c => block.appendChild(el('div', { class: 'page-resize-handle ' + c, 'data-corner': c })));
    stage.appendChild(block);
    const entry = { page, block, img, pinLayer, w: 0, h: 0 };
    lvState.pages.push(entry);
    img.onload = () => {
      entry.w = img.naturalWidth; entry.h = img.naturalHeight;
      block.style.width = entry.w + 'px';
      block.style.height = entry.h + 'px';
      applyPageTransform(entry); // bake in stored rotation + scale
      resolve();
    };
    img.onerror = () => resolve();
    img.src = page.photo ? blobToUrl(page.photo) : '';
    // Dragging a whole page in layout mode.
    enablePageLayoutDrag(entry);
    enableCornerResize(entry);
  })));
  recomputeCanvasSize();
  // Render pins for every page.
  for (const entry of lvState.pages) await loadPagePins(loc, entry);
  applyAnnoHighlight();
}

// Persist EVERY page's position/rotation/scale. Needed after any layout change because
// recomputeCanvasSize() may shift ALL pages' offsets (when one extends past the origin), so
// saving only the dragged page would leave the others' new offsets unsaved → they'd reload at
// stale positions and overlap. Saving all pages keeps the whole layout consistent on reload.
async function persistAllPages() {
  for (const e of lvState.pages) {
    try { await DB.updatePage(e.page); } catch (err) { console.error('Save page failed', err); }
  }
}

// ---- Page transform (free-angle rotation + uniform scale) ----
// Each page has an unrotated "natural box" at (offsetX, offsetY) sized w×h. We apply the
// page's scale+rotation about the box CENTRE via a CSS transform, so the pins inside the
// block (positioned in %) rotate and scale WITH the image and never drift.
function pageRot(page) { return (((page.rotation || 0) % 360) + 360) % 360; }
function pageScale(page) { const s = page.scale || 1; return s > 0 ? s : 1; }

function applyPageTransform(entry) {
  const s = pageScale(entry.page), deg = pageRot(entry.page);
  // transform-origin is the box centre (set in CSS), so scale then rotate about the centre.
  entry.block.style.transform = `scale(${s}) rotate(${deg}deg)`;
}

// The 4 corners of a page's rotated+scaled box in canvas coordinates. Rotation/scale are
// about the box centre; the box's natural top-left sits at (offsetX, offsetY).
function pageCornersCanvas(entry) {
  const p = entry.page;
  const ox = p.offsetX || 0, oy = p.offsetY || 0, w = entry.w, h = entry.h;
  const cx = ox + w / 2, cy = oy + h / 2;
  const s = pageScale(p), rad = pageRot(p) * Math.PI / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([dx, dy]) => {
    const sx = dx * s, sy = dy * s;
    return { x: cx + sx * cos - sy * sin, y: cy + sx * sin + sy * cos };
  });
}

// The canvas is the axis-aligned bounding box that contains every rotated+scaled page. If any
// page extends left/above origin (negative), shift the whole stage so the canvas starts at 0.
function recomputeCanvasSize() {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const e of lvState.pages) {
    for (const c of pageCornersCanvas(e)) {
      minX = Math.min(minX, c.x); minY = Math.min(minY, c.y);
      maxX = Math.max(maxX, c.x); maxY = Math.max(maxY, c.y);
    }
  }
  if (!isFinite(minX)) { minX = minY = 0; maxX = 1000; maxY = 800; }
  // Shift all page offsets so the bounding box's top-left is (0,0). Keeps pin math simple
  // (canvas coords are always ≥ 0) and the stage size exact.
  const shiftX = minX < 0 ? -minX : 0, shiftY = minY < 0 ? -minY : 0;
  if (shiftX || shiftY) {
    for (const e of lvState.pages) {
      e.page.offsetX = (e.page.offsetX || 0) + shiftX;
      e.page.offsetY = (e.page.offsetY || 0) + shiftY;
      e.block.style.left = e.page.offsetX + 'px';
      e.block.style.top = e.page.offsetY + 'px';
    }
    maxX += shiftX; maxY += shiftY;
  }
  lvState.canvasW = Math.max(1, Math.round(maxX)) || 1000;
  lvState.canvasH = Math.max(1, Math.round(maxY)) || 800;
  if (lvState.stage) {
    lvState.stage.style.width = lvState.canvasW + 'px';
    lvState.stage.style.height = lvState.canvasH + 'px';
  }
}

// Convert a screen point to canvas coordinates (undo the stage translate+scale).
function screenToCanvas(clientX, clientY) {
  const r = lvState.viewer.getBoundingClientRect();
  return {
    x: (clientX - r.left - lvState.tx) / lvState.scale,
    y: (clientY - r.top - lvState.ty) / lvState.scale
  };
}

// Undo a page's scale+rotation (about its centre) to get the tap's fractional position
// within the natural (unrotated) image. Returns {relX, relY} in 0..1, or null if outside.
function canvasPointToPageFraction(entry, cx, cy) {
  const p = entry.page, w = entry.w, h = entry.h;
  const centerX = (p.offsetX || 0) + w / 2, centerY = (p.offsetY || 0) + h / 2;
  const s = pageScale(p), rad = pageRot(p) * Math.PI / 180;
  // Translate to centre, inverse-rotate, inverse-scale.
  const dx = cx - centerX, dy = cy - centerY;
  const cos = Math.cos(-rad), sin = Math.sin(-rad);
  const rx = (dx * cos - dy * sin) / s;
  const ry = (dx * sin + dy * cos) / s;
  const relX = rx / w + 0.5, relY = ry / h + 0.5;
  if (relX < 0 || relX > 1 || relY < 0 || relY > 1) return null;
  return { relX, relY };
}
// Same as above but never returns null — used while dragging a marker so it stays grabbable
// even if the finger strays just outside the image; the caller clamps to 0..1.
function canvasPointToPageFractionUnclamped(entry, cx, cy) {
  const p = entry.page, w = entry.w, h = entry.h;
  const centerX = (p.offsetX || 0) + w / 2, centerY = (p.offsetY || 0) + h / 2;
  const s = pageScale(p), rad = pageRot(p) * Math.PI / 180;
  const dx = cx - centerX, dy = cy - centerY;
  const cos = Math.cos(-rad), sin = Math.sin(-rad);
  const rx = (dx * cos - dy * sin) / s;
  const ry = (dx * sin + dy * cos) / s;
  return { relX: rx / w + 0.5, relY: ry / h + 0.5 };
}

// Which page image is under a screen point, and the tap's fractional position within it.
// When images overlap, the topmost (highest z / order) wins. Rotation/scale aware.
function pageAtPoint(clientX, clientY) {
  const { x: cx, y: cy } = screenToCanvas(clientX, clientY);
  const ordered = lvState.pages.slice().sort((a, b) => (b.page.order || 0) - (a.page.order || 0));
  for (const entry of ordered) {
    const frac = canvasPointToPageFraction(entry, cx, cy);
    if (frac) return { entry, page: entry.page, relX: frac.relX, relY: frac.relY };
  }
  return null;
}

// Layout-mode gestures on a whole page:
//   • one finger drag  → reposition the photo on the canvas
//   • two fingers      → pinch to RESIZE and twist to ROTATE (any angle, 0–360°)
//   • plain tap / hold (no move) → the page menu (crop / front / back / delete)
// Rotation/scale are stored as page metadata (page.rotation, page.scale) so the pins on the
// page rotate and scale WITH the image and stay in their correct spots.
function enablePageLayoutDrag(entry) {
  const block = entry.block;
  const pts = new Map();            // active pointers on THIS block
  let start = null;                 // single-finger drag anchor
  let gesture = null;               // two-finger pinch/rotate anchor
  let holdTimer = null, movedFar = false, menuOpened = false, changed = false;
  function clearHold() { if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; } }
  function twoFingerInfo() {
    const a = Array.from(pts.values());
    const dist = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
    const ang = Math.atan2(a[1].y - a[0].y, a[1].x - a[0].x) * 180 / Math.PI;
    return { dist, ang };
  }

  block.addEventListener('pointerdown', (e) => {
    if (!lvState.layoutMode) return;
    if (e.target.closest('.pin')) return;
    e.stopPropagation();
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { block.setPointerCapture(e.pointerId); } catch (err) {}
    block.classList.add('page-dragging');

    if (pts.size === 1) {
      movedFar = false; menuOpened = false; changed = false;
      start = { x: e.clientX, y: e.clientY, ox: entry.page.offsetX || 0, oy: entry.page.offsetY || 0 };
      holdTimer = setTimeout(() => {
        menuOpened = true; start = null; block.classList.remove('page-dragging'); openPageMenu(entry);
      }, 500);
    } else if (pts.size === 2) {
      // Second finger down → switch from drag to pinch/rotate.
      clearHold(); start = null; movedFar = true;
      const { dist, ang } = twoFingerInfo();
      gesture = { dist, ang, baseScale: pageScale(entry.page), baseRot: pageRot(entry.page) };
    }
  });

  block.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pts.size >= 2 && gesture) {
      const { dist, ang } = twoFingerInfo();
      if (gesture.dist > 0) {
        let s = gesture.baseScale * (dist / gesture.dist);
        s = Math.max(0.2, Math.min(6, s));       // clamp resize
        entry.page.scale = Math.round(s * 1000) / 1000;
      }
      entry.page.rotation = (((gesture.baseRot + (ang - gesture.ang)) % 360) + 360) % 360;
      applyPageTransform(entry);
      changed = true;
    } else if (pts.size === 1 && start) {
      const dx = (e.clientX - start.x) / lvState.scale;
      const dy = (e.clientY - start.y) / lvState.scale;
      if (!movedFar && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) { movedFar = true; clearHold(); }
      entry.page.offsetX = Math.round(start.ox + dx);
      entry.page.offsetY = Math.round(start.oy + dy);
      block.style.left = entry.page.offsetX + 'px';
      block.style.top = entry.page.offsetY + 'px';
      changed = true;
    }
  });

  const end = async (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (pts.size >= 2) return;         // still pinching with remaining fingers
    if (pts.size === 1) {              // dropped from two fingers to one — end the gesture
      gesture = null;
      if (changed) { recomputeCanvasSize(); await persistAllPages(); changed = false; }
      return;
    }
    // pts.size === 0 — gesture fully ended.
    clearHold();
    block.classList.remove('page-dragging');
    const wasGesture = !!gesture; gesture = null;
    if (changed) {
      recomputeCanvasSize();
      await persistAllPages();
      changed = false;
    } else if (!menuOpened && !wasGesture && start) {
      openPageMenu(entry);            // a plain tap (no move) opens the menu
    }
    start = null;
  };
  block.addEventListener('pointerup', end);
  block.addEventListener('pointercancel', end);
}

// Corner-drag resize (layout mode): grabbing any corner and dragging OUT enlarges the photo,
// dragging IN shrinks it. Uniform scale about the centre, so pins scale with the image and
// keep their positions. This complements the two-finger pinch.
function enableCornerResize(entry) {
  const block = entry.block;
  // Half-diagonal of the natural image = distance from centre to a corner at scale 1.
  const handles = block.querySelectorAll('.page-resize-handle');
  handles.forEach(handle => {
    let active = false, baseScale = 1, halfDiag = 1;
    handle.addEventListener('pointerdown', (e) => {
      if (!lvState.layoutMode) return;
      e.stopPropagation(); e.preventDefault();
      active = true;
      baseScale = pageScale(entry.page);
      halfDiag = Math.hypot(entry.w, entry.h) / 2 || 1;
      try { handle.setPointerCapture(e.pointerId); } catch (err) {}
      block.classList.add('page-dragging');
    });
    handle.addEventListener('pointermove', (e) => {
      if (!active) return;
      e.stopPropagation();
      // Distance from the page centre to the pointer, in canvas units → new scale.
      const p = entry.page;
      const cx = (p.offsetX || 0) + entry.w / 2, cy = (p.offsetY || 0) + entry.h / 2;
      const { x, y } = screenToCanvas(e.clientX, e.clientY);
      const dist = Math.hypot(x - cx, y - cy);
      let s = dist / halfDiag;
      s = Math.max(0.2, Math.min(6, s));
      entry.page.scale = Math.round(s * 1000) / 1000;
      applyPageTransform(entry);
    });
    const end = async (e) => {
      if (!active) return;
      e.stopPropagation();
      active = false;
      block.classList.remove('page-dragging');
      recomputeCanvasSize();
      await persistAllPages();
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  });
}

// Layout-mode page menu: crop, bring-to-front, send-to-back, reset transform, delete.
// Rotation & resize are done directly on the photo with a two-finger gesture (no menu item),
// so any angle is possible — the old fixed "Rotate 90°" item has been removed.
function openPageMenu(entry) {
  const overlay = el('div', { class: 'modal-overlay centered' });
  const item = (label, cls, fn) => el('button', { class: 'btn ' + (cls || 'secondary') + ' menu-item', onclick: fn }, [label]);

  async function resetTransform() {
    overlay.remove();
    entry.page.rotation = 0;
    entry.page.scale = 1;
    applyPageTransform(entry);
    recomputeCanvasSize();
    await persistAllPages();
    render();
  }
  async function bringFront() {
    overlay.remove();
    const maxOrder = Math.max(0, ...lvState.pages.map(p => p.page.order || 0));
    entry.page.order = maxOrder + 1;
    await DB.updatePage(entry.page);
    render();
  }
  async function sendBack() {
    overlay.remove();
    const minOrder = Math.min(0, ...lvState.pages.map(p => p.page.order || 0));
    entry.page.order = minOrder - 1;
    await DB.updatePage(entry.page);
    render();
  }
  async function del() {
    overlay.remove();
    if (lvState.pages.length <= 1) { showToast('A location needs at least one photo'); return; }
    if (!confirm('Delete this photo and all hotspots on it?')) return;
    await DB.deletePage(entry.page.id);
    render();
  }
  function crop() {
    overlay.remove();
    openCropModal(entry.page.photo, async (blob) => {
      const spinner = showSpinner('Applying crop…');
      try { entry.page.photo = blob; await DB.updatePage(entry.page); }
      finally { spinner.remove(); }
      render();
    });
  }

  overlay.appendChild(el('div', { class: 'modal-sheet' }, [
    el('h2', {}, ['Photo']),
    el('div', { class: 'section-title', style: 'padding-left:0;padding-top:0;' }, ['Tip: use two fingers on the photo to rotate to any angle and resize.']),
    item('✂  Crop', 'secondary', crop),
    item('⬆  Bring to front', 'secondary', bringFront),
    item('⬇  Send to back', 'secondary', sendBack),
    item('⟲  Reset rotation & size', 'secondary', resetTransform),
    item('🗑  Delete photo', 'danger', del),
    el('div', { class: 'btn-row', style: 'margin-top:12px;' }, [
      el('button', { class: 'btn secondary', onclick: () => overlay.remove() }, ['Cancel'])
    ])
  ]));
  showOverlay(overlay);
}

// Add another photo (page) to this location.
async function addPageFlow(loc) {
  const files = await pickImageWithChoice({ multiple: true });
  if (!files.length) return;
  // Instant add: store each original file straight away and render, then compress each in the
  // background and swap the stored blob in place. No blocking spinner.
  try {
    const existing = await DB.getPagesForLocation(loc.id);
    // Place each new page to the right of the current canvas so nothing overlaps initially.
    let placeX = 0;
    for (const e of lvState.pages) placeX = Math.max(placeX, (e.page.offsetX || 0) + e.w + 40);
    let order = existing.length;
    for (const file of files) {
      const px = placeX;
      await addPhotoInstant(file, {
        save: (blob) => DB.addPage({ locationId: loc.id, photo: blob, offsetX: px, offsetY: 0, order: order++ }),
        replace: (rec, small) => { rec.photo = small; return DB.updatePage(rec); },
        maxDim: 1600, quality: 0.82
      });
      placeX += 40; // stagger; real position set in layout mode
    }
    if (!loc.coverPhoto) {
      // Cover: store the original now, compress in the background.
      loc.coverPhoto = files[0];
      await DB.updateLocation(loc);
      compressInBackground(files[0], loc, (l, small) => { l.coverPhoto = small; return DB.updateLocation(l); }, 1600, 0.82);
    }
  } catch (err) {
    console.error('Add page failed', err);
    showToast('Could not add photo');
  }
  render();
}

// Canvas model: the stage has its top-left at (0,0) and size canvasW×canvasH. The transform
// is translate(tx,ty) scale(s) with transform-origin 0 0, so a canvas point (px,py) maps to
// screen (tx + px*s, ty + py*s). fit centres the whole canvas in the viewer.
function fitCanvasToScreen() {
  const viewer = lvState.viewer, cw = lvState.canvasW, ch = lvState.canvasH;
  const vw = viewer.clientWidth, vh = viewer.clientHeight;
  const scale = Math.min(vw / cw, vh / ch, 1) || 1;
  lvState.scale = scale;
  lvState.baseScale = scale;
  lvState.tx = (vw - cw * scale) / 2;
  lvState.ty = (vh - ch * scale) / 2;
}

function applyTransform(stage) {
  // translateZ(0) keeps the stage on its own GPU layer so the whole canvas stays painted
  // while panning/zooming — fixes black patches that previously only cleared after a scroll.
  stage.style.transform = `translate3d(${lvState.tx}px, ${lvState.ty}px, 0) scale(${lvState.scale})`;
  // Remember the current zoom/pan so an in-place re-render restores it instead of refitting.
  if (lvState.loc) lvViewport = { locationId: lvState.loc.id, scale: lvState.scale, tx: lvState.tx, ty: lvState.ty };
}

function resetZoom() {
  fitCanvasToScreen();
  lvState.stage.classList.add('animate');
  applyTransform(lvState.stage);
  setTimeout(() => lvState.stage.classList.remove('animate'), 300);
}

function setupZoomPan(viewer, stage, img, onChange, onTap) {
  let pointers = new Map();
  let lastDist = 0, lastMid = null;
  let dragging = false;
  let dragStart = null;
  let moved = false;

  function midpoint(pts) {
    const arr = Array.from(pts.values());
    return { x: (arr[0].x + arr[1].x) / 2, y: (arr[0].y + arr[1].y) / 2 };
  }
  function dist(pts) {
    const arr = Array.from(pts.values());
    return Math.hypot(arr[0].x - arr[1].x, arr[0].y - arr[1].y);
  }

  viewer.addEventListener('pointerdown', (e) => {
    // #7: taps that start on an overlaid control (Add/Relocate/Layout toolbar, the relocate
    // D-pad, hint banner) belong to that control — never to the canvas. Ignore them here so
    // toggling Add box OFF can't also register as a tap that creates a hotspot underneath.
    if (e.target.closest('.location-toolbar, .nudge-pad-circle, .add-hint')) return;
    viewer.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    stage.classList.add('zooming'); // hint the compositor during the gesture
    moved = false;
    if (pointers.size === 1) {
      dragging = true;
      dragStart = { x: e.clientX, y: e.clientY, tx: lvState.tx, ty: lvState.ty };
    } else if (pointers.size === 2) {
      dragging = false;
      lastDist = dist(pointers);
      lastMid = midpoint(pointers);
    }
  });

  viewer.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 1 && dragging) {
      const dx = e.clientX - dragStart.x;
      const dy = e.clientY - dragStart.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
      lvState.tx = dragStart.tx + dx;
      lvState.ty = dragStart.ty + dy;
      applyTransform(stage);
    } else if (pointers.size === 2) {
      moved = true;
      const newDist = dist(pointers);
      const newMid = midpoint(pointers);
      const rect = viewer.getBoundingClientRect();
      // Focal point in viewer coords (screen), before applying this frame's changes.
      const fx = newMid.x - rect.left, fy = newMid.y - rect.top;
      if (lastDist > 0) {
        const factor = newDist / lastDist;
        const target = Math.min(Math.max(lvState.scale * factor, lvState.baseScale * 0.5), lvState.baseScale * 8);
        const ratio = target / lvState.scale;
        // Keep the pinch midpoint anchored to the same canvas point while scaling.
        lvState.tx = fx - (fx - lvState.tx) * ratio;
        lvState.ty = fy - (fy - lvState.ty) * ratio;
        lvState.scale = target;
      }
      // Two-finger pan (midpoint drift).
      lvState.tx += newMid.x - lastMid.x;
      lvState.ty += newMid.y - lastMid.y;
      lastDist = newDist;
      lastMid = newMid;
      applyTransform(stage);
    }
  });

  function endPointer(e) {
    const wasSingle = pointers.size === 1;
    const upPos = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    if (pointers.size === 0) {
      if (wasSingle && !moved && dragging && upPos) {
        const targetEl = document.elementFromPoint(upPos.x, upPos.y);
        const pinEl = targetEl && targetEl.closest('.pin');
        if (pinEl) { dragging = false; return; } // pin has its own tap handler
        // Multi-page: hand the raw screen point to onTap, which resolves which page/image
        // was hit and the fractional position within it.
        onTap(upPos.x, upPos.y, targetEl);
      }
      dragging = false;
      stage.classList.remove('zooming');
    }
  }
  viewer.addEventListener('pointerup', endPointer);
  viewer.addEventListener('pointercancel', endPointer);

  // Desktop wheel zoom — keep the point under the cursor fixed. With transform-origin 0,0
  // and screen = tx + canvas*scale, holding a screen point p fixed gives:
  //   tx' = p - (p - tx) * (newScale/scale)
  viewer.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = viewer.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.12 : 0.89;
    const newScale = Math.min(Math.max(lvState.scale * factor, lvState.baseScale * 0.5), lvState.baseScale * 8);
    const ratio = newScale / lvState.scale;
    lvState.tx = px - (px - lvState.tx) * ratio;
    lvState.ty = py - (py - lvState.ty) * ratio;
    lvState.scale = newScale;
    applyTransform(stage);
  }, { passive: false });

  // Desktop click-to-create (mouse users without touch)
  viewer.addEventListener('click', (e) => {
    if (moved) return;
  });
}

let pendingLocate = null; // {locationId, hotspotId, pulse} — set before navigating to a location (#7/#9)

// Render pins for one page into its own pin layer.
async function loadPagePins(loc, entry) {
  entry.pinLayer.innerHTML = '';
  const hotspots = await DB.getHotspotsForPage(entry.page.id);
  hotspots.forEach(h => renderPin(h, entry));
  if (pendingLocate && pendingLocate.locationId === loc.id) {
    const { hotspotId, pulse } = pendingLocate;
    // Only clear+highlight once we've found the pin on some page.
    if (entry.pinLayer.querySelector(`.pin[data-hotspot-id="${hotspotId}"]`)) {
      pendingLocate = null;
      setTimeout(() => highlightPin(hotspotId, pulse), 80);
    }
  }
}

// Find the page-entry + pin element for a hotspot id across all pages.
function findPin(hotspotId) {
  for (const entry of lvState.pages) {
    const pin = entry.pinLayer.querySelector(`.pin[data-hotspot-id="${hotspotId}"]`);
    if (pin) return { entry, pin };
  }
  return null;
}

// Canvas coords (px,py) of a hotspot. The pin sits at (h.x%, h.y%) of the natural image; we
// map that through the page's centre-based scale+rotation so Locate/centre targets the
// marker's ACTUAL on-screen position even when the photo is rotated/resized.
function pinCanvasPos(entry, h) {
  const p = entry.page, w = entry.w, h2 = entry.h;
  const cx = (p.offsetX || 0) + w / 2, cy = (p.offsetY || 0) + h2 / 2;
  const s = pageScale(p), rad = pageRot(p) * Math.PI / 180;
  const dx = ((h.x / 100) - 0.5) * w * s, dy = ((h.y / 100) - 0.5) * h2 * s;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  return { px: cx + dx * cos - dy * sin, py: cy + dx * sin + dy * cos };
}

// Pan (and optionally zoom) so the given hotspot sits at the centre of the viewer.
// yBias (0..1) shifts the target UP from centre — used by relocate so the marker sits
// above the D-pad at the bottom, with a clear gap between them.
function centerOnPin(hotspotId, zoomScale, yBias) {
  const found = findPin(hotspotId);
  if (!found) return;
  const h = { x: parseFloat(found.pin.style.left), y: parseFloat(found.pin.style.top) };
  const { px, py } = pinCanvasPos(found.entry, h);
  if (zoomScale) lvState.scale = zoomScale;
  const vw = lvState.viewer.clientWidth, vh = lvState.viewer.clientHeight;
  const targetY = vh * (yBias != null ? yBias : 0.5);
  lvState.tx = vw / 2 - px * lvState.scale;
  lvState.ty = targetY - py * lvState.scale;
  lvState.stage.classList.add('animate');
  applyTransform(lvState.stage);
  setTimeout(() => lvState.stage.classList.remove('animate'), 320);
}

// Highlight a pin: a static red ring (#7) or a pulsing "breathing" ring (#9 Locate).
// Always ZOOMS IN on the marker (never out) so it's clearly visible even on a big
// multi-photo canvas, and dims the rest of the canvas for ~3.5s (spotlight) so the user can
// instantly see WHERE the searched item is.
function highlightPin(hotspotId, pulse) {
  if (!lvState) return;
  const f = findPin(hotspotId);
  if (f) {
    const vw = lvState.viewer.clientWidth, vh = lvState.viewer.clientHeight;
    // Zoom so the marker's own page roughly fills the viewer, then a bit more — but never
    // LESS than the current fit scale, so Locate is always a zoom-IN, never a zoom-out.
    const pageFit = Math.min(vw / f.entry.w, vh / f.entry.h) || 1;
    const target = Math.max(pageFit * 1.6, (lvState.baseScale || 1) * 1.8);
    centerOnPin(hotspotId, target);
  } else {
    centerOnPin(hotspotId, (lvState.baseScale || 1) * 1.8);
  }
  const found = findPin(hotspotId);
  if (!found) return;
  lvState.pages.forEach(e => e.pinLayer.querySelectorAll('.pin-highlight, .pin-locate').forEach(p => p.classList.remove('pin-highlight', 'pin-locate')));
  found.pin.classList.add(pulse ? 'pin-locate' : 'pin-highlight');
  spotlightPin(found);
  if (!pulse) setTimeout(() => found.pin.classList.remove('pin-highlight'), 3500);
}

// Spotlight the located marker: dim every page image AND every OTHER pin for ~3.5s, leaving
// only the target marker bright, then fade everything back to normal. Purely visual — added
// via a class on the viewer plus a per-pin "spotlight-target" marker.
let spotlightTimer = null;
function spotlightPin(found) {
  if (!lvState || !lvState.viewer) return;
  if (spotlightTimer) { clearTimeout(spotlightTimer); spotlightTimer = null; }
  // Clear any stale target flag, then flag the current one.
  lvState.pages.forEach(e => e.pinLayer.querySelectorAll('.spotlight-target').forEach(p => p.classList.remove('spotlight-target')));
  found.pin.classList.add('spotlight-target');
  lvState.viewer.classList.add('spotlight');
  spotlightTimer = setTimeout(() => {
    lvState.viewer.classList.remove('spotlight');
    found.pin.classList.remove('spotlight-target');
    spotlightTimer = null;
  }, 3500);
}

function renderPin(h, entry) {
  const pinLayer = entry.pinLayer, img = entry.img;
  const isAnnotation = h.type === 'annotation';
  const pin = el('div', {
    class: 'pin' + (isAnnotation ? ' annotation' : ''),
    style: `left:${h.x}%; top:${h.y}%; position:absolute;`
  }, [
    el('div', { class: 'pin-dot' }, [isAnnotation ? '' : el('span', {}, [h.number ? h.number.slice(0, 3) : '•'])])
  ]);
  pin.dataset.hotspotId = h.id;
  // #15 adaptive colour: sample the image pixel under the marker and pick a contrasting
  // hue if the default (blue box / red annotation) would blend into the background.
  applyAdaptivePinColor(pin, h, entry);

  // Pins get their own independent tap detection so they always open reliably,
  // regardless of the viewer's pointer-capture-based pan/zoom/create-hotspot logic.
  let pinDownPos = null, pinDragging = false;
  pin.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    pinDownPos = { x: e.clientX, y: e.clientY };
    pinDragging = false;
    if (lvState && lvState.relocateMode) { try { pin.setPointerCapture(e.pointerId); } catch (err) {} }
  });
  pin.addEventListener('pointermove', (e) => {
    if (!pinDownPos || !lvState || !lvState.relocateMode) return;
    const dx = e.clientX - pinDownPos.x, dy = e.clientY - pinDownPos.y;
    if (!pinDragging && Math.hypot(dx, dy) < 6) return; // ignore micro-jitter
    pinDragging = true;
    hideNudgePad();
    // Move the pin live: convert the pointer position to a % of the (possibly rotated/scaled)
    // image so the marker follows the finger exactly at any zoom/rotation.
    const { x: cx, y: cy } = screenToCanvas(e.clientX, e.clientY);
    const frac = canvasPointToPageFraction(entry, cx, cy);
    // Outside the image bounds → clamp using the unclamped fraction so it stays grabbable.
    let nx, ny;
    if (frac) { nx = frac.relX * 100; ny = frac.relY * 100; }
    else {
      const raw = canvasPointToPageFractionUnclamped(entry, cx, cy);
      nx = raw.relX * 100; ny = raw.relY * 100;
    }
    nx = Math.max(0, Math.min(100, nx));
    ny = Math.max(0, Math.min(100, ny));
    h.x = nx; h.y = ny;
    pin.style.left = nx + '%';
    pin.style.top = ny + '%';
  });
  pin.addEventListener('pointerup', async (e) => {
    e.stopPropagation();
    const wasDrag = pinDragging;
    pinDragging = false;
    if (pinDownPos) {
      const dx = e.clientX - pinDownPos.x, dy = e.clientY - pinDownPos.y;
      const isTap = Math.hypot(dx, dy) < 8;
      if (lvState && lvState.relocateMode) {
        if (wasDrag) {
          await DB.updateHotspot(h); // persist the dragged position
          showToast('Position updated');
        } else if (isTap) {
          showNudgePad(h, pin, img); // tap in relocate mode → arrow pad
        }
      } else if (isTap) {
        // Add toggle ON => editable detail (Save/Delete/Add Photos).
        // Add toggle OFF => read-only view (Close only).
        if (lvState && lvState.addMode) openHotspotDetail(h.id);
        else openHotspotView(h.id);
      }
    }
    pinDownPos = null;
  });
  pin.addEventListener('click', (e) => e.stopPropagation());

  pinLayer.appendChild(pin);
}

// Jump to a hotspot's marker on the canvas and pulse a red locate ring around it — used by
// annotation link chips (#18) and search Locate. Works whether the target is on the current
// location (highlight directly) or a different one (navigate there first).
function locateHotspotOnCanvas(hotspotId, locationId) {
  if (lvState && lvState.loc && lvState.loc.id === locationId && findPin(hotspotId)) {
    highlightPin(hotspotId, true);
    return;
  }
  pendingLocate = { locationId, hotspotId, pulse: true };
  goLocation(locationId);
}

// Zoom in on a hotspot for relocation. The zoom level is based on the marker's OWN PAGE
// (not the whole multi-photo canvas) — otherwise, with several photos, the canvas fit-scale
// is tiny and the marker would appear zoomed OUT. We size so that page fills ~the viewer,
// then a touch more, and place the marker in the upper-middle (above the D-pad).
function zoomToPin(hotspotId) {
  const found = findPin(hotspotId);
  if (!found) { centerOnPin(hotspotId, (lvState.baseScale || 1) * 1.5, 0.36); return; }
  const vw = lvState.viewer.clientWidth, vh = lvState.viewer.clientHeight;
  const pageFit = Math.min(vw / found.entry.w, vh / found.entry.h) || 1; // scale to fit that page
  centerOnPin(hotspotId, pageFit * 1.4, 0.36);
}

// ---- Relocate: circular on-screen directional pad to nudge a marker ----
// - centred, always on-screen, larger buttons
// - no "Done": tapping anywhere outside the pad dismisses it
// - press-and-hold a direction to move continuously
let nudgePadEl = null;
let nudgeDismiss = null; // outside-tap listener, removed on hide
function hideNudgePad() {
  if (nudgeDismiss) { document.removeEventListener('pointerdown', nudgeDismiss, true); nudgeDismiss = null; }
  if (nudgePadEl) { nudgePadEl.remove(); nudgePadEl = null; }
}
function showNudgePad(h, pin, img) {
  hideNudgePad();
  zoomToPin(h.id); // #7: zoom ~150% and centre the marker being moved

  const STEP = 0.5; // percent of image dimension per step
  let saveTimer = null;
  function nudge(ddx, ddy) {
    h.x = Math.max(0, Math.min(100, h.x + ddx * STEP));
    h.y = Math.max(0, Math.min(100, h.y + ddy * STEP));
    pin.style.left = h.x + '%';
    pin.style.top = h.y + '%';
    // Debounce DB writes during continuous movement; flush shortly after the last step.
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => DB.updateHotspot(h), 250);
  }

  // A direction button: one tap = one step; press-and-hold = repeat until released.
  function dirBtn(label, ddx, ddy, cls) {
    const btn = el('button', { class: 'nudge-btn ' + cls }, [label]);
    let holdTimer = null, repeat = null, held = false;
    const start = (e) => {
      e.preventDefault(); e.stopPropagation();
      held = false;
      nudge(ddx, ddy); // immediate first step
      holdTimer = setTimeout(() => {
        held = true;
        repeat = setInterval(() => nudge(ddx, ddy), 70); // continuous while held
      }, 300);
    };
    const stop = (e) => {
      if (e) e.stopPropagation();
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      if (repeat) { clearInterval(repeat); repeat = null; }
    };
    btn.addEventListener('pointerdown', start);
    btn.addEventListener('pointerup', stop);
    btn.addEventListener('pointercancel', stop);
    btn.addEventListener('pointerleave', stop);
    return btn;
  }

  nudgePadEl = el('div', { class: 'nudge-pad-circle' }, [
    dirBtn('▲', 0, -1, 'up'),
    dirBtn('◀', -1, 0, 'left'),
    el('div', { class: 'nudge-hub' }, ['✛']),
    dirBtn('▶', 1, 0, 'right'),
    dirBtn('▼', 0, 1, 'down')
  ]);
  // Swallow taps that land on the pad itself so they don't reach the viewer or the
  // outside-dismiss handler.
  nudgePadEl.addEventListener('pointerdown', (e) => e.stopPropagation());
  (lvState.viewer || document.body).appendChild(nudgePadEl);

  // Tapping anywhere outside the pad dismisses it (no "Done" button). Capture phase so we
  // see the tap before the viewer's own pan/zoom logic.
  nudgeDismiss = (e) => {
    if (nudgePadEl && !nudgePadEl.contains(e.target)) hideNudgePad();
  };
  setTimeout(() => document.addEventListener('pointerdown', nudgeDismiss, true), 0);
}

// ---- #15 Adaptive marker colour ----
// Default colours: box hotspot = blue, annotation = red (both semi-transparent as before).
// If the diagram pixel UNDER the marker is close to the default colour's hue (so the marker
// would blend in), switch to a contrasting colour instead. We sample the pixel from a tiny
// offscreen canvas of the page image (cached per page).
const DEFAULT_BOX = [74, 158, 255];      // blue
const DEFAULT_ANNO = [229, 72, 72];      // red
function rgbToHue([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return -1; // grey → no hue
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60; if (h < 0) h += 360;
  return h;
}
function hueClose(h1, h2, tol = 40) {
  if (h1 < 0 || h2 < 0) return false;
  let d = Math.abs(h1 - h2) % 360; if (d > 180) d = 360 - d;
  return d <= tol;
}
function samplePixel(entry, xPct, yPct) {
  try {
    if (!entry.__sampleCanvas) {
      const c = document.createElement('canvas');
      const SW = 60, SH = Math.max(1, Math.round(60 * entry.h / entry.w));
      c.width = SW; c.height = SH;
      c.getContext('2d').drawImage(entry.img, 0, 0, SW, SH);
      entry.__sampleCanvas = c;
    }
    const c = entry.__sampleCanvas;
    const px = Math.min(c.width - 1, Math.max(0, Math.round(xPct / 100 * c.width)));
    const py = Math.min(c.height - 1, Math.max(0, Math.round(yPct / 100 * c.height)));
    const d = c.getContext('2d').getImageData(px, py, 1, 1).data;
    return [d[0], d[1], d[2]];
  } catch (e) { return null; } // cross-origin/tainted → skip adaptation
}
function applyAdaptivePinColor(pin, h, entry) {
  const dot = pin.querySelector('.pin-dot');
  if (!dot) return;
  const isAnno = h.type === 'annotation';
  const base = isAnno ? DEFAULT_ANNO : DEFAULT_BOX;
  const bg = samplePixel(entry, h.x, h.y);
  let color = base;
  if (bg && hueClose(rgbToHue(bg), rgbToHue(base))) {
    // Same hue family as the background → pick a contrasting hue. Red bg → green marker,
    // blue bg → orange marker, else fall back to a bright complementary.
    const bgHue = rgbToHue(bg);
    if (hueClose(bgHue, 0, 45) || hueClose(bgHue, 30, 30)) color = [60, 200, 90];   // red/orange bg → green
    else if (hueClose(bgHue, 220, 60)) color = [255, 165, 40];                       // blue/purple bg → orange
    else color = [255, 60, 200];                                                     // else magenta
  }
  const rgb = `${color[0]},${color[1]},${color[2]}`;
  if (isAnno) {
    dot.style.background = `rgba(${rgb},0.55)`;
  } else {
    dot.style.background = `rgb(${rgb})`;
  }
}

// ---- #16 Highlight all annotations (dim the diagram behind them) ----
function toggleAnnoHighlight() {
  lvState.highlightAnno = !lvState.highlightAnno;
  applyAnnoHighlight();
}
function applyAnnoHighlight() {
  if (!lvState || !lvState.viewer) return;
  lvState.viewer.classList.toggle('anno-highlight', !!lvState.highlightAnno);
}

async function handleTapCreate(loc, pageId, xPct, yPct, entry) {
  openHotspotForm({
    locationId: loc.id,
    pageId,
    x: xPct,
    y: yPct,
    type: lvState.markerType,
    onSaved: (h) => {
      renderPin(h, entry);
    }
  });
}

function toggleBrowse(loc) {
  openBrowseModal(loc);
}

// A small gallery grid of the photos whose captions matched a search query. Each cell shows
// the photo with its caption underneath; tapping opens the full-screen photo viewer at that
// photo. `allPhotos` is the hotspot's full photo list so the viewer can swipe through them.
function buildMatchedPhotoGrid(matchedPhotos, allPhotos, h) {
  const grid = el('div', { class: 'match-photo-grid' });
  for (const p of matchedPhotos) {
    const cell = el('div', {
      class: 'match-photo-cell',
      onclick: (e) => {
        e.stopPropagation(); // don't trigger the row's "locate marker" click
        const startIdx = Math.max(0, allPhotos.indexOf(p));
        openPhotoViewer(allPhotos, startIdx, h.id, null, { readOnly: true });
      }
    }, [
      el('img', { src: blobToUrl(p.photo), draggable: 'false' }),
      p.caption ? el('div', { class: 'match-photo-cap' }, [p.caption]) : null
    ]);
    grid.appendChild(cell);
  }
  return grid;
}

// #1: All-Hotspots list — aggregates hotspots across ALL pages of the location. An eye
// (expand) toggle reveals each item's photo captions inline; a search box filters by
// hotspot name/number AND by any photo caption. Tapping an item jumps to its marker.
async function openBrowseModal(loc) {
  const overlay = el('div', { class: 'modal-overlay centered' });
  const listWrap = el('div', { class: 'hotspot-list' });
  const hotspots = await DB.getHotspotsForLocation(loc.id);

  // Pre-load photos/captions once so search + expand are instant.
  const enriched = [];
  for (const h of hotspots) {
    const photos = await DB.getPhotosForHotspot(h.id);
    enriched.push({ h, photos, captions: photos.map(p => p.caption).filter(Boolean) });
  }

  let expanded = false;
  let query = '';

  function matches(rec) {
    if (!query) return true;
    const q = query.toLowerCase();
    if ((rec.h.name || '').toLowerCase().includes(q)) return true;
    if ((rec.h.number || '').toLowerCase().includes(q)) return true;
    if ((rec.h.description || '').toLowerCase().includes(q)) return true;
    return rec.captions.some(c => c.toLowerCase().includes(q));
  }

  function renderList() {
    listWrap.innerHTML = '';
    const shown = enriched.filter(matches);
    if (!shown.length) {
      listWrap.appendChild(el('div', { class: 'empty-state' }, [hotspots.length ? 'No matches.' : 'No hotspots yet for this location.']));
      return;
    }
    for (const rec of shown) {
      const { h, photos, captions } = rec;
      const thumb = el('div', { class: 'hlt-thumb' }, photos[0] ? [] : [h.type === 'annotation' ? '💬' : '📦']);
      if (photos[0]) thumb.style.backgroundImage = `url(${blobToUrl(photos[0].photo)})`;
      const children = [
        el('div', { class: 'name' }, [h.name || '(unnamed)']),
        el('div', { class: 'meta' }, [`${h.type === 'annotation' ? 'annotation' : '#' + (h.number || '—')} · ${photos.length} photo${photos.length === 1 ? '' : 's'}`])
      ];
      // Expanded: show item captions beneath the name.
      if (expanded && captions.length) {
        children.push(el('div', { class: 'hlt-captions' }, captions.map(c => el('div', { class: 'hlt-cap' }, ['• ' + c]))));
      }
      // If the query matched this item's PHOTO CAPTIONS, show those photos right here in a
      // gallery grid (photo + caption), so the user sees the actual matching photo, not just
      // the item name. Tapping a photo opens the full-screen viewer.
      const q = query.toLowerCase();
      const matchedPhotos = q ? photos.filter(p => (p.caption || '').toLowerCase().includes(q)) : [];
      if (matchedPhotos.length) {
        children.push(buildMatchedPhotoGrid(matchedPhotos, photos, h));
      }
      const item = el('div', {
        class: 'hotspot-list-item', onclick: () => { overlay.remove(); highlightPin(h.id, false); }
      }, [thumb, el('div', { class: 'hlt-text' }, children)]);
      listWrap.appendChild(item);
    }
  }

  const searchInput = el('input', { type: 'text', placeholder: 'Search name, number, or caption…' });
  searchInput.addEventListener('input', () => { query = searchInput.value.trim(); renderList(); });

  const eyeBtn = el('button', { class: 'icon-btn', title: 'Expand (show captions)' }, ['👁️']);
  eyeBtn.addEventListener('click', () => { expanded = !expanded; eyeBtn.classList.toggle('on', expanded); renderList(); });

  renderList();

  const sheet = el('div', { class: 'modal-sheet' }, [
    el('div', { class: 'view-header' }, [
      el('h2', { style: 'margin:0;' }, [`${loc.name} — All Hotspots`]),
      eyeBtn
    ]),
    el('div', { class: 'field' }, [searchInput]),
    listWrap,
    el('div', { class: 'btn-row', style: 'margin-top:12px;' }, [
      el('button', { class: 'btn secondary', onclick: () => overlay.remove() }, ['Close'])
    ])
  ]);
  overlay.appendChild(sheet);
  showOverlay(overlay);
  // Put the cursor straight in the search box (like the global Search screen does) so the
  // user can start typing immediately.
  setTimeout(() => searchInput.focus(), 50);
}

async function openEditLocationModal(loc) {
  const overlay = el('div', { class: 'modal-overlay centered' });
  const nameInput = el('input', { type: 'text', value: loc.name });
  const typeInput = el('select', {}, [
    el('option', { value: 'storeroom' }, ['Storeroom / Box Inventory']),
    el('option', { value: 'diagram' }, ['Diagram / Panel (Annotation Mode)'])
  ]);
  typeInput.value = loc.type || 'storeroom';

  const sheet = el('div', { class: 'modal-sheet' }, [
    el('h2', {}, ['Edit Location']),
    el('div', { class: 'field' }, [el('label', {}, ['Name']), nameInput]),
    el('div', { class: 'field' }, [el('label', {}, ['Type']), typeInput]),
    // #11: "Replace Cover Photo" intentionally removed — swapping the cover photo would
    // orphan every hotspot already placed on the old image.
    el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn secondary', onclick: () => overlay.remove() }, ['Cancel']),
      el('button', {
        class: 'btn danger', onclick: async () => {
          if (confirm(`Delete "${loc.name}"? You can restore it from Settings (⚙️) until you close the app.`)) {
            await deleteLocationWithUndo(loc);
            // Robustly close all open overlays and land cleanly on home.
            closeAllOverlays(resetToHome);
            showToast('Location deleted — restore from Settings');
          }
        }
      }, ['Delete Location']),
      el('button', {
        class: 'btn', onclick: async () => {
          loc.name = nameInput.value.trim() || loc.name;
          loc.type = typeInput.value;
          await DB.updateLocation(loc);
          overlay.remove();
          render();
        }
      }, ['Save'])
    ])
  ]);
  overlay.appendChild(sheet);
  showOverlay(overlay);
}
