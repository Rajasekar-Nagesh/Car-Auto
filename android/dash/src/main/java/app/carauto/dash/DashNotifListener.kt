package app.carauto.dash

import android.service.notification.NotificationListenerService

/**
 * Notification access on the stereo lets Car-Auto Dash read the stereo's
 * Bluetooth music app (song title, artist, album art) and control it.
 */
class DashNotifListener : NotificationListenerService() {
    override fun onListenerConnected() {
        super.onListenerConnected()
        DashMedia.start(applicationContext)
    }
}
