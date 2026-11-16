package app.carauto.link

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothClass
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import org.json.JSONObject
import java.io.OutputStream
import java.util.UUID
import kotlin.concurrent.thread

/**
 * Phone side of the Bluetooth link to Car-Auto Dash: connects over the
 * pairing the phone already has with the stereo.
 */
object BtLink {
    private val SERVICE_UUID: UUID = UUID.fromString("4c1f3a52-8f2d-4b8e-9c3a-ca7a0d1e0b55")

    private var socket: BluetoothSocket? = null
    private var out: OutputStream? = null

    private fun permitted(ctx: Context) = Build.VERSION.SDK_INT < 31 ||
        ctx.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED

    /**
     * Try to connect (blocking; call off the main thread). Events:
     * {type:"btLink", ev:"open"|"fail"|"msg"|"close", data?, device?}
     */
    @SuppressLint("MissingPermission")
    fun connect(ctx: Context, code: String, emit: (JSONObject) -> Unit) {
        close()
        fun fail(why: String) = emit(JSONObject().put("type", "btLink").put("ev", "fail").put("why", why))
        if (!permitted(ctx)) return fail("permission")
        val adapter = ctx.getSystemService(BluetoothManager::class.java)?.adapter ?: return fail("no-bluetooth")
        if (!adapter.isEnabled) return fail("off")
        val chosen = Prefs.btDevice(ctx)
        val bonded = runCatching { adapter.bondedDevices.toList() }.getOrDefault(emptyList())
        // The car chosen in settings first, then paired car/audio devices.
        val targets: List<BluetoothDevice> = (bonded.filter { it.address == chosen } +
            bonded.filter { it.address != chosen && it.bluetoothClass?.majorDeviceClass == BluetoothClass.Device.Major.AUDIO_VIDEO }).take(4)
        if (targets.isEmpty()) return fail("no-paired-car")
        runCatching { adapter.cancelDiscovery() }
        val hello = "CARAUTO ${code.uppercase().filter { it.isLetterOrDigit() }}\n".toByteArray()
        for (device in targets) {
            val s = runCatching { device.createInsecureRfcommSocketToServiceRecord(SERVICE_UUID) }.getOrNull() ?: continue
            try {
                s.connect()
                s.outputStream.write(hello)
                s.outputStream.flush()
                socket = s
                out = s.outputStream
                emit(JSONObject().put("type", "btLink").put("ev", "open").put("device", runCatching { device.name }.getOrNull() ?: device.address))
                thread(isDaemon = true) { readLoop(s, emit) }
                return
            } catch (e: Exception) {
                runCatching { s.close() }
            }
        }
        fail("car-not-reachable")
    }

    private fun readLoop(s: BluetoothSocket, emit: (JSONObject) -> Unit) {
        try {
            val reader = s.inputStream.bufferedReader(Charsets.UTF_8)
            while (true) {
                val line = reader.readLine() ?: break
                if (line.isNotBlank()) emit(JSONObject().put("type", "btLink").put("ev", "msg").put("data", line))
            }
        } catch (e: Exception) {
            // disconnected
        }
        if (socket === s) {
            socket = null
            out = null
            emit(JSONObject().put("type", "btLink").put("ev", "close"))
        }
        runCatching { s.close() }
    }

    fun send(text: String) {
        val o = out ?: return
        thread(isDaemon = true) {
            runCatching {
                synchronized(o) {
                    o.write((text.replace('\n', ' ') + "\n").toByteArray(Charsets.UTF_8))
                    o.flush()
                }
            }
        }
    }

    fun close() {
        val s = socket
        socket = null
        out = null
        runCatching { s?.close() }
    }
}
