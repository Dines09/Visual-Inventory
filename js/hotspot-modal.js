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

  const fields = [ el('div', { class: 'field' }, [el('label', {}, ['Name']), nameInput]) ];
  if (!isAnno) fields.push(el('div', { class: 'field' }, [el('label', {}, ['Number / Label']), numberInput]));
  fields.push(el('div', { class: 'field' }, [el('label', {}, ['Description']), descInput]));
  if (isAnno) fields.push(el('div', { class: 'field' }, [el('label', {}, ['References (@ other annotations)']), refInput]));

  const sheet = el('div', { class: 'modal-sheet' }, [
    el('h2', {}, [isAnno ? 'New Annotation' : 'New Hotspot']),
    ...fields,
    el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn secondary', onclick: () => overlay.remove() }, ['Cancel']),
      el('button', {
        class: 'btn secondary', onclick: async () => {
          const h = await saveHotspot();
          reuseOverlayAsDetail(overlay, h.id, { openPhotos: true });
        }
      }, ['+ Add Photos']),
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

async function openHotspotDetail(hotspotId, opts = {}) {
  const overlay = el('div', { class: 'modal-overlay centered detail-popup' });
  overlay.appendChild(el('div', { class: 'modal-sheet' }));
  showOverlay(overlay);
  await renderHotspotDetailInto(overlay, hotspotId);
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

    const typeBadge = el('span', {
      class: 'type-badge ' + (isAnno ? 'anno' : 'box')
    }, [isAnno ? 'ANNOTATION' : 'BOX HOTSPOT']);
    sheet.appendChild(el('h2', {}, [loc ? loc.name : '', typeBadge]));
    sheet.appendChild(el('div', { class: 'field' }, [el('label', {}, ['Name']), nameInput]));
    if (!isAnno) sheet.appendChild(el('div', { class: 'field' }, [el('label', {}, ['Number / Label']), numberInput]));
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

    sheet.appendChild(el('div', { class: 'section-title', style: 'padding-left:0;' }, ['Photos']));
    sheet.appendChild(photoGrid);

    const addPhotosBtn = el('button', { 'data-role': 'add-photos', class: 'btn secondary', onclick: () => addPhotosFlow(h.id, renderDetailBody) }, ['+ Add Photos']);
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
        class: 'btn danger', onclick: async () => {
          if (confirm('Delete this hotspot and all its photos?')) {
            overlay.__persist = null; // don't write a deleted record back on close
            await DB.deleteHotspot(h.id);
            overlay.remove();
            render();
          }
        }
      }, ['Delete']),
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
// toggle OFF, and from Search. Shows Name/Number/Description/Photos and a single Close
// button only. No editable fields, no Save, no Delete (#2).
async function openHotspotView(hotspotId) {
  const h = await DB.getHotspot(hotspotId);
  if (!h) return;
  const loc = await DB.getLocation(h.locationId);
  const photos = await DB.getPhotosForHotspot(h.id);

  const overlay = el('div', { class: 'modal-overlay centered detail-popup' });

  const typeBadge = el('span', {
    class: 'type-badge ' + (h.type === 'annotation' ? 'anno' : 'box')
  }, [h.type === 'annotation' ? 'ANNOTATION' : 'BOX HOTSPOT']);

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
    el('h2', { style: 'margin:0;' }, [loc ? loc.name : '', typeBadge]),
    el('button', { class: 'icon-btn view-close', title: 'Close', onclick: () => overlay.remove() }, ['✕'])
  ]);

  const isAnno = h.type === 'annotation';
  const rows = [
    header,
    el('div', { class: 'view-row' }, [el('span', { class: 'view-label' }, ['Name']), el('span', { class: 'view-val' }, [h.name || '—'])])
  ];
  // Annotations show Description (no Number). Boxes keep Number.
  if (!isAnno) rows.push(el('div', { class: 'view-row' }, [el('span', { class: 'view-label' }, ['Number']), el('span', { class: 'view-val' }, [h.number || '—'])]));
  rows.push(el('div', { class: 'view-row col' }, [el('span', { class: 'view-label' }, ['Description']), el('div', { class: 'view-val' }, [h.description || '—'])]));

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

  rows.push(el('div', { class: 'section-title', style: 'padding-left:0;' }, ['Photos (' + photos.length + ')']));
  rows.push(photos.length ? photoGrid : el('div', { class: 'view-val', style: 'opacity:0.6;padding:4px 0;' }, ['No photos']));

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
      async function ok() {
        photo.caption = input.value.trim();
        try { await DB.updatePhoto(photo); } catch (err) { console.error(err); }
        overlay.remove();
        resolve();
      }
      const sheet = el('div', { class: 'modal-sheet' }, [
        el('h2', {}, ['Add caption']),
        el('div', { class: 'caption-preview' }, [el('img', { src: blobToUrl(photo.photo) })]),
        el('div', { class: 'field' }, [input]),
        el('div', { class: 'btn-row' }, [
          el('button', { class: 'btn secondary', onclick: () => { overlay.remove(); resolve(); } }, ['Cancel']),
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
    const sheet = el('div', { class: 'modal-sheet' }, [
      el('h2', {}, [`Added ${count} photo${count === 1 ? '' : 's'}`]),
      el('p', {}, ['Add another photo, or finish here.']),
      el('div', { class: 'btn-row' }, [
        el('button', { class: 'btn secondary', onclick: () => { overlay.remove(); addOne(); } }, ['+ Add More']),
        el('button', { class: 'btn', onclick: () => { overlay.remove(); finish(); } }, ['Done'])
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
// (a fast flick can never skip past several photos). Pass opts.readOnly to hide edit/delete.
function openPhotoViewer(photos, startIdx, hotspotId, onChange, opts = {}) {
  const readOnly = !!opts.readOnly;
  let index = Math.max(0, Math.min(startIdx, photos.length - 1));

  const overlay = el('div', { class: 'photo-viewer-overlay' });

  const viewport = el('div', { class: 'photo-viewer-viewport' });
  const track = el('div', { class: 'photo-viewer-track' });
  photos.forEach(p => {
    track.appendChild(el('div', { class: 'slide' }, [el('img', { src: blobToUrl(p.photo), draggable: 'false' })]));
  });
  viewport.appendChild(track);

  const counter = el('div', { class: 'photo-viewer-counter' });

  const header = el('div', { class: 'photo-viewer-header' }, [
    el('button', { class: 'icon-btn', style: 'color:#fff', onclick: () => close() }, ['✕']),
    counter,
    readOnly
      ? el('span', { style: 'width:44px;display:inline-block;' })
      : el('button', { class: 'icon-btn', style: 'color:#fff', onclick: deleteCurrent }, ['🗑'])
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
  overlay.appendChild(captionWrap);
  showOverlay(overlay);

  function layout() {
    const w = viewport.clientWidth;
    Array.from(track.children).forEach(s => { s.style.width = w + 'px'; });
    setTransform(false);
  }
  function setTransform(animate) {
    const w = viewport.clientWidth;
    track.style.transition = animate ? 'transform 0.28s cubic-bezier(0.22,0.61,0.36,1)' : 'none';
    track.style.transform = `translateX(${-index * w}px)`;
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
    index = Math.max(0, Math.min(i, photos.length - 1));
    setTransform(animate);
    sync();
  }

  // Swipe: one gesture moves at most one image, based on distance dragged.
  let startX = 0, dragging = false, dragDx = 0;
  viewport.addEventListener('pointerdown', (e) => {
    dragging = true; startX = e.clientX; dragDx = 0;
    viewport.setPointerCapture(e.pointerId);
    track.style.transition = 'none';
  });
  viewport.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    dragDx = e.clientX - startX;
    const w = viewport.clientWidth;
    let dx = dragDx;
    if ((index === 0 && dx > 0) || (index === photos.length - 1 && dx < 0)) dx *= 0.35; // edge resistance
    track.style.transform = `translateX(${-index * w + dx}px)`;
  });
  function endDrag() {
    if (!dragging) return;
    dragging = false;
    const w = viewport.clientWidth;
    const threshold = Math.min(w * 0.18, 70);
    if (dragDx <= -threshold) goTo(index + 1);
    else if (dragDx >= threshold) goTo(index - 1);
    else goTo(index);
  }
  viewport.addEventListener('pointerup', endDrag);
  viewport.addEventListener('pointercancel', endDrag);

  const keyHandler = (e) => {
    if (e.key === 'ArrowRight') goTo(index + 1);
    else if (e.key === 'ArrowLeft') goTo(index - 1);
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
    track.children[index].remove();
    if (index >= photos.length) index = photos.length - 1;
    layout();
    sync();
  }

  requestAnimationFrame(() => { layout(); sync(); });
}
