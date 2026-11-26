package app.carauto.dash

import android.content.Context
import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicInteger

/**
 * Offline map storage on the stereo.
 *
 * Every map file the dashboard loads (vector tiles, fonts, icons, the map
 * style) is saved on disk and served from there, so areas you have seen, or
 * downloaded in Settings → Offline maps, still show without internet.
 * Least-recently-used files are removed above [MAX_BYTES].
 */
object MapCache {

    private const val MAX_BYTES = 800L * 1024 * 1024
    private const val TILE_REFRESH_MS = 60L * 24 * 60 * 60 * 1000 // refresh tiles older than 60 days when online
    private val HOSTS = setOf("tiles.openfreemap.org", "tile.openstreetmap.org")

    private var dir: File? = null
    private val writes = AtomicInteger()

    fun init(ctx: Context) {
        if (dir == null) dir = File(ctx.filesDir, "mapcache").apply { mkdirs() }
    }

    fun handles(url: Uri) = url.host in HOSTS

    /**
     * Cache key. OpenFreeMap tile URLs carry a weekly data version
     * (/planet/20251119_001001_pt/14/1/2.pbf); it's dropped so saved tiles
     * keep working when the version changes.
     */
    fun key(url: Uri): String {
        val segs = url.pathSegments.toMutableList()
        if (segs.size == 5 && segs[0] == "planet") segs.removeAt(1)
        return url.host + "/" + segs.joinToString("/") + (url.query?.let { "?$it" } ?: "")
    }

    /** Small files that can change (the map style, tile index): network first. */
    private fun isMutable(url: Uri): Boolean {
        val p = url.path.orEmpty()
        return p.startsWith("/styles/") || p == "/planet" || p == "/planet/"
    }

    fun contentType(url: Uri): String {
        val p = url.path.orEmpty()
        return when {
            p.endsWith(".pbf") || p.endsWith(".mvt") -> "application/x-protobuf"
            p.endsWith(".png") -> "image/png"
            p.endsWith(".jpg") || p.endsWith(".jpeg") -> "image/jpeg"
            p.endsWith(".webp") -> "image/webp"
            else -> "application/json"
        }
    }

    private fun fileFor(key: String): File? {
        val d = dir ?: return null
        val hash = MessageDigest.getInstance("SHA-1").digest(key.toByteArray()).joinToString("") { "%02x".format(it) }
        return File(File(d, hash.substring(0, 2)).apply { mkdirs() }, hash)
    }

    private fun response(bytes: ByteArray, type: String, code: Int = 200, reason: String = "OK") =
        WebResourceResponse(
            type, null, code, reason,
            mapOf("Access-Control-Allow-Origin" to "*", "Cache-Control" to "max-age=3600"),
            ByteArrayInputStream(bytes),
        )

    fun respond(request: WebResourceRequest): WebResourceResponse? {
        if (request.method != "GET") return null
        val url = request.url
        val type = contentType(url)
        val file = fileFor(key(url)) ?: return null
        val cached = file.takeIf { it.exists() && it.length() > 0 }
        val mutable = isMutable(url)

        // Saved and still fresh: serve from disk without touching the network.
        if (cached != null && !mutable && System.currentTimeMillis() - cached.lastModified() < TILE_REFRESH_MS) {
            cached.setLastModified(System.currentTimeMillis())
            return response(cached.readBytes(), type)
        }

        return try {
            val conn = URL(url.toString()).openConnection() as HttpURLConnection
            conn.connectTimeout = if (cached != null) 3000 else 8000
            conn.readTimeout = 12000
            conn.setRequestProperty("User-Agent", "Car-Auto/1.0 (Android car stereo)")
            val code = conn.responseCode
            if (code == 200) {
                val bytes = conn.inputStream.use { it.readBytes() }
                save(file, bytes)
                response(bytes, type)
            } else {
                cached?.let { response(it.readBytes(), type) } ?: response(ByteArray(0), type, code, "Error")
            }
        } catch (e: Exception) {
            // Offline: serve the saved copy, or tell the map the file isn't available.
            cached?.let { response(it.readBytes(), type) } ?: response(ByteArray(0), type, 504, "Offline")
        }
    }

    private fun save(file: File, bytes: ByteArray) {
        runCatching {
            val tmp = File(file.parentFile, file.name + ".tmp")
            tmp.writeBytes(bytes)
            tmp.renameTo(file)
        }
        if (writes.incrementAndGet() % 100 == 0) Thread { trim() }.start()
    }

    private fun allFiles(): List<File> = dir?.walkTopDown()?.filter { it.isFile && !it.name.endsWith(".tmp") }?.toList().orEmpty()

    @Synchronized
    fun trim() {
        val files = allFiles()
        var total = files.sumOf { it.length() }
        if (total <= MAX_BYTES) return
        for (f in files.sortedBy { it.lastModified() }) {
            total -= f.length()
            f.delete()
            if (total <= MAX_BYTES * 9 / 10) break
        }
    }

    fun stats(): JSONObject {
        val files = allFiles()
        return JSONObject().put("files", files.size).put("bytes", files.sumOf { it.length() }).put("max", MAX_BYTES)
    }

    fun clear() {
        dir?.listFiles()?.forEach { it.deleteRecursively() }
    }
}
