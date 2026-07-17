const root = $('#app');
const state = { view: null, locationId: null, folderId: null, mode: 'box' };

// #12 In-memory trash for deleted locations — survives only until the tab/app is closed.
// Each entry: { location, hotspots:[], photos:[], deletedAt }. Restore re-imports it.
const deletedLocations = [];

// Snapshot a location (with its pages, hotspots + photos) into the session trash, then delete.
async function deleteLocationWithUndo(loc) {
  const hotspots = await DB.getHotspotsForLocation(loc.id);
  const pages = await DB.getPagesForLocation(loc.id);
  const photos = [];
  for (const h of hotspots) photos.push(...await DB.getPhotosForHotspot(h.id));
  deletedLocations.push({ location: loc, hotspots, pages, photos, deletedAt: Date.now() });
  await DB.deleteLocation(loc.id);
}

// Restore a trashed location back into the DB and remove it from the trash.
async function restoreDeletedLocation(entry) {
  await DB.importAll({ locations: [entry.location], hotspots: entry.hotspots, pages: entry.pages || [], photos: entry.photos, folders: [] }, 'merge');
  const i = deletedLocations.indexOf(entry);
  if (i >= 0) deletedLocations.splice(i, 1);
}

// ---- Camera mode (in-app camera with flash vs. the phone's native camera) ----
// 'app'    → open the in-app live camera (getUserMedia) with the torch/flash turned ON by
//            default, so tagging in a dark store is one tap. Requires HTTPS + permission.
// 'native' → open the phone's own camera app (the flash is then the OS's setting, which the
//            web app cannot control).
// Default is 'app' so the flash is on by default; the user can switch in Settings.
function getCameraMode() {
  try { const m = localStorage.getItem('vi-camera-mode'); if (m === 'app' || m === 'native') return m; } catch (e) {}
  return 'app';
}
function setCameraMode(mode) {
  try { localStorage.setItem('vi-camera-mode', mode === 'native' ? 'native' : 'app'); } catch (e) {}
}

// ---- Theme (dark / light) ----
function getTheme() {
  try { const t = localStorage.getItem('vi-theme'); if (t === 'light' || t === 'dark') return t; } catch (e) {}
  return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
}
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem('vi-theme', theme); } catch (e) {}
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#f2f4f7' : '#111418');
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') || getTheme();
  applyTheme(cur === 'light' ? 'dark' : 'light');
  render();
}

function render() {
  root.innerHTML = '';
  if (state.view === 'home' || !state.view) renderHome();
  else if (state.view === 'location') renderLocationView();
  else if (state.view === 'search') renderSearch();
}

// ---- Browser-history integration ----
// Each screen and each modal gets a real history entry, so the phone/browser Back
// button navigates INSIDE the app (modal -> screen -> home) instead of closing the tab.
function pushView(view, locationId) {
  state.view = view;
  state.locationId = locationId || null;
  history.pushState({ view: state.view, locationId: state.locationId }, '');
  render();
}
function goHome() { pushView('home', null); }
function goLocation(id) { pushView('location', id); }
function goSearch() { pushView('search', null); }

// Go straight home and collapse the stack (used after delete/import, where going
// "back" to the just-removed screen would make no sense).
function resetToHome() {
  state.view = 'home';
  state.locationId = null;
  state.folderId = null; // land on the top-level grid, not inside a (possibly deleted) folder
  history.replaceState({ view: 'home', locationId: null }, '');
  render();
}

// Add a modal/overlay to the page AND give it a history entry so Back closes it first.
// opts.onBackdrop: when true (default for most sheets), tapping the dimmed area outside
// the sheet closes the overlay — same as tapping its Close/✕ button.
function showOverlay(overlay, opts = {}) {
  document.body.appendChild(overlay);
  history.pushState({ overlay: true }, '');
  const origRemove = overlay.remove.bind(overlay);
  overlay.remove = function () {
    if (overlay.__removed) return; // idempotent — never double-remove / double-back
    overlay.__removed = true;
    overlay.remove = origRemove;
    origRemove();
    // If this overlay's own history entry is still the current one (i.e. it was
    // closed by a button, not by Back), pop it to keep history balanced. We flag the
    // pop as "programmatic" so the popstate handler treats it as pure bookkeeping and
    // does NOT close the overlay stacked beneath this one.
    if (history.state && history.state.overlay) { programmaticBack = true; history.back(); }
  };

  // Tap-outside-to-close. A pointerdown that STARTS on the dim backdrop (not the sheet)
  // and ends there too closes the overlay — so a drag that begins inside the sheet and
  // slips onto the backdrop won't accidentally dismiss it.
  if (opts.onBackdrop !== false) {
    let downOnBackdrop = false;
    overlay.addEventListener('pointerdown', (e) => { downOnBackdrop = (e.target === overlay); });
    overlay.addEventListener('pointerup', async (e) => {
      if (downOnBackdrop && e.target === overlay) {
        // Flush any pending edits (hotspot detail fields) before dismissing.
        if (typeof overlay.__persist === 'function') { try { await overlay.__persist(); } catch (err) {} }
        overlay.remove();
      }
      downOnBackdrop = false;
    });
  }
  return overlay;
}

