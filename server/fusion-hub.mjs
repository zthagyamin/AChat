import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// ============================================================================
// 1. Inline Approval & Option Selection Cards (OpenMausBot Apache-2.0 Inspired)
// ============================================================================

export const OPTIONS_CARD_LIMITS = Object.freeze({
  maxOptions: 6,
  maxTitleChars: 140,
  maxLabelChars: 96,
  maxSummaryChars: 240,
});

export function parseOptionsCardInput(raw = {}, fallbackId = 'card-choice') {
  if (!raw || typeof raw !== 'object') return null;
  const rawOptions = Array.isArray(raw.options) ? raw.options : [];
  if (rawOptions.length < 2) return null;

  const seenKeys = new Set();
  const options = [];
  const defaultKeys = ['A', 'B', 'C', 'D', 'E', 'F'];

  for (let i = 0; i < rawOptions.length && options.length < OPTIONS_CARD_LIMITS.maxOptions; i += 1) {
    const item = rawOptions[i];
    if (!item || typeof item !== 'object') continue;
    const key = String(item.key || defaultKeys[options.length] || `${options.length + 1}`)
      .trim()
      .toUpperCase()
      .slice(0, 8);
    if (!key || seenKeys.has(key)) continue;
    const label = String(item.label || item.title || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, OPTIONS_CARD_LIMITS.maxLabelChars);
    const summary = String(item.summary || item.description || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, OPTIONS_CARD_LIMITS.maxSummaryChars);
    if (!label && !summary) continue;
    seenKeys.add(key);
    options.push({
      key,
      label: label || summary.slice(0, 48),
      summary: label ? summary : '',
      recommended: Boolean(item.recommended) || /推荐/.test(`${item.badge || ''} ${label}`),
    });
  }

  if (options.length < 2) return null;
  const title =
    String(raw.title || raw.question || '请选择方案继续')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, OPTIONS_CARD_LIMITS.maxTitleChars) || '请选择方案继续';

  return {
    id: String(raw.id || fallbackId).slice(0, 120),
    kind: 'choice',
    actorId: String(raw.actorId || '').trim(),
    title,
    options,
    settled: null,
  };
}

function stripFencedCodeBlocks(text = '') {
  return String(text || '').replace(/```[\s\S]*?```/g, '\n');
}

export function extractInteractiveCardFromMessage(msg = {}, { groupReadOnly = false } = {}) {
  if (!msg || typeof msg !== 'object') return null;
  if (msg.isUser || msg.kind !== 'chat') return null;
  const rawText = String(msg.text || '').trim();
  if (!rawText) return null;

  const msgId = String(msg.id || 'msg').replace(/[^a-zA-Z0-9._-]/g, '');
  const actorId = String(msg.by || '').trim();

  // 1a. Explicit structured JSON option card comment `<!--achat-card:{...}-->`
  const explicitCardMatch = rawText.match(/<!--achat-card:([\s\S]*?)-->/);
  if (explicitCardMatch) {
    try {
      const parsed = JSON.parse(explicitCardMatch[1]);
      const built = parseOptionsCardInput(
        { ...parsed, actorId: parsed.actorId || actorId },
        `card-choice-${msgId}`
      );
      if (built) return built;
    } catch {
      // ignore malformed explicit tag
    }
  }

  // 1b. Explicit structured approval tag `<!--achat-approval:{...}-->`
  const explicitApprovalMatch = rawText.match(/<!--achat-approval:([\s\S]*?)-->/);
  if (explicitApprovalMatch) {
    try {
      const parsed = JSON.parse(explicitApprovalMatch[1]);
      return {
        id: `card-approval-${msgId}`,
        kind: 'approval',
        actorId,
        title: String(parsed.title || '请求授予工作区写入权限并执行').slice(0, 120),
        detail: String(parsed.detail || '批准后将以 workspace-write 可写权限继续执行该任务。').slice(
          0,
          240
        ),
        suggestedPermission: 'workspace-write',
        settled: null,
      };
    } catch {
      // ignore malformed approval tag
    }
  }

  // 2. Natural A/B/C decision options in prose (outside code fences)
  const prose = stripFencedCodeBlocks(rawText);
  const lines = prose.split(/\r?\n/);
  const extractedOpts = [];
  let firstOptionLineIdx = -1;
  const optionLineRe =
    /^\s*(?:[-*•]\s+|\d+[.)]\s+)?(?:\*\*|`)?(?:选项\s*|方案\s*)?([A-F])(?:\s*[（(]([^）)]*)[）)])?(?:\*\*|`)?\s*(?:[：:.、)\]]|[-—]+)\s*(.+)$/;

  for (let idx = 0; idx < lines.length; idx += 1) {
    const m = lines[idx].match(optionLineRe);
    if (!m) continue;
    const key = m[1].toUpperCase();
    const parenTag = String(m[2] || '').trim();
    const rest = String(m[3] || '')
      .replace(/\*\*/g, '')
      .replace(/`/g, '')
      .trim();
    if (!rest || rest.length < 2) continue;
    if (extractedOpts.some((o) => o.key === key)) continue;

    // Enforce alphabetical progression starting from A (prevents accidental random capital letters)
    const expectedChar = String.fromCharCode(65 + extractedOpts.length);
    if (key !== expectedChar) continue;

    if (firstOptionLineIdx < 0) firstOptionLineIdx = idx;
    let label = rest;
    let summary = '';
    const splitMatch = rest.match(/^([^，。；：:—–-]{2,38})[，：:—–-]\s*(.+)$/);
    if (splitMatch) {
      label = splitMatch[1].trim();
      summary = splitMatch[2].trim();
    }
    const recommended = /推荐|recommended/i.test(`${parenTag} ${rest}`);
    if (parenTag && !label.includes(parenTag)) {
      label = `${label}（${parenTag}）`;
    }
    extractedOpts.push({
      key,
      label: label.slice(0, OPTIONS_CARD_LIMITS.maxLabelChars),
      summary: summary.slice(0, OPTIONS_CARD_LIMITS.maxSummaryChars),
      recommended,
    });
  }

  if (extractedOpts.length >= 2) {
    let leadQuestion = '点选下方方案一键回复';
    if (firstOptionLineIdx > 0) {
      for (let j = firstOptionLineIdx - 1; j >= 0; j -= 1) {
        const candidate = lines[j].replace(/[*#>`]/g, '').trim();
        if (candidate) {
          leadQuestion = candidate.slice(0, OPTIONS_CARD_LIMITS.maxTitleChars);
          break;
        }
      }
    }
    return parseOptionsCardInput(
      {
        id: `card-choice-${msgId}`,
        actorId,
        title: leadQuestion,
        options: extractedOpts,
      },
      `card-choice-${msgId}`
    );
  }

  // 3. Read-only / Write-permission blocked inline approval card
  const receiptReadOnly = msg.sessionReceipt?.permission === 'read-only';
  const mentionsReadOnly =
    receiptReadOnly ||
    groupReadOnly ||
    /只读模式|只读权限|只读分析|read-only|readonly\s+sandbox/i.test(prose);
  const mentionsBlockedOrApproval =
    /无法直接(?:修改|写入|创建|保存|落地)|不能直接(?:修改|写入)|无写入权限|需要(?:可写|写入)权限|授予可写|批准可写|切换为可写|批准后(?:继续|执行|修改)|确认后(?:继续|执行|修改)|workspace-write/i.test(
      prose
    );

  if (mentionsReadOnly && mentionsBlockedOrApproval) {
    return {
      id: `card-approval-${msgId}`,
      kind: 'approval',
      actorId,
      title: `${msg.senderTitle || actorId || 'Agent'} 请求工作区可写授权`,
      detail: '当前轮次受只读沙箱限制；点击「批准可写并继续」将以可写模式重新执行上一任务。',
      suggestedPermission: 'workspace-write',
      settled: null,
    };
  }

  return null;
}

