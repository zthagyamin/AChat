import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { CcccBridge, computeGroupsFingerprint } from './cccc-bridge.mjs';
import {
  captureHostScreenPreview,
  detectProviderEcosystem,
  getCachedScreenPreviewAgeMs,
  queryTailscaleStatus,
  updateCachedScreenPreview,
  waitForFreshScreenPreview,
} from './fusion-hub.mjs';
import { TunnelManager } from './tunnel-manager.mjs';
import { startAntigravityDesktopHubHealWatcher } from './session-router.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const RELEASES_DIR = path.join(ROOT_DIR, 'releases');
const APK_PRIMARY_PATH = path.join(RELEASES_DIR, 'AChat.apk');
const APK_LEGACY_PATH = path.join(RELEASES_DIR, 'Agent微信.apk');

function resolveApkPath() {
  if (fs.existsSync(APK_PRIMARY_PATH)) return APK_PRIMARY_PATH;
  if (fs.existsSync(APK_LEGACY_PATH)) return APK_LEGACY_PATH;
  return APK_PRIMARY_PATH;
}
const LEGACY_SIBLING_UPLOADS = path.resolve(ROOT_DIR, '..', 'cccc-room', 'uploads');
const UPLOADS_DIR =
  process.env.ACHAT_UPLOADS_DIR ||
  (fs.existsSync(LEGACY_SIBLING_UPLOADS) ? LEGACY_SIBLING_UPLOADS : path.join(DATA_DIR, 'uploads'));
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|svg)$/i;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.apk': 'application/vnd.android.package-archive',
};

const BLOCKED_EXEC_EXT_RE =
  /\.(exe|bat|cmd|com|scr|pif|vbs|vbe|jse|wsf|wsh|msi|msp|hta|cpl|reg|ps1|lnk)$/i;

