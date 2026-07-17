// Minimal local ZIP writer (STORE method, no compression) — no external deps.
// Produces a valid .zip readable by any unzip tool / Excel.
(function (global) {
  function crc32(buf) {
    let c, crcTable = crc32.table;
    if (!crcTable) {
      crcTable = crc32.table = [];
      for (let n = 0; n < 256; n++) {
        c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        crcTable[n] = c;
      }
    }
    let crc = 0 ^ (-1);
    for (let i = 0; i < buf.length; i++) {
      crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff];
    }
    return (crc ^ (-1)) >>> 0;
  }

  function strToBytes(str) {
    return new TextEncoder().encode(str);
  }

  function dosDateTime(date) {
    const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f);
    const dosDate = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0xf) << 5) | (date.getDate() & 0x1f);
    return { time, dosDate };
  }

  class MiniZip {
    constructor() {
      this.files = [];
    }
    addFile(name, data) {
      let bytes;
      if (typeof data === 'string') bytes = strToBytes(data);
      else if (data instanceof Uint8Array) bytes = data;
      else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
      else throw new Error('Unsupported data type for zip entry');
      this.files.push({ name, bytes });
    }
    generate() {
      const now = new Date();
      const { time, dosDate } = dosDateTime(now);
      const localParts = [];
      const centralParts = [];
      let offset = 0;

      for (const file of this.files) {
        const nameBytes = strToBytes(file.name);
        const crc = crc32(file.bytes);
        const size = file.bytes.length;

        const localHeader = new Uint8Array(30 + nameBytes.length);
        const lv = new DataView(localHeader.buffer);
        lv.setUint32(0, 0x04034b50, true);
        lv.setUint16(4, 20, true);
        lv.setUint16(6, 0, true);
        lv.setUint16(8, 0, true); // no compression
        lv.setUint16(10, time, true);
        lv.setUint16(12, dosDate, true);
        lv.setUint32(14, crc, true);
        lv.setUint32(18, size, true);
        lv.setUint32(22, size, true);
        lv.setUint16(26, nameBytes.length, true);
        lv.setUint16(28, 0, true);
        localHeader.set(nameBytes, 30);

        localParts.push(localHeader, file.bytes);

        const centralHeader = new Uint8Array(46 + nameBytes.length);
        const cv = new DataView(centralHeader.buffer);
        cv.setUint32(0, 0x02014b50, true);
        cv.setUint16(4, 20, true);
        cv.setUint16(6, 20, true);
        cv.setUint16(8, 0, true);
        cv.setUint16(10, 0, true);
        cv.setUint16(12, time, true);
        cv.setUint16(14, dosDate, true);
        cv.setUint32(16, crc, true);
        cv.setUint32(20, size, true);
        cv.setUint32(24, size, true);
        cv.setUint16(28, nameBytes.length, true);
        cv.setUint16(30, 0, true);
        cv.setUint16(32, 0, true);
        cv.setUint16(34, 0, true);
        cv.setUint16(36, 0, true);
        cv.setUint32(38, 0, true);
        cv.setUint32(42, offset, true);
        centralHeader.set(nameBytes, 46);

        centralParts.push(centralHeader);

        offset += localHeader.length + file.bytes.length;
      }

      const centralSize = centralParts.reduce((a, p) => a + p.length, 0);
      const centralOffset = offset;

      const eocd = new Uint8Array(22);
      const ev = new DataView(eocd.buffer);
      ev.setUint32(0, 0x06054b50, true);
      ev.setUint16(4, 0, true);
      ev.setUint16(6, 0, true);
      ev.setUint16(8, this.files.length, true);
      ev.setUint16(10, this.files.length, true);
      ev.setUint32(12, centralSize, true);
      ev.setUint32(16, centralOffset, true);
      ev.setUint16(20, 0, true);

      const totalSize = offset + centralSize + eocd.length;
      const out = new Uint8Array(totalSize);
      let pos = 0;
      for (const part of localParts) { out.set(part, pos); pos += part.length; }
      for (const part of centralParts) { out.set(part, pos); pos += part.length; }
      out.set(eocd, pos);

      return out;
    }
    generateBlob(mimeType) {
      return new Blob([this.generate()], { type: mimeType || 'application/zip' });
    }
  }

  global.MiniZip = MiniZip;
})(window);
