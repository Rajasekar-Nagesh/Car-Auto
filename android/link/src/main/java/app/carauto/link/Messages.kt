package app.carauto.link

import android.Manifest
import android.app.Notification
import android.app.Person
import android.app.RemoteInput
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.provider.ContactsContract
import android.provider.Telephony
import android.net.Uri
import android.service.notification.StatusBarNotification
import android.telephony.SmsManager
import org.json.JSONArray
import org.json.JSONObject

/**
 * Messages on the car screen.
 *
 * - Chat notifications (WhatsApp, Messages, Telegram, Signal…) are forwarded
 *   to the car through notification access, and can be answered using the
 *   notification's own reply action, exactly like Android Auto does.
 * - Recent SMS can be listed and answered directly with the SMS permissions.
 */
object Messages {

    private val replyActions = LinkedHashMap<String, Notification.Action>()
    private val lastSeen = HashMap<String, String>()

    private fun granted(ctx: Context, perm: String) = ctx.checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED

    fun onNotification(ctx: Context, sbn: StatusBarNotification) {
        val n = sbn.notification ?: return
        if (sbn.packageName == ctx.packageName) return
        if (n.flags and Notification.FLAG_GROUP_SUMMARY != 0) return
        if (n.flags and Notification.FLAG_ONGOING_EVENT != 0) return
        val extras = n.extras ?: return

        val reply = n.actions?.firstOrNull { a -> a.remoteInputs?.any { it.allowFreeFormInput } == true }
        val isMessage = n.category == Notification.CATEGORY_MESSAGE || reply != null ||
            extras.containsKey(Notification.EXTRA_MESSAGES)
        if (!isMessage) return

        var from = extras.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE)?.toString()
            ?: extras.getCharSequence(Notification.EXTRA_TITLE)?.toString() ?: ""
        var text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString() ?: ""

        // MessagingStyle notifications: use the newest message and its sender.
        @Suppress("DEPRECATION")
        val msgs = extras.getParcelableArray(Notification.EXTRA_MESSAGES)
        val last = msgs?.lastOrNull() as? Bundle
        if (last != null) {
            last.getCharSequence("text")?.let { text = it.toString() }
            val sender = if (Build.VERSION.SDK_INT >= 28) {
                @Suppress("DEPRECATION")
                (last.getParcelable("sender_person") as? Person)?.name?.toString()
            } else {
                null
            } ?: last.getCharSequence("sender")?.toString()
            val isGroup = extras.getBoolean(Notification.EXTRA_IS_GROUP_CONVERSATION, false)
            if (!sender.isNullOrBlank()) from = if (isGroup && from.isNotBlank() && from != sender) "$sender ($from)" else sender
        }
        if (text.isBlank()) return

        val id = sbn.key
        val signature = "$from|$text"
        if (lastSeen[id] == signature) return // same notification re-posted
        lastSeen[id] = signature
        if (reply != null) replyActions[id] = reply
        while (replyActions.size > 60) replyActions.remove(replyActions.keys.first())
        if (lastSeen.size > 200) lastSeen.clear()

        PhoneHub.listener?.invoke(
            JSONObject()
                .put("type", "message")
                .put("id", id)
                .put("app", PhoneHub.appName(ctx, sbn.packageName))
                .put("pkg", sbn.packageName)
                .put("from", from)
                .put("text", text)
                .put("time", sbn.postTime)
                .put("canReply", reply != null),
        )
    }

    /** Reply through the app's own notification reply action (WhatsApp, Messages, Telegram…). */
    fun reply(ctx: Context, id: String, text: String): Boolean {
        val action = replyActions[id] ?: return false
        val inputs = action.remoteInputs ?: return false
        val intent = Intent()
        val results = Bundle()
        inputs.forEach { results.putCharSequence(it.resultKey, text) }
        RemoteInput.addResultsToIntent(inputs, intent, results)
        return runCatching { action.actionIntent.send(ctx, 0, intent) }.isSuccess
    }

    /** Most recent received SMS. */
    fun recentSms(ctx: Context): JSONArray {
        val arr = JSONArray()
        if (!granted(ctx, Manifest.permission.READ_SMS)) return arr
        val cols = arrayOf(Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE)
        runCatching {
            ctx.contentResolver.query(Telephony.Sms.Inbox.CONTENT_URI, cols, null, null, "${Telephony.Sms.DATE} DESC")?.use { c ->
                while (c.moveToNext() && arr.length() < 40) {
                    val address = c.getString(0) ?: continue
                    arr.put(
                        JSONObject()
                            .put("number", address)
                            .put("name", contactName(ctx, address) ?: "")
                            .put("text", c.getString(1) ?: "")
                            .put("date", c.getLong(2)),
                    )
                }
            }
        }
        return arr
    }

    fun sendSms(ctx: Context, number: String, text: String): Boolean {
        if (number.isBlank() || text.isBlank() || !granted(ctx, Manifest.permission.SEND_SMS)) return false
        return runCatching {
            val sms = if (Build.VERSION.SDK_INT >= 31) {
                ctx.getSystemService(SmsManager::class.java)
            } else {
                @Suppress("DEPRECATION")
                SmsManager.getDefault()
            }
            sms.sendMultipartTextMessage(number, null, sms.divideMessage(text), null, null)
        }.isSuccess
    }

    private fun contactName(ctx: Context, number: String): String? {
        if (!granted(ctx, Manifest.permission.READ_CONTACTS)) return null
        val uri = Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(number))
        return runCatching {
            ctx.contentResolver.query(uri, arrayOf(ContactsContract.PhoneLookup.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) c.getString(0) else null
            }
        }.getOrNull()
    }
}
