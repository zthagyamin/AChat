const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  Tray,
  Menu,
  nativeImage,
  globalShortcut,
  screen,
  Notification,
  desktopCapturer,
} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const APP_ID = 'com.achat.desktop';
app.setAppUserModelId(APP_ID);

const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const BOUNDS_FILE = path.join(DATA_DIR, 'window-bounds.json');
const LAUNCH_LOG_FILE = path.join(DATA_DIR, 'desktop-launch.log');
const BOSS_KEY = 'CommandOrControl+Alt+W';
const START_HIDDEN = process.argv.includes('--hidden');

const smokeUserDataArg = process.argv.find((arg) => String(arg).startsWith('--smoke-user-data='));
const IS_SMOKE_TEST = Boolean(smokeUserDataArg);
if (smokeUserDataArg) {
  const customUserData = smokeUserDataArg.slice('--smoke-user-data='.length).trim();
  if (customUserData) {
    fs.mkdirSync(customUserData, { recursive: true });
    app.setPath('userData', customUserData);
  }
}

function appendLaunchLog(stage, detail = {}) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(LAUNCH_LOG_FILE)) {
      const st = fs.statSync(LAUNCH_LOG_FILE);
      if (st.size > 65536) {
        const tail = fs.readFileSync(LAUNCH_LOG_FILE, 'utf8').slice(-32768);
        const nl = tail.indexOf('\n');
        fs.writeFileSync(LAUNCH_LOG_FILE, nl >= 0 ? tail.slice(nl + 1) : tail, 'utf8');
      }
    }
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      pid: process.pid,
      smoke: IS_SMOKE_TEST,
      hidden: START_HIDDEN,
      stage,
      ...detail,
    });
    fs.appendFileSync(LAUNCH_LOG_FILE, `${entry}\n`, 'utf8');
  } catch {
    // ignore logging failure
  }
}

appendLaunchLog('process-start', { argv: process.argv.slice(1) });

function getStartupDir() {
  return path.join(
    app.getPath('appData'),
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup'
  );
}

function getStartupShortcutPath() {
  return path.join(getStartupDir(), 'AChat.lnk');
}

function getLegacyStartupShortcutPath() {
  return path.join(getStartupDir(), 'Agent 微信.lnk');
}

function isAutoStartEnabled() {
  try {
    return (
      fs.existsSync(getStartupShortcutPath()) || fs.existsSync(getLegacyStartupShortcutPath())
    );
  } catch {
    return false;
  }
}

function setAutoStartEnabled(enabled) {
  const lnkPath = getStartupShortcutPath();
  const legacyPath = getLegacyStartupShortcutPath();
  try {
    if (fs.existsSync(legacyPath)) fs.unlinkSync(legacyPath);
    if (!enabled) {
      if (fs.existsSync(lnkPath)) fs.unlinkSync(lnkPath);
      return false;
    }
    fs.mkdirSync(path.dirname(lnkPath), { recursive: true });
    const wscriptExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');
    const wakeScript = path.join(ROOT_DIR, 'server', 'wake-gateway.vbs');
    shell.writeShortcutLink(lnkPath, 'create', {
      target: wscriptExe,
      args: `//B //Nologo "${wakeScript}"`,
      cwd: ROOT_DIR,
      icon: path.join(PUBLIC_DIR, 'achat.ico'),
      iconIndex: 0,
      description: 'AChat 轻量无窗口待机网关（保障手机随时远程唤醒连接）',
    });
    return fs.existsSync(lnkPath);
  } catch {
    return isAutoStartEnabled();
  }
}

let mainWindow = null;
let tray = null;
let serverHandle = null;
let isQuitting = false;
let currentTargetOrigin = 'http://127.0.0.1:8866';
let boundsSaveTimer = null;
let iconNormal = null;
let iconUnread = null;
let pendingMaximizeOnShow = false;
let standbyPollTimer = null;
let bootstrapServerReady = false;

function clearStandbyPollTimer() {
  if (standbyPollTimer) {
    clearTimeout(standbyPollTimer);
    standbyPollTimer = null;
  }
}

