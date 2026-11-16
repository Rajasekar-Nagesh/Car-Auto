// End-to-end smoke test: runs the car display and the phone remote side by
// side (local transport), with map/search/routing/radio services mocked.
// Usage: npm test   (needs Playwright: npm i -D playwright && npx playwright install chromium)

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = 8099;
const BASE = `http://localhost:${PORT}`;
const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, 'screenshots');

const A = [77.5946, 12.9716];
const B = [77.5946, 12.9743];
const C = [77.59737, 12.9743];
const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];

const OSRM = {
  code: 'Ok',
  routes: [{
    distance: 600,
    duration: 90,
    geometry: { type: 'LineString', coordinates: [A, mid(A, B), B, mid(B, C), C] },
    legs: [{
      steps: [
        { name: 'MG Road', maneuver: { type: 'depart', location: A, bearing_after: 0 }, geometry: { coordinates: [A, mid(A, B), B] } },
        { name: 'Brigade Road', maneuver: { type: 'turn', modifier: 'right', location: B }, geometry: { coordinates: [B, mid(B, C), C] } },
        { name: '', maneuver: { type: 'arrive', location: C }, geometry: { coordinates: [C, C] } },
      ],
    }],
  }],
};

const NOMINATIM = [
  { name: 'City Airport', display_name: 'City Airport, Airport Road, Bengaluru', lat: String(C[1]), lon: String(C[0]) },
  { name: 'Old Airport', display_name: 'Old Airport Road, Bengaluru', lat: '12.96', lon: '77.64' },
];

const STATIONS = [
  { stationuuid: '1', name: 'Test Jazz FM', url_resolved: 'https://stream.example/jazz', favicon: '', country: 'Testland', tags: 'jazz,smooth' },
  { stationuuid: '2', name: 'Plain HTTP Radio', url_resolved: 'http://stream.example/http', favicon: '', country: 'Testland', tags: 'pop' },
];

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/akNPBYAAAAASUVORK5CYII=', 'base64');

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.log(`  ✗ ${msg}`); }
}

