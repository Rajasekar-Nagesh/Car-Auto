// Map rendering behind one small interface, so navigation logic doesn't care
// which engine draws it.
//
// - Vector (preferred): MapLibre GL + OpenFreeMap vector tiles. Two-finger
//   rotate/tilt, heading-up navigation, sharp place/street names at every
//   zoom that stay upright when the map turns.
// - Raster (fallback for stereos without WebGL): Leaflet + OpenStreetMap
//   image tiles. North-up only.

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const ROUTE = '#4c8df6';
const ROUTE_CASING = '#1a4fa8';
const DONE = '#8a9099';

const toLngLat = ([lat, lon]) => [lon, lat];
const line = (coords) => ({
  type: 'Feature',
  properties: {},
  geometry: { type: 'LineString', coordinates: (coords || []).map(toLngLat) },
});

function carElement() {
  const el = document.createElement('div');
  el.className = 'car-marker';
  el.innerHTML = '<div class="car-arrow"><svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="22" fill="#fff" opacity=".18"/><path d="M24 6 39 40 24 32 9 40Z" fill="#4c8df6" stroke="#fff" stroke-width="3" stroke-linejoin="round"/></svg></div>';
  return el;
}

function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

export function createMapView(container, opts) {
  const forceRaster = new URLSearchParams(location.search).get('map') === 'raster';
  if (window.maplibregl && !forceRaster && webglAvailable()) {
    try {
      return vectorView(container, opts);
    } catch (e) {
      console.warn('Vector map failed, using raster fallback', e);
    }
  }
  return rasterView(container, opts);
}

// ---------------------------------------------------------------------------
// Vector map (MapLibre GL)
// ---------------------------------------------------------------------------
function vectorView(container, { center, zoom }) {
  const ml = window.maplibregl;
  const map = new ml.Map({
    container,
    style: STYLE_URL,
    center: toLngLat(center),
    zoom,
    attributionControl: false,
    fadeDuration: 0,
    dragRotate: true,
    pitchWithRotate: true,
    touchPitch: true,
    maxPitch: 60,
    renderWorldCopies: false,
    trackResize: true,
  });
  map.addControl(new ml.AttributionControl({ compact: true }), 'bottom-right');
  map.touchZoomRotate.enableRotation();

  const handlers = { userpan: [], click: [], rotate: [], unavailable: [], loaded: [] };
  const fire = (t, ...a) => handlers[t].forEach((fn) => fn(...a));
  // Style couldn't load (offline and never saved): tell the UI instead of a blank map.
  map.on('error', () => { if (!map.isStyleLoaded()) fire('unavailable'); });
  map.on('load', () => fire('loaded'));
  map.on('dragstart', (e) => { if (e.originalEvent) fire('userpan'); });
  map.on('rotate', () => fire('rotate', map.getBearing()));
  map.on('click', () => fire('click'));

  // Route layers are (re)added whenever a style finishes loading.
  const data = { route: line([]), done: line([]), preview: line([]) };
  function addLayers() {
    for (const id of ['preview', 'route', 'done']) {
      if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: data[id] });
    }
    const width = ['interpolate', ['linear'], ['zoom'], 10, 4, 16, 9, 19, 14];
    const casing = ['interpolate', ['linear'], ['zoom'], 10, 6, 16, 13, 19, 19];
    const layout = { 'line-cap': 'round', 'line-join': 'round' };
    const add = (l) => { if (!map.getLayer(l.id)) map.addLayer(l); };
    add({ id: 'preview-line', type: 'line', source: 'preview', layout, paint: { 'line-color': ROUTE, 'line-width': width, 'line-opacity': 0.85 } });
    add({ id: 'route-casing', type: 'line', source: 'route', layout, paint: { 'line-color': ROUTE_CASING, 'line-width': casing } });
    add({ id: 'route-line', type: 'line', source: 'route', layout, paint: { 'line-color': ROUTE, 'line-width': width } });
    add({ id: 'done-line', type: 'line', source: 'done', layout, paint: { 'line-color': DONE, 'line-width': width } });
  }
  map.on('load', addLayers);
  map.on('styledata', () => { if (map.isStyleLoaded()) addLayers(); });
  const setData = (id, coords) => {
    data[id] = line(coords);
    map.getSource(id)?.setData(data[id]);
  };

  let car = null;
  let dest = null;

  return {
    kind: 'vector',
    canRotate: true,
    on(type, fn) { handlers[type]?.push(fn); },
    setCar(ll, heading) {
      if (!car) car = new ml.Marker({ element: carElement(), rotationAlignment: 'map', pitchAlignment: 'map' }).setLngLat(toLngLat(ll)).addTo(map);
      car.setLngLat(toLngLat(ll));
      car.setRotation(heading || 0);
    },
    // Move the camera without animation (called every frame while following).
    follow(ll, { zoom, bearing, pitch, offsetY = 0 } = {}) {
      const cam = { center: toLngLat(ll), padding: { top: offsetY, bottom: 0, left: 0, right: 0 } };
      if (zoom != null) cam.zoom = zoom;
      if (bearing != null) cam.bearing = bearing;
      if (pitch != null) cam.pitch = pitch;
      map.jumpTo(cam);
    },
    getZoom: () => map.getZoom(),
    getCenter() { const c = map.getCenter(); return [c.lat, c.lng]; },
    getBearing: () => map.getBearing(),
    resetNorth() { map.easeTo({ bearing: 0, pitch: 0, duration: 400 }); },
    fitCoords(coords, padding = 60) {
      if (!coords.length) return;
      const b = new ml.LngLatBounds(toLngLat(coords[0]), toLngLat(coords[0]));
      coords.forEach((c) => b.extend(toLngLat(c)));
      map.fitBounds(b, { padding, bearing: 0, pitch: 0, duration: 0, maxZoom: 17 });
    },
    setRoute(coords) { setData('route', coords); if (!coords) setData('done', null); },
    setDone(coords) { setData('done', coords); },
    setPreview(coords) { setData('preview', coords); },
    setDest(ll) {
      dest?.remove();
      dest = ll ? new ml.Marker({ color: '#ea4335' }).setLngLat(toLngLat(ll)).addTo(map) : null;
    },
    resize() { map.resize(); },
    // What to download for offline use: tile URL template, fonts, icons.
    offlineSources() {
      if (!map.isStyleLoaded()) return null;
      const style = map.getStyle();
      let tiles = null;
      let maxzoom = 14;
      for (const id of Object.keys(style.sources || {})) {
        const src = map.getSource(id);
        if (src?.type === 'vector' && src.tiles?.length) {
          tiles = src.tiles[0];
          maxzoom = Math.min(src.maxzoom ?? 14, 14);
          break;
        }
      }
      const fonts = new Set();
      (style.layers || []).forEach((l) => {
        const f = l.layout?.['text-font'];
        if (Array.isArray(f) && f.every((x) => typeof x === 'string')) fonts.add(f.join(','));
      });
      const sprite = typeof style.sprite === 'string' ? [style.sprite] : (style.sprite || []).map((s) => s.url);
      return { tiles, maxzoom, glyphs: style.glyphs || null, fonts: [...fonts], sprite };
    },
    raw: map,
  };
}

