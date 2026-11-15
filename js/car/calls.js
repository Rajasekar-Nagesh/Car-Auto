// Incoming-call screen and in-call bar, driven by call events from the
// Car-Auto Link app on the Android phone. Call audio itself goes through the
// stereo's Bluetooth hands-free; this only shows and controls the call.

import { $, fmtClock } from '../common.js';

export function createCalls(ctx) {
  const overlay = $('#call-overlay');
  const bar = $('#call-bar');
  const el = {
    avatar: $('#call-avatar'),
    name: $('#call-name'),
    number: $('#call-number'),
    barName: $('#call-bar-name'),
    timer: $('#call-timer'),
  };
  let state = 'idle';
  let since = 0;
  let timer = 0;

  const displayName = (ev) => ev.name || ctx.phone.nameFor(ev.number) || ev.number || 'Unknown caller';

  function tick() {
    const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
    el.timer.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function update(ev) {
    const prev = state;
    state = ev.state || 'idle';
    const name = displayName(ev);
    document.body.classList.toggle('in-call', state !== 'idle');
    if (state === 'ringing') {
      el.avatar.textContent = name.charAt(0).toUpperCase();
      el.name.textContent = name;
      el.number.textContent = ev.name && ev.number ? ev.number : '';
      overlay.hidden = false;
      bar.hidden = true;
      ctx.music.holdForCall(true);
    } else if (state === 'active' || state === 'dialing') {
      overlay.hidden = true;
      bar.hidden = false;
      el.barName.textContent = name;
      since = ev.since || Date.now();
      clearInterval(timer);
      if (state === 'active') { tick(); timer = setInterval(tick, 1000); } else el.timer.textContent = 'Calling…';
      ctx.music.holdForCall(true);
    } else {
      overlay.hidden = true;
      bar.hidden = true;
      clearInterval(timer);
      if (prev !== 'idle') ctx.music.holdForCall(false);
      if (prev === 'ringing' && ev.missed) ctx.bus.emit('notify', { from: name, text: `Missed call at ${fmtClock()}` });
    }
  }

  function action(a) {
    ctx.phoneLink?.send({ t: 'pcallAction', action: a });
  }

  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-call]')?.dataset.call;
    if (a) action(a);
  });

  ctx.bus.on('phone:call', update);
  ctx.bus.on('phone:linked', (on) => { if (!on) update({ state: 'idle' }); });

  return { action, getState: () => state };
}
