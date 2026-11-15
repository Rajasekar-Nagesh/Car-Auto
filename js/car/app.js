// Car display entry point: taskbar + split-screen dashboard + full-screen apps.
// The map is created once and never torn down; apps open as overlays on top.

import {
  $, $$, store, toast, speak, fmtSpeed, genPairCode, keepAwake,
  registerServiceWorker, searchPlaces, escapeHtml, debounce, fmtClock, openExternal,
} from '../common.js';
import { CarHost, transportFromUrl, loadScript } from '../link.js';
import { createNav } from './nav.js';
import { createMusic } from './music.js';
import { createPhone } from './phone.js';
import { createVoice } from './voice.js';
import { createHome } from './home.js';
import { createCalls } from './calls.js';

// The Car-Auto Dash Android app (stereo) exposes window.CarAutoNative and
// delivers events (media keys, voice results) through this hook.
const native = window.CarAutoNative || null;
window.carautoNative = { onEvent: (ev) => { try { bus.emit(`native:${ev.type}`, ev); } catch (e) { console.error(e); } } };

const DEFAULTS = {
  carName: 'My Car',
  units: 'km',
  voiceGuidance: true,
  gpsSource: 'auto', // auto | device | phone
  theme: 'auto', // map colors: auto | day | night
  keepAwake: true,
  demo: false,
  home: null,
  work: null,
  peerServer: null,
};

const settings = { ...DEFAULTS, ...store.get('settings', {}) };
const saveSettings = () => store.set('settings', settings);

const bus = {
  t: new EventTarget(),
  emit(type, detail) { this.t.dispatchEvent(new CustomEvent(type, { detail })); },
  on(type, fn) { this.t.addEventListener(type, (e) => fn(e.detail)); },
};

// Views: 'home' (split screen) and 'map' (full map) show the dashboard;
// everything else is a full-screen app over it.
const DASH_VIEWS = new Set(['home', 'map']);
let currentView = 'home';
let music;
let nav;

const ctx = {
  settings,
  bus,
  showView,
  showMap: () => { if (!DASH_VIEWS.has(currentView)) showView('home'); },
  isViewVisible: (v) => currentView === v,
  mapVisible: () => DASH_VIEWS.has(currentView),
  speedText: (ms) => fmtSpeed(ms, settings.units),
  voice(text) {
    if (!settings.voiceGuidance || !text) return;
    music?.duck(true);
    speak(text);
    clearTimeout(ctx._unduck);
    ctx._unduck = setTimeout(() => music?.duck(false), Math.min(9000, 1500 + text.length * 70));
  },
  emitState: debounce(() => broadcastState(), 150),
};