// Close every open overlay in one shot, then go to a clean home. Used after destructive
// actions (delete location / import) instead of a hard-coded history.go(-N), which
// mis-fires whenever the real overlay depth differs from the assumption (a backdrop-close,
// an extra confirm sheet, etc.). We remove the overlay DOM plainly and rewind their
// history entries with a single go(-N); resetToHome then replaces the landing state so the
// history tail is always a clean [home]. Any leftover stale entries are harmless — Back on
// them simply finds no overlay and lands on home again.
function closeAllOverlays(after) {
  const overlays = Array.prototype.slice.call(
    document.querySelectorAll('.modal-overlay, .photo-viewer-overlay')
  ).filter(o => !o.__removed);
  overlays.forEach(o => { o.__removed = true; o.remove = HTMLElement.prototype.remove; o.remove(); });
  const steps = overlays.length;
  if (steps > 0) {
    // Swallow the whole popstate cascade from this rewind, then finish on home.
    suppressPopstateCount += steps;
    history.go(-steps);
  }
  // resetToHome uses replaceState, so it clobbers whatever entry we land on with [home].
  setTimeout(() => { (after || resetToHome)(); }, steps > 0 ? 40 : 0);
}

let programmaticBack = false;   // true while a single button-close balances its history entry
let suppressPopstateCount = 0;  // >0 while a multi-step programmatic rewind is in flight

window.addEventListener('popstate', (e) => {
  // Swallow the popstate cascade produced by a multi-step programmatic rewind
  // (closeAllOverlays) — those entries are just being unwound, not navigated.
  if (suppressPopstateCount > 0) { suppressPopstateCount--; return; }
  // A history.back() fired by a single button-close is pure bookkeeping — swallow it so it
  // does NOT cascade down and close the overlay stacked beneath the one just closed.
  if (programmaticBack) { programmaticBack = false; return; }
  // Only close an overlay that is BOTH in the DOM and not already flagged as removed.
  const overlays = Array.prototype.slice.call(
    document.querySelectorAll('.modal-overlay, .photo-viewer-overlay')
  ).filter(o => !o.__removed);
  if (overlays.length) {
    // Back was pressed while a modal is open: close the topmost one.
    // Its history entry was already popped by the browser, so remove the DOM node
    // plainly (bypass the patched remove that would call history.back again).
    const top = overlays[overlays.length - 1];
    top.__removed = true;
    if (typeof top.__onClose === 'function') { try { top.__onClose(); } catch (err) {} }
    top.remove = HTMLElement.prototype.remove;
    top.remove();
    return;
  }
  // Inside a folder on the home screen: Back exits the folder to the top level first,
  // and re-pushes the home entry we just consumed so the app isn't left one short.
  if ((state.view === 'home' || !state.view) && state.folderId) {
    state.folderId = null;
    history.pushState({ view: 'home', locationId: null }, '');
    render();
    return;
  }
  const st = e.state || { view: 'home', locationId: null };
  const same = st.view === state.view && (st.locationId || null) === (state.locationId || null);
  state.view = st.view;
  state.locationId = st.locationId || null;
  if (!same) render(); // skip needless redraw when a button-close lands us on the same screen
});

