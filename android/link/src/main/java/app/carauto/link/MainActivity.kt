package app.carauto.link

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.bluetooth.BluetoothManager
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast

/**
 * Setup screen: pair with the car, grant permissions, choose the car's
 * Bluetooth device for automatic start. The link itself runs in [LinkService].
 */
class MainActivity : Activity() {

    private lateinit var status: TextView
    private lateinit var codeInput: EditText
    /** One line in the permissions checklist. */
    private class Access(
        val label: String,
        val why: String,
        val granted: () -> Boolean,
        val request: () -> Unit,
    ) {
        lateinit var title: TextView
        lateinit var button: Button
    }

    private val accessList = mutableListOf<Access>()
    private lateinit var accessSummary: TextView
    private lateinit var accessToggle: TextView
    private lateinit var accessBox: LinearLayout
    private lateinit var restrictedHelp: TextView
    private var accessExpanded = false
    private lateinit var btSpinner: Spinner
    private lateinit var btHint: TextView
    private var btAddresses: List<String?> = emptyList()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        buildUi()
        handleIntent(intent)
        // First launch: ask for the basic permissions straight away.
        val prefs = getSharedPreferences("link", MODE_PRIVATE)
        if (!prefs.getBoolean("askedPermissions", false)) {
            prefs.edit().putBoolean("askedPermissions", true).apply()
            requestRuntime(*basicPermissions)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        LinkService.statusListener = { text -> runOnUiThread { showStatus(text) } }
        showStatus(if (LinkService.running) LinkService.status else "Not connected")
        refreshAccess()
        loadBluetoothDevices()
    }

    /** Green when connected, red for problems, grey otherwise. */
    private fun showStatus(text: String) {
        status.text = text
        val lower = text.lowercase()
        status.setTextColor(
            when {
                lower.startsWith("connected") -> Color.rgb(0x6d, 0xd5, 0x8c)
                listOf("error", "not found", "couldn't", "no connection", "failed").any { lower.contains(it) } -> Color.rgb(0xf2, 0x8b, 0x82)
                else -> Color.rgb(0x9a, 0xa0, 0xa6)
            },
        )
    }

    override fun onPause() {
        LinkService.statusListener = null
        super.onPause()
    }

