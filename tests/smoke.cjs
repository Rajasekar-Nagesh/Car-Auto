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

    await car.click('.rail [data-view=settings]');
    const code = (await car.textContent('#pair-code')).trim();
    check(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code), `pairing code shown (${code})`);
    check(await car.locator('#pair-qr svg').count() === 1, 'QR code rendered');
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
    await car.click('.rail [data-view=home]');
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
    await phone.screenshot({ path: `${SHOTS}/phone-remote.png`, fullPage: true });

    await send(12.9743, 77.5960);
    await car.waitForFunction(() => /arrived|destination/i.test(document.querySelector('#maneuver .text').textContent));
    check(true, 'after the turn, next instruction is arrival');
    await send(12.9743, 77.59735);
    await car.waitForSelector('#maneuver', { state: 'hidden' });
    check(true, 'arrival ends navigation');

    // Media + message from phone
    await phone.click('[data-media=next]');
    await phone.fill('#say-form textarea', 'Pick up milk');
    await phone.click('#say-form button');
    await car.waitForSelector('#message-overlay:not([hidden])');
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

    // Unpaired phone view
    const fresh = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await fresh.goto(`${BASE}/phone.html`);
    check(await fresh.isVisible('#pair-form'), 'unpaired phone shows pairing form');
    await fresh.screenshot({ path: `${SHOTS}/phone-pair.png` });

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
