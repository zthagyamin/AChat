import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import {
  discoverLocalSessions,
  executeExternalAgentTurn,
  isAgentRoutedExternally,
  normalizeSessionRouting,
  readExternalSessionPreview,
} from './session-router.mjs';
import {
  PROVIDER_CATALOG_META,
  buildAgentPersonaDirective,
  executeGitWorkspaceAction,
  extractInteractiveCardFromMessage,
  normalizeAgentProfiles,
} from './fusion-hub.mjs';
import {
  PHASE_LABELS,
  computeIdeBoardFingerprint,
  createActorBoardState,
  extractActorSubtaskHint,
  parseCollabSignal,
  parseIdeStepsFromText,
  pushBoardRecentAction,
  stripIdeProtocolTags,
} from './ide-collab.mjs';

const HOME_DIR = os.homedir();
const LOCAL_APP_DATA = process.env.LOCALAPPDATA || path.join(HOME_DIR, 'AppData', 'Local');
const BRIDGE_ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEGACY_SIBLING_ROOM_DIR = path.resolve(BRIDGE_ROOT_DIR, '..', 'cccc-room');
const CCCC_BIN =
  process.env.CCCC_BIN ||
  path.join(HOME_DIR, '.local', 'bin', process.platform === 'win32' ? 'cccc.exe' : 'cccc');
const CCCC_HOME = path.join(HOME_DIR, '.cccc');
const GROUPS_DIR = path.join(CCCC_HOME, 'groups');
const MCP_CONFIG_PATH =
  process.env.AGY_MCP_CONFIG_PATH || path.join(HOME_DIR, '.gemini', 'config', 'mcp_config.json');
const DEFAULT_ROOM_DIR =
  process.env.ACHAT_DEFAULT_ROOM_DIR ||
  (fs.existsSync(LEGACY_SIBLING_ROOM_DIR)
    ? LEGACY_SIBLING_ROOM_DIR
    : path.join(BRIDGE_ROOT_DIR, 'data', 'workspace'));
const AGY_BIN =
  process.env.AGY_BIN ||
  (process.platform === 'win32' ? path.join(LOCAL_APP_DATA, 'agy', 'bin', 'agy.exe') : 'agy');

const CODEX_SLIM_MCP_ARGS = [
  '-c', 'mcp_servers.blender.enabled=false',
  '-c', 'mcp_servers.chatcut.enabled=false',
  '-c', 'mcp_servers.dsh_bridge.enabled=false',
  '-c', 'mcp_servers.desktop_commander_remote.enabled=false',
  '-c', 'mcp_servers.node_repl.enabled=false',
  '-c', 'mcp_servers.antigravity_bridge.enabled=false',
];

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|svg)$/i;

export function buildCodexLaunchCommand(
  codexBin,
  { sandbox = 'read-only', gear = 'fast', model = '' } = {}
) {
  const safeSandbox = sandbox === 'workspace-write' ? 'workspace-write' : 'read-only';
  const effort = gear === 'fast' ? 'low' : 'high';
  const safeModel = String(model || '')
    .trim()
    .replace(/[^a-zA-Z0-9._:/-]/g, '')
    .slice(0, 80);
  const parts = [
    `"${codexBin}"`,
    '-c',
    'check_for_update_on_startup=false',
    '-c',
    'shell_environment_policy.inherit=all',
    '-c',
    'features.computer_use=false',
    `-c`,
    `model_reasoning_effort=${effort}`,
  ];
  if (safeModel) {
    parts.push('-c', `model="${safeModel}"`);
  }
  parts.push(...CODEX_SLIM_MCP_ARGS, '-s', safeSandbox, '-a', 'never');
  return parts.join(' ');
}

export function buildAntigravityLaunchCommand(
  agyBin = AGY_BIN,
  { gear = 'fast', model = '' } = {}
) {
  const safeModel = String(model || '')
    .trim()
    .replace(/[^a-zA-Z0-9._:/-]/g, '')
    .slice(0, 80);
  if (safeModel) {
    return `"${agyBin}" --dangerously-skip-permissions --model ${safeModel} --disable-slash-commands`;
  }
  if (gear === 'fast') {
    return `"${agyBin}" --dangerously-skip-permissions --model gemini-3.8-flash-low --disable-slash-commands`;
  }
  return `"${agyBin}" --dangerously-skip-permissions`;
}

export function detectActorSpeedGear(command = []) {
  const joined = Array.isArray(command) ? command.join(' ') : String(command || '');
  if (
    joined.includes('model_reasoning_effort=low') ||
    joined.includes('gemini-3.8-flash-low')
  ) {
    return 'fast';
  }
  return 'deep';
}

export function parseMessageAttachments(text = '', uploadsDir = '') {
  const attachments = [];
  const normUploads = uploadsDir ? path.resolve(uploadsDir).toLowerCase() : '';
  const cleaned = String(text || '').replace(
    /\[(图片|文件):\s*([^\]]+?)\]/g,
    (_full, kindLabel, rawPath) => {
      const trimmedPath = rawPath.trim();
      const baseName = path.basename(trimmedPath);
      const isImg = kindLabel === '图片' || IMAGE_EXT_RE.test(baseName);
      let url = '';
      if (normUploads) {
        const resolved = path.resolve(trimmedPath).toLowerCase();
        if (resolved.startsWith(normUploads)) {
          url = `/api/uploads/${encodeURIComponent(baseName)}`;
        }
      } else if (trimmedPath.includes('uploads')) {
        url = `/api/uploads/${encodeURIComponent(baseName)}`;
      }
      attachments.push({
        kind: isImg ? 'image' : 'file',
        name: baseName,
        filePath: trimmedPath,
        url,
      });
      return '';
    }
  );
  return {
    cleanText: cleaned.replace(/\n{3,}/g, '\n\n').trim(),
    attachments,
  };
}

function buildExtendedEnv() {
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

function execCccc(args, { timeout = 15000, cwd = DEFAULT_ROOM_DIR } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      CCCC_BIN,
      args,
      {
        cwd: fs.existsSync(cwd) ? cwd : process.cwd(),
        env: buildExtendedEnv(),
        timeout,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || stdout || err.message || '').trim();
          const wrapped = new Error(`cccc ${args.join(' ')} failed: ${detail}`);
          wrapped.stdout = stdout;
          wrapped.stderr = stderr;
          return reject(wrapped);
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

async function execCcccJson(args, opts) {
  const { stdout } = await execCccc(args, opts);
  const trimmed = stdout.trim();
  const firstBrace = trimmed.indexOf('{');
  const jsonText = firstBrace >= 0 ? trimmed.slice(firstBrace) : trimmed;
  return JSON.parse(jsonText);
}

export async function repinMcpConfig() {
  try {
    if (!fs.existsSync(MCP_CONFIG_PATH)) return;
    const raw = await fsp.readFile(MCP_CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed?.mcpServers?.cccc && parsed.mcpServers.cccc.command !== CCCC_BIN) {
      parsed.mcpServers.cccc.command = CCCC_BIN;
      await fsp.writeFile(MCP_CONFIG_PATH, JSON.stringify(parsed, null, 2), 'utf8');
    }
  } catch {
    // Non-fatal safeguard
  }
}

let cachedCodexBinary = { ts: 0, exe: '' };

async function resolveCodexBinary() {
  const now = Date.now();
  if (
    cachedCodexBinary.exe &&
    now - cachedCodexBinary.ts < 60_000 &&
    (cachedCodexBinary.exe === 'codex' || fs.existsSync(cachedCodexBinary.exe))
  ) {
    return cachedCodexBinary.exe;
  }

  // 1. Prefer OpenAI Codex Desktop CLI bin directory (%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe)
  const localAppData =
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const codexBinRoot = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
  try {
    if (fs.existsSync(codexBinRoot)) {
      const dirs = await fsp.readdir(codexBinRoot, { withFileTypes: true });
      const candidates = [];
      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        const exe = path.join(codexBinRoot, d.name, 'codex.exe');
        if (fs.existsSync(exe)) {
          const st = await fsp.stat(exe);
          candidates.push({ exe, mtimeMs: st.mtimeMs });
        }
      }
      candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
      if (candidates.length > 0) {
        cachedCodexBinary = { ts: now, exe: candidates[0].exe };
        return candidates[0].exe;
      }
    }
  } catch {
    // continue to fallbacks
  }

  // 2. Try Get-AppxPackage InstallLocation for Microsoft Store OpenAI.Codex
  try {
    const installLoc = await new Promise((resolve) => {
      execFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          "(Get-AppxPackage -Name 'OpenAI.Codex*' | Sort-Object Version -Descending | Select-Object -First 1).InstallLocation",
        ],
        { timeout: 4000, windowsHide: true },
        (err, stdout) => {
          if (err) return resolve('');
          resolve(String(stdout || '').trim());
        }
      );
    });
    if (installLoc) {
      const candidate = path.join(installLoc, 'app', 'resources', 'codex.exe');
      if (fs.existsSync(candidate)) {
        cachedCodexBinary = { ts: now, exe: candidate };
        return candidate;
      }
    }
  } catch {
    // ignore
  }

  cachedCodexBinary = { ts: now, exe: 'codex' };
  return 'codex';
}

function cleanScopeUrl(url = '') {
  return String(url).replace(/^\\\\\?\\/, '');
}

function detectReadOnly(command = []) {
  if (!Array.isArray(command)) return false;
  for (let i = 0; i < command.length; i += 1) {
    if ((command[i] === '-s' || command[i] === '--sandbox') && command[i + 1] === 'read-only') {
      return true;
    }
  }
  return false;
}

export function stripSharedContextBlock(raw = '') {
  return String(raw || '')
    .replace(/\n*<!--aw-ctx:start-->[\s\S]*?(?:<!--aw-ctx:end-->|$)/g, '')
    .trim();
}

