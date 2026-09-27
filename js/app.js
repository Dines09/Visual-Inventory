const root = $('#app');
const state = { view: null, locationId: null, folderId: null, mode: 'box' };
const APP_VERSION = '2.0';

// Every overlay that the Back button should close, topmost last in DOM order.
const OVERLAY_SEL = '.modal-overlay, .photo-viewer-overlay, .camera-overlay, .fs-overlay';

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

// ---- Theme: 'light' | 'dark' | 'system' (follows the phone) ----
const systemDark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
function getThemePref() {
  try { const t = localStorage.getItem('vi-theme'); if (t === 'light' || t === 'dark' || t === 'system') return t; } catch (e) {}
  return 'system';
}
function resolveTheme(pref) {
  if (pref === 'light' || pref === 'dark') return pref;
  return systemDark && !systemDark.matches ? 'light' : 'dark';
}
function getTheme() { return resolveTheme(getThemePref()); }
function applyTheme(pref) {
  const theme = resolveTheme(pref);
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem('vi-theme', pref); } catch (e) {}
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#eef1f7' : '#0a0c10');
}
// The theme switch flips between light and dark. No re-render needed: every colour is a CSS
// variable and the switch animates itself from the data-theme attribute.
function toggleTheme() {
  document.documentElement.classList.add('theme-anim');
  applyTheme(getTheme() === 'light' ? 'dark' : 'light');
  setTimeout(() => document.documentElement.classList.remove('theme-anim'), 450);
}
if (systemDark && systemDark.addEventListener) {
  systemDark.addEventListener('change', () => { if (getThemePref() === 'system') applyTheme('system'); });
}

function themeSwitch() {
  return el('button', { class: 'theme-switch', title: 'Switch light / dark', 'aria-label': 'Switch light or dark theme', onclick: toggleTheme }, [
    el('span', { class: 'ts-track' }, [
      el('span', { class: 'ts-ico ts-sun' }, [icon('sun', 14)]),
      el('span', { class: 'ts-ico ts-moon' }, [icon('moon', 14)]),
      el('span', { class: 'ts-knob' }, [el('span', { class: 'ts-knob-sun' }, [icon('sun', 15)]), el('span', { class: 'ts-knob-moon' }, [icon('moon', 15)])])
    ])
  ]);
}

// ---- Hotspot clipboard (copy a box here, paste it in any location — even another store) ----
function getClipboard() {
  try { const c = JSON.parse(localStorage.getItem('vi-clipboard') || 'null'); return c && c.hotspotId ? c : null; } catch (e) { return null; }
}
function setClipboard(h, locName) {
  const c = { hotspotId: h.id, name: h.name || '', number: h.number || '', type: h.type || 'box', locationId: h.locationId, locationName: locName || '', at: Date.now() };
  try { localStorage.setItem('vi-clipboard', JSON.stringify(c)); } catch (e) {}
  return c;
}
function clearClipboard() { try { localStorage.removeItem('vi-clipboard'); } catch (e) {} }
function clipLabel(c) {
  if (!c) return '';
  return c.name || (c.number ? '#' + c.number : (c.type === 'annotation' ? 'annotation' : 'box'));
}

// ---- Rendering ----
// renderSeq guards the async render functions: if a newer render() starts while an older one
// is still awaiting the database, the older one stops instead of appending a second copy of
// the screen.
let renderSeq = 0;
function render() {
  renderSeq++;
  root.innerHTML = '';
  if (state.view !== 'location' && typeof destroyPanoCache === 'function') destroyPanoCache();
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
// overlay.__onClose (optional) runs whenever the overlay is dismissed by Back or backdrop,
// so promise-based sheets always settle.
function showOverlay(overlay, opts = {}) {
  if (!overlay.parentNode) document.body.appendChild(overlay);
  history.pushState({ overlay: true }, '');
  const origRemove = overlay.remove.bind(overlay);
  overlay.remove = function () {
    if (overlay.__removed) return; // idempotent — never double-remove / double-back
    overlay.__removed = true;
    overlay.remove = origRemove;
    origRemove();
    // If this overlay's own history entry is still the current one (i.e. it was
    // closed by a button, not by Back), pop it to keep history balanced. The pop is counted
    // as "programmatic" so the popstate handler treats it as pure bookkeeping and does NOT
    // close the overlay stacked beneath this one.
    if (history.state && history.state.overlay) { programmaticBacks++; history.back(); }
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
        if (typeof overlay.__onClose === 'function') { try { overlay.__onClose(); } catch (err) {} }
        overlay.remove();
      }
      downOnBackdrop = false;
    });
  }
  return overlay;
}

