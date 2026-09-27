// ---- Annotation link helpers (#18) ----
// Resolve an array of target hotspot ids to their (still-existing) hotspot records.
async function resolveLinks(ids) {
  const out = [];
  for (const id of (ids || [])) {
    const t = await DB.getHotspot(id);
    if (t) out.push(t);
  }
  return out;
}
// Render a set of linked annotations as an "@Name @Name" string for the References field.
function linksToText(targets) {
  return (targets || []).map(t => '@' + (t.name || '')).join(' ');
}
// Everyone in this location whose links array points AT hotspotId (incoming references).
async function incomingLinks(hotspotId, locationId) {
  const all = await DB.getHotspotsForLocation(locationId);
  return all.filter(h => Array.isArray(h.links) && h.links.includes(hotspotId));
}
// Parse "@Name @Other" free text back into target ids, matching annotation names in the
// location. Used on save so manual edits to the References field stay consistent.
async function parseRefsToIds(text, locationId, selfId) {
  const names = (text.match(/@([^@\s][^@]*?)(?=\s*@|\s*$)/g) || []).map(s => s.slice(1).trim().toLowerCase());
  if (!names.length) return [];
  const all = (await DB.getHotspotsForLocation(locationId)).filter(h => h.type === 'annotation' && h.id !== selfId);
  const ids = [];
  for (const nm of names) {
    const hit = all.find(h => (h.name || '').toLowerCase() === nm) || all.find(h => (h.name || '').toLowerCase().includes(nm));
    if (hit && !ids.includes(hit.id)) ids.push(hit.id);
  }
  return ids;
}

// Suggest the next box number for a location: find the highest integer that appears in any
// existing box hotspot's Number/Label, and add 1 (so "Box 12" → suggests "13", plain "4" →
// "5"). Returns "1" for the first box. The user can freely overwrite the pre-filled value.
async function suggestNextNumber(locationId) {
  const all = await DB.getHotspotsForLocation(locationId);
  let max = 0;
  for (const h of all) {
    if (h.type === 'annotation') continue;
    // Take the LAST run of digits in the number/label (handles "Box 12", "A-7", "5").
    const nums = String(h.number || '').match(/\d+/g);
    if (nums && nums.length) max = Math.max(max, parseInt(nums[nums.length - 1], 10));
  }
  return String(max + 1);
}

// Copy a hotspot to the app clipboard so it can be pasted (moved or duplicated) in any
// location — including a different store.
function copyHotspot(h, locName, btn) {
  const c = setClipboard(h, locName);
  showToast(`Copied “${clipLabel(c)}” — open any location and tap Paste`, 3200);
  if (btn) {
    btn.classList.add('done');
    btn.innerHTML = '';
    btn.append(icon('check', 18), el('span', {}, ['Copied']));
  }
  // Refresh the location screen behind the sheet so its dock shows Paste right away.
  if (state.view === 'location') render();
}
function copyButton(h, locName) {
  const b = el('button', { class: 'pill-btn', title: 'Copy — paste it in any location', onclick: () => copyHotspot(h, locName, b) }, [icon('copy', 18), el('span', {}, ['Copy'])]);
  return b;
}

