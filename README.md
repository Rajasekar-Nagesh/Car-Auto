# Car-Auto

A free **Android Auto / Apple CarPlay alternative** for Android touchscreen car stereos that don't support either. It also includes a **phone remote** that works on Android and iPhone.

There's no app store and no account. It's one web app you install from the browser on each device.

| On the car stereo (**Car-Auto Dash**) | On your phone (**Car Remote**) |
|---|---|
| Home dashboard: clock, speed, weather, next turn, now playing, quick dial | Pair by scanning a QR code on the stereo |
| **Maps** with turn-by-turn voice guidance, automatic rerouting, home/work, recent places | Send a destination to the car: search, paste a Google Maps link, or share from Maps (Android) |
| **Music**: internet radio (thousands of stations), favorites, music files from the stereo or a USB drive | Control the car's music and volume |
| **Phone**: dial pad and favorite contacts, calls go through the stereo's Bluetooth hands-free | See the next turn and arrival time |
| **Voice commands**: "Navigate to…", "Play jazz radio", "Call Mom", "Go home" | Send a message that's shown and read aloud in the car |
| Steering-wheel media buttons, day/night theme, works offline for recently seen map areas | **Share phone GPS** with the car if the stereo has no GPS or a weak signal |

## How it works

```
 ┌──────────── Car stereo (Android) ────────────┐        ┌──── Phone (Android / iPhone) ────┐
 │ Car-Auto Dash  (Chrome, installed as an app) │◀──────▶│ Car Remote (browser, installed)  │
 │ maps · music · dialer · voice                │ WebRTC │ destinations · media · GPS · msg │
 └──────────────────────┬───────────────────────┘        └──────────────────────────────────┘
                        │ Bluetooth (set up once in the stereo's own settings)
                        └── call audio + phone media audio
```

* The stereo and the phone connect directly over WebRTC. Pairing uses an 8-character code, which is inside the QR code. The free public PeerJS server is only used to introduce the two devices. You can run your own server instead (see *Advanced*).
* Calls use the stereo's existing Bluetooth hands-free. Car-Auto opens the stereo's dialer with the number filled in.
* Maps come from OpenStreetMap, routes from OSRM, place search from Nominatim, radio stations from radio-browser.info and weather from Open-Meteo. All of them are free and need no API keys.

## 1. Publish it (one time, about 5 minutes)

GPS, the microphone and "Install app" only work over **HTTPS**. GitHub Pages hosts the app for free:

1. Merge this code into the `main` branch of your GitHub repository.
2. On GitHub, open **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
3. Open the **Actions** tab. When the **Deploy to GitHub Pages** run finishes, your app is live at
   `https://<your-github-username>.github.io/<repo-name>/` (for example `https://rajasekar-nagesh.github.io/Car-Auto/`).

## 2. Set up the car stereo

1. Turn on your phone's **Wi-Fi hotspot** and connect the stereo to it, so the stereo has internet in the car.
2. Pair your phone with the stereo over **Bluetooth** in the stereo's own settings (for calls and audio).
3. Open **Chrome** on the stereo and go to your app address. Choose **"This is my car stereo"**.
4. Allow **Location** (and **Microphone** when you first use voice).
5. In Chrome's ⋮ menu tap **Install app** (or **Add to Home screen**). Car-Auto Dash now opens fullscreen from its icon.
6. Open **Settings** in the app to set Home and Work, units (km or miles) and your car's name.

> If the stereo has no Chrome, install "Google Chrome" from its Play Store, or any up-to-date Chromium-based browser.

## 3. Set up your phone

1. On the stereo, open **Settings → Pair your phone**.
2. Scan the QR code with your **phone's camera**. It opens Car Remote, already paired.
3. Install it:
   * **iPhone (Safari):** Share button → **Add to Home Screen**.
   * **Android (Chrome):** ⋮ → **Install app**. You can then share a place from Google Maps → **Car Remote**, and the car starts navigating.

## Voice commands

Tap the microphone in the side bar, then say:

| Say | What happens |
|---|---|
| "Navigate to Phoenix Mall", "Take me to the airport" | Searches and starts navigation |
| "Go home", "Navigate to work" | Starts navigation to a saved place |
| "Stop navigation", "How long until we arrive?" | Ends the route / reads out time and distance left |
| "Play jazz radio", "Play BBC", "Play music", "Pause", "Next" | Music control |
| "Volume up", "Volume down" | Changes the app's volume |
| "Call Mom", "Call 98765 43210" | Calls a favorite contact or a number |
| "What time is it?", "Open music" | Tells the time / switches screens |

Voice recognition uses Chrome's speech service, so it needs internet.

## Tips and troubleshooting

* **Try it without driving:** turn on **Settings → Demo drive**, then pick a destination. The car is moved along the route automatically.
* **"Car not found" on the phone:** make sure Car-Auto Dash is open on the stereo and shows *Online — ready for phones* in Settings, and that both devices have internet.
* **No GPS on the stereo:** on the phone, switch on **Share my GPS** and keep Car Remote open on screen. iPhones pause location sharing when the app is in the background.
* **A radio station won't play:** some stations only stream over plain HTTP, which browsers block on HTTPS pages. Those are hidden from the list. Try another station.
* **Music files** are read straight from the stereo or USB. Pick them again after restarting the app; nothing is uploaded.
* **Steering-wheel buttons:** most Android stereos send media-key presses to the app that's playing, so next, previous and play/pause work while Car-Auto is playing.
* **Keep the screen on** is enabled by default (Settings).

## Advanced

* **Own pairing server:** run a [PeerJS server](https://github.com/peers/peerjs-server) (`npx peer --port 9000`) behind HTTPS and enter its URL in the car's *Settings → Advanced*. Phones that scan the new QR code use it too.
* **Run locally:** `npm start`, then open http://localhost:8080. Add `?transport=local` to `car.html` and `phone.html` to try both screens in one browser without the internet pairing server.
* **Tests:** `npm i -D playwright && npm test` runs an end-to-end test that drives the car screen and the phone remote together, with the map, search and radio services mocked.

## Project layout

```
index.html            start page: choose "car stereo" or "phone"
car.html              car dashboard
phone.html            phone remote
js/common.js          shared helpers (storage, geo, formatting, search)
js/link.js            phone ↔ car connection (WebRTC via PeerJS, heartbeats, reconnects)
js/car/               dashboard modules: app, nav, music, phone, voice, home
js/phone/app.js       remote
sw.js                 offline cache (app files + recently seen map tiles)
vendor/               Leaflet 1.9.4, PeerJS 1.5.4, qrcode-generator 1.4.4 (bundled, MIT/BSD)
```

## Safety

Set your destination before you drive, or let a passenger use the phone remote. Use voice commands while driving, and always follow road signs and local laws over the app's directions.

## License

MIT. Map data © OpenStreetMap contributors.
