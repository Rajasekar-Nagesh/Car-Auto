package app.carauto.dash

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.media.AudioManager
import android.media.MediaMetadata
import android.media.session.MediaController
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.util.Base64
import android.view.KeyEvent
import org.json.JSONObject
import java.io.ByteArrayOutputStream

/**
 * Bluetooth audio from the phone, as seen on the stereo.
 *
 * The stereo's own Bluetooth music app receives the phone's audio and track
 * info (AVRCP). With notification access granted on the stereo, Car-Auto Dash
 * reads that app's media session to show the song and control playback.
 * Without it, commands are sent as media keys, which the Bluetooth app
 * forwards to the phone.
 */
object DashMedia {

    var emit: ((JSONObject) -> Unit)? = null

    private val main = Handler(Looper.getMainLooper())
    private var appContext: Context? = null
    private var manager: MediaSessionManager? = null
    private var controller: MediaController? = null
    private var lastArtKey = ""
    private var lastArt: String? = null
    private var pending = false

    private val BT_HINT = Regex("bluetooth|\\bbt\\b|bt ?music|bt ?audio|a2dp|btmusic|蓝牙", RegexOption.IGNORE_CASE)

    fun listenerComponent(ctx: Context) = ComponentName(ctx, DashNotifListener::class.java)

    fun hasAccess(ctx: Context): Boolean =
        Settings.Secure.getString(ctx.contentResolver, "enabled_notification_listeners")?.contains(ctx.packageName) == true

    private val sessionsListener = MediaSessionManager.OnActiveSessionsChangedListener { list -> pick(list ?: emptyList()) }

    private val callback = object : MediaController.Callback() {
        override fun onMetadataChanged(metadata: MediaMetadata?) = schedule()
        override fun onPlaybackStateChanged(state: PlaybackState?) = schedule()
        override fun onSessionDestroyed() {
            controller = null
            schedule()
        }
    }

    fun start(ctx: Context) {
        val app = ctx.applicationContext
        appContext = app
        if (!hasAccess(app)) return
        val msm = app.getSystemService(Context.MEDIA_SESSION_SERVICE) as? MediaSessionManager ?: return
        manager = msm
        try {
            msm.removeOnActiveSessionsChangedListener(sessionsListener)
            msm.addOnActiveSessionsChangedListener(sessionsListener, listenerComponent(app), main)
            pick(msm.getActiveSessions(listenerComponent(app)))
        } catch (e: SecurityException) {
            // access not granted yet
        }
    }

    /** Prefer the stereo's Bluetooth music app; otherwise any other app's session (never our own). */
    private fun pick(list: List<MediaController>) {
        val ctx = appContext ?: return
        val others = list.filter { it.packageName != ctx.packageName }
        val bt = others.filter { isBluetoothApp(ctx, it.packageName) }
        val best = bt.firstOrNull { it.playbackState?.state == PlaybackState.STATE_PLAYING }
            ?: bt.firstOrNull()
            ?: others.firstOrNull { it.playbackState?.state == PlaybackState.STATE_PLAYING }
        if (best?.sessionToken != controller?.sessionToken) {
            controller?.unregisterCallback(callback)
            controller = best
            best?.registerCallback(callback, main)
        }
        schedule()
    }

    fun isBluetoothApp(ctx: Context, pkg: String): Boolean {
        if (BT_HINT.containsMatchIn(pkg)) return true
        val label = runCatching { ctx.packageManager.getApplicationLabel(ctx.packageManager.getApplicationInfo(pkg, 0)).toString() }.getOrNull()
        return label != null && BT_HINT.containsMatchIn(label)
    }

    private fun schedule() {
        if (pending) return
        pending = true
        main.postDelayed({
            pending = false
            emit?.invoke(JSONObject().put("type", "btmedia").put("media", json(false) ?: JSONObject.NULL))
        }, 250)
    }

