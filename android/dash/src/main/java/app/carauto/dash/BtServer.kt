package app.carauto.dash

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothServerSocket
import android.bluetooth.BluetoothSocket
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import org.json.JSONObject
import java.io.OutputStream
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

/**
 * Phone ↔ car link over Bluetooth (RFCOMM), using the pairing the phone
 * already has with the stereo for calls. Works without hotspot or internet.
 *
 * Many Android stereos run Bluetooth on a separate chip that apps can't use;
 * there [available] is false and this link is simply not offered.
 *
 * Protocol: the phone first sends "CARAUTO <code>\n", then newline-separated
 * JSON messages both ways (the same messages the other links carry).
 */
class BtServer(private val context: Context, private val onEvent: (JSONObject) -> Unit) {

    private class Client(val socket: BluetoothSocket, val out: OutputStream)

    @Volatile private var code = ""
    @Volatile private var running = false
    private var serverSocket: BluetoothServerSocket? = null
    private val clients = ConcurrentHashMap<Int, Client>()
    private val ids = AtomicInteger(ID_BASE)

    private fun permitted() = Build.VERSION.SDK_INT < 31 ||
        context.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED

    @Suppress("DEPRECATION")
    private fun adapter(): BluetoothAdapter? = runCatching { BluetoothAdapter.getDefaultAdapter() }.getOrNull()

    /** True when this stereo lets apps use Bluetooth (and it's switched on). */
    @SuppressLint("MissingPermission")
    fun available(): Boolean = permitted() && adapter()?.isEnabled == true

    fun start(pairCode: String) {
        code = normalize(pairCode)
        if (running) return
        running = true
        thread(name = "carauto-bt", isDaemon = true) { serve() }
    }

    fun stop() {
        running = false
        runCatching { serverSocket?.close() }
        clients.values.forEach { runCatching { it.socket.close() } }
        clients.clear()
    }

    fun owns(id: Int) = id >= ID_BASE

    fun send(id: Int, text: String) {
        val c = clients[id] ?: return
        thread(isDaemon = true) {
            runCatching {
                synchronized(c.out) {
                    c.out.write((text.replace('\n', ' ') + "\n").toByteArray(Charsets.UTF_8))
                    c.out.flush()
                }
            }.onFailure { drop(id) }
        }
    }

    fun close(id: Int) = drop(id)

    @SuppressLint("MissingPermission")
    private fun serve() {
        while (running) {
            if (!available()) {
                Thread.sleep(15000) // Bluetooth off, not permitted, or not usable by apps here
                continue
            }
            val ss = runCatching { adapter()!!.listenUsingInsecureRfcommWithServiceRecord("Car-Auto", SERVICE_UUID) }.getOrNull()
            if (ss == null) {
                Thread.sleep(15000)
                continue
            }
            serverSocket = ss
            while (running) {
                val s = runCatching { ss.accept() }.getOrNull() ?: break
                thread(isDaemon = true) { handle(s) }
            }
            runCatching { ss.close() }
            if (running) Thread.sleep(2000)
        }
    }

    private fun handle(s: BluetoothSocket) {
        val reader = s.inputStream.bufferedReader(Charsets.UTF_8)
        val hello = runCatching { reader.readLine() }.getOrNull()
        if (hello == null || !hello.startsWith("CARAUTO ") || normalize(hello.substring(8)) != code || code.isEmpty()) {
            runCatching { s.close() }
            return
        }
        val id = ids.incrementAndGet()
        clients[id] = Client(s, s.outputStream)
        onEvent(JSONObject().put("type", "lan").put("ev", "open").put("id", id).put("via", "bluetooth"))
        try {
            while (true) {
                val line = reader.readLine() ?: break
                if (line.isNotBlank()) onEvent(JSONObject().put("type", "lan").put("ev", "msg").put("id", id).put("data", line))
            }
        } catch (e: Exception) {
            // disconnected
        }
        drop(id)
    }

    private fun drop(id: Int) {
        val c = clients.remove(id) ?: return
        runCatching { c.socket.close() }
        onEvent(JSONObject().put("type", "lan").put("ev", "close").put("id", id))
    }

    companion object {
        /** Fixed service id shared with Car-Auto Link. */
        val SERVICE_UUID: UUID = UUID.fromString("4c1f3a52-8f2d-4b8e-9c3a-ca7a0d1e0b55")
        private const val ID_BASE = 100000
        fun normalize(code: String) = code.uppercase().filter { it.isLetterOrDigit() }
    }
}
