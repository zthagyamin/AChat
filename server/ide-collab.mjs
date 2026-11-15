/**
 * IDE Task Progress Board & Return-to-Chat Collaboration Protocol helpers.
 *
 * Keeps protocol parsing, step extraction, tag stripping, and per-actor IDE
 * board reduction pure and unit-testable outside CcccBridge.
 */

const VALID_STEP_STATUSES = new Set(['done', 'active', 'pending', 'blocked']);

export const PHASE_LABELS = Object.freeze({
  idle: '待命中',
  aligning: '群内对齐中',
  running: 'IDE 执行中',
  collab: '回群协作中',
  reviewing: '主审验收中',
  rework: '按审返修中',
  done: '已完成',
  error: '需处理',
});

/**
 * Strip hidden `<!--achat-steps:...-->`, `<!--achat-collab:...-->`, and
 * `<!--achat-review:...-->` markers (including incomplete trailing markers during streaming).
 */
export function stripIdeProtocolTags(rawText = '') {
  let out = String(rawText || '');
  out = out.replace(/<!--\s*achat-(?:steps|collab|review):[\s\S]*?-->/gi, '');
  out = out.replace(/<!--\s*achat-(?:steps|collab|review):[\s\S]*$/gi, '');
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

function normalizeStepStatus(raw = '') {
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'done' || s === 'completed' || s === 'complete' || s === 'x') return 'done';
  if (s === 'active' || s === 'in_progress' || s === 'running' || s === '/') return 'active';
  if (s === 'blocked' || s === 'error' || s === 'failed') return 'blocked';
  return VALID_STEP_STATUSES.has(s) ? s : 'pending';
}

function normalizeStepsArray(rawList = [], maxSteps = 8) {
  const out = [];
  const seen = new Set();
  for (let i = 0; i < rawList.length && out.length < maxSteps; i += 1) {
    const item = rawList[i];
    if (!item) continue;
    let title = '';
    let status = 'pending';
    if (typeof item === 'string') {
      title = item.replace(/\s+/g, ' ').trim();
    } else if (typeof item === 'object') {
      title = String(item.title || item.label || item.name || item.step || '')
        .replace(/\s+/g, ' ')
        .trim();
      status = normalizeStepStatus(item.status || item.state || '');
    }
    if (!title) continue;
    const clipped = title.slice(0, 96);
    const dedupeKey = clipped.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({
      id: `step-${out.length + 1}`,
      title: clipped,
      status,
    });
  }
  return out;
}

/**
 * Extract structured IDE checklist steps from explicit `<!--achat-steps:[...]-->`
 * or fallback markdown task checklists (`- [x] ...` / `- [ ] ...`).
 */
export function parseIdeStepsFromText(rawText = '') {
  const txt = String(rawText || '');
  if (!txt.trim()) return [];

  const tagMatches = [...txt.matchAll(/<!--\s*achat-steps:([\s\S]*?)-->/gi)];
  for (let i = tagMatches.length - 1; i >= 0; i -= 1) {
    const body = String(tagMatches[i][1] || '').trim();
    if (!body) continue;
    try {
      const parsed = JSON.parse(body);
      const list = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.steps)
          ? parsed.steps
          : [];
      const normalized = normalizeStepsArray(list);
      if (normalized.length > 0) return normalized;
    } catch {
      // ignore malformed JSON tag and try earlier/fallback patterns
    }
  }

  // Fallback: markdown checkbox lines (`- [x] ...`, `- [/] ...`, `- [ ] ...`)
  const checkboxItems = [];
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*[-*]\s+\[([ xX/!])\]\s+(.+)$/);
    if (!m) continue;
    const mark = m[1].toLowerCase();
    const status =
      mark === 'x' ? 'done' : mark === '/' ? 'active' : mark === '!' ? 'blocked' : 'pending';
    checkboxItems.push({ title: m[2].trim(), status });
  }
  if (checkboxItems.length > 0) {
    return normalizeStepsArray(checkboxItems);
  }

  return [];
}

/**
 * Parse a return-to-chat collaboration request from an agent's IDE output.
 * Returns null unless the agent explicitly asks to return to AChat to sync with its peer.
 */