function showView(name, { fromHistory = false } = {}) {
  if (name === currentView) return;
  const wasApp = !DASH_VIEWS.has(currentView);
  currentView = name;
  const isDash = DASH_VIEWS.has(name);
  $$('.app-view').forEach((v) => { v.hidden = v.id !== `view-${name}`; });
  document.body.classList.toggle('map-full', name === 'map');
  $$('.taskbar [data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  if (isDash) nav?.refresh();
  if (name === 'music') music?.onShow();
  if (name === 'settings') renderPairing();
  if (name === 'messages') renderMessages();
  if (name === 'apps') renderStereoApps();
  // Android back button / gesture closes apps and returns to the dashboard.
  if (!fromHistory) {
    if (!isDash && !wasApp) history.pushState({ app: name }, '');
    else if (!isDash && wasApp) history.replaceState({ app: name }, '');
    else if (isDash && wasApp) history.back();
  }
}
window.addEventListener('popstate', () => {
  if (!DASH_VIEWS.has(currentView)) showView('home', { fromHistory: true });
});

$$('.taskbar [data-view]').forEach((b) => b.addEventListener('click', () => {
  const v = b.dataset.view;
  // Tapping Maps again while it is full screen returns to split screen.
  showView(v === 'map' && currentView === 'map' ? 'home' : v);
}));
$('#btn-expand').addEventListener('click', () => showView(currentView === 'map' ? 'home' : 'map'));

// ---- Map colors (UI stays dark like a car head unit; map follows daylight) ----

function applyTheme() {
  let night = settings.theme === 'night';
  if (settings.theme === 'auto') {
    const h = new Date().getHours() + new Date().getMinutes() / 60;
    night = h >= 18.75 || h < 6.5;
  }
  document.body.classList.toggle('night-map', night);
  document.body.classList.toggle('day-map', !night);
}
applyTheme();
setInterval(applyTheme, 5 * 60000);

// ---- Modules ----

// Native phone link (Car-Auto Link app on an Android phone).
let nativeLinkId = null;
ctx.phoneLink = {
  available: () => !!nativeLinkId && !!host?.clients.has(nativeLinkId),
  send: (m) => host?.clients.get(nativeLinkId)?.send(m),
};

const home = createHome(ctx);
const phone = createPhone(ctx);
ctx.phone = phone;
music = createMusic(ctx);
ctx.music = music;
nav = createNav(ctx);
ctx.nav = nav;
const voice = createVoice(ctx);
ctx.voiceCmd = voice;
const calls = createCalls(ctx);
ctx.calls = calls;
bus.on('notify', ({ from, text }) => showMessage(from, text, { silent: true }));

// Steering-wheel / hardware media keys forwarded by the Android app.
bus.on('native:media', ({ cmd }) => ({ play: music.resume, pause: music.pause, toggle: music.toggle, next: music.next, prev: music.prev }[cmd])?.());
bus.on('recents', () => home.refreshSuggestions());

$('#btn-voice').addEventListener('click', () => voice.listen());
const setSpeedUnit = () => { $('#speed-unit').textContent = settings.units === 'mi' ? 'mph' : 'km/h'; };
setSpeedUnit();

// ---- Launcher ----

$('#view-apps').addEventListener('click', (e) => {
  const open = e.target.closest('[data-open]')?.dataset.open;
  if (!open) return;
  if (open === 'voice') { showView('home'); voice.listen(); return; }
  if (open === 'fullscreen') { toggleFullscreen(); return; }
  if (open === 'radio') { showView('music'); music.openTab('browse'); return; }
  if (open === 'aa') { startAndroidAuto(); return; }
  showView(open);
});

// Real Android Auto projection is provided by the free Open Headunit app
// (github.com/andreknieriem/open-headunit), launched as a separate app.
const AA_PKG = 'com.andrerinas.headunitrevived';
const AA_DOWNLOAD = 'https://github.com/andreknieriem/open-headunit/releases';
function startAndroidAuto() {
  if (native?.launchApp && native.launchApp(AA_PKG)) {
    toast('Starting Android Auto… connect your phone by USB or wireless');
    return true;
  }
  ctx.voice('To use Android Auto, install the Open Headunit app on this stereo.');
  toast('Install the free Open Headunit app on this stereo for real Android Auto', 6000);
  openExternal(AA_DOWNLOAD);
  return false;
}
ctx.startAndroidAuto = startAndroidAuto;

// Apps installed on the stereo (Android app) or quick links (browser).
const WEB_APPS = [
  { label: 'Google Maps', url: 'https://www.google.com/maps', color: '#188038' },
  { label: 'Waze', url: 'https://waze.com/ul', color: '#33ccff' },
  { label: 'Spotify', url: 'https://open.spotify.com', color: '#1db954' },
  { label: 'YouTube Music', url: 'https://music.youtube.com', color: '#c4302b' },
  { label: 'YouTube', url: 'https://m.youtube.com', color: '#e62117' },
];
let stereoApps = null;
function renderStereoApps() {
  const grid = $('#stereo-apps');
  const hint = $('#stereo-apps-hint');
  if (native?.listApps) {
    if (!stereoApps) {
      try { stereoApps = JSON.parse(native.listApps()); } catch { stereoApps = []; }
    }
    grid.innerHTML = stereoApps.map((a, i) => `<button class="launch" data-pkg="${i}"><span class="ic ic-app"><img src="${a.icon}" alt="" decoding="async"></span><span class="lbl">${escapeHtml(a.label)}</span></button>`).join('');
    hint.textContent = '';
  } else {
    $('#stereo-apps-head').textContent = 'Open in app';
    grid.innerHTML = WEB_APPS.map((a, i) => `<button class="launch" data-web="${i}"><span class="ic ic-letter" style="background:${a.color}">${escapeHtml(a.label.charAt(0))}</span><span class="lbl">${escapeHtml(a.label)}</span></button>`).join('');
    hint.innerHTML = 'Install the <a href="apk/car-auto-dash.apk">Car-Auto Dash</a> Android app on this stereo to open every installed app from here and start automatically with the car.';
  }
}
$('#stereo-apps').addEventListener('click', (e) => {
  const b = e.target.closest('.launch');
  if (!b) return;
  if (b.dataset.pkg != null) native.launchApp(stereoApps[+b.dataset.pkg].pkg);
  else openExternal(WEB_APPS[+b.dataset.web].url);
});
ctx.openStereoApp = (name) => {
  if (/^(android auto|headunit|open headunit)$/i.test(name.trim())) { startAndroidAuto(); return true; }
  if (!native?.listApps) return false;
  renderStereoApps();
  const q = name.toLowerCase();
  const app = stereoApps.find((a) => a.label.toLowerCase() === q) || stereoApps.find((a) => a.label.toLowerCase().includes(q));
  if (app) native.launchApp(app.pkg);
  return !!app;
};

// ---- Notifications (messages sent from the phone) ----

let messages = store.get('messages', []);
let unread = 0;
function updateBadge() {
  const badge = $('#msg-badge');
  badge.hidden = !unread;
  badge.textContent = unread;
}

function renderMessages() {
  unread = 0;
  updateBadge();
  $('#message-list').innerHTML = messages.length
    ? messages.map((m, i) => `
      <div class="msg">
        <span class="avatar">${escapeHtml((m.from || '?').charAt(0).toUpperCase())}</span>
        <div class="meta"><b>${escapeHtml(m.from)}</b> <span class="muted small">${fmtClock(new Date(m.at))}</span><p>${escapeHtml(m.text)}</p></div>
        <button class="btn small" data-read="${i}">Read</button>
      </div>`).join('')
    : '<div class="empty muted">No notifications</div>';
}
$('#message-list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-read]');
  if (b) { const m = messages[+b.dataset.read]; speak(`${m.from} says: ${m.text}`); }
});
$('#btn-clear-msgs').addEventListener('click', () => { messages = []; store.set('messages', messages); renderMessages(); });

