// Car display entry point: wires the views, settings and the phone link.

import {
  $, $$, store, toast, speak, fmtSpeed, genPairCode, keepAwake,
  registerServiceWorker, searchPlaces, escapeHtml, debounce,
} from '../common.js';
import { CarHost, transportFromUrl } from '../link.js';
import { createNav } from './nav.js';
import { createMusic } from './music.js';
import { createPhone } from './phone.js';
import { createVoice } from './voice.js';
import { createHome } from './home.js';

const DEFAULTS = {
  carName: 'My Car',
  units: 'km',
  voiceGuidance: true,
  gpsSource: 'auto', // auto | device | phone
  theme: 'auto', // auto | day | night
  keepAwake: true,
  demo: false,
  home: null,
  work: null,
  peerServer: null,
};

const settings = { ...DEFAULTS, ...store.get('settings', {}) };
const saveSettings = () => store.set('settings', settings);

// Tiny event bus shared by modules.
const bus = {
  t: new EventTarget(),
  emit(type, detail) { this.t.dispatchEvent(new CustomEvent(type, { detail })); },
  on(type, fn) { this.t.addEventListener(type, (e) => fn(e.detail)); },
};

let currentView = 'home';
const ctx = {
  settings,
  bus,
  showView,
  isViewVisible: (v) => currentView === v,
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

// ---- Views ----

function showView(name) {
  currentView = name;
  $$('.view').forEach((v) => { v.hidden = v.id !== `view-${name}`; });
  $$('.rail [data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'map') nav?.refresh();
  if (name === 'music') music?.onShow();
  if (name === 'settings') renderPairing();
}

$$('.rail [data-view]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

// ---- Theme ----

function applyTheme() {
  let night = settings.theme === 'night';
  if (settings.theme === 'auto') {
    const h = new Date().getHours() + new Date().getMinutes() / 60;
    night = h >= 18.75 || h < 6.5;
  }
  document.body.classList.toggle('night', night);
  document.body.classList.toggle('day', !night);
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', night ? '#0b0f14' : '#eef2f6');
}
applyTheme();
setInterval(applyTheme, 60000);

// ---- Modules ----

let music;
let nav;
const home = createHome(ctx);
const phone = createPhone(ctx);
ctx.phone = phone;
music = createMusic(ctx);
ctx.music = music;
nav = createNav(ctx);
ctx.nav = nav;
const voice = createVoice(ctx);
ctx.voiceCmd = voice;

$('#btn-voice').addEventListener('click', () => voice.listen());

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
    document.body.classList.toggle('phone-linked', count > 0);
  });
  host.on('join', ({ send }) => {
    send({ t: 'welcome', carName: settings.carName, home: settings.home, work: settings.work });
    send(stateMsg());
  });
  host.on('message', ({ msg, reply }) => handlePhoneMessage(msg, reply));
  host.start();
}

function stateMsg() {
  return { t: 'state', music: music.getState(), nav: nav.getState(), gpsSource: settings.gpsSource };
}

function broadcastState() {
  if (host?.clientCount) host.broadcast(stateMsg());
}
bus.on('nav', debounce(broadcastState, 500));

function handlePhoneMessage(msg, reply) {
  switch (msg.t) {
    case 'hello':
      toast(`📱 ${msg.name || 'Phone'} connected`);
      break;
    case 'nav':
      if (Number.isFinite(msg.lat) && Number.isFinite(msg.lon)) {
        toast(`📍 Destination from phone: ${msg.name || msg.label || ''}`);
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
      showMessage(msg.from || 'Phone', msg.text);
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

function showMessage(from, text) {
  const box = $('#message-overlay');
  box.querySelector('.from').textContent = from;
  box.querySelector('.body').textContent = text;
  box.hidden = false;
  speak(`Message from ${from}. ${text}`);
  clearTimeout(showMessage.t);
  showMessage.t = setTimeout(() => { box.hidden = true; }, 15000);
}
$('#message-overlay').addEventListener('click', (e) => { e.currentTarget.hidden = true; });

// ---- Settings view ----

function renderPairing() {
  $('#pair-code').textContent = code;
  const url = phoneUrl();
  $('#pair-url').textContent = url;
  const qr = window.qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  $('#pair-qr').innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
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
bindSetting('#set-units', 'units', { after: () => { home.refreshUnits(); broadcastState(); } });
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

// Advanced: self-hosted PeerJS signalling server.
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

$('#btn-fullscreen').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => toast('Fullscreen not available'));
});

// ---- Install prompt (Android Chrome) ----

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
startLink();
store.set('role', 'car');
registerServiceWorker();
showView(new URLSearchParams(location.hash.slice(1)).get('view') || 'home');

// Exposed for debugging and automated tests.
window.carauto = { ctx, settings, get host() { return host; }, code: () => code, escapeHtml };