// ============================================================================
// 2. One-Click Git Closed-Loop & Worktree Sandbox (T3 Code MIT Inspired)
// ============================================================================

function execGit(repoRoot, args, timeout = 12_000) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=false', ...args],
      {
        cwd: repoRoot,
        timeout,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || stdout || err.message || '').trim();
          const wrapped = new Error(detail || `git ${args[0]} 执行失败`);
          wrapped.stderr = stderr;
          wrapped.stdout = stdout;
          return reject(wrapped);
        }
        resolve(String(stdout || ''));
      }
    );
  });
}

function validateSafeRelativeRepoFile(repoRoot, rawFile = '') {
  const cleaned = String(rawFile || '')
    .trim()
    .replace(/\\/g, '/');
  if (!cleaned || cleaned.includes('\0') || cleaned.startsWith('-')) {
    throw new Error('非法的文件参数');
  }
  const fullPath = path.resolve(repoRoot, cleaned);
  const relBack = path.relative(repoRoot, fullPath);
  if (!relBack || relBack.startsWith('..') || path.isAbsolute(relBack)) {
    throw new Error('安全限制：不允许操作绑定工作目录以外的路径');
  }
  return {
    fullPath,
    cleanRelFile: relBack.split(path.sep).join('/'),
  };
}

export async function executeGitWorkspaceAction(repoRoot, payload = {}) {
  const resolvedRepo = repoRoot ? path.resolve(repoRoot) : '';
  if (!resolvedRepo || !fs.existsSync(resolvedRepo)) {
    throw new Error('当前群聊未绑定有效的本地项目目录');
  }

  const insideOut = await execGit(resolvedRepo, ['rev-parse', '--is-inside-work-tree']).catch(
    () => ''
  );
  if (insideOut.trim() !== 'true') {
    throw new Error('当前绑定目录还不是 Git 仓库');
  }

  const action = String(payload.action || '').trim();
  const managedWorktreesRoot = path.resolve(path.dirname(resolvedRepo), '.achat-worktrees');

  if (action === 'stage-commit') {
    const commitMsg = String(payload.message || '')
      .replace(/\r\n/g, '\n')
      .trim()
      .slice(0, 400);
    if (!commitMsg) {
      throw new Error('请输入 Commit 提交说明');
    }
    const statusBefore = await execGit(resolvedRepo, ['status', '--porcelain=v1', '-uall']);
    if (!statusBefore.trim()) {
      throw new Error('当前工作区干净，没有可提交的变更');
    }
    await execGit(resolvedRepo, ['add', '-A']);
    await execGit(resolvedRepo, ['commit', '-m', commitMsg]);
    const revOut = await execGit(resolvedRepo, ['log', '-1', '--pretty=format:%h%n%s']);
    const [commitHash = '', subject = commitMsg] = revOut.split(/\r?\n/);
    return {
      ok: true,
      action: 'stage-commit',
      commitHash: commitHash.trim(),
      subject: subject.trim(),
    };
  }

  if (action === 'discard-file') {
    const { fullPath, cleanRelFile } = validateSafeRelativeRepoFile(resolvedRepo, payload.file);
    const fileStatus = await execGit(resolvedRepo, [
      'status',
      '--porcelain=v1',
      '-uall',
      '--',
      cleanRelFile,
    ]);
    const trimmed = fileStatus.trim();
    if (!trimmed) {
      return { ok: true, action: 'discard-file', file: cleanRelFile, noop: true };
    }
    if (trimmed.startsWith('?? ')) {
      await fsp.rm(fullPath, { force: true });
      return { ok: true, action: 'discard-file', file: cleanRelFile, removedUntracked: true };
    }
    await execGit(resolvedRepo, ['reset', 'HEAD', '--', cleanRelFile]).catch(() => {});
    await execGit(resolvedRepo, ['checkout', '--', cleanRelFile]);
    return { ok: true, action: 'discard-file', file: cleanRelFile };
  }

  if (action === 'worktree-list') {
    const raw = await execGit(resolvedRepo, ['worktree', 'list', '--porcelain']);
    const blocks = raw.trim().split(/\r?\n\r?\n/).filter(Boolean);
    const worktrees = [];
    for (const blk of blocks) {
      let wtPath = '';
      let head = '';
      let branch = '';
      for (const line of blk.split(/\r?\n/)) {
        if (line.startsWith('worktree ')) {
          wtPath = path.resolve(line.slice('worktree '.length).trim());
        } else if (line.startsWith('HEAD ')) {
          head = line.slice(5).trim().slice(0, 8);
        } else if (line.startsWith('branch ')) {
          branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
        } else if (line === 'detached') {
          branch = branch || 'detached';
        }
      }
      if (!wtPath) continue;
      const isMain = wtPath.toLowerCase() === resolvedRepo.toLowerCase();
      const isManaged = wtPath
        .toLowerCase()
        .startsWith(`${managedWorktreesRoot.toLowerCase()}${path.sep}`);
      worktrees.push({
        path: wtPath,
        name: path.basename(wtPath),
        head,
        branch: branch || 'HEAD',
        isMain,
        isManaged,
        exists: fs.existsSync(wtPath),
      });
    }
    return { ok: true, action: 'worktree-list', worktrees };
  }

  if (action === 'worktree-create') {
    const rawSlug = String(payload.name || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32);
    const slug = rawSlug || `wt-${Date.now().toString(36).slice(-5)}`;
    const repoBase = path.basename(resolvedRepo).replace(/[^a-zA-Z0-9._-\u4e00-\u9fa5]/g, '_');
    await fsp.mkdir(managedWorktreesRoot, { recursive: true });

    let finalSlug = slug;
    let worktreePath = path.join(managedWorktreesRoot, `${repoBase}-${finalSlug}`);
    if (fs.existsSync(worktreePath)) {
      finalSlug = `${slug}-${Math.random().toString(36).slice(2, 5)}`;
      worktreePath = path.join(managedWorktreesRoot, `${repoBase}-${finalSlug}`);
    }
    const branchName = `achat/${finalSlug}`;

    try {
      await execGit(resolvedRepo, ['worktree', 'add', '-b', branchName, worktreePath, 'HEAD'], 20_000);
    } catch {
      await execGit(resolvedRepo, ['worktree', 'add', worktreePath, branchName], 20_000);
    }

    return {
      ok: true,
      action: 'worktree-create',
      worktreePath,
      branch: branchName,
      name: path.basename(worktreePath),
    };
  }

  if (action === 'worktree-remove') {
    const targetRaw = String(payload.worktreePath || '').trim();
    if (!targetRaw) {
      throw new Error('请指定要移除的 Worktree 路径');
    }
    const candidate = path.resolve(targetRaw);
    if (
      candidate.toLowerCase() === resolvedRepo.toLowerCase() ||
      !candidate.toLowerCase().startsWith(`${managedWorktreesRoot.toLowerCase()}${path.sep}`)
    ) {
      throw new Error('安全限制：仅允许移除 AChat 创建的受管隔离 Worktree 沙箱');
    }
    await execGit(resolvedRepo, ['worktree', 'remove', '--force', candidate], 20_000);
    await fsp.rm(candidate, { recursive: true, force: true }).catch(() => {});
    return { ok: true, action: 'worktree-remove', worktreePath: candidate };
  }

  throw new Error(`不支持的 Git 工作区操作：${action}`);
}

