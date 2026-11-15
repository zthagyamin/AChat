import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { executeExtraProviderTurn } from './fusion-hub.mjs';

export const VALID_SESSION_FLOWS = ['direct', 'discuss_then_exec'];
export const VALID_SESSION_PERMISSIONS = ['inherit', 'workspace-write', 'read-only'];
export const VALID_TARGET_MODES = ['group', 'existing', 'new'];
export const DEFAULT_IDLE_TIMEOUT_MS = 600_000;

const HOME_DIR = os.homedir();
const LOCAL_APP_DATA = process.env.LOCALAPPDATA || path.join(HOME_DIR, 'AppData', 'Local');
const DEFAULT_AGY_BIN =
  process.env.AGY_BIN ||
  (process.platform === 'win32' ? path.join(LOCAL_APP_DATA, 'agy', 'bin', 'agy.exe') : 'agy');

function formatIdleDurationLabel(idleMs = DEFAULT_IDLE_TIMEOUT_MS) {
  const ms = Math.max(1000, Number(idleMs) || DEFAULT_IDLE_TIMEOUT_MS);
  if (ms >= 60_000) {
    return `${Math.round(ms / 60_000)} 分钟`;
  }
  return `${Math.max(1, Math.round(ms / 1000))} 秒`;
}

function computeCandidateFilesSignature(filePaths = []) {
  let maxMtime = 0;
  let totalSize = 0;
  for (const fp of filePaths) {
    if (!fp) continue;
    try {
      if (fs.existsSync(fp)) {
        const st = fs.statSync(fp);
        if (st.mtimeMs > maxMtime) maxMtime = st.mtimeMs;
        totalSize += st.size || 0;
      }
    } catch {
      // ignore transient stat race
    }
  }
  return { maxMtime, totalSize };
}

function createDualActivityIdleWatchdog({
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  getCandidateFiles = () => [],
  onIdleTimeout,
} = {}) {
  const safeIdleMs = Math.max(40, Number(idleTimeoutMs) || DEFAULT_IDLE_TIMEOUT_MS);
  let lastStreamActivityAt = Date.now();
  let lastDiskSig = computeCandidateFilesSignature(getCandidateFiles());
  let timer = null;
  let stopped = false;

  const scheduleCheck = (delayMs = safeIdleMs) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (stopped) return;
      const now = Date.now();
      const streamElapsed = now - lastStreamActivityAt;
      if (streamElapsed < safeIdleMs) {
        scheduleCheck(safeIdleMs - streamElapsed);
        return;
      }
      // Check if underlying session files on disk grew or updated since last check
      const curSig = computeCandidateFilesSignature(getCandidateFiles());
      if (
        curSig.maxMtime > lastDiskSig.maxMtime ||
        curSig.totalSize !== lastDiskSig.totalSize ||
        curSig.maxMtime > lastStreamActivityAt
      ) {
        lastDiskSig = curSig;
        lastStreamActivityAt = Math.max(now, curSig.maxMtime);
        scheduleCheck(safeIdleMs);
        return;
      }
      stopped = true;
      onIdleTimeout?.();
    }, Math.max(20, delayMs));
    timer.unref?.();
  };

  scheduleCheck(safeIdleMs);

  return {
    touch() {
      if (stopped) return;
      lastStreamActivityAt = Date.now();
      scheduleCheck(safeIdleMs);
    },
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

const CODEX_SLIM_MCP_ARGS = [
  '-c', 'mcp_servers.blender.enabled=false',
  '-c', 'mcp_servers.chatcut.enabled=false',
  '-c', 'mcp_servers.dsh_bridge.enabled=false',
  '-c', 'mcp_servers.desktop_commander_remote.enabled=false',
  '-c', 'mcp_servers.node_repl.enabled=false',
  '-c', 'mcp_servers.antigravity_bridge.enabled=false',
];

export function stripWinVerbatimPrefix(rawPath = '') {
  return String(rawPath || '')
    .trim()
    .replace(/^\\\\\?\\UNC\\/i, '\\\\')
    .replace(/^\\\\\?\\/, '');
}

export function decodeWorkspaceUri(rawUri = '') {
  const s = String(rawUri || '').trim();
  if (!s) return '';
  if (s.startsWith('file://')) {
    try {
      return stripWinVerbatimPrefix(fileURLToPath(s));
    } catch {
      return stripWinVerbatimPrefix(
        decodeURIComponent(s.replace(/^file:\/\/\/?/i, '')).replace(/\//g, '\\')
      );
    }
  }
  return stripWinVerbatimPrefix(s);
}

export function sanitizeSessionTitle(raw = '', maxLen = 68) {
  let txt = String(raw || '');
  const reqMatch = txt.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
  if (reqMatch) txt = reqMatch[1];
  txt = txt
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!txt) return '';
  return txt.length > maxLen ? `${txt.slice(0, maxLen)}…` : txt;
}

function isInternalNoiseTitleOrPrompt(txt = '', cwd = '') {
  const s = String(txt || '').trim();
  const c = String(cwd || '').toLowerCase();
  if (c.includes('cli-probe') || c.endsWith('\\cccc-room') || c.endsWith('/cccc-room')) {
    return true;
  }
  if (!s) return false;
  return (
    s === 'CCCC Actor' ||
    s === 'Guardian review' ||
    s.startsWith('[CCCC] You are ') ||
    s.startsWith('[cccc] SYSTEM:') ||
    s.startsWith('[cccc] ') ||
    s.startsWith('You are being consulted by another local AI agent') ||
    s.startsWith('Reply with the single word ') ||
    s.startsWith('Remember code 42 and reply READY')
  );
}

function normalizeSingleAgentTarget(raw = {}, defaultScopePath = '') {
  const obj = raw && typeof raw === 'object' ? raw : {};
  const mode = VALID_TARGET_MODES.includes(obj.mode) ? obj.mode : 'group';
  const sessionId = String(obj.sessionId || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '')
    .slice(0, 120);
  const sessionTitle = String(obj.sessionTitle || '').trim().slice(0, 120);
  const rawCwd = stripWinVerbatimPrefix(obj.cwd || '');
  const cwd = rawCwd || (mode === 'new' ? stripWinVerbatimPrefix(defaultScopePath || '') : '');
  if (mode === 'existing' && !sessionId) {
    return { mode: 'group', sessionId: '', sessionTitle: '', cwd: '' };
  }
  return { mode, sessionId, sessionTitle, cwd };
}

export function normalizeSessionRouting(raw = {}, defaultScopePath = '') {
  const obj = raw && typeof raw === 'object' ? raw : {};
  const codex = normalizeSingleAgentTarget(obj.codex, defaultScopePath);
  const antigravity = normalizeSingleAgentTarget(obj.antigravity, defaultScopePath);
  const hasAnyExternal = codex.mode !== 'group' || antigravity.mode !== 'group';
  const enabled = typeof obj.enabled === 'boolean' ? obj.enabled : hasAnyExternal;
  const flow = VALID_SESSION_FLOWS.includes(obj.flow) ? obj.flow : 'direct';
  const permission = VALID_SESSION_PERMISSIONS.includes(obj.permission)
    ? obj.permission
    : 'inherit';
  const autoWake = typeof obj.autoWake === 'boolean' ? obj.autoWake : true;
  return {
    enabled: Boolean(enabled || hasAnyExternal),
    flow,
    permission,
    autoWake,
    codex,
    antigravity,
  };
}

export function isAgentRoutedExternally(routing, actorId) {
  if (!routing) return false;
  const key = actorId === 'codex' ? 'codex' : actorId === 'antigravity' ? 'antigravity' : '';
  if (!key) return false;
  const target = routing[key];
  if (!target) return false;
  if (target.mode === 'existing' && target.sessionId) return true;
  if (target.mode === 'new') return true;
  return false;
}

function toIsoSafe(val) {
  if (!val) return '';
  if (typeof val === 'number') {
    const ms = val > 1e12 ? val : val * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString();
  }
  const str = String(val).trim();
  if (/^\d+$/.test(str)) {
    const num = Number(str);
    const ms = num > 1e12 ? num : num * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString();
  }
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

function checkAgyPresenceLocked(agyDataDir, conversationId) {
  try {
    const lockPath = path.join(agyDataDir, 'presence', `${conversationId}.lock`);
    if (!fs.existsSync(lockPath)) return false;
    fs.readFileSync(lockPath);
    return false;
  } catch (err) {
    return err?.code === 'EBUSY' || err?.code === 'EPERM';
  }
}

function readCodexInProgressThreads(codexHomeDir) {
  const busySet = new Set();
  if (!codexHomeDir) return busySet;
  const histPath = path.join(codexHomeDir, 'thread_history_1.sqlite');
  if (!fs.existsSync(histPath)) return busySet;
  let db = null;
  try {
    db = new DatabaseSync(histPath, { readOnly: true });
    const rows = db
      .prepare(
        `SELECT t.*
         FROM thread_turns t
         INNER JOIN (
           SELECT thread_id, MAX(rollout_ordinal) AS max_ord
           FROM thread_turns
           GROUP BY thread_id
         ) latest
         ON t.thread_id = latest.thread_id AND t.rollout_ordinal = latest.max_ord
         WHERE t.status = 'inProgress' AND t.completed_at IS NULL`
      )
      .all();
    const nowSec = Math.floor(Date.now() / 1000);
    for (const r of rows) {
      const tid = String(r.thread_id || '').trim();
      if (!tid) continue;
      const startedSec = Number(r.started_at) || 0;
      if (startedSec > 0 && nowSec - startedSec > 2700) {
        continue;
      }
      busySet.add(tid);
    }
  } catch {
    // ignore sqlite read error
  } finally {
    try {
      db?.close();
    } catch {}
  }
  return busySet;
}

function isCodexThreadTurnInProgress(codexHomeDir, threadId) {
  const safeId = String(threadId || '').trim();
  if (!safeId || !codexHomeDir) return false;
  const histPath = path.join(codexHomeDir, 'thread_history_1.sqlite');
  if (!fs.existsSync(histPath)) return false;
  let db = null;
  try {
    db = new DatabaseSync(histPath, { readOnly: true });
    const row = db
      .prepare(
        `SELECT *
         FROM thread_turns
         WHERE thread_id = ?
         ORDER BY rollout_ordinal DESC
         LIMIT 1`
      )
      .get(safeId);
    if (!row) return false;
    if (String(row.status || '') !== 'inProgress' || row.completed_at !== null) {
      return false;
    }
    const startedSec = Number(row.started_at) || 0;
    const nowSec = Math.floor(Date.now() / 1000);
    if (startedSec > 0 && nowSec - startedSec > 2700) {
      return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

export async function ensureCodexThreadWritable({
  sessionId,
  codexHomeDir = path.join(os.homedir(), '.codex'),
  maxWaitMs = 8000,
  onProgress = null,
} = {}) {
  const safeId = String(sessionId || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '');
  if (!safeId || !codexHomeDir) {
    return { ok: true, inProgress: false, releasedIdleLock: false };
  }

  const lockPath = path.join(codexHomeDir, 'thread-writer-locks', `${safeId}.lock`);
  const deadline = Date.now() + Math.max(0, Number(maxWaitMs) || 0);
  let inProgress = isCodexThreadTurnInProgress(codexHomeDir, safeId);
  let notifiedWait = false;

  while (inProgress && Date.now() < deadline) {
    if (!notifiedWait) {
      notifiedWait = true;
      try {
        onProgress?.({
          sessionId: safeId,
          stepLabel: '⏳ 目标 Codex 会话正在桌面端收尾上一轮，等待释放写锁…',
          text: '',
        });
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 350));
    inProgress = isCodexThreadTurnInProgress(codexHomeDir, safeId);
  }

  if (inProgress) {
    return { ok: false, inProgress: true, releasedIdleLock: false };
  }

  let releasedIdleLock = false;
  if (fs.existsSync(lockPath)) {
    try {
      await fsp.unlink(lockPath);
      releasedIdleLock = true;
    } catch {
      // ignore if unlink fails or raced
    }
  }
  return { ok: true, inProgress: false, releasedIdleLock };
}

function resolveCliDataDir(antigravityDataDir, antigravityCliDataDir) {
  if (antigravityCliDataDir) return antigravityCliDataDir;
  return path.join(path.dirname(antigravityDataDir), 'antigravity-cli');
}

function getMaxWalMtimeMs(dbPath) {
  let maxMs = 0;
  for (const candidate of [dbPath, `${dbPath}-wal`]) {
    try {
      if (fs.existsSync(candidate)) {
        const m = fs.statSync(candidate).mtimeMs || 0;
        if (m > maxMs) maxMs = m;
      }
    } catch {
      // ignore stat race
    }
  }
  return maxMs;
}

export async function ensureAntigravityCliTrajectory({
  sessionId,
  antigravityDataDir = path.join(os.homedir(), '.gemini', 'antigravity'),
  antigravityCliDataDir = null,
} = {}) {
  const safeId = String(sessionId || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '');
  if (!safeId) {
    return { bridged: false, reason: 'empty_id' };
  }
  const cliDir = resolveCliDataDir(antigravityDataDir, antigravityCliDataDir);
  if (path.resolve(antigravityDataDir) === path.resolve(cliDir)) {
    return { bridged: false, reason: 'same_dir' };
  }

  const srcDb = path.join(antigravityDataDir, 'conversations', `${safeId}.db`);
  const dstConvDir = path.join(cliDir, 'conversations');
  const dstDb = path.join(dstConvDir, `${safeId}.db`);

  // Copy lightweight title/workspace annotation into CLI store if missing (read-only on Desktop)
  const srcAnnot = path.join(antigravityDataDir, 'annotations', `${safeId}.pbtxt`);
  const dstAnnotDir = path.join(cliDir, 'annotations');
  const dstAnnot = path.join(dstAnnotDir, `${safeId}.pbtxt`);
  if (fs.existsSync(srcAnnot) && !fs.existsSync(dstAnnot)) {
    try {
      await fsp.mkdir(dstAnnotDir, { recursive: true });
      await fsp.copyFile(srcAnnot, dstAnnot);
    } catch {
      // non-fatal annotation sync
    }
  }

  if (!fs.existsSync(srcDb)) {
    let dstSize = 0;
    try {
      dstSize = fs.statSync(dstDb).size;
    } catch {
      dstSize = 0;
    }
    return { bridged: false, existsInCli: dstSize > 0, reason: 'no_desktop_db' };
  }

  let dstSize = 0;
  try {
    dstSize = fs.statSync(dstDb).size;
  } catch {
    dstSize = 0;
  }
  const dstExists = dstSize > 0;
  const desktopMtime = getMaxWalMtimeMs(srcDb);
  const cliMtime = dstExists ? getMaxWalMtimeMs(dstDb) : 0;
  const cliLocked = dstExists && checkAgyPresenceLocked(cliDir, safeId);

  if (dstExists && (desktopMtime <= cliMtime + 1000 || cliLocked)) {
    setDbTrajectoryType(dstDb, 22, 1);
    return { bridged: false, reusedCli: true, dstDb };
  }

  await fsp.mkdir(dstConvDir, { recursive: true });
  const tmpDb = path.join(
    dstConvDir,
    `${safeId}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.db`
  );
  const sqlSafeTmp = tmpDb.replace(/'/g, "''");

  let srcConn = null;
  try {
    // Open Desktop trajectory strictly read-only; VACUUM INTO folds WAL frames into standalone tmpDb without touching srcDb
    srcConn = new DatabaseSync(srcDb, { readOnly: true });
    srcConn.exec(`VACUUM INTO '${sqlSafeTmp}'`);
  } catch (err) {
    await fsp.rm(tmpDb, { force: true }).catch(() => {});
    throw err;
  } finally {
    try {
      srcConn?.close();
    } catch {
      // ignore close error
    }
  }

  // Mark CLI bridged copy as trajectory_type = 22 (0x16) so Desktop's `recomputeAndStore` (`cmp eax, 0x16; je return`)
  // ignores `antigravity-cli/conversations/<id>.db` even while `agy.exe` is actively running!
  setDbTrajectoryType(tmpDb, 22, 1);

  for (const stale of [dstDb, `${dstDb}-wal`, `${dstDb}-shm`]) {
    await fsp.rm(stale, { force: true }).catch(() => {});
  }
  await fsp.rename(tmpDb, dstDb);
  return { bridged: true, dstDb };
}

function setDbTrajectoryType(dbPath, trajectoryType, source = 1) {
  if (!dbPath || !fs.existsSync(dbPath)) return false;
  let db = null;
  try {
    if (fs.statSync(dbPath).size <= 0) return false;
    db = new DatabaseSync(dbPath);
    const hasMeta = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='trajectory_meta' LIMIT 1")
      .get();
    if (hasMeta) {
      db.prepare('UPDATE trajectory_meta SET trajectory_type = ?, source = ?').run(
        Number(trajectoryType),
        Number(source)
      );
      return true;
    }
  } catch {
    // ignore locked or mock db
  } finally {
    try {
      db?.close();
    } catch {}
  }
  return false;
}

function readProtoVarint(buf, offset) {
  let res = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buf.length) {
    const b = BigInt(buf[pos++]);
    res |= (b & 0x7fn) << shift;
    if ((b & 0x80n) === 0n) return { val: res, next: pos };
    shift += 7n;
  }
  throw new Error('Truncated protobuf varint');
}

function encodeProtoVarint(val) {
  let v = BigInt(val);
  const out = [];
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return Buffer.from(out);
}

function parsePbtxtTitle(pbtxtPath) {
  if (!pbtxtPath || !fs.existsSync(pbtxtPath)) return '';
  try {
    const raw = fs.readFileSync(pbtxtPath, 'utf8');
    const m = raw.match(/title:\s*"((?:[^"\\]|\\.)*)"/);
    if (!m) return '';
    const escaped = m[1];
    const bytes = [];
    for (let i = 0; i < escaped.length; i += 1) {
      if (escaped[i] === '\\' && i + 1 < escaped.length) {
        const next = escaped[i + 1];
        if (next >= '0' && next <= '7') {
          const oct = escaped.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)?.[0] || next;
          bytes.push(parseInt(oct, 8) & 0xff);
          i += oct.length;
          continue;
        }
        if (next === 'n') {
          bytes.push(10);
          i += 1;
          continue;
        }
        if (next === 't') {
          bytes.push(9);
          i += 1;
          continue;
        }
        if (next === '"' || next === '\\') {
          bytes.push(next.charCodeAt(0));
          i += 1;
          continue;
        }
      }
      const code = escaped.codePointAt(i);
      const utf8 = Buffer.from(String.fromCodePoint(code), 'utf8');
      for (const b of utf8) bytes.push(b);
      if (code > 0xffff) i += 1;
    }
    return Buffer.from(bytes).toString('utf8').trim();
  } catch {
    return '';
  }
}

function readDbStepCountAndWorkspaces(dbPath) {
  const out = { stepCount: 0, workspaceUris: [] };
  if (!dbPath || !fs.existsSync(dbPath)) return out;
  let st = null;
  try {
    st = fs.statSync(dbPath);
  } catch {
    return out;
  }
  if (!st || st.size <= 0) return out;

  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r) => r.name)
    );
    if (tables.has('steps')) {
      const r = db.prepare('SELECT count(*) AS cnt FROM steps').get();
      out.stepCount = Math.max(out.stepCount, Number(r?.cnt || 0));
    }
    if (tables.has('trajectory')) {
      const r = db.prepare('SELECT step_count FROM trajectory LIMIT 1').get();
      out.stepCount = Math.max(out.stepCount, Number(r?.step_count || 0));
    }
    if (tables.has('trajectory_metadata_blob')) {
      const row = db.prepare('SELECT data FROM trajectory_metadata_blob LIMIT 1').get();
      if (row?.data && row.data.length > 0) {
        const text = Buffer.from(row.data).toString('utf8');
        const matches = text.match(/file:\/\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+/g) || [];
        for (const m of matches) {
          const decoded = m.replace(/%3A/gi, ':');
          if (!out.workspaceUris.includes(decoded) && !out.workspaceUris.includes(m)) {
            out.workspaceUris.push(m);
          }
        }
      }
    }
  } catch {
    // ignore locked or mock db
  } finally {
    try {
      db?.close();
    } catch {}
  }
  return out;
}

