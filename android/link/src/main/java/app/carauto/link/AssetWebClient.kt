package app.carauto.link

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import java.io.ByteArrayInputStream
import java.io.IOException

/** Virtual HTTPS origin that serves the web app bundled in the APK's assets. */
const val APP_HOST = "appassets.androidplatform.net"
const val APP_ORIGIN = "https://$APP_HOST"

/**
 * Serves bundled files for [APP_HOST] (a secure origin, so GPS and WebRTC work)
 * and hands every other link (Maps, Waze, tel:, intent:) to Android.
 */
class AssetWebClient(private val context: Context) : WebViewClient() {

    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
        val url = request.url
        if (url.host != APP_HOST) return null
        var path = (url.path ?: "/").trimStart('/')
        if (path.isEmpty() || path.endsWith("/")) path += "index.html"
        return try {
            val mime = mimeType(path)
            val text = mime.startsWith("text/") || mime.contains("json") || mime.contains("svg")
            WebResourceResponse(mime, if (text) "utf-8" else null, context.assets.open(path)).apply {
                responseHeaders = mapOf("Cache-Control" to "no-cache")
            }
        } catch (e: IOException) {
            WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))
        }
    }

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        if (request.url.host == APP_HOST) return false
        openExternal(context, request.url.toString())
        return true
    }

    companion object {
        fun mimeType(path: String): String = when (path.substringAfterLast('.', "").lowercase()) {
            "html" -> "text/html"
            "js", "mjs" -> "text/javascript"
            "css" -> "text/css"
            "json" -> "application/json"
            "webmanifest" -> "application/manifest+json"
            "svg" -> "image/svg+xml"
            "png" -> "image/png"
            "jpg", "jpeg" -> "image/jpeg"
            "ico" -> "image/x-icon"
            else -> "application/octet-stream"
        }
    }
}

/** Opens a URL (https:, tel:, geo:, intent:) in whichever app handles it. */
fun openExternal(context: Context, url: String): Boolean = try {
    val intent = if (url.startsWith("intent:")) {
        Intent.parseUri(url, Intent.URI_INTENT_SCHEME)
    } else {
        Intent(Intent.ACTION_VIEW, Uri.parse(url))
    }
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    context.startActivity(intent)
    true
} catch (e: Exception) {
    false
}