// ============ HOME ============
// state.folderId === null → top level (folders + loose locations).
// state.folderId === <id> → inside a folder (its member locations only).
async function renderHome() {
  const isLight = (document.documentElement.getAttribute('data-theme') || getTheme()) === 'light';
  const curFolder = state.folderId ? await DB.getFolder(state.folderId) : null;
  if (state.folderId && !curFolder) { state.folderId = null; } // folder was deleted

  const topbar = el('div', { class: 'topbar' }, [
    curFolder ? el('button', { class: 'icon-btn', title: 'Back', onclick: () => { state.folderId = null; render(); } }, ['←']) : null,
    el('h1', {}, [curFolder ? curFolder.name : 'Visual Inventory']),
    curFolder
      ? el('button', { class: 'icon-btn', title: 'Rename / delete folder', onclick: () => openFolderMenu(curFolder) }, ['⋯'])
      : el('button', { class: 'icon-btn', title: 'Toggle dark / light', onclick: toggleTheme }, [isLight ? '🌙' : '☀️']),
    el('button', { class: 'icon-btn', title: 'Search', onclick: goSearch }, ['🔍']),
    el('button', { class: 'icon-btn', title: 'Backup / Restore', onclick: openBackupModal }, ['⚙️'])
  ]);
  root.appendChild(topbar);

  const view = el('div', { class: 'view' });
  root.appendChild(view);

  const allLocations = await DB.getAllLocations();
  const folders = curFolder ? [] : await DB.getAllFolders();
  // At top level show folders + locations with no folder; inside a folder show its members.
  const locations = curFolder
    ? allLocations.filter(l => l.folderId === curFolder.id)
    : allLocations.filter(l => !l.folderId);

  if (!folders.length && !locations.length) {
    view.appendChild(el('div', { class: 'empty-state' }, [
      el('div', { class: 'big-icon' }, ['📦']),
      el('div', {}, [curFolder ? 'This folder is empty.' : 'No locations yet.']),
      el('div', {}, [curFolder ? 'Move locations in from the home screen (long-press a tile).' : 'Tap + to add your first Workshop, Store Room, or Panel.'])
    ]));
  } else {
    const grid = el('div', { class: 'location-grid' });

    // Folder tiles first (top level only).
    for (const f of folders) {
      const memberCount = allLocations.filter(l => l.folderId === f.id).length;
      const cover = allLocations.find(l => l.folderId === f.id && l.coverPhoto);
      const thumb = el('div', { class: 'thumb folder-thumb' }, cover ? [] : ['📁']);
      if (cover) thumb.style.backgroundImage = `url(${blobToUrl(cover.coverPhoto)})`;
      const card = el('div', {
        class: 'location-card folder-card', 'data-folder-id': f.id,
        onclick: () => { state.folderId = f.id; render(); }
      }, [
        thumb,
        el('div', { class: 'label' }, [`📁 ${f.name}`, el('span', { class: 'count-badge' }, [String(memberCount)])])
      ]);
      grid.appendChild(card);
    }

    // Location tiles.
    locations.forEach(loc => {
      const thumb = el('div', { class: 'thumb' }, loc.coverPhoto ? [] : ['📷']);
      if (loc.coverPhoto) thumb.style.backgroundImage = `url(${blobToUrl(loc.coverPhoto)})`;
      const card = el('div', { class: 'location-card', 'data-location-id': loc.id, onclick: (e) => {
        if (card.__suppressClick) { card.__suppressClick = false; e.stopPropagation(); return; }
        goLocation(loc.id);
      } }, [
        thumb,
        el('div', { class: 'label' }, [loc.name])
      ]);
      makeLocationTileInteractive(card, loc, { inFolder: !!curFolder });
      grid.appendChild(card);
    });
    view.appendChild(grid);
  }

  root.appendChild(el('button', { class: 'fab', title: 'Add Location', onclick: openAddLocationModal }, ['+']));
}

// ---- Home-screen grouping: long-press menu + drag-and-drop ----
// A location tile supports:
//   • long-press → action menu (move into / create folder / remove from folder)
//   • drag (after a long hold) → drop onto another location (makes a new folder from both)
//     or onto a folder tile (moves it in)
function makeLocationTileInteractive(card, loc, { inFolder }) {
  let holdTimer = null, dragging = false, ghost = null, startPt = null, moved = false;

  function clearHold() { if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; } }

  card.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return;
    startPt = { x: e.clientX, y: e.clientY };
    moved = false;
    holdTimer = setTimeout(() => {
      holdTimer = null;
      startDrag(e); // enter drag mode after a 320ms hold
    }, 320);
  });

  card.addEventListener('pointermove', (e) => {
    if (startPt && !dragging) {
      if (Math.hypot(e.clientX - startPt.x, e.clientY - startPt.y) > 10) { moved = true; clearHold(); }
    }
    if (dragging) moveGhost(e);
  });

  card.addEventListener('pointerup', (e) => {
    clearHold();
    if (dragging) { endDrag(e); return; }
    startPt = null;
  });
  card.addEventListener('pointercancel', () => { clearHold(); if (dragging) cancelDrag(); });

  // Long-press without moving much → show the menu (drag never started because pointerup
  // fired first is handled by startDrag flagging). We open the menu from the hold timer
  // ONLY if the user lifts quickly; simpler: give a dedicated contextmenu + a menu button
  // via long press. Here: if hold fired and turned into a drag but the user didn't move,
  // endDrag falls back to opening the menu.

  function startDrag(e) {
    dragging = true;
    card.classList.add('dragging');
    document.body.classList.add('tiles-dragging');
    ghost = card.cloneNode(true);
    ghost.classList.add('drag-ghost');
    document.body.appendChild(ghost);
    moveGhost(e);
    try { card.setPointerCapture(e.pointerId); } catch (err) {}
    if (navigator.vibrate) navigator.vibrate(15);
  }
  function moveGhost(e) {
    if (!ghost) return;
    ghost.style.left = e.clientX + 'px';
    ghost.style.top = e.clientY + 'px';
    highlightDropUnder(e.clientX, e.clientY, loc.id);
  }
  function endDrag(e) {
    const target = dropTargetUnder(e.clientX, e.clientY, loc.id);
    card.__suppressClick = true; // a drag/hold happened — don't let the tile's click navigate
    // Self-clear so a stale flag can never eat a later legitimate tap on the same tile.
    setTimeout(() => { card.__suppressClick = false; }, 500);
    cleanupDrag();
    if (!moved && !target) { openLocationMenu(loc, { inFolder }); return; } // held but didn't drag → menu
    if (!target) return;
    if (target.type === 'folder') {
      DB.setLocationFolder(loc.id, target.folderId).then(() => { showToast('Moved into folder'); render(); });
    } else if (target.type === 'location') {
      promptNewFolderFrom(loc, target.locationId);
    }
  }
  function cancelDrag() { cleanupDrag(); }
  function cleanupDrag() {
    dragging = false; startPt = null;
    card.classList.remove('dragging');
    document.body.classList.remove('tiles-dragging');
    if (ghost) { ghost.remove(); ghost = null; }
    document.querySelectorAll('.drop-hover').forEach(n => n.classList.remove('drop-hover'));
  }
}

