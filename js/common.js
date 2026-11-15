// Shared helpers used by both the car display and the phone remote.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const NS = 'carauto.';
export const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(NS + key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(NS + key, JSON.stringify(value));
    } catch {
      /* storage full or blocked: settings simply won't persist */
    }
  },
  remove(key) {
    try { localStorage.removeItem(NS + key); } catch { /* ignore */ }
  },
};

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

let toastTimer = null;
export function toast(message, ms = 3200) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

export function speak(text, { interrupt = true, lang } = {}) {
  if (!('speechSynthesis' in window) || !text) return;
  if (interrupt) speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang || navigator.language || 'en-US';
  u.rate = 1;
  speechSynthesis.speak(u);
}

export async function fetchJSON(url, { timeout = 12000, ...opts } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Request timed out');
    throw err;
  } finally {
    clearTimeout(t);
  }
}

// ---- Geo helpers -------------------------------------------------------

const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;

export function haversine(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function bearing(a, b) {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
    Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export function fmtDist(m, units = 'km') {
  if (m == null || !isFinite(m)) return '–';
  if (units === 'mi') {
    const ft = m * 3.28084;
    if (ft < 1000) return `${Math.round(ft / 50) * 50 || Math.round(ft)} ft`;
    const mi = m / 1609.344;
    return `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`;
  }
  if (m < 1000) return `${m < 100 ? Math.round(m / 10) * 10 : Math.round(m / 50) * 50} m`;
  const km = m / 1000;
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
}

// Distance phrased for speech ("400 meters", "1.5 kilometers").
export function sayDist(m, units = 'km') {
  if (units === 'mi') {
    const ft = m * 3.28084;
    if (ft < 1000) return `${Math.max(50, Math.round(ft / 50) * 50)} feet`;
    const mi = m / 1609.344;
    return `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} miles`;
  }
  if (m < 1000) return `${Math.max(10, Math.round(m / 50) * 50)} meters`;
  const km = m / 1000;
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} kilometers`;
}

export function fmtSpeed(ms, units = 'km') {
  if (ms == null || !isFinite(ms) || ms < 0) return '0';
  return String(Math.round(units === 'mi' ? ms * 2.236936 : ms * 3.6));
}

export function fmtDuration(sec) {
  if (sec == null || !isFinite(sec)) return '–';
  const min = Math.max(1, Math.round(sec / 60));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h} h ${min % 60} min`;
}

export function fmtClock(date = new Date()) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Pull coordinates out of pasted text or a shared maps link.
// Handles "12.97, 77.59", geo: URIs, and common Google/Apple Maps URL forms.
export function parseLocationText(text) {
  if (!text) return null;
  const s = decodeURIComponent(String(text)).trim();
  const num = '(-?\\d{1,3}(?:\\.\\d+)?)';
  const patterns = [
    new RegExp(`geo:${num},${num}`),
    new RegExp(`@${num},${num}`),
    new RegExp(`[?&](?:q|ll|query|destination|daddr|sll|center)=(?:loc:)?${num},\\s*${num}`),
    new RegExp(`!3d${num}!4d${num}`),
    new RegExp(`^${num}\\s*,\\s*${num}$`),
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) {
      const lat = parseFloat(m[1]);
      const lon = parseFloat(m[2]);
      if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat, lon };
    }
  }
  return null;
}

// Free-text part of shared content, with URLs removed (for searching).
export function stripUrls(text) {
  return String(text || '').replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim();
}

// OpenStreetMap place search (Nominatim). Called only on explicit submit
// to stay within its 1-request-per-second usage policy.
export async function searchPlaces(query, near) {
  const coords = parseLocationText(query);
  if (coords) return [{ name: 'Dropped pin', label: `${coords.lat.toFixed(5)}, ${coords.lon.toFixed(5)}`, ...coords }];
  const p = new URLSearchParams({ q: query, format: 'jsonv2', limit: '8' });
  if (near) {
    const d = 0.6;
    p.set('viewbox', `${near.lon - d},${near.lat + d},${near.lon + d},${near.lat - d}`);
  }
  p.set('accept-language', navigator.language || 'en');
  const rows = await fetchJSON(`https://nominatim.openstreetmap.org/search?${p}`);
  return rows.map((r) => ({
    name: r.name || r.display_name.split(',')[0],
    label: r.display_name,
    lat: parseFloat(r.lat),
    lon: parseFloat(r.lon),
  }));
}

// Unambiguous pairing code, e.g. "K7P2-9QXM" (~40 bits of randomness).
export function genPairCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

export function normalizeCode(code) {
  const c = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : null;
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// Keep the screen awake while the app is visible (dash-mounted use).
export function keepAwake(enabled) {
  let lock = null;
  async function acquire() {
    if (!enabled || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    try { lock = await navigator.wakeLock.request('screen'); } catch { /* not allowed */ }
  }
  document.addEventListener('visibilitychange', acquire);
  acquire();
  return () => { enabled = false; lock?.release?.(); };
}

// True inside the Car-Auto Android apps (they serve the files from the APK).
export const inNativeApp = () => !!(window.CarAutoNative || window.CarAutoLink);

// Open a link outside the app: another Android app (Maps, Waze, Spotify…) or a browser tab.
export function openExternal(url) {
  if (window.CarAutoNative?.openUrl) return window.CarAutoNative.openUrl(url);
  window.open(url, '_blank', 'noopener');
}

export function registerServiceWorker() {
  if (inNativeApp()) return;
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline support unavailable */ });
  }
}