// ============================================================================
// 3. Multi-CLI Provider Registry & AI Employee Profiles (T3 Code + OpenMausBot)
// ============================================================================

export const SUPPORTED_CLI_PROVIDERS = Object.freeze([
  'codex',
  'antigravity',
  'claude',
  'opencode',
  'ollama',
]);

const MODEL_CACHE_TTL_MS = 30 * 60 * 1000;

export function isLegacyFilteredModel(providerId = '', modelId = '') {
  const id = String(modelId || '').trim();
  if (!id) return false;
  if (providerId === 'antigravity' || providerId === 'opencode') {
    if (
      /gemini-3(?:\b|\.|[-_])|3\.8[-_.]?flash|\bflash(?:[-_.]lite)?\b|gemini-4-argon|orchestrator-argon/i.test(
        id
      )
    ) {
      return true;
    }
  }
  if (providerId === 'codex' || providerId === 'opencode') {
    if (/(?:^|\/)gpt-5(?:\b|\.|[-_])/i.test(id)) {
      return true;
    }
  }
  return false;
}

function finalizeModelPresetList(providerId, rawItems = []) {
  const presets = [];
  const seen = new Set();
  for (const raw of rawItems) {
    const id = String(raw?.id || raw?.slug || raw || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const label = String(raw?.label || raw?.displayName || raw?.display_name || id).trim() || id;
    const legacy =
      typeof raw?.legacy === 'boolean' ? raw.legacy : isLegacyFilteredModel(providerId, id);
    presets.push({ id, label, legacy });
  }
  // Keep modern non-legacy models ahead of filtered legacy entries while preserving order within each group
  return [
    ...presets.filter((m) => !m.legacy),
    ...presets.filter((m) => m.legacy),
  ];
}

function buildBuiltinMeta(id, title, vendor, rawPresets, installHint) {
  const modelPresets = finalizeModelPresetList(id, rawPresets);
  return {
    id,
    title,
    vendor,
    models: modelPresets.filter((m) => !m.legacy).map((m) => m.id),
    allModels: modelPresets.map((m) => m.id),
    modelPresets,
    installHint,
  };
}

export const PROVIDER_CATALOG_META = Object.freeze({
  codex: buildBuiltinMeta(
    'codex',
    'OpenAI Codex',
    'OpenAI',
    [
      { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol · 最新主力编码' },
      { id: 'gpt-6-astra', label: 'GPT-6-Astra · 旗舰深度推理' },
      { id: 'gpt-6.1-terra', label: 'GPT-6.1-Terra · Codex 专项模型' },
      { id: 'gpt-6-sol', label: 'GPT-6-Sol · 均衡稳健' },
      { id: 'gpt-6-luna', label: 'GPT-6-Luna · 极速轻量' },
    ],
    'VS Code Codex 扩展或 npm i -g @openai/codex'
  ),
  antigravity: buildBuiltinMeta(
    'antigravity',
    'Google Antigravity',
    'Google DeepMind',
    [
      { id: 'gemini-4-carbon-high', label: 'Gemini 4 Carbon (High) · 旗舰深度' },
      { id: 'gemini-4-carbon-medium', label: 'Gemini 4 Carbon (Medium) · 均衡主力' },
      { id: 'gemini-4-carbon-low', label: 'Gemini 4 Carbon (Low) · 轻量推理' },
      { id: 'gemini-pro-orchestrator', label: 'Orchestrator (Carbon) · 统筹编排' },
      { id: 'gemini-4-hydrogen-xhigh', label: 'Gemini 4 Hydrogen (XHigh) · 深度强化' },
      { id: 'gemini-4-hydrogen-high', label: 'Gemini 4 Hydrogen (High) · 高速主力' },
      { id: 'gemini-4-hydrogen-medium', label: 'Gemini 4 Hydrogen (Medium) · 快速均衡' },
      { id: 'gemini-4-hydrogen-low', label: 'Gemini 4 Hydrogen (Low) · 极速保底' },
      { id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High) · 深度架构' },
      { id: 'claude-opus-5-5-medium', label: 'Claude Opus 5.5 (Medium) · 均衡推理' },
      { id: 'claude-opus-5-5-low', label: 'Claude Opus 5.5 (Low) · 快速思考' },
      { id: 'claude-sonnet-5-5-high', label: 'Claude Sonnet 5.5 (High) · 主力编码' },
      { id: 'claude-sonnet-5-5-medium', label: 'Claude Sonnet 5.5 (Medium) · 快速编码' },
      { id: 'claude-sonnet-5-5-low', label: 'Claude Sonnet 5.5 (Low) · 轻量编码' },
      { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium) · 开源大模型' },
      { id: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High) · 旧档位', legacy: true },
      { id: 'gemini-4-argon-medium', label: 'Gemini 4 Argon (Medium) · 旧档位', legacy: true },
      { id: 'gemini-4-argon-low', label: 'Gemini 4 Argon (Low) · 旧档位', legacy: true },
      { id: 'gemini-pro-orchestrator-argon', label: 'Orchestrator (Argon) · 旧档位', legacy: true },
      { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High) · 旧版 Flash', legacy: true },
      { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium) · 旧版 Flash', legacy: true },
      { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low) · 旧版 Flash', legacy: true },
    ],
    'Antigravity Desktop 内置 agy CLI'
  ),
  claude: buildBuiltinMeta(
    'claude',
    'Claude Code',
    'Anthropic',
    [
      { id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High) · 旗舰推理' },
      { id: 'claude-sonnet-5-5-high', label: 'Claude Sonnet 5.5 (High) · 主力编码' },
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
    ],
    'npm install -g @anthropic-ai/claude-code'
  ),
  opencode: buildBuiltinMeta(
    'opencode',
    'OpenCode',
    'SST / OpenCode',
    [
      { id: 'openai/gpt-6-astra', label: 'OpenAI GPT-6-Astra' },
      { id: 'openai/gpt-6.1-sol', label: 'OpenAI GPT-6.1-Sol' },
      { id: 'google/gemini-4-carbon-high', label: 'Gemini 4 Carbon (High)' },
      { id: 'google/gemini-4-hydrogen-high', label: 'Gemini 4 Hydrogen (High)' },
      { id: 'anthropic/claude-opus-5-5', label: 'Claude Opus 5.5' },
    ],
    'npm install -g opencode-ai'
  ),
  ollama: buildBuiltinMeta(
    'ollama',
    'Ollama Local',
    'Local LLM',
    [
      { id: 'qwen3-coder:30b', label: 'Qwen3 Coder 30B · 本地编码' },
      { id: 'gpt-oss:120b', label: 'GPT-OSS 120B · 本地开源' },
      { id: 'deepseek-r1:32b', label: 'DeepSeek R1 32B · 本地推理' },
    ],
    'https://ollama.com/download'
  ),
});

const AGY_BUILTIN_HINTS = new Map(
  PROVIDER_CATALOG_META.antigravity.modelPresets.map((item) => [item.id, item])
);
const CODEX_BUILTIN_HINTS = new Map(
  PROVIDER_CATALOG_META.codex.modelPresets.map((item) => [item.id, item])
);

function agySortWeight(id = '') {
  const s = String(id).toLowerCase();
  if (/^gemini-(?:[5-9]|[1-9]\d)/.test(s)) return 0;
  if (s.includes('gemini-4-carbon-high')) return 10;
  if (s.includes('gemini-4-carbon-medium')) return 11;
  if (s.includes('gemini-4-carbon-low')) return 12;
  if (s.startsWith('gemini-4-carbon')) return 15;
  if (s === 'gemini-pro-orchestrator') return 20;
  if (s.includes('gemini-4-hydrogen-xhigh')) return 30;
  if (s.includes('gemini-4-hydrogen-high')) return 31;
  if (s.includes('gemini-4-hydrogen-medium')) return 32;
  if (s.includes('gemini-4-hydrogen-low')) return 33;
  if (s.startsWith('gemini-4-hydrogen')) return 35;
  if (s.startsWith('claude-opus')) return 40;
  if (s.startsWith('claude-sonnet')) return 45;
  if (s.startsWith('gpt-oss')) return 55;
  if (isLegacyFilteredModel('antigravity', s)) return 90;
  return 25;
}

export function parseAgyModelsOutput(stdout = '') {
  const items = [];
  const seen = new Set();
  for (const rawLine of String(stdout || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^Fetching available models/i.test(line)) continue;
    const match = line.match(/^([a-zA-Z0-9._:/-]+)\s+(.+)$/);
    if (!match) continue;
    const id = match[1].trim();
    const displayName = match[2].trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const known = AGY_BUILTIN_HINTS.get(id);
    const legacy = isLegacyFilteredModel('antigravity', id);
    items.push({
      id,
      label: known?.label || displayName || id,
      legacy,
      orderIdx: items.length,
    });
  }
  items.sort((a, b) => {
    const wa = agySortWeight(a.id);
    const wb = agySortWeight(b.id);
    if (wa !== wb) return wa - wb;
    return a.orderIdx - b.orderIdx;
  });
  return finalizeModelPresetList('antigravity', items);
}

export function parseOllamaListOutput(stdout = '') {
  const items = [];
  const seen = new Set();
  for (const rawLine of String(stdout || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^NAME\s+ID\s+SIZE/i.test(line)) continue;
    const col1 = line.split(/\s+/)[0]?.trim();
    if (!col1 || col1 === 'NAME' || seen.has(col1)) continue;
    seen.add(col1);
    items.push({ id: col1, label: `${col1} · 本机 Ollama`, legacy: false });
  }
  return items;
}

export function parseOpencodeModelsOutput(stdout = '') {
  const items = [];
  const seen = new Set();
  for (const rawLine of String(stdout || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /\s/.test(line) && !line.includes('/')) continue;
    const id = line.split(/\s+/)[0]?.trim();
    if (!id || !id.includes('/') || seen.has(id)) continue;
    seen.add(id);
    items.push({ id, label: id, legacy: isLegacyFilteredModel('opencode', id) });
  }
  return items;
}

function execCliText(bin, args = [], { timeout = 4500 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      {
        encoding: 'utf8',
        timeout,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
      },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(String(stdout || ''));
      }
    );
  });
}

