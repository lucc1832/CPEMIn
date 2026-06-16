package com.example.myapplication

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import android.telephony.CellIdentityGsm
import android.telephony.CellIdentityLte
import android.telephony.CellIdentityWcdma
import android.telephony.CellInfo
import android.telephony.CellInfoGsm
import android.telephony.CellInfoLte
import android.telephony.CellInfoNr
import android.telephony.CellInfoWcdma
import android.telephony.CellSignalStrengthGsm
import android.telephony.CellSignalStrengthLte
import android.telephony.CellSignalStrengthWcdma
import android.telephony.SubscriptionInfo
import android.telephony.SubscriptionManager
import android.telephony.TelephonyManager
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.core.net.toUri
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStream
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.CookieHandler
import java.net.CookieManager
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.util.Locale
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

@Suppress("DEPRECATION")
class MainActivity : ComponentActivity() {
    private lateinit var webView: WebView
    private var fiberAuthCache: FiberAuth? = null

    private val phonePermissions = arrayOf(
        Manifest.permission.ACCESS_FINE_LOCATION,
        Manifest.permission.ACCESS_COARSE_LOCATION,
        Manifest.permission.READ_PHONE_STATE
    )

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        CookieHandler.setDefault(CookieManager())
        requestPhonePermissionsIfNeeded()

