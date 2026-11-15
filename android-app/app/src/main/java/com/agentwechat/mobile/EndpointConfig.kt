package com.agentwechat.mobile

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder
import java.util.Locale

data class ServerEndpoint(
    val baseUrl: String,
    val hostPort: String,
    val token: String,
    val label: String,
    val beaconId: String = "",
    val lastConnectedAt: Long = System.currentTimeMillis()
) {
    fun buildEntryUrl(): String {
        return if (token.isNotBlank()) {
            "$baseUrl/?token=${EndpointParser.encodeQueryComponent(token)}"
        } else {
            "$baseUrl/"
        }
    }

    fun buildProbeUrl(): String {
        return if (token.isNotBlank()) {
            "$baseUrl/api/session?token=${EndpointParser.encodeQueryComponent(token)}"
        } else {
            "$baseUrl/api/session"
        }
    }
}

data class ParsedPairInput(
    val baseUrl: String,
    val hostPort: String,
    val token: String,
    val suggestedLabel: String,
    val beaconId: String = ""
)

object EndpointParser {
    private const val DEFAULT_PORT = 8866
    private val urlRegex = Regex("""https?://[^\s"'<>]+""", RegexOption.IGNORE_CASE)
    private val hostPortRegex = Regex(
        """^([a-zA-Z0-9.-]+|\[[0-9a-fA-F:]+\])(?::(\d{1,5}))?(/.*)?$"""
    )
    private val beaconIdRegex = Regex("""^[a-fA-F0-9]{20,40}$""")

    fun sanitizeBeaconId(raw: String?): String {
        val candidate = raw?.trim().orEmpty()
        return if (beaconIdRegex.matches(candidate)) candidate.lowercase(Locale.ROOT) else ""
    }

    fun encodeQueryComponent(value: String): String {
        return URLEncoder.encode(value, Charsets.UTF_8.name()).replace("+", "%20")
    }

    private fun decodeQueryComponent(value: String): String {
        return runCatching {
            URLDecoder.decode(value.replace("+", "%2B"), Charsets.UTF_8.name())
        }.getOrDefault(value)
    }

    private fun parseQueryParams(rawQuery: String?): Map<String, String> {
        if (rawQuery.isNullOrBlank()) return emptyMap()
        val out = LinkedHashMap<String, String>()
        for (pair in rawQuery.split('&')) {
            if (pair.isBlank()) continue
            val eqIdx = pair.indexOf('=')
            if (eqIdx > 0) {
                val key = decodeQueryComponent(pair.substring(0, eqIdx).trim())
                val value = decodeQueryComponent(pair.substring(eqIdx + 1).trim())
                if (key.isNotEmpty() && !out.containsKey(key)) {
                    out[key] = value
                }
            }
        }
        return out
    }

    fun isTunnelHost(host: String): Boolean {
        val h = host.lowercase(Locale.ROOT)
        return h.endsWith(".lhr.life") ||
            h.endsWith(".trycloudflare.com") ||
            h.endsWith(".ngrok-free.app")
    }

    fun suggestLabelForHost(host: String, hasBeacon: Boolean = false): String {
        val h = host.lowercase(Locale.ROOT)
        return when {
            isTunnelHost(h) -> if (hasBeacon) "异地远程自动寻址" else "异地远程直连"
            h.startsWith("100.") || h.contains("tailscale") || h.endsWith(".ts.net") -> "Tailscale 异地远程"
            h.startsWith("192.168.") || h.startsWith("10.") -> "家里 / 局域网 Wi-Fi"
            h.startsWith("172.") -> "局域网连接"
            h == "127.0.0.1" || h == "localhost" -> "本机调试"
            else -> "电脑端 ($host)"
        }
    }

    /**
     * Extracts pairing URL or host:port + token + optional beaconId from arbitrary clipboard or input text.
     */
    fun parseFromRawText(raw: String): ParsedPairInput? {
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) return null

