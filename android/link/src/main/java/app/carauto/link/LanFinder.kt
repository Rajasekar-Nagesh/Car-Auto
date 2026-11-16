package app.carauto.link

import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.SocketTimeoutException

/**
 * Finds the car stereo on the local network (normally this phone's hotspot)
 * by broadcasting the pairing code; Car-Auto Dash answers with its port.
 */
object LanFinder {
    private const val DISCOVERY_PORT = 47799

    /** Returns "ip:port" of the car, or null if it didn't answer in time. */
    fun find(code: String, timeoutMs: Long = 2500): String? {
        val wanted = code.uppercase().filter { it.isLetterOrDigit() }
        if (wanted.isEmpty()) return null
        val msg = "CARAUTO?$wanted".toByteArray()
        return runCatching {
            DatagramSocket().use { sock ->
                sock.broadcast = true
                sock.soTimeout = 350
                val targets = broadcastTargets()
                val deadline = System.currentTimeMillis() + timeoutMs
                while (System.currentTimeMillis() < deadline) {
                    targets.forEach { addr -> runCatching { sock.send(DatagramPacket(msg, msg.size, addr, DISCOVERY_PORT)) } }
                    val buf = ByteArray(128)
                    val p = DatagramPacket(buf, buf.size)
                    try {
                        sock.receive(p)
                        val text = String(p.data, 0, p.length, Charsets.UTF_8).trim()
                        if (text.startsWith("CARAUTO!")) {
                            val port = text.substring(8).toIntOrNull() ?: continue
                            return@use "${p.address.hostAddress}:$port"
                        }
                    } catch (e: SocketTimeoutException) {
                        // send again
                    }
                }
                null
            }
        }.getOrNull()
    }

    /** Broadcast address of every active network (hotspot, Wi-Fi) plus the global one. */
    private fun broadcastTargets(): List<InetAddress> {
        val list = mutableListOf<InetAddress>()
        runCatching {
            NetworkInterface.getNetworkInterfaces()?.toList().orEmpty()
                .filter { it.isUp && !it.isLoopback }
                .forEach { nif -> nif.interfaceAddresses.mapNotNullTo(list) { it.broadcast } }
        }
        runCatching { list.add(InetAddress.getByName("255.255.255.255")) }
        return list.distinct()
    }
}
