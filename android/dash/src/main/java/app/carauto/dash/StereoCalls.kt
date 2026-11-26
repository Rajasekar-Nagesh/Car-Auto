package app.carauto.dash

import android.Manifest
import android.app.Notification
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.CallLog
import android.provider.ContactsContract
import android.service.notification.StatusBarNotification
import org.json.JSONArray
import org.json.JSONObject

/**
 * The stereo's own Bluetooth phone app.
 *
 * - Its call pop-up can't be blocked by another app, so when a call starts
 *   Car-Auto brings itself back on top and shows its own call screen.
 * - If that app posts a call notification (needs notification access on the
 *   stereo), the caller's name and the Answer/Decline buttons are used too.
 * - Contacts and call history the stereo synced from the phone over Bluetooth
 *   are offered when Car-Auto Link isn't connected.
 */
object StereoCalls {

    private val main = Handler(Looper.getMainLooper())
    private var callKey: String? = null
    private var actions: Array<Notification.Action>? = null
    private var appContext: Context? = null

    private val ANSWER = Regex("answer|accept|接听", RegexOption.IGNORE_CASE)
    private val DECLINE = Regex("decline|reject|hang|end|挂断|拒接", RegexOption.IGNORE_CASE)

    fun onPosted(ctx: Context, sbn: StatusBarNotification) {
        val n = sbn.notification ?: return
        if (n.category != Notification.CATEGORY_CALL || sbn.packageName == ctx.packageName) return
        appContext = ctx.applicationContext
        callKey = sbn.key
        actions = n.actions
        val extras = n.extras
        val name = extras?.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty()
        val detail = extras?.getCharSequence(Notification.EXTRA_TEXT)?.toString().orEmpty()
        val ringing = n.actions?.any { ANSWER.containsMatchIn(it.title ?: "") } == true
        DashMedia.emit?.invoke(
            JSONObject()
                .put("type", "stereoCall")
                .put("state", if (ringing) "ringing" else "active")
                .put("name", name)
                .put("number", detail.filter { it.isDigit() || it == '+' }.takeIf { it.length >= 3 } ?: "")
                .put("since", System.currentTimeMillis()),
        )
        bringToFront(ctx)
    }

    fun onRemoved(sbn: StatusBarNotification) {
        if (sbn.key != callKey) return
        callKey = null
        actions = null
        DashMedia.emit?.invoke(JSONObject().put("type", "stereoCall").put("state", "idle"))
    }

    /** Answer / decline / end through the stereo phone app's notification buttons. */
    fun action(what: String): Boolean {
        val re = if (what == "answer") ANSWER else DECLINE
        val a = actions?.firstOrNull { re.containsMatchIn(it.title ?: "") } ?: return false
        return runCatching { a.actionIntent.send() }.isSuccess
    }

    /** Put Car-Auto back in front of the stereo's own call screen. */
    fun bringToFront(ctx: Context) {
        val app = ctx.applicationContext
        val open = Intent(app, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        // The stereo app opens its screen first; come back on top right after it.
        main.postDelayed({ runCatching { app.startActivity(open) } }, 700)
        main.postDelayed({ runCatching { app.startActivity(open) } }, 2000)
    }

    private fun granted(ctx: Context, perm: String) =
        Build.VERSION.SDK_INT < 23 || ctx.checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED

    /** Contacts stored on the stereo (many stereos copy the phone book over Bluetooth). */
    fun localContacts(ctx: Context): JSONArray {
        val arr = JSONArray()
        if (!granted(ctx, Manifest.permission.READ_CONTACTS)) return arr
        val seen = HashSet<String>()
        runCatching {
            ctx.contentResolver.query(
                ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                arrayOf(
                    ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
                    ContactsContract.CommonDataKinds.Phone.NUMBER,
                    ContactsContract.CommonDataKinds.Phone.STARRED,
                ),
                null, null, "${ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} COLLATE NOCASE ASC",
            )?.use { c ->
                while (c.moveToNext() && arr.length() < 3000) {
                    val name = c.getString(0) ?: continue
                    val num = c.getString(1) ?: continue
                    if (!seen.add(name + "|" + num.filter { it.isDigit() }.takeLast(9))) continue
                    arr.put(JSONObject().put("name", name).put("number", num).put("starred", c.getInt(2) == 1))
                }
            }
        }
        return arr
    }

    /** Call history stored on the stereo. */
    fun localRecents(ctx: Context): JSONArray {
        val arr = JSONArray()
        if (!granted(ctx, Manifest.permission.READ_CALL_LOG)) return arr
        runCatching {
            ctx.contentResolver.query(
                CallLog.Calls.CONTENT_URI,
                arrayOf(CallLog.Calls.NUMBER, CallLog.Calls.CACHED_NAME, CallLog.Calls.TYPE, CallLog.Calls.DATE),
                null, null, "${CallLog.Calls.DATE} DESC",
            )?.use { c ->
                while (c.moveToNext() && arr.length() < 60) {
                    val type = when (c.getInt(2)) {
                        CallLog.Calls.OUTGOING_TYPE -> "out"
                        CallLog.Calls.MISSED_TYPE -> "missed"
                        else -> "in"
                    }
                    arr.put(
                        JSONObject().put("number", c.getString(0) ?: "").put("name", c.getString(1) ?: "")
                            .put("type", type).put("date", c.getLong(3)),
                    )
                }
            }
        }
        return arr
    }
}
