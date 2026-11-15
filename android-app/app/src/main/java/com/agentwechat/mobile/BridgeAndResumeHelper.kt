package com.agentwechat.mobile

import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.util.Base64
import java.util.Locale

data class FormattedAgentNotification(
    val title: String,
    val body: String
)

data class SystemBarThemeSpec(
    val isDark: Boolean,
    val darkStatusBarHex: String?,
    val darkNavigationBarHex: String?,
    val isAppearanceLightStatusBars: Boolean,
    val isAppearanceLightNavigationBars: Boolean
)

data class RawShareImageCandidate(
    val fileName: String?,
    val mimeType: String?,
    val declaredSizeBytes: Long = -1L,
    val openStream: () -> InputStream?
)

data class EncodedShareImage(
    val fileName: String,
    val mimeType: String,
    val dataBase64: String
)

sealed class SilentResumeResult {
    data object HealthyNoChange : SilentResumeResult()
    data class ReboundEndpoint(
        val endpoint: ServerEndpoint,
        val shouldReloadWebView: Boolean
    ) : SilentResumeResult()
    data class RecoveredExisting(val endpoint: ServerEndpoint) : SilentResumeResult()
    data class TokenUnauthorized(val endpoint: ServerEndpoint, val message: String) : SilentResumeResult()
    data class StillUnreachableSilent(val reason: String) : SilentResumeResult()
}

object BridgeAndResumeHelper {
    const val APP_VERSION = "1.5.0"
    const val NOTIFICATION_CHANNEL_ID = "achat_agent_replies"
    const val NOTIFICATION_CHANNEL_NAME = "Agent 消息提醒"
    const val MAX_SNIPPET_CHARS = 120
    const val RESUME_SILENT_PROBE_THRESHOLD_MS = 8000L
    const val RESUME_SILENT_PROBE_TIMEOUT_MS = 2200
    const val USER_AGENT_TAG = "AChatAndroid/1.5"
    const val DARK_STATUS_BAR_HEX = "#0F1622"
    const val DARK_NAV_BAR_HEX = "#0D1117"
    const val RESUME_DISPATCH_JS = "window.dispatchEvent(new CustomEvent('achat-resume'));"
    const val SHARE_READY_DISPATCH_JS = "window.dispatchEvent(new CustomEvent('achat-share-ready'));"

    const val MAX_SHARED_IMAGES = 4
    const val MAX_SHARED_IMAGE_BYTES = 6 * 1024 * 1024

    private val unsafeFileNameChars = Regex("""[^\w.\-\u4e00-\u9fa5 ()]""")

    fun shouldDeliverAgentNotification(
        isActivityInForeground: Boolean,
        isPermissionGranted: Boolean,
        areSystemNotificationsEnabled: Boolean = true
    ): Boolean {
        return !isActivityInForeground && isPermissionGranted && areSystemNotificationsEnabled
    }

    fun formatAgentNotification(
        groupTitle: String?,
        senderName: String?,
        snippet: String?
    ): FormattedAgentNotification {
        val cleanSender = senderName?.trim().orEmpty().ifEmpty { "Agent" }
        val cleanGroup = groupTitle?.trim().orEmpty().ifEmpty { "AChat" }
        val cleanBody = snippet?.trim().orEmpty().take(MAX_SNIPPET_CHARS).ifEmpty { "收到一条新消息" }
        return FormattedAgentNotification(
            title = "$cleanSender · $cleanGroup",
            body = cleanBody
        )
    }

    fun resolveSystemBarTheme(isDark: Boolean): SystemBarThemeSpec {
        return if (isDark) {
            SystemBarThemeSpec(
                isDark = true,
                darkStatusBarHex = DARK_STATUS_BAR_HEX,
                darkNavigationBarHex = DARK_NAV_BAR_HEX,
                isAppearanceLightStatusBars = false,
                isAppearanceLightNavigationBars = false
            )
        } else {
            SystemBarThemeSpec(
                isDark = false,
                darkStatusBarHex = null,
                darkNavigationBarHex = null,
                isAppearanceLightStatusBars = true,
                isAppearanceLightNavigationBars = true
            )
        }
    }

    fun shouldTriggerSilentResumeProbe(
        hasActiveEndpoint: Boolean,
        isOnboardingVisible: Boolean,
        hasMainFrameError: Boolean,
        lastPauseAtMs: Long,
        nowMs: Long
    ): Boolean {
        if (!hasActiveEndpoint || isOnboardingVisible) return false
        if (hasMainFrameError) return true
        if (lastPauseAtMs <= 0L) return false
        return (nowMs - lastPauseAtMs) > RESUME_SILENT_PROBE_THRESHOLD_MS
    }

