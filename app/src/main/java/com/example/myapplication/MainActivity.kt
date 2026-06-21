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
import android.util.Log
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
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
import java.util.concurrent.ConcurrentHashMap
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

@Suppress("DEPRECATION")
class MainActivity : ComponentActivity() {
    // 主 WebView 承载 assets/index.html，页面 UI 和大部分交互都在前端完成。
    private lateinit var webView: WebView
    private lateinit var rootView: FrameLayout
    // 隐藏 WebView 是兼容备用方案；正常读取烽火状态优先走本地 FHTOOLAPIS。
    private var hiddenWebView: WebView? = null
    private var hiddenHost = ""
    private val hiddenAsyncTokens = ConcurrentHashMap<String, Boolean>()
    // 旧网页登录流程缓存，保留给少数需要网页登录的设备。
    private var fiberAuthCache: FiberAuth? = null
    // 记录本地 app_do_login 唤醒时间，避免自动刷新太快导致账号保护。
    private val fiberToolWakeTimes = ConcurrentHashMap<String, Long>()
    private val fiberToolWakeCooldownMs = 10 * 60 * 1000L

    private val phonePermissions = arrayOf(
        Manifest.permission.ACCESS_FINE_LOCATION,
        Manifest.permission.ACCESS_COARSE_LOCATION,
        Manifest.permission.READ_PHONE_STATE
    )

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        CookieHandler.setDefault(CookieManager())

        rootView = FrameLayout(this)
        webView = WebView(this)
        rootView.addView(
            webView,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        )
        setContentView(rootView)

        configureWebView(webView)

