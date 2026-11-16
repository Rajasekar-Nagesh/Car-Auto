package app.carauto.link

import android.Manifest
import android.app.Notification
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.AudioManager
import android.media.MediaMetadata
import android.media.session.MediaController
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.CallLog
import android.provider.ContactsContract
import android.telecom.TelecomManager
import android.telephony.PhoneStateListener
import android.telephony.TelephonyManager
import android.util.Base64
import android.view.KeyEvent
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream

/**
 * Everything the car learns about the phone: what's playing in any music app,
 * the call state, contacts and recent calls. Events go to [listener]
 * (LinkService forwards them to the car).
 */
object PhoneHub {

    var listener: ((JSONObject) -> Unit)? = null

    private val main = Handler(Looper.getMainLooper())
    private fun granted(ctx: Context, perm: String) = ctx.checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED

    // =========================================================================
    // Media (any app with a media session: Spotify, YouTube Music, podcasts…)
    // Requires notification access (NotifListener) to read other apps' sessions.
    // =========================================================================

    private var appContext: Context? = null
    private var sessionManager: MediaSessionManager? = null
    private var controller: MediaController? = null
    private var lastArtKey = ""
    private var lastArt: String? = null
    private var pushPending = false

    private val sessionsListener = MediaSessionManager.OnActiveSessionsChangedListener { list ->
        pick(list ?: emptyList())
    }

    private val controllerCallback = object : MediaController.Callback() {
        override fun onMetadataChanged(metadata: MediaMetadata?) = schedulePush()
        override fun onPlaybackStateChanged(state: PlaybackState?) {
            // A different app may have started playing: re-check which session is most relevant.
            val ctx = appContext
            val msm = sessionManager
            if (ctx != null && msm != null && state?.state != PlaybackState.STATE_PLAYING) {
                runCatching { pick(msm.getActiveSessions(ComponentName(ctx, NotifListener::class.java))) }
            }
            schedulePush()
        }
        override fun onSessionDestroyed() {
            controller = null
            schedulePush()
        }
    }

    fun startMedia(ctx: Context) {
        val app = ctx.applicationContext
        appContext = app
        val msm = app.getSystemService(MediaSessionManager::class.java) ?: return
        sessionManager = msm
        val component = ComponentName(app, NotifListener::class.java)
        try {
            msm.removeOnActiveSessionsChangedListener(sessionsListener)
            msm.addOnActiveSessionsChangedListener(sessionsListener, component, main)
            pick(msm.getActiveSessions(component))
        } catch (e: SecurityException) {
            // Notification access not granted yet; MainActivity asks for it.
        }
    }

    fun stopMedia() {
        runCatching { sessionManager?.removeOnActiveSessionsChangedListener(sessionsListener) }
        controller?.unregisterCallback(controllerCallback)
        controller = null
    }

    private fun pick(list: List<MediaController>) {
        val best = list.firstOrNull { it.playbackState?.state == PlaybackState.STATE_PLAYING } ?: list.firstOrNull()
        if (best?.sessionToken != controller?.sessionToken) {
            controller?.unregisterCallback(controllerCallback)
            controller = best
            best?.registerCallback(controllerCallback, main)
        }
        schedulePush()
    }

    private fun schedulePush() {
        if (pushPending) return
        pushPending = true
        main.postDelayed({
            pushPending = false
            val ctx = appContext ?: return@postDelayed
            listener?.invoke(JSONObject().put("type", "media").put("media", mediaJson(ctx, false) ?: JSONObject.NULL))
        }, 250)
    }

    /** Current track, or null. Album art is included only when it changed (or [forceArt]). */
    @Synchronized
    fun mediaJson(ctx: Context, forceArt: Boolean): JSONObject? {
        val c = controller ?: return null
        val md = c.metadata ?: return null
        val title = md.getString(MediaMetadata.METADATA_KEY_TITLE)
            ?: md.getString(MediaMetadata.METADATA_KEY_DISPLAY_TITLE) ?: return null
        val artist = md.getString(MediaMetadata.METADATA_KEY_ARTIST)
            ?: md.getString(MediaMetadata.METADATA_KEY_ALBUM_ARTIST)
            ?: md.getString(MediaMetadata.METADATA_KEY_DISPLAY_SUBTITLE) ?: ""
        val st = c.playbackState
        val playing = st?.state == PlaybackState.STATE_PLAYING || st?.state == PlaybackState.STATE_BUFFERING
        val updated = st?.lastPositionUpdateTime ?: 0L
        val positionAt = if (updated > 0) System.currentTimeMillis() - (SystemClock.elapsedRealtime() - updated) else System.currentTimeMillis()
        val artKey = "$title|$artist|${c.packageName}"
        val o = JSONObject()
            .put("title", title)
            .put("artist", artist)
            .put("album", md.getString(MediaMetadata.METADATA_KEY_ALBUM) ?: "")
            .put("app", appLabel(ctx, c.packageName))
            .put("pkg", c.packageName)
            .put("playing", playing)
            .put("duration", md.getLong(MediaMetadata.METADATA_KEY_DURATION))
            .put("position", st?.position ?: 0L)
            .put("positionAt", positionAt)
            .put("speed", (st?.playbackSpeed ?: 1f).toDouble())
            .put("artKey", artKey)
        if (forceArt || artKey != lastArtKey) {
            if (artKey != lastArtKey) {
                lastArtKey = artKey
                lastArt = encodeArt(ctx, md)
            }
            o.put("art", lastArt ?: JSONObject.NULL)
        }
        return o
    }

