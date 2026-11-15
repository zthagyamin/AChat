package com.agentwechat.mobile

import android.webkit.CookieManager
import org.json.JSONObject
import java.net.ConnectException
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.net.UnknownHostException

sealed class ProbeOutcome {
    data object Authorized : ProbeOutcome()
    data class Unauthorized(val message: String) : ProbeOutcome()
    data class Unreachable(val reason: String) : ProbeOutcome()
}

object ConnectionProber {
    fun probe(endpoint: ServerEndpoint, timeoutMs: Int = 2600): ProbeOutcome {
        var conn: HttpURLConnection? = null
        return try {
            val url = URL(endpoint.buildProbeUrl())
            conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = timeoutMs
                readTimeout = timeoutMs
                instanceFollowRedirects = true
                useCaches = false
                setRequestProperty("Accept", "application/json")
                setRequestProperty("Cache-Control", "no-cache")
                val savedCookie = runCatching {
                    CookieManager.getInstance().getCookie(endpoint.baseUrl)
                }.getOrNull()
                if (!savedCookie.isNullOrBlank()) {
                    setRequestProperty("Cookie", savedCookie)
                }
            }

            val code = conn.responseCode
            val body = runCatching {
                val stream = if (code in 200..399) conn.inputStream else conn.errorStream
                stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
            }.getOrDefault("")

            return classifyResponse(code, body)
        } catch (_: SocketTimeoutException) {
            ProbeOutcome.Unreachable("连接超时：请确认电脑已启动 AChat，且网络畅通。")
        } catch (_: ConnectException) {
            ProbeOutcome.Unreachable("连接被拒绝 (ERR_CONNECTION_REFUSED)：电脑端服务可能尚未启动或地址已变更。")
        } catch (_: UnknownHostException) {
            ProbeOutcome.Unreachable("无法解析主机地址：隧道域名可能已轮换或当前网络未就绪。")
        } catch (e: Exception) {
            ProbeOutcome.Unreachable("网络不可达：${e.javaClass.simpleName}")
        } finally {
            conn?.disconnect()
        }
    }

    internal fun classifyResponse(code: Int, body: String): ProbeOutcome {
        return when {
            code == 200 -> {
                val json = runCatching { JSONObject(body) }.getOrNull()
                if (json != null && json.has("authorized")) {
                    if (json.optBoolean("authorized", false)) {
                        ProbeOutcome.Authorized
                    } else {
                        ProbeOutcome.Unauthorized(
                            "已连通电脑端，但访问口令 (Token) 无效或未填写。请粘贴电脑端「手机连接」中的完整配对链接。"
                        )
                    }
                } else {
                    // Expired tunnel landing pages (e.g. *.lhr.life HTML) return 200 without JSON {"authorized":...}
                    ProbeOutcome.Unreachable("隧道域名已轮换或网关未就绪")
                }
            }
            code == 401 || code == 403 -> {
                ProbeOutcome.Unauthorized("访问口令 (Token) 校验未通过 (HTTP $code)，请重新复制电脑端配对链接。")
            }
            else -> ProbeOutcome.Unreachable("隧道域名已轮换或服务暂不可用 (HTTP $code)")
        }
    }
}