export function parseCollabSignal(rawText = '', { fromActor = '', validTargets = [] } = {}) {
  const txt = String(rawText || '');
  if (!txt.trim()) return null;

  const targetEntries = Array.isArray(validTargets)
    ? validTargets
        .map((t) =>
          typeof t === 'string'
            ? { slotId: t, label: t }
            : t && typeof t === 'object'
              ? { slotId: String(t.slotId || t.id || ''), label: String(t.label || t.title || '') }
              : null
        )
        .filter((t) => t && t.slotId)
    : [];

  const normalizeTarget = (rawTo = '') => {
    const clean = String(rawTo || '').trim().replace(/^@/, '');
    const lower = clean.toLowerCase();
    if (lower === 'all' || lower === 'both' || lower === '所有人' || lower === '全部会话') {
      return 'all';
    }
    const matched = targetEntries.find(
      (t) =>
        t.slotId === clean ||
        t.slotId.toLowerCase() === lower ||
        (t.label && t.label.toLowerCase() === lower)
    );
    if (matched) return matched.slotId;
    if (lower === 'codex' || lower === 'cx') {
      const firstCx = targetEntries.find((t) => t.slotId.toLowerCase().startsWith('codex'));
      return firstCx ? firstCx.slotId : 'codex';
    }
    if (lower === 'antigravity' || lower === 'agy' || lower === 'ag') {
      const firstAg = targetEntries.find(
        (t) => t.slotId.toLowerCase() !== 'codex' && !t.slotId.toLowerCase().startsWith('codex')
      );
      return firstAg ? firstAg.slotId : 'antigravity';
    }
    if (/^[a-zA-Z0-9_-]{1,36}$/.test(clean)) return clean;
    if (fromActor === 'codex') return 'antigravity';
    if (fromActor === 'antigravity') return 'codex';
    return 'all';
  };

  const tagMatches = [...txt.matchAll(/<!--\s*achat-collab:([\s\S]*?)-->/gi)];
  for (let i = tagMatches.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(String(tagMatches[i][1] || '').trim());
      if (!parsed || parsed.needCollab !== true) continue;
      const message = String(parsed.message || parsed.summary || '').trim();
      if (!message) continue;
      return {
        needCollab: true,
        to: normalizeTarget(parsed.to),
        reason: String(parsed.reason || '需要回群与同伴协作对齐').trim().slice(0, 120),
        message: message.slice(0, 2400),
        nextSteps: Array.isArray(parsed.nextSteps)
          ? parsed.nextSteps.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 6)
          : [],
      };
    } catch {
      // ignore malformed tag
    }
  }

  // Natural explicit fallback block: `【回群协作】...`
  const fallbackMatch = txt.match(/(?:^|\n)\s*(?:【回群协作】|🤝\s*回群沟通[：:])\s*([\s\S]{8,1600})$/);
  if (fallbackMatch) {
    const cleanMsg = stripIdeProtocolTags(fallbackMatch[1]).trim();
    if (cleanMsg) {
      return {
        needCollab: true,
        to: normalizeTarget(
          /@?codex/i.test(cleanMsg) && !/@?antigravity/i.test(cleanMsg)
            ? 'codex'
            : /@?antigravity/i.test(cleanMsg) && !/@?codex/i.test(cleanMsg)
              ? 'antigravity'
              : ''
        ),
        reason: '请求回群沟通协作',
        message: cleanMsg,
        nextSteps: [],
      };
    }
  }

  return null;
}

/**
 * Parse a lead reviewer acceptance verdict (`<!--achat-review:...-->`).
 */
export function parseReviewVerdict(rawText = '', { validTargets = [] } = {}) {
  const txt = String(rawText || '');
  if (!txt.trim()) return null;

  const targetEntries = Array.isArray(validTargets)
    ? validTargets
        .map((t) =>
          typeof t === 'string'
            ? { slotId: t, label: t }
            : t && typeof t === 'object'
              ? { slotId: String(t.slotId || t.id || ''), label: String(t.label || t.title || '') }
              : null
        )
        .filter((t) => t && t.slotId)
    : [];

  const tagMatches = [...txt.matchAll(/<!--\s*achat-review:([\s\S]*?)-->/gi)];
  for (let i = tagMatches.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(String(tagMatches[i][1] || '').trim());
      if (!parsed || typeof parsed.approved !== 'boolean') continue;
      const rawTargets = Array.isArray(parsed.targets)
        ? parsed.targets
        : typeof parsed.target === 'string'
          ? [parsed.target]
          : [];
      const targets = [];
      for (const rawT of rawTargets) {
        const clean = String(rawT || '').trim().replace(/^@/, '');
        if (!clean) continue;
        const lower = clean.toLowerCase();
        const found = targetEntries.find(
          (t) =>
            t.slotId === clean ||
            t.slotId.toLowerCase() === lower ||
            (t.label && t.label.toLowerCase() === lower)
        );
        const id = found ? found.slotId : /^[a-zA-Z0-9_-]{1,36}$/.test(clean) ? clean : '';
        if (id && !targets.includes(id)) targets.push(id);
      }
      return {
        approved: parsed.approved,
        targets,
        feedback: String(parsed.feedback || parsed.reason || parsed.summary || '').trim().slice(0, 2400),
      };
    } catch {
      // ignore malformed tag
    }
  }
  return null;
}