// Close every open overlay in one shot, then go to a clean home. Used after destructive
// actions (delete location / import) instead of a hard-coded history.go(-N), which
// mis-fires whenever the real overlay depth differs from the assumption.
function closeAllOverlays(after) {
  const overlays = Array.prototype.slice.call(document.querySelectorAll(OVERLAY_SEL)).filter(o => !o.__removed);
  overlays.forEach(o => {
    o.__removed = true;
    if (typeof o.__onClose === 'function') { try { o.__onClose(); } catch (err) {} }
    o.remove = HTMLElement.prototype.remove; o.remove();
  });
  const steps = overlays.length;
  if (steps > 0) {
    // Swallow the whole popstate cascade from this rewind, then finish on home.
    suppressPopstateCount += steps;
    history.go(-steps);
  }
  // resetToHome uses replaceState, so it clobbers whatever entry we land on with [home].
  setTimeout(() => { (after || resetToHome)(); }, steps > 0 ? 40 : 0);
}

let programmaticBacks = 0;      // pending history.back() calls made by button-closes
let suppressPopstateCount = 0;  // >0 while a multi-step programmatic rewind is in flight

window.addEventListener('popstate', (e) => {
  // Swallow the popstate cascade produced by a multi-step programmatic rewind
  // (closeAllOverlays) — those entries are just being unwound, not navigated.
  if (suppressPopstateCount > 0) { suppressPopstateCount--; return; }
  // A history.back() fired by a button-close is pure bookkeeping — swallow it so it does NOT
  // cascade down and close the overlay stacked beneath the one just closed. (A counter, not a
  // flag: two sheets closing in the same tick queue two backs.)
  if (programmaticBacks > 0) { programmaticBacks--; return; }
  // Only close an overlay that is BOTH in the DOM and not already flagged as removed.
  const overlays = Array.prototype.slice.call(document.querySelectorAll(OVERLAY_SEL)).filter(o => !o.__removed);
  if (overlays.length) {
    // Back was pressed while a modal is open: close the topmost one.
    // Its history entry was already popped by the browser, so remove the DOM node
    // plainly (bypass the patched remove that would call history.back again).
    const top = overlays[overlays.length - 1];
    top.__removed = true;
    top.remove = HTMLElement.prototype.remove;
    if (typeof top.__onClose === 'function') { try { top.__onClose(); } catch (err) {} }
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
  const seq = renderSeq;
  const curFolder = state.folderId ? await DB.getFolder(state.folderId) : null;
  if (seq !== renderSeq) return;
  if (state.folderId && !curFolder) { state.folderId = null; } // folder was deleted

  const allLocations = await DB.getAllLocations();
  const folders = curFolder ? [] : await DB.getAllFolders();
  const allHotspots = await DB.getAllHotspots();
  if (seq !== renderSeq) return;
  const boxCount = {};
  for (const h of allHotspots) boxCount[h.locationId] = (boxCount[h.locationId] || 0) + 1;
  // At top level show folders + locations with no folder; inside a folder show its members.
  const locations = curFolder
    ? allLocations.filter(l => l.folderId === curFolder.id)
    : allLocations.filter(l => !l.folderId);

  const header = el('header', { class: 'home-header glass-bar' }, [
    el('div', { class: 'hh-row' }, [
      curFolder ? el('button', { class: 'icon-btn round', title: 'Back', onclick: () => { state.folderId = null; render(); } }, [icon('back')]) : null,
      el('div', { class: 'hh-title' }, [
        el('div', { class: 'hh-kicker' }, [curFolder ? 'Folder' : 'Visual Inventory']),
        el('h1', {}, [curFolder ? curFolder.name : 'Locations']),
        el('div', { class: 'hh-sub' }, [curFolder
          ? `${locations.length} location${locations.length === 1 ? '' : 's'}`
          : `${allLocations.length} location${allLocations.length === 1 ? '' : 's'} · ${allHotspots.length} item${allHotspots.length === 1 ? '' : 's'}`])
      ]),
      curFolder
        ? el('button', { class: 'icon-btn round', title: 'Rename / delete folder', onclick: () => openFolderMenu(curFolder) }, [icon('more')])
        : themeSwitch(),
      el('button', { class: 'icon-btn round', title: 'Settings', onclick: openSettings }, [icon('settings')])
    ]),
    el('button', { class: 'search-pill', onclick: goSearch }, [icon('search', 18), el('span', {}, ['Search boxes, numbers, captions…'])])
  ]);
  // The header lives inside the scroll area (sticky) so the tiles blur beneath its glass.
  const view = el('div', { class: 'view home-view' }, [header]);
  root.appendChild(view);

  if (!folders.length && !locations.length) {
    view.appendChild(el('div', { class: 'empty-state' }, [
      el('div', { class: 'empty-art' }, [icon(curFolder ? 'folder' : 'box', 40)]),
      el('div', { class: 'empty-title' }, [curFolder ? 'This folder is empty' : 'No locations yet']),
      el('div', { class: 'empty-text' }, [curFolder ? 'Long-press a location on the home screen to move it in here.' : 'Add a workshop, store room or panel. Capture it as a 360° photo, then tag every box on it.']),
      curFolder ? null : el('button', { class: 'btn', onclick: openAddLocationModal }, [icon('plus', 20), 'Add first location'])
    ]));
  } else {
    const grid = el('div', { class: 'location-grid' });

    // Folder tiles first (top level only).
    for (const f of folders) {
      const members = allLocations.filter(l => l.folderId === f.id);
      const covers = members.filter(l => l.coverPhoto).slice(0, 4);
      const thumb = el('div', { class: 'thumb folder-thumb' + (covers.length > 1 ? ' mosaic' : '') });
      if (covers.length === 1) thumb.style.backgroundImage = `url(${blobToUrl(covers[0].coverPhoto)})`;
      else if (covers.length > 1) covers.forEach(c => { const m = el('div', { class: 'mosaic-cell' }); m.style.backgroundImage = `url(${blobToUrl(c.coverPhoto)})`; thumb.appendChild(m); });
      else thumb.appendChild(icon('folder', 36));
      const card = el('div', {
        class: 'location-card folder-card', 'data-folder-id': f.id,
        onclick: () => { state.folderId = f.id; render(); }
      }, [
        thumb,
        el('div', { class: 'card-badges' }, [el('span', { class: 'chip-badge' }, [icon('folder', 13), String(members.length)])]),
        el('div', { class: 'label' }, [el('div', { class: 'label-name' }, [f.name]), el('div', { class: 'label-sub' }, [`${members.length} location${members.length === 1 ? '' : 's'}`])])
      ]);
      grid.appendChild(card);
    }

    // Location tiles.
    locations.forEach(loc => {
      const thumb = el('div', { class: 'thumb' });
      if (loc.coverPhoto) thumb.style.backgroundImage = `url(${blobToUrl(loc.coverPhoto)})`;
      else thumb.appendChild(icon('image', 32));
      const n = boxCount[loc.id] || 0;
      const card = el('div', { class: 'location-card', 'data-location-id': loc.id, onclick: (e) => {
        if (card.__suppressClick) { card.__suppressClick = false; e.stopPropagation(); return; }
        goLocation(loc.id);
      } }, [
        thumb,
        loc.panoCount ? el('div', { class: 'card-badges' }, [el('span', { class: 'chip-badge pano' }, [icon('pano', 13), '360°'])]) : null,
        el('div', { class: 'label' }, [
          el('div', { class: 'label-name' }, [loc.name]),
          el('div', { class: 'label-sub' }, [loc.type === 'diagram' ? `${n} annotation${n === 1 ? '' : 's'}` : `${n} box${n === 1 ? '' : 'es'}`])
        ])
      ]);
      makeLocationTileInteractive(card, loc, { inFolder: !!curFolder });
      grid.appendChild(card);
    });
    view.appendChild(grid);
  }

  if (!curFolder) root.appendChild(el('button', { class: 'fab', title: 'Add location', onclick: openAddLocationModal }, [icon('plus', 24), el('span', {}, ['New location'])]));
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
  card.addEventListener('contextmenu', (e) => e.preventDefault());

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

// A tappable action row used by all menus: icon + label (+ optional subtitle).
function menuItem(iconName, label, onclick, opts = {}) {
  return el('button', { class: 'menu-item' + (opts.danger ? ' danger' : ''), onclick }, [
    el('span', { class: 'mi-icon' }, [icon(iconName, 20)]),
    el('span', { class: 'mi-text' }, [el('span', { class: 'mi-label' }, [label]), opts.sub ? el('span', { class: 'mi-sub' }, [opts.sub]) : null]),
    opts.chevron ? el('span', { class: 'mi-chev' }, [icon('chevronRight', 18)]) : null
  ]);
}

// Location tile action menu (long-press).
async function openLocationMenu(loc, { inFolder }) {
  const overlay = el('div', { class: 'modal-overlay' });
  const folders = await DB.getAllFolders();
  const rows = [
    el('div', { class: 'sheet-grabber' }),
    el('h2', {}, [loc.name]),
    el('div', { class: 'menu-group' }, [
      menuItem('chevronRight', 'Open', () => { overlay.remove(); goLocation(loc.id); }),
      menuItem('edit', 'Rename', async () => {
        const name = prompt('Rename location:', loc.name);
        overlay.remove();
        if (name == null) return;
        loc.name = name.trim() || loc.name;
        await DB.updateLocation(loc);
        showToast('Renamed');
        render();
      }),
      menuItem('folderPlus', 'New folder from this…', () => { overlay.remove(); promptNewFolder(loc); })
    ])
  ];
  const moveTargets = folders.filter(f => loc.folderId !== f.id);
  if (moveTargets.length) {
    rows.push(el('div', { class: 'section-title' }, ['Move into folder']));
    rows.push(el('div', { class: 'menu-group' }, moveTargets.map(f =>
      menuItem('folder', f.name, async () => { overlay.remove(); await DB.setLocationFolder(loc.id, f.id); showToast('Moved'); render(); })
    )));
  }
  if (inFolder || loc.folderId) {
    rows.push(el('div', { class: 'menu-group' }, [
      menuItem('folderOut', 'Remove from folder', async () => { overlay.remove(); await DB.setLocationFolder(loc.id, null); showToast('Removed from folder'); render(); })
    ]));
  }
  rows.push(el('div', { class: 'btn-row' }, [
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
  const overlay = el('div', { class: 'modal-overlay' });
  overlay.appendChild(el('div', { class: 'modal-sheet' }, [
    el('div', { class: 'sheet-grabber' }),
    el('h2', {}, [folder.name]),
    el('div', { class: 'menu-group' }, [
      menuItem('edit', 'Rename folder', async () => {
        const name = prompt('Rename folder:', folder.name);
        overlay.remove();
        if (name == null) return;
        folder.name = name.trim() || folder.name;
        await DB.updateFolder(folder);
        render();
      }),
      menuItem('trash', 'Delete folder', async () => {
        overlay.remove();
        if (!confirm('Delete this folder? The locations inside will move back to the home screen (they are NOT deleted).')) return;
        await DB.deleteFolder(folder.id);
        state.folderId = null;
        showToast('Folder deleted');
        render();
      }, { danger: true, sub: 'Locations inside are kept' })
    ]),
    el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn secondary', onclick: () => overlay.remove() }, ['Cancel'])
    ])
  ]));
  showOverlay(overlay);
}

// Segmented control. options: [{ value, label, icon }]. Returns { el, get value() }.
function segmented(options, value, onChange) {
  let cur = value;
  const wrap = el('div', { class: 'segmented', role: 'tablist' });
  const btns = options.map(o => {
    const b = el('button', { class: 'seg' + (o.value === cur ? ' on' : ''), type: 'button', onclick: () => {
      if (o.disabled) return;
      cur = o.value;
      btns.forEach((x, i) => x.classList.toggle('on', options[i].value === cur));
      onChange && onChange(cur);
    } }, [o.icon ? icon(o.icon, 16) : null, o.label]);
    if (o.disabled) b.classList.add('disabled');
    return b;
  });
  btns.forEach(b => wrap.appendChild(b));
  return { el: wrap, get value() { return cur; } };
}

// Create the location (and its first scene/photo) from a picked flat photo or a 360° result.
async function createLocationWith({ name, type, flatBlob, pano }) {
  if (pano) {
    const cover = await PanoStitch.renderPerspective(pano.blob, { yaw: pano.meta.startYaw || 0, pitch: 0, hfov: 90, width: 640, height: 480 });
    const loc = await DB.addLocation({ name, type, coverPhoto: cover });
    await DB.addPage({ locationId: loc.id, kind: 'pano', photo: pano.blob, pano: pano.meta, name: 'Scene 1', order: 0 });
    loc.panoCount = 1;
    await DB.updateLocation(loc);
    return loc;
  }
  const loc = await DB.addLocation({ name, type, coverPhoto: flatBlob });
  // v3: the cover photo also becomes the location's first page (so the viewer,
  // which now works off pages, has an image to show and tag).
  await DB.addPage({ locationId: loc.id, photo: flatBlob, offsetX: 0, offsetY: 0, order: 0 });
  return loc;
}

function openAddLocationModal() {
  let flatBlob = null, pano = null, busy = false;
  const overlay = el('div', { class: 'modal-overlay' });

  const nameInput = el('input', { type: 'text', placeholder: 'e.g. Workshop, Store Room', autocomplete: 'off' });
  const typeSeg = segmented([
    { value: 'storeroom', label: 'Boxes', icon: 'box' },
    { value: 'diagram', label: 'Diagram', icon: 'tag' }
  ], 'storeroom');

  const preview = el('div', { class: 'cover-preview', style: 'display:none;' });
  const editRow = el('div', { class: 'chip-row', style: 'display:none;' });

  function showPreview() {
    preview.innerHTML = '';
    editRow.innerHTML = '';
    const blob = pano ? pano.cover : flatBlob;
    if (!blob) { preview.style.display = 'none'; editRow.style.display = 'none'; updateCreateState(); return; }
    const img = el('img', { src: blobToUrl(blob) });
    preview.appendChild(img);
    if (pano) {
      preview.appendChild(el('span', { class: 'chip-badge pano overlay-badge' }, [icon('pano', 13), '360°']));
      editRow.appendChild(el('button', { class: 'chip', onclick: () => choose('capture') }, [icon('restore', 16), 'Retake 360°']));
    } else {
      img.title = 'Tap to crop';
      img.addEventListener('click', cropCover);
      editRow.appendChild(el('button', { class: 'chip', onclick: rotateCover }, [icon('rotate', 16), 'Rotate']));
      editRow.appendChild(el('button', { class: 'chip', onclick: cropCover }, [icon('crop', 16), 'Crop']));
    }
    preview.style.display = 'block';
    editRow.style.display = 'flex';
    updateCreateState();
  }
  async function rotateCover() {
    if (!flatBlob) return;
    const spinner = showSpinner('Rotating…');
    try { flatBlob = await downscaleImage(flatBlob, 1600, 0.82, 90); showPreview(); }
    catch (e) { showToast('Rotate failed'); } finally { spinner.remove(); }
  }
  function cropCover() {
    if (!flatBlob) return;
    openCropModal(flatBlob, (blob) => { if (blob) { flatBlob = blob; showPreview(); } });
  }

  async function choose(kind) {
    if (busy) return;
    busy = true; updateCreateState();
    try {
      if (kind === 'photo') {
        const files = await pickImageWithChoice();
        if (files[0]) { flatBlob = await downscaleImage(files[0], 1600, 0.82); pano = null; }
      } else {
        const res = await obtainPanorama(kind === 'import' ? 'import' : 'capture');
        if (res && res.flat) {
          showToast('That photo isn\'t a panorama — added as a regular photo');
          flatBlob = await downscaleImage(res.file, 1600, 0.82); pano = null;
        } else if (res && res.blob) {
          const sp = showSpinner('Preparing preview…');
          try {
            const cover = await PanoStitch.renderPerspective(res.blob, { yaw: res.meta.startYaw || 0, hfov: 90, width: 640, height: 480 });
            pano = { blob: res.blob, meta: res.meta, cover }; flatBlob = null;
          } finally { sp.remove(); }
        }
      }
    } catch (err) {
      console.error('Photo load failed', err);
      showToast(err && err.message ? err.message : 'Could not load that photo — please try again');
    } finally {
      busy = false;
      showPreview();
    }
  }

  const createBtn = el('button', {
    class: 'btn', onclick: async () => {
      const name = nameInput.value.trim();
      if (!name || !(flatBlob || pano)) return;
      createBtn.disabled = true;
      createBtn.textContent = 'Saving…';
      try {
        await createLocationWith({ name, type: typeSeg.value, flatBlob, pano });
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
    createBtn.disabled = busy || !nameInput.value.trim() || !(flatBlob || pano);
  }
  nameInput.addEventListener('input', updateCreateState);

  const tile = (kind, ic, title, sub, primary) => el('button', { class: 'source-tile' + (primary ? ' primary' : ''), onclick: () => choose(kind) }, [
    el('span', { class: 'st-icon' }, [icon(ic, 24)]),
    el('span', { class: 'st-title' }, [title]),
    el('span', { class: 'st-sub' }, [sub])
  ]);

  const sheet = el('div', { class: 'modal-sheet' }, [
    el('div', { class: 'sheet-grabber' }),
    el('h2', {}, ['New location']),
    // #6: action buttons at the TOP so the on-screen keyboard never hides them.
    el('div', { class: 'btn-row-top' }, [
      el('button', { class: 'btn secondary', onclick: () => overlay.remove() }, ['Cancel']),
      createBtn
    ]),
    el('div', { class: 'field' }, [el('label', {}, ['Name']), nameInput]),
    el('div', { class: 'field' }, [el('label', {}, ['What will you tag here?']), typeSeg.el]),
    el('div', { class: 'field' }, [
      el('label', {}, ['Location photo (required)']),
      el('div', { class: 'source-grid' }, [
        tile('capture', 'orbit', '360° photo', 'Capture the whole room', true),
        tile('import', 'pano', 'Import 360°', 'From a 360° camera / app'),
        tile('photo', 'image', 'Regular photo', 'Camera or gallery')
      ]),
      preview, editRow
    ])
  ]);
  overlay.appendChild(sheet);
  showOverlay(overlay);
  updateCreateState();
  setTimeout(() => nameInput.focus(), 60);
}

// ============ SETTINGS ============
function openSettings() {
  const overlay = el('div', { class: 'modal-overlay settings-overlay' });
  const body = el('div', { class: 'settings-body' });

  const group = (title, rows, note) => el('section', { class: 'set-group' }, [
    title ? el('div', { class: 'set-title' }, [title]) : null,
    el('div', { class: 'set-card' }, rows.filter(Boolean)),
    note ? el('div', { class: 'set-note' }, [note]) : null
  ]);
  const row = (ic, title, sub, right, opts = {}) => el(opts.onclick ? 'button' : 'div', {
    class: 'set-row' + (opts.onclick ? ' tappable' : '') + (opts.danger ? ' danger' : '') + (opts.stack ? ' stack' : ''),
    onclick: opts.onclick
  }, [
    el('span', { class: 'set-ico ' + (opts.tone || '') }, [icon(ic, 18)]),
    el('span', { class: 'set-text' }, [el('span', { class: 'set-label' }, [title]), sub ? el('span', { class: 'set-sub' }, [sub]) : null]),
    right || (opts.onclick ? el('span', { class: 'set-chev' }, [icon('chevronRight', 18)]) : null)
  ]);

  // Appearance
  const themeSeg = segmented([
    { value: 'light', label: 'Light', icon: 'sun' },
    { value: 'dark', label: 'Dark', icon: 'moon' },
    { value: 'system', label: 'Auto', icon: 'monitor' }
  ], getThemePref(), (v) => {
    document.documentElement.classList.add('theme-anim');
    applyTheme(v);
    setTimeout(() => document.documentElement.classList.remove('theme-anim'), 450);
  });

  // Camera
  const camSeg = segmented([
    { value: 'app', label: 'In-app', icon: 'flash' },
    { value: 'native', label: 'Phone', icon: 'camera' }
  ], getCameraMode(), (v) => { setCameraMode(v); renderCamWarn(); });
  const camWarn = el('div');
  function renderCamWarn() {
    camWarn.innerHTML = '';
    // The in-app camera (and therefore flash control) only works in a "secure context":
    // HTTPS, or http://localhost. On plain http:// the browser blocks getUserMedia and we
    // silently fall back to the native camera — so tell the user plainly why.
    const secure = window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
    if (getCameraMode() === 'app' && !secure) {
      camWarn.appendChild(el('div', { class: 'set-warn' }, [icon('alert', 18), el('span', {}, ['The in-app camera needs a secure (https://) link, so "Take photo" is using your phone camera for now. 360° capture also needs https.'])]));
    }
  }
  renderCamWarn();

  let hd = false;
  try { hd = localStorage.getItem('vi-pano-hd') === '1'; } catch (e) {}
  const hdSupported = !PanoStitch.isIOS();
  const hdSeg = segmented([
    { value: '0', label: 'Standard' },
    { value: '1', label: 'High', disabled: !hdSupported }
  ], hd && hdSupported ? '1' : '0', (v) => { try { localStorage.setItem('vi-pano-hd', v); } catch (e) {} });

  // Data
  const storageSub = el('span', { class: 'set-sub' }, ['Checking…']);
  const storageRow = el('div', { class: 'set-row' }, [
    el('span', { class: 'set-ico' }, [icon('database', 18)]),
    el('span', { class: 'set-text' }, [el('span', { class: 'set-label' }, ['Storage on this device']), storageSub])
  ]);
  (async () => {
    try {
      const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
      const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false;
      const mb = est && est.usage != null ? (est.usage / 1048576).toFixed(1) + ' MB used' : 'Usage unknown';
      storageSub.textContent = mb + (persisted ? ' · protected from auto-cleanup' : ' · export backups regularly');
    } catch (e) { storageSub.textContent = 'Usage unknown'; }
  })();

  // Recently deleted (session trash)
  const trashWrap = el('div');
  function renderTrash() {
    trashWrap.innerHTML = '';
    if (!deletedLocations.length) return;
    trashWrap.appendChild(group('Recently deleted', deletedLocations.slice().reverse().map(entry =>
      row('restore', entry.location.name, `${entry.hotspots.length} item${entry.hotspots.length === 1 ? '' : 's'} · until the app is closed`,
        el('button', {
          class: 'btn small', onclick: async () => {
            await restoreDeletedLocation(entry);
            showToast('Location restored');
            renderTrash();
            render(); // refresh home grid behind the sheet
          }
        }, ['Restore']))
    )));
  }
  renderTrash();

  body.append(
    group('Appearance', [row('sun', 'Theme', 'Auto follows your phone', null, { stack: true }), el('div', { class: 'set-control' }, [themeSeg.el])]),
    group('Camera', [
      row('camera', 'Photo camera', 'In-app camera fires the flash for each shot', null, { stack: true }),
      el('div', { class: 'set-control' }, [camSeg.el]),
      camWarn,
      row('hd', '360° detail', hdSupported ? 'High = sharper zoom, needs more memory' : 'High detail isn\'t available on iPhone / iPad', null, { stack: true }),
      el('div', { class: 'set-control' }, [hdSeg.el])
    ]),
    group('Backup & restore', [
      row('download', 'Export all data', 'Locations, boxes, 360° scenes and photos (.json)', null, { onclick: () => exportAllData(), tone: 'accent' }),
      row('upload', 'Import / restore', 'From a previously exported backup', null, { onclick: () => triggerImport(), tone: 'accent' }),
      storageRow
    ]),
    trashWrap,
    group('Danger zone', [
      row('trash', 'Reset all data', 'Permanently deletes everything on this device', null, { onclick: () => resetData(), danger: true, tone: 'danger' })
    ], 'Export a backup first — this cannot be undone.'),
    el('div', { class: 'about' }, [el('div', { class: 'about-logo' }, [icon('box', 22)]), el('div', {}, [`Visual Inventory ${APP_VERSION}`]), el('div', { class: 'about-sub' }, ['Works offline · data stays on this device'])])
  );

  const sheet = el('div', { class: 'modal-sheet settings-sheet' }, [
    el('div', { class: 'sheet-head' }, [
      el('h2', {}, ['Settings']),
      el('button', { class: 'icon-btn round', title: 'Close', onclick: () => overlay.remove() }, [icon('close')])
    ]),
    body
  ]);
  overlay.appendChild(sheet);
  showOverlay(overlay);

  // #3: manual-only, confirmed reset of all local data.
  async function resetData() {
    if (!confirm('Delete ALL data on this device? This cannot be undone.')) return;
    if (!confirm('Are you absolutely sure? Export a backup first if you have not.')) return;
    try {
      await DB.clearAll();
      clearClipboard();
      overlay.remove();
      resetToHome();
      showToast('All data cleared');
    } catch (err) {
      console.error('Reset failed', err);
      showToast('Reset failed — please try again');
    }
  }

  async function exportAllData() {
    const spinner = showSpinner('Preparing backup…');
    try {
      const data = await DB.exportAll();
      const out = { version: 4, exportedAt: new Date().toISOString(), locations: [], hotspots: data.hotspots, folders: data.folders || [], pages: [], photos: [] };
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
    } catch (err) {
      console.error('Export failed', err);
      showToast('Export failed — please try again');
    } finally { spinner.remove(); }
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
      el('h2', {}, ['Restore data']),
      el('p', { class: 'sheet-sub' }, [`This backup contains ${data.locations?.length || 0} location(s). Merge keeps existing data and adds/updates from the backup. Replace erases current data first.`]),
      el('div', { class: 'btn-row' }, [
        el('button', { class: 'btn secondary', onclick: () => confirmOverlay.remove() }, ['Cancel']),
        el('button', { class: 'btn secondary', onclick: () => doImport(data, 'merge') }, ['Merge']),
        el('button', { class: 'btn danger', onclick: () => doImport(data, 'replace') }, ['Replace all'])
      ])
    ]);
    confirmOverlay.appendChild(confirmSheet);
    showOverlay(confirmOverlay);

    async function doImport(data, mode) {
      const spinner = showSpinner('Restoring…');
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
        await DB.importAll(converted, mode);
        // Robustly close every open modal and land on a freshly-rendered home so the
        // imported locations/hotspots show at once.
        closeAllOverlays(resetToHome);
        showToast(`Restore complete — ${converted.locations.length} location(s), ${converted.hotspots.length} item(s)`);
      } catch (err) {
        console.error('Import failed', err);
        showToast('Import failed: ' + (err && err.message ? err.message : 'unknown error'));
      } finally { spinner.remove(); }
    }
  }
}
// Old name kept for any external callers.
const openBackupModal = openSettings;

// ============ SEARCH ============
function renderSearch() {
  const seq = renderSeq;
  const input = el('input', { type: 'search', placeholder: 'Search name, number, or photo caption…', autocomplete: 'off' });
  const clearBtn = el('button', { class: 'search-clear', title: 'Clear', onclick: () => { input.value = ''; input.focus(); showAllBoxes(); clearBtn.style.visibility = 'hidden'; } }, [icon('close', 16)]);
  clearBtn.style.visibility = 'hidden';
  const header = el('header', { class: 'topbar glass-bar search-top' }, [
    el('button', { class: 'icon-btn round', title: 'Back', onclick: () => history.back() }, [icon('back')]),
    el('div', { class: 'search-field' }, [icon('search', 18), input, clearBtn])
  ]);
  const view = el('div', { class: 'view' }, [header]);
  const resultsEl = el('div', { class: 'search-results' });
  view.appendChild(resultsEl);
  root.appendChild(view);

  let debounceTimer;
  input.addEventListener('input', () => {
    clearBtn.style.visibility = input.value ? 'visible' : 'hidden';
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
  let listSeq = 0;
  async function renderList(records, { hint, query } = {}) {
    const my = ++listSeq;
    const frag = document.createDocumentFragment();
    if (hint) frag.appendChild(el('div', { class: 'search-hint' }, [hint]));
    const q = (query || '').toLowerCase();
    for (const rec of records) {
      const h = rec.hotspot;
      const loc = await locName(h.locationId);
      const photos = await DB.getPhotosForHotspot(h.id);
      if (my !== listSeq || seq !== renderSeq) return; // a newer search replaced this one
      const thumb = el('div', { class: 'srt-thumb' });
      if (photos[0]) thumb.style.backgroundImage = `url(${blobToUrl(photos[0].photo)})`;
      else thumb.appendChild(icon(h.type === 'annotation' ? 'tag' : 'box', 20));
      const locateBtn = el('button', {
        class: 'btn small secondary locate-btn', title: 'Locate on photo',
        onclick: (e) => {
          e.stopPropagation();
          pendingLocate = { locationId: h.locationId, hotspotId: h.id, pulse: true };
          goLocation(h.locationId);
        }
      }, [icon('locate', 16), 'Locate']);
      const srcBadge = rec.source && rec.source !== 'name'
        ? el('span', { class: 'match-badge' }, ['matched ' + rec.source])
        : null;
      const row = el('div', {
        class: 'search-result-item', onclick: () => openHotspotView(h.id)
      }, [
        thumb,
        el('div', { class: 'srt-text' }, [
          el('div', { class: 'name' }, [h.name || '(unnamed)', srcBadge]),
          el('div', { class: 'meta' }, [`#${h.number || '—'} · ${loc ? loc.name : ''}`])
        ]),
        locateBtn
      ]);
      // Photos whose caption matched the query → show them in a grid beneath the row.
      const matchedPhotos = q ? photos.filter(p => (p.caption || '').toLowerCase().includes(q)) : [];
      const children = [row];
      if (matchedPhotos.length) children.push(buildMatchedPhotoGrid(matchedPhotos, photos, h));
      frag.appendChild(el('div', { class: 'search-result-group' }, children));
    }
    if (my !== listSeq) return;
    resultsEl.innerHTML = '';
    resultsEl.appendChild(frag);
  }

  async function runSearch(q) {
    if (!q.trim()) { showAllBoxes(); return; }
    const results = await DB.searchHotspots(q); // [{hotspot, source}]
    if (!results.length) {
      listSeq++;
      resultsEl.innerHTML = '';
      resultsEl.appendChild(el('div', { class: 'empty-state small' }, [el('div', { class: 'empty-art' }, [icon('search', 30)]), el('div', { class: 'empty-text' }, ['No matches found.'])]));
      return;
    }
    renderList(results, { query: q.trim() });
  }

  // Empty search box → list every box/annotation so the user can browse.
  async function showAllBoxes() {
    const all = await DB.getAllHotspots();
    if (!all.length) {
      listSeq++;
      resultsEl.innerHTML = '';
      resultsEl.appendChild(el('div', { class: 'empty-state small' }, [el('div', { class: 'empty-art' }, [icon('box', 30)]), el('div', { class: 'empty-text' }, ['Nothing stored yet. Add boxes inside a location first.'])]));
      return;
    }
    all.sort((a, b) => (a.locationId || '').localeCompare(b.locationId || '') || (b.createdAt || 0) - (a.createdAt || 0));
    renderList(all.map(h => ({ hotspot: h, source: null })), { hint: `All ${all.length} items — type above to filter` });
  }

  setTimeout(() => input.focus(), 50);
  showAllBoxes();
}

function isTypingTarget(t) {
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

// #8 Theme shortcuts.
// Laptop: press the spacebar twice quickly (when not typing in a field) to flip theme.
let lastSpace = 0;
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' && e.key !== ' ') return;
  if (isTypingTarget(e.target)) return; // don't hijack typing
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
  if (isTypingTarget(e.target)) return; // don't hijack typing
  const now = Date.now();
  if (now - lastS < 350) { e.preventDefault(); lastS = 0; openContextSearch(); }
  else lastS = now;
});

// Open the right search surface for wherever the user currently is.
async function openContextSearch() {
  // Don't stack a second search on top of one that's already open.
  if (document.querySelector(OVERLAY_SEL)) return;
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
  // Ignore taps on interactive controls, and anything while a sheet/camera/viewer is open.
  if (e.target && e.target.closest && e.target.closest('button, input, select, textarea, a, .pano-view')) return;
  if (document.querySelector(OVERLAY_SEL)) return;
  const now = Date.now();
  if (now - lastTopTap < 350) { lastTopTap = 0; toggleTheme(); }
  else lastTopTap = now;
});

document.addEventListener('DOMContentLoaded', () => {
  applyTheme(getThemePref());
  state.view = 'home';
  state.locationId = null;
  history.replaceState({ view: 'home', locationId: null }, '');
  render();
  // Ask the browser to keep this app's data even under storage pressure (photos + 360°
  // scenes are the user's only copy). Silently ignored where unsupported.
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
});
