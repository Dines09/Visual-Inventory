let lvState = null; // per-location-view transient state
// Modes persist across in-place re-renders (e.g. after a layout rotate/front/back) so a
// toggle the user turned ON stays ON until they turn it OFF. Reset when the location changes.
let lvModes = { locationId: null, addMode: false, relocateMode: false, layoutMode: false, pasteMode: false, sceneId: null };
// The zoom/pan the user has set persists across in-place re-renders (e.g. after saving a
// hotspot) so the canvas doesn't snap back to the fit-everything view. Reset per location.
let lvViewport = { locationId: null, scale: 0, tx: 0, ty: 0 };
// The 360° viewer survives in-place re-renders (no texture re-upload, no flicker, same view
// direction). views[pageId] remembers where the user was looking in each scene.
let panoCache = { pageId: null, viewer: null, views: {} };

function isPanoPage(p) { return !!p && p.kind === 'pano'; }

function destroyPanoCache() {
  if (panoCache.viewer) panoCache.viewer.destroy();
  panoCache.viewer = null;
  panoCache.pageId = null;
}

async function renderLocationView() {
  const seq = renderSeq;
  hideNudgePad(); // drop any stale relocate pad from a previous render
  const loc = await DB.getLocation(state.locationId);
  if (seq !== renderSeq) return;
  if (!loc) { destroyPanoCache(); goHome(); return; }

  if (lvModes.locationId !== loc.id) {
    lvModes = { locationId: loc.id, addMode: false, relocateMode: false, layoutMode: false, pasteMode: false, sceneId: null };
    panoCache.views = {};
    destroyPanoCache();
  }

  // Load pages (v3). Older data was migrated so there is always ≥1 page unless the
  // location was created with no photo yet. 360° scenes are pages with kind 'pano'.
  const pages = await DB.getPagesForLocation(loc.id);
  const hotspots = await DB.getHotspotsForLocation(loc.id);
  if (seq !== renderSeq) return;
  const panoPages = pages.filter(isPanoPage), flatPages = pages.filter(p => !isPanoPage(p));
  const scenes = panoPages.map((p, i) => ({ id: p.id, kind: 'pano', page: p, name: p.name || `Scene ${i + 1}` }));
  if (flatPages.length) scenes.push({ id: 'flat', kind: 'flat', name: panoPages.length ? 'Photos' : 'Photo' });

  // A pending Locate for this location opens the scene that holds the target.
  if (pendingLocate && pendingLocate.locationId === loc.id) {
    const target = hotspots.find(h => h.id === pendingLocate.hotspotId);
    if (target) {
      const s = scenes.find(sc => sc.kind === 'pano' ? sc.id === target.pageId : !panoPages.some(p => p.id === target.pageId));
      if (s) lvModes.sceneId = s.id;
    }
  }
  const scene = scenes.find(s => s.id === lvModes.sceneId) || scenes[0] || null;
  lvModes.sceneId = scene ? scene.id : null;
  if (!scene || scene.kind !== 'pano' || panoCache.pageId !== scene.id) destroyPanoCache();
  if (lvModes.layoutMode && (!scene || scene.kind !== 'flat')) lvModes.layoutMode = false;
  if (lvModes.pasteMode && !getClipboard()) lvModes.pasteMode = false;

  lvState = {
    scale: 1, tx: 0, ty: 0,
    canvasW: 0, canvasH: 0,          // total canvas size (bounding box of all pages)
    markerType: loc.type === 'diagram' ? 'annotation' : 'box',
    addMode: lvModes.addMode,
    relocateMode: lvModes.relocateMode,
    layoutMode: lvModes.layoutMode,  // when ON, drag whole pages to reposition them
    pasteMode: lvModes.pasteMode,    // when ON, the next tap places the copied hotspot
    highlightAnno: false,            // #16 highlight-all-annotations dim mode
    pages: [],                       // [{ page, block, img, pinLayer, w, h }] or one pano entry
    mode: scene ? scene.kind : null, // 'pano' | 'flat'
    scene, loc
  };

  const isAnno = lvState.markerType === 'annotation';
  const itemWord = isAnno ? 'annotation' : 'box';
  const count = hotspots.length;

  const topbar = el('header', { class: 'topbar glass-bar floating' }, [
    el('button', { class: 'icon-btn round', title: 'Back', onclick: () => history.back() }, [icon('back')]),
    el('div', { class: 'tb-title' }, [
      el('h1', {}, [loc.name]),
      el('div', { class: 'tb-sub' }, [`${count} ${itemWord}${count === 1 ? '' : (isAnno ? 's' : 'es')}` + (scene && scene.kind === 'pano' ? ' · 360°' : '')])
    ]),
    // #16: annotation-only — highlight all annotations (dim the diagram behind them).
    isAnno ? el('button', { class: 'icon-btn round', title: 'Highlight annotations', onclick: () => toggleAnnoHighlight() }, [icon('bulb')]) : null,
    el('button', { class: 'icon-btn round', title: 'Search in this location', onclick: () => toggleBrowse(loc) }, [icon('search')]),
    el('button', { class: 'icon-btn round', title: 'Export Excel', onclick: () => exportLocationExcel(loc) }, [icon('sheet')]),
    el('button', { class: 'icon-btn round', title: 'Edit location', onclick: () => openEditLocationModal(loc) }, [icon('edit')])
  ]);
  root.appendChild(topbar);

  const viewWrap = el('div', { class: 'view location-wrap' });
  root.appendChild(viewWrap);

  if (!scene) {
    viewWrap.appendChild(el('div', { class: 'no-photo-placeholder' }, [
      el('div', { class: 'empty-art' }, [icon('orbit', 40)]),
      el('div', { class: 'empty-title' }, ['No photo of this location yet']),
      el('div', { class: 'empty-text' }, ['Capture it as a 360° photo to see the whole room at once, or add a regular photo.']),
      el('div', { class: 'stack-btns' }, [
        el('button', { class: 'btn', onclick: () => addPanoScene(loc, 'capture') }, [icon('orbit', 20), 'Capture 360°']),
        el('button', { class: 'btn secondary', onclick: () => addPanoScene(loc, 'import') }, [icon('upload', 20), 'Import 360° photo']),
        el('button', { class: 'btn secondary', onclick: () => addPageFlow(loc) }, [icon('image', 20), 'Add regular photo'])
      ])
    ]));
    return;
  }

  const viewer = el('div', { class: 'location-viewer' + (scene.kind === 'pano' ? ' is-pano' : '') });
  viewWrap.appendChild(viewer);
  lvState.viewer = viewer;

  // Scene switcher — shown whenever the location has a 360° scene.
  if (panoPages.length) {
    const bar = el('div', { class: 'scene-bar' });
    scenes.forEach(s => {
      const on = s.id === scene.id;
      bar.appendChild(el('button', {
        class: 'scene-chip' + (on ? ' on' : ''),
        onclick: () => {
          if (on) { if (s.kind === 'pano') openSceneMenu(loc, s.page); return; }
          lvModes.sceneId = s.id;
          lvModes.layoutMode = false;
          render();
        }
      }, [icon(s.kind === 'pano' ? 'pano' : 'images', 15), el('span', {}, [s.name]), on && s.kind === 'pano' ? icon('chevronDown', 14) : null]));
    });
    bar.appendChild(el('button', { class: 'scene-chip add', title: 'Add a scene or photo', onclick: () => openAddMediaSheet(loc) }, [icon('plus', 16)]));
    viewer.appendChild(bar);
  }

  if (scene.kind === 'pano') await renderPanoScene(loc, scene.page, viewer);
  else await renderFlatScene(loc, flatPages, viewer);
  if (seq !== renderSeq) return;

  // Mode hint banner (what a tap will do right now) with a Done button.
  const hintText = el('span', { class: 'mh-text' });
  const hint = el('div', { class: 'mode-hint glass' }, [
    el('span', { class: 'mh-dot' }), hintText,
    el('button', { class: 'mh-done', onclick: () => setMode(null) }, ['Done'])
  ]);
  viewer.appendChild(hint);
  lvState.hint = hint;

  // ---- Floating dock ----
  const clip = getClipboard();
  const dockBtn = (key, ic, label, onclick) => el('button', { class: 'dock-btn', 'data-key': key, title: label, onclick }, [
    el('span', { class: 'dock-ico' }, [icon(ic, 22)]), el('span', { class: 'dock-label' }, [label])
  ]);
  const btns = [
    dockBtn('add', isAnno ? 'dot' : 'pinAdd', isAnno ? 'Add dot' : 'Add box', () => setMode('add')),
    dockBtn('relocate', 'move', 'Move', () => setMode('relocate'))
  ];
  if (scene.kind === 'flat') btns.push(dockBtn('layout', 'layout', 'Arrange', () => setMode('layout')));
  if (scene.kind === 'pano' && PanoViewer.gyroAvailable()) {
    btns.push(dockBtn('look', 'compass', 'Look', async () => {
      const pv = lvState.pano;
      if (!pv) return;
      const ok = await pv.setGyro(!pv.gyro);
      if (!ok && !pv.gyro && lvState.pano === pv) { /* turned off, or permission refused */ }
      refreshModes();
      if (pv.gyro) showToast('Move your phone to look around');
    }));
  }
  if (clip) {
    const b = dockBtn('paste', 'paste', 'Paste', () => setMode('paste'));
    b.classList.add('has-clip');
    btns.push(b);
  }
  btns.push(dockBtn('media', 'plus', scene.kind === 'pano' ? 'Scene' : 'Photo', () => openAddMediaSheet(loc)));
  const dock = el('nav', { class: 'dock glass' }, btns);
  viewer.appendChild(dock);
  lvState.dock = dock;

  function hintFor() {
    if (lvState.layoutMode) return 'Drag photos to arrange · two fingers rotate & resize';
    if (lvState.relocateMode) return 'Drag a marker, or tap it for fine arrows';
    if (lvState.pasteMode) { const c = getClipboard(); return `Tap where “${clipLabel(c)}” should go`; }
    if (lvState.addMode) return scene.kind === 'pano' ? `Tap anywhere in the 360° view to add a ${itemWord}` : (isAnno ? 'Tap the image to add a dot' : 'Tap the photo to add a box');
    return '';
  }
  function refreshModes() {
    const active = lvState.addMode ? 'add' : lvState.relocateMode ? 'relocate' : lvState.layoutMode ? 'layout' : lvState.pasteMode ? 'paste' : null;
    dock.querySelectorAll('.dock-btn').forEach(b => {
      const k = b.dataset.key;
      b.classList.toggle('on', k === active || (k === 'look' && !!(lvState.pano && lvState.pano.gyro)));
    });
    viewer.classList.toggle('add-mode', lvState.addMode || lvState.pasteMode);
    viewer.classList.toggle('relocate-mode', lvState.relocateMode);
    viewer.classList.toggle('layout-mode', lvState.layoutMode);
    const t = hintFor();
    hintText.textContent = t;
    hint.classList.toggle('show', !!t);
    // Persist the current modes so an in-place render() (e.g. after a layout rotate) keeps
    // whatever the user had toggled on.
    lvModes.addMode = lvState.addMode;
    lvModes.relocateMode = lvState.relocateMode;
    lvModes.layoutMode = lvState.layoutMode;
    lvModes.pasteMode = lvState.pasteMode;
  }
  lvState.refreshToggle = refreshModes;
  refreshModes();
}

