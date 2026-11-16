package app.carauto.dash

import android.content.Context
import android.net.wifi.WifiManager
import android.util.Base64
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.EOFException
import java.io.InputStream
import java.io.OutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

/**
 * Direct phone ↔ car link over the local network (e.g. the phone's hotspot),
 * with no internet or pairing server involved.
 *
 * - Discovery: the phone broadcasts "CARAUTO?<code>" on UDP [DISCOVERY_PORT];
 *   we answer "CARAUTO!<port>" when the pairing code matches.
 * - Link: a minimal WebSocket server on [BASE_PORT]; the path must be the
 *   pairing code. Messages are the same JSON the internet link uses.
 */
class LanServer(private val context: Context, private val onEvent: (JSONObject) -> Unit) {

    private class Client(val socket: Socket, val out: OutputStream)

    @Volatile private var code = ""
    @Volatile private var port = 0
    private var server: ServerSocket? = null
    private var udp: DatagramSocket? = null
    private val clients = ConcurrentHashMap<Int, Client>()
    private val ids = AtomicInteger()
    private var multicastLock: WifiManager.MulticastLock? = null

    fun start(pairCode: String) {
        code = normalize(pairCode)
        if (server != null) return
        multicastLock = runCatching {
            (context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager)
                .createMulticastLock("carauto-discovery").apply { setReferenceCounted(false); acquire() }
        }.getOrNull()
        thread(name = "carauto-lan", isDaemon = true) { serve() }
        thread(name = "carauto-discovery", isDaemon = true) { discovery() }
    }

    fun stop() {
        runCatching { server?.close() }
        runCatching { udp?.close() }
        clients.values.forEach { runCatching { it.socket.close() } }
        clients.clear()
        server = null
        udp = null
        runCatching { multicastLock?.release() }
    }

    fun send(id: Int, text: String) {
        val c = clients[id] ?: return
        thread(isDaemon = true) { runCatching { writeFrame(c.out, 0x1, text.toByteArray()) }.onFailure { drop(id) } }
    }

    fun close(id: Int) = drop(id)

    // ---- WebSocket server ----

    private fun serve() {
        val ss = (0 until 10).firstNotNullOfOrNull { i ->
            runCatching { ServerSocket().apply { reuseAddress = true; bind(InetSocketAddress(BASE_PORT + i)) } }.getOrNull()
        } ?: return
        server = ss
        port = ss.localPort
        while (!ss.isClosed) {
            val s = runCatching { ss.accept() }.getOrNull() ?: break
            thread(isDaemon = true) { handle(s) }
        }
    }

    private fun handle(s: Socket) {
        try {
            s.tcpNoDelay = true
            s.soTimeout = 0
            val input = BufferedInputStream(s.getInputStream())
            val out = s.getOutputStream()
            val head = readHead(input) ?: return s.close()
            val lines = head.split("\r\n")
            val path = lines.firstOrNull()?.split(" ")?.getOrNull(1).orEmpty().trim('/')
            val headers = lines.drop(1).mapNotNull { l ->
                val i = l.indexOf(':')
                if (i > 0) l.substring(0, i).trim().lowercase() to l.substring(i + 1).trim() else null
            }.toMap()
            val key = headers["sec-websocket-key"]
            if (code.isEmpty() || normalize(java.net.URLDecoder.decode(path, "UTF-8")) != code || key == null) {
                out.write("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n".toByteArray())
                s.close()
                return
            }
            val accept = Base64.encodeToString(
                MessageDigest.getInstance("SHA-1").digest((key + WS_GUID).toByteArray()), Base64.NO_WRAP,
            )
            out.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: $accept\r\n\r\n".toByteArray())
            out.flush()

            val id = ids.incrementAndGet()
            clients[id] = Client(s, out)
            onEvent(JSONObject().put("type", "lan").put("ev", "open").put("id", id))

            val message = java.io.ByteArrayOutputStream()
            var messageOpcode = 0
            while (true) {
                val b0 = input.read()
                if (b0 < 0) break
                val fin = b0 and 0x80 != 0
                val opcode = b0 and 0x0f
                val b1 = input.read()
                if (b1 < 0) break
                val masked = b1 and 0x80 != 0
                var len = (b1 and 0x7f).toLong()
                if (len == 126L) len = ((readByte(input) shl 8) or readByte(input)).toLong()
                else if (len == 127L) { len = 0; repeat(8) { len = (len shl 8) or readByte(input).toLong() } }
                if (len > MAX_MESSAGE) break
                val mask = if (masked) ByteArray(4).also { readFully(input, it) } else null
                val payload = ByteArray(len.toInt()).also { readFully(input, it) }
                if (mask != null) for (i in payload.indices) payload[i] = (payload[i].toInt() xor mask[i % 4].toInt()).toByte()
                when (opcode) {
                    0x8 -> break // close
                    0x9 -> runCatching { writeFrame(out, 0xA, payload) } // ping -> pong
                    0xA -> {}
                    0x0, 0x1, 0x2 -> {
                        if (opcode != 0x0) { message.reset(); messageOpcode = opcode }
                        message.write(payload)
                        if (message.size() > MAX_MESSAGE) break
                        if (fin && messageOpcode == 0x1) {
                            onEvent(JSONObject().put("type", "lan").put("ev", "msg").put("id", id).put("data", message.toString("UTF-8")))
                        }
                    }
                }
            }
            drop(id)
        } catch (e: Exception) {
            runCatching { s.close() }
        }
    }