    private fun encodeArt(ctx: Context, md: MediaMetadata): String? {
        var bmp: Bitmap? = md.getBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART)
            ?: md.getBitmap(MediaMetadata.METADATA_KEY_ART)
            ?: md.getBitmap(MediaMetadata.METADATA_KEY_DISPLAY_ICON)
        if (bmp == null) {
            val uri = md.getString(MediaMetadata.METADATA_KEY_ALBUM_ART_URI) ?: md.getString(MediaMetadata.METADATA_KEY_ART_URI)
            if (uri != null && (uri.startsWith("content:") || uri.startsWith("android.resource:"))) {
                bmp = runCatching { ctx.contentResolver.openInputStream(Uri.parse(uri))?.use { BitmapFactory.decodeStream(it) } }.getOrNull()
            }
        }
        val src = bmp ?: return null
        val scale = 300f / maxOf(src.width, src.height).coerceAtLeast(1)
        val scaled = if (scale < 1f) Bitmap.createScaledBitmap(src, (src.width * scale).toInt().coerceAtLeast(1), (src.height * scale).toInt().coerceAtLeast(1), true) else src
        val out = ByteArrayOutputStream()
        scaled.compress(Bitmap.CompressFormat.JPEG, 80, out)
        return "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }

    private fun appLabel(ctx: Context, pkg: String): String = try {
        val pm = ctx.packageManager
        pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
    } catch (e: Exception) {
        pkg.substringAfterLast('.').replaceFirstChar { it.uppercase() }
    }

    fun mediaCmd(ctx: Context, cmd: String) {
        val c = controller
        if (c == null) {
            // No active session: a play key resumes the last music app.
            if (cmd == "play" || cmd == "toggle") sendMediaKey(ctx, KeyEvent.KEYCODE_MEDIA_PLAY)
            return
        }
        val t = c.transportControls
        when (cmd) {
            "play" -> t.play()
            "pause" -> t.pause()
            "toggle" -> if (c.playbackState?.state == PlaybackState.STATE_PLAYING) t.pause() else t.play()
            "next" -> t.skipToNext()
            "prev" -> t.skipToPrevious()
        }
    }

