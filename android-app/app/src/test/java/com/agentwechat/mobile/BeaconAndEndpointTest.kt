package com.agentwechat.mobile

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

class BeaconAndEndpointTest {

    private val sampleToken = "test_dummy_token_0123456789abcdef01234567"
    private val sampleBeaconId = "a1b2c3d4e5f60718293a4b5c6d7e8f90"

    private fun encryptLikeNodeServer(
        plainJson: String,
        token: String,
        ivBytes: ByteArray = ByteArray(12).also { SecureRandom().nextBytes(it) }
    ): String {
        val keyBytes = MessageDigest.getInstance("SHA-256")
            .digest(("agent-wechat-beacon-v1:" + token.trim()).toByteArray(Charsets.UTF_8))
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.ENCRYPT_MODE,
            SecretKeySpec(keyBytes, "AES"),
            GCMParameterSpec(128, ivBytes)
        )
        // JCE AES/GCM/NoPadding outputs (ciphertext || 16-byte authTag), matching Node concat(enc, tag)
        val ctAndTag = cipher.doFinal(plainJson.toByteArray(Charsets.UTF_8))

        return JSONObject().apply {
            put("v", 1)
            put("alg", "AES-256-GCM")
            put("iv", Base64.getEncoder().encodeToString(ivBytes))
            put("ct", Base64.getEncoder().encodeToString(ctAndTag))
            put("ts", 1793928600000L)
        }.toString()
    }

    @Test
    fun `decryptBeaconEnvelope decrypts AES-256-GCM payload accurately and rejects wrong token`() {
        val expectedPlain = JSONObject().apply {
            put("v", 1)
            put("url", "https://fresh-tunnel-99.lhr.life")
            put("lanUrl", "http://192.168.1.73:8866")
            put("updatedAt", "2026-11-06T01:30:00Z")
        }.toString()

        val envelope = encryptLikeNodeServer(expectedPlain, sampleToken)
        val decrypted = BeaconResolver.decryptBeaconEnvelope(envelope, "  $sampleToken  ")

        assertEquals("https://fresh-tunnel-99.lhr.life", decrypted.url)
        assertEquals("http://192.168.1.73:8866", decrypted.lanUrl)
        assertEquals("2026-11-06T01:30:00Z", decrypted.updatedAt)

        // Wrong token must fail GCM authentication tag verification
        try {
            BeaconResolver.decryptBeaconEnvelope(envelope, "wrong_token_value_abcdef123456")
            fail("Expected AEADBadTagException when decrypting with wrong token")
        } catch (_: Exception) {
            // Expected authentication failure
        }
    }

    @Test
    fun `extractBeaconContentFromGistApi extracts inner agent-wechat-beacon json`() {
        val innerContent = """{"v":1,"alg":"AES-256-GCM","iv":"AAAA","ct":"BBBB","ts":123}"""
        val gistApiMock = JSONObject().apply {
            put(
                "files",
                JSONObject().apply {
                    put(
                        "agent-wechat-beacon.json",
                        JSONObject().apply {
                            put("filename", "agent-wechat-beacon.json")
                            put("content", innerContent)
                        }
                    )
                }
            )
        }.toString()

        val extracted = BeaconResolver.extractBeaconContentFromGistApi(gistApiMock)
        assertEquals(innerContent, extracted)
        assertNull(BeaconResolver.extractBeaconContentFromGistApi("""{"files":{}}"""))
    }

    @Test
    fun `EndpointParser extracts valid beacon query param, suggests auto-routing label, and ignores malformed beacon`() {
        val rawClipboard =
            "手机远程配对链接：https://old-node.lhr.life/?token=$sampleToken&beacon=$sampleBeaconId。"
        val parsed = EndpointParser.parseFromRawText(rawClipboard)
        assertNotNull(parsed)
        assertEquals("https://old-node.lhr.life", parsed!!.baseUrl)
        assertEquals("https://old-node.lhr.life", parsed.hostPort)
        assertEquals(sampleToken, parsed.token)
        assertEquals(sampleBeaconId, parsed.beaconId)
        assertEquals("异地远程自动寻址", parsed.suggestedLabel)

        // Cloudflare tunnel without beacon -> direct remote label
        val noBeaconParsed = EndpointParser.parseFromRawText("https://demo.trycloudflare.com/?token=$sampleToken&beacon=not-hex!")
        assertNotNull(noBeaconParsed)
        assertEquals("", noBeaconParsed!!.beaconId)
        assertEquals("异地远程直连", noBeaconParsed.suggestedLabel)

        // Nested achat:// and legacy agentwechat:// deep links both preserve beaconId
        val encodedUrl = EndpointParser.encodeQueryComponent(
            "https://sub.ngrok-free.app/?token=$sampleToken&beacon=$sampleBeaconId"
        )
        val achatDeepParsed = EndpointParser.parseFromRawText("achat://connect?url=$encodedUrl")
        assertNotNull(achatDeepParsed)
        assertEquals("https://sub.ngrok-free.app", achatDeepParsed!!.baseUrl)
        assertEquals(sampleToken, achatDeepParsed.token)
        assertEquals(sampleBeaconId, achatDeepParsed.beaconId)
        assertEquals("异地远程自动寻址", achatDeepParsed.suggestedLabel)

        val achatDirectHostParsed = EndpointParser.parseFromRawText(
            "achat://connect?host=https://edge.lhr.life&token=$sampleToken&beacon=$sampleBeaconId"
        )
        assertNotNull(achatDirectHostParsed)
        assertEquals("https://edge.lhr.life", achatDirectHostParsed!!.baseUrl)
        assertEquals(sampleBeaconId, achatDirectHostParsed.beaconId)

        val legacyDeepParsed = EndpointParser.parseFromRawText("agentwechat://connect?url=$encodedUrl")
        assertNotNull(legacyDeepParsed)
        assertEquals(sampleBeaconId, legacyDeepParsed!!.beaconId)
        assertEquals("异地远程自动寻址", legacyDeepParsed.suggestedLabel)
    }

    @Test
    fun `mergeEndpointIntoHistory deduplicates rotated tunnel domains sharing the same beaconId`() {
        val lanEndpoint = ServerEndpoint(
            baseUrl = "http://192.168.1.73:8866",
            hostPort = "192.168.1.73:8866",
            token = sampleToken,
            label = "家里 Wi-Fi",
            beaconId = "",
            lastConnectedAt = 1000L
        )
        val oldTunnel = ServerEndpoint(
            baseUrl = "https://stale-tunnel-1.lhr.life",
            hostPort = "https://stale-tunnel-1.lhr.life",
            token = sampleToken,
            label = "异地远程自动寻址",
            beaconId = sampleBeaconId,
            lastConnectedAt = 2000L
        )
        val rotatedTunnel = ServerEndpoint(
            baseUrl = "https://new-tunnel-2.lhr.life",
            hostPort = "https://new-tunnel-2.lhr.life",
            token = sampleToken,
            label = "异地远程自动寻址",
            beaconId = sampleBeaconId,
            lastConnectedAt = 3000L
        )

        val merged = EndpointParser.mergeEndpointIntoHistory(
            existing = listOf(oldTunnel, lanEndpoint),
            incoming = rotatedTunnel
        )

        // Old tunnel with identical beaconId must be replaced, while LAN entry stays intact
        assertEquals(2, merged.size)
        assertEquals("https://new-tunnel-2.lhr.life", merged[0].baseUrl)
        assertEquals(sampleBeaconId, merged[0].beaconId)
        assertEquals("http://192.168.1.73:8866", merged[1].baseUrl)
        assertTrue(merged.none { it.baseUrl.contains("stale-tunnel-1") })
    }

    @Test
    fun `ConnectionProber rejects 200 HTML landing pages and accepts valid authorized session JSON`() {
        val htmlFalsePositive = ConnectionProber.classifyResponse(200, "<!doctype html><html>Tunnel not found</html>")
        assertTrue(htmlFalsePositive is ProbeOutcome.Unreachable)

        val unauthJson = ConnectionProber.classifyResponse(200, """{"authorized":false,"isLocal":false}""")
        assertTrue(unauthJson is ProbeOutcome.Unauthorized)

        val validJson = ConnectionProber.classifyResponse(200, """{"authorized":true,"isLocal":false}""")
        assertTrue(validJson is ProbeOutcome.Authorized)
    }

    @Test
    fun `resolveLatestEndpoint probes public URL first and falls back to LAN URL while preserving beaconId`() {
        val staleEndpoint = ServerEndpoint(
            baseUrl = "https://expired-01.lhr.life",
            hostPort = "https://expired-01.lhr.life",
            token = sampleToken,
            label = "异地远程自动寻址",
            beaconId = sampleBeaconId
        )
        val plainBeacon = JSONObject().apply {
            put("v", 1)
            put("url", "https://live-02.lhr.life")
            put("lanUrl", "http://192.168.1.73:8866")
            put("updatedAt", "2026-11-06T01:35:00Z")
        }.toString()
        val encryptedEnvelope = encryptLikeNodeServer(plainBeacon, sampleToken)

        // Scenario A: Public tunnel is reachable -> switches to live-02.lhr.life
        val resolvedPublic = BeaconResolver.resolveLatestEndpoint(
            endpoint = staleEndpoint,
            prober = { candidate, _ ->
                if (candidate.baseUrl == "https://live-02.lhr.life") ProbeOutcome.Authorized
                else ProbeOutcome.Unreachable("down")
            },
            envelopeFetcher = { encryptedEnvelope }
        )
        assertNotNull(resolvedPublic)
        assertEquals("https://live-02.lhr.life", resolvedPublic!!.baseUrl)
        assertEquals(sampleBeaconId, resolvedPublic.beaconId)
        assertEquals(sampleToken, resolvedPublic.token)

        // Scenario B: Public tunnel unreachable, LAN reachable -> switches to LAN and preserves beaconId
        val resolvedLan = BeaconResolver.resolveLatestEndpoint(
            endpoint = staleEndpoint,
            prober = { candidate, _ ->
                if (candidate.baseUrl == "http://192.168.1.73:8866") ProbeOutcome.Authorized
                else ProbeOutcome.Unreachable("public blocked")
            },
            envelopeFetcher = { encryptedEnvelope }
        )
        assertNotNull(resolvedLan)
        assertEquals("http://192.168.1.73:8866", resolvedLan!!.baseUrl)
        assertEquals("192.168.1.73:8866", resolvedLan.hostPort)
        assertEquals(sampleBeaconId, resolvedLan.beaconId)
    }
}