export function normalizeAgentProfiles(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const result = {};
  for (const id of SUPPORTED_CLI_PROVIDERS) {
    const item = src[id] && typeof src[id] === 'object' ? src[id] : {};
    result[id] = {
      displayName: String(item.displayName || '').trim().slice(0, 40),
      model: String(item.model || '')
        .trim()
        .replace(/[^a-zA-Z0-9._:/-]/g, '')
        .slice(0, 80),
      persona: String(item.persona || '').trim().slice(0, 600),
    };
  }
  return result;
}

export function buildAgentPersonaDirective(actorId, agentProfiles = {}) {
  const prof = agentProfiles?.[actorId];
  if (!prof || (!prof.displayName && !prof.persona)) return '';
  const parts = [];
  if (prof.displayName) parts.push(`岗位称呼：${prof.displayName}`);
  if (prof.persona) parts.push(`职责与行事准则：${prof.persona}`);
  return `[AI 员工角色设定（请在本轮协作中遵守）：${parts.join('；')}]`;
}

function findExecutableInPath(names = [], extraDirs = []) {
  const pathEnv = process.env.PATH || process.env.Path || '';
  const dirs = [...extraDirs, ...pathEnv.split(path.delimiter)].filter(Boolean);
  const exts =
    process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];

  for (const dir of dirs) {
    for (const base of names) {
      if (path.isAbsolute(base)) {
        if (fs.existsSync(base)) return base;
        continue;
      }
      for (const ext of exts) {
        const candidate = path.join(dir, base.endsWith(ext) ? base : `${base}${ext}`);
        try {
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return candidate;
          }
        } catch {
          // ignore inaccessible PATH entry
        }
      }
    }
  }
  return '';
}

