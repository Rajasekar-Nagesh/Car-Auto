package app.carauto.dash

import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

/**
 * Notification access on the stereo lets Car-Auto Dash read the stereo's
 * Bluetooth music app (song title, artist, album art) and control it.
 */
class DashNotifListener : NotificationListenerService() {
    override fun onListenerConnected() {
        super.onListenerConnected()
        DashMedia.start(applicationContext)
    }

    // The stereo's Bluetooth phone app: incoming/active calls.
    override fun onNotificationPosted(sbn: StatusBarNotification) = StereoCalls.onPosted(applicationContext, sbn)

    override fun onNotificationRemoved(sbn: StatusBarNotification) = StereoCalls.onRemoved(sbn)
}
