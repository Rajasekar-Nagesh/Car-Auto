package app.carauto.dash

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import org.json.JSONObject

/**
 * Car-Auto Dash: full-screen car dashboard for Android head units.
 * Hosts the bundled web dashboard and adds what a browser can't do:
 * open any installed app, native voice recognition, steering-wheel keys,
 * direct dialing, auto-start and acting as the home screen.
 */
class MainActivity : Activity() {

    private lateinit var web: WebView
    private lateinit var bridge: DashBridge
    private var fileCallback: ValueCallback<Array<Uri>>? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        web = WebView(this)
        web.setBackgroundColor(Color.BLACK)
        setContentView(web)
        hideStatusBar()

        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            setGeolocationEnabled(true)
            allowFileAccess = false
            allowContentAccess = true
            textZoom = 100
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
        }
        web.webViewClient = AssetWebClient(this)
        web.webChromeClient = object : WebChromeClient() {
            override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) {
                callback.invoke(origin, true, false)
            }

            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread { request.grant(request.resources) }
            }

            override fun onShowFileChooser(
                webView: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams,
            ): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = filePathCallback
                val pick = Intent(Intent.ACTION_GET_CONTENT)
                    .addCategory(Intent.CATEGORY_OPENABLE)
                    .setType("audio/*")
                    .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                return try {
                    startActivityForResult(Intent.createChooser(pick, "Choose music"), REQ_FILES)
                    true
                } catch (e: Exception) {
                    fileCallback = null
                    false
                }
            }
        }

        bridge = DashBridge(this, web)
        web.addJavascriptInterface(bridge, "CarAutoNative")
        requestMissingPermissions()
        web.loadUrl("$APP_ORIGIN/web/car.html")
    }

    private fun requestMissingPermissions() {
        if (Build.VERSION.SDK_INT < 23) return
        val wanted = arrayOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.RECORD_AUDIO,
            Manifest.permission.CALL_PHONE,
        )
        val missing = wanted.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isNotEmpty()) requestPermissions(missing.toTypedArray(), REQ_PERMS)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        val locationGranted = permissions.indices.any {
            permissions[it] == Manifest.permission.ACCESS_FINE_LOCATION && grantResults[it] == PackageManager.PERMISSION_GRANTED
        }
        // Reload so the page's GPS watch starts with the new permission.
        if (requestCode == REQ_PERMS && locationGranted) web.reload()
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode != REQ_FILES) {
            @Suppress("DEPRECATION")
            super.onActivityResult(requestCode, resultCode, data)
            return
        }
        val callback = fileCallback ?: return
        fileCallback = null
        if (resultCode != RESULT_OK || data == null) {
            callback.onReceiveValue(null)
            return
        }
        val uris = mutableListOf<Uri>()
        data.clipData?.let { clip -> for (i in 0 until clip.itemCount) uris.add(clip.getItemAt(i).uri) }
        if (uris.isEmpty()) data.data?.let { uris.add(it) }
        callback.onReceiveValue(uris.toTypedArray())
    }

    /** Back closes the open app inside the dashboard; it never exits (car launcher). */
    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        web.evaluateJavascript("(window.carauto && window.carauto.back && window.carauto.back()) || false", null)
    }

    /** Steering-wheel and hardware media keys while the dashboard is in front. */
    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        val cmd = when (keyCode) {
            KeyEvent.KEYCODE_MEDIA_NEXT -> "next"
            KeyEvent.KEYCODE_MEDIA_PREVIOUS -> "prev"
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_HEADSETHOOK -> "toggle"
            KeyEvent.KEYCODE_MEDIA_PLAY -> "play"
            KeyEvent.KEYCODE_MEDIA_PAUSE, KeyEvent.KEYCODE_MEDIA_STOP -> "pause"
            KeyEvent.KEYCODE_VOICE_ASSIST, KeyEvent.KEYCODE_SEARCH -> "voice"
            else -> null
        }
        if (cmd == "voice") {
            web.evaluateJavascript("document.getElementById('btn-voice').click()", null)
            return true
        }
        if (cmd != null) {
            bridge.emit(JSONObject().put("type", "media").put("cmd", cmd))
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    @Suppress("DEPRECATION")
    private fun hideStatusBar() {
        // Keep the head unit's own navigation bar visible; hide only the status bar.
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideStatusBar()
    }

    override fun onResume() {
        super.onResume()
        // Note: onPause deliberately does NOT pause the WebView, so music and
        // voice guidance keep running while you use another app.
        web.onResume()
        web.resumeTimers()
    }

    override fun onDestroy() {
        bridge.release()
        web.destroy()
        super.onDestroy()
    }

    companion object {
        private const val REQ_PERMS = 1
        private const val REQ_FILES = 2
    }
}