let cachedProviderScan = { ts: 0, scopeKey: '', data: null };

export async function detectProviderEcosystem({
  force = false,
  codexBinHint = '',
  codexHomeDir = path.join(os.homedir(), '.codex'),
  dataDir = '',
  agyModelsRunnerOverride = null,
  ollamaListRunnerOverride = null,
} = {}) {
  const now = Date.now();
  const codexCacheFile = path.join(codexHomeDir || path.join(os.homedir(), '.codex'), 'models_cache.json');
  let codexCacheMtime = 0;
  try {
    if (fs.existsSync(codexCacheFile)) {
      codexCacheMtime = fs.statSync(codexCacheFile).mtimeMs || 0;
    }
  } catch {}
  const catalogCachePath = dataDir ? path.join(dataDir, 'models-catalog-cache.json') : '';
  const scopeKey = `${codexHomeDir}|${dataDir}|${codexCacheMtime}|${codexBinHint}`;

  if (
    !force &&
    !agyModelsRunnerOverride &&
    !ollamaListRunnerOverride &&
    cachedProviderScan.data &&
    cachedProviderScan.scopeKey === scopeKey &&
    now - cachedProviderScan.ts < 20_000
  ) {
    return cachedProviderScan.data;
  }

  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const commonExtraDirs = [
    path.join(os.homedir(), '.local', 'bin'),
    path.join(localAppData, 'agy', 'bin'),
    path.join(localAppData, 'Programs', 'Ollama'),
    path.join(process.env.APPDATA || '', 'npm'),
  ].filter(Boolean);

  // Also check VS Code OpenAI Codex extension bin folder
  let vscodeCodexBin = codexBinHint && fs.existsSync(codexBinHint) ? codexBinHint : '';
  if (!vscodeCodexBin) {
    const codexRoot = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
    try {
      if (fs.existsSync(codexRoot)) {
        for (const d of fs.readdirSync(codexRoot, { withFileTypes: true })) {
          if (!d.isDirectory()) continue;
          const exe = path.join(codexRoot, d.name, 'codex.exe');
          if (fs.existsSync(exe)) {
            vscodeCodexBin = exe;
            break;
          }
        }
      }
    } catch {}
  }
  if (!vscodeCodexBin) {
    const extRoot = path.join(os.homedir(), '.vscode', 'extensions');
    try {
      if (fs.existsSync(extRoot)) {
        const matches = fs
          .readdirSync(extRoot)
          .filter((n) => n.startsWith('openai.chatgpt-'))
          .sort()
          .reverse();
        for (const m of matches) {
          const exe = path.join(extRoot, m, 'bin', 'windows-x86_64', 'codex.exe');
          if (fs.existsSync(exe)) {
            vscodeCodexBin = exe;
            break;
          }
        }
      }
    } catch {}
  }

  const binaryMap = {
    codex: vscodeCodexBin || findExecutableInPath(['codex'], commonExtraDirs),
    antigravity: findExecutableInPath(
      [path.join(localAppData, 'agy', 'bin', 'agy.exe'), 'agy'],
      commonExtraDirs
    ),
    claude: findExecutableInPath(['claude'], commonExtraDirs),
    opencode: findExecutableInPath(['opencode'], commonExtraDirs),
    ollama: findExecutableInPath(['ollama'], commonExtraDirs),
  };

  // Load persisted catalog cache (written only when dataDir is provided)
  let diskCache = { updatedAt: '', providers: {} };
  if (catalogCachePath) {
    try {
      if (fs.existsSync(catalogCachePath)) {
        const parsed = JSON.parse(await fsp.readFile(catalogCachePath, 'utf8'));
        if (parsed && typeof parsed === 'object') {
          diskCache = {
            updatedAt: String(parsed.updatedAt || ''),
            providers: parsed.providers && typeof parsed.providers === 'object' ? parsed.providers : {},
          };
        }
      }
    } catch {}
  }
  const diskCacheTs = Date.parse(diskCache.updatedAt || '');
  const isDiskCacheFresh = Number.isFinite(diskCacheTs) && now - diskCacheTs < MODEL_CACHE_TTL_MS;
  let diskCacheDirty = false;
  const nowIso = new Date(now).toISOString();

  // 1. Dynamically sync Codex models from local ~/.codex/models_cache.json (excluding hidden internal slugs)
  const liveCodexPresets = [];
  let codexModelSource = 'builtin';
  let codexUpdatedAt = '';
  try {
    if (fs.existsSync(codexCacheFile)) {
      const parsed = JSON.parse(fs.readFileSync(codexCacheFile, 'utf8'));
      const rawModels = Array.isArray(parsed?.models) ? parsed.models : [];
      const visible = rawModels
        .filter((m) => m && typeof m === 'object' && m.visibility !== 'hide')
        .sort((a, b) => {
          const pa = Number.isFinite(Number(a.priority)) ? Number(a.priority) : 999;
          const pb = Number.isFinite(Number(b.priority)) ? Number(b.priority) : 999;
          return pa - pb;
        });
      for (const m of visible) {
        const slug = String(m?.slug || '').trim();
        if (!slug) continue;
        const known = CODEX_BUILTIN_HINTS.get(slug);
        const disp = String(m?.display_name || slug).trim();
        const rawDesc = String(m?.description || '').trim();
        const shortDesc = rawDesc.length > 26 ? `${rawDesc.slice(0, 26).trimEnd()}…` : rawDesc;
        liveCodexPresets.push({
          id: slug,
          label: known?.label || (shortDesc ? `${disp} · ${shortDesc}` : disp),
          legacy: isLegacyFilteredModel('codex', slug),
        });
      }
      if (liveCodexPresets.length > 0) {
        codexModelSource = 'live';
        codexUpdatedAt = codexCacheMtime ? new Date(codexCacheMtime).toISOString() : nowIso;
      }
    }
  } catch {
    // ignore malformed models_cache.json
  }
  const codexMergedPresets = finalizeModelPresetList('codex', [
    ...liveCodexPresets,
    ...PROVIDER_CATALOG_META.codex.modelPresets,
  ]);

  // 2. Dynamically sync Antigravity models via `agy models` on-demand + disk cache fallback
  const cachedAgy = Array.isArray(diskCache.providers?.antigravity) ? diskCache.providers.antigravity : [];
  let agyPresets = null;
  let agyModelSource = 'builtin';
  let agyUpdatedAt = diskCache.updatedAt || '';
  if (
    agyModelsRunnerOverride ||
    (binaryMap.antigravity && (force || cachedAgy.length === 0 || !isDiskCacheFresh))
  ) {
    try {
      const rawOut = agyModelsRunnerOverride
        ? await agyModelsRunnerOverride()
        : await execCliText(binaryMap.antigravity, ['models'], { timeout: 4500 });
      const parsed = parseAgyModelsOutput(rawOut);
      if (parsed.length > 0) {
        agyPresets = parsed;
        agyModelSource = 'live';
        agyUpdatedAt = nowIso;
        diskCache.providers.antigravity = parsed;
        diskCache.updatedAt = nowIso;
        diskCacheDirty = true;
      }
    } catch {
      // fall through cleanly to disk cache or built-in defaults
    }
  }
  if (!agyPresets && cachedAgy.length > 0) {
    agyPresets = finalizeModelPresetList('antigravity', cachedAgy);
    agyModelSource = 'cache';
  }
  if (!agyPresets) {
    agyPresets = PROVIDER_CATALOG_META.antigravity.modelPresets;
  }

  // 3. Dynamically sync Ollama local models via `ollama list`
  const cachedOllama = Array.isArray(diskCache.providers?.ollama) ? diskCache.providers.ollama : [];
  let ollamaPresets = null;
  let ollamaSource = 'builtin';
  let ollamaUpdatedAt = diskCache.updatedAt || '';
  if (
    ollamaListRunnerOverride ||
    (binaryMap.ollama && (force || cachedOllama.length === 0 || !isDiskCacheFresh))
  ) {
    try {
      const rawOllama = ollamaListRunnerOverride
        ? await ollamaListRunnerOverride()
        : await execCliText(binaryMap.ollama, ['list'], { timeout: 2500 });
      const parsedOllama = parseOllamaListOutput(rawOllama);
      if (parsedOllama.length > 0) {
        ollamaPresets = finalizeModelPresetList('ollama', [
          ...parsedOllama,
          ...PROVIDER_CATALOG_META.ollama.modelPresets,
        ]);
        ollamaSource = 'live';
        ollamaUpdatedAt = nowIso;
        diskCache.providers.ollama = ollamaPresets;
        diskCache.updatedAt = nowIso;
        diskCacheDirty = true;
      }
    } catch {}
  }
  if (!ollamaPresets && cachedOllama.length > 0) {
    ollamaPresets = finalizeModelPresetList('ollama', [
      ...cachedOllama,
      ...PROVIDER_CATALOG_META.ollama.modelPresets,
    ]);
    ollamaSource = 'cache';
  }
  if (!ollamaPresets) {
    ollamaPresets = PROVIDER_CATALOG_META.ollama.modelPresets;
  }

  // 4. Opportunistic OpenCode sync if binary installed
  const cachedOpencode = Array.isArray(diskCache.providers?.opencode) ? diskCache.providers.opencode : [];
  let opencodePresets = null;
  let opencodeSource = 'builtin';
  let opencodeUpdatedAt = diskCache.updatedAt || '';
  if (binaryMap.opencode && (force || cachedOpencode.length === 0 || !isDiskCacheFresh)) {
    try {
      const rawOc = await execCliText(binaryMap.opencode, ['models'], { timeout: 2500 });
      const parsedOc = parseOpencodeModelsOutput(rawOc);
      if (parsedOc.length > 0) {
        opencodePresets = finalizeModelPresetList('opencode', [
          ...parsedOc,
          ...PROVIDER_CATALOG_META.opencode.modelPresets,
        ]);
        opencodeSource = 'live';
        opencodeUpdatedAt = nowIso;
        diskCache.providers.opencode = opencodePresets;
        diskCache.updatedAt = nowIso;
        diskCacheDirty = true;
      }
    } catch {}
  }
  if (!opencodePresets && cachedOpencode.length > 0) {
    opencodePresets = finalizeModelPresetList('opencode', [
      ...cachedOpencode,
      ...PROVIDER_CATALOG_META.opencode.modelPresets,
    ]);
    opencodeSource = 'cache';
  }
  if (!opencodePresets) {
    opencodePresets = PROVIDER_CATALOG_META.opencode.modelPresets;
  }

  if (diskCacheDirty && catalogCachePath) {
    try {
      await fsp.mkdir(path.dirname(catalogCachePath), { recursive: true });
      await fsp.writeFile(catalogCachePath, JSON.stringify(diskCache, null, 2), 'utf8');
    } catch {}
  }

  const providerDynamicMap = {
    codex: { modelPresets: codexMergedPresets, modelSource: codexModelSource, modelsUpdatedAt: codexUpdatedAt },
    antigravity: { modelPresets: agyPresets, modelSource: agyModelSource, modelsUpdatedAt: agyUpdatedAt },
    claude: {
      modelPresets: PROVIDER_CATALOG_META.claude.modelPresets,
      modelSource: 'builtin',
      modelsUpdatedAt: '',
    },
    opencode: { modelPresets: opencodePresets, modelSource: opencodeSource, modelsUpdatedAt: opencodeUpdatedAt },
    ollama: { modelPresets: ollamaPresets, modelSource: ollamaSource, modelsUpdatedAt: ollamaUpdatedAt },
  };

  const providers = SUPPORTED_CLI_PROVIDERS.map((id) => {
    const meta = PROVIDER_CATALOG_META[id];
    const dyn = providerDynamicMap[id];
    const presets = dyn.modelPresets;
    const binPath = binaryMap[id] || '';
    return {
      ...meta,
      models: presets.filter((m) => !m.legacy).map((m) => m.id),
      allModels: presets.map((m) => m.id),
      modelPresets: presets,
      modelSource: dyn.modelSource,
      modelsUpdatedAt: dyn.modelsUpdatedAt,
      installed: Boolean(binPath),
      binaryPath: binPath,
    };
  });

  const payload = {
    scannedAt: nowIso,
    providers,
  };
  if (!agyModelsRunnerOverride && !ollamaListRunnerOverride) {
    cachedProviderScan = { ts: now, scopeKey, data: payload };
  }
  return payload;
}