let huTimer;
let huMsg = null;
function showMessage(from, text, { silent = false } = {}) {
  const m = { from, text, at: Date.now() };
  messages.unshift(m);
  messages = messages.slice(0, 30);
  store.set('messages', messages);
  if (currentView === 'messages') renderMessages(); else { unread++; updateBadge(); }
  huMsg = m;
  const box = $('#message-overlay');
  box.querySelector('.from').textContent = from;
  box.querySelector('.body').textContent = text;
  box.hidden = false;
  if (!silent) speak(`Message from ${from}. ${text}`);
  clearTimeout(huTimer);
  huTimer = setTimeout(() => { box.hidden = true; }, 12000);
}
$('#message-overlay').addEventListener('click', (e) => {
  const act = e.target.closest('[data-hu]')?.dataset.hu;
  if (act === 'read' && huMsg) speak(`${huMsg.from} says: ${huMsg.text}`);
  else e.currentTarget.hidden = true;
});

// ---- Phone link ----

let code = store.get('pairCode', null);
if (!code) { code = genPairCode(); store.set('pairCode', code); }
let host = null;
let linkState = 'offline';

function phoneUrl() {
  const u = new URL('phone.html', location.href);
  if (transportFromUrl() === 'local') u.searchParams.set('transport', 'local');
  const hash = new URLSearchParams({ pair: code });
  if (settings.peerServer?.host) hash.set('srv', btoa(JSON.stringify(settings.peerServer)));
  u.hash = hash.toString();
  return u.toString();
}

function startLink() {
  host?.stop();
  host = new CarHost(code, { transport: transportFromUrl(), server: settings.peerServer });
  host.on('status', ({ state, message }) => {
    linkState = state;
    $('#pair-status').textContent = state === 'online' ? 'Online — ready for phones' : message || state;
    $('#pair-status').className = state === 'online' ? 'good' : state === 'error' ? 'bad' : 'muted';
    bus.emit('link', { count: host.clientCount, state });
  });
  host.on('clients', ({ count }) => {
    bus.emit('link', { count, state: linkState });
    if (nativeLinkId && !host.clients.has(nativeLinkId)) {
      nativeLinkId = null;
      music.setPhoneMedia(null);
      bus.emit('phone:linked', false);
    }
  });
  host.on('join', ({ send }) => {
    send({ t: 'welcome', carName: settings.carName, home: settings.home, work: settings.work });
    send(stateMsg());
  });
  host.on('message', ({ id, msg, reply }) => handlePhoneMessage(msg, reply, id));
  host.start();
}