    /** carauto://pair?code=ABCD-1234[&srv=...] from the car's QR code or the web remote's "Open in app" button. */
    private fun handleIntent(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme != "carauto") return
        val pairing = Prefs.parsePairing(data.toString()) ?: return
        Prefs.setServer(this, pairing.server)
        connect(pairing.code)
    }

    private fun scanQr() {
        QrScanner.scan(
            this,
            onResult = { raw ->
                val pairing = Prefs.parsePairing(raw)
                if (pairing == null) {
                    Toast.makeText(this, "That isn't a Car-Auto pairing code", Toast.LENGTH_LONG).show()
                } else {
                    Prefs.setServer(this, pairing.server)
                    connect(pairing.code)
                }
            },
            onError = {
                Toast.makeText(this, "Couldn't open the scanner. Type the code instead.", Toast.LENGTH_LONG).show()
            },
        )
    }

    private fun connect(code: String) {
        codeInput.setText(code)
        Prefs.setCode(this, code)
        LinkService.restart(this)
        Toast.makeText(this, "Connecting to your car…", Toast.LENGTH_SHORT).show()
        if (!hasAllPhonePermissions()) requestPhonePermissions()
    }

    // ---- UI (built in code: no layout resources needed) ----

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun text(s: String, size: Float = 16f, bold: Boolean = false, color: Int = Color.WHITE) = TextView(this).apply {
        text = s
        textSize = size
        setTextColor(color)
        if (bold) setTypeface(typeface, Typeface.BOLD)
        setPadding(0, dp(6), 0, dp(6))
    }

    private fun button(label: String, onClick: () -> Unit) = Button(this).apply {
        text = label
        isAllCaps = false
        setOnClickListener { onClick() }
    }

    private fun section(title: String, root: LinearLayout) {
        root.addView(text(title, 18f, true).apply { setPadding(0, dp(24), 0, dp(4)) })
    }

    @SuppressLint("SetTextI18n")
    private fun buildUi() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(20), dp(20), dp(32))
        }
        val muted = Color.rgb(0x9a, 0xa0, 0xa6)

        root.addView(text("Car-Auto Link", 26f, true))
        root.addView(text("Version $appVersion", 13f, color = muted))
        root.addView(text("Shows this phone's music, calls and contacts on your Car-Auto car screen — like Android Auto.", 15f, color = muted))
        status = text("Not connected", 16f, true, Color.rgb(0x6d, 0xd5, 0x8c))
        root.addView(status)

        section("1. Pair with your car", root)
        root.addView(text("On the car screen open Settings → Pair your phone, then scan the QR code or type the code shown there.", 14f, color = muted))
        root.addView(button("📷  Scan QR code") { scanQr() }, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        codeInput = EditText(this).apply {
            hint = "ABCD-1234"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS
            setText(Prefs.code(this@MainActivity) ?: "")
            textSize = 22f
            gravity = Gravity.CENTER
        }
        root.addView(codeInput, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        row.addView(button("Connect") {
            val code = Prefs.normalizeCode(codeInput.text.toString())
            if (code == null) {
                Toast.makeText(this, "Codes have 8 letters/numbers, like ABCD-1234", Toast.LENGTH_LONG).show()
            } else {
                connect(code)
            }
        }, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
        row.addView(button("Disconnect") {
            LinkService.stop(this)
            status.text = "Not connected"
        }, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
        root.addView(row)

        section("2. Allow access", root)
        // Collapsed to one line once everything is allowed.
        accessSummary = text("", 15f, true).apply { setPadding(0, dp(2), 0, dp(2)) }
        root.addView(accessSummary)
        accessToggle = text("Show details", 14f, color = Color.rgb(0x8a, 0xb4, 0xf8)).apply {
            setOnClickListener {
                accessExpanded = !accessExpanded
                refreshAccess()
            }
        }
        root.addView(accessToggle)
        accessBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        root.addView(accessBox, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        buildAccessList()
        accessList.forEach { a ->
            val line = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(0, dp(4), 0, dp(4))
            }
            val texts = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
            a.title = text(a.label, 16f, true).apply { setPadding(0, 0, 0, 0) }
            texts.addView(a.title)
            texts.addView(text(a.why, 13f, color = muted).apply { setPadding(0, 0, 0, 0) })
            line.addView(texts, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
            a.button = button("Allow") { a.request() }
            line.addView(a.button, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT))
            accessBox.addView(line, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        }
        restrictedHelp = text(
            "Greyed out or \"restricted setting\"? Open app settings → ⋮ (top right) → Allow restricted settings, then try again.",
            13f, color = muted,
        ).apply {
            setPadding(0, dp(8), 0, 0)
            setOnClickListener { openAppSettings() }
        }
        accessBox.addView(restrictedHelp)

        section("3. Options", root)
        val gps = Switch(this).apply {
            text = "Share this phone's GPS with the car"
            setTextColor(Color.WHITE)
            isChecked = Prefs.shareGps(this@MainActivity)
            setPadding(0, dp(8), 0, dp(8))
            setOnCheckedChangeListener { _, on ->
                Prefs.setShareGps(this@MainActivity, on)
                if (on && checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION), REQ_LOCATION)
                }
                if (LinkService.running) LinkService.restart(this@MainActivity)
            }
        }
        root.addView(gps)

        root.addView(text("Start automatically when connected to this Bluetooth device:", 15f).apply { setPadding(0, dp(12), 0, 0) })
        btSpinner = Spinner(this)
        root.addView(btSpinner, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        btHint = text("", 13f, color = muted)
        root.addView(btHint)

        root.addView(text("Music and call audio still play through the car speakers over Bluetooth, as usual. This app adds the car-screen controls.", 13f, color = muted).apply { setPadding(0, dp(24), 0, 0) })

        setContentView(ScrollView(this).apply {
            setBackgroundColor(Color.rgb(0x12, 0x13, 0x16))
            addView(root)
        })
    }

    // ---- Permissions ----

    private val appVersion: String
        get() = runCatching { packageManager.getPackageInfo(packageName, 0).versionName }.getOrNull() ?: "?"

    private fun has(vararg perms: String) = perms.all { checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }

    private val phonePerms = arrayOf(
        Manifest.permission.READ_PHONE_STATE,
        Manifest.permission.CALL_PHONE,
        Manifest.permission.ANSWER_PHONE_CALLS,
    )
    private val notificationPerms = if (Build.VERSION.SDK_INT >= 33) arrayOf(Manifest.permission.POST_NOTIFICATIONS) else emptyArray()
    private val nearbyPerms = if (Build.VERSION.SDK_INT >= 31) arrayOf(Manifest.permission.BLUETOOTH_CONNECT) else emptyArray()
    private val smsPerms = arrayOf(Manifest.permission.READ_SMS, Manifest.permission.RECEIVE_SMS, Manifest.permission.SEND_SMS)
    private val musicPerms = arrayOf(if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_AUDIO else Manifest.permission.READ_EXTERNAL_STORAGE)

    /** Everything except location, which is only needed for GPS sharing. */
    private val basicPermissions: Array<String>
        get() = phonePerms + arrayOf(Manifest.permission.READ_CONTACTS, Manifest.permission.READ_CALL_LOG) + smsPerms + musicPerms + notificationPerms + nearbyPerms

    private fun hasAllPhonePermissions() = has(*basicPermissions)

    private fun requestPhonePermissions() = requestRuntime(*basicPermissions)

    /** Ask for runtime permissions; if Android won't show the dialog any more, open app settings instead. */
    private fun requestRuntime(vararg perms: String) {
        val missing = perms.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isEmpty()) return
        val prefs = getSharedPreferences("link", MODE_PRIVATE)
        val askedBefore = missing.all { prefs.getBoolean("asked_$it", false) }
        val blocked = askedBefore && missing.none { shouldShowRequestPermissionRationale(it) }
        if (blocked) {
            Toast.makeText(this, "Allow it under Permissions in app settings", Toast.LENGTH_LONG).show()
            openAppSettings()
            return
        }
        prefs.edit().apply { missing.forEach { putBoolean("asked_$it", true) } }.apply()
        requestPermissions(missing.toTypedArray(), REQ_PHONE)
    }

    private val callPerms: Array<String>
        get() = phonePerms + arrayOf(Manifest.permission.READ_CONTACTS, Manifest.permission.READ_CALL_LOG) + smsPerms
    private val devicePerms: Array<String>
        get() = musicPerms + notificationPerms + nearbyPerms

    private fun buildAccessList() {
        accessList.clear()
        accessList += Access(
            "Calls, contacts & SMS", "Call screen, Contacts, Recents and text messages on the car",
            { has(*callPerms) }, { requestRuntime(*callPerms) },
        )
        accessList += Access(
            "Music, alerts & Bluetooth", "Phone's songs, the \"Connected\" status, Bluetooth link and auto-start",
            { has(*devicePerms) }, { requestRuntime(*devicePerms) },
        )
        accessList += Access(
            "Notification access", "Song names, album art and WhatsApp/SMS messages from other apps",
            { hasNotificationAccess() }, { openNotificationAccess() },
        )
        accessList += Access(
            "Run in background", "Keeps the link alive while you drive",
            { ignoresBatteryOptimizations() }, { requestBatteryExemption() },
        )
    }

    private fun openNotificationAccess() {
        val detail = if (Build.VERSION.SDK_INT >= 30) {
            Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS)
                .putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME, ComponentName(this, NotifListener::class.java).flattenToString())
        } else {
            null
        }
        val opened = detail != null && runCatching { startActivity(detail) }.isSuccess
        if (!opened) runCatching { startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)) }
    }

    private fun openAppSettings() {
        runCatching { startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))) }
    }

    private fun hasNotificationAccess(): Boolean =
        Settings.Secure.getString(contentResolver, "enabled_notification_listeners")?.contains(packageName) == true

    private fun ignoresBatteryOptimizations(): Boolean =
        getSystemService(PowerManager::class.java)?.isIgnoringBatteryOptimizations(packageName) == true

    @SuppressLint("BatteryLife")
    private fun requestBatteryExemption() {
        runCatching {
            startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
        }
    }

    private fun refreshAccess() {
        var missing = 0
        accessList.forEach { a ->
            val ok = a.granted()
            if (!ok) missing++
            a.title.text = if (ok) "✓  ${a.label}" else "✗  ${a.label}"
            a.title.setTextColor(if (ok) Color.rgb(0x6d, 0xd5, 0x8c) else Color.WHITE)
            a.button.visibility = if (ok) View.GONE else View.VISIBLE
        }
        val allOk = missing == 0
        accessSummary.text = if (allOk) "✓  All access allowed" else "$missing of ${accessList.size} still needed: tap Allow"
        accessSummary.setTextColor(if (allOk) Color.rgb(0x6d, 0xd5, 0x8c) else Color.rgb(0xfd, 0xd6, 0x63))
        accessBox.visibility = if (allOk && !accessExpanded) View.GONE else View.VISIBLE
        accessToggle.visibility = if (allOk) View.VISIBLE else View.GONE
        accessToggle.text = if (accessExpanded) "Hide details" else "Show details"
        restrictedHelp.visibility = if (hasNotificationAccess()) View.GONE else View.VISIBLE
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        refreshAccess()
        loadBluetoothDevices()
        // Restart so call tracking and GPS pick up the new permissions.
        if (LinkService.running) LinkService.restart(this)
    }

    // ---- Bluetooth auto-start ----

    @SuppressLint("MissingPermission")
    private fun loadBluetoothDevices() {
        val names = mutableListOf("Off (start manually)")
        val addresses = mutableListOf<String?>(null)
        val canList = Build.VERSION.SDK_INT < 31 ||
            checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED
        if (canList) {
            val adapter = getSystemService(BluetoothManager::class.java)?.adapter
            runCatching {
                adapter?.bondedDevices?.sortedBy { it.name ?: "" }?.forEach { d ->
                    names.add(d.name ?: d.address)
                    addresses.add(d.address)
                }
            }
            btHint.visibility = View.GONE
        } else {
            btHint.text = "Allow phone access above to list your Bluetooth devices."
            btHint.visibility = View.VISIBLE
        }
        btAddresses = addresses
        btSpinner.onItemSelectedListener = null
        btSpinner.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, names)
        val saved = Prefs.btDevice(this)
        btSpinner.setSelection(addresses.indexOf(saved).coerceAtLeast(0), false)
        btSpinner.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                Prefs.setBtDevice(this@MainActivity, btAddresses.getOrNull(position))
            }
            override fun onNothingSelected(parent: AdapterView<*>?) {}
        }
    }

    companion object {
        private const val REQ_PHONE = 1
        private const val REQ_LOCATION = 2
    }
}
