// Phone remote: pairs with the car display and sends it destinations,
// media commands, messages and (optionally) live GPS.

import {
  $, $$, store, toast, escapeHtml, normalizeCode, parseLocationText, stripUrls,
  searchPlaces, fmtClock, keepAwake, registerServiceWorker, debounce,
} from '../common.js';
import { PhoneClient, transportFromUrl } from '../link.js';

const defaultName = /iPhone/.test(navigator.userAgent) ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android phone' : 'Phone';
let name = store.get('phoneName', defaultName);
let pairing = store.get('pairing', null); // { code, server }
let client = null;
let carInfo = { carName: 'car', home: null, work: null };
let carState = null;
let gpsWatch = null;
let releaseWake = null;

// Inside the Car-Auto Link Android app, window.CarAutoLink gives access to the
// phone's media sessions, calls, contacts and call log.
const native = window.CarAutoLink || null;
const parseJson = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
window.carautoNative = {
  onEvent(ev) {
    if (!client) return;
    if (ev.type === 'media') client.send({ t: 'phoneMedia', media: ev.media });
    else if (ev.type === 'call') client.send({ t: 'phoneCall', ...ev });
    else if (ev.type === 'message') client.send({ t: 'phoneMsg', msg: ev });
    else if (ev.type === 'lanFound') client.lanFound(ev.addr);
    else if (ev.type === 'btLink') client.btEvent(ev);
  },
};

// Send a long list in small pages (data-channel messages must stay small).
function sendPaged(type, items, size = 150) {
  const pages = Math.max(1, Math.ceil(items.length / size));
  for (let page = 0; page < pages; page++) {
    client.send({ t: type, page, pages, items: items.slice(page * size, (page + 1) * size) });
  }
}

function sendContacts() {
  const items = parseJson(native.getContacts(), []);
  const size = 150; // keep each data-channel message small
  const pages = Math.max(1, Math.ceil(items.length / size));
  for (let page = 0; page < pages; page++) {
    client.send({ t: 'contacts', page, pages, items: items.slice(page * size, (page + 1) * size) });
  }
}

function pushNativeState() {
  client.send({ t: 'phoneMedia', media: parseJson(native.getMedia(), null) });
  const call = parseJson(native.getCall(), null);
  if (call && call.state !== 'idle') client.send({ t: 'phoneCall', ...call });
}

// ---- Pairing from QR (#pair=CODE&srv=...) ----
(function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  const code = normalizeCode(h.get('pair'));
  if (!code) return;
  let server = null;
  try { server = h.get('srv') ? JSON.parse(atob(h.get('srv'))) : null; } catch { /* ignore bad server */ }
  pairing = { code, server };
  store.set('pairing', pairing);
  history.replaceState(null, '', location.pathname + location.search);
}());

// ---- Shared content (Android share sheet → this app) ----
const params = new URLSearchParams(location.search);
const shared = [params.get('title'), params.get('text'), params.get('url')].filter(Boolean).join(' ');

function setStatus(text, cls) {
  const s = $('#status');
  s.textContent = text;
  s.className = `status-pill ${cls || ''}`;
}

function showViews() {
  $('#pair-view').hidden = !!pairing;
  $('#remote-view').hidden = !pairing;
  if (!pairing) setStatus('Not paired');
}

function connect() {
  client?.stop();
  if (!pairing) return showViews();
  showViews();
  client = new PhoneClient(pairing.code, {
    transport: transportFromUrl(),
    server: pairing.server,
    name,
    caps: native ? { native: true, media: true, calls: true, contacts: true } : null,
    lan: native,
  });
  client.on('status', ({ state, message }) => {
    native?.onStatus(state, state === 'connected' ? ({ lan: 'direct', bluetooth: 'bluetooth' }[client.via] || 'internet') : (message || ''));
    if (state === 'connected' && native) pushNativeState();
    if (state === 'connected') setStatus(`Connected to ${carInfo.carName}`, 'good');
    else if (state === 'connecting') setStatus('Connecting to car…', 'warn');
    else setStatus(message || 'Disconnected', state === 'error' ? 'bad' : 'warn');
  });
  client.on('message', onMessage);
  client.start();
}