async function parkWindowToStandbyWhenIdle() {
  clearStandbyPollTimer();
  if (isQuitting || !mainWindow || mainWindow.isDestroyed() || mainWindow.isVisible()) return;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1200);
    const res = await fetch(`${currentTargetOrigin}/api/session`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return;
    const snap = await res.json();
    if (snap?.activeWork) {
      standbyPollTimer = setTimeout(() => {
        parkWindowToStandbyWhenIdle().catch(() => {});
      }, 10_000);
      return;
    }
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isVisible()) return;
    const curUrl = mainWindow.webContents.getURL() || '';
    if (curUrl && !curUrl.startsWith('about:blank')) {
      await mainWindow.loadURL('about:blank').catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
    }
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isVisible()) return;
    await fetch(`${currentTargetOrigin}/api/admin/standby`, { method: 'POST' }).catch(() => {});
  } catch {
    // non-fatal if local server unavailable
  }
}

// Ensure single desktop instance
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  appendLaunchLog('single-instance-abort');
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    appendLaunchLog('second-instance', { commandLine });
    if (Array.isArray(commandLine) && commandLine.includes('--hidden')) return;
    summonMainWindow();
  });
}

function loadAppIcon(unread = false) {
  const icoPath = path.join(PUBLIC_DIR, unread ? 'achat-unread.ico' : 'achat.ico');
  const legacyIco = path.join(PUBLIC_DIR, unread ? 'icon-unread.ico' : 'icon.ico');
  const pngFallback = path.join(PUBLIC_DIR, unread ? 'icon-unread-64.png' : 'icon-64.png');
  for (const candidate of [icoPath, legacyIco, pngFallback]) {
    if (fs.existsSync(candidate)) {
      const img = nativeImage.createFromPath(candidate);
      if (!img.isEmpty()) return img;
    }
  }
  return nativeImage.createEmpty();
}

function resolveActiveTargetDisplay() {
  const primary = screen.getPrimaryDisplay();
  try {
    const pt = screen.getCursorScreenPoint();
    // Remote sessions or idle cursors often report (0, 0) on the multi-monitor seam; prefer Primary Display
    if ((pt.x === 0 && pt.y === 0) || Math.abs(pt.x - primary.bounds.x) <= 4) {
      return primary;
    }
    const hit = screen.getAllDisplays().find((d) => {
      const b = d.bounds;
      return pt.x >= b.x + 4 && pt.x < b.x + b.width - 4 && pt.y >= b.y && pt.y < b.y + b.height;
    });
    return hit || primary;
  } catch {
    return primary;
  }
}

function moveWindowToCursorDisplayIfNeeded() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const targetDisplay = resolveActiveTargetDisplay();
    const wa = targetDisplay?.workArea || targetDisplay?.bounds;
    if (!wa) return;
    const wasMax = mainWindow.isMaximized();
    const b = mainWindow.getBounds();
    const cx = b.x + Math.round(b.width / 2);
    const cy = b.y + Math.round(b.height / 2);
    const onTarget =
      cx >= wa.x && cx <= wa.x + wa.width && cy >= wa.y && cy <= wa.y + wa.height;
    if (!onTarget) {
      if (wasMax) mainWindow.unmaximize();
      const w = Math.min(Math.max(740, b.width || 1100), Math.max(740, wa.width - 48));
      const h = Math.min(Math.max(540, b.height || 750), Math.max(540, wa.height - 48));
      const nx = wa.x + Math.round((wa.width - w) / 2);
      const ny = wa.y + Math.round((wa.height - h) / 2);
      mainWindow.setBounds({ x: nx, y: ny, width: w, height: h });
      if (wasMax) mainWindow.maximize();
    }
  } catch {
    // ignore display lookup failure
  }
}

function summonMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  clearStandbyPollTimer();
  const curUrl = mainWindow.webContents.getURL() || '';
  if (bootstrapServerReady && !curUrl.startsWith(currentTargetOrigin)) {
    mainWindow.loadURL(currentTargetOrigin).catch(() => {});
  }
  const prevTop = mainWindow.isAlwaysOnTop();
  if (mainWindow.isMinimized()) mainWindow.restore();
  moveWindowToCursorDisplayIfNeeded();
  mainWindow.setAlwaysOnTop(true);
  mainWindow.show();
  if (pendingMaximizeOnShow) {
    pendingMaximizeOnShow = false;
    mainWindow.maximize();
  }
  moveWindowToCursorDisplayIfNeeded();
  mainWindow.focus();
  if (typeof mainWindow.moveTop === 'function') {
    mainWindow.moveTop();
  }
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !prevTop) {
      mainWindow.setAlwaysOnTop(false);
    }
  }, 220);
}