function buildCleanDesktopSummaryProto(
  rawBuf,
  fallbackTitle = '',
  fallbackPreview = '',
  minStepCount = 0,
  fallbackWorkspaceUris = []
) {
  const chunks = [];
  let hasField1 = false;
  let hasField9 = false;
  let maxStepCount = Math.max(0, Number(minStepCount || 0));
  const titleStr = String(fallbackTitle || '').trim();

  if (rawBuf && rawBuf.length > 0) {
    const buf = Buffer.from(rawBuf);
    let pos = 0;
    try {
      while (pos < buf.length) {
        const start = pos;
        const tagInfo = readProtoVarint(buf, pos);
        pos = tagInfo.next;
        const fieldNum = Number(tagInfo.val >> 3n);
        const wireType = Number(tagInfo.val & 7n);
        if (wireType === 0) {
          const vInfo = readProtoVarint(buf, pos);
          pos = vInfo.next;
          // Strip field 20 (source = CORTEX_TRAJECTORY_SOURCE_CLI) and CLI-only flags 21, 26
          if (fieldNum === 20 || fieldNum === 21 || fieldNum === 26) continue;
          if (fieldNum === 2) {
            maxStepCount = Math.max(maxStepCount, Number(vInfo.val));
            continue;
          }
          if (fieldNum === 5) {
            chunks.push(Buffer.from([0x28, 0x01])); // CASCADE_RUN_STATUS_IDLE
            continue;
          }
        } else if (wireType === 1) {
          pos += 8;
        } else if (wireType === 2) {
          const lenInfo = readProtoVarint(buf, pos);
          pos = lenInfo.next + Number(lenInfo.val);
          if (fieldNum === 1) hasField1 = true;
          if (fieldNum === 9) hasField9 = true;
          // Always replace field 15 when we have an explicit Desktop title so an empty/timestamp-only field 15 doesn't blank the title
          if (fieldNum === 15 && titleStr) continue;
        } else if (wireType === 5) {
          pos += 4;
        } else {
          break;
        }
        chunks.push(buf.subarray(start, pos));
      }
    } catch {
      // ignore malformed tail
    }
  }

  const previewStr = String(fallbackPreview || fallbackTitle || '').trim();
  if (!hasField1 && previewStr) {
    const pBuf = Buffer.from(previewStr, 'utf8');
    chunks.unshift(Buffer.concat([Buffer.from([0x0a]), encodeProtoVarint(pBuf.length), pBuf]));
  }
  if (maxStepCount > 0) {
    chunks.push(Buffer.concat([Buffer.from([0x10]), encodeProtoVarint(maxStepCount)]));
  }
  if (!hasField9 && Array.isArray(fallbackWorkspaceUris) && fallbackWorkspaceUris.length > 0) {
    for (const rawUri of fallbackWorkspaceUris) {
      const uriStr = String(rawUri || '').trim();
      if (!uriStr) continue;
      const uBuf = Buffer.from(uriStr, 'utf8');
      const wsMsg = Buffer.concat([
        Buffer.from([0x0a]),
        encodeProtoVarint(uBuf.length),
        uBuf,
        Buffer.from([0x1a, 0x00]),
      ]);
      chunks.push(Buffer.concat([Buffer.from([0x4a]), encodeProtoVarint(wsMsg.length), wsMsg]));
    }
  }
  if (titleStr) {
    const tBuf = Buffer.from(titleStr, 'utf8');
    const annotMsg = Buffer.concat([Buffer.from([0x0a]), encodeProtoVarint(tBuf.length), tBuf]);
    chunks.push(Buffer.concat([Buffer.from([0x7a]), encodeProtoVarint(annotMsg.length), annotMsg]));
  }
  return Buffer.concat(chunks);
}

