// IndexedDB data layer for Visual Inventory PWA
const DB_NAME = 'visual-inventory';
// v3: added `pages` store (multiple positioned images per location) + hotspot.pageId +
//     hotspot.links (annotation cross-references). Existing single coverPhoto is migrated
//     into a first page during upgrade.
const DB_VERSION = 3;
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      const upgradeTx = e.target.transaction; // the versionchange transaction
      if (!db.objectStoreNames.contains('locations')) {
        const s = db.createObjectStore('locations', { keyPath: 'id' });
        s.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains('hotspots')) {
        const s = db.createObjectStore('hotspots', { keyPath: 'id' });
        s.createIndex('locationId', 'locationId');
        s.createIndex('name', 'name');
        s.createIndex('number', 'number');
      }
      if (!db.objectStoreNames.contains('itemPhotos')) {
        const s = db.createObjectStore('itemPhotos', { keyPath: 'id' });
        s.createIndex('hotspotId', 'hotspotId');
      }
      // v2 — folders (containers) for grouping locations on the home screen.
      if (!db.objectStoreNames.contains('folders')) {
        const s = db.createObjectStore('folders', { keyPath: 'id' });
        s.createIndex('createdAt', 'createdAt');
      }
      // v3 — pages: one or more positioned images per location. Each hotspot belongs to a
      // page (hotspot.pageId). page.offsetX/offsetY position the image on a shared canvas
      // so images can be laid out like walls of a room.
      if (!db.objectStoreNames.contains('pages')) {
        const s = db.createObjectStore('pages', { keyPath: 'id' });
        s.createIndex('locationId', 'locationId');
      }
      // Migrate existing data into the page model within this same upgrade transaction.
      if (e.oldVersion >= 1 && e.oldVersion < 3) {
        migrateToPagesV3(upgradeTx);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

// One-time migration (v<3 → v3): give every location a first page built from its existing
// coverPhoto, and stamp each existing hotspot with that page's id. Uses cursors on the
// upgrade transaction (no async/await — versionchange transactions must stay open).
function migrateToPagesV3(t) {
  const locStore = t.objectStore('locations');
  const pageStore = t.objectStore('pages');
  const hsStore = t.objectStore('hotspots');
  const locFirstPage = {}; // locationId -> new pageId

  locStore.openCursor().onsuccess = (ev) => {
    const cur = ev.target.result;
    if (cur) {
      const loc = cur.value;
      const pid = uuid();
      locFirstPage[loc.id] = pid;
      pageStore.put({
        id: pid, locationId: loc.id,
        photo: loc.coverPhoto || null,
        offsetX: 0, offsetY: 0, order: 0, createdAt: loc.createdAt || Date.now()
      });
      cur.continue();
    } else {
      // All locations processed → now stamp hotspots with their location's first page.
      hsStore.openCursor().onsuccess = (ev2) => {
        const c2 = ev2.target.result;
        if (c2) {
          const h = c2.value;
          if (!h.pageId && locFirstPage[h.locationId]) {
            h.pageId = locFirstPage[h.locationId];
            c2.update(h);
          }
          c2.continue();
        }
      };
    }
  };
}

function tx(storeNames, mode) {
  return openDB().then(db => db.transaction(storeNames, mode));
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

const DB = {
  // ---------- Locations ----------
  async addLocation({ name, type, coverPhoto }) {
    const t = await tx('locations', 'readwrite');
    const loc = { id: uuid(), name, type: type || '', coverPhoto: coverPhoto || null, createdAt: Date.now() };
    await reqToPromise(t.objectStore('locations').add(loc));
    return loc;
  },
  async getLocation(id) {
    const t = await tx('locations', 'readonly');
    return reqToPromise(t.objectStore('locations').get(id));
  },
  async getAllLocations() {
    const t = await tx('locations', 'readonly');
    const all = await reqToPromise(t.objectStore('locations').getAll());
    return all.sort((a, b) => a.createdAt - b.createdAt);
  },
  async updateLocation(loc) {
    const t = await tx('locations', 'readwrite');
    await reqToPromise(t.objectStore('locations').put(loc));
    return loc;
  },
  async deleteLocation(id) {
    const hotspots = await DB.getHotspotsForLocation(id);
    for (const h of hotspots) await DB.deleteHotspot(h.id);
    const pages = await DB.getPagesForLocation(id);
    for (const p of pages) { const t0 = await tx('pages', 'readwrite'); await reqToPromise(t0.objectStore('pages').delete(p.id)); }
    const t = await tx('locations', 'readwrite');
    await reqToPromise(t.objectStore('locations').delete(id));
  },

  // ---------- Folders (home-screen containers) ----------
  async addFolder({ name }) {
    const t = await tx('folders', 'readwrite');
    const f = { id: uuid(), name: name || 'Folder', createdAt: Date.now() };
    await reqToPromise(t.objectStore('folders').add(f));
    return f;
  },
  async getFolder(id) {
    const t = await tx('folders', 'readonly');
    return reqToPromise(t.objectStore('folders').get(id));
  },
  async getAllFolders() {
    const t = await tx('folders', 'readonly');
    const all = await reqToPromise(t.objectStore('folders').getAll());
    return all.sort((a, b) => a.createdAt - b.createdAt);
  },
  async updateFolder(f) {
    const t = await tx('folders', 'readwrite');
    await reqToPromise(t.objectStore('folders').put(f));
    return f;
  },
  // Delete a folder; its member locations move back out to the home grid (not deleted).
  async deleteFolder(id) {
    const locs = await DB.getAllLocations();
    for (const l of locs) {
      if (l.folderId === id) { l.folderId = null; await DB.updateLocation(l); }
    }
    const t = await tx('folders', 'readwrite');
    await reqToPromise(t.objectStore('folders').delete(id));
  },
  // Move a location into a folder (folderId=null moves it back to the top level).
  async setLocationFolder(locationId, folderId) {
    const loc = await DB.getLocation(locationId);
    if (!loc) return;
    loc.folderId = folderId || null;
    await DB.updateLocation(loc);
  },

  // ---------- Pages (positioned images within a location) ----------
  // kind: undefined / 'flat' → a normal photo laid out on the location's 2D canvas.
  //       'pano'            → a 360° scene: `photo` is an equirectangular image, `pano` holds
  //                           its metadata (start view, coverage limits), `name` labels it.
  //                           Hotspots on it use x = longitude %, y = latitude % of the image.
  async addPage({ locationId, photo, offsetX, offsetY, order, rotation, scale, kind, name, pano }) {
    const t = await tx('pages', 'readwrite');
    const p = {
      id: uuid(), locationId, photo: photo || null,
      offsetX: offsetX || 0, offsetY: offsetY || 0,
      // Free-angle rotation (degrees, 0–360) + uniform scale (multiplier) applied to the
      // whole photo in the layout. Stored as metadata so pins on the page rotate/scale WITH
      // the image and never drift out of place. Default: unrotated, natural size.
      rotation: rotation || 0, scale: scale || 1,
      order: order || 0, createdAt: Date.now()
    };
    if (kind === 'pano') { p.kind = 'pano'; p.name = name || ''; p.pano = pano || {}; }
    await reqToPromise(t.objectStore('pages').add(p));
    return p;
  },
  async getPage(id) {
    const t = await tx('pages', 'readonly');
    return reqToPromise(t.objectStore('pages').get(id));
  },
  async getPagesForLocation(locationId) {
    const t = await tx('pages', 'readonly');
    const idx = t.objectStore('pages').index('locationId');
    const all = await reqToPromise(idx.getAll(locationId));
    return all.sort((a, b) => (a.order || 0) - (b.order || 0) || (a.createdAt || 0) - (b.createdAt || 0));
  },
  async updatePage(p) {
    const t = await tx('pages', 'readwrite');
    await reqToPromise(t.objectStore('pages').put(p));
    return p;
  },
  async deletePage(id) {
    // Remove the page, all hotspots on it, and those hotspots' photos.
    const page = await DB.getPage(id);
    if (!page) return;
    const hotspots = (await DB.getHotspotsForLocation(page.locationId)).filter(h => h.pageId === id);
    for (const h of hotspots) await DB.deleteHotspot(h.id);
    const t = await tx('pages', 'readwrite');
    await reqToPromise(t.objectStore('pages').delete(id));
  },
  async getAllPages() {
    const t = await tx('pages', 'readonly');
    return reqToPromise(t.objectStore('pages').getAll());
  },

  // ---------- Hotspots ----------
  async addHotspot({ locationId, pageId, x, y, name, number, description, type, links }) {
    const t = await tx('hotspots', 'readwrite');
    const h = {
      id: uuid(), locationId, pageId: pageId || null, x, y,
      name: name || '', number: number || '', description: description || '',
      type: type || 'box', links: links || [],
      createdAt: Date.now(), updatedAt: Date.now()
    };
    await reqToPromise(t.objectStore('hotspots').add(h));
    return h;
  },
  async getHotspot(id) {
    const t = await tx('hotspots', 'readonly');
    return reqToPromise(t.objectStore('hotspots').get(id));
  },
  async getHotspotsForLocation(locationId) {
    const t = await tx('hotspots', 'readonly');
    const idx = t.objectStore('hotspots').index('locationId');
    return reqToPromise(idx.getAll(locationId));
  },
  async getHotspotsForPage(pageId) {
    const t = await tx('hotspots', 'readonly');
    const all = await reqToPromise(t.objectStore('hotspots').getAll());
    return all.filter(h => h.pageId === pageId);
  },
  async getAllHotspots() {
    const t = await tx('hotspots', 'readonly');
    return reqToPromise(t.objectStore('hotspots').getAll());
  },
  async updateHotspot(h) {
    h.updatedAt = Date.now();
    const t = await tx('hotspots', 'readwrite');
    await reqToPromise(t.objectStore('hotspots').put(h));
    return h;
  },
  // Copy a hotspot (fields + all its photos) to a new place — any location, any page.
  async duplicateHotspot(srcId, { locationId, pageId, x, y }) {
    const src = await DB.getHotspot(srcId);
    if (!src) return null;
    const h = await DB.addHotspot({
      locationId, pageId, x, y,
      name: src.name, number: src.number, description: src.description, type: src.type,
      // Annotation links only make sense inside the same location.
      links: src.locationId === locationId ? (src.links || []).slice() : []
    });
    const photos = await DB.getPhotosForHotspot(srcId);
    for (const p of photos) await DB.addPhoto({ hotspotId: h.id, photo: p.photo, caption: p.caption, order: p.order });
    return h;
  },
  // Move a hotspot (with its photos, which are keyed by hotspot id) to a new place.
  async moveHotspot(id, { locationId, pageId, x, y }) {
    const h = await DB.getHotspot(id);
    if (!h) return null;
    h.locationId = locationId; h.pageId = pageId || null; h.x = x; h.y = y;
    return DB.updateHotspot(h);
  },
  async deleteHotspot(id) {
    const photos = await DB.getPhotosForHotspot(id);
    const t = await tx(['hotspots', 'itemPhotos'], 'readwrite');
    for (const p of photos) t.objectStore('itemPhotos').delete(p.id);
    t.objectStore('hotspots').delete(id);
    return new Promise((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  },

  // ---------- ItemPhotos ----------
  async addPhoto({ hotspotId, photo, caption, order }) {
    const t = await tx('itemPhotos', 'readwrite');
    const p = { id: uuid(), hotspotId, photo, caption: caption || '', order: order || 0, createdAt: Date.now() };
    await reqToPromise(t.objectStore('itemPhotos').add(p));
    return p;
  },
  async getPhotosForHotspot(hotspotId) {
    const t = await tx('itemPhotos', 'readonly');
    const idx = t.objectStore('itemPhotos').index('hotspotId');
    const all = await reqToPromise(idx.getAll(hotspotId));
    return all.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  },
  async updatePhoto(p) {
    const t = await tx('itemPhotos', 'readwrite');
    await reqToPromise(t.objectStore('itemPhotos').put(p));
    return p;
  },
  async deletePhoto(id) {
    const t = await tx('itemPhotos', 'readwrite');
    await reqToPromise(t.objectStore('itemPhotos').delete(id));
  },

  // ---------- Search ----------
  // Returns [{ hotspot, source }] where source is 'name' | 'number' | 'description' |
  // 'caption'. #2: matches on the hotspot's own fields AND on any of its photo captions,
  // so searching "light" finds a box whose photo caption mentions "light".
  async searchHotspots(query) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const all = await DB.getAllHotspots();
    const results = [];
    for (const h of all) {
      let source = null;
      if (h.name && h.name.toLowerCase().includes(q)) source = 'name';
      else if (h.number && h.number.toLowerCase().includes(q)) source = 'number';
      else if (h.description && h.description.toLowerCase().includes(q)) source = 'description';
      else {
        const photos = await DB.getPhotosForHotspot(h.id);
        const cap = photos.find(p => p.caption && p.caption.toLowerCase().includes(q));
        if (cap) source = 'caption';
      }
      if (source) results.push({ hotspot: h, source });
    }
    return results;
  },

  // ---------- Full export / import ----------
  async exportAll() {
    const locations = await DB.getAllLocations();
    const hotspots = await DB.getAllHotspots();
    const folders = await DB.getAllFolders();
    const pages = await DB.getAllPages();
    const photos = [];
    const t = await tx('itemPhotos', 'readonly');
    const all = await reqToPromise(t.objectStore('itemPhotos').getAll());
    photos.push(...all);
    return { locations, hotspots, folders, pages, photos };
  },
  async importAll(data, mode = 'merge') {
    if (mode === 'replace') {
      await DB.clearAll();
    }
    const db = await openDB();
    // Only include stores that actually exist (guards against an older DB/cache that
    // predates a store — otherwise the whole transaction would abort and NOTHING would
    // import, which is exactly the "hotspots didn't sync" symptom).
    const wanted = ['locations', 'hotspots', 'itemPhotos', 'folders', 'pages'];
    const stores = wanted.filter(s => db.objectStoreNames.contains(s));
    const t = db.transaction(stores, 'readwrite');
    const has = (s) => stores.includes(s);
    let putCount = 0;
    if (has('folders')) for (const f of data.folders || []) { t.objectStore('folders').put(f); putCount++; }
    if (has('pages')) for (const pg of data.pages || []) { t.objectStore('pages').put(pg); putCount++; }
    if (has('locations')) for (const loc of data.locations || []) { t.objectStore('locations').put(loc); putCount++; }
    if (has('hotspots')) for (const h of data.hotspots || []) { t.objectStore('hotspots').put(h); putCount++; }
    if (has('itemPhotos')) for (const p of data.photos || []) { t.objectStore('itemPhotos').put(p); putCount++; }
    return new Promise((resolve, reject) => {
      t.oncomplete = () => resolve({ imported: putCount });
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('Import transaction aborted'));
    });
  },
  async clearAll() {
    const t = await tx(['locations', 'hotspots', 'itemPhotos', 'folders', 'pages'], 'readwrite');
    t.objectStore('locations').clear();
    t.objectStore('hotspots').clear();
    t.objectStore('itemPhotos').clear();
    t.objectStore('folders').clear();
    t.objectStore('pages').clear();
    return new Promise((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }
};

window.DB = DB;
window.uuid = uuid;
