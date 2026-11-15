// Phone tab on the car display: dial pad + favorite contacts.
// Calls use tel: links, which Android head units hand to their built-in
// Bluetooth hands-free dialer (your phone must be paired over Bluetooth).

import { $, store, toast, escapeHtml } from '../common.js';

export function createPhone(ctx) {
  let contacts = store.get('contacts', []);
  let number = '';

  const el = {
    display: $('#dial-display'),
    pad: $('#dial-pad'),
    list: $('#contact-list'),
    form: $('#contact-form'),
  };

  function call(num, name) {
    const clean = String(num).replace(/[^\d+*#]/g, '');
    if (!clean) return toast('Enter a number first');
    ctx.voice(`Calling ${name || clean.split('').join(' ')}`);
    setTimeout(() => { window.location.href = `tel:${clean}`; }, 600);
  }

  function findContact(query) {
    const q = query.toLowerCase().trim();
    return contacts.find((c) => c.name.toLowerCase() === q) ||
      contacts.find((c) => c.name.toLowerCase().includes(q));
  }

  function renderDisplay() {
    el.display.textContent = number || 'Enter number';
    el.display.classList.toggle('muted', !number);
  }

  function render() {
    store.set('contacts', contacts);
    el.list.innerHTML = contacts.length
      ? contacts.map((c, i) => `
        <div class="contact">
          <button class="contact-main" data-call="${i}">
            <span class="avatar">${escapeHtml(c.name.charAt(0).toUpperCase())}</span>
            <span class="meta"><b>${escapeHtml(c.name)}</b><span class="muted">${escapeHtml(c.number)}</span></span>
          </button>
          <button class="icon-btn" data-del="${i}" aria-label="Remove ${escapeHtml(c.name)}">✕</button>
        </div>`).join('')
      : '<div class="empty muted">Add favorite contacts for one-tap and voice calling ("Call Mom").</div>';
    ctx.bus.emit('contacts', contacts);
  }

  el.pad.addEventListener('click', (e) => {
    const k = e.target.closest('[data-key]')?.dataset.key;
    if (!k) return;
    if (k === 'back') number = number.slice(0, -1);
    else if (k === 'call') return call(number);
    else if (number.length < 20) number += k;
    renderDisplay();
  });

  el.list.addEventListener('click', (e) => {
    const c = e.target.closest('[data-call]');
    const d = e.target.closest('[data-del]');
    if (c) { const ct = contacts[+c.dataset.call]; call(ct.number, ct.name); }
    if (d) { contacts.splice(+d.dataset.del, 1); render(); }
  });

  el.form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = el.form.name.value.trim();
    const num = el.form.number.value.trim();
    if (!name || !num) return;
    contacts.push({ name, number: num });
    contacts.sort((a, b) => a.name.localeCompare(b.name));
    el.form.reset();
    render();
  });

  renderDisplay();
  render();

  return {
    call,
    callByName(name) {
      const c = findContact(name);
      if (c) { call(c.number, c.name); return true; }
      const digits = name.replace(/[^\d+]/g, '');
      if (digits.length >= 3) { call(digits); return true; }
      return false;
    },
    getContacts: () => contacts,
  };
}