function toggleMainWindowVisibility() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isVisible() && mainWindow.isFocused() && !mainWindow.isMinimized()) {
    mainWindow.hide();
    parkWindowToStandbyWhenIdle().catch(() => {});
  } else {
    summonMainWindow();
  }
}

function loadSavedWindowBounds() {
  const defaults = { width: 1100, height: 750, maximized: false };
  try {
    if (!fs.existsSync(BOUNDS_FILE)) return defaults;
    const saved = JSON.parse(fs.readFileSync(BOUNDS_FILE, 'utf8')) || {};
    const width = Math.max(740, Number(saved.width) || defaults.width);
    const height = Math.max(540, Number(saved.height) || defaults.height);
    const maximized = Boolean(saved.maximized);
    if (typeof saved.x === 'number' && typeof saved.y === 'number') {
      const displays = screen.getAllDisplays();
      const visibleOnAny = displays.some((d) => {
        const b = d.workArea || d.bounds;
        return (
          saved.x + width > b.x + 80 &&
          saved.x < b.x + b.width - 80 &&
          saved.y + height > b.y + 60 &&
          saved.y < b.y + b.height - 60
        );
      });
      if (visibleOnAny) {
        return { x: saved.x, y: saved.y, width, height, maximized };
      }
    }
    return { width, height, maximized };
  } catch {
    return defaults;
  }
}

function scheduleSaveWindowBounds() {
  if (IS_SMOKE_TEST || !mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) return;
  clearTimeout(boundsSaveTimer);
  boundsSaveTimer = setTimeout(() => {
    try {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const isMax = mainWindow.isMaximized();
      const normalBounds = isMax ? mainWindow.getNormalBounds() : mainWindow.getBounds();
      fs.writeFileSync(
        BOUNDS_FILE,
        JSON.stringify(
          {
            x: normalBounds.x,
            y: normalBounds.y,
            width: normalBounds.width,
            height: normalBounds.height,
            maximized: isMax,
          },
          null,
          2
        ),
        'utf8'
      );
    } catch {
      // ignore transient write contention
    }
  }, 220);
}

function clearUnreadIndicators() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.flashFrame(false);
  }
  if (tray && !tray.isDestroyed() && iconNormal && !iconNormal.isEmpty()) {
    tray.setImage(iconNormal);
    tray.setToolTip('AChat — 多智能体协作客户端 (Ctrl+Alt+W)');
  }
}

function broadcastWinState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('win:state', {
    maximized: mainWindow.isMaximized(),
    alwaysOnTop: mainWindow.isAlwaysOnTop(),
    shortcut: 'Ctrl+Alt+W',
  });
}

function isSafeExternalUrl(rawUrl = '') {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:';
  } catch {
    return false;
  }
}

async function detectExistingServer(port = 8866) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1200);
    const res = await fetch(`http://127.0.0.1:${port}/api/session`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (res.ok) {
      return `http://127.0.0.1:${port}`;
    }
  } catch {
    // Not running yet
  }
  return null;
}