function onMessage(msg) {
  if (native) {
    switch (msg.t) {
      case 'pmedia': native.mediaCmd(msg.cmd); return;
      case 'pcall': native.placeCall(String(msg.number || '')); return;
      case 'pcallAction': native.callAction(msg.action); return;
      case 'getContacts': sendContacts(); return;
      case 'getRecents': client.send({ t: 'recents', items: parseJson(native.getRecents(), []) }); return;
      case 'msgReply': client.send({ t: 'msgReplyResult', id: msg.id, ok: !!native.replyMessage?.(String(msg.id), String(msg.text || '')) }); return;
      case 'getSms': client.send({ t: 'sms', items: parseJson(native.getSms?.() || '[]', []) }); return;
      case 'smsSend': client.send({ t: 'msgReplyResult', id: msg.id, ok: !!native.sendSms?.(String(msg.number), String(msg.text || '')) }); return;
      case 'getMusic': sendPaged('music', parseJson(native.getMusic?.() || '[]', [])); return;
      case 'playMusic': native.playMusic?.(JSON.stringify(msg.ids || []), Number(msg.index) || 0); return;
      default: break;
    }
  }
  if (msg.t === 'welcome') {
    carInfo = { ...carInfo, ...msg };
    setStatus(`Connected to ${carInfo.carName}`, 'good');
  } else if (msg.t === 'state') {
    carState = msg;
    renderState();
  }
}

// ---- Render car state ----

function renderState() {
  const m = carState?.music || {};
  $('#np-title').textContent = m.title || 'Nothing playing';
  $('#np-sub').textContent = m.sub || '';
  $('#np-toggle').textContent = m.playing ? '❚❚' : '▶';
  if (document.activeElement !== $('#np-volume') && m.volume != null) $('#np-volume').value = Math.round(m.volume * 100);

  const n = carState?.nav || {};
  const ns = $('#nav-status');
  if (n.active) {
    ns.className = 'nav-status';
    ns.innerHTML = `<div class="tile-label">To ${escapeHtml(n.dest || '')}</div><b>${escapeHtml(n.toNextText || '')}</b> ${escapeHtml(n.text || '')}<div class="muted">${escapeHtml(n.remainingText || '')} · arrive ${fmtClock(new Date(n.eta))}</div>`;
  } else {
    ns.className = 'nav-status muted';
    ns.textContent = 'Not navigating';
  }
  $('#btn-stop-nav').hidden = !n.active;
}

// ---- Destinations ----

function sendDestination(place, start = true) {
  client.send({ t: 'nav', lat: place.lat, lon: place.lon, name: place.name, label: place.label, start });
  toast(`📍 Sent to ${carInfo.carName}: ${place.name}`);
  $('#dest-results').innerHTML = '';
  const recents = store.get('phoneRecents', []).filter((r) => r.label !== place.label);
  recents.unshift(place);
  store.set('phoneRecents', recents.slice(0, 6));
}

let lastPhonePos = null;
async function searchDest(q) {
  q = q.trim();
  if (!q) return;
  const box = $('#dest-results');
  const coords = parseLocationText(q);
  if (coords) {
    const place = { ...coords, name: 'Shared location', label: `${coords.lat.toFixed(5)}, ${coords.lon.toFixed(5)}` };
    box.innerHTML = resultHtml([place]);
    box._rows = [place];
    return;
  }
  const text = stripUrls(q);
  if (!text) {
    box.innerHTML = '<div class="muted pad">This link has no coordinates. Copy the place name or address instead.</div>';
    return;
  }
  box.innerHTML = '<div class="muted pad">Searching…</div>';
  try {
    const rows = await searchPlaces(text, lastPhonePos);
    box._rows = rows;
    box.innerHTML = rows.length ? resultHtml(rows) : '<div class="muted pad">No places found.</div>';
  } catch (e) {
    box.innerHTML = `<div class="bad pad">Search failed: ${escapeHtml(e.message)}</div>`;
  }
}

function resultHtml(rows) {
  return rows.map((r, i) => `
    <div class="result-row">
      <div class="meta"><b>${escapeHtml(r.name)}</b><span class="muted small">${escapeHtml(r.label)}</span></div>
      <button class="btn primary" data-send="${i}">Go</button>
    </div>`).join('');
}

$('#dest-form').addEventListener('submit', (e) => {
  e.preventDefault();
  e.target.q.blur();
  searchDest(e.target.q.value);
});

$('#dest-results').addEventListener('click', (e) => {
  const b = e.target.closest('[data-send]');
  if (b) sendDestination($('#dest-results')._rows[+b.dataset.send]);
});

$('#dest-form').q.addEventListener('focus', () => {
  const recents = store.get('phoneRecents', []);
  const box = $('#dest-results');
  if (!recents.length || $('#dest-form').q.value) return;
  box._rows = recents;
  box.innerHTML = `<div class="tile-label pad">Recent</div>${resultHtml(recents)}`;
});

$$('[data-place]').forEach((b) => b.addEventListener('click', () => {
  const key = b.dataset.place;
  const p = carInfo[key];
  if (!p) return toast(`Set ${key === 'home' ? 'Home' : 'Work'} in the car's Settings first`);
  sendDestination({ ...p, name: key === 'home' ? 'Home' : 'Work' });
}));

