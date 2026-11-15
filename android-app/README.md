# AChat · Android 原生客户端 (`com.agentwechat.mobile`, v1.5.0)

配合电脑端「AChat · AgentChat 多智能体协作平台」（默认端口 `8866`）使用的原生 Android 客户端工程。

## 核心能力
- **Android 系统级双向分享与触感联动（v1.5.0）**：
  - **系统分享面板直接分享至 AChat**：支持从任意 App 通过系统分享发送文本、网页链接、单张或多张图片（`ACTION_SEND` / `ACTION_SEND_MULTIPLE`，最多 4 张 ≤ 6MB 图片），经 `achat-share-ready` 事件与 `AndroidBridge.consumePendingShare()` 原子投递至当前会话。
  - **向外原生分享与轻触觉反馈**：支持 `AndroidBridge.shareTextOut(title, text)` 呼出系统分享面板导出摘要/笔记，以及 `AndroidBridge.triggerHaptic()` 原生轻触觉反馈。
- **`window.AndroidBridge` 原生深度桥接（v1.4.0–v1.5.0）**：
  - `notifyAgentReply(groupTitle, senderName, snippet)`：App 处于后台时通过 `achat_agent_replies` 渠道推送系统通知，点击直达当前会话；Android 13+ 配对进入主页后温和申请一次通知权限。
  - `syncTheme(isDark)`：前端深浅色模式与系统状态栏（`#0F1622` / `#F1F5F9`）、导航栏（`#0D1117` / `#F1F5F9`）及图标反色实时联动。
  - `openServerSwitcher()` / `getAppVersion()`：支持前端顶栏直接呼出原生多机切换菜单及读取客户端版本（`1.5.0`）。
- **切后台回前台秒级静默重连与隧道换绑**：`onResume` 即刻派发 `achat-resume` 事件唤醒前端增量拉取；后台停留超过 8 秒或主框架异常时自动静默探测并在隧道轮换后通过加密云信标无感换绑。
- **双协议 Deep Link 与原位平滑升级**：同时兼容 `achat://connect?url=...` 与旧版 `agentwechat://connect?url=...`；保持 `com.agentwechat.mobile` 包名与同一本地签名证书，直接原位覆盖升级并完整继承已存配对与信标记录。

## 本地构建命令
```powershell
$env:JAVA_HOME = '<PATH_TO_JDK21>'
$env:ANDROID_HOME = '<PATH_TO_ANDROID_SDK>'
$env:ANDROID_SDK_ROOT = '<PATH_TO_ANDROID_SDK>'
# Optional on Windows if repo path contains non-ASCII characters:
# $env:ACHAT_ANDROID_BUILD_CACHE = '<OPTIONAL_ASCII_BUILD_CACHE_DIR>'
.\gradlew.bat testDebugUnitTest assembleRelease --no-daemon
```
说明：若本地未提供 `keystore/keystore.properties`，`app/build.gradle.kts` 会自动回退到 Android debug 签名以完成构建。
签名发布产物默认输出至 `app/build/outputs/apk/release/`。
