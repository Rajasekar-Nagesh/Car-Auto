// Map + turn-by-turn navigation for the car display.
// Map tiles: OpenStreetMap. Routing: OSRM. Search: Nominatim.

import {
  $, store, toast, speak, fetchJSON, haversine, bearing, fmtDist, sayDist,
  fmtDuration, fmtClock, escapeHtml, searchPlaces, openExternal,
} from '../common.js';
import { createMapView } from './mapview.js';

const OSRM = 'https://router.project-osrm.org/route/v1/driving';
const OFF_ROUTE_M = 60;
const ARRIVE_M = 30;
const PHONE_GPS_FRESH_MS = 10000;

// ---- Instruction text --------------------------------------------------

const ORD = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'];
const ordinal = (n) => ORD[n] || `${n}th`;
const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
const compass = (deg) => COMPASS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];

export function instructionFor(step) {
  const m = step.maneuver || {};
  const name = step.name || step.ref || '';
  const onto = name ? ` onto ${name}` : '';
  const mod = m.modifier || '';
  const side = mod.includes('left') ? 'left' : mod.includes('right') ? 'right' : '';
  switch (m.type) {
    case 'depart':
      return `Head ${compass(m.bearing_after || 0)}${name ? ` on ${name}` : ''}`;
    case 'arrive':
      return side ? `Your destination is on the ${side}` : 'You have arrived';
    case 'roundabout':
    case 'rotary':
      return m.exit ? `At the roundabout, take the ${ordinal(m.exit)} exit${onto}` : `Enter the roundabout${onto}`;
    case 'exit roundabout':
    case 'exit rotary':
      return `Exit the roundabout${onto}`;
    case 'merge':
      return `Merge${side ? ` ${side}` : ''}${onto}`;
    case 'on ramp':
      return `Take the ramp${side ? ` on the ${side}` : ''}${onto}`;
    case 'off ramp':
      return `Take the exit${side ? ` on the ${side}` : ''}${onto}`;
    case 'fork':
      return `Keep ${side || 'straight'} at the fork${onto}`;
    case 'end of road':
      return `At the end of the road, turn ${side || mod}${onto}`;
    case 'continue':
    case 'new name':
      if (!mod || mod === 'straight') return `Continue${name ? ` on ${name}` : ' straight'}`;
    // falls through
    default:
      if (mod === 'uturn') return 'Make a U-turn';
      if (mod === 'straight') return `Continue straight${onto}`;
      return `Turn ${mod || 'ahead'}${onto}`;
  }
}

const ARROW_ANGLE = {
  straight: 0, 'slight right': 45, right: 90, 'sharp right': 135,
  uturn: 180, 'sharp left': -135, left: -90, 'slight left': -45,
};
export function arrowFor(step) {
  const m = step?.maneuver || {};
  if (m.type === 'arrive') return '<span class="glyph">🏁</span>';
  if (m.type === 'roundabout' || m.type === 'rotary') return `<span class="glyph">⟳${m.exit ? `<small>${m.exit}</small>` : ''}</span>`;
  const angle = ARROW_ANGLE[m.modifier] ?? 0;
  return `<svg viewBox="0 0 48 48" style="transform:rotate(${angle}deg)"><path d="M24 4 L38 20 H29 V44 H19 V20 H10 Z" fill="currentColor"/></svg>`;
}

// ---- Geometry helpers --------------------------------------------------

// Project to local metres around a reference latitude (accurate enough
// for the short distances involved in snapping to a route).
function projector(lat0) {
  const kx = Math.cos((lat0 * Math.PI) / 180) * 111320;
  const ky = 110540;
  return ([lat, lon]) => [lon * kx, lat * ky];
}

function closestOnSegment(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = a[0] + t * dx;
  const y = a[1] + t * dy;
  return { t, d: Math.hypot(p[0] - x, p[1] - y) };
}