        // Case 1: achat://connect?url=... or legacy agentwechat://connect?url=...
        if (
            trimmed.startsWith("achat://", ignoreCase = true) ||
            trimmed.startsWith("agentwechat://", ignoreCase = true)
        ) {
            val deepUri = runCatching { URI(trimmed) }.getOrNull()
            val deepParams = parseQueryParams(deepUri?.rawQuery)
            val outerBeacon = sanitizeBeaconId(deepParams["beacon"])
            val nestedUrl = deepParams["url"]
            if (!nestedUrl.isNullOrBlank()) {
                val inner = parseFromRawText(nestedUrl) ?: return null
                val mergedBeacon = inner.beaconId.ifBlank { outerBeacon }
                val host = runCatching { URI(inner.baseUrl).host.orEmpty() }.getOrDefault("")
                val updatedLabel = if (mergedBeacon.isNotBlank() && inner.beaconId.isBlank() && host.isNotEmpty()) {
                    suggestLabelForHost(host, hasBeacon = true)
                } else {
                    inner.suggestedLabel
                }
                return inner.copy(beaconId = mergedBeacon, suggestedLabel = updatedLabel)
            }
            val hostParam = deepParams["host"]
            if (!hostParam.isNullOrBlank()) {
                val tok = deepParams["token"].orEmpty()
                val schemePrefix = if (
                    hostParam.startsWith("http://", ignoreCase = true) ||
                    hostParam.startsWith("https://", ignoreCase = true)
                ) {
                    hostParam
                } else {
                    "http://$hostParam"
                }
                val querySuffix = buildString {
                    append("/?token=")
                    append(encodeQueryComponent(tok))
                    if (outerBeacon.isNotBlank()) {
                        append("&beacon=")
                        append(outerBeacon)
                    }
                }
                return parseUriString("$schemePrefix$querySuffix")
            }
        }

        // Case 2: Contains full http(s):// URL anywhere in the text
        val urlMatch = urlRegex.find(trimmed)?.value?.trimEnd(',', ';', ')', ']', '。', '！')
        if (urlMatch != null) {
            return parseUriString(urlMatch)
        }

        // Case 3: Bare IP or host[:port][/?token=...]
        val firstLine = trimmed.lineSequence().firstOrNull()?.trim().orEmpty()
        if (hostPortRegex.matches(firstLine)) {
            return parseUriString("http://$firstLine")
        }

        return null
    }

    internal fun parseUriString(urlStr: String): ParsedPairInput? {
        val uri = runCatching { URI(urlStr.trim()) }.getOrNull() ?: return null
        val scheme = (uri.scheme ?: "http").lowercase(Locale.ROOT)
        if (scheme != "http" && scheme != "https") return null

        val host = uri.host?.trim().orEmpty()
        if (host.isEmpty()) return null

        val explicitPort = uri.port
        val port = if (explicitPort in 1..65535) {
            explicitPort
        } else if (scheme == "https") {
            443
        } else {
            DEFAULT_PORT
        }

        val hostPort = if ((scheme == "http" && port == 80) || (scheme == "https" && port == 443)) {
            host
        } else {
            "$host:$port"
        }

        val baseUrl = "$scheme://$hostPort"
        val queryParams = parseQueryParams(uri.rawQuery)
        val token = queryParams["token"].orEmpty().trim()
        val beaconId = sanitizeBeaconId(queryParams["beacon"])

        return ParsedPairInput(
            baseUrl = baseUrl,
            hostPort = if (scheme == "https") "$scheme://$hostPort" else hostPort,
            token = token,
            suggestedLabel = suggestLabelForHost(host, hasBeacon = beaconId.isNotBlank()),
            beaconId = beaconId
        )
    }

    fun composeEndpoint(
        hostOrUrlInput: String,
        tokenInput: String,
        labelInput: String,
        beaconIdInput: String = ""
    ): Result<ServerEndpoint> {
        val cleanHostInput = hostOrUrlInput.trim()
        if (cleanHostInput.isEmpty()) {
            return Result.failure(IllegalArgumentException("请填写电脑端 IP 地址或粘贴完整配对链接"))
        }

        val candidateUrl = if (
            cleanHostInput.startsWith("http://", ignoreCase = true) ||
            cleanHostInput.startsWith("https://", ignoreCase = true)
        ) {
            cleanHostInput
        } else {
            "http://$cleanHostInput"
        }

        val parsed = parseUriString(candidateUrl)
            ?: return Result.failure(IllegalArgumentException("地址格式不正确，示例：192.168.1.73:8866"))

        val finalToken = tokenInput.trim().ifEmpty { parsed.token }
        val finalBeaconId = sanitizeBeaconId(beaconIdInput).ifEmpty { parsed.beaconId }
        val host = runCatching { URI(parsed.baseUrl).host.orEmpty() }.getOrDefault("")
        val defaultLabel = if (host.isNotEmpty()) {
            suggestLabelForHost(host, hasBeacon = finalBeaconId.isNotBlank())
        } else {
            parsed.suggestedLabel
        }
        val finalLabel = labelInput.trim().ifEmpty { defaultLabel }

        return Result.success(
            ServerEndpoint(
                baseUrl = parsed.baseUrl,
                hostPort = parsed.hostPort,
                token = finalToken,
                label = finalLabel,
                beaconId = finalBeaconId,
                lastConnectedAt = System.currentTimeMillis()
            )
        )
    }

    /**
     * Deduplicates saved endpoints by baseUrl AND (when non-blank) by beaconId so rotated tunnel
     * domains never pile up stale entries in history.
     */
    fun mergeEndpointIntoHistory(
        existing: List<ServerEndpoint>,
        incoming: ServerEndpoint,
        maxHistory: Int = 15
    ): List<ServerEndpoint> {
        val filtered = existing.filterNot { item ->
            item.baseUrl.equals(incoming.baseUrl, ignoreCase = true) ||
                (incoming.beaconId.isNotBlank() && item.beaconId.equals(incoming.beaconId, ignoreCase = true))
        }
        return (listOf(incoming) + filtered).take(maxHistory)
    }
}

