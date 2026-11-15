# Car-Auto

A free **Android Auto / Apple CarPlay alternative** for Android touchscreen car stereos that don't support either.

It comes in two parts. Each one is available as an Android app (full experience) or as a web app (works anywhere):

| | Android app (recommended) | Web app |
|---|---|---|
| **Car stereo** | **Car-Auto Dash** (`car-auto-dash.apk`) | `car.html` in Chrome |
| **Phone** | **Car-Auto Link** (`car-auto-link.apk`), Android only | `phone.html` remote, Android and iPhone |

### What you get

| Feature | Needs |
|---|---|
| Split-screen dashboard: live map, media card, weather, next turns, quick dial | — |
| **Maps** with turn-by-turn voice guidance, rerouting, Home/Work, recent places; hand off to **Google Maps** or **Waze** | — |
| **Music**: internet radio, favorites, files from the stereo or USB | — |
| **Your phone's music on the car screen**: whatever plays in Spotify, YouTube Music, podcasts… with album art, progress and controls | Car-Auto Link |
| **Incoming call screen** (Answer / Decline), in-call bar with timer and End | Car-Auto Link |
| **Contacts and Recents** synced from the phone; tap to call | Car-Auto Link |
| **Open any app installed on the stereo** from the app grid (Google Maps, Waze, Spotify, YouTube…) | Car-Auto Dash |
| **Starts automatically** with the car, or set it as the stereo's **home screen** | Car-Auto Dash |
| Link starts automatically when the phone connects to the car's **Bluetooth** | Car-Auto Link |
| Voice commands: "Navigate to…", "Play jazz radio", "Call Mom", "Answer", "Open Spotify" | — |
| Send destinations and messages from the phone, share phone GPS | Either phone app |

## The car screen

* **Taskbar** on the left: clock; Dashboard, Maps, Music and Phone; notifications, the app grid and the microphone. On portrait screens it moves to the bottom.
* **Split-screen dashboard**: the live map on the left, with a media card and a context card on the right. The context card shows weather and suggested destinations, or your next turns while navigating.
* **Full-screen apps**: Music, Phone (Favorites, Recents, Contacts, Keypad), Notifications and Settings, plus an **app grid** that also lists the stereo's apps. The stereo's **Back** button returns to the dashboard.
* Calls appear as a full-screen **incoming call** card. During a call, a green bar shows the caller and the timer, and the stereo's own radio is paused.

### Built for speed

* The map is created once and keeps running behind every app, so switching screens is instant.
* The car marker glides smoothly between GPS fixes. Map lines are drawn on a canvas.
* With the CPU slowed 4× (like a budget stereo): first paint in about 0.2 s, about 0.08 s on later launches; opening an app takes about 35 ms. The Android apps load the files from inside the APK, so they don't wait on the network.

## How it works

```
 ┌──────────── Car stereo ─────────────┐   WebRTC   ┌─────────────── Android phone ───────────────┐
 │ Car-Auto Dash                       │◀──────────▶│ Car-Auto Link (runs in the background)      │
 │ maps · music · phone · voice        │            │ reads media sessions, call state, contacts  │
 │ opens stereo apps · auto-start      │            │ answers/ends calls, controls music apps     │
 └────────────────┬────────────────────┘            └─────────────────────────────────────────────┘
                  │ Bluetooth (paired once in the stereo's settings)
                  └── call audio + phone music audio, as usual
```

* The stereo and phone connect directly over WebRTC. Pairing uses an 8-character code. The free public PeerJS server only introduces the two devices; you can run your own (see *Advanced*). Both devices need internet: turn on your phone's hotspot and connect the stereo to it.
* **Sound still travels over Bluetooth**, exactly as it does today. Car-Auto adds the screen, the controls and the call handling.
* Maps from OpenStreetMap, routes from OSRM, search from Nominatim, radio from radio-browser.info, weather from Open-Meteo. All free, no API keys.

## 1. Publish it (one time, about 10 minutes)

GitHub builds the APKs and hosts the web app for free:

1. Merge this code into the `main` branch of your GitHub repository.
2. On GitHub, open **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
3. Open the **Actions** tab and wait for **Deploy to GitHub Pages** to finish. Then:
   * Web app: `https://<your-github-username>.github.io/<repo-name>/` (for example `https://rajasekar-nagesh.github.io/Car-Auto/`)
   * Stereo app: `…/apk/car-auto-dash.apk`
   * Phone app: `…/apk/car-auto-link.apk`

Every push also runs **Build Android apps**, and its run page has the two APKs under *Artifacts*.

## 2. Set up the car stereo