function openHotspotForm({ locationId, pageId, x, y, type, onSaved }) {
  const overlay = el('div', { class: 'modal-overlay detail-popup' });
  const isAnno = type === 'annotation';
  const nameInput = el('input', { type: 'text', placeholder: isAnno ? 'e.g. CO2 relay' : 'e.g. Bearing spares' });
  const numberInput = el('input', { type: 'text', placeholder: 'e.g. Box 12' });
  // Pre-fill the next available box number by default (user can edit it). Async — fills in
  // as soon as the existing hotspots are read; leaves the field empty on failure.
  if (!isAnno) {
    suggestNextNumber(locationId).then(n => { if (!numberInput.value) numberInput.value = n; }).catch(() => {});
  }
  const descInput = el('textarea', { placeholder: 'Description / notes…' });
  // #18/#19: annotations get a "References" field that links to OTHER annotations by
  // "@name". Typing @ pops an autocomplete of matching annotation names.
  const refInput = isAnno ? el('input', { type: 'text', placeholder: 'Reference other annotations with @name…' }) : null;
  let linkState = { links: [] };
  if (isAnno) attachAtAutocomplete(refInput, overlay, locationId, linkState);

  async function saveHotspot() {
    const h = await DB.addHotspot({
      locationId, pageId, x, y, type,
      name: nameInput.value.trim(),
      number: isAnno ? '' : numberInput.value.trim(),
      description: descInput.value.trim(),
      links: isAnno ? linkState.links.slice() : []
    });
    onSaved && onSaved(h);
    return h;
  }

  const fields = [el('div', { class: 'field' }, [el('label', {}, ['Name']), nameInput])];
  if (!isAnno) fields.push(el('div', { class: 'field' }, [el('label', {}, ['Number / label']), numberInput]));
  fields.push(el('div', { class: 'field' }, [el('label', {}, ['Description']), descInput]));
  if (isAnno) fields.push(el('div', { class: 'field' }, [el('label', {}, ['References (@ other annotations)']), refInput]));

  const sheet = el('div', { class: 'modal-sheet' }, [
    el('div', { class: 'sheet-grabber' }),
    el('h2', {}, [isAnno ? 'New annotation' : 'New box']),
    ...fields,
    el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn secondary', onclick: () => overlay.remove() }, ['Cancel']),
      el('button', {
        class: 'btn secondary', onclick: async () => {
          const h = await saveHotspot();
          reuseOverlayAsDetail(overlay, h.id, { openPhotos: true });
        }
      }, [icon('camera', 18), 'Photos']),
      el('button', {
        class: 'btn', onclick: async () => {
          const h = await saveHotspot();
          reuseOverlayAsDetail(overlay, h.id);
        }
      }, ['Save'])
    ])
  ]);
  overlay.appendChild(sheet);
  showOverlay(overlay);
  nameInput.focus();
}

// #18/#19: "@name" autocomplete for annotation references. As the user types "@partial",
// show a scrollable popup of matching annotation names in the SAME location (excluding the
// one being edited). Selecting one appends "@Name" to the field and records the target id
// in linkState.links. Duplicate names are disambiguated by showing their description.
function attachAtAutocomplete(input, overlay, locationId, linkState, selfId) {
  let pop = null;
  function closePop() { if (pop) { pop.remove(); pop = null; } }

  async function refresh() {
    const val = input.value;
    const at = val.lastIndexOf('@');
    if (at < 0) { closePop(); return; }
    const frag = val.slice(at + 1).toLowerCase();
    const all = (await DB.getHotspotsForLocation(locationId)).filter(h => h.type === 'annotation' && h.id !== selfId);
    const matches = all.filter(h => (h.name || '').toLowerCase().includes(frag)).slice(0, 8);
    closePop();
    if (!matches.length) return;
    pop = el('div', { class: 'at-suggest' }, matches.map(m =>
      el('div', {
        class: 'at-item', onclick: () => {
          // Replace the "@frag" the user was typing with the chosen "@Name".
          input.value = val.slice(0, at) + '@' + (m.name || '') + ' ';
          if (!linkState.links.includes(m.id)) linkState.links.push(m.id);
          closePop();
          input.focus();
        }
      }, [
        el('div', { class: 'at-name' }, ['@' + (m.name || '(unnamed)')]),
        m.description ? el('div', { class: 'at-desc' }, [m.description]) : null
      ])
    ));
    // Position the popup ABOVE the input (#19: popup appears above), inside the sheet.
    input.parentElement.appendChild(pop);
  }
  input.addEventListener('input', refresh);
  input.addEventListener('blur', () => setTimeout(closePop, 200));
}

// Turn the just-used new-hotspot overlay into the hotspot detail view IN PLACE, reusing
// the same DOM node and the same single history entry. This avoids the history-cascade
// that used to make the freshly-created hotspot's popup vanish.
async function reuseOverlayAsDetail(overlay, hotspotId, opts = {}) {
  overlay.classList.add('centered', 'detail-popup');
  await renderHotspotDetailInto(overlay, hotspotId);
  if (opts.openPhotos) {
    const sheet = overlay.querySelector('.modal-sheet');
    const addBtn = sheet && sheet.querySelector('[data-role="add-photos"]');
    if (addBtn) addBtn.click();
  }
}