export async function executeExtraProviderTurn({
  provider,
  cwd = '',
  prompt = '',
  model = '',
  permission = 'read-only',
  binOverride = '',
  extraLeadArgs = [],
  registerChild = null,
  onProgress = null,
  idleTimeoutMs = 600_000,
  timeoutMs = 600_000,
} = {}) {
  const effectiveIdleMs = Math.max(40, Number(idleTimeoutMs ?? timeoutMs) || 600_000);
  const safeProvider = String(provider || '').toLowerCase();
  const workingDir = cwd && fs.existsSync(cwd) ? cwd : process.cwd();
  const ecosystem = await detectProviderEcosystem();
  const found = ecosystem.providers.find((p) => p.id === safeProvider);
  const bin = binOverride || found?.binaryPath || '';

  if (!bin) {
    const hint = found?.installHint || safeProvider;
    return {
      ok: false,
      sessionId: '',
      text: `⚠️ 本机尚未检测到 ${found?.title || safeProvider} CLI（安装方式：\`${hint}\`）。安装后无需重启即可在 AChat 直接调度。`,
    };
  }

  const args = Array.isArray(extraLeadArgs) ? [...extraLeadArgs] : [];
  if (!binOverride) {
    if (safeProvider === 'claude') {
      args.push('-p', prompt, '--output-format', 'stream-json', '--verbose');
      if (model) args.push('--model', model);
      if (permission === 'workspace-write') {
        args.push('--permission-mode', 'acceptEdits');
      } else {
        args.push('--permission-mode', 'plan');
      }
    } else if (safeProvider === 'opencode') {
      args.push('run', '--format', 'json');
      if (model) args.push('--model', model);
      args.push(prompt);
    } else if (safeProvider === 'ollama') {
      const targetModel = model || 'qwen3-coder:30b';
      args.push('run', targetModel, prompt);
    } else {
      return { ok: false, sessionId: '', text: `⚠️ 不支持的扩展 CLI Provider：${safeProvider}` };
    }
  } else {
    args.push(prompt);
  }

  return new Promise((resolve) => {
    const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
    const child = spawn(bin, args, {
      cwd: workingDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: useShell,
      windowsHide: true,
    });
    registerChild?.(child);

    let stdout = '';
    let stderr = '';
    let lineBuf = '';
    let settled = false;
    let detectedSessionId = '';
    let streamedText = '';
    let finalResult = '';

    const parseStreamLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (!trimmed.startsWith('{')) {
        if (safeProvider === 'ollama') {
          streamedText += `${line}\n`;
          onProgress?.({ stepLabel: '✍ Ollama 正在本地生成回复…', text: streamedText.trim() });
        }
        return;
      }
      try {
        const obj = JSON.parse(trimmed);
        if (obj.session_id) detectedSessionId = String(obj.session_id);
        if (typeof obj.result === 'string' && obj.result.trim()) {
          finalResult = obj.result.trim();
        } else if (typeof obj.text === 'string' && obj.text.trim()) {
          streamedText += obj.text;
          onProgress?.({ stepLabel: `✍ ${found?.title || safeProvider} 正在输出…`, text: streamedText.trim() });
        } else if (obj.message?.content && Array.isArray(obj.message.content)) {
          const chunkTxt = obj.message.content
            .map((c) => (typeof c?.text === 'string' ? c.text : ''))
            .join('');
          if (chunkTxt) {
            streamedText = chunkTxt.trim();
            onProgress?.({ stepLabel: `✍ ${found?.title || safeProvider} 正在输出…`, text: streamedText });
          }
        }
      } catch {
        // ignore plain line
      }
    };

    let timer = null;
    const resetIdleTimer = () => {
      if (settled) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          child.kill();
        } catch {}
        resolve({
          ok: false,
          sessionId: detectedSessionId,
          text: `⚠️ ${safeProvider} 长时间无新输出响应，已自动断开`,
        });
      }, effectiveIdleMs);
      timer.unref?.();
    };
    resetIdleTimer();

    child.stdout.on('data', (chunk) => {
      resetIdleTimer();
      const s = chunk.toString('utf8');
      stdout += s;
      lineBuf += s;
      const parts = lineBuf.split(/\r?\n/);
      lineBuf = parts.pop() || '';
      for (const p of parts) parseStreamLine(p);
    });
    child.stderr.on('data', (chunk) => {
      resetIdleTimer();
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ ok: false, sessionId: detectedSessionId, text: `⚠️ 启动 ${safeProvider} 失败：${err.message}` });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (lineBuf.trim()) parseStreamLine(lineBuf);
      const best = finalResult || streamedText.trim() || stdout.trim();
      if (best && code === 0) {
        resolve({ ok: true, sessionId: detectedSessionId, text: best });
        return;
      }
      if (finalResult || streamedText.trim()) {
        resolve({ ok: true, sessionId: detectedSessionId, text: finalResult || streamedText.trim() });
        return;
      }
      resolve({
        ok: false,
        sessionId: detectedSessionId,
        text: `⚠️ ${safeProvider} 未返回有效结果（退出码 ${code}）：${(stderr || stdout).trim().slice(0, 320)}`,
      });
    });
  });
}