// Switch the one active editing mode ('add' | 'relocate' | 'layout' | 'paste'); tapping the
// active one again (or null) turns everything off.
function setMode(name) {
  if (!lvState) return;
  const on = name && !lvState[name + 'Mode'];
  lvState.addMode = lvState.relocateMode = lvState.layoutMode = lvState.pasteMode = false;
  if (on) lvState[name + 'Mode'] = true;
  hideNudgePad();
  if (lvState.refreshToggle) lvState.refreshToggle();
}

// ============================================================ 360° scene
async function renderPanoScene(loc, page, viewer) {
  const seq = renderSeq;
  const meta = page.pano || {};
  let pv = panoCache.viewer && panoCache.pageId === page.id && !panoCache.viewer.destroyed ? panoCache.viewer : null;
  if (!pv) {
    destroyPanoCache();
    const saved = panoCache.views[page.id];
    pv = new PanoViewer({
      start: saved || { yaw: meta.startYaw || 0, pitch: meta.startPitch || 0, fov: meta.startFov || undefined },
      limits: meta.limits || null
    });
    panoCache.viewer = pv; panoCache.pageId = page.id;
    pv.load(page.photo).catch(err => console.error('360 load failed', err));
    maybeShowPanoCoach(viewer);
  }
  pv.opts.isTapMode = () => !!(lvState && (lvState.addMode || lvState.pasteMode));
  pv.opts.onViewChange = (v) => { panoCache.views[page.id] = v; };
  viewer.appendChild(pv.el);
  pv._resize();

  const entry = makePanoEntry(page, pv);
  lvState.pages = [entry];
  lvState.pano = pv;
  pv.opts.onTap = (lon, lat) => {
    if (!lvState || lvState.relocateMode || lvState.layoutMode) return;
    const p = PanoMath.pctFromLonLat(lon, lat);
    if (lvState.pasteMode) { handlePasteAt(loc, page.id, p.x, p.y); return; }
    if (lvState.addMode) handleTapCreate(loc, page.id, p.x, p.y, entry);
  };
  pv.opts.onLoad = () => {
    entry.__sampleCanvas = pv.sampleCanvas;
    pv.pins.forEach(p => { if (p.el.__h) applyAdaptivePinColor(p.el, p.el.__h, entry); });
  };
  if (pv.sampleCanvas) entry.__sampleCanvas = pv.sampleCanvas;
  await loadPagePins(loc, entry);
  if (seq !== renderSeq) return;
}