function dropTargetUnder(x, y, selfLocId) {
  const stack = document.elementsFromPoint(x, y);
  for (const node of stack) {
    const fc = node.closest && node.closest('.folder-card');
    if (fc && fc.dataset.folderId) return { type: 'folder', folderId: fc.dataset.folderId };
    const lc = node.closest && node.closest('.location-card:not(.folder-card)');
    if (lc && lc.dataset.locationId && lc.dataset.locationId !== selfLocId) {
      return { type: 'location', locationId: lc.dataset.locationId };
    }
  }
  return null;
}

function highlightDropUnder(x, y, selfLocId) {
  document.querySelectorAll('.drop-hover').forEach(n => n.classList.remove('drop-hover'));
  const t = dropTargetUnder(x, y, selfLocId);
  if (!t) return;
  const sel = t.type === 'folder' ? `.folder-card[data-folder-id="${t.folderId}"]` : `.location-card[data-location-id="${t.locationId}"]`;
  const node = document.querySelector(sel);
  if (node) node.classList.add('drop-hover');
}

// Location tile action menu (long-press).
async function openLocationMenu(loc, { inFolder }) {
  const overlay = el('div', { class: 'modal-overlay centered' });
  const folders = await DB.getAllFolders();
  const rows = [
    el('h2', {}, [loc.name]),
    el('button', { class: 'btn secondary menu-item', onclick: () => { overlay.remove(); goLocation(loc.id); } }, ['Open']),
    el('button', {
      class: 'btn secondary menu-item', onclick: async () => {
        const name = prompt('Rename location:', loc.name);
        overlay.remove();
        if (name == null) return;
        loc.name = name.trim() || loc.name;
        await DB.updateLocation(loc);
        showToast('Renamed');
        render();
      }
    }, ['✎ Rename']),
    el('button', { class: 'btn secondary menu-item', onclick: () => { overlay.remove(); promptNewFolder(loc); } }, ['📁 New folder from this…'])
  ];
  if (folders.length) {
    rows.push(el('div', { class: 'section-title', style: 'padding-left:0;' }, ['Move into folder']));
    folders.forEach(f => {
      if (loc.folderId === f.id) return;
      rows.push(el('button', {
        class: 'btn secondary menu-item', onclick: async () => { overlay.remove(); await DB.setLocationFolder(loc.id, f.id); showToast('Moved'); render(); }
      }, [`📁 ${f.name}`]));
    });
  }
  if (inFolder || loc.folderId) {
    rows.push(el('button', {
      class: 'btn secondary menu-item', onclick: async () => { overlay.remove(); await DB.setLocationFolder(loc.id, null); showToast('Removed from folder'); render(); }
    }, ['⬆︎ Remove from folder']));
  }
  rows.push(el('div', { class: 'btn-row', style: 'margin-top:12px;' }, [
    el('button', { class: 'btn secondary', onclick: () => overlay.remove() }, ['Cancel'])
  ]));
  overlay.appendChild(el('div', { class: 'modal-sheet' }, rows));
  showOverlay(overlay);
}

function promptNewFolder(loc) {
  const name = prompt('New folder name:', 'Boiler');
  if (name == null) return;
  DB.addFolder({ name: name.trim() || 'Folder' }).then(async f => {
    await DB.setLocationFolder(loc.id, f.id);
    showToast('Folder created');
    render();
  });
}

// Drop location A onto location B → make a new folder containing both.
function promptNewFolderFrom(locA, locBId) {
  const name = prompt('Name the new folder for these two locations:', 'Boiler');
  if (name == null) return;
  DB.addFolder({ name: name.trim() || 'Folder' }).then(async f => {
    await DB.setLocationFolder(locA.id, f.id);
    await DB.setLocationFolder(locBId, f.id);
    showToast('Folder created');
    render();
  });
}

