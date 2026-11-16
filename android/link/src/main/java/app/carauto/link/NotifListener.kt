package app.carauto.link

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

/**
 * Notification access lets the app read other apps' media sessions (to show
 * and control Spotify, YouTube Music…) and the caller name on call notifications.
 */
class NotifListener : NotificationListenerService() {

    override fun onListenerConnected() {
        super.onListenerConnected()
        if (LinkService.running) PhoneHub.startMedia(applicationContext)
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        val n = sbn.notification ?: return
        if (n.category == Notification.CATEGORY_CALL) PhoneHub.onCallNotification(n)
    }
}
