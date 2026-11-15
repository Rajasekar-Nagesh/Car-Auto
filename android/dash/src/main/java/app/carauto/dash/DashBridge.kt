package app.carauto.dash

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.Drawable
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream

/**
 * JavaScript interface exposed to the dashboard as `window.CarAutoNative`.
 * Methods are called on a WebView background thread; UI work is posted to main.
 */
class DashBridge(private val activity: MainActivity, private val web: WebView) {

    private val main = Handler(Looper.getMainLooper())
    private val prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private var recognizer: SpeechRecognizer? = null

    /** A media session so steering-wheel buttons reach the dashboard even when another app is in front. */
    private val session = MediaSession(activity, "CarAutoDash").apply {
        @Suppress("DEPRECATION")
        setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS or MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS)
        setCallback(object : MediaSession.Callback() {
            override fun onPlay() = emitMedia("play")
            override fun onPause() = emitMedia("pause")
            override fun onStop() = emitMedia("pause")
            override fun onSkipToNext() = emitMedia("next")
            override fun onSkipToPrevious() = emitMedia("prev")
        })
    }

    fun emit(event: JSONObject) {
        main.post { web.evaluateJavascript("window.carautoNative&&window.carautoNative.onEvent($event)", null) }
    }

    private fun emitMedia(cmd: String) = emit(JSONObject().put("type", "media").put("cmd", cmd))

    private fun emitVoice(key: String, value: String) = emit(JSONObject().put("type", "voice").put(key, value))

    @JavascriptInterface
    fun version(): Int = 1

    // ---- Apps on the stereo ----

    @JavascriptInterface
    fun listApps(): String {
        val pm = activity.packageManager
        val launcher = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val result = JSONArray()
        pm.queryIntentActivities(launcher, 0)
            .filter { it.activityInfo.packageName != activity.packageName }
            .distinctBy { it.activityInfo.packageName }
            .map { it to it.loadLabel(pm).toString() }
            .sortedBy { it.second.lowercase() }
            .forEach { (info, label) ->
                result.put(
                    JSONObject()
                        .put("pkg", info.activityInfo.packageName)
                        .put("label", label)
                        .put("icon", iconData(info.loadIcon(pm))),
                )
            }
        return result.toString()
    }

    private fun iconData(drawable: Drawable): String {
        val size = 112
        val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        drawable.setBounds(0, 0, size, size)
        drawable.draw(Canvas(bitmap))
        val out = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
        bitmap.recycle()
        return "data:image/png;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }

    @JavascriptInterface
    fun launchApp(pkg: String): Boolean {
        val intent = activity.packageManager.getLaunchIntentForPackage(pkg) ?: return false
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        main.post { runCatching { activity.startActivity(intent) } }
        return true
    }

    @JavascriptInterface
    fun openUrl(url: String) {
        main.post { openExternal(activity, url) }
    }

    // ---- Calls through the stereo's own Bluetooth dialer ----

    @JavascriptInterface
    fun dial(number: String) {
        main.post {
            val uri = Uri.fromParts("tel", number, null)
            val canCall = Build.VERSION.SDK_INT < 23 ||
                activity.checkSelfPermission(Manifest.permission.CALL_PHONE) == PackageManager.PERMISSION_GRANTED
            val call = Intent(if (canCall) Intent.ACTION_CALL else Intent.ACTION_DIAL, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            try {
                activity.startActivity(call)
            } catch (e: Exception) {
                runCatching { activity.startActivity(Intent(Intent.ACTION_DIAL, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
            }
        }
    }

    // ---- Voice ----

    @JavascriptInterface
    fun startVoice(lang: String) {
        main.post {
            if (!SpeechRecognizer.isRecognitionAvailable(activity)) {
                emitVoice("error", "unavailable")
                return@post
            }
            if (Build.VERSION.SDK_INT >= 23 &&
                activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED
            ) {
                activity.requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 3)
                emitVoice("error", "not-allowed")
                return@post
            }
            recognizer?.destroy()
            val r = SpeechRecognizer.createSpeechRecognizer(activity)
            recognizer = r
            r.setRecognitionListener(object : RecognitionListener {
                override fun onReadyForSpeech(params: Bundle?) {}
                override fun onBeginningOfSpeech() {}
                override fun onRmsChanged(rmsdB: Float) {}
                override fun onBufferReceived(buffer: ByteArray?) {}
                override fun onEndOfSpeech() {}
                override fun onEvent(eventType: Int, params: Bundle?) {}

                override fun onError(error: Int) {
                    val code = when (error) {
                        SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "no-match"
                        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "not-allowed"
                        else -> "error-$error"
                    }
                    emitVoice("error", code)
                }

                override fun onResults(results: Bundle?) {
                    val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: ""
                    emitVoice("final", text)
                }

                override fun onPartialResults(partialResults: Bundle?) {
                    val text = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()
                    if (!text.isNullOrBlank()) emitVoice("partial", text)
                }
            })
            val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang)
                .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            r.startListening(intent)
        }
    }

    @JavascriptInterface
    fun stopVoice() {
        main.post { recognizer?.cancel() }
    }

    // ---- Media state (for steering-wheel buttons) ----

    @JavascriptInterface
    fun setMediaState(title: String, artist: String, playing: Boolean) {
        main.post {
            session.setMetadata(
                MediaMetadata.Builder()
                    .putString(MediaMetadata.METADATA_KEY_TITLE, title)
                    .putString(MediaMetadata.METADATA_KEY_ARTIST, artist)
                    .build(),
            )
            session.setPlaybackState(
                PlaybackState.Builder()
                    .setActions(
                        PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_PLAY_PAUSE or
                            PlaybackState.ACTION_SKIP_TO_NEXT or PlaybackState.ACTION_SKIP_TO_PREVIOUS or PlaybackState.ACTION_STOP,
                    )
                    .setState(
                        if (playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED,
                        PlaybackState.PLAYBACK_POSITION_UNKNOWN,
                        1f,
                    )
                    .build(),
            )
            session.isActive = true
        }
    }

    // ---- Auto-start / home screen ----

    @JavascriptInterface
    fun getAutoStart(): Boolean = prefs.getBoolean(KEY_AUTOSTART, true)

    @JavascriptInterface
    fun setAutoStart(on: Boolean) {
        prefs.edit().putBoolean(KEY_AUTOSTART, on).apply()
        if (on && needsOverlayPermission()) openSettings("overlay")
    }

    /** Android 10+ only lets apps open themselves at boot with "display over other apps". */
    @JavascriptInterface
    fun needsOverlayPermission(): Boolean = Build.VERSION.SDK_INT >= 29 && !Settings.canDrawOverlays(activity)

    @JavascriptInterface
    fun openSettings(which: String) {
        main.post {
            val intent = when (which) {
                "overlay" -> Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${activity.packageName}"))
                "home" -> Intent(Settings.ACTION_HOME_SETTINGS)
                else -> Intent(Settings.ACTION_SETTINGS)
            }.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            try {
                activity.startActivity(intent)
            } catch (e: Exception) {
                runCatching { activity.startActivity(Intent(Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
            }
        }
    }

    fun release() {
        recognizer?.destroy()
        session.release()
    }

    companion object {
        const val PREFS = "carauto"
        const val KEY_AUTOSTART = "autostart"
    }
}