    fun performSilentResumeProbe(
        target: ServerEndpoint,
        hasMainFrameError: Boolean,
        prober: (ServerEndpoint, Int) -> ProbeOutcome = ConnectionProber::probe,
        beaconResolver: (ServerEndpoint) -> ServerEndpoint? = { BeaconResolver.resolveLatestEndpoint(it) }
    ): SilentResumeResult {
        return when (val outcome = prober(target, RESUME_SILENT_PROBE_TIMEOUT_MS)) {
            is ProbeOutcome.Authorized -> {
                if (hasMainFrameError) {
                    SilentResumeResult.RecoveredExisting(target)
                } else {
                    SilentResumeResult.HealthyNoChange
                }
            }
            is ProbeOutcome.Unauthorized -> {
                SilentResumeResult.TokenUnauthorized(target, outcome.message)
            }
            is ProbeOutcome.Unreachable -> {
                if (target.beaconId.isNotBlank()) {
                    val resolved = beaconResolver(target)
                    if (resolved != null) {
                        val endpointChanged = !resolved.baseUrl.equals(target.baseUrl, ignoreCase = true) ||
                            resolved.token != target.token
                        return SilentResumeResult.ReboundEndpoint(
                            endpoint = resolved,
                            shouldReloadWebView = endpointChanged || hasMainFrameError
                        )
                    }
                }
                SilentResumeResult.StillUnreachableSilent(outcome.reason)
            }
        }
    }

    /**
     * Merges Intent.EXTRA_SUBJECT and Intent.EXTRA_TEXT without repeating EXTRA_SUBJECT when
     * EXTRA_TEXT already starts with it.
     */
    fun mergeSharedText(subject: String?, text: String?): String {
        val cleanSubject = subject?.trim().orEmpty()
        val cleanText = text?.trim().orEmpty()
        return when {
            cleanSubject.isEmpty() -> cleanText
            cleanText.isEmpty() -> cleanSubject
            cleanText.startsWith(cleanSubject, ignoreCase = true) -> cleanText
            else -> "$cleanSubject\n$cleanText"
        }
    }

    /**
     * Reads at most [maxBytes] from [input]; immediately aborts and returns null if the stream
     * exceeds [maxBytes] so oversized files cannot spike heap memory.
     */
    fun readBoundedBytes(input: InputStream, maxBytes: Int = MAX_SHARED_IMAGE_BYTES): ByteArray? {
        val out = ByteArrayOutputStream()
        val buf = ByteArray(8192)
        var total = 0
        while (true) {
            val read = input.read(buf)
            if (read < 0) break
            total += read
            if (total > maxBytes) {
                return null
            }
            out.write(buf, 0, read)
        }
        return out.toByteArray()
    }

    fun collectEncodedShareImages(
        candidates: List<RawShareImageCandidate>,
        maxCount: Int = MAX_SHARED_IMAGES,
        maxBytes: Int = MAX_SHARED_IMAGE_BYTES
    ): List<EncodedShareImage> {
        if (candidates.isEmpty() || maxCount <= 0) return emptyList()
        val results = ArrayList<EncodedShareImage>(maxCount)

        for (candidate in candidates) {
            if (results.size >= maxCount) break
            if (candidate.declaredSizeBytes > maxBytes) continue

            val rawBytes = runCatching {
                candidate.openStream()?.use { stream ->
                    readBoundedBytes(stream, maxBytes)
                }
            }.getOrNull() ?: continue

            if (rawBytes.isEmpty()) continue

            val mimeType = normalizeImageMimeType(candidate.mimeType)
            val safeName = sanitizeSharedFileName(
                rawName = candidate.fileName,
                fallbackIndex = results.size + 1,
                mimeType = mimeType
            )
            // RFC 4648 Basic Base64 encoder (no line breaks, identical to Base64.NO_WRAP)
            val encodedB64 = Base64.getEncoder().encodeToString(rawBytes)
            results.add(
                EncodedShareImage(
                    fileName = safeName,
                    mimeType = mimeType,
                    dataBase64 = encodedB64
                )
            )
        }
        return results
    }

    fun serializePendingShareJson(text: String, images: List<EncodedShareImage>): String {
        val cleanText = text.trim()
        if (cleanText.isEmpty() && images.isEmpty()) return ""

        val imagesArray = JSONArray()
        for (img in images) {
            imagesArray.put(
                JSONObject().apply {
                    put("fileName", img.fileName)
                    put("mimeType", img.mimeType)
                    put("dataBase64", img.dataBase64)
                }
            )
        }

        return JSONObject().apply {
            put("text", cleanText)
            put("images", imagesArray)
        }.toString()
    }

    fun consumeAtomically(
        lock: Any,
        getter: () -> String,
        setter: (String) -> Unit
    ): String {
        synchronized(lock) {
            val current = getter()
            if (current.isNotEmpty()) {
                setter("")
            }
            return current
        }
    }

    private fun normalizeImageMimeType(rawMime: String?): String {
        val candidate = rawMime?.trim()?.lowercase(Locale.ROOT).orEmpty()
        return if (candidate.startsWith("image/") && candidate != "image/*") {
            candidate
        } else {
            "image/jpeg"
        }
    }

    private fun sanitizeSharedFileName(rawName: String?, fallbackIndex: Int, mimeType: String): String {
        val base = rawName
            ?.substringAfterLast('/')
            ?.substringAfterLast('\\')
            ?.replace(unsafeFileNameChars, "_")
            ?.trim('_', ' ', '.')
            .orEmpty()
        if (base.isNotEmpty()) {
            return base.take(96)
        }
        val ext = when (mimeType) {
            "image/png" -> "png"
            "image/webp" -> "webp"
            "image/gif" -> "gif"
            "image/bmp" -> "bmp"
            "image/svg+xml" -> "svg"
            else -> "jpg"
        }
        return "shared-$fallbackIndex.$ext"
    }
}
