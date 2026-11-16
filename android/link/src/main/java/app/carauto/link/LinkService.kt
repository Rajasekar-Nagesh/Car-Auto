package app.carauto.link

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.webkit.GeolocationPermissions
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebView
import org.json.JSONObject

/**
 * Keeps the phone linked to the car in the background.
 *
 * It runs the bundled web remote (phone.html) in a hidden WebView, which
 * handles pairing and the WebRTC connection, and gives that page native
 * access to media, calls and contacts through [Bridge].
 */
class LinkService : Service() {

    private val main = Handler(Looper.getMainLooper())
    private var web: WebView? = null
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
        startInForeground("Connecting to car…")
        running = true
        if (Prefs.code(this) == null) {
            stopSelf()
            return
        }
        wakeLock = getSystemService(PowerManager::class.java)
            ?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "CarAuto:link")
            ?.apply { acquire(12 * 60 * 60 * 1000L) }
        startWebView()
        PhoneHub.listener = { event -> sendToPage(event) }
        PhoneHub.startMedia(this)
        PhoneHub.startCalls(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        PhoneHub.listener = null
        PhoneHub.stopMedia()
        PhoneHub.stopCalls(this)
        PhonePlayer.stop()
        BtLink.close()
        web?.destroy()
        web = null
        wakeLock?.let { if (it.isHeld) it.release() }
        updateStatus("Stopped", notify = false)
        super.onDestroy()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun startWebView() {
        val code = Prefs.code(this) ?: return
        val w = WebView(applicationContext)
        with(w.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            setGeolocationEnabled(true)
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            // The direct link to the stereo is a plain ws:// connection on the local network.
            mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        }
        w.webViewClient = AssetWebClient(this)
        w.webChromeClient = object : WebChromeClient() {
            override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) {
                callback.invoke(origin, true, false)
            }
        }
        w.addJavascriptInterface(Bridge(), "CarAutoLink")
        val gps = if (Prefs.shareGps(this)) "&gps=1" else ""
        var hash = "pair=" + Uri.encode(code)
        Prefs.server(this)?.let { hash += "&srv=" + Uri.encode(it) }
        w.loadUrl("$APP_ORIGIN/web/phone.html?native=1$gps#$hash")
        w.onResume()
        w.resumeTimers()
        web = w
    }

    private fun sendToPage(event: JSONObject) {
        main.post { web?.evaluateJavascript("window.carautoNative&&window.carautoNative.onEvent($event)", null) }
    }

    // ---- Notification / status ----

    private fun createChannel() {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Car connection", NotificationManager.IMPORTANCE_LOW))
    }

    private fun buildNotification(text: String): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(
            this, 1, Intent(this, LinkService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE,
        )
        return Notification.Builder(this, CHANNEL)
            .setContentTitle("Car-Auto Link")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(Notification.Action.Builder(null, "Disconnect", stop).build())
            .build()
    }

    private fun startInForeground(text: String) {
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIF_ID, buildNotification(text), ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        } else {
            startForeground(NOTIF_ID, buildNotification(text))
        }
    }

    private fun updateStatus(text: String, notify: Boolean = true) {
        status = text
        main.post {
            statusListener?.invoke(text)
            if (notify && running) getSystemService(NotificationManager::class.java).notify(NOTIF_ID, buildNotification(text))
        }
    }

    /** JavaScript interface (`window.CarAutoLink`) for the hidden phone.html page. */
    inner class Bridge {
        private val ctx: Context get() = this@LinkService

        @JavascriptInterface
        fun getMedia(): String = (PhoneHub.mediaJson(ctx, true) ?: PhoneHub.keysOnlyMedia()).toString()

        @JavascriptInterface
        fun getCall(): String = PhoneHub.callJson().toString()

        @JavascriptInterface
        fun mediaCmd(cmd: String) {
            main.post { PhoneHub.mediaCmd(ctx, cmd) }
        }

        @JavascriptInterface
        fun placeCall(number: String) {
            main.post { PhoneHub.placeCall(ctx, number) }
        }

        @JavascriptInterface
        fun callAction(action: String) {
            main.post { PhoneHub.callAction(ctx, action) }
        }

        @JavascriptInterface
        fun getContacts(): String = PhoneHub.contacts(ctx).toString()

        @JavascriptInterface
        fun getRecents(): String = PhoneHub.recents(ctx).toString()

        /** Connect to the stereo over Bluetooth; answers with "btLink" events. */
        @JavascriptInterface
        fun btConnect(code: String) {
            Thread { BtLink.connect(ctx, code) { event -> sendToPage(event) } }.start()
        }

        @JavascriptInterface
        fun btSend(text: String) = BtLink.send(text)

        @JavascriptInterface
        fun btClose() = BtLink.close()

        /** Look for the car on the local network; answers with a "lanFound" event. */
        @JavascriptInterface
        fun discoverCar(code: String) {
            Thread {
                val addr = LanFinder.find(code)
                sendToPage(JSONObject().put("type", "lanFound").put("addr", addr ?: ""))
            }.start()
        }

        @JavascriptInterface
        fun replyMessage(id: String, text: String): Boolean = Messages.reply(ctx, id, text)

        @JavascriptInterface
        fun getSms(): String = Messages.recentSms(ctx).toString()

        @JavascriptInterface
        fun sendSms(number: String, text: String): Boolean = Messages.sendSms(ctx, number, text)

        @JavascriptInterface
        fun getMusic(): String = PhonePlayer.library(ctx).toString()

        @JavascriptInterface
        fun playMusic(idsJson: String, index: Int) {
            main.post { PhonePlayer.play(ctx, idsJson, index) }
        }

        @JavascriptInterface
        fun onStatus(state: String, message: String) {
            updateStatus(
                when (state) {
                    "connected" -> when (message) {
                        "direct" -> "Connected to your car (direct over hotspot)"
                        "bluetooth" -> "Connected to your car (over Bluetooth)"
                        else -> "Connected to your car (over the internet)"
                    }
                    "connecting" -> "Connecting to car…"
                    else -> message.ifBlank { "Waiting for the car…" }
                },
            )
        }
    }

    companion object {
        private const val CHANNEL = "link"
        private const val NOTIF_ID = 1
        private const val ACTION_STOP = "app.carauto.link.STOP"

        @Volatile var running = false
            private set
        @Volatile var status = "Not connected"
            private set
        var statusListener: ((String) -> Unit)? = null

        fun start(ctx: Context) {
            ctx.startForegroundService(Intent(ctx, LinkService::class.java))
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, LinkService::class.java))
        }

        fun restart(ctx: Context) {
            stop(ctx)
            Handler(Looper.getMainLooper()).postDelayed({ start(ctx) }, 400)
        }
    }
}
