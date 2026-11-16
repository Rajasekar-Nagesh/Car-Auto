// Phone app on the car display: Favorites, Recents and Contacts (synced from
// the Android phone through the Car-Auto Link app) and a keypad.
//
// Calls are placed by the phone itself when Car-Auto Link is connected (most
// reliable), by the Car-Auto Dash app on the stereo, or as a tel: link that
// the stereo's Bluetooth dialer handles.

import { $, $$, store, toast, escapeHtml } from '../common.js';

const ICON_IN = '<svg viewBox="0 0 24 24"><path d="M20 5.41 18.59 4 7 15.59V9H5v10h10v-2H8.41z"/></svg>';
const ICON_OUT = '<svg viewBox="0 0 24 24"><path d="M9 5v2h6.59L4 18.59 5.41 20 17 8.41V15h2V5z"/></svg>';
const ICON_MISSED = '<svg viewBox="0 0 24 24"><path d="M19.59 7 12 14.59 6.41 9H11V7H3v8h2v-4.59l7 7 9-9z"/></svg>';

export function createPhone(ctx) {
  let contacts = store.get('contacts', []); // favorites added on the car
  let phoneContacts = [];
  let recents = [];
  let number = '';
  let tab = 'contacts';
  let filter = '';
  let pending = null;

  const el = {
    body: $('.phone-body'),
    display: $('#dial-display'),
    pad: $('#dial-pad'),
    list: $('#contact-list'),
    form: $('#contact-form'),
    tabs: $$('#phone-tabs [data-ptab]'),
    search: $('#contact-search'),
    synced: $('#synced-list'),
    syncHint: $('#sync-hint'),
  };

  function call(num, name) {
    const clean = String(num).replace(/[^\d+*#]/g, '');
    if (!clean) return toast('Enter a number first');
    toast(`Calling ${name || clean}…`);
    if (ctx.phoneLink?.available()) {
      ctx.phoneLink.send({ t: 'pcall', number: clean });
      return;
    }
    if (window.CarAutoNative?.dial) {
      window.CarAutoNative.dial(clean);
      return;
    }
    window.location.href = `tel:${clean}`;
  }

  const allContacts = () => [...contacts, ...phoneContacts];

  function findContact(query) {
    const q = query.toLowerCase().trim();
    const list = allContacts();
    return list.find((c) => c.name.toLowerCase() === q) ||
      list.find((c) => c.name.toLowerCase().startsWith(q)) ||
      list.find((c) => c.name.toLowerCase().includes(q));
  }

  function nameFor(num) {
    const digits = String(num).replace(/\D/g, '').slice(-9);
    if (!digits) return '';
    return allContacts().find((c) => String(c.number).replace(/\D/g, '').endsWith(digits))?.name || '';
  }

  // ---- Rendering ----

  function renderDisplay() {
    el.display.textContent = number || 'Enter number';
    el.display.classList.toggle('muted', !number);
  }

  function renderFavorites() {
    store.set('contacts', contacts);
    const starred = phoneContacts.filter((c) => c.starred);
    const items = [...contacts.map((c, i) => ({ ...c, local: i })), ...starred];
    el.list.innerHTML = items.length
      ? items.map((c, i) => `
        <div class="contact">
          <button class="contact-main" data-fav="${i}">
            <span class="avatar">${escapeHtml(c.name.charAt(0).toUpperCase())}</span>
            <span class="meta"><b>${escapeHtml(c.name)}</b><span class="muted">${escapeHtml(c.number)}</span></span>
          </button>
          ${c.local != null ? `<button class="icon-btn" data-del="${c.local}" aria-label="Remove ${escapeHtml(c.name)}">✕</button>` : '<span class="muted small pad">★ Phone</span>'}
        </div>`).join('')
      : '<div class="empty muted">Add favorites for one-tap and voice calling ("Call Mom").</div>';
    el.list._items = items;
    ctx.bus.emit('contacts', items);
  }

  function renderSynced() {
    const linked = !!ctx.phoneLink?.available();
    el.syncHint.hidden = linked;
    el.search.hidden = !linked || tab !== 'all';
    if (!linked) { el.synced.innerHTML = ''; return; }
    let rows;
    if (tab === 'recents') {
      rows = recents.map((r, i) => {
        const icon = r.type === 'missed' ? ICON_MISSED : r.type === 'out' ? ICON_OUT : ICON_IN;
        const when = new Date(r.date);
        const today = when.toDateString() === new Date().toDateString();
        const time = today ? when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : when.toLocaleDateString([], { month: 'short', day: 'numeric' });
        return `<button class="contact-main row-call ${r.type === 'missed' ? 'missed' : ''}" data-recent="${i}">
          <span class="avatar">${escapeHtml((r.name || '#').charAt(0).toUpperCase())}</span>
          <span class="meta"><b>${escapeHtml(r.name || r.number)}</b><span class="muted call-type">${icon}${escapeHtml(r.name ? r.number : '')}</span></span>
          <span class="muted small">${time}</span></button>`;
      });
      if (!rows.length) rows = ['<div class="empty muted">No recent calls</div>'];
    } else {
      const q = filter.toLowerCase();
      const list = q ? phoneContacts.filter((c) => c.name.toLowerCase().includes(q) || c.number.includes(q)) : phoneContacts;
      rows = list.slice(0, 300).map((c) => `<button class="contact-main row-call" data-num="${escapeHtml(c.number)}" data-name="${escapeHtml(c.name)}">
          <span class="avatar">${escapeHtml(c.name.charAt(0).toUpperCase())}</span>
          <span class="meta"><b>${escapeHtml(c.name)}</b><span class="muted">${escapeHtml(c.number)}</span></span></button>`);
      if (!rows.length) rows = [`<div class="empty muted">${phoneContacts.length ? 'No matches' : 'Loading contacts from phone…'}</div>`];
    }
    el.synced.innerHTML = rows.join('');
  }

  function showTab(name) {
    tab = name;
    el.tabs.forEach((b) => b.classList.toggle('active', b.dataset.ptab === name));
    el.body.dataset.ptabShow = name;
    if ((name === 'recents' || name === 'all') && ctx.phoneLink?.available()) {
      ctx.phoneLink.send({ t: name === 'recents' ? 'getRecents' : 'getContacts' });
    }
    renderSynced();
  }

  // ---- Events ----

  el.tabs.forEach((b) => b.addEventListener('click', () => showTab(b.dataset.ptab)));

  el.pad.addEventListener('click', (e) => {
    const k = e.target.closest('[data-key]')?.dataset.key;
    if (!k) return;
    if (k === 'back') number = number.slice(0, -1);
    else if (k === 'call') return call(number, nameFor(number));
    else if (number.length < 20) number += k;
    renderDisplay();
  });

  el.list.addEventListener('click', (e) => {
    const f = e.target.closest('[data-fav]');
    const d = e.target.closest('[data-del]');
    if (d) { contacts.splice(+d.dataset.del, 1); renderFavorites(); return; }
    if (f) { const c = el.list._items[+f.dataset.fav]; call(c.number, c.name); }
  });

  el.synced.addEventListener('click', (e) => {
    const r = e.target.closest('[data-recent]');
    const c = e.target.closest('[data-num]');
    if (r) { const x = recents[+r.dataset.recent]; call(x.number, x.name); }
    if (c) call(c.dataset.num, c.dataset.name);
  });

  el.search.addEventListener('input', () => { filter = el.search.value; renderSynced(); });

  el.form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = el.form.name.value.trim();
    const num = el.form.number.value.trim();
    if (!name || !num) return;
    contacts.push({ name, number: num });
    contacts.sort((a, b) => a.name.localeCompare(b.name));
    el.form.reset();
    renderFavorites();
  });

  // ---- Data from the phone ----

  ctx.bus.on('phone:contacts', (m) => {
    if (m.page === 0) pending = [];
    pending = (pending || []).concat(m.items || []);
    if (m.page >= m.pages - 1) {
      phoneContacts = pending;
      pending = null;
      renderFavorites();
      renderSynced();
    }
  });
  ctx.bus.on('phone:recents', (m) => { recents = m.items || []; renderSynced(); });
  ctx.bus.on('phone:linked', (on) => {
    if (on) ctx.phoneLink.send({ t: 'getContacts' });
    else { phoneContacts = []; recents = []; renderFavorites(); }
    renderSynced();
  });

  renderDisplay();
  renderFavorites();
  showTab('contacts');

  return {
    call,
    nameFor,
    callByName(name) {
      const c = findContact(name);
      if (c) { call(c.number, c.name); return true; }
      const digits = name.replace(/[^\d+]/g, '');
      if (digits.length >= 3) { call(digits); return true; }
      return false;
    },
    getContacts: () => el.list._items || contacts,
  };
}