        webView = WebView(this)
        setContentView(webView)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            allowFileAccess = true
            allowContentAccess = true
            allowFileAccessFromFileURLs = true
            allowUniversalAccessFromFileURLs = true
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            cacheMode = WebSettings.LOAD_NO_CACHE
            textZoom = 100
            useWideViewPort = true
            loadWithOverviewMode = true
            userAgentString = mobileChromeUserAgent
        }

        webView.webViewClient = WebViewClient()
        webView.addJavascriptInterface(CpeBridge(), "CpeNative")
        webView.loadUrl("file:///android_asset/index.html")

        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    if (::webView.isInitialized && webView.canGoBack()) {
                        webView.goBack()
                    } else {
                        finish()
                    }
                }
            }
        )
    }

    private fun requestPhonePermissionsIfNeeded() {
        val missing = phonePermissions.filter {
            checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED
        }.toTypedArray()
        if (missing.isNotEmpty()) requestPermissions(missing, 7001)
    }

    private fun hasPhonePermission(): Boolean {
        return phonePermissions.all { checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }
    }

    @Suppress("unused")
    inner class CpeBridge {
        @JavascriptInterface
        fun openUrl(address: String): String {
            runOnUiThread { webView.loadUrl(address) }
            return "{\"ok\":true}"
        }

        @JavascriptInterface
        fun openUrlWithHeaders(address: String): String {
            runOnUiThread { openInsideWebView(address) }
            return "{\"ok\":true}"
        }

        @JavascriptInterface
        fun openExternalUrl(address: String): String {
            return try {
                runOnUiThread {
                    startActivity(Intent(Intent.ACTION_VIEW, address.toUri()))
                }
                "{\"ok\":true}"
            } catch (_: Exception) {
                runOnUiThread { openInsideWebView(address) }
                "{\"ok\":true,\"fallback\":\"webview\"}"
            }
        }

        @JavascriptInterface
        fun requestPhonePermissions(): String {
            runOnUiThread { requestPhonePermissionsIfNeeded() }
            return "{\"ok\":true}"
        }

        @JavascriptInterface
        fun getPhoneSignals(): String {
            return readPhoneSignalsJson()
        }

        @JavascriptInterface
        fun httpGet(address: String): String {
            return request("GET", address, null)
        }

        @JavascriptInterface
        fun httpPost(address: String, body: String?): String {
            return request("POST", address, body ?: "{}")
        }

        @JavascriptInterface
        fun fiberHomeStatus(hostAndPort: String, username: String, password: String): String {
            return readFiberHomeStatus(hostAndPort, username, password)
        }

        private fun request(method: String, address: String, requestBody: String?): String {
            var connection: HttpURLConnection? = null
            return try {
                val url = URL(address)
                connection = (url.openConnection() as HttpURLConnection).apply {
                    connectTimeout = 6000
                    readTimeout = 6000
                    requestMethod = method
                    setRequestProperty("Accept", "application/json,text/plain,*/*")

                    if (method == "POST") {
                        val bytes = (requestBody ?: "{}").toByteArray(StandardCharsets.UTF_8)
                        doOutput = true
                        setRequestProperty("Content-Type", "application/json; charset=utf-8")
                        setRequestProperty("Content-Length", bytes.size.toString())
                        outputStream.use { output: OutputStream -> output.write(bytes) }
                    }
                }

                val code = connection.responseCode
                val stream = if (code >= 400) connection.errorStream else connection.inputStream
                val responseBody = readAll(stream)
                if (code >= 400) {
                    "{\"error\":\"HTTP $code\",\"body\":${quote(responseBody)}}"
                } else {
                    responseBody
                }
            } catch (error: Exception) {
                "{\"error\":${quote(error.message ?: error.javaClass.simpleName)}}"
            } finally {
                connection?.disconnect()
            }
        }
    }

    private fun openInsideWebView(address: String) {
        webView.loadUrl(
            address,
            mapOf(
                "Accept" to "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language" to "zh-CN,zh;q=0.9,en;q=0.8",
                "Referer" to address.substringBeforeLast('/', "http://192.168.8.1") + "/",
                "Upgrade-Insecure-Requests" to "1"
            )
        )
    }

    private fun readFiberHomeStatus(
        hostAndPort: String,
        username: String,
        password: String
    ): String {
        return try {
            val host = hostAndPort.trim()
                .removePrefix("http://")
                .removePrefix("https://")
                .trimEnd('/')
            require(host.isNotBlank()) { "设备地址不能为空" }
            val baseUrl = "http://$host"

            // FiberHome web UI flow: refresh session, AES-CBC login, then read non-mutating status methods.
            val cached = fiberAuthCache?.takeIf {
                it.host == host && it.expiresAt > System.currentTimeMillis()
            }
            val activeSession = if (cached != null) {
                FiberSession(cached.sessionId, cached.token)
            } else {
                val firstSession = fiberRefreshSession(baseUrl, emptyMap())
                val loginHeaders = fiberHeaders(firstSession.sessionId, firstSession.token)
                val loginPayload = JSONObject()
                    .put(
                        "dataObj",
                        JSONObject()
                            .put("username", username)
                            .put("password", password)
                    )
                    .put("ajaxmethod", "DO_WEB_LOGIN")
                    .put("sessionid", firstSession.sessionId)
                    .toString()
                val loginResponse = fiberHttp(
                    "POST",
                    "$baseUrl/api/sign/DO_WEB_LOGIN",
                    fiberEncryptHex(loginPayload, firstSession.sessionId),
                    loginHeaders
                )
                if (loginResponse.code >= 400) error("登录失败：HTTP ${loginResponse.code}")
                fiberRefreshSession(baseUrl, loginHeaders)
            }
            val activeHeaders = fiberHeaders(activeSession.sessionId, activeSession.token)
            val responses = JSONObject()
            var matched = 0
            val matchedMethods = mutableListOf<String>()
            val methods = cached?.methods?.takeIf { it.isNotEmpty() } ?: fiberReadMethods.flatMap {
                listOf("FHAPIS:$it", "FHTOOLAPIS:$it")
            }

            methods.forEach { methodSpec ->
                val apiKind = methodSpec.substringBefore(':', "FHAPIS")
                val method = methodSpec.substringAfter(':', methodSpec)
                try {
                    val response = if (apiKind == "FHTOOLAPIS") {
                        fiberToolApi(baseUrl, method, activeSession, activeHeaders)
                    } else {
                        fiberEncryptedApi(baseUrl, method, activeSession, activeHeaders)
                    }
                    if (response.code >= 400 || response.body.isBlank()) return@forEach
                    val decoded = if (apiKind == "FHTOOLAPIS") {
                        response.body
                    } else {
                        fiberDecryptOrPlain(response.body, activeSession.sessionId)
                    }
                    if (looksLikeStatusPayload(decoded)) {
                        responses.put("${apiKind}_$method", jsonValue(decoded))
                        matched += 1
                        matchedMethods += methodSpec
                    }
                } catch (_: Exception) {
                    // Firmware variants expose different read-only ajax methods.
                }
            }
            fiberAuthCache = if (matchedMethods.isNotEmpty()) {
                FiberAuth(
                    host = host,
                    sessionId = activeSession.sessionId,
                    token = activeSession.token,
                    methods = matchedMethods,
                    expiresAt = System.currentTimeMillis() + 10 * 60 * 1000
                )
            } else {
                null
            }

            JSONObject()
                .put("ok", matched > 0)
                .put("vendor", "firehome")
                .put("responses", responses)
                .put(
                    "error",
                    if (matched == 0) "已登录，但未匹配到当前固件的状态方法" else JSONObject.NULL
                )
                .toString()
        } catch (error: Exception) {
            JSONObject()
                .put("ok", false)
                .put("error", error.message ?: error.javaClass.simpleName)
                .toString()
        }
    }

    private fun fiberEncryptedApi(
        baseUrl: String,
        method: String,
        session: FiberSession,
        headers: Map<String, String>
    ): FiberResponse {
        val payload = JSONObject()
            .put("dataObj", JSONObject())
            .put("ajaxmethod", method)
            .put("sessionid", session.sessionId)
            .toString()
        return fiberHttp(
            "POST",
            "$baseUrl/api/tmp/FHAPIS",
            fiberEncryptHex(payload, session.sessionId),
            headers
        )
    }

    private fun fiberToolApi(
        baseUrl: String,
        method: String,
        session: FiberSession,
        headers: Map<String, String>
    ): FiberResponse {
        val payload = JSONObject()
            .put("dataObj", JSONObject())
            .put("ajaxmethod", method)
            .put("sessionid", session.sessionId)
            .toString()
        return fiberHttp(
            "POST",
            "$baseUrl/api/tmp/FHTOOLAPIS",
            payload,
            headers
        )
    }

    private fun fiberRefreshSession(baseUrl: String, headers: Map<String, String>): FiberSession {
        val response = fiberHttp(
            "GET",
            "$baseUrl/api/tmp/FHNCAPIS?ajaxmethod=get_refresh_sessionid",
            null,
            headers
        )
        if (response.code >= 400) error("获取烽火会话失败：HTTP ${response.code}")
        val sessionId = try {
            JSONObject(response.body).optString("sessionid")
                .ifBlank { JSONObject(response.body).optString("SessionID") }
        } catch (_: Exception) {
            Regex("\"(?:sessionid|SessionID)\"\\s*:\\s*\"([^\"]+)\"")
                .find(response.body)
                ?.groupValues
                ?.getOrNull(1)
                .orEmpty()
        }
        if (sessionId.length < 16) error("烽火会话无效")
        val token = response.header("WebToken").ifBlank { headers["WebToken"].orEmpty() }
        return FiberSession(sessionId, token)
    }

    private fun fiberHeaders(sessionId: String, token: String): Map<String, String> {
        return buildMap {
            put("Accept", "application/json,text/plain,*/*")
            put("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
            put("User-Agent", mobileChromeUserAgent)
            put("X-Requested-With", "XMLHttpRequest")
            put("WebSession", sessionId)
            put("Cookie", "sessionid=$sessionId")
            if (token.isNotBlank()) put("WebToken", token)
        }
    }

    private fun fiberHttp(
        method: String,
        address: String,
        requestBody: String?,
        headers: Map<String, String>
    ): FiberResponse {
        var connection: HttpURLConnection? = null
        return try {
            connection = (URL(address).openConnection() as HttpURLConnection).apply {
                connectTimeout = 5500
                readTimeout = 5500
                requestMethod = method
                useCaches = false
                headers.forEach { (key, value) -> setRequestProperty(key, value) }
                if (method == "POST") {
                    val bytes = requestBody.orEmpty().toByteArray(StandardCharsets.UTF_8)
                    doOutput = true
                    setRequestProperty("Content-Type", "application/json; charset=utf-8")
                    outputStream.use { output -> output.write(bytes) }
                }
            }
            val code = connection.responseCode
            val stream = if (code >= 400) connection.errorStream else connection.inputStream
            val responseHeaders = connection.headerFields.entries.mapNotNull { (key, value) ->
                key?.let { it to value }
            }.toMap()
            FiberResponse(code, readAll(stream), responseHeaders)
        } finally {
            connection?.disconnect()
        }
    }

    private fun fiberEncryptHex(plainText: String, sessionId: String): String {
        val key = sessionId.take(16).toByteArray(StandardCharsets.UTF_8)
        val cipher = Cipher.getInstance("AES/CBC/PKCS5Padding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), IvParameterSpec(fiberIv))
        return cipher.doFinal(plainText.toByteArray(StandardCharsets.UTF_8)).toHex()
    }

    private fun fiberDecryptOrPlain(value: String, sessionId: String): String {
        val trimmed = value.trim()
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) return trimmed
        return try {
            val encoded = trimmed.hexToBytes()
            val cipher = Cipher.getInstance("AES/CBC/PKCS5Padding")
            cipher.init(
                Cipher.DECRYPT_MODE,
                SecretKeySpec(sessionId.take(16).toByteArray(StandardCharsets.UTF_8), "AES"),
                IvParameterSpec(fiberIv)
            )
            String(cipher.doFinal(encoded), StandardCharsets.UTF_8)
        } catch (_: Exception) {
            try {
                val encoded = Base64.decode(trimmed, Base64.DEFAULT)
                if (encoded.size <= 16) return trimmed
                val cipher = Cipher.getInstance("AES/CBC/PKCS5Padding")
                cipher.init(
                    Cipher.DECRYPT_MODE,
                    SecretKeySpec(sessionId.take(16).toByteArray(StandardCharsets.UTF_8), "AES"),
                    IvParameterSpec(encoded.copyOfRange(0, 16))
                )
                String(
                    cipher.doFinal(encoded.copyOfRange(16, encoded.size)),
                    StandardCharsets.UTF_8
                )
            } catch (_: Exception) {
                trimmed
            }
        }
    }

    private fun looksLikeStatusPayload(value: String): Boolean {
        return value.contains(
            Regex(
                "rsrp|rsrq|sinr|arfcn|earfcn|pci|cell|band|device|model|traffic|flow|wan|lte|nr|5g|imei|imsi|temperature|temp|version|signal|rate|tx|rx",
                RegexOption.IGNORE_CASE
            )
        )
    }

    private fun jsonValue(value: String): Any {
        val trimmed = value.trim()
        return try {
            when {
                trimmed.startsWith("{") -> JSONObject(trimmed)
                trimmed.startsWith("[") -> JSONArray(trimmed)
                else -> trimmed
            }
        } catch (_: Exception) {
            trimmed
        }
    }

    private data class FiberSession(val sessionId: String, val token: String)

    private data class FiberAuth(
        val host: String,
        val sessionId: String,
        val token: String,
        val methods: List<String>,
        val expiresAt: Long
    )

    private data class FiberResponse(
        val code: Int,
        val body: String,
        val headers: Map<String, List<String>>
    ) {
        fun header(name: String): String {
            return headers.entries.firstOrNull { it.key.equals(name, ignoreCase = true) }
                ?.value
                ?.firstOrNull()
                .orEmpty()
        }
    }

    private val fiberReadMethods = listOf(
        "get_device_status",
        "get_device_info",
        "get_sysinfo",
        "get_system_info",
        "get_system_status",
        "get_network_status",
        "get_network_info",
        "get_mobile_network_status",
        "get_radio_status",
        "get_cell_info",
        "get_nr_status",
        "get_lte_status",
        "get_signal_status",
        "get_modem_status",
        "get_wan_status",
        "get_wan_info",
        "get_statistics",
        "get_traffic_status",
        "get_flow_statistics",
        "get_sim_status",
        "get_current_network"
    )

    private val fiberIv = ByteArray(16) { index -> (index + 112).toByte() }

    private val mobileChromeUserAgent =
        "Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"

    private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it.toInt() and 255) }

    private fun String.hexToBytes(): ByteArray {
        val clean = trim()
        require(clean.length % 2 == 0) { "invalid hex length" }
        return ByteArray(clean.length / 2) { index ->
            clean.substring(index * 2, index * 2 + 2).toInt(16).toByte()
        }
    }

    @SuppressLint("MissingPermission")
    private fun readPhoneSignalsJson(): String {
        if (!hasPhonePermission()) {
            return "{\"ok\":false,\"error\":\"需要授予定位和电话权限后才能读取手机信号\"}"
        }

        return try {
            val groups = mutableListOf<String>()
            val telephony = getSystemService(TelephonyManager::class.java)
            val subscriptions = readSubscriptions()

            if (subscriptions.isNotEmpty()) {
                subscriptions.forEachIndexed { index, info ->
                    val manager = telephony.createForSubscriptionId(info.subscriptionId)
                    groups += phoneGroupJson(
                        index + 1,
                        info.carrierName?.toString(),
                        manager.allCellInfo
                    )
                }
            } else {
                groups += phoneGroupJson(1, telephony.networkOperatorName, telephony.allCellInfo)
            }

            "{\"ok\":true,\"cellular\":[${groups.joinToString(",")}],\"wifi\":${readWifiJson()}}"
        } catch (error: Exception) {
            "{\"ok\":false,\"error\":${quote(error.message ?: error.javaClass.simpleName)},\"wifi\":${readWifiJson()}}"
        }
    }

    @SuppressLint("MissingPermission")
    private fun readSubscriptions(): List<SubscriptionInfo> {
        return try {
            val manager = getSystemService(SubscriptionManager::class.java)
            manager.activeSubscriptionInfoList ?: emptyList()
        } catch (_: Exception) {
            emptyList()
        }
    }

    private fun phoneGroupJson(slot: Int, carrier: String?, cells: List<CellInfo>?): String {
        val parsed = (cells ?: emptyList()).mapNotNull { parseCell(it) }
        val primary = parsed.firstOrNull { it.registered } ?: parsed.firstOrNull()
        val title =
            "${carrier.takeUnless { it.isNullOrBlank() } ?: "未知"}|${parsed.count { it.registered }}"
        val rows = parsed.joinToString(",") { phoneCellJson(it) }

        return "{" +
                "\"slot\":$slot," +
                "\"title\":${quote(title)}," +
                "\"plmn\":${quote(primary?.plmn ?: "N/A")}," +
                "\"tac\":${quote(primary?.tac ?: "N/A")}," +
                "\"cellId\":${quote(primary?.cellId ?: "N/A")}," +
                "\"sinr\":${quote(primary?.sinr ?: "N/A")}," +
                "\"cells\":[$rows]" +
                "}"
    }

    private fun parseCell(cell: CellInfo): PhoneCell? {
        return when {
            cell is CellInfoLte -> parseLte(cell)
            cell is CellInfoWcdma -> parseWcdma(cell)
            cell is CellInfoGsm -> parseGsm(cell)
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && cell is CellInfoNr -> parseNr(cell)
            else -> null
        }
    }

    private fun parseLte(cell: CellInfoLte): PhoneCell {
        val id = cell.cellIdentity
        val signal = cell.cellSignalStrength
        return PhoneCell(
            type = "LTE",
            registered = cell.isRegistered,
            plmn = plmn(id),
            tac = cleanInt(id.tac),
            cellId = lteCellId(id.ci),
            sinr = lteSinr(signal),
            arfcn = cleanInt(id.earfcn),
            pci = cleanInt(id.pci),
            rsrp = lteRsrp(signal),
            rsrq = lteRsrq(signal),
            name = ""
        )
    }

    private fun parseWcdma(cell: CellInfoWcdma): PhoneCell {
        val id = cell.cellIdentity
        val signal = cell.cellSignalStrength
        return PhoneCell(
            type = "WCDMA",
            registered = cell.isRegistered,
            plmn = plmn(id),
            tac = cleanInt(id.lac),
            cellId = cleanInt(id.cid),
            sinr = "N/A",
            arfcn = cleanInt(id.uarfcn),
            pci = cleanInt(id.psc),
            rsrp = dbm(signal),
            rsrq = "N/A",
            name = ""
        )
    }

    private fun parseGsm(cell: CellInfoGsm): PhoneCell {
        val id = cell.cellIdentity
        val signal = cell.cellSignalStrength
        return PhoneCell(
            type = "GSM",
            registered = cell.isRegistered,
            plmn = plmn(id),
            tac = cleanInt(id.lac),
            cellId = cleanInt(id.cid),
            sinr = "N/A",
            arfcn = cleanInt(id.arfcn),
            pci = cleanInt(id.bsic),
            rsrp = dbm(signal),
            rsrq = "N/A",
            name = ""
        )
    }

    @SuppressLint("NewApi")
    private fun parseNr(cell: CellInfoNr): PhoneCell {
        val id = cell.cellIdentity as android.telephony.CellIdentityNr
        val signal = cell.cellSignalStrength as android.telephony.CellSignalStrengthNr
        return PhoneCell(
            type = "NR",
            registered = cell.isRegistered,
            plmn = "${id.mccString ?: ""}${id.mncString ?: ""}".ifBlank { "N/A" },
            tac = cleanInt(id.tac),
            cellId = nrCellId(id.nci),
            sinr = cleanInt(signal.ssSinr),
            arfcn = cleanInt(id.nrarfcn),
            pci = cleanInt(id.pci),
            rsrp = cleanInt(signal.ssRsrp),
            rsrq = cleanInt(signal.ssRsrq),
            name = ""
        )
    }

    private fun plmn(id: CellIdentityLte): String {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            return "${id.mccString ?: ""}${id.mncString ?: ""}".ifBlank { "N/A" }
        }
        return "${cleanInt(id.mcc)}${cleanInt(id.mnc)}".takeUnless { it.contains("N/A") } ?: "N/A"
    }

    private fun plmn(id: CellIdentityWcdma): String {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            return "${id.mccString ?: ""}${id.mncString ?: ""}".ifBlank { "N/A" }
        }
        return "${cleanInt(id.mcc)}${cleanInt(id.mnc)}".takeUnless { it.contains("N/A") } ?: "N/A"
    }

    private fun plmn(id: CellIdentityGsm): String {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            return "${id.mccString ?: ""}${id.mncString ?: ""}".ifBlank { "N/A" }
        }
        return "${cleanInt(id.mcc)}${cleanInt(id.mnc)}".takeUnless { it.contains("N/A") } ?: "N/A"
    }

    private fun lteCellId(ci: Int): String {
        if (!isValid(ci)) return "N/A"
        return "${ci ushr 8}/${ci and 255}"
    }

    private fun nrCellId(nci: Long): String {
        if (nci == Long.MAX_VALUE || nci < 0) return "N/A"
        val local = nci and 1023L
        val gNode = nci ushr 10
        return "$gNode/$local"
    }

    @SuppressLint("NewApi")
    private fun lteSinr(signal: CellSignalStrengthLte): String {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return "N/A"
        val value = signal.rssnr
        if (!isValid(value)) return "N/A"
        return if (value % 10 == 0) (value / 10).toString() else String.format(
            Locale.US,
            "%.1f",
            value / 10.0
        )
    }

    @SuppressLint("NewApi")
    private fun lteRsrp(signal: CellSignalStrengthLte): String {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) cleanInt(signal.rsrp) else cleanInt(
            signal.dbm
        )
    }

    @SuppressLint("NewApi")
    private fun lteRsrq(signal: CellSignalStrengthLte): String {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) cleanInt(signal.rsrq) else "N/A"
    }

    private fun dbm(signal: CellSignalStrengthWcdma): String = cleanInt(signal.dbm)
    private fun dbm(signal: CellSignalStrengthGsm): String = cleanInt(signal.dbm)

    private fun cleanInt(value: Int): String {
        return if (isValid(value)) value.toString() else "N/A"
    }

    private fun isValid(value: Int): Boolean {
        return value != Int.MAX_VALUE && value != Int.MIN_VALUE && value != 99
    }

    private fun readWifiJson(): String {
        return try {
            val wifi = applicationContext.getSystemService(WifiManager::class.java)
            val info = wifi.connectionInfo
            "{" +
                    "\"ssid\":${quote(info.ssid?.trim('"') ?: "N/A")}," +
                    "\"bssid\":${quote(info.bssid ?: "N/A")}," +
                    "\"rssi\":${quote(cleanInt(info.rssi))}," +
                    "\"linkSpeed\":${quote("${info.linkSpeed}Mbps")}," +
                    "\"frequency\":${quote("${info.frequency}MHz")}" +
                    "}"
        } catch (error: Exception) {
            "{\"error\":${quote(error.message ?: error.javaClass.simpleName)}}"
        }
    }

    private fun phoneCellJson(cell: PhoneCell): String {
        return "{" +
                "\"type\":${quote(cell.type)}," +
                "\"registered\":${cell.registered}," +
                "\"plmn\":${quote(cell.plmn)}," +
                "\"tac\":${quote(cell.tac)}," +
                "\"cellId\":${quote(cell.cellId)}," +
                "\"sinr\":${quote(cell.sinr)}," +
                "\"arfcn\":${quote(cell.arfcn)}," +
                "\"pci\":${quote(cell.pci)}," +
                "\"rsrp\":${quote(cell.rsrp)}," +
                "\"rsrq\":${quote(cell.rsrq)}," +
                "\"name\":${quote(cell.name)}" +
                "}"
    }

    private data class PhoneCell(
        val type: String,
        val registered: Boolean,
        val plmn: String,
        val tac: String,
        val cellId: String,
        val sinr: String,
        val arfcn: String,
        val pci: String,
        val rsrp: String,
        val rsrq: String,
        val name: String
    )

    private fun readAll(stream: InputStream?): String {
        if (stream == null) return ""
        val reader = BufferedReader(InputStreamReader(stream, StandardCharsets.UTF_8))
        val builder = StringBuilder()
        reader.useLines { lines -> lines.forEach { builder.append(it) } }
        return builder.toString()
    }

    private fun quote(value: String): String {
        return buildString {
            append('"')
            value.forEach { char ->
                when (char) {
                    '\\' -> append("\\\\")
                    '"' -> append("\\\"")
                    '\n' -> append("\\n")
                    '\r' -> append("\\r")
                    else -> append(char)
                }
            }
            append('"')
        }
    }
}