    private fun sendMediaKey(ctx: Context, code: Int) {
        val am = ctx.getSystemService(AudioManager::class.java) ?: return
        am.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, code))
        am.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_UP, code))
    }

    // =========================================================================
    // Calls
    // =========================================================================

    private var phoneListener: PhoneStateListener? = null
    private var callState = "idle"
    private var callNumber = ""
    private var callName = ""
    private var callSince = 0L
    private var lastDialed = ""
    private var notifCallerName: String? = null
    private var callActions: Array<Notification.Action>? = null

    @Suppress("DEPRECATION")
    fun startCalls(ctx: Context) {
        if (phoneListener != null) return
        val app = ctx.applicationContext
        val tm = app.getSystemService(TelephonyManager::class.java) ?: return
        val l = object : PhoneStateListener() {
            @Deprecated("Deprecated in Java")
            override fun onCallStateChanged(state: Int, phoneNumber: String?) = onCallState(app, state, phoneNumber)
        }
        try {
            tm.listen(l, PhoneStateListener.LISTEN_CALL_STATE)
            phoneListener = l
        } catch (e: SecurityException) {
            // READ_PHONE_STATE not granted yet.
        }
    }

    @Suppress("DEPRECATION")
    fun stopCalls(ctx: Context) {
        val l = phoneListener ?: return
        ctx.applicationContext.getSystemService(TelephonyManager::class.java)?.listen(l, PhoneStateListener.LISTEN_NONE)
        phoneListener = null
    }

    private fun onCallState(ctx: Context, state: Int, number: String?) {
        val num = number?.takeIf { it.isNotBlank() } ?: callNumber
        when (state) {
            TelephonyManager.CALL_STATE_RINGING -> {
                callState = "ringing"
                callNumber = num
                callName = lookupName(ctx, num) ?: notifCallerName ?: ""
            }
            TelephonyManager.CALL_STATE_OFFHOOK -> {
                if (callState != "active") callSince = System.currentTimeMillis()
                if (callState == "idle") {
                    callNumber = num.ifBlank { lastDialed }
                    callName = lookupName(ctx, callNumber) ?: ""
                }
                callState = "active"
            }
            else -> {
                val missed = callState == "ringing"
                callState = "idle"
                listener?.invoke(callJson().put("missed", missed).put("number", callNumber).put("name", callName))
                callNumber = ""
                callName = ""
                notifCallerName = null
                callActions = null
                return
            }
        }
        listener?.invoke(callJson())
    }

    /** The phone app's call notification carries the caller's name and Answer/Decline actions. */
    fun onCallNotification(n: Notification) {
        notifCallerName = n.extras?.getCharSequence(Notification.EXTRA_TITLE)?.toString()
        callActions = n.actions
        if (callState == "ringing" && callName.isBlank() && !notifCallerName.isNullOrBlank()) {
            callName = notifCallerName ?: ""
            main.post { listener?.invoke(callJson()) }
        }
    }

    fun callJson(): JSONObject = JSONObject()
        .put("type", "call")
        .put("state", callState)
        .put("number", callNumber)
        .put("name", callName)
        .put("since", callSince)

    @Suppress("DEPRECATION")
    fun callAction(ctx: Context, action: String) {
        val telecom = ctx.getSystemService(TelecomManager::class.java)
        val canControl = granted(ctx, Manifest.permission.ANSWER_PHONE_CALLS)
        try {
            when (action) {
                "answer" -> if (canControl && telecom != null) telecom.acceptRingingCall() else fireCallAction(true)
                "decline", "end" -> {
                    val ended = canControl && telecom != null && Build.VERSION.SDK_INT >= 28 && telecom.endCall()
                    if (!ended) fireCallAction(false)
                }
            }
        } catch (e: SecurityException) {
            fireCallAction(action == "answer")
        }
    }

    private fun fireCallAction(answer: Boolean) {
        val words = if (answer) listOf("answer", "accept") else listOf("decline", "reject", "hang", "end")
        val match = callActions?.firstOrNull { a -> words.any { a.title?.toString()?.lowercase()?.contains(it) == true } }
        runCatching { match?.actionIntent?.send() }
    }

    fun placeCall(ctx: Context, number: String) {
        if (number.isBlank()) return
        lastDialed = number
        val uri = Uri.fromParts("tel", number, null)
        if (granted(ctx, Manifest.permission.CALL_PHONE)) {
            try {
                ctx.getSystemService(TelecomManager::class.java)?.placeCall(uri, Bundle())
                return
            } catch (e: SecurityException) {
                // fall through to the dialer
            }
        }
        runCatching { ctx.startActivity(Intent(Intent.ACTION_DIAL, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    }

    // =========================================================================
    // Contacts and call log
    // =========================================================================

    fun contacts(ctx: Context): JSONArray {
        val arr = JSONArray()
        if (!granted(ctx, Manifest.permission.READ_CONTACTS)) return arr
        val seen = HashSet<String>()
        val cols = arrayOf(
            ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
            ContactsContract.CommonDataKinds.Phone.NUMBER,
            ContactsContract.CommonDataKinds.Phone.STARRED,
        )
        ctx.contentResolver.query(
            ContactsContract.CommonDataKinds.Phone.CONTENT_URI, cols, null, null,
            "${ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} COLLATE NOCASE ASC",
        )?.use { c ->
            while (c.moveToNext() && arr.length() < 3000) {
                val name = c.getString(0) ?: continue
                val num = c.getString(1) ?: continue
                if (!seen.add(name + "|" + num.filter { it.isDigit() }.takeLast(9))) continue
                arr.put(JSONObject().put("name", name).put("number", num).put("starred", c.getInt(2) == 1))
            }
        }
        return arr
    }

    fun recents(ctx: Context): JSONArray {
        val arr = JSONArray()
        if (!granted(ctx, Manifest.permission.READ_CALL_LOG)) return arr
        val cols = arrayOf(CallLog.Calls.NUMBER, CallLog.Calls.CACHED_NAME, CallLog.Calls.TYPE, CallLog.Calls.DATE)
        ctx.contentResolver.query(CallLog.Calls.CONTENT_URI, cols, null, null, "${CallLog.Calls.DATE} DESC")?.use { c ->
            while (c.moveToNext() && arr.length() < 60) {
                val type = when (c.getInt(2)) {
                    CallLog.Calls.OUTGOING_TYPE -> "out"
                    CallLog.Calls.MISSED_TYPE, CallLog.Calls.REJECTED_TYPE -> "missed"
                    else -> "in"
                }
                arr.put(
                    JSONObject()
                        .put("number", c.getString(0) ?: "")
                        .put("name", c.getString(1) ?: "")
                        .put("type", type)
                        .put("date", c.getLong(3)),
                )
            }
        }
        return arr
    }

    private fun lookupName(ctx: Context, number: String): String? {
        if (number.isBlank() || !granted(ctx, Manifest.permission.READ_CONTACTS)) return null
        val uri = Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(number))
        return runCatching {
            ctx.contentResolver.query(uri, arrayOf(ContactsContract.PhoneLookup.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) c.getString(0) else null
            }
        }.getOrNull()
    }
}