1. Turn on your phone's **Wi-Fi hotspot** and connect the stereo to it.
2. Pair your phone with the stereo over **Bluetooth** in the stereo's own settings (for call and music audio).
3. In the stereo's browser, open `…/apk/car-auto-dash.apk` and install it. Android asks you to allow installing from the browser once.
4. Open **Car-Auto Dash** and allow **Location**, **Microphone** and **Phone**.
5. In **Settings → Car-Auto Dash app**:
   * **Start automatically when the stereo turns on** (on by default). On Android 10+ also tap **Allow "display over other apps"**.
   * Or tap **Use as home screen**, the most reliable way to have it open every time the car starts.
6. Set Home and Work, units and your car's name.

> No APK? Open the web address in Chrome on the stereo, choose **"This is my car stereo"** and use ⋮ → **Install app**. Everything works except opening other apps and auto-start.

## 3. Set up your phone

**Android: Car-Auto Link (music, calls, contacts)**

1. On the phone, open `…/apk/car-auto-link.apk` and install it.
2. On the stereo, open **Settings → Pair your phone**. Enter the code in Car-Auto Link and tap **Connect**. Or scan the QR code with the camera and tap **Open in app**.
3. In Car-Auto Link, tap each **Allow** button:
   * **Notification access**: needed to see and control music from other apps and to show caller names.
   * **Phone, contacts & call log**: incoming call screen, answer/decline, contacts, recents.
   * **Keep running in the background**: stops Android from closing the link while you drive.
4. Under **Start automatically**, choose your car stereo's Bluetooth name. From then on the link starts by itself when you get in the car and stops when you leave.

**iPhone (or Android without the app):** scan the QR code with the camera to open the web remote, then use Share → **Add to Home Screen**. It sends destinations and messages, controls the car's radio and shares GPS. Apple doesn't allow apps to read other apps' music or calls, so those features are Android only.

## Voice commands

Tap the microphone in the taskbar (or press the steering-wheel voice button with the stereo app), then say:

| Say | What happens |
|---|---|
| "Navigate to Phoenix Mall", "Take me to the airport" | Searches and starts navigation |
| "Go home", "Navigate to work" | Starts navigation to a saved place |
| "Stop navigation", "How long until we arrive?" | Ends the route / reads out time left |
| "Play jazz radio", "Play music", "Pause", "Next" | Music control (also controls phone music) |
| "Call Mom", "Call 98765 43210" | Calls a contact (phone contacts too) or a number |
| "Answer", "Decline", "Hang up" | Handles the current call |
| "Open Spotify", "Open Waze" | Opens an app on the stereo |
| "What time is it?", "Open music" | Tells the time / switches screens |

## Tips and troubleshooting

* **Try it parked:** turn on **Settings → Demo drive**, then pick a destination.
* **Phone music doesn't show:** in Car-Auto Link check that *Notification access* has a ✓, then start playing something on the phone.
* **Calls don't show:** check *Phone, contacts & call log* has a ✓. Some phone brands also need Car-Auto Link set to "No restrictions" under battery settings.
* **"Car not found":** Car-Auto Dash must be open on the stereo and show *Online — ready for phones* in Settings; both devices need internet.
* **Auto-start doesn't happen:** many stereos sleep instead of shutting down when the car turns off, so they never "boot". Use **Use as home screen** instead.
* **A radio station won't play:** stations that only stream over plain HTTP are hidden; try another.
* **Steering-wheel buttons** go to whatever is playing (Car-Auto radio or your phone's music).

## Advanced

* **Own pairing server:** run a [PeerJS server](https://github.com/peers/peerjs-server) (`npx peer --port 9000`) behind HTTPS and enter its URL in *Settings → Advanced*. Phones pick it up from the QR code.
* **Run locally:** `npm start`, then open http://localhost:8080. Add `?transport=local` to `car.html` and `phone.html` to try both screens in one browser.
* **Tests:** `npm i -D playwright && npm test` drives the car screen, the web remote and simulated versions of both Android apps together, with map, search and radio services mocked.
* **Build the APKs yourself:** install the Android SDK, then run `gradle -p android assembleRelease`. The APKs are signed with `android/carauto.keystore` (password `carauto`) so updates install over older versions. This key is public: make your own before publishing anywhere.

## Project layout

```
index.html, car.html, phone.html   start page, car dashboard, web remote
js/common.js                       shared helpers (storage, geo, formatting, search)
js/link.js                         phone ↔ car connection (WebRTC via PeerJS)
js/car/                            dashboard: app, nav, music, phone, calls, voice, home
js/phone/app.js                    remote (also runs inside Car-Auto Link)
sw.js                              offline cache for the web version
android/dash/                      Car-Auto Dash: stereo app (Kotlin)
android/link/                      Car-Auto Link: phone app (Kotlin)
vendor/                            Leaflet 1.9.4, PeerJS 1.5.4, qrcode-generator 1.4.4
```

## Safety

Set your destination before you drive, or let a passenger use the phone. Use voice commands while driving, and always follow road signs and local laws over the app's directions.

## License

MIT. Map data © OpenStreetMap contributors.
