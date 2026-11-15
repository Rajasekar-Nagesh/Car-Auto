package app.carauto.link

import android.bluetooth.BluetoothDevice
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build

/** Starts the link when the phone connects to the chosen car Bluetooth device, and stops it on disconnect. */
class BtReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val target = Prefs.btDevice(context) ?: return
        if (Prefs.code(context) == null) return
        val device: BluetoothDevice? = if (Build.VERSION.SDK_INT >= 33) {
            intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE, BluetoothDevice::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE)
        }
        if (device?.address != target) return
        when (intent.action) {
            BluetoothDevice.ACTION_ACL_CONNECTED -> runCatching { LinkService.start(context) }
            BluetoothDevice.ACTION_ACL_DISCONNECTED -> LinkService.stop(context)
        }
    }
}
