// Minimal local XLSX writer — builds a real .xlsx (OOXML) file from an array-of-rows
// using MiniZip. No external dependencies. Supports embedding JPEG images into cells
// (used to put box photos next to their rows — #10).
(function (global) {
  const EMU_PER_PX = 9525; // 1 pixel = 9525 English Metric Units

  function xmlEscape(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  function colName(n) {
    let s = '';
    n++;
    while (n > 0) {
      const rem = (n - 1) % 26;
      s = String.fromCharCode(65 + rem) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  function sheetXmlFromRows(rows, opts) {
    opts = opts || {};
    let rowsXml = '';
    rows.forEach((row, rIdx) => {
      const rowNum = rIdx + 1;
      const rowAttr = opts.rowHeights && opts.rowHeights[rIdx]
        ? ` ht="${opts.rowHeights[rIdx]}" customHeight="1"` : '';
      let cellsXml = '';
      row.forEach((cell, cIdx) => {
        const ref = colName(cIdx) + rowNum;
        if (cell === null || cell === undefined || cell === '') return;
        if (typeof cell === 'number' && isFinite(cell)) {
          cellsXml += `<c r="${ref}"><v>${cell}</v></c>`;
        } else {
          cellsXml += `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(cell)}</t></is></c>`;
        }
      });
      rowsXml += `<row r="${rowNum}"${rowAttr}>${cellsXml}</row>`;
    });
    const cols = opts.colWidths
      ? `<cols>${opts.colWidths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
      : '';
    const drawingTag = opts.drawingRid ? `<drawing r:id="${opts.drawingRid}"/>` : '';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
${cols}<sheetData>${rowsXml}</sheetData>${drawingTag}
</worksheet>`;
  }

  // Build the drawing XML. We use oneCellAnchor: the image is anchored at a single cell's
  // top-left and sized with an ABSOLUTE extent (cx,cy in EMU) taken from the thumbnail's
  // real pixel size. Because the size comes straight from the image, the aspect ratio is
  // preserved exactly — no stretching — and the caller sizes the photo column + row height
  // to match so the picture sits neatly inside its cell.
  function drawingXml(images) {
    const anchors = images.map((img, i) => {
      const w = img.wPx || 100, h = img.hPx || 75;
      const cx = Math.round(w * EMU_PER_PX);
      const cy = Math.round(h * EMU_PER_PX);
      const rId = 'rId' + (i + 1);
      const id = i + 2;
      return `<xdr:oneCellAnchor>
<xdr:from><xdr:col>${img.col}</xdr:col><xdr:colOff>19050</xdr:colOff><xdr:row>${img.row}</xdr:row><xdr:rowOff>19050</xdr:rowOff></xdr:from>
<xdr:ext cx="${cx}" cy="${cy}"/>
<xdr:pic>
<xdr:nvPicPr><xdr:cNvPr id="${id}" name="Photo ${i + 1}"/><xdr:cNvPicPr/></xdr:nvPicPr>
<xdr:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>
<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>
</xdr:pic>
<xdr:clientData/>
</xdr:oneCellAnchor>`;
    }).join('\n');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
${anchors}
</xdr:wsDr>`;
  }

  // sheets: [{ name, rows:[[...]], images?:[{data:Uint8Array, col, row, wPx, hPx}], colWidths?, rowHeights? }]
  function buildXlsx(sheets) {
    const zip = new MiniZip();
    let mediaCount = 0;
    const mediaFiles = []; // {path, data}

    // Assign drawings to sheets that have images.
    const sheetMeta = sheets.map((s, i) => {
      const meta = { drawingIndex: null, images: s.images || [] };
      if (meta.images.length) meta.drawingIndex = i + 1;
      return meta;
    });

    // Content types
    const hasAnyImage = sheetMeta.some(m => m.images.length);
    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
${hasAnyImage ? '<Default Extension="jpeg" ContentType="image/jpeg"/>' : ''}
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
${sheetMeta.map((m) => m.drawingIndex ? `<Override PartName="/xl/drawings/drawing${m.drawingIndex}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>` : '').filter(Boolean).join('\n')}
</Types>`;
    zip.addFile('[Content_Types].xml', contentTypes);

    zip.addFile('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`);

    zip.addFile('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>
${sheets.map((s, i) => `<sheet name="${xmlEscape(s.name.substring(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('\n')}
</sheets>
</workbook>`);

    zip.addFile('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
</Relationships>`);

    sheets.forEach((s, i) => {
      const meta = sheetMeta[i];
      const drawingRid = meta.drawingIndex ? 'rIdDraw' : null;
      zip.addFile(`xl/worksheets/sheet${i + 1}.xml`, sheetXmlFromRows(s.rows, {
        colWidths: s.colWidths, rowHeights: s.rowHeights, drawingRid
      }));

      if (meta.drawingIndex) {
        // worksheet -> drawing relationship
        zip.addFile(`xl/worksheets/_rels/sheet${i + 1}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdDraw" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${meta.drawingIndex}.xml"/>
</Relationships>`);

        // drawing xml
        zip.addFile(`xl/drawings/drawing${meta.drawingIndex}.xml`, drawingXml(meta.images));

        // drawing -> media relationships + media files
        const relParts = meta.images.map((img, idx) => {
          mediaCount++;
          const mediaName = `image${mediaCount}.jpeg`;
          mediaFiles.push({ path: `xl/media/${mediaName}`, data: img.data });
          return `<Relationship Id="rId${idx + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${mediaName}"/>`;
        }).join('\n');
        zip.addFile(`xl/drawings/_rels/drawing${meta.drawingIndex}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${relParts}
</Relationships>`);
      }
    });

    // media binary files
    mediaFiles.forEach(m => zip.addFile(m.path, m.data));

    return zip.generateBlob('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  }

  global.XlsxWriter = { buildXlsx };
})(window);
