package com.agentwechat.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class V14BridgeAndResumeTest {

    private val sampleToken = "test_dummy_token_0123456789abcdef01234567"
    private val sampleBeaconId = "a1b2c3d4e5f60718293a4b5c6d7e8f90"

    @Test
    fun `formatAgentNotification builds sender-group title and truncates snippet to 120 chars`() {
        val longSnippet = "A".repeat(150)
        val formatted = BridgeAndResumeHelper.formatAgentNotification(
            groupTitle = "核心研发群",
            senderName = "Codex",
            snippet = longSnippet
        )
        assertEquals("Codex · 核心研发群", formatted.title)
        assertEquals(120, formatted.body.length)
        assertEquals("A".repeat(120), formatted.body)

        // Null or blank inputs fall back cleanly without crashing JavaBridge
        val fallback = BridgeAndResumeHelper.formatAgentNotification(
            groupTitle = "   ",
            senderName = null,
            snippet = ""
        )
        assertEquals("Agent · AChat", fallback.title)
        assertEquals("收到一条新消息", fallback.body)
    }

    @Test
    fun `shouldDeliverAgentNotification only allows background state with granted permission`() {
        // Foreground -> never notify
        assertFalse(
            BridgeAndResumeHelper.shouldDeliverAgentNotification(
                isActivityInForeground = true,
                isPermissionGranted = true,
                areSystemNotificationsEnabled = true
            )
        )
        // Background + permission granted + system enabled -> notify
        assertTrue(
            BridgeAndResumeHelper.shouldDeliverAgentNotification(
                isActivityInForeground = false,
                isPermissionGranted = true,
                areSystemNotificationsEnabled = true
            )
        )
        // Background without permission -> do not notify
        assertFalse(
            BridgeAndResumeHelper.shouldDeliverAgentNotification(
                isActivityInForeground = false,
                isPermissionGranted = false,
                areSystemNotificationsEnabled = true
            )
        )
    }

    @Test
    fun `resolveSystemBarTheme returns obsidian dark colors or restores light bar appearance`() {
        val darkSpec = BridgeAndResumeHelper.resolveSystemBarTheme(isDark = true)
        assertTrue(darkSpec.isDark)
        assertEquals("#0F1622", darkSpec.darkStatusBarHex)
        assertEquals("#0D1117", darkSpec.darkNavigationBarHex)
        assertFalse(darkSpec.isAppearanceLightStatusBars)
        assertFalse(darkSpec.isAppearanceLightNavigationBars)

        val lightSpec = BridgeAndResumeHelper.resolveSystemBarTheme(isDark = false)
        assertFalse(lightSpec.isDark)
        assertEquals(null, lightSpec.darkStatusBarHex)
        assertEquals(null, lightSpec.darkNavigationBarHex)
        assertTrue(lightSpec.isAppearanceLightStatusBars)
        assertTrue(lightSpec.isAppearanceLightNavigationBars)
    }

    @Test
    fun `shouldTriggerSilentResumeProbe respects 8000ms background threshold, cold start, and main-frame error`() {
        // Cold start (lastPauseAtMs == 0) without error -> false
        assertFalse(
            BridgeAndResumeHelper.shouldTriggerSilentResumeProbe(
                hasActiveEndpoint = true,
                isOnboardingVisible = false,
                hasMainFrameError = false,
                lastPauseAtMs = 0L,
                nowMs = 1_700_000_000_000L
            )
        )

        // Short pause (5000ms <= 8000ms) without error -> false
        assertFalse(
            BridgeAndResumeHelper.shouldTriggerSilentResumeProbe(
                hasActiveEndpoint = true,
                isOnboardingVisible = false,
                hasMainFrameError = false,
                lastPauseAtMs = 10_000L,
                nowMs = 15_000L
            )
        )

        // Pause > 8000ms -> true
        assertTrue(
            BridgeAndResumeHelper.shouldTriggerSilentResumeProbe(
                hasActiveEndpoint = true,
                isOnboardingVisible = false,
                hasMainFrameError = false,
                lastPauseAtMs = 10_000L,
                nowMs = 18_001L
            )
        )

        // Short pause with mainFrameError -> true
        assertTrue(
            BridgeAndResumeHelper.shouldTriggerSilentResumeProbe(
                hasActiveEndpoint = true,
                isOnboardingVisible = false,
                hasMainFrameError = true,
                lastPauseAtMs = 10_000L,
                nowMs = 11_000L
            )
        )

        // Onboarding visible -> false
        assertFalse(
            BridgeAndResumeHelper.shouldTriggerSilentResumeProbe(
                hasActiveEndpoint = true,
                isOnboardingVisible = true,
                hasMainFrameError = true,
                lastPauseAtMs = 10_000L,
                nowMs = 30_000L
            )
        )
    }

    @Test
    fun `performSilentResumeProbe silently rebinds rotated tunnel via beacon when primary probe is unreachable`() {
        val staleTunnel = ServerEndpoint(
            baseUrl = "https://stale-node.lhr.life",
            hostPort = "https://stale-node.lhr.life",
            token = sampleToken,
            label = "异地远程自动寻址",
            beaconId = sampleBeaconId
        )
        val rotatedTunnel = staleTunnel.copy(
            baseUrl = "https://fresh-node.lhr.life",
            hostPort = "https://fresh-node.lhr.life"
        )

        var capturedTimeoutMs = -1
        val result = BridgeAndResumeHelper.performSilentResumeProbe(
            target = staleTunnel,
            hasMainFrameError = false,
            prober = { _, timeoutMs ->
                capturedTimeoutMs = timeoutMs
                ProbeOutcome.Unreachable("tunnel rotated")
            },
            beaconResolver = { ep ->
                assertEquals(sampleBeaconId, ep.beaconId)
                rotatedTunnel
            }
        )

        assertEquals(2200, capturedTimeoutMs)
        assertTrue(result is SilentResumeResult.ReboundEndpoint)
        val rebound = result as SilentResumeResult.ReboundEndpoint
        assertEquals("https://fresh-node.lhr.life", rebound.endpoint.baseUrl)
        assertTrue(rebound.shouldReloadWebView)
    }

    @Test
    fun `performSilentResumeProbe stays silent when unreachable without rotated beacon and recovers when authorized`() {
        val lanEndpoint = ServerEndpoint(
            baseUrl = "http://192.168.1.73:8866",
            hostPort = "192.168.1.73:8866",
            token = sampleToken,
            label = "家里 Wi-Fi",
            beaconId = ""
        )

        val unreachableResult = BridgeAndResumeHelper.performSilentResumeProbe(
            target = lanEndpoint,
            hasMainFrameError = false,
            prober = { _, _ -> ProbeOutcome.Unreachable("transient") },
            beaconResolver = { null }
        )
        assertTrue(unreachableResult is SilentResumeResult.StillUnreachableSilent)

        val healthyResult = BridgeAndResumeHelper.performSilentResumeProbe(
            target = lanEndpoint,
            hasMainFrameError = false,
            prober = { _, _ -> ProbeOutcome.Authorized },
            beaconResolver = { null }
        )
        assertEquals(SilentResumeResult.HealthyNoChange, healthyResult)

        val recoveredResult = BridgeAndResumeHelper.performSilentResumeProbe(
            target = lanEndpoint,
            hasMainFrameError = true,
            prober = { _, _ -> ProbeOutcome.Authorized },
            beaconResolver = { null }
        )
        assertTrue(recoveredResult is SilentResumeResult.RecoveredExisting)
    }
}
