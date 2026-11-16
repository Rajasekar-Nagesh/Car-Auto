package app.carauto.link

import android.app.Activity
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning

/**
 * Scans the pairing QR code shown on the car screen using Google Play
 * services' built-in scanner (no camera permission needed; the scanner UI is
 * provided by Play services and downloaded on first use).
 */
object QrScanner {
    fun scan(activity: Activity, onResult: (String) -> Unit, onError: (String) -> Unit) {
        val options = GmsBarcodeScannerOptions.Builder()
            .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
            .build()
        GmsBarcodeScanning.getClient(activity, options)
            .startScan()
            .addOnSuccessListener { barcode -> onResult(barcode.rawValue ?: "") }
            .addOnCanceledListener { }
            .addOnFailureListener { e -> onError(e.message ?: "Scanner unavailable") }
    }
}
