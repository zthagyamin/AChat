package com.agentwechat.mobile

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.util.Base64

class V15ShareAndBridgeTest {

    @Test
    fun `v1_5 bridge constants expose AChatAndroid 1_5 UA, version 1_5_0, and share-ready event JS`() {
        assertEquals("AChatAndroid/1.5", BridgeAndResumeHelper.USER_AGENT_TAG)
        assertEquals("1.5.0", BridgeAndResumeHelper.APP_VERSION)
        assertEquals(
            "window.dispatchEvent(new CustomEvent('achat-share-ready'));",
            BridgeAndResumeHelper.SHARE_READY_DISPATCH_JS
        )
    }

    @Test
    fun `mergeSharedText combines subject and text cleanly and avoids duplicate subject prefix`() {
        // Distinct subject and body -> joined with newline
        assertEquals(
            "技术周报\nhttps://example.com/weekly",
            BridgeAndResumeHelper.mergeSharedText("  技术周报 ", " https://example.com/weekly ")
        )

        // Body already starts with subject (case-insensitive) -> no duplicate prefix
        assertEquals(
            "AChat Architecture Notes - https://example.com/doc",
            BridgeAndResumeHelper.mergeSharedText(
                "achat architecture notes",
                "AChat Architecture Notes - https://example.com/doc"
            )
        )

        // Missing subject or missing body
        assertEquals("仅正文内容", BridgeAndResumeHelper.mergeSharedText(null, "仅正文内容"))
        assertEquals("仅标题内容", BridgeAndResumeHelper.mergeSharedText("仅标题内容", "   "))
        assertEquals("", BridgeAndResumeHelper.mergeSharedText(null, null))
    }

    @Test
    fun `collectEncodedShareImages enforces max 4 images and 6MB size guardrail with safe defaults`() {
        val maxBytes = BridgeAndResumeHelper.MAX_SHARED_IMAGE_BYTES // 6 * 1024 * 1024
        assertEquals(6 * 1024 * 1024, maxBytes)

        // Exact 6MB stream passes readBoundedBytes; 6MB + 1 fails
        val exact6Mb = ByteArray(maxBytes) { 0x2A }
        val exactRead = BridgeAndResumeHelper.readBoundedBytes(ByteArrayInputStream(exact6Mb), maxBytes)
        assertEquals(maxBytes, exactRead?.size)

        val over6Mb = ByteArray(maxBytes + 1) { 0x2A }
        val overRead = BridgeAndResumeHelper.readBoundedBytes(ByteArrayInputStream(over6Mb), maxBytes)
        assertNull(overRead)

        // Build 6 candidates: 1 oversized via declaredSize, 1 oversized via stream, and 5 valid -> keeps first 4 valid
        val sampleBytes = "hello-image".toByteArray(Charsets.UTF_8)
        val candidates = listOf(
            RawShareImageCandidate(
                fileName = "too-big-declared.png",
                mimeType = "image/png",
                declaredSizeBytes = maxBytes + 100L,
                openStream = { ByteArrayInputStream(sampleBytes) }
            ),
            RawShareImageCandidate(
                fileName = null,
                mimeType = null, // defaults to image/jpeg and shared-1.jpg
                openStream = { ByteArrayInputStream(sampleBytes) }
            ),
            RawShareImageCandidate(
                fileName = "too-big-stream.jpg",
                mimeType = "image/jpeg",
                openStream = { ByteArrayInputStream(over6Mb) }
            ),
            RawShareImageCandidate(
                fileName = "../unsafe/path/diagram.png",
                mimeType = "image/png",
                openStream = { ByteArrayInputStream(sampleBytes) }
            ),
            RawShareImageCandidate(
                fileName = "shot3.webp",
                mimeType = "image/webp",
                openStream = { ByteArrayInputStream(sampleBytes) }
            ),
            RawShareImageCandidate(
                fileName = "shot4.gif",
                mimeType = "image/gif",
                openStream = { ByteArrayInputStream(sampleBytes) }
            ),
            RawShareImageCandidate(
                fileName = "fifth-valid-should-be-dropped.jpg",
                mimeType = "image/jpeg",
                openStream = { ByteArrayInputStream(sampleBytes) }
            )
        )

        val encoded = BridgeAndResumeHelper.collectEncodedShareImages(candidates)
        assertEquals(4, encoded.size)
        assertEquals("shared-1.jpg", encoded[0].fileName)
        assertEquals("image/jpeg", encoded[0].mimeType)
        assertEquals(Base64.getEncoder().encodeToString(sampleBytes), encoded[0].dataBase64)
        assertTrue(!encoded[0].dataBase64.contains("\n"))

        assertEquals("diagram.png", encoded[1].fileName)
        assertEquals("image/png", encoded[1].mimeType)
        assertEquals("shot3.webp", encoded[2].fileName)
        assertEquals("shot4.gif", encoded[3].fileName)
    }

    @Test
    fun `serializePendingShareJson and consumeAtomically match contract and clear after single read`() {
        val sampleBytes = byteArrayOf(1, 2, 3, 4)
        val expectedB64 = Base64.getEncoder().encodeToString(sampleBytes)
        val jsonStr = BridgeAndResumeHelper.serializePendingShareJson(
            text = "分享摘要\nhttps://achat.local/item",
            images = listOf(
                EncodedShareImage(
                    fileName = "shared-1.jpg",
                    mimeType = "image/jpeg",
                    dataBase64 = expectedB64
                )
            )
        )

        val parsed = JSONObject(jsonStr)
        assertEquals("分享摘要\nhttps://achat.local/item", parsed.getString("text"))
        val imagesArr = parsed.getJSONArray("images")
        assertEquals(1, imagesArr.length())
        val img0 = imagesArr.getJSONObject(0)
        assertEquals("shared-1.jpg", img0.getString("fileName"))
        assertEquals("image/jpeg", img0.getString("mimeType"))
        assertEquals(expectedB64, img0.getString("dataBase64"))

        // Empty text + empty images -> empty string (not queued)
        assertEquals("", BridgeAndResumeHelper.serializePendingShareJson("   ", emptyList()))

        // Atomic single-consume verification
        val lock = Any()
        var holder = jsonStr
        val firstConsume = BridgeAndResumeHelper.consumeAtomically(lock, { holder }, { holder = it })
        val secondConsume = BridgeAndResumeHelper.consumeAtomically(lock, { holder }, { holder = it })
        assertEquals(jsonStr, firstConsume)
        assertEquals("", secondConsume)
        assertEquals("", holder)
    }
}
