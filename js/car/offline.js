// Offline maps: download map data around you, or along the current route,
// so the map works without internet.
//
// Downloading just fetches the map files; the stereo app saves every map file
// it loads (Android MapCache), and the browser version keeps them in its
// offline cache (service worker). Areas you've simply viewed are saved too.

import { $, toast } from '../common.js';

const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2y = (lat, z) => {
  const r = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};
// Unicode ranges for map labels: Latin/Greek/Cyrillic, Indian scripts, punctuation.
const GLYPH_RANGES = ['0-255', '256-511', '512-767', '768-1023', '1024-1279', '2304-2559', '2560-2815', '2816-3071', '3072-3327', '3328-3583', '8192-8447', '8448-8703', '65280-65535'];
const AVG_TILE_KB = 40;

export function tilesAround(center, km, maxz) {
  const dLat = km / 111;
  const dLon = km / (111 * Math.cos((center.lat * Math.PI) / 180));
  return tilesInBox([center.lat - dLat, center.lon - dLon, center.lat + dLat, center.lon + dLon], 0, maxz);
}

export function tilesInBox([s, w, n, e], z0, z1, set = new Set()) {
  for (let z = z0; z <= z1; z++) {
    const x0 = lon2x(w, z); const x1 = lon2x(e, z);
    const y0 = lat2y(n, z); const y1 = lat2y(s, z);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) set.add(`${z}/${x}/${y}`);
  }
  return set;
}

// A corridor along the route: whole-route overview at low zoom, detail near the road.
export function tilesAlongRoute(coords, maxz) {
  const set = new Set();
  const lats = coords.map((c) => c[0]);
  const lons = coords.map((c) => c[1]);
  tilesInBox([Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons)], 0, Math.min(9, maxz), set);
  for (let z = 10; z <= maxz; z++) {
    for (const [lat, lon] of coords) {
      const x = lon2x(lon, z); const y = lat2y(lat, z);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) set.add(`${z}/${x + dx}/${y + dy}`);
    }
  }
  return set;
}

export function createOffline(ctx) {
  const native = window.CarAutoNative || null;
  const el = {
    radius: $('#offline-radius'),
    area: $('#btn-offline-area'),
    route: $('#btn-offline-route'),
    cancel: $('#btn-offline-cancel'),
    clear: $('#btn-offline-clear'),
    progress: $('#offline-progress'),
    status: $('#offline-status'),
    stats: $('#offline-stats'),
  };
  let job = null;

  function sources() {
    const src = ctx.nav.map.offlineSources?.();
    if (!src?.tiles) {
      toast(ctx.nav.map.kind === 'vector' ? 'Map is still loading, try again in a moment' : 'Offline download needs the vector map');
      return null;
    }
    return src;
  }

  function urlsFor(tiles, src) {
    const urls = [...tiles].map((t) => {
      const [z, x, y] = t.split('/');
      return src.tiles.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    });
    // Fonts (for place names) and map icons, so labels draw offline too.
    if (src.glyphs) {
      const fonts = src.fonts.length ? src.fonts : ['Noto Sans Regular'];
      for (const f of fonts) for (const r of GLYPH_RANGES) urls.push(src.glyphs.replace('{fontstack}', encodeURIComponent(f)).replace('{range}', r));
    }
    for (const s of src.sprite) for (const v of ['', '@2x']) for (const ext of ['.json', '.png']) urls.push(`${s}${v}${ext}`);
    return urls;
  }

  const mb = (bytes) => `${Math.round(bytes / 1048576)} MB`;

  async function refreshStats() {
    try {
      if (native?.offlineMapStats) {
        const s = JSON.parse(native.offlineMapStats());
        el.stats.textContent = `${mb(s.bytes)} of map data saved on this stereo`;
      } else if (navigator.storage?.estimate) {
        const s = await navigator.storage.estimate();
        el.stats.textContent = `${mb(s.usage || 0)} saved in this browser`;
      }
    } catch { /* ignore */ }
    el.route.hidden = !ctx.nav.getRouteCoords?.();
  }

  async function run(urls, label) {
    if (job) return;
    job = { cancelled: false };
    const total = urls.length;
    let done = 0;
    let failed = 0;
    el.progress.hidden = false;
    el.cancel.hidden = false;
    el.area.disabled = true;
    el.route.disabled = true;
    const bar = el.progress.firstElementChild;
    const update = () => {
      bar.style.transform = `scaleX(${done / total})`;
      el.status.textContent = `Downloading ${label}: ${done} of ${total} files${failed ? ` (${failed} failed)` : ''}`;
    };
    update();
    let next = 0;
    const worker = async () => {
      while (next < total && !job.cancelled) {
        const url = urls[next++];
        try {
          const res = await fetch(url, { mode: 'cors' });
          if (!res.ok && res.status !== 204) failed++;
          else await res.arrayBuffer();
        } catch {
          failed++;
        }
        done++;
        if (done % 5 === 0 || done === total) update();
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    const cancelled = job.cancelled;
    job = null;
    el.cancel.hidden = true;
    el.area.disabled = false;
    el.route.disabled = false;
    el.progress.hidden = true;
    el.status.textContent = cancelled
      ? 'Download cancelled. Files downloaded so far are kept.'
      : failed > total / 2
        ? "Download failed: check the internet connection and try again."
        : `✓ ${label} saved for offline use${failed ? ` (${failed} files missing)` : ''}.`;
    if (!cancelled) toast(failed > total / 2 ? 'Offline download failed' : `Offline map saved: ${label}`);
    refreshStats();
  }

  el.area.addEventListener('click', () => {
    const src = sources();
    if (!src) return;
    const pos = ctx.nav.getPos();
    const [clat, clon] = ctx.nav.map.getCenter();
    const center = pos || { lat: clat, lon: clon };
    const km = Number(el.radius.value) || 25;
    const tiles = tilesAround(center, km, src.maxzoom);
    const estimate = Math.round((tiles.size * AVG_TILE_KB) / 1024);
    if (!confirm(`Download the map ${km} km around ${pos ? 'you' : 'the map centre'}?\nAbout ${tiles.size} tiles (≈${estimate} MB). Use Wi-Fi or your hotspot.`)) return;
    run(urlsFor(tiles, src), `${km} km area`);
  });

  el.route.addEventListener('click', () => {
    const src = sources();
    const coords = ctx.nav.getRouteCoords?.();
    if (!src || !coords) return;
    const tiles = tilesAlongRoute(coords, src.maxzoom);
    const estimate = Math.round((tiles.size * AVG_TILE_KB) / 1024);
    if (!confirm(`Download the map along your route?\nAbout ${tiles.size} tiles (≈${estimate} MB).`)) return;
    run(urlsFor(tiles, src), 'route');
  });

  el.cancel.addEventListener('click', () => { if (job) job.cancelled = true; });

  el.clear.addEventListener('click', async () => {
    if (!confirm('Delete all offline map data? Areas will download again when you are online.')) return;
    if (native?.clearOfflineMaps) native.clearOfflineMaps();
    else if (window.caches) await caches.delete('carauto-tiles');
    el.status.textContent = 'Offline maps deleted.';
    refreshStats();
  });

  return { onShow: refreshStats };
}