// ============================================================================
// 4. Tailscale Discovery (T3 Code MIT) & Live Host Computer Panel (OpenMausBot)
// ============================================================================

const TAILSCALE_STATUS_TIMEOUT_MS = 3500;

export function stderrDiagnosticOf(stderrText = '') {
  const raw = String(stderrText || '').trim();
  if (!raw) return '';
  return raw
    .replace(/\btskey-[a-zA-Z0-9_-]+/gi, 'tskey-[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, '$1[REDACTED]:[REDACTED]@')
    .replace(/\s+/g, ' ')
    .slice(0, 220);
}

export function parseTailscaleStatusJson(rawJson = '', port = 8866) {
  const parsed = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson || {};
  const backendState = String(parsed.BackendState || '');
  const selfNode = parsed.Self || {};
  const rawDns = String(selfNode.DNSName || '').trim().replace(/\.$/, '');
  const ips = Array.isArray(selfNode.TailscaleIPs) ? selfNode.TailscaleIPs.map(String) : [];
  const ipv4 = ips.find((ip) => /^100\.\d+\.\d+\.\d+$/.test(ip)) || ips.find((ip) => !ip.includes(':')) || '';
  const running = backendState === 'Running' && (Boolean(ipv4) || Boolean(rawDns));
  return {
    installed: true,
    running,
    backendState,
    online: Boolean(selfNode.Online),
    dnsName: rawDns,
    ipv4,
    magicDnsUrl: rawDns ? `http://${rawDns}:${port}` : '',
    ipv4Url: ipv4 ? `http://${ipv4}:${port}` : '',
  };
}

export async function queryTailscaleStatus({
  port = 8866,
  timeoutMs = TAILSCALE_STATUS_TIMEOUT_MS,
  execFileOverride = null,
} = {}) {
  const candidates =
    process.platform === 'win32'
      ? [
          'tailscale.exe',
          path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe'),
        ]
      : ['tailscale'];

  const runner =
    execFileOverride ||
    ((bin, args) =>
      new Promise((resolve, reject) => {
        execFile(
          bin,
          args,
          { timeout: timeoutMs, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
          (err, stdout, stderr) => {
            if (err) {
              err.stderr = stderr;
              err.stdout = stdout;
              return reject(err);
            }
            resolve({ stdout, stderr });
          }
        );
      }));

  let lastDiag = '';
  for (const bin of candidates) {
    if (path.isAbsolute(bin) && !fs.existsSync(bin)) continue;
    try {
      const { stdout } = await runner(bin, ['status', '--json']);
      return parseTailscaleStatusJson(stdout, port);
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
      lastDiag = stderrDiagnosticOf(err?.stderr || err?.message || '');
      return {
        installed: true,
        running: false,
        backendState: 'Stopped',
        online: false,
        dnsName: '',
        ipv4: '',
        magicDnsUrl: '',
        ipv4Url: '',
        diagnostic: lastDiag,
      };
    }
  }

  return {
    installed: false,
    running: false,
    backendState: 'NotInstalled',
    online: false,
    dnsName: '',
    ipv4: '',
    magicDnsUrl: '',
    ipv4Url: '',
    diagnostic: lastDiag,
  };
}

let cachedScreenCapture = { ts: 0, payload: null };
let inFlightScreenCapture = null;
const screenPreviewWaiters = new Set();

export function getCachedScreenPreviewAgeMs() {
  if (!cachedScreenCapture.payload || !cachedScreenCapture.ts) return Number.POSITIVE_INFINITY;
  return Math.max(0, Date.now() - cachedScreenCapture.ts);
}

export function waitForFreshScreenPreview(timeoutMs = 900) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      screenPreviewWaiters.delete(onFrame);
      resolve(cachedScreenCapture.payload || null);
    }, Math.max(120, Number(timeoutMs) || 900));
    timer.unref?.();

    function onFrame(frame) {
      clearTimeout(timer);
      screenPreviewWaiters.delete(onFrame);
      resolve(frame);
    }
    screenPreviewWaiters.add(onFrame);
  });
}

