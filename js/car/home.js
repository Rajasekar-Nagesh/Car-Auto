// Dashboard context card (right side of the split screen) + taskbar clock.
// Idle: weather, destination suggestions, quick dial, phone status.
// Navigating: upcoming turns. All renders are skipped when nothing changed.

import { $, store, fetchJSON, fmtClock, fmtDist, escapeHtml } from '../common.js';
import { arrowFor } from './nav.js';

const WEATHER = {
  0: ['☀️', 'Clear'], 1: ['🌤️', 'Mostly clear'], 2: ['⛅', 'Partly cloudy'], 3: ['☁️', 'Cloudy'],
  45: ['🌫️', 'Fog'], 48: ['🌫️', 'Fog'], 51: ['🌦️', 'Drizzle'], 53: ['🌦️', 'Drizzle'], 55: ['🌦️', 'Drizzle'],
  61: ['🌧️', 'Rain'], 63: ['🌧️', 'Rain'], 65: ['🌧️', 'Heavy rain'], 66: ['🌧️', 'Freezing rain'], 67: ['🌧️', 'Freezing rain'],
  71: ['🌨️', 'Snow'], 73: ['🌨️', 'Snow'], 75: ['❄️', 'Heavy snow'], 77: ['🌨️', 'Snow'],
  80: ['🌦️', 'Showers'], 81: ['🌧️', 'Showers'], 82: ['⛈️', 'Heavy showers'], 85: ['🌨️', 'Snow showers'], 86: ['🌨️', 'Snow showers'],
  95: ['⛈️', 'Thunderstorm'], 96: ['⛈️', 'Thunderstorm'], 99: ['⛈️', 'Thunderstorm'],
};

const PIN = '<svg viewBox="0 0 24 24"><path d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>';
const HOME = '<svg viewBox="0 0 24 24"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>';
const WORK = '<svg viewBox="0 0 24 24"><path d="M20 6h-4V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2zm-6 0h-4V4h4z"/></svg>';

export function createHome(ctx) {
  const el = {
    date: $('#home-date'),
    railClock: $('#rail-clock'),
    weather: $('#home-weather'),
    navTile: $('#tile-nav'),
    quick: $('#quick-contacts'),
    linkTile: $('#tile-link'),
  };

  // ---- Clock: tick exactly on the minute boundary, no polling every second ----
  function tick() {
    const now = new Date();
    el.railClock.textContent = fmtClock(now);
    el.date.textContent = now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    setTimeout(tick, 60000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 50);
  }
  tick();

  // ---- Weather (Open-Meteo, no API key), deferred so it never delays startup ----
  let lastWeather = 0;
  let weatherAt = null;
  async function loadWeather(pos) {
    if (Date.now() - lastWeather < 15 * 60 * 1000 && weatherAt && Math.abs(weatherAt.lat - pos.lat) < 0.2) return;
    lastWeather = Date.now();
    weatherAt = pos;
    try {
      const unit = ctx.settings.units === 'mi' ? '&temperature_unit=fahrenheit' : '';
      const j = await fetchJSON(`https://api.open-meteo.com/v1/forecast?latitude=${pos.lat.toFixed(3)}&longitude=${pos.lon.toFixed(3)}&current=temperature_2m,weather_code&timezone=auto${unit}`);
      const [icon, label] = WEATHER[j.current.weather_code] || ['🌡️', ''];
      el.weather.innerHTML = `<span class="w-icon">${icon}</span><span class="w-temp">${Math.round(j.current.temperature_2m)}°</span><span class="muted">${label}</span>`;
    } catch {
      lastWeather = 0;
    }
  }
  const cachedWeatherPos = store.get('lastPos', null);
  ctx.bus.on('pos', (pos) => {
    if (!weatherAt) (window.requestIdleCallback || setTimeout)(() => loadWeather(pos));
    else loadWeather(pos);
  });
  if (cachedWeatherPos) (window.requestIdleCallback || setTimeout)(() => loadWeather(cachedWeatherPos), { timeout: 3000 });

  // ---- Suggestions / upcoming turns ----
  let lastNavHtml = '';
  function renderNav(state) {
    const { settings } = ctx;
    let html;
    if (state?.active) {
      const upcoming = state.upcoming || [];
      html = `<div class="tile-label">Next turns</div><div class="step-list">${upcoming.map((s) => `
        <div class="step"><span class="s-ic">${arrowFor(s.step)}</span><b>${escapeHtml(fmtDist(s.at, settings.units))}</b><span class="muted">${escapeHtml(s.step.text)}</span></div>`).join('')}</div>`;
    } else {
      const chips = [];
      if (settings.home) chips.push(`<button class="chip" data-go="home">${HOME}Home</button>`);
      if (settings.work) chips.push(`<button class="chip" data-go="work">${WORK}Work</button>`);
      store.get('recents', []).slice(0, 3).forEach((r, i) => chips.push(`<button class="chip" data-recent="${i}">${PIN}${escapeHtml(r.name)}</button>`));
      if (!chips.length) chips.push(`<button class="chip" data-go="search">${PIN}Where to?</button>`);
      html = `<div class="tile-label">Suggested</div><div class="chips">${chips.join('')}</div>`;
    }
    if (html !== lastNavHtml) {
      lastNavHtml = html;
      el.navTile.innerHTML = html;
    }
  }

  el.navTile.addEventListener('click', (e) => {
    const b = e.target.closest('[data-go],[data-recent]');
    if (!b) return;
    if (b.dataset.recent != null) {
      const r = store.get('recents', [])[+b.dataset.recent];
      if (r) ctx.nav.navigateTo(r, { immediate: true });
      return;
    }
    const go = b.dataset.go;
    if (go === 'search') {
      ctx.showView('home');
      $('#nav-search input').focus();
      return;
    }
    const p = ctx.settings[go];
    if (p) ctx.nav.navigateTo({ ...p, name: go === 'home' ? 'Home' : 'Work' }, { immediate: true });
  });

  function renderQuick(contacts) {
    el.quick.innerHTML = contacts.slice(0, 5)
      .map((c, i) => `<button class="quick" data-q="${i}"><span class="avatar">${escapeHtml(c.name.charAt(0).toUpperCase())}</span><span>${escapeHtml(c.name.split(' ')[0])}</span></button>`)
      .join('');
  }
  el.quick.addEventListener('click', (e) => {
    const q = e.target.closest('[data-q]')?.dataset.q;
    if (q == null) return;
    const c = ctx.phone.getContacts()[+q];
    ctx.phone.call(c.number, c.name);
  });

  function renderLink({ count, state }) {
    el.linkTile.innerHTML = count
      ? `<span class="link-ok">● ${count} phone${count > 1 ? 's' : ''} connected</span>`
      : `<span>${state === 'online' ? 'Phone remote ready' : 'Phone remote offline'}</span><button class="btn small" data-pair>Pair phone</button>`;
  }
  el.linkTile.addEventListener('click', (e) => { if (e.target.closest('[data-pair]')) ctx.showView('settings'); });

  ctx.bus.on('nav', renderNav);
  ctx.bus.on('contacts', renderQuick);
  ctx.bus.on('link', renderLink);
  renderNav({ active: false });

  return {
    refreshUnits() { lastWeather = 0; renderNav(ctx.nav.getState()); },
    refreshSuggestions() { renderNav(ctx.nav.getState()); },
  };
}