function stateMsg() {
  const n = nav.getState();
  delete n.upcoming;
  return { t: 'state', music: music.getState(), nav: n, gpsSource: settings.gpsSource };
}

function broadcastState() {
  if (host?.clientCount) host.broadcast(stateMsg());
}
bus.on('nav', debounce(broadcastState, 500));

function handlePhoneMessage(msg, reply, id) {
  switch (msg.t) {
    case 'hello':
      if (msg.caps?.native && nativeLinkId !== id) {
        nativeLinkId = id;
        toast(`${msg.name || 'Phone'} linked: music, calls and contacts`);
        bus.emit('phone:linked', true);
      } else if (!msg.caps?.native) {
        toast(`${msg.name || 'Phone'} connected`);
      }
      break;
    case 'phoneMedia':
      if (id === nativeLinkId) music.setPhoneMedia(msg.media);
      break;
    case 'phoneCall':
      if (id === nativeLinkId) bus.emit('phone:call', msg);
      break;
    case 'contacts':
      if (id === nativeLinkId) bus.emit('phone:contacts', msg);
      break;
    case 'recents':
      if (id === nativeLinkId) bus.emit('phone:recents', msg);
      break;
    case 'nav':
      if (Number.isFinite(msg.lat) && Number.isFinite(msg.lon)) {
        toast(`Destination from phone: ${msg.name || msg.label || ''}`);
        nav.navigateTo({ lat: msg.lat, lon: msg.lon, name: msg.name, label: msg.label }, { immediate: !!msg.start });
      } else if (msg.query) {
        nav.searchAndGo(msg.query);
      }
      break;
    case 'stopNav':
      nav.stop();
      break;
    case 'media': {
      const fns = { toggle: music.toggle, play: music.resume, pause: music.pause, next: music.next, prev: music.prev };
      if (msg.cmd === 'volume') music.setVolume(Number(msg.value));
      else fns[msg.cmd]?.();
      break;
    }
    case 'say':
      showMessage(msg.from || 'Phone', String(msg.text || '').slice(0, 500));
      break;
    case 'gps':
      nav.ingest({ ...msg, time: Date.now() }, 'phone');
      break;
    case 'call':
      phone.call(msg.number, msg.name);
      break;
    case 'getState':
      reply(stateMsg());
      break;
    default:
      break;
  }
}

// ---- Settings ----

async function renderPairing() {
  $('#pair-code').textContent = code;
  const url = phoneUrl();
  $('#pair-url').textContent = url;
  try {
    await loadScript(new URL('../../vendor/qrcode/qrcode.js', import.meta.url).href, () => window.qrcode);
    const qr = window.qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    $('#pair-qr').innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  } catch {
    $('#pair-qr').textContent = 'QR unavailable — use the code';
  }
}

function bindSetting(id, key, { parse = (v) => v, after } = {}) {
  const input = $(id);
  if (input.type === 'checkbox') input.checked = !!settings[key];
  else input.value = settings[key] ?? '';
  input.addEventListener('change', () => {
    settings[key] = input.type === 'checkbox' ? input.checked : parse(input.value);
    saveSettings();
    after?.(settings[key]);
  });
}

bindSetting('#set-carname', 'carName');
bindSetting('#set-units', 'units', { after: () => { home.refreshUnits(); setSpeedUnit(); broadcastState(); } });
bindSetting('#set-voice', 'voiceGuidance');
bindSetting('#set-gps', 'gpsSource', { after: broadcastState });
bindSetting('#set-theme', 'theme', { after: applyTheme });
bindSetting('#set-awake', 'keepAwake', { after: (v) => v && keepAwake(true) });
bindSetting('#set-demo', 'demo', { after: (v) => { nav.setDemo(v); toast(v ? 'Demo drive on: routes will be driven automatically' : 'Demo drive off'); } });

