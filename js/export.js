// Render a JPEG thumbnail of a photo blob for embedding into Excel, preserving aspect
// ratio. Returns { data: Uint8Array, wPx, hPx }. maxDim=240 + quality 0.82 gives a clear
// thumbnail (the old 150px/0.72 looked blocky).
function photoThumbForExcel(blob, maxDim = 240, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      let w = img.naturalWidth, h = img.naturalHeight;
      if (w > maxDim || h > maxDim) {
        if (w >= h) { h = Math.round(h * maxDim / w); w = maxDim; }
        else { w = Math.round(w * maxDim / h); h = maxDim; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob(async (b) => {
        URL.revokeObjectURL(url);
        const buf = new Uint8Array(await b.arrayBuffer());
        resolve({ data: buf, wPx: w, hPx: h });
      }, 'image/jpeg', quality);
    };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

// Build one worksheet spec (rows + embedded photos) for a single location.
async function buildLocationSheet(loc) {
  const hotspots = await DB.getHotspotsForLocation(loc.id);
  const header = ['Box/Item Name', 'Number', 'Type', 'Description', 'Photo #', 'Caption', 'Photo'];
  const rows = [header];
  const images = [];
  const rowHeights = [];
  const PHOTO_COL = 6; // column G (0-based)

  let maxPhotoW = 0; // widest thumbnail (px) → drives the photo column width
  for (const h of hotspots) {
    const photos = await DB.getPhotosForHotspot(h.id);
    const typeLabel = h.type === 'annotation' ? 'Annotation' : 'Box';
    if (!photos.length) {
      rows.push([h.name, h.number, typeLabel, h.description, '', '', '']);
    } else {
      for (let i = 0; i < photos.length; i++) {
        const p = photos[i];
        rows.push([
          i === 0 ? h.name : '',
          i === 0 ? h.number : '',
          i === 0 ? typeLabel : '',
          i === 0 ? h.description : '',
          i + 1,
          p.caption || '',
          '' // the embedded image floats over this cell
        ]);
        const rowIndex = rows.length - 1; // 0-based row for the anchor
        try {
          const thumb = await photoThumbForExcel(p.photo, 240);
          images.push({ data: thumb.data, col: PHOTO_COL, row: rowIndex, wPx: thumb.wPx, hPx: thumb.hPx });
          // Row height (points) sized to the image height so the photo fits inside the row.
          rowHeights[rowIndex] = Math.round(thumb.hPx * 0.75) + 8; // px → points (+padding)
          maxPhotoW = Math.max(maxPhotoW, thumb.wPx);
        } catch (e) {
          console.warn('Could not thumbnail a photo for export', e);
        }
      }
    }
  }

  // Photo column width in Excel "characters" ≈ px / 7, with a little padding so the image
  // (anchored a few px in) never spills past the right cell edge.
  const photoColWidth = maxPhotoW ? Math.ceil(maxPhotoW / 7) + 2 : 24;

  return {
    name: (loc.name || 'Sheet').substring(0, 31),
    rows,
    images,
    rowHeights,
    colWidths: [22, 10, 10, 34, 7, 26, photoColWidth]
  };
}

// #8 + #10: choose which location(s) to export, then generate one .xlsx with a sheet
// per location and each box's photos embedded next to its row.
function exportLocationExcel(currentLoc) {
  openExportChooser(currentLoc);
}

async function openExportChooser(currentLoc) {
  const locations = await DB.getAllLocations();
  const overlay = el('div', { class: 'modal-overlay centered' });

  const listWrap = el('div', { style: 'max-height:46vh;overflow-y:auto;margin:8px 0;' });
  const checks = {};
  locations.forEach(loc => {
    const cb = el('input', { type: 'checkbox' });
    if (currentLoc && loc.id === currentLoc.id) cb.checked = true;
    checks[loc.id] = cb;
    const row = el('label', {
      style: 'display:flex;align-items:center;gap:10px;padding:10px 4px;border-bottom:1px solid var(--border);cursor:pointer;'
    }, [cb, el('span', {}, [loc.name])]);
    listWrap.appendChild(row);
  });

  const noteEl = el('div', { class: 'view-val', style: 'font-size:12px;opacity:0.7;margin-top:4px;' }, [
    'Box photos are embedded next to each row as thumbnails. Open the file in Excel, Google Sheets, or LibreOffice.'
  ]);

  const exportBtn = el('button', {
    class: 'btn', onclick: async () => {
      const chosen = locations.filter(l => checks[l.id].checked);
      if (!chosen.length) { showToast('Select at least one location'); return; }
      exportBtn.disabled = true;
      exportBtn.textContent = 'Generating…';
      try {
        const sheets = [];
        for (const loc of chosen) sheets.push(await buildLocationSheet(loc));
        const blob = XlsxWriter.buildXlsx(sheets);
        const fname = chosen.length === 1 ? safeFileName(chosen[0].name) : 'inventory-export';
        downloadBlob(blob, `${fname}.xlsx`);
        overlay.remove();
        showToast('Excel file downloaded');
      } catch (err) {
        console.error('Excel export failed', err);
        showToast('Export failed — please try again');
        exportBtn.disabled = false;
        exportBtn.textContent = 'Export';
      }
    }
  }, ['Export']);

  const sheet = el('div', { class: 'modal-sheet' }, [
    el('h2', {}, ['Export to Excel']),
    el('div', { class: 'view-val', style: 'font-size:13px;opacity:0.8;margin-bottom:4px;' }, ['Choose which location(s) to export:']),
    listWrap,
    noteEl,
    el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn secondary', onclick: () => overlay.remove() }, ['Cancel']),
      exportBtn
    ])
  ]);
  overlay.appendChild(sheet);
  showOverlay(overlay);
}