async function openHotspotDetail(hotspotId) {
  const overlay = el('div', { class: 'modal-overlay centered detail-popup' });
  overlay.appendChild(el('div', { class: 'modal-sheet' }));
  showOverlay(overlay);
  await renderHotspotDetailInto(overlay, hotspotId);
}

function typeBadgeFor(h) {
  const isAnno = h.type === 'annotation';
  return el('span', { class: 'type-badge ' + (isAnno ? 'anno' : 'box') }, [icon(isAnno ? 'tag' : 'box', 12), isAnno ? 'Annotation' : 'Box']);
}

// Render the editable hotspot detail (Name/Number/Description/Photos + Close/Delete/Save)
// into an existing overlay. Used both by openHotspotDetail and by the new-hotspot form
// once it saves (so the description carries straight over).
async function renderHotspotDetailInto(overlay, hotspotId) {
  const h = await DB.getHotspot(hotspotId);
  if (!h) return;
  const loc = await DB.getLocation(h.locationId);

  const sheet = overlay.querySelector('.modal-sheet');

  await renderDetailBody();

  async function renderDetailBody() {
    sheet.innerHTML = '';
    const isAnno = h.type === 'annotation';
    const photos = await DB.getPhotosForHotspot(h.id);

    const nameInput = el('input', { type: 'text', value: h.name });
    const numberInput = el('input', { type: 'text', value: h.number });
    const descInput = el('textarea', { value: h.description });
    const refInput = isAnno ? el('input', { type: 'text', value: linksToText(await resolveLinks(h.links)) }) : null;
    const linkState = { links: (h.links || []).slice() };
    if (isAnno) attachAtAutocomplete(refInput, overlay, h.locationId, linkState, h.id);

    const photoGrid = el('div', { class: 'photo-grid' });
    photos.forEach((p, idx) => {
      const thumb = el('div', {
        class: 'photo-thumb', onclick: () => openPhotoViewer(photos, idx, h.id, renderDetailBody)
      }, [
        el('img', { src: blobToUrl(p.photo) }),
        p.caption ? el('div', { class: 'cap-badge' }, [p.caption]) : null
      ]);
      photoGrid.appendChild(thumb);
    });

    sheet.appendChild(el('div', { class: 'view-header' }, [
      el('div', { class: 'vh-title' }, [el('h2', {}, [loc ? loc.name : '']), typeBadgeFor(h)]),
      copyButton(h, loc ? loc.name : '')
    ]));
    sheet.appendChild(el('div', { class: 'field' }, [el('label', {}, ['Name']), nameInput]));
    if (!isAnno) sheet.appendChild(el('div', { class: 'field' }, [el('label', {}, ['Number / label']), numberInput]));
    sheet.appendChild(el('div', { class: 'field' }, [el('label', {}, ['Description']), descInput]));

    if (isAnno) {
      sheet.appendChild(el('div', { class: 'field' }, [el('label', {}, ['References (@ other annotations)']), refInput]));
      // #18: outgoing = where THIS annotation points ("goes to"); incoming = who points AT
      // this one ("comes from"). Tapping a chip locates that annotation on the diagram.
      const outgoing = await resolveLinks(h.links);
      const incoming = await incomingLinks(h.id, h.locationId);
      if (incoming.length) sheet.appendChild(linkChips('Comes from', incoming));
      if (outgoing.length) sheet.appendChild(linkChips('Goes to', outgoing));
    }

    sheet.appendChild(el('div', { class: 'section-title' }, [`Photos (${photos.length})`]));
    if (photos.length) sheet.appendChild(photoGrid);

    const addPhotosBtn = el('button', { 'data-role': 'add-photos', class: 'btn secondary block', onclick: () => addPhotosFlow(h.id, renderDetailBody) }, [icon('camera', 18), 'Add photos']);
    sheet.appendChild(el('div', { class: 'field' }, [addPhotosBtn]));

    async function persistFields() {
      h.name = nameInput.value.trim();
      h.number = isAnno ? '' : numberInput.value.trim();
      h.description = descInput.value.trim();
      // Reconcile links from the visible "@Name" text so manual edits are honoured.
      if (isAnno) h.links = await parseRefsToIds(refInput.value, h.locationId, h.id);
      await DB.updateHotspot(h);
    }
    overlay.__persist = persistFields; // showOverlay's backdrop-close will flush this

    // A stack of tappable link rows; each shows the linked annotation's @name AND its
    // description (so you get a clear picture). Tapping closes this popup and locates that
    // annotation on the diagram (red pulsing ring).
    function linkChips(label, targets) {
      return el('div', { class: 'field' }, [
        el('label', {}, [label]),
        el('div', { class: 'link-list' }, targets.map(t =>
          el('button', {
            class: 'link-row', onclick: () => { overlay.remove(); setTimeout(() => locateHotspotOnCanvas(t.id, t.locationId), 30); }
          }, [
            el('div', { class: 'link-row-name' }, ['@' + (t.name || '(unnamed)')]),
            t.description ? el('div', { class: 'link-row-desc' }, [t.description]) : null
          ])
        ))
      ]);
    }

    sheet.appendChild(el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn secondary', onclick: () => overlay.remove() }, ['Close']),
      el('button', {
        class: 'btn danger', title: 'Delete', onclick: async () => {
          if (confirm('Delete this item and all its photos?')) {
            overlay.__persist = null; // don't write a deleted record back on close
            await DB.deleteHotspot(h.id);
            overlay.remove();
            render();
          }
        }
      }, [icon('trash', 18)]),
      el('button', {
        class: 'btn', onclick: async () => {
          overlay.__persist = null;
          await persistFields();
          overlay.remove();
          render();
          showToast('Saved');
        }
      }, ['Save'])
    ]));
  }
}