export async function extractRolloutLiveStep(rolloutPath, maxBytes = 24576) {
  if (!rolloutPath || !fs.existsSync(rolloutPath)) return null;
  let handle = null;
  try {
    handle = await fsp.open(rolloutPath, 'r');
    const stat = await handle.stat();
    if (!stat.size) return null;
    const readLen = Math.min(stat.size, maxBytes);
    const startOffset = Math.max(0, stat.size - readLen);
    const buf = Buffer.alloc(readLen);
    const { bytesRead } = await handle.read(buf, 0, readLen, startOffset);
    let rawChunk = buf.subarray(0, bytesRead).toString('utf8');
    if (startOffset > 0) {
      const firstNl = rawChunk.indexOf('\n');
      if (firstNl >= 0) rawChunk = rawChunk.slice(firstNl + 1);
    }
    const lines = rawChunk.split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      let item;
      try {
        item = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      const updatedAt = item.timestamp || null;
      const p = item.payload || {};
      const pType = p.type || item.type || '';

      if (pType === 'message' && p.role === 'assistant') {
        const blocks = Array.isArray(p.content) ? p.content : [];
        const rawText = blocks
          .map((b) => (typeof b?.text === 'string' ? b.text : ''))
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (rawText) {
          return { kind: 'note', stepText: rawText.slice(0, 88), updatedAt };
        }
      }

      if (pType === 'agent_message' && typeof p.message === 'string') {
        const rawText = p.message.replace(/\s+/g, ' ').trim();
        if (rawText) {
          return { kind: 'note', stepText: rawText.slice(0, 88), updatedAt };
        }
      }

      if (pType === 'custom_tool_call' || pType === 'function_call') {
        const name = String(p.name || '').trim();
        const rawArgs = String(p.input || p.arguments || '').replace(/\s+/g, ' ').trim();
        const callSource = `${name} ${rawArgs}`;
        let stepText = name ? `🔧 调用工具 ${name}…` : '🔧 正在调用工具…';
        if (/tools\.mcp__cccc__cccc_message_(?:reply|send)\s*\(|^cccc_message_(?:reply|send)$/i.test(callSource)) {
          stepText = '✍ 正在整理并发送群消息回复…';
        } else if (/view_image\s*\(/i.test(callSource)) {
          stepText = '🖼 正在读取并分析图片附件…';
        } else if (/tools\.mcp__cccc__cccc_|^cccc_/i.test(callSource)) {
          stepText = '🔄 正在同步群聊协作状态…';
        } else if (/memory_|obsidian_/i.test(callSource)) {
          stepText = '📚 正在检索知识库与笔记上下文…';
        } else if (/^(exec|exec_command|shell|shell_command|bash|powershell)$/i.test(name)) {
          let cmdPreview = '';
          try {
            const parsedArgs = JSON.parse(p.arguments || p.input || '{}');
            cmdPreview = String(parsedArgs.cmd || parsedArgs.command || '').replace(/\s+/g, ' ').trim();
          } catch {
            cmdPreview = rawArgs;
          }
          stepText = cmdPreview
            ? `⚙ 执行命令：${cmdPreview.slice(0, 64)}`
            : '⚙ 正在执行终端检索或脚本命令…';
        }
        return { kind: 'tool', stepText, updatedAt };
      }

      if (pType === 'reasoning' || pType === 'agent_reasoning') {
        let reasonText = '';
        if (typeof p.text === 'string' && p.text.trim()) {
          reasonText = p.text.trim();
        } else if (Array.isArray(p.summary)) {
          reasonText = p.summary
            .map((s) => (typeof s?.text === 'string' ? s.text : ''))
            .join(' ')
            .trim();
        }
        const cleanReason = reasonText.replace(/[*_`#]/g, '').replace(/\s+/g, ' ').trim();
        return {
          kind: 'reasoning',
          stepText: cleanReason ? `💭 ${cleanReason.slice(0, 72)}` : '💭 正在深度推理分析…',
          updatedAt,
        };
      }

      if (pType === 'task_started') {
        return { kind: 'start', stepText: '已接收任务，正在启动分析…', updatedAt };
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function inspectCodexRolloutForPending(
  rolloutPath,
  targetEventIds = [],
  maxBytes = 262144
) {
  const empty = {
    matched: false,
    turnId: '',
    completed: false,
    aborted: false,
    calledCcccSend: false,
    finalAnswerText: '',
    completedAtMs: 0,
  };
  const validTargets = (Array.isArray(targetEventIds) ? targetEventIds : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean);
  if (!rolloutPath || validTargets.length === 0 || !fs.existsSync(rolloutPath)) {
    return empty;
  }

  let handle = null;
  try {
    handle = await fsp.open(rolloutPath, 'r');
    const stat = await handle.stat();
    if (!stat.size) return empty;
    const readLen = Math.min(stat.size, maxBytes);
    const startOffset = Math.max(0, stat.size - readLen);
    const buf = Buffer.alloc(readLen);
    const { bytesRead } = await handle.read(buf, 0, readLen, startOffset);
    let rawChunk = buf.subarray(0, bytesRead).toString('utf8');
    if (startOffset > 0) {
      const firstNl = rawChunk.indexOf('\n');
      if (firstNl >= 0) rawChunk = rawChunk.slice(firstNl + 1);
    }

    const lines = rawChunk.split(/\r?\n/).filter(Boolean);
    const turns = [];
    let currentTurn = null;

    const ensureTurn = (turnId = '') => {
      if (!currentTurn) {
        currentTurn = {
          turnId: String(turnId || ''),
          matched: false,
          isSystemMailNotice: false,
          completed: false,
          aborted: false,
          calledCcccSend: false,
          finalPhaseMessage: '',
          taskCompleteMessage: '',
          completedAtMs: 0,
        };
        turns.push(currentTurn);
      } else if (turnId && !currentTurn.turnId) {
        currentTurn.turnId = String(turnId);
      }
      return currentTurn;
    };

    for (const line of lines) {
      let item;
      try {
        item = JSON.parse(line);
      } catch {
        continue;
      }
      const p = item.payload || {};
      const pType = p.type || item.type || '';

      if (pType === 'task_started') {
        const tId = p.turn_attribution?.turn_id || p.turn_id || '';
        currentTurn = null;
        ensureTurn(tId);
        continue;
      }

      if (pType === 'user_message') {
        const turn = ensureTurn();
        const msg = String(p.message || '');
        if (/^\[cccc\]\s+SYSTEM\s+\(mail_notice\)/i.test(msg.trim())) {
          turn.isSystemMailNotice = true;
        }
        if (validTargets.some((id) => msg.includes(id))) {
          turn.matched = true;
        }
        continue;
      }

      if (pType === 'custom_tool_call' || pType === 'function_call') {
        const turn = ensureTurn();
        const name = String(p.name || '').trim();
        const codeBody = String(p.input || '');
        if (
          /^cccc_message_(?:reply|send)$/i.test(name) ||
          /mcp__cccc__cccc_message_(?:reply|send)$/i.test(name) ||
          /tools\.mcp__cccc__cccc_message_(?:reply|send)\s*\(/.test(codeBody)
        ) {
          turn.calledCcccSend = true;
        }
        continue;
      }

      if (pType === 'agent_message' && typeof p.message === 'string') {
        const turn = ensureTurn();
        const phase = String(p.phase || '').toLowerCase();
        if (phase === 'final_answer' || phase === 'final') {
          const clean = p.message.trim();
          if (clean) turn.finalPhaseMessage = clean;
        }
        continue;
      }

      if (pType === 'turn_aborted') {
        const turn = ensureTurn(p.turn_id || '');
        turn.aborted = true;
        currentTurn = null;
        continue;
      }

      if (pType === 'task_complete') {
        const turn = ensureTurn(p.turn_id || '');
        turn.completed = true;
        if (typeof p.last_agent_message === 'string' && p.last_agent_message.trim()) {
          turn.taskCompleteMessage = p.last_agent_message.trim();
        }
        if (Number(p.completed_at) > 0) {
          turn.completedAtMs = Number(p.completed_at) * 1000;
        } else if (item.timestamp) {
          const parsedTs = Date.parse(item.timestamp);
          if (!Number.isNaN(parsedTs)) turn.completedAtMs = parsedTs;
        }
        currentTurn = null;
      }
    }

    for (let i = turns.length - 1; i >= 0; i -= 1) {
      const t = turns[i];
      if (!t.matched || t.isSystemMailNotice) continue;
      return {
        matched: true,
        turnId: t.turnId,
        completed: t.completed,
        aborted: t.aborted,
        calledCcccSend: t.calledCcccSend,
        finalAnswerText: t.finalPhaseMessage || t.taskCompleteMessage || '',
        completedAtMs: t.completedAtMs,
      };
    }
    return empty;
  } catch {
    return empty;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function formatShortTime(iso) {
  const d = new Date(iso || '');
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export const VALID_REPLY_STYLES = ['plain', 'balanced', 'pro'];

export function normalizeReplyStyle(raw) {
  return VALID_REPLY_STYLES.includes(raw) ? raw : 'plain';
}

export function buildReplyStyleDirective(style = 'plain') {
  const normalized = normalizeReplyStyle(style);
  if (normalized === 'pro') {
    return '[回复表达风格要求（当前档位：🔬 专业深度）：用户需要深入专业技术分析。请结论先行、言简意赅不讲空话，同时完整保留准确的专业术语、架构机制、源码符号/路径依据、边界条件与必要的公式或代码推导]';
  }
  if (normalized === 'balanced') {
    return '[回复表达风格要求（当前档位：⚖️ 适中清晰）：请用自然好懂的中文表达，先给一句话核心结论，再用 2–4 个清晰短要点说明原因与下一步建议；少说套话废话，保留关键术语时附简短通俗说明，兼顾好读与准确]';
  }
  return '[回复表达风格强制要求（当前档位：💬 人话精简）：用户希望像日常微信聊天一样轻松读懂。请严格遵守：1) 第一句直接说大白话结论，严禁客套寒暄、复述问题或说车轱辘废话；2) 禁止堆砌晦涩英文缩写、内部黑话、源码行号或长篇复杂公式（除非用户明确索要代码/公式）；必须提到专业概念时，顺手用一句直白的生活化大白话解释清楚；3) 尽量控制在 3–6 句话或 2–4 个短要点内讲透“是什么、对你有什么影响、下一步怎么做”]';
}

export function computeGroupsFingerprint(groups = []) {
  if (!Array.isArray(groups)) return '';
  return JSON.stringify(
    groups.map((g) => ({
      id: g.id,
      kind: g.kind,
      title: g.title,
      topic: g.topic,
      running: g.running,
      state: g.state,
      scopePath: g.scopePath,
      speedGear: g.speedGear,
      replyStyle: g.replyStyle || 'plain',
      sessionRouting: g.sessionRouting || null,
      agentProfiles: g.agentProfiles || null,
      codexSandbox: g.codexSandbox,
      collabMode: g.collabMode,
      relayLead: g.relayLead,
      pinned: g.pinned,
      archived: g.archived,
      memberCount: g.memberCount,
      messageCount: g.messageCount,
      lastMessage: g.lastMessage || null,
      actors: (g.actors || []).map((a) => ({
        id: a.id,
        title: a.title,
        role: a.role,
        running: a.running,
        enabled: a.enabled,
        pid: a.pid,
        readOnly: a.readOnly,
        speedGear: a.speedGear,
        workingState: a.workingState,
        thinkingSince: a.thinkingSince,
        stepText: a.liveStep?.stepText || '',
      })),
      ideBoard: computeIdeBoardFingerprint(g.ideBoard),
    }))
  );
}

export class CcccBridge extends EventEmitter {
  constructor({
    dataDir,
    groupsDir = GROUPS_DIR,
    uploadsDir = path.join(DEFAULT_ROOM_DIR, 'uploads'),
    codexSessionsRoot = path.join(os.homedir(), '.codex', 'sessions'),
    codexHomeDir = path.join(os.homedir(), '.codex'),
    antigravityDataDir = path.join(os.homedir(), '.gemini', 'antigravity'),
    antigravityCliDataDir = null,
    enableWatchdogInTests = false,
    allowStandbyExecInTests = false,
    composerMinWaitMs = null,
    composerPollIntervalMs = null,
    ptyEnterNudgeOverride = null,
    externalSessionRunnerOverride = null,
    execCcccOverride = null,
    execJsonOverride = null,
  }) {
    super();
    this.dataDir = dataDir;
    this.groupsDir = groupsDir;
    this.uploadsDir = uploadsDir;
    this.codexSessionsRoot = codexSessionsRoot;
    this.codexHomeDir = codexHomeDir;
    this.antigravityDataDir = antigravityDataDir;
    this.antigravityCliDataDir = antigravityCliDataDir;
    this.enableWatchdogInTests = Boolean(enableWatchdogInTests);
    this.allowStandbyExecInTests = Boolean(allowStandbyExecInTests);
    this.composerMinWaitMs = composerMinWaitMs;
    this.composerPollIntervalMs = composerPollIntervalMs;
    this.hasCustomPtyEnterNudge = Boolean(ptyEnterNudgeOverride);
    this.ptyEnterNudgeFn =
      ptyEnterNudgeOverride || ((groupId, actorId) => this.sendPtyEnterKeystroke(groupId, actorId));
    this.externalSessionRunnerFn =
      externalSessionRunnerOverride || ((params) => executeExternalAgentTurn(params));
    this.externalDispatchesDir = path.join(dataDir, 'external-dispatches');
    this.externalSessionCache = { ts: 0, data: null };
    this.externalThinkingActors = new Map(); // groupId -> Map<actorId, { since, label }>
    this.activeExternalChildren = new Map(); // groupId -> Set<ChildProcess>
    this.cancelledExternalGroups = new Set(); // groupId interrupted flag
    this.fileHelperPath = path.join(dataDir, 'file-helper.json');
    this.groupPrefsPath = path.join(dataDir, 'group-prefs.json');
    this.clientSyncPath = path.join(dataDir, 'client-sync.json');
    this.cardSettlementsPath = path.join(dataDir, 'card-settlements.json');
    this.groupPrefs = {}; // groupId -> { speedGear, collabMode, relayLead, pinned, archived, agentProfiles }
    this.groupPrefsRev = 0;
    this.clientSyncState = null; // { stars: [], templates: [], updatedAt }
    this.cardSettlements = null; // cardId -> settlement record
    this.cardSettlementsRev = 0;
    this.execFn = execCcccOverride || execCccc;
    this.execJsonFn = execJsonOverride || execCcccJson;
    this.isMockExec = Boolean(execCcccOverride || execJsonOverride);
    this.ledgerCache = new Map(); // groupId -> { size, mtimeMs, extSize, extMtimeMs, messages, ... }
    this.ledgerBaseCache = new Map(); // groupId -> { size, mtimeMs, messages, latestActivity, pendingSince, pendingMessageMeta, lastReplyAt, rawCount }
    this.extDispatchCache = new Map(); // groupId -> { size, mtimeMs, messages }
    this.ledgerParseStats = new Map(); // groupId -> count of main ledger.jsonl parses
    this.seededGroups = new Set(); // groupId seeded so historical messages don't replay on boot
    this.emittedMessageIds = new Map(); // groupId -> Set<msgId> (guarantees zero dropped SSE bubbles)
    this.lastThinkingKey = new Map(); // groupId -> sorted thinking actor IDs string
    this.liveActorStates = new Map(); // groupId -> Map<actorId, { running, workingState, activeTaskId, stateSource }>
    this.droppedTurnRetried = new Set(); // `${groupId}:${actorId}:${eventId}`
    this.pendingTurnRecovery = new Map(); // `${groupId}:${actorId}:${eventId}` -> { attempts, lastAttemptAt, inFlight, retryEventIds }
    this.harvestedTurnIds = new Set(); // `${groupId}:${actorId}:${turnId}`
    this.harvestingKeys = new Set(); // in-flight harvest lock
    this.cancelledPendingIds = new Set(); // `${groupId}:${actorId}:${eventId}`
    this.rolloutPathCache = new Map(); // threadId -> rollout jsonl path
    this.retryingActors = new Set(); // `${groupId}:${actorId}`
    this.pendingRelays = new Map(); // groupId -> { userText, leadId, leadTitle, reviewerId, reviewerTitle, baselineIds }
    this.activeRelayReviewers = new Map(); // groupId -> reviewerId
    this.ideBoards = new Map(); // groupId -> live IDE Task Board snapshot
    this.lastIdeBoardFp = new Map(); // groupId -> last emitted IDE board fingerprint
    this.groupWatchers = new Map(); // groupId -> { watcher, debounceTimer }
    this.rootWatcher = null;
    this.extWatcher = null;
    this.extWatchDebounce = null;
    this.mcpConfigRepinned = false;
    this.cachedWebOrigin = { ts: 0, host: '127.0.0.1', port: 8848 };
    this.groupMetaCache = { ts: 0, data: null };
    this.groupShowCache = new Map(); // groupId -> { ts, showData }
    this.listGroupsInFlight = null;
    this.lastGroupsFingerprint = '';
    this.cachedDaemonStatus = { running: true };
    this.autoHealCooldown = new Map(); // `${groupId}:${actorId}` -> timestamp
    this.pollTimer = null;
    this.metaRefreshTimer = null;
    this.ensuringPromise = null;
    this.standbyMode = false;
    this.wakingPromise = null;
    this.enteringStandbyPromise = null;
    this.ccccWebPid = null;
  }

  async init({ standby = false } = {}) {
    await fsp.mkdir(this.dataDir, { recursive: true });
    await fsp.mkdir(this.uploadsDir, { recursive: true });
    await this.loadGroupPrefs();
    await this.loadClientSyncState();
    await this.ensureFileHelperSeed();
    if (standby) {
      await this.enterStandby();
      return;
    }
    await this.ensureDaemonRunning();
    await this.primeAllLedgers();
    await this.refreshAllMeta().catch(() => {});
    this.startPolling();
  }

  async loadGroupPrefs() {
    try {
      if (fs.existsSync(this.groupPrefsPath)) {
        this.groupPrefs = JSON.parse(await fsp.readFile(this.groupPrefsPath, 'utf8')) || {};
      }
    } catch {
      this.groupPrefs = {};
    }
  }

  async saveGroupPrefs() {
    this.groupPrefsRev = (this.groupPrefsRev || 0) + 1;
    await fsp.mkdir(this.dataDir, { recursive: true });
    await fsp.writeFile(this.groupPrefsPath, JSON.stringify(this.groupPrefs, null, 2), 'utf8');
  }

  ensureCardSettlementsLoaded() {
    if (this.cardSettlements) return this.cardSettlements;
    try {
      if (fs.existsSync(this.cardSettlementsPath)) {
        this.cardSettlements =
          JSON.parse(fs.readFileSync(this.cardSettlementsPath, 'utf8')) || {};
        return this.cardSettlements;
      }
    } catch {
      // ignore corrupted settlement cache
    }
    this.cardSettlements = {};
    return this.cardSettlements;
  }

  async saveCardSettlements() {
    const map = this.ensureCardSettlementsLoaded();
    await fsp.mkdir(this.dataDir, { recursive: true });
    await fsp.writeFile(this.cardSettlementsPath, JSON.stringify(map, null, 2), 'utf8');
  }

  isGroupEffectiveReadOnly(groupId) {
    const prefs = this.groupPrefs[groupId] || {};
    if (prefs.sessionRouting?.permission === 'read-only') return true;
    const cachedGroup = (this.groupMetaCache?.data || []).find((g) => g.id === groupId);
    if (cachedGroup && cachedGroup.codexSandbox === 'read-only') return true;
    return false;
  }

  decorateMessageWithCard(groupId, msg) {
    if (!msg || msg.isUser || msg.kind !== 'chat') return msg;
    const customName = String(
      this.groupPrefs[groupId]?.agentProfiles?.[msg.by]?.displayName || ''
    ).trim();
    const msgWithProfile =
      customName && msg.senderTitle !== customName ? { ...msg, senderTitle: customName } : msg;
    const groupReadOnly = this.isGroupEffectiveReadOnly(groupId);
    const baseCard = extractInteractiveCardFromMessage(msgWithProfile, { groupReadOnly });
    if (!baseCard) return msgWithProfile;
    const settlements = this.ensureCardSettlementsLoaded();
    const settled = settlements[baseCard.id] || null;
    return {
      ...msgWithProfile,
      interactiveCard: {
        ...baseCard,
        settled,
      },
    };
  }

  stop() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.metaRefreshTimer) {
      clearInterval(this.metaRefreshTimer);
      this.metaRefreshTimer = null;
    }
    if (this.extWatchDebounce) {
      clearTimeout(this.extWatchDebounce);
      this.extWatchDebounce = null;
    }
    if (this.extWatcher) {
      try {
        this.extWatcher.close();
      } catch {
        // ignore
      }
      this.extWatcher = null;
    }
    if (this.rootWatcher) {
      try {
        this.rootWatcher.close();
      } catch {
        // ignore
      }
      this.rootWatcher = null;
    }
    for (const entry of this.groupWatchers.values()) {
      clearTimeout(entry.debounceTimer);
      try {
        entry.watcher.close();
      } catch {
        // ignore
      }
    }
    this.groupWatchers.clear();
  }

  hasActiveWork() {
    if (
      this.retryingActors.size > 0 ||
      this.pendingRelays.size > 0 ||
      this.activeRelayReviewers.size > 0
    ) {
      return true;
    }
    for (const actorMap of this.externalThinkingActors.values()) {
      if (actorMap && actorMap.size > 0) return true;
    }
    for (const childSet of this.activeExternalChildren.values()) {
      if (childSet && childSet.size > 0) return true;
    }
    const nowMs = Date.now();
    for (const [groupId, cached] of this.ledgerCache.entries()) {
      const pendingMap = cached?.pendingMessageMeta || {};
      for (const [actorId, meta] of Object.entries(pendingMap)) {
        if (!meta?.id) continue;
        const ageMs = meta.ts ? nowMs - new Date(meta.ts).getTime() : -1;
        const key = `${groupId}:${actorId}:${meta.id}`;
        if (
          ageMs >= 0 &&
          ageMs < 300_000 &&
          !this.cancelledPendingIds.has(key) &&
          !this.droppedTurnRetried.has(key)
        ) {
          return true;
        }
      }
    }
    return false;
  }

  async enterStandby() {
    if (this.enteringStandbyPromise) return this.enteringStandbyPromise;
    this.enteringStandbyPromise = (async () => {
      this.stop();
      this.standbyMode = true;
      this.groupMetaCache = { ts: 0, data: null };
      this.groupShowCache.clear();
      this.cachedDaemonStatus = { running: false, standby: true };

      if (!this.isMockExec || this.allowStandbyExecInTests) {
        const status = await this.getDaemonStatus().catch(() => ({ running: false }));
        if (status?.running) {
          const summary = await this.queryGroupsSummary().catch(() => null);
          const rawGroups = Array.isArray(summary?.groups) ? summary.groups : [];
          for (const g of rawGroups) {
            if (g?.group_id && (g.running !== false || (g.state && g.state !== 'stopped'))) {
              await this.execFn(['group', 'stop', '--group', g.group_id], {
                timeout: 12000,
              }).catch(() => {});
            }
          }
          await this.execFn(['daemon', 'stop'], { timeout: 10000 }).catch(() => {});
        }
        if (this.ccccWebPid) {
          try {
            process.kill(this.ccccWebPid);
          } catch {
            // ignore
          }
          this.ccccWebPid = null;
        }
        if (!this.isMockExec) {
          const stillUp = await this.fetchCcccDaemonApi('/api/v1/ping', { timeoutMs: 500 });
          if (stillUp) {
            await new Promise((resolve) => {
              execFile(
                'powershell.exe',
                [
                  '-NoProfile',
                  '-NonInteractive',
                  '-WindowStyle',
                  'Hidden',
                  '-Command',
                  "Get-CimInstance Win32_Process -Filter \"Name='cccc.exe'\" | Where-Object { $_.CommandLine -match 'web\\s+--host\\s+127\\.0\\.0\\.1\\s+--port\\s+8848' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
                ],
                { windowsHide: true, timeout: 6000 },
                () => resolve()
              );
            });
          }
        }
      }
      return true;
    })();

    try {
      return await this.enteringStandbyPromise;
    } finally {
      this.enteringStandbyPromise = null;
    }
  }

  async wakeFromStandby() {
    if (!this.standbyMode) return false;
    if (this.wakingPromise) return this.wakingPromise;
    this.wakingPromise = (async () => {
      if (this.enteringStandbyPromise) {
        await this.enteringStandbyPromise.catch(() => {});
      }
      this.standbyMode = false;
      await this.ensureDaemonRunning();
      await this.primeAllLedgers();
      await this.refreshAllMeta({ background: false }).catch(() => {});
      this.startPolling();
      return true;
    })();

    try {
      return await this.wakingPromise;
    } finally {
      this.wakingPromise = null;
    }
  }

  async fetchCcccDaemonApi(pathname, { timeoutMs = 1800 } = {}) {
    if (this.isMockExec || typeof fetch !== 'function') return null;
    try {
      const { host, port } = await this.resolveCcccWebOrigin();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      timer.unref?.();
      const res = await fetch(`http://${host}:${port}${pathname}`, {
        signal: ctrl.signal,
        headers: { Accept: 'application/json' },
      }).finally(() => clearTimeout(timer));
      if (!res.ok) return null;
      const json = await res.json();
      if (json && json.ok === true && json.result !== undefined) {
        return json.result;
      }
      return null;
    } catch {
      return null;
    }
  }

  async queryGroupsSummary() {
    if (!this.isMockExec) {
      const httpRes = await this.fetchCcccDaemonApi('/api/v1/groups');
      if (httpRes && Array.isArray(httpRes.groups)) return httpRes;
    }
    return this.execJsonFn(['groups']);
  }

  async queryGroupShow(groupId) {
    if (!this.isMockExec) {
      const httpRes = await this.fetchCcccDaemonApi(
        `/api/v1/groups/${encodeURIComponent(groupId)}`
      );
      if (httpRes && httpRes.group) return httpRes;
    }
    return this.execJsonFn(['group', 'show', groupId]);
  }

  async queryGroupActors(groupId) {
    if (!this.isMockExec) {
      const httpRes = await this.fetchCcccDaemonApi(
        `/api/v1/groups/${encodeURIComponent(groupId)}/actors`
      );
      if (httpRes && Array.isArray(httpRes.actors)) return httpRes;
    }
    return this.execJsonFn(['actor', 'list', '--group', groupId]);
  }

  async refreshAllMeta({ background = false } = {}) {
    const [daemon, groups] = await Promise.all([
      this.getDaemonStatus(),
      this.listGroups({ force: !background, background }),
    ]);
    this.cachedDaemonStatus = daemon;
    return { daemon, groups };
  }

  async getFastBootstrap({ force = false } = {}) {
    if (force || !this.groupMetaCache.data) {
      return this.refreshAllMeta();
    }
    return {
      daemon: this.cachedDaemonStatus,
      groups: this.groupMetaCache.data,
    };
  }

  async ensureFileHelperSeed() {
    if (fs.existsSync(this.fileHelperPath)) return;
    const initial = [
      {
        id: 'fh-welcome',
        ts: new Date().toISOString(),
        by: 'system-helper',
        senderTitle: '文件传输助手',
        senderRole: 'helper',
        to: ['user'],
        mode: 'send',
        text: '欢迎使用你专属的 AChat (AgentChat) 客户端！\n• 这里是本地「文件传输助手」，可在电脑与手机端之间随手互发笔记、代码片段或文件路径。\n• 点击左侧群聊（或新建项目群聊）即可直接用 `@codex`、`@antigravity` 指挥多 Agent 协作，并实时看到它们互相讨论的完整气泡。',
      },
    ];
    await fsp.mkdir(this.dataDir, { recursive: true });
    await fsp.writeFile(this.fileHelperPath, JSON.stringify(initial, null, 2), 'utf8');
  }

  async getDaemonStatus() {
    if (!this.isMockExec) {
      const ping = await this.fetchCcccDaemonApi('/api/v1/ping', { timeoutMs: 1500 });
      if (ping) {
        return { running: true, raw: 'Daemon: running (http)' };
      }
    }
    try {
      const { stdout } = await this.execFn(['status'], { timeout: 6000 });
      const running = /Daemon:\s+running/i.test(stdout);
      return { running, raw: stdout };
    } catch (err) {
      return { running: false, error: err.message };
    }
  }

  async ensureDaemonRunning() {
    if (this.isMockExec) return true;
    if (this.ensuringPromise) return this.ensuringPromise;
    this.ensuringPromise = (async () => {
      const status = await this.getDaemonStatus();
      if (status.running) {
        if (!this.mcpConfigRepinned) {
          this.mcpConfigRepinned = true;
          await repinMcpConfig();
        }
        return true;
      }
      const child = spawn(CCCC_BIN, ['web', '--host', '127.0.0.1', '--port', '8848'], {
        cwd: fs.existsSync(DEFAULT_ROOM_DIR) ? DEFAULT_ROOM_DIR : process.cwd(),
        env: buildExtendedEnv(),
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      this.ccccWebPid = child.pid || null;
      child.unref();

      for (let attempt = 0; attempt < 16; attempt += 1) {
        await new Promise((r) => setTimeout(r, 500));
        const next = await this.getDaemonStatus();
        if (next.running) {
          this.mcpConfigRepinned = true;
          await repinMcpConfig();
          return true;
        }
      }
      return false;
    })();

    try {
      return await this.ensuringPromise;
    } finally {
      this.ensuringPromise = null;
    }
  }

  parseLedgerEventToMessage(ev) {
    if (!ev || typeof ev !== 'object') return null;
    if (ev.kind === 'chat.message') {
      const data = ev.data || {};
      const by = ev.by || data.actor_id || 'unknown';
      const isUser = by === 'user';
      const rawText = String(data.text || '');

      if (rawText.startsWith('<!--aw-retry-->')) {
        return null;
      }

      const relayHeader = rawText.match(/^<!--aw-relay-handoff:([^>]+)-->/);
      if (relayHeader) {
        return {
          id: ev.id,
          ts: ev.ts,
          kind: 'system',
          text: `🔁 主从接力：已自动将 ${relayHeader[1]} 复核`,
        };
      }

      const hasSharedContext = rawText.includes('<!--aw-ctx:start-->');
      const stripped = stripSharedContextBlock(rawText);
      const { cleanText, attachments } = parseMessageAttachments(stripped, this.uploadsDir);
      return {
        id: ev.id,
        ts: ev.ts,
        kind: 'chat',
        by,
        isUser,
        senderTitle: isUser ? '我' : (data.sender_title || by),
        senderRuntime: data.sender_runtime || (isUser ? 'user' : by),
        to: Array.isArray(data.to) ? data.to : [],
        mode: data.message_mode || 'send',
        insight: data.insight || '',
        hasSharedContext,
        attachments,
        text: cleanText,
      };
    }
    if (ev.kind === 'group.attach') {
      const url = cleanScopeUrl(ev.data?.url || ev.data?.path || '');
      if (!url) return null;
      return {
        id: ev.id,
        ts: ev.ts,
        kind: 'system',
        text: `已绑定工作目录：${url}`,
      };
    }
    return null;
  }

  computeThinkingActorIds(
    groupId,
    latestActivity = {},
    pendingSince = {},
    pendingMessageMeta = {},
    nowMs = Date.now(),
    lastReplyAt = {}
  ) {
    const liveMap = this.liveActorStates.get(groupId);
    const candidateActors = new Set([
      ...Object.keys(latestActivity),
      ...Object.keys(pendingSince),
      ...(liveMap ? Array.from(liveMap.keys()) : []),
    ]);

    const thinkingActorIds = [];
    for (const actorId of candidateActors) {
      const live = liveMap?.get(actorId);
      const act = latestActivity[actorId];
      const isRunning = live ? live.running : act ? act.running !== false : true;
      if (!isRunning) continue;

      const metaId = pendingMessageMeta?.[actorId]?.id || '';
      const isCancelled =
        metaId && this.cancelledPendingIds.has(`${groupId}:${actorId}:${metaId}`);

      const stateSource = live?.stateSource || '';
      const workingState = isCancelled ? 'idle' : live?.workingState || act?.workingState || 'idle';
      const hasActiveTask = isCancelled ? false : Boolean(live?.activeTaskId);
      const pendingTs = isCancelled ? null : pendingSince[actorId];
      const pendingAgeMs = pendingTs ? nowMs - new Date(pendingTs).getTime() : Infinity;
      const isRetrying = this.retryingActors.has(`${groupId}:${actorId}`);

      if (stateSource === 'managed_session') {
        const isStartingOrRetrying = isRetrying || (pendingAgeMs >= 0 && pendingAgeMs < 18_000);
        const hasUnansweredPending = Boolean(pendingTs) && pendingAgeMs >= 0;
        const workingUpdatedMs = live?.workingUpdatedAt
          ? new Date(live.workingUpdatedAt).getTime()
          : NaN;
        const lastReplyMs = lastReplyAt?.[actorId]
          ? new Date(lastReplyAt[actorId]).getTime()
          : 0;
        // Guard against stale cccc managed_session 'working' flags after a turn already replied
        const freshAutonomousWork =
          !hasUnansweredPending &&
          (workingState === 'working' || hasActiveTask) &&
          Number.isFinite(workingUpdatedMs) &&
          workingUpdatedMs > lastReplyMs &&
          nowMs - workingUpdatedMs >= 0 &&
          nowMs - workingUpdatedMs < 25_000;

        if (
          isStartingOrRetrying ||
          (hasUnansweredPending && (workingState === 'working' || hasActiveTask)) ||
          freshAutonomousWork
        ) {
          thinkingActorIds.push(actorId);
        }
      } else {
        const pendingRecent = pendingAgeMs >= 0 && pendingAgeMs < 90_000;
        const hasUnansweredPending = Boolean(pendingTs) && pendingAgeMs >= 0;
        const pendingMs = pendingTs ? new Date(pendingTs).getTime() : NaN;
        const rawOutputIso = live?.lastOutputAt || act?.lastOutputAt || '';
        const lastOutputMs = rawOutputIso ? new Date(rawOutputIso).getTime() : NaN;
        const hasLivePtyQuiet =
          live?.ptyQuietSeconds !== undefined &&
          live?.ptyQuietSeconds !== null &&
          Number.isFinite(Number(live.ptyQuietSeconds));
        const ptyActivelyStreaming = hasLivePtyQuiet
          ? Number(live.ptyQuietSeconds) < 25
          : Number.isFinite(lastOutputMs) &&
            Number.isFinite(pendingMs) &&
            lastOutputMs >= pendingMs &&
            nowMs - lastOutputMs >= 0 &&
            nowMs - lastOutputMs < 25_000;
        if (
          isRetrying ||
          pendingRecent ||
          (hasUnansweredPending && (workingState === 'working' || ptyActivelyStreaming)) ||
          (!live && workingState === 'working')
        ) {
          thinkingActorIds.push(actorId);
        }
      }
    }
    const extThinkingMap = this.externalThinkingActors.get(groupId);
    if (extThinkingMap && extThinkingMap.size > 0) {
      for (const actorId of extThinkingMap.keys()) {
        if (!thinkingActorIds.includes(actorId)) {
          thinkingActorIds.push(actorId);
        }
      }
    }
    thinkingActorIds.sort();
    return thinkingActorIds;
  }

  async resolveCodexRolloutPath(groupId, actorId = 'codex') {
    try {
      const sessionFile = path.join(
        this.groupsDir,
        groupId,
        'state',
        'runtime_sessions',
        `${actorId}.json`
      );
      if (!fs.existsSync(sessionFile)) return null;
      const parsed = JSON.parse(await fsp.readFile(sessionFile, 'utf8'));
      const threadId = String(
        parsed?.provider_thread_id || parsed?.provider_session_id || ''
      ).trim();
      if (!threadId) return null;

      const cached = this.rolloutPathCache.get(threadId);
      if (cached && fs.existsSync(cached)) return cached;

      const sessionsRoot = this.codexSessionsRoot || path.join(os.homedir(), '.codex', 'sessions');
      if (!fs.existsSync(sessionsRoot)) return null;

      const descNames = async (dir) => {
        const entries = await fsp.readdir(dir, { withFileTypes: true });
        return entries
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
          .sort((a, b) => b.localeCompare(a));
      };

      for (const yr of (await descNames(sessionsRoot)).slice(0, 2)) {
        const yrDir = path.join(sessionsRoot, yr);
        for (const mo of (await descNames(yrDir)).slice(0, 3)) {
          const moDir = path.join(yrDir, mo);
          for (const dy of (await descNames(moDir)).slice(0, 7)) {
            const dyDir = path.join(moDir, dy);
            const files = await fsp.readdir(dyDir);
            const hit = files.find((f) => f.endsWith('.jsonl') && f.includes(threadId));
            if (hit) {
              const full = path.join(dyDir, hit);
              this.rolloutPathCache.set(threadId, full);
              return full;
            }
          }
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  applyLedgerLines(lines, state) {
    for (const line of lines) {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.kind === 'actor.activity' && Array.isArray(ev.data?.actors)) {
        for (const a of ev.data.actors) {
          state.latestActivity[a.id] = {
            workingState: a.effective_working_state || 'idle',
            running: Boolean(a.running),
            lastOutputAt: a.pty_last_output_at || null,
          };
        }
      }
      if (ev.kind === 'chat.message') {
        const rawMsgText = String(ev.data?.text || '');
        const isRetryNudge = rawMsgText.startsWith('<!--aw-retry-->');
        const recipients = Array.isArray(ev.data?.to) ? ev.data.to : [];
        const msgMode = String(ev.data?.message_mode || 'send').toLowerCase();
        const expectsReply =
          ev.by === 'user' || msgMode === 'request-reply' || msgMode === 'request_reply';
        if (expectsReply) {
          for (const r of recipients) {
            if (r && r !== 'user' && r !== ev.by) {
              state.pendingSince[r] = ev.ts;
              if (!isRetryNudge) {
                state.pendingMessageMeta[r] = {
                  id: ev.id,
                  ts: ev.ts,
                  by: ev.by || 'user',
                  text: stripSharedContextBlock(rawMsgText),
                };
              }
            }
          }
        }
        if (ev.by && ev.by !== 'user') {
          state.lastReplyAt[ev.by] = ev.ts;
          delete state.pendingSince[ev.by];
          delete state.pendingMessageMeta[ev.by];
        }
      }

      const msg = this.parseLedgerEventToMessage(ev);
      if (msg) state.messages.push(msg);
      state.rawCount += 1;
    }
  }

  async readGroupLedger(groupId, { seedOnly = false } = {}) {
    const ledgerPath = path.join(this.groupsDir, groupId, 'ledger.jsonl');
    const extPath = path.join(this.externalDispatchesDir, `${groupId}.jsonl`);
    const hasLedger = fs.existsSync(ledgerPath);
    const hasExt = fs.existsSync(extPath);
    if (!hasLedger && !hasExt) {
      return {
        messages: [],
        latestActivity: {},
        pendingSince: {},
        pendingMessageMeta: {},
        thinkingActorIds: this.computeThinkingActorIds(groupId, {}, {}, {}, Date.now(), {}),
        rawCount: 0,
        newMessages: [],
      };
    }

    const stat = hasLedger ? await fsp.stat(ledgerPath) : { size: 0, mtimeMs: 0 };
    const extStat = hasExt ? await fsp.stat(extPath) : { size: 0, mtimeMs: 0 };
    const cached = this.ledgerCache.get(groupId);
    if (
      cached &&
      cached.size === stat.size &&
      cached.mtimeMs === stat.mtimeMs &&
      cached.extSize === extStat.size &&
      cached.extMtimeMs === extStat.mtimeMs &&
      cached.cardRev === this.cardSettlementsRev &&
      cached.prefsRev === this.groupPrefsRev &&
      this.seededGroups.has(groupId)
    ) {
      const freshThinking = this.computeThinkingActorIds(
        groupId,
        cached.latestActivity,
        cached.pendingSince,
        cached.pendingMessageMeta,
        Date.now(),
        cached.lastReplyAt || {}
      );
      const nextThinkingKey = freshThinking.join(',');
      if (!seedOnly && this.lastThinkingKey.get(groupId) !== nextThinkingKey) {
        this.lastThinkingKey.set(groupId, nextThinkingKey);
        this.groupMetaCache.ts = 0;
        this.emit('activity', { groupId, thinkingActorIds: freshThinking });
      }
      cached.thinkingActorIds = freshThinking;
      return { ...cached, newMessages: [] };
    }

    // 1. Resolve main ledger.jsonl independently so external session appends NEVER re-parse unchanged ledger.jsonl
    let baseData = this.ledgerBaseCache.get(groupId);
    if (!hasLedger || stat.size === 0) {
      baseData = {
        size: 0,
        mtimeMs: stat.mtimeMs,
        headBuf: null,
        endsWithNewline: true,
        messages: [],
        latestActivity: {},
        pendingSince: {},
        pendingMessageMeta: {},
        lastReplyAt: {},
        rawCount: 0,
      };
      this.ledgerBaseCache.set(groupId, baseData);
    } else if (!baseData || baseData.size !== stat.size || baseData.mtimeMs !== stat.mtimeMs) {
      this.ledgerParseStats.set(groupId, (this.ledgerParseStats.get(groupId) || 0) + 1);
      let usedIncremental = false;

      if (
        baseData &&
        baseData.size > 0 &&
        stat.size > baseData.size &&
        baseData.endsWithNewline &&
        baseData.headBuf
      ) {
        let fh = null;
        try {
          fh = await fsp.open(ledgerPath, 'r');
          const checkLen = baseData.headBuf.length;
          const curHead = Buffer.alloc(checkLen);
          const { bytesRead: headRead } = await fh.read(curHead, 0, checkLen, 0);
          if (headRead === checkLen && Buffer.compare(curHead, baseData.headBuf) === 0) {
            const deltaLen = stat.size - baseData.size;
            const deltaBuf = Buffer.alloc(deltaLen);
            const { bytesRead } = await fh.read(deltaBuf, 0, deltaLen, baseData.size);
            const sliceBuf = deltaBuf.subarray(0, bytesRead);
            const endsWithNl = sliceBuf.length > 0 && sliceBuf[sliceBuf.length - 1] === 0x0a;
            const nextState = {
              size: stat.size,
              mtimeMs: stat.mtimeMs,
              headBuf: baseData.headBuf,
              endsWithNewline: endsWithNl,
              messages: [...baseData.messages],
              latestActivity: { ...baseData.latestActivity },
              pendingSince: { ...baseData.pendingSince },
              pendingMessageMeta: { ...baseData.pendingMessageMeta },
              lastReplyAt: { ...baseData.lastReplyAt },
              rawCount: baseData.rawCount,
            };
            const deltaLines = sliceBuf.toString('utf8').split(/\r?\n/).filter(Boolean);
            this.applyLedgerLines(deltaLines, nextState);
            baseData = nextState;
            this.ledgerBaseCache.set(groupId, baseData);
            usedIncremental = true;
          }
        } catch {
          usedIncremental = false;
        } finally {
          await fh?.close().catch(() => {});
        }
      }

      if (!usedIncremental) {
        const rawBuf = await fsp.readFile(ledgerPath);
        const headLen = Math.min(64, rawBuf.length);
        const headBuf = headLen > 0 ? Buffer.from(rawBuf.subarray(0, headLen)) : null;
        const endsWithNl = rawBuf.length > 0 && rawBuf[rawBuf.length - 1] === 0x0a;
        const nextState = {
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          headBuf,
          endsWithNewline: endsWithNl,
          messages: [],
          latestActivity: {},
          pendingSince: {},
          pendingMessageMeta: {},
          lastReplyAt: {},
          rawCount: 0,
        };
        const lines = rawBuf.toString('utf8').split(/\r?\n/).filter(Boolean);
        this.applyLedgerLines(lines, nextState);
        baseData = nextState;
        this.ledgerBaseCache.set(groupId, baseData);
      }
    }

    // 2. Resolve external-dispatches/<groupId>.jsonl independently
    let extEntry = this.extDispatchCache.get(groupId);
    if (!hasExt || extStat.size === 0) {
      extEntry = { size: 0, mtimeMs: extStat.mtimeMs, messages: [] };
      this.extDispatchCache.set(groupId, extEntry);
    } else if (!extEntry || extEntry.size !== extStat.size || extEntry.mtimeMs !== extStat.mtimeMs) {
      const parsedExt = [];
      try {
        const extContent = await fsp.readFile(extPath, 'utf8');
        for (const extLine of extContent.split(/\r?\n/)) {
          if (!extLine.trim()) continue;
          try {
            const extMsg = JSON.parse(extLine);
            if (extMsg && extMsg.id) {
              parsedExt.push(extMsg);
            }
          } catch {
            // skip malformed external line
          }
        }
      } catch {
        // ignore transient read error
      }
      extEntry = { size: extStat.size, mtimeMs: extStat.mtimeMs, messages: parsedExt };
      this.extDispatchCache.set(groupId, extEntry);
    }

    let messages = baseData.messages;
    if (extEntry.messages.length > 0) {
      if (baseData.messages.length === 0) {
        messages = extEntry.messages;
      } else {
        messages = [...baseData.messages, ...extEntry.messages].sort((a, b) => {
          const ta = a.ts ? new Date(a.ts).getTime() : 0;
          const tb = b.ts ? new Date(b.ts).getTime() : 0;
          return ta - tb;
        });
      }
    }
    messages = messages.map((m) => this.decorateMessageWithCard(groupId, m));

    const { latestActivity, pendingSince, pendingMessageMeta, lastReplyAt, rawCount } = baseData;

    const thinkingActorIds = this.computeThinkingActorIds(
      groupId,
      latestActivity,
      pendingSince,
      pendingMessageMeta,
      Date.now(),
      lastReplyAt
    );

    let newMessages = [];
    if (!this.seededGroups.has(groupId)) {
      this.emittedMessageIds.set(groupId, new Set(messages.map((m) => m.id)));
      this.seededGroups.add(groupId);
      this.lastThinkingKey.set(groupId, thinkingActorIds.join(','));
      if (!seedOnly) {
        this.ensureGroupWatcher(groupId);
      }
    } else {
      const seen = this.emittedMessageIds.get(groupId) || new Set();
      this.emittedMessageIds.set(groupId, seen);
      for (const m of messages) {
        if (!seen.has(m.id)) {
          seen.add(m.id);
          newMessages.push(m);
          if (!seedOnly) {
            this.groupMetaCache.ts = 0;
            this.emit('message', { groupId, message: m });
            this.handleRelayProgressOnMessage(groupId, m);
          }
        }
      }
      const nextThinkingKey = thinkingActorIds.join(',');
      if (!seedOnly && this.lastThinkingKey.get(groupId) !== nextThinkingKey) {
        this.lastThinkingKey.set(groupId, nextThinkingKey);
        this.groupMetaCache.ts = 0;
        this.emit('activity', { groupId, thinkingActorIds });
      }
    }

    const nextEntry = {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      extSize: extStat.size,
      extMtimeMs: extStat.mtimeMs,
      cardRev: this.cardSettlementsRev,
      prefsRev: this.groupPrefsRev,
      messages,
      latestActivity,
      pendingSince,
      pendingMessageMeta,
      lastReplyAt,
      thinkingActorIds,
      rawCount,
    };
    this.ledgerCache.set(groupId, nextEntry);
    return { ...nextEntry, newMessages };
  }

  ensureGroupWatcher(groupId) {
    if (this.groupWatchers.has(groupId)) return;
    const groupFolder = path.join(this.groupsDir, groupId);
    if (!fs.existsSync(groupFolder)) return;
    try {
      const entry = { watcher: null, debounceTimer: null };
      entry.watcher = fs.watch(groupFolder, (_eventType, filename) => {
        if (filename && filename !== 'ledger.jsonl') return;
        clearTimeout(entry.debounceTimer);
        entry.debounceTimer = setTimeout(() => {
          this.readGroupLedger(groupId).catch(() => {});
        }, 25);
      });
      entry.watcher.on('error', () => {});
      this.groupWatchers.set(groupId, entry);
    } catch {
      // Fallback interval still covers all updates
    }
  }

  ensureExternalDispatchesWatcher() {
    if (this.extWatcher) return;
    try {
      fs.mkdirSync(this.externalDispatchesDir, { recursive: true });
      this.extWatcher = fs.watch(this.externalDispatchesDir, (_eventType, filename) => {
        if (!filename || !filename.endsWith('.jsonl')) return;
        const gid = filename.slice(0, -'.jsonl'.length);
        if (!gid) return;
        clearTimeout(this.extWatchDebounce);
        this.extWatchDebounce = setTimeout(() => {
          this.readGroupLedger(gid).catch(() => {});
        }, 25);
      });
      this.extWatcher.on('error', () => {});
    } catch {
      // Fallback interval still covers external dispatches
    }
  }

  async primeAllLedgers() {
    try {
      if (!fs.existsSync(this.groupsDir)) return;
      const dirs = await fsp.readdir(this.groupsDir, { withFileTypes: true });
      for (const d of dirs) {
        if (d.isDirectory()) {
          await this.readGroupLedger(d.name, { seedOnly: true });
        }
      }
    } catch {
      // ignore
    }
  }

  startPolling() {
    if (this.pollTimer) return;
    this.ensureExternalDispatchesWatcher();
    try {
      if (fs.existsSync(this.groupsDir)) {
        for (const d of fs.readdirSync(this.groupsDir, { withFileTypes: true })) {
          if (d.isDirectory()) this.ensureGroupWatcher(d.name);
        }
        this.rootWatcher = fs.watch(this.groupsDir, () => {
          try {
            for (const d of fs.readdirSync(this.groupsDir, { withFileTypes: true })) {
              if (d.isDirectory()) this.ensureGroupWatcher(d.name);
            }
          } catch {
            // ignore
          }
        });
        this.rootWatcher.on('error', () => {});
      }
    } catch {
      // ignore
    }

    // Event-driven fs.watch handles sub-30ms updates; fallback sweep runs gently every 2000ms
    this.pollTimer = setInterval(async () => {
      try {
        if (!fs.existsSync(this.groupsDir)) return;
        const dirs = await fsp.readdir(this.groupsDir, { withFileTypes: true });
        for (const d of dirs) {
          if (!d.isDirectory()) continue;
          this.ensureGroupWatcher(d.name);
          await this.readGroupLedger(d.name);
        }
      } catch {
        // ignore transient read contention
      }
    }, 2000);

    if (!this.metaRefreshTimer) {
      this.metaRefreshTimer = setInterval(() => {
        this.refreshAllMeta({ background: true }).catch(() => {});
      }, 6000);
    }
  }

  handleRelayProgressOnMessage(groupId, m) {
    if (!m || m.kind !== 'chat' || m.isUser) return;

    const pending = this.pendingRelays.get(groupId);
    if (pending && m.by === pending.leadId && !pending.baselineIds.has(m.id)) {
      this.pendingRelays.delete(groupId);
      this.activeRelayReviewers.set(groupId, {
        reviewerId: pending.reviewerId,
        reviewerTitle: pending.reviewerTitle,
      });

      this.emit('relay', {
        groupId,
        active: true,
        step: 2,
        leadTitle: pending.leadTitle,
        reviewerTitle: pending.reviewerTitle,
        text: `🔁 接力 2/2：已收到 ${pending.leadTitle} 初稿，正自动转交 ${pending.reviewerTitle} 复核补充…`,
      });

      const draftExcerpt = String(m.text || '').trim().slice(0, 2600);
      const attachmentBlock = (pending.rawAttachmentRefs || []).join('\n');
      const relayReplyStyle = normalizeReplyStyle(
        pending.replyStyle || this.groupPrefs[groupId]?.replyStyle
      );
      const stage2Payload = [
        `<!--aw-relay-handoff:${pending.leadTitle} → ${pending.reviewerTitle}-->`,
        `[主从自动接力 2/2 · 请复核并补充同伴初稿]`,
        `用户原始需求：`,
        pending.userPrompt || '(见附件)',
        attachmentBlock ? `\n附带文件/图片：\n${attachmentBlock}` : '',
        `\n${pending.leadTitle} (@${pending.leadId}) 的初稿回复：`,
        draftExcerpt || '(空)',
        `\n请直接向用户给出你的二阶段复核意见：确认准确部分（简短带过，勿整段重复初稿），重点指出遗漏、边界风险或更优方案补充。`,
        buildReplyStyleDirective(relayReplyStyle),
        attachmentBlock.includes('[图片:')
          ? `[图片附件提示：如需核对原图细节，可直接用内置读图工具读取上述本地图片路径]`
          : '',
        `[极速回复约定：请直接调用 cccc_message_reply(event_id=<本消息event_id>, to=["user"], mode="send", text="...") 单步回复用户，无需再转交同伴]`,
      ]
        .filter(Boolean)
        .join('\n');

      Promise.resolve()
        .then(async () => {
          const args = [
            'send',
            '--group',
            groupId,
            '--by',
            'user',
            '--to',
            pending.reviewerId,
            '--mode',
            'send',
            '--',
            stage2Payload,
          ];
          try {
            await this.execFn(args, { timeout: 15000 });
          } catch {
            await this.ensureDaemonRunning();
            await this.execFn(args, { timeout: 15000 });
          }
          this.groupMetaCache.ts = 0;
          await this.readGroupLedger(groupId);
        })
        .catch((err) => {
          this.activeRelayReviewers.delete(groupId);
          this.emit('relay', {
            groupId,
            active: false,
            step: 0,
            error: err.message || '自动接力转交失败',
            text: '',
          });
        });
      return;
    }

    const activeRev = this.activeRelayReviewers.get(groupId);
    if (activeRev && m.by === activeRev.reviewerId) {
      this.activeRelayReviewers.delete(groupId);
      this.emit('relay', { groupId, active: false, step: 0, text: '' });
    }
  }

  async getFileHelperMessages() {
    try {
      const raw = await fsp.readFile(this.fileHelperPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.map((item) => {
        if (Array.isArray(item.attachments)) return item;
        const { cleanText, attachments } = parseMessageAttachments(
          item.rawText || item.text || '',
          this.uploadsDir
        );
        return { ...item, text: cleanText, attachments };
      });
    } catch {
      return [];
    }
  }

  async appendFileHelperMessage(text) {
    const list = await this.getFileHelperMessages();
    const rawText = String(text || '').trim();
    const { cleanText, attachments } = parseMessageAttachments(rawText, this.uploadsDir);
    const msg = {
      id: `fh-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      ts: new Date().toISOString(),
      kind: 'chat',
      by: 'user',
      isUser: true,
      senderTitle: '我',
      senderRuntime: 'user',
      to: ['file-helper'],
      mode: 'send',
      insight: '',
      rawText,
      attachments,
      text: cleanText,
    };
    list.push(msg);
    await fsp.writeFile(this.fileHelperPath, JSON.stringify(list, null, 2), 'utf8');
    this.emit('message', { groupId: 'file-helper', message: msg });
    return msg;
  }

  async waitForActorComposerReady(
    groupId,
    actorId,
    { maxWaitMs = 18000, minQuietSec = 2 } = {}
  ) {
    if (this.isMockExec && this.composerMinWaitMs === null) return;
    const initialWait = this.composerMinWaitMs ?? (actorId === 'codex' ? 8000 : 4500);
    const pollInterval = this.composerPollIntervalMs ?? 650;
    const postQuietSettle = this.composerMinWaitMs !== null ? 10 : 450;
    const deadline = Date.now() + maxWaitMs;
    await new Promise((r) => setTimeout(r, initialWait));
    while (Date.now() < deadline) {
      try {
        const res = await this.queryGroupActors(groupId);
        const found = (res?.actors || []).find((x) => x.id === actorId);
        const quietOk =
          found?.pty_quiet_seconds === undefined ||
          found?.pty_quiet_seconds === null ||
          Number(found.pty_quiet_seconds) >= minQuietSec;
        if (found?.running && (found.effective_working_state || 'idle') === 'idle' && quietOk) {
          await new Promise((r) => setTimeout(r, postQuietSettle));
          return;
        }
      } catch {
        // retry until deadline
      }
      await new Promise((r) => setTimeout(r, pollInterval));
    }
  }

  async unlinkBrokenRuntimeSession(groupId, actorId, { force = false } = {}) {
    const sessionFile = path.join(
      this.groupsDir,
      groupId,
      'state',
      'runtime_sessions',
      `${actorId}.json`
    );
    if (!fs.existsSync(sessionFile)) return false;
    let shouldUnlink = Boolean(force);
    if (!shouldUnlink) {
      try {
        const parsed = JSON.parse(await fsp.readFile(sessionFile, 'utf8'));
        if (parsed?.status === 'resume_failed') {
          shouldUnlink = true;
        }
      } catch {
        shouldUnlink = true;
      }
    }
    if (shouldUnlink) {
      await fsp.unlink(sessionFile).catch(() => {});
      return true;
    }
    return false;
  }

  async resolveCcccWebOrigin() {
    const now = Date.now();
    if (this.cachedWebOrigin && now - this.cachedWebOrigin.ts < 15_000) {
      return { host: this.cachedWebOrigin.host, port: this.cachedWebOrigin.port };
    }
    try {
      const runtimeJson = path.join(CCCC_HOME, 'daemon', 'web_runtime.json');
      if (fs.existsSync(runtimeJson)) {
        const parsed = JSON.parse(await fsp.readFile(runtimeJson, 'utf8'));
        const host = String(parsed?.host || '127.0.0.1').trim() || '127.0.0.1';
        const port = Number(parsed?.port) || 8848;
        this.cachedWebOrigin = { ts: now, host, port };
        return { host, port };
      }
    } catch {
      // fallback to default cccc web port
    }
    this.cachedWebOrigin = { ts: now, host: '127.0.0.1', port: 8848 };
    return { host: '127.0.0.1', port: 8848 };
  }

  async sendPtyEnterKeystroke(groupId, actorId = 'codex') {
    if (this.isMockExec && !this.hasCustomPtyEnterNudge) return false;
    if (typeof WebSocket !== 'function') return false;
    const { host, port } = await this.resolveCcccWebOrigin();
    const httpOrigin = `http://${host}:${port}`;

    // Verify terminal tail actually holds an unsubmitted paste / cccc prompt before pressing Enter
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2000);
      const tailRes = await fetch(
        `${httpOrigin}/api/v1/groups/${encodeURIComponent(groupId)}/terminal/tail?actor_id=${encodeURIComponent(actorId)}&max_chars=4500`,
        { signal: ctrl.signal }
      ).finally(() => clearTimeout(timer));
      if (tailRes.ok) {
        const tailJson = await tailRes.json();
        const tailText = String(tailJson?.result?.text || '');
        if (
          tailText &&
          !tailText.includes('[Pasted Content') &&
          !tailText.includes('event_id=') &&
          !tailText.includes('[cccc]') &&
          !tailText.includes('<!--aw-retry-->')
        ) {
          return false;
        }
      }
    } catch {
      // Proceed to WebSocket control nudge if tail check fails transiently
    }

    const wsUrl = `ws://${host}:${port}/api/v1/groups/${encodeURIComponent(groupId)}/actors/${encodeURIComponent(actorId)}/term?mode=control&takeover=true`;
    return new Promise((resolve) => {
      let settled = false;
      let sent = false;
      let ws = null;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(guardTimer);
        try {
          if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
            ws.close();
          }
        } catch {
          // ignore close error
        }
        resolve(ok);
      };
      const guardTimer = setTimeout(() => finish(sent), 3500);
      guardTimer.unref?.();
      try {
        ws = new WebSocket(wsUrl, { headers: { Origin: httpOrigin } });
        ws.binaryType = 'arraybuffer';
        ws.onmessage = (ev) => {
          if (sent || settled) return;
          let attached = false;
          if (ev.data instanceof ArrayBuffer) {
            const u8 = new Uint8Array(ev.data);
            if (u8[0] === 51 || u8[0] === 54) attached = true;
          } else if (typeof ev.data === 'string' && ev.data.includes('terminal.attach')) {
            attached = true;
          }
          if (attached) {
            sent = true;
            setTimeout(() => {
              try {
                // Binary frame 48 ('0') = PTY stdin input, 13 = '\r' (Enter)
                ws.send(new Uint8Array([48, 13]));
              } catch {
                finish(false);
                return;
              }
              setTimeout(() => finish(true), 260);
            }, 200);
          }
        };
        ws.onerror = () => finish(false);
        ws.onclose = () => finish(sent);
      } catch {
        finish(false);
      }
    });
  }

  async healActorBinaryOrDroppedTurn(
    groupId,
    actor,
    pendingMeta = null,
    { wipeSession = false, tracker = null } = {}
  ) {
    const actorKey = `${groupId}:${actor.id}`;
    if (this.retryingActors.has(actorKey)) return;
    this.retryingActors.add(actorKey);
    try {
      const runtime = String(actor.runtime || actor.id || '').toLowerCase();
      if (actor.id === 'codex' || runtime.includes('codex')) {
        const cmdArr = Array.isArray(actor.command) ? actor.command : [];
        if (cmdArr[0] && cmdArr[0] !== 'codex' && !fs.existsSync(cmdArr[0])) {
          const codexBin = await resolveCodexBinary();
          const sandbox = detectReadOnly(cmdArr) ? 'read-only' : 'workspace-write';
          const gear = detectActorSpeedGear(cmdArr);
          const newCmd = buildCodexLaunchCommand(codexBin, { sandbox, gear });
          await this.execFn(
            ['actor', 'update', '--group', groupId, '--command', newCmd, actor.id],
            { timeout: 15000 }
          ).catch(() => {});
        }
      }

      await this.unlinkBrokenRuntimeSession(groupId, actor.id, { force: Boolean(wipeSession) });

      if (!actor.running && !pendingMeta?.id) {
        return;
      }

      const action = actor.running ? 'restart' : 'start';
      await this.execFn(['actor', action, '--group', groupId, actor.id], { timeout: 25000 });

      if (pendingMeta?.id) {
        await this.waitForActorComposerReady(groupId, actor.id);
        const excerpt = String(pendingMeta.text || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 220);
        const fromPeer = pendingMeta.by && pendingMeta.by !== 'user' ? pendingMeta.by : '';
        const replyTargetsHint = fromPeer ? `["${fromPeer}", "user"]` : `["user"]`;
        const senderDesc = fromPeer ? `同伴 @${fromPeer} 发来的协作待办` : '用户刚才发送的待办消息';
        const retryText = `<!--aw-retry--> 请立即处理并回复${senderDesc} (event_id=${pendingMeta.id})：${excerpt} —— 【系统明确授权与强制要求】：群聊界面不显示终端直接输出，完成后必须调用 MCP 工具 cccc_message_reply(event_id="${pendingMeta.id}", to=${replyTargetsHint}, mode="send", text="...") 将最终回复发回群里。`;
        const sendRes = await this.execFn(
          [
            'send',
            '--group',
            groupId,
            '--by',
            'user',
            '--to',
            actor.id,
            '--mode',
            'send',
            '--',
            retryText,
          ],
          { timeout: 15000 }
        ).catch(() => null);
        if (tracker && sendRes?.stdout) {
          try {
            const parsedSend = JSON.parse(sendRes.stdout);
            const rId =
              parsedSend?.event_id ||
              parsedSend?.event?.id ||
              parsedSend?.result?.event_id ||
              '';
            if (rId && !tracker.retryEventIds.includes(rId)) {
              tracker.retryEventIds.push(rId);
            }
          } catch {
            // ignore non-json stdout
          }
        }
        // Post-retry Enter guard: if cccc pasted retry into Codex composer without submitting, nudge Enter after 4s
        if (!this.isMockExec && (actor.id === 'codex' || runtime.includes('codex'))) {
          const postRetryTimer = setTimeout(async () => {
            try {
              const postList = await this.queryGroupActors(groupId);
              const postAct = (postList?.actors || []).find((x) => x.id === actor.id);
              if (
                postAct?.running &&
                (postAct.effective_working_state || 'idle') === 'idle' &&
                !postAct.effective_active_task_id
              ) {
                await this.ptyEnterNudgeFn(groupId, actor.id);
              }
            } catch {
              // ignore post-retry check error
            }
          }, 4000);
          postRetryTimer.unref?.();
        }
      }
      this.groupMetaCache.ts = 0;
      await this.readGroupLedger(groupId).catch(() => {});
    } finally {
      this.retryingActors.delete(actorKey);
      if (tracker) {
        tracker.inFlight = false;
        tracker.lastAttemptAt = Date.now();
      }
      this.groupMetaCache.ts = 0;
    }
  }

  async reconcileCodexPendingTurn(groupId, actor, ledger, nowMs = Date.now()) {
    const pendingMeta = ledger?.pendingMessageMeta?.[actor.id];
    if (!pendingMeta?.id) {
      return { activeTurnInRollout: false };
    }
    const retryKey = `${groupId}:${actor.id}:${pendingMeta.id}`;
    if (this.cancelledPendingIds.has(retryKey)) {
      return { activeTurnInRollout: false };
    }

    let tracker = this.pendingTurnRecovery.get(retryKey);
    if (!tracker) {
      tracker = {
        attempts: 0,
        lastAttemptAt: 0,
        enterNudged: false,
        enterNudgeAt: 0,
        inFlight: false,
        retryEventIds: [],
      };
      this.pendingTurnRecovery.set(retryKey, tracker);
    }

    const targetEventIds = [pendingMeta.id, ...tracker.retryEventIds];
    const rolloutPath = await this.resolveCodexRolloutPath(groupId, actor.id);
    const rolloutInfo = rolloutPath
      ? await inspectCodexRolloutForPending(rolloutPath, targetEventIds)
      : null;

    // Case 1: Codex has genuinely started the user's turn in rollout and is still working
    if (rolloutInfo?.matched && !rolloutInfo.completed && !rolloutInfo.aborted) {
      return { activeTurnInRollout: true };
    }

    // Case 2: Codex finished the user's turn in rollout with a non-empty final answer,
    //         yet group ledger still shows the user message as unanswered -> Auto-Harvest!
    if (
      rolloutInfo?.matched &&
      rolloutInfo.completed &&
      !rolloutInfo.aborted &&
      rolloutInfo.finalAnswerText
    ) {
      const graceMs = rolloutInfo.calledCcccSend ? 4500 : 1500;
      const completedAgeMs = rolloutInfo.completedAtMs
        ? nowMs - rolloutInfo.completedAtMs
        : 9999;
      if (completedAgeMs < graceMs) {
        return { activeTurnInRollout: true };
      }

      const harvestId = rolloutInfo.turnId || pendingMeta.id;
      const harvestKey = `${groupId}:${actor.id}:${harvestId}`;
      if (!this.harvestedTurnIds.has(harvestKey) && !this.harvestingKeys.has(harvestKey)) {
        this.harvestingKeys.add(harvestKey);
        try {
          const freshLedger = await this.readGroupLedger(groupId);
          if (freshLedger.pendingMessageMeta?.[actor.id]?.id === pendingMeta.id) {
            const safeKey = String(harvestId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48);
            const idempKey = `aw-harvest-${safeKey || Date.now()}`;
            try {
              await this.execFn(
                [
                  'reply',
                  '--group',
                  groupId,
                  '--by',
                  actor.id,
                  '--to',
                  'user',
                  '--mode',
                  'send',
                  '--idempotency-key',
                  idempKey,
                  '--',
                  pendingMeta.id,
                  rolloutInfo.finalAnswerText,
                ],
                { timeout: 15000 }
              );
            } catch {
              await this.execFn(
                [
                  'send',
                  '--group',
                  groupId,
                  '--by',
                  actor.id,
                  '--to',
                  'user',
                  '--mode',
                  'send',
                  '--',
                  rolloutInfo.finalAnswerText,
                ],
                { timeout: 15000 }
              );
            }
            this.harvestedTurnIds.add(harvestKey);
            this.groupMetaCache.ts = 0;
            await this.readGroupLedger(groupId);
          } else {
            this.harvestedTurnIds.add(harvestKey);
          }
        } catch {
          // Will retry on next refresh cycle if transient CLI failure
        } finally {
          this.harvestingKeys.delete(harvestKey);
        }
      }
      return { activeTurnInRollout: false };
    }

    // Case 3: Turn never reached task_started (e.g. unsubmitted multi-line paste in Codex v0.167+ composer, stale WS 10054, or swallowed during boot)
    if (
      actor.enabled &&
      actor.running &&
      actor.runtime_state_source === 'managed_session' &&
      (actor.effective_working_state || 'idle') === 'idle' &&
      !actor.effective_active_task_id
    ) {
      const ageMs = pendingMeta.ts ? nowMs - new Date(pendingMeta.ts).getTime() : -1;
      const quietOk =
        actor.pty_quiet_seconds === undefined ||
        actor.pty_quiet_seconds === null ||
        Number(actor.pty_quiet_seconds) >= 2;

      // Stage 0: Gentle PTY Enter keystroke nudge first (submits any [Pasted Content ...] sitting in Codex composer WITHOUT restarting!)
      if (
        !tracker.inFlight &&
        !tracker.enterNudged &&
        tracker.attempts === 0 &&
        ageMs >= 6_500 &&
        ageMs < 300_000 &&
        quietOk
      ) {
        tracker.inFlight = true;
        tracker.enterNudged = true;
        tracker.enterNudgeAt = nowMs;
        Promise.resolve(this.ptyEnterNudgeFn(groupId, actor.id))
          .catch(() => false)
          .finally(() => {
            tracker.inFlight = false;
          });
        return { activeTurnInRollout: true };
      }

      const healKey = `${groupId}:${actor.id}`;
      const lastHeal = this.autoHealCooldown.get(healKey) || 0;
      const dueAttempt1 =
        tracker.attempts === 0 &&
        ((tracker.enterNudged && nowMs - tracker.enterNudgeAt >= 20_000) ||
          (!tracker.enterNudged && ageMs >= 26_000));
      const dueAttempt2 = tracker.attempts === 1 && nowMs - tracker.lastAttemptAt >= 32_000;

      if (
        !tracker.inFlight &&
        ageMs >= 14_000 &&
        ageMs < 300_000 &&
        (dueAttempt1 || dueAttempt2) &&
        nowMs - lastHeal > 16_000
      ) {
        tracker.inFlight = true;
        tracker.attempts += 1;
        tracker.lastAttemptAt = nowMs;
        const wipeSession = actor.runtime_session_status === 'resume_failed';
        this.droppedTurnRetried.add(retryKey);
        this.autoHealCooldown.set(healKey, nowMs);
        this.healActorBinaryOrDroppedTurn(groupId, actor, pendingMeta, {
          wipeSession,
          tracker,
        }).catch(() => {});
        return { activeTurnInRollout: true };
      }
    }

    return { activeTurnInRollout: false };
  }

  async listGroups({ force = false, background = false } = {}) {
    if (background && (this.standbyMode || this.enteringStandbyPromise)) {
      return this.groupMetaCache.data || [];
    }
    const now = Date.now();
    if (!force && !background && this.groupMetaCache.data && now - this.groupMetaCache.ts < 2500) {
      return this.groupMetaCache.data;
    }
    if (!force && background && this.listGroupsInFlight) {
      return this.listGroupsInFlight;
    }
    if (this.listGroupsInFlight && force) {
      try {
        await this.listGroupsInFlight;
      } catch {
        // continue with fresh fetch
      }
    }

    const runFetch = async () => {
      await this.ensureDaemonRunning();
      const groupsRes = await this.queryGroupsSummary();
      const rawGroups = Array.isArray(groupsRes?.groups) ? groupsRes.groups : [];

      const detailed = await Promise.all(
        rawGroups.map(async (g) => {
          let showData = null;
          let actorsData = null;
          const cachedShow = this.groupShowCache.get(g.group_id);
          const canReuseShow =
            background &&
            !force &&
            cachedShow &&
            Date.now() - cachedShow.ts < 30_000;

          try {
            if (canReuseShow) {
              showData = cachedShow.showData;
              actorsData = await this.queryGroupActors(g.group_id);
            } else {
              [showData, actorsData] = await Promise.all([
                this.queryGroupShow(g.group_id),
                this.queryGroupActors(g.group_id),
              ]);
              if (showData) {
                this.groupShowCache.set(g.group_id, { ts: Date.now(), showData });
              }
            }
          } catch {
            // fallback to group summary
          }

          const actorsList = Array.isArray(actorsData?.actors)
            ? actorsData.actors
            : (showData?.group?.actors || []);

          const liveStateMap = new Map();
          for (const a of actorsList) {
            liveStateMap.set(a.id, {
              running: Boolean(a.running),
              workingState: a.effective_working_state || 'idle',
              workingUpdatedAt: a.effective_working_updated_at || null,
              activeTaskId: a.effective_active_task_id || null,
              stateSource: a.runtime_state_source || '',
              ptyQuietSeconds: a.pty_quiet_seconds ?? null,
              lastOutputAt: a.pty_last_output_at || null,
            });
          }
          this.liveActorStates.set(g.group_id, liveStateMap);

        let ledger = await this.readGroupLedger(g.group_id);
        let thinkingSet = new Set(ledger.thinkingActorIds || []);
        const nowMs = Date.now();

        if (!this.isMockExec || this.enableWatchdogInTests) {
          for (const a of actorsList) {
            const healKey = `${g.group_id}:${a.id}`;
            const lastHeal = this.autoHealCooldown.get(healKey) || 0;
            const cmdArr = Array.isArray(a.command) ? a.command : [];
            const isCodexActor =
              a.id === 'codex' || String(a.runtime || '').toLowerCase().includes('codex');
            const pendingMeta = ledger.pendingMessageMeta?.[a.id] || null;
            const pendingAgeMs = pendingMeta?.ts ? nowMs - new Date(pendingMeta.ts).getTime() : -1;
            const pendingRetryKey = pendingMeta?.id ? `${g.group_id}:${a.id}:${pendingMeta.id}` : '';
            const hasUnfinishedPendingTurn = Boolean(
              pendingRetryKey &&
                pendingAgeMs >= 0 &&
                pendingAgeMs < 300_000 &&
                !this.cancelledPendingIds.has(pendingRetryKey) &&
                !this.droppedTurnRetried.has(pendingRetryKey)
            );
            const missingBinary =
              a.enabled &&
              isCodexActor &&
              cmdArr[0] &&
              cmdArr[0] !== 'codex' &&
              !fs.existsSync(cmdArr[0]);

            if (missingBinary && nowMs - lastHeal > 30_000) {
              this.autoHealCooldown.set(healKey, nowMs);
              if (!a.running && !hasUnfinishedPendingTurn) {
                const codexBin = await resolveCodexBinary();
                const sandbox = detectReadOnly(cmdArr) ? 'read-only' : 'workspace-write';
                const gear = detectActorSpeedGear(cmdArr);
                const newCmd = buildCodexLaunchCommand(codexBin, { sandbox, gear });
                this.execFn(
                  ['actor', 'update', '--group', g.group_id, '--command', newCmd, a.id],
                  { timeout: 15000 }
                ).catch(() => {});
                continue;
              }
              if (pendingMeta?.id) {
                this.droppedTurnRetried.add(pendingRetryKey);
              }
              this.healActorBinaryOrDroppedTurn(g.group_id, a, pendingMeta, {
                wipeSession: false,
              }).catch(() => {});
              continue;
            }

            const groupShouldRun =
              g.running !== false &&
              g.desired_running !== false &&
              g.state !== 'stopped' &&
              g.state !== 'paused' &&
              !(this.groupPrefs[g.group_id]?.archived);

            if (
              a.enabled &&
              !a.running &&
              hasUnfinishedPendingTurn &&
              (groupShouldRun || a.runtime_session_status === 'resume_failed')
            ) {
              if (nowMs - lastHeal > 25_000) {
                this.autoHealCooldown.set(healKey, nowMs);
                this.droppedTurnRetried.add(pendingRetryKey);
                this.healActorBinaryOrDroppedTurn(g.group_id, a, pendingMeta, {
                  wipeSession: a.runtime_session_status === 'resume_failed',
                }).catch(() => {});
              }
              continue;
            }

            if (!a.running && !hasUnfinishedPendingTurn) {
              continue;
            }

            if (isCodexActor) {
              const rec = await this.reconcileCodexPendingTurn(g.group_id, a, ledger, nowMs);
              // Refresh local ledger snapshot if Auto-Harvest just wrote Codex's reply
              ledger = await this.readGroupLedger(g.group_id);
              thinkingSet = new Set(ledger.thinkingActorIds || []);
              if (rec.activeTurnInRollout) {
                thinkingSet.add(a.id);
              }
              continue;
            }

            // Fallback Watchdog for non-Codex managed_session actors
            if (
              a.enabled &&
              a.running &&
              a.runtime_state_source === 'managed_session' &&
              (a.effective_working_state || 'idle') === 'idle' &&
              !a.effective_active_task_id
            ) {
              const pendingMeta = ledger.pendingMessageMeta?.[a.id];
              const ageMs = pendingMeta?.ts
                ? nowMs - new Date(pendingMeta.ts).getTime()
                : -1;
              const retryId = pendingMeta?.id ? `${g.group_id}:${a.id}:${pendingMeta.id}` : '';
              if (
                retryId &&
                ageMs >= 14_000 &&
                ageMs < 180_000 &&
                !this.droppedTurnRetried.has(retryId) &&
                !this.cancelledPendingIds.has(retryId) &&
                nowMs - lastHeal > 20_000
              ) {
                this.droppedTurnRetried.add(retryId);
                this.autoHealCooldown.set(healKey, nowMs);
                thinkingSet.add(a.id);
                this.healActorBinaryOrDroppedTurn(g.group_id, a, pendingMeta, {
                  wipeSession: false,
                }).catch(() => {});
              }
            }
          }
        }

        const prefs = this.groupPrefs[g.group_id] || {};
        const agentProfiles = normalizeAgentProfiles(prefs.agentProfiles);

        const actors = await Promise.all(
          actorsList.map(async (a) => {
            const rawState = a.effective_working_state || 'idle';
            const extThink = this.externalThinkingActors.get(g.group_id)?.get(a.id) || null;
            const isThinking =
              Boolean(extThink) || (Boolean(a.running) && thinkingSet.has(a.id));
            const thinkingSince = isThinking
              ? extThink?.since ||
                ledger.pendingSince?.[a.id] ||
                a.effective_working_updated_at ||
                ledger.pendingMessageMeta?.[a.id]?.ts ||
                new Date().toISOString()
              : null;

            let liveStep = null;
            if (isThinking) {
              if (extThink?.label) {
                liveStep = {
                  kind: 'external_session',
                  stepText: extThink.label,
                  updatedAt: thinkingSince,
                };
              }
              const isCodex =
                a.id === 'codex' || String(a.runtime || '').toLowerCase().includes('codex');
              if (!liveStep && isCodex && (!this.isMockExec || this.enableWatchdogInTests)) {
                const rolloutPath = await this.resolveCodexRolloutPath(g.group_id, a.id);
                if (rolloutPath) {
                  liveStep = await extractRolloutLiveStep(rolloutPath);
                }
              }
              if (!liveStep) {
                liveStep = {
                  kind: 'thinking',
                  stepText:
                    a.id === 'antigravity' ? '正在思考并生成回复…' : '正在分析上下文…',
                  updatedAt: thinkingSince,
                };
              }
            }

            const defaultTitle = a.title || a.id;
            const customTitle = String(agentProfiles[a.id]?.displayName || '').trim();
            return {
              id: a.id,
              title: customTitle || defaultTitle,
              defaultTitle,
              role: a.role || 'peer',
              runtime: a.runtime || a.id,
              running: Boolean(a.running),
              enabled: Boolean(a.enabled),
              pid: a.pid || null,
              readOnly: detectReadOnly(a.command),
              speedGear: detectActorSpeedGear(a.command),
              workingState: isThinking ? 'thinking' : rawState === 'working' ? 'idle' : rawState,
              thinkingSince,
              liveStep,
              lastOutputAt: a.pty_last_output_at || null,
            };
          })
        );

        const detectedGear =
          actors.length > 0 && actors.every((a) => a.speedGear === 'fast')
            ? 'fast'
            : actors.find((a) => a.id === 'antigravity' || a.id === 'codex')?.speedGear || 'deep';
        const speedGear =
          prefs.speedGear && actors.some((a) => a.speedGear === prefs.speedGear)
            ? prefs.speedGear
            : detectedGear;
        const collabMode = ['free', 'relay', 'blind'].includes(prefs.collabMode)
          ? prefs.collabMode
          : 'free';
        const relayLead = prefs.relayLead || 'codex';
        const replyStyle = normalizeReplyStyle(prefs.replyStyle);

        const chatMsgs = ledger.messages.filter((m) => m.kind === 'chat');
        const lastMsg = chatMsgs[chatMsgs.length - 1] || null;
        const lastPreviewText = lastMsg
          ? (
              lastMsg.text ||
              (lastMsg.attachments?.[0]?.kind === 'image'
                ? '[图片]'
                : lastMsg.attachments?.length
                  ? '[文件]'
                  : '')
            )
              .replace(/\s+/g, ' ')
              .slice(0, 60)
          : '';
        const scopes = (showData?.group?.scopes || []).map((s) => ({
          key: s.scope_key,
          label: s.label,
          path: cleanScopeUrl(s.url),
        }));
        const activeScopePath =
          cleanScopeUrl(showData?.effective_scope?.path || '') ||
          scopes[0]?.path ||
          '';

        const codexActor = actors.find(
          (a) => a.id === 'codex' || String(a.runtime || '').toLowerCase().includes('codex')
        );
        const codexSandbox = codexActor
          ? codexActor.readOnly
            ? 'read-only'
            : 'workspace-write'
          : 'read-only';

        const sessionRouting = normalizeSessionRouting(prefs.sessionRouting, activeScopePath);

        return {
          id: g.group_id,
          kind: 'group',
          title: g.title || g.group_id,
          topic: showData?.group?.topic || g.topic || '',
          running: Boolean(g.running),
          state: g.state || 'active',
          scopePath: activeScopePath,
          scopes,
          actors,
          speedGear,
          replyStyle,
          sessionRouting,
          agentProfiles,
          codexSandbox,
          collabMode,
          relayLead,
          ideBoard: this.getIdeBoardSnapshot(g.group_id),
          pinned: Boolean(prefs.pinned),
          archived: Boolean(prefs.archived),
          memberCount: actors.length + 1, // +1 for User ("我")
          messageCount: chatMsgs.length,
          lastMessage: lastMsg
            ? {
                sender: lastMsg.isUser ? '我' : lastMsg.senderTitle,
                text: lastPreviewText,
                ts: lastMsg.ts,
              }
            : null,
          updatedAt: lastMsg?.ts || g.updated_at || g.created_at,
        };
      })
    );

    // Append local File Transfer Assistant just like WeChat
    const fhMessages = await this.getFileHelperMessages();
    const lastFh = fhMessages[fhMessages.length - 1] || null;
    const lastFhPreview = lastFh
      ? (
          lastFh.text ||
          (lastFh.attachments?.[0]?.kind === 'image'
            ? '[图片]'
            : lastFh.attachments?.length
              ? '[文件]'
              : '')
        )
          .replace(/\s+/g, ' ')
          .slice(0, 60)
      : '';
    const fhPrefs = this.groupPrefs['file-helper'] || {};
    const fileHelperSession = {
      id: 'file-helper',
      kind: 'helper',
      title: '文件传输助手',
      topic: '电脑与手机端跨设备随手笔记、代码片段、截图与文件路径速传',
      running: true,
      state: 'active',
      scopePath: this.dataDir,
      scopes: [],
      actors: [],
      speedGear: 'fast',
      replyStyle: 'plain',
      codexSandbox: 'read-only',
      collabMode: 'free',
      relayLead: 'codex',
      pinned: Boolean(fhPrefs.pinned),
      archived: false,
      memberCount: 1,
      messageCount: fhMessages.length,
      lastMessage: lastFh
        ? {
            sender: lastFh.isUser ? '我' : '助手',
            text: lastFhPreview,
            ts: lastFh.ts,
          }
          : null,
        updatedAt: lastFh?.ts || '1970-01-01T00:00:00.000Z',
      };

      detailed.sort((a, b) => {
        if (Boolean(a.archived) !== Boolean(b.archived)) return a.archived ? 1 : -1;
        if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
        return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
      });
      const activeDetailed = detailed.filter((g) => !g.archived);
      const archivedDetailed = detailed.filter((g) => g.archived);
      const result = fileHelperSession.pinned
        ? [fileHelperSession, ...activeDetailed, ...archivedDetailed]
        : [...activeDetailed, fileHelperSession, ...archivedDetailed];
      this.groupMetaCache = { ts: Date.now(), data: result };
      const nextFp = computeGroupsFingerprint(result);
      if (nextFp !== this.lastGroupsFingerprint) {
        this.lastGroupsFingerprint = nextFp;
        this.emit('groups', result);
      }
      return result;
    };

    const p = runFetch();
    this.listGroupsInFlight = p;
    try {
      return await p;
    } finally {
      if (this.listGroupsInFlight === p) {
        this.listGroupsInFlight = null;
      }
    }
  }

  async setGroupPrefs(groupId, patch = {}) {
    if (!groupId || !/^[a-zA-Z0-9_-]+$/.test(groupId)) {
      throw new Error('非法的群聊 ID');
    }
    const cur = this.groupPrefs[groupId] || {};
    const next = { ...cur };
    if (patch.collabMode && ['free', 'relay', 'blind'].includes(patch.collabMode)) {
      next.collabMode = patch.collabMode;
    }
    if (patch.replyStyle && VALID_REPLY_STYLES.includes(patch.replyStyle)) {
      next.replyStyle = patch.replyStyle;
    }
    if (typeof patch.relayLead === 'string' && /^[a-zA-Z0-9_-]+$/.test(patch.relayLead)) {
      next.relayLead = patch.relayLead;
    }
    if (typeof patch.pinned === 'boolean') {
      next.pinned = patch.pinned;
    }
    if (typeof patch.archived === 'boolean') {
      next.archived = patch.archived;
    }
    if (patch.sessionRouting && typeof patch.sessionRouting === 'object') {
      const existingGroup = (this.groupMetaCache.data || []).find((g) => g.id === groupId);
      next.sessionRouting = normalizeSessionRouting(
        patch.sessionRouting,
        existingGroup?.scopePath || ''
      );
    }
    if (patch.agentProfiles && typeof patch.agentProfiles === 'object') {
      next.agentProfiles = normalizeAgentProfiles({
        ...(cur.agentProfiles || {}),
        ...patch.agentProfiles,
      });
    }
    this.groupPrefs[groupId] = next;
    await this.saveGroupPrefs();
    this.groupMetaCache.ts = 0;
    return next;
  }

  async interruptOrRetryGroupTurn(groupId, { action = 'interrupt', actorId = '', text = '' } = {}) {
    if (!groupId || !/^[a-zA-Z0-9_-]+$/.test(groupId)) {
      throw new Error('非法的群聊 ID');
    }
    if (groupId === 'file-helper') {
      return { ok: true, action, groups: await this.listGroups({ force: true }) };
    }
    await this.ensureDaemonRunning();
    const [actorsRes, ledger] = await Promise.all([
      this.queryGroupActors(groupId).catch(() => ({ actors: [] })),
      this.readGroupLedger(groupId),
    ]);
    const actorsList = Array.isArray(actorsRes?.actors) ? actorsRes.actors : [];

    if (action === 'interrupt') {
      this.cancelledExternalGroups.add(groupId);
      const activeProcs = this.activeExternalChildren.get(groupId);
      if (activeProcs && activeProcs.size > 0) {
        for (const child of activeProcs) {
          try {
            child.kill();
          } catch {
            // ignore kill error
          }
        }
        activeProcs.clear();
      }
      if (this.externalThinkingActors.has(groupId)) {
        this.externalThinkingActors.delete(groupId);
        this.emit('activity', { groupId, thinkingActorIds: [] });
      }
      const board = this.ideBoards.get(groupId);
      if (board) {
        board.stageText = '⏹ 已手动中断当前执行';
        board.updatedAt = new Date().toISOString();
        for (const aState of Object.values(board.actors || {})) {
          if (aState && ['aligning', 'running', 'collab'].includes(aState.phase)) {
            aState.phase = 'error';
            aState.phaseLabel = '已中断';
            aState.currentAction = '⏹ 用户已手动中断执行';
            aState.lastActivityAt = board.updatedAt;
          }
        }
        this.emitIdeBoardIfChanged(groupId);
      }
      if (this.pendingRelays.has(groupId) || this.activeRelayReviewers.has(groupId)) {
        this.pendingRelays.delete(groupId);
        this.activeRelayReviewers.delete(groupId);
        this.emit('relay', { groupId, active: false, step: 0, text: '' });
      } else {
        this.emit('relay', { groupId, active: false, step: 0, text: '' });
      }
      const targets = actorsList.filter((a) => {
        if (actorId) return a.id === actorId;
        return (
          a.running &&
          ((a.effective_working_state || 'idle') === 'working' ||
            Boolean(a.effective_active_task_id) ||
            (ledger.thinkingActorIds || []).includes(a.id) ||
            Boolean(ledger.pendingMessageMeta?.[a.id]))
        );
      });
      const finalTargets = targets.length > 0 ? targets : actorsList.filter((a) => a.running);

      for (const a of finalTargets) {
        const meta = ledger.pendingMessageMeta?.[a.id];
        if (meta?.id) {
          this.cancelledPendingIds.add(`${groupId}:${a.id}:${meta.id}`);
        }
        if (ledger.pendingSince) delete ledger.pendingSince[a.id];
      }

      await Promise.all(
        finalTargets.map((a) =>
          this.execFn(['actor', 'restart', '--group', groupId, a.id], { timeout: 20000 }).catch(
            () => {}
          )
        )
      );

      const liveMap = this.liveActorStates.get(groupId);
      if (liveMap) {
        for (const a of finalTargets) {
          const prev = liveMap.get(a.id);
          if (prev) {
            liveMap.set(a.id, { ...prev, workingState: 'idle', activeTaskId: null });
          }
        }
      }
      this.lastThinkingKey.set(groupId, '');
      this.emit('activity', { groupId, thinkingActorIds: [] });
      this.groupMetaCache.ts = 0;
      const groups = await this.listGroups({ force: true });
      return { ok: true, action: 'interrupt', groups };
    }

    if (action === 'retry') {
      const trimmedText = String(text || '').trim();
      if (trimmedText) {
        await this.sendGroupMessage(groupId, {
          text: trimmedText,
          to: actorId ? [actorId] : [],
        });
        const groups = await this.listGroups({ force: true });
        return { ok: true, action: 'retry', groups };
      }

      const lastUserMsg = [...(ledger.messages || [])]
        .reverse()
        .find((m) => m.kind === 'chat' && m.isUser);
      const targets = actorsList.filter((a) => {
        if (actorId) return a.id === actorId;
        return Boolean(ledger.pendingMessageMeta?.[a.id]) && a.enabled !== false;
      });
      const finalTargets =
        targets.length > 0 ? targets : actorsList.filter((a) => a.enabled !== false).slice(0, 1);

      for (const a of finalTargets) {
        const pendingMeta =
          ledger.pendingMessageMeta?.[a.id] ||
          (lastUserMsg
            ? { id: lastUserMsg.id, ts: lastUserMsg.ts, text: lastUserMsg.text }
            : {
                id: `manual-${Date.now()}`,
                ts: new Date().toISOString(),
                text: '请继续处理并回复上一条待办消息',
              });
        const key = `${groupId}:${a.id}:${pendingMeta.id}`;
        this.cancelledPendingIds.delete(key);
        this.droppedTurnRetried.delete(key);
        this.pendingTurnRecovery.delete(key);

        const isCodexActor =
          a.id === 'codex' || String(a.runtime || '').toLowerCase().includes('codex');
        if (isCodexActor && ledger.pendingMessageMeta?.[a.id]?.id === pendingMeta.id) {
          const rolloutPath = await this.resolveCodexRolloutPath(groupId, a.id);
          const rolloutInfo = rolloutPath
            ? await inspectCodexRolloutForPending(rolloutPath, [pendingMeta.id])
            : null;
          if (rolloutInfo?.matched && rolloutInfo.completed && rolloutInfo.finalAnswerText) {
            await this.reconcileCodexPendingTurn(groupId, a, ledger, Date.now() + 10_000);
            continue;
          }
        }

        await this.healActorBinaryOrDroppedTurn(groupId, a, pendingMeta, { wipeSession: false });
      }

      this.groupMetaCache.ts = 0;
      const groups = await this.listGroups({ force: true });
      return { ok: true, action: 'retry', groups };
    }

    throw new Error(`不支持的轮次控制动作：${action}`);
  }

  async setGroupSpeedGear(groupId, gear = 'fast') {
    if (!groupId || !/^[a-zA-Z0-9_-]+$/.test(groupId)) {
      throw new Error('非法的群聊 ID');
    }
    const safeGear = gear === 'deep' ? 'deep' : 'fast';
    await this.ensureDaemonRunning();

    const [showData, actorsData] = await Promise.all([
      this.queryGroupShow(groupId),
      this.queryGroupActors(groupId),
    ]);

    const showActors = showData?.group?.actors || [];
    const liveActors = Array.isArray(actorsData?.actors) ? actorsData.actors : showActors;
    const profiles = normalizeAgentProfiles(this.groupPrefs[groupId]?.agentProfiles);

    const restartTargets = [];

    for (const a of liveActors) {
      const cfgActor = showActors.find((x) => x.id === a.id) || a;
      const cmdArr = Array.isArray(cfgActor.command)
        ? cfgActor.command
        : Array.isArray(a.command)
          ? a.command
          : [];
      const runtime = String(a.runtime || a.id || '').toLowerCase();

      if (a.id === 'codex' || runtime.includes('codex')) {
        const sandbox = detectReadOnly(cmdArr) ? 'read-only' : 'workspace-write';
        const codexBin =
          cmdArr[0] && fs.existsSync(cmdArr[0]) ? cmdArr[0] : await resolveCodexBinary();
        const newCmd = buildCodexLaunchCommand(codexBin, {
          sandbox,
          gear: safeGear,
          model: profiles.codex?.model || '',
        });
        await this.execFn(
          ['actor', 'update', '--group', groupId, '--command', newCmd, a.id],
          { timeout: 15000 }
        );
        if (a.running || a.enabled !== false) {
          restartTargets.push(a);
        }
      } else if (a.id === 'antigravity' || runtime.includes('antigravity')) {
        const agyBin = cmdArr[0] && fs.existsSync(cmdArr[0]) ? cmdArr[0] : AGY_BIN;
        const newCmd = buildAntigravityLaunchCommand(agyBin, {
          gear: safeGear,
          model: profiles.antigravity?.model || '',
        });
        await this.execFn(
          ['actor', 'update', '--group', groupId, '--command', newCmd, a.id],
          { timeout: 15000 }
        );
        if (a.running || a.enabled !== false) {
          restartTargets.push(a);
        }
      }
    }

    await Promise.all(
      restartTargets.map(async (a) => {
        await this.unlinkBrokenRuntimeSession(groupId, a.id);
        const action = a.running ? 'restart' : 'start';
        await this.execFn(['actor', action, '--group', groupId, a.id], { timeout: 25000 });
      })
    );

    await repinMcpConfig();
    this.groupPrefs[groupId] = {
      ...(this.groupPrefs[groupId] || {}),
      speedGear: safeGear,
    };
    await this.saveGroupPrefs();
    this.groupMetaCache.ts = 0;
    return this.listGroups({ force: true });
  }

  async getMessages(groupId) {
    if (groupId === 'file-helper') {
      return this.getFileHelperMessages();
    }
    const ledger = await this.readGroupLedger(groupId);
    return ledger.messages;
  }

  async getMessagesSlice(groupId, { limit = 0, beforeIndex = null } = {}) {
    const all = await this.getMessages(groupId);
    const totalCount = all.length;
    const maxCount = Number(limit) || 0;
    if (maxCount <= 0) {
      return {
        groupId,
        messages: all,
        totalCount,
        startIndex: 0,
        hasMore: false,
      };
    }
    const endIdx =
      beforeIndex !== null && beforeIndex !== '' && Number.isFinite(Number(beforeIndex))
        ? Math.max(0, Math.min(totalCount, Number(beforeIndex)))
        : totalCount;
    const startIdx = Math.max(0, endIdx - Math.min(200, maxCount));
    return {
      groupId,
      messages: all.slice(startIdx, endIdx),
      totalCount,
      startIndex: startIdx,
      hasMore: startIdx > 0,
    };
  }

  async searchMessages(rawQuery = '', { limit = 40 } = {}) {
    const q = String(rawQuery || '').trim().toLowerCase();
    if (!q) return [];

    const groups = this.groupMetaCache.data || (await this.listGroups().catch(() => []));
    const titleByGroup = new Map(groups.map((g) => [g.id, g.title || g.id]));
    const hits = [];

    const collectFromList = (groupId, groupTitle, messages) => {
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const m = messages[i];
        if (!m || m.kind !== 'chat') continue;
        const body = String(m.text || '');
        const attNames = Array.isArray(m.attachments)
          ? m.attachments.map((a) => a.name || '').join(' ')
          : '';
        const haystack = `${m.senderTitle || ''} ${body} ${m.insight || ''} ${attNames}`;
        const lower = haystack.toLowerCase();
        const idx = lower.indexOf(q);
        if (idx === -1) continue;

        const cleanFlat = (body || attNames || '[附件]').replace(/\s+/g, ' ').trim();
        const flatLower = cleanFlat.toLowerCase();
        const bodyIdx = flatLower.indexOf(q);
        let snippet = cleanFlat.slice(0, 68);
        if (bodyIdx > 22) {
          const start = Math.max(0, bodyIdx - 18);
          snippet = `${start > 0 ? '…' : ''}${cleanFlat.slice(start, start + 64)}`;
        }

        hits.push({
          id: m.id,
          groupId,
          groupTitle,
          senderTitle: m.isUser ? '我' : m.senderTitle || m.by || 'Agent',
          ts: m.ts || '',
          snippet,
        });
      }
    };

    try {
      if (fs.existsSync(this.groupsDir)) {
        const dirs = await fsp.readdir(this.groupsDir, { withFileTypes: true });
        for (const d of dirs) {
          if (!d.isDirectory()) continue;
          const ledger = await this.readGroupLedger(d.name);
          collectFromList(
            d.name,
            titleByGroup.get(d.name) || d.name,
            ledger.messages || []
          );
        }
      }
    } catch {
      // ignore read error
    }

    const fhMsgs = await this.getFileHelperMessages();
    collectFromList('file-helper', '文件传输助手', fhMsgs);

    hits.sort((a, b) => new Date(b.ts || 0) - new Date(a.ts || 0));
    return hits.slice(0, Math.max(1, Math.min(100, Number(limit) || 40)));
  }

  resolveRecipients(text, explicitTo, actors = []) {
    const validIds = new Set(actors.map((a) => a.id));
    const chosen = new Set();

    // 1. Check explicit @mentions inside message text first
    const textMentions = new Set();
    const mentionMatches = String(text || '').matchAll(/@([a-zA-Z0-9_\u4e00-\u9fa5-]+)/g);
    for (const m of mentionMatches) {
      const token = m[1].toLowerCase();
      if (token === 'all' || token === '所有人') {
        for (const a of actors) textMentions.add(a.id);
      } else {
        for (const a of actors) {
          if (a.id.toLowerCase() === token || (a.title || '').toLowerCase() === token) {
            textMentions.add(a.id);
          }
        }
      }
    }

    const isExplicitAll =
      !Array.isArray(explicitTo) ||
      explicitTo.length === 0 ||
      explicitTo.includes('@all') ||
      explicitTo.includes('all');

    if (textMentions.size > 0 && isExplicitAll) {
      // User left chip on "@所有人" but typed "@codex ..." specifically
      for (const id of textMentions) chosen.add(id);
    } else if (!isExplicitAll) {
      // User clicked a specific recipient chip (plus any @mentions in text)
      for (const item of explicitTo) {
        if (validIds.has(item)) chosen.add(item);
      }
      for (const id of textMentions) chosen.add(id);
    }

    // Default WeChat group behavior: broadcast to ALL agents in the group so everyone participates
    if (chosen.size === 0) {
      for (const a of actors) {
        if (a.enabled !== false) chosen.add(a.id);
      }
    }

    return Array.from(chosen);
  }

  async buildOutgoingMessagePayload(
    groupId,
    cleanText,
    { sharedContext = true, fastHint = true, replyStyle = '', extraSystemNote = '' } = {}
  ) {
    const hasImageAttachment = /\[图片:\s*[^\]]+\]/.test(cleanText);
    const hasExplicitStyle = VALID_REPLY_STYLES.includes(replyStyle);
    if (!sharedContext && !fastHint && !extraSystemNote && !hasImageAttachment && !hasExplicitStyle) {
      return cleanText;
    }

    const effectiveStyle = normalizeReplyStyle(
      hasExplicitStyle ? replyStyle : this.groupPrefs[groupId]?.replyStyle
    );
    const lines = [];
    if (extraSystemNote) {
      lines.push(extraSystemNote);
    }
    const groupProfiles = normalizeAgentProfiles(this.groupPrefs[groupId]?.agentProfiles);
    for (const pid of ['codex', 'antigravity']) {
      const pNote = buildAgentPersonaDirective(pid, groupProfiles);
      if (pNote) lines.push(`[@${pid} ${pNote.slice(1, -1)}]`);
    }
    if (fastHint || hasExplicitStyle) {
      lines.push(buildReplyStyleDirective(effectiveStyle));
    }
    if (hasImageAttachment) {
      lines.push(
        '[图片附件提示：消息中包含本地图片路径，请直接调用内置读图工具查看该图片文件后再结合问题作答]'
      );
    }
    if (sharedContext) {
      const ledger = await this.readGroupLedger(groupId);
      const recentChat = (ledger.messages || [])
        .filter((m) => m.kind === 'chat' && (m.text || m.attachments?.length))
        .slice(-3);
      if (recentChat.length > 0) {
        lines.push('[近期群聊背景]');
        for (const m of recentChat) {
          const ts = formatShortTime(m.ts);
          const who = m.isUser ? '我' : m.senderTitle;
          const toLabel = Array.isArray(m.to) && m.to.length
            ? m.to.map((r) => (r === 'user' ? '我' : `@${r}`)).join(',')
            : '群内';
          const flat = stripSharedContextBlock(m.text || '[附件]')
            .replace(/\s+/g, ' ')
            .slice(0, 140);
          lines.push(`- ${ts ? `[${ts}] ` : ''}${who} → ${toLabel}: ${flat}`);
        }
      }
    }

    if (fastHint) {
      lines.push(
        '[回复通道强制要求（用户已明确授权）：群聊界面不显示终端直接输出，完成分析后必须调用 MCP 工具 cccc_message_reply(event_id=<本消息event_id>, to=["user"], mode="send", text="...") 将最终回复发回群里；如需同步同伴则另发给同伴并填 insight]'
      );
    }

    if (lines.length === 0) return cleanText;
    return `${cleanText}\n\n<!--aw-ctx:start-->\n${lines.join('\n')}\n<!--aw-ctx:end-->`;
  }

  async listExternalSessions({ force = false, limit = 28 } = {}) {
    const now = Date.now();
    if (!force && this.externalSessionCache.data && now - this.externalSessionCache.ts < 4000) {
      return this.externalSessionCache.data;
    }
    const catalog = await discoverLocalSessions({
      codexHomeDir: this.codexHomeDir,
      antigravityDataDir: this.antigravityDataDir,
      antigravityCliDataDir: this.antigravityCliDataDir,
      limit,
    });
    this.externalSessionCache = { ts: now, data: catalog };
    return catalog;
  }

  async getExternalSessionPreview(agent, sessionId, { maxItems = 3 } = {}) {
    const safeAgent = agent === 'codex' ? 'codex' : 'antigravity';
    return readExternalSessionPreview({
      agent: safeAgent,
      sessionId,
      codexHomeDir: this.codexHomeDir,
      antigravityDataDir: this.antigravityDataDir,
      antigravityCliDataDir: this.antigravityCliDataDir,
      maxItems,
    });
  }

  async appendExternalDispatchMessage(groupId, msgObj) {
    await fsp.mkdir(this.externalDispatchesDir, { recursive: true });
    const extPath = path.join(this.externalDispatchesDir, `${groupId}.jsonl`);
    const record = {
      id: msgObj.id || `ext-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: msgObj.ts || new Date().toISOString(),
      kind: msgObj.kind || 'chat',
      by: msgObj.by || 'user',
      isUser: Boolean(msgObj.isUser),
      senderTitle: msgObj.senderTitle || (msgObj.isUser ? '我' : msgObj.by),
      senderRuntime: msgObj.senderRuntime || (msgObj.isUser ? 'user' : msgObj.by),
      to: Array.isArray(msgObj.to) ? msgObj.to : [],
      mode: msgObj.mode || 'send',
      insight: msgObj.insight || '',
      hasSharedContext: Boolean(msgObj.hasSharedContext),
      attachments: Array.isArray(msgObj.attachments) ? msgObj.attachments : [],
      text: String(msgObj.text || ''),
      ok: msgObj.ok !== false,
      thoughtTrace: Array.isArray(msgObj.thoughtTrace) ? msgObj.thoughtTrace : [],
      sessionReceipt: msgObj.sessionReceipt || null,
      retryMeta: msgObj.retryMeta || null,
    };
    await fsp.appendFile(extPath, `${JSON.stringify(record)}\n`, 'utf8');
    this.groupMetaCache.ts = 0;
    await this.readGroupLedger(groupId);
    return record;
  }

  setExternalActorThinking(groupId, actorId, label = '') {
    if (!label) {
      const m = this.externalThinkingActors.get(groupId);
      if (m) {
        m.delete(actorId);
        if (m.size === 0) this.externalThinkingActors.delete(groupId);
      }
    } else {
      let m = this.externalThinkingActors.get(groupId);
      if (!m) {
        m = new Map();
        this.externalThinkingActors.set(groupId, m);
      }
      const prev = m.get(actorId);
      m.set(actorId, { since: prev?.since || new Date().toISOString(), label });
    }
    this.groupMetaCache.ts = 0;
    this.readGroupLedger(groupId).catch(() => {});
  }

  getIdeBoardSnapshot(groupId) {
    const board = this.ideBoards.get(groupId);
    if (!board) return null;
    const actorsCopy = {};
    for (const [k, v] of Object.entries(board.actors || {})) {
      actorsCopy[k] = {
        ...v,
        steps: Array.isArray(v.steps) ? v.steps.map((s) => ({ ...s })) : [],
        recentActions: Array.isArray(v.recentActions) ? v.recentActions.map((a) => ({ ...a })) : [],
      };
    }
    return {
      groupId: board.groupId,
      taskTitle: board.taskTitle || '',
      stageText: board.stageText || '',
      round: Number(board.round || 0),
      updatedAt: board.updatedAt || '',
      actors: actorsCopy,
    };
  }

  emitIdeBoardIfChanged(groupId) {
    const board = this.ideBoards.get(groupId);
    if (!board) return;
    const fp = computeIdeBoardFingerprint(board);
    if (this.lastIdeBoardFp.get(groupId) === fp) return;
    this.lastIdeBoardFp.set(groupId, fp);
    this.groupMetaCache.ts = 0;
    this.emit('ideBoard', { groupId, ideBoard: this.getIdeBoardSnapshot(groupId) });
  }

  ensureGroupIdeBoard(groupId, { taskTitle = '', stageText = '', round = null, reset = false } = {}) {
    let board = reset ? null : this.ideBoards.get(groupId);
    const nowIso = new Date().toISOString();
    if (!board) {
      board = {
        groupId,
        taskTitle: String(taskTitle || '').slice(0, 96),
        stageText: String(stageText || ''),
        round: Number(round || 1),
        updatedAt: nowIso,
        actors: {
          codex: createActorBoardState('codex', { title: 'Codex' }),
          antigravity: createActorBoardState('antigravity', { title: 'Antigravity' }),
        },
      };
      this.ideBoards.set(groupId, board);
    } else {
      if (taskTitle) board.taskTitle = String(taskTitle).slice(0, 96);
      if (stageText !== undefined && stageText !== '') board.stageText = String(stageText);
      if (typeof round === 'number' && round > 0) board.round = round;
      board.updatedAt = nowIso;
    }
    this.emitIdeBoardIfChanged(groupId);
    return board;
  }

  updateActorIdeBoardState(groupId, actorId, patch = {}, { actionKind = '', actionText = '' } = {}) {
    const board = this.ensureGroupIdeBoard(groupId);
    const prev =
      board.actors[actorId] ||
      createActorBoardState(actorId, { title: actorId === 'codex' ? 'Codex' : 'Antigravity' });
    const nowIso = new Date().toISOString();
    const next = {
      ...prev,
      ...patch,
      actorId,
      lastActivityAt: patch.lastActivityAt || nowIso,
    };
    if (next.phase && !patch.phaseLabel) {
      next.phaseLabel = PHASE_LABELS[next.phase] || next.phaseLabel || '执行中';
    }
    if (actionText) {
      next.recentActions = pushBoardRecentAction(prev.recentActions, actionKind || 'tool', actionText);
    }
    board.actors[actorId] = next;
    board.updatedAt = nowIso;
    this.emitIdeBoardIfChanged(groupId);
    return next;
  }

  async runTargetSessionForActor({
    groupId,
    targetGroup,
    actorId,
    routing,
    prompt,
    attachments = [],
    replyStyle = 'plain',
    phase = 'exec',
    forcePermission = null,
  }) {
    const actorInfo = (targetGroup.actors || []).find((a) => a.id === actorId) || {
      id: actorId,
      title:
        PROVIDER_CATALOG_META[actorId]?.title ||
        (actorId === 'codex' ? 'Codex' : 'Antigravity'),
    };
    const profiles = normalizeAgentProfiles(this.groupPrefs[groupId]?.agentProfiles);
    const actorProfile = profiles[actorId] || { displayName: '', model: '', persona: '' };
    const personaDirective = buildAgentPersonaDirective(actorId, profiles);
    const agentCfg = routing[actorId] || { mode: 'group', sessionId: '', sessionTitle: '', cwd: '' };
    let effectiveMode = agentCfg.mode || 'group';
    let effectiveSessionId = agentCfg.sessionId || '';
    let effectiveCwd = agentCfg.cwd || targetGroup.scopePath || DEFAULT_ROOM_DIR;

    // If actor remained in 'group' mode while peer was routed externally, reuse group's bound session/scope cleanly
    if (effectiveMode === 'group') {
      if (actorId === 'codex') {
        const sFile = path.join(
          this.groupsDir,
          groupId,
          'state',
          'runtime_sessions',
          'codex.json'
        );
        try {
          if (fs.existsSync(sFile)) {
            const parsed = JSON.parse(await fsp.readFile(sFile, 'utf8'));
            if (parsed?.status !== 'resume_failed' && parsed?.provider_thread_id) {
              effectiveMode = 'existing';
              effectiveSessionId = String(parsed.provider_thread_id);
            }
          }
        } catch {
          // fallback to new in scope
        }
        if (effectiveMode === 'group') effectiveMode = 'new';
      } else {
        effectiveMode = 'new';
      }
    }

    const effectivePermission = forcePermission || routing.permission || 'inherit';
    const styleDirective = buildReplyStyleDirective(replyStyle);
    const fullPrompt = personaDirective
      ? `${personaDirective}\n\n${prompt}\n\n${styleDirective}`
      : `${prompt}\n\n${styleDirective}`;
    const codexBin = actorId === 'codex' ? await resolveCodexBinary() : 'codex';

    const streamId = `stream-${groupId}-${actorId}-${phase}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 6)}`;
    const senderTitle =
      actorProfile.displayName ||
      actorInfo.title ||
      PROVIDER_CATALOG_META[actorId]?.title ||
      (actorId === 'codex' ? 'Codex' : 'Antigravity');
    let lastEmitMs = 0;
    let lastBoardEmitMs = 0;
    let latestStep = '🚀 正在唤醒目标会话…';
    let latestText = '';
    let latestThoughtTrace = [];
    let pendingFlushTimer = null;
    const resolvedSessionTitle =
      agentCfg.sessionTitle ||
      (effectiveCwd ? `${path.basename(effectiveCwd)} 会话` : '群默认目录');
    const boardPhaseForTurn =
      phase === 'discuss_lead' || phase === 'discuss_peer'
        ? 'aligning'
        : phase === 'collab_sync'
          ? 'collab'
          : 'running';
    const turnStartedIso = new Date().toISOString();

    this.updateActorIdeBoardState(
      groupId,
      actorId,
      {
        title: senderTitle,
        phase: boardPhaseForTurn,
        sessionTitle: resolvedSessionTitle,
        sessionMode: agentCfg.mode || 'group',
        sessionId: effectiveSessionId || '',
        currentAction: latestStep,
        startedAt: turnStartedIso,
        completedAt: '',
        collabNote: '',
      },
      { actionKind: 'tool', actionText: latestStep }
    );

    const flushStreamFrame = () => {
      pendingFlushTimer = null;
      lastEmitMs = Date.now();
      this.emit('stream', {
        groupId,
        streamId,
        by: actorId,
        senderTitle,
        phase,
        stepLabel: latestStep,
        text: stripIdeProtocolTags(latestText),
        thoughtTrace: latestThoughtTrace,
        done: false,
      });
    };

    // Emit immediate 0ms streaming placeholder frame so UI responds within milliseconds
    flushStreamFrame();

    const onProgress = ({ stepLabel = '', text = '', thoughtTrace = null } = {}) => {
      if (this.cancelledExternalGroups.has(groupId)) return;
      if (stepLabel) {
        latestStep = stepLabel;
        const m = this.externalThinkingActors.get(groupId);
        if (m?.has(actorId)) {
          const prev = m.get(actorId);
          m.set(actorId, { since: prev?.since || new Date().toISOString(), label: stepLabel });
          this.groupMetaCache.ts = 0;
        }
      }
      if (typeof text === 'string' && text) {
        latestText = text;
      }
      if (Array.isArray(thoughtTrace)) {
        latestThoughtTrace = thoughtTrace;
      }

      const nowMs = Date.now();
      const parsedLiveSteps = parseIdeStepsFromText(latestText);
      const lastTrace =
        Array.isArray(latestThoughtTrace) && latestThoughtTrace.length > 0
          ? latestThoughtTrace[latestThoughtTrace.length - 1]
          : null;
      const boardActionText = lastTrace?.text || stepLabel || '';
      const boardActionKind = lastTrace?.kind || (/^💭/.test(boardActionText) ? 'thinking' : 'tool');
      if (parsedLiveSteps.length > 0 || boardActionText || nowMs - lastBoardEmitMs >= 200) {
        lastBoardEmitMs = nowMs;
        const patch = {
          currentAction: stepLabel || boardActionText || latestStep,
          lastActivityAt: new Date().toISOString(),
        };
        if (parsedLiveSteps.length > 0) {
          patch.steps = parsedLiveSteps;
        }
        this.updateActorIdeBoardState(groupId, actorId, patch, {
          actionKind: boardActionKind,
          actionText: boardActionText,
        });
      }

      const elapsed = nowMs - lastEmitMs;
      if (elapsed >= 90) {
        if (pendingFlushTimer) {
          clearTimeout(pendingFlushTimer);
          pendingFlushTimer = null;
        }
        flushStreamFrame();
      } else if (!pendingFlushTimer) {
        pendingFlushTimer = setTimeout(flushStreamFrame, 90 - elapsed);
        pendingFlushTimer.unref?.();
      }
    };

    const onIntermediateMessage = ({ sessionId: midSid = '', text: midText = '', thoughtTrace: midTrace = [] } = {}) => {
      if (this.cancelledExternalGroups.has(groupId)) return;
      const rawMid = String(midText || '').trim();
      if (!rawMid) return;
      const midSteps = parseIdeStepsFromText(rawMid);
      if (midSteps.length > 0) {
        this.updateActorIdeBoardState(groupId, actorId, { steps: midSteps });
      }
      const cleanMid = stripIdeProtocolTags(rawMid);
      if (!cleanMid) return;
      latestText = '';
      this.appendExternalDispatchMessage(groupId, {
        by: actorId,
        isUser: false,
        senderTitle,
        senderRuntime: actorId,
        to: ['user'],
        insight: `💬 阶段进展 · ${senderTitle}`,
        text: cleanMid,
        ok: true,
        thoughtTrace: Array.isArray(midTrace) ? midTrace : [],
        sessionReceipt: {
          agent: actorId,
          mode: agentCfg.mode,
          sessionId: midSid || effectiveSessionId || '',
          sessionTitle: resolvedSessionTitle,
          cwd: effectiveCwd,
          permission: effectivePermission,
        },
      }).catch(() => {});
    };

    let childRef = null;
    const registerChild = (child) => {
      childRef = child;
      let set = this.activeExternalChildren.get(groupId);
      if (!set) {
        set = new Set();
        this.activeExternalChildren.set(groupId, set);
      }
      set.add(child);
    };

    try {
      const result = await this.externalSessionRunnerFn({
        agent: actorId,
        phase,
        mode: effectiveMode,
        sessionId: effectiveSessionId,
        cwd: effectiveCwd,
        prompt: fullPrompt,
        attachments,
        permission: effectivePermission,
        fallbackSandbox: targetGroup.codexSandbox || 'read-only',
        gear: targetGroup.speedGear || 'deep',
        model: actorProfile.model || '',
        replyStyle,
        codexBin,
        codexHomeDir: this.codexHomeDir,
        agyBin: AGY_BIN,
        antigravityDataDir: this.antigravityDataDir,
        antigravityCliDataDir: this.antigravityCliDataDir,
        registerChild,
        onProgress,
        onIntermediateMessage,
      });

      // Auto-bind newly created or companion-forked session so subsequent messages continue in that exact writable session!
      if (
        phase === 'exec' &&
        (agentCfg.mode === 'new' || result?.forkedFromSessionId) &&
        result?.ok &&
        result.sessionId &&
        !this.cancelledExternalGroups.has(groupId)
      ) {
        const curPrefs = this.groupPrefs[groupId] || {};
        const curRouting = normalizeSessionRouting(curPrefs.sessionRouting, targetGroup.scopePath);
        const folderBase = effectiveCwd ? path.basename(effectiveCwd) : '项目';
        curRouting[actorId] = {
          mode: 'existing',
          sessionId: result.sessionId,
          sessionTitle: agentCfg.sessionTitle || `${folderBase} 新建会话`,
          cwd: effectiveCwd,
        };
        this.groupPrefs[groupId] = {
          ...curPrefs,
          sessionRouting: curRouting,
        };
        await this.saveGroupPrefs();
        this.externalSessionCache.ts = 0;
        this.groupMetaCache.ts = 0;
        this.listGroups({ force: true })
          .then((gs) => this.emit('groups', gs))
          .catch(() => {});
      }

      const rawText = String(result?.text || '');
      const parsedSteps = parseIdeStepsFromText(rawText);
      const collabSignal =
        result?.ok !== false ? parseCollabSignal(rawText, { fromActor: actorId }) : null;
      const cleanText = stripIdeProtocolTags(rawText) || collabSignal?.message || rawText;
      const resolvedSid = result?.sessionId || effectiveSessionId || '';

      if (!this.cancelledExternalGroups.has(groupId)) {
        const curBoardActor = this.ideBoards.get(groupId)?.actors?.[actorId];
        const nextSteps =
          parsedSteps.length > 0
            ? parsedSteps
            : Array.isArray(curBoardActor?.steps)
              ? curBoardActor.steps.map((s) =>
                  result?.ok !== false && phase === 'exec' && !collabSignal && s.status === 'active'
                    ? { ...s, status: 'done' }
                    : s
                )
              : [];
        const boardPatch = {
          sessionId: resolvedSid,
          sessionTitle: resolvedSessionTitle,
          steps: nextSteps,
          lastActivityAt: new Date().toISOString(),
        };
        if (collabSignal) {
          boardPatch.phase = 'collab';
          boardPatch.phaseLabel = '回群请求协作';
          boardPatch.collabNote = collabSignal.reason;
          boardPatch.currentAction = `🤝 回群沟通：${collabSignal.reason}`;
        } else if (result?.ok === false) {
          boardPatch.phase = 'error';
          boardPatch.phaseLabel = PHASE_LABELS.error;
          boardPatch.currentAction = cleanText.replace(/\s+/g, ' ').slice(0, 96) || '执行中断';
        } else if (phase === 'exec') {
          boardPatch.phase = 'done';
          boardPatch.phaseLabel = PHASE_LABELS.done;
          boardPatch.completedAt = new Date().toISOString();
          boardPatch.currentAction = '✓ 当前 IDE 分工已完成';
        } else {
          boardPatch.currentAction =
            phase === 'collab_sync' ? '🤝 已完成回群协作答复' : '✓ 群内分工已确认';
        }
        this.updateActorIdeBoardState(groupId, actorId, boardPatch, {
          actionKind: collabSignal ? 'collab' : 'tool',
          actionText: boardPatch.currentAction,
        });
      }

      return {
        ...result,
        text: cleanText,
        rawText,
        parsedSteps,
        collabSignal,
        actorTitle: senderTitle,
        sessionReceipt: {
          agent: actorId,
          mode: agentCfg.mode,
          sessionId: resolvedSid,
          sessionTitle: resolvedSessionTitle,
          cwd: effectiveCwd,
          permission: effectivePermission,
        },
      };
    } finally {
      if (pendingFlushTimer) {
        clearTimeout(pendingFlushTimer);
        pendingFlushTimer = null;
      }
      this.emit('stream', {
        groupId,
        streamId,
        by: actorId,
        senderTitle,
        phase,
        done: true,
      });
      if (childRef) {
        this.activeExternalChildren.get(groupId)?.delete(childRef);
      }
    }
  }

  isRetryableAutoWakeFailure(res = {}) {
    if (!res || res.ok !== false) return false;
    const combined = `${res.rawDetail || ''}\n${res.text || ''}`;
    if (/MODEL_PLACEHOLDER_|锁占用|already running in desktop/i.test(combined)) {
      return false;
    }
    return /idle_timeout|长时间无响应|无新输出|未返回正文|执行异常|已自动断开/i.test(combined);
  }

  needsLongTaskPhaseContinuation(userTaskText = '', replyText = '') {
    const reply = String(replyText || '').trim();
    if (!reply) return false;
    if (parseCollabSignal(reply)) return false;
    if (/全部完成|全套长任务已全部完成|全部验收通过|已全部完成|所有任务已完成/i.test(reply)) {
      return false;
    }
    const hasDeferredPhaseMarker =
      /尚未恢复训练|未恢复训练|尚未开始训练|训练尚未开始|暂不启动正式训练|尚未启动新一轮模型训练|仍待合并|尚未通过验收|待下一步|下一步再/i.test(
        reply
      );
    if (!hasDeferredPhaseMarker) return false;
    const isUnattendedOrLongTask =
      /无人看管|无人值守|睡觉|通宵|全部跑完|自动推进|自行商量解决|不用来询问我|训练|验收/i.test(
        String(userTaskText || '')
      );
    return isUnattendedOrLongTask;
  }

  async executeActorWithAutoWake({
    groupId,
    targetGroup,
    actorId,
    routing,
    initialPrompt,
    userTaskText = '',
    attachments = [],
    replyStyle = 'plain',
    maxDisconnectWakeups = 3,
    maxPhaseContinuations = 2,
  }) {
    const autoWakeEnabled = routing?.autoWake !== false;
    let currentRouting = {
      ...routing,
      [actorId]: { ...(routing[actorId] || {}) },
    };

    const runWithDisconnectWakeups = async (promptToRun, stageTag = '') => {
      let disconnectWakeCount = 0;
      let activePrompt = promptToRun;
      while (true) {
        const res = await this.runTargetSessionForActor({
          groupId,
          targetGroup,
          actorId,
          routing: currentRouting,
          prompt: activePrompt,
          attachments,
          replyStyle,
          phase: 'exec',
        });
        if (this.cancelledExternalGroups.has(groupId)) return res;

        const resolvedSid = res?.sessionReceipt?.sessionId || res?.sessionId || '';
        if (resolvedSid) {
          currentRouting = {
            ...currentRouting,
            [actorId]: {
              ...(currentRouting[actorId] || {}),
              mode: 'existing',
              sessionId: resolvedSid,
              cwd: currentRouting[actorId]?.cwd || targetGroup.scopePath || '',
            },
          };
        }

        if (
          res.ok !== false ||
          !autoWakeEnabled ||
          disconnectWakeCount >= maxDisconnectWakeups ||
          !this.isRetryableAutoWakeFailure(res)
        ) {
          return {
            ...res,
            disconnectWakeCount,
            stageTag,
          };
        }

        disconnectWakeCount += 1;
        const actorLabel = actorId === 'codex' ? 'Codex' : 'Antigravity';
        this.setExternalActorThinking(
          groupId,
          actorId,
          `⏰ 检测到 ${actorLabel} 静默中断，正在同会话自动唤醒续跑 (${disconnectWakeCount}/${maxDisconnectWakeups})…`
        );
        activePrompt = `【AChat 长任务自动唤醒续跑 (${disconnectWakeCount}/${maxDisconnectWakeups})】\n检测到上一轮长任务执行因长时间静默或连接中断而暂停。\n请先检查当前工作区已落盘的文件、测试结果与后台进程状态（保留已完成成果，勿重复返工），直接从断点继续完成属于你的剩余任务并汇报最终结果：\n\n${promptToRun}`;
      }
    };

    let currentRes = await runWithDisconnectWakeups(initialPrompt, '');
    if (this.cancelledExternalGroups.has(groupId)) return currentRes;

    let phaseContinuationCount = 0;
    while (
      autoWakeEnabled &&
      currentRes.ok !== false &&
      !currentRes.collabSignal &&
      phaseContinuationCount < maxPhaseContinuations &&
      this.needsLongTaskPhaseContinuation(
        userTaskText || initialPrompt,
        currentRes.rawText || currentRes.text
      )
    ) {
      // Emit intermediate progress bubble so the user has full visibility into each completed stage
      await this.appendExternalDispatchMessage(groupId, {
        by: actorId,
        isUser: false,
        senderTitle: currentRes.actorTitle,
        senderRuntime: actorId,
        to: ['user'],
        insight:
          phaseContinuationCount === 0
            ? currentRes.disconnectWakeCount > 0
              ? `⏰ 自动唤醒续跑成功 · 阶段汇报`
              : `📋 长任务阶段汇报（已自动唤醒下一阶段）`
            : `⏰ 长任务自动接力 (${phaseContinuationCount}/${maxPhaseContinuations})`,
        text: currentRes.text,
        ok: true,
        thoughtTrace: currentRes.thoughtTrace,
        sessionReceipt: currentRes.sessionReceipt,
        retryMeta: {
          actorId,
          prompt: initialPrompt.slice(0, 6000),
          replyStyle,
          attachments,
        },
      });

      phaseContinuationCount += 1;
      const actorLabel = actorId === 'codex' ? 'Codex' : 'Antigravity';
      this.setExternalActorThinking(
        groupId,
        actorId,
        `⏰ 检测到 ${actorLabel} 尚有未闭环阶段，正在同会话自动唤醒推进 (${phaseContinuationCount}/${maxPhaseContinuations})…`
      );

      const continuationPrompt = `【AChat 长任务无人值守自动唤醒推进 (${phaseContinuationCount}/${maxPhaseContinuations})】\n你在上一阶段汇报中提到部分后续步骤尚未执行完毕：\n"""\n${String(currentRes.text || '').slice(-1200)}\n"""\n当前处于长任务自动巡航模式，无需等待用户手动确认。请结合工作区最新状态（及同伴已落盘的最新改动），直接在当前会话继续推进剩余未完成的集成、训练或对照验收闭环，全部完成后汇报最终结果。`;

      currentRes = await runWithDisconnectWakeups(
        continuationPrompt,
        `⏰ 自动唤醒推进 (${phaseContinuationCount}/${maxPhaseContinuations})`
      );
      if (this.cancelledExternalGroups.has(groupId)) return currentRes;
    }

    return {
      ...currentRes,
      phaseContinuationCount,
    };
  }

  async dispatchExternalSessionWorkflow({
    groupId,
    targetGroup,
    recipients,
    cleanText,
    replyStyle,
    routing,
    followUp = false,
  }) {
    this.cancelledExternalGroups.delete(groupId);
    const { cleanText: userPromptOnly, attachments } = parseMessageAttachments(
      cleanText,
      this.uploadsDir
    );
    const promptBody = userPromptOnly || cleanText;

    const targetLabels = recipients.map((r) => {
      const cfg = routing[r] || {};
      if (cfg.mode === 'existing' && cfg.sessionId) {
        return `${r === 'codex' ? 'Codex' : 'Antigravity'} → ${cfg.sessionTitle || cfg.sessionId.slice(0, 8)}`;
      }
      if (cfg.mode === 'new') {
        const base = path.basename(cfg.cwd || targetGroup.scopePath || '项目目录');
        return `${r === 'codex' ? 'Codex' : 'Antigravity'} → ➕新建(${base})`;
      }
      return `${r === 'codex' ? 'Codex' : 'Antigravity'} → 本群会话`;
    });

    const isFollowUpTurn = Boolean(followUp);
    const effectiveFlow = isFollowUpTurn ? 'direct' : routing.flow;

    const userRecord = await this.appendExternalDispatchMessage(groupId, {
      by: 'user',
      isUser: true,
      senderTitle: '我',
      senderRuntime: 'user',
      to: recipients,
      mode: 'send',
      insight: isFollowUpTurn
        ? `➕ 补充跟进 · ${targetLabels.join(' | ')}`
        : `🎯 ${effectiveFlow === 'discuss_then_exec' ? '先商量再执行' : '直达会话'} · ${targetLabels.join(' | ')}`,
      attachments,
      text: promptBody,
    });

    const MAX_COLLAB_ROUNDS = 3;
    const taskTitle = String(promptBody || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 88);

    const runWorkflowAsync = async () => {
      try {
        this.ensureGroupIdeBoard(groupId, {
          taskTitle,
          stageText:
            effectiveFlow === 'discuss_then_exec'
              ? '🤝 正在群内沟通对齐方案与分工…'
              : isFollowUpTurn
                ? '➕ 正在 IDE 会话跟进补充信息…'
                : '🚀 正在派发至目标 IDE 会话执行…',
          round: 1,
          reset: !isFollowUpTurn,
        });

        let alignmentSummary = '';
        const execTargets =
          effectiveFlow === 'discuss_then_exec'
            ? recipients.length >= 2
              ? recipients
              : ['codex', 'antigravity']
            : recipients;

        if (effectiveFlow === 'discuss_then_exec') {
          // Stage 1: Codex drafts concise alignment + initial steps
          this.setExternalActorThinking(groupId, 'codex', '🤝 正在群内拟定简洁分工方案…');
          this.emit('relay', {
            groupId,
            active: true,
            step: 1,
            text: '🤝 群内对齐 1/3：Codex 正在拟定分工方案…',
          });

          const leadRes = await this.runTargetSessionForActor({
            groupId,
            targetGroup,
            actorId: 'codex',
            routing,
            prompt: `用户布置了双 Agent 协作任务：\n\n${promptBody}\n\n【第 1 步：群内快速沟通（只出思路与分工，先不改文件）】：\n请用简明清晰的语言说明核心思路，并严格按行写清分工：\n- Codex 负责：...\n- Antigravity 负责：...\n- 协作同步点：什么情况下需要回到群里跟同伴沟通\n并在回答末尾另起一行附带初始步骤清单（仅供顶部 IDE 看板渲染，用户看不见此标签）：\n<!--achat-steps:[{"title":"步骤1","status":"pending"},{"title":"步骤2","status":"pending"}]-->`,
            attachments,
            replyStyle,
            phase: 'discuss_lead',
            forcePermission: 'read-only',
          });
          this.setExternalActorThinking(groupId, 'codex', '');
          if (this.cancelledExternalGroups.has(groupId)) return;

          await this.appendExternalDispatchMessage(groupId, {
            by: 'codex',
            isUser: false,
            senderTitle: leadRes.actorTitle || 'Codex',
            senderRuntime: 'codex',
            to: ['antigravity', 'user'],
            insight: '🤝 群内沟通 · 分工提案',
            text: leadRes.text,
            thoughtTrace: leadRes.thoughtTrace,
          });

          for (const actorKey of ['codex', 'antigravity']) {
            const sub = extractActorSubtaskHint(leadRes.text, actorKey);
            if (sub || leadRes.parsedSteps?.length) {
              this.updateActorIdeBoardState(groupId, actorKey, {
                ...(sub ? { subtask: sub } : {}),
                ...(leadRes.parsedSteps?.length ? { steps: leadRes.parsedSteps } : {}),
              });
            }
          }

          // Stage 2: Antigravity reviews & locks final division of labor
          this.setExternalActorThinking(groupId, 'antigravity', '🤝 正在复核并拍板分工…');
          this.emit('relay', {
            groupId,
            active: true,
            step: 2,
            text: '🤝 群内对齐 2/3：Antigravity 正在确认分工并准备派往 IDE…',
          });

          const peerRes = await this.runTargetSessionForActor({
            groupId,
            targetGroup,
            actorId: 'antigravity',
            routing,
            prompt: `用户任务：\n${promptBody}\n\nCodex 在群里的分工提案：\n${leadRes.text}\n\n【第 2 步：拍板分工（保持简短，确认后系统将分别派入你们各自的 IDE 会话执行）】：\n请补充确认关键边界与协作节点，明确写清：\n- Codex 负责：...\n- Antigravity 负责：...\n并在末尾附带确认后的步骤标签：\n<!--achat-steps:[{"title":"步骤1","status":"pending"},{"title":"步骤2","status":"pending"}]-->`,
            attachments,
            replyStyle,
            phase: 'discuss_peer',
            forcePermission: 'read-only',
          });
          this.setExternalActorThinking(groupId, 'antigravity', '');
          if (this.cancelledExternalGroups.has(groupId)) return;

          await this.appendExternalDispatchMessage(groupId, {
            by: 'antigravity',
            isUser: false,
            senderTitle: peerRes.actorTitle || 'Antigravity',
            senderRuntime: 'antigravity',
            to: ['codex', 'user'],
            insight: '🤝 群内沟通 · 拍板确认',
            text: peerRes.text,
            thoughtTrace: peerRes.thoughtTrace,
          });

          for (const actorKey of ['codex', 'antigravity']) {
            const sub =
              extractActorSubtaskHint(peerRes.text, actorKey) ||
              extractActorSubtaskHint(leadRes.text, actorKey);
            if (sub || peerRes.parsedSteps?.length) {
              this.updateActorIdeBoardState(groupId, actorKey, {
                ...(sub ? { subtask: sub } : {}),
                ...(peerRes.parsedSteps?.length ? { steps: peerRes.parsedSteps } : {}),
              });
            }
          }

          alignmentSummary = `--- Codex 提案 ---\n${leadRes.text}\n--- Antigravity 拍板 ---\n${peerRes.text}`;

          await this.appendExternalDispatchMessage(groupId, {
            kind: 'system',
            by: 'system',
            text: `🚀 群内已对齐，正在分别派入对应 IDE 会话执行（${targetLabels.join(' · ')}）`,
          });
        }

        const buildIdeProtocolSuffix = (actorKey) => {
          const peerKey = actorKey === 'codex' ? 'antigravity' : 'codex';
          const lines = [
            '【顶部 IDE 进度看板同步规则】：',
            '在回复末尾（或分段推进时）维护一句步骤清单标签（用户界面会自动转为 IDE 进度条）：',
            '<!--achat-steps:[{"title":"关键步骤1","status":"done"},{"title":"关键步骤2","status":"active"}]-->',
            '（思考与工具调用轨迹会自动实时同步到顶部 IDE 看板；聊天最终回复请保持精炼结论，不必写长篇流水账。）',
          ];
          if (execTargets.length >= 2) {
            lines.push(
              '',
              `【回群协作规则】：在 IDE 会话执行过程中，如果你完成了前置依赖、发现与 @${peerKey} 相关的分歧/接口问题、或需要同伴验证接力，请在回复末尾附带一行协作信号：`,
              `<!--achat-collab:{"needCollab":true,"to":"${peerKey}","reason":"一句话原因","message":"回到 AChat 群里要对同伴说的具体沟通内容"}-->`,
              '附带该信号后，系统会立即把你和同伴带回 AChat 群聊完成沟通，再派回 IDE 继续推进。'
            );
          }
          return lines.join('\n');
        };

        const runParallelIdeWave = async (waveActors, waveRound, buildPromptForActor) => {
          const stageMsg =
            waveRound > 1
              ? `🚀 第 ${waveRound} 轮派单：已按群内新共识派回各自 IDE 会话执行…`
              : effectiveFlow === 'discuss_then_exec'
                ? `🚀 派单执行：已在各自目标 IDE 会话并行推进（${targetLabels.join(' · ')}）…`
                : isFollowUpTurn
                  ? `➕ 已在同会话跟进补充信息（${targetLabels.join(' · ')}）…`
                  : `🎯 已直达目标 IDE 会话执行（${targetLabels.join(' · ')}）…`;

          this.ensureGroupIdeBoard(groupId, {
            stageText: stageMsg,
            round: waveRound,
          });
          this.emit('relay', {
            groupId,
            active: true,
            step: waveRound > 1 ? 4 : effectiveFlow === 'discuss_then_exec' ? 3 : 1,
            text: stageMsg,
          });
          for (const actorKey of waveActors) {
            this.updateActorIdeBoardState(groupId, actorKey, { round: waveRound });
            this.setExternalActorThinking(
              groupId,
              actorKey,
              waveRound > 1
                ? `🚀 第 ${waveRound} 轮：正在目标 IDE 会话继续推进…`
                : isFollowUpTurn
                  ? '➕ 正在同会话跟进补充信息…'
                  : '🚀 正在目标 IDE 会话执行任务…'
            );
          }

          return Promise.all(
            waveActors.map(async (r) => {
              try {
                const fullActorPrompt = buildPromptForActor(r);
                const res = await this.executeActorWithAutoWake({
                  groupId,
                  targetGroup,
                  actorId: r,
                  routing,
                  initialPrompt: fullActorPrompt,
                  userTaskText: promptBody,
                  attachments,
                  replyStyle,
                });
                if (this.cancelledExternalGroups.has(groupId)) return { actorId: r, res, cancelled: true };

                const collabReq = res?.ok !== false ? res?.collabSignal : null;
                const msgTo = collabReq?.to && collabReq.to !== 'all' ? [collabReq.to, 'user'] : ['user'];
                const msgText = collabReq?.message
                  ? res.text && res.text.includes(collabReq.message)
                    ? res.text
                    : res.text
                      ? `${res.text}\n\n🤝 回群协作说明：${collabReq.message}`
                      : collabReq.message
                  : res.text;
                const insightText = collabReq
                  ? `🤝 回群请求协作（第${waveRound}轮）· ${collabReq.reason}`
                  : res.stageTag ||
                    (res.disconnectWakeCount > 0
                      ? `⏰ 自动唤醒续跑成功 (${res.disconnectWakeCount}次)`
                      : waveRound > 1
                        ? `🚀 第 ${waveRound} 轮 IDE 执行汇报`
                        : '');

                await this.appendExternalDispatchMessage(groupId, {
                  by: r,
                  isUser: false,
                  senderTitle: res.actorTitle,
                  senderRuntime: r,
                  to: msgTo,
                  insight: insightText,
                  text: msgText,
                  ok: res.ok !== false,
                  thoughtTrace: res.thoughtTrace,
                  sessionReceipt: res.sessionReceipt,
                  retryMeta: {
                    actorId: r,
                    prompt: fullActorPrompt.slice(0, 6000),
                    replyStyle,
                    attachments,
                  },
                });
                return { actorId: r, res };
              } finally {
                this.setExternalActorThinking(groupId, r, '');
              }
            })
          );
        };

        let collabRound = 1;
        let latestWaveResults = await runParallelIdeWave(execTargets, collabRound, (r) => {
          if (effectiveFlow === 'discuss_then_exec') {
            const roleLabel = r === 'codex' ? 'Codex' : 'Antigravity';
            return `【AChat 跨会话正式派单】\n用户原始任务：\n${promptBody}\n\n双方在群内商量拍板的分工方案：\n${alignmentSummary}\n\n请现在立即在当前目标 IDE 会话中执行属于「${roleLabel}」的部分（遵守分工边界），完成后给出精简结论与下一步。\n\n${buildIdeProtocolSuffix(r)}`;
          }
          const followUpPrefix = isFollowUpTurn
            ? '【用户追加补充信息（请结合当前会话正在进行的任务与上下文直接跟进处理，无需重新走分工提案）】：\n'
            : '';
          const peerNote =
            execTargets.length > 1
              ? `\n\n【协作提示：本任务同时派发给了 ${execTargets.join(' 与 ')}，请专注处理属于你的部分并清晰汇报结果。】`
              : '';
          return `${followUpPrefix}${promptBody}${peerNote}\n\n${buildIdeProtocolSuffix(r)}`;
        });

        while (!this.cancelledExternalGroups.has(groupId) && collabRound < MAX_COLLAB_ROUNDS) {
          const collabHits = (latestWaveResults || []).filter(
            (item) => !item.cancelled && item.res?.ok !== false && item.res?.collabSignal?.needCollab
          );
          if (collabHits.length === 0 || execTargets.length < 2) break;

          const collabSummaryLines = [];
          for (const hit of collabHits) {
            const requesterId = hit.actorId;
            const peerId = requesterId === 'codex' ? 'antigravity' : 'codex';
            const sig = hit.res.collabSignal;
            const peerLabel = peerId === 'codex' ? 'Codex' : 'Antigravity';
            const reqLabel = requesterId === 'codex' ? 'Codex' : 'Antigravity';

            this.ensureGroupIdeBoard(groupId, {
              stageText: `🤝 第 ${collabRound} 轮回群协作：${reqLabel} 与 ${peerLabel} 正在群内沟通对齐…`,
              round: collabRound,
            });
            this.emit('relay', {
              groupId,
              active: true,
              step: 2,
              text: `🤝 需要协作：${reqLabel} 与 ${peerLabel} 已回到 AChat 群聊沟通中…`,
            });
            this.setExternalActorThinking(
              groupId,
              peerId,
              `🤝 正在群内回应 ${reqLabel} 的协作请求…`
            );

            const syncPrompt = `【AChat 回群协作沟通（第 ${collabRound} 轮）】\n${reqLabel} 在 IDE 执行任务途中回到群里向你发起协作请求：\n\n原因：${sig.reason}\n${reqLabel} 的沟通内容：\n"""\n${sig.message}\n"""\n\n用户总任务背景：\n${promptBody}\n\n请直接针对 ${reqLabel} 的请求在群聊中回复明确结论、接口/方案确认或下一步分工配合（保持精炼实用），随后系统会把新共识派回你们各自的 IDE 会话继续推进。\n可在末尾更新步骤标签 <!--achat-steps:[...]-->。`;

            const peerSyncRes = await this.runTargetSessionForActor({
              groupId,
              targetGroup,
              actorId: peerId,
              routing,
              prompt: syncPrompt,
              attachments,
              replyStyle,
              phase: 'collab_sync',
              forcePermission: 'read-only',
            });
            this.setExternalActorThinking(groupId, peerId, '');
            if (this.cancelledExternalGroups.has(groupId)) break;

            await this.appendExternalDispatchMessage(groupId, {
              by: peerId,
              isUser: false,
              senderTitle: peerSyncRes.actorTitle || peerLabel,
              senderRuntime: peerId,
              to: [requesterId, 'user'],
              insight: `🤝 回群协作回应（第${collabRound}轮）· 回复 @${reqLabel}`,
              text: peerSyncRes.text,
              ok: peerSyncRes.ok !== false,
              thoughtTrace: peerSyncRes.thoughtTrace,
            });

            collabSummaryLines.push(
              `[${reqLabel} 发起请求]: ${sig.message}\n[${peerLabel} 群内回应]: ${peerSyncRes.text}`
            );
          }

          if (this.cancelledExternalGroups.has(groupId) || collabSummaryLines.length === 0) break;

          collabRound += 1;
          const collabContextBlock = collabSummaryLines.join('\n\n');
          await this.appendExternalDispatchMessage(groupId, {
            kind: 'system',
            by: 'system',
            text: `🤝 群内协作沟通已完成，正将新共识派回各自 IDE 会话继续执行（第 ${collabRound} 轮）`,
          });

          latestWaveResults = await runParallelIdeWave(execTargets, collabRound, (r) => {
            const roleLabel = r === 'codex' ? 'Codex' : 'Antigravity';
            return `【AChat 回群协作后继续派单（第 ${collabRound} 轮）】\n用户原始任务：\n${promptBody}\n\n刚才在 AChat 群聊里刚达成的协作沟通结果：\n${collabContextBlock}\n\n请「${roleLabel}」结合上述群内最新共识，继续在当前目标 IDE 会话完成你的剩余工作并汇报结果。\n\n${buildIdeProtocolSuffix(r)}`;
          });
        }

        if (!this.cancelledExternalGroups.has(groupId)) {
          const hadFailure = (latestWaveResults || []).some((item) => item.res?.ok === false);
          this.ensureGroupIdeBoard(groupId, {
            stageText: hadFailure
              ? '⚠️ 部分 IDE 会话执行异常，可点击下方消息重试'
              : '✅ 双端 IDE 任务已协同完成',
            round: collabRound,
          });
        }
      } finally {
        this.emit('relay', { groupId, active: false, step: 0, text: '' });
        this.listGroups({ force: true })
          .then((gs) => this.emit('groups', gs))
          .catch(() => {});
      }
    };

    runWorkflowAsync().catch(() => {});
    return userRecord;
  }

  async retrySingleActor(groupId, { actorId, messageId = '', prompt = '' } = {}) {
    const safeActor = String(actorId || '').trim();
    if (!safeActor) throw new Error('请指定需要重试的 Agent');

    let groups = this.groupMetaCache.data;
    let targetGroup = Array.isArray(groups) ? groups.find((g) => g.id === groupId) : null;
    if (!targetGroup) {
      await this.ensureDaemonRunning();
      groups = await this.listGroups();
      targetGroup = groups.find((g) => g.id === groupId);
    }
    if (!targetGroup) throw new Error(`找不到群聊 ${groupId}`);

    const savedPrefs = this.groupPrefs[groupId] || {};
    const replyStyle = normalizeReplyStyle(savedPrefs.replyStyle);
    const routing = normalizeSessionRouting(savedPrefs.sessionRouting, targetGroup.scopePath || '');
    const allMsgs = await this.getMessages(groupId);

    const matchedBubble = messageId ? allMsgs.find((m) => m.id === messageId) : null;
    const isExtBubble =
      Boolean(matchedBubble?.sessionReceipt || matchedBubble?.retryMeta) ||
      isAgentRoutedExternally(routing, safeActor);

    let resolvedPrompt = String(prompt || matchedBubble?.retryMeta?.prompt || '').trim();
    let resolvedAttachments = Array.isArray(matchedBubble?.retryMeta?.attachments)
      ? matchedBubble.retryMeta.attachments
      : [];

    if (!resolvedPrompt) {
      for (let i = allMsgs.length - 1; i >= 0; i -= 1) {
        if (allMsgs[i]?.isUser && String(allMsgs[i].text || '').trim()) {
          resolvedPrompt = String(allMsgs[i].text).trim();
          if (!resolvedAttachments.length && Array.isArray(allMsgs[i].attachments)) {
            resolvedAttachments = allMsgs[i].attachments;
          }
          break;
        }
      }
    }
    if (!resolvedPrompt) {
      throw new Error('未找到可重试的上文任务内容');
    }

    if (isExtBubble) {
      this.cancelledExternalGroups.delete(groupId);
      this.setExternalActorThinking(groupId, safeActor, '↻ 正在单独重试该目标会话…');
      const runSingleExt = async () => {
        try {
          const res = await this.runTargetSessionForActor({
            groupId,
            targetGroup,
            actorId: safeActor,
            routing,
            prompt: resolvedPrompt,
            attachments: resolvedAttachments,
            replyStyle: matchedBubble?.retryMeta?.replyStyle || replyStyle,
            phase: 'exec',
          });
          if (this.cancelledExternalGroups.has(groupId)) return;
          await this.appendExternalDispatchMessage(groupId, {
            by: safeActor,
            isUser: false,
            senderTitle: res.actorTitle,
            senderRuntime: safeActor,
            to: ['user'],
            insight: `↻ 单独重试 · ${res.actorTitle}`,
            text: res.text,
            ok: res.ok !== false,
            thoughtTrace: res.thoughtTrace,
            sessionReceipt: res.sessionReceipt,
            retryMeta: {
              actorId: safeActor,
              prompt: resolvedPrompt.slice(0, 6000),
              replyStyle: matchedBubble?.retryMeta?.replyStyle || replyStyle,
              attachments: resolvedAttachments,
            },
          });
        } finally {
          this.setExternalActorThinking(groupId, safeActor, '');
          this.listGroups({ force: true })
            .then((gs) => this.emit('groups', gs))
            .catch(() => {});
        }
      };
      runSingleExt().catch(() => {});
      return { ok: true, mode: 'external', actorId: safeActor };
    }

    // Normal group chat single-actor retry without waking peer actor
    const actorObj = (targetGroup.actors || []).find((a) => a.id === safeActor);
    if (actorObj && !actorObj.running && actorObj.enabled !== false) {
      await this.execFn(['actor', 'start', '--group', groupId, safeActor], {
        timeout: 20000,
      }).catch(() => {});
    }
    const styleNote = buildReplyStyleDirective(replyStyle);
    const retryPayload = `<!--aw-retry-->[单独重试提醒：只需你（@${safeActor}）直接回复用户以下待处理消息，同伴无需重复回答]\n\n${resolvedPrompt}\n\n${styleNote}`;
    await this.execFn(
      [
        'send',
        '--group',
        groupId,
        '--by',
        'user',
        '--to',
        safeActor,
        '--mode',
        'request-reply',
        '--',
        retryPayload,
      ],
      { timeout: 15000 }
    );
    if (!this.isMockExec && safeActor === 'codex') {
      const nudgeTimer = setTimeout(() => {
        this.ptyEnterNudgeFn(groupId, safeActor).catch(() => {});
      }, 3800);
      nudgeTimer.unref?.();
    }
    this.groupMetaCache.ts = 0;
    const updatedGroups = await this.listGroups({ force: true });
    return { ok: true, mode: 'group', actorId: safeActor, groups: updatedGroups };
  }

  async sendGroupMessage(
    groupId,
    {
      text,
      to = [],
      mode = 'send',
      sharedContext = true,
      collabMode,
      relayLead,
      replyStyle,
      sessionRouting,
      quote = null,
      followUp = false,
    } = {}
  ) {
    let cleanText = stripSharedContextBlock(String(text || '').trim());
    if (quote && typeof quote === 'object' && quote.text) {
      const qSender = String(quote.sender || '群成员').trim();
      const qSnippet = String(quote.text || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 180);
      if (qSnippet) {
        cleanText = cleanText
          ? `> 引用 ${qSender}：${qSnippet}\n\n${cleanText}`
          : `> 引用 ${qSender}：${qSnippet}`;
      }
    }
    if (!cleanText) throw new Error('消息内容不能为空');

    if (groupId === 'file-helper') {
      return this.appendFileHelperMessage(cleanText);
    }

    if (this.standbyMode) {
      await this.wakeFromStandby();
    }

    // Fast path: reuse warm group metadata without spawning extra status/list subprocesses
    let groups = this.groupMetaCache.data;
    let targetGroup = Array.isArray(groups) ? groups.find((g) => g.id === groupId) : null;
    if (!targetGroup) {
      await this.ensureDaemonRunning();
      groups = await this.listGroups();
      targetGroup = groups.find((g) => g.id === groupId);
    }
    if (!targetGroup) throw new Error(`找不到群聊 ${groupId}`);

    const savedPrefs = this.groupPrefs[groupId] || {};
    const effectiveCollab = ['free', 'relay', 'blind'].includes(collabMode)
      ? collabMode
      : savedPrefs.collabMode || 'free';
    const effectiveLead = relayLead || savedPrefs.relayLead || 'codex';
    const effectiveReplyStyle = VALID_REPLY_STYLES.includes(replyStyle)
      ? replyStyle
      : normalizeReplyStyle(savedPrefs.replyStyle);
    const effectiveRouting = normalizeSessionRouting(
      sessionRouting && typeof sessionRouting === 'object'
        ? sessionRouting
        : savedPrefs.sessionRouting,
      targetGroup.scopePath || ''
    );

    if (
      savedPrefs.collabMode !== effectiveCollab ||
      (relayLead && savedPrefs.relayLead !== effectiveLead) ||
      (VALID_REPLY_STYLES.includes(replyStyle) && savedPrefs.replyStyle !== effectiveReplyStyle) ||
      (sessionRouting && typeof sessionRouting === 'object')
    ) {
      this.groupPrefs[groupId] = {
        ...savedPrefs,
        collabMode: effectiveCollab,
        relayLead: effectiveLead,
        replyStyle: effectiveReplyStyle,
        sessionRouting: effectiveRouting,
      };
      this.saveGroupPrefs().catch(() => {});
    }

    // Clear any unfinished relay pipeline when user starts a fresh turn
    if (this.pendingRelays.has(groupId) || this.activeRelayReviewers.has(groupId)) {
      this.pendingRelays.delete(groupId);
      this.activeRelayReviewers.delete(groupId);
      this.emit('relay', { groupId, active: false, step: 0, text: '' });
    }

    const extraProviderMentions = [];
    for (const extraId of ['claude', 'opencode', 'ollama']) {
      const re = new RegExp(`@${extraId}\\b`, 'i');
      if (re.test(cleanText) || (Array.isArray(to) && to.includes(extraId))) {
        extraProviderMentions.push(extraId);
      }
    }

    const preResolvedRecipients = this.resolveRecipients(cleanText, to, targetGroup.actors);
    const anyRecipientExternal =
      extraProviderMentions.length > 0 ||
      preResolvedRecipients.some((r) => isAgentRoutedExternally(effectiveRouting, r));
    const anyGroupExternalForDiscuss =
      effectiveRouting.flow === 'discuss_then_exec' &&
      (isAgentRoutedExternally(effectiveRouting, 'codex') ||
        isAgentRoutedExternally(effectiveRouting, 'antigravity'));

    if (anyRecipientExternal || anyGroupExternalForDiscuss) {
      const mergedExternalRecipients =
        extraProviderMentions.length > 0
          ? Array.from(
              new Set([
                ...extraProviderMentions,
                ...preResolvedRecipients.filter((r) => isAgentRoutedExternally(effectiveRouting, r)),
              ])
            )
          : preResolvedRecipients.length > 0
            ? preResolvedRecipients
            : ['codex', 'antigravity'];
      const effectiveRoutingForTurn =
        extraProviderMentions.length > 0 && effectiveRouting.flow === 'discuss_then_exec'
          ? { ...effectiveRouting, flow: 'direct' }
          : effectiveRouting;
      return this.dispatchExternalSessionWorkflow({
        groupId,
        targetGroup,
        recipients: mergedExternalRecipients,
        cleanText,
        replyStyle: effectiveReplyStyle,
        routing: effectiveRoutingForTurn,
        followUp: Boolean(followUp),
      });
    }

    const enabledActors = (targetGroup.actors || []).filter((a) => a.enabled !== false);
    let recipients = [];
    let payloadText = '';

    if (effectiveCollab === 'relay' && enabledActors.length >= 2) {
      const leadActor =
        enabledActors.find((a) => a.id === effectiveLead) || enabledActors[0];
      const reviewerActor =
        enabledActors.find((a) => a.id !== leadActor.id) || enabledActors[1];

      const baselineLedger = await this.readGroupLedger(groupId);
      const baselineIds = new Set((baselineLedger.messages || []).map((m) => m.id));
      const rawAttachmentRefs = cleanText.match(/\[(图片|文件):\s*[^\]]+\]/g) || [];
      const { cleanText: userPromptOnly } = parseMessageAttachments(cleanText, this.uploadsDir);

      this.pendingRelays.set(groupId, {
        userPrompt: userPromptOnly || cleanText,
        rawAttachmentRefs,
        leadId: leadActor.id,
        leadTitle: leadActor.title || leadActor.id,
        reviewerId: reviewerActor.id,
        reviewerTitle: reviewerActor.title || reviewerActor.id,
        replyStyle: effectiveReplyStyle,
        baselineIds,
      });

      this.emit('relay', {
        groupId,
        active: true,
        step: 1,
        leadTitle: leadActor.title || leadActor.id,
        reviewerTitle: reviewerActor.title || reviewerActor.id,
        text: `🔁 接力 1/2：正由 ${leadActor.title || leadActor.id} 生成初稿（完成后自动转交 ${reviewerActor.title || reviewerActor.id} 复核）…`,
      });

      recipients = [leadActor.id];
      payloadText = await this.buildOutgoingMessagePayload(groupId, cleanText, {
        sharedContext: sharedContext !== false,
        fastHint: true,
        replyStyle: effectiveReplyStyle,
        extraSystemNote: `[主从自动接力 1/2：你是本轮主笔 ${leadActor.title || leadActor.id}，请直接向 user 给出清晰初稿结论；系统收到你的回复后会自动转发给 ${reviewerActor.title || reviewerActor.id} 做二阶段复核，你无需手动 @ 同伴]`,
      });
    } else if (effectiveCollab === 'blind') {
      recipients = this.resolveRecipients(cleanText, to, targetGroup.actors);
      payloadText = await this.buildOutgoingMessagePayload(groupId, cleanText, {
        sharedContext: false,
        fastHint: true,
        replyStyle: effectiveReplyStyle,
        extraSystemNote:
          '[双盲独立对撞模式：已隔离同伴近期回复，请勿读取历史同伴发言，完全独立给出你的判断与依据供用户交叉比对]',
      });
    } else {
      recipients = this.resolveRecipients(cleanText, to, targetGroup.actors);
      payloadText = await this.buildOutgoingMessagePayload(groupId, cleanText, {
        sharedContext: sharedContext !== false,
        fastHint: true,
        replyStyle: effectiveReplyStyle,
      });
    }

    if (recipients.length === 0) {
      throw new Error('当前群聊中还没有可接收消息的 Agent 成员');
    }

    // Auto-wake any stopped target actor (and restore active group delivery state if stopped in Standby)
    let liveGroupActors = targetGroup.actors || [];
    if (
      targetGroup.state === 'stopped' ||
      targetGroup.state === 'paused' ||
      targetGroup.running === false
    ) {
      await this.execFn(['group', 'set-state', '--group', groupId, 'active'], {
        timeout: 10000,
      }).catch(() => {});
      const freshActorsRes = await this.queryGroupActors(groupId).catch(() => null);
      if (Array.isArray(freshActorsRes?.actors)) {
        liveGroupActors = freshActorsRes.actors;
      }
    }
    const stoppedTargets = liveGroupActors.filter(
      (a) => recipients.includes(a.id) && a.enabled !== false && !a.running
    );
    if (stoppedTargets.length > 0) {
      await Promise.all(
        stoppedTargets.map(async (a) => {
          const sessionFile = path.join(
            this.groupsDir,
            groupId,
            'state',
            'runtime_sessions',
            `${a.id}.json`
          );
          try {
            const raw = await fsp.readFile(sessionFile, 'utf8');
            if (JSON.parse(raw)?.status === 'resume_failed') {
              await fsp.unlink(sessionFile).catch(() => {});
            }
          } catch {
            // ignore
          }
          await this.execFn(['actor', 'start', '--group', groupId, a.id], {
            timeout: 15000,
          }).catch(() => {});
          await this.waitForActorComposerReady(groupId, a.id);
        })
      );
      this.groupMetaCache.ts = 0;
    }

    const safeMode = mode === 'request-reply' || mode === 'request_reply' ? 'request-reply' : 'send';
    const args = [
      'send',
      '--group',
      groupId,
      '--by',
      'user',
      ...recipients.flatMap((r) => ['--to', r]),
      '--mode',
      safeMode,
      '--',
      payloadText,
    ];

    try {
      await this.execFn(args, { timeout: 15000 });
    } catch {
      await this.ensureDaemonRunning();
      await this.execFn(args, { timeout: 15000 });
    }
    this.groupMetaCache.ts = 0;

    // Immediately read ledger (which also emits SSE message & thinking activity!)
    const ledger = await this.readGroupLedger(groupId);
    return ledger.messages[ledger.messages.length - 1] || { ok: true, recipients };
  }

  async controlActor(groupId, actorId, action) {
    if (!['start', 'stop', 'restart'].includes(action)) {
      throw new Error(`不支持的操作：${action}`);
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(actorId) || !/^[a-zA-Z0-9_-]+$/.test(groupId)) {
      throw new Error('非法的 ID 参数');
    }
    await this.ensureDaemonRunning();
    if (action === 'start' || action === 'restart') {
      const sessionFile = path.join(
        this.groupsDir,
        groupId,
        'state',
        'runtime_sessions',
        `${actorId}.json`
      );
      try {
        const raw = await fsp.readFile(sessionFile, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed?.status === 'resume_failed') {
          await fsp.unlink(sessionFile).catch(() => {});
        }
      } catch {
        // ignore if absent
      }
    }
    await this.execFn(['actor', action, '--group', groupId, actorId], { timeout: 20000 });
    if (actorId === 'antigravity' && action !== 'stop') {
      await repinMcpConfig();
    }
    this.groupMetaCache.ts = 0;
    return this.listGroups({ force: true });
  }

  async createGroup({
    title,
    topic = '',
    projectPath = '',
    codexSandbox = 'read-only',
    speedGear = 'fast',
    includeCodex = true,
    includeAntigravity = true,
  }) {
    const cleanTitle = String(title || '').trim();
    if (!cleanTitle) throw new Error('请输入群聊名称');

    const targetDir = String(projectPath || '').trim() || DEFAULT_ROOM_DIR;
    if (!fs.existsSync(targetDir)) {
      throw new Error(`绑定目录不存在：${targetDir}`);
    }

    const safeGear = speedGear === 'deep' ? 'deep' : 'fast';
    await this.ensureDaemonRunning();
    const created = await this.execJsonFn([
      'group',
      'create',
      '--title',
      cleanTitle,
      '--topic',
      String(topic || '').trim(),
    ]);
    const groupId = created?.group_id || created?.group?.group_id;
    if (!groupId) {
      throw new Error('创建群聊未返回 group_id');
    }

    await this.execFn(['attach', '--group', groupId, targetDir], { cwd: targetDir });

    if (includeCodex) {
      const codexBin = await resolveCodexBinary();
      const sandboxMode = codexSandbox === 'workspace-write' ? 'workspace-write' : 'read-only';
      const codexCmd = buildCodexLaunchCommand(codexBin, {
        sandbox: sandboxMode,
        gear: safeGear,
      });
      await this.execFn([
        'actor',
        'add',
        '--group',
        groupId,
        '--title',
        'Codex',
        '--runtime',
        'codex',
        '--command',
        codexCmd,
        'codex',
      ]);
    }

    if (includeAntigravity && fs.existsSync(AGY_BIN)) {
      const agyCmd = buildAntigravityLaunchCommand(AGY_BIN, { gear: safeGear });
      await this.execFn([
        'actor',
        'add',
        '--group',
        groupId,
        '--title',
        'Antigravity',
        '--runtime',
        'antigravity',
        '--command',
        agyCmd,
        'antigravity',
      ]);
    }

    this.groupPrefs[groupId] = {
      speedGear: safeGear,
      collabMode: 'free',
      relayLead: 'codex',
    };
    await this.saveGroupPrefs();

    await this.execFn(['group', 'start', '--group', groupId]);
    await repinMcpConfig();
    this.groupMetaCache.ts = 0;
    const groups = await this.listGroups({ force: true });
    return groups.find((g) => g.id === groupId) || { id: groupId, title: cleanTitle };
  }

  async updateGroupSettings(groupId, { title, topic, codexSandbox } = {}) {
    if (!groupId || !/^[a-zA-Z0-9_-]+$/.test(groupId) || groupId === 'file-helper') {
      throw new Error('不支持修改该会话的群配置');
    }
    await this.ensureDaemonRunning();

    const updateArgs = ['group', 'update', '--group', groupId];
    let hasGroupMetaUpdate = false;
    if (typeof title === 'string') {
      const cleanTitle = title.trim();
      if (!cleanTitle) throw new Error('群聊名称不能为空');
      updateArgs.push('--title', cleanTitle);
      hasGroupMetaUpdate = true;
    }
    if (typeof topic === 'string') {
      updateArgs.push('--topic', topic.trim());
      hasGroupMetaUpdate = true;
    }
    if (hasGroupMetaUpdate) {
      await this.execFn(updateArgs, { timeout: 15000 });
    }

    if (codexSandbox === 'read-only' || codexSandbox === 'workspace-write') {
      const [showData, actorsData] = await Promise.all([
        this.queryGroupShow(groupId).catch(() => ({})),
        this.queryGroupActors(groupId).catch(() => ({ actors: [] })),
      ]);
      const showActors = showData?.group?.actors || [];
      const liveActors = Array.isArray(actorsData?.actors) ? actorsData.actors : showActors;
      for (const a of liveActors) {
        const runtime = String(a.runtime || a.id || '').toLowerCase();
        if (a.id !== 'codex' && !runtime.includes('codex')) continue;
        const cfgActor = showActors.find((x) => x.id === a.id) || a;
        const cmdArr = Array.isArray(cfgActor.command)
          ? cfgActor.command
          : Array.isArray(a.command)
            ? a.command
            : [];
        const existingGear = detectActorSpeedGear(cmdArr);
        const codexBin =
          cmdArr[0] && fs.existsSync(cmdArr[0]) ? cmdArr[0] : await resolveCodexBinary();
        const newCmd = buildCodexLaunchCommand(codexBin, {
          sandbox: codexSandbox,
          gear: existingGear,
        });
        await this.execFn(['actor', 'update', '--group', groupId, '--command', newCmd, a.id], {
          timeout: 15000,
        });
        if (a.running || a.enabled !== false) {
          await this.unlinkBrokenRuntimeSession(groupId, a.id);
          const act = a.running ? 'restart' : 'start';
          await this.execFn(['actor', act, '--group', groupId, a.id], { timeout: 20000 }).catch(
            () => {}
          );
        }
      }
    }

    this.groupMetaCache.ts = 0;
    return this.listGroups({ force: true });
  }

  async manageGroupLifecycle(groupId, { action, confirmId = '' } = {}) {
    if (!groupId || !/^[a-zA-Z0-9_-]+$/.test(groupId) || groupId === 'file-helper') {
      throw new Error('该会话不支持归档或删除操作');
    }
    await this.ensureDaemonRunning();

    if (action === 'archive') {
      await this.execFn(['group', 'stop', '--group', groupId], { timeout: 20000 }).catch(() => {});
      await this.setGroupPrefs(groupId, { archived: true, pinned: false });
      const groups = await this.listGroups({ force: true });
      return { ok: true, action: 'archive', groups };
    }

    if (action === 'restore') {
      await this.setGroupPrefs(groupId, { archived: false });
      await this.execFn(['group', 'start', '--group', groupId], { timeout: 20000 }).catch(() => {});
      const groups = await this.listGroups({ force: true });
      return { ok: true, action: 'restore', groups };
    }

    if (action === 'delete') {
      if (String(confirmId || '').trim() !== groupId) {
        throw new Error('确认群 ID 不一致，已取消删除操作');
      }
      const watcher = this.groupWatchers.get(groupId);
      if (watcher) {
        clearTimeout(watcher.debounceTimer);
        try {
          watcher.watcher.close();
        } catch {
          // ignore
        }
        this.groupWatchers.delete(groupId);
      }
      await this.execFn(['group', 'delete', '--group', groupId, '--confirm', groupId], {
        timeout: 20000,
      });
      delete this.groupPrefs[groupId];
      await this.saveGroupPrefs();
      this.ledgerCache.delete(groupId);
      this.ledgerBaseCache.delete(groupId);
      this.extDispatchCache.delete(groupId);
      this.ledgerParseStats.delete(groupId);
      this.emittedMessageIds.delete(groupId);
      this.lastThinkingKey.delete(groupId);
      this.groupMetaCache.ts = 0;
      const groups = await this.listGroups({ force: true });
      return { ok: true, action: 'delete', deletedGroupId: groupId, groups };
    }

    throw new Error(`不支持的群管理操作：${action}`);
  }

  async loadClientSyncState() {
    if (this.clientSyncState) return this.clientSyncState;
    try {
      if (fs.existsSync(this.clientSyncPath)) {
        const parsed = JSON.parse(await fsp.readFile(this.clientSyncPath, 'utf8')) || {};
        this.clientSyncState = {
          stars: Array.isArray(parsed.stars) ? parsed.stars : [],
          templates: Array.isArray(parsed.templates) ? parsed.templates : [],
          updatedAt: parsed.updatedAt || new Date().toISOString(),
        };
        return this.clientSyncState;
      }
    } catch {
      // fall through to clean empty state
    }
    this.clientSyncState = {
      stars: [],
      templates: [],
      updatedAt: new Date().toISOString(),
    };
    return this.clientSyncState;
  }

  async saveClientSyncState() {
    await fsp.mkdir(this.dataDir, { recursive: true });
    const payload = this.clientSyncState || {
      stars: [],
      templates: [],
      updatedAt: new Date().toISOString(),
    };
    payload.updatedAt = new Date().toISOString();
    await fsp.writeFile(this.clientSyncPath, JSON.stringify(payload, null, 2), 'utf8');
    return payload;
  }

  async getClientSyncState() {
    const cur = await this.loadClientSyncState();
    return {
      stars: [...cur.stars],
      templates: [...cur.templates],
      updatedAt: cur.updatedAt,
    };
  }

  async mutateClientSyncState({
    upsertStars = [],
    removeStarIds = [],
    upsertTemplates = [],
    removeTemplateIds = [],
  } = {}) {
    const cur = await this.loadClientSyncState();
    const starMap = new Map(cur.stars.map((s) => [String(s.id), s]));

    if (Array.isArray(removeStarIds)) {
      for (const rawId of removeStarIds) {
        starMap.delete(String(rawId || ''));
      }
    }

    if (Array.isArray(upsertStars)) {
      for (const item of upsertStars) {
        if (!item || !item.id) continue;
        const id = String(item.id).slice(0, 140);
        const existing = starMap.get(id);
        starMap.set(id, {
          id,
          groupId: String(item.groupId || existing?.groupId || '').slice(0, 80),
          groupTitle: String(item.groupTitle || existing?.groupTitle || '群聊').slice(0, 100),
          senderTitle: String(item.senderTitle || existing?.senderTitle || 'Agent').slice(0, 80),
          text: String(item.text ?? existing?.text ?? '').slice(0, 12000),
          ts: String(item.ts || existing?.ts || new Date().toISOString()).slice(0, 48),
          starredAt: existing?.starredAt || item.starredAt || new Date().toISOString(),
        });
      }
    }

    const starsSorted = Array.from(starMap.values())
      .sort((a, b) => new Date(b.starredAt || b.ts || 0) - new Date(a.starredAt || a.ts || 0))
      .slice(0, 500);

    const tplMap = new Map(cur.templates.map((t) => [String(t.id), t]));
    if (Array.isArray(removeTemplateIds)) {
      for (const rawId of removeTemplateIds) {
        tplMap.delete(String(rawId || ''));
      }
    }

    if (Array.isArray(upsertTemplates)) {
      for (const item of upsertTemplates) {
        if (!item || !item.prompt) continue;
        const id = String(
          item.id || `tpl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
        ).slice(0, 80);
        let rawCmd = String(item.cmd || '/tpl')
          .trim()
          .replace(/\s+/g, '');
        if (!rawCmd.startsWith('/')) rawCmd = `/${rawCmd}`;
        rawCmd = rawCmd.slice(0, 28);
        tplMap.set(id, {
          id,
          cmd: rawCmd,
          label: String(item.label || rawCmd.slice(1)).trim().slice(0, 60),
          prompt: String(item.prompt).trim().slice(0, 8000),
        });
      }
    }

    cur.stars = starsSorted;
    cur.templates = Array.from(tplMap.values()).slice(0, 60);
    await this.saveClientSyncState();
    const snapshot = await this.getClientSyncState();
    this.emit('clientSync', snapshot);
    return snapshot;
  }

  async resolveGroupScopeDirectory(groupId) {
    if (!groupId || !/^[a-zA-Z0-9_-]+$/.test(groupId)) {
      throw new Error('非法的群聊 ID');
    }
    const groups = this.groupMetaCache.data || (await this.listGroups({ force: true }));
    let target = groups.find((g) => g.id === groupId);
    if (!target) {
      const refreshed = await this.listGroups({ force: true });
      target = refreshed.find((g) => g.id === groupId);
    }
    if (!target || !target.scopePath) return '';
    const resolved = path.resolve(target.scopePath);
    if (!fs.existsSync(resolved)) return '';
    return resolved;
  }

  async searchScopeFiles(groupId, { query = '', limit = 30 } = {}) {
    const scopeRoot = await this.resolveGroupScopeDirectory(groupId);
    if (!scopeRoot) {
      return { scopePath: '', files: [] };
    }

    const IGNORED_DIRS = new Set([
      '.git',
      'node_modules',
      'dist',
      'build',
      'out',
      '.next',
      '.nuxt',
      '.venv',
      'venv',
      '__pycache__',
      '.gradle',
      '.idea',
      '.vs',
      'target',
      'coverage',
      'build-cache',
    ]);

    const q = String(query || '')
      .trim()
      .replace(/\\/g, '/')
      .toLowerCase();
    const maxLimit = Math.max(1, Math.min(80, Number(limit) || 30));
    const collected = [];
    const queue = [{ dir: scopeRoot, depth: 0 }];
    let scannedCount = 0;

    while (queue.length > 0 && scannedCount < 2800) {
      const { dir, depth } = queue.shift();
      let entries = [];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of entries) {
        if (scannedCount >= 2800) break;
        const name = ent.name;
        if (!name || name === '.' || name === '..') continue;
        if (ent.isDirectory()) {
          if (IGNORED_DIRS.has(name) || (name.startsWith('.') && name !== '.github')) continue;
          if (depth < 6) {
            queue.push({ dir: path.join(dir, name), depth: depth + 1 });
          }
          continue;
        }
        if (!ent.isFile()) continue;
        scannedCount += 1;
        const fullPath = path.join(dir, name);
        const relNative = path.relative(scopeRoot, fullPath);
        if (!relNative || relNative.startsWith('..') || path.isAbsolute(relNative)) continue;
        const relPath = relNative.split(path.sep).join('/');
        const lowerBase = name.toLowerCase();
        const lowerRel = relPath.toLowerCase();

        if (q) {
          let score = 0;
          if (lowerBase === q) score = 100;
          else if (lowerBase.startsWith(q)) score = 80;
          else if (lowerBase.includes(q)) score = 60;
          else if (lowerRel.includes(q)) score = 40;
          if (score === 0) continue;
          collected.push({ relPath, name, depth, score });
        } else {
          collected.push({ relPath, name, depth, score: Math.max(1, 20 - depth * 3) });
        }
      }
    }

    collected.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.depth !== b.depth) return a.depth - b.depth;
      return a.relPath.localeCompare(b.relPath);
    });

    return {
      scopePath: scopeRoot,
      files: collected.slice(0, maxLimit).map(({ relPath, name }) => ({ relPath, name })),
    };
  }

  async getScopeGitSummary(groupId, { file = '', maxDiffChars = 24000 } = {}) {
    const scopeRoot = await this.resolveGroupScopeDirectory(groupId);
    if (!scopeRoot) {
      return { isRepo: false, scopePath: '', branch: '', changedFiles: [], diff: '' };
    }

    let cleanRelFile = '';
    if (typeof file === 'string' && file.trim()) {
      const raw = file.trim().replace(/\\/g, '/');
      if (raw.includes('\0') || raw.startsWith('-')) {
        throw new Error('非法的文件参数');
      }
      const candidateFull = path.resolve(scopeRoot, raw);
      const relBack = path.relative(scopeRoot, candidateFull);
      if (!relBack || relBack.startsWith('..') || path.isAbsolute(relBack)) {
        throw new Error('不允许访问绑定工作目录以外的路径');
      }
      cleanRelFile = relBack.split(path.sep).join('/');
    }

    const runGit = (args) =>
      new Promise((resolve, reject) => {
        execFile(
          'git',
          args,
          {
            cwd: scopeRoot,
            timeout: 6000,
            maxBuffer: 4 * 1024 * 1024,
            windowsHide: true,
          },
          (err, stdout, stderr) => {
            if (err) {
              const e = new Error((stderr || err.message || '').trim());
              e.stderr = stderr;
              return reject(e);
            }
            resolve(String(stdout || ''));
          }
        );
      });

    let statusOut = '';
    try {
      statusOut = await runGit(['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-b', '-uall']);
    } catch {
      return { isRepo: false, scopePath: scopeRoot, branch: '', changedFiles: [], files: [], diff: '' };
    }

    const lines = statusOut.split(/\r?\n/).filter(Boolean);
    let branch = '';
    const changedFiles = [];
    for (const line of lines) {
      if (line.startsWith('## ')) {
        branch = line.slice(3).split('...')[0].trim();
        continue;
      }
      const status = line.slice(0, 2).trim() || 'M';
      let rawFile = line.slice(3).trim();
      const arrowIdx = rawFile.indexOf(' -> ');
      if (arrowIdx >= 0) {
        rawFile = rawFile.slice(arrowIdx + 4).trim();
      }
      rawFile = rawFile.replace(/^"+|"+$/g, '');
      if (rawFile) {
        changedFiles.push({ status, path: rawFile });
      }
    }

    let rawDiff = '';
    const matchedEntry = cleanRelFile
      ? changedFiles.find((f) => f.path === cleanRelFile)
      : null;

    if (cleanRelFile && matchedEntry?.status === '??') {
      try {
        const fullNew = path.resolve(scopeRoot, cleanRelFile);
        const content = await fsp.readFile(fullNew, 'utf8');
        const bodyLines = content
          .split(/\r?\n/)
          .map((l) => `+${l}`)
          .join('\n');
        rawDiff = `--- /dev/null\n+++ b/${cleanRelFile}\n@@ 新建未跟踪文件 @@\n${bodyLines}`;
      } catch {
        rawDiff = '';
      }
    } else if (cleanRelFile) {
      rawDiff = await runGit(['-c', 'core.quotepath=false', 'diff', 'HEAD', '--', cleanRelFile]).catch(
        () => runGit(['-c', 'core.quotepath=false', 'diff', '--', cleanRelFile]).catch(() => '')
      );
    } else if (changedFiles.length > 0) {
      rawDiff = await runGit(['-c', 'core.quotepath=false', 'diff', 'HEAD']).catch(() =>
        runGit(['-c', 'core.quotepath=false', 'diff']).catch(() => '')
      );
    }

    const cap = Math.max(1024, Math.min(80000, Number(maxDiffChars) || 24000));
    const truncated = rawDiff.length > cap;
    const slicedFiles = changedFiles.slice(0, 120);
    return {
      isRepo: true,
      scopePath: scopeRoot,
      branch,
      changedFiles: slicedFiles,
      files: slicedFiles,
      diff: truncated ? `${rawDiff.slice(0, cap)}\n…（Diff 已截断显示前 ${cap} 字符）` : rawDiff,
      truncated,
    };
  }

  async runScopeGitAction(groupId, payload = {}) {
    const scopeRoot = await this.resolveGroupScopeDirectory(groupId);
    if (!scopeRoot) {
      throw new Error('当前群聊未绑定有效的本地项目目录');
    }
    const result = await executeGitWorkspaceAction(scopeRoot, payload);
    const gitSummary = await this.getScopeGitSummary(groupId).catch(() => null);
    return {
      ...result,
      gitSummary,
    };
  }

  async resolveCardAction(
    groupId,
    { messageId = '', cardId = '', decision = '', optionKey = '', grantScope = 'turn' } = {}
  ) {
    if (!groupId || !/^[a-zA-Z0-9_-]+$/.test(groupId)) {
      throw new Error('非法的群聊 ID');
    }
    const allMsgs = await this.getMessages(groupId);
    const targetMsg = allMsgs.find(
      (m) =>
        (messageId && m.id === messageId) ||
        (cardId && m.interactiveCard && m.interactiveCard.id === cardId)
    );
    if (!targetMsg || !targetMsg.interactiveCard) {
      throw new Error('找不到对应的交互操作卡片');
    }

    const card = targetMsg.interactiveCard;
    const settlements = this.ensureCardSettlementsLoaded();
    if (settlements[card.id]) {
      throw new Error('该操作卡片已处理，不可重复提交');
    }

    let groups = this.groupMetaCache.data;
    let targetGroup = Array.isArray(groups) ? groups.find((g) => g.id === groupId) : null;
    if (!targetGroup && groupId !== 'file-helper') {
      await this.ensureDaemonRunning();
      groups = await this.listGroups();
      targetGroup = groups.find((g) => g.id === groupId);
    }

    if (card.kind === 'choice') {
      const wantedKey = String(optionKey || decision || '')
        .trim()
        .toUpperCase();
      const chosen = (card.options || []).find((o) => o.key === wantedKey);
      if (!chosen) {
        throw new Error('请选择有效的方案选项');
      }

      const settled = {
        cardId: card.id,
        groupId,
        messageId: targetMsg.id,
        kind: 'choice',
        decision: chosen.key,
        label: `${chosen.key} · ${chosen.label}`,
        settledAt: new Date().toISOString(),
      };
      settlements[card.id] = settled;
      this.cardSettlementsRev += 1;
      await this.saveCardSettlements();
      this.emit('cardSettled', { groupId, messageId: targetMsg.id, cardId: card.id, settled });

      const sent = await this.sendGroupMessage(groupId, {
        text: `我选择方案 ${chosen.key}（${chosen.label}），请按此继续。`,
        to: targetMsg.by ? [targetMsg.by] : [],
        quote: {
          sender: targetMsg.senderTitle || targetMsg.by || 'Agent',
          text: card.title,
        },
      });
      return { ok: true, settled, message: sent };
    }

    if (card.kind === 'approval') {
      const rawDec = String(decision || '').trim().toLowerCase();
      const normDecision =
        rawDec === 'approve' || rawDec === 'allow'
          ? 'approve'
          : rawDec === 'deny' || rawDec === 'reject'
            ? 'deny'
            : '';
      if (!normDecision) {
        throw new Error('请明确选择批准或拒绝');
      }

      const settled = {
        cardId: card.id,
        groupId,
        messageId: targetMsg.id,
        kind: 'approval',
        decision: normDecision,
        grantScope: normDecision === 'approve' ? grantScope : 'none',
        label:
          normDecision === 'approve'
            ? grantScope === 'session'
              ? '已批准会话常驻可写并执行'
              : '已批准本轮可写并执行'
            : '已拒绝写入授权（保持只读）',
        settledAt: new Date().toISOString(),
      };
      settlements[card.id] = settled;
      this.cardSettlementsRev += 1;
      await this.saveCardSettlements();
      this.emit('cardSettled', { groupId, messageId: targetMsg.id, cardId: card.id, settled });

      if (normDecision === 'deny') {
        await this.appendExternalDispatchMessage(groupId, {
          kind: 'system',
          by: 'system',
          text: `🔒 已拒绝 ${targetMsg.senderTitle || targetMsg.by || 'Agent'} 的写入授权请求，当前继续保持只读安全边界。`,
        });
        return { ok: true, settled };
      }

      // Approved: upgrade permission for this execution (and optionally persist for session)
      const actorId = targetMsg.by || card.actorId || 'codex';
      const savedPrefs = this.groupPrefs[groupId] || {};
      const replyStyle = normalizeReplyStyle(
        targetMsg.retryMeta?.replyStyle || savedPrefs.replyStyle
      );
      const routing = normalizeSessionRouting(
        savedPrefs.sessionRouting,
        targetGroup?.scopePath || ''
      );

      let origPrompt = String(targetMsg.retryMeta?.prompt || '').trim();
      let origAttachments = Array.isArray(targetMsg.retryMeta?.attachments)
        ? targetMsg.retryMeta.attachments
        : [];
      if (!origPrompt) {
        for (let i = allMsgs.length - 1; i >= 0; i -= 1) {
          if (allMsgs[i]?.isUser && String(allMsgs[i].text || '').trim()) {
            origPrompt = String(allMsgs[i].text).trim();
            if (!origAttachments.length && Array.isArray(allMsgs[i].attachments)) {
              origAttachments = allMsgs[i].attachments;
            }
            break;
          }
        }
      }
      const approvedPrompt = origPrompt
        ? `${origPrompt}\n\n【用户已在气泡内点击「批准可写权限」：本轮已授予 workspace-write 写入权限，请直接完成修改与验证。】`
        : '用户已在气泡内批准 workspace-write 可写权限，请继续完成刚才受只读限制未落地的修改与验证。';

      const isExt =
        Boolean(targetMsg.sessionReceipt || targetMsg.retryMeta) ||
        isAgentRoutedExternally(routing, actorId);

      if (grantScope === 'session') {
        if (isExt) {
          routing.permission = 'workspace-write';
          this.groupPrefs[groupId] = { ...savedPrefs, sessionRouting: routing };
          await this.saveGroupPrefs();
          this.groupMetaCache.ts = 0;
          const freshGroups = await this.listGroups({ force: true }).catch(() => null);
          if (freshGroups) this.emit('groups', freshGroups);
        } else if (actorId === 'codex') {
          await this.updateGroupSettings(groupId, { codexSandbox: 'workspace-write' }).catch(
            () => {}
          );
          const freshGroups = await this.listGroups({ force: true }).catch(() => null);
          if (freshGroups) this.emit('groups', freshGroups);
        }
      }

      // Run via temporary/external writable turn when routed externally OR when grantScope === 'turn' (protects standing group read-only sandbox!)
      if ((isExt || grantScope !== 'session') && targetGroup) {
        this.cancelledExternalGroups.delete(groupId);
        this.setExternalActorThinking(groupId, actorId, '🔓 已获可写授权，正在落地执行修改…');
        const runApprovedAsync = async () => {
          try {
            const res = await this.runTargetSessionForActor({
              groupId,
              targetGroup,
              actorId,
              routing,
              prompt: approvedPrompt,
              attachments: origAttachments,
              replyStyle,
              phase: 'exec',
              forcePermission: 'workspace-write',
            });
            if (this.cancelledExternalGroups.has(groupId)) return;
            await this.appendExternalDispatchMessage(groupId, {
              by: actorId,
              isUser: false,
              senderTitle: res.actorTitle,
              senderRuntime: actorId,
              to: ['user'],
              insight: `🔓 已批准可写执行 · ${res.actorTitle}`,
              text: res.text,
              ok: res.ok !== false,
              sessionReceipt: res.sessionReceipt,
              retryMeta: {
                actorId,
                prompt: approvedPrompt.slice(0, 6000),
                replyStyle,
                attachments: origAttachments,
              },
            });
          } finally {
            this.setExternalActorThinking(groupId, actorId, '');
            this.listGroups({ force: true })
              .then((gs) => this.emit('groups', gs))
              .catch(() => {});
          }
        };
        runApprovedAsync().catch(() => {});
        return { ok: true, settled, mode: isExt ? 'external' : 'turn-isolated' };
      }

      // Standing Group CCCC actor upgrade (only reached when grantScope === 'session' and !isExt)
      const sent = await this.sendGroupMessage(groupId, {
        text: approvedPrompt,
        to: [actorId],
      });
      return { ok: true, settled, mode: 'group', message: sent };
    }

    throw new Error(`不支持的卡片类型：${card.kind}`);
  }
}