// Folder header menu (rename / delete).
function openFolderMenu(folder) {
  const overlay = el('div', { class: 'modal-overlay centered' });
  overlay.appendChild(el('div', { class: 'modal-sheet' }, [
    el('h2', {}, [folder.name]),
    el('button', {
      class: 'btn secondary menu-item', onclick: async () => {
        const name = prompt('Rename folder:', folder.name);
        overlay.remove();
        if (name == null) return;
        folder.name = name.trim() || folder.name;
        await DB.updateFolder(folder);
        render();
      }
    }, ['✎ Rename folder']),
    el('button', {
      class: 'btn danger menu-item', onclick: async () => {
        overlay.remove();
        if (!confirm('Delete this folder? The locations inside will move back to the home screen (they are NOT deleted).')) return;
        await DB.deleteFolder(folder.id);
        state.folderId = null;
        showToast('Folder deleted');
        render();
      }
    }, ['🗑 Delete folder']),
    el('div', { class: 'btn-row', style: 'margin-top:12px;' }, [
      el('button', { class: 'btn secondary', onclick: () => overlay.remove() }, ['Cancel'])
    ])
  ]));
  showOverlay(overlay);
}

function openAddLocationModal() {
  let coverBlob = null;
  let photoBusy = false;
  const overlay = el('div', { class: 'modal-overlay' });

  const nameInput = el('input', { type: 'text', placeholder: 'e.g. Workshop, Store Room' });
  const typeInput = el('select', {}, [
    el('option', { value: 'storeroom' }, ['Storeroom / Box Inventory']),
    el('option', { value: 'diagram' }, ['Diagram / Panel (Annotation Mode)'])
  ]);

  // #6: after picking a photo, the preview is tappable to crop, and Rotate/Crop buttons
  // appear so the image can be adjusted BEFORE the location is created.
  const previewImg = el('img', { title: 'Tap to crop', style: 'display:none;max-width:100%;border-radius:10px;margin-top:8px;cursor:pointer;' });
  const editRow = el('div', { class: 'btn-row', style: 'display:none;margin-top:8px;' });

  function setCover(blob) {
    coverBlob = blob;
    previewImg.src = blobToUrl(coverBlob);
    previewImg.style.display = 'block';
    editRow.style.display = 'flex';
    photoBtn.textContent = 'Change Photo';
    updateCreateState();
  }
  async function rotateCover() {
    if (!coverBlob) return;
    const spinner = showSpinner('Rotating…');
    try { setCover(await downscaleImage(coverBlob, 1600, 0.82, 90)); }
    catch (e) { showToast('Rotate failed'); } finally { spinner.remove(); }
  }
  function cropCover() {
    if (!coverBlob) return;
    openCropModal(coverBlob, (blob) => { if (blob) setCover(blob); });
  }
  editRow.appendChild(el('button', { class: 'btn secondary small', onclick: rotateCover }, ['↻ Rotate']));
  editRow.appendChild(el('button', { class: 'btn secondary small', onclick: cropCover }, ['✂ Crop']));
  previewImg.addEventListener('click', cropCover);

  const photoBtn = el('button', {
    class: 'btn secondary', onclick: async () => {
      if (photoBusy) return;
      photoBusy = true;
      photoBtn.textContent = 'Loading photo…';
      updateCreateState();
      try {
        const files = await pickImageWithChoice();
        if (files[0]) {
          // #5: only mark the photo as ready once it's actually decoded into a blob.
          setCover(await downscaleImage(files[0], 1600, 0.82)); // cover: sharper for pin placement
        } else {
          photoBtn.textContent = coverBlob ? 'Change Photo' : 'Add Location Photo';
        }
      } catch (err) {
        console.error('Photo load failed', err);
        showToast(err && err.message ? err.message : 'Could not load that photo — please try again');
        photoBtn.textContent = coverBlob ? 'Change Photo' : 'Add Location Photo';
      } finally {
        photoBusy = false;
        updateCreateState();
      }
    }
  }, ['Add Location Photo']);

  const createBtn = el('button', {
    class: 'btn', onclick: async () => {
      const name = nameInput.value.trim();
      if (!name || !coverBlob) return; // guarded, but double-check
      createBtn.disabled = true;
      createBtn.textContent = 'Saving…';
      try {
        // #5: commit reliably; surface errors instead of failing silently.
        const loc = await DB.addLocation({ name, type: typeInput.value, coverPhoto: coverBlob });
        // v3: the cover photo also becomes the location's first page (so the viewer,
        // which now works off pages, has an image to show and tag).
        await DB.addPage({ locationId: loc.id, photo: coverBlob, offsetX: 0, offsetY: 0, order: 0 });
        overlay.remove();
        // #4: do NOT auto-open the new location. Return to the tile grid where it now appears.
        render();
        showToast('Location created');
      } catch (err) {
        console.error('Save location failed', err);
        showToast('Save failed — please try again');
        createBtn.disabled = false;
        createBtn.textContent = 'Create';
      }
    }
  }, ['Create']);

  function updateCreateState() {
    createBtn.disabled = photoBusy || !nameInput.value.trim() || !coverBlob;
  }
  nameInput.addEventListener('input', updateCreateState);

  const sheet = el('div', { class: 'modal-sheet' }, [
    el('h2', {}, ['New Location']),
    // #6: action buttons at the TOP so the on-screen keyboard never hides them.
    el('div', { class: 'btn-row-top' }, [
      el('button', { class: 'btn secondary', onclick: () => overlay.remove() }, ['Cancel']),
      createBtn
    ]),
    el('div', { class: 'field' }, [el('label', {}, ['Name']), nameInput]),
    el('div', { class: 'field' }, [el('label', {}, ['Type']), typeInput]),
    el('div', { class: 'field' }, [el('label', {}, ['Cover Photo (required)']), photoBtn, previewImg, editRow])
  ]);
  overlay.appendChild(sheet);
  showOverlay(overlay);
  updateCreateState();
  nameInput.focus();
}