// Read-only "nice card" view of a hotspot — used when tapping a marker with the Add
// toggle OFF, and from Search. Shows Name/Number/Description/Photos with Copy and Close (✕).
// No editable fields, no Save, no Delete (#2).
async function openHotspotView(hotspotId) {
  const h = await DB.getHotspot(hotspotId);
  if (!h) return;
  const loc = await DB.getLocation(h.locationId);
  const photos = await DB.getPhotosForHotspot(h.id);

  const overlay = el('div', { class: 'modal-overlay centered detail-popup' });

  const photoGrid = el('div', { class: 'photo-grid' });
  photos.forEach((p, idx) => {
    photoGrid.appendChild(el('div', {
      class: 'photo-thumb', onclick: () => openPhotoViewer(photos, idx, h.id, null, { readOnly: true })
    }, [
      el('img', { src: blobToUrl(p.photo) }),
      p.caption ? el('div', { class: 'cap-badge' }, [p.caption]) : null
    ]));
  });

  const header = el('div', { class: 'view-header' }, [
    el('div', { class: 'vh-title' }, [el('h2', {}, [loc ? loc.name : '']), typeBadgeFor(h)]),
    el('div', { class: 'vh-actions' }, [
      copyButton(h, loc ? loc.name : ''),
      el('button', { class: 'icon-btn round view-close', title: 'Close', onclick: () => overlay.remove() }, [icon('close', 20)])
    ])
  ]);

  const isAnno = h.type === 'annotation';
  const rows = [
    header,
    el('div', { class: 'view-hero' }, [
      el('div', { class: 'vh-name' }, [h.name || '(unnamed)']),
      !isAnno && h.number ? el('div', { class: 'vh-number' }, ['#' + h.number]) : null
    ])
  ];
  if (h.description) rows.push(el('div', { class: 'view-row col' }, [el('span', { class: 'view-label' }, ['Description']), el('div', { class: 'view-val' }, [h.description])]));

  // #18: link chips for annotations. "Comes from" = who references this; "Goes to" = what
  // this references. Tapping a chip locates that annotation on the diagram.
  if (isAnno) {
    const outgoing = await resolveLinks(h.links);
    const incoming = await incomingLinks(h.id, h.locationId);
    const chip = (label, targets) => el('div', { class: 'view-row col' }, [
      el('span', { class: 'view-label' }, [label]),
      el('div', { class: 'link-list' }, targets.map(t =>
        el('button', { class: 'link-row', onclick: () => { overlay.remove(); setTimeout(() => locateHotspotOnCanvas(t.id, t.locationId), 30); } }, [
          el('div', { class: 'link-row-name' }, ['@' + (t.name || '(unnamed)')]),
          t.description ? el('div', { class: 'link-row-desc' }, [t.description]) : null
        ])
      ))
    ]);
    if (incoming.length) rows.push(chip('Comes from', incoming));
    if (outgoing.length) rows.push(chip('Goes to', outgoing));
  }

  rows.push(el('div', { class: 'section-title' }, ['Photos (' + photos.length + ')']));
  rows.push(photos.length ? photoGrid : el('div', { class: 'view-val muted' }, ['No photos']));

  const sheet = el('div', { class: 'modal-sheet' }, rows);
  overlay.appendChild(sheet);
  showOverlay(overlay);
}