export function updateCachedScreenPreview(frame = {}) {
  const cleanB64 = String(frame.base64 || '').replace(/^data:[^;]+;base64,/, '');
  if (!cleanB64) return null;
  const built = {
    ok: true,
    capturedAt: new Date().toISOString(),
    mimeType: String(frame.mimeType || 'image/jpeg'),
    width: Math.max(1, Number(frame.width) || 1280),
    height: Math.max(1, Number(frame.height) || 720),
    origWidth: Math.max(1, Number(frame.origWidth || frame.width) || 1280),
    origHeight: Math.max(1, Number(frame.origHeight || frame.height) || 720),
    base64: cleanB64,
    source: 'desktop-bridge',
  };
  cachedScreenCapture = { ts: Date.now(), payload: built };
  for (const waiter of [...screenPreviewWaiters]) {
    try {
      waiter(built);
    } catch {
      // ignore waiter error
    }
  }
  return built;
}

export async function captureHostScreenPreview({
  maxWidth = 1280,
  quality = 68,
  cacheTtlMs = 800,
  runnerOverride = null,
} = {}) {
  const now = Date.now();
  if (cachedScreenCapture.payload && now - cachedScreenCapture.ts < cacheTtlMs) {
    return cachedScreenCapture.payload;
  }
  if (!runnerOverride && inFlightScreenCapture) {
    return inFlightScreenCapture;
  }

  const safeWidth = Math.max(480, Math.min(1920, Number(maxWidth) || 1280));
  const safeQuality = Math.max(35, Math.min(92, Number(quality) || 68));

  const doCapture = async () => {
    if (typeof runnerOverride === 'function') {
      const custom = await runnerOverride({ maxWidth: safeWidth, quality: safeQuality });
      const built = {
        ok: true,
        capturedAt: new Date().toISOString(),
        mimeType: custom.mimeType || 'image/jpeg',
        width: Number(custom.width) || safeWidth,
        height: Number(custom.height) || 720,
        base64: String(custom.base64 || ''),
      };
      cachedScreenCapture = { ts: Date.now(), payload: built };
      return built;
    }

    if (cachedScreenCapture.payload && Date.now() - cachedScreenCapture.ts < 300_000) {
      return cachedScreenCapture.payload;
    }

    return {
      ok: false,
      needsDesktopSync: true,
      error:
        '等待桌面端画面同步：在电脑端 AChat 打开「🖥 桌面」（或点「↻ 刷新画面」）后，本机与手机端即可实时查看最新桌面画面',
    };
  };

  if (runnerOverride) {
    return doCapture();
  }
  const p = doCapture().finally(() => {
    if (inFlightScreenCapture === p) inFlightScreenCapture = null;
  });
  inFlightScreenCapture = p;
  return p;
}