export function validateLocalOpenTarget(rawPath) {
  if (typeof rawPath !== 'string') return null;
  let trimmed = rawPath.trim().replace(/^[`"']+|[`"']+$/g, '').trim();
  if (!trimmed || trimmed.includes('\0')) return null;
  if (/^(https?|javascript|data|file|mailto|achat):/i.test(trimmed)) return null;
  if (trimmed.startsWith('\\\\')) return null;
  if (!/^[a-zA-Z]:[\\/]/.test(trimmed)) return null;
  try {
    const resolved = path.resolve(trimmed);
    if (!fs.existsSync(resolved)) return null;
    return resolved;
  } catch {
    return null;
  }
}

const assetVersionMemo = new Map();

export async function computePublicAssetVersion(publicDir = PUBLIC_DIR) {
  const resolvedDir = path.resolve(publicDir);
  const tracked = ['index.html', 'styles.css', 'app.mjs', 'sw.js'];
  const statParts = [];
  for (const rel of tracked) {
    const full = path.join(resolvedDir, rel);
    try {
      const st = await fsp.stat(full);
      statParts.push(`${rel}:${st.size}:${st.mtimeMs}`);
    } catch {
      statParts.push(`${rel}:missing`);
    }
  }
  const sig = statParts.join('|');
  const prev = assetVersionMemo.get(resolvedDir);
  if (prev && prev.sig === sig) {
    return prev.version;
  }

  const hash = crypto.createHash('sha256');
  for (const rel of tracked) {
    const full = path.join(resolvedDir, rel);
    try {
      const buf = await fsp.readFile(full);
      hash.update(rel);
      hash.update(buf);
    } catch {
      // ignore missing file in minimal test directories
    }
  }
  const version = hash.digest('hex').slice(0, 12);
  assetVersionMemo.set(resolvedDir, { sig, version });
  return version;
}

const serverVersionMemo = new Map();

export async function computeServerCodeVersion(serverDir = __dirname) {
  const resolvedDir = path.resolve(serverDir);
  let tracked = [];
  try {
    tracked = (await fsp.readdir(resolvedDir))
      .filter((name) => name.endsWith('.mjs'))
      .sort();
  } catch {
    tracked = [];
  }
  const statParts = [];
  for (const rel of tracked) {
    const full = path.join(resolvedDir, rel);
    try {
      const st = await fsp.stat(full);
      statParts.push(`${rel}:${st.size}:${st.mtimeMs}`);
    } catch {
      statParts.push(`${rel}:missing`);
    }
  }
  const sig = statParts.join('|');
  const prev = serverVersionMemo.get(resolvedDir);
  if (prev && prev.sig === sig) {
    return prev.version;
  }

  const hash = crypto.createHash('sha256');
  for (const rel of tracked) {
    const full = path.join(resolvedDir, rel);
    try {
      const buf = await fsp.readFile(full);
      hash.update(rel);
      hash.update(buf);
    } catch {
      // ignore missing file
    }
  }
  const version = hash.digest('hex').slice(0, 12);
  serverVersionMemo.set(resolvedDir, { sig, version });
  return version;
}

function isLoopback(remoteAddress = '') {
  return (
    remoteAddress === '127.0.0.1' ||
    remoteAddress === '::1' ||
    remoteAddress === '::ffff:127.0.0.1'
  );
}

export function isDirectLocalRequest(req) {
  if (!isLoopback(req.socket?.remoteAddress)) return false;
  if (
    req.headers['cf-connecting-ip'] ||
    req.headers['x-forwarded-for'] ||
    req.headers['x-real-ip'] ||
    req.headers['forwarded'] ||
    req.headers['cdn-loop']
  ) {
    return false;
  }
  const rawHost = String(req.headers.host || '')
    .split(':')[0]
    .trim()
    .toLowerCase();
  return rawHost === '127.0.0.1' || rawHost === 'localhost' || rawHost === '[::1]';
}

function parseCookies(cookieHeader = '') {
  const out = {};
  for (const part of String(cookieHeader).split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      out[k] = decodeURIComponent(v);
    }
  }
  return out;
}

function timingSafeEqualStr(a = '', b = '') {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function discoverLanAddresses(port) {
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const [name, list] of Object.entries(nets)) {
    if (!Array.isArray(list)) continue;
    for (const info of list) {
      if (info.family !== 'IPv4' || info.internal) continue;
      const ip = info.address;
      if (ip.startsWith('169.254.')) continue;
      const lower = name.toLowerCase();
      const isTunOrProxy =
        ip.startsWith('198.18.') ||
        /^172\.(1[6-9]|2\d|3[0-1])\.\d+\.1$/.test(ip) ||
        /vethernet|wsl|vmware|virtualbox|docker|clash|mihomo|sing|tun|tap|wintun|lightxtreme|meta|vpn/.test(
          lower
        );
      const isTailscale = ip.startsWith('100.') || lower.includes('tailscale');
      const isPhysicalLan =
        !isTunOrProxy &&
        (/wi-fi|wlan|ethernet|以太网/.test(lower) || ip.startsWith('192.168.'));

      let priority = 3;
      if (isPhysicalLan) priority = 1;
      else if (isTailscale) priority = 2;
      else if (isTunOrProxy) priority = 8;

      candidates.push({
        name,
        ip,
        isTailscale,
        isVirtual: isTunOrProxy,
        priority,
        url: `http://${ip}:${port}`,
      });
    }
  }
  candidates.sort((a, b) => a.priority - b.priority);
  return candidates;
}

async function loadOrCreateAccessToken(dataDir = DATA_DIR) {
  await fsp.mkdir(dataDir, { recursive: true });
  const tokenFile = path.join(dataDir, 'access-token.txt');
  if (fs.existsSync(tokenFile)) {
    const saved = (await fsp.readFile(tokenFile, 'utf8')).trim();
    if (saved.length >= 24) return saved;
  }
  const fresh = crypto.randomBytes(20).toString('hex');
  await fsp.writeFile(tokenFile, fresh, { encoding: 'utf8', mode: 0o600 });
  return fresh;
}

async function loadOrCreateInviteCode(dataDir = DATA_DIR) {
  await fsp.mkdir(dataDir, { recursive: true });
  const inviteFile = path.join(dataDir, 'invite-code.txt');
  if (fs.existsSync(inviteFile)) {
    const saved = (await fsp.readFile(inviteFile, 'utf8')).trim();
    if (saved.length >= 16) return saved;
  }
  const fresh = crypto.randomBytes(14).toString('base64url');
  await fsp.writeFile(inviteFile, fresh, { encoding: 'utf8', mode: 0o600 });
  return fresh;
}

function readActiveTunnelUrl(dataDir = DATA_DIR) {
  try {
    const p = path.join(dataDir, 'remote-tunnel.json');
    if (!fs.existsSync(p)) return '';
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    const url = String(parsed?.publicUrl || '').trim().replace(/\/+$/, '');
    return /^https:\/\/[a-z0-9.-]+$/i.test(url) ? url : '';
  } catch {
    return '';
  }
}

function readSavedBeaconId(dataDir = DATA_DIR) {
  try {
    const p = path.join(dataDir, 'beacon-state.json');
    if (!fs.existsSync(p)) return '';
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    const id = String(parsed?.beaconId || '').trim();
    return /^[a-f0-9]{20,40}$/i.test(id) ? id : '';
  } catch {
    return '';
  }
}

function renderMobileInviteHtml({ originUrl, accessToken, inviteCode, beaconId, apkSizeMb }) {
  const beaconSuffix = beaconId ? `&beacon=${encodeURIComponent(beaconId)}` : '';
  const fullPairUrl = `${originUrl}/?token=${encodeURIComponent(accessToken)}${beaconSuffix}`;
  const deepLinkUrl = `achat://connect?url=${encodeURIComponent(fullPairUrl)}`;
  const apkUrl = `/download/achat.apk?invite=${encodeURIComponent(inviteCode)}`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>AChat · 手机安装与远程直连</title>
  <link rel="icon" href="/icon-192.png?v=2">
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100dvh;
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
      background: #f1f5f9;
      color: #0f172a;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px 16px;
    }
    .card {
      width: 100%;
      max-width: 420px;
      background: #ffffff;
      border-radius: 16px;
      padding: 26px 22px 22px;
      border: 1px solid #dbe3ed;
      box-shadow: 0 14px 36px rgba(15, 23, 42, 0.08);
      text-align: center;
    }
    .logo {
      width: 72px;
      height: 72px;
      border-radius: 16px;
      margin: 0 auto 12px;
      display: block;
    }
    h1 {
      margin: 0 0 4px;
      font-size: 21px;
      font-weight: 700;
      letter-spacing: -0.01em;
    }
    .sub {
      margin: 0 0 12px;
      font-size: 12.5px;
      color: #64748b;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 11px;
      border-radius: 999px;
      background: #e0f2fe;
      color: #0369a1;
      font-size: 12px;
      font-weight: 600;
      margin-bottom: 18px;
    }
    .step-box {
      text-align: left;
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 12px;
      padding: 14px;
      margin-bottom: 12px;
    }
    .step-title {
      font-size: 13px;
      font-weight: 600;
      color: #1e293b;
      margin-bottom: 8px;
    }
    .btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      min-height: 46px;
      border-radius: 10px;
      border: none;
      font-size: 15px;
      font-weight: 600;
      text-decoration: none;
      cursor: pointer;
      padding: 10px 14px;
    }
    .btn-primary {
      background: #0369a1;
      color: #ffffff;
    }
    .btn-primary:active { background: #075985; }
    .btn-outline {
      background: #ffffff;
      color: #0369a1;
      border: 1.5px solid #0284c7;
      margin-top: 8px;
      font-size: 14px;
      min-height: 42px;
    }
    .btn-ghost {
      background: #eef2f7;
      color: #334155;
      margin-top: 8px;
      font-size: 13.5px;
      min-height: 40px;
    }
    .hint {
      margin: 8px 0 0;
      font-size: 12px;
      color: #64748b;
      line-height: 1.45;
    }
    .toast {
      margin-top: 10px;
      font-size: 12.5px;
      color: #0369a1;
      font-weight: 600;
      min-height: 18px;
    }
  </style>
</head>
<body>
  <main class="card">
    <img class="logo" src="/icon-192.png?v=2" alt="AChat">
    <h1>AChat</h1>
    <p class="sub">AgentChat · 多智能体实时协作</p>
    <div class="badge">● 电脑端在线 · 已开启永久加密自动寻址</div>

    <section class="step-box">
      <div class="step-title">第一步：下载或原位覆盖升级（v1.5.0 全功能协作版）</div>
      <a class="btn btn-primary" href="${apkUrl}" download="AChat.apk">⬇️ 下载 AChat.apk (${apkSizeMb} MB)</a>
      <p class="hint">已安装旧版可直接覆盖升级为 AChat（自动保留原有配对与记录）。若内置浏览器打不开下载，请点右上角「在系统浏览器中打开」。</p>
    </section>

    <section class="step-box">
      <div class="step-title">第二步：配对一次，此后手机 App 随时点开即连</div>
      <a id="wakeBtn" class="btn btn-outline" href="${deepLinkUrl}">🚀 一键唤醒 AChat 并绑定永久寻址</a>
      <button id="copyBtn" class="btn btn-ghost" type="button">📋 复制永久配对口令（App 内粘贴即连）</button>
      <p class="hint">绑定后即使免费隧道域名定时轮换，AChat 也会通过 AES-256-GCM 加密信标自动获取新地址，无需再换链接。</p>
    </section>

    <a class="btn btn-ghost" href="/">💬 暂不安装 App，直接在网页版打开 AChat</a>
    <div id="toast" class="toast" aria-live="polite"></div>
  </main>
  <script>
    const pairUrl = ${JSON.stringify(fullPairUrl)};
    const toast = document.getElementById('toast');
    document.getElementById('copyBtn').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(pairUrl);
        toast.textContent = '✅ 配对链接已复制！打开「AChat」App 点「从剪贴板粘贴」即可秒连';
      } catch {
        const ta = document.createElement('textarea');
        ta.value = pairUrl;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        toast.textContent = '✅ 配对链接已复制！打开「AChat」App 点「从剪贴板粘贴」即可秒连';
      }
    });
    document.getElementById('wakeBtn').addEventListener('click', () => {
      navigator.clipboard?.writeText?.(pairUrl).catch(() => {});
      toast.textContent = '正在唤醒 AChat App（同时已自动复制配对口令备用）…';
    });
  </script>