        webView.webViewClient = WebViewClient()
        webView.addJavascriptInterface(CpeBridge(), "CpeNative")
        val startUrl = if (intent?.getBooleanExtra("autotest", false) == true) {
            "file:///android_asset/index.html?autotest=1"
        } else {
            "file:///android_asset/index.html"
        }
        webView.loadUrl(startUrl)

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

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView(target: WebView) {
        // 允许本地 HTML 访问路由器 HTTP 接口，这是 APK 内嵌页面能直连 CPE 的关键。
        target.settings.apply {
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
        // 前端通过 window.CpeNative 调用这些方法，获得 Android 原生网络和手机信号能力。
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
        fun getWifiGateway(): String {
            return readWifiGatewayJson()
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

        @JavascriptInterface
        fun fiberHomeStatusAsync(
            token: String,
            hostAndPort: String,
            username: String,
            password: String
        ): String {
            return try {
                startFiberHomeStatusWithOfficialWeb(token, hostAndPort, username, password)
                "{\"ok\":true}"
            } catch (error: Exception) {
                deliverHiddenResult(
                    token,
                    JSONObject()
                        .put("ok", false)
                        .put("error", error.message ?: error.javaClass.simpleName)
                        .toString()
                )
                "{\"ok\":false,\"error\":${quote(error.message ?: error.javaClass.simpleName)}}"
            }
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

    @Suppress("unused")
    inner class HiddenCpeBridge {
        @JavascriptInterface
        fun onResult(token: String, payload: String) {
            Log.d("CpeHidden", "result token=$token length=${payload.length}")
            deliverHiddenResult(token, payload)
        }
    }

    private fun deliverHiddenResult(token: String, payload: String) {
        hiddenAsyncTokens.remove(token)
        val callbackScript = """
            (function() {
              const callback = window.__cpeNativeFiberHomeResult;
              if (typeof callback === "function") {
                callback(${JSONObject.quote(token)}, ${JSONObject.quote(payload)});
              }
            })();
        """.trimIndent()
        runOnUiThread {
            if (::webView.isInitialized) webView.evaluateJavascript(callbackScript, null)
        }
    }

    private fun startFiberHomeStatusWithOfficialWeb(
        token: String,
        hostAndPort: String,
        username: String,
        password: String
    ) {
        val host = hostAndPort.trim()
            .removePrefix("http://")
            .removePrefix("https://")
            .trimEnd('/')
        require(host.isNotBlank()) { "device host is blank" }

        hiddenAsyncTokens[token] = true
        Log.d("CpeHidden", "async start host=$host token=$token")
        Thread {
            try {
                // 烽火直连优先读本地工具接口；正常读取不需要反复登录，只有 timeout 时才用账号密码低频唤醒。
                val direct = readFiberHomeToolBaseInfo(host, username, password)
                if (direct != null && isHiddenTokenActive(token)) {
                    deliverHiddenResult(token, direct.toString())
                    return@Thread
                }
            } catch (error: Exception) {
                Log.d("CpeHidden", "tool api failed host=$host error=${error.message}")
            }

            deliverHiddenResult(
                token,
                JSONObject()
                    .put("ok", false)
                    .put("error", "烽火本地接口暂时 timeout，正在等待设备返回数据")
                    .toString()
            )
        }.start()
    }

    private fun isHiddenTokenActive(token: String): Boolean {
        return hiddenAsyncTokens.containsKey(token)
    }

    // 备用网页登录方案：当前主路径走 FHTOOLAPIS，这段保留给后续兼容需要网页登录的固件。
    @Suppress("unused")
    private fun loadFiberHomeHiddenPage(
        token: String,
        host: String,
        username: String,
        password: String
    ) {
        runOnUiThread {
            try {
                val hidden = ensureHiddenWebView()
                val script = fiberHomeOfficialScript(token, username, password)
                val runScript = {
                    if (isHiddenTokenActive(token)) {
                        Log.d("CpeHidden", "evaluate token=$token url=${hidden.url}")
                        hidden.evaluateJavascript(script) { result ->
                            Log.d("CpeHidden", "evaluateResult token=$token result=${result?.take(120)}")
                        }
                    }
                }
                val scheduleScript = {
                    hidden.postDelayed({ runScript() }, 1200L)
                    hidden.postDelayed({ runScript() }, 3000L)
                    hidden.postDelayed({ runScript() }, 6000L)
                }
                val hostName = host.substringBefore(':')

                hidden.webViewClient = object : WebViewClient() {
                    override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
                        Log.d("CpeHidden", "pageStarted token=$token url=$url")
                        if (url?.contains(hostName) == true) scheduleScript()
                    }

                    override fun onPageFinished(view: WebView?, url: String?) {
                        Log.d("CpeHidden", "pageFinished token=$token url=$url")
                        if (url?.contains(hostName) == true) runScript()
                    }
                }

                if (hiddenHost != host || hidden.url?.contains(hostName) != true) {
                    hiddenHost = host
                    Log.d("CpeHidden", "load http://$host/login.html")
                    hidden.loadUrl("http://$host/login.html")
                    scheduleScript()
                } else {
                    scheduleScript()
                }
            } catch (error: Exception) {
                if (hiddenAsyncTokens.containsKey(token)) {
                    deliverHiddenResult(
                        token,
                        JSONObject()
                            .put("ok", false)
                            .put("error", error.message ?: error.javaClass.simpleName)
                            .toString()
                    )
                }
            }
        }
    }

    private fun ensureHiddenWebView(): WebView {
        hiddenWebView?.let { return it }
        val hidden = WebView(this)
        configureWebView(hidden)
        hidden.visibility = View.INVISIBLE
        hidden.addJavascriptInterface(HiddenCpeBridge(), "CpeHidden")
        rootView.addView(hidden, FrameLayout.LayoutParams(1, 1))
        hiddenWebView = hidden
        return hidden
    }

    private fun fiberHomeOfficialScript(token: String, username: String, password: String): String {
        val rfFields = JSONObject()
            .put("TAC", "X_FH_MobileNetwork.RadioSignalParameter.TAC")
            .put("PLMN", "X_FH_MobileNetwork.RadioSignalParameter.PLMN")
            .put("EARFCN_NBR", "X_FH_MobileNetwork.RadioSignalParameter.EARFCN_NBR")
            .put("RSRP_NBR", "X_FH_MobileNetwork.RadioSignalParameter.RSRP_NBR")
            .put("WorkMode", "X_FH_MobileNetwork.RadioSignalParameter.WorkMode")
            .put("PCI_NBR", "X_FH_MobileNetwork.RadioSignalParameter.PCI_NBR")
            .put("BAND_NBR", "X_FH_MobileNetwork.RadioSignalParameter.BAND_NBR")
            .put("SINR_NBR", "X_FH_MobileNetwork.RadioSignalParameter.SINR_NBR")
            .put("RSRQ", "X_FH_MobileNetwork.RadioSignalParameter.RSRQ")
            .put("RSSI", "X_FH_MobileNetwork.RadioSignalParameter.RSSI")
            .put("SSB_RSRP", "X_FH_MobileNetwork.RadioSignalParameter.SSB_RSRP")
            .put("SSB_SINR", "X_FH_MobileNetwork.RadioSignalParameter.SSB_SINR")
            .put("SSB_RSSI", "X_FH_MobileNetwork.RadioSignalParameter.SSB_RSSI")
            .put("SSB_RSRQ", "X_FH_MobileNetwork.RadioSignalParameter.SSB_RSRQ")
            .put("NR_BAND", "X_FH_MobileNetwork.RadioSignalParameter.NR_Band")
            .put("NR_Power", "X_FH_MobileNetwork.RadioSignalParameter.NR_Power")
            .put("NR_CQI", "X_FH_MobileNetwork.RadioSignalParameter.NR_CQI")
            .put("RSRP", "X_FH_MobileNetwork.RadioSignalParameter.RSRP")
            .put("SINR", "X_FH_MobileNetwork.RadioSignalParameter.SINR")
            .put("BAND", "X_FH_MobileNetwork.RadioSignalParameter.BAND")
            .put("LTE_Power", "X_FH_MobileNetwork.RadioSignalParameter.LTE_Power")
            .put("LTE_CQI", "X_FH_MobileNetwork.RadioSignalParameter.LTE_CQI")
            .put("PCI", "X_FH_MobileNetwork.RadioSignalParameter.PCI")
            .put("NetworkMode", "X_FH_MobileNetwork.SIM.1.NetworkMode")
            .put("NCGI", "X_FH_MobileNetwork.RadioSignalParameter.NCGI")
            .put("ECGI", "X_FH_MobileNetwork.RadioSignalParameter.ECGI")
            .put("QCI", "X_FH_MobileNetwork.RadioSignalParameter.QCI")
            .put("NR_QCI", "X_FH_MobileNetwork.RadioSignalParameter.NR_QCI")
            .put("DL_AMBR", "X_FH_MobileNetwork.RadioSignalParameter.DL_AMBR")
            .put("UL_AMBR", "X_FH_MobileNetwork.RadioSignalParameter.UL_AMBR")
            .put("NR_PCI", "X_FH_MobileNetwork.RadioSignalParameter.NR_PCI")
            .put("NR_DLBW", "X_FH_MobileNetwork.RadioSignalParameter.NR_DLBW")
            .put("NR_ULBW", "X_FH_MobileNetwork.RadioSignalParameter.NR_ULBW")
            .put("NR_DLMCS", "X_FH_MobileNetwork.RadioSignalParameter.NR_DLMCS")
            .put("NR_ULMCS", "X_FH_MobileNetwork.RadioSignalParameter.NR_ULMCS")
            .put("NR_MIMO_DL", "X_FH_MobileNetwork.RadioSignalParameter.NR_MIMO_DL")
            .put("NR_MIMO_UL", "X_FH_MobileNetwork.RadioSignalParameter.NR_MIMO_UL")
            .put("Temperature", "X_FH_MobileNetwork.RadioSignalParameter.Temperature")
            .put("DeviceTemperature", "Device.DeviceInfo.TemperatureStatus.TemperatureSensor.1.Value")
            .put("DeviceTemperature2", "Device.DeviceInfo.TemperatureStatus.TemperatureSensor.1.Temperature")
            .put("FHDeviceTemperature", "Device.DeviceInfo.X_FH_Temperature")
            .put("IGDTemperature", "InternetGatewayDevice.DeviceInfo.X_FH_Temperature")
            .put("SoftwareVersion", "Device.DeviceInfo.SoftwareVersion")
            .put("IGDSoftwareVersion", "InternetGatewayDevice.DeviceInfo.SoftwareVersion")
            .put("HardwareVersion", "Device.DeviceInfo.HardwareVersion")
            .put("ProductSoftwareVersion", "X_FH_DeviceInfo.SoftwareVersion")
            .toString()
        val trafficFields = JSONObject()
            .put("DayTrafficStatus", "X_FH_MobileNetwork.TrafficStats.TodayExcceed")
            .put("MonthTrafficStatus", "X_FH_MobileNetwork.TrafficStats.MonthExcceed")
            .put("TestSIMCardEnable", "X_FH_MobileNetwork.NetworkSettings.TestSIMCardEnable")
            .put("TodayDownload", "X_FH_MobileNetwork.TrafficStats.TodayDownload")
            .put("TodayUpload", "X_FH_MobileNetwork.TrafficStats.TodayUpload")
            .put("MonthDownload", "X_FH_MobileNetwork.TrafficStats.MonthDownload")
            .put("MonthUpload", "X_FH_MobileNetwork.TrafficStats.MonthUpload")
            .put("DownloadRate", "X_FH_MobileNetwork.TrafficStats.DownloadRate")
            .put("UploadRate", "X_FH_MobileNetwork.TrafficStats.UploadRate")
            .toString()

        return """
            (function() {
              const token = ${JSONObject.quote(token)};
              const username = ${JSONObject.quote(username.ifBlank { "admin" })};
              const password = ${JSONObject.quote(password)};
              const rfFields = $rfFields;
              const trafficFields = $trafficFields;
              const done = (payload) => {
                try { CpeHidden.onResult(token, JSON.stringify(payload || {})); } catch (e) {}
              };
              const waitForApi = () => new Promise((resolve, reject) => {
                let tries = 0;
                const tick = () => {
                  if (typeof window.${'$'}post === "function" && typeof window.${'$'}get === "function") {
                    resolve();
                  } else if (++tries > 300) {
                    reject(new Error("FiberHome page API not ready"));
                  } else {
                    setTimeout(tick, 100);
                  }
                };
                tick();
              });
              (async () => {
                await waitForApi();
                const device = await window.${'$'}post("get_device_info", null, "nocheck");
                const login = await window.${'$'}post("DO_WEB_LOGIN", { username, password });
                if (!login || String(login.result) !== "0") {
                  throw new Error("FiberHome login failed: result=" + String(login && login.result));
                }
                try { await window.${'$'}get("set_developer_mode", null); } catch (e) {}
                let toolBaseInfo = {};
                try {
                  const toolResponse = await fetch("/api/tmp/FHTOOLAPIS?ajaxmethod=app_get_base_info", { cache: "no-store" });
                  if (toolResponse && toolResponse.ok) toolBaseInfo = await toolResponse.json();
                } catch (e) {}
                const header = await window.${'$'}get("get_header_info");
                const rf = await window.${'$'}post("get_value_by_xmlnode", rfFields);
                let traffic = {};
                try { traffic = await window.${'$'}post("get_value_by_xmlnode", trafficFields); } catch (e) {}
                done({
                  ok: true,
                  vendor: "firehome",
                  responses: {
                    device_info: device || {},
                    tool_base_info: toolBaseInfo || {},
                    login_result: { result: login.result },
                    header_info: header || {},
                    rf_signal: rf || {},
                    traffic_status: traffic || {}
                  },
                  error: null
                });
              })().catch((error) => {
                done({ ok: false, error: String((error && error.message) || error) });
              });
            })();
        """.trimIndent()
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

            readFiberHomeToolBaseInfo(host, username, password)?.let { return it.toString() }

            // FiberHome web UI flow: refresh session, optionally log in, then read non-mutating status methods.
            val cached = fiberAuthCache?.takeIf {
                it.host == host && it.expiresAt > System.currentTimeMillis()
            }
            var loginError = ""
            val activeSession = if (cached != null) {
                FiberSession(cached.sessionId, cached.token)
            } else {
                val firstSession = fiberRefreshSession(baseUrl, emptyMap())
                val loginResult = fiberLogin(baseUrl, firstSession, username, password)
                if (!loginResult.ok) loginError = loginResult.error
                firstSession
            }
            val activeHeaders = fiberHeaders(activeSession.sessionId, activeSession.token, baseUrl)
            val responses = JSONObject()
            var matched = 0
            val matchedMethods = mutableListOf<String>()
            val methods = cached?.methods?.takeIf { it.isNotEmpty() } ?: fiberReadMethods.flatMap {
                listOf("FHNCAPIS:$it", "FHAPIS:$it", "FHTOOLAPIS:$it")
            }

            methods.forEach { methodSpec ->
                if (matched >= 8) return@forEach
                val apiKind = methodSpec.substringBefore(':', "FHAPIS")
                val method = methodSpec.substringAfter(':', methodSpec)
                try {
                    val response = fiberStatusApi(baseUrl, apiKind, method, activeSession, activeHeaders)
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

            val errorMessage = if (matched == 0) {
                val suffix = loginError.takeIf { it.isNotBlank() }?.let { "；登录提示：$it" } ?: ""
                "已连到设备，但未匹配到当前固件的只读状态接口$suffix"
            } else {
                JSONObject.NULL
            }
            if (matched == 0) {
                responses.put(
                    "_connection",
                    JSONObject()
                        .put("deviceReachable", true)
                        .put("session", "ok")
                        .put("message", errorMessage)
                )
            }

            JSONObject()
                .put("ok", true)
                .put("vendor", "firehome")
                .put("responses", responses)
                .put("warning", if (matched == 0) errorMessage else JSONObject.NULL)
                .put("error", JSONObject.NULL)
                .toString()
        } catch (error: Exception) {
            JSONObject()
                .put("ok", false)
                .put("error", error.message ?: error.javaClass.simpleName)
                .toString()
        }
    }

    private fun fiberLogin(
        baseUrl: String,
        session: FiberSession,
        username: String,
        password: String
    ): FiberLoginResult {
        if (username.isBlank() && password.isBlank()) {
            return FiberLoginResult(false, "未填写账号密码，已尝试免登录只读接口")
        }
        return try {
            val headers = fiberHeaders(session.sessionId, session.token, baseUrl)
            val payload = JSONObject()
                .put(
                    "dataObj",
                    JSONObject()
                        .put("username", username.ifBlank { "admin" })
                        .put("password", password)
                )
                .put("ajaxmethod", "DO_WEB_LOGIN")
                .put("sessionid", session.sessionId)
                .toString()
            val response = fiberHttp(
                "POST",
                "$baseUrl/api/sign/DO_WEB_LOGIN",
                fiberEncryptHex(payload, session.sessionId),
                headers
            )
            if (response.code >= 400) {
                FiberLoginResult(false, "HTTP ${response.code}")
            } else {
                val decoded = fiberDecryptOrPlain(response.body, session.sessionId)
                if (decoded.contains(Regex("fail|error|invalid|denied|password", RegexOption.IGNORE_CASE))) {
                    FiberLoginResult(false, decoded.take(160))
                } else {
                    FiberLoginResult(true, "")
                }
            }
        } catch (error: Exception) {
            FiberLoginResult(false, error.message ?: error.javaClass.simpleName)
        }
    }

    private fun readFiberHomeToolBaseInfo(host: String, username: String = "", password: String = ""): JSONObject? {
        val baseUrl = "http://$host"
        val headers = mapOf(
            "Accept" to "application/json,text/plain,*/*",
            "Accept-Encoding" to "gzip, deflate",
            "Accept-Language" to "zh-CN,en,*",
            "User-Agent" to "Mozilla/5.0",
            "Connection" to "Keep-Alive",
            "Cache-Control" to "no-cache"
        )
        // 先直接读状态；只有状态接口 timeout 且用户填了密码，才低频执行本地唤醒。
        readFiberHomeToolBaseInfoOnce(baseUrl, headers)?.let { return it }
        if (password.isNotBlank() && reserveFiberHomeToolWake(baseUrl)) {
            wakeFiberHomeToolApi(baseUrl, headers, username, password)
            readFiberHomeToolBaseInfoOnce(baseUrl, headers)?.let { return it }
        }
        return null
    }

    private fun reserveFiberHomeToolWake(baseUrl: String): Boolean {
        // 同一设备 10 分钟内最多唤醒一次，避免 app_do_login 被自动刷新反复调用。
        val now = System.currentTimeMillis()
        synchronized(fiberToolWakeTimes) {
            val lastWake = fiberToolWakeTimes[baseUrl] ?: 0L
            if (now - lastWake < fiberToolWakeCooldownMs) return false
            fiberToolWakeTimes[baseUrl] = now
            return true
        }
    }

    private fun readFiberHomeToolBaseInfoOnce(baseUrl: String, headers: Map<String, String>): JSONObject? {
        repeat(3) { attempt ->
            // 烽火主状态接口；新增字段优先在 assets/app.js 的 normalizeDevicePayload 里映射。
            val response = fiberHttp(
                "GET",
                "$baseUrl/api/tmp/FHTOOLAPIS?ajaxmethod=app_get_base_info",
                null,
                headers,
                timeoutMillis = 1200
            )
            if (response.code < 400 && response.body.isNotBlank()) {
                val body = response.body.trim()
                if (looksLikeStatusPayload(body)) {
                    return JSONObject()
                        .put("ok", true)
                        .put("vendor", "firehome")
                        .put(
                            "responses",
                            JSONObject().put("FHTOOLAPIS_app_get_base_info", jsonValue(body))
                        )
                        .put("warning", JSONObject.NULL)
                        .put("error", JSONObject.NULL)
                }
                if (!body.contains("\"timeout\"", ignoreCase = true)) return null
            }
            if (attempt < 2) Thread.sleep(80L)
        }
        return null
    }

    private fun wakeFiberHomeToolApi(
        baseUrl: String,
        headers: Map<String, String>,
        username: String,
        password: String
    ) {
        try {
            // 参考原版启动时的本地请求顺序，但有冷却时间保护，不会每秒重复登录。
            fiberHomeToolPost(baseUrl, headers, "app_get_login_status", JSONObject.NULL)
            val loginUsers = listOf(username.trim().ifBlank { "admin" }, "admin").distinct()
            val loggedIn = loginUsers.any { loginUser ->
                val response = fiberHomeToolPost(
                    baseUrl,
                    headers,
                    "app_do_login",
                    JSONObject()
                        .put("username", loginUser)
                        .put("password", password)
                )
                isFiberHomeToolLoginOk(response.body)
            }
            if (!loggedIn) {
                Log.d("CpeHidden", "tool wake login was not accepted")
                return
            }
            listOf("app_get_network_info", "app_get_lockband", "app_get_cell_list").forEach { method ->
                fiberHomeToolPost(baseUrl, headers, method, JSONObject.NULL)
            }
            fiberHttp(
                "GET",
                "$baseUrl/api/tmp/FHTOOLAPIS?ajaxmethod=app_get_airplane",
                null,
                headers,
                timeoutMillis = 1200
            )
        } catch (error: Exception) {
            Log.d("CpeHidden", "tool wake failed error=${error.javaClass.simpleName}")
        }
    }

    private fun isFiberHomeToolLoginOk(body: String): Boolean {
        val trimmed = body.trim()
        if (trimmed.isBlank()) return false
        return try {
            val json = JSONObject(trimmed)
            val timeout = json.optString("timeout").equals("true", ignoreCase = true)
            // 烽火本地接口登录成功字段通常是 login_result=0，不能只按通用 result 判断。
            val result = listOf("login_result", "result", "ret", "code")
                .firstNotNullOfOrNull { key -> json.optString(key).takeIf { it.isNotBlank() } }
            !timeout && (result == "0" || result.equals("success", ignoreCase = true))
        } catch (_: Exception) {
            !trimmed.contains(Regex("timeout|fail|error|password|denied", RegexOption.IGNORE_CASE))
        }
    }

    private fun fiberHomeToolPost(
        baseUrl: String,
        headers: Map<String, String>,
        ajaxMethod: String,
        dataObj: Any
    ): FiberResponse {
        val sessionResponse = fiberHttp(
            "GET",
            "$baseUrl/api/tmp/FHNCAPIS?ajaxmethod=get_refresh_sessionid",
            null,
            headers,
            timeoutMillis = 1200
        )
        val sessionId = JSONObject(sessionResponse.body).optString("sessionid")
        if (sessionId.isBlank()) throw IllegalStateException("empty sessionid")
        val payload = JSONObject()
            .put("dataObj", dataObj)
            .put("ajaxmethod", ajaxMethod)
            .put("sessionid", sessionId)
            .toString()
        return fiberHttp(
            "POST",
            "$baseUrl/api/tmp/FHTOOLAPIS",
            payload,
            headers + mapOf("Referer" to "$baseUrl/main.html"),
            timeoutMillis = 1200
        )
    }

    private fun fiberStatusApi(
        baseUrl: String,
        apiKind: String,
        method: String,
        session: FiberSession,
        headers: Map<String, String>
    ): FiberResponse {
        val payload = JSONObject()
            .put("dataObj", JSONObject())
            .put("ajaxmethod", method)
            .put("sessionid", session.sessionId)
            .toString()
        val encrypted = apiKind != "FHTOOLAPIS"
        return fiberHttp(
            "POST",
            "$baseUrl/api/tmp/$apiKind",
            if (encrypted) fiberEncryptHex(payload, session.sessionId) else payload,
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
        val cookieSession = response.header("Set-Cookie")
            .split(';')
            .firstOrNull { it.trim().startsWith("sessionid=", ignoreCase = true) }
            ?.substringAfter('=')
            .orEmpty()
        val effectiveSessionId = sessionId.ifBlank { cookieSession }
        if (effectiveSessionId.length < 16) error("烽火会话无效")
        val token = response.header("WebToken").ifBlank { headers["WebToken"].orEmpty() }
        return FiberSession(effectiveSessionId, token)
    }

    private fun fiberHeaders(
        sessionId: String,
        token: String,
        baseUrl: String = "http://192.168.8.1"
    ): Map<String, String> {
        return buildMap {
            put("Accept", "application/json,text/plain,*/*")
            put("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
            put("User-Agent", mobileChromeUserAgent)
            put("X-Requested-With", "XMLHttpRequest")
            put("Origin", baseUrl)
            put("Referer", "$baseUrl/")
            put("WebSession", sessionId)
            put("Cookie", "sessionid=$sessionId")
            if (token.isNotBlank()) put("WebToken", token)
        }
    }

    private fun fiberHttp(
        method: String,
        address: String,
        requestBody: String?,
        headers: Map<String, String>,
        timeoutMillis: Int = 3500
    ): FiberResponse {
        var connection: HttpURLConnection? = null
        return try {
            connection = (URL(address).openConnection() as HttpURLConnection).apply {
                connectTimeout = timeoutMillis
                readTimeout = timeoutMillis
                requestMethod = method
                useCaches = false
                headers.forEach { (key, value) -> setRequestProperty(key, value) }
                if (method == "POST") {
                    val bytes = requestBody.orEmpty().toByteArray(StandardCharsets.UTF_8)
                    doOutput = true
                    val looksEncrypted = requestBody.orEmpty().matches(Regex("[0-9a-fA-F]+"))
                    setRequestProperty(
                        "Content-Type",
                        if (looksEncrypted) "text/plain; charset=utf-8" else "application/json; charset=utf-8"
                    )
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
                "rsrp|rsrq|sinr|arfcn|earfcn|pci|cell|band|device|model|operator_name|product|lan_port|i18n|traffic|flow|wan|lte|nr|5g|imei|imsi|temperature|temp|version|signal|rate|tx|rx",
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

    private data class FiberLoginResult(val ok: Boolean, val error: String)

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
        "get_wan_state",
        "get_mobile_network_status",
        "get_mobile_network_info",
        "get_main_status",
        "get_main_info",
        "get_radio_status",
        "get_cell_info",
        "get_cell_status",
        "get_serving_cell",
        "get_neighbor_cell",
        "get_neighbor_cells",
        "get_nr_status",
        "get_nr_info",
        "get_lte_status",
        "get_lte_info",
        "get_signal_status",
        "get_signal_info",
        "get_modem_status",
        "get_modem_info",
        "get_wan_status",
        "get_wan_info",
        "get_statistics",
        "get_traffic_status",
        "get_flow_statistics",
        "get_sim_status",
        "get_current_network",
        "get_traffic_info",
        "get_device_base_info",
        "get_network_type",
        "get_lte_multi_ca_info",
        "get_nr_multi_ca_info"
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

    private fun readWifiGatewayJson(): String {
        return try {
            val wifi = applicationContext.getSystemService(WifiManager::class.java)
            val dhcp = wifi.dhcpInfo
            val gateway = ipv4FromLittleEndian(dhcp.gateway)
            val info = wifi.connectionInfo
            JSONObject()
                .put("ok", gateway != "0.0.0.0")
                .put("gateway", gateway)
                .put("ssid", info.ssid?.trim('"') ?: "")
                .toString()
        } catch (error: Exception) {
            JSONObject()
                .put("ok", false)
                .put("error", error.message ?: error.javaClass.simpleName)
                .toString()
        }
    }

    private fun ipv4FromLittleEndian(value: Int): String {
        return listOf(
            value and 255,
            value shr 8 and 255,
            value shr 16 and 255,
            value shr 24 and 255
        ).joinToString(".")
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
