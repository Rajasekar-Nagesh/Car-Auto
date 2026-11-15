// Home dashboard tiles: clock, speed, weather, next turn, now playing,
// quick-dial contacts and phone link status.

import { $, fetchJSON, fmtClock, escapeHtml } from '../common.js';

const WEATHER = {
  0: ['☀️', 'Clear'], 1: ['🌤️', 'Mostly clear'], 2: ['⛅', 'Partly cloudy'], 3: ['☁️', 'Overcast'],
  45: ['🌫️', 'Fog'], 48: ['🌫️', 'Fog'], 51: ['🌦️', 'Drizzle'], 53: ['🌦️', 'Drizzle'], 55: ['🌦️', 'Drizzle'],
  61: ['🌧️', 'Rain'], 63: ['🌧️', 'Rain'], 65: ['🌧️', 'Heavy rain'], 66: ['🌧️', 'Freezing rain'], 67: ['🌧️', 'Freezing rain'],
  71: ['🌨️', 'Snow'], 73: ['🌨️', 'Snow'], 75: ['❄️', 'Heavy snow'], 77: ['🌨️', 'Snow'],
  80: ['🌦️', 'Showers'], 81: ['🌧️', 'Showers'], 82: ['⛈️', 'Heavy showers'], 85: ['🌨️', 'Snow showers'], 86: ['🌨️', 'Snow showers'],
  95: ['⛈️', 'Thunderstorm'], 96: ['⛈️', 'Thunderstorm'], 99: ['⛈️', 'Thunderstorm'],
};

export function createHome(ctx) {
  const el = {
    clock: $('#home-clock'),
    date: $('#home-date'),
    railClock: $('#rail-clock'),
    speed: $('#home-speed'),
    speedUnit: $('#home-speed-unit'),
    weather: $('#home-weather'),
    navTile: $('#tile-nav'),
    quick: $('#quick-contacts'),
    linkTile: $('#tile-link'),
  };

  function tick() {
    const now = new Date();
    el.clock.textContent = fmtClock(now);
    el.railClock.textContent = fmtClock(now);
    el.date.textContent = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  }
  setInterval(tick, 5000);
  tick();

  // ---- Weather (Open-Meteo, no API key) ----
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

  ctx.bus.on('pos', (pos) => {
    el.speed.textContent = ctx.speedText(pos.speed);
    loadWeather(pos);
  });

  function renderNav(state) {
    const { settings } = ctx;
    if (state?.active) {
      el.navTile.innerHTML = `
        <div class="tile-label">Navigating to ${escapeHtml(state.dest || '')}</div>
        <div class="nav-next"><b>${escapeHtml(state.toNextText)}</b> ${escapeHtml(state.text)}</div>
        <div class="muted">${escapeHtml(state.remainingText)} · arrive ${fmtClock(new Date(state.eta))}</div>`;
    } else {
      el.navTile.innerHTML = `
        <div class="tile-label">Where to?</div>
        <button class="btn big wide" data-go="search">🔍 Search destination</button>
        <div class="row">
          <button class="btn" data-go="home">🏠 Home</button>
          <button class="btn" data-go="work">💼 Work</button>
        </div>
        ${settings.home || settings.work ? '' : '<div class="muted small">Set Home and Work in Settings.</div>'}`;
    }
  }

  el.navTile.addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]')?.dataset.go;
    if (!go && ctx.nav.getState().active) return ctx.showView('map');
    if (go === 'search') {
      ctx.showView('map');
      setTimeout(() => $('#nav-search input').focus(), 100);
    } else if (go) {
      const p = ctx.settings[go];
      if (!p) return ctx.showView('settings');
      ctx.nav.navigateTo({ ...p, name: go === 'home' ? 'Home' : 'Work' });
    }
  });

  function renderQuick(contacts) {
    const top = contacts.slice(0, 4);
    el.quick.innerHTML = top.length
      ? top.map((c, i) => `<button class="quick" data-q="${i}"><span class="avatar">${escapeHtml(c.name.charAt(0).toUpperCase())}</span><span>${escapeHtml(c.name)}</span></button>`).join('')
      : '<button class="btn" data-q="add">➕ Add favorite contacts</button>';
  }
  el.quick.addEventListener('click', (e) => {
    const q = e.target.closest('[data-q]')?.dataset.q;
    if (q == null) return;
    if (q === 'add') return ctx.showView('phone');
    const c = ctx.phone.getContacts()[+q];
    ctx.phone.call(c.number, c.name);
  });

  function renderLink({ count, state }) {
    const online = state === 'online';
    el.linkTile.innerHTML = count
      ? `<div class="tile-label">Phone remote</div><div class="link-ok">📱 ${count} phone${count > 1 ? 's' : ''} connected</div>`
      : `<div class="tile-label">Phone remote</div><div class="${online ? '' : 'muted'}">${online ? 'Ready to pair' : 'Offline'}</div><button class="btn" data-pair>Pair a phone</button>`;
  }
  el.linkTile.addEventListener('click', (e) => { if (e.target.closest('[data-pair]')) ctx.showView('settings'); });

  ctx.bus.on('nav', renderNav);
  ctx.bus.on('contacts', renderQuick);
  ctx.bus.on('link', renderLink);
  renderNav({ active: false });
  el.speedUnit.textContent = ctx.settings.units === 'mi' ? 'mph' : 'km/h';

  return {
    refreshUnits() {
      el.speedUnit.textContent = ctx.settings.units === 'mi' ? 'mph' : 'km/h';
      lastWeather = 0;
    },
  };
}