export function buildRoute(osrmRoute, dest) {
  const coords = osrmRoute.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
  const cum = [0];
  for (let i = 1; i < coords.length; i++) {
    cum.push(cum[i - 1] + haversine(
      { lat: coords[i - 1][0], lon: coords[i - 1][1] },
      { lat: coords[i][0], lon: coords[i][1] },
    ));
  }
  const steps = [];
  let from = 0;
  for (const leg of osrmRoute.legs) {
    for (const s of leg.steps) {
      const [lon, lat] = s.maneuver.location;
      let idx = from;
      for (let j = from; j < coords.length; j++) {
        if (Math.abs(coords[j][0] - lat) < 1e-5 && Math.abs(coords[j][1] - lon) < 1e-5) { idx = j; break; }
      }
      from = idx;
      steps.push({ ...s, startIdx: idx, text: instructionFor(s) });
    }
  }
  return {
    coords, cum, steps, dest,
    distance: osrmRoute.distance,
    duration: osrmRoute.duration,
    total: cum[cum.length - 1] || osrmRoute.distance,
  };
}

// Where is `pos` along the route? Returns segment index, offset and
// distance travelled. Searches a window around the last known index.
export function locateOnRoute(route, pos, hint = 0) {
  const proj = projector(pos.lat);
  const p = proj([pos.lat, pos.lon]);
  const { coords, cum } = route;
  const lo = Math.max(0, hint - 15);
  const hi = Math.min(coords.length - 1, hint + 400);
  let best = { seg: lo, t: 0, d: Infinity };
  const scan = (a, b) => {
    for (let i = a; i < b; i++) {
      const r = closestOnSegment(p, proj(coords[i]), proj(coords[i + 1]));
      if (r.d < best.d) best = { seg: i, t: r.t, d: r.d };
    }
  };
  scan(lo, hi);
  if (best.d > OFF_ROUTE_M && (lo > 0 || hi < coords.length - 1)) scan(0, coords.length - 1);
  if (coords.length === 1) best = { seg: 0, t: 0, d: haversine(pos, { lat: coords[0][0], lon: coords[0][1] }) };
  const segLen = (cum[best.seg + 1] ?? cum[best.seg]) - cum[best.seg];
  return { ...best, travelled: cum[best.seg] + best.t * segLen };
}

// ---- Module ------------------------------------------------------------

