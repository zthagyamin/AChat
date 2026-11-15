import { marked } from '/vendor/marked.esm.js';

marked.setOptions({
  breaks: true,
  gfm: true,
});

// --- Sanitizer API with lazy DOMPurify fallback (modern-web-guidance: sanitize-untrusted-html) ---
const ALLOWED_ELEMENTS = [
  'p', 'br', 'b', 'i', 'strong', 'em', 'code', 'pre',
  'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4',
  'a', 'hr', 'del', 'span', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
];
const ALLOWED_ATTRIBUTES = ['href', 'title', 'target', 'rel', 'class'];

let domPurifyPromise = null;
function loadDOMPurify() {
  domPurifyPromise ??= import('/vendor/purify.es.mjs').then((mod) => mod.default ?? mod);
  return domPurifyPromise;
}

let katexPromise = null;
function loadKatex() {
  katexPromise ??= import('/vendor/katex/katex.mjs')
    .then((mod) => mod.default ?? mod)
    .catch(() => null);
  return katexPromise;
}

let mermaidPromise = null;
function loadMermaid() {
  mermaidPromise ??= import('/vendor/mermaid/mermaid.esm.min.mjs')
    .then((mod) => mod.default ?? mod)
    .catch(() => null);
  return mermaidPromise;
}

function triggerLightHaptic() {
  try {
    window.AndroidBridge?.triggerHaptic?.();
  } catch {
    // ignore bridge error
  }
}

async function safeSetHTML(el, html) {
  if ('setHTML' in Element.prototype) {
    el.setHTML(html, {
      sanitizer: { elements: ALLOWED_ELEMENTS, attributes: ALLOWED_ATTRIBUTES },
    });
  } else {
    const DOMPurify = await loadDOMPurify();
    el.innerHTML = DOMPurify.sanitize(html, {
      ALLOWED_TAGS: [...ALLOWED_ELEMENTS, '#text'],
      ALLOWED_ATTR: ALLOWED_ATTRIBUTES,
      ALLOW_ARIA_ATTR: false,
      ALLOW_DATA_ATTR: false,
      KEEP_CONTENT: false,
    });
  }
}

// --- Theme Management (modern-web-guidance: dark-mode & dark-mode-toggle) ---
const systemDarkMql = window.matchMedia('(prefers-color-scheme: dark)');

function getMetaColorScheme() {
  return document.querySelector('meta[name="color-scheme"]');
}

function getStoredColorScheme() {
  try {
    const v = localStorage.getItem('color-scheme');
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

function getMetaOverrideColorScheme() {
  const c = getMetaColorScheme()?.content?.trim();
  return c === 'light' || c === 'dark' ? c : null;
}

function getRenderedColorScheme() {
  return getMetaOverrideColorScheme() ?? getStoredColorScheme() ?? (systemDarkMql.matches ? 'dark' : 'light');
}

function syncThemeControlsUI() {
  const stored = getStoredColorScheme();
  const sysNow = systemDarkMql.matches ? 'dark' : 'light';
  const rendered = getRenderedColorScheme();

  const hintEl = document.getElementById('popThemeSysHint');
  if (hintEl) {
    hintEl.textContent = `外观模式（系统当前：${sysNow === 'dark' ? '深色' : '浅色'}）`;
  }
  for (const btn of document.querySelectorAll('[data-theme-choice]')) {
    const choice = btn.dataset.themeChoice;
    const active = choice === 'system' ? stored === null : choice === stored;
    btn.classList.toggle('is-active', active);
  }
  const mobBtn = document.getElementById('mobileThemeBtn');
  if (mobBtn) {
    mobBtn.textContent = rendered === 'dark' ? '浅色' : '深色';
  }
  try {
    window.AndroidBridge?.syncTheme?.(rendered === 'dark');
  } catch {
    // ignore bridge error
  }
}

function applyThemeChoice(choice) {
  const meta = getMetaColorScheme();
  try {
    if (choice === 'light' || choice === 'dark') {
      localStorage.setItem('color-scheme', choice);
    } else {
      localStorage.removeItem('color-scheme');
    }
  } catch {
    // storage blocked; still apply to meta below
  }
  if (meta) {
    meta.content = choice === 'light' || choice === 'dark' ? choice : 'light dark';
  }
  syncThemeControlsUI();
  rerenderVisibleMermaidDiagrams();
}

function toggleTwoStateComfortTheme() {
  const rendered = getRenderedColorScheme();
  const target = rendered === 'dark' ? 'light' : 'dark';
  const sysNow = systemDarkMql.matches ? 'dark' : 'light';
  if (target === sysNow) {
    applyThemeChoice('system');
  } else {
    applyThemeChoice(target);
  }
}

// --- Dual-Skin Management (Scheme A 'workbench' + Scheme B 'editorial', modern-web-guidance: design-token-reactivity) ---
const UI_SKIN_STORAGE_KEY = 'achat-ui-skin';

function normalizeUiSkin(skin) {
  return skin === 'editorial' ? 'editorial' : 'workbench';
}

function getActiveUiSkin() {
  return normalizeUiSkin(document.documentElement.dataset.uiSkin);
}

function isIdeBoardCollapsedForGroup(groupId) {
  if (groupId && state.ideBoardCollapsedByGroup.has(groupId)) {
    return Boolean(state.ideBoardCollapsedByGroup.get(groupId));
  }
  return getActiveUiSkin() === 'editorial';
}

function syncSkinControlsUI() {
  const activeSkin = getActiveUiSkin();
  const skinLabel = activeSkin === 'editorial' ? '沉浸阅读 (方案 B)' : '极简工作台 (方案 A)';

  const hintEl = document.getElementById('popSkinHint');
  if (hintEl) {
    hintEl.textContent = `界面皮肤（当前：${skinLabel}）`;
  }
  for (const btn of document.querySelectorAll('[data-skin-choice]')) {
    const choice = normalizeUiSkin(btn.dataset.skinChoice);
    const active = choice === activeSkin;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
  if (els.skinToggleBtn) {
    els.skinToggleBtn.classList.toggle('is-editorial', activeSkin === 'editorial');
    els.skinToggleBtn.setAttribute('aria-pressed', activeSkin === 'editorial' ? 'true' : 'false');
    els.skinToggleBtn.title = `当前皮肤：${skinLabel}（点击切换另一套皮肤）`;
  }
  if (els.mobileSkinBtn) {
    els.mobileSkinBtn.textContent = activeSkin === 'editorial' ? '沉浸' : '工作台';
  }
}

function applyUiSkin(skin, { persist = true, resetBoardPosture = true } = {}) {
  const nextSkin = normalizeUiSkin(skin);
  document.documentElement.dataset.uiSkin = nextSkin;
  if (persist) {
    try {
      localStorage.setItem(UI_SKIN_STORAGE_KEY, nextSkin);
    } catch {
      // ignore storage errors
    }
  }
  if (resetBoardPosture) {
    state.ideBoardCollapsedByGroup.clear();
  }
  syncSkinControlsUI();
  const selectedGroup = getSelectedGroup();
  if (selectedGroup) {
    renderIdeTaskBoard(selectedGroup);
  }
}

function toggleUiSkin() {
  const nextSkin = getActiveUiSkin() === 'editorial' ? 'workbench' : 'editorial';
  applyUiSkin(nextSkin, { persist: true, resetBoardPosture: true });
  triggerLightHaptic();
  showToast(
    nextSkin === 'editorial'
      ? '已切换皮肤：沉浸阅读 (方案 B)'
      : '已切换皮肤：极简工作台 (方案 A)'
  );
}

// --- Polyfills / Fallbacks for Dialog closedby & Invoker Commands (modern-web-guidance) ---
function setupModernOverlayFallbacks() {
  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.addEventListener('close', () => {
      dialog.returnValue = '';
    });
  }

  for (const dialog of document.querySelectorAll('dialog[closedby="any"]')) {
    if (!('closedBy' in HTMLDialogElement.prototype)) {
      let pressOutside = false;
      const isPointOutside = (ev) => {
        const rect = dialog.getBoundingClientRect();
        return (
          ev.clientY < rect.top ||
          ev.clientY > rect.top + rect.height ||
          ev.clientX < rect.left ||
          ev.clientX > rect.left + rect.width
        );
      };
      dialog.addEventListener('pointerdown', (event) => {
        pressOutside = event.target === dialog && isPointOutside(event);
      });
      dialog.addEventListener('pointerup', (event) => {
        if (pressOutside && event.target === dialog && isPointOutside(event)) {
          dialog.close();
        }
        pressOutside = false;
      });
    }
  }

  if (!('commandForElement' in HTMLButtonElement.prototype)) {
    import('https://unpkg.com/invokers-polyfill@latest/invoker.min.js').catch(() => {});
    document.addEventListener('click', (event) => {
      if ('commandForElement' in HTMLButtonElement.prototype) return;
      const btn = event.composedPath().find((el) => el.matches?.('button[commandfor]'));
      if (!btn) return;
      const target = document.getElementById(btn.getAttribute('commandfor'));
      const cmd = btn.getAttribute('command');
      if (!target || !cmd) return;
      if (cmd === 'show-modal' && typeof target.showModal === 'function') {
        target.showModal();
      } else if (cmd === 'close' && typeof target.close === 'function') {
        target.close();
      } else if (cmd === 'toggle-popover' && typeof target.togglePopover === 'function') {
        target.togglePopover();
      }
    });
  }

  // MANDATORY feature detection for Popover polyfill (modern-web-guidance: content-first-noise-reduction)
  if (!('popover' in HTMLElement.prototype)) {
    import('https://unpkg.com/@oddbird/popover-polyfill@latest/dist/popover.min.js').catch(() => {});
  }

  // Viewport-aware fallback positioning when CSS Anchor Positioning is unsupported
  const setupPopoverFallback = (popEl, btnEl, { maxW = 356, placeBelow = false } = {}) => {
    if (!popEl || !btnEl || CSS.supports('position-area', 'block-start span-inline-start')) return;
    const placePopover = () => {
      const btnRect = btnEl.getBoundingClientRect();
      const popWidth = Math.min(maxW, window.innerWidth - 24);
      const left = Math.max(12, Math.min(btnRect.right - popWidth, window.innerWidth - popWidth - 12));
      popEl.style.position = 'fixed';
      popEl.style.inset = 'auto';
      popEl.style.left = `${Math.round(left)}px`;
      if (placeBelow) {
        const topOffset = Math.max(12, Math.min(btnRect.bottom + 8, window.innerHeight - 240));
        popEl.style.top = `${Math.round(topOffset)}px`;
        popEl.style.bottom = 'auto';
      } else {
        const bottomOffset = Math.max(12, window.innerHeight - btnRect.top + 8);
        popEl.style.bottom = `${Math.round(bottomOffset)}px`;
        popEl.style.top = 'auto';
      }
    };
    popEl.addEventListener('beforetoggle', (ev) => {
      if (ev.newState === 'open') placePopover();
    });
    window.addEventListener('resize', () => {
      if (popEl.matches?.(':popover-open') || popEl.classList.contains(':popover-open')) {
        placePopover();
      }
    });
  };
  setupPopoverFallback(
    document.getElementById('composerMorePopover'),
    document.getElementById('composerMoreBtn'),
    { maxW: 356, placeBelow: false }
  );
  setupPopoverFallback(
    document.getElementById('chatQuickMenuPopover'),
    document.getElementById('chatQuickMenuBtn'),
    { maxW: 280, placeBelow: true }
  );
}

// --- Application State ---
const state = {
  navTab: 'chats', // 'chats' | 'contacts' | 'favorites'
  groups: [],
  selectedGroupId: null,
  messagesByGroup: new Map(),
  unreadByGroup: new Map(),
  thinkingByGroup: new Map(), // groupId -> string[] of actorIds
  relayByGroup: new Map(), // groupId -> { active, step, text }
  starredIds: new Set(JSON.parse(localStorage.getItem('aw_starred') || '[]')),
  starredItems: new Map(), // id -> { id, groupId, groupTitle, senderTitle, text, ts }
  customTemplates: [], // [{ id, cmd, label, prompt }]
  showArchivedGroups: false,
  multiSelectMode: false,
  selectedMsgIds: new Set(),
  draftsByGroup: JSON.parse(localStorage.getItem('aw_drafts') || '{}'),
  sharedContext: localStorage.getItem('aw_shared_ctx') !== 'false',
  selectedRecipients: [], // [] means default @all
  pendingAttachments: [], // [{ id, kind: 'image'|'file', fileName, url, filePath }]
  activeQuote: null, // { sender, text }
  switchingGear: false,
  uploadingCount: 0,
  searchQuery: '',
  searchHits: [],
  searchingMessages: false,
  belowFoldCount: 0,
  mentionActive: false,
  autocompleteKind: null, // 'mention' | 'slash' | 'file' | null
  mentionIndex: 0,
  mentionCandidates: [],
  cmdPaletteIndex: 0,
  cmdPaletteItems: [],
  lightboxZoom: 1,
  activeGitSummary: null,
  activeDiffContext: null,
  cropState: null,
  pendingOptimistic: new Map(), // tempId -> { groupId, cleanText, attCount }
  thinkingStartedAt: new Map(), // `${groupId}:${actorId}` -> epoch ms
  controllingTurn: false,
  isLocalSession: Boolean(window.electronApp?.isDesktop),
  assetVersion: null,
  pendingHotReload: false,
  isComposingInput: false,
  lastSendReady: null,
  lastSendDisabled: null,
  lastQueueBtnHidden: null,
  lastQueueBtnDisabled: null,
  lastSendHintText: '',
  renderedGroupId: null,
  renderedMessagesSig: '',
  lastSessionRenderKey: '',
  lastRecipientChipsKey: '',
  lastClientSyncKey: '',
  lastDrawerRenderKey: '',
  externalSessions: { codex: [], antigravity: [], recentDirectories: [] },
  externalSessionsLoaded: false,
  loadingExternalSessions: false,
  sessionBarOpenByGroup: new Map(),
  sessionFilterQuery: '',
  lastCodexSelectKey: '',
  lastAgySelectKey: '',
  slotSelectCacheKeys: new Map(), // `${groupId}:${slotId}` -> cache key
  openIdeSlotDetails: new Set(), // `${groupId}:${slotId}` expanded accordions
  queuedByGroup: new Map(), // groupId -> Array<{ rawInputText, attachments, quote, explicitRecipients }>
  drainingQueueGroupId: null,
  activeStreamsByGroup: new Map(), // groupId -> Map(streamId -> frame)
  paginationByGroup: new Map(), // groupId -> { startIndex, totalCount, hasMore, loadingMore }
  retryingActorKey: '',
  providerEcosystem: null,
  loadingProviders: false,
  worktreesByGroup: new Map(), // groupId -> worktree[]
  computerPreviewFrame: null,
  computerPreviewTimer: null,
  loadingComputerPreview: false,
  pendingDiscardConfirmKey: '',
  pendingDiscardTimer: null,
  lastBgStepNotifyAt: new Map(), // groupId -> epoch ms
  ideBoardsByGroup: new Map(), // groupId -> live IDE Task Progress Board snapshot
  ideBoardCollapsedByGroup: new Map(), // groupId -> boolean
  sessionPresetsOpenByGroup: new Map(), // groupId -> boolean
  ideBoardTicker: null,
};

const mobileViewportMql = window.matchMedia('(max-width: 768px)');

const els = {
  appRoot: document.getElementById('appRoot'),
  myAvatarBtn: document.getElementById('myAvatarBtn'),
  daemonDot: document.getElementById('daemonDot'),
  totalUnreadBadge: document.getElementById('totalUnreadBadge'),
  mobileGroupCount: document.getElementById('mobileGroupCount'),
  mobileSkinBtn: document.getElementById('mobileSkinBtn'),
  mobileThemeBtn: document.getElementById('mobileThemeBtn'),
  skinToggleBtn: document.getElementById('skinToggleBtn'),
  androidServerBtn: document.getElementById('androidServerBtn'),
  netStatePill: document.getElementById('netStatePill'),
  searchInput: document.getElementById('searchInput'),
  sessionList: document.getElementById('sessionList'),
  desktopWinBar: document.getElementById('desktopWinBar'),
  winPinBtn: document.getElementById('winPinBtn'),
  winMinBtn: document.getElementById('winMinBtn'),
  winMaxBtn: document.getElementById('winMaxBtn'),
  winCloseBtn: document.getElementById('winCloseBtn'),
  emptyWatermark: document.getElementById('emptyWatermark'),
  activeChatWrap: document.getElementById('activeChatWrap'),
  mobileBackBtn: document.getElementById('mobileBackBtn'),
  chatTitle: document.getElementById('chatTitle'),
  chatSubtitle: document.getElementById('chatSubtitle'),
  openSessionRoutingBtn: document.getElementById('openSessionRoutingBtn'),
  chatQuickMenuBtn: document.getElementById('chatQuickMenuBtn'),
  chatQuickMenuPopover: document.getElementById('chatQuickMenuPopover'),
  pinSessionBtn: document.getElementById('pinSessionBtn'),
  openComputerPreviewBtn: document.getElementById('openComputerPreviewBtn'),
  replyStyleBtn: document.getElementById('replyStyleBtn'),
  speedGearBtn: document.getElementById('speedGearBtn'),
  toggleDrawerBtn: document.getElementById('toggleDrawerBtn'),
  ideTaskBoard: document.getElementById('ideTaskBoard'),
  itbTaskTitle: document.getElementById('itbTaskTitle'),
  itbStageText: document.getElementById('itbStageText'),
  itbRoundPill: document.getElementById('itbRoundPill'),
  itbRetryBtn: document.getElementById('itbRetryBtn'),
  itbInterruptBtn: document.getElementById('itbInterruptBtn'),
  itbToggleBtn: document.getElementById('itbToggleBtn'),
  itbGrid: document.getElementById('itbGrid'),
  messageStream: document.getElementById('messageStream'),
  newMsgJumpBtn: document.getElementById('newMsgJumpBtn'),
  relayBanner: document.getElementById('relayBanner'),
  relayBannerText: document.getElementById('relayBannerText'),
  typingBanner: document.getElementById('typingBanner'),
  typingBannerText: document.getElementById('typingBannerText'),
  retryTurnBtn: document.getElementById('retryTurnBtn'),
  interruptTurnBtn: document.getElementById('interruptTurnBtn'),
  themeToggleBtn: document.getElementById('themeToggleBtn'),
  dropOverlay: document.getElementById('dropOverlay'),
  composerArea: document.getElementById('composerArea'),
  mentionMenu: document.getElementById('mentionMenu'),
  multiSelectBar: document.getElementById('multiSelectBar'),
  multiSelectCount: document.getElementById('multiSelectCount'),
  multiForwardBtn: document.getElementById('multiForwardBtn'),
  multiStarBtn: document.getElementById('multiStarBtn'),
  multiExportBtn: document.getElementById('multiExportBtn'),
  multiNativeShareBtn: document.getElementById('multiNativeShareBtn'),
  multiCancelBtn: document.getElementById('multiCancelBtn'),
  mentionBtn: document.getElementById('mentionBtn'),
  slashCmdBtn: document.getElementById('slashCmdBtn'),
  scopeFileBtn: document.getElementById('scopeFileBtn'),
  attachImageBtn: document.getElementById('attachImageBtn'),
  attachFileBtn: document.getElementById('attachFileBtn'),
  screenCaptureBtn: document.getElementById('screenCaptureBtn'),
  hiddenImageInput: document.getElementById('hiddenImageInput'),
  hiddenFileInput: document.getElementById('hiddenFileInput'),
  collabModeBar: document.getElementById('collabModeBar'),
  relayOrderBtn: document.getElementById('relayOrderBtn'),
  blindHintChip: document.getElementById('blindHintChip'),
  recipientBar: document.getElementById('recipientBar'),
  targetSessionToggleBtn: document.getElementById('targetSessionToggleBtn'),
  composerMoreBtn: document.getElementById('composerMoreBtn'),
  composerMorePopover: document.getElementById('composerMorePopover'),
  sharedCtxStateHint: document.getElementById('sharedCtxStateHint'),
  replyModeStateHint: document.getElementById('replyModeStateHint'),
  sessionRoutingDialog: document.getElementById('sessionRoutingDialog'),
  toggleSessionPresetsBtn: document.getElementById('toggleSessionPresetsBtn'),
  sessionPresetPanel: document.getElementById('sessionPresetPanel'),
  sessionPresetSummary: document.getElementById('sessionPresetSummary'),
  sessionFlowSeg: document.getElementById('sessionFlowSeg'),
  sessionPermSeg: document.getElementById('sessionPermSeg'),
  autoReviewToggleBtn: document.getElementById('autoReviewToggleBtn'),
  autoWakeToggleBtn: document.getElementById('autoWakeToggleBtn'),
  sessionFilterInput: document.getElementById('sessionFilterInput'),
  refreshExtSessionsBtn: document.getElementById('refreshExtSessionsBtn'),
  presetOneLeadTwoAgyBtn: document.getElementById('presetOneLeadTwoAgyBtn'),
  resetSessionRoutingBtn: document.getElementById('resetSessionRoutingBtn'),
  sessionSlotsList: document.getElementById('sessionSlotsList'),
  addAgySlotBtn: document.getElementById('addAgySlotBtn'),
  addCodexSlotBtn: document.getElementById('addCodexSlotBtn'),
  srdSlotCountHint: document.getElementById('srdSlotCountHint'),
  recentProjectDirsList: document.getElementById('recentProjectDirsList'),
  queuedTurnBar: document.getElementById('queuedTurnBar'),
  queuedTurnText: document.getElementById('queuedTurnText'),
  steerQueuedTurnBtn: document.getElementById('steerQueuedTurnBtn'),
  flushQueuedNowBtn: document.getElementById('flushQueuedNowBtn'),
  clearQueuedBtn: document.getElementById('clearQueuedBtn'),
  sharedCtxBtn: document.getElementById('sharedCtxBtn'),
  replyModeBtn: document.getElementById('replyModeBtn'),
  quoteBar: document.getElementById('quoteBar'),
  quoteBarText: document.getElementById('quoteBarText'),
  clearQuoteBtn: document.getElementById('clearQuoteBtn'),
  attachmentStrip: document.getElementById('attachmentStrip'),
  messageInput: document.getElementById('messageInput'),
  composerSendHint: document.getElementById('composerSendHint'),
  queueMsgBtn: document.getElementById('queueMsgBtn'),
  sendBtn: document.getElementById('sendBtn'),
  groupDrawer: document.getElementById('groupDrawer'),
  drawerMemberGrid: document.getElementById('drawerMemberGrid'),
  drawerSpeedSection: document.getElementById('drawerSpeedSection'),
  drawerFastGearBtn: document.getElementById('drawerFastGearBtn'),
  drawerDeepGearBtn: document.getElementById('drawerDeepGearBtn'),
  drawerHelperInfoSection: document.getElementById('drawerHelperInfoSection'),
  drawerGroupName: document.getElementById('drawerGroupName'),
  drawerGroupTopic: document.getElementById('drawerGroupTopic'),
  drawerGroupEditSection: document.getElementById('drawerGroupEditSection'),
  drawerEditTitleInput: document.getElementById('drawerEditTitleInput'),
  drawerEditTopicInput: document.getElementById('drawerEditTopicInput'),
  drawerSandboxField: document.getElementById('drawerSandboxField'),
  drawerCodexSandboxSelect: document.getElementById('drawerCodexSandboxSelect'),
  saveGroupSettingsBtn: document.getElementById('saveGroupSettingsBtn'),
  drawerScopePath: document.getElementById('drawerScopePath'),
  copyScopeBtn: document.getElementById('copyScopeBtn'),
  openScopeBtn: document.getElementById('openScopeBtn'),
  drawerGitSection: document.getElementById('drawerGitSection'),
  drawerGitBranch: document.getElementById('drawerGitBranch'),
  refreshGitBtn: document.getElementById('refreshGitBtn'),
  openFullDiffBtn: document.getElementById('openFullDiffBtn'),
  drawerWorktreeCreateBtn: document.getElementById('drawerWorktreeCreateBtn'),
  drawerGitCommitBar: document.getElementById('drawerGitCommitBar'),
  drawerGitCommitInput: document.getElementById('drawerGitCommitInput'),
  drawerGitCommitBtn: document.getElementById('drawerGitCommitBtn'),
  drawerGitFileList: document.getElementById('drawerGitFileList'),
  drawerWorktreeWrap: document.getElementById('drawerWorktreeWrap'),
  drawerWorktreeList: document.getElementById('drawerWorktreeList'),
  drawerAgentProfilesSection: document.getElementById('drawerAgentProfilesSection'),
  drawerAgentProfilesList: document.getElementById('drawerAgentProfilesList'),
  enterMultiSelectBtn: document.getElementById('enterMultiSelectBtn'),
  exportChatBtn: document.getElementById('exportChatBtn'),
  drawerActorsSection: document.getElementById('drawerActorsSection'),
  drawerActorCards: document.getElementById('drawerActorCards'),
  drawerLifecycleSection: document.getElementById('drawerLifecycleSection'),
  archiveGroupBtn: document.getElementById('archiveGroupBtn'),
  deleteGroupBtn: document.getElementById('deleteGroupBtn'),
  deleteGroupDialog: document.getElementById('deleteGroupDialog'),
  deleteGroupDesc: document.getElementById('deleteGroupDesc'),
  confirmDeleteGroupBtn: document.getElementById('confirmDeleteGroupBtn'),
  newGroupDialog: document.getElementById('newGroupDialog'),
  newGroupForm: document.getElementById('newGroupForm'),
  ngPath: document.getElementById('ngPath'),
  pickDirBtn: document.getElementById('pickDirBtn'),
  ngError: document.getElementById('ngError'),
  ngSubmitBtn: document.getElementById('ngSubmitBtn'),
  mobileConnectDialog: document.getElementById('mobileConnectDialog'),
  qrContainer: document.getElementById('qrContainer'),
  apkStatusSub: document.getElementById('apkStatusSub'),
  apkDownloadLink: document.getElementById('apkDownloadLink'),
  lanIpSelect: document.getElementById('lanIpSelect'),
  tailscaleStatusBanner: document.getElementById('tailscaleStatusBanner'),
  mobilePairUrlInput: document.getElementById('mobilePairUrlInput'),
  copyPairUrlBtn: document.getElementById('copyPairUrlBtn'),
  imageLightbox: document.getElementById('imageLightbox'),
  lightboxStage: document.getElementById('lightboxStage'),
  lightboxImg: document.getElementById('lightboxImg'),
  lightboxCaption: document.getElementById('lightboxCaption'),
  lightboxZoomOutBtn: document.getElementById('lightboxZoomOutBtn'),
  lightboxZoomResetBtn: document.getElementById('lightboxZoomResetBtn'),
  lightboxZoomInBtn: document.getElementById('lightboxZoomInBtn'),
  lightboxDownload: document.getElementById('lightboxDownload'),
  cmdPaletteDialog: document.getElementById('cmdPaletteDialog'),
  cmdPaletteInput: document.getElementById('cmdPaletteInput'),
  cmdPaletteList: document.getElementById('cmdPaletteList'),
  slashTemplateDialog: document.getElementById('slashTemplateDialog'),
  customTplList: document.getElementById('customTplList'),
  slashTemplateForm: document.getElementById('slashTemplateForm'),
  tplCmdInput: document.getElementById('tplCmdInput'),
  tplLabelInput: document.getElementById('tplLabelInput'),
  tplPromptInput: document.getElementById('tplPromptInput'),
  gitDiffDialog: document.getElementById('gitDiffDialog'),
  gitDiffTitle: document.getElementById('gitDiffTitle'),
  gitDiffSubtitle: document.getElementById('gitDiffSubtitle'),
  discardCurrentFileBtn: document.getElementById('discardCurrentFileBtn'),
  copyGitDiffBtn: document.getElementById('copyGitDiffBtn'),
  askAgentReviewDiffBtn: document.getElementById('askAgentReviewDiffBtn'),
  modalGitCommitBar: document.getElementById('modalGitCommitBar'),
  modalGitCommitInput: document.getElementById('modalGitCommitInput'),
  modalGitCommitBtn: document.getElementById('modalGitCommitBtn'),
  gitDiffViewer: document.getElementById('gitDiffViewer'),
  forwardTargetDialog: document.getElementById('forwardTargetDialog'),
  forwardNoteInput: document.getElementById('forwardNoteInput'),
  forwardGroupList: document.getElementById('forwardGroupList'),
  screenCropDialog: document.getElementById('screenCropDialog'),
  screenCropCanvas: document.getElementById('screenCropCanvas'),
  cropFullBtn: document.getElementById('cropFullBtn'),
  cropConfirmBtn: document.getElementById('cropConfirmBtn'),
  sessionPreviewDialog: document.getElementById('sessionPreviewDialog'),
  sessionPreviewTitle: document.getElementById('sessionPreviewTitle'),
  sessionPreviewSub: document.getElementById('sessionPreviewSub'),
  sessionPreviewBody: document.getElementById('sessionPreviewBody'),
  sessionPreviewOpenDirBtn: document.getElementById('sessionPreviewOpenDirBtn'),
  computerPreviewDialog: document.getElementById('computerPreviewDialog'),
  computerPreviewMeta: document.getElementById('computerPreviewMeta'),
  computerAutoRefreshCheck: document.getElementById('computerAutoRefreshCheck'),
  computerRefreshNowBtn: document.getElementById('computerRefreshNowBtn'),
  computerCaptureToChatBtn: document.getElementById('computerCaptureToChatBtn'),
  computerPreviewImg: document.getElementById('computerPreviewImg'),
  computerPreviewPlaceholder: document.getElementById('computerPreviewPlaceholder'),
  refreshNowBtn: document.getElementById('refreshNowBtn'),
  menuExportChatBtn: document.getElementById('menuExportChatBtn'),
  menuStatusText: document.getElementById('menuStatusText'),
  menuShortcutHint: document.getElementById('menuShortcutHint'),
  toastBar: document.getElementById('toastBar'),
};

let toastTimer = null;
function showToast(text) {
  els.toastBar.textContent = text;
  els.toastBar.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toastBar.hidden = true;
  }, 2600);
}

async function copyTextSafe(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      return true;
    } catch {
      return false;
    } finally {
      ta.remove();
    }
  }
}

async function shareTextOutSafe(title, text) {
  const cleanText = String(text || '').trim();
  if (!cleanText) return false;
  if (window.AndroidBridge?.shareTextOut) {
    try {
      window.AndroidBridge.shareTextOut(String(title || 'AChat'), cleanText);
      triggerLightHaptic();
      return true;
    } catch {
      // fallback below
    }
  }
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ title: String(title || 'AChat'), text: cleanText });
      return true;
    } catch {
      return false;
    }
  }
  await copyTextSafe(cleanText);
  showToast('已复制到剪贴板');
  return true;
}

function setLightboxZoom(nextZoom) {
  const clamped = Math.min(4, Math.max(0.5, Number(nextZoom) || 1));
  state.lightboxZoom = Math.round(clamped * 100) / 100;
  if (els.lightboxImg) {
    els.lightboxImg.style.transform = `scale(${state.lightboxZoom})`;
  }
  if (els.lightboxZoomResetBtn) {
    els.lightboxZoomResetBtn.textContent = `${Math.round(state.lightboxZoom * 100)}%`;
  }
}

function openImageLightbox(url, caption = '') {
  if (!url) return;
  setLightboxZoom(1);
  els.lightboxImg.src = url;
  els.lightboxCaption.textContent = caption || '大图预览';
  els.lightboxDownload.href = url;
  els.lightboxDownload.setAttribute('download', caption || 'achat-preview.png');
  if (!els.imageLightbox.open) {
    els.imageLightbox.showModal();
  }
}

// Android Native Back Gesture Hook (called by MainActivity.kt OnBackPressedDispatcher)
window.__achatAndroidBack = window.__awAndroidBack = function handleAndroidBack() {
  const openDialog = document.querySelector('dialog[open]');
  if (openDialog) {
    openDialog.close();
    return true;
  }
  const openPop = document.querySelector('[popover]:popover-open');
  if (openPop && typeof openPop.hidePopover === 'function') {
    openPop.hidePopover();
    return true;
  }
  if (state.mentionActive) {
    closeMentionMenu();
    return true;
  }
  if (state.multiSelectMode) {
    setMultiSelectMode(false);
    return true;
  }
  if (!els.groupDrawer.hidden) {
    els.groupDrawer.hidden = true;
    els.toggleDrawerBtn.setAttribute('aria-expanded', 'false');
    return true;
  }
  if (
    mobileViewportMql.matches &&
    els.appRoot.dataset.mobileView === 'chat'
  ) {
    els.appRoot.dataset.mobileView = 'list';
    return true;
  }
  if (state.navTab !== 'chats') {
    setNavTab('chats');
    return true;
  }
  return false;
};

function formatWeChatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (sameDay) return `${hh}:${mm}`;
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${m}/${day}`;
}

function formatFullWeChatTimestamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (sameDay) return `${hh}:${mm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
}

function getSelectedGroup() {
  return state.groups.find((g) => g.id === state.selectedGroupId) || null;
}

function avatarMetaForActor(id = '', title = '') {
  const lower = String(id || title).toLowerCase();
  const titleLower = String(title || '').toLowerCase();
  if (lower === 'user' || lower === '我') {
    return { cls: 'avatar-user', label: '我' };
  }
  const agySlot = lower.match(/^agy-(\d+)$/);
  if (agySlot) {
    return { cls: 'avatar-antigravity', label: `A${agySlot[1]}` };
  }
  const cxSlot = lower.match(/^codex-(\d+)$/);
  if (cxSlot) {
    return { cls: 'avatar-codex', label: `C${cxSlot[1]}` };
  }
  if (lower.includes('codex') || titleLower.includes('codex')) {
    return { cls: 'avatar-codex', label: 'Cx' };
  }
  if (lower.includes('antigravity') || /^ag[-_]?\d*$/i.test(lower) || titleLower.includes('ag-')) {
    return { cls: 'avatar-antigravity', label: 'Ag' };
  }
  if (lower.includes('claude')) {
    return { cls: 'avatar-codex', label: 'Cl' };
  }
  if (lower.includes('opencode')) {
    return { cls: 'avatar-antigravity', label: 'Oc' };
  }
  if (lower.includes('ollama')) {
    return { cls: 'avatar-helper', label: 'Ol' };
  }
  if (lower.includes('helper')) {
    return { cls: 'avatar-helper', label: '助' };
  }
  return { cls: 'avatar-codex', label: (title || id || 'A').slice(0, 2) };
}

function shortActorTag(actor) {
  if (!actor) return '';
  const idLower = String(actor.id || '').toLowerCase();
  if (idLower === 'codex') return 'Cx';
  if (idLower === 'antigravity') return 'Ag';
  const agMatch = idLower.match(/^agy-(\d+)$/);
  if (agMatch) return `A${agMatch[1]}`;
  const cxMatch = idLower.match(/^codex-(\d+)$/);
  if (cxMatch) return `C${cxMatch[1]}`;
  const lower = String(actor.id || actor.title).toLowerCase();
  if (lower.includes('codex')) return 'Cx';
  if (lower.includes('antigravity')) return 'Ag';
  if (lower.includes('claude')) return 'Cl';
  if (lower.includes('opencode')) return 'Oc';
  if (lower.includes('ollama')) return 'Ol';
  return (actor.title || actor.id).slice(0, 4);
}

function extractGroupMonogram(title) {
  const clean = String(title || 'AC').replace(/^[\s#@]+/, '').trim();
  if (!clean) return 'AC';
  const asciiWords = clean.match(/[A-Za-z0-9]+/g);
  if (asciiWords && asciiWords.length >= 2 && /^[\x00-\x7F]/.test(clean)) {
    return (asciiWords[0][0] + asciiWords[1][0]).toUpperCase();
  }
  const firstChar = Array.from(clean)[0] || 'A';
  if (/[\u4e00-\u9fff]/.test(firstChar)) {
    return firstChar;
  }
  return clean.slice(0, 2).toUpperCase();
}

function createGroupMosaicElement(group) {
  if (group.kind === 'helper') {
    const div = document.createElement('div');
    div.className = 'helper-avatar';
    div.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-9Z"/></svg>`;
    return div;
  }

  const wrap = document.createElement('div');
  wrap.className = 'group-mosaic';
  const mono = document.createElement('span');
  mono.className = 'group-monogram';
  mono.textContent = extractGroupMonogram(group.title);
  const actorTags = (group.actors || [])
    .filter((a) => a && a.enabled !== false)
    .slice(0, 2)
    .map((a) => shortActorTag(a));
  const tag = document.createElement('span');
  tag.className = 'group-agent-tag';
  tag.textContent = actorTags.length > 0 ? actorTags.join('·') : 'AI';
  wrap.append(mono, tag);
  return wrap;
}

async function apiFetch(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `请求失败 (${res.status})`);
  }
  return data;
}

let draftPersistTimer = null;
let draftPersistDirty = false;

function flushDraftsToStorage() {
  if (draftPersistTimer !== null) {
    clearTimeout(draftPersistTimer);
    draftPersistTimer = null;
  }
  if (!draftPersistDirty) return;
  draftPersistDirty = false;
  try {
    localStorage.setItem('aw_drafts', JSON.stringify(state.draftsByGroup));
  } catch {
    // ignore quota error
  }
}

function saveGroupDraft(groupId, rawValue, { immediate = false } = {}) {
  if (!groupId) return;
  const trimmed = String(rawValue || '');
  const prev = state.draftsByGroup[groupId] || '';
  if (trimmed.trim()) {
    if (prev === trimmed && !immediate) return;
    state.draftsByGroup[groupId] = trimmed;
  } else {
    if (!(groupId in state.draftsByGroup) && !immediate) return;
    delete state.draftsByGroup[groupId];
  }
  draftPersistDirty = true;
  if (immediate) {
    flushDraftsToStorage();
    return;
  }
  if (draftPersistTimer !== null) {
    clearTimeout(draftPersistTimer);
  }
  draftPersistTimer = setTimeout(() => {
    draftPersistTimer = null;
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(() => flushDraftsToStorage(), { timeout: 600 });
    } else {
      flushDraftsToStorage();
    }
  }, 450);
}

function updateBelowFoldPill() {
  if (!els.newMsgJumpBtn) return;
  if (state.belowFoldCount > 0) {
    els.newMsgJumpBtn.textContent = `↓ ${state.belowFoldCount} 条新消息`;
    els.newMsgJumpBtn.hidden = false;
  } else {
    els.newMsgJumpBtn.hidden = true;
  }
}

function syncDesktopUnreadState(notifyPayload = null) {
  if (!window.electronApp?.notifyUnread) return;
  let totalUnread = 0;
  for (const c of state.unreadByGroup.values()) totalUnread += c;
  const backgroundCount =
    totalUnread + (document.hidden || !document.hasFocus() ? (notifyPayload ? 1 : 0) : 0);
  window.electronApp
    .notifyUnread({
      count: backgroundCount,
      notifyTitle: notifyPayload?.title || '',
      notifyBody: notifyPayload?.body || '',
    })
    .catch(() => {});
}

let searchDebounceTimer = null;
let searchReqSeq = 0;
function triggerFullTextSearch(rawQuery) {
  clearTimeout(searchDebounceTimer);
  const q = String(rawQuery || '').trim();
  if (!q) {
    state.searchHits = [];
    state.searchingMessages = false;
    renderSessionColumn();
    return;
  }
  state.searchingMessages = true;
  const mySeq = ++searchReqSeq;
  searchDebounceTimer = setTimeout(async () => {
    try {
      const res = await apiFetch(`/api/search?q=${encodeURIComponent(q)}`);
      if (mySeq !== searchReqSeq) return;
      state.searchHits = Array.isArray(res.hits) ? res.hits : [];
    } catch {
      if (mySeq !== searchReqSeq) return;
      state.searchHits = [];
    } finally {
      if (mySeq === searchReqSeq) {
        state.searchingMessages = false;
        renderSessionColumn();
      }
    }
  }, 160);
}

function jumpToMessageBubble(msgId) {
  if (!msgId) return;
  const targetRow = Array.from(els.messageStream.querySelectorAll('[data-msg-id]')).find(
    (el) => el.dataset.msgId === msgId
  );
  if (!targetRow) return;
  targetRow.classList.remove('is-offscreen-history');
  const folded = targetRow.querySelector('.msg-fold-extra[hidden]');
  if (folded) {
    folded.removeAttribute('hidden');
    const foldBtn = targetRow.querySelector('.msg-fold-btn');
    if (foldBtn) {
      foldBtn.setAttribute('aria-expanded', 'true');
      foldBtn.textContent = '收起长文';
    }
  }
  targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
  targetRow.classList.remove('is-search-hit');
  void targetRow.offsetWidth;
  targetRow.classList.add('is-search-hit');
}

async function openOrCopyLocalPath(rawPath) {
  const cleaned = String(rawPath || '').trim();
  if (!cleaned) return;
  if (state.isLocalSession) {
    try {
      const res = await apiFetch('/api/open-local-path', {
        method: 'POST',
        body: JSON.stringify({ targetPath: cleaned }),
      });
      showToast(
        res.mode === 'reveal' ? '已在资源管理器定位该文件' : '已在电脑端打开本地路径'
      );
      return;
    } catch {
      await copyTextSafe(cleaned);
      showToast('本地未找到该路径，已复制到剪贴板');
      return;
    }
  }
  await copyTextSafe(cleaned);
  showToast('已复制电脑路径到剪贴板');
}

async function exportCurrentGroupMarkdown() {
  const group = getSelectedGroup();
  if (!group) return;
  let msgs = state.messagesByGroup.get(group.id);
  if (!Array.isArray(msgs) || msgs.length === 0) {
    const res = await apiFetch(`/api/groups/${group.id}/messages`);
    msgs = res.messages || [];
    state.messagesByGroup.set(group.id, msgs);
  }
  const chatMsgs = msgs.filter((m) => m.kind === 'chat');
  if (chatMsgs.length === 0) {
    showToast('当前会话暂无可导出的消息');
    return;
  }

  const lines = [
    `# ${group.title} — 聊天记录`,
    '',
    `- 导出时间：${new Date().toLocaleString('zh-CN')}`,
    group.scopePath ? `- 绑定目录：\`${group.scopePath}\`` : '',
    `- 消息总数：${chatMsgs.length} 条`,
    '',
    '---',
    '',
  ].filter((x) => x !== undefined);

  for (const m of chatMsgs) {
    const timeStr = m.ts ? new Date(m.ts).toLocaleString('zh-CN') : '';
    const who = m.isUser ? '我' : m.senderTitle || m.by || 'Agent';
    const toStr =
      Array.isArray(m.to) && m.to.length && m.to[0] !== 'file-helper'
        ? ` → ${m.to.map((r) => (r === 'user' ? '我' : `@${r}`)).join(', ')}`
        : '';
    lines.push(`### ${who}${toStr}${timeStr ? ` (${timeStr})` : ''}`);
    lines.push('');
    if (m.text) {
      lines.push(m.text);
      lines.push('');
    }
    if (Array.isArray(m.attachments) && m.attachments.length > 0) {
      for (const att of m.attachments) {
        lines.push(`- 附件 [${att.kind === 'image' ? '图片' : '文件'}]：\`${att.filePath || att.name}\``);
      }
      lines.push('');
    }
    if (m.insight) {
      lines.push(`> 💭 洞察摘要：${m.insight}`);
      lines.push('');
    }
  }

  const safeTitle = String(group.title || 'group').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
  downloadMarkdownText(`${safeTitle}-聊天记录.md`, lines.join('\n'));
}

function downloadMarkdownText(fileName, content) {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 1500);
  showToast(`已导出「${fileName}」`);
}

function syncStarButtonsInDOM() {
  for (const row of els.messageStream.querySelectorAll('[data-msg-id]')) {
    const id = row.dataset.msgId;
    const starBtn = row.querySelector('.star-btn');
    if (!starBtn || !id) continue;
    const starred = state.starredIds.has(id);
    starBtn.classList.toggle('is-starred', starred);
    starBtn.textContent = starred ? '★' : '☆';
  }
}

function hydrateClientSync(syncData) {
  if (!syncData || typeof syncData !== 'object') return;
  const syncFp = JSON.stringify({
    s: Array.isArray(syncData.starred) ? syncData.starred.map((x) => x?.id || '') : null,
    t: Array.isArray(syncData.templates)
      ? syncData.templates.map((x) => `${x?.id || ''}:${x?.cmd || ''}:${x?.label || ''}:${(x?.prompt || '').length}`)
      : null,
  });
  if (syncFp === state.lastClientSyncKey) return;
  state.lastClientSyncKey = syncFp;
  if (Array.isArray(syncData.starred)) {
    const nextMap = new Map();
    const nextSet = new Set();
    for (const item of syncData.starred) {
      if (!item?.id) continue;
      nextMap.set(item.id, item);
      nextSet.add(item.id);
    }
    state.starredItems = nextMap;
    state.starredIds = nextSet;
    try {
      localStorage.setItem('aw_starred', JSON.stringify(Array.from(nextSet)));
    } catch {
      // ignore storage quota
    }
    syncStarButtonsInDOM();
  }
  if (Array.isArray(syncData.templates)) {
    state.customTemplates = syncData.templates;
    if (els.slashTemplateDialog?.open) {
      renderCustomTemplatesModal();
    }
  }
  if (state.navTab === 'favorites') {
    renderSessionColumn();
  }
}

async function migrateLegacyLocalStarsIfNeeded() {
  let legacyIds = [];
  try {
    if (localStorage.getItem('aw_starred_migrated') === '1') return;
    legacyIds = JSON.parse(localStorage.getItem('aw_starred') || '[]');
  } catch {
    return;
  }
  if (!Array.isArray(legacyIds) || legacyIds.length === 0) return;
  const missing = [];
  for (const [gid, msgs] of state.messagesByGroup.entries()) {
    const g = state.groups.find((x) => x.id === gid);
    for (const m of msgs) {
      if (legacyIds.includes(m.id) && !state.starredItems.has(m.id)) {
        missing.push({
          id: m.id,
          groupId: gid,
          groupTitle: g?.title || gid,
          senderTitle: m.isUser ? '我' : m.senderTitle || 'Agent',
          text: String(m.text || '[图片/附件]'),
          ts: m.ts || new Date().toISOString(),
        });
      }
    }
  }
  if (missing.length > 0) {
    try {
      const res = await apiFetch('/api/client-sync', {
        method: 'POST',
        body: JSON.stringify({ action: 'batchAddStars', items: missing }),
      });
      if (res.clientSync) hydrateClientSync(res.clientSync);
      localStorage.setItem('aw_starred_migrated', '1');
    } catch {
      // ignore transient error
    }
  }
}

async function toggleStarMessage(msg, group) {
  if (!msg?.id) return;
  const itemPayload = {
    id: msg.id,
    groupId: group?.id || state.selectedGroupId || '',
    groupTitle: group?.title || '',
    senderTitle: msg.isUser ? '我' : msg.senderTitle || msg.by || 'Agent',
    text: String(msg.text || '[图片/附件]'),
    ts: msg.ts || new Date().toISOString(),
  };
  const wasStarred = state.starredIds.has(msg.id);
  if (wasStarred) {
    state.starredIds.delete(msg.id);
    state.starredItems.delete(msg.id);
  } else {
    state.starredIds.add(msg.id);
    state.starredItems.set(msg.id, itemPayload);
  }
  syncStarButtonsInDOM();
  triggerLightHaptic();
  showToast(wasStarred ? '已取消收藏' : '已加入云端收藏');

  try {
    const res = await apiFetch('/api/client-sync', {
      method: 'POST',
      body: JSON.stringify({ action: 'toggleStar', item: itemPayload }),
    });
    if (res.clientSync) hydrateClientSync(res.clientSync);
  } catch (err) {
    showToast(err.message);
  }
}

async function removeStarById(starId) {
  if (!starId) return;
  state.starredIds.delete(starId);
  state.starredItems.delete(starId);
  syncStarButtonsInDOM();
  renderSessionColumn();
  try {
    const res = await apiFetch('/api/client-sync', {
      method: 'POST',
      body: JSON.stringify({ action: 'removeStar', id: starId }),
    });
    if (res.clientSync) hydrateClientSync(res.clientSync);
  } catch (err) {
    showToast(err.message);
  }
}

function appendGroupSessionItem(container, g) {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = `session-item${g.id === state.selectedGroupId ? ' is-selected' : ''}${g.pinned ? ' is-pinned' : ''}${g.archived ? ' is-archived' : ''}`;
  item.setAttribute('role', 'option');
  item.setAttribute('aria-selected', g.id === state.selectedGroupId ? 'true' : 'false');

  item.appendChild(createGroupMosaicElement(g));

  const meta = document.createElement('div');
  meta.className = 'session-meta';

  const top = document.createElement('div');
  top.className = 'session-row-top';
  const titleSpan = document.createElement('span');
  titleSpan.className = 'session-title';
  if (g.pinned && !g.archived) {
    const pTag = document.createElement('span');
    pTag.className = 'pin-tag';
    pTag.textContent = '置顶';
    titleSpan.appendChild(pTag);
  } else if (g.archived) {
    const aTag = document.createElement('span');
    aTag.className = 'pin-tag';
    aTag.textContent = '归档';
    titleSpan.appendChild(aTag);
  }
  titleSpan.appendChild(document.createTextNode(g.title));
  const timeSpan = document.createElement('span');
  timeSpan.className = 'session-time';
  timeSpan.textContent = formatWeChatTime(g.lastMessage?.ts || g.updatedAt);
  top.append(titleSpan, timeSpan);

  const sub = document.createElement('div');
  sub.className = 'session-row-sub';
  const preview = document.createElement('span');
  preview.className = 'session-preview';
  const draftText = g.id !== state.selectedGroupId ? (state.draftsByGroup[g.id] || '').trim() : '';
  if (draftText) {
    const dTag = document.createElement('span');
    dTag.className = 'draft-tag';
    dTag.textContent = '[草稿]';
    preview.append(dTag, document.createTextNode(draftText.replace(/\s+/g, ' ').slice(0, 48)));
  } else {
    preview.textContent = g.lastMessage
      ? `${g.lastMessage.sender}: ${g.lastMessage.text}`
      : g.topic || '暂无消息';
  }
  sub.appendChild(preview);

  const thinkingActors = getThinkingActorsForGroup(g);
  const unread = state.unreadByGroup.get(g.id) || 0;
  if (unread > 0) {
    const badge = document.createElement('span');
    badge.className = 'unread-dot';
    badge.textContent = String(unread);
    sub.appendChild(badge);
  } else if (thinkingActors.length > 0) {
    const pill = document.createElement('span');
    pill.className = 'thinking-pill';
    pill.textContent = '思考中';
    sub.appendChild(pill);
  }

  meta.append(top, sub);
  item.appendChild(meta);

  item.addEventListener('click', () => selectGroup(g.id));
  container.appendChild(item);
}

function computeSessionRenderKey() {
  const q = state.searchQuery.trim().toLowerCase();
  const unreadStr = Array.from(state.unreadByGroup.entries())
    .filter(([, c]) => c > 0)
    .map(([k, c]) => `${k}:${c}`)
    .join(',');
  const hitsStr = q ? state.searchHits.map((h) => h.id).join(',') : '';
  const favStr =
    state.navTab === 'favorites'
      ? `${Array.from(state.starredIds).join(',')}|${state.starredItems.size}`
      : '';
  const provStr =
    state.navTab === 'contacts' && state.providerEcosystem?.providers
      ? state.providerEcosystem.providers.map((p) => `${p.id}:${p.installed ? 1 : 0}`).join(',')
      : '';
  const groupsStr = state.groups
    .map((g) => {
      const thinking = getThinkingActorsForGroup(g).map((a) => a.id).join('+');
      const draftSnip = String(state.draftsByGroup[g.id] || '').trim().slice(0, 48);
      const actStr = (g.actors || [])
        .map((a) => `${a.id}:${a.running ? 1 : 0}:${a.role}:${a.readOnly ? 1 : 0}:${a.speedGear}`)
        .join(',');
      return `${g.id}|${g.title}|${g.pinned ? 1 : 0}|${g.archived ? 1 : 0}|${g.lastMessage?.sender || ''}|${g.lastMessage?.text || ''}|${g.lastMessage?.ts || ''}|${thinking}|${draftSnip}|${actStr}`;
    })
    .join(';;');
  return `${state.navTab}::${state.selectedGroupId || ''}::${q}::${state.searchingMessages ? 1 : 0}::${unreadStr}::${hitsStr}::${favStr}::${provStr}::${groupsStr}`;
}

async function loadProviderEcosystem({ force = false } = {}) {
  if (state.loadingProviders) return state.providerEcosystem;
  if (!force && state.providerEcosystem) return state.providerEcosystem;
  state.loadingProviders = true;
  try {
    const res = await apiFetch(`/api/providers${force ? '?force=1' : ''}`);
    state.providerEcosystem = res;
    if (state.navTab === 'contacts') {
      renderSessionColumn({ force: true });
    }
    return res;
  } catch {
    return null;
  } finally {
    state.loadingProviders = false;
  }
}

// --- Render Session / Contacts / Favorites Column ---
function renderSessionColumn({ force = false } = {}) {
  const nextKey = computeSessionRenderKey();
  if (!force && nextKey === state.lastSessionRenderKey && els.sessionList.childElementCount > 0) {
    return;
  }
  state.lastSessionRenderKey = nextKey;
  els.sessionList.replaceChildren();
  const q = state.searchQuery.trim().toLowerCase();

  let totalUnread = 0;
  for (const c of state.unreadByGroup.values()) totalUnread += c;
  els.totalUnreadBadge.hidden = totalUnread === 0;
  els.totalUnreadBadge.textContent = String(totalUnread);
  const activeCount = state.groups.filter((g) => !g.archived).length;
  els.mobileGroupCount.textContent = activeCount ? `(${activeCount})` : '';

  if (state.navTab === 'contacts') {
    const seen = new Map();
    for (const g of state.groups) {
      if (g.archived) continue;
      for (const a of g.actors || []) {
        const entry = seen.get(a.id) || { ...a, groups: [] };
        entry.groups.push(g.title);
        seen.set(a.id, entry);
      }
    }
    for (const agent of seen.values()) {
      if (q && !agent.title.toLowerCase().includes(q) && !agent.id.toLowerCase().includes(q)) {
        continue;
      }
      const row = document.createElement('div');
      row.className = 'info-card-row';

      const topLine = document.createElement('div');
      topLine.style.display = 'flex';
      topLine.style.justifyContent = 'space-between';
      topLine.style.alignItems = 'center';
      const strong = document.createElement('strong');
      strong.textContent = `${agent.title} (@${agent.id})`;
      const pill = document.createElement('span');
      pill.className = 'thinking-pill';
      pill.textContent = agent.running ? '在线' : '离线';
      topLine.append(strong, pill);

      const roleLine = document.createElement('div');
      roleLine.className = 'session-preview';
      roleLine.textContent = `角色：${agent.role === 'foreman' ? '工头' : '成员'}${agent.readOnly ? ' · 只读安全' : ''} · ${agent.speedGear === 'fast' ? '⚡极速档' : '🧠深度档'}`;

      const grpLine = document.createElement('div');
      grpLine.className = 'session-time';
      grpLine.textContent = `所在群聊：${agent.groups.join('、')}`;

      row.append(topLine, roleLine, grpLine);
      els.sessionList.appendChild(row);
    }

    if (!state.providerEcosystem && !state.loadingProviders) {
      loadProviderEcosystem();
    }
    const provHdr = document.createElement('div');
    provHdr.className = 'search-section-label';
    provHdr.textContent = '本机 CLI 智能体生态（支持在群内直接 @ 呼叫）';
    els.sessionList.appendChild(provHdr);

    const providers = state.providerEcosystem?.providers || [];
    for (const p of providers) {
      if (q && !String(p.title || '').toLowerCase().includes(q) && !String(p.id || '').toLowerCase().includes(q)) {
        continue;
      }
      const card = document.createElement('article');
      card.className = `cli-ecosystem-card${p.installed ? ' is-installed' : ''}`;

      const topRow = document.createElement('div');
      topRow.className = 'cli-card-top';
      const titleEl = document.createElement('span');
      titleEl.className = 'cli-card-title';
      titleEl.textContent = `${p.title} (@${p.id})`;
      const stPill = document.createElement('span');
      stPill.className = 'thinking-pill';
      stPill.textContent = p.installed ? '✓ 已就绪' : '未安装';
      topRow.append(titleEl, stPill);

      const descEl = document.createElement('div');
      descEl.className = 'session-preview';
      descEl.textContent = p.installed
        ? `${p.description || ''}${p.version ? ` · ${p.version}` : ''}`
        : `安装提示：${p.installHint || p.binary}`;

      card.append(topRow, descEl);
      if (p.installed) {
        const actRow = document.createElement('div');
        actRow.className = 'scope-actions';
        const callBtn = document.createElement('button');
        callBtn.type = 'button';
        callBtn.className = 'msg-act-btn';
        callBtn.textContent = `在当前群 @${p.id}`;
        callBtn.addEventListener('click', () => {
          setNavTab('chats');
          const cur = els.messageInput.value;
          els.messageInput.value = cur && !cur.endsWith(' ') ? `${cur} @${p.id} ` : `${cur}@${p.id} `;
          if (state.selectedGroupId) saveGroupDraft(state.selectedGroupId, els.messageInput.value);
          updateSendButtonState();
          els.messageInput.focus();
        });
        actRow.appendChild(callBtn);
        card.appendChild(actRow);
      }
      els.sessionList.appendChild(card);
    }
    return;
  }

  if (state.navTab === 'favorites') {
    const mergedMap = new Map(state.starredItems);
    for (const [gid, msgs] of state.messagesByGroup.entries()) {
      const g = state.groups.find((x) => x.id === gid);
      for (const m of msgs) {
        if (state.starredIds.has(m.id) && !mergedMap.has(m.id)) {
          mergedMap.set(m.id, {
            id: m.id,
            groupId: gid,
            groupTitle: g?.title || gid,
            senderTitle: m.isUser ? '我' : m.senderTitle || 'Agent',
            text: m.text || '[图片/附件]',
            ts: m.ts,
          });
        }
      }
    }
    const allStarred = Array.from(mergedMap.values()).filter((it) => {
      if (!q) return true;
      return (
        String(it.text || '').toLowerCase().includes(q) ||
        String(it.groupTitle || '').toLowerCase().includes(q) ||
        String(it.senderTitle || '').toLowerCase().includes(q)
      );
    });
    if (allStarred.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'info-card-row';
      empty.textContent = q
        ? '未匹配到相关收藏消息。'
        : '暂无收藏消息。在聊天气泡上方点击「☆」（或多选批量收藏）即可云端同步到这里。';
      els.sessionList.appendChild(empty);
      return;
    }
    for (const item of allStarred) {
      const card = document.createElement('div');
      card.className = 'fav-item-card';

      const bodyBtn = document.createElement('button');
      bodyBtn.type = 'button';
      bodyBtn.className = 'fav-card-body';

      const top = document.createElement('div');
      top.className = 'session-row-top';
      const titleSpan = document.createElement('span');
      titleSpan.className = 'session-title';
      titleSpan.textContent = `${item.senderTitle || 'Agent'} · ${item.groupTitle || item.groupId}`;
      const timeSpan = document.createElement('span');
      timeSpan.className = 'session-time';
      timeSpan.textContent = formatWeChatTime(item.ts);
      top.append(titleSpan, timeSpan);

      const prev = document.createElement('div');
      prev.className = 'session-preview';
      prev.textContent = String(item.text || '[图片/附件]').replace(/\s+/g, ' ').slice(0, 88);

      bodyBtn.append(top, prev);
      bodyBtn.addEventListener('click', () => {
        if (!item.groupId) return;
        setNavTab('chats');
        selectGroup(item.groupId, { jumpToMsgId: item.id });
      });

      const actRow = document.createElement('div');
      actRow.className = 'fav-card-actions';

      const cpBtn = document.createElement('button');
      cpBtn.type = 'button';
      cpBtn.className = 'msg-act-btn';
      cpBtn.textContent = '复制';
      cpBtn.addEventListener('click', async () => {
        await copyTextSafe(item.text || '');
        showToast('收藏内容已复制');
      });

      const shBtn = document.createElement('button');
      shBtn.type = 'button';
      shBtn.className = 'msg-act-btn';
      shBtn.textContent = '分享';
      shBtn.addEventListener('click', () => {
        shareTextOutSafe(`${item.senderTitle} · ${item.groupTitle}`, item.text || '');
      });

      const rmBtn = document.createElement('button');
      rmBtn.type = 'button';
      rmBtn.className = 'msg-act-btn';
      rmBtn.textContent = '移除';
      rmBtn.addEventListener('click', () => removeStarById(item.id));

      actRow.append(cpBtn, shBtn, rmBtn);
      card.append(bodyBtn, actRow);
      els.sessionList.appendChild(card);
    }
    return;
  }

  // Default: WeChat Chat Sessions (Active first + Collapsible Archived Fold)
  const matchesFilter = (g) =>
    !q ||
    g.title.toLowerCase().includes(q) ||
    (g.lastMessage?.text || '').toLowerCase().includes(q);

  const activeGroups = state.groups.filter((g) => !g.archived && matchesFilter(g));
  const archivedGroups = state.groups.filter((g) => Boolean(g.archived) && matchesFilter(g));

  for (const g of activeGroups) {
    appendGroupSessionItem(els.sessionList, g);
  }

  if (archivedGroups.length > 0) {
    if (q) {
      for (const g of archivedGroups) {
        appendGroupSessionItem(els.sessionList, g);
      }
    } else {
      const foldBar = document.createElement('button');
      foldBar.type = 'button';
      foldBar.className = 'archived-fold-bar';
      const labelSpan = document.createElement('span');
      labelSpan.textContent = `📦 已归档群聊 (${archivedGroups.length})`;
      const arrowSpan = document.createElement('span');
      arrowSpan.textContent = state.showArchivedGroups ? '收起 ▴' : '展开 ▾';
      foldBar.append(labelSpan, arrowSpan);
      foldBar.addEventListener('click', () => {
        state.showArchivedGroups = !state.showArchivedGroups;
        renderSessionColumn();
      });
      els.sessionList.appendChild(foldBar);

      if (state.showArchivedGroups) {
        for (const g of archivedGroups) {
          appendGroupSessionItem(els.sessionList, g);
        }
      }
    }
  }

  // Render Full-Text Chat Message Search Hits underneath group matches
  if (q) {
    const hdr = document.createElement('div');
    hdr.className = 'search-section-label';
    hdr.textContent = state.searchingMessages
      ? '正在检索全部聊天记录…'
      : `聊天记录匹配 (${state.searchHits.length})`;
    els.sessionList.appendChild(hdr);

    for (const hit of state.searchHits) {
      const hitBtn = document.createElement('button');
      hitBtn.type = 'button';
      hitBtn.className = 'search-hit-item';

      const topRow = document.createElement('div');
      topRow.className = 'session-row-top';
      const titleSpan = document.createElement('span');
      titleSpan.className = 'session-title';
      titleSpan.textContent = `${hit.senderTitle} · ${hit.groupTitle}`;
      const timeSpan = document.createElement('span');
      timeSpan.className = 'session-time';
      timeSpan.textContent = formatWeChatTime(hit.ts);
      topRow.append(titleSpan, timeSpan);

      const snipDiv = document.createElement('div');
      snipDiv.className = 'session-preview';
      snipDiv.textContent = hit.snippet;

      hitBtn.append(topRow, snipDiv);
      hitBtn.addEventListener('click', () => {
        selectGroup(hit.groupId, { jumpToMsgId: hit.id });
      });
      els.sessionList.appendChild(hitBtn);
    }
  }
}

function getThinkingActorsForGroup(group) {
  if (!group || group.kind === 'helper') return [];
  const liveIds = state.thinkingByGroup.get(group.id);
  const extThinkMap =
    group.externalThinking && typeof group.externalThinking === 'object' && !Array.isArray(group.externalThinking)
      ? group.externalThinking
      : {};
  const board = state.ideBoardsByGroup.get(group.id) || group.ideBoard || null;
  const routing = getNormalizedGroupRouting(group);
  const idSet = new Set();
  if (Array.isArray(liveIds)) {
    for (const id of liveIds) idSet.add(id);
  } else {
    for (const a of group.actors || []) {
      if (a.workingState === 'thinking') idSet.add(a.id);
    }
  }
  for (const extId of Object.keys(extThinkMap)) {
    idSet.add(extId);
  }
  for (const [aid, ast] of Object.entries(board?.actors || {})) {
    if (['aligning', 'running', 'collab', 'reviewing', 'rework'].includes(ast?.phase)) {
      idSet.add(aid);
    }
  }
  const result = [];
  for (const id of idSet) {
    const actor = (group.actors || []).find((a) => a.id === id);
    const slot = routing.slots.find((s) => s.slotId === id);
    const bActor = board?.actors?.[id];
    const ext = extThinkMap[id];
    result.push({
      id,
      title: slot?.label || bActor?.title || actor?.title || id,
      workingState: 'thinking',
      thinkingSince: ext?.since || bActor?.startedAt || actor?.thinkingSince || null,
      liveStep: ext?.label
        ? { kind: 'thinking', stepText: ext.label }
        : bActor?.currentAction
          ? { kind: 'thinking', stepText: bActor.currentAction }
          : actor?.liveStep || null,
    });
  }
  return result;
}

function formatElapsedSec(startMs) {
  if (!startMs || Number.isNaN(startMs)) return '';
  const sec = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s`;
}

function updateTypingAndRelayBanners(group) {
  if (els.relayBanner) {
    els.relayBanner.hidden = true;
  }
  if (!group || group.kind === 'helper') {
    els.typingBanner.hidden = true;
    if (els.itbRetryBtn) els.itbRetryBtn.hidden = true;
    if (els.itbInterruptBtn) els.itbInterruptBtn.hidden = true;
    return;
  }

  const thinking = getThinkingActorsForGroup(group);
  const boardVisible = Boolean(els.ideTaskBoard && !els.ideTaskBoard.hidden);
  const board = state.ideBoardsByGroup.get(group.id) || group.ideBoard || null;
  const hasBoardError = Object.values(board?.actors || {}).some((a) => a?.phase === 'error');

  if (els.itbRetryBtn) {
    els.itbRetryBtn.hidden = !(boardVisible && (thinking.length > 0 || hasBoardError));
    els.itbRetryBtn.disabled = state.controllingTurn;
  }
  if (els.itbInterruptBtn) {
    els.itbInterruptBtn.hidden = !(boardVisible && thinking.length > 0);
    els.itbInterruptBtn.disabled = state.controllingTurn;
  }

  if (!thinking.length) {
    els.typingBanner.hidden = true;
    return;
  }

  let earliestMs = Infinity;
  let stepSnippet = '';
  for (const a of thinking) {
    const key = `${group.id}:${a.id}`;
    const parsedSince = a.thinkingSince ? new Date(a.thinkingSince).getTime() : NaN;
    if (!Number.isNaN(parsedSince)) {
      state.thinkingStartedAt.set(key, parsedSince);
      if (parsedSince < earliestMs) earliestMs = parsedSince;
    } else {
      const saved = state.thinkingStartedAt.get(key) || Date.now();
      state.thinkingStartedAt.set(key, saved);
      if (saved < earliestMs) earliestMs = saved;
    }
    if (!stepSnippet && a.liveStep?.stepText) {
      stepSnippet = a.liveStep.stepText;
    }
  }

  if (boardVisible) {
    els.typingBanner.hidden = true;
    return;
  }

  const names = thinking.map((a) => a.title || a.id).join('、');
  const elapsed = earliestMs < Infinity ? ` (${formatElapsedSec(earliestMs)})` : '';
  const detail = stepSnippet ? ` · ${stepSnippet}` : ' · 正在思考回复…';
  const nextBannerText = `${names}${elapsed}${detail}`;
  if (els.typingBannerText.textContent !== nextBannerText) {
    els.typingBannerText.textContent = nextBannerText;
  }
  if (els.retryTurnBtn && els.retryTurnBtn.disabled !== state.controllingTurn) {
    els.retryTurnBtn.disabled = state.controllingTurn;
  }
  if (els.interruptTurnBtn && els.interruptTurnBtn.disabled !== state.controllingTurn) {
    els.interruptTurnBtn.disabled = state.controllingTurn;
  }
  if (els.typingBanner.hidden) {
    els.typingBanner.hidden = false;
  }
}

async function controlGroupTurn(group, action) {
  if (!group || group.kind === 'helper' || state.controllingTurn) return;
  state.controllingTurn = true;
  updateTypingAndRelayBanners(group);
  try {
    const res = await apiFetch(`/api/groups/${group.id}/turn-control`, {
      method: 'POST',
      body: JSON.stringify({ action }),
    });
    if (Array.isArray(res.groups)) {
      state.groups = res.groups;
      syncThinkingStateFromGroups(state.groups);
    }
    if (action === 'interrupt') {
      state.thinkingByGroup.set(group.id, []);
      showToast('已中断当前推理，Agent 已恢复待命');
    } else {
      showToast('已重新唤醒并补发待办消息');
    }
  } catch (err) {
    showToast(err.message);
  } finally {
    state.controllingTurn = false;
    renderSessionColumn();
    renderActiveHeaderAndRecipients();
  }
}

// --- Speed Gear & Collaboration Switchers ---
async function switchGroupSpeedGear(group, nextGear) {
  if (!group || group.kind === 'helper' || state.switchingGear) return;
  state.switchingGear = true;
  renderActiveHeaderAndRecipients();
  try {
    const res = await apiFetch(`/api/groups/${group.id}/speed-gear`, {
      method: 'POST',
      body: JSON.stringify({ gear: nextGear }),
    });
    if (Array.isArray(res.groups)) {
      state.groups = res.groups;
    }
    showToast(
      nextGear === 'fast'
        ? '已切换至 ⚡极速快聊档（双 Agent 已按极速参数热重启）'
        : '已切换至 🧠深度思考档（双 Agent 已恢复高推理深度）'
    );
  } catch (err) {
    showToast(err.message);
  } finally {
    state.switchingGear = false;
    renderSessionColumn();
    renderActiveHeaderAndRecipients();
  }
}

async function updateGroupCollabPrefs(group, patch) {
  if (!group) return;
  Object.assign(group, patch);
  renderSessionColumn();
  renderActiveHeaderAndRecipients();
  try {
    const res = await apiFetch(`/api/groups/${group.id}/prefs`, {
      method: 'POST',
      body: JSON.stringify(patch),
    });
    if (Array.isArray(res.groups)) {
      state.groups = res.groups;
      renderSessionColumn();
      renderActiveHeaderAndRecipients();
    }
  } catch (err) {
    showToast(err.message);
  }
}

// --- Target Session Selector & Multi-Session Dispatch (v1.6.0) ---
function normalizeClientAgentTarget(raw = {}, defaultScopePath = '') {
  const obj = raw && typeof raw === 'object' ? raw : {};
  const mode = ['group', 'existing', 'new'].includes(obj.mode) ? obj.mode : 'group';
  const sessionId = String(obj.sessionId || '').trim();
  const sessionTitle = String(obj.sessionTitle || '').trim();
  const cwd = String(obj.cwd || '').trim() || (mode === 'new' ? String(defaultScopePath || '').trim() : '');
  if (mode === 'existing' && !sessionId) {
    return { mode: 'group', sessionId: '', sessionTitle: '', cwd: '' };
  }
  return { mode, sessionId, sessionTitle, cwd };
}

function normalizeClientSessionSlot(raw = {}, idx = 0, defaultScopePath = '') {
  const obj = raw && typeof raw === 'object' ? raw : {};
  const rawProv = String(obj.provider || obj.slotId || '').toLowerCase();
  const provider = rawProv.includes('codex')
    ? 'codex'
    : rawProv.includes('antigravity') || rawProv.startsWith('agy') || rawProv.startsWith('ag')
      ? 'antigravity'
      : idx === 0
        ? 'codex'
        : 'antigravity';
  const defaultSlotId =
    idx === 0 && provider === 'codex'
      ? 'codex'
      : idx === 1 && provider === 'antigravity'
        ? 'antigravity'
        : `${provider === 'codex' ? 'codex' : 'agy'}-${idx + 1}`;
  const slotId =
    String(obj.slotId || defaultSlotId)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .slice(0, 32) || defaultSlotId;
  const defaultLabel =
    slotId === 'codex'
      ? 'Codex'
      : slotId === 'antigravity'
        ? 'Antigravity'
        : provider === 'codex'
          ? `Codex-${slotId.replace(/^codex-?/i, '') || idx + 1}`
          : `AG-${slotId.replace(/^agy-?/i, '') || idx + 1}`;
  const label = String(obj.label || defaultLabel).trim().slice(0, 24) || defaultLabel;
  const role = obj.role === 'lead' ? 'lead' : 'peer';
  const target = normalizeClientAgentTarget(obj, defaultScopePath);
  return {
    slotId,
    provider,
    label,
    role,
    ...target,
  };
}

function getNormalizedGroupRouting(group) {
  const raw = group?.sessionRouting && typeof group.sessionRouting === 'object' ? group.sessionRouting : {};
  const scopePath = group?.scopePath || '';
  let slots = [];
  if (Array.isArray(raw.slots) && raw.slots.length > 0) {
    const usedIds = new Set();
    let sawLead = false;
    for (let i = 0; i < Math.min(raw.slots.length, 8); i += 1) {
      const slot = normalizeClientSessionSlot(raw.slots[i], i, scopePath);
      let sid = slot.slotId;
      let suffix = 2;
      while (usedIds.has(sid)) {
        sid = `${slot.provider === 'codex' ? 'codex' : 'agy'}-${suffix}`;
        suffix += 1;
      }
      usedIds.add(sid);
      const role = slot.role === 'lead' && !sawLead ? 'lead' : 'peer';
      if (role === 'lead') sawLead = true;
      slots.push({ ...slot, slotId: sid, role });
    }
  } else {
    const legacyCodex = normalizeClientAgentTarget(raw.codex, scopePath);
    const legacyAgy = normalizeClientAgentTarget(raw.antigravity, scopePath);
    slots = [
      { slotId: 'codex', provider: 'codex', label: 'Codex', role: 'peer', ...legacyCodex },
      {
        slotId: 'antigravity',
        provider: 'antigravity',
        label: 'Antigravity',
        role: 'peer',
        ...legacyAgy,
      },
    ];
  }
  const codexSlot = slots.find((s) => s.provider === 'codex');
  const agySlot = slots.find((s) => s.provider === 'antigravity');
  const codex = codexSlot
    ? {
        mode: codexSlot.mode,
        sessionId: codexSlot.sessionId,
        sessionTitle: codexSlot.sessionTitle,
        cwd: codexSlot.cwd,
      }
    : normalizeClientAgentTarget(raw.codex, scopePath);
  const antigravity = agySlot
    ? {
        mode: agySlot.mode,
        sessionId: agySlot.sessionId,
        sessionTitle: agySlot.sessionTitle,
        cwd: agySlot.cwd,
      }
    : normalizeClientAgentTarget(raw.antigravity, scopePath);
  const hasAnyExternal = slots.some((s) => s.mode === 'new' || (s.mode === 'existing' && s.sessionId));
  const flow = raw.flow === 'discuss_then_exec' ? 'discuss_then_exec' : 'direct';
  const permission = ['inherit', 'workspace-write', 'read-only'].includes(raw.permission)
    ? raw.permission
    : 'inherit';
  const autoWake = typeof raw.autoWake === 'boolean' ? raw.autoWake : true;
  const autoReview = typeof raw.autoReview === 'boolean' ? raw.autoReview : true;
  return {
    enabled: Boolean(raw.enabled ?? hasAnyExternal),
    flow,
    permission,
    autoWake,
    autoReview,
    slots,
    codex,
    antigravity,
  };
}

function getActiveGroupSlots(routing) {
  if (!routing || !Array.isArray(routing.slots)) return [];
  return routing.slots.filter((s) => s.mode === 'new' || (s.mode === 'existing' && Boolean(s.sessionId)));
}

function isGroupExternallyRouted(routing) {
  return getActiveGroupSlots(routing).length > 0;
}

function resolveGroupSlot(routing, idOrProvider = '') {
  const key = String(idOrProvider || '').trim().toLowerCase();
  if (!key || !routing?.slots) return null;
  return (
    routing.slots.find((s) => s.slotId.toLowerCase() === key || s.label.toLowerCase() === key) ||
    routing.slots.find((s) => s.provider === key) ||
    null
  );
}

function pathBasenameShort(winOrPosixPath = '') {
  const clean = String(winOrPosixPath || '').replace(/[\\/]+$/, '');
  if (!clean) return '';
  const idx = Math.max(clean.lastIndexOf('\\'), clean.lastIndexOf('/'));
  return idx >= 0 ? clean.slice(idx + 1) : clean;
}

function formatSessionShortTime(isoStr = '') {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return '';
  const diffMin = Math.floor((Date.now() - d.getTime()) / 60000);
  if (diffMin < 2) return '刚刚';
  if (diffMin < 60) return `${diffMin}分前`;
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  if (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  ) {
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
}

async function loadExternalSessions({ force = false, silent = true } = {}) {
  if (state.loadingExternalSessions) return;
  state.loadingExternalSessions = true;
  renderSessionTargetBar(getSelectedGroup());
  try {
    const res = await apiFetch(`/api/external-sessions${force ? '?force=1' : ''}`);
    state.externalSessions = {
      codex: Array.isArray(res.codex) ? res.codex : [],
      antigravity: Array.isArray(res.antigravity) ? res.antigravity : [],
      recentDirectories: Array.isArray(res.recentDirectories) ? res.recentDirectories : [],
    };
    state.externalSessionsLoaded = true;
    state.slotSelectCacheKeys.clear();
    if (els.recentProjectDirsList) {
      els.recentProjectDirsList.replaceChildren();
      for (const dir of state.externalSessions.recentDirectories) {
        const dirPath = typeof dir === 'string' ? dir : dir?.path || '';
        if (!dirPath) continue;
        const opt = document.createElement('option');
        opt.value = dirPath;
        if (dir?.name) opt.label = dir.name;
        els.recentProjectDirsList.appendChild(opt);
      }
    }
    if (!silent) {
      showToast(
        `已扫描本机会话：Codex ${state.externalSessions.codex.length} 个 · Antigravity ${state.externalSessions.antigravity.length} 个`
      );
    }
  } catch (err) {
    if (!silent) showToast(err.message || '扫描本机会话失败');
  } finally {
    state.loadingExternalSessions = false;
    renderSessionTargetBar(getSelectedGroup());
  }
}

function populateAgentSessionSelect(selectEl, agentKey, targetCfg, sessionsList, cacheSlotKey) {
  if (!selectEl) return;
  const filterQ = String(state.sessionFilterQuery || '').trim().toLowerCase();
  const filteredList = filterQ
    ? sessionsList.filter((s) => {
        if (targetCfg.mode === 'existing' && targetCfg.sessionId === s.id) return true;
        const hay = `${s.title || ''} ${s.folderName || ''} ${s.cwd || ''} ${s.id || ''}`.toLowerCase();
        return hay.includes(filterQ);
      })
    : sessionsList;

  const desiredVal =
    targetCfg.mode === 'existing' && targetCfg.sessionId
      ? `existing:${targetCfg.sessionId}`
      : targetCfg.mode === 'new'
        ? 'new'
        : 'group';
  const selectKey = [
    agentKey,
    targetCfg.mode,
    targetCfg.sessionId,
    targetCfg.sessionTitle,
    filterQ,
    state.externalSessionsLoaded ? '1' : '0',
    state.loadingExternalSessions ? '1' : '0',
    filteredList
      .map((s) => `${s.id}:${s.busy ? 1 : 0}:${s.sourceSurface || ''}:${s.updatedAt || ''}`)
      .join(','),
  ].join('|');

  if (state.slotSelectCacheKeys.get(cacheSlotKey) === selectKey && selectEl.options.length > 0) {
    if (selectEl.value !== desiredVal) selectEl.value = desiredVal;
    return;
  }

  selectEl.replaceChildren();

  const grpOpt = document.createElement('option');
  grpOpt.value = 'group';
  grpOpt.textContent = '💬 本群默认会话（不跨会话）';
  selectEl.appendChild(grpOpt);

  const newOpt = document.createElement('option');
  newOpt.value = 'new';
  newOpt.textContent = '➕ 在指定项目目录新建会话…';
  selectEl.appendChild(newOpt);

  const optGroup = document.createElement('optgroup');
  optGroup.label = filterQ
    ? `🔍 匹配 "${filterQ}" 的 ${agentKey === 'codex' ? 'Codex' : 'Antigravity'} 会话 (${filteredList.length})`
    : `📌 本机最近 ${agentKey === 'codex' ? 'Codex' : 'Antigravity'} 会话`;

  const hasBoundInCatalog =
    targetCfg.mode === 'existing' &&
    targetCfg.sessionId &&
    filteredList.some((s) => s.id === targetCfg.sessionId);

  if (targetCfg.mode === 'existing' && targetCfg.sessionId && !hasBoundInCatalog) {
    const pinnedOpt = document.createElement('option');
    pinnedOpt.value = `existing:${targetCfg.sessionId}`;
    const folderTag = targetCfg.cwd ? `[${pathBasenameShort(targetCfg.cwd)}] ` : '';
    pinnedOpt.textContent = `${folderTag}${targetCfg.sessionTitle || targetCfg.sessionId.slice(0, 8)} · 当前绑定`;
    optGroup.appendChild(pinnedOpt);
  }

  for (const s of filteredList) {
    const opt = document.createElement('option');
    opt.value = `existing:${s.id}`;
    const surfacePrefix =
      agentKey === 'antigravity'
        ? s.sourceSurface === 'desktop'
          ? '[桌面] '
          : s.sourceSurface === 'cli'
            ? '[CLI] '
            : ''
        : '';
    const folderPrefix = s.folderName ? `[${s.folderName}] ` : '';
    const rawTitle = String(s.title || s.id.slice(0, 8));
    const shortTitle = rawTitle.length > 34 ? `${rawTitle.slice(0, 34)}…` : rawTitle;
    const timePart = formatSessionShortTime(s.updatedAt);
    const statusPart = s.busy
      ? ' · 🟢运行中'
      : s.sandbox === 'read-only'
        ? ' · 只读'
        : '';
    opt.textContent = `${surfacePrefix}${folderPrefix}${shortTitle}${timePart ? ` · ${timePart}` : ''}${statusPart}`;
    opt.title = `${rawTitle}\n目录：${s.cwd || '未指定目录'}\nID：${s.id}${s.sourceSurface ? `\n来源：${s.sourceSurface}` : ''}`;
    optGroup.appendChild(opt);
  }

  if (filteredList.length === 0 && !(targetCfg.mode === 'existing' && targetCfg.sessionId)) {
    const emptyOpt = document.createElement('option');
    emptyOpt.value = '__empty__';
    emptyOpt.disabled = true;
    emptyOpt.textContent = state.loadingExternalSessions
      ? '正在扫描本机会话…'
      : filterQ
        ? `未搜到包含 "${filterQ}" 的会话`
        : '暂无最近会话（可点右上角刷新或选上方新建）';
    optGroup.appendChild(emptyOpt);
  }

  selectEl.appendChild(optGroup);
  selectEl.value = desiredVal;
  state.slotSelectCacheKeys.set(cacheSlotKey, selectKey);
}

function formatAgentSlotHint(agentKey, targetCfg, routing, group) {
  if (targetCfg.mode === 'existing' && targetCfg.sessionId) {
    const list = state.externalSessions[agentKey] || [];
    const match = list.find((s) => s.id === targetCfg.sessionId);
    const folder = match?.folderName || pathBasenameShort(targetCfg.cwd) || targetCfg.sessionId.slice(0, 8);
    const permText =
      routing.permission === 'read-only'
        ? '只读'
        : routing.permission === 'workspace-write'
          ? '可写'
          : match?.sandbox === 'read-only'
            ? '原只读'
            : '原权限';
    return `📂 ${folder} · ${permText}`;
  }
  if (targetCfg.mode === 'new') {
    const folder = pathBasenameShort(targetCfg.cwd || group?.scopePath || '') || '待选目录';
    return `➕ 新建于 ${folder}`;
  }
  return '本群默认';
}

const ACTIVE_IDE_PHASES = new Set(['aligning', 'running', 'collab', 'reviewing', 'rework']);

function formatBoardHeartbeatLabel(actorState) {
  const active = ACTIVE_IDE_PHASES.has(actorState?.phase);
  const nowMs = Date.now();
  const lastMs = actorState?.lastActivityAt ? new Date(actorState.lastActivityAt).getTime() : 0;
  const startMs = actorState?.startedAt ? new Date(actorState.startedAt).getTime() : 0;
  const elapsedSec = startMs > 0 ? Math.max(0, Math.floor((nowMs - startMs) / 1000)) : 0;
  const elapsedStr =
    elapsedSec >= 60
      ? `${Math.floor(elapsedSec / 60)}m${String(elapsedSec % 60).padStart(2, '0')}s`
      : elapsedSec > 0
        ? `${elapsedSec}s`
        : '';
  const agoSec = lastMs > 0 ? Math.max(0, Math.floor((nowMs - lastMs) / 1000)) : 0;
  const agoStr =
    agoSec <= 3 ? '刚刚活跃' : agoSec < 60 ? `${agoSec}秒前活跃` : `${Math.floor(agoSec / 60)}分前活跃`;
  if (active) {
    return elapsedStr ? `已运行 ${elapsedStr} · ${agoStr}` : agoStr;
  }
  return lastMs > 0 ? agoStr : '';
}

function stopIdeBoardTicker() {
  if (state.ideBoardTicker) {
    clearInterval(state.ideBoardTicker);
    state.ideBoardTicker = null;
  }
}

function ensureIdeBoardTicker() {
  if (state.ideBoardTicker) return;
  state.ideBoardTicker = setInterval(() => {
    const g = getSelectedGroup();
    if (!g) {
      stopIdeBoardTicker();
      return;
    }
    const board = state.ideBoardsByGroup.get(g.id) || g.ideBoard;
    const actors = Object.values(board?.actors || {});
    const hasActive = actors.some((a) => ACTIVE_IDE_PHASES.has(a?.phase));
    if (!hasActive) {
      stopIdeBoardTicker();
      return;
    }
    for (const a of actors) {
      const hbEl = els.itbGrid?.querySelector(`[data-itb-hb="${a.actorId}"]`);
      if (hbEl) hbEl.textContent = formatBoardHeartbeatLabel(a);
    }
  }, 1000);
}

function renderIdeTaskBoard(group) {
  if (!els.ideTaskBoard || !els.itbGrid) return;
  if (!group || group.kind === 'helper') {
    els.ideTaskBoard.hidden = true;
    stopIdeBoardTicker();
    updateTypingAndRelayBanners(group);
    return;
  }
  const board = state.ideBoardsByGroup.get(group.id) || group.ideBoard || null;
  if (!board) {
    els.ideTaskBoard.hidden = true;
    stopIdeBoardTicker();
    updateTypingAndRelayBanners(group);
    return;
  }

  els.ideTaskBoard.hidden = false;
  const routing = getNormalizedGroupRouting(group);
  const slotOrder = (routing.slots || []).map((s) => s.slotId);
  const rawActorKeys = Object.keys(board.actors || {});
  const orderedIds = [
    ...slotOrder.filter((id) => board.actors?.[id]),
    ...rawActorKeys.filter((id) => !slotOrder.includes(id)),
  ];
  const actorIds = orderedIds;

  const isCollapsed = isIdeBoardCollapsedForGroup(group.id);
  els.ideTaskBoard.classList.toggle('is-collapsed', isCollapsed);
  els.itbGrid.hidden = isCollapsed;
  if (els.itbToggleBtn) {
    els.itbToggleBtn.textContent = isCollapsed ? '展开步骤' : '收起看板';
    els.itbToggleBtn.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
  }
  if (els.itbTaskTitle) {
    els.itbTaskTitle.textContent = board.taskTitle || group.title || '协作任务';
  }
  if (els.itbStageText) {
    if (isCollapsed && actorIds.length > 0) {
      els.itbStageText.textContent = actorIds
        .map((id) => {
          const st = board.actors[id];
          const slot = resolveGroupSlot(routing, id);
          return `${slot?.label || st?.title || id} · ${st?.phaseLabel || '待命'}`;
        })
        .join(' / ');
    } else {
      els.itbStageText.textContent = board.stageText || '';
    }
  }
  if (els.itbRoundPill) {
    const roundNum = Number(board.round || 0);
    els.itbRoundPill.hidden = roundNum <= 0;
    if (roundNum > 0) els.itbRoundPill.textContent = `第 ${roundNum} 轮`;
  }

  const frag = document.createDocumentFragment();
  let anyActive = false;

  for (const id of actorIds) {
    const a = board.actors[id];
    const slot = resolveGroupSlot(routing, id);
    const provider = a.provider || slot?.provider || (String(id).includes('codex') ? 'codex' : 'antigravity');
    const role = a.role || slot?.role || 'peer';
    const isActive = ACTIVE_IDE_PHASES.has(a.phase);
    if (isActive) anyActive = true;

    const detailsEl = document.createElement('details');
    detailsEl.className = `itb-row is-phase-${a.phase || 'idle'}`;
    detailsEl.dataset.slotId = id;
    const detKey = `${group.id}:${id}`;
    if (state.openIdeSlotDetails.has(detKey)) {
      detailsEl.open = true;
    }
    detailsEl.addEventListener('toggle', () => {
      if (detailsEl.open) {
        state.openIdeSlotDetails.add(detKey);
      } else {
        state.openIdeSlotDetails.delete(detKey);
      }
    });

    // No heading element inside <summary> (modern-web-guidance: accordion)
    const summaryEl = document.createElement('summary');
    summaryEl.className = 'itb-summary';

    const dot = document.createElement('span');
    dot.className = `stb-agent-dot ${provider === 'codex' ? 'is-cx' : 'is-ag'}`;
    dot.textContent = avatarMetaForActor(id, slot?.label || a.title).label;

    const titleEl = document.createElement('span');
    titleEl.className = 'itb-slot-name';
    titleEl.textContent = slot?.label || a.title || (provider === 'codex' ? 'Codex' : 'Antigravity');

    summaryEl.append(dot, titleEl);

    if (role === 'lead') {
      const leadBadge = document.createElement('span');
      leadBadge.className = 'role-badge is-lead itb-lead-tag';
      leadBadge.textContent = '主审';
      summaryEl.appendChild(leadBadge);
    }

    if (a.sessionTitle) {
      const sessEl = document.createElement('span');
      sessEl.className = 'itb-session-pill';
      sessEl.title = a.sessionTitle;
      sessEl.textContent = a.sessionTitle;
      summaryEl.appendChild(sessEl);
    }

    const phaseEl = document.createElement('span');
    phaseEl.className = `itb-phase-pill is-${a.phase || 'idle'}`;
    phaseEl.textContent = a.phaseLabel || '待命';
    summaryEl.appendChild(phaseEl);

    const steps = Array.isArray(a.steps) ? a.steps : [];
    if (steps.length > 0) {
      const doneCount = steps.filter((s) => s.status === 'done').length;
      const ratioEl = document.createElement('span');
      ratioEl.className = 'itb-step-ratio';
      ratioEl.textContent = `${doneCount}/${steps.length}`;
      summaryEl.appendChild(ratioEl);
    }

    const inlinePreview = a.currentAction || a.subtask || '';
    if (inlinePreview) {
      const actPreview = document.createElement('span');
      actPreview.className = 'itb-inline-action';
      actPreview.textContent = inlinePreview;
      summaryEl.appendChild(actPreview);
    }

    const hbEl = document.createElement('span');
    hbEl.className = 'itb-heartbeat itb-hb';
    hbEl.dataset.itbHb = id;
    hbEl.textContent = formatBoardHeartbeatLabel(a);
    summaryEl.appendChild(hbEl);

    if (a.phase === 'error') {
      const retryActorBtn = document.createElement('button');
      retryActorBtn.type = 'button';
      retryActorBtn.className = 'itb-slot-retry-btn';
      retryActorBtn.title = `仅重试 ${slot?.label || a.title || id}`;
      retryActorBtn.textContent = '↻';
      retryActorBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        retrySingleActor(group.id, id);
      });
      summaryEl.appendChild(retryActorBtn);
    }

    detailsEl.appendChild(summaryEl);

    const bodyEl = document.createElement('div');
    bodyEl.className = 'itb-detail-body';

    if (a.subtask) {
      const subEl = document.createElement('div');
      subEl.className = 'itb-subtask';
      subEl.textContent = `负责：${a.subtask}`;
      bodyEl.appendChild(subEl);
    }

    if (steps.length > 0) {
      const stepsUl = document.createElement('ul');
      stepsUl.className = 'itb-steps';
      for (const step of steps) {
        const li = document.createElement('li');
        li.className = `itb-step is-${step.status || 'pending'}`;
        const icon = document.createElement('span');
        icon.className = 'itb-step-icon';
        icon.textContent =
          step.status === 'done'
            ? '✓'
            : step.status === 'active'
              ? '●'
              : step.status === 'blocked'
                ? '!'
                : '○';
        const txt = document.createElement('span');
        txt.className = 'itb-step-title';
        txt.textContent = step.title || '';
        li.append(icon, txt);
        stepsUl.appendChild(li);
      }
      bodyEl.appendChild(stepsUl);
    }

    if (a.currentAction) {
      const curEl = document.createElement('div');
      curEl.className = 'itb-current-action';
      curEl.textContent = a.currentAction;
      bodyEl.appendChild(curEl);
    }

    if (Array.isArray(a.recentActions) && a.recentActions.length > 0) {
      const feedUl = document.createElement('ul');
      feedUl.className = 'itb-feed';
      for (const act of a.recentActions.slice(0, 4)) {
        const li = document.createElement('li');
        li.className = 'itb-feed-item';
        const timeEl = document.createElement('span');
        timeEl.className = 'itb-feed-time';
        timeEl.textContent = act.ts ? formatSessionShortTime(act.ts) : '';
        const textEl = document.createElement('span');
        textEl.className = 'itb-feed-text';
        textEl.textContent = act.text || '';
        li.append(timeEl, textEl);
        feedUl.appendChild(li);
      }
      bodyEl.appendChild(feedUl);
    }

    detailsEl.appendChild(bodyEl);
    frag.appendChild(detailsEl);
  }

  els.itbGrid.replaceChildren(frag);
  if (anyActive && !isCollapsed) {
    ensureIdeBoardTicker();
  } else {
    stopIdeBoardTicker();
  }
  updateTypingAndRelayBanners(group);
}

function updateSlotInGroupRouting(group, slotId, slotPatch) {
  if (!group || group.kind === 'helper') return;
  const base = getNormalizedGroupRouting(group);
  const nextSlots = base.slots.map((s) => {
    if (s.slotId !== slotId) {
      if (slotPatch.role === 'lead' && s.role === 'lead') {
        return { ...s, role: 'peer' };
      }
      return s;
    }
    return { ...s, ...slotPatch };
  });
  applyGroupSessionRoutingPatch(group, { slots: nextSlots });
}

function addSlotToGroupRouting(group, provider) {
  if (!group || group.kind === 'helper') return;
  const base = getNormalizedGroupRouting(group);
  if (base.slots.length >= 8) {
    showToast('最多支持同时编排 8 个目标会话');
    return;
  }
  const safeProv = provider === 'codex' ? 'codex' : 'antigravity';
  const usedIds = new Set(base.slots.map((s) => s.slotId));
  let idx = 1;
  const prefix = safeProv === 'codex' ? 'codex' : 'agy';
  while (usedIds.has(`${prefix}-${idx}`)) idx += 1;
  const slotId = `${prefix}-${idx}`;
  const existingSameProv = base.slots.filter((s) => s.provider === safeProv).length + 1;
  const label = safeProv === 'codex' ? `Codex-${existingSameProv}` : `AG-${existingSameProv}`;
  const defaultScope = group.scopePath || '';
  const usedSessions = new Set(
    base.slots.filter((s) => s.mode === 'existing' && s.sessionId).map((s) => s.sessionId)
  );
  const candidates = (state.externalSessions[safeProv] || []).filter((s) => !usedSessions.has(s.id));
  const picked = candidates[0] || null;
  const newSlot = picked
    ? {
        slotId,
        provider: safeProv,
        label,
        role: 'peer',
        mode: 'existing',
        sessionId: picked.id,
        sessionTitle: picked.title || picked.id.slice(0, 8),
        cwd: picked.cwd || defaultScope,
      }
    : {
        slotId,
        provider: safeProv,
        label,
        role: 'peer',
        mode: defaultScope ? 'new' : 'group',
        sessionId: '',
        sessionTitle: '',
        cwd: defaultScope,
      };
  applyGroupSessionRoutingPatch(group, { slots: [...base.slots, newSlot] });
}

function removeSlotFromGroupRouting(group, slotId) {
  if (!group || group.kind === 'helper') return;
  const base = getNormalizedGroupRouting(group);
  if (base.slots.length <= 2) {
    showToast('至少保留 2 个会话槽位');
    return;
  }
  const nextSlots = base.slots.filter((s) => s.slotId !== slotId);
  applyGroupSessionRoutingPatch(group, { slots: nextSlots });
}

function applyPresetOneLeadTwoAgy(group) {
  if (!group || group.kind === 'helper') return;
  const defaultScope = group.scopePath || '';
  const cxList = state.externalSessions.codex || [];
  const agList = state.externalSessions.antigravity || [];
  const curRouting = getNormalizedGroupRouting(group);
  const curCx = curRouting.slots.find((s) => s.provider === 'codex');
  const cxTarget =
    curCx && curCx.mode === 'existing' && curCx.sessionId
      ? { mode: 'existing', sessionId: curCx.sessionId, sessionTitle: curCx.sessionTitle, cwd: curCx.cwd }
      : cxList[0]
        ? { mode: 'existing', sessionId: cxList[0].id, sessionTitle: cxList[0].title || '', cwd: cxList[0].cwd || defaultScope }
        : { mode: 'new', sessionId: '', sessionTitle: '', cwd: defaultScope };

  const existingAgy = curRouting.slots.filter(
    (s) => s.provider === 'antigravity' && s.mode === 'existing' && s.sessionId
  );
  const ag1Target = existingAgy[0]
    ? { mode: 'existing', sessionId: existingAgy[0].sessionId, sessionTitle: existingAgy[0].sessionTitle, cwd: existingAgy[0].cwd }
    : agList[0]
      ? { mode: 'existing', sessionId: agList[0].id, sessionTitle: agList[0].title || '', cwd: agList[0].cwd || defaultScope }
      : { mode: 'new', sessionId: '', sessionTitle: '', cwd: defaultScope };
  const ag2Pick = agList.find((s) => s.id !== ag1Target.sessionId) || null;
  const ag2Target = existingAgy[1] && existingAgy[1].sessionId !== ag1Target.sessionId
    ? { mode: 'existing', sessionId: existingAgy[1].sessionId, sessionTitle: existingAgy[1].sessionTitle, cwd: existingAgy[1].cwd }
    : ag2Pick
      ? { mode: 'existing', sessionId: ag2Pick.id, sessionTitle: ag2Pick.title || '', cwd: ag2Pick.cwd || defaultScope }
      : { mode: 'new', sessionId: '', sessionTitle: '', cwd: defaultScope };

  applyGroupSessionRoutingPatch(group, {
    flow: 'direct',
    autoReview: true,
    slots: [
      { slotId: 'codex', provider: 'codex', label: 'Codex', role: 'lead', ...cxTarget },
      { slotId: 'agy-1', provider: 'antigravity', label: 'AG-1', role: 'peer', ...ag1Target },
      { slotId: 'agy-2', provider: 'antigravity', label: 'AG-2', role: 'peer', ...ag2Target },
    ],
  });
  showToast('已配置「1 Codex 主审 + 2 Antigravity 子会话」，可直接派发任务');
}

function renderSessionTargetBar(group) {
  if (!group || group.kind === 'helper') {
    if (els.openSessionRoutingBtn) els.openSessionRoutingBtn.hidden = true;
    if (els.targetSessionToggleBtn) els.targetSessionToggleBtn.hidden = true;
    if (els.sendBtn) els.sendBtn.textContent = '发送(S)';
    if (els.messageInput) {
      els.messageInput.placeholder = '输入消息，@ 指定会话，/ 调指令…';
    }
    return;
  }

  const routing = getNormalizedGroupRouting(group);
  const activeSlots = getActiveGroupSlots(routing);
  const isRouted = activeSlots.length > 0;
  const leadSlot = activeSlots.find((s) => s.role === 'lead') || routing.slots.find((s) => s.role === 'lead');
  const modalOpen = Boolean(els.sessionRoutingDialog?.open);

  if (els.openSessionRoutingBtn) {
    els.openSessionRoutingBtn.hidden = false;
    els.openSessionRoutingBtn.classList.toggle('is-routed', isRouted);
    els.openSessionRoutingBtn.textContent = isRouted
      ? `会话 · ${activeSlots.length}${leadSlot ? ' 主审' : ''}`
      : '会话';
  }
  if (els.targetSessionToggleBtn) {
    els.targetSessionToggleBtn.hidden = false;
    els.targetSessionToggleBtn.setAttribute('aria-expanded', modalOpen ? 'true' : 'false');
    els.targetSessionToggleBtn.classList.toggle('is-active', modalOpen);
    els.targetSessionToggleBtn.classList.toggle('is-routed', isRouted);
    els.targetSessionToggleBtn.textContent = isRouted ? `会话 · ${activeSlots.length}` : '会话';
  }

  if (modalOpen && !state.externalSessionsLoaded && !state.loadingExternalSessions) {
    loadExternalSessions({ silent: true });
  }

  if (els.resetSessionRoutingBtn) {
    els.resetSessionRoutingBtn.hidden = !isRouted && routing.slots.length <= 2;
  }
  if (els.refreshExtSessionsBtn) {
    els.refreshExtSessionsBtn.disabled = state.loadingExternalSessions;
    els.refreshExtSessionsBtn.textContent = state.loadingExternalSessions ? '扫描中…' : '刷新会话';
  }
  if (els.addAgySlotBtn) els.addAgySlotBtn.disabled = routing.slots.length >= 8;
  if (els.addCodexSlotBtn) els.addCodexSlotBtn.disabled = routing.slots.length >= 8;
  if (els.srdSlotCountHint) {
    els.srdSlotCountHint.textContent = `已启用 ${activeSlots.length} / 共 ${routing.slots.length} 槽位（上限 8）`;
  }

  if (els.sessionFlowSeg) {
    for (const btn of els.sessionFlowSeg.querySelectorAll('[data-session-flow]')) {
      btn.classList.toggle('is-active', btn.dataset.sessionFlow === routing.flow);
    }
  }
  if (els.sessionPermSeg) {
    for (const btn of els.sessionPermSeg.querySelectorAll('[data-session-perm]')) {
      btn.classList.toggle('is-active', btn.dataset.sessionPerm === routing.permission);
    }
  }
  if (els.autoReviewToggleBtn) {
    const isRevOn = routing.autoReview !== false;
    els.autoReviewToggleBtn.setAttribute('aria-pressed', isRevOn ? 'true' : 'false');
    els.autoReviewToggleBtn.classList.toggle('is-primary-tint', isRevOn);
    els.autoReviewToggleBtn.textContent = isRevOn ? '主审自动验收 · 开' : '主审自动验收 · 关';
  }
  if (els.autoWakeToggleBtn) {
    const isWakeOn = routing.autoWake !== false;
    els.autoWakeToggleBtn.setAttribute('aria-pressed', isWakeOn ? 'true' : 'false');
    els.autoWakeToggleBtn.classList.toggle('is-primary-tint', isWakeOn);
    els.autoWakeToggleBtn.textContent = isWakeOn ? '自动唤醒 · 开' : '自动唤醒 · 关';
  }
  if (els.sessionPresetSummary) {
    const flowTxt = routing.flow === 'discuss_then_exec' ? '先聊再派 IDE' : '直达会话';
    const permTxt =
      routing.permission === 'workspace-write'
        ? '允许改代码'
        : routing.permission === 'read-only'
          ? '只读分析'
          : '沿用原权限';
    const reviewTxt = routing.autoReview !== false ? '主审验收开' : '主审验收关';
    const wakeTxt = routing.autoWake !== false ? '自动唤醒开' : '自动唤醒关';
    els.sessionPresetSummary.textContent = `${flowTxt} · ${permTxt} · ${reviewTxt} · ${wakeTxt}`;
  }
  if (els.sessionPresetPanel && els.toggleSessionPresetsBtn) {
    const presetsOpen = Boolean(state.sessionPresetsOpenByGroup.get(group.id));
    els.sessionPresetPanel.hidden = !presetsOpen;
    els.toggleSessionPresetsBtn.setAttribute('aria-expanded', presetsOpen ? 'true' : 'false');
    els.toggleSessionPresetsBtn.classList.toggle('is-active', presetsOpen);
  }

  if (els.sessionSlotsList && !(document.activeElement && els.sessionSlotsList.contains(document.activeElement) && document.activeElement.tagName === 'INPUT')) {
    const dupCounts = new Map();
    for (const s of routing.slots) {
      if (s.mode === 'existing' && s.sessionId) {
        const key = `${s.provider}:${s.sessionId}`;
        dupCounts.set(key, (dupCounts.get(key) || 0) + 1);
      }
    }
    const canPickDesktopDir = Boolean(window.electronApp?.pickDirectory);
    const listFrag = document.createDocumentFragment();

    for (const slot of routing.slots) {
      const card = document.createElement('div');
      card.className = `srd-slot-card${slot.mode !== 'group' ? ' is-bound' : ''}${slot.role === 'lead' ? ' is-lead' : ''}`;
      card.dataset.slotId = slot.slotId;

      const topRow = document.createElement('div');
      topRow.className = 'srd-slot-head';

      const provSel = document.createElement('select');
      provSel.className = 'srd-provider-select';
      provSel.setAttribute('aria-label', `${slot.label} 引擎类型`);
      const optAg = new Option('Antigravity', 'antigravity');
      const optCx = new Option('Codex', 'codex');
      provSel.append(optAg, optCx);
      provSel.value = slot.provider;
      provSel.addEventListener('change', () => {
        const nextProv = provSel.value === 'codex' ? 'codex' : 'antigravity';
        updateSlotInGroupRouting(group, slot.slotId, {
          provider: nextProv,
          mode: 'group',
          sessionId: '',
          sessionTitle: '',
        });
      });

      const labelInput = document.createElement('input');
      labelInput.type = 'text';
      labelInput.className = 'srd-label-input';
      labelInput.maxLength = 24;
      labelInput.value = slot.label;
      labelInput.placeholder = '会话别称（如 AG-1）';
      labelInput.title = '用于群聊 @ 点名与进度看板标识的简短名称';
      labelInput.addEventListener('change', () => {
        const nextLabel = labelInput.value.trim().slice(0, 24) || slot.slotId;
        if (nextLabel !== slot.label) {
          updateSlotInGroupRouting(group, slot.slotId, { label: nextLabel });
        }
      });

      const roleBtn = document.createElement('button');
      roleBtn.type = 'button';
      roleBtn.className = `srd-role-btn${slot.role === 'lead' ? ' is-lead' : ''}`;
      roleBtn.textContent = slot.role === 'lead' ? '🎯 主审验收' : '成员';
      roleBtn.title = '设为「主审」后，群发任务时子会话并行完成，主审自动分析审查并只打回不通过项';
      roleBtn.addEventListener('click', () => {
        const nextRole = slot.role === 'lead' ? 'peer' : 'lead';
        updateSlotInGroupRouting(group, slot.slotId, { role: nextRole });
      });

      const headRight = document.createElement('div');
      headRight.className = 'srd-head-right';
      const hintSpan = document.createElement('span');
      hintSpan.className = `stb-slot-hint${slot.mode !== 'group' ? ' is-external' : ''}`;
      hintSpan.textContent = formatAgentSlotHint(slot.provider, slot, routing, group);
      headRight.appendChild(hintSpan);

      if (slot.mode === 'existing' && slot.sessionId) {
        const previewBtn = document.createElement('button');
        previewBtn.type = 'button';
        previewBtn.className = 'stb-preview-btn';
        previewBtn.textContent = '👁 预览';
        previewBtn.title = '预览目标会话最近内容';
        previewBtn.addEventListener('click', () => {
          openExternalSessionPreview(slot.provider, slot.sessionId);
        });
        headRight.appendChild(previewBtn);
      }

      if (routing.slots.length > 2) {
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'srd-remove-btn';
        delBtn.textContent = '×';
        delBtn.title = '移除此槽位';
        delBtn.setAttribute('aria-label', `移除 ${slot.label}`);
        delBtn.addEventListener('click', () => {
          removeSlotFromGroupRouting(group, slot.slotId);
        });
        headRight.appendChild(delBtn);
      }

      topRow.append(provSel, labelInput, roleBtn, headRight);
      card.appendChild(topRow);

      const selEl = document.createElement('select');
      selEl.className = 'stb-select srd-session-select';
      selEl.setAttribute('aria-label', `${slot.label} 绑定会话`);
      populateAgentSessionSelect(
        selEl,
        slot.provider,
        slot,
        state.externalSessions[slot.provider] || [],
        `${group.id}:${slot.slotId}`
      );
      selEl.addEventListener('change', () => {
        const rawVal = String(selEl.value || 'group');
        if (rawVal === 'group') {
          updateSlotInGroupRouting(group, slot.slotId, {
            mode: 'group',
            sessionId: '',
            sessionTitle: '',
            cwd: '',
          });
          return;
        }
        if (rawVal === 'new') {
          const firstRecent = state.externalSessions.recentDirectories?.[0];
          const fallbackRecent =
            typeof firstRecent === 'string' ? firstRecent : firstRecent?.path || '';
          const defaultDir = slot.cwd || group.scopePath || fallbackRecent || '';
          updateSlotInGroupRouting(group, slot.slotId, {
            mode: 'new',
            sessionId: '',
            sessionTitle: '',
            cwd: defaultDir,
          });
          return;
        }
        if (rawVal.startsWith('existing:')) {
          const sid = rawVal.slice('existing:'.length);
          const found = (state.externalSessions[slot.provider] || []).find((s) => s.id === sid);
          updateSlotInGroupRouting(group, slot.slotId, {
            mode: 'existing',
            sessionId: sid,
            sessionTitle: found?.title || slot.sessionTitle || sid.slice(0, 8),
            cwd: found?.cwd || slot.cwd || '',
          });
        }
      });
      card.appendChild(selEl);

      if (slot.mode === 'existing' && slot.sessionId && (dupCounts.get(`${slot.provider}:${slot.sessionId}`) || 0) > 1) {
        const dupWarn = document.createElement('div');
        dupWarn.className = 'srd-dup-warn';
        dupWarn.textContent = '⚠ 该会话已在多个槽位重复绑定；并发执行时同会话将自动串行排队。';
        card.appendChild(dupWarn);
      }

      if (slot.mode === 'new') {
        const dirRow = document.createElement('div');
        dirRow.className = 'stb-dir-row';
        const dirInput = document.createElement('input');
        dirInput.type = 'text';
        dirInput.className = 'stb-dir-input';
        dirInput.setAttribute('list', 'recentProjectDirsList');
        dirInput.placeholder = '输入或选择新建会话的项目目录路径…';
        dirInput.value = slot.cwd || group.scopePath || '';
        const commitDir = () => {
          const nextDir = dirInput.value.trim();
          if (nextDir !== (slot.cwd || '')) {
            updateSlotInGroupRouting(group, slot.slotId, { mode: 'new', cwd: nextDir });
          }
        };
        dirInput.addEventListener('change', commitDir);
        dirInput.addEventListener('blur', commitDir);
        dirRow.appendChild(dirInput);

        if (canPickDesktopDir) {
          const pickBtn = document.createElement('button');
          pickBtn.type = 'button';
          pickBtn.className = 'stb-dir-btn';
          pickBtn.textContent = '📂 浏览';
          pickBtn.addEventListener('click', async () => {
            const chosen = await window.electronApp.pickDirectory();
            if (chosen) {
              dirInput.value = chosen;
              updateSlotInGroupRouting(group, slot.slotId, { mode: 'new', cwd: chosen });
            }
          });
          dirRow.appendChild(pickBtn);
        }
        card.appendChild(dirRow);
      }

      listFrag.appendChild(card);
    }

    els.sessionSlotsList.replaceChildren(listFrag);
  }

  if (els.sendBtn) {
    if (isRouted) {
      els.sendBtn.textContent =
        routing.flow === 'discuss_then_exec'
          ? `商量并派 (${activeSlots.length})`
          : `派发 (${activeSlots.length})`;
    } else {
      els.sendBtn.textContent = '发送(S)';
    }
  }
  if (els.messageInput) {
    els.messageInput.placeholder = isRouted
      ? `输入任务（${activeSlots.length} 个目标会话就绪，@ 可点名单槽位）…`
      : '输入消息，@ 指定会话，/ 调指令…';
  }
}

function applyGroupSessionRoutingPatch(group, partialRouting) {
  if (!group || group.kind === 'helper') return;
  const base = getNormalizedGroupRouting(group);
  const mergedRaw = {
    ...base,
    ...partialRouting,
    codex: partialRouting.codex ? { ...base.codex, ...partialRouting.codex } : base.codex,
    antigravity: partialRouting.antigravity
      ? { ...base.antigravity, ...partialRouting.antigravity }
      : base.antigravity,
  };
  const next = getNormalizedGroupRouting({
    scopePath: group.scopePath || '',
    sessionRouting: mergedRaw,
  });
  next.enabled = isGroupExternallyRouted(next);
  state.slotSelectCacheKeys.clear();
  updateGroupCollabPrefs(group, { sessionRouting: next });
}

async function openExternalSessionPreview(agentKey, sessionId) {
  if (!sessionId || !els.sessionPreviewDialog) return;
  const agentName = agentKey === 'codex' ? 'Codex' : 'Antigravity';
  els.sessionPreviewTitle.textContent = `${agentName} 会话最近内容预览`;
  els.sessionPreviewSub.textContent = sessionId;
  els.sessionPreviewBody.replaceChildren();
  if (els.sessionPreviewOpenDirBtn) {
    els.sessionPreviewOpenDirBtn.hidden = true;
    els.sessionPreviewOpenDirBtn.onclick = null;
  }

  const loadingEl = document.createElement('div');
  loadingEl.className = 'info-card-row';
  loadingEl.textContent = '正在读取该会话最近对话…';
  els.sessionPreviewBody.appendChild(loadingEl);

  if (!els.sessionPreviewDialog.open) {
    els.sessionPreviewDialog.showModal();
  }

  try {
    const res = await apiFetch(
      `/api/external-sessions/${encodeURIComponent(agentKey)}/${encodeURIComponent(sessionId)}/preview?limit=3`
    );
    els.sessionPreviewBody.replaceChildren();
    els.sessionPreviewTitle.textContent = `${agentName} · ${res.title || sessionId.slice(0, 8)}`;
    els.sessionPreviewSub.textContent = res.cwd || sessionId;

    const metaStrip = document.createElement('div');
    metaStrip.className = 'sp-meta-strip';
    const metaParts = [];
    if (res.cwd) metaParts.push(`📂 目录：${res.cwd}`);
    if (res.gitBranch) metaParts.push(`⎇ 分支：${res.gitBranch}`);
    if (res.updatedAt) metaParts.push(`🕒 最近活跃：${formatFullWeChatTimestamp(res.updatedAt)}`);
    metaStrip.textContent = metaParts.join('  ·  ') || `会话 ID：${sessionId}`;
    els.sessionPreviewBody.appendChild(metaStrip);

    if (res.cwd && els.sessionPreviewOpenDirBtn) {
      els.sessionPreviewOpenDirBtn.hidden = false;
      els.sessionPreviewOpenDirBtn.onclick = () => openOrCopyLocalPath(res.cwd);
    }

    const rawItems = res.items || res.messages;
    const items = Array.isArray(rawItems) ? rawItems : [];
    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'info-card-row';
      empty.textContent = '该会话暂无可预览的最近文本消息（可能刚创建或仅含工具动作）。';
      els.sessionPreviewBody.appendChild(empty);
      return;
    }

    for (const it of items) {
      const card = document.createElement('div');
      card.className = `sp-msg-card ${it.role === 'user' ? 'is-user' : 'is-agent'}`;
      const roleSpan = document.createElement('span');
      roleSpan.className = 'sp-msg-role';
      roleSpan.textContent =
        it.role === 'user'
          ? `👤 我${it.ts ? ` · ${formatSessionShortTime(it.ts)}` : ''}`
          : `🤖 ${agentName}${it.ts ? ` · ${formatSessionShortTime(it.ts)}` : ''}`;
      const bodyDiv = document.createElement('div');
      bodyDiv.className = 'sp-msg-text';
      bodyDiv.textContent = String(it.text || '').trim();
      card.append(roleSpan, bodyDiv);
      els.sessionPreviewBody.appendChild(card);
    }
  } catch (err) {
    els.sessionPreviewBody.replaceChildren();
    const errEl = document.createElement('div');
    errEl.className = 'info-card-row';
    errEl.textContent = `预览加载失败：${err.message}`;
    els.sessionPreviewBody.appendChild(errEl);
  }
}

// --- Render Chat Header & Collaboration / Recipient Controls ---
function renderActiveHeaderAndRecipients() {
  const group = getSelectedGroup();
  if (!group) {
    els.emptyWatermark.hidden = false;
    els.activeChatWrap.hidden = true;
    return;
  }
  els.emptyWatermark.hidden = true;
  els.activeChatWrap.hidden = false;

  if (els.pinSessionBtn) {
    const isPinned = Boolean(group.pinned);
    els.pinSessionBtn.classList.toggle('is-pinned', isPinned);
    els.pinSessionBtn.setAttribute('aria-pressed', isPinned ? 'true' : 'false');
    els.pinSessionBtn.title = isPinned ? '取消置顶当前会话' : '置顶当前会话';
  }

  if (group.kind === 'helper') {
    els.chatTitle.textContent = group.title;
    els.chatSubtitle.textContent = group.topic;
    els.chatSubtitle.classList.remove('is-thinking');
    if (els.openSessionRoutingBtn) els.openSessionRoutingBtn.hidden = true;
    if (els.replyStyleBtn) els.replyStyleBtn.hidden = true;
    els.speedGearBtn.hidden = true;
    els.collabModeBar.hidden = true;
    els.relayOrderBtn.hidden = true;
    els.blindHintChip.hidden = true;
    if (els.recipientBar.childElementCount > 0) {
      els.recipientBar.replaceChildren();
    }
    state.lastRecipientChipsKey = '';
    els.sharedCtxBtn.hidden = true;
    els.replyModeBtn.hidden = true;
    els.mentionBtn.hidden = true;
    if (els.scopeFileBtn) els.scopeFileBtn.hidden = true;
    updateTypingAndRelayBanners(group);
  } else {
    const routing = getNormalizedGroupRouting(group);
    const activeSlots = getActiveGroupSlots(routing);
    const isExtRouted = activeSlots.length > 0;
    els.chatTitle.textContent = isExtRouted
      ? `${group.title} (${activeSlots.length} 会话)`
      : `${group.title} (${group.memberCount})`;
    const thinking = getThinkingActorsForGroup(group);
    if (thinking.length > 0) {
      els.chatSubtitle.textContent = `${thinking.map((a) => a.title).join('、')} 正在运行中…`;
      els.chatSubtitle.classList.add('is-thinking');
    } else if (isExtRouted) {
      els.chatSubtitle.textContent = activeSlots
        .map((s) => `${s.label}${s.role === 'lead' ? '(主审)' : ''}`)
        .join(' · ');
      els.chatSubtitle.classList.remove('is-thinking');
    } else {
      const parts = (group.actors || []).map(
        (a) => `${a.title}${a.readOnly ? '[只读]' : ''} ${a.running ? '在线' : '已停'}`
      );
      els.chatSubtitle.textContent = parts.join(' · ') || '群聊就绪';
      els.chatSubtitle.classList.remove('is-thinking');
    }

    // Header / Quick Menu Reply Style Button (0ms instant 3-tier switch)
    if (els.replyStyleBtn) {
      const curStyle = ['plain', 'balanced', 'pro'].includes(group.replyStyle)
        ? group.replyStyle
        : 'plain';
      const styleMeta = {
        plain: {
          label: '人话',
          cls: 'is-plain',
          tip: '当前回复风格：人话精简（少废话、说人话、不堆黑话术语）。点击切换为适中清晰',
        },
        balanced: {
          label: '适中',
          cls: 'is-balanced',
          tip: '当前回复风格：适中清晰（结论先行 + 简明要点，兼顾通俗与条理）。点击切换为专业深度',
        },
        pro: {
          label: '专业',
          cls: 'is-pro',
          tip: '当前回复风格：专业深度（完整保留专业术语、源码依据与严谨推导）。点击切换为人话精简',
        },
      }[curStyle];
      els.replyStyleBtn.hidden = false;
      els.replyStyleBtn.className = `style-pill ${styleMeta.cls}`;
      els.replyStyleBtn.textContent = styleMeta.label;
      els.replyStyleBtn.title = styleMeta.tip;
    }

    // Speed Gear Button
    const isFast = group.speedGear === 'fast';
    els.speedGearBtn.hidden = false;
    els.speedGearBtn.disabled = state.switchingGear;
    els.speedGearBtn.className = `gear-pill ${isFast ? 'is-fast' : 'is-deep'}`;
    els.speedGearBtn.textContent = state.switchingGear
      ? '切换中…'
      : isFast
        ? '极速'
        : '深度';
    els.speedGearBtn.title = isFast
      ? '当前：极速快聊档（Flash-Low + Codex低推理 + 精简MCP）。点击切换为深度思考档'
      : '当前：深度思考档（完整推理强度）。点击切换为极速快聊档';

    // 3-Mode Collaboration Controls (superseded cleanly when target sessions are bound)
    const collabMode = group.collabMode || 'free';
    const enabledActors = (group.actors || []).filter((a) => a.enabled !== false);
    els.collabModeBar.hidden = isExtRouted || enabledActors.length < 2;
    for (const btn of els.collabModeBar.querySelectorAll('[data-collab]')) {
      btn.classList.toggle('is-active', btn.dataset.collab === collabMode);
    }

    if (isExtRouted) {
      els.relayOrderBtn.hidden = true;
      els.blindHintChip.hidden = true;
      els.sharedCtxBtn.hidden = true;
      renderRecipientChips(group);
    } else if (collabMode === 'relay' && enabledActors.length >= 2) {
      const lead =
        enabledActors.find((a) => a.id === (group.relayLead || 'codex')) || enabledActors[0];
      const reviewer = enabledActors.find((a) => a.id !== lead.id) || enabledActors[1];
      els.relayOrderBtn.hidden = false;
      els.relayOrderBtn.textContent = `${shortActorTag(lead)}初稿 → ${shortActorTag(reviewer)}复核`;
      els.blindHintChip.hidden = true;
      if (els.recipientBar.childElementCount > 0) {
        els.recipientBar.replaceChildren();
      }
      state.lastRecipientChipsKey = '';
      els.sharedCtxBtn.hidden = false;
    } else if (collabMode === 'blind' && enabledActors.length >= 2) {
      els.relayOrderBtn.hidden = true;
      els.blindHintChip.hidden = false;
      if (els.recipientBar.childElementCount > 0) {
        els.recipientBar.replaceChildren();
      }
      state.lastRecipientChipsKey = '';
      els.sharedCtxBtn.hidden = true;
    } else {
      els.relayOrderBtn.hidden = true;
      els.blindHintChip.hidden = true;
      els.sharedCtxBtn.hidden = false;
      renderRecipientChips(group);
    }

    els.replyModeBtn.hidden = isExtRouted;
    els.mentionBtn.hidden = false;
    if (els.scopeFileBtn) els.scopeFileBtn.hidden = !group.scopePath;
    updateTypingAndRelayBanners(group);
  }

  renderIdeTaskBoard(group);
  renderSessionTargetBar(group);
  renderQueuedTurnBar(group);
  updateSendButtonState();

  if (!els.groupDrawer.hidden) {
    renderGroupDrawer(group);
  }
}

function renderRecipientChips(group) {
  const routing = getNormalizedGroupRouting(group);
  const activeSlots = getActiveGroupSlots(routing);
  const useSlots = activeSlots.length > 0;
  const targetItems = useSlots
    ? activeSlots.map((s) => ({
        id: s.slotId,
        chipText: s.role === 'lead' ? `@${s.label}·主审` : `@${s.label}`,
        title: `${s.label} (${s.provider === 'codex' ? 'Codex' : 'Antigravity'})${s.sessionTitle ? ` · ${s.sessionTitle}` : ''}`,
      }))
    : (group.actors || []).map((a) => ({
        id: a.id,
        chipText: `@${a.id}`,
        title: a.title || a.id,
      }));

  if (targetItems.length === 0) {
    if (els.recipientBar.childElementCount > 0) {
      els.recipientBar.replaceChildren();
    }
    state.lastRecipientChipsKey = '';
    return;
  }

  const validIdSet = new Set(targetItems.map((t) => t.id));
  const sanitizedSel = state.selectedRecipients.filter((id) => id === '@all' || validIdSet.has(id));
  const activeList = sanitizedSel.length ? sanitizedSel : ['@all'];
  const nextChipsKey = `${group.id}|${useSlots ? 'slots' : 'actors'}|${targetItems.map((t) => `${t.id}:${t.chipText}`).join(',')}|${activeList.join(',')}`;
  if (nextChipsKey === state.lastRecipientChipsKey && els.recipientBar.childElementCount > 0) {
    return;
  }
  state.lastRecipientChipsKey = nextChipsKey;
  els.recipientBar.replaceChildren();

  const activeSet = new Set(activeList);

  if (targetItems.length > 1) {
    const allChip = document.createElement('button');
    allChip.type = 'button';
    const isAll = activeSet.has('@all');
    allChip.className = `recip-chip${isAll ? ' is-active' : ''}`;
    allChip.textContent = useSlots ? '@全部会话' : '@所有人';
    allChip.addEventListener('click', () => {
      state.selectedRecipients = ['@all'];
      renderRecipientChips(group);
      els.messageInput.focus();
    });
    els.recipientBar.appendChild(allChip);
  }

  for (const item of targetItems) {
    const chip = document.createElement('button');
    chip.type = 'button';
    const isSel = activeSet.has(item.id) && !activeSet.has('@all');
    chip.className = `recip-chip${isSel ? ' is-active' : ''}`;
    chip.textContent = item.chipText;
    chip.title = item.title;
    chip.addEventListener('click', () => {
      state.selectedRecipients = [item.id];
      renderRecipientChips(group);
      els.messageInput.focus();
    });
    els.recipientBar.appendChild(chip);
  }
}

// --- Quote & Pending Attachments Preview UI ---
function setQuoteMessage(sender, text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return;
  state.activeQuote = { sender, text: clean.slice(0, 180) };
  renderQuoteBar();
  els.messageInput.focus();
}

function clearQuoteMessage() {
  state.activeQuote = null;
  renderQuoteBar();
}

function renderQuoteBar() {
  if (!state.activeQuote) {
    els.quoteBar.hidden = true;
    els.quoteBarText.textContent = '';
    return;
  }
  els.quoteBarText.textContent = `引用 ${state.activeQuote.sender}：${state.activeQuote.text}`;
  els.quoteBar.hidden = false;
}

function renderAttachmentStrip() {
  els.attachmentStrip.replaceChildren();
  if (state.pendingAttachments.length === 0 && state.uploadingCount === 0) {
    els.attachmentStrip.hidden = true;
    updateSendButtonState();
    return;
  }
  els.attachmentStrip.hidden = false;

  for (const att of state.pendingAttachments) {
    const chip = document.createElement('div');
    chip.className = 'att-chip';

    if (att.kind === 'image' && att.url) {
      const img = document.createElement('img');
      img.className = 'att-thumb';
      img.src = att.url;
      img.alt = att.fileName;
      img.width = 40;
      img.height = 40;
      chip.appendChild(img);
    } else {
      const badge = document.createElement('div');
      badge.className = 'att-file-badge';
      badge.textContent = '📄';
      chip.appendChild(badge);
    }

    const nameSpan = document.createElement('span');
    nameSpan.className = 'att-name';
    nameSpan.textContent = att.fileName;
    chip.appendChild(nameSpan);

    const rmBtn = document.createElement('button');
    rmBtn.type = 'button';
    rmBtn.className = 'att-remove-btn';
    rmBtn.textContent = '×';
    rmBtn.title = '移除附件';
    rmBtn.addEventListener('click', () => {
      state.pendingAttachments = state.pendingAttachments.filter((x) => x.id !== att.id);
      renderAttachmentStrip();
    });
    chip.appendChild(rmBtn);

    els.attachmentStrip.appendChild(chip);
  }

  if (state.uploadingCount > 0) {
    const loadingChip = document.createElement('div');
    loadingChip.className = 'att-chip';
    const sp = document.createElement('span');
    sp.className = 'att-name';
    sp.textContent = `正在处理图片 (${state.uploadingCount})…`;
    loadingChip.appendChild(sp);
    els.attachmentStrip.appendChild(loadingChip);
  }

  updateSendButtonState();
}

// --- Render Rich Markdown (Offline KaTeX + Code Headers + Local Path Chips + Searchable Fold) ---
const INLINE_WIN_PATH_EXACT_RE = /^[A-Za-z]:\\[^\r\n"'<>|?*]+$/;
const PROSE_WIN_PATH_RE =
  /[A-Za-z]:\\[^\s"'<>|?*()[\]`，。；：！？、（）【】「」\\]+(?:[ \\][^\s"'<>|?*()[\]`，。；：！？、（）【】「」\\]+)*\\?/g;

function createLocalPathChip(winPath) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'local-path-chip';
  const isDoc = /\.[a-z0-9]{1,8}$/i.test(winPath);
  btn.dataset.pathIcon = isDoc ? '📄' : '📂';
  btn.textContent = winPath;
  btn.title = state.isLocalSession
    ? `点击在电脑端直接打开：${winPath}`
    : `点击复制路径：${winPath}`;
  btn.addEventListener('click', () => openOrCopyLocalPath(winPath));
  return btn;
}

const mermaidSourceByCard = new WeakMap();
let mermaidIdSeq = 0;

async function renderMermaidStage(stageEl, rawSource) {
  if (!stageEl || !rawSource.trim()) return;
  const [mermaid, DOMPurify] = await Promise.all([loadMermaid(), loadDOMPurify()]);
  if (!mermaid) {
    stageEl.textContent = '离线图表引擎未就绪，请点击右上角「查看源码」。';
    return;
  }
  try {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: getRenderedColorScheme() === 'dark' ? 'dark' : 'default',
    });
    const renderId = `achat-mmd-${Date.now()}-${++mermaidIdSeq}`;
    const { svg } = await mermaid.render(renderId, rawSource);
    const cleanSvg = DOMPurify.sanitize(String(svg || ''), {
      USE_PROFILES: { svg: true, svgFilters: true },
      ALLOW_DATA_ATTR: false,
    });
    const parsed = new DOMParser().parseFromString(cleanSvg, 'image/svg+xml');
    const svgNode = parsed.querySelector('svg');
    if (svgNode) {
      stageEl.replaceChildren(document.importNode(svgNode, true));
    } else {
      stageEl.textContent = '图表语法解析为空，请切换源码检查。';
    }
  } catch {
    stageEl.textContent = 'Mermaid 图表语法无法渲染，已保留原始代码供查看。';
  }
}

function rerenderVisibleMermaidDiagrams() {
  for (const card of document.querySelectorAll('.mermaid-card')) {
    const rawSource = mermaidSourceByCard.get(card);
    const stageEl = card.querySelector('.mermaid-stage');
    if (rawSource && stageEl && !stageEl.hidden) {
      renderMermaidStage(stageEl, rawSource);
    }
  }
}

function enhanceCodeAndLocalPaths(container) {
  for (const link of container.querySelectorAll('a[href]')) {
    const href = link.getAttribute('href') || '';
    if (/^https?:\/\//i.test(href)) {
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
    }
  }

  for (const pre of Array.from(container.querySelectorAll('pre'))) {
    if (pre.querySelector('.code-block-bar') || pre.classList.contains('mermaid-source')) continue;
    const codeEl = pre.querySelector('code');
    const langMatch = (codeEl?.className || '').match(/language-([a-zA-Z0-9_+-]+)/);
    const lang = (langMatch ? langMatch[1] : 'code').toLowerCase();

    if (lang === 'mermaid' && codeEl) {
      const rawMermaid = (codeEl.textContent || '').trim();
      if (rawMermaid) {
        const card = document.createElement('div');
        card.className = 'mermaid-card';
        mermaidSourceByCard.set(card, rawMermaid);

        const toolbar = document.createElement('div');
        toolbar.className = 'mermaid-toolbar';
        const tag = document.createElement('span');
        tag.className = 'mermaid-tag';
        tag.textContent = '◇ Mermaid 图表';

        const actWrap = document.createElement('div');
        actWrap.className = 'mermaid-actions';

        const toggleSrcBtn = document.createElement('button');
        toggleSrcBtn.type = 'button';
        toggleSrcBtn.className = 'mermaid-btn';
        toggleSrcBtn.textContent = '查看源码';

        const zoomBtn = document.createElement('button');
        zoomBtn.type = 'button';
        zoomBtn.className = 'mermaid-btn';
        zoomBtn.textContent = '放大预览';

        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'mermaid-btn';
        copyBtn.textContent = '复制源码';

        const stageEl = document.createElement('div');
        stageEl.className = 'mermaid-stage scroller';
        stageEl.textContent = '正在渲染图表…';

        pre.classList.add('mermaid-source');
        pre.hidden = true;

        toggleSrcBtn.addEventListener('click', () => {
          const showingSrc = !pre.hidden;
          pre.hidden = showingSrc;
          stageEl.hidden = !showingSrc;
          toggleSrcBtn.textContent = showingSrc ? '查看源码' : '查看图表';
        });

        zoomBtn.addEventListener('click', () => {
          const svgEl = stageEl.querySelector('svg');
          if (!svgEl) return;
          const serialized = new XMLSerializer().serializeToString(svgEl);
          const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(serialized)}`;
          openImageLightbox(dataUrl, 'Mermaid-Diagram.svg');
        });

        copyBtn.addEventListener('click', async () => {
          await copyTextSafe(rawMermaid);
          showToast('Mermaid 源码已复制');
        });

        actWrap.append(toggleSrcBtn, zoomBtn, copyBtn);
        toolbar.append(tag, actWrap);
        pre.replaceWith(card);
        card.append(toolbar, stageEl, pre);
        renderMermaidStage(stageEl, rawMermaid);
        continue;
      }
    }

    const bar = document.createElement('div');
    bar.className = 'code-block-bar';

    const langSpan = document.createElement('span');
    langSpan.className = 'code-lang-tag';
    langSpan.textContent = lang;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'code-copy-btn';
    btn.textContent = '复制代码';
    btn.addEventListener('click', async () => {
      const raw = (codeEl ? codeEl.innerText : pre.innerText) || '';
      await copyTextSafe(raw);
      btn.textContent = '已复制';
      setTimeout(() => {
        btn.textContent = '复制代码';
      }, 1500);
    });

    bar.append(langSpan, btn);
    pre.prepend(bar);
  }

  // Upgrade inline `C:\...` code spans to clickable path chips
  for (const code of Array.from(container.querySelectorAll(':not(pre) > code'))) {
    const txt = (code.textContent || '').trim();
    if (INLINE_WIN_PATH_EXACT_RE.test(txt)) {
      code.replaceWith(createLocalPathChip(txt));
    }
  }

  // Upgrade bare Windows paths in prose text nodes
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const p = node.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      if (p.closest('pre, code, a, button, .katex')) return NodeFilter.FILTER_REJECT;
      return /[A-Za-z]:\\/.test(node.nodeValue || '')
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_SKIP;
    },
  });
  const textNodes = [];
  let cur;
  while ((cur = walker.nextNode())) textNodes.push(cur);

  for (const tNode of textNodes) {
    const src = tNode.nodeValue || '';
    const looksLikeJsonLine = src.includes('{"');
    PROSE_WIN_PATH_RE.lastIndex = 0;
    let lastIdx = 0;
    let matched = false;
    const frag = document.createDocumentFragment();
    let m;
    while ((m = PROSE_WIN_PATH_RE.exec(src)) !== null) {
      if (looksLikeJsonLine && m.index > 0 && src[m.index - 1] === '"') {
        continue;
      }
      matched = true;
      let rawHit = m[0];
      const trailing = rawHit.match(/[.,;:!?)}\]]+$/)?.[0] || '';
      if (trailing) {
        rawHit = rawHit.slice(0, -trailing.length);
      }
      if (m.index > lastIdx) {
        frag.appendChild(document.createTextNode(src.slice(lastIdx, m.index)));
      }
      frag.appendChild(createLocalPathChip(rawHit));
      lastIdx = m.index + rawHit.length;
    }
    if (matched) {
      if (lastIdx < src.length) {
        frag.appendChild(document.createTextNode(src.slice(lastIdx)));
      }
      tNode.replaceWith(frag);
    }
  }
}

function applySmartFoldIfNeeded(bubble, rawText, msgId) {
  const totalLines = String(rawText || '').split('\n').length;
  if ((rawText.length <= 1150 && totalLines <= 28) || bubble.children.length < 6) {
    return;
  }
  const allChildren = Array.from(bubble.children);
  const visibleCount = 4;
  const toFold = allChildren.slice(visibleCount);
  if (toFold.length < 2) return;

  const foldId = `fold-${String(msgId || Math.random().toString(36).slice(2, 8)).replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const extraWrap = document.createElement('div');
  extraWrap.className = 'msg-fold-extra';
  extraWrap.id = foldId;
  extraWrap.setAttribute('hidden', 'until-found');

  const inner = document.createElement('div');
  inner.className = 'msg-fold-inner';
  for (const child of toFold) {
    inner.appendChild(child);
  }
  extraWrap.appendChild(inner);

  const collapsedLabel = `展开余下内容（全文 ${totalLines} 行 · 支持 Ctrl+F 搜索自动展开）`;
  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'msg-fold-btn';
  toggleBtn.setAttribute('aria-expanded', 'false');
  toggleBtn.setAttribute('aria-controls', foldId);
  toggleBtn.textContent = collapsedLabel;

  extraWrap.addEventListener('beforematch', () => {
    toggleBtn.setAttribute('aria-expanded', 'true');
    toggleBtn.textContent = '收起长文';
  });

  toggleBtn.addEventListener('click', () => {
    const isExpanded = toggleBtn.getAttribute('aria-expanded') === 'true';
    if (isExpanded) {
      extraWrap.setAttribute('hidden', 'until-found');
      toggleBtn.setAttribute('aria-expanded', 'false');
      toggleBtn.textContent = collapsedLabel;
    } else {
      extraWrap.removeAttribute('hidden');
      toggleBtn.setAttribute('aria-expanded', 'true');
      toggleBtn.textContent = '收起长文';
    }
  });

  bubble.append(extraWrap, toggleBtn);

  // Fallback for browsers without hidden="until-found" support (modern-web-guidance: search-hidden-content)
  if (!('onbeforematch' in HTMLElement.prototype)) {
    extraWrap.removeAttribute('hidden');
    toggleBtn.setAttribute('aria-expanded', 'true');
    toggleBtn.hidden = true;
  }
}

async function renderRichMarkdownInto(bubble, rawText, { allowFold = false, msgId = '' } = {}) {
  const src = String(rawText || '');
  const codeVault = [];
  const mathVault = [];

  // 1. Shield fenced code blocks & inline code spans before math tokenization
  let stage = src.replace(/(^|\n)(```|~~~)[^\n]*\n[\s\S]*?\n\2(?=\n|$)/g, (full, lead) => {
    const block = lead ? full.slice(lead.length) : full;
    const idx = codeVault.push(block) - 1;
    return `${lead}@@ACHAT_CODE_${idx}@@`;
  });
  stage = stage.replace(/`[^`\n]+`/g, (span) => {
    const idx = codeVault.push(span) - 1;
    return `@@ACHAT_CODE_${idx}@@`;
  });

  // 2. Tokenize display math ($$...$$ and \[...\]) and inline math ($...$ and \(...\))
  stage = stage.replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g, (_m, d1, d2) => {
    const tex = (d1 ?? d2 ?? '').trim();
    if (!tex) return _m;
    const idx = mathVault.push({ tex, displayMode: true }) - 1;
    return `\n\n@@ACHAT_MATH_${idx}@@\n\n`;
  });
  stage = stage.replace(
    /\\\(([^\n]+?)\\\)|(?<![\\$\w])\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/g,
    (_m, i1, i2) => {
      const tex = (i1 ?? i2 ?? '').trim();
      if (!tex) return _m;
      const idx = mathVault.push({ tex, displayMode: false }) - 1;
      return `@@ACHAT_MATH_${idx}@@`;
    }
  );

  // 3. Restore code blocks/spans, parse Markdown, and sanitize into DOM
  stage = stage.replace(/@@ACHAT_CODE_(\d+)@@/g, (_m, idStr) => codeVault[Number(idStr)] ?? _m);
  const renderedHtml = marked.parse(stage);
  await safeSetHTML(bubble, renderedHtml);

  // 4. Substitute math placeholders with sanitized offline KaTeX fragments
  if (mathVault.length > 0) {
    const [katex, DOMPurify] = await Promise.all([loadKatex(), loadDOMPurify()]);
    const mathRe = /@@ACHAT_MATH_(\d+)@@/g;
    const walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p || p.closest('pre, code')) return NodeFilter.FILTER_REJECT;
        return (node.nodeValue || '').includes('@@ACHAT_MATH_')
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP;
      },
    });
    const targets = [];
    let n;
    while ((n = walker.nextNode())) targets.push(n);

    for (const tNode of targets) {
      const val = tNode.nodeValue || '';
      mathRe.lastIndex = 0;
      let lastIdx = 0;
      const frag = document.createDocumentFragment();
      let m;
      while ((m = mathRe.exec(val)) !== null) {
        if (m.index > lastIdx) {
          frag.appendChild(document.createTextNode(val.slice(lastIdx, m.index)));
        }
        const entry = mathVault[Number(m[1])];
        if (entry && katex) {
          const rawKatex = katex.renderToString(entry.tex, {
            displayMode: entry.displayMode,
            throwOnError: false,
            strict: 'ignore',
            trust: false,
            output: 'htmlAndMathml',
          });
          const cleanKatex = DOMPurify.sanitize(rawKatex, {
            USE_PROFILES: { html: true, mathMl: true, svg: true },
            ALLOW_DATA_ATTR: false,
          });
          const parsedDoc = new DOMParser().parseFromString(cleanKatex, 'text/html');
          const wrap = document.createElement(entry.displayMode ? 'div' : 'span');
          wrap.className = entry.displayMode
            ? 'achat-math-block katex-copyable'
            : 'katex-copyable';
          wrap.title = '点击复制 LaTeX 公式源码';
          while (parsedDoc.body.firstChild) {
            wrap.appendChild(parsedDoc.body.firstChild);
          }
          const rawTexCopy = entry.tex;
          wrap.addEventListener('click', async (ev) => {
            if (state.multiSelectMode) return;
            ev.stopPropagation();
            await copyTextSafe(rawTexCopy);
            showToast('已复制 LaTeX 公式源码');
          });
          frag.appendChild(wrap);
        } else if (entry) {
          const codeFallback = document.createElement('code');
          codeFallback.textContent = entry.tex;
          frag.appendChild(codeFallback);
        }
        lastIdx = m.index + m[0].length;
      }
      if (lastIdx < val.length) {
        frag.appendChild(document.createTextNode(val.slice(lastIdx)));
      }
      const parentP = tNode.parentElement;
      if (
        parentP &&
        parentP.tagName === 'P' &&
        parentP.childNodes.length === 1 &&
        frag.childNodes.length === 1 &&
        frag.firstChild?.classList?.contains('achat-math-block')
      ) {
        parentP.replaceWith(frag.firstChild);
      } else {
        tNode.replaceWith(frag);
      }
    }
  }

  enhanceCodeAndLocalPaths(bubble);
  if (allowFold) {
    applySmartFoldIfNeeded(bubble, src, msgId);
  }
}

async function forwardBubbleToPeer(group, msg, peerActor) {
  if (!group || !peerActor) return;
  const promptText = `@${peerActor.id} 请复核并点评上面 ${msg.senderTitle} 的结论，确认准确部分并指出有无遗漏风险或补充建议。`;
  await sendMessagePayload({
    group,
    rawInputText: promptText,
    attachments: [],
    quote: {
      sender: msg.senderTitle,
      text: msg.text || '[图片/附件]',
    },
    explicitRecipients: [peerActor.id],
    forceCollabMode: 'free',
  });
}

// --- Multi-Select Message Mode (Forward / Batch Star / Export / Native Share) ---
function syncMultiSelectUI() {
  if (els.multiSelectBar) {
    els.multiSelectBar.hidden = !state.multiSelectMode;
  }
  if (els.multiSelectCount) {
    els.multiSelectCount.textContent = `已选 ${state.selectedMsgIds.size} 条`;
  }
  if (els.multiNativeShareBtn) {
    els.multiNativeShareBtn.hidden = !(
      window.AndroidBridge?.shareTextOut || typeof navigator.share === 'function'
    );
  }
  for (const row of els.messageStream.querySelectorAll('.msg-row[data-msg-id]')) {
    const id = row.dataset.msgId;
    const isSel = Boolean(id && state.selectedMsgIds.has(id));
    row.classList.toggle('is-selectable', state.multiSelectMode);
    row.classList.toggle('is-selected-msg', state.multiSelectMode && isSel);
    const box = row.querySelector('.msg-select-box');
    if (box) {
      box.hidden = !state.multiSelectMode;
      box.textContent = isSel ? '✓' : '';
    }
  }
}

function setMultiSelectMode(enabled, initialMsgId = null) {
  state.multiSelectMode = Boolean(enabled);
  if (!state.multiSelectMode) {
    state.selectedMsgIds.clear();
  } else if (initialMsgId) {
    state.selectedMsgIds.add(initialMsgId);
  }
  syncMultiSelectUI();
}

function toggleMessageSelection(msgId) {
  if (!msgId) return;
  if (state.selectedMsgIds.has(msgId)) {
    state.selectedMsgIds.delete(msgId);
  } else {
    state.selectedMsgIds.add(msgId);
  }
  triggerLightHaptic();
  syncMultiSelectUI();
}

function getSelectedMessageObjects() {
  const gid = state.selectedGroupId;
  if (!gid) return [];
  const all = state.messagesByGroup.get(gid) || [];
  return all.filter((m) => m.kind === 'chat' && state.selectedMsgIds.has(m.id));
}

function formatMessagesDigestMarkdown(msgs, groupTitle, headerTitle = '精选聊天记录') {
  const lines = [
    `# ${groupTitle} — ${headerTitle}`,
    '',
    `- 整理时间：${new Date().toLocaleString('zh-CN')}`,
    `- 选中条数：${msgs.length} 条`,
    '',
    '---',
    '',
  ];
  for (const m of msgs) {
    const who = m.isUser ? '我' : m.senderTitle || m.by || 'Agent';
    const tsStr = m.ts ? formatFullWeChatTimestamp(m.ts) : '';
    lines.push(`### ${who}${tsStr ? ` (${tsStr})` : ''}`);
    lines.push('');
    lines.push(m.text || '[图片/附件]');
    lines.push('');
  }
  return lines.join('\n');
}

async function batchStarSelectedMessages() {
  const group = getSelectedGroup();
  const picked = getSelectedMessageObjects();
  if (picked.length === 0) {
    showToast('请先点击气泡勾选至少 1 条消息');
    return;
  }
  const items = picked.map((m) => ({
    id: m.id,
    groupId: group?.id || '',
    groupTitle: group?.title || '',
    senderTitle: m.isUser ? '我' : m.senderTitle || 'Agent',
    text: String(m.text || '[图片/附件]'),
    ts: m.ts || new Date().toISOString(),
  }));
  try {
    const res = await apiFetch('/api/client-sync', {
      method: 'POST',
      body: JSON.stringify({ action: 'batchAddStars', items }),
    });
    if (res.clientSync) hydrateClientSync(res.clientSync);
    showToast(`已将 ${items.length} 条消息批量加入云端收藏`);
    setMultiSelectMode(false);
  } catch (err) {
    showToast(err.message);
  }
}

function exportSelectedMessagesMarkdown() {
  const group = getSelectedGroup();
  const picked = getSelectedMessageObjects();
  if (picked.length === 0) {
    showToast('请先点击气泡勾选至少 1 条消息');
    return;
  }
  const safeTitle = String(group?.title || 'AChat').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
  const md = formatMessagesDigestMarkdown(picked, group?.title || 'AChat', '精选摘录');
  downloadMarkdownText(`${safeTitle}-精选${picked.length}条.md`, md);
  setMultiSelectMode(false);
}

async function nativeShareSelectedMessages() {
  const group = getSelectedGroup();
  const picked = getSelectedMessageObjects();
  if (picked.length === 0) {
    showToast('请先点击气泡勾选至少 1 条消息');
    return;
  }
  const digest = picked
    .map((m) => `【${m.isUser ? '我' : m.senderTitle || 'Agent'}】\n${m.text || '[图片/附件]'}`)
    .join('\n\n---\n\n');
  await shareTextOutSafe(`${group?.title || 'AChat'} (${picked.length}条记录)`, digest);
  setMultiSelectMode(false);
}

function openForwardTargetModal() {
  const sourceGroup = getSelectedGroup();
  const picked = getSelectedMessageObjects();
  if (picked.length === 0) {
    showToast('请先点击气泡勾选至少 1 条消息');
    return;
  }
  els.forwardGroupList.replaceChildren();
  els.forwardNoteInput.value = '';
  for (const targetGroup of state.groups.filter((g) => !g.archived)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'forward-group-item';
    const nameSpan = document.createElement('strong');
    nameSpan.textContent = targetGroup.title;
    const subSpan = document.createElement('span');
    subSpan.className = 'session-time';
    subSpan.textContent =
      targetGroup.id === sourceGroup?.id ? '本群整理' : targetGroup.kind === 'helper' ? '备忘助手' : '跨群转发';
    btn.append(nameSpan, subSpan);
    btn.addEventListener('click', async () => {
      const note = els.forwardNoteInput.value.trim();
      const lines = [
        note ? `${note}\n` : '',
        `> 📨 **合并转发记录**（来自「${sourceGroup?.title || '群聊'}」，共 ${picked.length} 条）：`,
        ...picked.map((m) => {
          const who = m.isUser ? '我' : m.senderTitle || 'Agent';
          const snippet = String(m.text || '[图片/附件]').trim();
          return `\n**[${who}]**：\n${snippet}`;
        }),
      ].filter(Boolean);
      els.forwardTargetDialog.close();
      setMultiSelectMode(false);
      await selectGroup(targetGroup.id);
      await sendMessagePayload({
        group: targetGroup,
        rawInputText: lines.join('\n'),
        attachments: [],
        quote: null,
      });
      showToast(`已合并转发至「${targetGroup.title}」`);
    });
    els.forwardGroupList.appendChild(btn);
  }
  els.forwardTargetDialog.showModal();
}

async function createMessageNode(msg, group, prevTs) {
  const frag = document.createDocumentFragment();

  // Insert WeChat timestamp pill if > 5 minutes apart
  const curTime = msg.ts ? new Date(msg.ts).getTime() : 0;
  const prevTime = prevTs ? new Date(prevTs).getTime() : 0;
  if (curTime && (!prevTime || curTime - prevTime > 5 * 60 * 1000)) {
    const timeEl = document.createElement('div');
    timeEl.className = 'time-divider';
    timeEl.textContent = formatFullWeChatTimestamp(msg.ts);
    frag.appendChild(timeEl);
  }

  if (msg.kind === 'system') {
    const sys = document.createElement('div');
    sys.className = 'sys-divider';
    sys.textContent = msg.text;
    frag.appendChild(sys);
    return frag;
  }

  const isSelf = Boolean(msg.isUser);
  const isSelected = state.multiSelectMode && state.selectedMsgIds.has(msg.id);
  const row = document.createElement('div');
  row.className = `msg-row ${isSelf ? 'is-self' : 'is-other'}${msg._optimistic ? ' is-optimistic' : ''}${state.multiSelectMode ? ' is-selectable' : ''}${isSelected ? ' is-selected-msg' : ''}`;
  row.dataset.msgId = msg.id;

  const selectBox = document.createElement('span');
  selectBox.className = 'msg-select-box';
  selectBox.setAttribute('aria-hidden', 'true');
  selectBox.hidden = !state.multiSelectMode;
  selectBox.textContent = isSelected ? '✓' : '';

  row.addEventListener('click', (ev) => {
    if (!state.multiSelectMode || msg._optimistic) return;
    ev.preventDefault();
    ev.stopPropagation();
    toggleMessageSelection(msg.id);
  });

  const groupRouting = group && group.kind !== 'helper' ? getNormalizedGroupRouting(group) : null;
  const senderSlot = !isSelf && groupRouting ? resolveGroupSlot(groupRouting, msg.by) : null;
  const resolvedSenderTitle = senderSlot?.label || msg.senderTitle;
  const avInfo = avatarMetaForActor(msg.by, resolvedSenderTitle);
  const avatar = document.createElement('div');
  avatar.className = `msg-avatar ${avInfo.cls}`;
  avatar.textContent = avInfo.label;

  const col = document.createElement('div');
  col.className = 'msg-content-col';

  const metaLine = document.createElement('div');
  metaLine.className = 'msg-meta-line';

  const senderSpan = document.createElement('span');
  senderSpan.textContent = isSelf ? '我' : resolvedSenderTitle;
  metaLine.appendChild(senderSpan);

  if (msg._optimistic) {
    const sendingSpan = document.createElement('span');
    sendingSpan.className = 'sending-tag';
    sendingSpan.textContent = '发送中…';
    metaLine.appendChild(sendingSpan);
  }

  if (!isSelf && (senderSlot?.role === 'lead' || msg.sessionReceipt?.role === 'lead')) {
    const badge = document.createElement('span');
    badge.className = 'role-badge is-lead';
    badge.textContent = '主审';
    metaLine.appendChild(badge);
  }

  if (Array.isArray(msg.to) && msg.to.length > 0 && msg.to[0] !== 'file-helper') {
    const toSpan = document.createElement('span');
    toSpan.className = 'to-chip';
    const formattedTo = msg.to
      .map((r) => {
        if (r === 'user') return '我';
        const tSlot = groupRouting ? resolveGroupSlot(groupRouting, r) : null;
        return `@${tSlot?.label || r}`;
      })
      .join(', ');
    toSpan.textContent = `→ ${formattedTo}`;
    metaLine.appendChild(toSpan);
  }

  const isSessionStageInsight =
    typeof msg.insight === 'string' &&
    (msg.insight.startsWith('🎯') ||
      msg.insight.startsWith('🤝') ||
      msg.insight.startsWith('➕') ||
      msg.insight.startsWith('⏰') ||
      msg.insight.startsWith('💬'));

  if (!isSelf && msg.sessionReceipt?.sessionId) {
    const receiptBtn = document.createElement('button');
    receiptBtn.type = 'button';
    receiptBtn.className = 'session-receipt-chip';
    const rawTitle =
      msg.sessionReceipt.sessionTitle || msg.sessionReceipt.sessionId.slice(0, 8);
    const shortTitle = rawTitle.length > 22 ? `${rawTitle.slice(0, 22)}…` : rawTitle;
    const permTag =
      msg.sessionReceipt.permission === 'read-only'
        ? ' · 只读'
        : msg.sessionReceipt.permission === 'workspace-write'
          ? ' · 可写'
          : '';
    receiptBtn.textContent = `${shortTitle}${permTag}`;
    receiptBtn.title = `执行会话：${rawTitle}\n会话 ID：${msg.sessionReceipt.sessionId}${
      msg.sessionReceipt.cwd
        ? `\n项目目录：${msg.sessionReceipt.cwd}\n（点击打开或复制目录）`
        : '\n（点击复制会话 ID）'
    }`;
    receiptBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (msg.sessionReceipt.cwd) {
        openOrCopyLocalPath(msg.sessionReceipt.cwd);
      } else {
        copyTextSafe(msg.sessionReceipt.sessionId).then(() => showToast('会话 ID 已复制'));
      }
    });
    metaLine.appendChild(receiptBtn);
  } else if (isSessionStageInsight && !isSelf) {
    const stageChip = document.createElement('span');
    stageChip.className = 'session-receipt-chip';
    stageChip.textContent = msg.insight.length > 44 ? `${msg.insight.slice(0, 44)}…` : msg.insight;
    stageChip.title = msg.insight;
    metaLine.appendChild(stageChip);
  }

  const starBtn = document.createElement('button');
  starBtn.type = 'button';
  const starred = state.starredIds.has(msg.id);
  starBtn.className = `star-btn${starred ? ' is-starred' : ''}`;
  starBtn.title = '云端收藏此消息';
  starBtn.textContent = starred ? '★' : '☆';
  starBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    toggleStarMessage(msg, group);
  });
  metaLine.appendChild(starBtn);

  const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
  const hasBodyText = Boolean(String(msg.text || '').trim());
  const isImageOnly =
    !hasBodyText && attachments.length > 0 && attachments.every((a) => a.kind === 'image' && a.url);
  const isErrorBubble =
    !isSelf && (msg.ok === false || String(msg.text || '').trim().startsWith('⚠️'));

  const bubble = document.createElement('div');
  bubble.className = `msg-bubble bubble-md${isImageOnly ? ' is-media-only' : ''}${isErrorBubble ? ' is-error-bubble' : ''}`;

  if (hasBodyText) {
    await renderRichMarkdownInto(bubble, String(msg.text || ''), {
      allowFold: !isSelf,
      msgId: msg.id,
    });
  }

  if (!isSelf && Array.isArray(msg.thoughtTrace) && msg.thoughtTrace.length > 0) {
    const traceEl = buildThoughtTraceElement(msg.thoughtTrace, { isLive: false });
    if (traceEl) {
      bubble.prepend(traceEl);
    }
  }

  if (attachments.length > 0) {
    const attWrap = document.createElement('div');
    attWrap.className = 'msg-attachments';
    for (const att of attachments) {
      if (att.kind === 'image' && att.url) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'msg-img-btn';
        btn.title = '点击查看大图';
        const img = document.createElement('img');
        img.className = 'msg-inline-img';
        img.src = att.url;
        img.alt = att.name || '聊天截图';
        img.loading = 'lazy';
        img.width = 280;
        img.height = 180;
        btn.appendChild(img);
        btn.addEventListener('click', () => {
          if (state.multiSelectMode) return;
          openImageLightbox(att.url, att.name);
        });
        attWrap.appendChild(btn);
      } else {
        const card = document.createElement(att.filePath ? 'button' : 'div');
        if (att.filePath) {
          card.type = 'button';
          card.style.cursor = 'pointer';
          card.title = state.isLocalSession ? `点击打开：${att.filePath}` : `点击复制路径：${att.filePath}`;
          card.addEventListener('click', () => {
            if (state.multiSelectMode) return;
            openOrCopyLocalPath(att.filePath);
          });
        }
        card.className = 'msg-file-card';
        card.textContent = `📄 ${att.name || att.filePath}`;
        attWrap.appendChild(card);
      }
    }
    bubble.prepend(attWrap);
  }

  col.append(metaLine, bubble);

  if (!isSelf && msg.interactiveCard && group?.kind === 'group') {
    const cardNode = buildInteractiveCardElement(msg, group);
    if (cardNode) {
      col.appendChild(cardNode);
    }
  }

  // Bubble Quick Action Bar (Quote / Forward to Peer / Resend / Multi-Select / Copy / Share)
  if (!msg._optimistic) {
    const actBar = document.createElement('div');
    actBar.className = 'msg-actions-bar';

    const quoteBtn = document.createElement('button');
    quoteBtn.type = 'button';
    quoteBtn.className = 'msg-act-btn';
    quoteBtn.textContent = '引用';
    quoteBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      setQuoteMessage(
        isSelf ? '我' : msg.senderTitle,
        msg.text || (attachments[0]?.name ? `[图片: ${attachments[0].name}]` : '[消息]')
      );
    });
    actBar.appendChild(quoteBtn);

    if (isSelf && group && (hasBodyText || attachments.length > 0)) {
      const resendBtn = document.createElement('button');
      resendBtn.type = 'button';
      resendBtn.className = 'msg-act-btn';
      resendBtn.textContent = '重发';
      resendBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        sendMessagePayload({
          group,
          rawInputText: msg.text || '',
          attachments: attachments.map((a) => ({
            kind: a.kind,
            fileName: a.name,
            filePath: a.filePath,
            url: a.url,
          })),
          quote: null,
          explicitRecipients: Array.isArray(msg.to) && msg.to.length ? msg.to : null,
        });
      });
      actBar.appendChild(resendBtn);
    }

    if (!isSelf && group?.kind === 'group') {
      if (msg.by) {
        const retryActorBtn = document.createElement('button');
        retryActorBtn.type = 'button';
        retryActorBtn.className = 'msg-act-btn is-retry-single';
        const shortName = shortActorTag({ id: msg.by, title: msg.senderTitle });
        retryActorBtn.textContent = `↻ 仅重试 ${shortName}`;
        retryActorBtn.title = `单独重新唤醒 ${msg.senderTitle || msg.by} 重试本轮任务，不打扰同伴会话`;
        retryActorBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          retrySingleActorInUI(group, msg.by, {
            messageId: msg.id,
            senderTitle: msg.senderTitle || msg.by,
          });
        });
        actBar.appendChild(retryActorBtn);
      }

      const peerActor = (group.actors || []).find(
        (a) => a.enabled !== false && a.id !== msg.by
      );
      if (peerActor) {
        const fwdBtn = document.createElement('button');
        fwdBtn.type = 'button';
        fwdBtn.className = 'msg-act-btn';
        fwdBtn.textContent = `转 ${shortActorTag(peerActor)} 点评`;
        fwdBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          forwardBubbleToPeer(group, msg, peerActor);
        });
        actBar.appendChild(fwdBtn);
      }
    }

    const multiBtn = document.createElement('button');
    multiBtn.type = 'button';
    multiBtn.className = 'msg-act-btn';
    multiBtn.textContent = '多选';
    multiBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      setMultiSelectMode(true, msg.id);
    });
    actBar.appendChild(multiBtn);

    if (hasBodyText) {
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'msg-act-btn';
      copyBtn.textContent = '复制';
      copyBtn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        await copyTextSafe(msg.text);
        showToast('消息已复制');
      });
      actBar.appendChild(copyBtn);

      if (window.AndroidBridge?.shareTextOut) {
        const shareBtn = document.createElement('button');
        shareBtn.type = 'button';
        shareBtn.className = 'msg-act-btn';
        shareBtn.textContent = '分享';
        shareBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          shareTextOutSafe(`${isSelf ? '我' : msg.senderTitle} · ${group?.title || 'AChat'}`, msg.text);
        });
        actBar.appendChild(shareBtn);
      }
    }

    col.appendChild(actBar);
  }

  row.append(selectBox, avatar, col);
  frag.appendChild(row);
  return frag;
}

function buildThoughtTraceElement(thoughtTrace = [], { isLive = false } = {}) {
  const items = Array.isArray(thoughtTrace) ? thoughtTrace.filter((it) => it && it.text) : [];
  if (items.length === 0) return null;

  const thinkCount = items.filter((it) => it.kind !== 'tool').length;
  const toolCount = items.filter((it) => it.kind === 'tool').length;

  const details = document.createElement('details');
  details.className = `thought-trace-panel${isLive ? ' is-live' : ''}`;
  if (isLive) {
    details.open = true;
  }

  const summary = document.createElement('summary');
  summary.className = 'thought-trace-summary';
  const badgeParts = [];
  if (thinkCount > 0) badgeParts.push(`${thinkCount} 步思考`);
  if (toolCount > 0) badgeParts.push(`${toolCount} 次工具/命令`);
  const lastSnippet = String(items[items.length - 1]?.text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 44);
  summary.textContent = isLive
    ? `实时思考与执行轨迹（${badgeParts.join(' · ') || `${items.length} 步`}）`
    : `思考与执行过程（${badgeParts.join(' · ') || `${items.length} 步`}${lastSnippet ? ` · ${lastSnippet}…` : ''}）`;

  const list = document.createElement('div');
  list.className = 'thought-trace-list scroller';

  for (const it of items) {
    const row = document.createElement('div');
    const isTool = it.kind === 'tool';
    row.className = `thought-trace-item ${isTool ? 'is-tool' : 'is-thinking'}`;
    const icon = document.createElement('span');
    icon.className = 'thought-trace-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = isTool ? '›' : '·';
    const body = document.createElement('div');
    body.className = 'thought-trace-text';
    body.textContent = String(it.text || '').trim();
    row.append(icon, body);
    list.appendChild(row);
  }

  details.append(summary, list);
  return details;
}

const INITIAL_MSG_LIMIT = 36;
const MORE_MSG_LIMIT = 40;

function applyCardSettlementInClientState(groupId, { messageId, cardId, settled }) {
  if (!groupId || !settled) return;
  const list = state.messagesByGroup.get(groupId) || [];
  let targetMsg = null;
  for (const m of list) {
    if (
      (messageId && m.id === messageId) ||
      (cardId && m.interactiveCard && m.interactiveCard.id === cardId)
    ) {
      if (m.interactiveCard) {
        m.interactiveCard.settled = settled;
        targetMsg = m;
      }
      break;
    }
  }
  if (groupId === state.selectedGroupId) {
    state.renderedMessagesSig = computeMessagesRenderSig(groupId, list);
    if (targetMsg) {
      const row = els.messageStream.querySelector(`[data-msg-id="${CSS.escape(targetMsg.id)}"]`);
      const oldCard = row?.querySelector('.inline-agent-card');
      const group = state.groups.find((g) => g.id === groupId);
      if (oldCard && group) {
        const freshCard = buildInteractiveCardElement(targetMsg, group);
        if (freshCard) oldCard.replaceWith(freshCard);
      }
    }
  }
}

async function resolveInlineCardAction(group, msg, payload, triggerBtn = null) {
  if (!group || !msg?.interactiveCard) return;
  const card = msg.interactiveCard;
  if (card.settled) return;
  if (triggerBtn) triggerBtn.disabled = true;
  try {
    const res = await apiFetch(`/api/groups/${group.id}/card-action`, {
      method: 'POST',
      body: JSON.stringify({
        messageId: msg.id,
        cardId: card.id,
        ...payload,
      }),
    });
    if (res.settled) {
      applyCardSettlementInClientState(group.id, {
        messageId: msg.id,
        cardId: card.id,
        settled: res.settled,
      });
    }
    if (Array.isArray(res.groups)) {
      state.groups = res.groups;
      renderSessionColumn();
      renderActiveHeaderAndRecipients();
    }
    triggerLightHaptic();
    showToast(res.settled?.label || '操作卡片已执行');
  } catch (err) {
    if (triggerBtn) triggerBtn.disabled = false;
    showToast(err.message || '执行卡片操作失败');
  }
}

function buildInteractiveCardElement(msg, group) {
  const card = msg?.interactiveCard;
  if (!card || !card.kind) return null;
  const isSettled = Boolean(card.settled);

  const root = document.createElement('article');
  root.className = `inline-agent-card${card.kind === 'approval' ? ' is-approval-card' : ''}${isSettled ? ' is-settled' : ''}`;
  root.dataset.cardId = card.id || '';

  const head = document.createElement('div');
  head.className = 'inline-card-head';
  const titleEl = document.createElement('span');
  titleEl.className = 'inline-card-title';
  titleEl.textContent =
    card.kind === 'approval'
      ? `🔒 ${card.title || '需要写入文件授权'}`
      : `📋 ${card.title || '点击方案直接答复'}`;
  const badgeEl = document.createElement('span');
  badgeEl.className = 'inline-card-badge';
  badgeEl.textContent = isSettled
    ? '已处理'
    : card.kind === 'approval'
      ? '权限审批'
      : '点选即回';
  head.append(titleEl, badgeEl);
  root.appendChild(head);

  const detailText = String(card.detail || card.reason || '').trim();
  if (detailText) {
    const reasonEl = document.createElement('div');
    reasonEl.className = 'inline-card-reason';
    reasonEl.textContent = detailText;
    root.appendChild(reasonEl);
  }

  if (card.kind === 'choice' && Array.isArray(card.options)) {
    const optsWrap = document.createElement('div');
    optsWrap.className = 'inline-card-options';
    for (const opt of card.options) {
      const btn = document.createElement('button');
      btn.type = 'button';
      const isChosen = isSettled && card.settled?.decision === opt.key;
      btn.className = `inline-card-opt-btn${opt.recommended ? ' is-recommended' : ''}${isChosen ? ' is-chosen' : ''}`;
      btn.disabled = isSettled;

      const keyBadge = document.createElement('span');
      keyBadge.className = 'inline-opt-key';
      keyBadge.textContent = opt.key;

      const bodyWrap = document.createElement('span');
      bodyWrap.className = 'inline-opt-body';
      const labelRow = document.createElement('span');
      labelRow.className = 'inline-opt-label-row';
      labelRow.appendChild(document.createTextNode(opt.label));
      if (opt.recommended) {
        const rec = document.createElement('span');
        rec.className = 'inline-opt-rec-pill';
        rec.textContent = '推荐';
        labelRow.appendChild(rec);
      }
      bodyWrap.appendChild(labelRow);

      if (opt.summary) {
        const sumSpan = document.createElement('span');
        sumSpan.className = 'inline-opt-summary';
        sumSpan.textContent = opt.summary;
        bodyWrap.appendChild(sumSpan);
      }

      btn.append(keyBadge, bodyWrap);
      if (!isSettled) {
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          resolveInlineCardAction(group, msg, { optionKey: opt.key }, btn);
        });
      }
      optsWrap.appendChild(btn);
    }
    root.appendChild(optsWrap);
  } else if (card.kind === 'approval' && !isSettled) {
    const actRow = document.createElement('div');
    actRow.className = 'inline-approval-actions';

    const allowTurnBtn = document.createElement('button');
    allowTurnBtn.type = 'button';
    allowTurnBtn.className = 'mini-btn is-primary-tint';
    allowTurnBtn.textContent = '✓ 批准本轮可写并执行';
    allowTurnBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      resolveInlineCardAction(
        group,
        msg,
        { decision: 'approve', grantScope: 'turn' },
        allowTurnBtn
      );
    });

    const allowSessBtn = document.createElement('button');
    allowSessBtn.type = 'button';
    allowSessBtn.className = 'mini-btn';
    allowSessBtn.textContent = '🔓 本群常驻可写并执行';
    allowSessBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      resolveInlineCardAction(
        group,
        msg,
        { decision: 'approve', grantScope: 'session' },
        allowSessBtn
      );
    });

    const denyBtn = document.createElement('button');
    denyBtn.type = 'button';
    denyBtn.className = 'mini-btn is-danger-tint';
    denyBtn.textContent = '✕ 保持只读';
    denyBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      resolveInlineCardAction(group, msg, { decision: 'deny' }, denyBtn);
    });

    actRow.append(allowTurnBtn, allowSessBtn, denyBtn);
    root.appendChild(actRow);
  }

  if (isSettled && card.settled?.label) {
    const pill = document.createElement('div');
    pill.className = `inline-card-settled-pill${card.settled.decision === 'deny' ? ' is-denied' : ''}`;
    pill.textContent = `${card.settled.decision === 'deny' ? '🔒' : '✓'} ${card.settled.label}`;
    root.appendChild(pill);
  }

  return root;
}

async function retrySingleActorInUI(group, actorId, { messageId = '', senderTitle = '' } = {}) {
  if (!group || group.kind === 'helper' || !actorId) return;
  const lockKey = `${group.id}:${actorId}`;
  if (state.retryingActorKey === lockKey) return;
  state.retryingActorKey = lockKey;

  const curThinking = new Set(state.thinkingByGroup.get(group.id) || []);
  curThinking.add(actorId);
  state.thinkingByGroup.set(group.id, Array.from(curThinking));
  state.thinkingStartedAt.set(lockKey, Date.now());
  renderSessionColumn();
  renderActiveHeaderAndRecipients();

  try {
    await apiFetch(`/api/groups/${group.id}/retry-actor`, {
      method: 'POST',
      body: JSON.stringify({ actorId, messageId }),
    });
    triggerLightHaptic();
    showToast(`已单独重试 ${senderTitle || actorId}（同伴会话不重复执行）`);
  } catch (err) {
    showToast(err.message || '单独重试失败');
  } finally {
    state.retryingActorKey = '';
  }
}

function buildLoadMoreHistoryBanner(groupId) {
  const pageInfo = state.paginationByGroup.get(groupId);
  if (!pageInfo?.hasMore) return null;
  const wrap = document.createElement('div');
  wrap.className = 'load-more-history-wrap';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'load-more-history-btn';
  const remain = Math.max(1, Number(pageInfo.startIndex) || 0);
  btn.disabled = Boolean(pageInfo.loadingMore);
  btn.textContent = pageInfo.loadingMore
    ? '⏳ 正在加载更早记录…'
    : `↑ 加载更早聊天记录（还有 ${remain} 条）`;
  btn.addEventListener('click', () => loadOlderGroupMessages(groupId));
  wrap.appendChild(btn);
  return wrap;
}

async function loadOlderGroupMessages(groupId) {
  const pageInfo = state.paginationByGroup.get(groupId);
  if (!groupId || !pageInfo || !pageInfo.hasMore || pageInfo.loadingMore) return;
  const beforeIdx = Number(pageInfo.startIndex) || 0;
  if (beforeIdx <= 0) {
    pageInfo.hasMore = false;
    return;
  }

  pageInfo.loadingMore = true;
  const existingBtn = els.messageStream.querySelector('.load-more-history-btn');
  if (existingBtn) {
    existingBtn.disabled = true;
    existingBtn.textContent = '⏳ 正在加载更早记录…';
  }

  try {
    const res = await apiFetch(
      `/api/groups/${groupId}/messages?limit=${MORE_MSG_LIMIT}&beforeIndex=${beforeIdx}`
    );
    const olderMsgs = Array.isArray(res.messages) ? res.messages : [];
    const curList = state.messagesByGroup.get(groupId) || [];
    const curIds = new Set(curList.map((m) => m.id));
    const uniqueOlder = olderMsgs.filter((m) => !curIds.has(m.id));
    const nextList = [...uniqueOlder, ...curList];
    state.messagesByGroup.set(groupId, nextList);

    state.paginationByGroup.set(groupId, {
      startIndex: res.startIndex ?? Math.max(0, beforeIdx - uniqueOlder.length),
      totalCount: res.totalCount ?? pageInfo.totalCount,
      hasMore: Boolean(res.hasMore),
      loadingMore: false,
    });

    if (groupId === state.selectedGroupId) {
      const prevScrollHeight = els.messageStream.scrollHeight;
      const prevScrollTop = els.messageStream.scrollTop;
      const group = state.groups.find((g) => g.id === groupId);

      const frag = document.createDocumentFragment();
      const nextBanner = buildLoadMoreHistoryBanner(groupId);
      if (nextBanner) frag.appendChild(nextBanner);

      let prevTs = null;
      for (const msg of uniqueOlder) {
        const node = await createMessageNode(msg, group, prevTs);
        frag.appendChild(node);
        if (msg.ts) prevTs = msg.ts;
      }

      els.messageStream.querySelector('.load-more-history-wrap')?.remove();
      els.messageStream.prepend(frag);
      state.renderedMessagesSig = computeMessagesRenderSig(groupId, nextList);
      const deltaHeight = els.messageStream.scrollHeight - prevScrollHeight;
      els.messageStream.scrollTop = prevScrollTop + Math.max(0, deltaHeight);
    }
  } catch (err) {
    pageInfo.loadingMore = false;
    showToast(err.message || '加载历史记录失败');
  }
}

function upsertStreamingBubbleDom(groupId, frame) {
  if (groupId !== state.selectedGroupId || !frame?.streamId) return;
  const nearBottom =
    els.messageStream.scrollHeight - els.messageStream.scrollTop - els.messageStream.clientHeight < 150;

  let row = els.messageStream.querySelector(`[data-stream-id="${CSS.escape(frame.streamId)}"]`);
  if (!row) {
    row = document.createElement('div');
    row.className = 'msg-row is-other is-streaming';
    row.dataset.streamId = frame.streamId;
    row.dataset.streamBy = frame.by || '';

    const avInfo = avatarMetaForActor(frame.by, frame.senderTitle);
    const avatar = document.createElement('div');
    avatar.className = `msg-avatar ${avInfo.cls}`;
    avatar.textContent = avInfo.label;

    const col = document.createElement('div');
    col.className = 'msg-content-col';

    const metaLine = document.createElement('div');
    metaLine.className = 'msg-meta-line';
    const senderSpan = document.createElement('span');
    senderSpan.textContent = frame.senderTitle || frame.by || 'Agent';
    const liveTag = document.createElement('span');
    liveTag.className = 'sending-tag';
    liveTag.textContent = '实时输出中…';
    metaLine.append(senderSpan, liveTag);

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';

    const stepPill = document.createElement('div');
    stepPill.className = 'stream-step-pill';
    const dot = document.createElement('span');
    dot.className = 'stream-step-dot';
    const stepText = document.createElement('span');
    stepText.className = 'stream-step-label';
    stepPill.append(dot, stepText);

    const traceHost = document.createElement('div');
    traceHost.className = 'stream-trace-host';

    const body = document.createElement('div');
    body.className = 'stream-live-body';

    bubble.append(stepPill, traceHost, body);
    col.append(metaLine, bubble);
    row.append(avatar, col);
    els.messageStream.appendChild(row);
  }

  const stepLabelEl = row.querySelector('.stream-step-label');
  if (stepLabelEl) {
    stepLabelEl.textContent = frame.stepLabel || `${frame.senderTitle || 'Agent'} 正在思考处理…`;
  }

  const traceHostEl = row.querySelector('.stream-trace-host');
  if (traceHostEl) {
    const traceArr = Array.isArray(frame.thoughtTrace) ? frame.thoughtTrace : [];
    const traceSig = `${traceArr.length}:${traceArr[traceArr.length - 1]?.text?.length || 0}`;
    if (traceHostEl.dataset.traceSig !== traceSig) {
      traceHostEl.dataset.traceSig = traceSig;
      const existingDetails = traceHostEl.querySelector('details.thought-trace-panel');
      const wasOpen = existingDetails ? existingDetails.open : true;
      traceHostEl.replaceChildren();
      const traceEl = buildThoughtTraceElement(traceArr, { isLive: true });
      if (traceEl) {
        traceEl.open = wasOpen;
        traceHostEl.appendChild(traceEl);
        const listEl = traceEl.querySelector('.thought-trace-list');
        if (listEl) {
          listEl.scrollTop = listEl.scrollHeight;
        }
      }
    }
  }

  const bodyEl = row.querySelector('.stream-live-body');
  if (bodyEl) {
    const cleanText = String(frame.text || '').trim();
    bodyEl.replaceChildren();
    if (cleanText) {
      bodyEl.classList.remove('is-placeholder');
      bodyEl.appendChild(document.createTextNode(cleanText));
    } else {
      bodyEl.classList.add('is-placeholder');
      bodyEl.appendChild(document.createTextNode('已接通目标会话，正在等待首字或工具输出…'));
    }
    const cursor = document.createElement('span');
    cursor.className = 'stream-cursor';
    cursor.setAttribute('aria-hidden', 'true');
    bodyEl.appendChild(cursor);
  }

  if (nearBottom) {
    els.messageStream.scrollTop = els.messageStream.scrollHeight;
  }
}

function removeStreamingBubbleDom(streamId) {
  if (!streamId) return;
  els.messageStream.querySelector(`[data-stream-id="${CSS.escape(streamId)}"]`)?.remove();
}

function clearStreamingBubblesForActor(groupId, actorId) {
  if (!groupId || !actorId) return;
  const map = state.activeStreamsByGroup.get(groupId);
  if (map) {
    for (const [sid, f] of map.entries()) {
      if (f.by === actorId) map.delete(sid);
    }
  }
  if (groupId === state.selectedGroupId) {
    for (const el of els.messageStream.querySelectorAll(`[data-stream-by="${CSS.escape(actorId)}"]`)) {
      el.remove();
    }
  }
}

function computeMessagesRenderSig(groupId, list = []) {
  const pageInfo = state.paginationByGroup.get(groupId);
  const first = list[0];
  const last = list[list.length - 1];
  const cardSig = list
    .filter((m) => m?.interactiveCard)
    .map((m) => `${m.id}:${m.interactiveCard.settled?.decision || '0'}`)
    .join(',');
  return [
    groupId || '',
    list.length,
    first?.id || '',
    last?.id || '',
    last ? String(last.text || '').length : 0,
    last?.ok === false ? '0' : '1',
    last?._optimistic ? 'opt' : 'real',
    pageInfo?.hasMore ? '1' : '0',
    pageInfo?.startIndex ?? 0,
    cardSig,
  ].join('|');
}

async function renderMessages(groupId, { scrollToBottom = true } = {}) {
  const group = state.groups.find((g) => g.id === groupId);
  const list = state.messagesByGroup.get(groupId) || [];
  els.messageStream.replaceChildren();

  const eagerTailCount = 12;
  const offscreenCutoff = Math.max(0, list.length - eagerTailCount);
  const frag = document.createDocumentFragment();

  const topHistoryBanner = buildLoadMoreHistoryBanner(groupId);
  if (topHistoryBanner) {
    frag.appendChild(topHistoryBanner);
  }

  let prevTs = null;
  for (let i = 0; i < list.length; i += 1) {
    const msg = list[i];
    const node = await createMessageNode(msg, group, prevTs);
    if (i < offscreenCutoff && node?.children) {
      for (const child of node.children) {
        child.classList.add('is-offscreen-history');
      }
    }
    frag.appendChild(node);
    if (msg.ts) prevTs = msg.ts;
  }

  els.messageStream.appendChild(frag);
  state.renderedGroupId = groupId;
  state.renderedMessagesSig = computeMessagesRenderSig(groupId, list);

  const activeStreams = state.activeStreamsByGroup.get(groupId);
  if (activeStreams && activeStreams.size > 0) {
    for (const frame of activeStreams.values()) {
      if (!frame.done) upsertStreamingBubbleDom(groupId, frame);
    }
  }

  if (scrollToBottom) {
    els.messageStream.scrollTop = els.messageStream.scrollHeight;
  }
}

async function appendSingleMessageToStream(msg) {
  const group = getSelectedGroup();
  if (!group) return;
  const list = state.messagesByGroup.get(group.id) || [];
  const prevMsg = list.length >= 2 ? list[list.length - 2] : null;
  const nearBottom =
    els.messageStream.scrollHeight - els.messageStream.scrollTop - els.messageStream.clientHeight < 150;
  const node = await createMessageNode(msg, group, prevMsg?.ts || null);
  els.messageStream.appendChild(node);
  if (state.renderedGroupId === group.id) {
    state.renderedMessagesSig = computeMessagesRenderSig(group.id, list);
  }
  if (nearBottom || msg.isUser) {
    els.messageStream.scrollTop = els.messageStream.scrollHeight;
    state.belowFoldCount = 0;
    updateBelowFoldPill();
  } else if (msg.kind === 'chat') {
    state.belowFoldCount += 1;
    updateBelowFoldPill();
  }
}

// --- Group Settings, Git Diff Viewer & Lifecycle Helpers ---
function renderDiffIntoViewer(diffText) {
  els.gitDiffViewer.replaceChildren();
  const raw = String(diffText || '');
  if (!raw.trim()) {
    const emptyLine = document.createElement('div');
    emptyLine.className = 'diff-line is-meta';
    emptyLine.textContent = '当前没有可展示的文本改动（工作区干净或仅含二进制文件）。';
    els.gitDiffViewer.appendChild(emptyLine);
    return;
  }
  for (const line of raw.split('\n')) {
    const div = document.createElement('div');
    let cls = 'diff-line';
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git')) {
      cls += ' is-meta';
    } else if (line.startsWith('@@')) {
      cls += ' is-hunk';
    } else if (line.startsWith('+')) {
      cls += ' is-add';
    } else if (line.startsWith('-')) {
      cls += ' is-del';
    }
    div.className = cls;
    div.textContent = line || ' ';
    els.gitDiffViewer.appendChild(div);
  }
}

async function openGitDiffModal(group, relPath = '') {
  if (!group || group.kind === 'helper') return;
  els.gitDiffTitle.textContent = relPath ? '文件变更预览 (Git Diff)' : '工作区整体变更预览';
  els.gitDiffSubtitle.textContent = relPath || group.scopePath || '';
  if (els.discardCurrentFileBtn) {
    els.discardCurrentFileBtn.hidden = !relPath;
    els.discardCurrentFileBtn.classList.remove('is-confirming');
    els.discardCurrentFileBtn.textContent = '↺ 撤销此文件';
  }
  els.gitDiffViewer.replaceChildren();
  const loading = document.createElement('div');
  loading.className = 'diff-line is-meta';
  loading.textContent = '正在读取 Git Diff…';
  els.gitDiffViewer.appendChild(loading);
  if (!els.gitDiffDialog.open) {
    els.gitDiffDialog.showModal();
  }
  try {
    const qs = relPath ? `?file=${encodeURIComponent(relPath)}` : '';
    const summary = await apiFetch(`/api/groups/${group.id}/git-summary${qs}`);
    state.activeDiffContext = {
      groupId: group.id,
      relPath,
      branch: summary.branch || '',
      diffText: summary.diff || '',
    };
    const changed = Array.isArray(summary.changedFiles)
      ? summary.changedFiles
      : Array.isArray(summary.files)
        ? summary.files
        : [];
    if (els.modalGitCommitBar) {
      els.modalGitCommitBar.hidden = !summary.isRepo || changed.length === 0;
    }
    els.gitDiffSubtitle.textContent = `${summary.branch ? `[${summary.branch}] ` : ''}${relPath || '全部未提交变更'}`;
    renderDiffIntoViewer(summary.diff || '');
  } catch (err) {
    renderDiffIntoViewer(`读取失败：${err.message}`);
  }
}

async function loadDrawerGitSummary(group, { force = false } = {}) {
  if (!group || group.kind === 'helper' || !group.scopePath) return;
  if (!force && state.activeGitSummary?.groupId === group.id) {
    renderDrawerGitFiles(group, state.activeGitSummary);
    renderDrawerWorktrees(group, state.worktreesByGroup.get(group.id) || []);
    return;
  }
  els.drawerGitBranch.textContent = '读取中…';
  els.drawerGitFileList.replaceChildren();
  try {
    const summary = await apiFetch(`/api/groups/${group.id}/git-summary`);
    state.activeGitSummary = { ...summary, groupId: group.id };
    if (getSelectedGroup()?.id === group.id) {
      renderDrawerGitFiles(group, state.activeGitSummary);
    }
    if (summary?.isRepo) {
      loadDrawerWorktrees(group);
    } else if (els.drawerWorktreeWrap) {
      els.drawerWorktreeWrap.hidden = true;
    }
  } catch (err) {
    els.drawerGitBranch.textContent = '异常';
    els.drawerGitFileList.textContent = err.message;
  }
}

async function executeGroupGitCommit(group, inputEl, btnEl) {
  if (!group || group.kind === 'helper' || !inputEl) return;
  const msg = inputEl.value.trim();
  if (!msg) {
    showToast('请先输入 Commit 说明');
    inputEl.focus();
    return;
  }
  if (btnEl) btnEl.disabled = true;
  try {
    const res = await apiFetch(`/api/groups/${group.id}/git-action`, {
      method: 'POST',
      body: JSON.stringify({ action: 'stage-commit', message: msg }),
    });
    inputEl.value = '';
    if (els.drawerGitCommitInput) els.drawerGitCommitInput.value = '';
    if (els.modalGitCommitInput) els.modalGitCommitInput.value = '';
    if (res.gitSummary) {
      state.activeGitSummary = { ...res.gitSummary, groupId: group.id };
      renderDrawerGitFiles(group, state.activeGitSummary);
    } else {
      await loadDrawerGitSummary(group, { force: true });
    }
    if (els.gitDiffDialog?.open) {
      els.gitDiffDialog.close();
    }
    triggerLightHaptic();
    showToast(`✓ 已提交 [${res.commitHash || 'HEAD'}] ${res.subject || msg}`);
  } catch (err) {
    showToast(err.message || 'Git 提交失败');
  } finally {
    if (btnEl) btnEl.disabled = false;
  }
}

async function confirmAndDiscardFile(group, relFile, btnEl, { closeModalOnDone = false } = {}) {
  if (!group || !relFile || !btnEl) return;
  const confirmKey = `${group.id}:${relFile}`;
  if (state.pendingDiscardConfirmKey !== confirmKey) {
    state.pendingDiscardConfirmKey = confirmKey;
    btnEl.classList.add('is-confirming');
    const origText = btnEl.dataset.origText || btnEl.textContent;
    btnEl.dataset.origText = origText;
    btnEl.textContent = '确认撤销?';
    clearTimeout(state.pendingDiscardTimer);
    state.pendingDiscardTimer = setTimeout(() => {
      if (state.pendingDiscardConfirmKey === confirmKey) {
        state.pendingDiscardConfirmKey = '';
      }
      btnEl.classList.remove('is-confirming');
      btnEl.textContent = btnEl.dataset.origText || '↺';
    }, 3200);
    return;
  }

  state.pendingDiscardConfirmKey = '';
  clearTimeout(state.pendingDiscardTimer);
  btnEl.disabled = true;
  try {
    const res = await apiFetch(`/api/groups/${group.id}/git-action`, {
      method: 'POST',
      body: JSON.stringify({ action: 'discard-file', file: relFile }),
    });
    if (res.gitSummary) {
      state.activeGitSummary = { ...res.gitSummary, groupId: group.id };
      renderDrawerGitFiles(group, state.activeGitSummary);
    } else {
      await loadDrawerGitSummary(group, { force: true });
    }
    if (closeModalOnDone && els.gitDiffDialog?.open) {
      els.gitDiffDialog.close();
    }
    triggerLightHaptic();
    showToast(`已撤销文件改动：${relFile}`);
  } catch (err) {
    btnEl.disabled = false;
    btnEl.classList.remove('is-confirming');
    btnEl.textContent = btnEl.dataset.origText || '↺';
    showToast(err.message || '撤销文件改动失败');
  }
}

async function loadDrawerWorktrees(group) {
  if (!group || group.kind === 'helper' || !group.scopePath) return;
  try {
    const res = await apiFetch(`/api/groups/${group.id}/git-action`, {
      method: 'POST',
      body: JSON.stringify({ action: 'worktree-list' }),
    });
    const list = Array.isArray(res.worktrees) ? res.worktrees : [];
    state.worktreesByGroup.set(group.id, list);
    if (getSelectedGroup()?.id === group.id) {
      renderDrawerWorktrees(group, list);
    }
  } catch {
    if (els.drawerWorktreeWrap) els.drawerWorktreeWrap.hidden = true;
  }
}

function bindWorktreeToAgent(group, agentKey, wt) {
  if (!group || !wt?.path) return;
  const label = agentKey === 'codex' ? 'Codex' : 'Antigravity';
  applyGroupSessionRoutingPatch(group, {
    [agentKey]: {
      mode: 'new',
      sessionId: '',
      sessionTitle: `${wt.branch || wt.name}`,
      cwd: wt.path,
    },
  });
  triggerLightHaptic();
  showToast(`🌿 已将 ${label} 绑定至隔离沙盒 ${wt.name}（互不踩踏主目录）`);
}

function renderDrawerWorktrees(group, worktrees = []) {
  if (!els.drawerWorktreeWrap || !els.drawerWorktreeList) return;
  const extraWorktrees = worktrees.filter((w) => !w.isMain);
  if (extraWorktrees.length === 0) {
    els.drawerWorktreeWrap.hidden = true;
    els.drawerWorktreeList.replaceChildren();
    return;
  }
  els.drawerWorktreeWrap.hidden = false;
  els.drawerWorktreeList.replaceChildren();

  for (const wt of extraWorktrees) {
    const card = document.createElement('article');
    card.className = 'worktree-item-card';

    const top = document.createElement('div');
    top.className = 'worktree-card-top';
    const brSpan = document.createElement('span');
    brSpan.className = 'worktree-branch-name';
    brSpan.textContent = `⎇ ${wt.branch || wt.name}`;
    const headPill = document.createElement('span');
    headPill.className = 'git-branch-pill';
    headPill.textContent = wt.head || 'HEAD';
    top.append(brSpan, headPill);

    const pathEl = document.createElement('code');
    pathEl.className = 'worktree-path-code';
    pathEl.textContent = wt.path;

    const actions = document.createElement('div');
    actions.className = 'scope-actions';

    const bindCxBtn = document.createElement('button');
    bindCxBtn.type = 'button';
    bindCxBtn.className = 'mini-btn is-primary-tint';
    bindCxBtn.textContent = '→ 绑 Cx';
    bindCxBtn.title = '让 Codex 在此隔离 Worktree 新建会话执行';
    bindCxBtn.addEventListener('click', () => bindWorktreeToAgent(group, 'codex', wt));

    const bindAgBtn = document.createElement('button');
    bindAgBtn.type = 'button';
    bindAgBtn.className = 'mini-btn is-primary-tint';
    bindAgBtn.textContent = '→ 绑 Ag';
    bindAgBtn.title = '让 Antigravity 在此隔离 Worktree 新建会话执行';
    bindAgBtn.addEventListener('click', () => bindWorktreeToAgent(group, 'antigravity', wt));

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'mini-btn';
    openBtn.textContent = state.isLocalSession ? '打开' : '复制';
    openBtn.addEventListener('click', () => openOrCopyLocalPath(wt.path));

    actions.append(bindCxBtn, bindAgBtn, openBtn);

    if (wt.isManaged) {
      const rmBtn = document.createElement('button');
      rmBtn.type = 'button';
      rmBtn.className = 'mini-btn is-danger-tint';
      rmBtn.textContent = '移除';
      rmBtn.addEventListener('click', async () => {
        rmBtn.disabled = true;
        try {
          await apiFetch(`/api/groups/${group.id}/git-action`, {
            method: 'POST',
            body: JSON.stringify({ action: 'worktree-remove', worktreePath: wt.path }),
          });
          showToast(`已移除隔离 Worktree：${wt.name}`);
          await loadDrawerWorktrees(group);
        } catch (err) {
          rmBtn.disabled = false;
          showToast(err.message || '移除 Worktree 失败');
        }
      });
      actions.appendChild(rmBtn);
    }

    card.append(top, pathEl, actions);
    els.drawerWorktreeList.appendChild(card);
  }
}

async function createGroupWorktree(group, btnEl) {
  if (!group || group.kind === 'helper' || !group.scopePath) return;
  if (btnEl) btnEl.disabled = true;
  try {
    const slug = `task-${new Date().toTimeString().slice(0, 5).replace(':', '')}`;
    const res = await apiFetch(`/api/groups/${group.id}/git-action`, {
      method: 'POST',
      body: JSON.stringify({ action: 'worktree-create', name: slug }),
    });
    triggerLightHaptic();
    showToast(`🌿 已创建隔离沙盒 ${res.name}（可点「→ 绑 Cx / Ag」直接派单）`);
    await loadDrawerWorktrees(group);
  } catch (err) {
    showToast(err.message || '创建隔离 Worktree 失败');
  } finally {
    if (btnEl) btnEl.disabled = false;
  }
}

function renderDrawerGitFiles(group, summary) {
  els.drawerGitFileList.replaceChildren();
  if (!summary?.isRepo) {
    els.drawerGitBranch.textContent = '非 Git 仓库';
    els.openFullDiffBtn.disabled = true;
    if (els.drawerWorktreeCreateBtn) els.drawerWorktreeCreateBtn.hidden = true;
    if (els.drawerGitCommitBar) els.drawerGitCommitBar.hidden = true;
    const note = document.createElement('div');
    note.className = 'session-time';
    note.textContent = '绑定目录尚未初始化 Git 仓库。';
    els.drawerGitFileList.appendChild(note);
    return;
  }
  els.drawerGitBranch.textContent = `⎇ ${summary.branch || 'HEAD'}`;
  if (els.drawerWorktreeCreateBtn) els.drawerWorktreeCreateBtn.hidden = false;
  const files = Array.isArray(summary.changedFiles)
    ? summary.changedFiles
    : Array.isArray(summary.files)
      ? summary.files
      : [];
  els.openFullDiffBtn.disabled = files.length === 0;
  if (els.drawerGitCommitBar) {
    els.drawerGitCommitBar.hidden = files.length === 0;
  }
  if (files.length === 0) {
    const clean = document.createElement('div');
    clean.className = 'session-time';
    clean.textContent = '✓ 工作区干净，暂无未提交改动';
    els.drawerGitFileList.appendChild(clean);
    return;
  }
  for (const f of files) {
    const wrap = document.createElement('div');
    wrap.className = 'git-file-row-wrap';

    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'git-file-row';
    row.title = `点击预览 Diff：${f.path}`;

    const badge = document.createElement('span');
    const st = String(f.status || 'M').toUpperCase();
    const badgeCls =
      st.includes('A') || st === '??'
        ? 'is-add'
        : st.includes('D')
          ? 'is-del'
          : 'is-mod';
    badge.className = `git-stat-badge ${badgeCls}`;
    badge.textContent = st === '??' ? 'U' : st.slice(0, 1);

    const pathSpan = document.createElement('span');
    pathSpan.className = 'git-file-path';
    pathSpan.textContent = f.path;

    row.append(badge, pathSpan);
    row.addEventListener('click', () => openGitDiffModal(group, f.path));

    const discardBtn = document.createElement('button');
    discardBtn.type = 'button';
    discardBtn.className = 'git-discard-mini-btn';
    discardBtn.textContent = '↺';
    discardBtn.title = `撤销文件改动：${f.path}（连点两次确认）`;
    discardBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      confirmAndDiscardFile(group, f.path, discardBtn);
    });

    wrap.append(row, discardBtn);
    els.drawerGitFileList.appendChild(wrap);
  }
}

const DEFAULT_AGENT_MODEL_PRESETS = {
  codex: [
    { id: 'gpt-6-astra', label: 'GPT-6-Astra · 旗舰深度推理' },
    { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol · 最新主力编码' },
    { id: 'gpt-6.1-terra', label: 'GPT-6.1-Terra · Codex 专项模型' },
    { id: 'gpt-6-sol', label: 'GPT-6-Sol · 均衡稳健' },
    { id: 'gpt-6-luna', label: 'GPT-6-Luna · 极速轻量' },
    { id: 'gpt-reserve', label: 'GPT-Reserve · 高速 Agent 编码' },
  ],
  antigravity: [
    { id: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High) · 旗舰深度' },
    { id: 'gemini-4-argon-medium', label: 'Gemini 4 Argon (Medium) · 均衡主力' },
    { id: 'gemini-4-argon-low', label: 'Gemini 4 Argon (Low) · 快速响应' },
    { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High) · 高速推理' },
    { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium) · 轻量均衡' },
    { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low) · 极速低延迟' },
    { id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High) · 深度架构' },
    { id: 'claude-opus-5-5-medium', label: 'Claude Opus 5.5 (Medium) · 均衡推理' },
    { id: 'claude-sonnet-5-5-high', label: 'Claude Sonnet 5.5 (High) · 主力编码' },
    { id: 'claude-sonnet-5-5-medium', label: 'Claude Sonnet 5.5 (Medium) · 快速编码' },
    { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium) · 开源大模型' },
  ],
  claude: [
    { id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High) · 旗舰推理' },
    { id: 'claude-sonnet-5-5-high', label: 'Claude Sonnet 5.5 (High) · 主力编码' },
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  ],
  opencode: [
    { id: 'openai/gpt-6-astra', label: 'OpenAI GPT-6-Astra' },
    { id: 'openai/gpt-6.1-sol', label: 'OpenAI GPT-6.1-Sol' },
    { id: 'google/gemini-4-argon-high', label: 'Gemini 4 Argon (High)' },
    { id: 'anthropic/claude-opus-5-5', label: 'Claude Opus 5.5' },
  ],
  ollama: [
    { id: 'qwen3-coder:30b', label: 'Qwen3 Coder 30B · 本地编码' },
    { id: 'gpt-oss:120b', label: 'GPT-OSS 120B · 本地开源' },
    { id: 'deepseek-r1:32b', label: 'DeepSeek R1 32B · 本地推理' },
  ],
};

function resolveAgentModelPresets(actorId) {
  const providerEntry = (state.providerEcosystem?.providers || []).find((p) => p.id === actorId);
  const fromServer = Array.isArray(providerEntry?.modelPresets) && providerEntry.modelPresets.length
    ? providerEntry.modelPresets
    : Array.isArray(providerEntry?.models) && providerEntry.models.length
      ? providerEntry.models.map((m) => ({ id: m, label: m }))
      : [];
  const defaults = DEFAULT_AGENT_MODEL_PRESETS[actorId] || [];
  const merged = [];
  const seen = new Set();
  for (const item of [...fromServer, ...defaults]) {
    const id = String(item?.id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    merged.push({ id, label: String(item?.label || id).trim() });
  }
  return merged;
}

function renderDrawerAgentProfiles(group, { force = false } = {}) {
  if (!els.drawerAgentProfilesSection || !els.drawerAgentProfilesList) return;
  if (!group || group.kind === 'helper') {
    els.drawerAgentProfilesSection.hidden = true;
    return;
  }
  els.drawerAgentProfilesSection.hidden = false;
  if (
    !force &&
    els.drawerAgentProfilesList.dataset.groupId === group.id &&
    els.drawerAgentProfilesList.childElementCount > 0 &&
    els.drawerAgentProfilesList.contains(document.activeElement)
  ) {
    return;
  }
  els.drawerAgentProfilesList.dataset.groupId = group.id;
  els.drawerAgentProfilesList.replaceChildren();

  const profiles = group.agentProfiles && typeof group.agentProfiles === 'object' ? group.agentProfiles : {};
  const baseActors = (group.actors || []).length
    ? group.actors
    : [
        { id: 'codex', title: 'Codex', defaultTitle: 'Codex' },
        { id: 'antigravity', title: 'Antigravity', defaultTitle: 'Antigravity' },
      ];
  const seenIds = new Set(baseActors.map((x) => x.id));
  const extraInstalled = (state.providerEcosystem?.providers || [])
    .filter((p) => p.installed && !seenIds.has(p.id))
    .map((p) => ({ id: p.id, title: p.title || p.id, defaultTitle: p.title || p.id }));
  const actorDefs = [...baseActors, ...extraInstalled];

  for (const a of actorDefs) {
    const curProf = profiles[a.id] || {};
    const baseName = a.defaultTitle || a.title || a.id;
    const card = document.createElement('article');
    card.className = 'agent-profile-card';

    const top = document.createElement('div');
    top.className = 'profile-card-top';
    const titleEl = document.createElement('span');
    titleEl.className = 'profile-card-title';
    titleEl.textContent = `${curProf.displayName || baseName} (@${a.id})`;
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'mini-btn is-primary-tint';
    saveBtn.textContent = '保存档案';
    top.append(titleEl, saveBtn);

    const grid = document.createElement('div');
    grid.className = 'profile-fields-grid';

    const row1 = document.createElement('div');
    row1.className = 'profile-fields-row';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'profile-input';
    nameInput.maxLength = 40;
    nameInput.placeholder = `岗位昵称（默认 ${baseName}）`;
    nameInput.value = curProf.displayName || '';

    const presets = resolveAgentModelPresets(a.id);
    const datalistId = presets.length > 0 ? `agentModelPresetsList-${a.id}` : 'agentModelPresetsList';
    const exampleModel = presets[0]?.id || '';

    const modelInput = document.createElement('input');
    modelInput.type = 'text';
    modelInput.className = 'profile-input';
    modelInput.maxLength = 64;
    modelInput.setAttribute('list', datalistId);
    modelInput.placeholder = exampleModel
      ? `指定模型（如 ${exampleModel}，留空默认）`
      : '指定模型（留空沿用默认）';
    modelInput.value = curProf.model || '';

    if (presets.length > 0) {
      const dl = document.createElement('datalist');
      dl.id = datalistId;
      for (const item of presets) {
        const opt = document.createElement('option');
        opt.value = item.id;
        opt.label = item.label;
        dl.appendChild(opt);
      }
      card.appendChild(dl);
    }

    row1.append(nameInput, modelInput);

    const personaInput = document.createElement('input');
    personaInput.type = 'text';
    personaInput.className = 'profile-input';
    personaInput.maxLength = 360;
    personaInput.placeholder = '岗位职责人设（如：负责严查边界缺陷，给出精简修复补丁）';
    personaInput.value = curProf.persona || '';

    grid.append(row1, personaInput);

    saveBtn.addEventListener('click', async () => {
      const nextProfiles = {
        ...profiles,
        [a.id]: {
          displayName: nameInput.value.trim(),
          model: modelInput.value.trim(),
          persona: personaInput.value.trim(),
        },
      };
      await updateGroupCollabPrefs(group, { agentProfiles: nextProfiles });
      triggerLightHaptic();
      showToast(`已保存 ${nameInput.value.trim() || a.title} 的模型与岗位人设`);
    });

    card.append(top, grid);
    els.drawerAgentProfilesList.appendChild(card);
  }
}

async function saveCurrentGroupSettings() {
  const group = getSelectedGroup();
  if (!group || group.kind === 'helper') return;
  const nextTitle = els.drawerEditTitleInput.value.trim();
  const nextTopic = els.drawerEditTopicInput.value.trim();
  const nextSandbox = els.drawerCodexSandboxSelect.value;
  if (!nextTitle) {
    showToast('群聊名称不能为空');
    return;
  }
  els.saveGroupSettingsBtn.disabled = true;
  els.saveGroupSettingsBtn.textContent = '保存中…';
  try {
    const payload = { title: nextTitle, topic: nextTopic };
    if (!els.drawerSandboxField.hidden) {
      payload.codexSandbox = nextSandbox;
    }
    const res = await apiFetch(`/api/groups/${group.id}/settings`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (Array.isArray(res.groups)) state.groups = res.groups;
    renderSessionColumn();
    renderActiveHeaderAndRecipients();
    showToast('群信息与权限设置已更新');
  } catch (err) {
    showToast(err.message);
  } finally {
    els.saveGroupSettingsBtn.disabled = false;
    els.saveGroupSettingsBtn.textContent = '保存群设置';
  }
}

async function toggleArchiveCurrentGroup() {
  const group = getSelectedGroup();
  if (!group || group.kind === 'helper') return;
  const action = group.archived ? 'restore' : 'archive';
  try {
    const res = await apiFetch(`/api/groups/${group.id}/lifecycle`, {
      method: 'POST',
      body: JSON.stringify({ action }),
    });
    if (Array.isArray(res.groups)) state.groups = res.groups;
    els.groupDrawer.hidden = true;
    els.toggleDrawerBtn.setAttribute('aria-expanded', 'false');
    if (action === 'archive') {
      const nextActive = state.groups.find((g) => !g.archived && g.id !== group.id);
      if (nextActive) await selectGroup(nextActive.id);
      showToast(`已归档「${group.title}」（可在会话列表底部随时展开恢复）`);
    } else {
      renderSessionColumn();
      renderActiveHeaderAndRecipients();
      showToast(`已恢复群聊「${group.title}」`);
    }
  } catch (err) {
    showToast(err.message);
  }
}

async function deleteCurrentGroupConfirmed() {
  const group = getSelectedGroup();
  if (!group || group.kind === 'helper') return;
  els.confirmDeleteGroupBtn.disabled = true;
  els.confirmDeleteGroupBtn.textContent = '正在移除…';
  try {
    const res = await apiFetch(`/api/groups/${group.id}/lifecycle`, {
      method: 'POST',
      body: JSON.stringify({ action: 'delete', confirmId: group.id }),
    });
    state.messagesByGroup.delete(group.id);
    if (Array.isArray(res.groups)) state.groups = res.groups;
    els.deleteGroupDialog.close();
    els.groupDrawer.hidden = true;
    els.toggleDrawerBtn.setAttribute('aria-expanded', 'false');
    const nextGroup = state.groups.find((g) => !g.archived) || state.groups[0] || null;
    if (nextGroup) {
      await selectGroup(nextGroup.id);
    } else {
      state.selectedGroupId = null;
      renderSessionColumn();
      renderActiveHeaderAndRecipients();
    }
    showToast(`已移除群聊「${group.title}」（本地源码目录完好保留）`);
  } catch (err) {
    showToast(err.message);
  } finally {
    els.confirmDeleteGroupBtn.disabled = false;
    els.confirmDeleteGroupBtn.textContent = '确认移除群聊';
  }
}

// --- Render Right Drawer ("...") ---
function renderGroupDrawer(group, { force = false } = {}) {
  if (!group) return;
  const drawerKey = JSON.stringify({
    id: group.id,
    kind: group.kind,
    title: group.title,
    topic: group.topic,
    scopePath: group.scopePath,
    speedGear: group.speedGear,
    codexSandbox: group.codexSandbox,
    archived: group.archived,
    switchingGear: state.switchingGear,
    agentProfiles: group.agentProfiles || null,
    actors: (group.actors || []).map((a) => ({
      id: a.id,
      title: a.title,
      role: a.role,
      running: a.running,
      workingState: a.workingState,
      readOnly: a.readOnly,
      speedGear: a.speedGear,
      pid: a.pid,
    })),
  });
  if (!force && drawerKey === state.lastDrawerRenderKey && els.drawerMemberGrid.childElementCount > 0) {
    return;
  }
  state.lastDrawerRenderKey = drawerKey;
  els.drawerGroupName.textContent = group.title;
  els.drawerGroupTopic.textContent = group.topic || '未设置群说明';
  els.drawerScopePath.textContent = group.scopePath || '未绑定目录';
  els.openScopeBtn.hidden = !state.isLocalSession || !group.scopePath;

  els.drawerMemberGrid.replaceChildren();
  const members = [
    { id: 'user', title: '我' },
    ...(group.actors || []).map((a) => ({ id: a.id, title: a.title })),
  ];
  for (const m of members) {
    const cell = document.createElement('div');
    cell.className = 'member-cell';
    const av = avatarMetaForActor(m.id, m.title);
    const avEl = document.createElement('div');
    avEl.className = `msg-avatar ${av.cls}`;
    avEl.textContent = av.label;
    const nameEl = document.createElement('span');
    nameEl.className = 'member-name';
    nameEl.textContent = m.title;
    cell.append(avEl, nameEl);
    els.drawerMemberGrid.appendChild(cell);
  }

  if (group.kind === 'helper') {
    els.drawerHelperInfoSection.hidden = false;
    els.drawerGroupEditSection.hidden = true;
    els.drawerSpeedSection.hidden = true;
    els.drawerGitSection.hidden = true;
    if (els.drawerAgentProfilesSection) els.drawerAgentProfilesSection.hidden = true;
    els.drawerActorsSection.hidden = true;
    els.drawerLifecycleSection.hidden = true;
    return;
  }

  els.drawerHelperInfoSection.hidden = true;
  els.drawerGroupEditSection.hidden = false;
  if (document.activeElement !== els.drawerEditTitleInput) {
    els.drawerEditTitleInput.value = group.title || '';
  }
  if (document.activeElement !== els.drawerEditTopicInput) {
    els.drawerEditTopicInput.value = group.topic || '';
  }
  const hasCodex = (group.actors || []).some((a) => a.id === 'codex');
  els.drawerSandboxField.hidden = !hasCodex;
  if (hasCodex) {
    els.drawerCodexSandboxSelect.value =
      group.codexSandbox === 'workspace-write' ? 'workspace-write' : 'read-only';
  }

  els.drawerSpeedSection.hidden = false;
  els.drawerFastGearBtn.classList.toggle('is-active', group.speedGear === 'fast');
  els.drawerDeepGearBtn.classList.toggle('is-active', group.speedGear !== 'fast');
  els.drawerFastGearBtn.disabled = state.switchingGear;
  els.drawerDeepGearBtn.disabled = state.switchingGear;

  els.drawerGitSection.hidden = !group.scopePath;
  if (group.scopePath) {
    loadDrawerGitSummary(group);
  }

  renderDrawerAgentProfiles(group);

  els.drawerLifecycleSection.hidden = false;
  els.archiveGroupBtn.textContent = group.archived ? '恢复此群聊' : '归档隐藏本群';
  if (els.deleteGroupDesc) {
    els.deleteGroupDesc.textContent = `确认移除群聊「${group.title}」的会话账本？绑定的本地项目目录（${group.scopePath || '无'}）绝不会被删除或修改。`;
  }

  els.drawerActorsSection.hidden = false;
  els.drawerActorCards.replaceChildren();

  for (const a of group.actors || []) {
    const card = document.createElement('div');
    card.className = 'actor-card';
    const stateLabel = !a.running
      ? '已停止'
      : a.workingState === 'thinking'
        ? '思考中…'
        : '在线待命';

    const topRow = document.createElement('div');
    topRow.className = 'actor-card-top';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'actor-card-name';
    nameSpan.textContent = `${a.title} (@${a.id})`;
    const tagSpan = document.createElement('span');
    tagSpan.className = `actor-state-tag${a.running ? ' is-on' : ''}`;
    tagSpan.textContent = stateLabel;
    topRow.append(nameSpan, tagSpan);

    const metaDiv = document.createElement('div');
    metaDiv.className = 'actor-card-meta';
    metaDiv.textContent = `角色：${a.role === 'foreman' ? '工头' : '成员'} · ${a.readOnly ? '只读保护' : '可写终端'} · ${a.speedGear === 'fast' ? '⚡极速档' : '🧠深度档'}${a.pid ? ` · PID ${a.pid}` : ''}`;

    const btnRow = document.createElement('div');
    btnRow.className = 'actor-card-btns';
    card.append(topRow, metaDiv, btnRow);
    const actions = a.running
      ? [
          { act: 'restart', label: '重启' },
          { act: 'stop', label: '停止' },
        ]
      : [{ act: 'start', label: '启动' }];

    for (const item of actions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'mini-btn';
      b.textContent = item.label;
      b.addEventListener('click', async () => {
        b.disabled = true;
        b.textContent = '执行中…';
        try {
          const res = await apiFetch(`/api/groups/${group.id}/actors/${a.id}/${item.act}`, {
            method: 'POST',
          });
          state.groups = res.groups || state.groups;
          renderSessionColumn();
          renderActiveHeaderAndRecipients();
          showToast(`${a.title} 已${item.label}`);
        } catch (err) {
          showToast(err.message);
        } finally {
          b.disabled = false;
        }
      });
      btnRow.appendChild(b);
    }
    els.drawerActorCards.appendChild(card);
  }
}

// --- Group Selection & Navigation ---
async function reconcileGroupMessages(groupId, { scrollToBottom = false } = {}) {
  if (!groupId) return;
  try {
    const res = await apiFetch(`/api/groups/${groupId}/messages?limit=${INITIAL_MSG_LIMIT}`);
    const serverTail = Array.isArray(res.messages) ? res.messages : [];
    const current = state.messagesByGroup.get(groupId) || [];
    const optimisticOnly = current.filter((m) => m._optimistic);

    // Keep any already-loaded older messages while updating/appending the latest server tail
    const tailIdSet = new Set(serverTail.map((m) => m.id));
    const preservedPrefix = current.filter((m) => !m._optimistic && !tailIdSet.has(m.id));
    const merged = [...preservedPrefix, ...serverTail, ...optimisticOnly];

    const prevPage = state.paginationByGroup.get(groupId);
    if (!prevPage) {
      state.paginationByGroup.set(groupId, {
        startIndex: res.startIndex ?? 0,
        totalCount: res.totalCount ?? serverTail.length,
        hasMore: Boolean(res.hasMore),
        loadingMore: false,
      });
    } else if (preservedPrefix.length === 0) {
      prevPage.startIndex = res.startIndex ?? prevPage.startIndex;
      prevPage.totalCount = res.totalCount ?? prevPage.totalCount;
      prevPage.hasMore = Boolean(res.hasMore);
    }

    state.messagesByGroup.set(groupId, merged);
    if (groupId !== state.selectedGroupId) return;

    const nextSig = computeMessagesRenderSig(groupId, merged);
    if (state.renderedGroupId === groupId && nextSig === state.renderedMessagesSig) {
      return;
    }

    // Fast path: if already rendered and only 1..4 new tail messages arrived without prefix churn
    const addedCount = merged.length - current.length;
    const isPureTailAppend =
      state.renderedGroupId === groupId &&
      optimisticOnly.length === 0 &&
      addedCount > 0 &&
      addedCount <= 4 &&
      current.every((m, idx) => merged[idx]?.id === m.id);

    if (isPureTailAppend) {
      const group = state.groups.find((g) => g.id === groupId);
      for (let i = current.length; i < merged.length; i += 1) {
        const prevTs = i > 0 ? merged[i - 1]?.ts || null : null;
        const node = await createMessageNode(merged[i], group, prevTs);
        els.messageStream.appendChild(node);
      }
      state.renderedMessagesSig = nextSig;
      if (scrollToBottom) {
        els.messageStream.scrollTop = els.messageStream.scrollHeight;
      }
      return;
    }

    await renderMessages(groupId, { scrollToBottom });
  } catch {
    // ignore transient offline error
  }
}

async function selectGroup(groupId, { jumpToMsgId = null } = {}) {
  if (state.selectedGroupId && state.selectedGroupId !== groupId) {
    saveGroupDraft(state.selectedGroupId, els.messageInput.value, { immediate: true });
    if (state.multiSelectMode) setMultiSelectMode(false);
  }
  state.selectedGroupId = groupId;
  state.unreadByGroup.set(groupId, 0);
  state.belowFoldCount = 0;
  updateBelowFoldPill();
  state.selectedRecipients = ['@all'];
  clearQuoteMessage();
  closeMentionMenu();
  els.messageInput.value = state.draftsByGroup[groupId] || '';
  syncComposerTextareaHeight();
  updateSendButtonState();
  els.appRoot.dataset.mobileView = 'chat';
  syncDesktopUnreadState();

  renderSessionColumn();
  renderActiveHeaderAndRecipients();

  const shouldScrollBottom = !jumpToMsgId;
  if (!state.messagesByGroup.has(groupId) || jumpToMsgId) {
    const limit = jumpToMsgId ? 180 : INITIAL_MSG_LIMIT;
    const res = await apiFetch(`/api/groups/${groupId}/messages?limit=${limit}`);
    const fetched = Array.isArray(res.messages) ? res.messages : [];
    state.messagesByGroup.set(groupId, fetched);
    state.paginationByGroup.set(groupId, {
      startIndex: res.startIndex ?? 0,
      totalCount: res.totalCount ?? fetched.length,
      hasMore: Boolean(res.hasMore),
      loadingMore: false,
    });
    await renderMessages(groupId, { scrollToBottom: shouldScrollBottom });
    migrateLegacyLocalStarsIfNeeded();
  } else {
    const cachedList = state.messagesByGroup.get(groupId) || [];
    const cachedSig = computeMessagesRenderSig(groupId, cachedList);
    if (state.renderedGroupId !== groupId || state.renderedMessagesSig !== cachedSig) {
      await renderMessages(groupId, { scrollToBottom: shouldScrollBottom });
    } else if (shouldScrollBottom) {
      els.messageStream.scrollTop = els.messageStream.scrollHeight;
    }
    reconcileGroupMessages(groupId, { scrollToBottom: shouldScrollBottom });
  }

  if (jumpToMsgId) {
    jumpToMessageBubble(jumpToMsgId);
  }
}

function setNavTab(tab) {
  state.navTab = tab;
  for (const b of document.querySelectorAll('[data-nav]')) {
    b.classList.toggle('is-active', b.dataset.nav === tab);
  }
  renderSessionColumn();
}

// --- Unified Composer Autocomplete: @Agent Mentions, /Slash Commands & #Scope Files ---
const BUILTIN_SLASH_COMMANDS = [
  {
    cmd: '/review',
    label: '代码缺陷与回归审查',
    prompt: '请对当前改动做一次严谨的缺陷优先（defect-first）代码审查，列出潜在回归风险、边界遗漏与修复建议：',
  },
  {
    cmd: '/diff',
    label: '检查 Git 工作区未提交变更',
    prompt: '请查看当前绑定目录的 Git 未提交变更（git status / git diff），总结核心改动并指出有无安全或逻辑隐患。',
  },
  {
    cmd: '/handoff',
    label: '生成阶段进展与交接摘要',
    prompt: '请用精炼结构整理当前任务的：1) 已完成并验证项 2) 关键技术决策 3) 剩余待办与下一步入口。',
  },
  {
    cmd: '/plan',
    label: '对比 2–3 个技术方案与推荐',
    prompt: '先不要直接改代码。请针对以下需求给出 2–3 个可行方案、核心取舍对比及你的推荐路线：\n',
  },
  {
    cmd: '/quiz',
    label: '出一道闭卷变式自测题',
    prompt: '请基于我们刚才讨论的核心机制，出一道简短的闭卷预测/排错变式题考考我（先不要直接给答案）。',
  },
];

function getAllSlashTemplates() {
  const custom = (state.customTemplates || []).map((t) => ({
    cmd: t.cmd,
    label: t.label || t.cmd,
    prompt: t.prompt,
    isCustom: true,
    id: t.id,
  }));
  return [...custom, ...BUILTIN_SLASH_COMMANDS];
}

function renderCustomTemplatesModal() {
  if (!els.customTplList) return;
  els.customTplList.replaceChildren();
  if (!state.customTemplates.length) {
    const empty = document.createElement('div');
    empty.className = 'session-time';
    empty.textContent = '暂无个人自定义模板（上方内置 /review、/diff、/handoff、/plan、/quiz 默认可用）。';
    els.customTplList.appendChild(empty);
    return;
  }
  for (const tpl of state.customTemplates) {
    const row = document.createElement('div');
    row.className = 'custom-tpl-row';
    const meta = document.createElement('div');
    meta.className = 'custom-tpl-meta';
    const codeEl = document.createElement('code');
    codeEl.textContent = `${tpl.cmd} · ${tpl.label}`;
    const bodySpan = document.createElement('span');
    bodySpan.textContent = tpl.prompt;
    meta.append(codeEl, bodySpan);

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'mini-btn is-danger-tint';
    delBtn.textContent = '删除';
    delBtn.addEventListener('click', async () => {
      try {
        const res = await apiFetch('/api/client-sync', {
          method: 'POST',
          body: JSON.stringify({ action: 'deleteTemplate', id: tpl.id }),
        });
        if (res.clientSync) hydrateClientSync(res.clientSync);
        showToast(`已删除模板 ${tpl.cmd}`);
      } catch (err) {
        showToast(err.message);
      }
    });
    row.append(meta, delBtn);
    els.customTplList.appendChild(row);
  }
}

function openMentionMenu(filter = '') {
  const group = getSelectedGroup();
  if (!group || group.kind === 'helper') {
    closeMentionMenu();
    return;
  }
  if (!state.providerEcosystem && !state.loadingProviders) {
    loadProviderEcosystem();
  }
  const routing = getNormalizedGroupRouting(group);
  const activeSlots = getActiveGroupSlots(routing);
  const slotIds = new Set(activeSlots.map((s) => s.slotId));
  const actors = group.actors || [];
  const actorIds = new Set(actors.map((a) => a.id));
  const extraInstalledProviders = (state.providerEcosystem?.providers || []).filter(
    (p) => p.installed && !actorIds.has(p.id) && !slotIds.has(p.id)
  );
  const baseCandidates =
    activeSlots.length > 0
      ? activeSlots.map((s) => ({
          kind: 'mention',
          token: `@${s.slotId}`,
          id: s.slotId,
          label: `${s.label} (@${s.slotId})`,
          role:
            s.role === 'lead'
              ? '主审验收'
              : s.provider === 'codex'
                ? 'Codex 会话'
                : 'Antigravity 会话',
        }))
      : actors.map((a) => ({
          kind: 'mention',
          token: `@${a.id}`,
          id: a.id,
          label: `${a.title} (@${a.id})`,
          role: a.role === 'foreman' ? '工头' : '成员',
        }));
  const candidates = [
    ...baseCandidates,
    ...extraInstalledProviders.map((p) => ({
      kind: 'mention',
      token: `@${p.id}`,
      id: p.id,
      label: `${p.title} (@${p.id})`,
      role: '本机扩展 CLI',
    })),
    ...(baseCandidates.length > 1
      ? [
          {
            kind: 'mention',
            token: '@all',
            id: '@all',
            label: activeSlots.length > 0 ? '全部会话 (@all)' : '所有人 (@all)',
            role: '全员广播',
          },
        ]
      : []),
  ].filter(
    (c) => !filter || c.id.toLowerCase().includes(filter) || c.label.toLowerCase().includes(filter)
  );

  if (candidates.length === 0) {
    closeMentionMenu();
    return;
  }
  state.autocompleteKind = 'mention';
  state.mentionCandidates = candidates;
  state.mentionIndex = 0;
  state.mentionActive = true;
  renderMentionOptions();
  els.mentionMenu.hidden = false;
}

function openSlashMenu(filter = '') {
  const q = String(filter || '').toLowerCase();
  const templates = getAllSlashTemplates()
    .filter(
      (t) =>
        !q ||
        t.cmd.toLowerCase().includes(q) ||
        t.label.toLowerCase().includes(q)
    )
    .map((t) => ({
      kind: 'slash',
      cmd: t.cmd,
      prompt: t.prompt,
      label: `${t.cmd}  ${t.label}`,
      role: t.isCustom ? '个人模板' : '快捷指令',
    }));

  templates.push({
    kind: 'open-tpl-modal',
    label: '＋ 新增 / 管理个人快捷模板…',
    role: '多端同步',
  });

  state.autocompleteKind = 'slash';
  state.mentionCandidates = templates;
  state.mentionIndex = 0;
  state.mentionActive = true;
  renderMentionOptions();
  els.mentionMenu.hidden = false;
}

let scopeFileTimer = null;
let scopeFileSeq = 0;
function openScopeFileMenu(filter = '') {
  const group = getSelectedGroup();
  if (!group || group.kind === 'helper' || !group.scopePath) {
    closeMentionMenu();
    return;
  }
  clearTimeout(scopeFileTimer);
  const mySeq = ++scopeFileSeq;
  scopeFileTimer = setTimeout(async () => {
    try {
      const res = await apiFetch(
        `/api/groups/${group.id}/scope-files?q=${encodeURIComponent(filter)}&limit=18`
      );
      if (mySeq !== scopeFileSeq) return;
      const files = Array.isArray(res.files) ? res.files : [];
      if (files.length === 0) {
        closeMentionMenu();
        return;
      }
      state.autocompleteKind = 'file';
      state.mentionCandidates = files.map((relPath) => ({
        kind: 'file',
        relPath,
        label: `📄 ${relPath}`,
        role: '引用文件',
      }));
      state.mentionIndex = 0;
      state.mentionActive = true;
      renderMentionOptions();
      els.mentionMenu.hidden = false;
    } catch {
      if (mySeq === scopeFileSeq) closeMentionMenu();
    }
  }, 90);
}

function closeMentionMenu() {
  if (!state.mentionActive && els.mentionMenu.hidden) return;
  state.mentionActive = false;
  state.autocompleteKind = null;
  els.mentionMenu.hidden = true;
}

function renderMentionOptions() {
  els.mentionMenu.replaceChildren();
  state.mentionCandidates.forEach((c, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `mention-option${idx === state.mentionIndex ? ' is-active' : ''}`;
    const labelSpan = document.createElement('span');
    labelSpan.textContent = c.label;
    const roleSpan = document.createElement('span');
    roleSpan.className = 'mention-role';
    roleSpan.textContent = c.role;
    btn.append(labelSpan, roleSpan);
    btn.addEventListener('click', () => applyMentionChoice(c));
    els.mentionMenu.appendChild(btn);
  });
}

function applyMentionChoice(choice) {
  if (!choice) return;
  if (choice.kind === 'open-tpl-modal') {
    closeMentionMenu();
    renderCustomTemplatesModal();
    els.slashTemplateDialog.showModal();
    return;
  }

  const ta = els.messageInput;
  const pos = ta.selectionStart || ta.value.length;
  const before = ta.value.slice(0, pos);
  const after = ta.value.slice(pos);

  if (choice.kind === 'slash') {
    const replacedBefore = /(?:^|\s)\/[a-zA-Z0-9_-]*$/.test(before)
      ? before.replace(/\/[a-zA-Z0-9_-]*$/, choice.prompt)
      : `${before}${before && !before.endsWith('\n') ? '\n' : ''}${choice.prompt}`;
    ta.value = replacedBefore + after;
  } else if (choice.kind === 'file') {
    const token = `\`${choice.relPath}\` `;
    const replacedBefore = /(?:^|\s)#[^\s#]*$/.test(before)
      ? before.replace(/#[^\s#]*$/, token)
      : `${before}${before && !before.endsWith(' ') ? ' ' : ''}${token}`;
    ta.value = replacedBefore + after;
  } else {
    const replacedBefore = /@[a-zA-Z0-9_-]*$/.test(before)
      ? before.replace(/@[a-zA-Z0-9_-]*$/, `${choice.token} `)
      : `${before}${before && !before.endsWith(' ') ? ' ' : ''}${choice.token} `;
    ta.value = replacedBefore + after;
    state.selectedRecipients = [choice.id];
    const group = getSelectedGroup();
    if (group && (group.collabMode || 'free') === 'free') renderRecipientChips(group);
  }

  if (state.selectedGroupId) {
    saveGroupDraft(state.selectedGroupId, ta.value);
  }
  closeMentionMenu();
  ta.focus();
  updateSendButtonState();
}

// --- Send Message, Elastic Composer & Next-Turn Queue ---
const supportsFieldSizing =
  typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('field-sizing', 'content');

function syncComposerTextareaHeight() {
  if (supportsFieldSizing || !els.messageInput) return;
  els.messageInput.style.height = 'auto';
  const nextH = Math.min(196, Math.max(54, els.messageInput.scrollHeight));
  els.messageInput.style.height = `${nextH}px`;
}

function renderQueuedTurnBar(group = getSelectedGroup()) {
  if (!els.queuedTurnBar || !els.queuedTurnText) return;
  if (!group || group.kind === 'helper') {
    els.queuedTurnBar.hidden = true;
    return;
  }
  const queue = state.queuedByGroup.get(group.id) || [];
  if (queue.length === 0) {
    els.queuedTurnBar.hidden = true;
    els.queuedTurnText.textContent = '';
    return;
  }
  const mergedPreview = queue
    .map((it) => String(it.rawInputText || '[图片/附件]').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ； ');
  const shortPreview = mergedPreview.length > 56 ? `${mergedPreview.slice(0, 56)}…` : mergedPreview;
  els.queuedTurnText.textContent =
    queue.length > 1
      ? `➕ 已追加 ${queue.length} 条补充（当前步完成后自动合并同会话跟进）：「${shortPreview}」`
      : `➕ 已追加补充（当前步完成后自动在同会话跟进）：「${shortPreview}」`;
  els.queuedTurnBar.hidden = false;
}

function coalesceQueuedSupplementItems(queue = []) {
  if (!Array.isArray(queue) || queue.length === 0) return null;
  if (queue.length === 1) {
    return {
      ...queue[0],
      followUp: true,
    };
  }
  const textBlocks = [];
  const mergedAttachments = [];
  let mergedQuote = null;
  let explicitRecipients = null;
  queue.forEach((item, idx) => {
    const clean = String(item.rawInputText || '').trim();
    if (clean) {
      textBlocks.push(`【补充信息 ${idx + 1}】\n${clean}`);
    }
    if (Array.isArray(item.attachments) && item.attachments.length) {
      mergedAttachments.push(...item.attachments);
    }
    if (!mergedQuote && item.quote) {
      mergedQuote = item.quote;
    }
    if (Array.isArray(item.explicitRecipients) && item.explicitRecipients.length) {
      explicitRecipients = item.explicitRecipients;
    }
  });
  return {
    rawInputText: textBlocks.join('\n\n'),
    attachments: mergedAttachments,
    quote: mergedQuote,
    explicitRecipients,
    followUp: true,
  };
}

function enqueueCurrentComposerDraft(group = getSelectedGroup()) {
  if (!group || group.kind === 'helper' || state.uploadingCount > 0) return;
  const rawInputText = els.messageInput.value.trim();
  const attachmentsSnapshot = [...state.pendingAttachments];
  const quoteSnapshot = state.activeQuote ? { ...state.activeQuote } : null;
  if (!rawInputText && attachmentsSnapshot.length === 0) return;

  const list = state.queuedByGroup.get(group.id) || [];
  list.push({
    rawInputText,
    attachments: attachmentsSnapshot,
    quote: quoteSnapshot,
    explicitRecipients: [...state.selectedRecipients],
    followUp: true,
  });
  state.queuedByGroup.set(group.id, list);

  els.messageInput.value = '';
  saveGroupDraft(group.id, '');
  state.pendingAttachments = [];
  clearQuoteMessage();
  renderAttachmentStrip();
  syncComposerTextareaHeight();
  renderQueuedTurnBar(group);
  updateSendButtonState();
  closeMentionMenu();
  triggerLightHaptic();
  showToast(
    list.length > 1
      ? `已合并追加第 ${list.length} 条补充：当前步完成后自动在同会话跟进（点「⚡ 立即纠偏」可立即打断注入）`
      : '已追加补充信息：当前步完成后自动在同会话跟进（点「⚡ 立即纠偏」可立即打断注入）'
  );
  els.messageInput.focus();
}

function isGroupPipelineBusy(group) {
  if (!group || group.kind === 'helper') return false;
  const thinking = getThinkingActorsForGroup(group);
  if (thinking.length > 0) return true;
  const relay = state.relayByGroup.get(group.id);
  return Boolean(relay?.active);
}

async function drainQueuedTurnIfIdle(
  groupId,
  { forceImmediate = false, interruptFirst = false } = {}
) {
  if (!groupId || state.drainingQueueGroupId === groupId) return;
  const queue = state.queuedByGroup.get(groupId) || [];
  if (queue.length === 0) return;
  const group = state.groups.find((g) => g.id === groupId);
  if (!group) return;

  if (!forceImmediate && isGroupPipelineBusy(group)) {
    return;
  }

  const coalesced = coalesceQueuedSupplementItems(queue);
  state.queuedByGroup.delete(groupId);

  if (groupId === state.selectedGroupId) {
    renderQueuedTurnBar(group);
  }
  if (!coalesced) return;

  state.drainingQueueGroupId = groupId;
  try {
    if (interruptFirst && isGroupPipelineBusy(group)) {
      await controlGroupTurn(group, 'interrupt');
      await new Promise((r) => setTimeout(r, 220));
    }
    await sendMessagePayload({
      group,
      rawInputText: coalesced.rawInputText,
      attachments: coalesced.attachments || [],
      quote: coalesced.quote || null,
      explicitRecipients: coalesced.explicitRecipients || null,
      followUp: true,
    });
  } finally {
    state.drainingQueueGroupId = null;
  }
}

function updateSendButtonState() {
  const rawVal = els.messageInput.value;
  const hasText = rawVal.length > 0 && /\S/.test(rawVal);
  const hasPayload = hasText || state.pendingAttachments.length > 0;
  const isDisabled = state.uploadingCount > 0;
  if (hasPayload !== state.lastSendReady) {
    state.lastSendReady = hasPayload;
    els.sendBtn.classList.toggle('is-ready', hasPayload);
  }
  if (isDisabled !== state.lastSendDisabled) {
    state.lastSendDisabled = isDisabled;
    els.sendBtn.disabled = isDisabled;
  }

  const curGroup = getSelectedGroup();
  const isThinking = Boolean(curGroup && curGroup.kind === 'group') && isGroupPipelineBusy(curGroup);
  if (els.sendBtn && curGroup && curGroup.kind === 'group') {
    const routing = getNormalizedGroupRouting(curGroup);
    const isRouted = isGroupExternallyRouted(routing);
    const desiredLabel = isThinking
      ? '➕ 追加补充(S)'
      : isRouted
        ? routing.flow === 'discuss_then_exec'
          ? '商量并派单(S)'
          : '派发任务(S)'
        : '发送(S)';
    if (els.sendBtn.textContent !== desiredLabel) {
      els.sendBtn.textContent = desiredLabel;
    }
  }
  if (els.queueMsgBtn) {
    const queueHidden = !(isThinking && hasPayload);
    if (queueHidden !== state.lastQueueBtnHidden) {
      state.lastQueueBtnHidden = queueHidden;
      els.queueMsgBtn.hidden = queueHidden;
    }
    if (isDisabled !== state.lastQueueBtnDisabled) {
      state.lastQueueBtnDisabled = isDisabled;
      els.queueMsgBtn.disabled = isDisabled;
    }
    if (!queueHidden && els.queueMsgBtn.textContent !== '⚡ 立即打断纠偏') {
      els.queueMsgBtn.textContent = '⚡ 立即打断纠偏';
      els.queueMsgBtn.title = '中断当前正在执行的步骤，并立即在同会话注入这条补充信息 (Ctrl+Enter)';
    }
  }
  if (els.composerSendHint) {
    const nextHint = isThinking
      ? 'Agent 运行中：Enter 随时追加补充（跑完自动同会话跟进） · Ctrl+Enter 立即打断纠偏'
      : 'Ctrl+K 速切 · / 指令 · Ctrl+V 贴图 · Enter 发送';
    if (nextHint !== state.lastSendHintText) {
      state.lastSendHintText = nextHint;
      els.composerSendHint.textContent = nextHint;
    }
  }
}

function promoteOptimisticBubble(groupId, tempId, realMsg) {
  state.pendingOptimistic.delete(tempId);
  const list = state.messagesByGroup.get(groupId) || [];
  const alreadyHasReal = list.some((m) => m.id === realMsg.id);
  const nextList = alreadyHasReal
    ? list.filter((m) => m.id !== tempId)
    : list.map((m) => (m.id === tempId ? realMsg : m));
  if (!nextList.some((m) => m.id === realMsg.id)) {
    nextList.push(realMsg);
  }
  state.messagesByGroup.set(groupId, nextList);

  if (groupId === state.selectedGroupId) {
    const tempRow = els.messageStream.querySelector(`[data-msg-id="${tempId}"]`);
    if (tempRow) {
      if (alreadyHasReal && els.messageStream.querySelector(`[data-msg-id="${realMsg.id}"]`)) {
        tempRow.remove();
      } else {
        tempRow.dataset.msgId = realMsg.id;
        tempRow.classList.remove('is-optimistic');
        tempRow.querySelector('.sending-tag')?.remove();
      }
    }
    if (state.renderedGroupId === groupId) {
      state.renderedMessagesSig = computeMessagesRenderSig(groupId, nextList);
    }
  }
}

async function sendMessagePayload({
  group,
  rawInputText,
  attachments,
  quote,
  explicitRecipients = null,
  forceCollabMode = null,
  followUp = false,
}) {
  const attLines = attachments.map(
    (a) => `[${a.kind === 'image' ? '图片' : '文件'}: ${a.filePath}]`
  );
  const wireText = [rawInputText, ...attLines].filter(Boolean).join('\n');
  if (!wireText && !quote?.text) return;

  const recipientsSnapshot = explicitRecipients || [...state.selectedRecipients];
  const mode = els.replyModeBtn.getAttribute('aria-pressed') === 'true' ? 'request-reply' : 'send';
  const collabMode = forceCollabMode || group.collabMode || 'free';
  const relayLead = group.relayLead || 'codex';
  const replyStyle = ['plain', 'balanced', 'pro'].includes(group.replyStyle)
    ? group.replyStyle
    : 'plain';
  const sharedContext = collabMode === 'blind' ? false : state.sharedContext;

  const displayBody = quote?.text
    ? rawInputText
      ? `> 引用 ${quote.sender}：${quote.text}\n\n${rawInputText}`
      : `> 引用 ${quote.sender}：${quote.text}`
    : rawInputText;

  const enabledActors = (group.actors || []).filter((a) => a.enabled !== false);
  const routing = getNormalizedGroupRouting(group);
  const activeSlots = getActiveGroupSlots(routing);
  const isExtRouted = group.kind !== 'helper' && activeSlots.length > 0;
  const isFollowUpTurn = Boolean(followUp);

  let targetActorIds = [];
  if (group.kind === 'helper') {
    targetActorIds = ['file-helper'];
  } else if (isExtRouted) {
    if (recipientsSnapshot.length && !recipientsSnapshot.includes('@all')) {
      targetActorIds = recipientsSnapshot;
    } else {
      targetActorIds = activeSlots.map((s) => s.slotId);
    }
  } else if (!isExtRouted && collabMode === 'relay' && enabledActors.length >= 2) {
    const lead = enabledActors.find((a) => a.id === relayLead) || enabledActors[0];
    targetActorIds = [lead.id];
  } else if (recipientsSnapshot.length && !recipientsSnapshot.includes('@all')) {
    targetActorIds = recipientsSnapshot;
  } else {
    targetActorIds = enabledActors.map((a) => a.id);
  }

  const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const optimisticMsg = {
    id: tempId,
    ts: new Date().toISOString(),
    kind: 'chat',
    by: 'user',
    isUser: true,
    senderTitle: '我',
    senderRuntime: 'user',
    to: targetActorIds,
    mode,
    attachments: attachments.map((a) => ({
      kind: a.kind,
      name: a.fileName,
      filePath: a.filePath,
      url: a.url,
    })),
    text: displayBody,
    _optimistic: true,
  };

  state.pendingOptimistic.set(tempId, {
    groupId: group.id,
    cleanText: displayBody.trim(),
    attCount: attachments.length,
  });

  const existing = state.messagesByGroup.get(group.id) || [];
  existing.push(optimisticMsg);
  state.messagesByGroup.set(group.id, existing);
  if (group.id === state.selectedGroupId) {
    await appendSingleMessageToStream(optimisticMsg);
  }

  if (group.kind !== 'helper' && targetActorIds.length > 0) {
    let initialThinking = targetActorIds;
    if (isExtRouted && !isFollowUpTurn) {
      const leadSlot = activeSlots.find((s) => s.role === 'lead');
      const workers = leadSlot ? activeSlots.filter((s) => s.slotId !== leadSlot.slotId) : [];
      const isFullDispatch = targetActorIds.length >= activeSlots.length;
      if (routing.flow === 'discuss_then_exec' && isFullDispatch) {
        initialThinking = [activeSlots[0].slotId];
      } else if (leadSlot && workers.length >= 1 && isFullDispatch) {
        initialThinking = workers.map((w) => w.slotId);
      }
    }
    state.thinkingByGroup.set(group.id, initialThinking);
    renderActiveHeaderAndRecipients();
  }

  try {
    const res = await apiFetch(`/api/groups/${group.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        text: wireText,
        to: recipientsSnapshot,
        mode,
        sharedContext,
        collabMode,
        relayLead,
        replyStyle,
        sessionRouting: isExtRouted ? routing : undefined,
        quote,
        followUp: isFollowUpTurn,
      }),
    });

    if (res.message?.id) {
      promoteOptimisticBubble(group.id, tempId, res.message);
    }
  } catch (err) {
    state.pendingOptimistic.delete(tempId);
    const cur = state.messagesByGroup.get(group.id) || [];
    state.messagesByGroup.set(
      group.id,
      cur.filter((m) => m.id !== tempId)
    );
    els.messageStream.querySelector(`[data-msg-id="${tempId}"]`)?.remove();
    showToast(err.message);
  }
}

async function handleSend({ forceInterruptSteer = false } = {}) {
  const group = getSelectedGroup();
  if (!group || state.uploadingCount > 0) return;
  const rawInputText = els.messageInput.value.trim();
  const attachmentsSnapshot = [...state.pendingAttachments];
  const quoteSnapshot = state.activeQuote ? { ...state.activeQuote } : null;

  if (!rawInputText && attachmentsSnapshot.length === 0) return;

  // Codex-style in-turn supplementary behavior:
  // When the group is currently thinking/running, Enter appends to the in-turn supplement queue
  // instead of spawning a duplicate parallel session!
  // If forceInterruptSteer is true (Ctrl+Enter or clicking ⚡ 立即打断纠偏), it merges any queued
  // supplements, interrupts the active step, and injects immediately into the same session.
  if (group.kind === 'group' && isGroupPipelineBusy(group)) {
    enqueueCurrentComposerDraft(group);
    if (forceInterruptSteer) {
      await drainQueuedTurnIfIdle(group.id, {
        forceImmediate: true,
        interruptFirst: true,
      });
      maybeExecutePendingHotReload();
    }
    return;
  }

  // Clear composer immediately (0ms tactile WeChat response)
  els.messageInput.value = '';
  saveGroupDraft(group.id, '');
  state.pendingAttachments = [];
  clearQuoteMessage();
  renderAttachmentStrip();
  syncComposerTextareaHeight();
  updateSendButtonState();
  closeMentionMenu();
  els.messageInput.focus();

  await sendMessagePayload({
    group,
    rawInputText,
    attachments: attachmentsSnapshot,
    quote: quoteSnapshot,
  });
  maybeExecutePendingHotReload();
}

// --- Screenshot Paste & File/Image Upload ---
function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function addLocalDesktopPaths(paths) {
  if (!paths?.length) return;
  state.uploadingCount += paths.length;
  renderAttachmentStrip();
  try {
    for (const srcPath of paths) {
      const res = await apiFetch('/api/upload-local', {
        method: 'POST',
        body: JSON.stringify({ sourcePath: srcPath }),
      });
      state.pendingAttachments.push({
        id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        kind: res.kind || 'file',
        fileName: res.fileName,
        url: res.url || '',
        filePath: res.filePath,
      });
    }
  } finally {
    state.uploadingCount = Math.max(0, state.uploadingCount - paths.length);
    renderAttachmentStrip();
    els.messageInput.focus();
  }
}

async function uploadBrowserFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;

  state.uploadingCount += files.length;
  renderAttachmentStrip();

  try {
    for (const file of files) {
      if (window.electronApp?.getPathForFile) {
        const nativePath = window.electronApp.getPathForFile(file);
        if (nativePath) {
          const res = await apiFetch('/api/upload-local', {
            method: 'POST',
            body: JSON.stringify({ sourcePath: nativePath }),
          });
          state.pendingAttachments.push({
            id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            kind: res.kind || 'file',
            fileName: res.fileName,
            url: res.url || '',
            filePath: res.filePath,
          });
          continue;
        }
      }

      const buf = await file.arrayBuffer();
      const dataBase64 = arrayBufferToBase64(buf);
      const extFromMime = (file.type || '').split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'png';
      const fallbackName = `screenshot-${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}.${extFromMime}`;
      const chosenName =
        file.name && file.name !== 'image.png' && file.name !== 'blob'
          ? file.name
          : fallbackName;

      const uploaded = await apiFetch('/api/upload', {
        method: 'POST',
        body: JSON.stringify({
          fileName: chosenName,
          mimeType: file.type || '',
          dataBase64,
        }),
      });

      state.pendingAttachments.push({
        id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        kind: uploaded.kind || 'file',
        fileName: uploaded.fileName,
        url: uploaded.url || '',
        filePath: uploaded.filePath,
      });
    }
  } finally {
    state.uploadingCount = Math.max(0, state.uploadingCount - files.length);
    renderAttachmentStrip();
    els.messageInput.focus();
  }
}

async function uploadBase64Attachment({ fileName, mimeType = 'image/png', dataBase64 }) {
  if (!dataBase64) return null;
  const cleanB64 = String(dataBase64).replace(/^data:[^;]+;base64,/, '');
  const uploaded = await apiFetch('/api/upload', {
    method: 'POST',
    body: JSON.stringify({
      fileName: fileName || `capture-${Date.now()}.png`,
      mimeType,
      dataBase64: cleanB64,
    }),
  });
  const att = {
    id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    kind: uploaded.kind || 'image',
    fileName: uploaded.fileName,
    url: uploaded.url || '',
    filePath: uploaded.filePath,
  };
  state.pendingAttachments.push(att);
  return att;
}

// --- Desktop Region Screen Capture & Cropper (Ctrl+Shift+A) ---
function drawScreenCropCanvas() {
  const st = state.cropState;
  if (!st || !els.screenCropCanvas) return;
  const ctx = els.screenCropCanvas.getContext('2d');
  if (!ctx) return;
  const { width, height } = els.screenCropCanvas;
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(st.img, 0, 0, width, height);

  if (st.rect && st.rect.w > 4 && st.rect.h > 4) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.48)';
    ctx.fillRect(0, 0, width, st.rect.y);
    ctx.fillRect(0, st.rect.y + st.rect.h, width, height - (st.rect.y + st.rect.h));
    ctx.fillRect(0, st.rect.y, st.rect.x, st.rect.h);
    ctx.fillRect(
      st.rect.x + st.rect.w,
      st.rect.y,
      width - (st.rect.x + st.rect.w),
      st.rect.h
    );
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 2;
    ctx.strokeRect(st.rect.x, st.rect.y, st.rect.w, st.rect.h);
  }
}

async function startDesktopScreenCapture() {
  if (!window.electronApp?.captureScreen) return;
  try {
    const res = await window.electronApp.captureScreen();
    if (!res?.dataUrl) {
      showToast('未获取到屏幕画面');
      return;
    }
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = res.dataUrl;
    });

    const maxW = Math.min(window.innerWidth * 0.88, 1120);
    const maxH = Math.min(window.innerHeight * 0.78, 760);
    const ratio = Math.min(1, maxW / img.naturalWidth, maxH / img.naturalHeight);
    const canvasW = Math.max(1, Math.round(img.naturalWidth * ratio));
    const canvasH = Math.max(1, Math.round(img.naturalHeight * ratio));

    els.screenCropCanvas.width = canvasW;
    els.screenCropCanvas.height = canvasH;
    state.cropState = {
      img,
      dataUrl: res.dataUrl,
      scaleX: img.naturalWidth / canvasW,
      scaleY: img.naturalHeight / canvasH,
      dragging: false,
      startX: 0,
      startY: 0,
      rect: null,
    };
    els.cropConfirmBtn.disabled = true;
    drawScreenCropCanvas();
    if (!els.screenCropDialog.open) {
      els.screenCropDialog.showModal();
    }
  } catch (err) {
    showToast(err.message || '桌面截图失败');
  }
}

async function commitScreenCrop(useFullScreen = false) {
  const st = state.cropState;
  if (!st) return;
  els.screenCropDialog.close();
  state.uploadingCount += 1;
  renderAttachmentStrip();
  try {
    let base64 = '';
    if (useFullScreen || !st.rect || st.rect.w < 6 || st.rect.h < 6) {
      base64 = st.dataUrl.replace(/^data:image\/png;base64,/, '');
    } else {
      const sx = Math.max(0, Math.round(st.rect.x * st.scaleX));
      const sy = Math.max(0, Math.round(st.rect.y * st.scaleY));
      const sw = Math.min(st.img.naturalWidth - sx, Math.max(1, Math.round(st.rect.w * st.scaleX)));
      const sh = Math.min(st.img.naturalHeight - sy, Math.max(1, Math.round(st.rect.h * st.scaleY)));
      const off = document.createElement('canvas');
      off.width = sw;
      off.height = sh;
      const octx = off.getContext('2d');
      octx.drawImage(st.img, sx, sy, sw, sh, 0, 0, sw, sh);
      base64 = off.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
    }
    const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
    await uploadBase64Attachment({
      fileName: `screen-crop-${stamp}.png`,
      mimeType: 'image/png',
      dataBase64: base64,
    });
    showToast('框选截图已贴入待发栏，按 Enter 即可发送');
  } catch (err) {
    showToast(err.message);
  } finally {
    state.cropState = null;
    state.uploadingCount = Math.max(0, state.uploadingCount - 1);
    renderAttachmentStrip();
    els.messageInput.focus();
  }
}

// --- Android v1.5 Inbound System Share Receiver ---
let consumingShare = false;
async function consumeAndroidIncomingShare() {
  if (!window.AndroidBridge?.consumePendingShare || consumingShare) return;
  let rawJson = '';
  try {
    rawJson = window.AndroidBridge.consumePendingShare() || '';
  } catch {
    return;
  }
  if (!rawJson) return;
  consumingShare = true;
  try {
    const payload = JSON.parse(rawJson);
    const sharedText = String(payload?.text || '').trim();
    const sharedImages = Array.isArray(payload?.images) ? payload.images : [];
    if (!sharedText && sharedImages.length === 0) return;

    if (!state.selectedGroupId && state.groups.length > 0) {
      const target = state.groups.find((g) => !g.archived) || state.groups[0];
      if (target) await selectGroup(target.id);
    } else {
      els.appRoot.dataset.mobileView = 'chat';
    }

    if (sharedText) {
      const prev = els.messageInput.value.trim();
      els.messageInput.value = prev ? `${prev}\n${sharedText}` : sharedText;
      if (state.selectedGroupId) {
        saveGroupDraft(state.selectedGroupId, els.messageInput.value);
      }
    }

    if (sharedImages.length > 0) {
      state.uploadingCount += sharedImages.length;
      renderAttachmentStrip();
      try {
        for (const img of sharedImages) {
          await uploadBase64Attachment({
            fileName: img.fileName || `shared-${Date.now()}.jpg`,
            mimeType: img.mimeType || 'image/jpeg',
            dataBase64: img.dataBase64,
          });
        }
      } finally {
        state.uploadingCount = Math.max(0, state.uploadingCount - sharedImages.length);
      }
    }

    renderAttachmentStrip();
    updateSendButtonState();
    triggerLightHaptic();
    showToast('已导入手机分享内容，确认目标群聊后点击发送即可');
    els.messageInput.focus();
  } catch {
    // ignore malformed share payload
  } finally {
    consumingShare = false;
  }
}

// --- Live Host Computer Preview Panel (Desktop & Remote Mobile) ---
let lastSilentDesktopPushAt = 0;

async function pushSilentDesktopPreviewFrame({ maxWidth = 1280, quality = 70 } = {}) {
  if (!window.electronApp?.captureDesktopPreview) return null;
  const now = Date.now();
  if (now - lastSilentDesktopPushAt < 500 && state.computerPreviewFrame?.base64) {
    return state.computerPreviewFrame;
  }
  lastSilentDesktopPushAt = now;
  const cap = await window.electronApp.captureDesktopPreview({ maxWidth, quality });
  if (!cap?.ok || !cap.base64) return null;
  const frame = {
    ok: true,
    capturedAt: new Date().toISOString(),
    mimeType: cap.mimeType || 'image/jpeg',
    width: cap.width || 1280,
    height: cap.height || 720,
    origWidth: cap.origWidth || cap.width || 1280,
    origHeight: cap.origHeight || cap.height || 720,
    base64: cap.base64,
  };
  apiFetch('/api/computer-preview', {
    method: 'POST',
    body: JSON.stringify(frame),
  }).catch(() => {});
  return frame;
}

async function refreshComputerPreview({
  silent = false,
  forceFresh = true,
  allowLegacyBlink = true,
} = {}) {
  if (state.loadingComputerPreview || !els.computerPreviewDialog) return;
  state.loadingComputerPreview = true;
  if (els.computerRefreshNowBtn) els.computerRefreshNowBtn.disabled = true;
  try {
    let res = null;
    if (window.electronApp?.captureDesktopPreview) {
      res = await pushSilentDesktopPreviewFrame({ maxWidth: 1280, quality: 70 });
    }
    if (!res?.ok || !res.base64) {
      res = await apiFetch(`/api/computer-preview${forceFresh ? '?fresh=1' : ''}`);
    }
    if ((!res?.ok || !res.base64) && allowLegacyBlink && window.electronApp?.captureScreen) {
      const cap = await window.electronApp.captureScreen();
      if (cap?.ok && cap.dataUrl) {
        const cleanB64 = cap.dataUrl.replace(/^data:[^;]+;base64,/, '');
        res = {
          ok: true,
          capturedAt: new Date().toISOString(),
          mimeType: 'image/png',
          width: cap.width || 1280,
          height: cap.height || 720,
          origWidth: cap.width || 1280,
          origHeight: cap.height || 720,
          base64: cleanB64,
        };
        apiFetch('/api/computer-preview', {
          method: 'POST',
          body: JSON.stringify({
            width: res.width,
            height: res.height,
            mimeType: 'image/png',
            base64: cleanB64,
          }),
        }).catch(() => {});
      }
    }
    if (!res?.ok || !res.base64) {
      throw new Error(res?.error || '未能获取桌面画面');
    }
    state.computerPreviewFrame = res;
    const dataUrl = `data:${res.mimeType || 'image/jpeg'};base64,${res.base64}`;
    if (els.computerPreviewImg) {
      if (res.width > 0 && res.height > 0) {
        els.computerPreviewImg.width = res.width;
        els.computerPreviewImg.height = res.height;
      }
      els.computerPreviewImg.src = dataUrl;
      els.computerPreviewImg.hidden = false;
    }
    if (els.computerPreviewPlaceholder) {
      els.computerPreviewPlaceholder.hidden = true;
    }
    if (els.computerPreviewMeta) {
      const timeStr = res.capturedAt ? new Date(res.capturedAt).toLocaleTimeString('zh-CN') : '';
      const resDim =
        res.origWidth && res.origHeight
          ? `${res.origWidth}×${res.origHeight}`
          : `${res.width}×${res.height}`;
      els.computerPreviewMeta.textContent = `${resDim} · 更新于 ${timeStr}`;
    }
  } catch (err) {
    if (els.computerPreviewPlaceholder && !state.computerPreviewFrame?.base64) {
      els.computerPreviewPlaceholder.hidden = false;
      els.computerPreviewPlaceholder.textContent = `${err.message}`;
    }
    if (!silent) showToast(err.message || '桌面画面获取失败');
  } finally {
    state.loadingComputerPreview = false;
    if (els.computerRefreshNowBtn) els.computerRefreshNowBtn.disabled = false;
  }
}

function syncComputerPreviewPolling() {
  clearInterval(state.computerPreviewTimer);
  state.computerPreviewTimer = null;
  if (
    els.computerPreviewDialog?.open &&
    els.computerAutoRefreshCheck?.checked &&
    !document.hidden
  ) {
    state.computerPreviewTimer = setInterval(() => {
      if (!els.computerPreviewDialog?.open || document.hidden) {
        syncComputerPreviewPolling();
        return;
      }
      refreshComputerPreview({ silent: true, forceFresh: true, allowLegacyBlink: false });
    }, 2000);
  }
}

function openComputerPreviewModal() {
  if (!els.computerPreviewDialog) return;
  if (!els.computerPreviewDialog.open) {
    els.computerPreviewDialog.showModal();
  }
  refreshComputerPreview({ silent: false });
  syncComputerPreviewPolling();
}

async function captureComputerPreviewToChat() {
  if (!state.computerPreviewFrame?.base64) {
    await refreshComputerPreview({ silent: false });
  }
  const frame = state.computerPreviewFrame;
  if (!frame?.base64) return;
  els.computerPreviewDialog?.close();
  state.uploadingCount += 1;
  renderAttachmentStrip();
  try {
    const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
    await uploadBase64Attachment({
      fileName: `host-desktop-${stamp}.jpg`,
      mimeType: frame.mimeType || 'image/jpeg',
      dataBase64: frame.base64,
    });
    triggerLightHaptic();
    showToast('已将当前宿主电脑画面贴入输入框，按 Enter 即可发送');
  } catch (err) {
    showToast(err.message || '贴入电脑画面失败');
  } finally {
    state.uploadingCount = Math.max(0, state.uploadingCount - 1);
    renderAttachmentStrip();
    els.messageInput.focus();
  }
}

// --- Ctrl+K Global Command & Quick-Switch Palette ---
function buildCommandPaletteItems(rawQuery = '') {
  const q = String(rawQuery || '').trim().toLowerCase();
  const items = [];
  const curGroup = getSelectedGroup();

  for (const g of state.groups) {
    items.push({
      title: `${g.archived ? '[已归档] ' : ''}${g.title}`,
      sub: g.kind === 'helper' ? '备忘与文件传输' : g.scopePath || g.topic || '切换至此群聊',
      tag: g.id === state.selectedGroupId ? '当前群聊' : '跳转群聊',
      keywords: `${g.title} ${g.topic || ''} ${g.scopePath || ''}`.toLowerCase(),
      run: () => selectGroup(g.id),
    });
  }

  for (const tpl of getAllSlashTemplates()) {
    items.push({
      title: `${tpl.cmd} — ${tpl.label}`,
      sub: tpl.prompt.replace(/\s+/g, ' ').slice(0, 72),
      tag: '插入指令',
      keywords: `${tpl.cmd} ${tpl.label} ${tpl.prompt}`.toLowerCase(),
      run: () => {
        const prev = els.messageInput.value;
        els.messageInput.value = prev && !prev.endsWith('\n') ? `${prev}\n${tpl.prompt}` : `${prev}${tpl.prompt}`;
        if (state.selectedGroupId) saveGroupDraft(state.selectedGroupId, els.messageInput.value);
        updateSendButtonState();
        els.messageInput.focus();
      },
    });
  }

  if (curGroup && curGroup.kind === 'group') {
    items.push({
      title: `切换本群速度档位（当前：${curGroup.speedGear === 'fast' ? '⚡极速' : '🧠深度'}）`,
      sub: '在极速快聊档与高推理深度思考档之间热切换',
      tag: '档位',
      keywords: 'speed gear fast deep 极速 深度 速度',
      run: () => switchGroupSpeedGear(curGroup, curGroup.speedGear === 'fast' ? 'deep' : 'fast'),
    });
    if (curGroup.scopePath) {
      items.push({
        title: '查看当前群 Git 工作区变更 (Diff)',
        sub: curGroup.scopePath,
        tag: 'Git Diff',
        keywords: 'git diff status 变更 代码 改动',
        run: () => openGitDiffModal(curGroup, ''),
      });
    }
  }

  if (window.electronApp?.captureScreen) {
    items.push({
      title: '桌面框选截图贴入输入框',
      sub: '快捷键 Ctrl+Shift+A',
      tag: '截图',
      keywords: 'screenshot capture 截图 抓屏',
      run: () => startDesktopScreenCapture(),
    });
  }

  items.push(
    {
      title: '查看宿主电脑实时桌面画面（支持手机远程监看与一键抓屏）',
      sub: '实时同步主屏幕画面，可一键贴入当前聊天框发给 Agent',
      tag: '实时桌面',
      keywords: 'computer desktop screen preview 桌面 电脑 实时 远程 监看',
      run: () => openComputerPreviewModal(),
    },
    {
      title: '切换界面皮肤：极简工作台 (方案 A)',
      sub: '中性灰黑工作台 · 顶部并行展开 IDE 双卡片',
      tag: '皮肤 A',
      keywords: 'skin theme workbench ui 皮肤 极简 工作台 方案a',
      run: () => {
        applyUiSkin('workbench');
        showToast('已切换皮肤：极简工作台 (方案 A)');
      },
    },
    {
      title: '切换界面皮肤：沉浸阅读 (方案 B)',
      sub: '暖纸/炭黑留白 · 顶部单行胶囊 + 68ch 无边界阅读',
      tag: '皮肤 B',
      keywords: 'skin theme editorial paper claude 皮肤 沉浸 阅读 暖纸 方案b',
      run: () => {
        applyUiSkin('editorial');
        showToast('已切换皮肤：沉浸阅读 (方案 B)');
      },
    },
    {
      title: '切换浅色 / 深色舒适外观',
      sub: `当前外观：${getRenderedColorScheme() === 'dark' ? '深色' : '浅色'}`,
      tag: '外观',
      keywords: 'theme dark light 深色 浅色 夜间 主题 外观',
      run: () => toggleTwoStateComfortTheme(),
    },
    {
      title: '进入消息多选整理模式（合并转发 / 批量收藏 / 导出精选）',
      sub: '勾选任意气泡进行跨群转发或导出',
      tag: '多选',
      keywords: 'multiselect forward star 多选 转发 收藏 精选',
      run: () => setMultiSelectMode(true),
    },
    {
      title: '管理个人 / 快捷提示词模板',
      sub: '多端云同步自定义指令',
      tag: '模板',
      keywords: 'template slash 模板 快捷指令',
      run: () => {
        renderCustomTemplatesModal();
        els.slashTemplateDialog.showModal();
      },
    },
    {
      title: '导出当前群聊完整记录 (.md)',
      sub: '保存为本地 Markdown 文档',
      tag: '导出',
      keywords: 'export markdown 导出 聊天记录',
      run: () => exportCurrentGroupMarkdown(),
    },
    {
      title: '发起新的 Agent 项目群聊',
      sub: '绑定目录并一键拉起 Codex 与 Antigravity',
      tag: '新建',
      keywords: 'new group create 新建 创建 群聊',
      run: () => els.newGroupDialog.showModal(),
    }
  );

  if (!q) return items;
  return items.filter(
    (it) =>
      it.title.toLowerCase().includes(q) ||
      it.sub.toLowerCase().includes(q) ||
      it.keywords.includes(q)
  );
}

function renderCommandPaletteList() {
  els.cmdPaletteList.replaceChildren();
  if (state.cmdPaletteItems.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'info-card-row';
    empty.textContent = '没有匹配的群聊或命令';
    els.cmdPaletteList.appendChild(empty);
    return;
  }
  state.cmdPaletteItems.forEach((item, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `cmd-palette-item${idx === state.cmdPaletteIndex ? ' is-active' : ''}`;
    btn.setAttribute('role', 'option');
    btn.setAttribute('aria-selected', idx === state.cmdPaletteIndex ? 'true' : 'false');

    const main = document.createElement('div');
    main.className = 'cmd-item-main';
    const tSpan = document.createElement('span');
    tSpan.className = 'cmd-item-title';
    tSpan.textContent = item.title;
    const sSpan = document.createElement('span');
    sSpan.className = 'cmd-item-sub';
    sSpan.textContent = item.sub;
    main.append(tSpan, sSpan);

    const tag = document.createElement('span');
    tag.className = 'cmd-item-tag';
    tag.textContent = item.tag;

    btn.append(main, tag);
    btn.addEventListener('click', () => {
      els.cmdPaletteDialog.close();
      item.run();
    });
    els.cmdPaletteList.appendChild(btn);
  });
}

function openCommandPalette() {
  if (!els.cmdPaletteDialog) return;
  els.cmdPaletteInput.value = '';
  state.cmdPaletteIndex = 0;
  state.cmdPaletteItems = buildCommandPaletteItems('');
  renderCommandPaletteList();
  if (!els.cmdPaletteDialog.open) {
    els.cmdPaletteDialog.showModal();
  }
  els.cmdPaletteInput.focus();
}

// --- Mobile QR Connect & APK Download Loader ---
async function loadMobileQrInfo(ip = '') {
  try {
    const query = ip ? `?ip=${encodeURIComponent(ip)}` : '';
    const [info, DOMPurify] = await Promise.all([
      apiFetch(`/api/mobile-connect${query}`),
      loadDOMPurify(),
    ]);
    const cleanQr = DOMPurify.sanitize(String(info.qrSvg || ''), {
      USE_PROFILES: { svg: true },
      ALLOW_DATA_ATTR: false,
    });
    const qrDoc = new DOMParser().parseFromString(cleanQr, 'image/svg+xml');
    const svgEl = qrDoc.querySelector('svg');
    if (svgEl) {
      els.qrContainer.replaceChildren(document.importNode(svgEl, true));
    } else {
      els.qrContainer.textContent = '二维码已就绪';
    }
    els.mobilePairUrlInput.value = info.pairUrl;

    if (info.apkAvailable) {
      els.apkDownloadLink.href = info.apkDownloadUrl || '/download/achat.apk';
      els.apkDownloadLink.classList.remove('is-disabled');
      els.apkDownloadLink.textContent = `下载 APK (${info.apkSizeMb} MB)`;
      els.apkStatusSub.textContent =
        'v1.5.0 原生包 · 系统分享直传链接/多图、自动寻址重连、拍照发图与返回手势';
    } else {
      els.apkDownloadLink.classList.add('is-disabled');
      els.apkDownloadLink.textContent = '构建中…';
    }

    if (els.tailscaleStatusBanner) {
      const ts = info.tailscale;
      if (ts?.online && (ts.magicDnsUrl || ts.ipv4Url)) {
        els.tailscaleStatusBanner.hidden = false;
        els.tailscaleStatusBanner.textContent = `🌐 Tailscale 异地直连已就绪：${ts.magicDnsUrl || ts.ipv4Url}${ts.ipv4 ? ` (${ts.ipv4})` : ''} — 手机不在同一 Wi-Fi 也可直接扫码连接`;
      } else if (ts?.installed) {
        els.tailscaleStatusBanner.hidden = false;
        els.tailscaleStatusBanner.textContent = `🌐 已检测到本机 Tailscale（当前状态：${ts.backendState || '未登录/未启动'}）。开启后可免内网穿透异地连回电脑端 AChat。`;
      } else {
        els.tailscaleStatusBanner.hidden = true;
      }
    }

    els.lanIpSelect.replaceChildren();
    if (info.endpoints.length === 0) {
      const opt = document.createElement('option');
      opt.value = '127.0.0.1';
      opt.textContent = '127.0.0.1 (仅本机)';
      els.lanIpSelect.appendChild(opt);
    } else {
      for (const ep of info.endpoints) {
        const opt = document.createElement('option');
        opt.value = ep.ip;
        opt.selected = ep.ip === info.selectedIp;
        opt.textContent = `${ep.ip} (${ep.name}${ep.isTailscale ? ' · Tailscale远程' : ''}${ep.isVirtual ? ' · 虚拟网卡' : ''})`;
        els.lanIpSelect.appendChild(opt);
      }
    }
  } catch (err) {
    els.qrContainer.textContent = err.message;
  }
}

function syncThinkingStateFromGroups(groups) {
  if (!Array.isArray(groups)) return;
  for (const g of groups) {
    if (!g || g.kind === 'helper') continue;
    const thinkingIds = [];
    for (const a of g.actors || []) {
      const key = `${g.id}:${a.id}`;
      if (a.workingState === 'thinking') {
        thinkingIds.push(a.id);
        if (a.thinkingSince) {
          const tsMs = new Date(a.thinkingSince).getTime();
          if (!Number.isNaN(tsMs)) state.thinkingStartedAt.set(key, tsMs);
        } else if (!state.thinkingStartedAt.has(key)) {
          state.thinkingStartedAt.set(key, Date.now());
        }
      } else {
        state.thinkingStartedAt.delete(key);
      }
    }
    if (g.externalThinking && typeof g.externalThinking === 'object') {
      for (const [extId, extMeta] of Object.entries(g.externalThinking)) {
        if (!thinkingIds.includes(extId)) {
          thinkingIds.push(extId);
        }
        const extKey = `${g.id}:${extId}`;
        if (extMeta?.since) {
          const tsMs = new Date(extMeta.since).getTime();
          if (!Number.isNaN(tsMs)) state.thinkingStartedAt.set(extKey, tsMs);
        } else if (!state.thinkingStartedAt.has(extKey)) {
          state.thinkingStartedAt.set(extKey, Date.now());
        }
      }
    }
    state.thinkingByGroup.set(g.id, thinkingIds);
    if (g.ideBoard && typeof g.ideBoard === 'object') {
      const existingBoard = state.ideBoardsByGroup.get(g.id);
      const nextTs = g.ideBoard.updatedAt ? new Date(g.ideBoard.updatedAt).getTime() : 0;
      const prevTs = existingBoard?.updatedAt ? new Date(existingBoard.updatedAt).getTime() : 0;
      if (!existingBoard || nextTs >= prevTs) {
        state.ideBoardsByGroup.set(g.id, g.ideBoard);
      }
    }
  }
}

function maybeExecutePendingHotReload() {
  if (!state.pendingHotReload) return;
  if (
    !els.messageInput.value.trim() &&
    state.uploadingCount === 0 &&
    !document.querySelector('dialog[open]')
  ) {
    if (state.selectedGroupId) {
      saveGroupDraft(state.selectedGroupId, els.messageInput.value, { immediate: true });
    }
    flushDraftsToStorage();
    window.location.reload();
  }
}

function handleIncomingAssetVersion(nextVersion) {
  if (!nextVersion) return;
  if (!state.assetVersion) {
    state.assetVersion = nextVersion;
    return;
  }
  if (nextVersion !== state.assetVersion) {
    state.assetVersion = nextVersion;
    state.pendingHotReload = true;
    maybeExecutePendingHotReload();
  }
}

async function refreshGroupsQuietly({ force = false } = {}) {
  try {
    const boot = await apiFetch(force ? '/api/bootstrap?force=1' : '/api/bootstrap');
    if (boot.assetVersion) {
      handleIncomingAssetVersion(boot.assetVersion);
    }
    if (boot.clientSync) {
      hydrateClientSync(boot.clientSync);
    }
    els.daemonDot.classList.toggle('is-online', Boolean(boot.daemon?.running));
    els.menuStatusText.textContent = boot.daemon?.running
      ? 'CCCC 引擎运行正常'
      : 'CCCC 引擎未连接';
    state.groups = boot.groups || [];
    syncThinkingStateFromGroups(state.groups);
    renderSessionColumn();
    renderActiveHeaderAndRecipients();
  } catch {
    // ignore transient poll failure
  }
}

// --- SSE Live Stream ---
function connectLiveEvents() {
  const es = new EventSource('/api/events');
  let hasHandledInitialSseConnect = false;

  es.addEventListener('connected', (ev) => {
    els.netStatePill.hidden = true;
    try {
      const payload = JSON.parse(ev.data || '{}');
      if (payload.assetVersion) {
        handleIncomingAssetVersion(payload.assetVersion);
      }
    } catch {
      // ignore
    }
    if (!hasHandledInitialSseConnect) {
      hasHandledInitialSseConnect = true;
      return;
    }
    refreshGroupsQuietly();
    if (state.selectedGroupId) {
      reconcileGroupMessages(state.selectedGroupId, { scrollToBottom: true });
    }
  });

  es.addEventListener('requestDesktopFrame', (ev) => {
    if (!window.electronApp?.captureDesktopPreview) return;
    try {
      const opts = JSON.parse(ev.data || '{}');
      pushSilentDesktopPreviewFrame({
        maxWidth: opts.maxWidth || 1280,
        quality: opts.quality || 68,
      }).catch(() => {});
    } catch {
      pushSilentDesktopPreviewFrame().catch(() => {});
    }
  });

  es.addEventListener('error', () => {
    els.netStatePill.hidden = false;
  });

  es.addEventListener('message', async (ev) => {
    try {
      const { groupId, message } = JSON.parse(ev.data);

      // If this SSE frame matches an in-flight optimistic green bubble, upgrade it in place
      if (message.isUser) {
        for (const [tempId, info] of state.pendingOptimistic.entries()) {
          const msgAttCount = Array.isArray(message.attachments) ? message.attachments.length : 0;
          if (
            info.groupId === groupId &&
            info.cleanText === String(message.text || '').trim() &&
            info.attCount === msgAttCount
          ) {
            promoteOptimisticBubble(groupId, tempId, message);
            return;
          }
        }
      } else if (message.by) {
        const isIntermediateStageMsg =
          typeof message.insight === 'string' &&
          (message.insight.startsWith('💬 阶段进展') ||
            message.insight.startsWith('📋 长任务阶段汇报') ||
            message.insight.startsWith('⏰ 长任务自动接力'));
        if (!isIntermediateStageMsg) {
          clearStreamingBubblesForActor(groupId, message.by);
          const curThinking = state.thinkingByGroup.get(groupId) || [];
          if (curThinking.includes(message.by)) {
            state.thinkingByGroup.set(
              groupId,
              curThinking.filter((id) => id !== message.by)
            );
          }
        }
      }

      const list = state.messagesByGroup.get(groupId) || [];
      if (!list.some((m) => m.id === message.id)) {
        list.push(message);
        state.messagesByGroup.set(groupId, list);
        if (groupId === state.selectedGroupId) {
          await appendSingleMessageToStream(message);
        } else if (message.kind === 'chat') {
          state.unreadByGroup.set(groupId, (state.unreadByGroup.get(groupId) || 0) + 1);
        }
        if (!message.isUser && message.kind === 'chat') {
          const grp = state.groups.find((x) => x.id === groupId);
          const snippet = (message.text || '[图片/附件]').replace(/\s+/g, ' ').slice(0, 96);
          syncDesktopUnreadState({
            title: `${message.senderTitle || 'Agent'} · ${grp?.title || 'AChat'}`,
            body: snippet,
          });
          try {
            window.AndroidBridge?.notifyAgentReply?.(
              grp?.title || 'AChat',
              message.senderTitle || 'Agent',
              snippet
            );
          } catch {
            // ignore bridge error
          }
        }
      }
      renderSessionColumn();
      renderActiveHeaderAndRecipients();
      if (!message.isUser) {
        drainQueuedTurnIfIdle(groupId);
      }
    } catch {
      // ignore malformed frame
    }
  });

  es.addEventListener('stream', (ev) => {
    try {
      const frame = JSON.parse(ev.data);
      const { groupId, streamId, done } = frame || {};
      if (!groupId || !streamId) return;
      let grpMap = state.activeStreamsByGroup.get(groupId);
      if (!grpMap) {
        grpMap = new Map();
        state.activeStreamsByGroup.set(groupId, grpMap);
      }
      if (done) {
        grpMap.delete(streamId);
        if (groupId === state.selectedGroupId) {
          removeStreamingBubbleDom(streamId);
        }
        return;
      }
      grpMap.set(streamId, frame);
      if (groupId === state.selectedGroupId) {
        upsertStreamingBubbleDom(groupId, frame);
      }
      if (
        document.hidden &&
        frame.stepLabel &&
        typeof window.Notification === 'function' &&
        Notification.permission === 'granted'
      ) {
        const lastAt = state.lastBgStepNotifyAt.get(groupId) || 0;
        if (Date.now() - lastAt >= 4500) {
          state.lastBgStepNotifyAt.set(groupId, Date.now());
          const grp = state.groups.find((x) => x.id === groupId);
          try {
            new Notification(`${frame.senderTitle || 'Agent'} · ${grp?.title || 'AChat'}`, {
              body: frame.stepLabel,
              tag: `achat-live-${groupId}`,
              silent: true,
            });
          } catch {
            // ignore notification constructor restriction on mobile service worker
          }
        }
      }
    } catch {
      // ignore malformed stream frame
    }
  });

  es.addEventListener('cardSettled', (ev) => {
    try {
      const payload = JSON.parse(ev.data || '{}');
      if (payload?.groupId && payload?.settled) {
        applyCardSettlementInClientState(payload.groupId, payload);
      }
    } catch {
      // ignore
    }
  });

  es.addEventListener('ideBoard', (ev) => {
    try {
      const payload = JSON.parse(ev.data || '{}');
      const { groupId, ideBoard } = payload;
      if (!groupId || !ideBoard) return;
      state.ideBoardsByGroup.set(groupId, ideBoard);
      if (groupId === state.selectedGroupId) {
        renderIdeTaskBoard(getSelectedGroup());
      }
    } catch {
      // ignore malformed ideBoard frame
    }
  });

  es.addEventListener('activity', (ev) => {
    try {
      const { groupId, thinkingActorIds } = JSON.parse(ev.data);
      const nextIds = Array.isArray(thinkingActorIds) ? thinkingActorIds : [];
      state.thinkingByGroup.set(groupId, nextIds);
      renderSessionColumn();
      if (groupId === state.selectedGroupId) {
        renderActiveHeaderAndRecipients();
      }
      if (nextIds.length === 0) {
        drainQueuedTurnIfIdle(groupId);
      }
    } catch {
      // ignore
    }
  });

  es.addEventListener('relay', (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (!data?.groupId) return;
      state.relayByGroup.set(data.groupId, data);
      if (data.error) {
        showToast(data.error);
      }
      if (data.groupId === state.selectedGroupId) {
        updateTypingAndRelayBanners(getSelectedGroup());
        updateSendButtonState();
      }
      if (!data.active) {
        drainQueuedTurnIfIdle(data.groupId);
      }
    } catch {
      // ignore
    }
  });

  es.addEventListener('groups', (ev) => {
    try {
      const { groups } = JSON.parse(ev.data);
      if (Array.isArray(groups)) {
        state.groups = groups;
        syncThinkingStateFromGroups(state.groups);
        renderSessionColumn();
        renderActiveHeaderAndRecipients();
      }
    } catch {
      // ignore
    }
  });

  es.addEventListener('clientSync', (ev) => {
    try {
      const syncData = JSON.parse(ev.data);
      hydrateClientSync(syncData);
    } catch {
      // ignore
    }
  });
}

// --- Wire Event Listeners & Desktop / PWA Integration ---
async function initApp() {
  setupModernOverlayFallbacks();
  syncThemeControlsUI();
  syncSkinControlsUI();

  els.skinToggleBtn?.addEventListener('click', toggleUiSkin);
  els.mobileSkinBtn?.addEventListener('click', toggleUiSkin);
  for (const btn of document.querySelectorAll('[data-skin-choice]')) {
    btn.addEventListener('click', () => {
      applyUiSkin(btn.dataset.skinChoice);
      triggerLightHaptic();
    });
  }

  els.themeToggleBtn?.addEventListener('click', toggleTwoStateComfortTheme);
  els.mobileThemeBtn?.addEventListener('click', toggleTwoStateComfortTheme);
  for (const btn of document.querySelectorAll('[data-theme-choice]')) {
    btn.addEventListener('click', () => {
      applyThemeChoice(btn.dataset.themeChoice);
    });
  }
  window.addEventListener('storage', (ev) => {
    if (ev.key === 'color-scheme') {
      const meta = getMetaColorScheme();
      if (meta) meta.content = ev.newValue === 'light' || ev.newValue === 'dark' ? ev.newValue : 'light dark';
      syncThemeControlsUI();
      rerenderVisibleMermaidDiagrams();
    } else if (ev.key === UI_SKIN_STORAGE_KEY) {
      applyUiSkin(ev.newValue || 'workbench', { persist: false, resetBoardPosture: true });
    }
  });
  systemDarkMql.addEventListener('change', () => {
    syncThemeControlsUI();
    rerenderVisibleMermaidDiagrams();
  });

  if (window.AndroidBridge?.openServerSwitcher && els.androidServerBtn) {
    els.androidServerBtn.hidden = false;
    els.androidServerBtn.addEventListener('click', () => {
      try {
        window.AndroidBridge.openServerSwitcher();
      } catch {
        // ignore
      }
    });
  }

  window.addEventListener('achat-share-ready', () => {
    consumeAndroidIncomingShare();
  });

  const handleForegroundResume = () => {
    refreshGroupsQuietly();
    if (state.selectedGroupId) {
      reconcileGroupMessages(state.selectedGroupId, { scrollToBottom: false });
    }
    consumeAndroidIncomingShare();
  };
  window.addEventListener('achat-resume', handleForegroundResume);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      flushDraftsToStorage();
      syncComputerPreviewPolling();
    } else {
      handleForegroundResume();
      syncComputerPreviewPolling();
    }
  });
  window.addEventListener('pagehide', flushDraftsToStorage);
  window.addEventListener('beforeunload', flushDraftsToStorage);

  // Preserve sequential keyboard reachability across off-screen content-visibility boundaries
  els.messageStream?.addEventListener('focusin', (ev) => {
    const row = ev.target?.closest?.('.msg-row');
    if (!row) return;
    row.classList.remove('is-offscreen-history');
    row.previousElementSibling?.classList.remove('is-offscreen-history');
    row.nextElementSibling?.classList.remove('is-offscreen-history');
  });

  // Lightbox Zoom Controls (Buttons + Mouse Wheel + Double-Click Reset)
  els.lightboxZoomInBtn?.addEventListener('click', () => setLightboxZoom(state.lightboxZoom + 0.25));
  els.lightboxZoomOutBtn?.addEventListener('click', () => setLightboxZoom(state.lightboxZoom - 0.25));
  els.lightboxZoomResetBtn?.addEventListener('click', () => setLightboxZoom(1));
  els.lightboxImg?.addEventListener('dblclick', () => setLightboxZoom(state.lightboxZoom === 1 ? 2 : 1));
  els.lightboxStage?.addEventListener(
    'wheel',
    (ev) => {
      if (!els.imageLightbox?.open) return;
      ev.preventDefault();
      const step = ev.deltaY < 0 ? 0.2 : -0.2;
      setLightboxZoom(state.lightboxZoom + step);
    },
    { passive: false }
  );

  // Global Ctrl+K Command Palette & Multi-Select Escape
  document.getElementById('openCmdPaletteBtn')?.addEventListener('click', () => openCommandPalette());
  document.getElementById('mobileCmdPaletteBtn')?.addEventListener('click', () => openCommandPalette());
  document.querySelector('[commandfor="cmdPaletteDialog"][command="show-modal"]')?.addEventListener('click', () => {
    document.getElementById('systemMenuPopover')?.hidePopover?.();
    setTimeout(() => openCommandPalette(), 0);
  });
  document.querySelector('[commandfor="slashTemplateDialog"][command="show-modal"]')?.addEventListener('click', () => {
    document.getElementById('systemMenuPopover')?.hidePopover?.();
    renderCustomTemplatesModal();
  });

  window.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && ev.key.toLowerCase() === 'k') {
      ev.preventDefault();
      if (els.cmdPaletteDialog?.open) {
        els.cmdPaletteDialog.close();
      } else {
        openCommandPalette();
      }
      return;
    }
    if (
      ev.key === 'Escape' &&
      state.multiSelectMode &&
      !document.querySelector('dialog[open]') &&
      !state.mentionActive
    ) {
      setMultiSelectMode(false);
    }
  });

  els.cmdPaletteInput?.addEventListener('input', () => {
    state.cmdPaletteIndex = 0;
    state.cmdPaletteItems = buildCommandPaletteItems(els.cmdPaletteInput.value);
    renderCommandPaletteList();
  });

  els.cmdPaletteInput?.addEventListener('keydown', (ev) => {
    const len = state.cmdPaletteItems.length;
    if (!len) return;
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      state.cmdPaletteIndex = (state.cmdPaletteIndex + 1) % len;
      renderCommandPaletteList();
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      state.cmdPaletteIndex = (state.cmdPaletteIndex - 1 + len) % len;
      renderCommandPaletteList();
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      const chosen = state.cmdPaletteItems[state.cmdPaletteIndex];
      if (chosen) {
        els.cmdPaletteDialog.close();
        chosen.run();
      }
    }
  });

  // Live 1s elapsed timer for thinking banner (SSE pushes live step & group diffs)
  setInterval(() => {
    if (document.hidden) return;
    const g = getSelectedGroup();
    if (!g || g.kind === 'helper') return;
    const thinking = getThinkingActorsForGroup(g);
    if (!thinking.length) return;
    updateTypingAndRelayBanners(g);
  }, 1000);

  for (const btn of [els.interruptTurnBtn, els.itbInterruptBtn]) {
    btn?.addEventListener('click', () => {
      const g = getSelectedGroup();
      if (g) controlGroupTurn(g, 'interrupt');
    });
  }
  for (const btn of [els.retryTurnBtn, els.itbRetryBtn]) {
    btn?.addEventListener('click', () => {
      const g = getSelectedGroup();
      if (g) controlGroupTurn(g, 'retry');
    });
  }

  els.openComputerPreviewBtn?.addEventListener('click', () => {
    els.chatQuickMenuPopover?.hidePopover?.();
  });

  els.pinSessionBtn?.addEventListener('click', () => {
    const g = getSelectedGroup();
    if (!g) return;
    const nextPinned = !g.pinned;
    updateGroupCollabPrefs(g, { pinned: nextPinned });
    showToast(nextPinned ? '当前会话已置顶' : '已取消会话置顶');
  });

  els.replyStyleBtn?.addEventListener('click', () => {
    const g = getSelectedGroup();
    if (!g || g.kind === 'helper') return;
    const order = ['plain', 'balanced', 'pro'];
    const cur = order.includes(g.replyStyle) ? g.replyStyle : 'plain';
    const nextStyle = order[(order.indexOf(cur) + 1) % order.length];
    updateGroupCollabPrefs(g, { replyStyle: nextStyle });
    triggerLightHaptic();
    const toasts = {
      plain: '已切至「人话精简」：直接给结论，少堆术语',
      balanced: '已切至「适中清晰」：结论先行 + 精简要点',
      pro: '已切至「专业深度」：保留完整术语与源码依据',
    };
    showToast(toasts[nextStyle]);
  });

  // Target Session Routing Modal & Multi-Session Orchestration Event Listeners
  const handleOpenRoutingModal = () => {
    const g = getSelectedGroup();
    if (!g || g.kind === 'helper') return;
    triggerLightHaptic();
    if (!state.externalSessionsLoaded && !state.loadingExternalSessions) {
      loadExternalSessions({ silent: true });
    }
    requestAnimationFrame(() => {
      const cur = getSelectedGroup();
      if (
        cur &&
        els.sessionRoutingDialog &&
        !els.sessionRoutingDialog.open &&
        typeof els.sessionRoutingDialog.showModal === 'function'
      ) {
        try {
          els.sessionRoutingDialog.showModal();
        } catch {}
      }
      renderSessionTargetBar(cur);
    });
  };
  els.openSessionRoutingBtn?.addEventListener('click', handleOpenRoutingModal);
  els.targetSessionToggleBtn?.addEventListener('click', handleOpenRoutingModal);

  els.sessionRoutingDialog?.addEventListener('close', () => {
    renderSessionTargetBar(getSelectedGroup());
  });

  els.itbToggleBtn?.addEventListener('click', () => {
    const g = getSelectedGroup();
    if (!g) return;
    const nextCollapsed = !isIdeBoardCollapsedForGroup(g.id);
    state.ideBoardCollapsedByGroup.set(g.id, nextCollapsed);
    triggerLightHaptic();
    renderIdeTaskBoard(g);
  });

  els.toggleSessionPresetsBtn?.addEventListener('click', () => {
    const g = getSelectedGroup();
    if (!g || g.kind === 'helper') return;
    const nextOpen = !Boolean(state.sessionPresetsOpenByGroup.get(g.id));
    state.sessionPresetsOpenByGroup.set(g.id, nextOpen);
    triggerLightHaptic();
    renderSessionTargetBar(g);
  });

  els.presetOneLeadTwoAgyBtn?.addEventListener('click', () => {
    const g = getSelectedGroup();
    if (!g || g.kind === 'helper') return;
    triggerLightHaptic();
    applyPresetOneLeadTwoAgy(g);
    showToast('已应用：1 Codex 主审验收 + 2 Antigravity 并行子会话');
  });

  els.addAgySlotBtn?.addEventListener('click', () => {
    const g = getSelectedGroup();
    if (!g || g.kind === 'helper') return;
    triggerLightHaptic();
    addSlotToGroupRouting(g, 'antigravity');
  });

  els.addCodexSlotBtn?.addEventListener('click', () => {
    const g = getSelectedGroup();
    if (!g || g.kind === 'helper') return;
    triggerLightHaptic();
    addSlotToGroupRouting(g, 'codex');
  });

  els.sessionFlowSeg?.addEventListener('click', (ev) => {
    const btn = ev.target?.closest?.('[data-session-flow]');
    if (!btn) return;
    const g = getSelectedGroup();
    if (!g || g.kind === 'helper') return;
    const nextFlow = btn.dataset.sessionFlow === 'discuss_then_exec' ? 'discuss_then_exec' : 'direct';
    triggerLightHaptic();
    applyGroupSessionRoutingPatch(g, { flow: nextFlow });
    showToast(
      nextFlow === 'discuss_then_exec'
        ? '已切至「先商量再执行」：先对齐分工，再并行派入目标会话'
        : '已切至「直达会话」：消息直接送入各已启用会话'
    );
  });

  els.sessionPermSeg?.addEventListener('click', (ev) => {
    const btn = ev.target?.closest?.('[data-session-perm]');
    if (!btn) return;
    const g = getSelectedGroup();
    if (!g || g.kind === 'helper') return;
    const nextPerm = ['inherit', 'workspace-write', 'read-only'].includes(btn.dataset.sessionPerm)
      ? btn.dataset.sessionPerm
      : 'inherit';
    triggerLightHaptic();
    applyGroupSessionRoutingPatch(g, { permission: nextPerm });
    const permMsgs = {
      inherit: '权限已设为「沿用原权限」',
      'workspace-write': '权限已设为「允许改代码」',
      'read-only': '权限已设为「只读分析」',
    };
    showToast(permMsgs[nextPerm]);
  });

  els.autoReviewToggleBtn?.addEventListener('click', () => {
    const g = getSelectedGroup();
    if (!g || g.kind === 'helper') return;
    const curRouting = getNormalizedGroupRouting(g);
    const nextRev = curRouting.autoReview === false;
    triggerLightHaptic();
    applyGroupSessionRoutingPatch(g, { autoReview: nextRev });
    showToast(
      nextRev
        ? '已开启「主审自动验收」：子会话完成后自动送主审验收并在不通过时定向返工'
        : '已关闭「主审自动验收」：各会话各自回复后即结束本轮'
    );
  });

  els.autoWakeToggleBtn?.addEventListener('click', () => {
    const g = getSelectedGroup();
    if (!g || g.kind === 'helper') return;
    const curRouting = getNormalizedGroupRouting(g);
    const nextWake = curRouting.autoWake === false;
    triggerLightHaptic();
    applyGroupSessionRoutingPatch(g, { autoWake: nextWake });
    showToast(
      nextWake
        ? '已开启「长任务自动唤醒」：断连自动续跑、未完阶段自动接力'
        : '已关闭「长任务自动唤醒」：单轮结束后等待手动指令'
    );
  });

  els.refreshExtSessionsBtn?.addEventListener('click', () => {
    triggerLightHaptic();
    loadExternalSessions({ force: true, silent: false });
  });

  els.sessionFilterInput?.addEventListener('input', () => {
    state.sessionFilterQuery = els.sessionFilterInput.value || '';
    state.slotSelectCacheKeys.clear();
    renderSessionTargetBar(getSelectedGroup());
  });

  els.resetSessionRoutingBtn?.addEventListener('click', () => {
    const g = getSelectedGroup();
    if (!g || g.kind === 'helper') return;
    triggerLightHaptic();
    if (els.sessionFilterInput) {
      els.sessionFilterInput.value = '';
      state.sessionFilterQuery = '';
    }
    state.slotSelectCacheKeys.clear();
    updateGroupCollabPrefs(g, {
      sessionRouting: {
        enabled: false,
        flow: 'direct',
        permission: 'inherit',
        autoReview: true,
        autoWake: true,
        slots: [
          {
            slotId: 'codex',
            provider: 'codex',
            label: 'Codex',
            role: 'lead',
            mode: 'group',
            sessionId: '',
            sessionTitle: '',
            cwd: '',
          },
          {
            slotId: 'antigravity',
            provider: 'antigravity',
            label: 'Antigravity',
            role: 'peer',
            mode: 'group',
            sessionId: '',
            sessionTitle: '',
            cwd: '',
          },
        ],
      },
    });
    showToast('已恢复为本群默认双会话');
  });

  if ('serviceWorker' in navigator && !window.electronApp?.isDesktop) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  // Desktop Electron frameless window controls + Screen Region Cropper
  if (window.electronApp?.isDesktop) {
    els.desktopWinBar.hidden = false;
    els.pickDirBtn.hidden = false;
    if (els.menuShortcutHint) els.menuShortcutHint.hidden = false;
    if (els.screenCaptureBtn && window.electronApp?.captureScreen) {
      els.screenCaptureBtn.hidden = false;
      els.screenCaptureBtn.addEventListener('click', () => startDesktopScreenCapture());
      window.electronApp.onTriggerScreenCapture?.(() => startDesktopScreenCapture());
    }

    window.addEventListener('focus', () => syncDesktopUnreadState());

    const syncWinState = (st) => {
      els.winPinBtn.classList.toggle('is-pinned', Boolean(st?.alwaysOnTop));
      els.winPinBtn.title = st?.alwaysOnTop ? '取消置顶' : '置顶窗口';
    };
    window.electronApp.getWindowState().then(syncWinState);
    window.electronApp.onWindowStateChange(syncWinState);

    els.winPinBtn.addEventListener('click', async () => {
      const st = await window.electronApp.toggleAlwaysOnTop();
      syncWinState(st);
      showToast(st.alwaysOnTop ? '窗口已置顶' : '已取消置顶');
    });
    els.winMinBtn.addEventListener('click', () => window.electronApp.minimize());
    els.winMaxBtn.addEventListener('click', () => window.electronApp.toggleMaximize());
    els.winCloseBtn.addEventListener('click', () => window.electronApp.closeWindow());
    els.pickDirBtn.addEventListener('click', async () => {
      const chosen = await window.electronApp.pickDirectory();
      if (chosen) els.ngPath.value = chosen;
    });
    els.openScopeBtn.addEventListener('click', () => {
      const g = getSelectedGroup();
      if (g?.scopePath) openOrCopyLocalPath(g.scopePath);
    });
  } else {
    els.openScopeBtn.addEventListener('click', () => {
      const g = getSelectedGroup();
      if (g?.scopePath) openOrCopyLocalPath(g.scopePath);
    });
  }

  // Screen Crop Canvas Pointer Events
  els.screenCropCanvas?.addEventListener('pointerdown', (ev) => {
    const st = state.cropState;
    if (!st) return;
    const r = els.screenCropCanvas.getBoundingClientRect();
    st.dragging = true;
    st.startX = Math.max(0, ev.clientX - r.left);
    st.startY = Math.max(0, ev.clientY - r.top);
    st.rect = { x: st.startX, y: st.startY, w: 0, h: 0 };
    els.screenCropCanvas.setPointerCapture?.(ev.pointerId);
    drawScreenCropCanvas();
  });
  els.screenCropCanvas?.addEventListener('pointermove', (ev) => {
    const st = state.cropState;
    if (!st?.dragging) return;
    const r = els.screenCropCanvas.getBoundingClientRect();
    const cx = Math.min(els.screenCropCanvas.width, Math.max(0, ev.clientX - r.left));
    const cy = Math.min(els.screenCropCanvas.height, Math.max(0, ev.clientY - r.top));
    st.rect = {
      x: Math.min(st.startX, cx),
      y: Math.min(st.startY, cy),
      w: Math.abs(cx - st.startX),
      h: Math.abs(cy - st.startY),
    };
    els.cropConfirmBtn.disabled = !(st.rect.w > 6 && st.rect.h > 6);
    drawScreenCropCanvas();
  });
  els.screenCropCanvas?.addEventListener('pointerup', () => {
    if (state.cropState) state.cropState.dragging = false;
  });
  els.cropFullBtn?.addEventListener('click', () => commitScreenCrop(true));
  els.cropConfirmBtn?.addEventListener('click', () => commitScreenCrop(false));

  // Nav buttons (both desktop rail & mobile bottom tabbar)
  for (const btn of document.querySelectorAll('[data-nav]')) {
    btn.addEventListener('click', () => setNavTab(btn.dataset.nav));
  }

  els.myAvatarBtn.addEventListener('click', () => {
    refreshGroupsQuietly();
    showToast('已同步最新连接状态');
  });

  els.mobileBackBtn.addEventListener('click', () => {
    els.appRoot.dataset.mobileView = 'list';
  });

  els.searchInput.addEventListener('input', () => {
    state.searchQuery = els.searchInput.value;
    renderSessionColumn();
    triggerFullTextSearch(state.searchQuery);
  });

  els.messageStream.addEventListener(
    'scroll',
    () => {
      const nearBottom =
        els.messageStream.scrollHeight - els.messageStream.scrollTop - els.messageStream.clientHeight < 90;
      if (nearBottom && state.belowFoldCount > 0) {
        state.belowFoldCount = 0;
        updateBelowFoldPill();
      }
      if (els.messageStream.scrollTop < 32 && state.selectedGroupId) {
        loadOlderGroupMessages(state.selectedGroupId);
      }
    },
    { passive: true }
  );

  els.newMsgJumpBtn?.addEventListener('click', () => {
    els.messageStream.scrollTo({ top: els.messageStream.scrollHeight, behavior: 'smooth' });
    state.belowFoldCount = 0;
    updateBelowFoldPill();
  });

  // Multi-select Bar & Drawer Lifecycle / Git / Settings Listeners
  els.enterMultiSelectBtn?.addEventListener('click', () => {
    els.groupDrawer.hidden = true;
    els.toggleDrawerBtn.setAttribute('aria-expanded', 'false');
    setMultiSelectMode(true);
  });
  els.multiCancelBtn?.addEventListener('click', () => setMultiSelectMode(false));
  els.multiStarBtn?.addEventListener('click', () => batchStarSelectedMessages());
  els.multiExportBtn?.addEventListener('click', () => exportSelectedMessagesMarkdown());
  els.multiNativeShareBtn?.addEventListener('click', () => nativeShareSelectedMessages());
  els.multiForwardBtn?.addEventListener('click', () => openForwardTargetModal());

  els.saveGroupSettingsBtn?.addEventListener('click', () => saveCurrentGroupSettings());
  els.archiveGroupBtn?.addEventListener('click', () => toggleArchiveCurrentGroup());
  els.confirmDeleteGroupBtn?.addEventListener('click', () => deleteCurrentGroupConfirmed());
  els.refreshGitBtn?.addEventListener('click', () => {
    const g = getSelectedGroup();
    if (g) loadDrawerGitSummary(g, { force: true });
  });
  els.openFullDiffBtn?.addEventListener('click', () => {
    const g = getSelectedGroup();
    if (g) openGitDiffModal(g, '');
  });
  els.drawerWorktreeCreateBtn?.addEventListener('click', () => {
    const g = getSelectedGroup();
    if (g) createGroupWorktree(g, els.drawerWorktreeCreateBtn);
  });
  els.drawerGitCommitBtn?.addEventListener('click', () => {
    const g = getSelectedGroup();
    if (g) executeGroupGitCommit(g, els.drawerGitCommitInput, els.drawerGitCommitBtn);
  });
  els.drawerGitCommitInput?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.isComposing) {
      ev.preventDefault();
      const g = getSelectedGroup();
      if (g) executeGroupGitCommit(g, els.drawerGitCommitInput, els.drawerGitCommitBtn);
    }
  });
  els.modalGitCommitBtn?.addEventListener('click', () => {
    const g = getSelectedGroup();
    if (g) executeGroupGitCommit(g, els.modalGitCommitInput, els.modalGitCommitBtn);
  });
  els.modalGitCommitInput?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.isComposing) {
      ev.preventDefault();
      const g = getSelectedGroup();
      if (g) executeGroupGitCommit(g, els.modalGitCommitInput, els.modalGitCommitBtn);
    }
  });
  els.discardCurrentFileBtn?.addEventListener('click', () => {
    const ctx = state.activeDiffContext;
    const g = getSelectedGroup();
    if (g && ctx?.relPath) {
      confirmAndDiscardFile(g, ctx.relPath, els.discardCurrentFileBtn, { closeModalOnDone: true });
    }
  });
  els.computerRefreshNowBtn?.addEventListener('click', () =>
    refreshComputerPreview({ silent: false })
  );
  els.computerAutoRefreshCheck?.addEventListener('change', () => {
    syncComputerPreviewPolling();
    if (els.computerAutoRefreshCheck.checked && els.computerPreviewDialog?.open) {
      refreshComputerPreview({ silent: true });
    }
  });
  els.computerCaptureToChatBtn?.addEventListener('click', () => captureComputerPreviewToChat());
  if (els.computerPreviewDialog) {
    els.computerPreviewDialog.addEventListener('close', () => syncComputerPreviewPolling());
    const cpObs = new MutationObserver(() => {
      if (els.computerPreviewDialog.open) {
        refreshComputerPreview({ silent: true });
      }
      syncComputerPreviewPolling();
    });
    cpObs.observe(els.computerPreviewDialog, { attributes: true, attributeFilter: ['open'] });
  }
  if (!('commandForElement' in HTMLButtonElement.prototype)) {
    document.addEventListener('click', (ev) => {
      const btn = ev.target?.closest?.('button[commandfor][command]');
      if (!btn) return;
      const target = document.getElementById(btn.getAttribute('commandfor') || '');
      if (!target) return;
      const cmd = btn.getAttribute('command');
      if (cmd === 'show-modal' && typeof target.showModal === 'function' && !target.open) {
        target.showModal();
      } else if (cmd === 'close' && typeof target.close === 'function' && target.open) {
        target.close();
      }
    });
  }
  for (const el of document.querySelectorAll('[commandfor="computerPreviewDialog"][command="show-modal"]')) {
    el.addEventListener('click', () => {
      document.getElementById('systemMenuPopover')?.hidePopover?.();
    });
  }
  els.copyGitDiffBtn?.addEventListener('click', async () => {
    const txt = state.activeDiffContext?.diffText || '';
    if (!txt) {
      showToast('当前暂无可复制的 Diff 内容');
      return;
    }
    await copyTextSafe(txt);
    showToast('Git Diff 已复制');
  });
  els.askAgentReviewDiffBtn?.addEventListener('click', () => {
    const ctx = state.activeDiffContext;
    els.gitDiffDialog.close();
    const targetDesc = ctx?.relPath ? `文件 \`${ctx.relPath}\`` : '当前工作区未提交改动';
    els.messageInput.value = `请重点审查 ${targetDesc} 的 Git Diff 变更，检查是否存在逻辑缺陷、安全边界遗漏或回归风险。`;
    if (state.selectedGroupId) saveGroupDraft(state.selectedGroupId, els.messageInput.value);
    updateSendButtonState();
    els.messageInput.focus();
  });

  els.exportChatBtn?.addEventListener('click', () => exportCurrentGroupMarkdown());
  els.menuExportChatBtn?.addEventListener('click', () => {
    document.getElementById('systemMenuPopover')?.hidePopover?.();
    exportCurrentGroupMarkdown();
  });

  // Custom / Slash Prompt Template Form
  els.slashTemplateForm?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const cmd = els.tplCmdInput.value.trim();
    const label = els.tplLabelInput.value.trim();
    const prompt = els.tplPromptInput.value.trim();
    if (!cmd || !prompt) return;
    try {
      const res = await apiFetch('/api/client-sync', {
        method: 'POST',
        body: JSON.stringify({
          action: 'saveTemplate',
          template: { cmd, label, prompt },
        }),
      });
      if (res.clientSync) hydrateClientSync(res.clientSync);
      els.slashTemplateForm.reset();
      showToast('个人快捷指令模板已保存并同步');
    } catch (err) {
      showToast(err.message);
    }
  });

  // Speed Gear toggle (Header pill + Drawer radio cards)
  els.speedGearBtn.addEventListener('click', () => {
    const g = getSelectedGroup();
    if (!g || g.kind === 'helper') return;
    const nextGear = g.speedGear === 'fast' ? 'deep' : 'fast';
    switchGroupSpeedGear(g, nextGear);
  });

  els.drawerFastGearBtn.addEventListener('click', () => {
    const g = getSelectedGroup();
    if (g && g.speedGear !== 'fast') switchGroupSpeedGear(g, 'fast');
  });

  els.drawerDeepGearBtn.addEventListener('click', () => {
    const g = getSelectedGroup();
    if (g && g.speedGear !== 'deep') switchGroupSpeedGear(g, 'deep');
  });

  // 3-Mode Collaboration Switcher
  for (const btn of els.collabModeBar.querySelectorAll('[data-collab]')) {
    btn.addEventListener('click', () => {
      const g = getSelectedGroup();
      if (!g || g.kind === 'helper') return;
      const nextMode = btn.dataset.collab;
      if ((g.collabMode || 'free') === nextMode) return;
      updateGroupCollabPrefs(g, { collabMode: nextMode });
      const labels = {
        free: '已切至「自由群聊」：正常群聊协作，可自由 @单人 或 @所有人',
        relay: '已切至「主从自动接力」：主笔回复初稿后将自动转交同伴复核',
        blind: '已切至「双盲独立对撞」：已隔离同伴发言，双方将独立盲答',
      };
      showToast(labels[nextMode] || '');
    });
  }

  els.relayOrderBtn.addEventListener('click', () => {
    const g = getSelectedGroup();
    if (!g || g.kind === 'helper') return;
    const enabled = (g.actors || []).filter((a) => a.enabled !== false);
    if (enabled.length < 2) return;
    const curLead = enabled.find((a) => a.id === (g.relayLead || 'codex')) || enabled[0];
    const nextLead = enabled.find((a) => a.id !== curLead.id) || enabled[1];
    updateGroupCollabPrefs(g, { relayLead: nextLead.id });
    showToast(`接力顺序已切换：${nextLead.title} 先出初稿 → ${curLead.title} 复核`);
  });

  els.clearQuoteBtn.addEventListener('click', clearQuoteMessage);

  els.toggleDrawerBtn.addEventListener('click', () => {
    const nextHidden = !els.groupDrawer.hidden;
    els.groupDrawer.hidden = nextHidden;
    els.toggleDrawerBtn.setAttribute('aria-expanded', nextHidden ? 'false' : 'true');
    const g = getSelectedGroup();
    if (!nextHidden && g) {
      renderGroupDrawer(g);
      if (!state.providerEcosystem) {
        loadProviderEcosystem({ force: false })
          .then(() => {
            const cur = getSelectedGroup();
            if (cur && !els.groupDrawer.hidden) renderDrawerAgentProfiles(cur);
          })
          .catch(() => {});
      }
    }
  });

  els.copyScopeBtn.addEventListener('click', async () => {
    const g = getSelectedGroup();
    if (!g?.scopePath) return;
    await copyTextSafe(g.scopePath);
    showToast('工作目录路径已复制');
  });

  // Composer Toolbar (@mention / /slash / #file)
  els.mentionBtn.addEventListener('click', () => {
    if (state.mentionActive && state.autocompleteKind === 'mention') closeMentionMenu();
    else openMentionMenu('');
    els.messageInput.focus();
  });

  els.slashCmdBtn?.addEventListener('click', () => {
    if (state.mentionActive && state.autocompleteKind === 'slash') closeMentionMenu();
    else openSlashMenu('');
    els.messageInput.focus();
  });

  els.scopeFileBtn?.addEventListener('click', () => {
    els.composerMorePopover?.hidePopover?.();
    if (state.mentionActive && state.autocompleteKind === 'file') closeMentionMenu();
    else openScopeFileMenu('');
    els.messageInput.focus();
  });

  const syncMoreToolsBadgeAndHints = () => {
    const replyRequired = els.replyModeBtn?.getAttribute('aria-pressed') === 'true';
    if (els.sharedCtxStateHint) {
      els.sharedCtxStateHint.textContent = state.sharedContext
        ? '已开启 · 双方共享近期发言'
        : '已关闭 · 双方独立盲答';
    }
    if (els.replyModeStateHint) {
      els.replyModeStateHint.textContent = replyRequired
        ? '已开启 · 强制正式回执'
        : '按需开启 · 强制明确答复';
    }
    if (els.composerMoreBtn) {
      els.composerMoreBtn.classList.toggle('has-custom', !state.sharedContext || replyRequired);
    }
  };

  const syncSharedCtxBtn = () => {
    els.sharedCtxBtn.setAttribute('aria-pressed', state.sharedContext ? 'true' : 'false');
    els.sharedCtxBtn.classList.toggle('is-active', state.sharedContext);
    syncMoreToolsBadgeAndHints();
  };
  syncSharedCtxBtn();

  els.sharedCtxBtn.addEventListener('click', () => {
    state.sharedContext = !state.sharedContext;
    localStorage.setItem('aw_shared_ctx', state.sharedContext ? 'true' : 'false');
    syncSharedCtxBtn();
    showToast(
      state.sharedContext
        ? '已开启「互通」：双方可见本群近期对话'
        : '已关闭「互通」：双方独立盲答不看底牌'
    );
  });

  els.replyModeBtn.addEventListener('click', () => {
    const next = els.replyModeBtn.getAttribute('aria-pressed') !== 'true';
    els.replyModeBtn.setAttribute('aria-pressed', next ? 'true' : 'false');
    els.replyModeBtn.classList.toggle('is-active', next);
    syncMoreToolsBadgeAndHints();
  });

  const runComposerAutocompleteCheck = () => {
    const rawVal = els.messageInput.value;
    const pos = els.messageInput.selectionStart || 0;
    const winStart = Math.max(0, pos - 96);
    const leadGuard = winStart > 0 ? (/\s/.test(rawVal[winStart - 1]) ? ' ' : 'x') : '';
    const before = `${leadGuard}${rawVal.slice(winStart, pos)}`;

    const mentionMatch = before.match(/(?:^|\s)@([a-zA-Z0-9_-]*)$/);
    if (mentionMatch) {
      openMentionMenu(mentionMatch[1].toLowerCase());
      return;
    }
    const slashLead = winStart > 0 ? (rawVal[winStart - 1] === '\n' ? '\n' : 'x') : '';
    const slashMatch = `${slashLead}${rawVal.slice(winStart, pos)}`.match(/(?:^|\n)\/([a-zA-Z0-9_-]*)$/);
    if (slashMatch) {
      openSlashMenu(slashMatch[1].toLowerCase());
      return;
    }
    const fileMatch = before.match(/(?:^|\s)#([^\s#]*)$/);
    if (fileMatch) {
      openScopeFileMenu(fileMatch[1]);
      return;
    }
    closeMentionMenu();
  };

  els.messageInput.addEventListener('compositionstart', () => {
    state.isComposingInput = true;
  });

  els.messageInput.addEventListener('compositionend', () => {
    state.isComposingInput = false;
    syncComposerTextareaHeight();
    updateSendButtonState();
    if (state.selectedGroupId) {
      saveGroupDraft(state.selectedGroupId, els.messageInput.value);
    }
    runComposerAutocompleteCheck();
  });

  els.messageInput.addEventListener('input', (ev) => {
    syncComposerTextareaHeight();
    // Skip state/DOM/timer churn while Chinese/CJK IME composition is in progress
    if (ev.isComposing || state.isComposingInput) {
      return;
    }
    updateSendButtonState();
    if (state.selectedGroupId) {
      saveGroupDraft(state.selectedGroupId, els.messageInput.value);
    }
    runComposerAutocompleteCheck();
  });

  // Direct Screenshot Paste (Ctrl+V) in Composer
  els.messageInput.addEventListener('paste', async (ev) => {
    const items = Array.from(ev.clipboardData?.items || []);
    const fileItems = items.filter((it) => it.kind === 'file');
    if (fileItems.length === 0) return;

    const files = fileItems.map((it) => it.getAsFile()).filter(Boolean);
    if (files.length === 0) return;

    ev.preventDefault();
    try {
      await uploadBrowserFiles(files);
      showToast('截图已添加，按 Enter 即可直接发送');
    } catch (err) {
      showToast(err.message);
    }
  });

  els.messageInput.addEventListener('keydown', (ev) => {
    if (state.mentionActive) {
      if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        state.mentionIndex = (state.mentionIndex + 1) % state.mentionCandidates.length;
        renderMentionOptions();
        return;
      }
      if (ev.key === 'ArrowUp') {
        ev.preventDefault();
        state.mentionIndex =
          (state.mentionIndex - 1 + state.mentionCandidates.length) %
          state.mentionCandidates.length;
        renderMentionOptions();
        return;
      }
      if (ev.key === 'Enter' || ev.key === 'Tab') {
        ev.preventDefault();
        applyMentionChoice(state.mentionCandidates[state.mentionIndex]);
        return;
      }
      if (ev.key === 'Escape') {
        ev.preventDefault();
        closeMentionMenu();
        return;
      }
    }

    if (
      ev.key === 'Enter' &&
      (ev.ctrlKey || ev.metaKey) &&
      !ev.isComposing &&
      !state.isComposingInput
    ) {
      const g = getSelectedGroup();
      if (g && g.kind === 'group' && isGroupPipelineBusy(g)) {
        ev.preventDefault();
        handleSend({ forceInterruptSteer: true });
        return;
      }
    }

    if (
      ev.key === 'Enter' &&
      ev.altKey &&
      !ev.isComposing &&
      !state.isComposingInput
    ) {
      const g = getSelectedGroup();
      if (g && g.kind === 'group' && isGroupPipelineBusy(g)) {
        ev.preventDefault();
        enqueueCurrentComposerDraft(g);
        return;
      }
    }

    if (ev.key === 'Enter' && !ev.shiftKey && !mobileViewportMql.matches && !ev.isComposing && !state.isComposingInput) {
      ev.preventDefault();
      handleSend();
    }
  });

  els.sendBtn.addEventListener('click', () => handleSend());
  els.queueMsgBtn?.addEventListener('click', () => handleSend({ forceInterruptSteer: true }));
  els.steerQueuedTurnBtn?.addEventListener('click', () => {
    const gid = state.selectedGroupId;
    if (gid) drainQueuedTurnIfIdle(gid, { forceImmediate: true, interruptFirst: true });
  });
  els.flushQueuedNowBtn?.addEventListener('click', () => {
    const gid = state.selectedGroupId;
    if (gid) drainQueuedTurnIfIdle(gid, { forceImmediate: true, interruptFirst: false });
  });
  els.clearQueuedBtn?.addEventListener('click', () => {
    const g = getSelectedGroup();
    if (!g) return;
    const queue = state.queuedByGroup.get(g.id) || [];
    if (queue.length > 0) {
      const popped = queue.pop();
      if (queue.length === 0) state.queuedByGroup.delete(g.id);
      else state.queuedByGroup.set(g.id, queue);
      if (popped?.rawInputText) {
        const cur = els.messageInput.value.trim();
        els.messageInput.value = cur ? `${cur}\n${popped.rawInputText}` : popped.rawInputText;
        saveGroupDraft(g.id, els.messageInput.value);
      }
      if (Array.isArray(popped?.attachments) && popped.attachments.length) {
        state.pendingAttachments.push(...popped.attachments);
        renderAttachmentStrip();
      }
    }
    syncComposerTextareaHeight();
    renderQueuedTurnBar(g);
    updateSendButtonState();
    els.messageInput.focus();
  });

  // Image & File attachment buttons + Drag-and-drop
  els.attachImageBtn.addEventListener('click', () => {
    els.hiddenImageInput.click();
  });

  els.hiddenImageInput.addEventListener('change', async () => {
    if (els.hiddenImageInput.files?.length) {
      try {
        await uploadBrowserFiles(els.hiddenImageInput.files);
      } catch (err) {
        showToast(err.message);
      }
      els.hiddenImageInput.value = '';
    }
  });

  els.attachFileBtn.addEventListener('click', async () => {
    els.composerMorePopover?.hidePopover?.();
    if (window.electronApp?.pickFiles) {
      const picked = await window.electronApp.pickFiles();
      if (picked?.length) {
        try {
          await addLocalDesktopPaths(picked);
        } catch (err) {
          showToast(err.message);
        }
      }
    } else {
      els.hiddenFileInput.click();
    }
  });

  els.hiddenFileInput.addEventListener('change', async () => {
    if (els.hiddenFileInput.files?.length) {
      try {
        await uploadBrowserFiles(els.hiddenFileInput.files);
      } catch (err) {
        showToast(err.message);
      }
      els.hiddenFileInput.value = '';
    }
  });

  const chatStage = document.getElementById('chatStage');
  chatStage.addEventListener('dragover', (ev) => {
    ev.preventDefault();
    els.dropOverlay.hidden = false;
  });
  chatStage.addEventListener('dragleave', (ev) => {
    if (ev.relatedTarget && chatStage.contains(ev.relatedTarget)) return;
    els.dropOverlay.hidden = true;
  });
  chatStage.addEventListener('drop', async (ev) => {
    ev.preventDefault();
    els.dropOverlay.hidden = true;
    if (ev.dataTransfer?.files?.length) {
      try {
        await uploadBrowserFiles(ev.dataTransfer.files);
      } catch (err) {
        showToast(err.message);
      }
    }
  });

  // Mobile QR Connect & APK modal events
  document.getElementById('mobileQrBtn').addEventListener('click', () => loadMobileQrInfo());
  els.lanIpSelect.addEventListener('change', () => loadMobileQrInfo(els.lanIpSelect.value));
  els.copyPairUrlBtn.addEventListener('click', async () => {
    if (!els.mobilePairUrlInput.value) return;
    await copyTextSafe(els.mobilePairUrlInput.value);
    showToast('手机配对链接已复制');
  });

  els.refreshNowBtn.addEventListener('click', () => {
    refreshGroupsQuietly();
    showToast('已刷新最新状态');
  });

  // Create New Group Form
  els.newGroupForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    els.ngError.hidden = true;
    els.ngSubmitBtn.disabled = true;
    els.ngSubmitBtn.textContent = '创建并启动中…';
    const fd = new FormData(els.newGroupForm);
    try {
      const payload = {
        title: fd.get('title'),
        projectPath: fd.get('projectPath'),
        topic: fd.get('topic'),
        codexSandbox: fd.get('codexSandbox'),
        speedGear: fd.get('speedGear') || 'fast',
        includeCodex: fd.get('includeCodex') === 'on',
        includeAntigravity: fd.get('includeAntigravity') === 'on',
      };
      const res = await apiFetch('/api/groups', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      state.groups = res.groups || state.groups;
      els.newGroupDialog.close();
      els.newGroupForm.reset();
      if (res.group?.id) {
        await selectGroup(res.group.id);
      } else {
        renderSessionColumn();
      }
      showToast('新群聊已创建并启动');
    } catch (err) {
      els.ngError.textContent = err.message;
      els.ngError.hidden = false;
    } finally {
      els.ngSubmitBtn.disabled = false;
      els.ngSubmitBtn.textContent = '创建并启动群聊';
    }
  });

  // Check session authorization first (for LAN mobile visitors without QR token)
  const sessionInfo = await apiFetch('/api/session');
  state.isLocalSession = Boolean(window.electronApp?.isDesktop || sessionInfo.isLocal);
  if (sessionInfo.assetVersion) {
    state.assetVersion = sessionInfo.assetVersion;
  }
  if (!sessionInfo.authorized) {
    els.emptyWatermark.hidden = false;
    els.activeChatWrap.hidden = true;
    const notice = document.createElement('div');
    notice.className = 'info-card-row';
    notice.style.color = '#c2410c';
    notice.textContent =
      '当前设备尚未授权访问。请在电脑端「AChat」左下角点击手机图标，用手机相机扫描二维码或粘贴配对链接即可登录。';
    els.sessionList.replaceChildren(notice);
    return;
  }

  // Initial Bootstrap
  const boot = await apiFetch('/api/bootstrap');
  if (boot.assetVersion && !state.assetVersion) {
    state.assetVersion = boot.assetVersion;
  }
  if (boot.clientSync) {
    hydrateClientSync(boot.clientSync);
  }
  els.daemonDot.classList.toggle('is-online', Boolean(boot.daemon?.running));
  state.groups = boot.groups || [];
  syncThinkingStateFromGroups(state.groups);
  renderSessionColumn();

  const firstActiveGroup = state.groups.find((g) => !g.archived) || state.groups[0] || null;
  const previewParam = new URLSearchParams(window.location.search).get('preview');
  if (previewParam === 'running' || previewParam === '1' || previewParam === 'multisession') {
    const now = Date.now();
    const iso = (ms) => new Date(ms).toISOString();

    state.groups = (state.groups || []).map((g) => ({
      ...g,
      actors: Array.isArray(g.actors) ? g.actors.map((a) => ({ ...a })) : [],
    }));

    let previewGroup =
      state.groups.find((g) => g.kind === 'group' && !g.archived) ||
      state.groups.find((g) => !g.archived) ||
      state.groups[0] ||
      null;
    let isSyntheticGroup = false;
    if (!previewGroup) {
      isSyntheticGroup = true;
      previewGroup = {
        id: 'preview-demo',
        kind: 'group',
        title: '皇室战争 AI 模型研发',
        topic: '1 Codex 主审验收 + 2 Antigravity 并行子会话',
        scopePath: '~/projects/cr-ai-model',
        actors: [
          { id: 'codex', title: 'Codex', role: 'lead', workingState: 'thinking' },
          { id: 'agy-1', title: 'AG-1·训练', role: 'peer', workingState: 'idle' },
          { id: 'agy-2', title: 'AG-2·推理', role: 'peer', workingState: 'idle' },
        ],
        speedGear: 'fast',
      };
      state.groups = [previewGroup];
    } else {
      previewGroup.kind = 'group';
      previewGroup.title = '皇室战争 AI 模型研发';
      if (!previewGroup.scopePath) {
        previewGroup.scopePath = '~/projects/cr-ai-model';
      }
      previewGroup.actors = [
        {
          id: 'codex',
          title: 'Codex',
          role: 'lead',
          workingState: 'thinking',
          thinkingSince: iso(now - 24000),
          liveStep: { kind: 'tool', stepText: '正在对比 AG-2 定向返工后的 RGB 帧输入与 P95 时延' },
        },
        {
          id: 'agy-1',
          title: 'AG-1·训练',
          role: 'peer',
          workingState: 'idle',
          thinkingSince: null,
          liveStep: null,
        },
        {
          id: 'agy-2',
          title: 'AG-2·推理',
          role: 'peer',
          workingState: 'idle',
          thinkingSince: null,
          liveStep: null,
        },
      ];
    }

    if (!isSyntheticGroup) {
      await selectGroup(previewGroup.id).catch(() => {});
    } else {
      state.selectedGroupId = previewGroup.id;
      els.appRoot.dataset.mobileView = 'chat';
    }

    els.emptyWatermark.hidden = true;
    els.activeChatWrap.hidden = false;

    await loadExternalSessions({ silent: true }).catch(() => {});

    const scopePath = previewGroup.scopePath || '~/projects/cr-ai-model';
    const previewCx = [
      {
        id: 'preview-cx-lead',
        title: 'review/cr-eval · 主审分析验收',
        cwd: scopePath,
        updatedAt: iso(now - 10000),
      },
    ];
    const previewAg = [
      {
        id: 'preview-ag1-train',
        title: 'feat/ppo-reward · 训练管线',
        cwd: scopePath,
        updatedAt: iso(now - 18000),
      },
      {
        id: 'preview-ag2-infer',
        title: 'feat/onnx-infer · 帧同步推理',
        cwd: scopePath,
        updatedAt: iso(now - 12000),
      },
    ];
    state.externalSessions = {
      codex: [...previewCx, ...(state.externalSessions?.codex || [])],
      antigravity: [...previewAg, ...(state.externalSessions?.antigravity || [])],
      recentDirectories: state.externalSessions?.recentDirectories || [scopePath],
    };
    state.externalSessionsLoaded = true;
    state.slotSelectCacheKeys.clear();

    previewGroup.externalThinking = {
      codex: { label: '主审复验中', since: iso(now - 24000) },
    };
    previewGroup.sessionRouting = {
      enabled: true,
      flow: 'discuss_then_exec',
      permission: 'workspace-write',
      autoReview: true,
      autoWake: true,
      slots: [
        {
          slotId: 'codex',
          provider: 'codex',
          label: 'Codex',
          role: 'lead',
          mode: 'existing',
          sessionId: 'preview-cx-lead',
          sessionTitle: 'review/cr-eval · 主审验收',
          cwd: scopePath,
        },
        {
          slotId: 'agy-1',
          provider: 'antigravity',
          label: 'AG-1·训练',
          role: 'peer',
          mode: 'existing',
          sessionId: 'preview-ag1-train',
          sessionTitle: 'feat/ppo-reward · 训练',
          cwd: scopePath,
        },
        {
          slotId: 'agy-2',
          provider: 'antigravity',
          label: 'AG-2·推理',
          role: 'peer',
          mode: 'existing',
          sessionId: 'preview-ag2-infer',
          sessionTitle: 'feat/onnx-infer · 推理',
          cwd: scopePath,
        },
      ],
    };

    state.ideBoardCollapsedByGroup.delete(previewGroup.id);
    state.openIdeSlotDetails.add(`${previewGroup.id}:codex`);
    state.ideBoardsByGroup.set(previewGroup.id, {
      taskTitle: '皇室战争 AI 模型：训练调优与帧同步推理验收',
      stageText: '主审验收第 2 轮 · AG-1 已过审，仅 AG-2 定向返工后复验中',
      round: 2,
      updatedAt: iso(now - 2000),
      actors: {
        codex: {
          actorId: 'codex',
          provider: 'codex',
          role: 'lead',
          title: 'Codex',
          sessionTitle: 'review/cr-eval · 主审',
          phase: 'reviewing',
          phaseLabel: '主审验收中',
          startedAt: iso(now - 24000),
          lastActivityAt: iso(now - 2000),
          subtask: '核对 AG-1 训练收口与 AG-2 RGB 通道返工补丁',
          steps: [
            { status: 'done', title: '确认 AG-1 PPO 奖励收敛，首轮准予通过' },
            { status: 'done', title: '识别 AG-2 BGR 通道偏差，仅打回 AG-2 返工' },
            { status: 'active', title: '复验 AG-2 RGB 对齐补丁与 16ms 帧推理预算' },
          ],
          currentAction: '正在比对 onnx_infer.py RGB 预处理张量与 benchmark P95…',
          recentActions: [
            { ts: iso(now - 4000), text: '跑通回归基准：AG-2 推理 P95 = 11.4ms (< 16ms)' },
          ],
        },
        'agy-1': {
          actorId: 'agy-1',
          provider: 'antigravity',
          role: 'peer',
          title: 'AG-1·训练',
          sessionTitle: 'feat/ppo-reward · 训练',
          phase: 'done',
          phaseLabel: '已验收通过',
          startedAt: iso(now - 95000),
          lastActivityAt: iso(now - 42000),
          subtask: '调优圣水差奖励函数并导出 ONNX 检查点',
          steps: [
            { status: 'done', title: '调整费用差与防塔惩罚权重' },
            { status: 'done', title: '导出 best_policy.onnx 与验证胜率报告' },
          ],
          currentAction: '已通过主审验收，待命',
          recentActions: [
            { ts: iso(now - 42000), text: '提交 best_policy.onnx（验证胜率 +6.4%）' },
          ],
        },
        'agy-2': {
          actorId: 'agy-2',
          provider: 'antigravity',
          role: 'peer',
          title: 'AG-2·推理',
          sessionTitle: 'feat/onnx-infer · 推理',
          phase: 'rework',
          phaseLabel: '定向返工已修',
          startedAt: iso(now - 68000),
          lastActivityAt: iso(now - 12000),
          subtask: '统一 RGB 帧输入并与主循环异步推理对接',
          steps: [
            { status: 'done', title: '按主审反馈将 cv2 BGR 转回 RGB' },
            { status: 'done', title: '实测单帧端到端推理 P95 = 11.4ms' },
          ],
          currentAction: '已提交第 2 轮返工补丁，等待 Codex 主审复验',
          recentActions: [
            { ts: iso(now - 12000), text: '修复 BGR→RGB 通道排列，提交复验' },
          ],
        },
      },
    });

    state.sessionBarOpenByGroup.set(previewGroup.id, false);
    state.thinkingByGroup.set(previewGroup.id, ['codex']);
    state.thinkingStartedAt.set(`${previewGroup.id}:codex`, now - 24000);
    state.relayByGroup.set(previewGroup.id, {
      active: true,
      step: 2,
      text: '主审第 2 轮验收中',
    });

    renderSessionColumn();
    renderActiveHeaderAndRecipients();

    const previewMessages = [
      {
        id: 'preview-msg-user',
        kind: 'chat',
        by: 'user',
        senderTitle: '我',
        isUser: true,
        to: ['codex', 'agy-1', 'agy-2'],
        ts: iso(now - 140000),
        text: 'AG-1 先调优 PPO 奖励并导出权重，AG-2 完成 ONNX 帧同步推理；两边改完后由 Codex 统一分析审查验收。',
      },
      {
        id: 'preview-msg-ag1-done',
        kind: 'chat',
        by: 'agy-1',
        senderTitle: 'AG-1·训练',
        role: 'peer',
        isUser: false,
        to: ['codex'],
        ts: iso(now - 72000),
        sessionReceipt: {
          sessionId: 'preview-ag1-train',
          sessionTitle: 'feat/ppo-reward · 训练',
          permission: 'workspace-write',
          cwd: scopePath,
        },
        text: 'PPO 奖励调优已完成，导出 `best_policy.onnx`（输入形状 `[1, 3, 224, 224]` RGB）。验证集 200 局胜率较基线提升 6.4%，请主审验收。',
      },
      {
        id: 'preview-msg-cx-rework',
        kind: 'chat',
        by: 'codex',
        senderTitle: 'Codex',
        role: 'lead',
        isUser: false,
        to: ['agy-2'],
        ts: iso(now - 45000),
        sessionReceipt: {
          sessionId: 'preview-cx-lead',
          sessionTitle: 'review/cr-eval · 主审',
          permission: 'workspace-write',
          cwd: scopePath,
        },
        thoughtTrace: [
          {
            kind: 'tool',
            text: 'Diff ag1/export_onnx.py vs ag2/onnx_infer.py input tensor channels',
          },
          {
            kind: 'reasoning',
            text: 'AG-1 导出为 RGB，而 AG-2 仍保留 OpenCV 默认 BGR 顺序；AG-1 无需重跑，仅打回 AG-2 定向修正。',
          },
        ],
        text: '第 1 轮审查结论：**AG-1 验收通过**（无需返工）。\n**仅 @AG-2·推理 定向返工**：`onnx_infer.py` 抓帧仍是 BGR，与 AG-1 导出的 RGB 张量不一致；请转成 RGB 并确认 P95 时延 < 16ms 后回报。',
      },
      {
        id: 'preview-msg-ag2-rework',
        kind: 'chat',
        by: 'agy-2',
        senderTitle: 'AG-2·推理',
        role: 'peer',
        isUser: false,
        to: ['codex'],
        ts: iso(now - 14000),
        sessionReceipt: {
          sessionId: 'preview-ag2-infer',
          sessionTitle: 'feat/onnx-infer · 推理',
          permission: 'workspace-write',
          cwd: scopePath,
        },
        text: '已定向修复 `cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)`，连续 300 帧基准测试零告警，端到端 P95 = 11.4ms，已提交主审复验。',
      },
    ];

    state.messagesByGroup.set(previewGroup.id, previewMessages);
    els.messageStream.replaceChildren();
    const frag = document.createDocumentFragment();
    let prevTs = null;
    for (const m of previewMessages) {
      frag.appendChild(await createMessageNode(m, previewGroup, prevTs));
      if (m.ts) prevTs = m.ts;
    }
    els.messageStream.appendChild(frag);
    state.renderedGroupId = previewGroup.id;
    state.renderedMessagesSig = computeMessagesRenderSig(previewGroup.id, previewMessages);

    upsertStreamingBubbleDom(previewGroup.id, {
      streamId: 'preview-stream-cx',
      by: 'codex',
      senderTitle: 'Codex',
      phase: 'tool',
      stepLabel: 'Codex 主审复验中 · 核对 AG-2 RGB 对齐补丁 (24s)',
      text: '已验证 AG-1 权重通道与 AG-2 返回的 RGB 预处理完全匹配，正在汇总整轮验收报告…',
      thoughtTrace: [
        {
          kind: 'reasoning',
          text: '复检 AG-2 补丁：BGR2RGB 已位于裁剪缩放前执行，张量均值与训练集对齐。',
        },
        {
          kind: 'tool',
          text: 'run_shell: pytest tests/test_onnx_infer.py -k rgb_alignment',
        },
      ],
      done: false,
    });

    els.messageStream.scrollTop = els.messageStream.scrollHeight;
    requestAnimationFrame(() => {
      els.messageStream.scrollTop = els.messageStream.scrollHeight;
    });
    document.documentElement.classList.remove('is-window-inactive');
    return;
  }
  if (firstActiveGroup) {
    const isDesktop = !window.matchMedia('(max-width: 768px)').matches;
    if (isDesktop) {
      await selectGroup(firstActiveGroup.id);
    } else {
      els.emptyWatermark.hidden = false;
      els.activeChatWrap.hidden = true;
    }
  } else {
    els.emptyWatermark.hidden = false;
    els.activeChatWrap.hidden = true;
  }

  const syncWindowInactiveState = () => {
    document.documentElement.classList.toggle(
      'is-window-inactive',
      Boolean(document.hidden) || !document.hasFocus()
    );
  };
  window.addEventListener('focus', syncWindowInactiveState);
  window.addEventListener('blur', syncWindowInactiveState);
  document.addEventListener('visibilitychange', syncWindowInactiveState);
  syncWindowInactiveState();

  await consumeAndroidIncomingShare();
  connectLiveEvents();
  loadExternalSessions({ silent: true });
}

initApp().catch((err) => {
  console.error(err);
  showToast(err.message || '初始化失败');
});