// ============ SETTINGS (BACKUP / RESTORE / RESET) MODAL ============
function openBackupModal() {
  const overlay = el('div', { class: 'modal-overlay centered' });

  // #12: "Recently deleted" — session-only trash of deleted locations, each restorable.
  const trashSection = el('div', {});
  function renderTrash() {
    trashSection.innerHTML = '';
    if (!deletedLocations.length) return;
    trashSection.appendChild(el('div', { class: 'section-title', style: 'padding-left:0;' }, ['Recently Deleted (this session)']));
    deletedLocations.slice().reverse().forEach(entry => {
      trashSection.appendChild(el('div', {
        class: 'field', style: 'display:flex;align-items:center;gap:10px;justify-content:space-between;'
      }, [
        el('span', {}, [`${entry.location.name} · ${entry.hotspots.length} hotspot(s)`]),
        el('button', {
          class: 'btn small', onclick: async () => {
            await restoreDeletedLocation(entry);
            showToast('Location restored');
            renderTrash();
            render(); // refresh home grid behind the modal
          }
        }, ['Restore'])
      ]));
    });
  }
  renderTrash();

  // ---- Camera source toggle ----
  // Two buttons act as a segmented control; the active one is highlighted. Switching is
  // instant and persisted — the next "Take photo" uses the chosen source.
  const camSection = el('div', {});
  function renderCam() {
    camSection.innerHTML = '';
    const mode = getCameraMode();
    const appBtn = el('button', { class: 'btn menu-item' + (mode === 'app' ? '' : ' secondary'), onclick: () => { setCameraMode('app'); renderCam(); } }, ['📸  App camera (flash ON by default)']);
    const natBtn = el('button', { class: 'btn menu-item' + (mode === 'native' ? '' : ' secondary'), onclick: () => { setCameraMode('native'); renderCam(); } }, ['📱  Phone camera (native)']);
    camSection.appendChild(el('div', { class: 'section-title', style: 'padding-left:0;' }, ['Camera']));
    camSection.appendChild(el('div', { class: 'field' }, [
      el('label', {}, ['Choose which camera opens when you take a photo. The in-app camera keeps the flash on by default; the phone camera uses the OS flash setting.']),
      appBtn, natBtn
    ]));
    // The in-app camera (and therefore flash control) only works in a "secure context":
    // HTTPS, or http://localhost. On plain http:// the browser blocks getUserMedia and we
    // silently fall back to the native camera — so tell the user plainly why.
    const secure = window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
    if (mode === 'app' && !secure) {
      camSection.appendChild(el('div', { class: 'field cam-warn' }, [
        '⚠️ The in-app camera can\'t open here, so the flash can\'t be controlled. It needs a secure connection (HTTPS). Open the app over https:// (or install it as a PWA from an HTTPS URL) to use the flash. Right now "Take photo" falls back to your phone camera.'
      ]));
    }
  }
  renderCam();

  const sheet = el('div', { class: 'modal-sheet' }, [
    el('h2', {}, ['Settings']),
    camSection,
    el('div', { class: 'section-title', style: 'padding-left:0;' }, ['Backup & Restore']),
    el('div', { class: 'field' }, [
      el('label', {}, ['Export all data (locations, hotspots, photos) to a single file for safekeeping.']),
      el('button', { class: 'btn', onclick: () => exportAllData() }, ['Export All Data (.json)'])
    ]),
    el('div', { class: 'field' }, [
      el('label', {}, ['Restore from a previously exported backup file.']),
      el('button', { class: 'btn secondary', onclick: () => triggerImport() }, ['Import / Restore Data'])
    ]),
    trashSection,
    el('div', { class: 'section-title', style: 'padding-left:0;' }, ['Danger Zone']),
    el('div', { class: 'field' }, [
      el('label', {}, ['Permanently delete ALL locations, hotspots and photos from this device. This cannot be undone — export a backup first.']),
      el('button', { class: 'btn danger', onclick: () => resetData() }, ['Reset Data'])
    ]),
    el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn secondary', onclick: () => overlay.remove() }, ['Close'])
    ])
  ]);
  overlay.appendChild(sheet);
  showOverlay(overlay);

  // #3: manual-only, confirmed reset of all local data.
  async function resetData() {
    if (!confirm('Delete ALL data on this device? This cannot be undone.')) return;
    if (!confirm('Are you absolutely sure? Export a backup first if you have not.')) return;
    try {
      await DB.clearAll();
      overlay.remove();
      resetToHome();
      showToast('All data cleared');
    } catch (err) {
      console.error('Reset failed', err);
      showToast('Reset failed — please try again');
    }
  }

  async function exportAllData() {
    showToast('Preparing export…');
    const data = await DB.exportAll();
    const out = { version: 3, exportedAt: new Date().toISOString(), locations: [], hotspots: data.hotspots, folders: data.folders || [], pages: [], photos: [] };
    for (const loc of data.locations) {
      out.locations.push({ ...loc, coverPhoto: loc.coverPhoto ? await blobToBase64(loc.coverPhoto) : null });
    }
    for (const pg of (data.pages || [])) {
      out.pages.push({ ...pg, photo: pg.photo ? await blobToBase64(pg.photo) : null });
    }
    for (const p of data.photos) {
      out.photos.push({ ...p, photo: p.photo ? await blobToBase64(p.photo) : null });
    }
    const blob = new Blob([JSON.stringify(out)], { type: 'application/json' });
    downloadBlob(blob, `visual-inventory-backup-${new Date().toISOString().slice(0, 10)}.json`);
    showToast('Backup downloaded');
  }

  function triggerImport() {
    const input = el('input', { type: 'file', accept: 'application/json,.json', class: 'file-input-hidden' });
    document.body.appendChild(input);
    input.addEventListener('change', async () => {
      const file = input.files[0];
      input.remove();
      if (!file) return;
      const text = await file.text();
      let data;
      try { data = JSON.parse(text); } catch (e) { showToast('Invalid backup file'); return; }
      confirmImportMode(data);
    });
    input.click();
  }

  function confirmImportMode(data) {
    const confirmOverlay = el('div', { class: 'modal-overlay centered' });
    const confirmSheet = el('div', { class: 'modal-sheet' }, [
      el('h2', {}, ['Restore Data']),
      el('p', {}, [`This backup contains ${data.locations?.length || 0} location(s). Merge will keep existing data and add/update from the backup. Replace will erase current data first.`]),
      el('div', { class: 'btn-row' }, [
        el('button', { class: 'btn secondary', onclick: () => confirmOverlay.remove() }, ['Cancel']),
        el('button', { class: 'btn secondary', onclick: () => doImport(data, 'merge') }, ['Merge']),
        el('button', { class: 'btn danger', onclick: () => doImport(data, 'replace') }, ['Replace All'])
      ])
    ]);
    confirmOverlay.appendChild(confirmSheet);
    showOverlay(confirmOverlay);

    async function doImport(data, mode) {
      showToast('Restoring…');
      try {
        const converted = {
          // coverPhoto/photo may be a base64 data URL (normal) or already null. base64ToBlob
          // is synchronous, so no await is needed — map plainly.
          locations: (data.locations || []).map(l => ({ ...l, coverPhoto: l.coverPhoto ? base64ToBlob(l.coverPhoto) : null })),
          hotspots: data.hotspots || [],
          folders: data.folders || [],
          pages: (data.pages || []).map(pg => ({ ...pg, photo: pg.photo ? base64ToBlob(pg.photo) : null })),
          photos: (data.photos || []).map(p => ({ ...p, photo: p.photo ? base64ToBlob(p.photo) : null }))
        };
        const res = await DB.importAll(converted, mode);
        // Robustly close every open modal and land on a freshly-rendered home so the
        // imported locations/hotspots show at once.
        closeAllOverlays(resetToHome);
        showToast(`Restore complete — ${converted.locations.length} location(s), ${converted.hotspots.length} hotspot(s)`);
      } catch (err) {
        console.error('Import failed', err);
        showToast('Import failed: ' + (err && err.message ? err.message : 'unknown error'));
      }
    }
  }
}