export function createNav(ctx) {
  const { settings } = ctx;
  const last = store.get('lastPos', null);
  const mapEl = document.getElementById('map');
  const view = createMapView(mapEl, { center: last ? [last.lat, last.lon] : [20, 0], zoom: last ? 16 : 2 });
  document.body.classList.toggle('map-vector', view.kind === 'vector');
  // Heading-up (map turns with the car) while navigating, like Android Auto.
  let headingUp = store.get('headingUp', true);
  let camBearing = 0;

  let pos = null;
  let follow = true;
  let route = null;
  let preview = null;
  let progress = null;
  let hint = 0;
  let offCount = 0;
  let lastReroute = 0;
  let rerouting = false;
  let announced = {};
  let lastPhoneFix = 0;
  let pendingDest = null;
  let doneIdx = -1;
  let sim = null;

  const el = {
    banner: $('#maneuver'),
    arrow: $('#maneuver .arrow'),
    dist: $('#maneuver .dist'),
    text: $('#maneuver .text'),
    then: $('#maneuver .then'),
    trip: $('#tripbar'),
    eta: $('#trip-eta'),
    remain: $('#trip-remain'),
    time: $('#trip-time'),
    searchForm: $('#nav-search'),
    searchInput: $('#nav-search input'),
    results: $('#nav-results'),
    previewCard: $('#route-preview'),
    recenter: $('#btn-recenter'),
    speedVal: $('#map-speed b'),
  };

  // ---- Positioning ----

  view.on('userpan', () => { follow = false; el.recenter.hidden = false; });
  el.recenter.addEventListener('click', () => {
    follow = true;
    el.recenter.hidden = true;
    if (pos) view.follow([pos.lat, pos.lon], { zoom: Math.max(view.getZoom(), 16) });
  });

  // Compass: shows north; tap to switch heading-up / north-up (or reset rotation).
  const compass = $('#btn-compass');
  compass.hidden = !view.canRotate;
  const needle = compass.querySelector('svg');
  view.on('rotate', (b) => { needle.style.transform = `rotate(${-b}deg)`; });
  compass.addEventListener('click', () => {
    if (route) {
      headingUp = !headingUp;
      store.set('headingUp', headingUp);
      toast(headingUp ? 'Heading up: the map turns with the car' : 'North up');
      if (!headingUp) view.resetNorth();
      follow = true;
      el.recenter.hidden = true;
    } else {
      view.resetNorth();
    }
  });
  const headingUpActive = () => view.canRotate && headingUp && !!route && follow;
  const lerpAngle = (a, b, k) => a + ((((b - a) % 360) + 540) % 360 - 180) * k;

  function ingest(fix, source) {
    if (sim && source !== 'sim') return;
    const mode = settings.gpsSource;
    if (source === 'phone') {
      lastPhoneFix = Date.now();
      if (mode === 'device') return;
    }
    if (source === 'device') {
      if (mode === 'phone') return;
      if (mode === 'auto' && Date.now() - lastPhoneFix < PHONE_GPS_FRESH_MS) return;
    }
    const prev = pos;
    let heading = Number.isFinite(fix.heading) ? fix.heading : prev?.heading ?? 0;
    let speed = Number.isFinite(fix.speed) ? fix.speed : null;
    if (prev) {
      const moved = haversine(prev, fix);
      const dt = (fix.time - prev.time) / 1000;
      if (moved > 4 && !Number.isFinite(fix.heading)) heading = bearing(prev, fix);
      if (speed == null && dt > 0) speed = moved / dt;
    }
    pos = { lat: fix.lat, lon: fix.lon, heading, speed: speed ?? 0, acc: fix.acc ?? 20, time: fix.time || Date.now(), source };
    onPosition();
  }

  let watchId = null;
  function startDeviceGps() {
    if (!('geolocation' in navigator)) return;
    watchId = navigator.geolocation.watchPosition(
      (p) => ingest({
        lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy,
        speed: p.coords.speed, heading: p.coords.heading, time: p.timestamp,
      }, 'device'),
      (err) => {
        if (err.code === 1 && settings.gpsSource !== 'phone') {
          toast('Location permission denied. Allow it, or share GPS from your phone.', 6000);
        }
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 },
    );
  }

  // Smoothly glide the car marker (and the camera) between GPS fixes at
  // display refresh rate, instead of jumping once per second.
  let shown = null;
  let animFrame = 0;
  let lastFixAt = 0;
  let lastHeading = null;
  let rotation = 0;
  function glideTo(target) {
    const now = performance.now();
    const dt = lastFixAt ? now - lastFixAt : 0;
    lastFixAt = now;
    const from = shown || target;
    const jump = haversine({ lat: from[0], lon: from[1] }, { lat: target[0], lon: target[1] });
    const dur = jump > 300 || !shown ? 0 : Math.min(1100, Math.max(250, dt));
    cancelAnimationFrame(animFrame);
    const t0 = now;
    const frame = (t) => {
      const k = dur ? Math.min(1, (t - t0) / dur) : 1;
      shown = [from[0] + (target[0] - from[0]) * k, from[1] + (target[1] - from[1]) * k];
      view.setCar(shown, rotation);
      if (follow && ctx.mapVisible()) {
        const zoom = view.getZoom() < 14 ? 16 : null;
        if (headingUpActive()) {
          camBearing = lerpAngle(camBearing, pos?.heading || 0, 0.12);
          // car sits low on screen with the road ahead visible, tilted
          view.follow(shown, { zoom, bearing: camBearing, pitch: 45, offsetY: mapEl.clientHeight * 0.35 });
        } else {
          view.follow(shown, { zoom });
        }
      }
      if (k < 1) animFrame = requestAnimationFrame(frame);
    };
    animFrame = requestAnimationFrame(frame);
  }

  let lastSave = 0;
  let lastSpeedText = '';
  function onPosition() {
    const ll = [pos.lat, pos.lon];
    const heading = Math.round(pos.heading || 0);
    if (heading !== lastHeading) {
      // accumulate rotation so 359°→1° turns 2°, not a full spin
      rotation = lastHeading == null ? heading : rotation + ((heading - lastHeading + 540) % 360) - 180;
      lastHeading = heading;
    }
    glideTo(ll);
    const st = ctx.speedText(pos.speed);
    if (st !== lastSpeedText) { lastSpeedText = st; el.speedVal.textContent = st; }
    if (Date.now() - lastSave > 30000) {
      lastSave = Date.now();
      store.set('lastPos', { lat: pos.lat, lon: pos.lon });
    }
    if (pendingDest) {
      const d = pendingDest;
      pendingDest = null;
      navigateTo(d);
    }
    if (route) updateGuidance();
    ctx.bus.emit('pos', pos);
  }

  // ---- Routing ----

  async function fetchRoute(from, to) {
    const url = `${OSRM}/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson&steps=true`;
    const j = await fetchJSON(url);
    if (j.code !== 'Ok' || !j.routes?.length) throw new Error(j.message || 'No route found');
    return buildRoute(j.routes[0], to);
  }

  function startPoint() {
    if (pos) return pos;
    if (settings.demo) {
      const [clat, clon] = view.getCenter();
      ingest({ lat: clat, lon: clon, speed: 0, time: Date.now() }, sim ? 'sim' : settings.gpsSource === 'phone' ? 'phone' : 'device');
      return pos;
    }
    return null;
  }

  async function previewTo(dest) {
    const from = startPoint();
    if (!from) {
      toast('Waiting for GPS… the route will start when your location is found.');
      pendingDest = dest;
      return;
    }
    el.previewCard.hidden = false;
    el.previewCard.innerHTML = `<div class="pv-title">${escapeHtml(dest.name || dest.label)}</div><div class="muted">Finding route…</div>`;
    try {
      preview = await fetchRoute(from, dest);
    } catch (e) {
      el.previewCard.innerHTML = `<div class="pv-title">${escapeHtml(dest.name || dest.label)}</div><div class="bad">Couldn't get a route: ${escapeHtml(e.message)}</div><div class="row"><button class="btn" data-act="cancel">Close</button></div>`;
      return;
    }
    view.setPreview(preview.coords);
    view.setDest([dest.lat, dest.lon]);
    follow = false;
    el.recenter.hidden = false;
    view.fitCoords(preview.coords, 70);
    const arrive = new Date(Date.now() + preview.duration * 1000);
    el.previewCard.innerHTML = `
      <div class="pv-title">${escapeHtml(dest.name || dest.label)}</div>
      <div class="pv-sub muted">${escapeHtml(dest.label || '')}</div>
      <div class="pv-stats"><b>${fmtDuration(preview.duration)}</b> · ${fmtDist(preview.distance, settings.units)} · arrive ${fmtClock(arrive)}</div>
      <div class="row">
        <button class="btn primary big" data-act="go">Start</button>
        <button class="btn" data-act="cancel">Cancel</button>
      </div>
      <div class="row wrap">
        <button class="btn small" data-act="gmaps">Open in Google Maps</button>
        <button class="btn small" data-act="waze">Open in Waze</button>
      </div>`;
  }

  el.previewCard.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'go' && preview) startRoute(preview);
    if (act === 'cancel') clearPreview();
    const d = preview?.dest;
    if (d && act === 'gmaps') openExternal(`https://www.google.com/maps/dir/?api=1&destination=${d.lat},${d.lon}&travelmode=driving&dir_action=navigate`);
    if (d && act === 'waze') openExternal(`https://waze.com/ul?ll=${d.lat},${d.lon}&navigate=yes`);
  });

  function clearPreview() {
    preview = null;
    view.setPreview(null);
    if (!route) view.setDest(null);
    el.previewCard.hidden = true;
  }

  function startRoute(r, { silent = false } = {}) {
    clearPreview();
    route = r;
    hint = 0;
    offCount = 0;
    announced = {};
    progress = null;
    view.setRoute(r.coords);
    view.setDone([]);
    doneIdx = -1;
    view.setDest([r.dest.lat, r.dest.lon]);
    follow = true;
    el.recenter.hidden = true;
    el.banner.hidden = false;
    el.trip.hidden = false;
    document.body.classList.add('navigating');
    store.set('lastDest', r.dest);
    if (!silent) {
      const first = r.steps[0];
      ctx.voice(`Starting route to ${r.dest.name || 'your destination'}. ${fmtDuration(r.duration).replace('min', 'minutes').replace(' h ', ' hours ')}. ${first ? first.text : ''}`);
    }
    if (settings.demo) startSim();
    if (pos) updateGuidance();
    ctx.bus.emit('nav', getState());
  }

  function stop({ arrived = false } = {}) {
    stopSim();
    route = null;
    progress = null;
    pendingDest = null;
    view.setRoute(null);
    view.setDest(null);
    if (view.canRotate && view.getBearing() !== 0) view.resetNorth();
    el.banner.hidden = true;
    el.trip.hidden = true;
    document.body.classList.remove('navigating');
    if (arrived) ctx.voice('You have arrived at your destination.');
    ctx.bus.emit('nav', getState());
  }

  async function reroute() {
    if (rerouting || !route || !pos) return;
    rerouting = true;
    lastReroute = Date.now();
    el.text.textContent = 'Recalculating…';
    try {
      const r = await fetchRoute(pos, route.dest);
      const wasDemo = !!sim;
      startRoute(r, { silent: true });
      if (!wasDemo) ctx.voice('Route recalculated.');
    } catch {
      toast('Rerouting failed — check the internet connection.');
    } finally {
      rerouting = false;
    }
  }

  function updateGuidance() {
    const loc = locateOnRoute(route, pos, hint);
    hint = loc.seg;
    // Off-route detection (ignore when GPS accuracy is poor).
    if (loc.d > OFF_ROUTE_M && (pos.acc ?? 0) < 50) offCount++;
    else offCount = 0;
    if (offCount >= 3 && Date.now() - lastReroute > 15000) {
      offCount = 0;
      reroute();
      return;
    }

    const remaining = Math.max(0, route.total - loc.travelled);
    const onRoute = loc.d <= OFF_ROUTE_M;
    if (onRoute && remaining < ARRIVE_M) { stop({ arrived: true }); return; }
    if (!onRoute) {
      // Snapping is meaningless while off route; wait for the reroute.
      el.dist.textContent = '';
      el.text.textContent = rerouting ? 'Recalculating…' : 'Off route';
      return;
    }

    let cur = 0;
    for (let i = 0; i < route.steps.length; i++) if (route.steps[i].startIdx <= loc.seg) cur = i;
    const nextIdx = Math.min(cur + 1, route.steps.length - 1);
    const next = route.steps[nextIdx];
    const toNext = Math.max(0, route.cum[next.startIdx] - loc.travelled);
    const afterNext = route.steps[nextIdx + 1];
    const remainingSec = route.duration * (remaining / route.total);

    progress = { stepIdx: nextIdx, toNext, remaining, remainingSec, next, afterNext, travelled: loc.travelled };

    if (el.arrow._step !== next) { el.arrow._step = next; el.arrow.innerHTML = arrowFor(next); }
    setText(el.dist, fmtDist(toNext, settings.units));
    setText(el.text, next.text);
    el.then.hidden = !(afterNext && route.cum[afterNext.startIdx] - route.cum[next.startIdx] < 150);
    if (!el.then.hidden) el.then.innerHTML = `Then ${arrowFor(afterNext)}`;
    setText(el.remain, fmtDist(remaining, settings.units));
    setText(el.time, fmtDuration(remainingSec));
    setText(el.eta, fmtClock(new Date(Date.now() + remainingSec * 1000)));

    if (loc.seg !== doneIdx) {
      doneIdx = loc.seg;
      view.setDone(route.coords.slice(0, loc.seg + 1).concat([[pos.lat, pos.lon]]));
    }

    // Voice prompts: far / near / now, once per step.
    const a = (announced[nextIdx] ||= {});
    const speed = pos.speed || 0;
    const far = Math.max(500, speed * 30);
    const near = Math.max(150, speed * 10);
    const now = Math.max(35, speed * 3);
    const say = (key, text) => { if (!a[key]) { a[key] = true; ctx.voice(text); } };
    if (toNext <= now) {
      a.far = a.near = true;
      say('now', next.maneuver.type === 'arrive' ? next.text : `${next.text}${afterNext && !el.then.hidden ? `, then ${afterNext.text}` : ''}`);
    } else if (toNext <= near) {
      a.far = true;
      say('near', `In ${sayDist(toNext, settings.units)}, ${lowerFirst(next.text)}`);
    } else if (toNext <= far && toNext > near * 1.5) {
      say('far', `In ${sayDist(toNext, settings.units)}, ${lowerFirst(next.text)}`);
    }

    ctx.bus.emit('nav', getState());
  }

  const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);
  const setText = (node, t) => { if (node.textContent !== t) node.textContent = t; };

  // ---- Demo drive: follows the active route at ~50 km/h ----

  function startSim() {
    stopSim();
    if (!route) return;
    let travelled = progress?.remaining != null ? route.total - progress.remaining : 0;
    const speed = 14; // m/s
    sim = setInterval(() => {
      travelled += speed;
      if (!route) return stopSim();
      const t = Math.min(travelled, route.total);
      let i = 0;
      while (i < route.cum.length - 2 && route.cum[i + 1] < t) i++;
      const seg = (route.cum[i + 1] - route.cum[i]) || 1;
      const f = Math.min(1, Math.max(0, (t - route.cum[i]) / seg));
      const a = route.coords[i];
      const b = route.coords[i + 1] || a;
      const fix = { lat: a[0] + (b[0] - a[0]) * f, lon: a[1] + (b[1] - a[1]) * f, speed, acc: 5, time: Date.now() };
      fix.heading = bearing({ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] });
      ingest(fix, 'sim');
    }, 1000);
  }

  function stopSim() {
    clearInterval(sim);
    sim = null;
  }

  // ---- Search UI ----

  async function runSearch(q) {
    q = q.trim();
    if (!q) return;
    el.results.hidden = false;
    el.results.innerHTML = '<div class="muted pad">Searching…</div>';
    try {
      const rows = await searchPlaces(q, pos);
      if (!rows.length) {
        el.results.innerHTML = '<div class="muted pad">No places found.</div>';
        return [];
      }
      el.results.innerHTML = rows.map((r, i) => `
        <button class="result" data-i="${i}">
          <b>${escapeHtml(r.name)}</b>
          <span class="muted">${escapeHtml(r.label)}</span>
          ${pos ? `<span class="dist">${fmtDist(haversine(pos, r), settings.units)}</span>` : ''}
        </button>`).join('');
      el.results._rows = rows;
      return rows;
    } catch (e) {
      el.results.innerHTML = `<div class="bad pad">Search failed: ${escapeHtml(e.message)}</div>`;
      return [];
    }
  }

  el.searchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    el.searchInput.blur();
    runSearch(el.searchInput.value);
  });
  el.results.addEventListener('click', (e) => {
    const b = e.target.closest('.result');
    if (!b) return;
    const r = el.results._rows[+b.dataset.i];
    el.results.hidden = true;
    addRecent(r);
    previewTo(r);
  });
  el.searchInput.addEventListener('focus', () => renderRecents());

  function addRecent(place) {
    const list = store.get('recents', []).filter((p) => p.label !== place.label);
    list.unshift({ name: place.name, label: place.label, lat: place.lat, lon: place.lon });
    store.set('recents', list.slice(0, 8));
    ctx.bus.emit('recents');
  }

  function renderRecents() {
    const items = [];
    if (settings.home) items.push({ ...settings.home, name: '🏠 Home' });
    if (settings.work) items.push({ ...settings.work, name: '💼 Work' });
    items.push(...store.get('recents', []));
    if (!items.length || el.searchInput.value) return;
    el.results.hidden = false;
    el.results._rows = items;
    el.results.innerHTML = items.map((r, i) => `
      <button class="result" data-i="${i}"><b>${escapeHtml(r.name)}</b><span class="muted">${escapeHtml(r.label || '')}</span></button>`).join('');
  }

  view.on('click', () => { el.results.hidden = true; });

  // ---- Public API ----

  function navigateTo(dest, { immediate = false } = {}) {
    ctx.showMap();
    if (!dest.label) dest.label = `${dest.lat.toFixed(5)}, ${dest.lon.toFixed(5)}`;
    if (!dest.name) dest.name = dest.label.split(',')[0];
    if (immediate) {
      const from = startPoint();
      if (!from) { pendingDest = dest; toast('Waiting for GPS…'); return; }
      fetchRoute(from, dest).then((r) => startRoute(r)).catch((e) => toast(`Couldn't get a route: ${e.message}`));
    } else {
      previewTo(dest);
    }
  }

  async function searchAndGo(q, { immediate = false } = {}) {
    ctx.showMap();
    el.searchInput.value = q;
    const rows = await runSearch(q);
    if (rows?.length) {
      el.results.hidden = true;
      addRecent(rows[0]);
      navigateTo(rows[0], { immediate });
    } else {
      ctx.voice(`Sorry, I couldn't find ${q}`);
    }
  }

  function getState() {
    if (!route) return { active: false };
    return {
      active: true,
      dest: route.dest.name,
      text: progress?.next?.text || route.steps[0]?.text || '',
      toNext: progress?.toNext ?? null,
      remaining: progress?.remaining ?? route.total,
      eta: Date.now() + (progress?.remainingSec ?? route.duration) * 1000,
      toNextText: progress ? fmtDist(progress.toNext, settings.units) : '',
      upcoming: progress
        ? route.steps.slice(progress.stepIdx, progress.stepIdx + 3).map((step) => ({ step, at: Math.max(0, route.cum[step.startIdx] - progress.travelled) }))
        : route.steps.slice(1, 4).map((step) => ({ step, at: route.cum[step.startIdx] })),
      remainingText: fmtDist(progress?.remaining ?? route.total, settings.units),
    };
  }

  $('#btn-stop-nav').addEventListener('click', () => stop());

  // Keep Leaflet in sync when the pane changes size (split ↔ full screen).
  if ('ResizeObserver' in window) {
    let raf = 0;
    new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        view.resize();
        if (shown && follow) view.follow(shown);
      });
    }).observe(document.getElementById('map'));
  }

  startDeviceGps();

  return {
    map: view,
    navigateTo,
    searchAndGo,
    // Show search results for a spoken or typed place (the driver picks one).
    search(q) {
      el.searchInput.value = q;
      return runSearch(q);
    },
    stop,
    getState,
    getPos: () => pos,
    ingest,
    setDemo(on) {
      if (on && route) startSim();
      if (!on) stopSim();
    },
    refresh() {
      requestAnimationFrame(() => {
        view.resize();
        if (shown && follow) view.follow(shown, { zoom: view.getZoom() < 14 ? 16 : null });
      });
    },
    destroy() {
      if (watchId != null) navigator.geolocation.clearWatch(watchId);
      stopSim();
    },
  };
}
