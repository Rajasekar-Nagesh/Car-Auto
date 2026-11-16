package app.carauto.link

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaMetadataRetriever
import android.media.MediaPlayer
import android.os.Build
import android.provider.MediaStore
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import java.io.ByteArrayOutputStream

/**
 * Plays songs stored on the phone, chosen from the car screen. Sound goes to
 * the car speakers over Bluetooth like any other phone audio.
 */
object PhonePlayer {

    private data class Song(val id: Long, val title: String, val artist: String, val duration: Long)

    private var player: MediaPlayer? = null
    private var queue: List<Song> = emptyList()
    private var index = 0
    private var art: String? = null
    private var focus: AudioFocusRequest? = null
    private var appContext: Context? = null

    /** True while our player owns playback (it then takes the car's media controls). */
    var active = false
        private set

    private fun audioPermission() =
        if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_AUDIO else Manifest.permission.READ_EXTERNAL_STORAGE

    fun library(ctx: Context): JSONArray {
        val arr = JSONArray()
        if (ctx.checkSelfPermission(audioPermission()) != PackageManager.PERMISSION_GRANTED) return arr
        val cols = arrayOf(
            MediaStore.Audio.Media._ID,
            MediaStore.Audio.Media.TITLE,
            MediaStore.Audio.Media.ARTIST,
            MediaStore.Audio.Media.DURATION,
        )
        runCatching {
            ctx.contentResolver.query(
                MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, cols,
                "${MediaStore.Audio.Media.IS_MUSIC} != 0", null,
                "${MediaStore.Audio.Media.TITLE} COLLATE NOCASE ASC",
            )?.use { c ->
                while (c.moveToNext() && arr.length() < 5000) {
                    val artist = c.getString(2).orEmpty()
                    arr.put(
                        JSONObject()
                            .put("id", c.getLong(0))
                            .put("title", c.getString(1) ?: "Unknown")
                            .put("artist", if (artist == "<unknown>") "" else artist)
                            .put("duration", c.getLong(3)),
                    )
                }
            }
        }
        return arr
    }

    /** Play [ids] (as listed on the car) starting at [start]. */
    fun play(ctx: Context, idsJson: String, start: Int) {
        appContext = ctx.applicationContext
        val lib = library(ctx)
        val byId = HashMap<Long, Song>()
        for (i in 0 until lib.length()) {
            val o = lib.getJSONObject(i)
            byId[o.getLong("id")] = Song(o.getLong("id"), o.getString("title"), o.getString("artist"), o.getLong("duration"))
        }
        val ids = JSONArray(idsJson)
        queue = (0 until ids.length()).mapNotNull { byId[ids.getLong(it)] }
        if (queue.isEmpty()) return
        index = start.coerceIn(0, queue.size - 1)
        playCurrent()
    }

    private fun playCurrent() {
        val ctx = appContext ?: return
        val song = queue.getOrNull(index) ?: return
        player?.release()
        if (!requestFocus(ctx)) return
        val uri = ContentUris.withAppendedId(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, song.id)
        art = loadArt(ctx, song)
        val mp = MediaPlayer()
        mp.setAudioAttributes(
            AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build(),
        )
        try {
            mp.setDataSource(ctx, uri)
        } catch (e: Exception) {
            mp.release()
            return
        }
        mp.setOnPreparedListener {
            it.start()
            push()
        }
        mp.setOnCompletionListener { next() }
        mp.setOnErrorListener { _, _, _ ->
            next()
            true
        }
        mp.prepareAsync()
        player = mp
        active = true
        push()
    }

    private fun loadArt(ctx: Context, song: Song): String? = runCatching {
        val r = MediaMetadataRetriever()
        r.setDataSource(ctx, ContentUris.withAppendedId(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, song.id))
        val bytes = r.embeddedPicture
        r.release()
        bytes ?: return null
        val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return null
        val scale = 300f / maxOf(bmp.width, bmp.height).coerceAtLeast(1)
        val small = if (scale < 1f) Bitmap.createScaledBitmap(bmp, (bmp.width * scale).toInt().coerceAtLeast(1), (bmp.height * scale).toInt().coerceAtLeast(1), true) else bmp
        val out = ByteArrayOutputStream()
        small.compress(Bitmap.CompressFormat.JPEG, 80, out)
        "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }.getOrNull()

    private fun requestFocus(ctx: Context): Boolean {
        val am = ctx.getSystemService(AudioManager::class.java) ?: return true
        val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
            .setOnAudioFocusChangeListener { change ->
                when (change) {
                    AudioManager.AUDIOFOCUS_LOSS -> stop() // another app (Spotify, a call) took over
                    AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> { player?.pause(); push() }
                    AudioManager.AUDIOFOCUS_GAIN -> { player?.start(); push() }
                }
            }
            .build()
        focus = req
        return am.requestAudioFocus(req) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    }

    /** Media command from the car; returns false when our player isn't the one playing. */
    fun cmd(cmd: String): Boolean {
        val mp = player ?: return false
        if (!active) return false
        when (cmd) {
            "play" -> mp.start()
            "pause" -> mp.pause()
            "toggle" -> if (mp.isPlaying) mp.pause() else mp.start()
            "next" -> { next(); return true }
            "prev" -> {
                if (mp.currentPosition > 4000) mp.seekTo(0) else { index = (index - 1 + queue.size) % queue.size; playCurrent(); return true }
            }
        }
        push()
        return true
    }

    private fun next() {
        if (queue.isEmpty()) return
        index = (index + 1) % queue.size
        playCurrent()
    }

    fun stop() {
        player?.release()
        player = null
        active = false
        val ctx = appContext
        focus?.let { f -> ctx?.getSystemService(AudioManager::class.java)?.abandonAudioFocusRequest(f) }
        PhoneHub.refreshMedia()
    }

    fun json(): JSONObject? {
        val song = queue.getOrNull(index) ?: return null
        if (!active) return null
        val mp = player
        val playing = runCatching { mp?.isPlaying == true }.getOrDefault(false)
        val position = runCatching { mp?.currentPosition?.toLong() ?: 0L }.getOrDefault(0L)
        return JSONObject()
            .put("title", song.title)
            .put("artist", song.artist)
            .put("app", "Phone music")
            .put("playing", playing)
            .put("duration", song.duration)
            .put("position", position)
            .put("positionAt", System.currentTimeMillis())
            .put("speed", 1.0)
            .put("artKey", "local:${song.id}")
            .put("art", art ?: JSONObject.NULL)
    }

    private fun push() {
        PhoneHub.listener?.invoke(JSONObject().put("type", "media").put("media", json() ?: JSONObject.NULL))
    }
}