$('#btn-new-code').addEventListener('click', () => {
  if (!confirm('Create a new pairing code? Paired phones will need to scan again.')) return;
  code = genPairCode();
  store.set('pairCode', code);
  renderPairing();
  startLink();
});

function renderPlaces() {
  for (const key of ['home', 'work']) {
    const p = settings[key];
    $(`#place-${key} .place-val`).textContent = p ? p.label : 'Not set';
  }
  home.refreshSuggestions();
}

$$('.place').forEach((row) => {
  const key = row.dataset.place;
  row.querySelector('[data-act=here]').addEventListener('click', () => {
    const pos = nav.getPos();
    if (!pos) return toast('Location not available yet');
    settings[key] = { lat: pos.lat, lon: pos.lon, label: `Current location (${pos.lat.toFixed(4)}, ${pos.lon.toFixed(4)})` };
    saveSettings();
    renderPlaces();
  });
  row.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = e.target.q.value.trim();
    if (!q) return;
    try {
      const [first] = await searchPlaces(q, nav.getPos());
      if (!first) return toast('Address not found');
      settings[key] = { lat: first.lat, lon: first.lon, label: first.label };
      saveSettings();
      e.target.reset();
      renderPlaces();
      toast(`${key === 'home' ? 'Home' : 'Work'} saved`);
    } catch (err) {
      toast(`Search failed: ${err.message}`);
    }
  });
  row.querySelector('[data-act=clear]').addEventListener('click', () => {
    settings[key] = null;
    saveSettings();
    renderPlaces();
  });
});
renderPlaces();

const srvInput = $('#set-server');
srvInput.value = settings.peerServer ? `${settings.peerServer.secure === false ? 'http' : 'https'}://${settings.peerServer.host}:${settings.peerServer.port}${settings.peerServer.path || '/'}` : '';
srvInput.addEventListener('change', () => {
  const v = srvInput.value.trim();
  if (!v) settings.peerServer = null;
  else {
    try {
      const u = new URL(v);
      settings.peerServer = { host: u.hostname, port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80), path: u.pathname, secure: u.protocol === 'https:' };
    } catch {
      return toast('Enter a full URL, e.g. https://peer.example.com:443/');
    }
  }
  saveSettings();
  renderPairing();
  startLink();
});

$('#btn-reset').addEventListener('click', () => {
  if (!confirm('Erase all Car-Auto settings, favorites and contacts on this device?')) return;
  Object.keys(localStorage).filter((k) => k.startsWith('carauto.')).forEach((k) => localStorage.removeItem(k));
  location.reload();
});

if (native) {
  $('#native-card').hidden = false;
  $('#get-app-card').hidden = true;
  const auto = $('#set-autostart');
  auto.checked = !!native.getAutoStart?.();
  auto.addEventListener('change', () => native.setAutoStart(auto.checked));
  const refreshOverlay = () => { $('#btn-overlay').hidden = !native.needsOverlayPermission?.(); };
  refreshOverlay();
  document.addEventListener('visibilitychange', refreshOverlay);
  $('#btn-overlay').addEventListener('click', () => native.openSettings('overlay'));
  $('#btn-home').addEventListener('click', () => native.openSettings('home'));
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => toast('Fullscreen not available'));
}
$('#btn-fullscreen').addEventListener('click', toggleFullscreen);

let installEvt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvt = e;
  $('#btn-install').hidden = false;
});
$('#btn-install').addEventListener('click', async () => {
  if (!installEvt) return;
  installEvt.prompt();
  await installEvt.userChoice;
  installEvt = null;
  $('#btn-install').hidden = true;
});

// ---- Start ----

if (settings.keepAwake) keepAwake(true);
store.set('role', 'car');
// Connection and offline cache start after first paint so the dashboard appears instantly.
requestAnimationFrame(() => setTimeout(() => {
  startLink();
  registerServiceWorker();
}, 0));
const startView = new URLSearchParams(location.hash.slice(1)).get('view');
if (startView) showView(startView);

// Called by the Android app for the Back key: close the open app, if any.
function back() {
  if (currentView !== 'home') { showView('home'); return true; }
  return false;
}

window.carauto = { ctx, settings, back, get host() { return host; }, code: () => code };