function makePanoEntry(page, pv) {
  return {
    kind: 'pano', page, viewer: pv, pinLayer: pv.pinLayer, w: 0, h: 0,
    place(pin, h) {
      const ll = PanoMath.lonLatFromPct(h.x, h.y);
      if (pin.__panoAdded) pv.movePin(pin, ll.lon, ll.lat);
      else { pv.addPin(pin, ll.lon, ll.lat); pin.__panoAdded = true; }
    },
    fromScreen(clientX, clientY) {
      const ll = pv.lonLatAtClient(clientX, clientY);
      return PanoMath.pctFromLonLat(ll.lon, ll.lat);
    }
  };
}

function maybeShowPanoCoach(viewer) {
  let n = 0;
  try { n = +(localStorage.getItem('vi-pano-coach') || 0); localStorage.setItem('vi-pano-coach', String(n + 1)); } catch (e) {}
  if (n >= 3) return;
  const coach = el('div', { class: 'pano-coach glass' }, [icon('orbit', 22), el('span', {}, ['Drag to look around · pinch to zoom'])]);
  viewer.appendChild(coach);
  setTimeout(() => coach.classList.add('out'), 2600);
  setTimeout(() => coach.remove(), 3200);
}

// Scene options for a 360° scene (tap the active scene chip).
function openSceneMenu(loc, page) {
  const overlay = el('div', { class: 'modal-overlay' });
  const pv = lvState && lvState.pano;
  overlay.appendChild(el('div', { class: 'modal-sheet' }, [
    el('div', { class: 'sheet-grabber' }),
    el('h2', {}, [page.name || '360° scene']),
    el('div', { class: 'menu-group' }, [
      menuItem('edit', 'Rename scene', async () => {
        const name = prompt('Scene name:', page.name || '');
        overlay.remove();
        if (name == null) return;
        page.name = name.trim() || page.name;
        await DB.updatePage(page);
        render();
      }),
      pv ? menuItem('target', 'Start here', async () => {
        overlay.remove();
        page.pano = Object.assign({}, page.pano, { startYaw: pv.yaw, startPitch: pv.pitch, startFov: pv.fov });
        await DB.updatePage(page);
        showToast('This view now opens first');
      }, { sub: 'Open this scene looking where you are looking now' }) : null,
      pv ? menuItem('image', 'Use this view as cover', async () => {
        overlay.remove();
        const sp = showSpinner('Updating cover…');
        try {
          const cover = await PanoStitch.renderPerspective(page.photo, { yaw: pv.yaw, pitch: pv.pitch, hfov: 90, width: 640, height: 480 });
          const fresh = await DB.getLocation(loc.id);
          fresh.coverPhoto = cover;
          await DB.updateLocation(fresh);
          showToast('Cover updated');
        } catch (e) { showToast('Could not update the cover'); } finally { sp.remove(); }
      }, { sub: 'Shown on the home screen tile' }) : null,
      menuItem('trash', 'Delete scene', async () => {
        overlay.remove();
        const n = (await DB.getHotspotsForPage(page.id)).length;
        if (!confirm(`Delete this 360° scene${n ? ` and the ${n} marker${n === 1 ? '' : 's'} on it` : ''}?`)) return;
        await DB.deletePage(page.id);
        await syncPanoCount(loc.id);
        lvModes.sceneId = null;
        destroyPanoCache();
        render();
        showToast('Scene deleted');
      }, { danger: true })
    ].filter(Boolean)),
    el('div', { class: 'btn-row' }, [el('button', { class: 'btn secondary', onclick: () => overlay.remove() }, ['Close'])])
  ]));
  showOverlay(overlay);
}

