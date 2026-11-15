// Music: internet radio (radio-browser.info directory) and local audio files
// from the stereo's storage / USB. Integrates with Media Session so the
// steering-wheel media buttons and the stereo's hardware keys work.

import { $, $$, store, toast, fetchJSON, escapeHtml } from '../common.js';

const RB_MIRRORS = [
  'https://de1.api.radio-browser.info',
  'https://fi1.api.radio-browser.info',
  'https://at1.api.radio-browser.info',
];

async function radioApi(path) {
  let lastErr;
  for (const base of RB_MIRRORS) {
    try {
      return await fetchJSON(base + path, { timeout: 8000 });
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

function toStation(r) {
  return {
    kind: 'radio',
    id: r.stationuuid,
    name: (r.name || 'Unknown station').trim(),
    sub: [r.country, (r.tags || '').split(',').slice(0, 2).join(', ')].filter(Boolean).join(' · '),
    url: r.url_resolved || r.url,
    art: r.favicon && r.favicon.startsWith('https://') ? r.favicon : '',
  };
}

// The app is served over HTTPS, so browsers block plain-HTTP streams.
const playable = (s) => s.url && s.url.startsWith('https://');

const ICON_PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24"><path d="M6 19h4V5H6zm8-14v14h4V5z" fill="currentColor"/></svg>';

export function createMusic(ctx) {
  const audio = new Audio();
  audio.preload = 'none';
  audio.volume = store.get('volume', 0.8);

  let favorites = store.get('stations', []);
  let localFiles = [];
  let queue = [];
  let index = -1;
  let current = null;
  let tab = favorites.length ? 'favorites' : 'browse';
  let browseRows = [];
  let lastArt = null;
  let lastPlaying = null;
  let listDirty = true;

  const el = {
    list: $('#music-list'),
    tabs: $$('#music-tabs [data-tab]'),
    searchForm: $('#radio-search'),
    searchInput: $('#radio-search input'),
    fileInput: $('#file-input'),
    title: $$('[data-np="title"]'),
    sub: $$('[data-np="sub"]'),
    art: $$('[data-np="art"]'),
    bg: $$('[data-np="bg"]'),
    toggle: $$('[data-media="toggle"]'),
    volume: $('#volume'),
  };

  // ---- Playback ----

  function play(list, i) {
    if (!list.length) return;
    queue = list;
    index = (i + list.length) % list.length;
    current = list[index];
    audio.src = current.url;
    audio.play().catch((e) => {
      if (e.name === 'NotAllowedError') toast('Tap play to start audio');
      else toast(`Can't play ${current.name}`);
    });
    if (current.kind === 'radio') store.set('lastStation', current);
    render();
  }

  function toggle() {
    if (!current) {
      const last = store.get('lastStation', null);
      if (favorites.length) return play(favorites, 0);
      if (last) return play([last], 0);
      toast('Pick a station or add music files first');
      ctx.showView('music');
      return;
    }
    if (audio.paused) audio.play().catch(() => toast('Playback failed'));
    else audio.pause();
  }

  const pause = () => audio.pause();
  const resume = () => (current ? audio.play().catch(() => {}) : toggle());
  const next = () => queue.length && play(queue, index + 1);
  const prev = () => {
    if (current?.kind === 'file' && audio.currentTime > 4) audio.currentTime = 0;
    else if (queue.length) play(queue, index - 1);
  };

  function setVolume(v) {
    audio.volume = Math.max(0, Math.min(1, v));
    store.set('volume', audio.volume);
    el.volume.value = Math.round(audio.volume * 100);
    ctx.emitState();
  }

  audio.addEventListener('play', render);
  audio.addEventListener('pause', render);
  audio.addEventListener('ended', () => (current?.kind === 'file' ? next() : render()));
  audio.addEventListener('error', () => {
    if (!audio.getAttribute('src')) return;
    audio.pause();
    if (current) toast(`${current.name} is unavailable right now`);
    render();
  });
  audio.addEventListener('waiting', () => document.body.classList.add('buffering'));
  audio.addEventListener('playing', () => document.body.classList.remove('buffering'));

  // Media Session: lock-screen / notification controls and hardware media keys.
  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession;
    const handlers = { play: resume, pause, nexttrack: next, previoustrack: prev, stop: pause };
    for (const [action, fn] of Object.entries(handlers)) {
      try { ms.setActionHandler(action, fn); } catch { /* unsupported action */ }
    }
  }

  function updateMediaSession() {
    if (!('mediaSession' in navigator) || !current || !window.MediaMetadata) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: current.name,
      artist: current.sub || (current.kind === 'radio' ? 'Internet radio' : 'Local music'),
      album: 'Car-Auto',
      artwork: current.art ? [{ src: current.art, sizes: '512x512' }] : [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
    });
    navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing';
  }

  // ---- Favorites ----

  const isFav = (s) => favorites.some((f) => f.url === s.url);
  function toggleFav(s) {
    if (isFav(s)) favorites = favorites.filter((f) => f.url !== s.url);
    else favorites.push({ kind: 'radio', id: s.id, name: s.name, sub: s.sub, url: s.url, art: s.art });
    store.set('stations', favorites);
    renderList();
  }

  // ---- Browse / search radio ----

  async function loadBrowse(query) {
    tab = 'browse';
    renderTabs();
    el.list.innerHTML = '<div class="muted pad">Loading stations…</div>';
    try {
      const region = (navigator.language || '').split('-')[1];
      const base = '/json/stations/search?hidebroken=true&order=clickcount&reverse=true&limit=60';
      const path = query
        ? `${base}&name=${encodeURIComponent(query)}`
        : `${base}${region ? `&countrycode=${region}` : ''}`;
      let rows = (await radioApi(path)).map(toStation).filter(playable);
      if (!rows.length && !query && region) rows = (await radioApi(base)).map(toStation).filter(playable);
      browseRows = rows;
      renderList();
      return rows;
    } catch (e) {
      el.list.innerHTML = `<div class="bad pad">Couldn't load stations: ${escapeHtml(e.message)}</div>`;
      return [];
    }
  }

  // Used by voice commands: "play <something>".
  async function playSearch(query) {
    const q = query.toLowerCase();
    const fav = favorites.find((f) => f.name.toLowerCase().includes(q));
    if (fav) return play(favorites, favorites.indexOf(fav)), true;
    const file = localFiles.find((f) => f.name.toLowerCase().includes(q));
    if (file) return play(localFiles, localFiles.indexOf(file)), true;
    const rows = await loadBrowse(query);
    if (rows.length) { play(rows, 0); return true; }
    return false;
  }

  // ---- Local files ----

  el.fileInput.addEventListener('change', () => {
    const files = [...el.fileInput.files].filter((f) => f.type.startsWith('audio/') || /\.(mp3|m4a|aac|ogg|opus|flac|wav)$/i.test(f.name));
    localFiles.forEach((f) => URL.revokeObjectURL(f.url));
    localFiles = files
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
      .map((f) => ({ kind: 'file', name: f.name.replace(/\.[^.]+$/, ''), sub: 'Local file', url: URL.createObjectURL(f) }));
    tab = 'files';
    renderTabs();
    renderList();
    if (localFiles.length) toast(`${localFiles.length} tracks added`);
  });

  // ---- Rendering ----

  function rowHtml(s, i, list) {
    const playing = current && current.url === s.url;
    const star = s.kind === 'radio'
      ? `<button class="icon-btn star ${isFav(s) ? 'on' : ''}" data-fav="${i}" aria-label="Favorite">★</button>` : '';
    return `<div class="track ${playing ? 'playing' : ''}" data-list="${list}" data-i="${i}">
      <div class="art">${s.art ? `<img src="${escapeHtml(s.art)}" alt="" loading="lazy" onerror="this.remove()">` : (s.kind === 'radio' ? '📻' : '🎵')}</div>
      <div class="meta"><b>${escapeHtml(s.name)}</b><span class="muted">${escapeHtml(s.sub || '')}</span></div>
      ${star}
    </div>`;
  }

  function listFor(name) {
    return name === 'favorites' ? favorites : name === 'files' ? localFiles : browseRows;
  }

  function renderTabs() {
    el.tabs.forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    el.searchForm.hidden = tab !== 'browse';
  }

  function renderList() {
    const list = listFor(tab);
    if (tab === 'files' && !list.length) {
      el.list.innerHTML = `<div class="empty"><p>Play music stored on this stereo or a USB drive.</p>
        <label class="btn primary big" for="file-input">Choose music files</label>
        <p class="muted small">Files stay on this device. Re-select them after restarting the app.</p></div>`;
      return;
    }
    if (tab === 'favorites' && !list.length) {
      el.list.innerHTML = '<div class="empty"><p>No favorite stations yet.</p><p class="muted">Open <b>Radio</b> and tap ★ to save stations here.</p></div>';
      return;
    }
    el.list.innerHTML = list.map((s, i) => rowHtml(s, i, tab)).join('') +
      (tab === 'files' ? '<div class="pad"><label class="btn" for="file-input">Choose different files</label></div>' : '');
  }

  function render() {
    const name = current?.name || 'Nothing playing';
    const sub = current ? (current.sub || (current.kind === 'radio' ? 'Internet radio' : 'Local music')) : 'Tap to choose music';
    el.title.forEach((n) => { n.textContent = name; });
    el.sub.forEach((n) => { n.textContent = sub; });
    const artKey = current?.art || current?.kind || '';
    if (artKey !== lastArt) {
      lastArt = artKey;
      el.art.forEach((n) => {
        n.innerHTML = current?.art ? `<img src="${escapeHtml(current.art)}" alt="" decoding="async" onerror="this.remove()">` : (current?.kind === 'file' ? '🎵' : '📻');
      });
      el.bg.forEach((n) => {
        n.style.backgroundImage = current?.art ? `url("${current.art.replace(/"/g, '%22')}")` : '';
        n.classList.toggle('on', !!current?.art);
      });
    }
    const playing = !!current && !audio.paused;
    if (playing !== lastPlaying) {
      lastPlaying = playing;
      el.toggle.forEach((b) => {
        b.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
        b.setAttribute('aria-label', playing ? 'Pause' : 'Play');
      });
    }
    document.body.classList.toggle('is-playing', !!playing);
    updateMediaSession();
    if (ctx.isViewVisible('music')) renderList(); else listDirty = true;
    ctx.emitState();
  }

  el.list.addEventListener('click', (e) => {
    const fav = e.target.closest('[data-fav]');
    const row = e.target.closest('.track');
    if (!row) return;
    const list = listFor(row.dataset.list);
    if (fav) return toggleFav(list[+fav.dataset.fav]);
    play(list, +row.dataset.i);
  });

  el.tabs.forEach((b) => b.addEventListener('click', () => {
    tab = b.dataset.tab;
    renderTabs();
    if (tab === 'browse' && !browseRows.length) loadBrowse();
    else renderList();
  }));

  el.searchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    el.searchInput.blur();
    loadBrowse(el.searchInput.value.trim());
  });

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-media]');
    if (b) { ({ toggle, next, prev }[b.dataset.media])?.(); return; }
    if (e.target.closest('#media-card')) ctx.showView('music');
  });

  el.volume.value = Math.round(audio.volume * 100);
  el.volume.addEventListener('input', () => setVolume(el.volume.value / 100));

  renderTabs();
  render();

  return {
    toggle, pause, resume, next, prev, setVolume, playSearch,
    onShow() {
      if (tab === 'browse' && !browseRows.length) loadBrowse();
      else if (listDirty) { listDirty = false; renderList(); }
    },
    openTab(name) { tab = name; renderTabs(); if (name === 'browse' && !browseRows.length) loadBrowse(); else renderList(); },
    getState: () => ({
      title: current?.name || '',
      sub: current?.sub || '',
      playing: !!current && !audio.paused,
      volume: audio.volume,
    }),
    duck(on) { audio.volume = on ? Math.min(audio.volume, 0.25) : store.get('volume', 0.8); },
  };
}
