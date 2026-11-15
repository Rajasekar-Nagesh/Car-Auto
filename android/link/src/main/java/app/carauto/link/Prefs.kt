package app.carauto.link

import android.content.Context

/** Small wrapper around the app's saved settings. */
object Prefs {
    private fun p(ctx: Context) = ctx.getSharedPreferences("link", Context.MODE_PRIVATE)

    fun code(ctx: Context): String? = p(ctx).getString("code", null)
    fun setCode(ctx: Context, code: String?) = p(ctx).edit().putString("code", code).apply()

    /** Optional self-hosted pairing server, as the base64 JSON carried in the QR link. */
    fun server(ctx: Context): String? = p(ctx).getString("srv", null)
    fun setServer(ctx: Context, srv: String?) = p(ctx).edit().putString("srv", srv).apply()

    /** Bluetooth address of the car stereo; the link starts when it connects. */
    fun btDevice(ctx: Context): String? = p(ctx).getString("bt", null)
    fun setBtDevice(ctx: Context, address: String?) = p(ctx).edit().putString("bt", address).apply()

    fun shareGps(ctx: Context): Boolean = p(ctx).getBoolean("gps", false)
    fun setShareGps(ctx: Context, on: Boolean) = p(ctx).edit().putBoolean("gps", on).apply()

    /** Accepts "abcd1234", "ABCD-1234" etc. Returns "ABCD-1234" or null. */
    fun normalizeCode(raw: String?): String? {
        val c = raw.orEmpty().uppercase().filter { it.isLetterOrDigit() }
        return if (c.length == 8) "${c.substring(0, 4)}-${c.substring(4)}" else null
    }
}