// ============ SEARCH ============
function renderSearch() {
  const topbar = el('div', { class: 'topbar' }, [
    el('button', { class: 'icon-btn', onclick: () => history.back() }, ['←']),
    el('h1', {}, ['Search'])
  ]);
  root.appendChild(topbar);

  const searchBar = el('div', { class: 'search-bar' });
  const input = el('input', { type: 'text', placeholder: 'Search name, number, or photo caption…' });
  searchBar.appendChild(input);
  root.appendChild(searchBar);

  const view = el('div', { class: 'view' });
  const resultsEl = el('div', { class: 'search-results' });
  view.appendChild(resultsEl);
  root.appendChild(view);

  let debounceTimer;
  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => runSearch(input.value), 200);
  });

  const locCache = {};
  async function locName(id) {
    if (!(id in locCache)) locCache[id] = await DB.getLocation(id);
    return locCache[id];
  }

  // records: [{ hotspot, source }] — source is the field the query matched (or null when
  // just listing everything). #2: show a badge telling the user WHY it matched. When the query
  // matched a PHOTO CAPTION, the matching photo(s) are shown in a gallery grid under the row.
  async function renderList(records, { hint, query } = {}) {
    resultsEl.innerHTML = '';
    if (hint) resultsEl.appendChild(el('div', { class: 'search-hint' }, [hint]));
    const q = (query || '').toLowerCase();
    for (const rec of records) {
      const h = rec.hotspot;
      const loc = await locName(h.locationId);
      const photos = await DB.getPhotosForHotspot(h.id);
      const thumb = el('div', { class: 'srt-thumb' });
      if (photos[0]) thumb.style.backgroundImage = `url(${blobToUrl(photos[0].photo)})`;
      const locateBtn = el('button', {
        class: 'btn small locate-btn', title: 'Locate on photo',
        onclick: (e) => {
          e.stopPropagation();
          pendingLocate = { locationId: h.locationId, hotspotId: h.id, pulse: true };
          goLocation(h.locationId);
        }
      }, ['📍 Locate']);
      const metaBits = [`#${h.number || '—'} · ${loc ? loc.name : ''}`];
      const srcBadge = rec.source && rec.source !== 'name'
        ? el('span', { class: 'match-badge' }, ['matched ' + rec.source])
        : null;
      const row = el('div', {
        class: 'search-result-item', onclick: () => openHotspotView(h.id)
      }, [
        thumb,
        el('div', { class: 'srt-text' }, [
          el('div', { class: 'name' }, [h.name || '(unnamed)', srcBadge]),
          el('div', { class: 'meta' }, metaBits)
        ]),
        locateBtn
      ]);
      // Photos whose caption matched the query → show them in a grid beneath the row.
      const matchedPhotos = q ? photos.filter(p => (p.caption || '').toLowerCase().includes(q)) : [];
      const children = [row];
      if (matchedPhotos.length) children.push(buildMatchedPhotoGrid(matchedPhotos, photos, h));
      resultsEl.appendChild(el('div', { class: 'search-result-group' }, children));
    }
  }

  async function runSearch(q) {
    if (!q.trim()) { showAllBoxes(); return; }
    const results = await DB.searchHotspots(q); // [{hotspot, source}]
    if (!results.length) {
      resultsEl.innerHTML = '';
      resultsEl.appendChild(el('div', { class: 'empty-state' }, ['No matches found.']));
      return;
    }
    renderList(results, { query: q.trim() });
  }

  // Empty search box → list every box/annotation so the user can browse.
  async function showAllBoxes() {
    const all = await DB.getAllHotspots();
    if (!all.length) {
      resultsEl.innerHTML = '';
      resultsEl.appendChild(el('div', { class: 'empty-state' }, ['Nothing stored yet. Add boxes inside a location first.']));
      return;
    }
    all.sort((a, b) => (a.locationId || '').localeCompare(b.locationId || '') || (b.createdAt || 0) - (a.createdAt || 0));
    renderList(all.map(h => ({ hotspot: h, source: null })), { hint: `All ${all.length} boxes — type above to filter` });
  }

  input.focus();
  showAllBoxes();
}