async function syncPanoCount(locationId) {
  const loc = await DB.getLocation(locationId);
  if (!loc) return;
  loc.panoCount = (await DB.getPagesForLocation(locationId)).filter(isPanoPage).length;
  await DB.updateLocation(loc);
}

// "Add" sheet: new 360° scene (capture / import) or regular photo(s).
function openAddMediaSheet(loc) {
  const overlay = el('div', { class: 'modal-overlay' });
  overlay.appendChild(el('div', { class: 'modal-sheet' }, [
    el('div', { class: 'sheet-grabber' }),
    el('h2', {}, ['Add to this location']),
    el('div', { class: 'menu-group' }, [
      menuItem('orbit', 'Capture 360° scene', () => { overlay.remove(); addPanoScene(loc, 'capture'); }, { sub: 'Turn on the spot — photos are taken automatically' }),
      menuItem('pano', 'Import 360° photo', () => { overlay.remove(); addPanoScene(loc, 'import'); }, { sub: 'From a 360° camera, Photo Sphere or phone panorama' }),
      menuItem('images', 'Regular photo(s)', () => { overlay.remove(); addPageFlow(loc); }, { sub: 'Add to the flat photo layout' })
    ]),
    el('div', { class: 'btn-row' }, [el('button', { class: 'btn secondary', onclick: () => overlay.remove() }, ['Cancel'])])
  ]));
  showOverlay(overlay);
}

async function addPanoScene(loc, mode) {
  const res = await obtainPanorama(mode);
  if (!res) return;
  if (res.flat) {
    showToast('That photo isn\'t a panorama — added as a regular photo');
    await addFlatFiles(loc, [res.file]);
    lvModes.sceneId = 'flat';
    render();
    return;
  }
  try {
    const pages = await DB.getPagesForLocation(loc.id);
    const n = pages.filter(isPanoPage).length;
    const page = await DB.addPage({ locationId: loc.id, kind: 'pano', photo: res.blob, pano: res.meta, name: `Scene ${n + 1}`, order: pages.length });
    const fresh = await DB.getLocation(loc.id);
    fresh.panoCount = n + 1;
    if (!fresh.coverPhoto || !n) {
      try { fresh.coverPhoto = await PanoStitch.renderPerspective(res.blob, { yaw: res.meta.startYaw || 0, hfov: 90, width: 640, height: 480 }); } catch (e) {}
    }
    await DB.updateLocation(fresh);
    lvModes.sceneId = page.id;
    render();
    showToast('360° scene added');
  } catch (err) {
    console.error('Save 360 failed', err);
    showToast('Could not save the 360° photo — storage may be full');
  }
}