    private fun drop(id: Int) {
        val c = clients.remove(id) ?: return
        runCatching { c.socket.close() }
        onEvent(JSONObject().put("type", "lan").put("ev", "close").put("id", id))
    }

    // ---- Discovery ----

    private fun discovery() {
        val sock = runCatching {
            DatagramSocket(null).apply {
                reuseAddress = true
                broadcast = true
                bind(InetSocketAddress(DISCOVERY_PORT))
            }
        }.getOrNull() ?: return
        udp = sock
        val buf = ByteArray(512)
        while (!sock.isClosed) {
            val p = DatagramPacket(buf, buf.size)
            if (runCatching { sock.receive(p) }.isFailure) break
            val text = String(p.data, 0, p.length, Charsets.UTF_8).trim()
            if (text.startsWith("CARAUTO?") && port > 0 && code.isNotEmpty() && normalize(text.substring(8)) == code) {
                val reply = "CARAUTO!$port".toByteArray()
                runCatching { sock.send(DatagramPacket(reply, reply.size, p.address, p.port)) }
            }
        }
    }

    companion object {
        const val BASE_PORT = 47800
        const val DISCOVERY_PORT = 47799
        private const val MAX_MESSAGE = 4L * 1024 * 1024
        private const val WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

        fun normalize(code: String) = code.uppercase().filter { it.isLetterOrDigit() }

        private fun readHead(input: InputStream): String? {
            val sb = StringBuilder()
            while (sb.length < 8192) {
                val b = input.read()
                if (b < 0) return null
                sb.append(b.toChar())
                if (sb.endsWith("\r\n\r\n")) return sb.toString()
            }
            return null
        }

        private fun readByte(input: InputStream): Int {
            val b = input.read()
            if (b < 0) throw EOFException()
            return b
        }

        private fun readFully(input: InputStream, buf: ByteArray) {
            var off = 0
            while (off < buf.size) {
                val n = input.read(buf, off, buf.size - off)
                if (n < 0) throw EOFException()
                off += n
            }
        }

        fun writeFrame(out: OutputStream, opcode: Int, payload: ByteArray) {
            synchronized(out) {
                out.write(0x80 or opcode)
                when {
                    payload.size < 126 -> out.write(payload.size)
                    payload.size < 65536 -> { out.write(126); out.write(payload.size shr 8); out.write(payload.size and 0xff) }
                    else -> { out.write(127); for (i in 7 downTo 0) out.write(((payload.size.toLong() shr (8 * i)) and 0xff).toInt()) }
                }
                out.write(payload)
                out.flush()
            }
        }
    }
}