async function addPhotosFlow(hotspotId, onDone) {
  let count = 0;
  await addOne();

  async function addOne() {
    const files = await pickImageWithChoice({ multiple: true });
    if (!files.length) { finish(); return; }
    // Instant add: store each picked file straight away (no wait), then compress it in the
    // background and swap the stored blob in place. No blocking spinner.
    const added = [];
    try {
      let order = (await DB.getPhotosForHotspot(hotspotId)).length; // read the base order once
      for (const file of files) {
        const p = await addPhotoInstant(file, {
          save: (blob) => DB.addPhoto({ hotspotId, photo: blob, order: order++ }),
          replace: (rec, small) => { rec.photo = small; return DB.updatePhoto(rec); }
        });
        added.push(p);
        count++;
      }
    } catch (err) {
      console.error('Add photo failed', err);
      showToast('Could not add that photo — please try again');
    }
    // Caption each newly-added photo one by one (OK saves, Cancel skips), then ask for more.
    for (const p of added) {
      await promptCaption(p);
    }
    askMore();
  }

  // Inline caption prompt shown right after a photo is added: a preview + a text box with
  // OK / Cancel. OK stores the caption immediately; Cancel leaves it blank.
  function promptCaption(photo) {
    return new Promise((resolve) => {
      const overlay = el('div', { class: 'modal-overlay centered' });
      const input = el('input', { type: 'text', placeholder: 'Caption for this photo (optional)…', value: photo.caption || '' });
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      overlay.__onClose = done; // Back / tap-outside must not leave the flow hanging
      async function ok() {
        photo.caption = input.value.trim();
        try { await DB.updatePhoto(photo); } catch (err) { console.error(err); }
        overlay.remove();
        done();
      }
      const sheet = el('div', { class: 'modal-sheet' }, [
        el('h2', {}, ['Add caption']),
        el('div', { class: 'caption-preview' }, [el('img', { src: blobToUrl(photo.photo) })]),
        el('div', { class: 'field' }, [input]),
        el('div', { class: 'btn-row' }, [
          el('button', { class: 'btn secondary', onclick: () => { overlay.remove(); done(); } }, ['Skip']),
          el('button', { class: 'btn', onclick: ok }, ['OK'])
        ])
      ]);
      // Enter key = OK.
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
      overlay.appendChild(sheet);
      showOverlay(overlay);
      setTimeout(() => input.focus(), 50);
    });
  }

  function askMore() {
    const overlay = el('div', { class: 'modal-overlay centered' });
    let chosen = false;
    overlay.__onClose = () => { if (!chosen) { chosen = true; finish(); } };
    const sheet = el('div', { class: 'modal-sheet' }, [
      el('h2', {}, [`Added ${count} photo${count === 1 ? '' : 's'}`]),
      el('p', { class: 'sheet-sub' }, ['Add another photo, or finish here.']),
      el('div', { class: 'btn-row' }, [
        el('button', { class: 'btn secondary', onclick: () => { chosen = true; overlay.remove(); addOne(); } }, [icon('plus', 18), 'Add more']),
        el('button', { class: 'btn', onclick: () => { chosen = true; overlay.remove(); finish(); } }, ['Done'])
      ])
    ]);
    overlay.appendChild(sheet);
    showOverlay(overlay);
  }

  function finish() {
    onDone && onDone();
  }
}