$('#btn-paste').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    $('#dest-form').q.value = text;
    searchDest(text);
  } catch {
    toast('Long-press the search box and choose Paste');
    $('#dest-form').q.focus();
  }
});

$('#btn-stop-nav').addEventListener('click', () => client.send({ t: 'stopNav' }));

// ---- Media ----

$$('[data-media]').forEach((b) => b.addEventListener('click', () => {
  client.send({ t: 'media', cmd: b.dataset.media });
  if (navigator.vibrate) navigator.vibrate(15);
}));
const sendVolume = debounce((v) => client.send({ t: 'media', cmd: 'volume', value: v }), 80);
$('#np-volume').addEventListener('input', (e) => sendVolume(e.target.value / 100));

// ---- Message ----

$('#say-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = e.target.text.value.trim();
  if (!text) return;
  client.send({ t: 'say', text, from: name });
  e.target.reset();
  toast('Message sent to car');
});

// ---- GPS sharing ----

function setGps(on) {
  if (gpsWatch != null) { navigator.geolocation.clearWatch(gpsWatch); gpsWatch = null; }
  releaseWake?.();
  releaseWake = null;
  store.set('shareGps', on);
  $('#gps-toggle').checked = on;
  if (!on) {
    $('#gps-status').textContent = 'Not sharing.';
    return;
  }
  if (!('geolocation' in navigator)) {
    $('#gps-status').textContent = 'Location is not available on this phone.';
    return;
  }
  releaseWake = keepAwake(true);
  $('#gps-status').textContent = 'Waiting for GPS fix…';
  gpsWatch = navigator.geolocation.watchPosition((p) => {
    const c = p.coords;
    lastPhonePos = { lat: c.latitude, lon: c.longitude };
    client?.send({ t: 'gps', lat: c.latitude, lon: c.longitude, acc: c.accuracy, speed: c.speed, heading: c.heading });
    $('#gps-status').textContent = `Sharing location (±${Math.round(c.accuracy)} m). Keep this screen open.`;
  }, (err) => {
    $('#gps-status').textContent = err.code === 1 ? 'Location permission denied. Enable it in your browser settings.' : 'Waiting for GPS signal…';
    if (err.code === 1) { $('#gps-toggle').checked = false; store.set('shareGps', false); }
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
}
$('#gps-toggle').addEventListener('change', (e) => setGps(e.target.checked));

// ---- Pair / settings ----

$('#pair-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = normalizeCode(e.target.code.value);
  if (!code) return toast('Codes look like ABCD-1234 (8 letters/numbers)');
  pairing = { code, server: null };
  store.set('pairing', pairing);
  connect();
});

$('#btn-menu').addEventListener('click', () => {
  $('#set-name').value = name;
  $('#paired-info').textContent = pairing ? `Paired with code ${pairing.code}` : 'Not paired';
  $('#btn-unpair').hidden = !pairing;
  $('#menu').showModal();
});
$('#set-name').addEventListener('change', (e) => {
  name = e.target.value.trim() || defaultName;
  store.set('phoneName', name);
  if (client) { client.name = name; client.send({ t: 'hello', name }); }
});
$('#btn-unpair').addEventListener('click', () => {
  if (!confirm('Unpair from this car?')) return;
  setGps(false);
  client?.stop();
  client = null;
  pairing = null;
  store.remove('pairing');
  $('#menu').close();
  showViews();
});
$('#btn-install-help').addEventListener('click', () => $('#install-help').showModal());

// ---- Start ----

store.set('role', 'phone');
connect();
if (native && params.get('gps') === '1') setGps(true);
else if (pairing && store.get('shareGps', false)) setGps(true);

// In a normal Android browser, point to the Android app for music & calls.
if (!native && /Android/i.test(navigator.userAgent)) {
  const banner = $('#app-banner');
  banner.hidden = false;
  if (pairing) {
    $('#open-in-app').href = `intent://pair?code=${encodeURIComponent(pairing.code)}#Intent;scheme=carauto;package=app.carauto.link;end`;
    $('#open-in-app').hidden = false;
  }
}
if (pairing && shared) {
  history.replaceState(null, '', location.pathname);
  $('#dest-form').q.value = shared;
  searchDest(shared).then(() => {
    const rows = $('#dest-results')._rows;
    if (rows?.length === 1 && parseLocationText(shared)) sendDestination(rows[0]);
  });
}
registerServiceWorker();

window.carautoPhone = { get client() { return client; }, get state() { return carState; } };