async function notifyDesktopJetboxWriteSummary(antigravityDataDir, sessionId, cleanProto) {
  if (!antigravityDataDir || !sessionId || !cleanProto || cleanProto.length === 0) return false;
  const daemonDir = path.join(antigravityDataDir, 'daemon');
  if (!fs.existsSync(daemonDir)) return false;

  const idBuf = Buffer.from(sessionId, 'utf8');
  const reqProto = Buffer.concat([
    Buffer.from([0x0a]),
    encodeProtoVarint(idBuf.length),
    idBuf,
    Buffer.from([0x12]),
    encodeProtoVarint(cleanProto.length),
    cleanProto,
  ]);

  let entries = [];
  try {
    entries = fs.readdirSync(daemonDir).filter((f) => /^hub_.*\.json$/i.test(f));
  } catch {
    return false;
  }

  let notified = false;
  for (const name of entries) {
    try {
      const hub = JSON.parse(fs.readFileSync(path.join(daemonDir, name), 'utf8'));
      if (!hub?.httpPort || !hub?.csrfToken) continue;
      if (hub.pid) {
        try {
          process.kill(Number(hub.pid), 0);
        } catch {
          continue;
        }
      }
      const resp = await fetch(
        `http://127.0.0.1:${hub.httpPort}/exa.language_server_pb.LanguageServerService/JetboxWriteSummary`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/proto',
            'x-codeium-csrf-token': hub.csrfToken,
          },
          body: reqProto,
          signal: AbortSignal.timeout(1500),
        }
      );
      if (resp.ok) notified = true;
    } catch {
      // ignore unreachable hub file
    }
  }
  return notified;
}

/**
 * Restores an Antigravity Desktop conversation after (or during) CLI execution so that
 * Desktop's `jetbox_summaries_store` watcher on `antigravity-cli/conversations` never
 * permanently hides the Desktop conversation as `CORTEX_TRAJECTORY_SOURCE_CLI` (`title = ''`),
 * while syncing newly executed CLI trajectory steps back into Desktop's `conversations/<id>.db`.
 */
