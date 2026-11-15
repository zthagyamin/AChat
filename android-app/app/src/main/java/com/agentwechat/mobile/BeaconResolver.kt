package com.agentwechat.mobile

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

data class DecryptedBeaconPayload(
    val url: String,
    val lanUrl: String,
    val updatedAt: String
)

object BeaconResolver {
    const val BEACON_FILE_NAME = "agent-wechat-beacon.json"
    private const val KEY_DERIVATION_PREFIX = "agent-wechat-beacon-v1:"
    private const val GCM_TAG_BITS = 128
    private const val FETCH_TIMEOUT_MS = 4000
    private const val PUBLIC_PROBE_TIMEOUT_MS = 3000
    private const val LAN_PROBE_TIMEOUT_MS = 1500
    private const val USER_AGENT = "AChatAndroid/1.5"

    /**
     * Derives the 32-byte AES-256 key identically to Node.js `crypto.createHash('sha256')`.
     */
    fun deriveBeaconKey(token: String): ByteArray {
        val material = (KEY_DERIVATION_PREFIX + token.trim()).toByteArray(Charsets.UTF_8)
        return MessageDigest.getInstance("SHA-256").digest(material)
    }

    /**
     * Decrypts the `agent-wechat-beacon.json` AES-256-GCM envelope using the paired access token.
     */
    fun decryptBeaconEnvelope(envelopeJson: String, token: String): DecryptedBeaconPayload {
        require(token.isNotBlank()) { "Missing pairing token for beacon decryption" }

        val env = JSONObject(envelopeJson)
        val alg = env.optString("alg", "AES-256-GCM")
        require(alg.equals("AES-256-GCM", ignoreCase = true)) {
            "Unsupported beacon cipher algorithm: $alg"
        }

        val ivBase64 = env.optString("iv").trim()
        val ctBase64 = env.optString("ct").trim()
        require(ivBase64.isNotEmpty() && ctBase64.isNotEmpty()) {
            "Malformed beacon envelope: missing iv or ct"
        }

        val ivBytes = Base64.getMimeDecoder().decode(ivBase64)
        val cipherAndTagBytes = Base64.getMimeDecoder().decode(ctBase64)

        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        val secretKey = SecretKeySpec(deriveBeaconKey(token), "AES")
        val gcmSpec = GCMParameterSpec(GCM_TAG_BITS, ivBytes)
        cipher.init(Cipher.DECRYPT_MODE, secretKey, gcmSpec)

        val plainBytes = cipher.doFinal(cipherAndTagBytes)
        val plainObj = JSONObject(String(plainBytes, Charsets.UTF_8))

        return DecryptedBeaconPayload(
            url = plainObj.optString("url").trim(),
            lanUrl = plainObj.optString("lanUrl").trim(),
            updatedAt = plainObj.optString("updatedAt").trim()
        )
    }

    /**
     * Extracts the inner `agent-wechat-beacon.json` content string from a GitHub Gist API JSON response.
     */
    fun extractBeaconContentFromGistApi(gistApiBody: String): String? {
        return runCatching {
            val root = JSONObject(gistApiBody)
            val files = root.optJSONObject("files") ?: return null
            val targetFile = files.optJSONObject(BEACON_FILE_NAME) ?: return null
            val content = targetFile.optString("content").trim()
            content.ifEmpty { null }
        }.getOrNull()
    }

    /**
     * Fetches the encrypted beacon via GitHub Gist API (zero-cache primary) with Raw Gist fallback,
     * decrypts it locally, and probes the latest public tunnel URL (3000ms) then LAN URL (1500ms).
     */
    fun resolveLatestEndpoint(
        endpoint: ServerEndpoint,
        prober: (ServerEndpoint, Int) -> ProbeOutcome = ConnectionProber::probe,
        envelopeFetcher: (String) -> String? = ::fetchBeaconEnvelopeJson
    ): ServerEndpoint? {
        val cleanBeaconId = EndpointParser.sanitizeBeaconId(endpoint.beaconId)
        if (cleanBeaconId.isEmpty() || endpoint.token.isBlank()) return null

        val envelopeJson = envelopeFetcher(cleanBeaconId) ?: return null
        val payload = runCatching {
            decryptBeaconEnvelope(envelopeJson, endpoint.token)
        }.getOrNull() ?: return null

        // 1. Try latest public HTTPS tunnel URL first (3000ms timeout)
        if (payload.url.isNotBlank()) {
            val publicCandidate = buildCandidateEndpoint(endpoint, payload.url)
            if (publicCandidate != null) {
                val outcome = prober(publicCandidate, PUBLIC_PROBE_TIMEOUT_MS)
                if (outcome is ProbeOutcome.Authorized) {
                    return publicCandidate
                }
            }
        }

        // 2. Fallback to LAN URL if on the same Wi-Fi (1500ms timeout), keeping beaconId intact!
        if (payload.lanUrl.isNotBlank()) {
            val lanCandidate = buildCandidateEndpoint(endpoint, payload.lanUrl)
            if (lanCandidate != null) {
                val outcome = prober(lanCandidate, LAN_PROBE_TIMEOUT_MS)
                if (outcome is ProbeOutcome.Authorized) {
                    return lanCandidate
                }
            }
        }

        return null
    }

    internal fun buildCandidateEndpoint(
        original: ServerEndpoint,
        candidateRawUrl: String
    ): ServerEndpoint? {
        val parsed = EndpointParser.parseUriString(candidateRawUrl) ?: return null
        return original.copy(
            baseUrl = parsed.baseUrl,
            hostPort = parsed.hostPort,
            lastConnectedAt = System.currentTimeMillis()
        )
    }

    private fun fetchBeaconEnvelopeJson(beaconId: String): String? {
        // Channel 1: GitHub REST API (real-time, zero CDN cache)
        val apiUrl = "https://api.github.com/gists/$beaconId"
        val apiBody = httpGetText(
            urlStr = apiUrl,
            acceptHeader = "application/vnd.github+json"
        )
        if (!apiBody.isNullOrBlank()) {
            val extracted = extractBeaconContentFromGistApi(apiBody)
            if (!extracted.isNullOrBlank()) {
                return extracted
            }
        }

        // Channel 2: GitHub Raw fallback (with cache-busting query param against rate-limiting)
        val rawUrl = "https://gist.githubusercontent.com/raw/$beaconId/$BEACON_FILE_NAME?t=${System.currentTimeMillis()}"
        val rawBody = httpGetText(
            urlStr = rawUrl,
            acceptHeader = "application/json"
        )
        return rawBody?.trim()?.takeIf { it.startsWith("{") }
    }

    private fun httpGetText(urlStr: String, acceptHeader: String): String? {
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = FETCH_TIMEOUT_MS
                readTimeout = FETCH_TIMEOUT_MS
                instanceFollowRedirects = true
                useCaches = false
                setRequestProperty("Accept", acceptHeader)
                setRequestProperty("Cache-Control", "no-cache")
                setRequestProperty("Pragma", "no-cache")
                setRequestProperty("User-Agent", USER_AGENT)
            }
            if (conn.responseCode == 200) {
                conn.inputStream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }
            } else {
                null
            }
        } catch (_: Exception) {
            null
        } finally {
            conn?.disconnect()
        }
    }
}