// Full-screen photo viewer. Transform-based carousel so one swipe = exactly one image
// (a fast flick can never skip past several photos). Each photo can be zoomed:
//   • pinch with two fingers (zooms around the fingers), drag to pan while zoomed
//   • double-tap to zoom in on that spot / double-tap again to fit
//   • mouse wheel or +/− keys on desktop
// Swiping to the next photo only happens at normal size, so panning never flips photos.
// Pass opts.readOnly to hide edit/delete.
function openPhotoViewer(photos, startIdx, hotspotId, onChange, opts = {}) {
  const readOnly = !!opts.readOnly;
  const MAX_ZOOM = 6;
  let index = Math.max(0, Math.min(startIdx, photos.length - 1));

  const overlay = el('div', { class: 'photo-viewer-overlay' });

  const viewport = el('div', { class: 'photo-viewer-viewport' });
  const track = el('div', { class: 'photo-viewer-track' });
  const slides = photos.map(p => {
    const img = el('img', { src: blobToUrl(p.photo), draggable: 'false' });
    const s = el('div', { class: 'slide' }, [img]);
    track.appendChild(s);
    return { el: s, img };
  });
  viewport.appendChild(track);

  const counter = el('div', { class: 'photo-viewer-counter' });
  const zoomBadge = el('button', { class: 'zoom-badge glass', title: 'Reset zoom', onclick: () => resetZoom(true) });

  const header = el('div', { class: 'photo-viewer-header' }, [
    el('button', { class: 'pv-btn glass', title: 'Close', onclick: () => close() }, [icon('close', 22)]),
    counter,
    readOnly
      ? el('span', { style: 'width:44px;display:inline-block;' })
      : el('button', { class: 'pv-btn glass', title: 'Delete photo', onclick: deleteCurrent }, [icon('trash', 20)])
  ]);

  const captionWrap = el('div', { class: 'photo-viewer-caption' });
  let captionInput = null, captionText = null;
  if (readOnly) {
    captionText = el('div', { class: 'caption-text' });
    captionWrap.appendChild(captionText);
  } else {
    captionInput = el('input', { type: 'text', placeholder: 'Add a caption for this photo…', class: 'caption-input' });
    captionWrap.appendChild(captionInput);
    // Auto-save the caption whenever the user leaves the field — by pressing Enter,
    // by tapping anywhere outside it (blur), by swiping to another photo, or by
    // closing the viewer. No explicit "save"/Enter is required.
    let lastSaved = '';
    async function saveCaption() {
      const p = photos[index];
      if (!p) return;
      const val = captionInput.value.trim();
      if (val === (p.caption || '') && val === lastSaved) return; // nothing changed
      p.caption = val;
      lastSaved = val;
      await DB.updatePhoto(p);
      onChange && onChange();
    }
    captionInput.__save = saveCaption; // let goTo()/close() flush before switching photo
    captionInput.addEventListener('change', saveCaption);
    captionInput.addEventListener('blur', saveCaption);
  }

  overlay.appendChild(header);
  overlay.appendChild(viewport);
  overlay.appendChild(zoomBadge);
  overlay.appendChild(captionWrap);
  showOverlay(overlay);

  // ---- zoom state of the current photo ----
  let z = { s: 1, tx: 0, ty: 0 };
  function curImg() { return slides[index] && slides[index].img; }
  function fitRect() {
    const img = curImg();
    return img ? { fx: img.offsetLeft, fy: img.offsetTop, fw: img.offsetWidth || 1, fh: img.offsetHeight || 1, W: viewport.clientWidth, H: viewport.clientHeight } : null;
  }
  // Keep the zoomed photo covering the screen (or centred when smaller than it).
  function clampZoom() {
    const r = fitRect();
    if (!r) return;
    z.s = Math.max(1, Math.min(MAX_ZOOM, z.s));
    const dw = r.fw * z.s, dh = r.fh * z.s;
    z.tx = dw <= r.W ? (r.W - dw) / 2 - r.fx : Math.min(-r.fx, Math.max(r.W - r.fx - dw, z.tx));
    z.ty = dh <= r.H ? (r.H - dh) / 2 - r.fy : Math.min(-r.fy, Math.max(r.H - r.fy - dh, z.ty));
  }
  function applyZoom(animate) {
    const img = curImg();
    if (!img) return;
    img.style.transition = animate ? 'transform 0.26s cubic-bezier(0.22,0.61,0.36,1)' : 'none';
    img.style.transform = z.s > 1.001 ? `translate3d(${z.tx}px, ${z.ty}px, 0) scale(${z.s})` : '';
    const zoomed = z.s > 1.01;
    overlay.classList.toggle('zoomed', zoomed);
    zoomBadge.textContent = zoomed ? z.s.toFixed(1) + '×' : '';
  }
  // Zoom to scale s keeping viewport point (px, py) fixed on the photo.
  function zoomAt(s, px, py, animate) {
    const r = fitRect();
    if (!r) return;
    const q = { x: (px - r.fx - z.tx) / z.s, y: (py - r.fy - z.ty) / z.s };
    z.s = Math.max(1, Math.min(MAX_ZOOM, s));
    z.tx = px - r.fx - q.x * z.s;
    z.ty = py - r.fy - q.y * z.s;
    clampZoom();
    applyZoom(animate);
  }
  function resetZoom(animate) { z = { s: 1, tx: 0, ty: 0 }; applyZoom(animate); }

  function layout() {
    const w = viewport.clientWidth;
    slides.forEach(s => { s.el.style.width = w + 'px'; });
    setTransform(false);
    if (z.s > 1) { clampZoom(); applyZoom(false); }
  }
  function setTransform(animate) {
    const w = viewport.clientWidth;
    track.style.transition = animate ? 'transform 0.28s cubic-bezier(0.22,0.61,0.36,1)' : 'none';
    track.style.transform = `translate3d(${-index * w}px, 0, 0)`;
  }
  function sync() {
    const p = photos[index];
    if (readOnly) captionText.textContent = p && p.caption ? p.caption : '';
    else if (captionInput) captionInput.value = p ? (p.caption || '') : '';
    counter.textContent = photos.length ? (index + 1) + ' / ' + photos.length : '';
  }
  function goTo(i, animate = true) {
    // Save the current photo's caption before moving to the next one.
    if (captionInput && captionInput.__save) captionInput.__save();
    const next = Math.max(0, Math.min(i, photos.length - 1));
    if (next !== index) resetZoom(false);
    index = next;
    setTransform(animate);
    sync();
  }

  // ---- gestures ----
  const pts = new Map();
  let mode = null;          // 'swipe' | 'pan' | 'pinch'
  let start = null, lastTap = null, moved = false;
  const vpPoint = (e) => { const r = viewport.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

  viewport.addEventListener('pointerdown', (e) => {
    try { viewport.setPointerCapture(e.pointerId); } catch (err) {}
    pts.set(e.pointerId, vpPoint(e));
    if (pts.size === 1) {
      const p = pts.get(e.pointerId);
      moved = false;
      mode = z.s > 1.01 ? 'pan' : 'swipe';
      start = { x: p.x, y: p.y, tx: z.tx, ty: z.ty, t: Date.now() };
      track.style.transition = 'none';
    } else if (pts.size === 2) {
      if (mode === 'swipe') setTransform(true); // cancel a half-done swipe
      const [a, b] = Array.from(pts.values());
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, r = fitRect();
      mode = 'pinch'; moved = true;
      start = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, s: z.s, q: { x: (mid.x - r.fx - z.tx) / z.s, y: (mid.y - r.fy - z.ty) / z.s } };
    }
  });
  viewport.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, vpPoint(e));
    if (mode === 'pinch' && pts.size >= 2) {
      const [a, b] = Array.from(pts.values());
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, r = fitRect();
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      z.s = Math.max(0.85, Math.min(MAX_ZOOM * 1.15, start.s * dist / start.dist)); // a little give past the limits
      z.tx = mid.x - r.fx - start.q.x * z.s;
      z.ty = mid.y - r.fy - start.q.y * z.s;
      applyZoom(false);
      return;
    }
    const p = pts.get(e.pointerId);
    const dx = p.x - start.x, dy = p.y - start.y;
    if (Math.hypot(dx, dy) > 6) moved = true;
    if (mode === 'pan') {
      z.tx = start.tx + dx; z.ty = start.ty + dy;
      clampZoom();
      applyZoom(false);
    } else if (mode === 'swipe') {
      const w = viewport.clientWidth;
      let d = dx;
      if ((index === 0 && d > 0) || (index === photos.length - 1 && d < 0)) d *= 0.35; // edge resistance
      track.style.transform = `translate3d(${-index * w + d}px, 0, 0)`;
    }
  });
  function endPointer(e) {
    if (!pts.has(e.pointerId)) return;
    const p = pts.get(e.pointerId);
    pts.delete(e.pointerId);
    if (mode === 'pinch') {
      if (pts.size === 1) { // continue panning with the remaining finger
        const q = Array.from(pts.values())[0];
        clampZoom(); applyZoom(true);
        mode = z.s > 1.01 ? 'pan' : null;
        start = { x: q.x, y: q.y, tx: z.tx, ty: z.ty, t: Date.now() };
        return;
      }
      if (pts.size === 0) { if (z.s < 1.02) resetZoom(true); else { clampZoom(); applyZoom(true); } mode = null; }
      return;
    }
    if (pts.size) return;
    if (mode === 'swipe') {
      const dx = p.x - start.x, w = viewport.clientWidth, threshold = Math.min(w * 0.18, 70);
      if (moved && dx <= -threshold) goTo(index + 1);
      else if (moved && dx >= threshold) goTo(index - 1);
      else goTo(index);
    }
    // Double-tap: zoom in 2.5× on the spot, or back out to fit.
    if (!moved) {
      const now = Date.now();
      if (lastTap && now - lastTap.t < 320 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 36) {
        if (z.s > 1.01) resetZoom(true); else zoomAt(2.5, p.x, p.y, true);
        lastTap = null;
      } else lastTap = { x: p.x, y: p.y, t: now };
    }
    mode = null;
  }
  viewport.addEventListener('pointerup', endPointer);
  viewport.addEventListener('pointercancel', endPointer);
  viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = vpPoint(e);
    zoomAt(z.s * (e.deltaY < 0 ? 1.18 : 1 / 1.18), p.x, p.y, false);
  }, { passive: false });

  const keyHandler = (e) => {
    if (e.target === captionInput) return;
    if (e.key === 'ArrowRight' && z.s <= 1.01) goTo(index + 1);
    else if (e.key === 'ArrowLeft' && z.s <= 1.01) goTo(index - 1);
    else if (e.key === '+' || e.key === '=') zoomAt(z.s * 1.4, viewport.clientWidth / 2, viewport.clientHeight / 2, true);
    else if (e.key === '-') zoomAt(z.s / 1.4, viewport.clientWidth / 2, viewport.clientHeight / 2, true);
    else if (e.key === '0') resetZoom(true);
    else if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', keyHandler);
  window.addEventListener('resize', layout);

  // Cleanup that must run no matter HOW the viewer closes (✕ button, Escape, or a hardware
  // Back press that popstate handles directly). popstate calls __onClose before removing.
  let cleaned = false;
  function cleanup() {
    if (cleaned) return; cleaned = true;
    if (captionInput && captionInput.__save) captionInput.__save(); // flush pending caption
    document.removeEventListener('keydown', keyHandler);
    window.removeEventListener('resize', layout);
  }
  overlay.__onClose = cleanup;

  async function close() {
    if (captionInput && captionInput.__save) await captionInput.__save(); // flush pending caption
    cleanup();
    overlay.remove();
  }

  async function deleteCurrent() {
    if (!confirm('Delete this photo?')) return;
    await DB.deletePhoto(photos[index].id);
    photos.splice(index, 1);
    onChange && onChange();
    if (!photos.length) { close(); return; }
    slides[index].el.remove();
    slides.splice(index, 1);
    if (index >= photos.length) index = photos.length - 1;
    resetZoom(false);
    layout();
    sync();
  }

  requestAnimationFrame(() => { layout(); sync(); });
}
