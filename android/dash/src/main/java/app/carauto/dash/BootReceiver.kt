package app.carauto.dash

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Opens the dashboard when the stereo starts. On Android 10+ this needs the
 * "display over other apps" permission; setting Car-Auto as the home screen
 * is the most reliable alternative.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val prefs = context.getSharedPreferences(DashBridge.PREFS, Context.MODE_PRIVATE)
        if (!prefs.getBoolean(DashBridge.KEY_AUTOSTART, true)) return
        val open = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        runCatching { context.startActivity(open) }
    }
}