// ============================================================ flat photo layout
async function renderFlatScene(loc, pages, viewer) {
  const stage = el('div', { class: 'stage stage-multi' });
  viewer.appendChild(stage);
  lvState.stage = stage;
  lvState.mode = 'flat';

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
    if (targetEl && targetEl.closest('.pin, .dock, .nudge-pad-circle, .mode-hint, .scene-bar')) return;
    if (lvState.layoutMode) return;              // layout mode drags pages, never creates
    if (!lvState.addMode && !lvState.pasteMode) return;
    const hit = pageAtPoint(clientX, clientY);
    if (!hit) return;
    if (lvState.pasteMode) { handlePasteAt(loc, hit.page.id, hit.relX * 100, hit.relY * 100); return; }
    handleTapCreate(loc, hit.page.id, hit.relX * 100, hit.relY * 100, hit.entry);
  });
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
    const entry = {
      kind: 'flat', page, block, img, pinLayer, w: 0, h: 0,
      place(pin, h) {
        if (pin.parentNode !== pinLayer) pinLayer.appendChild(pin);
        pin.style.left = h.x + '%'; pin.style.top = h.y + '%';
      },
      // Pointer position → % of the (possibly rotated/scaled) image, clamped to the image so
      // a dragged marker stays grabbable even if the finger strays just outside it.
      fromScreen(clientX, clientY) {
        const { x: cx, y: cy } = screenToCanvas(clientX, clientY);
        const raw = canvasPointToPageFractionUnclamped(entry, cx, cy);
        return { x: Math.max(0, Math.min(100, raw.relX * 100)), y: Math.max(0, Math.min(100, raw.relY * 100)) };
      }
    };
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
    if (e.kind !== 'flat') continue;
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
  entry.block.style.setProperty('--page-s', s);
  entry.block.style.setProperty('--page-r', deg + 'deg');
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
  const f = canvasPointToPageFractionUnclamped(entry, cx, cy);
  if (f.relX < 0 || f.relX > 1 || f.relY < 0 || f.relY > 1) return null;
  return f;
}
// Same as above but never returns null — used while dragging a marker so it stays grabbable
// even if the finger strays just outside the image; the caller clamps to 0..1.
function canvasPointToPageFractionUnclamped(entry, cx, cy) {
  const p = entry.page, w = entry.w, h = entry.h;
  const centerX = (p.offsetX || 0) + w / 2, centerY = (p.offsetY || 0) + h / 2;
  const s = pageScale(p), rad = pageRot(p) * Math.PI / 180;
  // Translate to centre, inverse-rotate, inverse-scale.
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
  const handles = block.querySelectorAll('.page-resize-handle');
  handles.forEach(handle => {
    let active = false, halfDiag = 1;
    handle.addEventListener('pointerdown', (e) => {
      if (!lvState.layoutMode) return;
      e.stopPropagation(); e.preventDefault();
      active = true;
      // Half-diagonal of the natural image = distance from centre to a corner at scale 1.
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
// so any angle is possible.
function openPageMenu(entry) {
  const overlay = el('div', { class: 'modal-overlay' });

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
    const all = await DB.getPagesForLocation(entry.page.locationId);
    if (all.length <= 1) { showToast('A location needs at least one photo'); return; }
    if (!confirm('Delete this photo and all hotspots on it?')) return;
    await DB.deletePage(entry.page.id);
    if (lvState.pages.length <= 1) lvModes.sceneId = null; // last flat photo gone → show a 360° scene
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
    el('div', { class: 'sheet-grabber' }),
    el('h2', {}, ['Photo']),
    el('p', { class: 'sheet-sub' }, ['Tip: use two fingers on the photo to rotate it to any angle and resize.']),
    el('div', { class: 'menu-group' }, [
      menuItem('crop', 'Crop', crop),
      menuItem('arrowUp', 'Bring to front', bringFront),
      menuItem('arrowDown', 'Send to back', sendBack),
      menuItem('restore', 'Reset rotation & size', resetTransform),
      menuItem('trash', 'Delete photo', del, { danger: true })
    ]),
    el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn secondary', onclick: () => overlay.remove() }, ['Cancel'])
    ])
  ]));
  showOverlay(overlay);
}

// Add another photo (page) to this location.
async function addPageFlow(loc) {
  const files = await pickImageWithChoice({ multiple: true });
  if (!files.length) return;
  await addFlatFiles(loc, files);
  lvModes.sceneId = 'flat';
  render();
}

// Store picked files as flat pages. Instant add: store each original file straight away and
// render, then compress each in the background and swap the stored blob in place.
async function addFlatFiles(loc, files) {
  try {
    const existing = await DB.getPagesForLocation(loc.id);
    // Place each new page to the right of the current canvas so nothing overlaps initially.
    let placeX = 0;
    if (lvState && lvState.mode === 'flat') {
      for (const e of lvState.pages) placeX = Math.max(placeX, (e.page.offsetX || 0) + e.w + 40);
    } else {
      for (const p of existing) if (!isPanoPage(p)) placeX = Math.max(placeX, (p.offsetX || 0) + 1700);
    }
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
    const fresh = await DB.getLocation(loc.id);
    if (fresh && !fresh.coverPhoto) {
      // Cover: store the original now, compress in the background.
      fresh.coverPhoto = files[0];
      await DB.updateLocation(fresh);
      compressInBackground(files[0], fresh, (l, small) => { l.coverPhoto = small; return DB.updateLocation(l); }, 1600, 0.82);
    }
  } catch (err) {
    console.error('Add page failed', err);
    showToast('Could not add photo');
  }
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
  stage.style.setProperty('--stage-s', lvState.scale);
  // Remember the current zoom/pan so an in-place re-render restores it instead of refitting.
  if (lvState.loc) lvViewport = { locationId: lvState.loc.id, scale: lvState.scale, tx: lvState.tx, ty: lvState.ty };
}

function resetZoom() {
  fitCanvasToScreen();
  lvState.stage.classList.add('animate');
  applyTransform(lvState.stage);
  setTimeout(() => lvState.stage.classList.remove('animate'), 300);
}

// Zoom the flat canvas to `target` scale keeping screen point (px, py) (viewer coords) fixed.
function zoomCanvasAt(target, px, py, animate) {
  const s = Math.min(Math.max(target, lvState.baseScale * 0.5), lvState.baseScale * 12);
  const ratio = s / lvState.scale;
  lvState.tx = px - (px - lvState.tx) * ratio;
  lvState.ty = py - (py - lvState.ty) * ratio;
  lvState.scale = s;
  if (animate) lvState.stage.classList.add('animate');
  applyTransform(lvState.stage);
  if (animate) setTimeout(() => lvState.stage.classList.remove('animate'), 300);
}