/**
 * Extract a concise per-actor/slot subtask label from alignment messages.
 */
export function extractActorSubtaskHint(alignmentText = '', actorId = '', customLabel = '') {
  const clean = stripIdeProtocolTags(alignmentText);
  if (!clean) return '';
  const escapeRegExp = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const candidates = [
    customLabel,
    actorId,
    actorId === 'codex' ? 'Codex' : actorId === 'antigravity' ? 'Antigravity' : '',
  ]
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  const uniqueCandidates = Array.from(new Set(candidates));
  const lines = clean.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const name of uniqueCandidates) {
    const escaped = escapeRegExp(name);
    const re = new RegExp(
      `^(?:[-*•\\d.)\\s]*)?(?:【?${escaped}(?:\\s*\\([^)]*\\))?(?:\\s*负责)?】?|\\*\\*${escaped}[^*]*\\*\\*)\\s*[：:]\\s*(.+)$`,
      'i'
    );
    for (const line of lines) {
      const match = line.match(re);
      if (match && match[1]) {
        return match[1].replace(/\*\*/g, '').trim().slice(0, 110);
      }
    }
  }
  return '';
}

export function createActorBoardState(actorId, overrides = {}) {
  const inferredProvider = String(actorId || '').toLowerCase().startsWith('codex')
    ? 'codex'
    : 'antigravity';
  const defaultTitle =
    actorId === 'codex' ? 'Codex' : actorId === 'antigravity' ? 'Antigravity' : actorId;
  const phase = overrides.phase && PHASE_LABELS[overrides.phase] ? overrides.phase : 'idle';
  return {
    actorId,
    provider: overrides.provider || inferredProvider,
    role: overrides.role === 'lead' ? 'lead' : 'peer',
    title: overrides.title || defaultTitle,
    phase,
    phaseLabel: overrides.phaseLabel || PHASE_LABELS[phase],
    subtask: overrides.subtask || '',
    sessionTitle: overrides.sessionTitle || '',
    sessionMode: overrides.sessionMode || 'group',
    sessionId: overrides.sessionId || '',
    round: Number(overrides.round || 0),
    steps: Array.isArray(overrides.steps) ? overrides.steps : [],
    currentAction: overrides.currentAction || '',
    recentActions: Array.isArray(overrides.recentActions) ? overrides.recentActions : [],
    collabNote: overrides.collabNote || '',
    startedAt: overrides.startedAt || '',
    lastActivityAt: overrides.lastActivityAt || '',
    completedAt: overrides.completedAt || '',
  };
}

export function pushBoardRecentAction(recentActions = [], kind = 'tool', text = '', maxItems = 7) {
  const cleanText = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 140);
  if (!cleanText) return Array.isArray(recentActions) ? recentActions : [];
  const next = Array.isArray(recentActions) ? [...recentActions] : [];
  const last = next[0];
  if (last && last.text === cleanText && last.kind === kind) {
    next[0] = { ...last, ts: new Date().toISOString() };
    return next;
  }
  next.unshift({
    ts: new Date().toISOString(),
    kind: kind === 'thinking' ? 'thinking' : kind === 'collab' ? 'collab' : 'tool',
    text: cleanText,
  });
  return next.slice(0, maxItems);
}

/**
 * Compact fingerprint of an `ideBoard` object for SSE change detection.
 */
export function computeIdeBoardFingerprint(ideBoard = null) {
  if (!ideBoard || typeof ideBoard !== 'object') return '';
  const actors = ideBoard.actors || {};
  const parts = Object.keys(actors)
    .sort()
    .map((id) => {
      const a = actors[id] || {};
      const stepsKey = (a.steps || []).map((s) => `${s.status}:${s.title}`).join('|');
      const topAction = a.recentActions?.[0]?.text || '';
      return `${id}:${a.role || 'peer'}:${a.title || ''}:${a.phase}:${a.round}:${a.currentAction}:${stepsKey}:${topAction}:${a.lastActivityAt}`;
    });
  return `${ideBoard.taskTitle || ''}|${ideBoard.round || 0}|${ideBoard.stageText || ''}|${parts.join(';')}`;
}