export async function restoreAntigravityDesktopTrajectory({
  sessionId,
  antigravityDataDir = path.join(os.homedir(), '.gemini', 'antigravity'),
  antigravityCliDataDir = null,
  keepCliDb = false,
} = {}) {
  const safeId = String(sessionId || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '');
  if (!safeId) {
    return { restored: false, reason: 'empty_id' };
  }
  const cliDir = resolveCliDataDir(antigravityDataDir, antigravityCliDataDir);
  if (path.resolve(antigravityDataDir) === path.resolve(cliDir)) {
    return { restored: false, reason: 'same_dir' };
  }

  const srcDb = path.join(antigravityDataDir, 'conversations', `${safeId}.db`);
  const srcAnnot = path.join(antigravityDataDir, 'annotations', `${safeId}.pbtxt`);
  const dstDb = path.join(cliDir, 'conversations', `${safeId}.db`);
  const cliAnnot = path.join(cliDir, 'annotations', `${safeId}.pbtxt`);

  const isDesktopSession = fs.existsSync(srcDb) || fs.existsSync(srcAnnot);
  if (!isDesktopSession) {
    return { restored: false, reason: 'not_desktop_session' };
  }

  let cliLocked = checkAgyPresenceLocked(cliDir, safeId);
  if (!keepCliDb && cliLocked) {
    for (let i = 0; i < 5 && cliLocked; i += 1) {
      await new Promise((r) => setTimeout(r, 150));
      cliLocked = checkAgyPresenceLocked(cliDir, safeId);
    }
  }

  let syncedBack = false;
  let dstSize = 0;
  try {
    dstSize = fs.statSync(dstDb).size;
  } catch {
    dstSize = 0;
  }

  let srcSize = 0;
  try {
    srcSize = fs.statSync(srcDb).size;
  } catch {
    srcSize = 0;
  }
  const srcMeta = readDbStepCountAndWorkspaces(srcDb);
  const dstMeta = readDbStepCountAndWorkspaces(dstDb);

  const deskLocked = checkAgyPresenceLocked(antigravityDataDir, safeId);
  const canSyncBack =
    dstSize > 0 &&
    !deskLocked &&
    !keepCliDb &&
    (dstMeta.stepCount >= srcMeta.stepCount || (srcMeta.stepCount === 0 && dstSize >= srcSize));
  if (canSyncBack) {
    const deskConvDir = path.join(antigravityDataDir, 'conversations');
    await fsp.mkdir(deskConvDir, { recursive: true });
    const tmpSyncDb = path.join(
      deskConvDir,
      `${safeId}.sync-tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.db`
    );
    const sqlSafeTmp = tmpSyncDb.replace(/'/g, "''");
    let cliConn = null;
    try {
      cliConn = new DatabaseSync(dstDb, { readOnly: true });
      cliConn.exec(`VACUUM INTO '${sqlSafeTmp}'`);
      cliConn.close();
      cliConn = null;
      setDbTrajectoryType(tmpSyncDb, 4, 1);
      for (const stale of [`${srcDb}-wal`, `${srcDb}-shm`]) {
        await fsp.rm(stale, { force: true }).catch(() => {});
      }
      await fsp.rename(tmpSyncDb, srcDb);
      syncedBack = true;
    } catch {
      await fsp.rm(tmpSyncDb, { force: true }).catch(() => {});
    } finally {
      try {
        cliConn?.close();
      } catch {
        // ignore
      }
    }

    // Also sync transcript.jsonl back to Desktop brain directory if CLI transcript is newer/larger
    const cliTranscript = path.join(cliDir, 'brain', safeId, '.system_generated', 'logs', 'transcript.jsonl');
    const deskTranscript = path.join(
      antigravityDataDir,
      'brain',
      safeId,
      '.system_generated',
      'logs',
      'transcript.jsonl'
    );
    try {
      if (fs.existsSync(cliTranscript)) {
        const cliSt = fs.statSync(cliTranscript);
        const deskSt = fs.existsSync(deskTranscript) ? fs.statSync(deskTranscript) : null;
        if (!deskSt || cliSt.size >= deskSt.size || cliSt.mtimeMs > deskSt.mtimeMs) {
          await fsp.mkdir(path.dirname(deskTranscript), { recursive: true });
          await fsp.copyFile(cliTranscript, deskTranscript);
        }
      }
    } catch {
      // non-fatal transcript sync
    }
  }

  // Ensure any non-empty CLI `.db` has trajectory_type = 22 (0x16) so Desktop's `recomputeAndStore` (`cmp eax, 0x16; je return`)
  // ignores it even while `agy.exe` is actively running!
  if (dstSize > 0 && fs.existsSync(dstDb)) {
    setDbTrajectoryType(dstDb, 22, 1);
  }

  // CRITICAL: Truncate CLI `.db` to 0 bytes (DO NOT unlink!) when turn is idle, and reset mtime to epoch
  // so even older in-memory routers see `srcStat.mtimeMs > dstStat.mtimeMs` and re-bridge before spawning `agy.exe`.
  // In Antigravity Desktop's `jetbox_summaries_store`:
  // - Unlinking `<id>.db` triggers `handleFileEvent` -> `DeleteSummary(<id>)` (`s.deleted[id] = true`), wiping it from Desktop!
  // - Leaving `<id>.db` with `size > 0` triggers `scanAndRefresh` -> `recomputeAndStore(defaultSource=CLI)`, wiping `title` and setting `source=CORTEX_TRAJECTORY_SOURCE_CLI`!
  // - Truncating `<id>.db` to 0 bytes keeps `os.Stat` succeeding while `loadTrajectoryFile` sees `Size() == 0` and returns `(nil, modTime, nil)` (no-op)!
  let truncatedCliStub = false;
  if (!keepCliDb && !cliLocked && fs.existsSync(dstDb) && dstSize > 0) {
    try {
      await fsp.truncate(dstDb, 0);
      await fsp.utimes(dstDb, new Date(1000), new Date(1000)).catch(() => {});
      for (const stale of [`${dstDb}-wal`, `${dstDb}-shm`]) {
        await fsp.rm(stale, { force: true }).catch(() => {});
      }
      truncatedCliStub = true;
      await new Promise((r) => setTimeout(r, 150));
    } catch {
      // ignore if locked
    }
  }

  // Read CLI & Desktop summary rows to reconstruct a clean Desktop summary (`source = ''`, original `title` preserved)
  let cliRow = null;
  const cliSummariesPath = path.join(cliDir, 'conversation_summaries.db');
  if (fs.existsSync(cliSummariesPath)) {
    let db = null;
    try {
      db = new DatabaseSync(cliSummariesPath, { readOnly: true });
      cliRow = db.prepare('SELECT * FROM conversation_summaries WHERE conversation_id = ?').get(safeId) || null;
    } catch {
      // ignore
    } finally {
      try {
        db?.close();
      } catch {}
    }
  }

  let deskRow = null;
  const deskSummariesPath = path.join(antigravityDataDir, 'conversation_summaries.db');
  if (fs.existsSync(deskSummariesPath)) {
    let db = null;
    try {
      db = new DatabaseSync(deskSummariesPath, { readOnly: true });
      deskRow = db.prepare('SELECT * FROM conversation_summaries WHERE conversation_id = ?').get(safeId) || null;
    } catch {
      // ignore
    } finally {
      try {
        db?.close();
      } catch {}
    }
  }

  const annotTitle = parsePbtxtTitle(srcAnnot) || parsePbtxtTitle(cliAnnot);
  const cleanTitle = String(cliRow?.title || deskRow?.title || annotTitle || '').trim();
  const cleanPreview = String(cliRow?.preview || deskRow?.preview || cleanTitle || '').trim();
  const stepCount = Math.max(
    Number(cliRow?.step_count || 0),
    Number(deskRow?.step_count || 0),
    srcMeta.stepCount,
    dstMeta.stepCount
  );
  const nowIso = new Date().toISOString();
  const lastModifiedTime = String(cliRow?.last_modified_time || deskRow?.last_modified_time || nowIso);
  const lastUserInputTime = String(
    cliRow?.last_user_input_time || deskRow?.last_user_input_time || lastModifiedTime
  );
  const nonEmptyJsonArr = (v) => {
    const s = String(v || '').trim();
    return s && s !== '[]' ? s : '';
  };
  let workspaceUris =
    nonEmptyJsonArr(deskRow?.workspace_uris) ||
    nonEmptyJsonArr(cliRow?.workspace_uris) ||
    (srcMeta.workspaceUris.length > 0 ? JSON.stringify(srcMeta.workspaceUris) : '') ||
    (dstMeta.workspaceUris.length > 0 ? JSON.stringify(dstMeta.workspaceUris) : '') ||
    '[]';
  let parsedWorkspaces = [];
  try {
    parsedWorkspaces = JSON.parse(workspaceUris);
  } catch {
    parsedWorkspaces = srcMeta.workspaceUris;
  }
  const projectId = String(cliRow?.project_id || deskRow?.project_id || '');
  const agentName = String(cliRow?.agent_name || deskRow?.agent_name || '');
  const parentConvId = String(cliRow?.parent_conversation_id || deskRow?.parent_conversation_id || '');
  const nestingDepth = Number(cliRow?.nesting_depth ?? deskRow?.nesting_depth ?? 0);
  const battleId = String(cliRow?.battle_id || deskRow?.battle_id || '');
  const winningConvId = String(cliRow?.winning_conversation_id || deskRow?.winning_conversation_id || '');
  const lastUserInputStepIdx = Number(
    cliRow?.last_user_input_step_index ?? deskRow?.last_user_input_step_index ?? -1
  );
  const groupId = String(cliRow?.group_id || deskRow?.group_id || '');
  const rawBase =
    deskRow?.raw_summary && deskRow.raw_summary.length > 0 && nonEmptyJsonArr(deskRow?.workspace_uris)
      ? deskRow.raw_summary
      : cliRow?.raw_summary && cliRow.raw_summary.length > 0
        ? cliRow.raw_summary
        : deskRow?.raw_summary || null;
  const cleanProto = buildCleanDesktopSummaryProto(
    rawBase,
    cleanTitle,
    cleanPreview,
    stepCount,
    parsedWorkspaces
  );

  let updatedSqlite = false;
  if (fs.existsSync(deskSummariesPath)) {
    let db = null;
    try {
      db = new DatabaseSync(deskSummariesPath);
      db.prepare(
        `INSERT OR REPLACE INTO conversation_summaries (
          conversation_id, title, preview, step_count, last_modified_time,
          workspace_uris, status, source, project_id, agent_name,
          parent_conversation_id, nesting_depth, battle_id, winning_conversation_id,
          not_fully_idle, killed, last_user_input_time, last_user_input_step_index,
          app_data_dir, raw_summary, group_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        safeId,
        cleanTitle,
        cleanPreview,
        stepCount,
        lastModifiedTime,
        workspaceUris,
        'CASCADE_RUN_STATUS_IDLE',
        '',
        projectId,
        agentName,
        parentConvId,
        nestingDepth,
        battleId,
        winningConvId,
        0,
        0,
        lastUserInputTime,
        lastUserInputStepIdx,
        'antigravity',
        cleanProto,
        groupId
      );
      updatedSqlite = true;
    } catch {
      // ignore if SQLite schema differs in mock tests
    } finally {
      try {
        db?.close();
      } catch {}
    }
  }

  const notifiedRpc = await notifyDesktopJetboxWriteSummary(antigravityDataDir, safeId, cleanProto);
  return {
    restored: Boolean(syncedBack || truncatedCliStub || updatedSqlite || notifiedRpc),
    syncedBack,
    truncatedCliStub,
    updatedSqlite,
    notifiedRpc,
    title: cleanTitle,
    stepCount,
  };
}

async function healHiddenAntigravityDesktopSessions({ antigravityDataDir, antigravityCliDataDir }) {
  if (!antigravityDataDir || !fs.existsSync(antigravityDataDir)) return;
  const cliDir = resolveCliDataDir(antigravityDataDir, antigravityCliDataDir);
  if (!cliDir || path.resolve(cliDir) === path.resolve(antigravityDataDir)) return;

  const toHeal = new Map();

  // 1. Check any non-empty CLI `.db` files that correspond to Desktop sessions
  const cliConvDir = path.join(cliDir, 'conversations');
  if (fs.existsSync(cliConvDir)) {
    try {
      const files = fs.readdirSync(cliConvDir).filter((f) => f.endsWith('.db'));
      for (const f of files) {
        const id = f.slice(0, -3);
        const full = path.join(cliConvDir, f);
        const sz = fs.statSync(full).size;
        if (sz > 0) {
          const hasDesk =
            fs.existsSync(path.join(antigravityDataDir, 'conversations', `${id}.db`)) ||
            fs.existsSync(path.join(antigravityDataDir, 'annotations', `${id}.pbtxt`));
          if (hasDesk) {
            const locked = checkAgyPresenceLocked(cliDir, id);
            setDbTrajectoryType(full, 22, 1);
            if (!locked) {
              toHeal.set(id, false);
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // 2. Check any Desktop summary rows marked with `source = 'CORTEX_TRAJECTORY_SOURCE_CLI'` that have a Desktop `.db` or annotation
  const deskSummariesPath = path.join(antigravityDataDir, 'conversation_summaries.db');
  if (fs.existsSync(deskSummariesPath)) {
    let db = null;
    try {
      db = new DatabaseSync(deskSummariesPath, { readOnly: true });
      const rows = db
        .prepare(
          `SELECT conversation_id FROM conversation_summaries
           WHERE source = 'CORTEX_TRAJECTORY_SOURCE_CLI'`
        )
        .all();
      for (const r of rows) {
        const id = String(r.conversation_id || '').trim();
        if (!id) continue;
        const hasDesk =
          fs.existsSync(path.join(antigravityDataDir, 'conversations', `${id}.db`)) ||
          fs.existsSync(path.join(antigravityDataDir, 'annotations', `${id}.pbtxt`));
        if (hasDesk) {
          const locked = checkAgyPresenceLocked(cliDir, id);
          toHeal.set(id, locked);
        }
      }
    } catch {
      // ignore if `source` column is absent in lightweight test fixtures
    } finally {
      try {
        db?.close();
      } catch {}
    }
  }

  for (const [id, keepCliDb] of toHeal.entries()) {
    await restoreAntigravityDesktopTrajectory({
      sessionId: id,
      antigravityDataDir,
      antigravityCliDataDir: cliDir,
      keepCliDb,
    }).catch(() => {});
  }
}

async function collectAntigravitySessionsFromStore(dataDir, sourceSurface, maxItems) {
  const sessions = [];
  const seen = new Set();
  if (!dataDir || !fs.existsSync(dataDir)) return sessions;

  const agySqlitePath = path.join(dataDir, 'conversation_summaries.db');
  if (fs.existsSync(agySqlitePath)) {
    let db = null;
    try {
      db = new DatabaseSync(agySqlitePath, { readOnly: true });
      const rows = db
        .prepare(
          `SELECT conversation_id, title, preview, workspace_uris, status, parent_conversation_id, nesting_depth, not_fully_idle, killed, last_modified_time
           FROM conversation_summaries
           WHERE nesting_depth = 0 AND parent_conversation_id = '' AND killed = 0
           ORDER BY last_modified_time DESC
           LIMIT 70`
        )
        .all();
      for (const r of rows) {
        const id = String(r.conversation_id || '').trim();
        if (!id || seen.has(id)) continue;
        let cwd = '';
        try {
          const uris = JSON.parse(r.workspace_uris || '[]');
          if (Array.isArray(uris) && uris.length > 0) {
            cwd = decodeWorkspaceUri(uris[0]);
          }
        } catch {
          // ignore malformed workspace_uris
        }
        const rawTitle = r.title || r.preview || '';
        if (isInternalNoiseTitleOrPrompt(rawTitle, cwd)) continue;
        const cleanTitle =
          sanitizeSessionTitle(rawTitle) ||
          (cwd ? `${path.basename(cwd)} 会话` : `Antigravity ${id.slice(0, 8)}`);
        const busy =
          Boolean(Number(r.not_fully_idle)) ||
          String(r.status || '').includes('RUNNING') ||
          checkAgyPresenceLocked(dataDir, id);
        seen.add(id);
        sessions.push({
          id,
          agent: 'antigravity',
          sourceSurface,
          title: cleanTitle,
          cwd,
          folderName: cwd ? path.basename(cwd) : '',
          sandbox: 'workspace-write',
          updatedAt: toIsoSafe(r.last_modified_time),
          busy,
        });
        if (sessions.length >= maxItems) break;
      }
    } catch {
      // fallback to brain directory scan below
    } finally {
      try {
        db?.close();
      } catch {
        // ignore
      }
    }
  }

  const brainDir = path.join(dataDir, 'brain');
  if (sessions.length < maxItems && fs.existsSync(brainDir)) {
    try {
      const entries = await fsp.readdir(brainDir, { withFileTypes: true });
      const candidates = [];
      for (const ent of entries) {
        if (!ent.isDirectory() || seen.has(ent.name)) continue;
        const tp = path.join(brainDir, ent.name, '.system_generated', 'logs', 'transcript.jsonl');
        if (!fs.existsSync(tp)) continue;
        const st = await fsp.stat(tp);
        candidates.push({ id: ent.name, tp, mtimeMs: st.mtimeMs });
      }
      candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const item of candidates.slice(0, 14)) {
        const fh = await fsp.open(item.tp, 'r');
        let chunk = '';
        try {
          const buf = Buffer.alloc(16384);
          const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
          chunk = buf.slice(0, bytesRead).toString('utf8');
        } finally {
          await fh.close();
        }
        const firstLine = chunk.split(/\r?\n/)[0] || '';
        let firstObj = null;
        try {
          firstObj = JSON.parse(firstLine);
        } catch {
          continue;
        }
        if (firstObj?.source !== 'USER_EXPLICIT' || firstObj?.type !== 'USER_INPUT') continue;
        const cleanTitle = sanitizeSessionTitle(firstObj.content || '');
        if (!cleanTitle || isInternalNoiseTitleOrPrompt(cleanTitle, '')) continue;
        seen.add(item.id);
        sessions.push({
          id: item.id,
          agent: 'antigravity',
          sourceSurface,
          title: cleanTitle,
          cwd: '',
          folderName: '',
          sandbox: 'workspace-write',
          updatedAt: new Date(item.mtimeMs).toISOString(),
          busy: checkAgyPresenceLocked(dataDir, item.id),
        });
        if (sessions.length >= maxItems) break;
      }
    } catch {
      // ignore supplement error
    }
  }

  return sessions;
}

export async function discoverLocalSessions({
  codexHomeDir = path.join(os.homedir(), '.codex'),
  antigravityDataDir = path.join(os.homedir(), '.gemini', 'antigravity'),
  antigravityCliDataDir = null,
  limit = 28,
} = {}) {
  const maxItems = Math.max(4, Math.min(60, Number(limit) || 28));
  const cliDir = resolveCliDataDir(antigravityDataDir, antigravityCliDataDir);
  const codexSessions = [];
  const seenCodex = new Set();

  // 1. Primary Codex source: state_5.sqlite (read-only) + thread_history_1.sqlite busy detection
  const codexInProgressSet = readCodexInProgressThreads(codexHomeDir);
  const codexSqlitePath = path.join(codexHomeDir, 'state_5.sqlite');
  if (fs.existsSync(codexSqlitePath)) {
    let db = null;
    try {
      db = new DatabaseSync(codexSqlitePath, { readOnly: true });
      const rows = db
        .prepare(
          `SELECT *
           FROM threads
           WHERE archived = 0
           ORDER BY updated_at DESC
           LIMIT 90`
        )
        .all();
      for (const r of rows) {
        const id = String(r.id || '').trim();
        if (!id || seenCodex.has(id)) continue;
        const source = String(r.source || '');
        if (source.startsWith('{"subagent"')) continue;
        const cwd = stripWinVerbatimPrefix(r.cwd || '');
        const rawCandidate = r.name || r.title || r.first_user_message || r.preview || '';
        if (
          isInternalNoiseTitleOrPrompt(r.title, cwd) ||
          isInternalNoiseTitleOrPrompt(r.first_user_message, cwd) ||
          isInternalNoiseTitleOrPrompt(rawCandidate, cwd)
        ) {
          continue;
        }
        const cleanTitle =
          sanitizeSessionTitle(rawCandidate) ||
          (cwd ? `${path.basename(cwd)} 会话` : `Codex ${id.slice(0, 8)}`);
        const pol = String(r.sandbox_policy || '').toLowerCase();
        const sandbox = pol.includes('read-only') || pol.includes('readonly')
          ? 'read-only'
          : 'workspace-write';
        seenCodex.add(id);
        codexSessions.push({
          id,
          agent: 'codex',
          title: cleanTitle,
          cwd,
          folderName: cwd ? path.basename(cwd) : '',
          sandbox,
          updatedAt: toIsoSafe(r.updated_at),
          busy: codexInProgressSet.has(id),
        });
        if (codexSessions.length >= maxItems) break;
      }
    } catch {
      // fallback below if SQLite schema differs
    } finally {
      try {
        db?.close();
      } catch {
        // ignore close error
      }
    }
  }

  // 2. Antigravity sources: Desktop (`~/.gemini/antigravity`) + CLI (`~/.gemini/antigravity-cli`)
  await healHiddenAntigravityDesktopSessions({
    antigravityDataDir,
    antigravityCliDataDir: cliDir,
  }).catch(() => {});
  const desktopAgy = await collectAntigravitySessionsFromStore(antigravityDataDir, 'desktop', maxItems);
  const cliAgy =
    path.resolve(cliDir) !== path.resolve(antigravityDataDir)
      ? await collectAntigravitySessionsFromStore(cliDir, 'cli', maxItems)
      : [];

  const mergedAgyMap = new Map();
  for (const item of desktopAgy) {
    mergedAgyMap.set(item.id, item);
  }
  for (const item of cliAgy) {
    const prev = mergedAgyMap.get(item.id);
    if (!prev) {
      mergedAgyMap.set(item.id, item);
    } else {
      const prevTs = new Date(prev.updatedAt || 0).getTime() || 0;
      const curTs = new Date(item.updatedAt || 0).getTime() || 0;
      mergedAgyMap.set(item.id, {
        ...prev,
        cwd: prev.cwd || item.cwd,
        folderName: prev.folderName || item.folderName,
        updatedAt: curTs > prevTs ? item.updatedAt : prev.updatedAt,
        busy: Boolean(prev.busy || item.busy),
      });
    }
  }
  const agySessions = Array.from(mergedAgyMap.values()).sort(
    (a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0)
  );

  // Collect recent project directories for 1-click "New Session in Folder" suggestions
  const recentDirs = [];
  const seenDirs = new Set();
  for (const s of [...codexSessions, ...agySessions]) {
    if (!s.cwd) continue;
    const norm = s.cwd.toLowerCase();
    if (seenDirs.has(norm)) continue;
    if (!fs.existsSync(s.cwd)) continue;
    seenDirs.add(norm);
    recentDirs.push({
      path: s.cwd,
      name: path.basename(s.cwd) || s.cwd,
    });
    if (recentDirs.length >= 12) break;
  }

  return {
    codex: codexSessions.slice(0, maxItems),
    antigravity: agySessions.slice(0, maxItems),
    recentDirectories: recentDirs,
  };
}

async function readTailUtf8(filePath, maxBytes = 98304) {
  let fh = null;
  try {
    const st = await fsp.stat(filePath);
    if (!st.isFile() || st.size === 0) return '';
    const start = Math.max(0, st.size - maxBytes);
    const len = st.size - start;
    fh = await fsp.open(filePath, 'r');
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, start);
    let text = buf.slice(0, bytesRead).toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      if (nl >= 0) text = text.slice(nl + 1);
    }
    return text;
  } catch {
    return '';
  } finally {
    await fh?.close().catch(() => {});
  }
}

function cleanPreviewSnippet(raw = '', maxLen = 220) {
  let txt = String(raw || '');
  const reqMatch = txt.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
  if (reqMatch) txt = reqMatch[1];
  txt = txt
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\[回复表达风格[^\]]*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!txt) return '';
  return txt.length > maxLen ? `${txt.slice(0, maxLen)}…` : txt;
}

export async function readExternalSessionPreview({
  agent,
  sessionId,
  codexHomeDir = path.join(os.homedir(), '.codex'),
  antigravityDataDir = path.join(os.homedir(), '.gemini', 'antigravity'),
  antigravityCliDataDir = null,
  maxItems = 3,
} = {}) {
  const safeId = String(sessionId || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '');
  if (!safeId) {
    throw new Error('会话 ID 无效');
  }

  const limit = Math.max(1, Math.min(8, Number(maxItems) || 3));
  const cliDir = resolveCliDataDir(antigravityDataDir, antigravityCliDataDir);

  if (agent === 'codex') {
    let title = '';
    let cwd = '';
    let gitBranch = '';
    let updatedAt = '';
    let rolloutPath = '';
    let firstUserMessage = '';

    const codexSqlitePath = path.join(codexHomeDir, 'state_5.sqlite');
    if (fs.existsSync(codexSqlitePath)) {
      let db = null;
      try {
        db = new DatabaseSync(codexSqlitePath, { readOnly: true });
        const row = db
          .prepare(
            `SELECT *
             FROM threads
             WHERE id = ?
             LIMIT 1`
          )
          .get(safeId);
        if (row) {
          cwd = stripWinVerbatimPrefix(row.cwd || '');
          firstUserMessage = String(row.first_user_message || '').trim();
          title =
            sanitizeSessionTitle(row.name || row.title || firstUserMessage || row.preview || '') ||
            (cwd ? `${path.basename(cwd)} 会话` : `Codex ${safeId.slice(0, 8)}`);
          gitBranch = String(row.git_branch || '').trim();
          updatedAt = toIsoSafe(row.updated_at);
          rolloutPath = stripWinVerbatimPrefix(row.rollout_path || '');
        }
      } catch {
        // ignore sqlite error
      } finally {
        try {
          db?.close();
        } catch {}
      }
    }

    const items = [];
    const pushDedup = (role, sender, rawText, ts) => {
      const snippet = cleanPreviewSnippet(rawText);
      if (!snippet || /^\[cccc\]\s+SYSTEM/i.test(snippet)) return;
      const prev = items[items.length - 1];
      if (prev && prev.role === role && prev.text === snippet) return;
      items.push({ role, sender, text: snippet, ts });
    };

    if (rolloutPath && fs.existsSync(rolloutPath)) {
      const tailText = await readTailUtf8(rolloutPath, 262144);
      let fallbackCommentary = null;
      for (const line of tailText.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
          const obj = JSON.parse(trimmed);
          const p = obj.payload || {};
          const pType = p.type || obj.type || '';
          const ts = toIsoSafe(obj.timestamp || p.completed_at);
          if (pType === 'user_message' && p.message) {
            pushDedup('user', '我', p.message, ts);
          } else if (pType === 'agent_message' && p.message) {
            const phase = String(p.phase || '').toLowerCase();
            if (!phase || phase === 'final_answer' || phase === 'final') {
              pushDedup('agent', 'Codex', p.message, ts);
            } else {
              fallbackCommentary = { text: p.message, ts };
            }
          } else if (pType === 'task_complete' && p.last_agent_message) {
            pushDedup('agent', 'Codex', p.last_agent_message, ts);
          } else if (obj.type === 'response_item' && p.type === 'message' && Array.isArray(p.content)) {
            if (p.role === 'user') {
              for (const blk of p.content) {
                const rawBlk = String(blk?.text || '').trim();
                if (
                  !rawBlk ||
                  rawBlk.startsWith('# AGENTS.md instructions') ||
                  rawBlk.startsWith('<INSTRUCTIONS>') ||
                  rawBlk.startsWith('<environment_context>') ||
                  rawBlk.startsWith('<permissions instructions>')
                ) {
                  continue;
                }
                pushDedup('user', '我', rawBlk, ts);
              }
            } else if (p.role === 'assistant') {
              const joined = p.content
                .map((blk) => String(blk?.text || '').trim())
                .filter(Boolean)
                .join('\n');
              if (joined) {
                const phase = String(p.phase || '').toLowerCase();
                if (!phase || phase === 'final_answer' || phase === 'final') {
                  pushDedup('agent', 'Codex', joined, ts);
                } else {
                  fallbackCommentary = { text: joined, ts };
                }
              }
            }
          }
        } catch {
          // ignore malformed line
        }
      }
      if (items.length === 0 && fallbackCommentary) {
        pushDedup('agent', 'Codex', fallbackCommentary.text, fallbackCommentary.ts);
      }
    }

    if (items.length === 0 && firstUserMessage) {
      pushDedup('user', '我', firstUserMessage, updatedAt);
    }

    const sliced = items.slice(-limit);
    return {
      agent: 'codex',
      sessionId: safeId,
      title: title || `Codex ${safeId.slice(0, 8)}`,
      cwd,
      gitBranch,
      updatedAt,
      messages: sliced,
      items: sliced,
    };
  }

  // Antigravity conversation preview (checks both Desktop and CLI stores)
  let title = '';
  let summaryPreview = '';
  let cwd = '';
  let updatedAt = '';
  const candidateDirs = [antigravityDataDir];
  if (cliDir && path.resolve(cliDir) !== path.resolve(antigravityDataDir)) {
    candidateDirs.push(cliDir);
  }

  for (const storeDir of candidateDirs) {
    const agySqlitePath = path.join(storeDir, 'conversation_summaries.db');
    if (!fs.existsSync(agySqlitePath)) continue;
    let db = null;
    try {
      db = new DatabaseSync(agySqlitePath, { readOnly: true });
      const row = db
        .prepare(
          `SELECT conversation_id, title, preview, workspace_uris, last_modified_time
           FROM conversation_summaries
           WHERE conversation_id = ?
           LIMIT 1`
        )
        .get(safeId);
      if (row) {
        const rowTs = toIsoSafe(row.last_modified_time);
        const isNewer =
          !updatedAt || (rowTs && new Date(rowTs).getTime() > new Date(updatedAt).getTime());
        if (!cwd) {
          try {
            const uris = JSON.parse(row.workspace_uris || '[]');
            if (Array.isArray(uris) && uris[0]) cwd = decodeWorkspaceUri(uris[0]);
          } catch {}
        }
        if (!title || isNewer) {
          summaryPreview = String(row.preview || row.title || summaryPreview).trim();
          title =
            sanitizeSessionTitle(row.title || row.preview || '') ||
            title ||
            (cwd ? `${path.basename(cwd)} 会话` : `Antigravity ${safeId.slice(0, 8)}`);
        }
        if (isNewer && rowTs) updatedAt = rowTs;
      }
    } catch {
      // ignore sqlite error
    } finally {
      try {
        db?.close();
      } catch {}
    }
  }

  const items = [];
  let bestTranscriptPath = '';
  let bestTranscriptMtime = 0;
  for (const storeDir of candidateDirs) {
    const tp = path.join(
      storeDir,
      'brain',
      safeId,
      '.system_generated',
      'logs',
      'transcript.jsonl'
    );
    try {
      if (fs.existsSync(tp)) {
        const m = fs.statSync(tp).mtimeMs || 0;
        if (m >= bestTranscriptMtime) {
          bestTranscriptMtime = m;
          bestTranscriptPath = tp;
        }
      }
    } catch {}
  }

  if (bestTranscriptPath) {
    const tailText = await readTailUtf8(bestTranscriptPath, 262144);
    for (const line of tailText.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        const obj = JSON.parse(trimmed);
        const ts = toIsoSafe(obj.created_at);
        if (obj.type === 'USER_INPUT' && obj.source === 'USER_EXPLICIT' && obj.content) {
          const snippet = cleanPreviewSnippet(obj.content);
          if (snippet) {
            if (!title) title = sanitizeSessionTitle(snippet);
            items.push({ role: 'user', sender: '我', text: snippet, ts });
          }
        } else if (obj.type === 'PLANNER_RESPONSE' && obj.content) {
          const snippet = cleanPreviewSnippet(obj.content);
          if (snippet) {
            items.push({ role: 'agent', sender: 'Antigravity', text: snippet, ts });
          }
        }
      } catch {
        // ignore truncated / malformed line
      }
    }
  }

  if (items.length === 0 && summaryPreview) {
    const snippet = cleanPreviewSnippet(summaryPreview);
    if (snippet) {
      items.push({ role: 'user', sender: '摘要', text: snippet, ts: updatedAt });
    }
  }

  const sliced = items.slice(-limit);
  return {
    agent: 'antigravity',
    sessionId: safeId,
    title: title || `Antigravity ${safeId.slice(0, 8)}`,
    cwd,
    gitBranch: '',
    updatedAt,
    messages: sliced,
    items: sliced,
  };
}

function buildExtendedChildEnv() {
  const extraPaths = [
    path.join(HOME_DIR, '.local', 'bin'),
    path.join(LOCAL_APP_DATA, 'agy', 'bin'),
    ...(process.env.ACHAT_EXTRA_PATH
      ? process.env.ACHAT_EXTRA_PATH.split(path.delimiter).filter(Boolean)
      : []),
  ];
  const currentPath = process.env.PATH || process.env.Path || '';
  return {
    ...process.env,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    LANG: 'C.UTF-8',
    PATH: `${extraPaths.join(path.delimiter)}${currentPath ? `${path.delimiter}${currentPath}` : ''}`,
  };
}

function formatAgyToolCallSummary(tc = {}) {
  const name = String(tc.name || tc.tool_name || tc.ToolName || '').trim();
  const args = tc.args || tc.arguments || tc.Arguments || {};
  if (!name) return '';
  if (name === 'read_file' || name === 'write_file' || name === 'edit_file') {
    const p = String(args.Path || args.path || '').trim();
    const shortPath = p ? path.basename(p) || p : '文件';
    const range =
      args.StartLine || args.EndLine ? ` (L${args.StartLine || 1}-${args.EndLine || 'end'})` : '';
    const actionMap = {
      read_file: '📖 读取文件',
      write_file: '📝 写入文件',
      edit_file: '✏️ 修改文件',
    };
    return `${actionMap[name]}：${shortPath}${range}`;
  }
  if (name === 'run_command') {
    const summary = String(args.toolSummary || '').trim();
    const cmd = String(args.CommandLine || args.command || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 76);
    return `⚙ 执行命令${summary ? `（${summary}）` : ''}：${cmd || '终端指令'}`;
  }
  if (name === 'invoke_subagent') {
    const role = String(args.Role || args.TypeName || '子代理').trim();
    return `🤖 派生子代理：${role}`;
  }
  if (name === 'search_web') {
    return `🌐 网页检索：${String(args.query || '').trim().slice(0, 60)}`;
  }
  return `🔧 调用工具：${name}`;
}

function appendUniqueThoughtItem(traceList, item) {
  if (!Array.isArray(traceList) || !item?.text) return false;
  const cleanText = String(item.text).trim();
  if (!cleanText) return false;
  const kind = item.kind === 'tool' ? 'tool' : 'thinking';
  const last = traceList[traceList.length - 1];
  if (last && last.kind === kind) {
    if (last.text === cleanText) return false;
    if (kind === 'thinking' && cleanText.startsWith(last.text)) {
      last.text = cleanText;
      last.ts = item.ts || new Date().toISOString();
      return true;
    }
  }
  if (traceList.some((x) => x.kind === kind && x.text === cleanText)) {
    return false;
  }
  traceList.push({
    kind,
    text: cleanText.slice(0, 1600),
    ts: item.ts || new Date().toISOString(),
  });
  if (traceList.length > 60) {
    traceList.shift();
  }
  return true;
}

export async function executeExternalAgentTurn({
  agent,
  mode = 'existing',
  sessionId = '',
  cwd = '',
  prompt = '',
  attachments = [],
  permission = 'inherit',
  fallbackSandbox = 'read-only',
  gear = 'deep',
  model = '',
  codexBin = 'codex',
  codexExtraLeadArgs = [],
  codexHomeDir = path.join(os.homedir(), '.codex'),
  agyBin = DEFAULT_AGY_BIN,
  agyExtraLeadArgs = [],
  antigravityDataDir = path.join(os.homedir(), '.gemini', 'antigravity'),
  antigravityCliDataDir = null,
  registerChild = null,
  onProgress = null,
  onIntermediateMessage = null,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  timeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
}) {
  const effectiveIdleMs = Math.max(
    40,
    Number(idleTimeoutMs ?? timeoutMs) || DEFAULT_IDLE_TIMEOUT_MS
  );
  const idleLabel = formatIdleDurationLabel(effectiveIdleMs);
  const workingDir = cwd && fs.existsSync(cwd) ? cwd : process.cwd();
  const effort = gear === 'fast' ? 'low' : 'high';
  const safeModel = String(model || '')
    .trim()
    .replace(/[^a-zA-Z0-9._:/-]/g, '')
    .slice(0, 80);
  const emitProgressSafe = (payload) => {
    if (typeof onProgress !== 'function') return;
    try {
      onProgress(payload);
    } catch {
      // ignore listener error
    }
  };
  const emitIntermediateSafe = (payload) => {
    if (typeof onIntermediateMessage !== 'function') return;
    try {
      onIntermediateMessage(payload);
    } catch {
      // ignore listener error
    }
  };

  if (agent === 'claude' || agent === 'opencode' || agent === 'ollama') {
    return executeExtraProviderTurn({
      provider: agent,
      cwd: workingDir,
      prompt,
      model: safeModel,
      permission,
      registerChild,
      onProgress: emitProgressSafe,
      idleTimeoutMs: effectiveIdleMs,
    });
  }

  if (agent === 'codex') {
    const effectivePerm =
      permission === 'read-only' || permission === 'workspace-write'
        ? permission
        : mode === 'new'
          ? fallbackSandbox === 'workspace-write'
            ? 'workspace-write'
            : 'read-only'
          : 'inherit';

    const buildCodexArgs = (runMode, targetSessionId, promptText) => {
      const args = Array.isArray(codexExtraLeadArgs) ? [...codexExtraLeadArgs, 'exec'] : ['exec'];
      if (runMode === 'existing' && targetSessionId) {
        args.push('resume', targetSessionId);
      } else if (workingDir) {
        args.push('-C', workingDir);
      }
      args.push(
        '--skip-git-repo-check',
        '-c',
        'check_for_update_on_startup=false',
        '-c',
        'shell_environment_policy.inherit=all',
        '-c',
        'features.computer_use=false',
        '-c',
        `model_reasoning_effort=${effort}`,
        ...CODEX_SLIM_MCP_ARGS
      );
      if (safeModel) {
        args.push('-c', `model="${safeModel}"`);
      }
      if (runMode === 'existing' && targetSessionId) {
        if (effectivePerm === 'read-only' || effectivePerm === 'workspace-write') {
          args.push('-c', `sandbox_mode="${effectivePerm}"`);
        }
      } else {
        args.push('-s', effectivePerm === 'workspace-write' ? 'workspace-write' : 'read-only');
      }
      for (const att of attachments) {
        if (att?.kind === 'image' && att.filePath && fs.existsSync(att.filePath)) {
          args.push('-i', att.filePath);
        }
      }
      args.push('--json', promptText);
      return args;
    };

    const runSingleCodexProcess = (runMode, targetSessionId, promptText) =>
      new Promise((resolve) => {
        const args = buildCodexArgs(runMode, targetSessionId, promptText);
        const child = spawn(codexBin, args, {
          cwd: workingDir,
          env: buildExtendedChildEnv(),
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
        registerChild?.(child);

        let stdout = '';
        let lineBuf = '';
        let stderr = '';
        let settled = false;
        let detectedThreadId = runMode === 'existing' ? targetSessionId || '' : '';
        const messages = [];
        const allThoughtTrace = [];
        let segmentThoughtTrace = [];
        let pendingCompletedMsg = '';
        let liveText = '';
        let errorMsg = '';

        const flushPendingIntermediateMsgIfNeeded = () => {
          if (!pendingCompletedMsg) return;
          const msgToEmit = pendingCompletedMsg;
          const traceSnapshot = [...segmentThoughtTrace];
          pendingCompletedMsg = '';
          liveText = '';
          segmentThoughtTrace = [];
          emitIntermediateSafe({
            sessionId: detectedThreadId,
            text: msgToEmit,
            thoughtTrace: traceSnapshot,
          });
        };

        const recordCodexThought = (kind, text) => {
          appendUniqueThoughtItem(allThoughtTrace, { kind, text });
          appendUniqueThoughtItem(segmentThoughtTrace, { kind, text });
        };

        const parseCodexEventLine = (rawLine) => {
          const trimmed = rawLine.trim();
          if (!trimmed.startsWith('{')) return;
          try {
            const ev = JSON.parse(trimmed);
            if (ev.type === 'thread.started' && ev.thread_id) {
              detectedThreadId = ev.thread_id;
              emitProgressSafe({
                sessionId: detectedThreadId,
                stepLabel: '已连接 Codex 会话，正在思考…',
                text: liveText,
                thoughtTrace: [...allThoughtTrace],
              });
              return;
            }
            if (ev.type === 'item.started' && ev.item) {
              const it = ev.item;
              if (it.type !== 'agent_message') {
                flushPendingIntermediateMsgIfNeeded();
              }
              let stepLabel = '';
              if (it.type === 'command_execution') {
                const fullCmd = String(it.command || '')
                  .replace(/\s+/g, ' ')
                  .trim();
                const shortCmd = fullCmd.slice(0, 64);
                stepLabel = `⚙ 执行命令：${shortCmd || '终端指令'}`;
                recordCodexThought('tool', `⚙ 执行命令：${fullCmd.slice(0, 320) || '终端指令'}`);
              } else if (it.type === 'mcp_tool_call') {
                const toolDesc = `${it.server ? `${it.server}/` : ''}${it.tool || 'MCP'}`;
                stepLabel = `🔌 调用工具：${toolDesc}`;
                recordCodexThought('tool', stepLabel);
              } else if (it.type === 'file_change') {
                stepLabel = '✏️ 正在修改项目文件…';
                recordCodexThought('tool', '✏️ 修改项目文件');
              } else if (it.type === 'reasoning') {
                stepLabel = '💭 正在推演方案…';
              }
              if (stepLabel) {
                emitProgressSafe({
                  sessionId: detectedThreadId,
                  stepLabel,
                  text: liveText,
                  thoughtTrace: [...allThoughtTrace],
                });
              }
              return;
            }
            if ((ev.type === 'item.updated' || ev.type === 'item.completed') && ev.item) {
              const it = ev.item;
              if (it.type === 'agent_message' && typeof it.text === 'string') {
                const clean = it.text.trim();
                if (clean) {
                  if (pendingCompletedMsg && pendingCompletedMsg !== clean) {
                    flushPendingIntermediateMsgIfNeeded();
                  }
                  liveText = clean;
                  if (ev.type === 'item.completed') {
                    messages.push(clean);
                    pendingCompletedMsg = clean;
                  }
                  emitProgressSafe({
                    sessionId: detectedThreadId,
                    stepLabel: '✍ 正在输出回复…',
                    text: liveText,
                    thoughtTrace: [...allThoughtTrace],
                  });
                }
              } else if (it.type === 'reasoning' && typeof it.text === 'string') {
                flushPendingIntermediateMsgIfNeeded();
                const fullReasoning = it.text.trim();
                if (fullReasoning) {
                  recordCodexThought('thinking', fullReasoning);
                }
                const summaryLine = fullReasoning
                  .replace(/[*_`#]/g, '')
                  .replace(/\s+/g, ' ')
                  .trim()
                  .slice(0, 56);
                if (summaryLine) {
                  emitProgressSafe({
                    sessionId: detectedThreadId,
                    stepLabel: `💭 ${summaryLine}`,
                    text: liveText,
                    thoughtTrace: [...allThoughtTrace],
                  });
                }
              }
              return;
            }
            if (ev.type === 'error' && ev.message) {
              errorMsg = String(ev.message);
            }
          } catch {
            // ignore non-json line
          }
        };

        const idleWatchdog = createDualActivityIdleWatchdog({
          idleTimeoutMs: effectiveIdleMs,
          getCandidateFiles: () => {
            const list = [
              path.join(codexHomeDir, 'thread_history_1.sqlite'),
              path.join(codexHomeDir, 'thread_history_1.sqlite-wal'),
              path.join(codexHomeDir, 'state_5.sqlite'),
              path.join(codexHomeDir, 'state_5.sqlite-wal'),
            ];
            if (detectedThreadId) {
              list.push(path.join(codexHomeDir, `rollout-${detectedThreadId}.jsonl`));
            }
            return list;
          },
          onIdleTimeout: () => {
            if (settled) return;
            settled = true;
            try {
              child.kill();
            } catch {}
            resolve({
              ok: false,
              sessionId: detectedThreadId,
              rawDetail: 'idle_timeout',
              thoughtTrace: [...allThoughtTrace],
              text: `⚠️ 目标 Codex 会话长时间无响应（已连续 ${idleLabel} 无新输出），已自动断开。请检查任务状态或点击气泡下方「仅重试 Codex」。`,
            });
          },
        });

        child.stdout.on('data', (chunk) => {
          idleWatchdog.touch();
          const str = chunk.toString('utf8');
          stdout += str;
          lineBuf += str;
          const parts = lineBuf.split(/\r?\n/);
          lineBuf = parts.pop() || '';
          for (const p of parts) {
            parseCodexEventLine(p);
          }
        });
        child.stderr.on('data', (chunk) => {
          idleWatchdog.touch();
          stderr += chunk.toString('utf8');
        });
        child.on('error', (err) => {
          if (settled) return;
          settled = true;
          idleWatchdog.stop();
          resolve({
            ok: false,
            sessionId: detectedThreadId,
            rawDetail: err.message,
            thoughtTrace: [...allThoughtTrace],
            text: `⚠️ 启动 Codex 会话失败：${err.message}`,
          });
        });
        child.on('close', (code) => {
          if (settled) return;
          settled = true;
          idleWatchdog.stop();
          if (lineBuf.trim()) parseCodexEventLine(lineBuf);

          const finalReply = messages[messages.length - 1] || liveText || '';
          if (finalReply) {
            resolve({
              ok: true,
              sessionId: detectedThreadId,
              thoughtTrace:
                segmentThoughtTrace.length > 0 ? [...segmentThoughtTrace] : [...allThoughtTrace],
              text: finalReply,
            });
            return;
          }
          const rawCombined = `${errorMsg}\n${stderr}\n${stdout}`.trim();
          const detail = (errorMsg || stderr || stdout || `退出码 ${code}`).trim().slice(0, 420);
          resolve({
            ok: false,
            sessionId: detectedThreadId,
            rawDetail: rawCombined,
            thoughtTrace: [...allThoughtTrace],
            text: `⚠️ Codex 目标会话未返回正文：${detail}`,
          });
        });
      });

    if (mode === 'existing' && sessionId) {
      await ensureCodexThreadWritable({
        sessionId,
        codexHomeDir,
        maxWaitMs: 6500,
        onProgress: emitProgressSafe,
      });
    }

    const firstRes = await runSingleCodexProcess(mode, sessionId, prompt);
    if (firstRes.ok) {
      return firstRes;
    }

    const rawErr = String(firstRes.rawDetail || firstRes.text || '');
    const isWriterLockConflict =
      mode === 'existing' &&
      sessionId &&
      /already has an active writer|thread-store conflict/i.test(rawErr);

    if (isWriterLockConflict) {
      emitProgressSafe({
        sessionId,
        stepLabel: '🔄 原会话正被桌面窗口独占写锁，正在自动载入上下文同目录无缝续跑…',
        text: '',
      });
      let contextPrefix = '';
      try {
        const preview = await readExternalSessionPreview({
          agent: 'codex',
          sessionId,
          codexHomeDir,
          maxItems: 6,
        });
        const turns = Array.isArray(preview?.items) ? preview.items : [];
        if (turns.length > 0) {
          const formattedTurns = turns
            .map((t) => `- ${t.role === 'user' ? '用户' : 'Codex'}：${t.text}`)
            .join('\n');
          contextPrefix = `【原目标会话（${preview.title || sessionId.slice(0, 8)}）最近历史上下文自动接续】：\n${formattedTurns}\n\n`;
        }
      } catch {
        // ignore preview error
      }
      const companionRes = await runSingleCodexProcess('new', '', `${contextPrefix}${prompt}`);
      if (companionRes.ok) {
        return {
          ...companionRes,
          forkedFromSessionId: sessionId,
        };
      }
    }

    const { rawDetail: _unused, ...cleanRes } = firstRes;
    return cleanRes;
  }

  // Antigravity CLI execution (`agy.exe` with real-time NDJSON `stream-json`)
  if (mode === 'existing' && sessionId) {
    const cliDir = resolveCliDataDir(antigravityDataDir, antigravityCliDataDir);
    const srcConvPath = path.join(antigravityDataDir, 'conversations', `${sessionId}.db`);
    const dstConvPath = path.join(cliDir, 'conversations', `${sessionId}.db`);
    if (!fs.existsSync(dstConvPath) && fs.existsSync(srcConvPath)) {
      emitProgressSafe({
        sessionId,
        stepLabel: '🔗 正在只读快照同步桌面端会话上下文…',
        text: '',
      });
    }
    try {
      await ensureAntigravityCliTrajectory({
        sessionId,
        antigravityDataDir,
        antigravityCliDataDir: cliDir,
      });
    } catch {
      // non-fatal: let agy report detailed error if trajectory cannot be prepared
    }
  }

  const agyArgs = Array.isArray(agyExtraLeadArgs) ? [...agyExtraLeadArgs] : [];
  if (mode === 'existing' && sessionId) {
    agyArgs.push('--conversation', sessionId);
  }
  if (workingDir && fs.existsSync(workingDir)) {
    agyArgs.push('--add-dir', workingDir);
  }
  if (safeModel) {
    agyArgs.push('--model', safeModel);
  }
  agyArgs.push('--output-format', 'stream-json', '--effort', effort);

  if (permission === 'read-only') {
    agyArgs.push('--mode', 'plan', '--sandbox', '--dangerously-skip-permissions');
  } else {
    agyArgs.push('--dangerously-skip-permissions', '--disable-slash-commands');
  }

  const attachmentHint =
    attachments.length > 0
      ? `\n\n【附加文件路径】：\n${attachments.map((a) => `- ${a.filePath}`).join('\n')}`
      : '';
  const readOnlyGuard =
    permission === 'read-only'
      ? '【权限硬边界：本次任务为「只读分析」模式，严禁创建、修改或删除任何代码与本地文件，仅做读取与方案分析。】\n\n'
      : '';
  agyArgs.push('-p', `${readOnlyGuard}${prompt}${attachmentHint}`);

  return new Promise((resolve) => {
    const child = spawn(agyBin, agyArgs, {
      cwd: workingDir,
      env: buildExtendedChildEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    registerChild?.(child);

    let stdout = '';
    let lineBuf = '';
    let stderr = '';
    let settled = false;
    let detectedConvId = sessionId || '';
    let streamedResponse = '';
    let finalResultResponse = '';
    let resultErrorMsg = '';
    let sawCurrentUserInput = !(mode === 'existing' && sessionId);
    const allThoughtTrace = [];
    let segmentThoughtTrace = [];
    const emittedIntermediateTexts = new Set();

    const recordAgyThought = (kind, text) => {
      const changed = appendUniqueThoughtItem(allThoughtTrace, { kind, text });
      appendUniqueThoughtItem(segmentThoughtTrace, { kind, text });
      return changed;
    };

    const cliDirForWatch = resolveCliDataDir(antigravityDataDir, antigravityCliDataDir);
    const transcriptOffsets = new Map();
    const resolveTranscriptPaths = (convId) => {
      if (!convId) return [];
      const list = [];
      for (const dir of [antigravityDataDir, cliDirForWatch]) {
        if (!dir) continue;
        const p = path.join(dir, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
        if (!list.includes(p)) list.push(p);
      }
      return list;
    };

    // Record initial byte offsets so we only harvest steps from the current turn
    if (detectedConvId) {
      for (const tp of resolveTranscriptPaths(detectedConvId)) {
        try {
          if (fs.existsSync(tp)) {
            transcriptOffsets.set(tp, fs.statSync(tp).size);
          }
        } catch {}
      }
    }

    const syncAgyTranscriptDelta = () => {
      if (!detectedConvId) return;
      let anyAdded = false;
      let latestLabel = '';
      for (const tp of resolveTranscriptPaths(detectedConvId)) {
        try {
          if (!fs.existsSync(tp)) continue;
          const st = fs.statSync(tp);
          const prevOffset = transcriptOffsets.get(tp) ?? 0;
          if (st.size <= prevOffset) continue;
          const readLen = Math.min(st.size - prevOffset, 512 * 1024);
          const fd = fs.openSync(tp, 'r');
          const buf = Buffer.alloc(readLen);
          try {
            fs.readSync(fd, buf, 0, readLen, st.size - readLen);
          } finally {
            fs.closeSync(fd);
          }
          transcriptOffsets.set(tp, st.size);
          const chunkStr = buf.toString('utf8');
          const lines = chunkStr.split(/\r?\n/).filter(Boolean);
          for (const line of lines) {
            if (!line.trim().startsWith('{')) continue;
            let stepObj = null;
            try {
              stepObj = JSON.parse(line);
            } catch {
              continue;
            }
            if (stepObj.type === 'USER_INPUT' && stepObj.source === 'USER_EXPLICIT') {
              sawCurrentUserInput = true;
              continue;
            }
            if (stepObj.type === 'PLANNER_RESPONSE') {
              if (typeof stepObj.thinking === 'string' && stepObj.thinking.trim()) {
                const cleanThink = stepObj.thinking.trim();
                if (recordAgyThought('thinking', cleanThink)) {
                  anyAdded = true;
                  const shortThink = cleanThink
                    .replace(/\s+/g, ' ')
                    .slice(0, 56);
                  latestLabel = `💭 ${shortThink}`;
                }
              }
              const toolCalls = Array.isArray(stepObj.tool_calls) ? stepObj.tool_calls : [];
              for (const tc of toolCalls) {
                const summary = formatAgyToolCallSummary(tc);
                if (summary && recordAgyThought('tool', summary)) {
                  anyAdded = true;
                  latestLabel = summary;
                }
              }
              const contentText = typeof stepObj.content === 'string' ? stepObj.content.trim() : '';
              if (contentText && toolCalls.length > 0 && !emittedIntermediateTexts.has(contentText)) {
                emittedIntermediateTexts.add(contentText);
                const traceSnapshot = [...segmentThoughtTrace];
                segmentThoughtTrace = [];
                emitIntermediateSafe({
                  sessionId: detectedConvId,
                  text: contentText,
                  thoughtTrace: traceSnapshot,
                });
              }
            }
          }
        } catch {
          // ignore transient read error
        }
      }
      if (anyAdded) {
        emitProgressSafe({
          sessionId: detectedConvId,
          stepLabel: latestLabel || '💭 正在思考与执行工具…',
          text: sawCurrentUserInput ? streamedResponse.trim() : '',
          thoughtTrace: [...allThoughtTrace],
        });
      }
    };

    const transcriptPollTimer = setInterval(syncAgyTranscriptDelta, 60);
    transcriptPollTimer.unref?.();

    const parseAgyStreamLine = (rawLine) => {
      const trimmed = rawLine.trim();
      if (!trimmed.startsWith('{')) return;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed.event === 'init') {
          if (parsed.conversation_id) {
            const newId = String(parsed.conversation_id).trim();
            if (newId && newId !== detectedConvId) {
              detectedConvId = newId;
              for (const tp of resolveTranscriptPaths(detectedConvId)) {
                if (!transcriptOffsets.has(tp)) {
                  try {
                    transcriptOffsets.set(tp, fs.existsSync(tp) ? fs.statSync(tp).size : 0);
                  } catch {}
                }
              }
            }
          }
          emitProgressSafe({
            sessionId: detectedConvId,
            stepLabel: '已连接 Antigravity 会话，正在分析代码与上下文…',
            text: sawCurrentUserInput ? streamedResponse : '',
            thoughtTrace: [...allThoughtTrace],
          });
          return;
        }
        if (parsed.event === 'step_update' && parsed.step_update) {
          const su = parsed.step_update;
          if (su.conversation_id) detectedConvId = String(su.conversation_id).trim();
          const stType = String(su.step_type || '').toLowerCase();
          if (stType === 'user_input') {
            sawCurrentUserInput = true;
            streamedResponse = '';
            syncAgyTranscriptDelta();
            emitProgressSafe({
              sessionId: detectedConvId,
              stepLabel: '💭 已注入新指令，正在思考…',
              text: '',
              thoughtTrace: [...allThoughtTrace],
            });
            return;
          }
          if (typeof su.thinking === 'string' && su.thinking.trim()) {
            recordAgyThought('thinking', su.thinking.trim());
          }
          if (typeof su.thinking_delta === 'string' && su.thinking_delta.trim()) {
            recordAgyThought('thinking', su.thinking_delta.trim());
          }
          syncAgyTranscriptDelta();
          if (typeof su.text_delta === 'string' && su.text_delta) {
            streamedResponse += su.text_delta;
            if (sawCurrentUserInput) {
              emitProgressSafe({
                sessionId: detectedConvId,
                stepLabel: '✍ 正在生成回复…',
                text: streamedResponse.trim(),
                thoughtTrace: [...allThoughtTrace],
              });
            } else {
              emitProgressSafe({
                sessionId: detectedConvId,
                stepLabel: '📜 正在装载历史会话上下文…',
                text: '',
                thoughtTrace: [...allThoughtTrace],
              });
            }
          } else if (stType) {
            const lastThought = allThoughtTrace[allThoughtTrace.length - 1];
            const dynamicStepLabel = lastThought
              ? `${lastThought.kind === 'thinking' ? '💭 ' : ''}${lastThought.text.replace(/\s+/g, ' ').slice(0, 60)}`
              : '';
            const stepMap = {
              tool_call: '🔧 正在调用工具检查项目…',
              command: '⚙ 正在执行命令验证…',
              thinking: '💭 正在深度思考…',
              agent_response: '✍ 正在整理结论…',
            };
            emitProgressSafe({
              sessionId: detectedConvId,
              stepLabel: sawCurrentUserInput
                ? dynamicStepLabel || stepMap[stType] || `⚡ 正在执行步骤 (${stType})…`
                : '📜 正在装载历史会话上下文…',
              text: sawCurrentUserInput ? streamedResponse.trim() : '',
              thoughtTrace: [...allThoughtTrace],
            });
          }
          return;
        }
        if (parsed.event === 'result' && parsed.result) {
          if (parsed.result.conversation_id) {
            detectedConvId = String(parsed.result.conversation_id).trim();
          }
          if (typeof parsed.result.response === 'string' && parsed.result.response.trim()) {
            finalResultResponse = parsed.result.response.trim();
          }
          if (parsed.result.status === 'ERROR' && parsed.result.error) {
            resultErrorMsg = String(parsed.result.error);
          }
          return;
        }
        // Backward-compatibility with single-object `--output-format json` mocks
        if (parsed.response !== undefined || parsed.conversation_id) {
          if (parsed.conversation_id) detectedConvId = String(parsed.conversation_id).trim();
          if (typeof parsed.response === 'string' && parsed.response.trim()) {
            finalResultResponse = parsed.response.trim();
          }
        }
      } catch {
        // ignore non-json line
      }
    };

    const isExistingDesktopTurn =
      mode === 'existing' &&
      Boolean(sessionId) &&
      (fs.existsSync(path.join(antigravityDataDir, 'conversations', `${sessionId}.db`)) ||
        fs.existsSync(path.join(antigravityDataDir, 'annotations', `${sessionId}.pbtxt`)));

    let desktopVisibilityTimer = null;
    if (isExistingDesktopTurn) {
      desktopVisibilityTimer = setInterval(() => {
        restoreAntigravityDesktopTrajectory({
          sessionId: detectedConvId || sessionId,
          antigravityDataDir,
          antigravityCliDataDir: cliDirForWatch,
          keepCliDb: true,
        }).catch(() => {});
      }, 2500);
      desktopVisibilityTimer.unref?.();
    }

    const finalizeDesktopVisibility = async () => {
      clearInterval(transcriptPollTimer);
      syncAgyTranscriptDelta();
      if (desktopVisibilityTimer) {
        clearInterval(desktopVisibilityTimer);
        desktopVisibilityTimer = null;
      }
      if (isExistingDesktopTurn) {
        await restoreAntigravityDesktopTrajectory({
          sessionId: detectedConvId || sessionId,
          antigravityDataDir,
          antigravityCliDataDir: cliDirForWatch,
          keepCliDb: false,
        }).catch(() => {});
      }
    };

    const idleWatchdog = createDualActivityIdleWatchdog({
      idleTimeoutMs: effectiveIdleMs,
      getCandidateFiles: () => {
        const files = [];
        for (const dir of [antigravityDataDir, cliDirForWatch]) {
          if (!dir) continue;
          files.push(
            path.join(dir, 'conversation_summaries.db'),
            path.join(dir, 'conversation_summaries.db-wal')
          );
          if (detectedConvId) {
            files.push(
              path.join(dir, 'conversations', `${detectedConvId}.db`),
              path.join(dir, 'conversations', `${detectedConvId}.db-wal`),
              path.join(
                dir,
                'brain',
                detectedConvId,
                '.system_generated',
                'logs',
                'transcript.jsonl'
              )
            );
          }
        }
        return files;
      },
      onIdleTimeout: async () => {
        if (settled) return;
        settled = true;
        try {
          child.kill();
        } catch {}
        await finalizeDesktopVisibility();
        resolve({
          ok: false,
          sessionId: detectedConvId,
          thoughtTrace: [...allThoughtTrace],
          text: `⚠️ 目标 Antigravity 会话长时间无响应（已连续 ${idleLabel} 无新输出），已自动断开。请在桌面窗口查看或点击「仅重试 Antigravity」。`,
        });
      },
    });

    child.stdout.on('data', (chunk) => {
      idleWatchdog.touch();
      const str = chunk.toString('utf8');
      stdout += str;
      lineBuf += str;
      const parts = lineBuf.split(/\r?\n/);
      lineBuf = parts.pop() || '';
      for (const p of parts) {
        parseAgyStreamLine(p);
      }
    });
    child.stderr.on('data', (chunk) => {
      idleWatchdog.touch();
      stderr += chunk.toString('utf8');
    });
    child.on('error', async (err) => {
      if (settled) return;
      settled = true;
      idleWatchdog.stop();
      await finalizeDesktopVisibility();
      resolve({
        ok: false,
        sessionId: detectedConvId,
        thoughtTrace: [...allThoughtTrace],
        text: `⚠️ 启动 Antigravity 会话失败：${err.message}`,
      });
    });
    child.on('close', async (code) => {
      if (settled) return;
      settled = true;
      idleWatchdog.stop();
      if (lineBuf.trim()) parseAgyStreamLine(lineBuf);
      await finalizeDesktopVisibility();

      const bestReply = finalResultResponse || streamedResponse.trim();
      if (bestReply) {
        resolve({
          ok: true,
          sessionId: detectedConvId,
          thoughtTrace:
            segmentThoughtTrace.length > 0 ? [...segmentThoughtTrace] : [...allThoughtTrace],
          text: bestReply,
        });
        return;
      }

      const rawErr = `${resultErrorMsg}\n${stderr}\n${stdout}`.trim();
      if (/lock|busy|already running|in use/i.test(rawErr)) {
        resolve({
          ok: false,
          sessionId: detectedConvId,
          thoughtTrace: [...allThoughtTrace],
          text: '⚠️ 该 Antigravity 会话当前正在桌面窗口中运行另一轮任务（锁占用）。请等它当前轮跑完后点下方「仅重试 Antigravity」，或在上方切换为「➕ 在目录新建会话」。',
        });
        return;
      }
      if (/MODEL_PLACEHOLDER_/i.test(rawErr)) {
        resolve({
          ok: false,
          sessionId: detectedConvId,
          thoughtTrace: [...allThoughtTrace],
          text: '⚠️ 该历史会话绑定了旧版已下线的内部测试模型枚举，CLI 无法直接续跑。请在上方目标会话切换为「➕ 在目录新建会话」继续。',
        });
        return;
      }
      resolve({
        ok: false,
        sessionId: detectedConvId,
        thoughtTrace: [...allThoughtTrace],
        text: `⚠️ Antigravity 目标会话执行异常（退出码 ${code}）：${rawErr.slice(0, 380) || '无输出'}`,
      });
    });
  });
}
