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
  let phoneLib = [];
  let phoneLibPending = null;
  let lastArt = null;
  let lastPlaying = null;
  let listDirty = true;
  // Media playing on the paired Android phone (via the Car-Auto Link app).
  let phoneMedia = null;
  let btMedia = null; // what the stereo's Bluetooth app reports (Car-Auto Dash app)
  let btPlaying = false;
  let source = 'local'; // 'local' | 'phone' | 'bt'
  let progressTimer = 0;
  let heldForCall = false;

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
    progress: $$('[data-np="progress"]'),
  };

  // ---- Playback ----

  function play(list, i) {
    if (!list.length) return;
    takeOverFromPhone();
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

  function takeOverFromPhone() {
    if (source === 'phone' && phoneMedia?.playing) ctx.phoneLink?.send({ t: 'pmedia', cmd: 'pause' });
    if (source === 'bt' && (btMedia?.playing || btPlaying)) btCmd('pause');
    btPlaying = false;
    source = 'local';
  }

  // ---- Bluetooth audio (phone → stereo over Bluetooth) ----
  const nativeApp = window.CarAutoNative || null;
  function btCmd(cmd) {
    if (nativeApp?.btCmd) nativeApp.btCmd(cmd);
    else if (ctx.phoneLink?.available()) ctx.phoneLink.send({ t: 'pmedia', cmd });
    else toast("Use your stereo's Bluetooth music app, or connect Car-Auto Link");
  }

  // Switch to Bluetooth: stop the radio and start the phone over Bluetooth.
  function useBluetooth({ switchStereo = false } = {}) {
    if (!audio.paused) audio.pause();
    source = 'bt';
    if (switchStereo && nativeApp?.switchToBluetooth) {
      if (!nativeApp.switchToBluetooth()) toast("Couldn't find the stereo's Bluetooth music app");
    }
    btCmd('play');
    btPlaying = true;
    render();
  }

  // Phone started playing: make sure the stereo is on its Bluetooth audio
  // (many stereos only play it after their Bluetooth music app was opened).
  let lastBtSwitch = 0;
  function ensureBluetoothAudio() {
    if (!nativeApp?.switchToBluetooth || btMedia?.playing) return;
    if (Date.now() - lastBtSwitch < 10 * 60 * 1000) return;
    lastBtSwitch = Date.now();
    if (nativeApp.switchToBluetooth()) toast('Switching the stereo to Bluetooth audio…');
  }

  function setBtMedia(m) {
    if (!m || !m.pkg) { btMedia = null; render(); return; }
    const prevArt = btMedia && btMedia.artKey === m.artKey ? btMedia.art : null;
    const started = m.playing && !btMedia?.playing;
    btMedia = { ...m, art: m.art !== undefined ? m.art : prevArt, receivedAt: Date.now() };
    btPlaying = !!m.playing;
    // Something started playing on the stereo's side (its Bluetooth app, whatever
    // it's called): show it automatically unless Car-Auto's own radio is playing
    // or the phone link already shows the same music with richer info.
    const phoneShowing = source === 'phone' && phoneMedia?.playing;
    if (started && (m.bluetooth || audio.paused) && !phoneShowing) {
      source = 'bt';
      if (!audio.paused) audio.pause();
    }
    render();
  }

  const phoneCmd = (cmd) => ctx.phoneLink?.send({ t: 'pmedia', cmd });
  const phoneActive = () => source === 'phone' && phoneMedia && ctx.phoneLink?.available();

  function toggle() {
    if (source === 'bt') {
      const playing = btMedia ? btMedia.playing : btPlaying;
      btCmd(playing ? 'pause' : 'play');
      btPlaying = !playing;
      if (btMedia) btMedia.playing = !playing;
      render();
      return;
    }
    if (phoneActive()) {
      if (phoneMedia.keysOnly) {
        // Standard phone app: no track info, so toggle and track the state here.
        phoneCmd('toggle');
        phoneMedia.playing = !phoneMedia.playing;
        render();
        return;
      }
      return phoneCmd(phoneMedia.playing ? 'pause' : 'play');
    }
    localToggle();
  }

  function localToggle() {
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

  const pause = () => {
    if (source === 'bt') { btCmd('pause'); btPlaying = false; return render(); }
    return phoneActive() ? phoneCmd('pause') : audio.pause();
  };
  const resume = () => {
    if (source === 'bt') { btCmd('play'); btPlaying = true; return render(); }
    if (phoneActive()) return phoneCmd('play');
    return current ? audio.play().catch(() => {}) : localToggle();
  };
  const next = () => {
    if (source === 'bt') return btCmd('next');
    return phoneActive() ? phoneCmd('next') : queue.length && play(queue, index + 1);
  };
  const prev = () => {
    if (source === 'bt') return btCmd('prev');
    if (phoneActive()) return phoneCmd('prev');
    if (current?.kind === 'file' && audio.currentTime > 4) audio.currentTime = 0;
    else if (queue.length) play(queue, index - 1);
  };

  // Called whenever the phone reports what it is playing (or null when nothing).
  function setPhoneMedia(m) {
    if (!m || !m.title) {
      phoneMedia = null;
      if (source === 'phone') source = 'local';
      render();
      return;
    }
    const prevArt = phoneMedia && phoneMedia.artKey === m.artKey ? phoneMedia.art : null;
    const startedPlaying = m.playing && !phoneMedia?.playing;
    phoneMedia = { ...m, art: m.art !== undefined ? m.art : prevArt, receivedAt: Date.now() };
    if (startedPlaying) {
      source = 'phone';
      document.body.classList.remove('buffering');
      ensureBluetoothAudio();
      if (!audio.paused) audio.pause();
    } else if (!current && source === 'local' && audio.paused) {
      source = 'phone';
    }
    render();
  }

  function display() {
    if (source === 'bt') {
      const m = btMedia?.title ? btMedia : (phoneMedia && !phoneMedia.keysOnly ? phoneMedia : null);
      return {
        kind: 'bt',
        name: m?.title || 'Bluetooth audio',
        sub: m ? [m.artist, 'Bluetooth'].filter(Boolean).join(' · ') : 'Playing from your phone over Bluetooth',
        art: m?.art || '',
        playing: btMedia ? !!btMedia.playing : btPlaying,
      };
    }
    if (source === 'phone' && phoneMedia) {
      return {
        kind: 'phone',
        name: phoneMedia.title,
        sub: phoneMedia.keysOnly ? 'Play, pause and skip from here' : [phoneMedia.artist, phoneMedia.app].filter(Boolean).join(' · '),
        art: phoneMedia.art || '',
        playing: !!phoneMedia.playing,
      };
    }
    if (!current) return null;
    return {
      kind: current.kind,
      name: current.name,
      sub: current.sub || (current.kind === 'radio' ? 'Internet radio' : 'Local music'),
      art: current.art || '',
      playing: !audio.paused,
    };
  }

  function progressNow() {
    if (source === 'bt' && btMedia?.duration > 0) {
      const elapsed = btMedia.playing ? (Date.now() - (btMedia.positionAt || btMedia.receivedAt)) * (btMedia.speed || 1) : 0;
      return Math.min(1, Math.max(0, (btMedia.position + elapsed) / btMedia.duration));
    }
    if (source === 'phone' && phoneMedia?.duration > 0) {
      const elapsed = phoneMedia.playing ? (Date.now() - (phoneMedia.positionAt || phoneMedia.receivedAt)) * (phoneMedia.speed || 1) : 0;
      return Math.min(1, Math.max(0, (phoneMedia.position + elapsed) / phoneMedia.duration));
    }
    if (source === 'local' && current?.kind === 'file' && audio.duration > 0) return audio.currentTime / audio.duration;
    return null;
  }

  function updateProgress() {
    const f = progressNow();
    el.progress.forEach((n) => {
      n.hidden = f == null;
      if (f != null) n.firstElementChild.style.transform = `scaleX(${f})`;
    });
  }

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
    document.body.classList.remove('buffering');
    if (!audio.getAttribute('src')) return;
    audio.pause();
    if (current) toast(`${current.name} is unavailable right now`);
    render();
  });
  audio.addEventListener('waiting', () => document.body.classList.add('buffering'));
  audio.addEventListener('playing', () => document.body.classList.remove('buffering'));
  audio.addEventListener('pause', () => document.body.classList.remove('buffering'));

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
      <div class="art">${s.art ? `<img src="${escapeHtml(s.art)}" alt="" loading="lazy" onerror="this.remove()">` : (s.kind === 'radio' ? '📻' : s.kind === 'phonelib' ? '📱' : '🎵')}</div>
      <div class="meta"><b>${escapeHtml(s.name)}</b><span class="muted">${escapeHtml(s.sub || '')}</span></div>
      ${star}
    </div>`;
  }

  function listFor(name) {
    if (name === 'phone') return phoneLib;
    return name === 'favorites' ? favorites : name === 'files' ? localFiles : browseRows;
  }

  function renderTabs() {
    el.tabs.forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    el.searchForm.hidden = tab !== 'browse';
  }

  function renderList() {
    const list = listFor(tab);
    if (tab === 'bt') {
      const appName = nativeApp?.bluetoothAppName?.() || '';
      const infoAllowed = nativeApp?.btInfoAllowed ? nativeApp.btInfoAllowed() : true;
      el.list.innerHTML = `<div class="bt-panel">
        <div class="bt-icon"><svg viewBox="0 0 24 24"><path d="M17.7 7.7 12 2h-1v7.6L6.4 5 5 6.4l5.6 5.6L5 17.6 6.4 19l4.6-4.6V22h1l5.7-5.7-4.3-4.3zM13 5.8l1.9 1.9L13 9.6zm1.9 10.5L13 18.2v-3.8z"/></svg></div>
        <b>Bluetooth audio</b>
        <p class="muted">Plays whatever is on your phone (Spotify, YouTube Music…) through the car speakers over Bluetooth.</p>
        <button class="btn primary big" data-bt="play">▶ Play via Bluetooth</button>
        ${nativeApp?.switchToBluetooth ? `<button class="btn" data-bt="switch">Switch stereo to Bluetooth audio${appName ? ` (${escapeHtml(appName)})` : ''}</button>` : ''}
        ${nativeApp?.allowBtInfo && !infoAllowed ? '<button class="btn" data-bt="info">Show song names (allow notification access)</button>' : ''}
        <p class="muted small">Your phone must be connected to the stereo over Bluetooth. No sound? Tap “Switch stereo to Bluetooth audio”${nativeApp ? '' : " or open the stereo's Bluetooth music app"}.</p>
      </div>`;
      return;
    }
    if (tab === 'phone' && !list.length) {
      el.list.innerHTML = `<div class="empty"><p>${ctx.phoneLink?.available() ? 'Loading songs from your phone…' : 'Connect Car-Auto Link on your phone to play its music.'}</p>
        <p class="muted small">In Car-Auto Link, allow <b>Music and audio</b>.</p></div>`;
      return;
    }
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
    const d = display();
    const name = d?.name || 'Nothing playing';
    const sub = d ? d.sub : 'Tap to choose music';
    el.title.forEach((n) => { n.textContent = name; });
    el.sub.forEach((n) => { n.textContent = sub; });
    const artKey = d?.art || d?.kind || '';
    if (artKey !== lastArt) {
      lastArt = artKey;
      el.art.forEach((n) => {
        n.innerHTML = d?.art ? `<img src="${escapeHtml(d.art)}" alt="" decoding="async" onerror="this.remove()">` : (d?.kind === 'bt' ? '🎧' : d?.kind === 'phone' ? '📱' : d?.kind === 'file' ? '🎵' : '📻');
      });
      el.bg.forEach((n) => {
        n.style.backgroundImage = d?.art ? `url("${d.art.replace(/"/g, '%22')}")` : '';
        n.classList.toggle('on', !!d?.art);
      });
    }
    const playing = !!d?.playing;
    clearInterval(progressTimer);
    updateProgress();
    if (playing && progressNow() != null) progressTimer = setInterval(updateProgress, 1000);
    // Only hold the stereo's media "source" while Car-Auto itself plays; when the
    // music is on the phone, step aside so the stereo plays its Bluetooth audio.
    const nat = window.CarAutoNative;
    const localPlaying = source === 'local' && !!current;
    nat?.setMediaSource?.(localPlaying);
    if (localPlaying) nat?.setMediaState?.(name, sub, playing);
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
    const bt = e.target.closest('[data-bt]')?.dataset.bt;
    if (bt === 'play') return useBluetooth();
    if (bt === 'switch') return useBluetooth({ switchStereo: true });
    if (bt === 'info') return nativeApp?.allowBtInfo();
    const fav = e.target.closest('[data-fav]');
    const row = e.target.closest('.track');
    if (!row) return;
    const list = listFor(row.dataset.list);
    if (fav) return toggleFav(list[+fav.dataset.fav]);
    if (row.dataset.list === 'phone') {
      // Played by the phone itself; its sound reaches the car over Bluetooth.
      if (!audio.paused) audio.pause();
      source = 'phone';
      ctx.phoneLink?.send({ t: 'playMusic', ids: phoneLib.map((s) => s.id), index: +row.dataset.i });
      return;
    }
    play(list, +row.dataset.i);
  });

  el.tabs.forEach((b) => b.addEventListener('click', () => {
    tab = b.dataset.tab;
    renderTabs();
    if (tab === 'browse' && !browseRows.length) loadBrowse();
    else {
      if (tab === 'phone' && !phoneLib.length && ctx.phoneLink?.available()) ctx.phoneLink.send({ t: 'getMusic' });
      renderList();
    }
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

  ctx.bus.on('phone:music', (m) => {
    if (m.page === 0) phoneLibPending = [];
    phoneLibPending = (phoneLibPending || []).concat(m.items || []);
    if (m.page >= m.pages - 1) {
      phoneLib = phoneLibPending.map((x) => ({ kind: 'phonelib', id: x.id, name: x.title, sub: x.artist || 'Phone', url: `phone:${x.id}` }));
      phoneLibPending = null;
      if (tab === 'phone') renderList();
    }
  });
  ctx.bus.on('phone:linked', (on) => {
    el.tabs.forEach((b) => { if (b.dataset.tab === 'phone') b.hidden = !on; });
    if (!on) { phoneLib = []; if (tab === 'phone') { tab = 'favorites'; renderTabs(); renderList(); } }
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
    setPhoneMedia,
    setBtMedia,
    useBluetooth,
    getState: () => {
      const d = display();
      return { title: d?.name || '', sub: d?.sub || '', playing: !!d?.playing, volume: audio.volume, source };
    },
    duck(on) { audio.volume = on ? Math.min(audio.volume, 0.25) : store.get('volume', 0.8); },
    // During phone calls the stereo's own audio must be silent.
    holdForCall(on) {
      if (on) { heldForCall = !audio.paused; audio.pause(); } else if (heldForCall) { heldForCall = false; audio.play().catch(() => {}); }
    },
  };
}