</body>
</html>`;
}

function readJsonBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error('请求体过大'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('JSON 格式错误'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export async function startAgentWeChatServer({
  port = 8866,
  host = '0.0.0.0',
  enableTunnel = process.env.AW_DISABLE_TUNNEL !== '1',
  dataDir = DATA_DIR,
  uploadsDir = UPLOADS_DIR,
  bridgeOptions = {},
  startInStandby = false,
  idleStandbyMs = 60_000,
} = {}) {
  const accessToken = await loadOrCreateAccessToken(dataDir);
  const inviteCode = await loadOrCreateInviteCode(dataDir);
  const bootServerVersion = await computeServerCodeVersion();
  const bridge = new CcccBridge({ dataDir, uploadsDir, ...bridgeOptions });
  await bridge.init({ standby: Boolean(startInStandby) });

  let tunnelManager = null;
  const agyHubHealWatcher = startAntigravityDesktopHubHealWatcher();
  const sseClients = new Set();
  let lastClientActivityAt = startInStandby ? 0 : Date.now();

  function broadcastSse(eventName, payload) {
    const frame = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(frame);
      } catch {
        sseClients.delete(client);
      }
    }
  }

  bridge.on('message', (data) => {
    broadcastSse('message', data);
  });

  bridge.on('activity', (data) => {
    broadcastSse('activity', data);
  });

  bridge.on('relay', (data) => {
    broadcastSse('relay', data);
  });

  bridge.on('stream', (data) => {
    broadcastSse('stream', data);
  });

  bridge.on('ideBoard', (data) => {
    broadcastSse('ideBoard', data);
  });

  bridge.on('clientSync', (data) => {
    broadcastSse('clientSync', data);
  });

  bridge.on('cardSettled', (data) => {
    broadcastSse('cardSettled', data);
  });

  let lastBroadcastGroupsFp = '';
  function broadcastGroupsIfChanged(groups) {
    if (sseClients.size === 0 || !Array.isArray(groups)) return;
    const fp = computeGroupsFingerprint(groups);
    if (fp === lastBroadcastGroupsFp) return;
    lastBroadcastGroupsFp = fp;
    broadcastSse('groups', { groups });
  }

  bridge.on('groups', (groups) => {
    broadcastGroupsIfChanged(groups);
  });

  const statusHeartbeat = setInterval(async () => {
    if (sseClients.size === 0 || bridge.standbyMode) return;
    try {
      const cacheAgeMs = Date.now() - (bridge.groupMetaCache?.ts || 0);
      const groups =
        cacheAgeMs > 8500 || !bridge.groupMetaCache?.data
          ? await bridge.listGroups({ background: true })
          : bridge.groupMetaCache.data;
      broadcastGroupsIfChanged(groups);
    } catch {
      // ignore transient error
    }
  }, 6500);

  const safeIdleStandbyMs = Math.max(250, Number(idleStandbyMs) || 60_000);
  const idleCheckIntervalMs = Math.min(15_000, Math.max(150, Math.floor(safeIdleStandbyMs / 2)));
  const idleStandbyTimer = setInterval(() => {
    if (bridge.standbyMode || sseClients.size > 0) return;
    if (Date.now() - lastClientActivityAt < safeIdleStandbyMs) return;
    if (bridge.hasActiveWork()) return;
    bridge.enterStandby().catch(() => {});
  }, idleCheckIntervalMs);
  idleStandbyTimer.unref?.();

  function isAuthorized(req, parsedUrl) {
    if (isDirectLocalRequest(req)) return true;
    const queryToken = parsedUrl.searchParams.get('token') || '';
    if (queryToken && timingSafeEqualStr(queryToken, accessToken)) return true;
    const queryInvite = parsedUrl.searchParams.get('invite') || '';
    if (queryInvite && timingSafeEqualStr(queryInvite, inviteCode)) return true;
    const cookies = parseCookies(req.headers.cookie || '');
    if (cookies.aw_token && timingSafeEqualStr(cookies.aw_token, accessToken)) return true;
    const authHeader = String(req.headers.authorization || '');
    if (authHeader.startsWith('Bearer ')) {
      const bearer = authHeader.slice(7).trim();
      if (timingSafeEqualStr(bearer, accessToken)) return true;
    }
    return false;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
      const pathname = parsedUrl.pathname;
      const hostHeader = String(req.headers.host || '').trim();
      const activeTunnel = tunnelManager?.publicUrl || readActiveTunnelUrl(dataDir);
      const activeBeaconId = tunnelManager?.beaconId || readSavedBeaconId(dataDir);
      const isHttps =
        String(req.headers['x-forwarded-proto'] || '').toLowerCase().includes('https') ||
        String(req.headers['forwarded'] || '').toLowerCase().includes('proto=https') ||
        String(req.headers['cf-visitor'] || '').toLowerCase().includes('"https"') ||
        /\.(?:trycloudflare\.com|lhr\.life|pinggy\.link|ngrok-free\.app)(?::\d+)?$/i.test(
          hostHeader
        ) ||
        Boolean(activeTunnel && hostHeader && activeTunnel.toLowerCase() === `https://${hostHeader.toLowerCase()}`);
      const cookieFlags = `HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax${isHttps ? '; Secure' : ''}`;

      // Mobile Remote Invite Landing Page (/invite/<code>)
      const inviteMatch = pathname.match(/^\/invite\/([a-zA-Z0-9_-]+)$/);
      if ((req.method === 'GET' || req.method === 'HEAD') && inviteMatch) {
        if (!timingSafeEqualStr(inviteMatch[1], inviteCode)) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Invite link invalid or expired');
          return;
        }
        lastClientActivityAt = Date.now();
        if (bridge.standbyMode) {
          bridge.wakeFromStandby().catch(() => {});
        }
        const proto = isHttps ? 'https' : 'http';
        const originUrl = `${proto}://${req.headers.host || `127.0.0.1:${port}`}`;
        const apkFile = resolveApkPath();
        const apkSizeMb = fs.existsSync(apkFile)
          ? Number(((await fsp.stat(apkFile)).size / (1024 * 1024)).toFixed(2))
          : 4.72;
        const html = renderMobileInviteHtml({
          originUrl,
          accessToken,
          inviteCode,
          beaconId: activeBeaconId,
          apkSizeMb,
        });
        const buf = Buffer.from(html, 'utf8');
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': buf.length,
          'Cache-Control': 'no-store',
          'Set-Cookie': `aw_token=${encodeURIComponent(accessToken)}; ${cookieFlags}`,
        });
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        res.end(buf);
        return;
      }

      // Exchange ?token=... into an HttpOnly cookie on entry
      const queryToken = parsedUrl.searchParams.get('token');
      if (pathname === '/' && queryToken && timingSafeEqualStr(queryToken, accessToken)) {
        lastClientActivityAt = Date.now();
        if (bridge.standbyMode) {
          bridge.wakeFromStandby().catch(() => {});
        }
        res.writeHead(302, {
          'Set-Cookie': `aw_token=${encodeURIComponent(accessToken)}; ${cookieFlags}`,
          Location: '/',
        });
        res.end();
        return;
      }

      const authed = isAuthorized(req, parsedUrl);

      // Vendor ESM bundles (offline-safe for LAN phones & desktop)
      if (req.method === 'GET' && pathname === '/vendor/marked.esm.js') {
        const p = path.join(ROOT_DIR, 'node_modules', 'marked', 'lib', 'marked.esm.js');
        const content = await fsp.readFile(p);
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
        res.end(content);
        return;
      }
      if (req.method === 'GET' && pathname === '/vendor/purify.es.mjs') {
        const p = path.join(ROOT_DIR, 'node_modules', 'dompurify', 'dist', 'purify.es.mjs');
        const content = await fsp.readFile(p);
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
        res.end(content);
        return;
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && pathname.startsWith('/vendor/katex/')) {
        const katexRoot = path.resolve(ROOT_DIR, 'node_modules', 'katex', 'dist');
        const subRel = decodeURIComponent(pathname.slice('/vendor/katex/'.length));
        const resolvedKatex = path.resolve(katexRoot, subRel);
        if (
          !resolvedKatex.toLowerCase().startsWith(`${katexRoot.toLowerCase()}${path.sep}`) ||
          !fs.existsSync(resolvedKatex) ||
          (await fsp.stat(resolvedKatex)).isDirectory()
        ) {
          res.writeHead(404);
          res.end('Not Found');
          return;
        }
        const ext = path.extname(resolvedKatex).toLowerCase();
        const content = await fsp.readFile(resolvedKatex);
        res.writeHead(200, {
          'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
          'Content-Length': content.length,
          'Cache-Control': 'public, max-age=604800, immutable',
        });
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        res.end(content);
        return;
      }

      if ((req.method === 'GET' || req.method === 'HEAD') && pathname.startsWith('/vendor/mermaid/')) {
        const mermaidRoot = path.resolve(ROOT_DIR, 'node_modules', 'mermaid', 'dist');
        const subRel = decodeURIComponent(pathname.slice('/vendor/mermaid/'.length));
        const resolvedMermaid = path.resolve(mermaidRoot, subRel);
        if (
          !resolvedMermaid.toLowerCase().startsWith(`${mermaidRoot.toLowerCase()}${path.sep}`) ||
          !fs.existsSync(resolvedMermaid) ||
          (await fsp.stat(resolvedMermaid)).isDirectory()
        ) {
          res.writeHead(404);
          res.end('Not Found');
          return;
        }
        const ext = path.extname(resolvedMermaid).toLowerCase();
        const content = await fsp.readFile(resolvedMermaid);
        res.writeHead(200, {
          'Content-Type': MIME_TYPES[ext] || 'application/javascript; charset=utf-8',
          'Content-Length': content.length,
          'Cache-Control': 'public, max-age=604800, immutable',
        });
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        res.end(content);
        return;
      }

      // Download standalone signed Android APK (supports both /download/achat.apk and legacy /download/agent-wechat.apk)
      if (
        (req.method === 'GET' || req.method === 'HEAD') &&
        (pathname === '/download/achat.apk' || pathname === '/download/agent-wechat.apk')
      ) {
        if (!authed) {
          sendJson(res, 401, {
            error: '未授权下载：请在电脑端「手机扫码直连」弹窗中扫码后再下载安装包',
          });
          return;
        }
        const apkFile = resolveApkPath();
        if (!fs.existsSync(apkFile)) {
          sendJson(res, 404, {
            error: '安卓安装包尚在构建中，请稍候几秒再试',
          });
          return;
        }
        const stat = await fsp.stat(apkFile);
        res.writeHead(200, {
          'Content-Type': 'application/vnd.android.package-archive',
          'Content-Length': stat.size,
          'Content-Disposition':
            "attachment; filename=\"AChat.apk\"; filename*=UTF-8''AChat.apk",
          'Cache-Control': 'no-cache',
        });
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        fs.createReadStream(apkFile).pipe(res);
        return;
      }

      // Auth check endpoint for frontend (never wakes Standby Mode)
      if (req.method === 'GET' && pathname === '/api/session') {
        const [assetVersion, serverVersion] = await Promise.all([
          computePublicAssetVersion(),
          computeServerCodeVersion(),
        ]);
        sendJson(res, 200, {
          authorized: authed,
          isLocal: isDirectLocalRequest(req),
          assetVersion,
          bootServerVersion,
          serverVersion,
          serverStale: bootServerVersion !== serverVersion,
          standby: Boolean(bridge.standbyMode),
          activeWork: Boolean(bridge.hasActiveWork()),
        });
        return;
      }

      // Protect all /api/* endpoints
      if (pathname.startsWith('/api/')) {
        if (!authed) {
          sendJson(res, 401, {
            error: '未授权访问：请在电脑端点击左下角「手机图标」扫码打开本页',
          });
          return;
        }

        if (req.method === 'POST' && pathname === '/api/admin/shutdown') {
          if (!isDirectLocalRequest(req)) {
            sendJson(res, 403, { error: '仅限本机操作' });
            return;
          }
          sendJson(res, 200, { ok: true });
          setTimeout(async () => {
            clearInterval(statusHeartbeat);
            clearInterval(idleStandbyTimer);
            agyHubHealWatcher.stop();
            tunnelManager?.stop();
            await bridge.enterStandby().catch(() => {
              bridge.stop();
            });
            for (const client of sseClients) {
              try {
                client.end();
              } catch {}
            }
            server.closeAllConnections?.();
            server.close(() => process.exit(0));
            setTimeout(() => process.exit(0), 1500);
          }, 80);
          return;
        }

        if (req.method === 'POST' && pathname === '/api/admin/restart') {
          if (!isDirectLocalRequest(req)) {
            sendJson(res, 403, { error: '仅限本机操作' });
            return;
          }
          if (bridge.hasActiveWork()) {
            sendJson(res, 409, { error: '当前有任务执行中，暂不自动重启服务' });
            return;
          }
          sendJson(res, 200, { ok: true, restarting: true });
          setTimeout(async () => {
            clearInterval(statusHeartbeat);
            clearInterval(idleStandbyTimer);
            agyHubHealWatcher.stop();
            tunnelManager?.stop();
            await bridge.enterStandby().catch(() => {
              bridge.stop();
            });
            for (const client of sseClients) {
              try {
                client.end();
              } catch {}
            }
            let spawned = false;
            const spawnFreshAndExit = () => {
              if (spawned) return;
              spawned = true;
              try {
                const entryScript = fileURLToPath(import.meta.url);
                const args = [entryScript, ...(startInStandby ? ['--standby'] : [])];
                const child = spawn(process.execPath, args, {
                  cwd: path.resolve(__dirname, '..'),
                  detached: true,
                  stdio: 'ignore',
                  windowsHide: true,
                });
                child.unref();
              } catch {}
              process.exit(0);
            };
            server.closeAllConnections?.();
            server.close(spawnFreshAndExit);
            setTimeout(spawnFreshAndExit, 1500);
          }, 80);
          return;
        }

        if (req.method === 'POST' && pathname === '/api/admin/standby') {
          if (!isDirectLocalRequest(req)) {
            sendJson(res, 403, { error: '仅限本机操作' });
            return;
          }
          if (sseClients.size > 0) {
            sendJson(res, 200, {
              ok: true,
              standby: false,
              reason: 'active_clients',
              sseClients: sseClients.size,
            });
            return;
          }
          if (bridge.hasActiveWork()) {
            sendJson(res, 200, {
              ok: true,
              standby: false,
              reason: 'active_work',
            });
            return;
          }
          await bridge.enterStandby();
          sendJson(res, 200, { ok: true, standby: Boolean(bridge.standbyMode) });
          return;
        }

        if (req.method === 'GET' && pathname === '/api/tunnel-status') {
          sendJson(
            res,
            200,
            tunnelManager
              ? tunnelManager.getSnapshot()
              : {
                  publicUrl: readActiveTunnelUrl(dataDir),
                  beaconId: readSavedBeaconId(dataDir),
                  status: 'external',
                }
          );
          return;
        }

        lastClientActivityAt = Date.now();
        if (bridge.standbyMode) {
          await bridge.wakeFromStandby();
        }

        if (req.method === 'GET' && pathname === '/api/events') {
          const assetVersion = await computePublicAssetVersion();
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'X-Accel-Buffering': 'no',
            Connection: 'keep-alive',
          });
          res.write(`event: connected\ndata: ${JSON.stringify({ ok: true, assetVersion })}\n\n`);
          sseClients.add(res);
          req.on('close', () => {
            sseClients.delete(res);
            lastClientActivityAt = Date.now();
          });
          return;
        }

        if (req.method === 'GET' && pathname === '/api/bootstrap') {
          const [payload, assetVersion, clientSync] = await Promise.all([
            bridge.getFastBootstrap({
              force: parsedUrl.searchParams.get('force') === '1',
            }),
            computePublicAssetVersion(),
            bridge.getClientSyncState(),
          ]);
          sendJson(res, 200, { ...payload, assetVersion, clientSync });
          return;
        }

        if (pathname === '/api/client-sync') {
          if (req.method === 'GET') {
            const clientSync = await bridge.getClientSyncState();
            sendJson(res, 200, { ok: true, clientSync });
            return;
          }
          if (req.method === 'POST') {
            const body = await readJsonBody(req);
            const clientSync = await bridge.mutateClientSyncState(body);
            sendJson(res, 200, { ok: true, clientSync });
            return;
          }
        }

        if (req.method === 'GET' && pathname === '/api/search') {
          const q = parsedUrl.searchParams.get('q') || '';
          const hits = await bridge.searchMessages(q, { limit: 40 });
          sendJson(res, 200, { hits });
          return;
        }

        if (req.method === 'GET' && pathname === '/api/external-sessions') {
          const force = parsedUrl.searchParams.get('force') === '1';
          const limit = Number(parsedUrl.searchParams.get('limit') || 28);
          const catalog = await bridge.listExternalSessions({ force, limit });
          sendJson(res, 200, { ok: true, ...catalog });
          return;
        }

        if (req.method === 'GET' && pathname === '/api/providers') {
          const actualPort = server.address()?.port || port;
          const force = parsedUrl.searchParams.get('force') === '1';
          const [ecosystem, tailscale] = await Promise.all([
            detectProviderEcosystem({
              force,
              dataDir,
              codexHomeDir: bridge.codexHomeDir,
            }),
            queryTailscaleStatus({ port: actualPort }),
          ]);
          sendJson(res, 200, { ok: true, ...ecosystem, tailscale });
          return;
        }

        if (pathname === '/api/computer-preview') {
          if (req.method === 'POST') {
            if (!isDirectLocalRequest(req)) {
              sendJson(res, 403, { error: '仅限本机桌面端推送屏幕缓存' });
              return;
            }
            const body = await readJsonBody(req, 16 * 1024 * 1024);
            const saved = updateCachedScreenPreview(body);
            sendJson(res, saved ? 200 : 400, saved || { ok: false, error: '无效的屏幕画面数据' });
            return;
          }
          if (req.method === 'GET') {
            const maxWidth = Number(parsedUrl.searchParams.get('maxWidth') || 1280);
            const quality = Number(parsedUrl.searchParams.get('quality') || 68);
            const wantsFresh = parsedUrl.searchParams.get('fresh') === '1';
            if ((wantsFresh || getCachedScreenPreviewAgeMs() > 1600) && sseClients.size > 0) {
              broadcastSse('requestDesktopFrame', {
                ts: Date.now(),
                maxWidth,
                quality,
              });
              await waitForFreshScreenPreview(850);
            }
            const snap = await captureHostScreenPreview({ maxWidth, quality });
            if (parsedUrl.searchParams.get('format') === 'raw' && snap.ok && snap.base64) {
              const imgBuf = Buffer.from(snap.base64, 'base64');
              res.writeHead(200, {
                'Content-Type': snap.mimeType || 'image/jpeg',
                'Content-Length': imgBuf.length,
                'Cache-Control': 'no-store',
              });
              res.end(imgBuf);
              return;
            }
            sendJson(res, 200, snap);
            return;
          }
        }

        const extPreviewMatch = pathname.match(
          /^\/api\/external-sessions\/(codex|antigravity)\/([a-zA-Z0-9._-]+)\/preview$/
        );
        if (req.method === 'GET' && extPreviewMatch) {
          const [, agentName, sid] = extPreviewMatch;
          const maxItems = Number(parsedUrl.searchParams.get('limit') || 3);
          const preview = await bridge.getExternalSessionPreview(agentName, sid, { maxItems });
          sendJson(res, 200, { ok: true, ...preview });
          return;
        }

        if (req.method === 'GET' && pathname === '/api/mobile-connect') {
          const actualPort = server.address()?.port || port;
          const [lanEndpoints, tailscale] = await Promise.all([
            Promise.resolve(discoverLanAddresses(actualPort)),
            queryTailscaleStatus({ port: actualPort }),
          ]);
          const tunnelUrl = tunnelManager?.publicUrl || readActiveTunnelUrl(dataDir);
          const beaconId = tunnelManager?.beaconId || readSavedBeaconId(dataDir);
          const beaconSuffix = beaconId ? `&beacon=${encodeURIComponent(beaconId)}` : '';
          const tailscaleDnsEndpoint =
            tailscale?.running && tailscale.dnsName
              ? [
                  {
                    name: `Tailscale MagicDNS (${tailscale.dnsName})`,
                    ip: tailscale.dnsName,
                    isTailscale: true,
                    isVirtual: false,
                  },
                ]
              : [];
          const endpoints = [
            ...(tunnelUrl
              ? [
                  {
                    name: beaconId ? 'HTTPS 异地永久自动寻址' : 'HTTPS 异地远程直连',
                    ip: tunnelUrl,
                    isTailscale: false,
                    isVirtual: false,
                  },
                ]
              : []),
            ...tailscaleDnsEndpoint,
            ...lanEndpoints,
          ];
          const selectedIp = parsedUrl.searchParams.get('ip') || endpoints[0]?.ip || '127.0.0.1';
          const isHttpsTunnel = selectedIp.startsWith('https://');
          const pairUrl = isHttpsTunnel
            ? `${selectedIp}/invite/${inviteCode}`
            : selectedIp === '127.0.0.1'
              ? `http://127.0.0.1:${actualPort}/`
              : `http://${selectedIp}:${actualPort}/?token=${accessToken}${beaconSuffix}`;
          const appDirectPairUrl = isHttpsTunnel
            ? `${selectedIp}/?token=${accessToken}${beaconSuffix}`
            : pairUrl;
          const apkFile = resolveApkPath();
          const apkAvailable = fs.existsSync(apkFile);
          const apkSizeMb = apkAvailable
            ? Number(((await fsp.stat(apkFile)).size / (1024 * 1024)).toFixed(2))
            : 0;
          const apkDownloadUrl = isHttpsTunnel
            ? `${selectedIp}/download/achat.apk?invite=${inviteCode}`
            : selectedIp === '127.0.0.1'
              ? `http://127.0.0.1:${actualPort}/download/achat.apk`
              : `http://${selectedIp}:${actualPort}/download/achat.apk?token=${accessToken}`;
          const qrSvg = await QRCode.toString(pairUrl, {
            type: 'svg',
            margin: 1,
            width: 200,
            color: { dark: '#0F172A', light: '#FFFFFF' },
          });
          sendJson(res, 200, {
            selectedIp,
            pairUrl,
            appDirectPairUrl,
            beaconId,
            qrSvg,
            apkAvailable,
            apkSizeMb,
            apkDownloadUrl,
            tailscale,
            endpoints: endpoints.map((e) => ({
              name: e.name,
              ip: e.ip,
              isTailscale: e.isTailscale,
              isVirtual: e.isVirtual,
            })),
          });
          return;
        }

        const gearMatch = pathname.match(/^\/api\/groups\/([a-zA-Z0-9_-]+)\/speed-gear$/);
        if (req.method === 'POST' && gearMatch) {
          const groupId = gearMatch[1];
          const body = await readJsonBody(req);
          const groups = await bridge.setGroupSpeedGear(groupId, body.gear);
          broadcastSse('groups', { groups });
          sendJson(res, 200, { ok: true, groups });
          return;
        }

        const turnCtrlMatch = pathname.match(/^\/api\/groups\/([a-zA-Z0-9_-]+)\/turn-control$/);
        if (req.method === 'POST' && turnCtrlMatch) {
          const groupId = turnCtrlMatch[1];
          const body = await readJsonBody(req);
          const result = await bridge.interruptOrRetryGroupTurn(groupId, body);
          if (result.groups) {
            broadcastSse('groups', { groups: result.groups });
          }
          sendJson(res, 200, result);
          return;
        }

        if (req.method === 'POST' && pathname === '/api/open-local-path') {
          if (!isDirectLocalRequest(req)) {
            sendJson(res, 403, { error: '仅限本机桌面端直开本地路径' });
            return;
          }
          const body = await readJsonBody(req);
          const validPath = validateLocalOpenTarget(body.targetPath);
          if (!validPath) {
            sendJson(res, 404, { error: '本地路径不存在或不可访问' });
            return;
          }
          const st = await fsp.stat(validPath);
          if (st.isDirectory()) {
            spawn('explorer.exe', [validPath], {
              detached: true,
              stdio: 'ignore',
              windowsHide: false,
            }).unref();
            sendJson(res, 200, { ok: true, mode: 'directory', path: validPath });
            return;
          }
          if (BLOCKED_EXEC_EXT_RE.test(validPath)) {
            spawn('explorer.exe', [`/select,${validPath}`], {
              detached: true,
              stdio: 'ignore',
              windowsHide: false,
            }).unref();
            sendJson(res, 200, { ok: true, mode: 'reveal', path: validPath });
            return;
          }
          spawn('rundll32.exe', ['url.dll,FileProtocolHandler', validPath], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
          }).unref();
          sendJson(res, 200, { ok: true, mode: 'open', path: validPath });
          return;
        }

        const prefsMatch = pathname.match(/^\/api\/groups\/([a-zA-Z0-9_-]+)\/prefs$/);
        if (req.method === 'POST' && prefsMatch) {
          const groupId = prefsMatch[1];
          const body = await readJsonBody(req);
          const prefs = await bridge.setGroupPrefs(groupId, body);
          const groups = await bridge.listGroups({ force: true });
          broadcastSse('groups', { groups });
          sendJson(res, 200, { ok: true, prefs, groups });
          return;
        }

        const settingsMatch = pathname.match(/^\/api\/groups\/([a-zA-Z0-9_-]+)\/settings$/);
        if (req.method === 'POST' && settingsMatch) {
          const groupId = settingsMatch[1];
          const body = await readJsonBody(req);
          const groups = await bridge.updateGroupSettings(groupId, body);
          broadcastSse('groups', { groups });
          sendJson(res, 200, { ok: true, groups });
          return;
        }

        const lifecycleMatch = pathname.match(/^\/api\/groups\/([a-zA-Z0-9_-]+)\/lifecycle$/);
        if (req.method === 'POST' && lifecycleMatch) {
          const groupId = lifecycleMatch[1];
          const body = await readJsonBody(req);
          const result = await bridge.manageGroupLifecycle(groupId, body);
          if (result.groups) {
            broadcastSse('groups', { groups: result.groups });
          }
          sendJson(res, 200, result);
          return;
        }

        const scopeFilesMatch = pathname.match(/^\/api\/groups\/([a-zA-Z0-9_-]+)\/scope-files$/);
        if (req.method === 'GET' && scopeFilesMatch) {
          const groupId = scopeFilesMatch[1];
          const query = parsedUrl.searchParams.get('q') || '';
          const limit = Number(parsedUrl.searchParams.get('limit') || 30);
          const data = await bridge.searchScopeFiles(groupId, { query, limit });
          sendJson(res, 200, data);
          return;
        }

        const gitSummaryMatch = pathname.match(/^\/api\/groups\/([a-zA-Z0-9_-]+)\/git-summary$/);
        if (req.method === 'GET' && gitSummaryMatch) {
          const groupId = gitSummaryMatch[1];
          const file = parsedUrl.searchParams.get('file') || '';
          const data = await bridge.getScopeGitSummary(groupId, { file });
          sendJson(res, 200, data);
          return;
        }

        const gitActionMatch = pathname.match(/^\/api\/groups\/([a-zA-Z0-9_-]+)\/git-action$/);
        if (req.method === 'POST' && gitActionMatch) {
          const groupId = gitActionMatch[1];
          const body = await readJsonBody(req);
          const data = await bridge.runScopeGitAction(groupId, body);
          sendJson(res, 200, data);
          return;
        }

        const cardActionMatch = pathname.match(/^\/api\/groups\/([a-zA-Z0-9_-]+)\/card-action$/);
        if (req.method === 'POST' && cardActionMatch) {
          const groupId = cardActionMatch[1];
          const body = await readJsonBody(req);
          const data = await bridge.resolveCardAction(groupId, body);
          sendJson(res, 200, data);
          return;
        }

        const msgMatch = pathname.match(/^\/api\/groups\/([a-zA-Z0-9_-]+)\/messages$/);
        if (msgMatch) {
          const groupId = msgMatch[1];
          if (req.method === 'GET') {
            const limitParam = Number(parsedUrl.searchParams.get('limit') || 0);
            const beforeIdx = parsedUrl.searchParams.get('beforeIndex');
            const sliced = await bridge.getMessagesSlice(groupId, {
              limit: limitParam,
              beforeIndex: beforeIdx,
            });
            sendJson(res, 200, sliced);
            return;
          }
          if (req.method === 'POST') {
            const body = await readJsonBody(req);
            const sent = await bridge.sendGroupMessage(groupId, body);
            sendJson(res, 200, { ok: true, message: sent });
            return;
          }
        }

        const retryActorMatch = pathname.match(/^\/api\/groups\/([a-zA-Z0-9_-]+)\/retry-actor$/);
        if (req.method === 'POST' && retryActorMatch) {
          const groupId = retryActorMatch[1];
          const body = await readJsonBody(req);
          const result = await bridge.retrySingleActor(groupId, body);
          if (result.groups) {
            broadcastSse('groups', { groups: result.groups });
          }
          sendJson(res, 200, result);
          return;
        }

        const actorMatch = pathname.match(
          /^\/api\/groups\/([a-zA-Z0-9_-]+)\/actors\/([a-zA-Z0-9_-]+)\/(start|stop|restart)$/
        );
        if (req.method === 'POST' && actorMatch) {
          const [, groupId, actorId, action] = actorMatch;
          const groups = await bridge.controlActor(groupId, actorId, action);
          broadcastSse('groups', { groups });
          sendJson(res, 200, { ok: true, groups });
          return;
        }

        if (req.method === 'POST' && pathname === '/api/groups') {
          const body = await readJsonBody(req);
          const group = await bridge.createGroup(body);
          const groups = await bridge.listGroups({ force: true });
          broadcastSse('groups', { groups });
          sendJson(res, 200, { ok: true, group, groups });
          return;
        }

        const uploadGetMatch = pathname.match(/^\/api\/uploads\/([^/]+)$/);
        if (req.method === 'GET' && uploadGetMatch) {
          const decoded = decodeURIComponent(uploadGetMatch[1]);
          if (!decoded || path.basename(decoded) !== decoded) {
            res.writeHead(400);
            res.end('Bad Request');
            return;
          }
          const uploadsRoot = path.resolve(UPLOADS_DIR);
          const resolvedUpload = path.resolve(uploadsRoot, decoded);
          if (
            !resolvedUpload.toLowerCase().startsWith(`${uploadsRoot.toLowerCase()}${path.sep}`)
          ) {
            res.writeHead(403);
            res.end('Forbidden');
            return;
          }
          if (!fs.existsSync(resolvedUpload)) {
            res.writeHead(404);
            res.end('Not Found');
            return;
          }
          const ext = path.extname(resolvedUpload).toLowerCase();
          const stat = await fsp.stat(resolvedUpload);
          res.writeHead(200, {
            'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
            'Content-Length': stat.size,
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'private, max-age=86400',
          });
          fs.createReadStream(resolvedUpload).pipe(res);
          return;
        }

        if (req.method === 'POST' && pathname === '/api/upload-local') {
          if (!isDirectLocalRequest(req)) {
            sendJson(res, 403, { error: '仅限本机桌面端使用' });
            return;
          }
          const body = await readJsonBody(req);
          const srcPath = String(body.sourcePath || '').trim();
          if (!srcPath || !fs.existsSync(srcPath)) {
            throw new Error('找不到所选文件');
          }
          const rawName = path.basename(srcPath);
          const safeName = rawName.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
          const isImage = IMAGE_EXT_RE.test(safeName);
          if (isImage) {
            await fsp.mkdir(UPLOADS_DIR, { recursive: true });
            const savedName = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${safeName}`;
            const destPath = path.join(UPLOADS_DIR, savedName);
            await fsp.copyFile(srcPath, destPath);
            sendJson(res, 200, {
              ok: true,
              kind: 'image',
              fileName: safeName,
              savedName,
              url: `/api/uploads/${encodeURIComponent(savedName)}`,
              filePath: destPath,
            });
            return;
          }
          sendJson(res, 200, {
            ok: true,
            kind: 'file',
            fileName: safeName,
            savedName: '',
            url: '',
            filePath: srcPath,
          });
          return;
        }

        if (req.method === 'POST' && pathname === '/api/upload') {
          const body = await readJsonBody(req, 28 * 1024 * 1024);
          const rawName = path.basename(String(body.fileName || 'upload.png'));
          const safeName = rawName.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
          const base64Data = String(body.dataBase64 || '');
          if (!base64Data) throw new Error('缺少文件内容');
          await fsp.mkdir(UPLOADS_DIR, { recursive: true });
          const savedName = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${safeName}`;
          const destPath = path.join(UPLOADS_DIR, savedName);
          await fsp.writeFile(destPath, Buffer.from(base64Data, 'base64'));
          const isImage =
            IMAGE_EXT_RE.test(savedName) || String(body.mimeType || '').startsWith('image/');
          sendJson(res, 200, {
            ok: true,
            kind: isImage ? 'image' : 'file',
            fileName: safeName,
            savedName,
            url: `/api/uploads/${encodeURIComponent(savedName)}`,
            filePath: destPath,
          });
          return;
        }

        sendJson(res, 404, { error: 'API 路径不存在' });
        return;
      }

      // Static files from public/
      const relPath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const resolved = path.resolve(PUBLIC_DIR, relPath);
      if (!resolved.startsWith(PUBLIC_DIR)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      if (!fs.existsSync(resolved) || (await fsp.stat(resolved)).isDirectory()) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      const ext = path.extname(resolved).toLowerCase();
      const content = await fsp.readFile(resolved);
      const isCodeOrShell =
        ext === '.html' || ext === '.mjs' || ext === '.js' || ext === '.css' || resolved.endsWith('sw.js');
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Content-Length': content.length,
        'Cache-Control': isCodeOrShell ? 'no-store, no-cache, must-revalidate' : 'no-cache',
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      res.end(content);
    } catch (err) {
      sendJson(res, 500, { error: err.message || '服务器内部错误' });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const boundPort = server.address()?.port || port;

  if (enableTunnel) {
    tunnelManager = new TunnelManager({
      dataDir,
      localPort: boundPort,
      accessToken,
      getLanUrl: () => {
        const lans = discoverLanAddresses(boundPort);
        const phys = lans.find((x) => !x.isVirtual && !x.isTailscale);
        return phys ? `http://${phys.ip}:${boundPort}` : '';
      },
    });
    tunnelManager.on('update', (snap) => {
      broadcastSse('tunnel', snap);
    });
    tunnelManager.start().catch(() => {});
  }

  return {
    port: boundPort,
    url: `http://127.0.0.1:${boundPort}`,
    bridge,
    tunnelManager,
    close: () => {
      clearInterval(statusHeartbeat);
      clearInterval(idleStandbyTimer);
      agyHubHealWatcher.stop();
      tunnelManager?.stop();
      bridge.stop();
      for (const client of sseClients) {
        try {
          client.end();
        } catch {
          // ignore
        }
      }
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

// Run standalone if executed directly (`npm run web` or background tray daemon)
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8866);
  const startInStandby = process.argv.includes('--standby');
  (async () => {
    try {
      const preflight = await fetch(`http://127.0.0.1:${port}/api/session`, {
        signal: AbortSignal.timeout(400),
      });
      if (preflight.ok) {
        process.exit(0);
      }
    } catch {
      // Not listening yet; proceed to start server
    }
    const srv = await startAgentWeChatServer({ port, startInStandby });
    console.log(`[AChat] Running at ${srv.url}${startInStandby ? ' (standby gateway)' : ''}`);
  })().catch((err) => {
    if (err && err.code === 'EADDRINUSE') {
      process.exit(0);
    }
    console.error('[AChat] Fatal startup error:', err);
    process.exit(1);
  });
}
