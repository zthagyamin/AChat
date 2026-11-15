package com.agentwechat.mobile

import android.Manifest
import android.annotation.SuppressLint
import android.app.DownloadManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.view.HapticFeedbackConstants
import android.view.LayoutInflater
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.inputmethod.InputMethodManager
import android.webkit.CookieManager
import android.webkit.DownloadListener
import android.webkit.JavascriptInterface
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.content.IntentCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.agentwechat.mobile.databinding.ActivityMainBinding
import com.agentwechat.mobile.databinding.ItemSavedEndpointBinding
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.abs
import kotlin.math.max

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var configStore: ServerConfigStore
    private lateinit var shakeDetector: ShakeDetector

    private val mainHandler = Handler(Looper.getMainLooper())
    private val ioExecutor = Executors.newSingleThreadExecutor()

    private var activeEndpoint: ServerEndpoint? = null
    private var hasMainFrameError = false
    private var isAutoProbing = false
    private var probeAttemptCount = 0
    private var suppressUrlWatcher = false
    private var isTokenVisible = false
    private var pillHiddenForSession = false
    private var currentEditingBeaconId: String = ""
    private var currentEditingHostPort: String = ""

    @Volatile
    private var isActivityInForeground: Boolean = false
    private var lastPauseAtMs: Long = 0L

    @Volatile
    private var isSilentResumeProbing: Boolean = false
    private var isWebThemeDark: Boolean = false
    private var hasLoadedActiveWebPage: Boolean = false
    private var quickServerDialog: AlertDialog? = null
    private val notificationSeq = AtomicInteger(0)

    private val shareLock = Any()

    @Volatile
    private var pendingShareJson: String = ""

    private var fileUploadCallback: ValueCallback<Array<Uri>>? = null
    private var pendingCameraPhotoUri: Uri? = null

    private val notificationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) {
        // Gentle one-time permission prompt on Android 13+: never block normal usage if declined.
    }

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val callback = fileUploadCallback
        fileUploadCallback = null
        val cameraUri = pendingCameraPhotoUri
        pendingCameraPhotoUri = null

        if (callback == null) return@registerForActivityResult

        if (result.resultCode != RESULT_OK) {
            callback.onReceiveValue(null)
            return@registerForActivityResult
        }

        val data = result.data
        val selectedUris = mutableListOf<Uri>()

        if (data != null) {
            val clipData = data.clipData
            if (clipData != null && clipData.itemCount > 0) {
                for (i in 0 until clipData.itemCount) {
                    clipData.getItemAt(i)?.uri?.let { selectedUris.add(it) }
                }
            } else {
                data.data?.let { selectedUris.add(it) }
            }
        }

        if (selectedUris.isEmpty() && cameraUri != null) {
            selectedUris.add(cameraUri)
        }

        callback.onReceiveValue(
            if (selectedUris.isNotEmpty()) selectedUris.toTypedArray() else null
        )
    }

    private val autoReconnectRunnable = object : Runnable {
        override fun run() {
            if (!isAutoProbing || !hasMainFrameError) return
            val target = activeEndpoint ?: return
            probeAttemptCount += 1
            binding.offlineAutoProbeText.text = "正在后台每 4 秒自动探测重连…（第 $probeAttemptCount 次）"

            ioExecutor.execute {
                val outcome = ConnectionProber.probe(target, timeoutMs = 2300)
                val resolvedViaBeacon = if (outcome is ProbeOutcome.Unreachable && target.beaconId.isNotBlank()) {
                    BeaconResolver.resolveLatestEndpoint(target)
                } else {
                    null
                }

                mainHandler.post {
                    if (!isFinishing && !isDestroyed && hasMainFrameError) {
                        if (resolvedViaBeacon != null) {
                            stopAutoReconnectProbe()
                            hasMainFrameError = false
                            configStore.saveAndActivate(resolvedViaBeacon)
                            activeEndpoint = resolvedViaBeacon
                            binding.offlineOverlay.visibility = View.GONE
                            Toast.makeText(this@MainActivity, "已自动同步最新远程通道", Toast.LENGTH_SHORT).show()
                            loadEndpointIntoWebView(resolvedViaBeacon)
                            return@post
                        }

                        when (outcome) {
                            is ProbeOutcome.Authorized -> {
                                stopAutoReconnectProbe()
                                hasMainFrameError = false
                                binding.offlineOverlay.visibility = View.GONE
                                Toast.makeText(this@MainActivity, "连接已恢复", Toast.LENGTH_SHORT).show()
                                loadEndpointIntoWebView(target)
                            }
                            is ProbeOutcome.Unauthorized -> {
                                stopAutoReconnectProbe()
                                showOnboarding(
                                    prefill = target,
                                    statusMessage = outcome.message
                                )
                            }
                            is ProbeOutcome.Unreachable -> {
                                if (isAutoProbing) {
                                    mainHandler.postDelayed(this, RECONNECT_INTERVAL_MS)
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        configStore = ServerConfigStore(this)
        shakeDetector = ShakeDetector(this) {
            if (binding.onboardingOverlay.visibility != View.VISIBLE && activeEndpoint != null) {
                showQuickServerMenu()
            }
        }

        ensureAgentReplyNotificationChannel()
        setupImmersiveBarsAndKeyboardInsets()
        setupWebView()
        setupOnboardingControls()
        setupOfflineControls()
        setupFloatingPill()
        setupBackNavigation()

        // Handle inbound Android system share (ACTION_SEND / ACTION_SEND_MULTIPLE)
        ingestInboundShareIntentIfNeeded(intent)

        // Handle deep link if launched via achat://connect or agentwechat://connect
        val deepLinkInput = extractDeepLinkEndpoint(intent)
        if (deepLinkInput != null) {
            showOnboarding(prefill = deepLinkInput, autoTriggerConnect = true)
            return
        }

        // Zero-config launch if an endpoint was already paired previously
        val savedActive = configStore.getActiveEndpoint()
        if (savedActive != null) {
            activeEndpoint = savedActive
            binding.onboardingOverlay.visibility = View.GONE
            updateFloatingPillVisibility()

            if (savedActive.beaconId.isNotBlank()) {
                launchWithBeaconFastCheck(savedActive)
            } else {
                loadEndpointIntoWebView(savedActive)
            }
        } else {
            showOnboarding(prefill = null)
        }
    }

    private fun launchWithBeaconFastCheck(savedActive: ServerEndpoint) {
        binding.offlineOverlay.visibility = View.GONE
        binding.topProgressBar.visibility = View.VISIBLE
        binding.topProgressBar.progress = 25

        ioExecutor.execute {
            val fastOutcome = ConnectionProber.probe(savedActive, timeoutMs = 1800)
            val resolvedViaBeacon = if (fastOutcome is ProbeOutcome.Unreachable) {
                BeaconResolver.resolveLatestEndpoint(savedActive)
            } else {
                null
            }

            mainHandler.post {
                if (isFinishing || isDestroyed) return@post

                if (resolvedViaBeacon != null) {
                    configStore.saveAndActivate(resolvedViaBeacon)
                    activeEndpoint = resolvedViaBeacon
                    Toast.makeText(this, "已自动同步最新远程通道", Toast.LENGTH_SHORT).show()
                    loadEndpointIntoWebView(resolvedViaBeacon)
                    return@post
                }

                when (fastOutcome) {
                    is ProbeOutcome.Authorized -> {
                        loadEndpointIntoWebView(savedActive)
                    }
                    is ProbeOutcome.Unauthorized -> {
                        binding.topProgressBar.visibility = View.GONE
                        showOnboarding(prefill = savedActive, statusMessage = fastOutcome.message)
                    }
                    is ProbeOutcome.Unreachable -> {
                        binding.topProgressBar.visibility = View.GONE
                        triggerOfflineOverlay(fastOutcome.reason)
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val deepLinkInput = extractDeepLinkEndpoint(intent)
        if (deepLinkInput != null) {
            setIntent(Intent(this, MainActivity::class.java).setAction(Intent.ACTION_MAIN))
            showOnboarding(prefill = deepLinkInput, autoTriggerConnect = true)
            return
        }
        if (ingestInboundShareIntentIfNeeded(intent)) {
            return
        }
        setIntent(intent)
    }

    override fun onStart() {
        super.onStart()
        if (hasMainFrameError && activeEndpoint != null && binding.offlineOverlay.visibility == View.VISIBLE) {
            startAutoReconnectProbe()
        }
    }

    override fun onResume() {
        super.onResume()
        val previousPauseAtMs = lastPauseAtMs
        isActivityInForeground = true
        shakeDetector.start()

        if (activeEndpoint != null && binding.onboardingOverlay.visibility != View.VISIBLE) {
            (getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager)?.cancelAll()
            handleForegroundResumeReconnect(previousPauseAtMs)
        }
    }

    override fun onPause() {
        isActivityInForeground = false
        lastPauseAtMs = System.currentTimeMillis()
        shakeDetector.stop()
        CookieManager.getInstance().flush()
        super.onPause()
    }

    override fun onStop() {
        isActivityInForeground = false
        stopAutoReconnectProbe()
        super.onStop()
    }

    override fun onDestroy() {
        quickServerDialog?.dismiss()
        quickServerDialog = null
        stopAutoReconnectProbe()
        ioExecutor.shutdownNow()
        binding.webView.removeJavascriptInterface("AndroidBridge")
        binding.webView.destroy()
        super.onDestroy()
    }

    private fun setupImmersiveBarsAndKeyboardInsets() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        applySystemBarTheme(isDark = false)

        // Resize root padding dynamically when IME (soft keyboard) opens so bottom composer is never covered
        ViewCompat.setOnApplyWindowInsetsListener(binding.rootContainer) { view, windowInsets ->
            val sysBars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars())
            val imeInsets = windowInsets.getInsets(WindowInsetsCompat.Type.ime())
            val bottomInset = max(sysBars.bottom, imeInsets.bottom)
            view.setPadding(sysBars.left, sysBars.top, sysBars.right, bottomInset)
            WindowInsetsCompat.CONSUMED
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        val cookieManager = CookieManager.getInstance()
        cookieManager.setAcceptCookie(true)
        cookieManager.setAcceptThirdPartyCookies(binding.webView, true)

        @Suppress("DEPRECATION")
        binding.webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            allowFileAccess = true
            allowContentAccess = true
            loadsImagesAutomatically = true
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            cacheMode = WebSettings.LOAD_DEFAULT
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            useWideViewPort = true
            loadWithOverviewMode = true
            textZoom = 100
            userAgentString = "$userAgentString ${BridgeAndResumeHelper.USER_AGENT_TAG}"
        }

        binding.webView.addJavascriptInterface(AndroidJsBridge(), "AndroidBridge")

        binding.webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                super.onPageStarted(view, url, favicon)
                binding.topProgressBar.visibility = View.VISIBLE
                binding.topProgressBar.progress = 15
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                binding.topProgressBar.visibility = View.GONE
                CookieManager.getInstance().flush()

                if (!hasMainFrameError && url != null && !url.startsWith("about:")) {
                    hasLoadedActiveWebPage = true
                    binding.offlineOverlay.visibility = View.GONE
                    stopAutoReconnectProbe()
                    if (pendingShareJson.isNotEmpty()) {
                        binding.webView.evaluateJavascript(BridgeAndResumeHelper.SHARE_READY_DISPATCH_JS, null)
                    }
                }
            }

            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val uri = request?.url ?: return false
                val scheme = uri.scheme?.lowercase(Locale.ROOT).orEmpty()

                if (scheme == "achat" || scheme == "agentwechat") {
                    val parsed = EndpointParser.parseFromRawText(uri.toString())
                    if (parsed != null) {
                        val ep = ServerEndpoint(
                            baseUrl = parsed.baseUrl,
                            hostPort = parsed.hostPort,
                            token = parsed.token,
                            label = parsed.suggestedLabel,
                            beaconId = parsed.beaconId
                        )
                        showOnboarding(prefill = ep, autoTriggerConnect = true)
                    }
                    return true
                }

                if (scheme != "http" && scheme != "https") {
                    openExternalUri(uri)
                    return true
                }

                val currentEp = activeEndpoint
                if (currentEp != null && isSameOrigin(uri, Uri.parse(currentEp.baseUrl))) {
                    // Downloadable binary extensions should go to system downloader/browser
                    val pathLower = uri.path?.lowercase(Locale.ROOT).orEmpty()
                    if (pathLower.endsWith(".apk") || pathLower.endsWith(".zip")) {
                        enqueueOrOpenDownload(uri.toString(), null, null)
                        return true
                    }
                    return false
                }

                // External web links open cleanly in system browser
                openExternalUri(uri)
                return true
            }

            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: WebResourceError?
            ) {
                super.onReceivedError(view, request, error)
                if (request?.isForMainFrame == true) {
                    val desc = error?.description?.toString().orEmpty()
                    val code = error?.errorCode ?: -1
                    // Ignore harmless user-initiated cancellation
                    if (code == ERROR_CONNECT ||
                        code == ERROR_HOST_LOOKUP ||
                        code == ERROR_TIMEOUT ||
                        code == ERROR_IO ||
                        code == ERROR_UNKNOWN ||
                        desc.contains("ERR_", ignoreCase = true)
                    ) {
                        triggerOfflineOverlay("网络异常 ($desc)")
                    }
                }
            }
        }

        binding.webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                if (newProgress in 1..99) {
                    binding.topProgressBar.visibility = View.VISIBLE
                    binding.topProgressBar.progress = newProgress
                } else {
                    binding.topProgressBar.visibility = View.GONE
                }
            }

            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                // Cancel any stale callback to avoid locking WebView file input
                fileUploadCallback?.onReceiveValue(null)
                fileUploadCallback = filePathCallback

                val acceptTypes = fileChooserParams?.acceptTypes
                    ?.filter { it.isNotBlank() }
                    .orEmpty()
                val allowMultiple = fileChooserParams?.mode == FileChooserParams.MODE_OPEN_MULTIPLE

                val cameraIntent = createCameraCaptureIntent()
                val contentIntent = Intent(Intent.ACTION_GET_CONTENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = if (acceptTypes.size == 1 && acceptTypes[0].contains("/")) {
                        acceptTypes[0]
                    } else {
                        "*/*"
                    }
                    if (acceptTypes.size > 1) {
                        putExtra(Intent.EXTRA_MIME_TYPES, acceptTypes.toTypedArray())
                    }
                    putExtra(Intent.EXTRA_ALLOW_MULTIPLE, allowMultiple)
                }

                val chooser = Intent.createChooser(contentIntent, "选择图片、拍照或上传附件").apply {
                    if (cameraIntent != null) {
                        putExtra(Intent.EXTRA_INITIAL_INTENTS, arrayOf(cameraIntent))
                    }
                }

                return try {
                    fileChooserLauncher.launch(chooser)
                    true
                } catch (_: Exception) {
                    fileUploadCallback?.onReceiveValue(null)
                    fileUploadCallback = null
                    pendingCameraPhotoUri = null
                    Toast.makeText(this@MainActivity, "无法打开系统文件选择器", Toast.LENGTH_SHORT).show()
                    false
                }
            }
        }

        // System Downloader / Browser handling for downloads (.apk, exports, etc.)
        binding.webView.setDownloadListener(
            DownloadListener { url, userAgent, contentDisposition, mimetype, _ ->
                if (url.isNullOrBlank()) return@DownloadListener
                enqueueOrOpenDownload(url, userAgent, contentDisposition, mimetype)
            }
        )

        // Long-press image / link support
        binding.webView.setOnLongClickListener {
            val hit = binding.webView.hitTestResult
            val extra = hit.extra
            if (!extra.isNullOrBlank() && (
                    hit.type == WebView.HitTestResult.IMAGE_TYPE ||
                        hit.type == WebView.HitTestResult.SRC_IMAGE_ANCHOR_TYPE
                    )
            ) {
                showImageActionDialog(extra)
                true
            } else {
                false
            }
        }
    }

    private fun setupOnboardingControls() {
        binding.btnCloseOnboarding.setOnClickListener {
            if (activeEndpoint != null) {
                hideKeyboard()
                binding.onboardingOverlay.visibility = View.GONE
                applySystemBarTheme(isWebThemeDark)
                updateFloatingPillVisibility()
            }
        }

        binding.btnPasteClipboard.setOnClickListener {
            pasteAndParseFromClipboard()
        }

        binding.inputFullPairUrl.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
            override fun afterTextChanged(s: Editable?) {
                if (suppressUrlWatcher) return
                val text = s?.toString()?.trim().orEmpty()
                if (text.isEmpty()) return
                val parsed = EndpointParser.parseFromRawText(text) ?: return
                currentEditingBeaconId = parsed.beaconId
                currentEditingHostPort = parsed.hostPort
                binding.inputHostPort.setText(parsed.hostPort)
                if (parsed.token.isNotEmpty()) {
                    binding.inputToken.setText(parsed.token)
                }
                val curLabel = binding.inputLabel.text?.toString()?.trim().orEmpty()
                if (curLabel.isEmpty() || (parsed.beaconId.isNotBlank() && curLabel == "异地远程直连")) {
                    binding.inputLabel.setText(parsed.suggestedLabel)
                }
                hideConnectStatus()
            }
        })

        binding.btnToggleTokenVisible.setOnClickListener {
            isTokenVisible = !isTokenVisible
            val sel = binding.inputToken.selectionEnd
            binding.inputToken.inputType = if (isTokenVisible) {
                InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
            } else {
                InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            }
            binding.btnToggleTokenVisible.text = if (isTokenVisible) "隐藏" else "显示"
            if (sel >= 0) {
                binding.inputToken.setSelection(sel.coerceAtMost(binding.inputToken.text.length))
            }
        }

        binding.chipHomeWifi.setOnClickListener { binding.inputLabel.setText("家里 Wi-Fi") }
        binding.chipTailscale.setOnClickListener { binding.inputLabel.setText("异地远程自动寻址") }
        binding.chipOfficeLan.setOnClickListener { binding.inputLabel.setText("办公室局域网") }

        binding.btnConnectNow.setOnClickListener {
            verifyAndConnectFromInputs()
        }
    }

    private fun setupOfflineControls() {
        binding.btnRetryNow.setOnClickListener {
            val target = activeEndpoint ?: return@setOnClickListener
            binding.btnRetryNow.isEnabled = false
            binding.btnRetryNow.text = "正在重连…"
            ioExecutor.execute {
                val outcome = ConnectionProber.probe(target, timeoutMs = 2600)
                val resolvedViaBeacon = if (outcome is ProbeOutcome.Unreachable && target.beaconId.isNotBlank()) {
                    BeaconResolver.resolveLatestEndpoint(target)
                } else {
                    null
                }

                mainHandler.post {
                    if (isFinishing || isDestroyed) return@post
                    binding.btnRetryNow.isEnabled = true
                    binding.btnRetryNow.text = "立即重试连接"

                    if (resolvedViaBeacon != null) {
                        stopAutoReconnectProbe()
                        hasMainFrameError = false
                        configStore.saveAndActivate(resolvedViaBeacon)
                        activeEndpoint = resolvedViaBeacon
                        binding.offlineOverlay.visibility = View.GONE
                        Toast.makeText(this, "已自动同步最新远程通道", Toast.LENGTH_SHORT).show()
                        loadEndpointIntoWebView(resolvedViaBeacon)
                        return@post
                    }

                    when (outcome) {
                        is ProbeOutcome.Authorized -> {
                            stopAutoReconnectProbe()
                            hasMainFrameError = false
                            binding.offlineOverlay.visibility = View.GONE
                            loadEndpointIntoWebView(target)
                        }
                        is ProbeOutcome.Unauthorized -> {
                            stopAutoReconnectProbe()
                            showOnboarding(prefill = target, statusMessage = outcome.message)
                        }
                        is ProbeOutcome.Unreachable -> {
                            binding.offlineReasonText.text = formatOfflineReason(target, outcome.reason)
                            Toast.makeText(this, "仍未连通，后台继续每 4 秒自动重试", Toast.LENGTH_SHORT).show()
                        }
                    }
                }
            }
        }

        binding.btnSwitchServerFromOffline.setOnClickListener {
            stopAutoReconnectProbe()
            showOnboarding(prefill = activeEndpoint)
        }
    }

    @SuppressLint("ClickableViewAccessibility")
    private fun setupFloatingPill() {
        val density = resources.displayMetrics.density
        val savedTopPx = (configStore.pillMarginTopDp * density).toInt()
        (binding.floatingQuickPill.layoutParams as? FrameLayout.LayoutParams)?.let { lp ->
            lp.topMargin = savedTopPx
            binding.floatingQuickPill.layoutParams = lp
        }

        val touchSlop = ViewConfiguration.get(this).scaledTouchSlop
        var downRawY = 0f
        var startTopMargin = 0
        var dragging = false

        binding.floatingQuickPill.setOnTouchListener { view, event ->
            val lp = view.layoutParams as? FrameLayout.LayoutParams ?: return@setOnTouchListener false
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downRawY = event.rawY
                    startTopMargin = lp.topMargin
                    dragging = false
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dy = event.rawY - downRawY
                    if (abs(dy) > touchSlop) {
                        dragging = true
                    }
                    if (dragging) {
                        val parentHeight = (view.parent as? View)?.height ?: resources.displayMetrics.heightPixels
                        val maxTop = (parentHeight - view.height - (16 * density).toInt()).coerceAtLeast(0)
                        lp.topMargin = (startTopMargin + dy.toInt()).coerceIn((8 * density).toInt(), maxTop)
                        view.layoutParams = lp
                    }
                    true
                }
                MotionEvent.ACTION_UP -> {
                    if (dragging) {
                        configStore.pillMarginTopDp = (lp.topMargin / density).toInt()
                    } else {
                        view.performClick()
                        showQuickServerMenu()
                    }
                    true
                }
                else -> false
            }
        }
    }

    private fun setupBackNavigation() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // 1. If Onboarding overlay is open
                if (binding.onboardingOverlay.visibility == View.VISIBLE) {
                    if (activeEndpoint != null && !hasMainFrameError) {
                        binding.onboardingOverlay.visibility = View.GONE
                        applySystemBarTheme(isWebThemeDark)
                        updateFloatingPillVisibility()
                    } else {
                        moveTaskToBack(true)
                    }
                    return
                }

                // 2. If Offline overlay is open
                if (binding.offlineOverlay.visibility == View.VISIBLE) {
                    moveTaskToBack(true)
                    return
                }

                // 3. Ask WebView page first (custom back hooks, open dialog/popover/drawer, or mobile chat->list)
                val backJs = """
                    (function() {
                      try {
                        if (typeof window.__achatAndroidBack === 'function' && window.__achatAndroidBack()) {
                          return 'handled';
                        }
                        if (typeof window.__awAndroidBack === 'function' && window.__awAndroidBack()) {
                          return 'handled';
                        }
                        var openDialog = document.querySelector('dialog[open]');
                        if (openDialog && typeof openDialog.close === 'function') {
                          openDialog.close();
                          return 'handled';
                        }
                        var openPop = document.querySelector('[popover]:popover-open');
                        if (openPop && typeof openPop.hidePopover === 'function') {
                          openPop.hidePopover();
                          return 'handled';
                        }
                        var mention = document.getElementById('mentionMenu');
                        if (mention && !mention.hidden) {
                          mention.hidden = true;
                          return 'handled';
                        }
                        var drawer = document.getElementById('groupDrawer');
                        if (drawer && !drawer.hidden) {
                          var toggleBtn = document.getElementById('toggleDrawerBtn');
                          if (toggleBtn) toggleBtn.click(); else drawer.hidden = true;
                          return 'handled';
                        }
                        var appRoot = document.getElementById('appRoot');
                        if (appRoot && appRoot.dataset && appRoot.dataset.mobileView === 'chat') {
                          var backBtn = document.getElementById('mobileBackBtn');
                          if (backBtn) backBtn.click(); else appRoot.dataset.mobileView = 'list';
                          return 'handled';
                        }
                      } catch (e) {}
                      return 'none';
                    })();
                """.trimIndent()

                binding.webView.evaluateJavascript(backJs) { rawResult ->
                    val handledInDom = rawResult?.contains("handled") == true
                    if (handledInDom) return@evaluateJavascript

                    if (canSafelyGoBackInWebView()) {
                        binding.webView.goBack()
                    } else {
                        // At session list home -> minimize cleanly to home screen
                        if (!moveTaskToBack(true)) {
                            finish()
                        }
                    }
                }
            }
        })
    }

    private fun canSafelyGoBackInWebView(): Boolean {
        val history = binding.webView.copyBackForwardList()
        val curIdx = history.currentIndex
        if (curIdx <= 0) return false
        val prevUrl = history.getItemAtIndex(curIdx - 1)?.url.orEmpty()
        if (prevUrl.isBlank() || prevUrl == "about:blank") return false
        // Do not step back into one-time ?token=... redirect entry URL
        if (prevUrl.contains("?token=")) return false
        return binding.webView.canGoBack()
    }

    private fun showOnboarding(
        prefill: ServerEndpoint?,
        statusMessage: String? = null,
        autoTriggerConnect: Boolean = false
    ) {
        stopAutoReconnectProbe()
        binding.offlineOverlay.visibility = View.GONE
        binding.floatingQuickPill.visibility = View.GONE
        binding.onboardingOverlay.visibility = View.VISIBLE
        applySystemBarTheme(isDark = false)
        binding.btnCloseOnboarding.visibility = if (activeEndpoint != null && !hasMainFrameError) {
            View.VISIBLE
        } else {
            View.GONE
        }

        val target = prefill ?: activeEndpoint ?: configStore.getSavedEndpoints().firstOrNull()
        suppressUrlWatcher = true
        if (target != null) {
            currentEditingBeaconId = target.beaconId
            currentEditingHostPort = target.hostPort
            binding.inputFullPairUrl.setText("")
            binding.inputHostPort.setText(target.hostPort)
            binding.inputToken.setText(target.token)
            binding.inputLabel.setText(target.label)
        } else {
            currentEditingBeaconId = ""
            currentEditingHostPort = ""
            binding.inputFullPairUrl.setText("")
            binding.inputHostPort.setText("")
            binding.inputToken.setText("")
            binding.inputLabel.setText("")
        }
        suppressUrlWatcher = false

        if (!statusMessage.isNullOrBlank()) {
            showConnectStatus(statusMessage, isError = true)
        } else {
            hideConnectStatus()
        }

        renderSavedEndpointsHistory()

        if (autoTriggerConnect && target != null) {
            verifyAndConnectEndpoint(target)
        }
    }

    private fun renderSavedEndpointsHistory() {
        val list = configStore.getSavedEndpoints()
        binding.savedEndpointsList.removeAllViews()

        if (list.isEmpty()) {
            binding.historyCardContainer.visibility = View.GONE
            return
        }

        binding.historyCardContainer.visibility = View.VISIBLE
        val currentBase = activeEndpoint?.baseUrl
        val inflater = LayoutInflater.from(this)

        for (item in list) {
            val itemBinding = ItemSavedEndpointBinding.inflate(
                inflater,
                binding.savedEndpointsList,
                false
            )
            val isCurrent = currentBase != null && currentBase.equals(item.baseUrl, ignoreCase = true)
            itemBinding.activeDot.alpha = if (isCurrent) 1.0f else 0.28f
            itemBinding.tvEndpointLabel.text = item.label
            itemBinding.tvEndpointBadge.visibility = if (isCurrent) View.VISIBLE else View.GONE
            itemBinding.tvEndpointUrl.text = buildString {
                append(item.baseUrl)
                if (item.token.isNotBlank()) append(" · 已存口令")
                if (item.beaconId.isNotBlank()) append(" · 自动寻址已开启")
            }

            itemBinding.itemRoot.setOnClickListener {
                hideKeyboard()
                verifyAndConnectEndpoint(item)
            }

            itemBinding.btnDeleteEndpoint.setOnClickListener {
                configStore.deleteEndpoint(item.baseUrl)
                if (activeEndpoint?.baseUrl.equals(item.baseUrl, ignoreCase = true)) {
                    activeEndpoint = configStore.getActiveEndpoint()
                }
                renderSavedEndpointsHistory()
                Toast.makeText(this, "已移除 ${item.label}", Toast.LENGTH_SHORT).show()
            }

            binding.savedEndpointsList.addView(itemBinding.root)
        }
    }

    private fun pasteAndParseFromClipboard() {
        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
        val clip: ClipData? = cm?.primaryClip
        val rawText = if (clip != null && clip.itemCount > 0) {
            clip.getItemAt(0)?.coerceToText(this)?.toString()?.trim().orEmpty()
        } else {
            ""
        }

        if (rawText.isEmpty()) {
            showConnectStatus("系统剪贴板为空，请先复制电脑端配对链接", isError = true)
            return
        }

        val parsed = EndpointParser.parseFromRawText(rawText)
        if (parsed == null) {
            // Maybe user copied only the raw hex token
            if (rawText.length in 16..128 && rawText.all { it.isLetterOrDigit() || it == '-' || it == '_' }) {
                binding.inputToken.setText(rawText)
                showConnectStatus("已从剪贴板填入访问口令 Token，请确认上方电脑地址", isError = false)
            } else {
                showConnectStatus("剪贴板中未识别到有效的服务器链接", isError = true)
            }
            return
        }

        currentEditingBeaconId = parsed.beaconId
        currentEditingHostPort = parsed.hostPort

        suppressUrlWatcher = true
        binding.inputFullPairUrl.setText(rawText)
        suppressUrlWatcher = false
        binding.inputHostPort.setText(parsed.hostPort)
        if (parsed.token.isNotEmpty()) {
            binding.inputToken.setText(parsed.token)
        }
        val curLabel = binding.inputLabel.text?.toString()?.trim().orEmpty()
        if (curLabel.isEmpty() || (parsed.beaconId.isNotBlank() && curLabel == "异地远程直连")) {
            binding.inputLabel.setText(parsed.suggestedLabel)
        }

        val modeSuffix = if (parsed.beaconId.isNotBlank()) "（已绑定云信标自动寻址）" else ""
        showConnectStatus(
            if (parsed.token.isNotEmpty()) {
                "已识别地址 ${parsed.hostPort}$modeSuffix，正在连接…"
            } else {
                "已识别地址 ${parsed.hostPort}$modeSuffix（若服务端开启鉴权请补充 Token）"
            },
            isError = false
        )

        if (parsed.token.isNotEmpty()) {
            verifyAndConnectFromInputs()
        }
    }

    private fun verifyAndConnectFromInputs() {
        val rawLink = binding.inputFullPairUrl.text?.toString()?.trim().orEmpty()
        val hostField = binding.inputHostPort.text?.toString()?.trim().orEmpty()
        val effectiveHostInput = hostField.ifEmpty { rawLink }

        val linkBeacon = EndpointParser.parseFromRawText(rawLink)?.beaconId.orEmpty()
        val inheritedBeacon = if (linkBeacon.isNotBlank()) {
            linkBeacon
        } else if (hostField.isEmpty() || hostField.equals(currentEditingHostPort, ignoreCase = true)) {
            currentEditingBeaconId
        } else {
            ""
        }

        val composed = EndpointParser.composeEndpoint(
            hostOrUrlInput = effectiveHostInput,
            tokenInput = binding.inputToken.text?.toString().orEmpty(),
            labelInput = binding.inputLabel.text?.toString().orEmpty(),
            beaconIdInput = inheritedBeacon
        )

        val endpoint = composed.getOrElse { err ->
            showConnectStatus(err.message ?: "输入格式有误", isError = true)
            return
        }

        hideKeyboard()
        verifyAndConnectEndpoint(endpoint)
    }

    private fun verifyAndConnectEndpoint(endpoint: ServerEndpoint) {
        binding.btnConnectNow.isEnabled = false
        binding.btnConnectNow.text = "正在验证连接…"
        showConnectStatus("正在连接 ${endpoint.baseUrl} …", isError = false)

        ioExecutor.execute {
            val initialOutcome = ConnectionProber.probe(endpoint, timeoutMs = 3200)
            val resolvedViaBeacon = if (initialOutcome is ProbeOutcome.Unreachable && endpoint.beaconId.isNotBlank()) {
                mainHandler.post {
                    if (!isFinishing && !isDestroyed) {
                        showConnectStatus("原隧道已轮换，正在通过加密云信标同步最新地址…", isError = false)
                    }
                }
                BeaconResolver.resolveLatestEndpoint(endpoint)
            } else {
                null
            }

            mainHandler.post {
                if (isFinishing || isDestroyed) return@post
                binding.btnConnectNow.isEnabled = true
                binding.btnConnectNow.text = "连接并进入 AChat"

                if (resolvedViaBeacon != null) {
                    configStore.saveAndActivate(resolvedViaBeacon)
                    activeEndpoint = resolvedViaBeacon
                    hasMainFrameError = false
                    hideConnectStatus()
                    binding.onboardingOverlay.visibility = View.GONE
                    binding.offlineOverlay.visibility = View.GONE
                    updateFloatingPillVisibility()
                    Toast.makeText(this, "已自动同步最新远程通道", Toast.LENGTH_SHORT).show()
                    loadEndpointIntoWebView(resolvedViaBeacon)
                    return@post
                }

                when (initialOutcome) {
                    is ProbeOutcome.Authorized -> {
                        configStore.saveAndActivate(endpoint)
                        activeEndpoint = endpoint
                        hasMainFrameError = false
                        hideConnectStatus()
                        binding.onboardingOverlay.visibility = View.GONE
                        binding.offlineOverlay.visibility = View.GONE
                        updateFloatingPillVisibility()
                        loadEndpointIntoWebView(endpoint)
                    }
                    is ProbeOutcome.Unauthorized -> {
                        showConnectStatus(initialOutcome.message, isError = true)
                    }
                    is ProbeOutcome.Unreachable -> {
                        showConnectStatus(initialOutcome.reason, isError = true)
                    }
                }
            }
        }
    }

    private fun loadEndpointIntoWebView(endpoint: ServerEndpoint) {
        hasMainFrameError = false
        hasLoadedActiveWebPage = false
        stopAutoReconnectProbe()
        binding.offlineOverlay.visibility = View.GONE
        applySystemBarTheme(isWebThemeDark)
        binding.webView.loadUrl(endpoint.buildEntryUrl())
        maybeRequestNotificationPermissionOnce()
    }

    private fun formatOfflineReason(ep: ServerEndpoint?, rawReason: String): String {
        return if (ep?.beaconId?.isNotBlank() == true) {
            "正在通过加密云信标自动搜寻电脑端最新远程地址…\n只要电脑端 AChat 在线，恢复后将自动进入会话。"
        } else {
            "$rawReason\n请确认电脑端 AChat 正在运行，且处于同一局域网或远程网络。"
        }
    }

    private fun triggerOfflineOverlay(reason: String) {
        hasMainFrameError = true
        val ep = activeEndpoint
        binding.offlineEndpointText.text = if (ep != null) {
            "${ep.label} · ${ep.baseUrl}"
        } else {
            "未配置服务器"
        }
        binding.offlineReasonText.text = formatOfflineReason(ep, reason)
        binding.offlineOverlay.visibility = View.VISIBLE
        hasLoadedActiveWebPage = false
        // Clear ugly native Chromium error page underneath
        binding.webView.loadUrl("about:blank")
        startAutoReconnectProbe()
    }

    private fun startAutoReconnectProbe() {
        if (isAutoProbing || activeEndpoint == null) return
        isAutoProbing = true
        probeAttemptCount = 0
        binding.offlineAutoProbeText.text = "正在后台每 4 秒自动探测重连…"
        mainHandler.removeCallbacks(autoReconnectRunnable)
        mainHandler.postDelayed(autoReconnectRunnable, RECONNECT_INTERVAL_MS)
    }

    private fun stopAutoReconnectProbe() {
        isAutoProbing = false
        mainHandler.removeCallbacks(autoReconnectRunnable)
    }

    private fun updateFloatingPillVisibility() {
        binding.floatingQuickPill.visibility =
            if (activeEndpoint != null && !pillHiddenForSession && binding.onboardingOverlay.visibility != View.VISIBLE) {
                View.VISIBLE
            } else {
                View.GONE
            }
    }

    private fun showQuickServerMenu() {
        val current = activeEndpoint
        val saved = configStore.getSavedEndpoints()
        val items = mutableListOf<String>()
        val actions = mutableListOf<() -> Unit>()

        items.add("刷新当前会话连接")
        actions.add {
            if (current != null) {
                if (current.beaconId.isNotBlank()) {
                    launchWithBeaconFastCheck(current)
                } else {
                    loadEndpointIntoWebView(current)
                }
                Toast.makeText(this, "正在刷新连接…", Toast.LENGTH_SHORT).show()
            } else {
                binding.webView.reload()
            }
        }

        for (ep in saved) {
            val isCur = current != null && current.baseUrl.equals(ep.baseUrl, ignoreCase = true)
            val prefix = if (isCur) "● 当前：" else "⇄ 切换至："
            val beaconTag = if (ep.beaconId.isNotBlank()) " · 自动寻址" else ""
            items.add("$prefix${ep.label} (${ep.hostPort}$beaconTag)")
            actions.add {
                if (!isCur) {
                    configStore.saveAndActivate(ep)
                    activeEndpoint = ep
                    if (ep.beaconId.isNotBlank()) {
                        launchWithBeaconFastCheck(ep)
                    } else {
                        loadEndpointIntoWebView(ep)
                    }
                    Toast.makeText(this, "已切换至 ${ep.label}", Toast.LENGTH_SHORT).show()
                } else {
                    loadEndpointIntoWebView(ep)
                }
            }
        }

        items.add("新增 / 管理服务器地址…")
        actions.add {
            showOnboarding(prefill = current)
        }

        if (current != null) {
            items.add("复制当前服务器配对链接")
            actions.add {
                val shareUrl = buildString {
                    append(current.buildEntryUrl())
                    if (current.beaconId.isNotBlank()) {
                        append(if (current.token.isNotBlank()) "&beacon=" else "?beacon=")
                        append(current.beaconId)
                    }
                }
                val cm = getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
                cm?.setPrimaryClip(ClipData.newPlainText("AChat URL", shareUrl))
                Toast.makeText(this, "配对链接已复制", Toast.LENGTH_SHORT).show()
            }
        }

        if (!pillHiddenForSession) {
            items.add("本次隐藏边缘「线路」按钮（摇一摇可呼出）")
            actions.add {
                pillHiddenForSession = true
                updateFloatingPillVisibility()
                Toast.makeText(this, "已隐藏，轻轻摇晃手机可随时呼出此菜单", Toast.LENGTH_SHORT).show()
            }
        } else {
            items.add("恢复显示边缘「线路」按钮")
            actions.add {
                pillHiddenForSession = false
                updateFloatingPillVisibility()
            }
        }

        if (quickServerDialog?.isShowing == true) {
            return
        }

        quickServerDialog = AlertDialog.Builder(this)
            .setTitle(current?.let { "AChat · ${it.label}" } ?: "AChat 连接菜单")
            .setItems(items.toTypedArray()) { _, which ->
                actions.getOrNull(which)?.invoke()
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun showImageActionDialog(imageUrl: String) {
        val options = arrayOf("在系统浏览器中查看 / 保存图片", "复制图片链接")
        AlertDialog.Builder(this)
            .setItems(options) { _, which ->
                when (which) {
                    0 -> openExternalUri(Uri.parse(imageUrl))
                    1 -> {
                        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
                        cm?.setPrimaryClip(ClipData.newPlainText("Image URL", imageUrl))
                        Toast.makeText(this, "图片链接已复制", Toast.LENGTH_SHORT).show()
                    }
                }
            }
            .show()
    }

    private fun createCameraCaptureIntent(): Intent? {
        return runCatching {
            val cameraDir = File(cacheDir, "camera").apply { mkdirs() }
            val stamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())
            val photoFile = File(cameraDir, "IMG_$stamp.jpg")
            val uri = FileProvider.getUriForFile(
                this,
                "${applicationContext.packageName}.fileprovider",
                photoFile
            )
            pendingCameraPhotoUri = uri
            Intent(MediaStore.ACTION_IMAGE_CAPTURE).apply {
                putExtra(MediaStore.EXTRA_OUTPUT, uri)
                addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
        }.getOrNull()
    }

    private fun enqueueOrOpenDownload(
        url: String,
        userAgent: String?,
        contentDisposition: String?,
        mimeType: String? = null
    ) {
        val uri = runCatching { Uri.parse(url) }.getOrNull() ?: return
        val scheme = uri.scheme?.lowercase(Locale.ROOT).orEmpty()
        if (scheme != "http" && scheme != "https") {
            openExternalUri(uri)
            return
        }

        val handledByDownloadManager = runCatching {
            val fileName = URLUtil.guessFileName(url, contentDisposition, mimeType)
            val req = DownloadManager.Request(uri).apply {
                setTitle(fileName)
                setDescription("AChat 正在下载文件")
                setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName)
                val cookie = CookieManager.getInstance().getCookie(url)
                if (!cookie.isNullOrBlank()) {
                    addRequestHeader("Cookie", cookie)
                }
                if (!userAgent.isNullOrBlank()) {
                    addRequestHeader("User-Agent", userAgent)
                }
            }
            val dm = getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
            dm.enqueue(req)
            Toast.makeText(this, "已加入系统下载：$fileName", Toast.LENGTH_SHORT).show()
            true
        }.getOrDefault(false)

        if (!handledByDownloadManager) {
            openExternalUri(uri)
        }
    }

    private fun openExternalUri(uri: Uri) {
        runCatching {
            startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }.onFailure {
            Toast.makeText(this, "未找到可打开此链接的系统应用", Toast.LENGTH_SHORT).show()
        }
    }

    private fun extractDeepLinkEndpoint(intent: Intent?): ServerEndpoint? {
        val data = intent?.data ?: return null
        val parsed = EndpointParser.parseFromRawText(data.toString()) ?: return null
        return ServerEndpoint(
            baseUrl = parsed.baseUrl,
            hostPort = parsed.hostPort,
            token = parsed.token,
            label = parsed.suggestedLabel,
            beaconId = parsed.beaconId
        )
    }

    private fun isSameOrigin(a: Uri, b: Uri): Boolean {
        val schemeA = (a.scheme ?: "http").lowercase(Locale.ROOT)
        val schemeB = (b.scheme ?: "http").lowercase(Locale.ROOT)
        val hostA = (a.host ?: "").lowercase(Locale.ROOT)
        val hostB = (b.host ?: "").lowercase(Locale.ROOT)
        val portA = if (a.port != -1) a.port else if (schemeA == "https") 443 else 80
        val portB = if (b.port != -1) b.port else if (schemeB == "https") 443 else 80
        return schemeA == schemeB && hostA == hostB && portA == portB
    }

    private fun showConnectStatus(msg: String, isError: Boolean) {
        binding.connectStatusText.text = msg
        binding.connectStatusText.setTextColor(
            ContextCompat.getColor(
                this,
                if (isError) R.color.achat_danger else R.color.achat_accent_text
            )
        )
        binding.connectStatusText.visibility = View.VISIBLE
    }

    private fun hideConnectStatus() {
        binding.connectStatusText.visibility = View.GONE
    }

    private fun hideKeyboard() {
        val imm = getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
        currentFocus?.windowToken?.let { token ->
            imm?.hideSoftInputFromWindow(token, 0)
        }
    }

    private fun ensureAgentReplyNotificationChannel() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        val existing = nm.getNotificationChannel(BridgeAndResumeHelper.NOTIFICATION_CHANNEL_ID)
        if (existing != null) return

        val channel = NotificationChannel(
            BridgeAndResumeHelper.NOTIFICATION_CHANNEL_ID,
            BridgeAndResumeHelper.NOTIFICATION_CHANNEL_NAME,
            NotificationManager.IMPORTANCE_DEFAULT
        ).apply {
            description = "当 AChat 处于后台时推送 Agent 最新回复提醒"
        }
        nm.createNotificationChannel(channel)
    }

    private fun hasNotificationPermission(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.POST_NOTIFICATIONS
            ) == PackageManager.PERMISSION_GRANTED
        } else {
            true
        }
    }

    private fun maybeRequestNotificationPermissionOnce() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (hasNotificationPermission() || configStore.notificationPermissionPrompted) return

        mainHandler.postDelayed({
            if (!isFinishing && !isDestroyed &&
                isActivityInForeground &&
                binding.onboardingOverlay.visibility != View.VISIBLE &&
                !hasNotificationPermission() &&
                !configStore.notificationPermissionPrompted
            ) {
                configStore.notificationPermissionPrompted = true
                runCatching {
                    notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                }
            }
        }, 650L)
    }

    private fun deliverAgentReplyNotificationIfBackground(
        groupTitle: String?,
        senderName: String?,
        snippet: String?
    ) {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        val allowed = BridgeAndResumeHelper.shouldDeliverAgentNotification(
            isActivityInForeground = isActivityInForeground,
            isPermissionGranted = hasNotificationPermission(),
            areSystemNotificationsEnabled = nm.areNotificationsEnabled()
        )
        if (!allowed) return

        ensureAgentReplyNotificationChannel()
        val formatted = BridgeAndResumeHelper.formatAgentNotification(
            groupTitle = groupTitle,
            senderName = senderName,
            snippet = snippet
        )

        val tapIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(this, BridgeAndResumeHelper.NOTIFICATION_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_achat)
            .setColor(ContextCompat.getColor(this, R.color.achat_primary))
            .setContentTitle(formatted.title)
            .setContentText(formatted.body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(formatted.body))
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .build()

        val notificationId = NOTIFICATION_ID_BASE + (notificationSeq.incrementAndGet() and 0x3F)
        nm.notify(notificationId, notification)
    }

    @Suppress("DEPRECATION")
    private fun applySystemBarTheme(isDark: Boolean) {
        val spec = BridgeAndResumeHelper.resolveSystemBarTheme(isDark)
        val statusColor = if (spec.darkStatusBarHex != null) {
            Color.parseColor(spec.darkStatusBarHex)
        } else {
            ContextCompat.getColor(this, R.color.achat_header_bar)
        }
        val navColor = if (spec.darkNavigationBarHex != null) {
            Color.parseColor(spec.darkNavigationBarHex)
        } else {
            ContextCompat.getColor(this, R.color.achat_page_bg)
        }

        window.statusBarColor = statusColor
        window.navigationBarColor = navColor
        binding.rootContainer.setBackgroundColor(statusColor)
        binding.webStageContainer.setBackgroundColor(navColor)

        WindowInsetsControllerCompat(window, window.decorView).apply {
            isAppearanceLightStatusBars = spec.isAppearanceLightStatusBars
            isAppearanceLightNavigationBars = spec.isAppearanceLightNavigationBars
        }
    }

    private fun handleForegroundResumeReconnect(previousPauseAtMs: Long) {
        val target = activeEndpoint ?: return
        if (binding.onboardingOverlay.visibility == View.VISIBLE) return

        // 1) Immediately notify WebView frontend to pull incremental messages
        binding.webView.evaluateJavascript(BridgeAndResumeHelper.RESUME_DISPATCH_JS, null)

        // 2) If main frame had an error OR background stay exceeded 8000ms, run silent probe + beacon rebind
        val shouldProbe = BridgeAndResumeHelper.shouldTriggerSilentResumeProbe(
            hasActiveEndpoint = true,
            isOnboardingVisible = false,
            hasMainFrameError = hasMainFrameError,
            lastPauseAtMs = previousPauseAtMs,
            nowMs = System.currentTimeMillis()
        )
        if (!shouldProbe || isSilentResumeProbing) return

        isSilentResumeProbing = true
        val errorSnapshot = hasMainFrameError
        ioExecutor.execute {
            try {
                val resumeResult = BridgeAndResumeHelper.performSilentResumeProbe(
                    target = target,
                    hasMainFrameError = errorSnapshot
                )
                mainHandler.post {
                    isSilentResumeProbing = false
                    if (isFinishing || isDestroyed) return@post
                    val activeNow = activeEndpoint ?: return@post
                    if (binding.onboardingOverlay.visibility == View.VISIBLE) return@post

                    val sameTarget = activeNow.baseUrl.equals(target.baseUrl, ignoreCase = true) ||
                        (target.beaconId.isNotBlank() && activeNow.beaconId.equals(target.beaconId, ignoreCase = true))
                    if (!sameTarget) return@post

                    when (resumeResult) {
                        is SilentResumeResult.ReboundEndpoint -> {
                            val resolved = resumeResult.endpoint
                            val changedVsNow = !resolved.baseUrl.equals(activeNow.baseUrl, ignoreCase = true) ||
                                resolved.token != activeNow.token
                            configStore.saveAndActivate(resolved)
                            activeEndpoint = resolved
                            if (changedVsNow || hasMainFrameError || resumeResult.shouldReloadWebView) {
                                loadEndpointIntoWebView(resolved)
                            }
                        }
                        is SilentResumeResult.RecoveredExisting -> {
                            if (hasMainFrameError) {
                                loadEndpointIntoWebView(resumeResult.endpoint)
                            }
                        }
                        is SilentResumeResult.TokenUnauthorized -> {
                            stopAutoReconnectProbe()
                            showOnboarding(prefill = resumeResult.endpoint, statusMessage = resumeResult.message)
                        }
                        is SilentResumeResult.HealthyNoChange,
                        is SilentResumeResult.StillUnreachableSilent -> {
                            // Keep silent without flashing offline error overlay
                        }
                    }
                }
            } catch (_: Exception) {
                isSilentResumeProbing = false
            }
        }
    }

    private fun ingestInboundShareIntentIfNeeded(incomingIntent: Intent?): Boolean {
        val intent = incomingIntent ?: return false
        val action = intent.action ?: return false
        if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) {
            return false
        }

        val rawSubject = intent.getStringExtra(Intent.EXTRA_SUBJECT)
        val rawText = intent.getStringExtra(Intent.EXTRA_TEXT)
            ?: intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
        val mergedText = BridgeAndResumeHelper.mergeSharedText(rawSubject, rawText)
        val imageUris = extractShareUrisFromIntent(intent)

        // Sanitize Activity intent immediately so screen rotation / config change never re-ingests
        intent.action = Intent.ACTION_MAIN
        intent.type = null
        intent.clipData = null
        intent.replaceExtras(Bundle())
        setIntent(Intent(this, MainActivity::class.java).setAction(Intent.ACTION_MAIN))

        if (mergedText.isEmpty() && imageUris.isEmpty()) {
            return true
        }

        // Hide onboarding immediately if already paired so user lands right in AChat
        if (activeEndpoint != null && binding.onboardingOverlay.visibility == View.VISIBLE) {
            hideKeyboard()
            binding.onboardingOverlay.visibility = View.GONE
            applySystemBarTheme(isWebThemeDark)
            updateFloatingPillVisibility()
        }

        ioExecutor.execute {
            val candidates = imageUris.map { buildShareImageCandidate(it) }
            val encodedImages = BridgeAndResumeHelper.collectEncodedShareImages(candidates)
            val serialized = BridgeAndResumeHelper.serializePendingShareJson(
                text = mergedText,
                images = encodedImages
            )

            if (serialized.isEmpty()) {
                if (imageUris.isNotEmpty()) {
                    mainHandler.post {
                        if (!isFinishing && !isDestroyed) {
                            Toast.makeText(this, "分享的图片超过 6MB 限制或无法读取", Toast.LENGTH_SHORT).show()
                        }
                    }
                }
                return@execute
            }

            synchronized(shareLock) {
                pendingShareJson = serialized
            }

            mainHandler.post {
                if (isFinishing || isDestroyed) return@post
                if (activeEndpoint != null && binding.onboardingOverlay.visibility == View.VISIBLE) {
                    hideKeyboard()
                    binding.onboardingOverlay.visibility = View.GONE
                    applySystemBarTheme(isWebThemeDark)
                    updateFloatingPillVisibility()
                }
                if (activeEndpoint != null && hasLoadedActiveWebPage && !hasMainFrameError && pendingShareJson.isNotEmpty()) {
                    binding.webView.evaluateJavascript(BridgeAndResumeHelper.SHARE_READY_DISPATCH_JS, null)
                }
            }
        }

        return true
    }

    private fun extractShareUrisFromIntent(intent: Intent): List<Uri> {
        val collected = LinkedHashSet<Uri>()
        when (intent.action) {
            Intent.ACTION_SEND -> {
                IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)
                    ?.let { collected.add(it) }
            }
            Intent.ACTION_SEND_MULTIPLE -> {
                IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)
                    ?.filterNotNull()
                    ?.forEach { collected.add(it) }
            }
        }

        val mime = intent.type?.lowercase(Locale.ROOT).orEmpty()
        if (collected.isEmpty() || mime.startsWith("image/") || intent.action == Intent.ACTION_SEND_MULTIPLE) {
            val clip = intent.clipData
            if (clip != null) {
                for (i in 0 until clip.itemCount) {
                    val uri = clip.getItemAt(i)?.uri ?: continue
                    val scheme = uri.scheme?.lowercase(Locale.ROOT).orEmpty()
                    if (scheme == "content" || scheme == "file" || scheme == "android.resource") {
                        collected.add(uri)
                    }
                }
            }
        }
        return collected.take(12)
    }

    private fun buildShareImageCandidate(uri: Uri): RawShareImageCandidate {
        val resolvedMime = runCatching { contentResolver.getType(uri) }.getOrNull()
        var displayName: String? = null
        var sizeBytes = -1L
        runCatching {
            contentResolver.query(
                uri,
                arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE),
                null,
                null,
                null
            )?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val nameIdx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (nameIdx >= 0 && !cursor.isNull(nameIdx)) {
                        displayName = cursor.getString(nameIdx)
                    }
                    val sizeIdx = cursor.getColumnIndex(OpenableColumns.SIZE)
                    if (sizeIdx >= 0 && !cursor.isNull(sizeIdx)) {
                        sizeBytes = cursor.getLong(sizeIdx)
                    }
                }
            }
        }
        if (displayName.isNullOrBlank()) {
            displayName = uri.lastPathSegment
        }
        return RawShareImageCandidate(
            fileName = displayName,
            mimeType = resolvedMime,
            declaredSizeBytes = sizeBytes,
            openStream = { contentResolver.openInputStream(uri) }
        )
    }

    private inner class AndroidJsBridge {
        @JavascriptInterface
        fun notifyAgentReply(groupTitle: String?, senderName: String?, snippet: String?) {
            mainHandler.post {
                if (isFinishing || isDestroyed) return@post
                deliverAgentReplyNotificationIfBackground(groupTitle, senderName, snippet)
            }
        }

        @JavascriptInterface
        fun syncTheme(isDark: Boolean) {
            mainHandler.post {
                if (isFinishing || isDestroyed) return@post
                isWebThemeDark = isDark
                if (binding.onboardingOverlay.visibility != View.VISIBLE) {
                    applySystemBarTheme(isDark)
                }
            }
        }

        @JavascriptInterface
        fun openServerSwitcher() {
            mainHandler.post {
                if (isFinishing || isDestroyed) return@post
                showQuickServerMenu()
            }
        }

        @JavascriptInterface
        fun getAppVersion(): String {
            return BridgeAndResumeHelper.APP_VERSION
        }

        @JavascriptInterface
        fun consumePendingShare(): String {
            return BridgeAndResumeHelper.consumeAtomically(
                lock = shareLock,
                getter = { pendingShareJson },
                setter = { pendingShareJson = it }
            )
        }

        @JavascriptInterface
        fun shareTextOut(title: String?, text: String?) {
            val cleanText = text?.trim().orEmpty()
            if (cleanText.isEmpty()) return
            val cleanTitle = title?.trim().orEmpty()
            mainHandler.post {
                if (isFinishing || isDestroyed) return@post
                runCatching {
                    val sendIntent = Intent(Intent.ACTION_SEND).apply {
                        type = "text/plain"
                        putExtra(Intent.EXTRA_TEXT, cleanText)
                        if (cleanTitle.isNotEmpty()) {
                            putExtra(Intent.EXTRA_SUBJECT, cleanTitle)
                            putExtra(Intent.EXTRA_TITLE, cleanTitle)
                        }
                    }
                    val chooserTitle = cleanTitle.ifEmpty { "分享内容" }
                    startActivity(Intent.createChooser(sendIntent, chooserTitle))
                }.onFailure {
                    Toast.makeText(this@MainActivity, "无法打开系统分享面板", Toast.LENGTH_SHORT).show()
                }
            }
        }

        @JavascriptInterface
        fun triggerHaptic() {
            mainHandler.post {
                if (isFinishing || isDestroyed) return@post
                runCatching {
                    binding.webView.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
                }
            }
        }
    }

    companion object {
        private const val RECONNECT_INTERVAL_MS = 4000L
        private const val NOTIFICATION_ID_BASE = 4100
    }
}