// #8 Theme shortcuts.
// Laptop: press the spacebar twice quickly (when not typing in a field) to flip theme.
let lastSpace = 0;
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' && e.key !== ' ') return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return; // don't hijack typing
  const now = Date.now();
  if (now - lastSpace < 350) { e.preventDefault(); lastSpace = 0; toggleTheme(); }
  else lastSpace = now;
});
// Double-press "S" quickly (when not typing in a field) opens Search — context aware:
//   • on the home screen → the global Search page
//   • inside a location  → that location's "All hotspots" search/browse list
let lastS = 0;
document.addEventListener('keydown', (e) => {
  if (e.key !== 's' && e.key !== 'S') return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return; // don't hijack typing
  const now = Date.now();
  if (now - lastS < 350) { e.preventDefault(); lastS = 0; openContextSearch(); }
  else lastS = now;
});

// Open the right search surface for wherever the user currently is.
async function openContextSearch() {
  // Don't stack a second search on top of one that's already open.
  if (document.querySelector('.modal-overlay, .photo-viewer-overlay, .camera-overlay')) return;
  if (state.view === 'location' && state.locationId) {
    const loc = await DB.getLocation(state.locationId);
    if (loc) { openBrowseModal(loc); return; }
  }
  if (state.view !== 'search') goSearch();
}

// Mobile: a quick double-tap on the very top edge of the screen flips theme.
let lastTopTap = 0;
document.addEventListener('pointerup', (e) => {
  if (e.clientY > 46) { return; } // only the thin strip at the very top
  // Ignore taps on interactive controls in the topbar (buttons handle themselves).
  if (e.target && e.target.closest && e.target.closest('button, input, select, textarea, a')) return;
  const now = Date.now();
  if (now - lastTopTap < 350) { lastTopTap = 0; toggleTheme(); }
  else lastTopTap = now;
});

document.addEventListener('DOMContentLoaded', () => {
  applyTheme(getTheme());
  state.view = 'home';
  state.locationId = null;
  history.replaceState({ view: 'home', locationId: null }, '');
  render();
});