    @Synchronized
    fun json(forceArt: Boolean): JSONObject? {
        val ctx = appContext ?: return null
        val c = controller ?: return null
        val md = c.metadata
        val title = md?.getString(MediaMetadata.METADATA_KEY_TITLE) ?: md?.getString(MediaMetadata.METADATA_KEY_DISPLAY_TITLE) ?: ""
        val artist = md?.getString(MediaMetadata.METADATA_KEY_ARTIST) ?: md?.getString(MediaMetadata.METADATA_KEY_ALBUM_ARTIST) ?: ""
        val st = c.playbackState
        val updated = st?.lastPositionUpdateTime ?: 0L
        val artKey = "$title|$artist|${c.packageName}"
        val o = JSONObject()
            .put("title", title)
            .put("artist", artist)
            .put("app", runCatching { ctx.packageManager.getApplicationLabel(ctx.packageManager.getApplicationInfo(c.packageName, 0)).toString() }.getOrDefault("Bluetooth"))
            .put("pkg", c.packageName)
            .put("bluetooth", isBluetoothApp(ctx, c.packageName))
            .put("playing", st?.state == PlaybackState.STATE_PLAYING || st?.state == PlaybackState.STATE_BUFFERING)
            .put("duration", md?.getLong(MediaMetadata.METADATA_KEY_DURATION) ?: 0L)
            .put("position", st?.position ?: 0L)
            .put("positionAt", if (updated > 0) System.currentTimeMillis() - (SystemClock.elapsedRealtime() - updated) else System.currentTimeMillis())
            .put("speed", (st?.playbackSpeed ?: 1f).toDouble())
            .put("artKey", artKey)
        if (forceArt || artKey != lastArtKey) {
            if (artKey != lastArtKey) {
                lastArtKey = artKey
                lastArt = encodeArt(md)
            }
            o.put("art", lastArt ?: JSONObject.NULL)
        }
        return o
    }

    private fun encodeArt(md: MediaMetadata?): String? {
        val src: Bitmap = md?.getBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART)
            ?: md?.getBitmap(MediaMetadata.METADATA_KEY_ART)
            ?: md?.getBitmap(MediaMetadata.METADATA_KEY_DISPLAY_ICON) ?: return null
        val scale = 300f / maxOf(src.width, src.height).coerceAtLeast(1)
        val bmp = if (scale < 1f) Bitmap.createScaledBitmap(src, (src.width * scale).toInt().coerceAtLeast(1), (src.height * scale).toInt().coerceAtLeast(1), true) else src
        val out = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.JPEG, 80, out)
        return "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }

    /** Play/pause/skip the phone over Bluetooth. */
    fun cmd(ctx: Context, cmd: String) {
        val c = controller
        if (c != null) {
            val t = c.transportControls
            when (cmd) {
                "play" -> t.play()
                "pause" -> t.pause()
                "toggle" -> if (c.playbackState?.state == PlaybackState.STATE_PLAYING) t.pause() else t.play()
                "next" -> t.skipToNext()
                "prev" -> t.skipToPrevious()
            }
            return
        }
        // No session visible: send a media key; the stereo's Bluetooth app passes it to the phone.
        val code = when (cmd) {
            "play" -> KeyEvent.KEYCODE_MEDIA_PLAY
            "pause" -> KeyEvent.KEYCODE_MEDIA_PAUSE
            "next" -> KeyEvent.KEYCODE_MEDIA_NEXT
            "prev" -> KeyEvent.KEYCODE_MEDIA_PREVIOUS
            else -> KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE
        }
        val am = ctx.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
        am.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, code))
        am.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_UP, code))
    }

    /** The stereo's Bluetooth music app, if one is installed (launcher apps whose name says Bluetooth/BT). */
    fun findBluetoothApp(ctx: Context): Pair<String, String>? {
        val pm = ctx.packageManager
        val launcher = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val apps = pm.queryIntentActivities(launcher, 0)
            .filter { it.activityInfo.packageName != ctx.packageName }
            .map { it.activityInfo.packageName to it.loadLabel(pm).toString() }
        // Prefer a "music/audio" Bluetooth app over the Bluetooth phone/dialer app.
        return apps.firstOrNull { (pkg, label) -> BT_HINT.containsMatchIn("$pkg $label") && Regex("music|audio|a2dp|media", RegexOption.IGNORE_CASE).containsMatchIn("$pkg $label") }
            ?: apps.firstOrNull { (pkg, label) -> BT_HINT.containsMatchIn("$pkg $label") }
    }
}