// ---------------------------------------------------------------------------
// Raster fallback (Leaflet)
// ---------------------------------------------------------------------------
function rasterView(container, { center, zoom }) {
  const L = window.L;
  const map = L.map(container, {
    zoomControl: false,
    preferCanvas: true,
    fadeAnimation: false,
    zoomSnap: 0.5,
    tapTolerance: 20,
  }).setView(center, zoom);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    keepBuffer: 4,
    updateWhenIdle: false,
    updateWhenZooming: false,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);

  const handlers = { userpan: [], click: [], rotate: [], unavailable: [], loaded: [] };
  map.on('dragstart', () => handlers.userpan.forEach((fn) => fn()));
  map.on('click', () => handlers.click.forEach((fn) => fn()));

  const style = { color: ROUTE, weight: 8, opacity: 1, lineCap: 'round', lineJoin: 'round' };
  const casingLine = L.polyline([], { ...style, color: ROUTE_CASING, weight: 12 }).addTo(map);
  const routeLine = L.polyline([], style).addTo(map);
  const doneLine = L.polyline([], { ...style, color: DONE }).addTo(map);
  const previewLine = L.polyline([], { ...style, opacity: 0.85 }).addTo(map);
  const icon = L.divIcon({ className: '', html: carElement().outerHTML, iconSize: [48, 48], iconAnchor: [24, 24] });
  let car = null;
  let arrow = null;
  let dest = null;

  return {
    kind: 'raster',
    canRotate: false,
    on(type, fn) { handlers[type]?.push(fn); },
    setCar(ll, heading) {
      if (!car) {
        car = L.marker(ll, { icon, interactive: false, keyboard: false, zIndexOffset: 1000 }).addTo(map);
        arrow = car.getElement()?.querySelector('.car-arrow');
      }
      car.setLatLng(ll);
      if (arrow) arrow.style.transform = `rotate(${heading || 0}deg)`;
    },
    follow(ll, { zoom } = {}) {
      if (zoom != null) map.setView(ll, zoom, { animate: false });
      else map.panTo(ll, { animate: false, noMoveStart: true });
    },
    getZoom: () => map.getZoom(),
    getCenter() { const c = map.getCenter(); return [c.lat, c.lng]; },
    getBearing: () => 0,
    resetNorth() {},
    fitCoords(coords, padding = 60) {
      if (coords.length) map.fitBounds(L.latLngBounds(coords), { padding: [padding, padding] });
    },
    setRoute(coords) { casingLine.setLatLngs(coords || []); routeLine.setLatLngs(coords || []); if (!coords) doneLine.setLatLngs([]); },
    setDone(coords) { doneLine.setLatLngs(coords || []); },
    setPreview(coords) { previewLine.setLatLngs(coords || []); },
    setDest(ll) {
      dest?.remove();
      dest = ll ? L.marker(ll).addTo(map) : null;
    },
    resize() { map.invalidateSize({ pan: false }); },
    raw: map,
  };
}