function setupZoomPan(viewer, stage, img, onChange, onTap) {
  let pointers = new Map();
  let lastDist = 0, lastMid = null;
  let dragging = false;
  let dragStart = null;
  let moved = false;
  let lastTap = null;

  function midpoint(pts) {
    const arr = Array.from(pts.values());
    return { x: (arr[0].x + arr[1].x) / 2, y: (arr[0].y + arr[1].y) / 2 };
  }
  function dist(pts) {
    const arr = Array.from(pts.values());
    return Math.hypot(arr[0].x - arr[1].x, arr[0].y - arr[1].y);
  }

  viewer.addEventListener('pointerdown', (e) => {
    // #7: taps that start on an overlaid control (dock, the relocate D-pad, hint banner,
    // scene chips) belong to that control — never to the canvas. Ignore them here so
    // toggling Add box OFF can't also register as a tap that creates a hotspot underneath.
    if (e.target.closest('.dock, .nudge-pad-circle, .mode-hint, .scene-bar')) return;
    viewer.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    stage.classList.add('zooming'); // hint the compositor during the gesture
    if (pointers.size === 1) {
      moved = false;
      dragging = true;
      dragStart = { x: e.clientX, y: e.clientY, tx: lvState.tx, ty: lvState.ty };
    } else if (pointers.size === 2) {
      moved = true;
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
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
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
        const target = Math.min(Math.max(lvState.scale * factor, lvState.baseScale * 0.5), lvState.baseScale * 12);
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
    if (pointers.size === 1) {
      // Lifted one of two fingers: keep panning with the remaining finger (used to freeze).
      const p = Array.from(pointers.values())[0];
      dragging = true;
      dragStart = { x: p.x, y: p.y, tx: lvState.tx, ty: lvState.ty };
      return;
    }
    if (pointers.size === 0) {
      if (wasSingle && !moved && dragging && upPos) {
        const targetEl = document.elementFromPoint(upPos.x, upPos.y);
        const pinEl = targetEl && targetEl.closest('.pin');
        if (!pinEl) {
          const tapMode = lvState && (lvState.addMode || lvState.pasteMode || lvState.layoutMode);
          if (tapMode) {
            // Multi-page: hand the raw screen point to onTap, which resolves which page/image
            // was hit and the fractional position within it.
            onTap(upPos.x, upPos.y, targetEl);
          } else {
            // Double-tap to zoom in on that spot (or back out to fit when already zoomed).
            const now = Date.now();
            if (lastTap && now - lastTap.t < 320 && Math.hypot(upPos.x - lastTap.x, upPos.y - lastTap.y) < 40) {
              const rect = viewer.getBoundingClientRect();
              if (lvState.scale > lvState.baseScale * 1.6) resetZoom();
              else zoomCanvasAt(lvState.scale * 2.5, upPos.x - rect.left, upPos.y - rect.top, true);
              lastTap = null;
            } else lastTap = { x: upPos.x, y: upPos.y, t: now };
          }
        }
      }
      dragging = false;
      stage.classList.remove('zooming');
    }
  }
  viewer.addEventListener('pointerup', endPointer);
  viewer.addEventListener('pointercancel', endPointer);

  // Desktop wheel zoom — keep the point under the cursor fixed.
  viewer.addEventListener('wheel', (e) => {
    if (e.target.closest('.dock, .scene-bar')) return;
    e.preventDefault();
    const rect = viewer.getBoundingClientRect();
    zoomCanvasAt(lvState.scale * (e.deltaY < 0 ? 1.12 : 0.89), e.clientX - rect.left, e.clientY - rect.top);
  }, { passive: false });
}

let pendingLocate = null; // {locationId, hotspotId, pulse, noMove} — set before navigating to a location (#7/#9)

// Render pins for one page (or the 360° scene) into its pin layer.
async function loadPagePins(loc, entry) {
  if (entry.kind === 'pano') entry.viewer.clearPins(); else entry.pinLayer.innerHTML = '';
  const hotspots = await DB.getHotspotsForPage(entry.page.id);
  hotspots.forEach(h => renderPin(h, entry));
  if (pendingLocate && pendingLocate.locationId === loc.id) {
    const { hotspotId, pulse, noMove } = pendingLocate;
    // Only clear+highlight once we've found the pin on some page.
    if (entry.pinLayer.querySelector(`.pin[data-hotspot-id="${hotspotId}"]`)) {
      pendingLocate = null;
      setTimeout(() => {
        if (noMove) { const f = findPin(hotspotId); if (f) { f.pin.classList.add('pin-highlight'); setTimeout(() => f.pin.classList.remove('pin-highlight'), 2500); } }
        else highlightPin(hotspotId, pulse);
      }, 80);
    }
  }
}

// Find the page-entry + pin element for a hotspot id across all pages.
function findPin(hotspotId) {
  if (!lvState) return null;
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
  const h = found.pin.__h;
  if (found.entry.kind === 'pano') {
    const pv = found.entry.viewer, ll = PanoMath.lonLatFromPct(h.x, h.y);
    const fov = zoomScale || pv.fov;
    pv.lookAt(ll.lon, ll.lat - (yBias != null ? (0.5 - yBias) * fov : 0), fov, 500);
    return;
  }
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
// instantly see WHERE the searched item is. In a 360° scene the view turns to face it.
function highlightPin(hotspotId, pulse) {
  if (!lvState) return;
  const f = findPin(hotspotId);
  if (f && f.entry.kind === 'pano') {
    centerOnPin(hotspotId, Math.min(f.entry.viewer.fov, 55));
  } else if (f) {
    const vw = lvState.viewer.clientWidth, vh = lvState.viewer.clientHeight;
    // Zoom so the marker's own page roughly fills the viewer, then a bit more — but never
    // LESS than the current fit scale, so Locate is always a zoom-IN, never a zoom-out.
    const pageFit = Math.min(vw / f.entry.w, vh / f.entry.h) || 1;
    const target = Math.max(pageFit * 1.6, (lvState.baseScale || 1) * 1.8);
    centerOnPin(hotspotId, target);
  }
  if (!f) return;
  lvState.pages.forEach(e => e.pinLayer.querySelectorAll('.pin-highlight, .pin-locate').forEach(p => p.classList.remove('pin-highlight', 'pin-locate')));
  f.pin.classList.add(pulse ? 'pin-locate' : 'pin-highlight');
  spotlightPin(f);
  if (!pulse) setTimeout(() => f.pin.classList.remove('pin-highlight'), 3500);
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
  const viewer = lvState.viewer;
  viewer.classList.add('spotlight');
  spotlightTimer = setTimeout(() => {
    viewer.classList.remove('spotlight');
    found.pin.classList.remove('spotlight-target');
    spotlightTimer = null;
  }, 3500);
}

function renderPin(h, entry) {
  const isAnnotation = h.type === 'annotation';
  const pin = el('div', {
    class: 'pin' + (isAnnotation ? ' annotation' : '')
  }, [
    el('div', { class: 'pin-dot' }, [isAnnotation ? '' : el('span', {}, [h.number ? h.number.slice(0, 3) : '•'])])
  ]);
  pin.dataset.hotspotId = h.id;
  pin.__h = h;
  // #15 adaptive colour: sample the image pixel under the marker and pick a contrasting
  // hue if the default (blue box / red annotation) would blend into the background.
  applyAdaptivePinColor(pin, h, entry);

  // Pins get their own independent tap detection so they always open reliably,
  // regardless of the viewer's pan/zoom/create-hotspot logic.
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
    // Move the pin live: the pointer position becomes the marker's % position on the image
    // (flat: rotation/scale aware; 360°: the longitude/latitude under the finger).
    const p = entry.fromScreen(e.clientX, e.clientY);
    h.x = p.x; h.y = p.y;
    entry.place(pin, h);
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
          showNudgePad(h, pin, entry); // tap in relocate mode → arrow pad
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

  entry.place(pin, h);
}

// Jump to a hotspot's marker on the canvas and pulse a red locate ring around it — used by
// annotation link chips (#18) and search Locate. Works whether the target is on the current
// location (highlight directly) or a different one (navigate there first).
function locateHotspotOnCanvas(hotspotId, locationId, pulse = true) {
  if (lvState && lvState.loc && lvState.loc.id === locationId && findPin(hotspotId)) {
    highlightPin(hotspotId, pulse);
    return;
  }
  pendingLocate = { locationId, hotspotId, pulse };
  if (state.view === 'location' && state.locationId === locationId) render();
  else goLocation(locationId);
}

// Zoom in on a hotspot for relocation. The zoom level is based on the marker's OWN PAGE
// (not the whole multi-photo canvas) — otherwise, with several photos, the canvas fit-scale
// is tiny and the marker would appear zoomed OUT. We size so that page fills ~the viewer,
// then a touch more, and place the marker in the upper-middle (above the D-pad).
function zoomToPin(hotspotId) {
  const found = findPin(hotspotId);
  if (!found) return;
  if (found.entry.kind === 'pano') { centerOnPin(hotspotId, Math.min(found.entry.viewer.fov, 50), 0.36); return; }
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
function showNudgePad(h, pin, entry) {
  hideNudgePad();
  zoomToPin(h.id); // #7: zoom ~150% and centre the marker being moved

  const pano = entry.kind === 'pano';
  // Percent of image per step. On a 360° scene x spans 360° and y 180°, so use a finer x step
  // to keep both directions ≈0.9° per tap, and let x wrap around the circle.
  const STEP_X = pano ? 0.25 : 0.5, STEP_Y = 0.5;
  let saveTimer = null;
  function nudge(ddx, ddy) {
    h.x = h.x + ddx * STEP_X;
    h.x = pano ? ((h.x % 100) + 100) % 100 : Math.max(0, Math.min(100, h.x));
    h.y = Math.max(0, Math.min(100, h.y + ddy * STEP_Y));
    entry.place(pin, h);
    // Debounce DB writes during continuous movement; flush shortly after the last step.
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => DB.updateHotspot(h), 250);
  }

  // A direction button: one tap = one step; press-and-hold = repeat until released.
  function dirBtn(ic, ddx, ddy, cls) {
    const btn = el('button', { class: 'nudge-btn ' + cls }, [icon(ic, 18)]);
    let holdTimer = null, repeat = null;
    const start = (e) => {
      e.preventDefault(); e.stopPropagation();
      nudge(ddx, ddy); // immediate first step
      holdTimer = setTimeout(() => {
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

  nudgePadEl = el('div', { class: 'nudge-pad-circle glass' }, [
    dirBtn('arrowUp', 0, -1, 'up'),
    dirBtn('back', -1, 0, 'left'),
    el('div', { class: 'nudge-hub' }, [icon('move', 14)]),
    dirBtn('chevronRight', 1, 0, 'right'),
    dirBtn('arrowDown', 0, 1, 'down')
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
// If the pixel UNDER the marker is close to the default colour's hue (so the marker would
// blend in), switch to a contrasting colour instead. We sample the pixel from a tiny
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
      if (!entry.img || !entry.w) return null;
      const c = document.createElement('canvas');
      const SW = 60, SH = Math.max(1, Math.round(60 * entry.h / entry.w));
      c.width = SW; c.height = SH;
      c.getContext('2d', { willReadFrequently: true }).drawImage(entry.img, 0, 0, SW, SH);
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

// ---- Paste a copied hotspot here: move the original, or drop a copy ----
async function handlePasteAt(loc, pageId, x, y) {
  const clip = getClipboard();
  if (!clip) { setMode(null); return; }
  const src = await DB.getHotspot(clip.hotspotId);
  if (!src) {
    clearClipboard();
    showToast('The copied item no longer exists');
    lvModes.pasteMode = false;
    render();
    return;
  }
  const fromLoc = src.locationId === loc.id ? null : await DB.getLocation(src.locationId);
  const label = clipLabel(clip);
  const photos = await DB.getPhotosForHotspot(src.id);
  const overlay = el('div', { class: 'modal-overlay' });
  const finishWith = (hotspotId, msg) => {
    overlay.remove();
    lvModes.pasteMode = false;
    pendingLocate = { locationId: loc.id, hotspotId, noMove: true };
    render();
    showToast(msg);
  };
  overlay.appendChild(el('div', { class: 'modal-sheet' }, [
    el('div', { class: 'sheet-grabber' }),
    el('h2', {}, [`Place “${label}” here`]),
    el('p', { class: 'sheet-sub' }, [fromLoc ? `It is currently in ${fromLoc.name}.` : 'It is currently elsewhere in this location.']),
    el('div', { class: 'menu-group' }, [
      menuItem('move', 'Move it here', async () => {
        await DB.moveHotspot(src.id, { locationId: loc.id, pageId, x, y });
        clearClipboard();
        finishWith(src.id, fromLoc ? `Moved from ${fromLoc.name}` : 'Moved here');
      }, { sub: `Takes the ${src.type === 'annotation' ? 'annotation' : 'box'}${photos.length ? ` and its ${photos.length} photo${photos.length === 1 ? '' : 's'}` : ''} out of ${fromLoc ? fromLoc.name : 'its old spot'}` }),
      menuItem('copy', 'Paste a copy', async () => {
        const h = await DB.duplicateHotspot(src.id, { locationId: loc.id, pageId, x, y });
        if (h) finishWith(h.id, 'Copy pasted');
      }, { sub: 'Keeps the original where it is' })
    ]),
    el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn ghost', onclick: () => { overlay.remove(); clearClipboard(); lvModes.pasteMode = false; render(); showToast('Clipboard cleared'); } }, ['Clear clipboard']),
      el('button', { class: 'btn secondary', onclick: () => overlay.remove() }, ['Cancel'])
    ])
  ]));
  showOverlay(overlay);
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
      listWrap.appendChild(el('div', { class: 'empty-state small' }, [el('div', { class: 'empty-text' }, [hotspots.length ? 'No matches.' : 'No items yet for this location.'])]));
      return;
    }
    for (const rec of shown) {
      const { h, photos, captions } = rec;
      const thumb = el('div', { class: 'hlt-thumb' }, photos[0] ? [] : [icon(h.type === 'annotation' ? 'tag' : 'box', 20)]);
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
        class: 'hotspot-list-item', onclick: () => { overlay.remove(); locateHotspotOnCanvas(h.id, loc.id, false); }
      }, [thumb, el('div', { class: 'hlt-text' }, children)]);
      listWrap.appendChild(item);
    }
  }

  const searchInput = el('input', { type: 'search', placeholder: 'Search name, number, or caption…', autocomplete: 'off' });
  searchInput.addEventListener('input', () => { query = searchInput.value.trim(); renderList(); });

  const eyeBtn = el('button', { class: 'icon-btn round', title: 'Show captions' }, [icon('eye', 20)]);
  eyeBtn.addEventListener('click', () => { expanded = !expanded; eyeBtn.classList.toggle('on', expanded); renderList(); });

  renderList();

  const sheet = el('div', { class: 'modal-sheet' }, [
    el('div', { class: 'view-header' }, [
      el('h2', { style: 'margin:0;' }, [`${loc.name} — all items`]),
      eyeBtn
    ]),
    el('div', { class: 'field search-field boxed' }, [icon('search', 18), searchInput]),
    listWrap,
    el('div', { class: 'btn-row' }, [
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
  const typeSeg = segmented([
    { value: 'storeroom', label: 'Boxes', icon: 'box' },
    { value: 'diagram', label: 'Diagram', icon: 'tag' }
  ], loc.type || 'storeroom');

  const sheet = el('div', { class: 'modal-sheet' }, [
    el('h2', {}, ['Edit location']),
    el('div', { class: 'field' }, [el('label', {}, ['Name']), nameInput]),
    el('div', { class: 'field' }, [el('label', {}, ['Type']), typeSeg.el]),
    // #11: "Replace Cover Photo" intentionally removed — swapping the cover photo would
    // orphan every hotspot already placed on the old image.
    el('button', {
      class: 'btn ghost danger-text block', onclick: async () => {
        if (confirm(`Delete "${loc.name}"? You can restore it from Settings until you close the app.`)) {
          await deleteLocationWithUndo(loc);
          destroyPanoCache();
          // Robustly close all open overlays and land cleanly on home.
          closeAllOverlays(resetToHome);
          showToast('Location deleted — restore from Settings');
        }
      }
    }, [icon('trash', 18), 'Delete location']),
    el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn secondary', onclick: () => overlay.remove() }, ['Cancel']),
      el('button', {
        class: 'btn', onclick: async () => {
          loc.name = nameInput.value.trim() || loc.name;
          loc.type = typeSeg.value;
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