async function ensureBackendServer(port = 8866) {
  let targetUrl = await detectExistingServer(port);
  if (targetUrl) return targetUrl;

  try {
    const nodeCandidates = [
      'C:\\Program Files\\nodejs\\node.exe',
      process.env.NODE_BINARY,
      'node.exe',
    ].filter(Boolean);
    const nodeExe =
      nodeCandidates.find((candidate) => candidate === 'node.exe' || fs.existsSync(candidate)) ||
      'node.exe';
    const serverScript = path.join(ROOT_DIR, 'server', 'index.mjs');
    const childEnv = { ...process.env };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    const spawnArgs = START_HIDDEN ? [serverScript, '--standby'] : [serverScript];
    const child = spawn(nodeExe, spawnArgs, {
      cwd: ROOT_DIR,
      env: childEnv,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    appendLaunchLog('spawned-detached-server', { serverPid: child.pid, nodeExe });
    for (let attempt = 0; attempt < 25 && !targetUrl; attempt += 1) {
      await new Promise((r) => setTimeout(r, 160));
      targetUrl = await detectExistingServer(port);
    }
    if (targetUrl) return targetUrl;
  } catch (spawnErr) {
    appendLaunchLog('detached-server-fallback', { error: String(spawnErr?.message || spawnErr) });
  }

  try {
    const serverModuleUrl = pathToFileURL(path.join(ROOT_DIR, 'server', 'index.mjs')).href;
    const { startAgentWeChatServer } = await import(serverModuleUrl);
    serverHandle = await startAgentWeChatServer({ port, host: '0.0.0.0' });
    return serverHandle.url;
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') {
      for (let attempt = 0; attempt < 20 && !targetUrl; attempt += 1) {
        await new Promise((r) => setTimeout(r, 200));
        targetUrl = await detectExistingServer(port);
      }
    }
    if (!targetUrl) throw err;
    return targetUrl;
  }
}

const COLD_BOOT_SPLASH_HTML =
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#0F172A;color:#F8FAFC;font-family:"Microsoft YaHei UI",system-ui,sans-serif;display:grid;place-items:center;user-select:none}
.box{text-align:center}
.mark{width:56px;height:56px;margin:0 auto 16px;border-radius:16px;background:linear-gradient(135deg,#06B6D4,#2563EB);display:grid;place-items:center;font-weight:800;font-size:28px;letter-spacing:-1px;box-shadow:0 12px 30px rgba(6,182,212,.32)}
.sub{margin-top:8px;font-size:13px;color:#94A3B8}
</style></head><body><div class="box"><div class="mark">A</div><div>AChat 正在连接本地多智能体服务…</div><div class="sub">首次冷启动约需 1 秒</div></div></body></html>`);

async function bootstrap() {
  iconNormal = loadAppIcon(false);
  iconUnread = loadAppIcon(true);
  const savedBounds = loadSavedWindowBounds();

  mainWindow = new BrowserWindow({
    title: 'AChat',
    ...(typeof savedBounds.x === 'number' ? { x: savedBounds.x, y: savedBounds.y } : {}),
    width: savedBounds.width,
    height: savedBounds.height,
    minWidth: 740,
    minHeight: 540,
    frame: false,
    backgroundColor: '#0F172A',
    icon: path.join(PUBLIC_DIR, 'achat.ico'),
    show: !START_HIDDEN,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (savedBounds.maximized) {
    if (START_HIDDEN) {
      pendingMaximizeOnShow = true;
    } else {
      mainWindow.maximize();
    }
  }
  if (!START_HIDDEN) {
    summonMainWindow();
  }
  appendLaunchLog('window-created', {
    bounds: mainWindow.getBounds(),
    visible: mainWindow.isVisible(),
  });

  // Prevent external Markdown links from hijacking the frameless AChat window
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      shell.openExternal(url).catch(() => {});
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      const parsed = new URL(url);
      if (
        parsed.origin === currentTargetOrigin ||
        parsed.protocol === 'data:' ||
        parsed.protocol === 'about:'
      ) {
        return;
      }
      event.preventDefault();
      if (isSafeExternalUrl(url)) {
        shell.openExternal(url).catch(() => {});
      }
    } catch {
      event.preventDefault();
    }
  });

  let didInitialAppLoad = false;
  mainWindow.webContents.on('did-finish-load', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const currentUrl = mainWindow.webContents.getURL();
      if (currentUrl.startsWith(currentTargetOrigin)) {
        if (!didInitialAppLoad) {
          didInitialAppLoad = true;
          if (!START_HIDDEN) {
            summonMainWindow();
          }
        }
        broadcastWinState();
        appendLaunchLog('app-loaded', {
          url: currentUrl,
          bounds: mainWindow.getBounds(),
          visible: mainWindow.isVisible(),
        });
      }
    }
  });

  mainWindow.on('focus', clearUnreadIndicators);
  mainWindow.on('resize', scheduleSaveWindowBounds);
  mainWindow.on('move', scheduleSaveWindowBounds);
  mainWindow.on('maximize', () => {
    scheduleSaveWindowBounds();
    broadcastWinState();
  });
  mainWindow.on('unmaximize', () => {
    scheduleSaveWindowBounds();
    broadcastWinState();
  });
  mainWindow.on('always-on-top-changed', broadcastWinState);

  // Close button hides to system tray and parks backend to Standby once idle
  mainWindow.on('close', (event) => {
    scheduleSaveWindowBounds();
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      parkWindowToStandbyWhenIdle().catch(() => {});
    }
  });

  // Register global Boss Key (Ctrl+Alt+W) & Region Screenshot Key (Ctrl+Shift+A)
  try {
    globalShortcut.register(BOSS_KEY, toggleMainWindowVisibility);
    globalShortcut.register('CommandOrControl+Shift+A', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('win:triggerScreenCapture');
      }
    });
  } catch {
    // Non-fatal if shortcut already claimed by another app
  }

  let targetUrl = await detectExistingServer(8866);
  if (!targetUrl) {
    if (!START_HIDDEN) {
      await mainWindow.loadURL(COLD_BOOT_SPLASH_HTML).catch(() => {});
    }
    targetUrl = await ensureBackendServer(8866);
  }
  currentTargetOrigin = new URL(targetUrl).origin;
  bootstrapServerReady = true;
  if (START_HIDDEN) {
    await mainWindow.loadURL('about:blank').catch(() => {});
  } else {
    await mainWindow.loadURL(targetUrl);
  }

  // Setup Windows System Tray with real multi-DPI .ico
  try {
    tray = new Tray(iconNormal.isEmpty() ? path.join(PUBLIC_DIR, 'achat.ico') : iconNormal);
    tray.setToolTip('AChat — 多智能体协作客户端 (Ctrl+Alt+W)');
    const updateTrayMenu = () => {
      const menu = Menu.buildFromTemplate([
        {
          label: '显示 / 隐藏主窗口 (Ctrl+Alt+W)',
          click: () => toggleMainWindowVisibility(),
        },
        {
          label: '打开主窗口',
          click: () => summonMainWindow(),
        },
        {
          label: '窗口置顶',
          type: 'checkbox',
          checked: mainWindow?.isAlwaysOnTop() || false,
          click: () => {
            const next = !mainWindow.isAlwaysOnTop();
            mainWindow.setAlwaysOnTop(next);
            updateTrayMenu();
          },
        },
        {
          label: '开机后台静默自启（保障手机随时可连）',
          type: 'checkbox',
          checked: isAutoStartEnabled(),
          click: () => {
            setAutoStartEnabled(!isAutoStartEnabled());
            updateTrayMenu();
          },
        },
        { type: 'separator' },
        {
          label: '关闭桌面界面（保持后台与手机远程随时可连）',
          click: async () => {
            clearStandbyPollTimer();
            isQuitting = true;
            try {
              if (mainWindow && !mainWindow.isDestroyed()) {
                await mainWindow.loadURL('about:blank').catch(() => {});
                await new Promise((r) => setTimeout(r, 250));
              }
              await fetch(`${currentTargetOrigin}/api/admin/standby`, { method: 'POST' }).catch(
                () => {}
              );
            } catch {
              // ignore
            }
            app.quit();
          },
        },
        {
          label: '彻底停止后台服务与远程通道并退出',
          click: async () => {
            isQuitting = true;
            try {
              await fetch('http://127.0.0.1:8866/api/admin/shutdown', { method: 'POST' });
            } catch {
              // ignore
            }
            app.quit();
          },
        },
      ]);
      tray.setContextMenu(menu);
    };
    updateTrayMenu();
    tray.on('click', () => summonMainWindow());
  } catch {
    // Non-fatal if tray unavailable
  }
}

ipcMain.handle('win:minimize', () => {
  mainWindow?.minimize();
});

ipcMain.handle('win:toggleMaximize', () => {
  if (!mainWindow) return { maximized: false };
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
  return { maximized: mainWindow.isMaximized() };
});

ipcMain.handle('win:close', () => {
  mainWindow?.close();
});

ipcMain.handle('win:toggleAlwaysOnTop', () => {
  if (!mainWindow) return { alwaysOnTop: false };
  const next = !mainWindow.isAlwaysOnTop();
  mainWindow.setAlwaysOnTop(next);
  return { alwaysOnTop: next };
});

ipcMain.handle('win:getState', () => ({
  maximized: mainWindow?.isMaximized() || false,
  alwaysOnTop: mainWindow?.isAlwaysOnTop() || false,
  shortcut: 'Ctrl+Alt+W',
}));

ipcMain.handle('win:notifyUnread', (_event, payload = {}) => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const count = Math.max(0, Number(payload.count) || 0);
  if (count === 0) {
    clearUnreadIndicators();
    return true;
  }

  const isBackgrounded =
    !mainWindow.isVisible() || mainWindow.isMinimized() || !mainWindow.isFocused();
  if (!isBackgrounded) {
    clearUnreadIndicators();
    return true;
  }

  if (tray && !tray.isDestroyed() && iconUnread && !iconUnread.isEmpty()) {
    tray.setImage(iconUnread);
    tray.setToolTip(`AChat — ${count} 条新消息 (Ctrl+Alt+W)`);
  }
  mainWindow.flashFrame(true);

  if (payload.notifyTitle && Notification.isSupported()) {
    try {
      const notif = new Notification({
        title: String(payload.notifyTitle).slice(0, 64),
        body: String(payload.notifyBody || '收到新回复').slice(0, 140),
        icon: path.join(PUBLIC_DIR, 'achat.ico'),
        silent: true,
      });
      notif.on('click', () => summonMainWindow());
      notif.show();
    } catch {
      // ignore notification failure
    }
  }
  return true;
});

ipcMain.handle('dialog:pickDirectory', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '选择群聊绑定的项目文件夹',
    properties: ['openDirectory'],
  });
  if (res.canceled || !res.filePaths?.[0]) return null;
  return res.filePaths[0];
});

ipcMain.handle('dialog:pickFiles', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '选择要发送给 Agent 的本地文件',
    properties: ['openFile', 'multiSelections'],
  });
  if (res.canceled || !res.filePaths?.length) return [];
  return res.filePaths;
});

ipcMain.handle('shell:openPath', async (_event, targetPath) => {
  if (!targetPath) return false;
  await shell.openPath(String(targetPath));
  return true;
});

ipcMain.handle('win:captureScreen', async () => {
  const canHide =
    mainWindow &&
    !mainWindow.isDestroyed() &&
    mainWindow.isVisible() &&
    !mainWindow.isMinimized();
  try {
    const display = resolveActiveTargetDisplay();
    const scale = Math.min(2, Math.max(1, Number(display?.scaleFactor) || 1));
    const width = Math.min(3840, Math.round((display?.size?.width || 1920) * scale));
    const height = Math.min(2160, Math.round((display?.size?.height || 1080) * scale));

    if (canHide) {
      mainWindow.setOpacity(0);
      await new Promise((r) => setTimeout(r, 130));
    }

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width, height },
    });
    const matched =
      sources.find((s) => String(s.display_id) === String(display?.id || '')) || sources[0];
    if (!matched || matched.thumbnail.isEmpty()) {
      return { ok: false, error: '未能捕获当前屏幕画面' };
    }
    const sz = matched.thumbnail.getSize();
    const pngBuf = matched.thumbnail.toPNG();
    return {
      ok: true,
      width: sz.width,
      height: sz.height,
      dataUrl: `data:image/png;base64,${pngBuf.toString('base64')}`,
    };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  } finally {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setOpacity(1);
      summonMainWindow();
    }
  }
});

ipcMain.handle('win:captureDesktopPreview', async (_event, opts = {}) => {
  try {
    const display = resolveActiveTargetDisplay();
    const scale = Math.min(2, Math.max(1, Number(display?.scaleFactor) || 1));
    const origWidth = Math.round((display?.size?.width || 1920) * scale);
    const origHeight = Math.round((display?.size?.height || 1080) * scale);
    const maxWidth = Math.max(480, Math.min(1920, Number(opts?.maxWidth) || 1280));
    const quality = Math.max(40, Math.min(90, Number(opts?.quality) || 70));
    const ratio = origWidth > maxWidth ? maxWidth / origWidth : 1;
    const thumbW = Math.max(320, Math.round(origWidth * ratio));
    const thumbH = Math.max(180, Math.round(origHeight * ratio));

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: thumbW, height: thumbH },
    });
    const matched =
      sources.find((s) => String(s.display_id) === String(display?.id || '')) || sources[0];
    if (!matched || matched.thumbnail.isEmpty()) {
      return { ok: false, error: '未能静默捕获桌面画面' };
    }
    const sz = matched.thumbnail.getSize();
    const jpegBuf = matched.thumbnail.toJPEG(quality);
    return {
      ok: true,
      width: sz.width,
      height: sz.height,
      origWidth,
      origHeight,
      mimeType: 'image/jpeg',
      base64: jpegBuf.toString('base64'),
    };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});

if (gotLock) {
  app.whenReady().then(bootstrap).catch((err) => {
    appendLaunchLog('bootstrap-error', { error: String(err?.stack || err) });
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, 'electron-boot-error.log'), String(err?.stack || err));
    console.error('BOOTSTRAP ERROR:', err);
    app.quit();
  });
}

app.on('will-quit', () => {
  try {
    globalShortcut.unregisterAll();
  } catch {
    // ignore
  }
});

app.on('before-quit', async () => {
  isQuitting = true;
  if (serverHandle) {
    await serverHandle.close().catch(() => {});
  }
});
