// Vehicle trip computer: start time, running hours, distance, odometer,
// fuel mileage, service reminder and trip history — from GPS and the
// stereo's power state (the stereo turns on with the ignition).
//
// A new trip starts when the app opens or wakes after the stereo has been
// off/asleep for longer than TRIP_GAP_MS.

import { $, store, fmtClock, haversine, speak } from '../common.js';

const TRIP_GAP_MS = 10 * 60 * 1000; // stereo off this long = engine was off
const TICK_MS = 5000;
const MAX_TICK_S = 15; // never count more than this per tick (sleep/suspend)
const MOVING_MS = 1.4; // m/s (~5 km/h)
const MIN_TRIP_M = 100;
const KM = 1000;
const MI = 1609.344;
const L_PER_GAL = 3.785411784;

const newTrip = (now) => ({ start: now, lastSeen: now, dist: 0, moving: 0, idle: 0, maxSpeed: 0, lastFix: null });

export function createVehicle(ctx) {
  const { settings } = ctx;
  let v = {
    odometer: null, // metres, null until the user sets it
    engineSec: 0, // total "running hours"
    tripsCount: 0,
    trips: [], // finished trips, newest first
    fuel: [], // fill-ups, newest first
    serviceDue: null, // metres
    serviceWarned: false,
    ...store.get('vehicle', {}),
  };
  let trip = store.get('trip', null);
  let lastTick = Date.now();
  let speedNow = 0;

  const unitLen = () => (settings.units === 'mi' ? MI : KM);
  const unitName = () => (settings.units === 'mi' ? 'mi' : 'km');
  const fmtLen = (m, digits = 1) => `${(m / unitLen()).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${unitName()}`;
  const fmtSpd = (ms) => `${Math.round(ms * (settings.units === 'mi' ? 2.236936 : 3.6))} ${settings.units === 'mi' ? 'mph' : 'km/h'}`;
  const fmtHM = (sec) => {
    const m = Math.floor(sec / 60);
    return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
  };
  const fmtNum = (n, d = 2) => n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });

  function save() {
    store.set('vehicle', v);
    store.set('trip', trip);
  }

  // ---- Trip lifecycle ----

  function finishTrip(t) {
    const end = t.lastSeen;
    if (t.dist >= MIN_TRIP_M || end - t.start > 2 * 60 * 1000) {
      v.trips.unshift({ start: t.start, end, dist: t.dist, moving: t.moving, idle: t.idle, maxSpeed: t.maxSpeed });
      v.trips = v.trips.slice(0, 50);
      v.tripsCount++;
    }
  }

  function startNewTrip(now = Date.now()) {
    if (trip) finishTrip(trip);
    trip = newTrip(now);
    save();
  }

  function ensureTrip(now) {
    if (!trip || now - trip.lastSeen > TRIP_GAP_MS) startNewTrip(now);
  }

  function tick() {
    const now = Date.now();
    ensureTrip(now);
    const dt = Math.min(MAX_TICK_S, Math.max(0, (now - lastTick) / 1000));
    lastTick = now;
    trip.lastSeen = now;
    v.engineSec += dt;
    if (speedNow >= MOVING_MS) trip.moving += dt; else trip.idle += dt;
    save();
    render();
  }

  // ---- Distance from GPS (filters jitter while parked and GPS jumps) ----

  ctx.bus.on('pos', (p) => {
    const now = Date.now();
    ensureTrip(now);
    speedNow = p.speed || 0;
    if (speedNow > trip.maxSpeed && speedNow < 70) trip.maxSpeed = speedNow;
    const acc = p.acc ?? 20;
    if (acc > 50) return;
    const fix = { lat: p.lat, lon: p.lon, t: p.time || now };
    const last = trip.lastFix;
    if (!last) { trip.lastFix = fix; return; }
    const d = haversine(last, fix);
    const dt = (fix.t - last.t) / 1000;
    if (dt <= 0) return;
    if (d / dt > 70) { trip.lastFix = fix; return; } // impossible jump (>250 km/h)
    if (d < Math.max(5, acc * 0.6) && speedNow < MOVING_MS) return; // standing still
    trip.dist += d;
    if (v.odometer != null) v.odometer += d;
    trip.lastFix = fix;
    checkService();
  });

  // ---- Fuel mileage ----

  // Average efficiency between full-tank fill-ups (most accurate method).
  function efficiency() {
    const fills = [...v.fuel].sort((a, b) => a.odo - b.odo);
    let dist = 0;
    let litres = 0;
    let lastFull = null;
    let pending = 0;
    for (const f of fills) {
      if (lastFull) pending += f.litres;
      if (f.full) {
        if (lastFull && f.odo > lastFull.odo) { dist += f.odo - lastFull.odo; litres += pending; }
        lastFull = f;
        pending = 0;
      }
    }
    if (dist <= 0 || litres <= 0) return null;
    return { mPerL: dist / litres, dist, litres };
  }

  function fmtEff(e) {
    if (!e) return null;
    if (settings.units === 'mi') return `${fmtNum(e.mPerL / MI * L_PER_GAL, 1)} mpg`;
    return `${fmtNum(e.mPerL / KM, 1)} km/l`;
  }

  const lastPrice = () => v.fuel.find((f) => f.price > 0)?.price || 0;

  // ---- Service reminder ----

  function checkService() {
    if (v.serviceDue == null || v.odometer == null) return;
    const left = v.serviceDue - v.odometer;
    const warnAt = settings.units === 'mi' ? 300 * MI : 500 * KM;
    if (left < warnAt && !v.serviceWarned) {
      v.serviceWarned = true;
      ctx.bus.emit('notify', { from: 'Vehicle', text: left > 0 ? `Service due in ${fmtLen(left, 0)}` : 'Service is due now' });
    }
  }

  // ---- Rendering ----

  const el = {
    start: $('#veh-start'),
    running: $('#veh-running'),
    dist: $('#veh-dist'),
    mileage: $('#veh-mileage-home'),
  };

  function stat(label, value, sub = '') {
    return `<div class="stat"><span class="muted">${label}</span><b>${value}</b>${sub ? `<small class="muted">${sub}</small>` : ''}</div>`;
  }

  function todayTotals() {
    const today = new Date().toDateString();
    const list = v.trips.filter((t) => new Date(t.start).toDateString() === today);
    const all = trip ? [trip, ...list] : list;
    return {
      trips: all.length,
      dist: all.reduce((s, t) => s + t.dist, 0),
      time: all.reduce((s, t) => s + t.moving + t.idle, 0),
    };
  }

  function render() {
    if (!trip) return;
    const eff = efficiency();
    const running = (trip.lastSeen - trip.start) / 1000;
    el.start.textContent = fmtClock(new Date(trip.start));
    el.running.textContent = fmtHM(running);
    el.dist.textContent = fmtLen(trip.dist);
    el.mileage.textContent = fmtEff(eff) || (v.odometer != null ? fmtLen(v.odometer, 0) : '—');
    el.mileage.previousElementSibling.textContent = eff ? 'Mileage' : 'Odometer';
    if (ctx.isViewVisible('vehicle')) renderFull(eff, running);
  }

  function renderFull(eff = efficiency(), running = (trip.lastSeen - trip.start) / 1000) {
    const avg = trip.moving > 30 ? trip.dist / trip.moving : 0;
    const fuelUsed = eff ? trip.dist / eff.mPerL : null;
    const price = lastPrice();
    $('#veh-trip-stats').innerHTML = [
      stat('Started', fmtClock(new Date(trip.start)), new Date(trip.start).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })),
      stat('Running time', fmtHM(running)),
      stat('Moving', fmtHM(trip.moving), `idle ${fmtHM(trip.idle)}`),
      stat('Distance', fmtLen(trip.dist)),
      stat('Average speed', avg ? fmtSpd(avg) : '—', 'while moving'),
      stat('Top speed', trip.maxSpeed ? fmtSpd(trip.maxSpeed) : '—'),
      stat('Fuel used', fuelUsed != null ? `${fmtNum(fuelUsed)} L` : '—', fuelUsed != null && price ? `≈ ${fmtNum(fuelUsed * price)} cost` : 'add fill-ups to estimate'),
    ].join('');

    const today = todayTotals();
    $('#veh-totals').innerHTML = [
      stat('Odometer', v.odometer != null ? fmtLen(v.odometer, 0) : 'Not set', v.odometer == null ? 'set it below' : ''),
      stat('Running hours', fmtHM(v.engineSec), 'total'),
      stat('Today', fmtLen(today.dist), `${today.trips} trip${today.trips === 1 ? '' : 's'} · ${fmtHM(today.time)}`),
      stat('Trips', String(v.tripsCount + 1)),
    ].join('');

    $('#veh-mileage').innerHTML = eff
      ? `<b>${fmtEff(eff)}</b><span class="muted">average over ${fmtLen(eff.dist, 0)} and ${fmtNum(eff.litres, 1)} L</span>`
      : '<span class="muted">Log two full-tank fill-ups to calculate your mileage.</span>';

    $('#fuel-list').innerHTML = v.fuel.slice(0, 6).map((f, i) => `
      <div class="mini-row">
        <span>${new Date(f.at).toLocaleDateString([], { day: 'numeric', month: 'short' })}</span>
        <span>${fmtNum(f.litres)} L${f.full ? ' · full' : ''}</span>
        <span class="muted">${fmtLen(f.odo, 0)}</span>
        <span class="muted">${f.price ? fmtNum(f.price * f.litres) : ''}</span>
        <button class="icon-btn small" data-del-fuel="${i}" aria-label="Delete fill-up">✕</button>
      </div>`).join('');

    const fuelOdo = $('#fuel-form').odo;
    if (document.activeElement !== fuelOdo && v.odometer != null) fuelOdo.placeholder = `${(v.odometer / unitLen()).toFixed(0)} ${unitName()}`;

    const sv = $('#veh-service');
    if (v.serviceDue == null) sv.textContent = 'No service reminder set.';
    else if (v.odometer == null) sv.textContent = 'Set the odometer to track the service reminder.';
    else {
      const left = v.serviceDue - v.odometer;
      sv.innerHTML = left > 0 ? `Next service in <b>${fmtLen(left, 0)}</b> (at ${fmtLen(v.serviceDue, 0)})` : '<b class="bad">Service is due</b>';
    }

    $('#trip-history').innerHTML = v.trips.length
      ? v.trips.slice(0, 20).map((t) => {
        const dur = (t.end - t.start) / 1000;
        return `<div class="mini-row">
          <span>${new Date(t.start).toLocaleDateString([], { day: 'numeric', month: 'short' })}</span>
          <span>${fmtClock(new Date(t.start))}–${fmtClock(new Date(t.end))}</span>
          <b>${fmtLen(t.dist)}</b>
          <span class="muted">${fmtHM(dur)}</span>
        </div>`;
      }).join('')
      : '<div class="muted">Finished trips appear here.</div>';
  }

  // ---- Forms ----

  const readLen = (value) => {
    const n = parseFloat(value);
    return Number.isFinite(n) && n >= 0 ? n * unitLen() : null;
  };

  $('#odo-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const m = readLen(e.target.odo.value);
    if (m == null) return;
    v.odometer = m;
    v.serviceWarned = false;
    e.target.reset();
    save();
    renderFull();
    render();
  });

  $('#service-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const m = readLen(e.target.due.value);
    v.serviceDue = m;
    v.serviceWarned = false;
    e.target.reset();
    save();
    renderFull();
  });

  $('#fuel-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const litres = parseFloat(f.litres.value);
    if (!(litres > 0)) return;
    const odo = readLen(f.odo.value) ?? v.odometer ?? 0;
    if (f.odo.value && v.odometer == null) v.odometer = odo;
    v.fuel.unshift({ at: Date.now(), litres, price: parseFloat(f.price.value) || 0, odo, full: f.full.checked });
    v.fuel = v.fuel.slice(0, 60);
    f.reset();
    f.full.checked = true;
    save();
    renderFull();
    render();
  });

  $('#fuel-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-del-fuel]');
    if (!b) return;
    v.fuel.splice(+b.dataset.delFuel, 1);
    save();
    renderFull();
    render();
  });

  $('#veh-new-trip').addEventListener('click', () => {
    startNewTrip();
    renderFull();
    render();
  });

  $('#trip-card').addEventListener('click', () => ctx.showView('vehicle'));

  // Save when the stereo goes to sleep / the app is hidden.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') save();
    else tick();
  });

  ensureTrip(Date.now());
  setInterval(tick, TICK_MS);
  render();

  return {
    onShow: () => renderFull(),
    refreshUnits: () => { render(); if (ctx.isViewVisible('vehicle')) renderFull(); },
    summary() {
      const eff = efficiency();
      const running = (trip.lastSeen - trip.start) / 1000;
      const parts = [
        `You started at ${fmtClock(new Date(trip.start))} and have been driving for ${fmtHM(running).replace('h', ' hours').replace('m', ' minutes')}.`,
        `This trip is ${fmtLen(trip.dist).replace('km', 'kilometers').replace('mi', 'miles')}.`,
      ];
      if (eff) parts.push(`Your mileage is ${fmtEff(eff).replace('km/l', 'kilometers per litre')}.`);
      return parts.join(' ');
    },
    speakSummary() { speak(this.summary()); },
    _state: () => ({ v, trip }),
  };
}