class ServerConfigStore(context: Context) {
    private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun getActiveEndpoint(): ServerEndpoint? {
        val activeBase = prefs.getString(KEY_ACTIVE_BASE_URL, null) ?: return null
        val all = getSavedEndpoints()
        return all.firstOrNull { it.baseUrl.equals(activeBase, ignoreCase = true) } ?: all.firstOrNull()
    }

    fun getSavedEndpoints(): List<ServerEndpoint> {
        val raw = prefs.getString(KEY_ENDPOINTS_JSON, null) ?: return emptyList()
        return runCatching {
            val arr = JSONArray(raw)
            buildList {
                for (i in 0 until arr.length()) {
                    val obj = arr.optJSONObject(i) ?: continue
                    val baseUrl = obj.optString("baseUrl").trim()
                    if (baseUrl.isEmpty()) continue
                    add(
                        ServerEndpoint(
                            baseUrl = baseUrl,
                            hostPort = obj.optString("hostPort").ifBlank {
                                baseUrl.removePrefix("http://")
                            },
                            token = obj.optString("token"),
                            label = obj.optString("label").ifBlank { "AChat 服务器" },
                            beaconId = EndpointParser.sanitizeBeaconId(obj.optString("beaconId", "")),
                            lastConnectedAt = obj.optLong("lastConnectedAt", 0L)
                        )
                    )
                }
            }.sortedByDescending { it.lastConnectedAt }
        }.getOrDefault(emptyList())
    }

    fun saveAndActivate(endpoint: ServerEndpoint) {
        val updated = endpoint.copy(lastConnectedAt = System.currentTimeMillis())
        val merged = EndpointParser.mergeEndpointIntoHistory(
            existing = getSavedEndpoints(),
            incoming = updated,
            maxHistory = MAX_HISTORY
        )
        writeEndpoints(merged)
        prefs.edit().putString(KEY_ACTIVE_BASE_URL, updated.baseUrl).apply()
    }

    fun deleteEndpoint(baseUrl: String) {
        val remaining = getSavedEndpoints().filterNot {
            it.baseUrl.equals(baseUrl, ignoreCase = true)
        }
        writeEndpoints(remaining)
        val curActive = prefs.getString(KEY_ACTIVE_BASE_URL, null)
        if (curActive != null && curActive.equals(baseUrl, ignoreCase = true)) {
            prefs.edit().putString(KEY_ACTIVE_BASE_URL, remaining.firstOrNull()?.baseUrl).apply()
        }
    }

    var pillMarginTopDp: Int
        get() = prefs.getInt(KEY_PILL_TOP_DP, 52)
        set(value) {
            prefs.edit().putInt(KEY_PILL_TOP_DP, value.coerceIn(8, 620)).apply()
        }

    var notificationPermissionPrompted: Boolean
        get() = prefs.getBoolean(KEY_NOTIF_PROMPTED, false)
        set(value) {
            prefs.edit().putBoolean(KEY_NOTIF_PROMPTED, value).apply()
        }

    private fun writeEndpoints(list: List<ServerEndpoint>) {
        val arr = JSONArray()
        for (ep in list) {
            arr.put(
                JSONObject().apply {
                    put("baseUrl", ep.baseUrl)
                    put("hostPort", ep.hostPort)
                    put("token", ep.token)
                    put("label", ep.label)
                    put("beaconId", ep.beaconId)
                    put("lastConnectedAt", ep.lastConnectedAt)
                }
            )
        }
        prefs.edit().putString(KEY_ENDPOINTS_JSON, arr.toString()).apply()
    }

    companion object {
        private const val PREFS_NAME = "agent_wechat_mobile_store"
        private const val KEY_ACTIVE_BASE_URL = "active_base_url"
        private const val KEY_ENDPOINTS_JSON = "saved_endpoints_json"
        private const val KEY_PILL_TOP_DP = "pill_margin_top_dp"
        private const val KEY_NOTIF_PROMPTED = "notif_perm_prompted_v1"
        private const val MAX_HISTORY = 15
    }
}