async function mockNetwork(context) {
  await context.route(/tile\.openstreetmap\.org/, (r) => r.fulfill({ body: PNG, contentType: 'image/png' }));
  await context.route(/nominatim\.openstreetmap\.org/, (r) => r.fulfill({ json: NOMINATIM }));
  await context.route(/router\.project-osrm\.org/, (r) => r.fulfill({ json: OSRM }));
  await context.route(/api\.open-meteo\.com/, (r) => r.fulfill({ json: { current: { temperature_2m: 27.4, weather_code: 1 } } }));
  await context.route(/radio-browser\.info/, (r) => r.fulfill({ json: STATIONS }));
  await context.route(/stream\.example/, (r) => r.fulfill({ status: 404, body: '' }));
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'serve.mjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'pipe' });
  await new Promise((res) => server.stdout.once('data', res));

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    geolocation: { latitude: A[1], longitude: A[0] },
    permissions: ['geolocation'],
    serviceWorkers: 'block',
  });
  await mockNetwork(context);
  const errors = [];

  try {
    // ---------------- Car display ----------------
    console.log('Car display');
    const car = await context.newPage();
    car.on('pageerror', (e) => errors.push(`car: ${e.message}`));
    car.on('console', (m) => m.type() === 'error' && !/Failed to load resource|404/.test(m.text()) && errors.push(`car console: ${m.text()}`));
    await car.goto(`${BASE}/car.html?transport=local`);
    await car.waitForFunction(() => window.carauto?.host?.state === 'online');
    check(true, 'car app loaded and link online');
    await car.waitForFunction(() => document.querySelector('#home-weather').textContent.includes('27'));
    check(true, 'weather tile shows temperature');
    await car.screenshot({ path: `${SHOTS}/car-home.png` });

    await car.click('.taskbar [data-view=apps]');
    check(await car.locator('.launch').count() >= 6, 'app launcher grid shows apps');
    await car.waitForTimeout(250);
    await car.screenshot({ path: `${SHOTS}/car-apps.png` });
    await car.click('[data-open=settings]');
    await car.waitForSelector('#pair-qr svg');
    const code = (await car.textContent('#pair-code')).trim();
    check(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code), `pairing code shown (${code})`);
    check(await car.locator('#pair-qr svg').count() === 1, 'QR code rendered (lazy-loaded)');
    await car.screenshot({ path: `${SHOTS}/car-settings.png` });

    // Voice command parser
    const parsed = await car.evaluate(async () => {
      const { parseCommand } = await import('./js/car/voice.js');
      return ['Navigate to the airport', 'go home', 'play jazz radio', 'call Mom', 'next song', 'stop navigation', 'pause']
        .map((t) => parseCommand(t));
    });
    check(parsed[0].cmd === 'navigate' && parsed[0].query === 'the airport', 'voice: navigate to');
    check(parsed[1].cmd === 'place' && parsed[1].place === 'home', 'voice: go home');
    check(parsed[2].cmd === 'playSearch' && parsed[2].query === 'jazz', 'voice: play jazz radio');
    check(parsed[3].cmd === 'call' && parsed[3].who === 'mom', 'voice: call');
    check(parsed[4].cmd === 'next' && parsed[5].cmd === 'stopNav' && parsed[6].cmd === 'pause', 'voice: next / stop navigation / pause');

    // Location parsing
    const locs = await car.evaluate(async () => {
      const { parseLocationText } = await import('./js/common.js');
      return [
        parseLocationText('https://www.google.com/maps/place/X/@12.9716,77.5946,15z'),
        parseLocationText('https://maps.google.com/?q=12.5,-70.25'),
        parseLocationText('geo:40.7,-74.0'),
        parseLocationText('Just a place name'),
      ];
    });
    check(locs[0]?.lat === 12.9716 && locs[1]?.lon === -70.25 && locs[2]?.lat === 40.7 && locs[3] === null, 'maps link / coordinate parsing');

    // Music: radio browse, favorite
    await car.click('.rail [data-view=music]');
    await car.click('#music-tabs [data-tab=browse]');
    await car.waitForSelector('.track');
    check(await car.locator('.track').count() === 1, 'radio list hides plain-HTTP streams');
    await car.click('.track .star');
    await car.click('#music-tabs [data-tab=favorites]');
    check(await car.locator('.track').count() === 1, 'station saved to favorites');
    await car.click('.track');
    await car.waitForFunction(() => document.querySelector('.music-side [data-np=title]').textContent === 'Test Jazz FM');
    check(true, 'selecting a station updates now playing');
    await car.screenshot({ path: `${SHOTS}/car-music.png` });

    // Phone tab: contacts
    await car.click('.rail [data-view=phone]');
    await car.fill('#contact-form [name=name]', 'Mom');
    await car.fill('#contact-form [name=number]', '+91 98765 43210');
    await car.click('#contact-form button');
    check(await car.locator('.contact').count() === 1, 'favorite contact added');
    await car.screenshot({ path: `${SHOTS}/car-phone.png` });
    await car.click('[data-ptab=keypad]');
    await car.screenshot({ path: `${SHOTS}/car-keypad.png` });
    await car.click('[data-ptab=contacts]');
    await car.goBack();
    await car.waitForSelector('#view-phone', { state: 'hidden' });
    check(true, 'Android back button returns to the dashboard');
    check(await car.locator('#quick-contacts .quick').count() === 1, 'contact appears in quick dial');

    // ---------------- Phone remote ----------------
    console.log('Phone remote');
    const phone = await context.newPage();
    phone.on('pageerror', (e) => errors.push(`phone: ${e.message}`));
    await phone.setViewportSize({ width: 390, height: 844 });
    await phone.goto(`${BASE}/phone.html?transport=local#pair=${code}`);
    await phone.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Connected'), null, { timeout: 10000 });
    check(true, 'phone paired via QR link and connected');
    await car.waitForFunction(() => document.querySelector('#tile-link').textContent.includes('1 phone'));
    check(true, 'car shows phone connected');
    await phone.waitForFunction(() => document.querySelector('#np-title').textContent === 'Test Jazz FM');
    check(true, 'phone shows car now-playing');

    // Send a destination from the phone
    await phone.fill('#dest-form [name=q]', 'airport');
    await phone.click('#dest-form button');
    await phone.waitForSelector('[data-send]');
    await phone.click('[data-send="0"]');
    await car.waitForSelector('#maneuver:not([hidden])', { timeout: 10000 });
    const banner = await car.textContent('#maneuver .text');
    check(/Turn right onto Brigade Road/.test(banner), `car started turn-by-turn ("${banner.trim()}")`);
    await phone.waitForFunction(() => /Brigade Road/.test(document.querySelector('#nav-status').textContent));
    check(true, 'phone shows next turn from car');

    // Phone GPS drives the car along the route
    const send = (lat, lon) => phone.evaluate(([la, lo]) => window.carautoPhone.client.send({ t: 'gps', lat: la, lon: lo, speed: 10, acc: 5 }), [lat, lon]);
    await send(12.9735, 77.5946);
    await car.waitForFunction(() => /\d+ m/.test(document.querySelector('#maneuver .dist').textContent));
    const d1 = await car.textContent('#maneuver .dist');
    check(/^(80|90|100) m$/.test(d1.trim()), `distance to turn updates from phone GPS (${d1.trim()})`);
    await car.screenshot({ path: `${SHOTS}/car-navigating.png` });
    check(await car.locator('#tile-nav .step').count() >= 1, 'dashboard card lists upcoming turns');
    await car.click('#btn-expand');
    await car.waitForTimeout(200);
    await car.screenshot({ path: `${SHOTS}/car-map-full.png` });
    check(await car.evaluate(() => document.body.classList.contains('map-full')), 'map expands to full screen');
    await car.click('#btn-expand');
    await phone.screenshot({ path: `${SHOTS}/phone-remote.png`, fullPage: true });

    await send(12.9743, 77.5960);
    await car.waitForFunction(() => /arrived|destination/i.test(document.querySelector('#maneuver .text').textContent));
    check(true, 'after the turn, next instruction is arrival');
    await send(12.9743, 77.59735);
    await car.waitForSelector('#maneuver', { state: 'hidden' });
    check(true, 'arrival ends navigation');

    // Vehicle trip computer
    const before = await car.evaluate(() => window.carauto.ctx.vehicle._state().trip.dist);
    await car.evaluate(() => {
      // realistic drive: 30 fixes, 1 s apart, 14 m each (~50 km/h) + GPS jitter while parked
      const t0 = Date.now() + 5000;
      const bus = window.carauto.ctx.bus;
      for (let i = 0; i <= 30; i++) bus.emit('pos', { lat: 12.98 + i * 14 / 110540, lon: 77.6, speed: 14, acc: 5, time: t0 + i * 1000 });
      for (let i = 1; i <= 10; i++) bus.emit('pos', { lat: 12.98 + 420 / 110540 + (i % 2) * 0.00002, lon: 77.6, speed: 0, acc: 8, time: t0 + 31000 + i * 1000 });
    });
    const added = (await car.evaluate(() => window.carauto.ctx.vehicle._state().trip.dist)) - before;
    check(added > 400 && added < 440, `trip distance from GPS, parked jitter ignored (+${Math.round(added)} m of 420)`);
    check(/\d{1,2}:\d{2}/.test(await car.textContent('#veh-start')), 'home shows trip start time');
    await car.click('#trip-card');
    await car.waitForSelector('#view-vehicle:not([hidden])');
    await car.fill('#odo-form [name=odo]', '45000');
    await car.click('#odo-form button');
    await car.fill('#fuel-form [name=litres]', '30');
    await car.fill('#fuel-form [name=price]', '100');
    await car.fill('#fuel-form [name=odo]', '44600');
    await car.click('#fuel-form button');
    await car.fill('#fuel-form [name=litres]', '25');
    await car.fill('#fuel-form [name=price]', '102');
    await car.fill('#fuel-form [name=odo]', '45000');
    await car.click('#fuel-form button');
    check((await car.textContent('#veh-mileage')).includes('16.0 km/l'), 'mileage from full-tank fill-ups (16.0 km/l)');
    check((await car.textContent('#veh-totals')).includes('45,000'), 'odometer shown in totals');
    await car.fill('#service-form [name=due]', '45300');
    await car.click('#service-form button');
    check((await car.textContent('#veh-service')).includes('300'), 'service reminder shows distance left');
    check((await car.textContent('#veh-trip-stats')).includes('Fuel used'), 'trip fuel estimate shown');
    await car.screenshot({ path: `${SHOTS}/car-vehicle.png` });
    await car.goBack();
    await car.waitForSelector('#view-vehicle', { state: 'hidden' });
    check((await car.textContent('#veh-mileage-home')).includes('km/l'), 'home trip card shows mileage');
    const tripCmd = await car.evaluate(async () => (await import('./js/car/voice.js')).parseCommand('how far have I driven').cmd);
    check(tripCmd === 'trip', 'voice: "how far have I driven"');

    // Media + message from phone
    await phone.click('[data-media=next]');
    await phone.fill('#say-form textarea', 'Pick up milk');
    await phone.click('#say-form button');
    await car.waitForSelector('#message-overlay:not([hidden])');
    await car.waitForTimeout(300);
    await car.screenshot({ path: `${SHOTS}/car-notification.png` });
    check(await car.textContent('#msg-badge') === '1', 'notification badge on taskbar');
    check((await car.textContent('#message-overlay .body')) === 'Pick up milk', 'message from phone shown in car');
    await car.click('#message-overlay');

    // Off-route rerouting (start again from the beginning of the route)
    await send(A[1], A[0]);
    await phone.evaluate(() => window.carautoPhone.client.send({ t: 'nav', lat: 12.9743, lon: 77.59737, name: 'City Airport', start: true }));
    await car.waitForSelector('#maneuver:not([hidden])');
    let osrmCalls = 0;
    await context.route(/router\.project-osrm\.org/, (r) => { osrmCalls++; r.fulfill({ json: OSRM }); });
    for (let i = 0; i < 4; i++) { await send(12.9716, 77.6000); await car.waitForTimeout(150); }
    await car.waitForTimeout(500);
    check(osrmCalls >= 1, 'driving off route triggers a reroute (not a false arrival)');
    check(await car.evaluate(() => window.carauto.ctx.nav.getState().active), 'navigation still active after going off route');

    // ---------------- Car-Auto Link (Android phone app) ----------------
    console.log('Car-Auto Link (native phone bridge, simulated)');
    await phone.close(); // only one remote, like a real car
    const linkPage = await context.newPage();
    linkPage.on('pageerror', (e) => errors.push(`link: ${e.message}`));
    await linkPage.addInitScript(() => {
      window.__log = [];
      const now = Date.now();
      window.CarAutoLink = {
        getMedia: () => JSON.stringify({ title: 'Song A', artist: 'Artist A', app: 'Spotify', playing: true, duration: 200000, position: 50000, positionAt: now, speed: 1, art: null, artKey: 'a' }),
        getCall: () => JSON.stringify({ state: 'idle' }),
        getContacts: () => JSON.stringify([{ name: 'Alice', number: '111', starred: true }, { name: 'Bob', number: '222', starred: false }]),
        getRecents: () => JSON.stringify([{ name: 'Alice', number: '111', type: 'missed', date: now - 60000 }]),
        mediaCmd: (c) => window.__log.push(`media:${c}`),
        placeCall: (n) => window.__log.push(`call:${n}`),
        callAction: (a) => window.__log.push(`action:${a}`),
        replyMessage: (id, text) => { window.__log.push(`reply:${id}:${text}`); return true; },
        getSms: () => JSON.stringify([{ number: '+9198', name: 'Carol', text: 'Call me', date: now - 120000 }]),
        sendSms: (n, t) => { window.__log.push(`sms:${n}:${t}`); return true; },
        getMusic: () => JSON.stringify([{ id: 11, title: 'Local Song One', artist: 'Band', duration: 200000 }, { id: 12, title: 'Local Song Two', artist: '', duration: 180000 }]),
        playMusic: (ids, i) => window.__log.push(`play:${ids}:${i}`),
        onStatus: () => {},
      };
    });
    await linkPage.goto(`${BASE}/phone.html?transport=local&native=1#pair=${code}`);
    await car.waitForFunction(() => document.querySelector('#media-card [data-np=title]').textContent === 'Song A');
    check((await car.textContent('#media-card [data-np=sub]')).includes('Spotify'), "car shows the phone's music (Spotify)");
    check(await car.isVisible('#media-card [data-np=progress]'), 'progress bar for phone track');
    await car.click('#media-card [data-media=toggle]');
    await linkPage.waitForFunction(() => window.__log.includes('media:pause'));
    check(true, 'car play/pause controls the phone app');
    await car.click('#media-card [data-media=next]');
    await linkPage.waitForFunction(() => window.__log.includes('media:next'));
    check(true, 'car next-track controls the phone app');

    await car.click('.rail [data-view=phone]');
    await car.waitForFunction(() => document.querySelector('#contact-list').textContent.includes('Alice'));
    check(true, 'starred phone contacts appear in Favorites');
    await car.click('[data-ptab=recents]');
    await car.waitForSelector('.row-call.missed');
    check((await car.textContent('#synced-list')).includes('Alice'), 'recent calls synced from phone');
    await car.click('[data-ptab=all]');
    await car.waitForFunction(() => document.querySelector('#synced-list').textContent.includes('Bob'));
    await car.screenshot({ path: `${SHOTS}/car-contacts.png` });
    await car.click('#synced-list [data-num="222"]');
    await linkPage.waitForFunction(() => window.__log.includes('call:222'));
    check(true, 'tapping a contact places the call on the phone');
    await car.click('.rail [data-view=home]');

    await linkPage.evaluate(() => window.carautoNative.onEvent({ type: 'call', state: 'ringing', number: '222', name: 'Bob' }));
    await car.waitForSelector('#call-overlay:not([hidden])');
    check((await car.textContent('#call-name')) === 'Bob', 'incoming call screen shows the caller');
    await car.waitForTimeout(200);
    await car.screenshot({ path: `${SHOTS}/car-incoming-call.png` });
    await car.click('[data-call=answer]');
    await linkPage.waitForFunction(() => window.__log.includes('action:answer'));
    check(true, 'Answer button answers on the phone');
    await linkPage.evaluate(() => window.carautoNative.onEvent({ type: 'call', state: 'active', number: '222', name: 'Bob', since: Date.now() - 65000 }));
    await car.waitForSelector('#call-bar:not([hidden])');
    check(/1:0\d/.test(await car.textContent('#call-timer')), 'in-call bar shows the call timer');
    await car.screenshot({ path: `${SHOTS}/car-in-call.png` });
    await car.click('#call-bar [data-call=end]');
    await linkPage.waitForFunction(() => window.__log.includes('action:end'));
    await linkPage.evaluate(() => window.carautoNative.onEvent({ type: 'call', state: 'idle' }));
    await car.waitForSelector('#call-bar', { state: 'hidden' });
    check(true, 'hanging up clears the call bar');
    await linkPage.evaluate(() => window.carautoNative.onEvent({ type: 'media', media: { title: 'Song B', artist: 'Artist B', app: 'YouTube Music', playing: true, duration: 0, position: 0, artKey: 'b' } }));
    await car.waitForFunction(() => document.querySelector('#media-card [data-np=title]').textContent === 'Song B');
    check(true, 'track changes on the phone update the car');
    await car.screenshot({ path: `${SHOTS}/car-phone-media.png` });
    // Standard edition of the phone app: controls only, no track info
    await linkPage.evaluate(() => window.carautoNative.onEvent({ type: 'media', media: { title: 'Music on your phone', artist: '', app: 'Phone', playing: false, duration: 0, keysOnly: true, artKey: 'keys', art: null } }));
    await car.waitForFunction(() => document.querySelector('#media-card [data-np=title]').textContent === 'Music on your phone');
    await linkPage.evaluate(() => { window.__log.length = 0; });
    await car.click('#media-card [data-media=toggle]');
    await linkPage.waitForFunction(() => window.__log.includes('media:toggle'));
    check(await car.getAttribute('#media-card [data-media=toggle]', 'aria-label') === 'Pause', 'standard phone app: car play button toggles phone music');

    // Messages from phone apps (WhatsApp, SMS…) with replies
    await linkPage.evaluate(() => window.carautoNative.onEvent({ type: 'message', id: 'wa1', app: 'WhatsApp', from: 'Dave', text: 'Where are you?', canReply: true, time: Date.now() }));
    await car.waitForSelector('#message-overlay:not([hidden])');
    check((await car.textContent('#message-overlay .from')).includes('WhatsApp') && await car.isVisible('[data-hu=reply]'), 'WhatsApp message pops up on the car with Reply');
    await car.waitForTimeout(250);
    await car.screenshot({ path: `${SHOTS}/car-message.png` });
    await car.click('[data-hu=reply]');
    await car.waitForSelector('#reply-sheet:not([hidden])');
    await car.screenshot({ path: `${SHOTS}/car-reply.png` });
    await car.click('#reply-quick [data-q="0"]');
    await linkPage.waitForFunction(() => window.__log.includes('reply:wa1:On my way'));
    check(true, 'quick reply is sent through the phone app');
    const replyCmd = await car.evaluate(async () => (await import('./js/car/voice.js')).parseCommand('reply I will be there in 5 minutes'));
    check(replyCmd.cmd === 'reply' && replyCmd.text === 'i will be there in 5 minutes', 'voice: "reply …"');
    await car.evaluate(() => window.carauto.ctx.voiceCmd.execute('reply see you soon'));
    await linkPage.waitForFunction(() => window.__log.includes('reply:wa1:see you soon'));
    check(true, 'voice reply goes to the latest message');
    await car.click('.taskbar [data-view=messages]');
    await car.click('#btn-load-sms');
    await car.waitForFunction(() => document.querySelector('#message-list').textContent.includes('Carol'));
    await car.click('.msg[data-sms="0"] [data-act=reply]');
    await car.click('#reply-quick [data-q="1"]');
    await linkPage.waitForFunction(() => window.__log.some((l) => l.startsWith('sms:+9198:')));
    check(true, 'text messages listed from the phone and answered by SMS');
    await car.goBack();

    // The phone's own music library
    await car.click('.rail [data-view=music]');
    await car.click('#music-tabs [data-tab=phone]');
    await car.waitForFunction(() => document.querySelector('#music-list').textContent.includes('Local Song Two'));
    await car.click('#music-list .track[data-i="1"]');
    await linkPage.waitForFunction(() => window.__log.includes('play:[11,12]:1'));
    check(true, "car's Music app plays songs stored on the phone");
    await car.screenshot({ path: `${SHOTS}/car-phone-library.png` });
    await car.click('.rail [data-view=home]');

    // ---------------- Car-Auto Dash (Android stereo app) ----------------
    console.log('Car-Auto Dash (native stereo bridge, simulated)');
    const dashCtx = await browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: 'block' });
    await mockNetwork(dashCtx);
    const dash = await dashCtx.newPage();
    dash.on('pageerror', (e) => errors.push(`dash: ${e.message}`));
    await dash.addInitScript((icon) => {
      window.__log = [];
      window.CarAutoNative = {
        listApps: () => JSON.stringify([
          { pkg: 'com.google.android.apps.maps', label: 'Maps', icon },
          { pkg: 'com.spotify.music', label: 'Spotify', icon },
          { pkg: 'com.waze', label: 'Waze', icon },
        ]),
        launchApp: (p) => { window.__log.push(`launch:${p}`); return true; },
        openUrl: (u) => window.__log.push(`url:${u}`),
        dial: (n) => window.__log.push(`dial:${n}`),
        startVoice: () => setTimeout(() => {
          window.carautoNative.onEvent({ type: 'voice', partial: 'open spo' });
          window.carautoNative.onEvent({ type: 'voice', final: 'open spotify' });
        }, 50),
        stopVoice: () => {},
        setMediaState: () => {},
        getAutoStart: () => true,
        setAutoStart: (v) => window.__log.push(`autostart:${v}`),
        needsOverlayPermission: () => true,
        openSettings: (w) => window.__log.push(`settings:${w}`),
        getBtMedia: () => 'null',
        btCmd: (c) => window.__log.push(`bt:${c}`),
        btInfoAllowed: () => false,
        allowBtInfo: () => window.__log.push('bt:info'),
        bluetoothAppName: () => 'BT Music',
        switchToBluetooth: () => { window.__log.push('bt:switch'); return true; },
      };
    }, `data:image/png;base64,${PNG.toString('base64')}`);
    await dash.addInitScript(() => {
      const now = Date.now();
      // previous drive that ended 30 minutes ago (stereo was off since)
      localStorage.setItem('carauto.trip', JSON.stringify({ start: now - 90 * 60000, lastSeen: now - 30 * 60000, dist: 12000, moving: 2400, idle: 600, maxSpeed: 20, lastFix: null }));
    });
    await dash.goto(`${BASE}/car.html?transport=local`);
    await dash.waitForFunction(() => window.carauto?.ctx?.vehicle);
    const st = await dash.evaluate(() => window.carauto.ctx.vehicle._state());
    check(st.v.trips.length === 1 && st.v.trips[0].dist === 12000 && Date.now() - st.trip.start < 60000, 'stereo off >10 min starts a new trip and saves the old one');
    await dash.click('.taskbar [data-view=apps]');
    await dash.waitForSelector('#stereo-apps .launch');
    check(await dash.locator('#stereo-apps .launch').count() === 3, 'app grid lists apps installed on the stereo');
    await dash.waitForTimeout(200);
    await dash.screenshot({ path: `${SHOTS}/dash-apps.png` });
    await dash.click('#stereo-apps .launch:nth-child(3)');
    check((await dash.evaluate(() => window.__log)).includes('launch:com.waze'), 'tapping an app launches it');
    await dash.click('.taskbar [data-view=apps]');
    await dash.click('[data-open=aa]');
    check((await dash.evaluate(() => window.__log)).includes('launch:com.andrerinas.headunitrevived'), 'Android Auto tile opens Open Headunit');
    const aaVoice = await dash.evaluate(async () => (await import('./js/car/voice.js')).parseCommand('Start Android Auto').cmd);
    check(aaVoice === 'androidAuto', 'voice: "start Android Auto"');
    check(await dash.evaluate(() => window.carauto.back()) === true, 'Back key closes the open app');
    check(await dash.evaluate(() => window.carauto.back()) === false, 'Back on the dashboard is ignored (launcher stays)');
    await dash.click('#btn-voice');
    await dash.waitForFunction(() => window.__log.includes('launch:com.spotify.music'));
    check(true, 'voice "open Spotify" launches the stereo app');
    await dash.evaluate(() => window.carautoNative.onEvent({ type: 'media', cmd: 'next' }));
    await dash.click('.taskbar [data-view=apps]');
    await dash.click('[data-open=settings]');
    check(await dash.isVisible('#native-card') && await dash.isVisible('#btn-overlay') && !(await dash.isVisible('#get-app-card')), 'native settings (auto-start, home screen) shown in the app');
    await dash.waitForSelector('#pair-qr svg');
    check((await dash.textContent('#pair-url')).startsWith('carauto://pair?code='), 'stereo app QR opens Car-Auto Link (carauto:// link)');
    check((await dash.textContent('#pair-help')).includes('Scan QR code'), 'pairing help tells you to scan in Car-Auto Link');
    await dash.fill('#set-webaddress', 'https://my-car.netlify.app');
    await dash.press('#set-webaddress', 'Enter');
    await dash.locator('#set-webaddress').blur();
    await dash.waitForFunction(() => document.querySelector('#pair-url').textContent.startsWith('https://my-car.netlify.app/phone.html'));
    check(true, 'with a web address set, the QR code uses it (works for iPhones)');
    await dash.click('#set-autostart');

    // Play via Bluetooth (stereo's Bluetooth app)
    await dash.click('.taskbar [data-view=music]');
    await dash.click('#music-tabs [data-tab=bt]');
    await dash.waitForSelector('.bt-panel');
    check((await dash.textContent('.bt-panel')).includes('BT Music') && await dash.isVisible('[data-bt=info]'), 'Bluetooth tab: switch button names the stereo BT app, offers song info');
    await dash.click('[data-bt=switch]');
    let dlog = await dash.evaluate(() => window.__log);
    check(dlog.includes('bt:switch') && dlog.includes('bt:play'), 'Play via Bluetooth switches the stereo and starts the phone');
    check((await dash.textContent('.music-side [data-np=title]')) === 'Bluetooth audio', 'now playing shows Bluetooth audio');
    await dash.evaluate(() => window.carautoNative.onEvent({ type: 'btmedia', media: { title: 'BT Song', artist: 'BT Artist', app: 'BT Music', pkg: 'com.syu.bt', bluetooth: true, playing: true, duration: 240000, position: 1000, artKey: 'x', art: null } }));
    await dash.waitForFunction(() => document.querySelector('.music-side [data-np=title]').textContent === 'BT Song');
    check((await dash.textContent('.music-side [data-np=sub]')).includes('Bluetooth'), 'song info from the stereo Bluetooth app shown');
    await dash.click('.music-side [data-media=next]');
    await dash.click('.music-side [data-media=toggle]');
    dlog = await dash.evaluate(() => window.__log);
    check(dlog.includes('bt:next') && dlog.includes('bt:pause'), 'controls go to the phone over Bluetooth');
    await dash.screenshot({ path: `${SHOTS}/dash-bluetooth.png` });
    const btVoice = await dash.evaluate(async () => (await import('./js/car/voice.js')).parseCommand('play bluetooth').cmd);
    check(btVoice === 'bluetooth', 'voice: "play bluetooth"');
    check((await dash.evaluate(() => window.__log)).includes('autostart:false'), 'auto-start toggle reaches the app');
    await dashCtx.close();

    // Unpaired phone view
    const fresh = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await fresh.goto(`${BASE}/phone.html`);
    check(await fresh.isVisible('#pair-form'), 'unpaired phone shows pairing form');
    await fresh.screenshot({ path: `${SHOTS}/phone-pair.png` });

    // The offline cache must never serve APK downloads (stale versions).
    const swSrc = require('fs').readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
    check(/pathname\.includes\('\/apk\/'\)[\s\S]*return;/.test(swSrc), 'service worker skips APK downloads');

    const landing = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await landing.goto(`${BASE}/index.html`);
    check(await landing.locator('.choice').count() === 2, 'landing page offers car / phone');
    await landing.screenshot({ path: `${SHOTS}/landing.png` });

    check(errors.length === 0, `no JavaScript errors${errors.length ? `:\n    ${errors.join('\n    ')}` : ''}`);
  } catch (e) {
    failures++;
    console.error(e);
    if (errors.length) console.error(errors.join('\n'));
  } finally {
    await browser.close();
    server.kill();
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})();
