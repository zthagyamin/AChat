import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CcccBridge,
  buildAntigravityLaunchCommand,
  buildCodexLaunchCommand,
  buildReplyStyleDirective,
  computeGroupsFingerprint,
  detectActorSpeedGear,
  extractRolloutLiveStep,
  inspectCodexRolloutForPending,
  normalizeReplyStyle,
  parseMessageAttachments,
  stripSharedContextBlock,
} from '../server/cccc-bridge.mjs';
import {
  computePublicAssetVersion,
  isDirectLocalRequest,
  startAgentWeChatServer,
  validateLocalOpenTarget,
} from '../server/index.mjs';
import {
  decryptBeaconPayload,
  encryptBeaconPayload,
  extractTunnelUrlFromChunk,
} from '../server/tunnel-manager.mjs';

test('CcccBridge never drops SSE message events when readGroupLedger is called by metadata refresh', async () => {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'aw-bridge-test-'));
  const dataDir = path.join(tmpRoot, 'data');
  const groupsDir = path.join(tmpRoot, 'groups');
  const groupId = 'g_test_race';
  const groupFolder = path.join(groupsDir, groupId);
  await fsp.mkdir(groupFolder, { recursive: true });
  await fsp.mkdir(dataDir, { recursive: true });

  const ledgerPath = path.join(groupFolder, 'ledger.jsonl');
  const seedEvent = {
    v: 1,
    id: 'ev-seed-1',
    ts: '2026-11-05T18:30:00.000Z',
    kind: 'chat.message',
    group_id: groupId,
    by: 'user',
    data: { text: '初始消息', to: ['codex', 'antigravity'], message_mode: 'send' },
  };
  await fsp.writeFile(ledgerPath, `${JSON.stringify(seedEvent)}\n`, 'utf8');

  const bridge = new CcccBridge({ dataDir, groupsDir });
  const received = [];
  bridge.on('message', (payload) => received.push(payload));

  // Initial seed read should NOT emit historical messages as live SSE pushes
  await bridge.primeAllLedgers();
  assert.equal(received.length, 0, 'Historical messages should not re-emit on boot');

  // Simulate Codex writing a reply right before a background metadata read (the 02:34 race!)
  const codexReply = {
    v: 1,
    id: 'ev-codex-reply-2',
    ts: new Date().toISOString(),
    kind: 'chat.message',
    group_id: groupId,
    by: 'codex',
    data: {
      actor_id: 'codex',
      sender_title: 'Codex',
      text: '我是主协调者 Codex<!--aw-ctx:start-->不应显示<!--aw-ctx:end-->',
      to: ['user'],
      message_mode: 'send',
    },
  };
  await fsp.appendFile(ledgerPath, `${JSON.stringify(codexReply)}\n`, 'utf8');

  // Call readGroupLedger directly (as listGroups() / getMessages() does) BEFORE pollTimer runs
  await bridge.readGroupLedger(groupId);
  // And then simulate pollTimer running right after
  await bridge.readGroupLedger(groupId);

  assert.equal(received.length, 1, 'Codex reply MUST be emitted exactly once over SSE');
  assert.equal(received[0].message.id, 'ev-codex-reply-2');
  assert.equal(
    received[0].message.text,
    '我是主协调者 Codex',
    'Shared context envelope must be stripped from UI text'
  );

  // Test buildOutgoingMessagePayload includes Codex -> user reply without nesting envelopes
  const wrapped = await bridge.buildOutgoingMessagePayload(groupId, '请 Antigravity 评价上面 Codex 的说法', {
    sharedContext: true,
    fastHint: true,
  });
  assert.match(wrapped, /请 Antigravity 评价上面 Codex 的说法/);
  assert.match(wrapped, /<!--aw-ctx:start-->/);
  assert.match(wrapped, /Codex → 我: 我是主协调者 Codex/);
  assert.doesNotMatch(wrapped, /不应显示/);
  assert.equal(stripSharedContextBlock(wrapped), '请 Antigravity 评价上面 Codex 的说法');

  const unwrapped = await bridge.buildOutgoingMessagePayload(groupId, '纯独立盲测问题', {
    sharedContext: false,
    fastHint: false,
  });
  assert.equal(unwrapped, '纯独立盲测问题');

  bridge.stop();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('Speed gear command builders & setGroupSpeedGear preserve read-only sandbox and avoid flag conflicts', async () => {
  const fastCodex = buildCodexLaunchCommand('C:\\bin\\codex.exe', {
    sandbox: 'read-only',
    gear: 'fast',
  });
  assert.match(fastCodex, /model_reasoning_effort=low/);
  assert.match(fastCodex, /-s read-only/);
  assert.match(fastCodex, /mcp_servers\.blender\.enabled=false/);
  assert.equal(detectActorSpeedGear(fastCodex), 'fast');

  const deepCodex = buildCodexLaunchCommand('C:\\bin\\codex.exe', {
    sandbox: 'read-only',
    gear: 'deep',
  });
  assert.match(deepCodex, /model_reasoning_effort=high/);
  assert.match(deepCodex, /-s read-only/);
  assert.equal(detectActorSpeedGear(deepCodex), 'deep');

  const fastAgy = buildAntigravityLaunchCommand('C:\\bin\\agy.exe', { gear: 'fast' });
  assert.match(fastAgy, /--model gemini-3\.8-flash-low/);
  assert.match(fastAgy, /--disable-slash-commands/);
  assert.doesNotMatch(fastAgy, /--effort/);
  assert.equal(detectActorSpeedGear(fastAgy), 'fast');

  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'aw-gear-test-'));
  const dataDir = path.join(tmpRoot, 'data');
  const groupsDir = path.join(tmpRoot, 'groups');
  const groupId = 'g_gear_1';
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.mkdir(path.join(groupsDir, groupId), { recursive: true });

  const cliCalls = [];
  let currentCodexCmd = ['codex.exe', '-c', 'model_reasoning_effort=high', '-s', 'read-only', '-a', 'never'];
  let currentAgyCmd = ['agy.exe', '--dangerously-skip-permissions'];

  const bridge = new CcccBridge({
    dataDir,
    groupsDir,
    execCcccOverride: async (args) => {
      cliCalls.push(args);
      if (args[0] === 'status') return { stdout: 'Daemon: running\n', stderr: '' };
      if (args[0] === 'actor' && args[1] === 'update') {
        const cmdIdx = args.indexOf('--command');
        const newCmd = args[cmdIdx + 1];
        const actorId = args[args.length - 1];
        if (actorId === 'codex') currentCodexCmd = newCmd.split(' ');
        if (actorId === 'antigravity') currentAgyCmd = newCmd.split(' ');
      }
      return { stdout: '{}', stderr: '' };
    },
    execJsonOverride: async (args) => {
      if (args[0] === 'groups') {
        return { groups: [{ group_id: groupId, title: 'ClassFormer-Collab', running: true }] };
      }
      if (args[0] === 'group' && args[1] === 'show') {
        return {
          group: {
            group_id: groupId,
            actors: [
              { id: 'codex', title: 'Codex', runtime: 'codex', running: true, enabled: true, command: currentCodexCmd },
              { id: 'antigravity', title: 'Antigravity', runtime: 'antigravity', running: true, enabled: true, command: currentAgyCmd },
            ],
          },
        };
      }
      if (args[0] === 'actor' && args[1] === 'list') {
        return {
          actors: [
            { id: 'codex', title: 'Codex', runtime: 'codex', running: true, enabled: true, command: currentCodexCmd },
            { id: 'antigravity', title: 'Antigravity', runtime: 'antigravity', running: true, enabled: true, command: currentAgyCmd },
          ],
        };
      }
      return {};
    },
  });

  const updatedGroups = await bridge.setGroupSpeedGear(groupId, 'fast');
  const g = updatedGroups.find((x) => x.id === groupId);
  assert.equal(g.speedGear, 'fast');
  assert.equal(g.actors.find((a) => a.id === 'codex').readOnly, true, 'Codex read-only sandbox must be preserved');
  assert.ok(cliCalls.some((c) => c[0] === 'actor' && c[1] === 'restart' && c.includes('codex')));
  assert.ok(cliCalls.some((c) => c[0] === 'actor' && c[1] === 'restart' && c.includes('antigravity')));

  bridge.stop();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('Relay (主从自动接力), Blind (双盲独立对撞), Quote & Image Attachment parsing work end-to-end', async () => {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'aw-collab-test-'));
  const dataDir = path.join(tmpRoot, 'data');
  const groupsDir = path.join(tmpRoot, 'groups');
  const uploadsDir = path.join(tmpRoot, 'uploads');
  const groupId = 'g_collab_1';
  const ledgerPath = path.join(groupsDir, groupId, 'ledger.jsonl');
  await fsp.mkdir(path.dirname(ledgerPath), { recursive: true });
  await fsp.mkdir(uploadsDir, { recursive: true });
  await fsp.writeFile(ledgerPath, '', 'utf8');

  const sentCliPayloads = [];
  let seq = 1;

  const bridge = new CcccBridge({
    dataDir,
    groupsDir,
    uploadsDir,
    execCcccOverride: async (args) => {
      if (args[0] === 'status') return { stdout: 'Daemon: running\n', stderr: '' };
      if (args[0] === 'send') {
        const dashIdx = args.indexOf('--');
        const text = args[dashIdx + 1];
        const to = [];
        for (let i = 0; i < dashIdx; i += 1) {
          if (args[i] === '--to') to.push(args[i + 1]);
        }
        sentCliPayloads.push({ to, text });
        const ev = {
          v: 1,
          id: `ev-send-${seq++}`,
          ts: new Date().toISOString(),
          kind: 'chat.message',
          group_id: groupId,
          by: 'user',
          data: { text, to, message_mode: 'send' },
        };
        await fsp.appendFile(ledgerPath, `${JSON.stringify(ev)}\n`, 'utf8');
      }
      return { stdout: '{}', stderr: '' };
    },
    execJsonOverride: async (args) => {
      if (args[0] === 'groups') {
        return { groups: [{ group_id: groupId, title: 'CollabRoom', running: true }] };
      }
      return {
        actors: [
          { id: 'codex', title: 'Codex', runtime: 'codex', running: true, enabled: true, command: ['codex'] },
          { id: 'antigravity', title: 'Antigravity', runtime: 'antigravity', running: true, enabled: true, command: ['agy'] },
        ],
      };
    },
  });

  await bridge.primeAllLedgers();
  const relayEvents = [];
  const messageEvents = [];
  bridge.on('relay', (e) => relayEvents.push(e));
  bridge.on('message', (e) => messageEvents.push(e.message));

  const sampleImg = path.join(uploadsDir, '179390-ui-shot.png');
  const parsedAtt = parseMessageAttachments(`请看截图\n[图片: ${sampleImg}]`, uploadsDir);
  assert.equal(parsedAtt.cleanText, '请看截图');
  assert.equal(parsedAtt.attachments.length, 1);
  assert.equal(parsedAtt.attachments[0].kind, 'image');
  assert.equal(parsedAtt.attachments[0].url, '/api/uploads/179390-ui-shot.png');

  // 1. Trigger Relay mode (Codex -> Antigravity) with quote & image
  await bridge.sendGroupMessage(groupId, {
    text: `分析这张架构图\n[图片: ${sampleImg}]`,
    collabMode: 'relay',
    relayLead: 'codex',
    quote: { sender: 'Codex', text: '上次我们讨论了模块拆分' },
  });

  assert.equal(sentCliPayloads.length, 1);
  assert.deepEqual(sentCliPayloads[0].to, ['codex'], 'Relay Stage 1 must target ONLY the lead agent');
  assert.match(sentCliPayloads[0].text, /> 引用 Codex：上次我们讨论了模块拆分/);
  assert.equal(relayEvents[0]?.step, 1);

  // 2. Simulate Codex posting its Stage 1 draft -> should automatically trigger Stage 2 to Antigravity!
  const codexDraftEv = {
    v: 1,
    id: 'ev-codex-draft-1',
    ts: new Date().toISOString(),
    kind: 'chat.message',
    group_id: groupId,
    by: 'codex',
    data: {
      actor_id: 'codex',
      sender_title: 'Codex',
      text: '初稿结论：建议拆分为桥接层与视图层。',
      to: ['user'],
      message_mode: 'send',
    },
  };
  await fsp.appendFile(ledgerPath, `${JSON.stringify(codexDraftEv)}\n`, 'utf8');
  await bridge.readGroupLedger(groupId);

  // Wait microtask tick for async Stage 2 dispatch
  await new Promise((r) => setTimeout(r, 40));

  assert.equal(sentCliPayloads.length, 2, 'Stage 2 must be dispatched automatically after lead draft');
  assert.deepEqual(sentCliPayloads[1].to, ['antigravity']);
  assert.match(sentCliPayloads[1].text, /^<!--aw-relay-handoff:Codex → Antigravity-->/);
  assert.match(sentCliPayloads[1].text, /初稿结论：建议拆分为桥接层与视图层/);
  assert.ok(
    messageEvents.some(
      (m) => m.kind === 'system' && m.text.includes('🔁 主从接力：已自动将 Codex → Antigravity 复核')
    ),
    'Relay handoff envelope must render as a clean system divider instead of a raw user bubble'
  );

  // 3. Simulate Antigravity posting its Stage 2 review -> closes relay banner
  const agyReviewEv = {
    v: 1,
    id: 'ev-agy-review-1',
    ts: new Date().toISOString(),
    kind: 'chat.message',
    group_id: groupId,
    by: 'antigravity',
    data: {
      actor_id: 'antigravity',
      sender_title: 'Antigravity',
      text: '复核同意，补充一点：SSE 需保留幂等去重。',
      to: ['user'],
      message_mode: 'send',
    },
  };
  await fsp.appendFile(ledgerPath, `${JSON.stringify(agyReviewEv)}\n`, 'utf8');
  await bridge.readGroupLedger(groupId);
  assert.equal(relayEvents[relayEvents.length - 1]?.active, false);

  // 4. Trigger Blind mode -> both agents receive prompt WITHOUT shared context history
  await bridge.sendGroupMessage(groupId, {
    text: '请各自独立评估风险',
    collabMode: 'blind',
  });
  const blindSend = sentCliPayloads[sentCliPayloads.length - 1];
  assert.deepEqual(blindSend.to.sort(), ['antigravity', 'codex']);
  assert.match(blindSend.text, /双盲独立对撞模式/);
  assert.doesNotMatch(blindSend.text, /群聊近期发言同步/, 'Blind mode must NOT leak companion replies');

  bridge.stop();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('Full-text searchMessages matches across group ledgers + file-helper, and sendGroupMessage auto-wakes stopped actors', async () => {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'aw-search-wake-'));
  const dataDir = path.join(tmpRoot, 'data');
  const groupsDir = path.join(tmpRoot, 'groups');
  const groupId = 'g_search_1';
  const ledgerPath = path.join(groupsDir, groupId, 'ledger.jsonl');
  await fsp.mkdir(path.dirname(ledgerPath), { recursive: true });
  await fsp.mkdir(dataDir, { recursive: true });

  const msg1 = {
    v: 1,
    id: 'ev-s-1',
    ts: '2026-11-05T19:00:00.000Z',
    kind: 'chat.message',
    group_id: groupId,
    by: 'codex',
    data: {
      actor_id: 'codex',
      sender_title: 'Codex',
      text: '建议在音频频谱提取阶段使用梅尔滤波器组优化延迟。',
      to: ['user'],
      message_mode: 'send',
    },
  };
  await fsp.writeFile(ledgerPath, `${JSON.stringify(msg1)}\n`, 'utf8');

  const cliActions = [];
  let codexRunning = false;

  const bridge = new CcccBridge({
    dataDir,
    groupsDir,
    execCcccOverride: async (args) => {
      cliActions.push(args);
      if (args[0] === 'status') return { stdout: 'Daemon: running\n', stderr: '' };
      if (args[0] === 'actor' && args[1] === 'start' && args.includes('codex')) {
        codexRunning = true;
      }
      return { stdout: '{}', stderr: '' };
    },
    execJsonOverride: async (args) => {
      if (args[0] === 'groups') {
        return { groups: [{ group_id: groupId, title: 'Audio-Lab', running: true }] };
      }
      return {
        actors: [
          { id: 'codex', title: 'Codex', runtime: 'codex', running: codexRunning, enabled: true, command: ['codex'] },
          { id: 'antigravity', title: 'Antigravity', runtime: 'antigravity', running: true, enabled: true, command: ['agy'] },
        ],
      };
    },
  });

  await bridge.ensureFileHelperSeed();
  await bridge.appendFileHelperMessage('桌面快捷方式已放至 C:\\Users\\demo\\Desktop');
  await bridge.listGroups({ force: true });

  const hits1 = await bridge.searchMessages('梅尔滤波器');
  assert.equal(hits1.length, 1);
  assert.equal(hits1[0].id, 'ev-s-1');
  assert.equal(hits1[0].groupId, groupId);
  assert.equal(hits1[0].groupTitle, 'Audio-Lab');

  const hits2 = await bridge.searchMessages('桌面快捷方式');
  assert.equal(hits2.length, 1);
  assert.equal(hits2[0].groupId, 'file-helper');

  // Sending a message to stopped codex should auto-wake codex before cccc send!
  await bridge.sendGroupMessage(groupId, { text: '@codex 请继续跟进', to: ['codex'] });
  assert.equal(codexRunning, true, 'Stopped target actor must be auto-started before sending');
  const startIdx = cliActions.findIndex((a) => a[0] === 'actor' && a[1] === 'start' && a.includes('codex'));
  const sendIdx = cliActions.findIndex((a) => a[0] === 'send');
  assert.ok(startIdx >= 0 && startIdx < sendIdx, 'actor start must execute before cccc send');

  bridge.stop();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('isDirectLocalRequest blocks reverse-proxy / tunnel headers from bypassing token auth', () => {
  assert.equal(
    isDirectLocalRequest({
      socket: { remoteAddress: '127.0.0.1' },
      headers: { host: '127.0.0.1:8866' },
    }),
    true
  );
  assert.equal(
    isDirectLocalRequest({
      socket: { remoteAddress: '127.0.0.1' },
      headers: { host: 'demo.trycloudflare.com', 'cf-connecting-ip': '203.0.113.9' },
    }),
    false,
    'Cloudflare tunnel traffic arriving on 127.0.0.1 must NEVER bypass token auth'
  );
  assert.equal(
    isDirectLocalRequest({
      socket: { remoteAddress: '127.0.0.1' },
      headers: { host: '127.0.0.1:8866', 'x-forwarded-for': '203.0.113.9' },
    }),
    false
  );
});

test('Tunnel beacon AES-256-GCM encryption hides URLs/tokens, rejects tampering, and extracts real lhr.life URL', () => {
  const token = 'a1b2c3d4e5f60718293a4b5c6d7e8f9011223344';
  const payload = {
    v: 1,
    url: 'https://9e9ce234a56aba.lhr.life',
    lanUrl: 'http://192.168.1.73:8866',
    updatedAt: '2026-11-06T09:30:00.000Z',
  };
  const envelope = encryptBeaconPayload(payload, token);
  const serialized = JSON.stringify(envelope);

  assert.equal(envelope.v, 1);
  assert.equal(envelope.alg, 'AES-256-GCM');
  assert.doesNotMatch(serialized, /lhr\.life/);
  assert.doesNotMatch(serialized, /192\.168\.1\.73/);
  assert.doesNotMatch(serialized, new RegExp(token));

  const roundtrip = decryptBeaconPayload(envelope, token);
  assert.deepEqual(roundtrip, payload);

  // Wrong token MUST fail GCM authentication
  assert.throws(() => decryptBeaconPayload(envelope, 'wrong-token-00000000000000000000'));

  // Tampered ciphertext byte MUST fail GCM authentication
  const ctBuf = Buffer.from(envelope.ct, 'base64');
  ctBuf[0] ^= 0xff;
  assert.throws(() =>
    decryptBeaconPayload({ ...envelope, ct: ctBuf.toString('base64') }, token)
  );

  // Real localhost.run banner (including 16KB+ trailing ANSI QR block) must extract ONLY the assigned .lhr.life origin
  const hugeAnsiQr = '\u001b[7m  \u001b[0m'.repeat(2000);
  const sampleBanner = [
    'Welcome to localhost.run!',
    'To set up and manage custom domains go to https://admin.localhost.run/',
    'More details at https://localhost.run/docs/custom-domains',
    `9e9ce234a56aba.lhr.life tunneled with tls termination, https://9e9ce234a56aba.lhr.life\n${hugeAnsiQr}`,
  ].join('\n');
  assert.equal(extractTunnelUrlFromChunk(sampleBanner), 'https://9e9ce234a56aba.lhr.life');
});

test('readGroupLedger never freezes thinkingActorIds when ledger file stops growing and hides internal <!--aw-retry--> nudges', async () => {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'aw-thinking-decay-'));
  const dataDir = path.join(tmpRoot, 'data');
  const groupsDir = path.join(tmpRoot, 'groups');
  const groupId = 'g_decay_1';
  const ledgerPath = path.join(groupsDir, groupId, 'ledger.jsonl');
  await fsp.mkdir(path.dirname(ledgerPath), { recursive: true });
  await fsp.writeFile(ledgerPath, '', 'utf8');

  const bridge = new CcccBridge({
    dataDir,
    groupsDir,
    execCcccOverride: async () => ({ stdout: 'Daemon: running\n', stderr: '' }),
    execJsonOverride: async () => ({ groups: [] }),
  });

  await bridge.primeAllLedgers();
  const activityEvents = [];
  bridge.on('activity', (ev) => activityEvents.push(ev));

  // Simulate user message sent 5 seconds ago + internal retry nudge
  const fiveSecAgo = new Date(Date.now() - 5000).toISOString();
  const lines = [
    JSON.stringify({
      v: 1,
      id: 'u-msg-1',
      ts: fiveSecAgo,
      kind: 'chat.message',
      group_id: groupId,
      by: 'user',
      data: { text: '测试问题', to: ['codex'] },
    }),
    JSON.stringify({
      v: 1,
      id: 'retry-1',
      ts: new Date().toISOString(),
      kind: 'chat.message',
      group_id: groupId,
      by: 'user',
      data: { text: '<!--aw-retry-->\n内部恢复提示', to: ['codex'] },
    }),
  ];
  await fsp.writeFile(ledgerPath, `${lines.join('\n')}\n`, 'utf8');

  bridge.liveActorStates.set(
    groupId,
    new Map([
      [
        'codex',
        { running: true, workingState: 'idle', activeTaskId: null, stateSource: 'managed_session' },
      ],
    ])
  );

  const firstRead = await bridge.readGroupLedger(groupId);
  assert.equal(firstRead.messages.length, 1, '<!--aw-retry--> must be hidden from chat UI');
  assert.deepEqual(firstRead.thinkingActorIds, ['codex']);

  // Now simulate 25s elapsed WITHOUT touching ledger.jsonl on disk (same size & mtime!)
  firstRead.pendingSince.codex = new Date(Date.now() - 25_000).toISOString();
  const secondRead = await bridge.readGroupLedger(groupId);
  assert.deepEqual(
    secondRead.thinkingActorIds,
    [],
    'Idle managed_session actor must clear thinking state even when ledger.jsonl stops growing'
  );
  assert.deepEqual(activityEvents[activityEvents.length - 1]?.thinkingActorIds, []);

  bridge.stop();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('extractRolloutLiveStep reads Codex rollout tail & interruptOrRetryGroupTurn controls thinking turns', async () => {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'aw-live-step-'));
  const rolloutFile = path.join(tmpRoot, 'rollout-sample.jsonl');

  const lines = [
    JSON.stringify({ timestamp: '2026-11-06T10:57:01Z', type: 'session_meta', payload: {} }),
    JSON.stringify({
      timestamp: '2026-11-06T10:57:10Z',
      type: 'response_item',
      payload: { type: 'reasoning' },
    }),
    JSON.stringify({
      timestamp: '2026-11-06T10:57:20Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '已找到今天更新的真实断点：准备整理 UV 与 Texel 笔记\n' }],
      },
    }),
  ];
  await fsp.writeFile(rolloutFile, `${lines.join('\n')}\n`, 'utf8');

  const step1 = await extractRolloutLiveStep(rolloutFile);
  assert.equal(step1?.kind, 'note');
  assert.match(step1?.stepText || '', /已找到今天更新的真实断点/);

  await fsp.appendFile(
    rolloutFile,
    `${JSON.stringify({
      timestamp: '2026-11-06T10:57:30Z',
      type: 'response_item',
      payload: { type: 'custom_tool_call', name: 'exec' },
    })}\n`,
    'utf8'
  );
  const step2 = await extractRolloutLiveStep(rolloutFile);
  assert.equal(step2?.kind, 'tool');
  assert.match(step2?.stepText || '', /正在执行终端检索/);

  // Test interruptOrRetryGroupTurn
  const dataDir = path.join(tmpRoot, 'data');
  const groupsDir = path.join(tmpRoot, 'groups');
  const groupId = 'g_ctrl_1';
  const ledgerPath = path.join(groupsDir, groupId, 'ledger.jsonl');
  await fsp.mkdir(path.dirname(ledgerPath), { recursive: true });
  await fsp.writeFile(
    ledgerPath,
    `${JSON.stringify({
      v: 1,
      id: 'u-pending-99',
      ts: new Date().toISOString(),
      kind: 'chat.message',
      group_id: groupId,
      by: 'user',
      data: { text: '请整理图形学重点', to: ['codex'] },
    })}\n`,
    'utf8'
  );

  const cliCalls = [];
  const bridge = new CcccBridge({
    dataDir,
    groupsDir,
    execCcccOverride: async (args) => {
      cliCalls.push(args);
      return { stdout: '{}', stderr: '' };
    },
    execJsonOverride: async (args) => {
      if (args[0] === 'groups') {
        return { groups: [{ group_id: groupId, title: 'CG-Study', running: true }] };
      }
      return {
        actors: [
          {
            id: 'codex',
            title: 'Codex',
            runtime: 'codex',
            running: true,
            enabled: true,
            effective_working_state: 'working',
            effective_active_task_id: 'turn-1',
            runtime_state_source: 'managed_session',
            command: ['codex'],
          },
        ],
      };
    },
  });

  await bridge.primeAllLedgers();
  const intRes = await bridge.interruptOrRetryGroupTurn(groupId, { action: 'interrupt' });
  assert.equal(intRes.ok, true);
  assert.ok(cliCalls.some((c) => c[0] === 'actor' && c[1] === 'restart' && c.includes('codex')));
  assert.ok(bridge.cancelledPendingIds.has(`${groupId}:codex:u-pending-99`));

  cliCalls.length = 0;
  const retryRes = await bridge.interruptOrRetryGroupTurn(groupId, {
    action: 'retry',
    actorId: 'codex',
  });
  assert.equal(retryRes.ok, true);
  assert.ok(cliCalls.some((c) => c[0] === 'send' && c.includes('codex')));

  bridge.stop();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('Pinned sessions sort first, validateLocalOpenTarget guards paths, and computePublicAssetVersion tracks edits', async () => {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'aw-pin-ver-'));
  const dataDir = path.join(tmpRoot, 'data');
  const groupsDir = path.join(tmpRoot, 'groups');
  const pubDir = path.join(tmpRoot, 'public');
  await fsp.mkdir(path.join(groupsDir, 'g_older'), { recursive: true });
  await fsp.mkdir(path.join(groupsDir, 'g_newer'), { recursive: true });
  await fsp.mkdir(pubDir, { recursive: true });

  const bridge = new CcccBridge({
    dataDir,
    groupsDir,
    execCcccOverride: async () => ({ stdout: 'Daemon: running\n', stderr: '' }),
    execJsonOverride: async (args) => {
      if (args[0] === 'groups') {
        return {
          groups: [
            { group_id: 'g_older', title: 'OlderPinned', running: true, updated_at: '2026-11-05T01:00:00Z' },
            { group_id: 'g_newer', title: 'NewerNormal', running: true, updated_at: '2026-11-06T12:00:00Z' },
          ],
        };
      }
      return { actors: [] };
    },
  });

  await bridge.setGroupPrefs('g_older', { pinned: true });
  const groups = await bridge.listGroups({ force: true });
  assert.equal(groups[0].id, 'g_older', 'Pinned group must sort ahead of newer unpinned group');
  assert.equal(groups[0].pinned, true);

  const sampleNote = path.join(tmpRoot, '01 考前冲刺.md');
  await fsp.writeFile(sampleNote, '# CG', 'utf8');
  assert.equal(validateLocalOpenTarget(sampleNote), path.resolve(sampleNote));
  assert.equal(validateLocalOpenTarget('https://evil.example/a'), null);
  assert.equal(validateLocalOpenTarget(path.join(tmpRoot, 'missing.md')), null);

  await fsp.writeFile(path.join(pubDir, 'app.mjs'), 'console.log(1);', 'utf8');
  const v1 = await computePublicAssetVersion(pubDir);
  await new Promise((r) => setTimeout(r, 15));
  await fsp.writeFile(path.join(pubDir, 'app.mjs'), 'console.log(222);', 'utf8');
  const v2 = await computePublicAssetVersion(pubDir);
  assert.notEqual(v1, v2);

  bridge.stop();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('updateGroupSettings updates title/topic/Codex sandbox, and manageGroupLifecycle archives/restores/deletes without touching project files', async () => {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'aw-group-mgmt-'));
  const dataDir = path.join(tmpRoot, 'data');
  const groupsDir = path.join(tmpRoot, 'groups');
  const projectDir = path.join(tmpRoot, 'my-project');
  const groupId = 'g_mgmt_1';
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.mkdir(path.join(groupsDir, groupId), { recursive: true });
  await fsp.mkdir(projectDir, { recursive: true });
  const keepFile = path.join(projectDir, 'important.py');
  await fsp.writeFile(keepFile, 'print("safe")\n', 'utf8');

  let mockTitle = 'OldName';
  let mockTopic = 'OldTopic';
  let mockDeleted = false;
  let mockCodexCmd = ['codex', '-c', 'model_reasoning_effort=low', '-s', 'read-only', '-a', 'never'];
  const cliCalls = [];

  const bridge = new CcccBridge({
    dataDir,
    groupsDir,
    execCcccOverride: async (args) => {
      cliCalls.push(args);
      if (args[0] === 'group' && args[1] === 'update') {
        const tIdx = args.indexOf('--title');
        if (tIdx >= 0) mockTitle = args[tIdx + 1];
        const pIdx = args.indexOf('--topic');
        if (pIdx >= 0) mockTopic = args[pIdx + 1];
      }
      if (args[0] === 'actor' && args[1] === 'update') {
        const cIdx = args.indexOf('--command');
        if (cIdx >= 0) mockCodexCmd = args[cIdx + 1].split(/\s+/);
      }
      if (args[0] === 'group' && args[1] === 'delete') {
        mockDeleted = true;
      }
      return { stdout: '{}', stderr: '' };
    },
    execJsonOverride: async (args) => {
      if (args[0] === 'groups') {
        return {
          groups: mockDeleted
            ? []
            : [{ group_id: groupId, title: mockTitle, topic: mockTopic, running: true }],
        };
      }
      if (args[0] === 'group' && args[1] === 'show') {
        return {
          group: {
            group_id: groupId,
            title: mockTitle,
            topic: mockTopic,
            scopes: [{ scope_key: 's1', label: 'proj', url: projectDir }],
            actors: [{ id: 'codex', runtime: 'codex', command: mockCodexCmd }],
          },
          effective_scope: { path: projectDir },
        };
      }
      return {
        actors: [
          {
            id: 'codex',
            title: 'Codex',
            runtime: 'codex',
            running: true,
            enabled: true,
            command: mockCodexCmd,
          },
        ],
      };
    },
  });

  await bridge.loadGroupPrefs();
  const updatedGroups = await bridge.updateGroupSettings(groupId, {
    title: 'CG-Shader-Lab',
    topic: 'GLSL 渲染管线与 PBR 推导',
    codexSandbox: 'workspace-write',
  });
  const target = updatedGroups.find((g) => g.id === groupId);
  assert.equal(target.title, 'CG-Shader-Lab');
  assert.equal(target.topic, 'GLSL 渲染管线与 PBR 推导');
  assert.equal(target.codexSandbox, 'workspace-write');
  assert.ok(cliCalls.some((c) => c[0] === 'group' && c[1] === 'update'));
  assert.ok(
    cliCalls.some(
      (c) =>
        c[0] === 'actor' &&
        c[1] === 'update' &&
        c.some((arg) => String(arg).includes('workspace-write') && String(arg).includes('model_reasoning_effort=low'))
    ),
    'Updating codexSandbox must preserve existing fast/deep speedGear'
  );

  // Archive & restore
  const afterArchive = await bridge.manageGroupLifecycle(groupId, { action: 'archive' });
  assert.equal(afterArchive.groups.find((g) => g.id === groupId)?.archived, true);
  assert.ok(cliCalls.some((c) => c[0] === 'group' && c[1] === 'stop'));

  const afterRestore = await bridge.manageGroupLifecycle(groupId, { action: 'restore' });
  assert.equal(afterRestore.groups.find((g) => g.id === groupId)?.archived, false);

  // Delete requires matching confirmId and never deletes project files
  await assert.rejects(() =>
    bridge.manageGroupLifecycle(groupId, { action: 'delete', confirmId: 'wrong_id' })
  );
  const afterDelete = await bridge.manageGroupLifecycle(groupId, {
    action: 'delete',
    confirmId: groupId,
  });
  assert.ok(!afterDelete.groups.some((g) => g.id === groupId));
  assert.equal(fs.existsSync(keepFile), true, 'Bound project directory must never be touched');

  bridge.stop();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('Cross-device clientSync persists starred messages and custom slash templates across reloads', async () => {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'aw-client-sync-'));
  const dataDir = path.join(tmpRoot, 'data');
  const groupsDir = path.join(tmpRoot, 'groups');
  await fsp.mkdir(groupsDir, { recursive: true });

  const bridge1 = new CcccBridge({
    dataDir,
    groupsDir,
    execCcccOverride: async () => ({ stdout: '{}', stderr: '' }),
    execJsonOverride: async () => ({ groups: [], actors: [] }),
  });

  const syncEvents = [];
  bridge1.on('clientSync', (payload) => syncEvents.push(payload));

  const state1 = await bridge1.mutateClientSyncState({
    upsertStars: [
      {
        id: 'msg-101',
        groupId: 'g_cg',
        groupTitle: 'CG-Lab',
        senderTitle: 'Codex',
        text: '齐次坐标旋转矩阵推导',
        ts: '2026-11-07T10:00:00Z',
      },
    ],
    upsertTemplates: [
      {
        id: 'tpl-my-audit',
        cmd: '/myaudit',
        label: '安全与边界自查',
        prompt: '请检查本次改动是否存在越界、未转义或并发竞争风险。',
      },
    ],
  });

  assert.equal(state1.stars.length, 1);
  assert.equal(state1.stars[0].id, 'msg-101');
  assert.equal(state1.templates.length, 1);
  assert.equal(state1.templates[0].cmd, '/myaudit');
  assert.equal(syncEvents.length, 1);
  bridge1.stop();

  const bridge2 = new CcccBridge({
    dataDir,
    groupsDir,
    execCcccOverride: async () => ({ stdout: '{}', stderr: '' }),
    execJsonOverride: async () => ({ groups: [], actors: [] }),
  });
  const loaded = await bridge2.getClientSyncState();
  assert.equal(loaded.stars.length, 1);
  assert.equal(loaded.templates[0].label, '安全与边界自查');

  const afterRemove = await bridge2.mutateClientSyncState({
    removeStarIds: ['msg-101'],
    removeTemplateIds: ['tpl-my-audit'],
  });
  assert.equal(afterRemove.stars.length, 0);
  assert.equal(afterRemove.templates.length, 0);

  bridge2.stop();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('searchScopeFiles safely indexes bound project files and getScopeGitSummary parses git status & bounded diff', async () => {
  const { execFileSync } = await import('node:child_process');
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'aw-scope-git-'));
  const dataDir = path.join(tmpRoot, 'data');
  const groupsDir = path.join(tmpRoot, 'groups');
  const repoDir = path.join(tmpRoot, 'cg-repo');
  const groupId = 'g_git_1';

  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.mkdir(path.join(groupsDir, groupId), { recursive: true });
  await fsp.mkdir(path.join(repoDir, 'src', 'shaders'), { recursive: true });
  await fsp.mkdir(path.join(repoDir, 'node_modules', 'pkg'), { recursive: true });
  await fsp.writeFile(path.join(repoDir, 'src', 'shaders', 'phong.glsl'), 'vec3 color = vec3(1.0);\n', 'utf8');
  await fsp.writeFile(path.join(repoDir, 'README.md'), '# Phong Demo\n', 'utf8');
  await fsp.writeFile(path.join(repoDir, 'node_modules', 'pkg', 'phong-hidden.js'), 'skip\n', 'utf8');

  execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['add', 'src/shaders/phong.glsl', 'README.md'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'ignore' });

  // Modify tracked file + add untracked file
  await fsp.writeFile(
    path.join(repoDir, 'src', 'shaders', 'phong.glsl'),
    'vec3 color = vec3(0.5, 0.8, 1.0);\n',
    'utf8'
  );
  await fsp.writeFile(path.join(repoDir, 'notes.md'), 'TODO specular\n', 'utf8');

  const bridge = new CcccBridge({
    dataDir,
    groupsDir,
    execCcccOverride: async () => ({ stdout: '{}', stderr: '' }),
    execJsonOverride: async (args) => {
      if (args[0] === 'groups') {
        return { groups: [{ group_id: groupId, title: 'CG-Git', running: true }] };
      }
      if (args[0] === 'group' && args[1] === 'show') {
        return {
          group: {
            group_id: groupId,
            title: 'CG-Git',
            scopes: [{ scope_key: 's1', label: 'cg', url: repoDir }],
          },
          effective_scope: { path: repoDir },
        };
      }
      return { actors: [] };
    },
  });

  const matchedFiles = await bridge.searchScopeFiles(groupId, { query: 'phong' });
  assert.equal(matchedFiles.files.length, 1);
  assert.equal(matchedFiles.files[0].relPath, 'src/shaders/phong.glsl');

  const gitSum = await bridge.getScopeGitSummary(groupId, { file: 'src/shaders/phong.glsl' });
  assert.equal(gitSum.isRepo, true);
  assert.ok(gitSum.changedFiles.some((f) => f.path === 'src/shaders/phong.glsl'));
  assert.ok(gitSum.changedFiles.some((f) => f.path === 'notes.md'));
  assert.match(gitSum.diff, /vec3\(0\.5, 0\.8, 1\.0\)/);

  // Path traversal attempt on file diff must be rejected cleanly
  await assert.rejects(() => bridge.getScopeGitSummary(groupId, { file: '../../outside.txt' }));

  bridge.stop();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('Peer mail does NOT pollute pendingMessageMeta or trigger false-positive Watchdog restarts', async () => {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'aw-peer-mail-'));
  const dataDir = path.join(tmpRoot, 'data');
  const groupsDir = path.join(tmpRoot, 'groups');
  const groupId = 'g_mail_guard';
  const ledgerPath = path.join(groupsDir, groupId, 'ledger.jsonl');
  await fsp.mkdir(path.dirname(ledgerPath), { recursive: true });

  const oldTs = new Date(Date.now() - 25_000).toISOString();
  const peerMailEv = {
    v: 1,
    id: 'ev-agy-mail-1',
    ts: oldTs,
    kind: 'chat.message',
    group_id: groupId,
    by: 'antigravity',
    data: {
      actor_id: 'antigravity',
      sender_title: 'Antigravity',
      message_mode: 'mail',
      to: ['codex'],
      text: '同步核查结果：待用户拍板后再行动，暂缓操作。',
    },
  };
  await fsp.writeFile(ledgerPath, `${JSON.stringify(peerMailEv)}\n`, 'utf8');

  const cliCalls = [];
  const bridge = new CcccBridge({
    dataDir,
    groupsDir,
    enableWatchdogInTests: true,
    execCcccOverride: async (args) => {
      cliCalls.push(args);
      return { stdout: '{}', stderr: '' };
    },
    execJsonOverride: async (args) => {
      if (args[0] === 'groups') {
        return { groups: [{ group_id: groupId, title: 'MailGuard', running: true }] };
      }
      return {
        actors: [
          {
            id: 'codex',
            title: 'Codex',
            runtime: 'codex',
            running: true,
            enabled: true,
            runtime_state_source: 'managed_session',
            effective_working_state: 'idle',
            effective_active_task_id: null,
            command: ['codex'],
          },
        ],
      };
    },
  });

  const ledger = await bridge.readGroupLedger(groupId);
  assert.equal(
    ledger.pendingMessageMeta.codex,
    undefined,
    'Internal peer mail must not be tracked as an unanswered user question'
  );

  await bridge.listGroups({ force: true });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(
    cliCalls.some((c) => c[0] === 'actor' && (c[1] === 'restart' || c[1] === 'start')),
    false,
    'Watchdog must NOT kill/restart Codex over an internal peer mail'
  );

  bridge.stop();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('inspectCodexRolloutForPending & reconcileCodexPendingTurn auto-harvest silent Codex final_answer without duplicating normal replies', async () => {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'aw-harvest-'));
  const dataDir = path.join(tmpRoot, 'data');
  const groupsDir = path.join(tmpRoot, 'groups');
  const sessionsRoot = path.join(tmpRoot, 'codex-sessions');
  const rolloutDir = path.join(sessionsRoot, '2026', '11', '07');
  const groupId = 'g_harvest_1';
  const threadId = '01a1b5cc-test-thread-9999';
  const ledgerPath = path.join(groupsDir, groupId, 'ledger.jsonl');
  const sessionFile = path.join(groupsDir, groupId, 'state', 'runtime_sessions', 'codex.json');
  const rolloutPath = path.join(rolloutDir, `rollout-2026-11-07T20-00-00-${threadId}.jsonl`);

  await fsp.mkdir(path.dirname(sessionFile), { recursive: true });
  await fsp.mkdir(rolloutDir, { recursive: true });
  await fsp.writeFile(
    sessionFile,
    JSON.stringify({ actor_id: 'codex', provider_thread_id: threadId, status: 'usable' }),
    'utf8'
  );

  const userEventId = 'ev-user-silent-codex-1';
  const userAskTs = new Date(Date.now() - 8000).toISOString();
  const completedEpochSec = Math.floor((Date.now() - 4000) / 1000);
  await fsp.writeFile(
    ledgerPath,
    `${JSON.stringify({
      v: 1,
      id: userEventId,
      ts: userAskTs,
      kind: 'chat.message',
      group_id: groupId,
      by: 'user',
      data: { text: '请帮我梳理 UV 与 Texel 的核心区别', to: ['codex'], message_mode: 'send' },
    })}\n`,
    'utf8'
  );

  // Rollout contains: 1) unrelated mail_notice turn, 2) matching userEventId turn that finished in final_answer WITHOUT calling cccc_message_reply (only filtering ALL_TOOLS)
  const rolloutLines = [
    {
      timestamp: new Date(Date.now() - 20000).toISOString(),
      type: 'event_msg',
      payload: { type: 'task_started', turn_attribution: { turn_id: 'turn-mail-0' } },
    },
    {
      timestamp: new Date(Date.now() - 19900).toISOString(),
      type: 'event_msg',
      payload: { type: 'user_message', message: '[cccc] SYSTEM (mail_notice): Mail waiting' },
    },
    {
      timestamp: new Date(Date.now() - 19000).toISOString(),
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'turn-mail-0',
        last_agent_message: '这条内部邮件结论绝不能误发给用户',
        completed_at: completedEpochSec - 15,
      },
    },
    {
      timestamp: new Date(Date.now() - 7000).toISOString(),
      type: 'event_msg',
      payload: { type: 'task_started', turn_attribution: { turn_id: 'turn-silent-1' } },
    },
    {
      timestamp: new Date(Date.now() - 6900).toISOString(),
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: `[cccc] user  codex [event_id=${userEventId} sent=${userAskTs}]:\n请帮我梳理 UV 与 Texel 的核心区别`,
      },
    },
    {
      timestamp: new Date(Date.now() - 6000).toISOString(),
      type: 'event_msg',
      payload: { type: 'agent_message', phase: 'commentary', message: '我先检索一下图形学笔记。' },
    },
    {
      timestamp: new Date(Date.now() - 5500).toISOString(),
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        name: 'exec',
        input: 'const m = ALL_TOOLS.filter(x=>/cccc_message_reply/.test(x.name));',
      },
    },
    {
      timestamp: new Date(Date.now() - 4000).toISOString(),
      type: 'event_msg',
      payload: {
        type: 'agent_message',
        phase: 'final_answer',
        message: 'UV 是归一化纹理坐标 [0,1]，而 Texel 是纹理图像上的离散纹素单元。',
      },
    },
    {
      timestamp: new Date(Date.now() - 4000).toISOString(),
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'turn-silent-1',
        last_agent_message: 'UV 是归一化纹理坐标 [0,1]，而 Texel 是纹理图像上的离散纹素单元。',
        completed_at: completedEpochSec,
      },
    },
  ];
  await fsp.writeFile(rolloutPath, rolloutLines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');

  const inspected = await inspectCodexRolloutForPending(rolloutPath, [userEventId]);
  assert.equal(inspected.matched, true);
  assert.equal(inspected.completed, true);
  assert.equal(inspected.calledCcccSend, false, 'Regex .filter() check must not count as an actual cccc_message_reply call');
  assert.match(inspected.finalAnswerText, /UV 是归一化纹理坐标/);
  assert.doesNotMatch(inspected.finalAnswerText, /我先检索一下/);

  const replyCliCalls = [];
  const bridge = new CcccBridge({
    dataDir,
    groupsDir,
    codexSessionsRoot: sessionsRoot,
    enableWatchdogInTests: true,
    execCcccOverride: async (args) => {
      if (args[0] === 'reply') {
        replyCliCalls.push(args);
        const dashIdx = args.indexOf('--');
        const replyTo = args[dashIdx + 1];
        const replyText = args[dashIdx + 2];
        const ev = {
          v: 1,
          id: 'ev-harvested-codex-1',
          ts: new Date().toISOString(),
          kind: 'chat.message',
          group_id: groupId,
          by: 'codex',
          data: {
            actor_id: 'codex',
            sender_title: 'Codex',
            reply_to: replyTo,
            text: replyText,
            to: ['user'],
            message_mode: 'send',
          },
        };
        await fsp.appendFile(ledgerPath, `${JSON.stringify(ev)}\n`, 'utf8');
      }
      return { stdout: '{}', stderr: '' };
    },
    execJsonOverride: async (args) => {
      if (args[0] === 'groups') {
        return { groups: [{ group_id: groupId, title: 'CG-Study', running: true }] };
      }
      return {
        actors: [
          {
            id: 'codex',
            title: 'Codex',
            runtime: 'codex',
            running: true,
            enabled: true,
            runtime_state_source: 'managed_session',
            effective_working_state: 'idle',
            effective_active_task_id: null,
            command: ['codex'],
          },
        ],
      };
    },
  });

  await bridge.primeAllLedgers();
  const sseMessages = [];
  bridge.on('message', (e) => sseMessages.push(e.message));

  await bridge.listGroups({ force: true });
  await new Promise((r) => setTimeout(r, 60));

  // Second call must be idempotent and NOT harvest again
  await bridge.listGroups({ force: true });
  await new Promise((r) => setTimeout(r, 40));

  assert.equal(replyCliCalls.length, 1, 'Silent Codex final_answer must be harvested into group ledger exactly once');
  assert.equal(sseMessages.length, 1, 'Harvested Codex bubble must emit over SSE immediately');
  assert.equal(sseMessages[0].by, 'codex');
  assert.match(sseMessages[0].text, /UV 是归一化纹理坐标/);

  bridge.stop();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('Watchdog recovery preserves usable codex.json on Attempt 1 and waits until pty_quiet_seconds settles before sending retry', async () => {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'aw-ready-retry-'));
  const dataDir = path.join(tmpRoot, 'data');
  const groupsDir = path.join(tmpRoot, 'groups');
  const groupId = 'g_ready_1';
  const ledgerPath = path.join(groupsDir, groupId, 'ledger.jsonl');
  const sessionFile = path.join(groupsDir, groupId, 'state', 'runtime_sessions', 'codex.json');
  await fsp.mkdir(path.dirname(sessionFile), { recursive: true });
  await fsp.writeFile(
    sessionFile,
    JSON.stringify({ actor_id: 'codex', provider_thread_id: '01a1-keep-me', status: 'usable' }),
    'utf8'
  );
  await fsp.writeFile(
    ledgerPath,
    `${JSON.stringify({
      v: 1,
      id: 'ev-dropped-1',
      ts: new Date(Date.now() - 18_000).toISOString(),
      kind: 'chat.message',
      group_id: groupId,
      by: 'user',
      data: { text: '测试冷启动断连恢复', to: ['codex'], message_mode: 'send' },
    })}\n`,
    'utf8'
  );

  let pollCount = 0;
  let quietAtSend = -1;
  let currentQuietSec = 0;

  const bridge = new CcccBridge({
    dataDir,
    groupsDir,
    composerMinWaitMs: 20,
    composerPollIntervalMs: 15,
    execCcccOverride: async (args) => {
      if (args[0] === 'send') {
        quietAtSend = currentQuietSec;
      }
      return { stdout: '{"event_id":"ev-retry-sent-1"}', stderr: '' };
    },
    execJsonOverride: async (args) => {
      if (args[0] === 'actor' && args[1] === 'list') {
        pollCount += 1;
        // First 2 polls simulate ConPTY still churning (pty_quiet_seconds = 0), 3rd poll settles (pty_quiet_seconds = 3)
        currentQuietSec = pollCount < 3 ? 0 : 3;
        return {
          actors: [
            {
              id: 'codex',
              running: true,
              effective_working_state: 'idle',
              pty_quiet_seconds: currentQuietSec,
            },
          ],
        };
      }
      return { groups: [] };
    },
  });

  await bridge.healActorBinaryOrDroppedTurn(
    groupId,
    { id: 'codex', runtime: 'codex', running: true, command: ['codex'] },
    { id: 'ev-dropped-1', text: '测试冷启动断连恢复' },
    { wipeSession: false }
  );

  assert.equal(
    fs.existsSync(sessionFile),
    true,
    'Attempt 1 soft-heal must preserve usable runtime_sessions/codex.json conversation memory'
  );
  assert.ok(
    quietAtSend >= 2,
    `Retry message must wait until ConPTY output settles (pty_quiet_seconds >= 2), got ${quietAtSend}`
  );

  bridge.stop();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});


test('Stale managed_session working flag clears after actor reply, background listGroups caches group show, and computeGroupsFingerprint ignores PTY noise', async () => {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'aw-perf-guard-'));
  const dataDir = path.join(tmpRoot, 'data');
  const groupsDir = path.join(tmpRoot, 'groups');
  const groupId = 'g_perf_1';
  const ledgerPath = path.join(groupsDir, groupId, 'ledger.jsonl');
  await fsp.mkdir(path.dirname(ledgerPath), { recursive: true });
  await fsp.mkdir(dataDir, { recursive: true });

  const tenMinAgo = new Date(Date.now() - 600_000).toISOString();
  const nineMinAgo = new Date(Date.now() - 540_000).toISOString();
  const ledgerLines = [
    JSON.stringify({
      v: 1,
      id: 'ev-user-q1',
      ts: tenMinAgo,
      kind: 'chat.message',
      group_id: groupId,
      by: 'user',
      data: { text: '测试图形学同步', to: ['codex'], message_mode: 'send' },
    }),
    JSON.stringify({
      v: 1,
      id: 'ev-codex-a1',
      ts: nineMinAgo,
      kind: 'chat.message',
      group_id: groupId,
      by: 'codex',
      data: { actor_id: 'codex', sender_title: 'Codex', text: '已同步完毕', to: ['user'], message_mode: 'send' },
    }),
  ];
  await fsp.writeFile(ledgerPath, `${ledgerLines.join('\n')}\n`, 'utf8');

  let groupShowCalls = 0;
  let ptyTick = 0;
  const emittedGroupsEvents = [];

  const bridge = new CcccBridge({
    dataDir,
    groupsDir,
    execCcccOverride: async () => ({ stdout: 'Daemon: running\n', stderr: '' }),
    execJsonOverride: async (args) => {
      if (args[0] === 'groups') {
        return { groups: [{ group_id: groupId, title: 'ClassFormer-Collab', running: true }] };
      }
      if (args[0] === 'group' && args[1] === 'show') {
        groupShowCalls += 1;
        return {
          group: {
            group_id: groupId,
            topic: 'CG 协作',
            scopes: [{ scope_key: 's1', label: 'room', url: 'E:\\room' }],
          },
        };
      }
      if (args[0] === 'actor' && args[1] === 'list') {
        ptyTick += 1;
        return {
          actors: [
            {
              id: 'codex',
              title: 'Codex',
              runtime: 'codex',
              running: true,
              enabled: true,
              effective_working_state: 'working',
              effective_working_updated_at: tenMinAgo,
              effective_active_task_id: 'stale-turn-id',
              runtime_state_source: 'managed_session',
              pty_last_output_at: new Date(Date.now() + ptyTick * 1000).toISOString(),
              command: ['codex'],
            },
          ],
        };
      }
      return {};
    },
  });

  bridge.on('groups', (g) => emittedGroupsEvents.push(g));
  await bridge.ensureFileHelperSeed();
  await bridge.primeAllLedgers();

  const firstGroups = await bridge.listGroups({ force: true });
  const g1 = firstGroups.find((g) => g.id === groupId);
  assert.equal(
    g1.actors[0].workingState,
    'idle',
    'Actor that already answered pending user message must normalize stale managed_session working -> idle'
  );
  assert.equal(groupShowCalls, 1);
  assert.equal(emittedGroupsEvents.length, 1);

  const secondGroups = await bridge.listGroups({ background: true });
  assert.equal(groupShowCalls, 1, 'Background listGroups must reuse cached group show within TTL');
  assert.equal(
    computeGroupsFingerprint(firstGroups),
    computeGroupsFingerprint(secondGroups),
    'computeGroupsFingerprint must ignore volatile pty_last_output_at ticks'
  );
  assert.equal(
    emittedGroupsEvents.length,
    1,
    'Unchanged group fingerprint must not re-emit redundant groups events'
  );

  bridge.stop();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});


test('replyStyle defaults to plain, switches 0ms via setGroupPrefs, and injects style directives across free/blind/relay Stage-2 while keeping bubbles clean', async () => {
  assert.equal(normalizeReplyStyle(''), 'plain');
  assert.equal(normalizeReplyStyle('invalid'), 'plain');
  assert.equal(normalizeReplyStyle('balanced'), 'balanced');
  assert.equal(normalizeReplyStyle('pro'), 'pro');
  assert.match(buildReplyStyleDirective('plain'), /💬 人话精简/);
  assert.match(buildReplyStyleDirective('balanced'), /⚖️ 适中清晰/);
  assert.match(buildReplyStyleDirective('pro'), /🔬 专业深度/);

  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'aw-reply-style-'));
  const dataDir = path.join(tmpRoot, 'data');
  const groupsDir = path.join(tmpRoot, 'groups');
  const groupId = 'g_style_1';
  const ledgerPath = path.join(groupsDir, groupId, 'ledger.jsonl');
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.mkdir(path.dirname(ledgerPath), { recursive: true });
  await fsp.writeFile(ledgerPath, '', 'utf8');

  const sentPayloads = [];
  const bridge = new CcccBridge({
    dataDir,
    groupsDir,
    execCcccOverride: async (args) => {
      if (args[0] === 'send') {
        const dashIdx = args.indexOf('--');
        const wireText = dashIdx >= 0 ? args[dashIdx + 1] : '';
        sentPayloads.push({ args, wireText });
        const ev = {
          v: 1,
          id: `ev-${sentPayloads.length}`,
          ts: new Date().toISOString(),
          kind: 'chat.message',
          group_id: groupId,
          by: 'user',
          data: {
            text: wireText,
            to: ['codex'],
          },
        };
        await fsp.appendFile(ledgerPath, `${JSON.stringify(ev)}\n`, 'utf8');
      }
      return { stdout: '{}', stderr: '' };
    },
    execJsonOverride: async (args) => {
      if (args[0] === 'groups') {
        return { groups: [{ group_id: groupId, title: 'StyleRoom', running: true }] };
      }
      if (args[0] === 'group' && args[1] === 'show') {
        return { group: { group_id: groupId, title: 'StyleRoom', scopes: [] } };
      }
      if (args[0] === 'actor' && args[1] === 'list') {
        return {
          actors: [
            {
              id: 'codex',
              title: 'Codex',
              runtime: 'codex',
              running: true,
              enabled: true,
              effective_working_state: 'idle',
              command: ['codex'],
            },
            {
              id: 'antigravity',
              title: 'Antigravity',
              runtime: 'antigravity',
              running: true,
              enabled: true,
              effective_working_state: 'idle',
              command: ['agy'],
            },
          ],
        };
      }
      return {};
    },
  });

  await bridge.ensureFileHelperSeed();
  const initialGroups = await bridge.listGroups({ force: true });
  const target = initialGroups.find((g) => g.id === groupId);
  assert.equal(target.replyStyle, 'plain', 'Groups should default to plain (💬 人话) style');

  // 1. Default send uses plain directive and keeps bubble text clean
  const sent1 = await bridge.sendGroupMessage(groupId, { text: '刚才你们在聊什么？' });
  assert.equal(sent1.text, '刚才你们在聊什么？', 'Visible chat bubble must strip hidden directive block');
  assert.match(sentPayloads[0].wireText, /💬 人话精简/);

  // 2. Switch to balanced via setGroupPrefs without restarting any actor
  await bridge.setGroupPrefs(groupId, { replyStyle: 'balanced' });
  const afterBalancedGroups = await bridge.listGroups({ force: true });
  assert.equal(afterBalancedGroups.find((g) => g.id === groupId).replyStyle, 'balanced');
  await bridge.sendGroupMessage(groupId, { text: '用适中模式讲讲光线追踪', collabMode: 'blind' });
  assert.match(sentPayloads[1].wireText, /⚖️ 适中清晰/);
  assert.match(sentPayloads[1].wireText, /双盲独立对撞模式/);

  // 3. Switch to pro and verify relay Stage-1 + Stage-2 handoff both carry 🔬 专业深度
  await bridge.setGroupPrefs(groupId, { replyStyle: 'pro', collabMode: 'relay', relayLead: 'codex' });
  await bridge.sendGroupMessage(groupId, { text: '推导一下渲染方程的蒙特卡洛估计量' });
  assert.match(sentPayloads[2].wireText, /🔬 专业深度/);
  assert.match(sentPayloads[2].wireText, /主从自动接力 1\/2/);

  // Simulate Codex Stage-1 reply arriving so Stage-2 handoff triggers
  await bridge.handleRelayProgressOnMessage(groupId, {
    id: 'ev-codex-draft-1',
    kind: 'chat',
    isUser: false,
    by: 'codex',
    senderTitle: 'Codex',
    to: ['user'],
    text: '蒙特卡洛估计量通过重要性采样 p(ω) 近似半球积分。',
  });
  assert.equal(sentPayloads.length, 4, 'Relay Stage-2 handoff should be dispatched to reviewer');
  assert.match(sentPayloads[3].wireText, /🔬 专业深度/, 'Relay Stage-2 reviewer must inherit replyStyle');
  assert.match(sentPayloads[3].wireText, /主从自动接力 2\/2/);

  bridge.stop();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});


test('v1.5.4: setGroupSpeedGear preserves usable codex.json, Watchdog nudges unsubmitted PTY Enter before restart, and terminal PTY thinking tracks live output past 90s', async () => {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'aw-v154-fix-'));
  const dataDir = path.join(tmpRoot, 'data');
  const groupsDir = path.join(tmpRoot, 'groups');
  const sessionsRoot = path.join(tmpRoot, 'codex-sessions');
  const rolloutDir = path.join(sessionsRoot, '2026', '11', '08');
  const groupId = 'g_deep_unjam';
  const threadId = '01a1b7b1-keep-usable-thread';
  const ledgerPath = path.join(groupsDir, groupId, 'ledger.jsonl');
  const sessionFile = path.join(groupsDir, groupId, 'state', 'runtime_sessions', 'codex.json');
  const rolloutFile = path.join(rolloutDir, `rollout-2026-11-08T04-26-53-${threadId}.jsonl`);

  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.mkdir(path.dirname(sessionFile), { recursive: true });
  await fsp.mkdir(rolloutDir, { recursive: true });

  await fsp.writeFile(
    sessionFile,
    JSON.stringify({ status: 'usable', resume_eligible: true, provider_thread_id: threadId }),
    'utf8'
  );
  await fsp.writeFile(
    rolloutFile,
    `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'session_meta', payload: { id: threadId } })}\n`,
    'utf8'
  );

  // User sent a message 9.5 seconds ago; Codex PTY accepted paste into input box but never submitted Enter
  const msgTs = new Date(Date.now() - 9_500).toISOString();
  await fsp.writeFile(
    ledgerPath,
    `${JSON.stringify({
      v: 1,
      id: 'ev-unsubmitted-1',
      ts: msgTs,
      kind: 'chat.message',
      group_id: groupId,
      by: 'user',
      data: { text: '请和 antigravity 商量分工方案', to: ['codex', 'antigravity'], message_mode: 'send' },
    })}\n`,
    'utf8'
  );

  const cliCalls = [];
  const enterNudgeCalls = [];
  const bridge = new CcccBridge({
    dataDir,
    groupsDir,
    codexSessionsRoot: sessionsRoot,
    enableWatchdogInTests: true,
    composerMinWaitMs: 5,
    composerPollIntervalMs: 5,
    ptyEnterNudgeOverride: async (gid, aid) => {
      enterNudgeCalls.push({ groupId: gid, actorId: aid });
      return true;
    },
    execCcccOverride: async (args) => {
      cliCalls.push(args);
      return { stdout: '{}', stderr: '' };
    },
    execJsonOverride: async (args) => {
      if (args[0] === 'groups') {
        return { groups: [{ group_id: groupId, title: 'DeepUnjam', running: true }] };
      }
      if (args[0] === 'group' && args[1] === 'show') {
        return {
          group: {
            group_id: groupId,
            title: 'DeepUnjam',
            scopes: [],
            actors: [
              { id: 'codex', title: 'Codex', runtime: 'codex', command: ['codex', '-s', 'read-only'] },
              { id: 'antigravity', title: 'Antigravity', runtime: 'antigravity', command: ['agy'] },
            ],
          },
        };
      }
      if (args[0] === 'actor' && args[1] === 'list') {
        return {
          actors: [
            {
              id: 'codex',
              title: 'Codex',
              runtime: 'codex',
              running: true,
              enabled: true,
              runtime_state_source: 'managed_session',
              effective_working_state: 'idle',
              effective_active_task_id: null,
              pty_quiet_seconds: 4,
              command: ['codex', '-s', 'read-only'],
            },
            {
              id: 'antigravity',
              title: 'Antigravity',
              runtime: 'antigravity',
              running: true,
              enabled: true,
              runtime_state_source: 'terminal',
              effective_working_state: 'waiting',
              effective_active_task_id: null,
              pty_quiet_seconds: 1,
              command: ['agy'],
            },
          ],
        };
      }
      return {};
    },
  });

  try {
    await bridge.ensureFileHelperSeed();

    // 1. Watchdog at 9.5s should nudge PTY Enter gently WITHOUT restarting Codex
    await bridge.listGroups({ force: true });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(enterNudgeCalls.length, 1, 'Should send gentle PTY Enter nudge when message sits unsubmitted');
    assert.deepEqual(enterNudgeCalls[0], { groupId, actorId: 'codex' });
    assert.equal(
      cliCalls.some((c) => c[0] === 'actor' && c[1] === 'restart'),
      false,
      'Must NOT kill/restart Codex before giving PTY Enter nudge a chance to start the turn'
    );

    // 2. setGroupSpeedGear must preserve usable codex.json (avoiding 1632-char boot prompt paste)
    await bridge.setGroupSpeedGear(groupId, 'deep');
    assert.equal(
      fs.existsSync(sessionFile),
      true,
      'setGroupSpeedGear must preserve usable codex.json so Codex resumes thread instead of pasting 1632-char prompt'
    );

    // Only unlink codex.json if status === "resume_failed"
    await fsp.writeFile(sessionFile, JSON.stringify({ status: 'resume_failed' }), 'utf8');
    await bridge.setGroupSpeedGear(groupId, 'fast');
    assert.equal(
      fs.existsSync(sessionFile),
      false,
      'setGroupSpeedGear should unlink codex.json when status is resume_failed'
    );

    // 3. Terminal PTY actor (Antigravity) thinking indicator stays active past 90s while PTY is outputting
    const threeMinAgo = new Date(Date.now() - 180_000).toISOString();
    bridge.liveActorStates.set(
      groupId,
      new Map([
        [
          'antigravity',
          {
            running: true,
            workingState: 'waiting',
            stateSource: 'terminal',
            ptyQuietSeconds: 2,
            lastOutputAt: new Date(Date.now() - 2_000).toISOString(),
          },
        ],
      ])
    );
    const activeThinking = bridge.computeThinkingActorIds(
      groupId,
      {},
      { antigravity: threeMinAgo },
      { antigravity: { id: 'ev-deep-1', ts: threeMinAgo, text: 'deep task' } },
      Date.now(),
      {}
    );
    assert.deepEqual(
      activeThinking,
      ['antigravity'],
      'Antigravity in deep mode must keep thinking status past 90s while PTY has live token output'
    );

    // Once PTY has been completely quiet for >= 25s past the initial window, thinking clears
    bridge.liveActorStates.set(
      groupId,
      new Map([
        [
          'antigravity',
          {
            running: true,
            workingState: 'waiting',
            stateSource: 'terminal',
            ptyQuietSeconds: 45,
            lastOutputAt: new Date(Date.now() - 45_000).toISOString(),
          },
        ],
      ])
    );
    const quietThinking = bridge.computeThinkingActorIds(
      groupId,
      {},
      { antigravity: threeMinAgo },
      { antigravity: { id: 'ev-deep-1', ts: threeMinAgo, text: 'deep task' } },
      Date.now(),
      {}
    );
    assert.deepEqual(quietThinking, [], 'Quiet terminal PTY past 120s should clear thinking status');
  } finally {
    bridge.stop();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('v1.6.0: Target session discovery, direct multi-session dispatch (with auto-bind on new session), and discuss_then_exec pipeline work end-to-end', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'aw-session-router-'));
  const dataDir = path.join(tmpRoot, 'data');
  const groupsDir = path.join(tmpRoot, 'groups');
  const codexHome = path.join(tmpRoot, 'codex-home');
  const agyHome = path.join(tmpRoot, 'agy-home');
  const projDir = path.join(tmpRoot, 'clash-royale-proj');
  const groupId = 'g_target_sess';
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.mkdir(path.join(groupsDir, groupId), { recursive: true });
  await fsp.mkdir(codexHome, { recursive: true });
  await fsp.mkdir(agyHome, { recursive: true });
  await fsp.mkdir(projDir, { recursive: true });
  await fsp.writeFile(path.join(groupsDir, groupId, 'ledger.jsonl'), '', 'utf8');

  // Seed mock Codex state_5.sqlite with 1 real thread + 1 internal CCCC noise thread
  const codexDb = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'));
  codexDb.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      title TEXT,
      name TEXT,
      first_user_message TEXT,
      preview TEXT,
      cwd TEXT,
      source TEXT,
      sandbox_policy TEXT,
      updated_at INTEGER,
      archived INTEGER DEFAULT 0
    );
  `);
  const insCodex = codexDb.prepare(
    'INSERT INTO threads (id, title, name, first_user_message, preview, cwd, source, sandbox_policy, updated_at, archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  insCodex.run(
    '01a1b7be-912d-7d72-847c-cb1bc7385f4d',
    '皇室战争模拟训练环境搭建',
    '',
    '搭建 8 卡戈仑石人高速模拟赛场',
    '',
    `\\\\?\\${projDir}`,
    'vscode',
    'workspace-write',
    1794084448,
    0
  );
  insCodex.run(
    '01a1b7ac-6d8d-7692-a0bd-189511313e25',
    'CCCC Actor',
    '',
    '[cccc] SYSTEM: internal',
    '',
    'E:\\cccc-room',
    'vscode',
    'read-only',
    1794085000,
    0
  );
  codexDb.close();

  // Seed mock Antigravity conversation_summaries.db with 1 real top-level conversation + 1 subagent
  const agyDb = new DatabaseSync(path.join(agyHome, 'conversation_summaries.db'));
  agyDb.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      preview TEXT NOT NULL DEFAULT '',
      workspace_uris TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT '',
      parent_conversation_id TEXT NOT NULL DEFAULT '',
      nesting_depth INTEGER NOT NULL DEFAULT 0,
      not_fully_idle NUMERIC NOT NULL DEFAULT 0,
      killed NUMERIC NOT NULL DEFAULT 0,
      last_modified_time TEXT NOT NULL
    );
  `);
  const insAgy = agyDb.prepare(
    'INSERT INTO conversation_summaries (conversation_id, title, preview, workspace_uris, status, parent_conversation_id, nesting_depth, not_fully_idle, killed, last_modified_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  insAgy.run(
    'da06ac00-62cf-4048-9483-28b89479a795',
    '皇室战争全自动战斗方案',
    '我想制作一个东西帮助实现皇室战争全自动战斗',
    JSON.stringify([`file:///${projDir.replace(/\\/g, '/')}`]),
    'CASCADE_RUN_STATUS_IDLE',
    '',
    0,
    0,
    0,
    '2026-11-08 04:40:00+08:00'
  );
  insAgy.run(
    'sub-1111-2222',
    'Subagent research',
    'internal subagent',
    '[]',
    'CASCADE_RUN_STATUS_IDLE',
    'da06ac00-62cf-4048-9483-28b89479a795',
    1,
    0,
    0,
    '2026-11-08 04:41:00+08:00'
  );
  agyDb.close();

  const cliCalls = [];
  const extRunnerCalls = [];
  const emittedMessages = [];

  const bridge = new CcccBridge({
    dataDir,
    groupsDir,
    codexHomeDir: codexHome,
    antigravityDataDir: agyHome,
    externalSessionRunnerOverride: async (params) => {
      extRunnerCalls.push(params);
      if (params.phase === 'discuss_lead') {
        return {
          ok: true,
          sessionId: 'plan-codex',
          text: '建议分工：Codex 负责模拟器核心数值与单元测试，Antigravity 负责屏幕识别桥接与面板。',
        };
      }
      if (params.phase === 'discuss_peer') {
        return {
          ok: true,
          sessionId: 'plan-agy',
          text: '同意该无重叠分工，两边现在按此接口直接落盘实现。',
        };
      }
      if (params.agent === 'codex') {
        return {
          ok: true,
          sessionId: params.mode === 'new' ? '01a1-new-codex-999' : params.sessionId,
          text: `Codex 已在目标会话完成模拟器模块（权限=${params.permission}）。`,
        };
      }
      return {
        ok: true,
        sessionId: params.mode === 'new' ? 'agy-new-888' : params.sessionId,
        text: `Antigravity 已在原会话完成视觉识别接入（权限=${params.permission}）。`,
      };
    },
    execCcccOverride: async (args) => {
      cliCalls.push(args);
      return { stdout: '{}', stderr: '' };
    },
    execJsonOverride: async (args) => {
      if (args[0] === 'groups') {
        return { groups: [{ group_id: groupId, title: 'SessionDispatchRoom', running: true }] };
      }
      if (args[0] === 'group' && args[1] === 'show') {
        return {
          effective_scope: { path: projDir },
          group: {
            group_id: groupId,
            title: 'SessionDispatchRoom',
            scopes: [{ scope_key: 's1', label: 'proj', url: projDir }],
            actors: [
              { id: 'codex', title: 'Codex', runtime: 'codex', command: ['codex', '-s', 'read-only'] },
              { id: 'antigravity', title: 'Antigravity', runtime: 'antigravity', command: ['agy'] },
            ],
          },
        };
      }
      if (args[0] === 'actor' && args[1] === 'list') {
        return {
          actors: [
            { id: 'codex', title: 'Codex', runtime: 'codex', running: true, enabled: true, command: ['codex', '-s', 'read-only'] },
            { id: 'antigravity', title: 'Antigravity', runtime: 'antigravity', running: true, enabled: true, command: ['agy'] },
          ],
        };
      }
      return {};
    },
  });

  bridge.on('message', (ev) => emittedMessages.push(ev.message));

  try {
    await bridge.ensureFileHelperSeed();
    await bridge.readGroupLedger(groupId);

    // 1. Discover local sessions cleanly (excluding CCCC Actor & subagents)
    const catalog = await bridge.listExternalSessions({ force: true });
    assert.equal(catalog.codex.length, 1, 'Should discover 1 real Codex session and filter CCCC Actor');
    assert.equal(catalog.codex[0].id, '01a1b7be-912d-7d72-847c-cb1bc7385f4d');
    assert.equal(catalog.codex[0].cwd, projDir);
    assert.equal(catalog.codex[0].sandbox, 'workspace-write');

    assert.equal(catalog.antigravity.length, 1, 'Should discover 1 top-level Antigravity conversation and filter subagent');
    assert.equal(catalog.antigravity[0].id, 'da06ac00-62cf-4048-9483-28b89479a795');
    assert.equal(catalog.antigravity[0].cwd, projDir);

    // 2. Configure sessionRouting (Codex -> new session in projDir, Antigravity -> existing da06ac00, flow -> direct, permission -> workspace-write)
    await bridge.setGroupPrefs(groupId, {
      sessionRouting: {
        enabled: true,
        flow: 'direct',
        permission: 'workspace-write',
        codex: { mode: 'new', cwd: projDir, sessionTitle: '新建项目会话' },
        antigravity: {
          mode: 'existing',
          sessionId: 'da06ac00-62cf-4048-9483-28b89479a795',
          sessionTitle: '皇室战争全自动战斗方案',
          cwd: projDir,
        },
      },
    });

    const groupsBefore = await bridge.listGroups({ force: true });
    const gInfo = groupsBefore.find((g) => g.id === groupId);
    assert.equal(gInfo.sessionRouting.flow, 'direct');
    assert.equal(gInfo.sessionRouting.permission, 'workspace-write');
    assert.equal(gInfo.sessionRouting.codex.mode, 'new');

    // 3. Send direct multi-session task -> dispatches to BOTH external sessions without waking internal cccc PTY actors
    await bridge.sendGroupMessage(groupId, {
      text: '请立即搭建第一版状态接口与动作桥接',
      to: ['@all'],
    });

    // Wait for async parallel dispatch to finish
    for (let i = 0; i < 40 && extRunnerCalls.length < 2; i += 1) {
      await new Promise((r) => setTimeout(r, 15));
    }
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(extRunnerCalls.length, 2, 'Should invoke external runner for both Codex and Antigravity');
    assert.equal(
      cliCalls.some((c) => c[0] === 'send' && (c.includes('codex') || c.includes('antigravity')) && c[c.indexOf('--by') + 1] === 'user'),
      false,
      'Must NOT trigger internal cccc PTY actors when dispatching to external sessions'
    );

    // Verify new Codex session auto-upgraded from mode="new" to mode="existing" with id="01a1-new-codex-999"
    const groupsAfterDirect = await bridge.listGroups({ force: true });
    const gAfter = groupsAfterDirect.find((g) => g.id === groupId);
    assert.equal(gAfter.sessionRouting.codex.mode, 'existing', 'New session should auto-bind to created sessionId for seamless follow-up');
    assert.equal(gAfter.sessionRouting.codex.sessionId, '01a1-new-codex-999');

    const msgsAfterDirect = await bridge.getMessages(groupId);
    assert.equal(msgsAfterDirect.length, 3, 'Should contain 1 user bubble + 2 external session agent reply bubbles');
    assert.ok(msgsAfterDirect.some((m) => m.by === 'codex' && m.sessionReceipt?.sessionId === '01a1-new-codex-999'));
    assert.ok(msgsAfterDirect.some((m) => m.by === 'antigravity' && m.sessionReceipt?.sessionId === 'da06ac00-62cf-4048-9483-28b89479a795'));

    // 4. Switch to discuss_then_exec ("🤝 先商量再派入指定会话") and verify 3-stage pipeline
    extRunnerCalls.length = 0;
    await bridge.setGroupPrefs(groupId, {
      sessionRouting: {
        ...gAfter.sessionRouting,
        flow: 'discuss_then_exec',
        permission: 'inherit',
      },
    });

    await bridge.sendGroupMessage(groupId, {
      text: '第二阶段：先商量训练评估指标分工，对齐后直接在各自会话落地',
      to: ['@all'],
    });

    for (let i = 0; i < 50 && extRunnerCalls.length < 4; i += 1) {
      await new Promise((r) => setTimeout(r, 15));
    }
    await new Promise((r) => setTimeout(r, 40));

    assert.equal(extRunnerCalls.length, 4, 'discuss_then_exec should run 2 alignment turns + 2 target session execution turns');
    assert.equal(extRunnerCalls[0].phase, 'discuss_lead');
    assert.equal(extRunnerCalls[1].phase, 'discuss_peer');
    const execPhases = extRunnerCalls.slice(2).map((c) => c.agent).sort();
    assert.deepEqual(execPhases, ['antigravity', 'codex']);
  } finally {
    bridge.stop();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('v1.7.0 streaming frames, session preview, tail pagination, and single-actor retry work end-to-end', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'aw-v170-suite-'));
  const dataDir = path.join(tmpRoot, 'data');
  const groupsDir = path.join(tmpRoot, 'groups');
  const codexHome = path.join(tmpRoot, 'codex-home');
  const agyHome = path.join(tmpRoot, 'agy-home');
  const projDir = path.join(tmpRoot, 'cr-sim');
  const groupId = 'g_v170';

  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.mkdir(path.join(groupsDir, groupId), { recursive: true });
  await fsp.mkdir(projDir, { recursive: true });
  await fsp.mkdir(codexHome, { recursive: true });

  // 1. Seed Codex rollout file + state_5.sqlite with rollout_path & git_branch
  const codexRolloutPath = path.join(codexHome, 'rollout-cr-01.jsonl');
  const codexLines = [
    JSON.stringify({
      timestamp: '2026-11-08T05:10:00Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: '帮我核对皇家巨人普攻帧数与射程配置' },
    }),
    JSON.stringify({
      timestamp: '2026-11-08T05:10:08Z',
      type: 'event_msg',
      payload: { type: 'agent_message', message: '已核对：射程 6.5 格，首击帧与攻速间隔均已写入单元测试。' },
    }),
  ];
  await fsp.writeFile(codexRolloutPath, `${codexLines.join('\n')}\n`, 'utf8');

  const codexDb = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'));
  codexDb.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      cwd TEXT NOT NULL,
      title TEXT NOT NULL,
      sandbox_policy TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      first_user_message TEXT NOT NULL DEFAULT '',
      git_branch TEXT
    );
  `);
  codexDb
    .prepare(
      `INSERT INTO threads (id, rollout_path, updated_at, source, cwd, title, sandbox_policy, archived, first_user_message, git_branch)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      'codex-prev-001',
      codexRolloutPath,
      1794114608,
      'vscode',
      projDir,
      '皇室模拟器帧率核验',
      '{"type":"workspace-write"}',
      0,
      '帮我核对皇家巨人普攻帧数与射程配置',
      'feat/sim-core'
    );
  codexDb.close();

  // 2. Seed Antigravity conversation_summaries.db + transcript.jsonl
  const agyConvId = 'agy-prev-002';
  const agyLogDir = path.join(agyHome, 'brain', agyConvId, '.system_generated', 'logs');
  await fsp.mkdir(agyLogDir, { recursive: true });
  const agyTranscriptLines = [
    JSON.stringify({
      step_index: 1,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      created_at: '2026-11-08T05:12:00Z',
      content: '<USER_REQUEST>\n请把圣水条识别阈值调优并汇报准确率\n</USER_REQUEST>',
    }),
    JSON.stringify({
      step_index: 2,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-08T05:12:09Z',
      content: '已完成圣水条 HSV + 模板双校验调优，200 帧样本准确率 99.5%。',
    }),
  ];
  await fsp.writeFile(
    path.join(agyLogDir, 'transcript.jsonl'),
    `${agyTranscriptLines.join('\n')}\n`,
    'utf8'
  );

  const agyDb = new DatabaseSync(path.join(agyHome, 'conversation_summaries.db'));
  agyDb.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT,
      preview TEXT,
      workspace_uris TEXT,
      status TEXT,
      parent_conversation_id TEXT,
      nesting_depth INTEGER,
      not_fully_idle INTEGER,
      killed INTEGER,
      last_modified_time TEXT
    );
  `);
  agyDb
    .prepare(
      `INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      agyConvId,
      '圣水条视觉识别调优',
      '请把圣水条识别阈值调优',
      JSON.stringify([`file:///${projDir.replace(/\\/g, '/')}`]),
      'CASCADE_RUN_STATUS_IDLE',
      '',
      0,
      0,
      0,
      '2026-11-08 05:12:09+08:00'
    );
  agyDb.close();

  const streamFrames = [];
  const runnerInvocations = [];
  const cliCalls = [];
  let codexAttempt = 0;

  const bridge = new CcccBridge({
    dataDir,
    groupsDir,
    codexHomeDir: codexHome,
    antigravityDataDir: agyHome,
    externalSessionRunnerOverride: async (params) => {
      runnerInvocations.push(params);
      if (params.agent === 'codex') {
        codexAttempt += 1;
        params.onProgress?.({
          stepLabel: '⚙️ 正在执行命令：npm test',
          text: '正在运行模拟器测试…',
        });
        await new Promise((r) => setTimeout(r, 110));
        if (codexAttempt === 1) {
          return {
            ok: false,
            sessionId: 'codex-prev-001',
            text: '⚠️ Codex 临时连接超时，请点击单独重试。',
          };
        }
        params.onProgress?.({
          stepLabel: '✍️ Codex 正在流式生成回复…',
          text: '重试成功：全部 24 项帧同步断言通过！',
        });
        return {
          ok: true,
          sessionId: 'codex-prev-001',
          text: '重试成功：全部 24 项帧同步断言通过！',
        };
      }
      params.onProgress?.({
        stepLabel: '✍️ Antigravity 正在流式生成回复…',
        text: 'Antigravity 视觉层一步到位通过。',
      });
      return {
        ok: true,
        sessionId: agyConvId,
        text: 'Antigravity 视觉层一步到位通过。',
      };
    },
    execCcccOverride: async (args) => {
      cliCalls.push(args);
      return { stdout: '{}', stderr: '' };
    },
    execJsonOverride: async (args) => {
      if (args[0] === 'groups') {
        return { groups: [{ group_id: groupId, title: 'V170Room', running: true }] };
      }
      if (args[0] === 'group' && args[1] === 'show') {
        return {
          effective_scope: { path: projDir },
          group: {
            group_id: groupId,
            title: 'V170Room',
            scopes: [{ scope_key: 's1', label: 'sim', url: projDir }],
            actors: [
              { id: 'codex', title: 'Codex', runtime: 'codex', command: ['codex', '-s', 'workspace-write'] },
              { id: 'antigravity', title: 'Antigravity', runtime: 'antigravity', command: ['agy'] },
            ],
          },
        };
      }
      if (args[0] === 'actor' && args[1] === 'list') {
        return {
          actors: [
            { id: 'codex', title: 'Codex', runtime: 'codex', running: true, enabled: true, command: ['codex', '-s', 'workspace-write'] },
            { id: 'antigravity', title: 'Antigravity', runtime: 'antigravity', running: true, enabled: true, command: ['agy'] },
          ],
        };
      }
      return {};
    },
  });

  bridge.on('stream', (frame) => streamFrames.push(frame));

  try {
    await bridge.ensureFileHelperSeed();
    await bridge.readGroupLedger(groupId);

    // A. Verify Session Preview for both Codex and Antigravity
    const codexPreview = await bridge.getExternalSessionPreview('codex', 'codex-prev-001', {
      maxItems: 3,
    });
    assert.equal(codexPreview.title, '皇室模拟器帧率核验');
    assert.equal(codexPreview.cwd, projDir);
    assert.equal(codexPreview.gitBranch, 'feat/sim-core');
    assert.equal(codexPreview.items.length, 2);
    assert.equal(codexPreview.items[0].role, 'user');
    assert.match(codexPreview.items[1].text, /射程 6\.5 格/);

    const agyPreview = await bridge.getExternalSessionPreview('antigravity', agyConvId, {
      maxItems: 3,
    });
    assert.equal(agyPreview.title, '圣水条视觉识别调优');
    assert.equal(agyPreview.items.length, 2);
    assert.equal(agyPreview.items[0].role, 'user');
    assert.equal(agyPreview.items[0].text, '请把圣水条识别阈值调优并汇报准确率');
    assert.match(agyPreview.items[1].text, /99\.5%/);

    // B. Verify real-time streaming frames + failed Codex bubble with ok=false & retryMeta
    await bridge.setGroupPrefs(groupId, {
      sessionRouting: {
        enabled: true,
        flow: 'direct',
        permission: 'workspace-write',
        codex: {
          mode: 'existing',
          sessionId: 'codex-prev-001',
          sessionTitle: '皇室模拟器帧率核验',
          cwd: projDir,
        },
        antigravity: {
          mode: 'existing',
          sessionId: agyConvId,
          sessionTitle: '圣水条视觉识别调优',
          cwd: projDir,
        },
      },
    });

    await bridge.sendGroupMessage(groupId, {
      text: '执行全套联调测试并汇报',
      to: ['@all'],
    });

    for (let i = 0; i < 40 && runnerInvocations.length < 2; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 150));

    assert.ok(
      streamFrames.some((f) => f.by === 'codex' && f.done === false && /npm test/.test(f.stepLabel || '')),
      'Should emit live tool stepLabel stream frame for Codex'
    );
    assert.ok(
      streamFrames.some((f) => f.by === 'codex' && f.done === true),
      'Should emit terminal done=true stream frame so UI cleans up live placeholder'
    );

    const msgsAfterFirst = await bridge.getMessages(groupId);
    const failedCodexBubble = msgsAfterFirst.find((m) => m.by === 'codex');
    assert.ok(failedCodexBubble, 'Codex failure bubble should be recorded');
    assert.equal(failedCodexBubble.ok, false);
    assert.match(failedCodexBubble.retryMeta?.prompt || '', /^执行全套联调测试并汇报/);

    // C. Verify retrySingleActor ONLY retries Codex without waking Antigravity!
    runnerInvocations.length = 0;
    const retryRes = await bridge.retrySingleActor(groupId, {
      actorId: 'codex',
      messageId: failedCodexBubble.id,
    });
    assert.equal(retryRes.ok, true);
    assert.equal(retryRes.mode, 'external');

    for (let i = 0; i < 60 && (await bridge.getMessages(groupId)).length < 4; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }

    assert.equal(runnerInvocations.length, 1, 'Single-actor retry must invoke ONLY Codex');
    assert.equal(runnerInvocations[0].agent, 'codex');

    const msgsAfterRetry = await bridge.getMessages(groupId);
    assert.equal(msgsAfterRetry.length, 4, 'Should now have 1 user + 1 agy + 1 failed codex + 1 retried codex');
    assert.match(msgsAfterRetry[3].text, /全部 24 项帧同步断言通过/);
    assert.equal(msgsAfterRetry[3].ok, true);

    // D. Verify getMessagesSlice tail pagination & beforeIndex cursor
    const pageTail = await bridge.getMessagesSlice(groupId, { limit: 2 });
    assert.equal(pageTail.totalCount, 4);
    assert.equal(pageTail.startIndex, 2);
    assert.equal(pageTail.hasMore, true);
    assert.equal(pageTail.messages.length, 2);
    assert.equal(pageTail.messages[1].id, msgsAfterRetry[3].id);

    const pageOlder = await bridge.getMessagesSlice(groupId, {
      limit: 2,
      beforeIndex: pageTail.startIndex,
    });
    assert.equal(pageOlder.startIndex, 0);
    assert.equal(pageOlder.hasMore, false);
    assert.equal(pageOlder.messages.length, 2);
    assert.equal(pageOlder.messages[0].id, msgsAfterRetry[0].id);
  } finally {
    bridge.stop();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('v1.7.1: Plan A read-only SQLite snapshot bridges Desktop Antigravity WAL trajectories to CLI without touching Desktop DB, and external dispatches do not re-parse main ledger', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const {
    discoverLocalSessions,
    ensureAntigravityCliTrajectory,
    executeExternalAgentTurn,
    readExternalSessionPreview,
  } = await import('../server/session-router.mjs');

  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'aw-v171-snap-'));
  const desktopAgyDir = path.join(tmpRoot, 'gemini', 'antigravity');
  const cliAgyDir = path.join(tmpRoot, 'gemini', 'antigravity-cli');
  const codexHome = path.join(tmpRoot, 'codex');
  const dataDir = path.join(tmpRoot, 'data');
  const groupsDir = path.join(tmpRoot, 'groups');
  const projDir = path.join(tmpRoot, 'clash-royale');

  await fsp.mkdir(path.join(desktopAgyDir, 'conversations'), { recursive: true });
  await fsp.mkdir(path.join(desktopAgyDir, 'annotations'), { recursive: true });
  await fsp.mkdir(path.join(cliAgyDir, 'conversations'), { recursive: true });
  await fsp.mkdir(codexHome, { recursive: true });
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.mkdir(groupsDir, { recursive: true });
  await fsp.mkdir(projDir, { recursive: true });

  const desktopConvId = 'da06ac00-62cf-4048-9483-28b89479a795';
  const cliOnlyConvId = 'c1100000-1111-4222-8333-444444444444';

  // 1. Seed Desktop conversation_summaries.db + CLI conversation_summaries.db
  for (const [dir, cid, title, appDir] of [
    [desktopAgyDir, desktopConvId, '皇室战争', 'antigravity'],
    [cliAgyDir, cliOnlyConvId, 'CLI 独立调试会话', 'antigravity-cli'],
  ]) {
    const sumDb = new DatabaseSync(path.join(dir, 'conversation_summaries.db'));
    sumDb.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT,
        preview TEXT,
        workspace_uris TEXT,
        status TEXT,
        parent_conversation_id TEXT,
        nesting_depth INTEGER,
        not_fully_idle INTEGER,
        killed INTEGER,
        last_modified_time TEXT,
        app_data_dir TEXT
      );
    `);
    sumDb
      .prepare(`INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        cid,
        title,
        `${title} 摘要`,
        JSON.stringify([`file:///${projDir.replace(/\\/g, '/')}`]),
        'CASCADE_RUN_STATUS_IDLE',
        '',
        0,
        0,
        0,
        '2026-11-09 00:20:00+08:00',
        appDir
      );
    sumDb.close();
  }

  // 2. Keep an active read-write WAL connection open on Desktop's trajectory DB to simulate live Desktop IDE!
  const desktopConvDbPath = path.join(desktopAgyDir, 'conversations', `${desktopConvId}.db`);
  const liveDesktopWriter = new DatabaseSync(desktopConvDbPath);
  liveDesktopWriter.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE trajectory_meta (trajectory_id TEXT PRIMARY KEY, cascade_id TEXT, trajectory_type INTEGER, source INTEGER);
    CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, payload TEXT);
    INSERT INTO trajectory_meta VALUES ('traj-cr-1', '${desktopConvId}', 4, 1);
    INSERT INTO steps VALUES (1, 1, '石头人推进卡组胜率分析');
  `);
  await fsp.writeFile(
    path.join(desktopAgyDir, 'annotations', `${desktopConvId}.pbtxt`),
    'title:"皇室战争"\n',
    'utf8'
  );
  const desktopStatBefore = await fsp.stat(desktopConvDbPath);

  try {
    // A. Both Desktop and CLI sessions are discovered with sourceSurface labels
    const discovered = await discoverLocalSessions({
      codexHomeDir: codexHome,
      antigravityDataDir: desktopAgyDir,
      antigravityCliDataDir: cliAgyDir,
      limit: 20,
    });
    const foundDesktop = discovered.antigravity.find((s) => s.id === desktopConvId);
    const foundCli = discovered.antigravity.find((s) => s.id === cliOnlyConvId);
    assert.ok(foundDesktop, 'Should discover Desktop Antigravity conversation');
    assert.equal(foundDesktop.sourceSurface, 'desktop');
    assert.ok(foundCli, 'Should discover CLI Antigravity conversation');
    assert.equal(foundCli.sourceSurface, 'cli');

    // Preview resolves CLI-only session too
    const cliPrev = await readExternalSessionPreview({
      agent: 'antigravity',
      sessionId: cliOnlyConvId,
      codexHomeDir: codexHome,
      antigravityDataDir: desktopAgyDir,
      antigravityCliDataDir: cliAgyDir,
    });
    assert.equal(cliPrev.title, 'CLI 独立调试会话');

    // B. ensureAntigravityCliTrajectory snapshots live WAL DB into CLI conversations without mutating Desktop DB!
    const snapRes = await ensureAntigravityCliTrajectory({
      sessionId: desktopConvId,
      antigravityDataDir: desktopAgyDir,
      antigravityCliDataDir: cliAgyDir,
    });
    assert.equal(snapRes.bridged, true);
    const cliConvDbPath = path.join(cliAgyDir, 'conversations', `${desktopConvId}.db`);
    assert.equal(fs.existsSync(cliConvDbPath), true, 'CLI trajectory snapshot DB should be created');

    const cliCheckDb = new DatabaseSync(cliConvDbPath, { readOnly: true });
    const copiedSteps = cliCheckDb.prepare('SELECT * FROM steps').all();
    cliCheckDb.close();
    assert.equal(copiedSteps.length, 1);
    assert.equal(copiedSteps[0].payload, '石头人推进卡组胜率分析');

    const desktopStatAfter = await fsp.stat(desktopConvDbPath);
    assert.equal(
      desktopStatAfter.mtimeMs,
      desktopStatBefore.mtimeMs,
      'Desktop trajectory DB must remain 100% untouched (zero writes)'
    );

    // C. Verify executeExternalAgentTurn ignores pre-user_input replayed step_updates and returns only current turn reply
    const fakeAgyScript = path.join(tmpRoot, 'fake-agy.mjs');
    await fsp.writeFile(
      fakeAgyScript,
      `
      const lines = [
        JSON.stringify({ event: 'init', conversation_id: '${desktopConvId}' }),
        JSON.stringify({ event: 'step_update', step_update: { conversation_id: '${desktopConvId}', step_index: 5, step_type: 'agent_response', text_delta: '旧轮历史回放不应混入' } }),
        JSON.stringify({ event: 'step_update', step_update: { conversation_id: '${desktopConvId}', step_index: 6, step_type: 'user_input' } }),
        JSON.stringify({ event: 'step_update', step_update: { conversation_id: '${desktopConvId}', step_index: 7, step_type: 'agent_response', text_delta: '本轮控制流针对性改进方案已就绪。' } }),
        JSON.stringify({ event: 'result', result: { conversation_id: '${desktopConvId}', status: 'ERROR', response: '本轮控制流针对性改进方案已就绪。', error: 'historical transient network warning' } }),
      ];
      for (const l of lines) console.log(l);
      `,
      'utf8'
    );
    const turnRes = await executeExternalAgentTurn({
      agent: 'antigravity',
      mode: 'existing',
      sessionId: desktopConvId,
      cwd: projDir,
      prompt: '继续提高面对控制流卡组的胜率',
      agyBin: process.execPath,
      agyExtraLeadArgs: [fakeAgyScript],
      antigravityDataDir: desktopAgyDir,
      antigravityCliDataDir: cliAgyDir,
    });
    assert.equal(turnRes.ok, true);
    assert.equal(turnRes.text, '本轮控制流针对性改进方案已就绪。');

    // D. Verify external dispatch appends do NOT re-read/re-parse main ledger.jsonl
    const groupId = 'g_no_reparse';
    const ledgerPath = path.join(groupsDir, groupId, 'ledger.jsonl');
    await fsp.mkdir(path.dirname(ledgerPath), { recursive: true });
    await fsp.writeFile(
      ledgerPath,
      `${JSON.stringify({
        v: 1,
        id: 'ev-base-1',
        ts: '2026-11-09T00:00:00.000Z',
        kind: 'chat.message',
        group_id: groupId,
        by: 'user',
        data: { text: '初始主账本消息', to: ['codex'] },
      })}\n`,
      'utf8'
    );

    const bridge = new CcccBridge({
      dataDir,
      groupsDir,
      execCcccOverride: async () => ({ stdout: 'Daemon: running\n', stderr: '' }),
      execJsonOverride: async () => ({ groups: [] }),
    });
    try {
      await bridge.readGroupLedger(groupId, { seedOnly: true });
      const baseParseCountBefore = bridge.ledgerParseStats?.get(groupId) || 0;
      assert.equal(baseParseCountBefore, 1);

      await bridge.appendExternalDispatchMessage(groupId, {
        by: 'antigravity',
        isUser: false,
        senderTitle: 'Antigravity',
        to: ['user'],
        text: '跨会话直达消息 1',
      });
      await bridge.appendExternalDispatchMessage(groupId, {
        by: 'codex',
        isUser: false,
        senderTitle: 'Codex',
        to: ['user'],
        text: '跨会话直达消息 2',
      });

      const baseParseCountAfter = bridge.ledgerParseStats?.get(groupId) || 0;
      assert.equal(
        baseParseCountAfter,
        1,
        'Appending external session messages must NOT re-parse unchanged main ledger.jsonl'
      );
      const allMsgs = await bridge.getMessages(groupId);
      assert.equal(allMsgs.length, 3);

      // 5. Frontend v1.7.1 lag & path-chip copy hygiene checks
      const appSrc = fs.readFileSync(
        path.join(process.cwd(), 'public', 'app.mjs'),
        'utf8'
      );
      const cssSrc = fs.readFileSync(
        path.join(process.cwd(), 'public', 'styles.css'),
        'utf8'
      );
      assert.ok(
        appSrc.includes('btn.dataset.pathIcon =') && appSrc.includes('btn.textContent = winPath;'),
        'Path chips must render icon via CSS pseudo-element so copied text stays pure path'
      );
      assert.ok(
        cssSrc.includes('.local-path-chip::before') && cssSrc.includes('html.is-window-inactive'),
        'CSS must style path chip icon pseudo-element and pause animations when window is inactive'
      );
      assert.ok(
        appSrc.includes('computeMessagesRenderSig') && appSrc.includes('lastSendHintText'),
        'Frontend must memoize send-bar DOM writes and message stream render signatures'
      );

      // Ensure linear PROSE_WIN_PATH_RE completes in <10ms on long pathological lines with spaces & quotes
      const proseRe =
        /[A-Za-z]:\\[^\s"'<>|?*()[\]`，。；：！？、（）【】「」\\]+(?:[ \\][^\s"'<>|?*()[\]`，。；：！？、（）【】「」\\]+)*\\?/g;
      const pathological = `{"event":"init","cwd":"e:\\${'workspace project '.repeat(60)}","tools":["ask_permission"]}`;
      const t0 = performance.now();
      const hits = pathological.match(proseRe) || [];
      const elapsedMs = performance.now() - t0;
      assert.equal(hits.length, 1);
      assert.ok(elapsedMs < 15, `Expected O(N) path regex <15ms, got ${elapsedMs.toFixed(2)}ms`);
    } finally {
      bridge.stop();
    }
  } finally {
    try {
      liveDesktopWriter.close();
    } catch {}
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('v2.0.0 Fusion Hub: Inline Approval/Choice Cards, One-Click Git & Worktree, Multi-CLI & Persona, Tailscale & Computer Preview', async () => {
  const {
    buildAgentPersonaDirective,
    captureHostScreenPreview,
    detectProviderEcosystem,
    executeExtraProviderTurn,
    executeGitWorkspaceAction,
    extractInteractiveCardFromMessage,
    normalizeAgentProfiles,
    parseOptionsCardInput,
    parseTailscaleStatusJson,
    stderrDiagnosticOf,
  } = await import('../server/fusion-hub.mjs');
  const { execFileSync } = await import('node:child_process');

  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'aw-fusion-v200-'));
  try {
    // 1. OpenMausBot-style Options Card & Inline Approval Card extraction
    const parsedCard = parseOptionsCardInput({
      title: '请选择数据库迁移策略',
      options: [
        { key: 'A', label: '增量迁移（推荐）', summary: '零停机保留旧表', recommended: true },
        { key: 'B', label: '全量重建', summary: '清空测试库重建索引' },
      ],
    });
    assert.equal(parsedCard.options.length, 2);
    assert.equal(parsedCard.options[0].recommended, true);

    const abcMsg = {
      id: 'msg-abc-1',
      kind: 'chat',
      by: 'antigravity',
      isUser: false,
      senderTitle: 'Antigravity',
      text: [
        '需要先确认缓存方案，请回复字母选择：',
        '- **A（推荐）**：内存 LRU + 磁盘快照，零外部依赖且延迟最低',
        '- **B**：引入本地 SQLite 缓存表，持久化强但多一次查询',
        '- **C**：保持现状暂不缓存',
      ].join('\n'),
    };
    const choiceCard = extractInteractiveCardFromMessage(abcMsg);
    assert.ok(choiceCard, 'Natural A/B/C decision prompt should produce an interactive choice card');
    assert.equal(choiceCard.kind, 'choice');
    assert.equal(choiceCard.options.length, 3);
    assert.equal(choiceCard.options[0].key, 'A');
    assert.equal(choiceCard.options[0].recommended, true);

    const roBlockedMsg = {
      id: 'msg-ro-1',
      kind: 'chat',
      by: 'codex',
      isUser: false,
      senderTitle: 'Codex',
      sessionReceipt: { permission: 'read-only' },
      text: '当前处于只读模式（read-only），无法直接修改 `server/index.mjs`。如需我直接落地修改，请授予可写权限后继续。',
    };
    const approvalCard = extractInteractiveCardFromMessage(roBlockedMsg, { groupReadOnly: true });
    assert.ok(approvalCard, 'Read-only permission block should produce an inline approval card');
    assert.equal(approvalCard.kind, 'approval');
    assert.equal(approvalCard.suggestedPermission, 'workspace-write');

    // 2. T3 Code-style One-Click Git Commit, File Discard & Isolated Worktree Sandbox
    const repoDir = path.join(tmpRoot, 'demo-repo');
    await fsp.mkdir(repoDir, { recursive: true });
    execFileSync('git', ['init'], { cwd: repoDir, windowsHide: true });
    execFileSync('git', ['config', 'user.email', 'test@achat.local'], { cwd: repoDir, windowsHide: true });
    execFileSync('git', ['config', 'user.name', 'AChat Test'], { cwd: repoDir, windowsHide: true });
    await fsp.writeFile(path.join(repoDir, 'app.js'), 'export const v = 1;\n', 'utf8');

    const commit1 = await executeGitWorkspaceAction(repoDir, {
      action: 'stage-commit',
      message: 'feat: initial seed',
    });
    assert.equal(commit1.ok, true);
    assert.ok(commit1.commitHash.length >= 7);

    // Modify tracked file + test path traversal guard + discard-file revert
    await fsp.writeFile(path.join(repoDir, 'app.js'), 'export const v = 999;\n', 'utf8');
    await assert.rejects(
      () => executeGitWorkspaceAction(repoDir, { action: 'discard-file', file: '../outside.js' }),
      /目录以外|非法/
    );
    const discardRes = await executeGitWorkspaceAction(repoDir, {
      action: 'discard-file',
      file: 'app.js',
    });
    assert.equal(discardRes.ok, true);
    assert.equal(
      (await fsp.readFile(path.join(repoDir, 'app.js'), 'utf8')).replace(/\r\n/g, '\n'),
      'export const v = 1;\n'
    );

    // Create, list, and remove an isolated Git Worktree sandbox
    const wtCreated = await executeGitWorkspaceAction(repoDir, {
      action: 'worktree-create',
      name: 'codex-sandbox',
    });
    assert.equal(wtCreated.ok, true);
    assert.ok(fs.existsSync(wtCreated.worktreePath), 'Isolated worktree directory must exist');
    assert.match(wtCreated.branch, /^achat\/codex-sandbox/);

    const wtList = await executeGitWorkspaceAction(repoDir, { action: 'worktree-list' });
    assert.equal(wtList.ok, true);
    assert.ok(wtList.worktrees.length >= 2);
    assert.ok(wtList.worktrees.some((w) => w.isManaged && w.branch === wtCreated.branch));

    // Main repo must NEVER be removable via worktree-remove
    await assert.rejects(
      () => executeGitWorkspaceAction(repoDir, { action: 'worktree-remove', worktreePath: repoDir }),
      /仅允许移除|受管/
    );

    const wtRemoved = await executeGitWorkspaceAction(repoDir, {
      action: 'worktree-remove',
      worktreePath: wtCreated.worktreePath,
    });
    assert.equal(wtRemoved.ok, true);
    assert.equal(fs.existsSync(wtCreated.worktreePath), false);

    // 3. Multi-CLI Provider Registry + Extra Provider Execution + Per-Agent Persona/Model
    const ecosystem = await detectProviderEcosystem();
    assert.ok(Array.isArray(ecosystem.providers));
    const providerIds = ecosystem.providers.map((p) => p.id);
    for (const expectedId of ['codex', 'antigravity', 'claude', 'opencode', 'ollama']) {
      assert.ok(providerIds.includes(expectedId), `Provider catalog should include ${expectedId}`);
    }

    const fakeClaudeScript = path.join(tmpRoot, 'fake-claude.mjs');
    await fsp.writeFile(
      fakeClaudeScript,
      `console.log(JSON.stringify({ type: 'result', result: 'Claude Code 审查通过：无阻塞缺陷。', session_id: 'claude-sess-1' }));`,
      'utf8'
    );
    const extraRes = await executeExtraProviderTurn({
      provider: 'claude',
      cwd: repoDir,
      prompt: '审查最近一次提交',
      binOverride: process.execPath,
      extraLeadArgs: [fakeClaudeScript],
    });
    assert.equal(extraRes.ok, true);
    assert.match(extraRes.text, /Claude Code 审查通过/);

    const profiles = normalizeAgentProfiles({
      codex: { displayName: '后端架构师 Codex', model: 'gpt-5.4', persona: '专注高并发与边界防御测试' },
      antigravity: { displayName: '前端主程 AGY', model: 'gemini-3.8-pro', persona: '专注无障碍与零抖动 UI' },
    });
    assert.equal(profiles.codex.model, 'gpt-5.4');
    const personaNote = buildAgentPersonaDirective('codex', profiles);
    assert.match(personaNote, /后端架构师 Codex/);
    assert.match(personaNote, /专注高并发与边界防御测试/);

    // 4. Tailscale Status Parser + Secret-Redacting Diagnostics + Computer Preview Cache
    const redacted = stderrDiagnosticOf(
      'Error: auth failed with key tskey-auth-k998877SECRET12345 and Bearer eyJhbGciOiJIUzI1NiJ9.secret'
    );
    assert.doesNotMatch(redacted, /k998877SECRET12345/);
    assert.doesNotMatch(redacted, /eyJhbGciOiJIUzI1NiJ9/);
    assert.match(redacted, /REDACTED/);

    const tsParsed = parseTailscaleStatusJson(
      JSON.stringify({
        BackendState: 'Running',
        Self: {
          Online: true,
          DNSName: 'devbox.tail9988.ts.net.',
          TailscaleIPs: ['100.88.12.34', 'fd7a:115c:a1e0::1'],
        },
      }),
      8866
    );
    assert.equal(tsParsed.running, true);
    assert.equal(tsParsed.dnsName, 'devbox.tail9988.ts.net');
    assert.equal(tsParsed.ipv4, '100.88.12.34');
    assert.equal(tsParsed.magicDnsUrl, 'http://devbox.tail9988.ts.net:8866');

    let screenCaptures = 0;
    const preview1 = await captureHostScreenPreview({
      cacheTtlMs: 5000,
      runnerOverride: async () => {
        screenCaptures += 1;
        return { width: 1920, height: 1080, mimeType: 'image/jpeg', base64: 'ZmFrZS1qcGVn' };
      },
    });
    const preview2 = await captureHostScreenPreview({
      cacheTtlMs: 5000,
      runnerOverride: async () => {
        screenCaptures += 1;
        return { width: 1920, height: 1080, mimeType: 'image/jpeg', base64: 'ZmFrZS1qcGVnLTI=' };
      },
    });
    assert.equal(preview1.ok, true);
    assert.equal(preview2.base64, 'ZmFrZS1qcGVn');
    assert.equal(screenCaptures, 1, 'Computer preview cache should prevent duplicate captures within TTL');

    // 5. End-to-End CcccBridge Card Action Settlement & Single-Submit Refusal Guard
    const dataDir = path.join(tmpRoot, 'data');
    const groupsDir = path.join(tmpRoot, 'groups');
    const groupId = 'g_fusion_cards';
    await fsp.mkdir(path.join(groupsDir, groupId), { recursive: true });
    await fsp.writeFile(path.join(groupsDir, groupId, 'ledger.jsonl'), '', 'utf8');

    const dispatchedPrompts = [];
    const bridge = new CcccBridge({
      dataDir,
      groupsDir,
      execCcccOverride: async () => ({ stdout: 'Daemon: running\n', stderr: '' }),
      execJsonOverride: async (args) => {
        if (args[0] === 'groups') {
          return { groups: [{ group_id: groupId, title: 'FusionRoom', running: true }] };
        }
        return {
          group: {
            group_id: groupId,
            scopes: [{ scope_key: 'main', label: 'repo', url: repoDir }],
            actors: [
              { id: 'codex', title: 'Codex', runtime: 'codex', running: true, enabled: true, command: ['codex', '-s', 'read-only'] },
              { id: 'antigravity', title: 'Antigravity', runtime: 'antigravity', running: true, enabled: true, command: ['agy'] },
            ],
          },
          actors: [
            { id: 'codex', title: 'Codex', runtime: 'codex', running: true, enabled: true, command: ['codex', '-s', 'read-only'] },
            { id: 'antigravity', title: 'Antigravity', runtime: 'antigravity', running: true, enabled: true, command: ['agy'] },
          ],
        };
      },
      externalSessionRunnerOverride: async (params) => {
        dispatchedPrompts.push(params);
        return { ok: true, sessionId: 'sess-codex-write-1', text: '已获可写授权并完成修改。' };
      },
    });

    try {
      await bridge.setGroupPrefs(groupId, {
        agentProfiles: profiles,
        sessionRouting: {
          enabled: true,
          flow: 'direct',
          permission: 'read-only',
          codex: { mode: 'existing', sessionId: 'sess-codex-write-1', sessionTitle: 'Demo', cwd: repoDir },
        },
      });
      await bridge.listGroups({ force: true });

      const appendedRo = await bridge.appendExternalDispatchMessage(groupId, {
        id: 'ext-ro-card-1',
        by: 'codex',
        isUser: false,
        senderTitle: 'Codex',
        to: ['user'],
        text: '当前处于只读模式（read-only），无法直接写入 `app.js`。请批准可写权限后继续执行。',
        sessionReceipt: {
          agent: 'codex',
          mode: 'existing',
          sessionId: 'sess-codex-write-1',
          cwd: repoDir,
          permission: 'read-only',
        },
        retryMeta: {
          actorId: 'codex',
          prompt: '把 app.js 里的 v 改成 2',
          replyStyle: 'plain',
          attachments: [],
        },
      });

      const msgsBefore = await bridge.getMessages(groupId);
      const cardMsg = msgsBefore.find((m) => m.id === appendedRo.id);
      assert.ok(cardMsg?.interactiveCard, 'Ledger message should expose interactiveCard');
      assert.equal(cardMsg.interactiveCard.kind, 'approval');
      assert.equal(cardMsg.interactiveCard.settled, null);

      // Approve write permission -> upgrades turn to workspace-write, injects persona, and settles card
      const approveRes = await bridge.resolveCardAction(groupId, {
        messageId: appendedRo.id,
        cardId: cardMsg.interactiveCard.id,
        decision: 'approve',
      });
      assert.equal(approveRes.ok, true);
      assert.equal(approveRes.settled.decision, 'approve');

      // Wait microtask tick for async external turn dispatch
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(dispatchedPrompts.length, 1);
      assert.equal(dispatchedPrompts[0].permission, 'workspace-write');
      assert.equal(dispatchedPrompts[0].model, 'gpt-5.4');
      assert.match(dispatchedPrompts[0].prompt, /专注高并发与边界防御测试/);

      // Double-click / second submission on an already settled card MUST be refused!
      await assert.rejects(
        () =>
          bridge.resolveCardAction(groupId, {
            messageId: appendedRo.id,
            cardId: cardMsg.interactiveCard.id,
            decision: 'deny',
          }),
        /已处理|不可重复/
      );
    } finally {
      bridge.stop();
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('v2.0.0 Frontend UI, Modern Web Guidance & Third-Party Attribution Contracts', () => {
  const pkg = JSON.parse(
    fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  );
  const swJs = fs.readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  const appMjs = fs.readFileSync(new URL('../public/app.mjs', import.meta.url), 'utf8');
  const notices = fs.readFileSync(
    new URL('../THIRD_PARTY_NOTICES.md', import.meta.url),
    'utf8'
  );

  assert.equal(pkg.version, '3.0.0');
  assert.match(swJs, /achat-shell-v15/);
  assert.match(notices, /pingdotgg\/t3code/);
  assert.match(notices, /milind-soni\/OpenMausBot/);

  // Declarative dialog control + light-dismiss + Computer Panel + Git closed-loop UI
  assert.match(html, /id="openComputerPreviewBtn"[^>]*commandfor="computerPreviewDialog"/);
  assert.match(html, /id="computerPreviewDialog"[^>]*closedby="any"/);
  assert.match(html, /id="drawerWorktreeCreateBtn"[^>]*hidden/);
  assert.match(html, /id="drawerGitCommitBar"[^>]*hidden/);
  assert.match(html, /id="drawerGitCommitBtn"/);
  assert.match(html, /id="drawerAgentProfilesSection"/);
  assert.match(html, /id="tailscaleStatusBanner"/);

  // CSS child-state :has() styling + card root layout stability + dvw viewport safety
  assert.match(css, /\.cp-auto-toggle:has\(input:checked\)/);
  assert.match(css, /\.git-commit-bar:has\(input:focus\)/);
  assert.match(css, /\.inline-agent-card\s*\{/);
  assert.match(css, /100dvw/);

  // App wiring: <article> card roots, SSE cardSettled & requestDesktopFrame, focus protection
  assert.match(appMjs, /document\.createElement\('article'\)/);
  assert.match(appMjs, /addEventListener\('cardSettled'/);
  assert.match(appMjs, /addEventListener\('requestDesktopFrame'/);
  assert.match(appMjs, /captureDesktopPreview/);
  assert.match(appMjs, /drawerAgentProfilesList\.contains\(document\.activeElement\)/);
  assert.match(appMjs, /hasHandledInitialSseConnect/);
  assert.match(appMjs, /\/api\/computer-preview/);
  assert.match(appMjs, /\/api\/providers/);
  assert.match(appMjs, /\/git-action/);
  assert.match(appMjs, /\/card-action/);
});

test('v2.0.1 Approval Scope Isolation, Full-Pipeline Profile Nicknames & Remote Desktop Frame Sync', async () => {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'achat-v201-test-'));
  try {
    const dataDir = path.join(tmpRoot, 'data');
    const groupsDir = path.join(tmpRoot, 'groups');
    const groupId = 'g_v201_room';
    const repoDir = path.join(tmpRoot, 'repo');
    await fsp.mkdir(path.join(groupsDir, groupId), { recursive: true });
    await fsp.mkdir(repoDir, { recursive: true });

    // Seed a group-mode Codex chat message blocked by read-only sandbox
    const seedLines = [
      JSON.stringify({
        id: 'ev-user-1',
        ts: '2026-11-09T02:00:00.000Z',
        kind: 'chat.message',
        by: 'user',
        data: { text: '修改 config.json 端口配置', to: ['codex'] },
      }),
      JSON.stringify({
        id: 'ev-codex-ro-1',
        ts: '2026-11-09T02:00:05.000Z',
        kind: 'chat.message',
        by: 'codex',
        data: {
          text: '当前处于只读模式（read-only），无法直接修改 `config.json`。如需继续请批准可写权限。',
          to: ['user'],
        },
      }),
    ];
    await fsp.writeFile(
      path.join(groupsDir, groupId, 'ledger.jsonl'),
      `${seedLines.join('\n')}\n`,
      'utf8'
    );

    let permanentSandboxUpdates = 0;
    const externalRuns = [];
    const emittedGroupsEvents = [];

    const bridge = new CcccBridge({
      dataDir,
      groupsDir,
      execCcccOverride: async (args) => {
        if (args[0] === 'actor' && args[1] === 'update') {
          permanentSandboxUpdates += 1;
        }
        return { stdout: 'Daemon: running\n', stderr: '' };
      },
      execJsonOverride: async (args) => {
        if (args[0] === 'groups') {
          return { groups: [{ group_id: groupId, title: 'V201Room', running: true }] };
        }
        return {
          group: {
            group_id: groupId,
            scopes: [{ scope_key: 'main', label: 'repo', url: repoDir }],
            actors: [
              {
                id: 'codex',
                title: 'Codex',
                runtime: 'codex',
                running: true,
                enabled: true,
                command: ['codex', '-s', 'read-only'],
              },
              {
                id: 'antigravity',
                title: 'Antigravity',
                runtime: 'antigravity',
                running: true,
                enabled: true,
                command: ['agy'],
              },
            ],
          },
          actors: [
            {
              id: 'codex',
              title: 'Codex',
              runtime: 'codex',
              running: true,
              enabled: true,
              command: ['codex', '-s', 'read-only'],
            },
            {
              id: 'antigravity',
              title: 'Antigravity',
              runtime: 'antigravity',
              running: true,
              enabled: true,
              command: ['agy'],
            },
          ],
        };
      },
      externalSessionRunnerOverride: async (params) => {
        externalRuns.push(params);
        await new Promise((r) => setTimeout(r, 60));
        return { ok: true, sessionId: 'sess-turn-1', text: '单轮可写执行完成。' };
      },
    });
    bridge.on('groups', (gs) => emittedGroupsEvents.push(gs));

    try {
      // 1. Set AI Employee Profile displayName -> must propagate to listGroups actor titles & group ledger senderTitle
      await bridge.setGroupPrefs(groupId, {
        agentProfiles: {
          codex: { displayName: '首席架构师 Cx', model: 'gpt-5.4', persona: '严谨求证' },
        },
      });
      const groupsAfterProfile = await bridge.listGroups({ force: true });
      const codexActor = groupsAfterProfile[0].actors.find((a) => a.id === 'codex');
      assert.equal(codexActor.title, '首席架构师 Cx');
      assert.equal(codexActor.defaultTitle, 'Codex');

      const msgs = await bridge.getMessages(groupId);
      const roMsg = msgs.find((m) => m.id === 'ev-codex-ro-1');
      assert.equal(roMsg.senderTitle, '首席架构师 Cx');
      assert.ok(roMsg.interactiveCard, 'Group read-only message should expose approval card');

      // 2. Approving with grantScope: 'turn' MUST NOT permanently mutate group codexSandbox!
      const turnApprove = await bridge.resolveCardAction(groupId, {
        messageId: 'ev-codex-ro-1',
        cardId: roMsg.interactiveCard.id,
        decision: 'approve',
        grantScope: 'turn',
      });
      assert.equal(turnApprove.ok, true);
      assert.equal(
        permanentSandboxUpdates,
        0,
        'Single-turn approval must NOT permanently upgrade group codexSandbox'
      );
      await new Promise((r) => setTimeout(r, 90));
      assert.equal(externalRuns.length, 1);
      assert.equal(externalRuns[0].permission, 'workspace-write');

      // 3. External session grantScope: 'session' MUST emit immediate groups SSE BEFORE turn finishes
      const extMsg = await bridge.appendExternalDispatchMessage(groupId, {
        id: 'ext-ro-session-1',
        by: 'codex',
        isUser: false,
        senderTitle: 'Codex',
        to: ['user'],
        text: '当前处于只读模式（read-only），无法直接写入文件，请批准可写后继续。',
        sessionReceipt: { agent: 'codex', permission: 'read-only', cwd: repoDir },
      });
      const msgs2 = await bridge.getMessages(groupId);
      const extCardMsg = msgs2.find((m) => m.id === extMsg.id);
      emittedGroupsEvents.length = 0;

      await bridge.resolveCardAction(groupId, {
        messageId: extMsg.id,
        cardId: extCardMsg.interactiveCard.id,
        decision: 'approve',
        grantScope: 'session',
      });
      // Immediately (before the 60ms runner finishes!), groups SSE should have fired with workspace-write
      assert.ok(
        emittedGroupsEvents.length >= 1,
        'grantScope=session should broadcast updated groups immediately before turn finishes'
      );
      assert.equal(emittedGroupsEvents[0][0].sessionRouting.permission, 'workspace-write');
      await new Promise((r) => setTimeout(r, 90));
    } finally {
      bridge.stop();
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('v2.0.2 Codex Writer-Lock Auto-Recovery, Busy Detection & 2026 Model Presets', async () => {
  const {
    discoverLocalSessions,
    ensureCodexThreadWritable,
    executeExternalAgentTurn,
  } = await import('../server/session-router.mjs');
  const { PROVIDER_CATALOG_META, detectProviderEcosystem } = await import(
    '../server/fusion-hub.mjs'
  );
  const { DatabaseSync } = await import('node:sqlite');

  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'achat-v202-test-'));
  try {
    const codexHome = path.join(tmpRoot, '.codex');
    const lockDir = path.join(codexHome, 'thread-writer-locks');
    const projDir = path.join(tmpRoot, 'clash-royale-ai');
    await fsp.mkdir(lockDir, { recursive: true });
    await fsp.mkdir(projDir, { recursive: true });

    // 1. Seed state_5.sqlite + thread_history_1.sqlite + rollout file
    const idleThreadId = '01a1bf48-4a23-78f2-8dee-e105436ac8cf';
    const busyThreadId = '01a1busy-9999-78f2-8dee-e105436ac8cf';
    const rolloutPath = path.join(codexHome, `rollout-${idleThreadId}.jsonl`);
    await fsp.writeFile(
      rolloutPath,
      [
        JSON.stringify({
          timestamp: '2026-11-09T15:10:00Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: '优化石头人卡组下牌策略与拉扯点位' },
        }),
        JSON.stringify({
          timestamp: '2026-11-09T15:11:00Z',
          type: 'event_msg',
          payload: {
            type: 'agent_message',
            phase: 'final_answer',
            message: '已梳理戈仑石人沉底时机与暗夜女巫跟进位置。',
          },
        }),
      ].join('\n') + '\n',
      'utf8'
    );

    const stateDb = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'));
    stateDb.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT,
        updated_at INTEGER,
        source TEXT,
        cwd TEXT,
        title TEXT,
        sandbox_policy TEXT,
        archived INTEGER,
        first_user_message TEXT,
        git_branch TEXT
      );
    `);
    stateDb
      .prepare(`INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        idleThreadId,
        rolloutPath,
        1794236904,
        'vscode',
        projDir,
        '皇室战争',
        '{"type":"workspace-write"}',
        0,
        '优化石头人卡组下牌策略',
        'main'
      );
    stateDb
      .prepare(`INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        busyThreadId,
        rolloutPath,
        1794236950,
        'vscode',
        projDir,
        '正在训练的对局会话',
        '{"type":"workspace-write"}',
        0,
        '跑一轮强化学习评估',
        'main'
      );
    stateDb.close();

    const histDb = new DatabaseSync(path.join(codexHome, 'thread_history_1.sqlite'));
    histDb.exec(`
      CREATE TABLE thread_turns (
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        rollout_ordinal INTEGER NOT NULL,
        status TEXT NOT NULL,
        completed_at INTEGER,
        PRIMARY KEY (thread_id, turn_id)
      );
    `);
    histDb
      .prepare(`INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?)`)
      .run(idleThreadId, 'turn-1', 10, 'completed', 1794236904);
    histDb
      .prepare(`INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?)`)
      .run(busyThreadId, 'turn-2', 20, 'inProgress', null);
    histDb.close();

    // Seed idle desktop writer lock file for idleThreadId and active lock file for busyThreadId
    const idleLockPath = path.join(lockDir, `${idleThreadId}.lock`);
    const busyLockPath = path.join(lockDir, `${busyThreadId}.lock`);
    await fsp.writeFile(idleLockPath, '', 'utf8');
    await fsp.writeFile(busyLockPath, '', 'utf8');

    // A. discoverLocalSessions must mark busyThreadId as busy=true and idleThreadId as busy=false
    const discovered = await discoverLocalSessions({
      codexHomeDir: codexHome,
      antigravityDataDir: path.join(tmpRoot, 'empty-agy'),
    });
    const idleSess = discovered.codex.find((s) => s.id === idleThreadId);
    const busySess = discovered.codex.find((s) => s.id === busyThreadId);
    assert.ok(idleSess && busySess);
    assert.equal(idleSess.busy, false, 'Completed thread should not be marked busy');
    assert.equal(busySess.busy, true, 'inProgress thread in thread_history_1.sqlite must be marked busy');

    // B. ensureCodexThreadWritable releases idle lock when thread is completed
    assert.equal(fs.existsSync(idleLockPath), true);
    const lockCheck = await ensureCodexThreadWritable({
      sessionId: idleThreadId,
      codexHomeDir: codexHome,
      maxWaitMs: 50,
    });
    assert.equal(lockCheck.inProgress, false);
    assert.equal(lockCheck.releasedIdleLock, true);
    assert.equal(fs.existsSync(idleLockPath), false, 'Idle lock file should be unlinked before resume');

    // C. When codex exec resume still hits `already has an active writer`, executeExternalAgentTurn
    //    automatically falls back to a context-seeded companion session in the same project directory!
    const fakeCodexScript = path.join(tmpRoot, 'fake-codex-lock.mjs');
    await fsp.writeFile(
      fakeCodexScript,
      `
      const args = process.argv.slice(2);
      if (args.includes('resume')) {
        console.error('2026-11-09T15:22:58.558874Z ERROR codex_core::session::session: failed to initialize thread persistence: thread-store conflict: thread ${idleThreadId} already has an active writer');
        console.error('Error: thread/resume: thread/resume failed');
        process.exit(1);
      }
      const prompt = args[args.length - 1] || '';
      console.log(JSON.stringify({ type: 'thread.started', thread_id: '01a1fork-companion-001' }));
      console.log(JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: '已自动接续原皇室战争会话上下文并完成卡组防守点位计划：' + (prompt.includes('戈仑石人') ? '含历史上下文' : '无上下文')
        }
      }));
      `,
      'utf8'
    );

    const turnRes = await executeExternalAgentTurn({
      agent: 'codex',
      mode: 'existing',
      sessionId: idleThreadId,
      cwd: projDir,
      prompt: '给出石头人卡组详细防守点位计划',
      codexBin: process.execPath,
      codexExtraLeadArgs: [fakeCodexScript],
      codexHomeDir: codexHome,
    });
    assert.equal(turnRes.ok, true, 'Should recover automatically from active writer conflict');
    assert.equal(turnRes.sessionId, '01a1fork-companion-001');
    assert.equal(turnRes.forkedFromSessionId, idleThreadId);
    assert.match(turnRes.text, /含历史上下文/);

    // D. Verify 2026 Model Catalog & Dynamic Models Cache Sync
    assert.ok(PROVIDER_CATALOG_META.codex.models.includes('gpt-6-astra'));
    assert.ok(PROVIDER_CATALOG_META.codex.models.includes('gpt-6.1-sol'));
    assert.ok(PROVIDER_CATALOG_META.antigravity.models.includes('gemini-4-argon-high'));
    assert.ok(PROVIDER_CATALOG_META.antigravity.models.includes('gemini-3.8-flash-high'));
    assert.ok(PROVIDER_CATALOG_META.antigravity.models.includes('claude-opus-5-5-high'));
    assert.ok(!PROVIDER_CATALOG_META.antigravity.models.some((m) => m.includes('gemini-2.5')));

    await fsp.writeFile(
      path.join(codexHome, 'models_cache.json'),
      JSON.stringify({
        models: [
          { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', description: 'Frontier intelligence' },
          { slug: 'gpt-6.2-nova-preview', display_name: 'GPT-6.2-Nova', description: 'Next-gen preview' },
        ],
      }),
      'utf8'
    );
    const eco = await detectProviderEcosystem({ force: true, codexHomeDir: codexHome });
    const codexProv = eco.providers.find((p) => p.id === 'codex');
    assert.ok(codexProv.models.includes('gpt-6.2-nova-preview'));

    // E. Verify launch command builders honor custom profile model
    const customCxCmd = buildCodexLaunchCommand('codex', {
      sandbox: 'workspace-write',
      gear: 'deep',
      model: 'gpt-6-astra',
    });
    assert.match(customCxCmd, /model="gpt-6-astra"/);
    const customAgCmd = buildAntigravityLaunchCommand('agy', {
      gear: 'deep',
      model: 'gemini-4-argon-high',
    });
    assert.match(customAgCmd, /--model gemini-4-argon-high/);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('v2.0.3 Unlimited Total Duration & Dual-Activity Idle Disconnect Watchdog', async () => {
  const { executeExternalAgentTurn, DEFAULT_IDLE_TIMEOUT_MS } = await import(
    '../server/session-router.mjs'
  );

  assert.equal(
    DEFAULT_IDLE_TIMEOUT_MS,
    600_000,
    'Default idle timeout must be 10 minutes (600,000 ms) of complete silence'
  );

  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'achat-v203-test-'));
  try {
    const codexHome = path.join(tmpRoot, '.codex');
    const agyHome = path.join(tmpRoot, '.antigravity');
    const projDir = path.join(tmpRoot, 'proj');
    await fsp.mkdir(codexHome, { recursive: true });
    await fsp.mkdir(agyHome, { recursive: true });
    await fsp.mkdir(projDir, { recursive: true });

    // 1. Active streaming script that runs 3x longer than idleTimeoutMs (330ms > 120ms)
    //    Must NOT be killed because stdout emits chunks every 50ms!
    const activeCodexScript = path.join(tmpRoot, 'active-codex.mjs');
    await fsp.writeFile(
      activeCodexScript,
      `
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thr-long-active' }));
      for (let i = 1; i <= 5; i++) {
        await sleep(55);
        console.log(JSON.stringify({
          type: 'item.started',
          item: { type: 'command_execution', command: 'step-' + i }
        }));
      }
      await sleep(45);
      console.log(JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: '长时连续输出任务顺利跑完，未受总时长限制！' }
      }));
      `,
      'utf8'
    );

    const activeRes = await executeExternalAgentTurn({
      agent: 'codex',
      mode: 'new',
      cwd: projDir,
      prompt: '执行多步长耗时训练',
      codexBin: process.execPath,
      codexExtraLeadArgs: [activeCodexScript],
      codexHomeDir: codexHome,
      idleTimeoutMs: 130,
    });
    assert.equal(
      activeRes.ok,
      true,
      'Process that keeps emitting output every 55ms must run past 130ms idleTimeoutMs without disconnecting'
    );
    assert.match(activeRes.text, /未受总时长限制/);

    // 2. Disk-activity-only script: stdout is silent for 220ms (> 120ms idleTimeoutMs),
    //    but thread_history_1.sqlite is touched every 50ms -> must ALSO stay alive!
    const diskActiveScript = path.join(tmpRoot, 'disk-active-codex.mjs');
    const histFile = path.join(codexHome, 'thread_history_1.sqlite');
    await fsp.writeFile(histFile, 'init', 'utf8');
    await fsp.writeFile(
      diskActiveScript,
      `
      import fs from 'node:fs';
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const hist = ${JSON.stringify(histFile)};
      console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thr-disk-active' }));
      for (let i = 1; i <= 4; i++) {
        await sleep(50);
        fs.appendFileSync(hist, 'step' + i);
      }
      await sleep(30);
      console.log(JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: '底层会话文件持续写入保活成功！' }
      }));
      `,
      'utf8'
    );

    const diskRes = await executeExternalAgentTurn({
      agent: 'codex',
      mode: 'new',
      cwd: projDir,
      prompt: '执行静默子进程任务',
      codexBin: process.execPath,
      codexExtraLeadArgs: [diskActiveScript],
      codexHomeDir: codexHome,
      idleTimeoutMs: 125,
    });
    assert.equal(
      diskRes.ok,
      true,
      'Process with disk activity in .codex must stay alive even when stdout is temporarily buffered'
    );
    assert.match(diskRes.text, /底层会话文件持续写入保活成功/);

    // 3. Truly stalled script (zero stdout/stderr and zero disk writes for > idleTimeoutMs)
    //    Must disconnect automatically and report idle silence (not 15-min wall-clock cap)!
    const stalledAgyScript = path.join(tmpRoot, 'stalled-agy.mjs');
    await fsp.writeFile(
      stalledAgyScript,
      `
      console.log(JSON.stringify({ event: 'init', conversation_id: 'conv-stalled-1' }));
      setTimeout(() => {}, 10000);
      `,
      'utf8'
    );

    const stalledRes = await executeExternalAgentTurn({
      agent: 'antigravity',
      mode: 'new',
      cwd: projDir,
      prompt: '测试卡死断开',
      agyBin: process.execPath,
      agyExtraLeadArgs: [stalledAgyScript],
      antigravityDataDir: agyHome,
      idleTimeoutMs: 120,
    });
    assert.equal(stalledRes.ok, false, 'Completely silent process must disconnect after idleTimeoutMs');
    assert.match(stalledRes.text, /无新输出|长时间无响应/);
    assert.doesNotMatch(stalledRes.text, /15 分钟上限/);
  } finally {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // Windows process exit file handle settle
    }
  }
});

test('v2.0.4: Codex-style in-turn supplement queue coalescing, followUp direct execution bypass, and hot steer interrupt', async () => {
  const indexHtmlSrc = await fsp.readFile(path.join(process.cwd(), 'public', 'index.html'), 'utf8');
  const appMjsSrc = await fsp.readFile(path.join(process.cwd(), 'public', 'app.mjs'), 'utf8');

  assert.match(
    indexHtmlSrc,
    /id="steerQueuedTurnBtn"/,
    'public/index.html must include #steerQueuedTurnBtn (⚡ 立即纠偏) on #queuedTurnBar'
  );
  assert.match(
    appMjsSrc,
    /followUp/,
    'public/app.mjs must send followUp: true when draining or steering supplementary messages'
  );
  assert.match(
    appMjsSrc,
    /coalesceQueuedSupplementItems/,
    'public/app.mjs must coalesce multiple queued supplementary messages into a single combined turn'
  );

  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'achat-v204-test-'));
  const dataDir = path.join(tmpRoot, 'data');
  const groupsDir = path.join(tmpRoot, 'groups');
  const codexHome = path.join(tmpRoot, 'codex-home');
  const agyHome = path.join(tmpRoot, 'agy-home');
  const projDir = path.join(tmpRoot, 'clash-royale-proj');
  const groupId = 'g_v204_followup';

  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.mkdir(path.join(groupsDir, groupId), { recursive: true });
  await fsp.mkdir(codexHome, { recursive: true });
  await fsp.mkdir(agyHome, { recursive: true });
  await fsp.mkdir(projDir, { recursive: true });
  await fsp.writeFile(path.join(groupsDir, groupId, 'ledger.jsonl'), '', 'utf8');

  const extRunnerCalls = [];
  const bridge = new CcccBridge({
    dataDir,
    groupsDir,
    codexHomeDir: codexHome,
    antigravityDataDir: agyHome,
    externalSessionRunnerOverride: async (params) => {
      extRunnerCalls.push(params);
      if (params.phase === 'discuss_lead') {
        return { ok: true, sessionId: 'plan-codex', text: '1/3 提案' };
      }
      if (params.phase === 'discuss_peer') {
        return { ok: true, sessionId: 'plan-agy', text: '2/3 拍板' };
      }
      return {
        ok: true,
        sessionId: params.sessionId || `${params.agent}-sess-1`,
        text: `${params.agent} 已在同会话跟进补充信息。`,
      };
    },
    execCcccOverride: async () => ({ stdout: '{}', stderr: '' }),
    execJsonOverride: async (args) => {
      if (args[0] === 'groups') {
        return { groups: [{ group_id: groupId, title: '皇室战争ai', running: true }] };
      }
      if (args[0] === 'group' && args[1] === 'show') {
        return {
          effective_scope: { path: projDir },
          group: {
            group_id: groupId,
            title: '皇室战争ai',
            scopes: [{ scope_key: 's1', label: 'proj', url: projDir }],
            actors: [
              { id: 'codex', title: 'Codex', runtime: 'codex', command: ['codex'] },
              { id: 'antigravity', title: 'Antigravity', runtime: 'antigravity', command: ['agy'] },
            ],
          },
        };
      }
      if (args[0] === 'actor' && args[1] === 'list') {
        return {
          actors: [
            { id: 'codex', title: 'Codex', runtime: 'codex', running: true, enabled: true, command: ['codex'] },
            { id: 'antigravity', title: 'Antigravity', runtime: 'antigravity', running: true, enabled: true, command: ['agy'] },
          ],
        };
      }
      return {};
    },
  });

  try {
    await bridge.ensureFileHelperSeed();
    await bridge.readGroupLedger(groupId);

    // Configure group with flow: 'discuss_then_exec' (which normally runs 4 external calls: 1/3, 2/3, and 2x 3/3)
    await bridge.setGroupPrefs(groupId, {
      sessionRouting: {
        enabled: true,
        flow: 'discuss_then_exec',
        permission: 'workspace-write',
        codex: { mode: 'existing', sessionId: 'codex-cr-001', sessionTitle: '皇室战争主会话', cwd: projDir },
        antigravity: { mode: 'existing', sessionId: 'agy-cr-001', sessionTitle: 'Clash Royale AI', cwd: projDir },
      },
    });

    // Send a supplementary message with followUp: true
    const sentUserRecord = await bridge.sendGroupMessage(groupId, {
      text: '【补充信息 1】飞龙宝宝是两轮觉醒\n\n【补充信息 2】野蛮人滚筒没有进化',
      to: ['@all'],
      followUp: true,
    });

    for (let i = 0; i < 40 && extRunnerCalls.length < 2; i += 1) {
      await new Promise((r) => setTimeout(r, 15));
    }
    await new Promise((r) => setTimeout(r, 30));

    // Must ONLY invoke the 2 target sessions directly (phase === 'exec'), skipping discuss_lead and discuss_peer!
    assert.equal(
      extRunnerCalls.length,
      2,
      'followUp: true must bypass Stage 1 (discuss_lead) & Stage 2 (discuss_peer) and execute directly in the 2 bound sessions'
    );
    assert.equal(extRunnerCalls.every((c) => c.phase === 'exec'), true);
    assert.match(
      extRunnerCalls[0].prompt,
      /用户追加补充信息/,
      'Direct supplementary execution prompt must carry the supplementary context header'
    );
    assert.match(
      sentUserRecord.insight,
      /补充跟进/,
      'User bubble insight must clearly indicate ➕ 补充跟进 instead of starting a new 3-stage debate'
    );
  } finally {
    bridge.stop();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('v2.0.5: Long-task Auto-Wakeup — auto-resumes on idle disconnect and auto-continues unfinished phases in unattended mode', async () => {
  const indexHtmlSrc = await fsp.readFile(path.join(process.cwd(), 'public', 'index.html'), 'utf8');
  const appMjsSrc = await fsp.readFile(path.join(process.cwd(), 'public', 'app.mjs'), 'utf8');

  assert.match(
    indexHtmlSrc,
    /id="autoWakeToggleBtn"/,
    'public/index.html must include #autoWakeToggleBtn (⏰ 自动唤醒) in the target session bar'
  );
  assert.match(
    appMjsSrc,
    /autoWake/,
    'public/app.mjs must support autoWake in sessionRouting state and UI toggle'
  );

  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'achat-v205-test-'));
  const dataDir = path.join(tmpRoot, 'data');
  const groupsDir = path.join(tmpRoot, 'groups');
  const codexHome = path.join(tmpRoot, 'codex-home');
  const agyHome = path.join(tmpRoot, 'agy-home');
  const projDir = path.join(tmpRoot, 'clash-royale-proj');
  const groupId = 'g_v205_autowake';

  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.mkdir(path.join(groupsDir, groupId), { recursive: true });
  await fsp.mkdir(codexHome, { recursive: true });
  await fsp.mkdir(agyHome, { recursive: true });
  await fsp.mkdir(projDir, { recursive: true });
  await fsp.writeFile(path.join(groupsDir, groupId, 'ledger.jsonl'), '', 'utf8');

  let codexExecAttempts = 0;
  let agyExecAttempts = 0;
  const extRunnerCalls = [];

  const bridge = new CcccBridge({
    dataDir,
    groupsDir,
    codexHomeDir: codexHome,
    antigravityDataDir: agyHome,
    externalSessionRunnerOverride: async (params) => {
      extRunnerCalls.push(params);
      if (params.phase === 'discuss_lead') {
        return { ok: true, sessionId: 'codex-cr-main', text: '1/3 分工提案：Codex 负责算水与验收，Antigravity 负责视觉与短训。' };
      }
      if (params.phase === 'discuss_peer') {
        return { ok: true, sessionId: 'agy-cr-main', text: '2/3 拍板定稿：两边按无重叠文件立即执行。' };
      }
      if (params.agent === 'codex') {
        codexExecAttempts += 1;
        if (codexExecAttempts === 1) {
          // Simulate 10-minute idle disconnect on Attempt 1 (like in the user's screenshot)
          return {
            ok: false,
            sessionId: 'codex-cr-main',
            rawDetail: 'idle_timeout',
            text: '⚠️ 目标 Codex 会话长时间无响应（已连续 10 分钟 无新输出），已自动断开。请检查任务状态或点击气泡下方「仅重试 Codex」。',
          };
        }
        if (codexExecAttempts === 2) {
          // Attempt 2 wakes up from idle disconnect, finishes phase 1 but leaves phase 2 unfinished ("尚未恢复训练")
          return {
            ok: true,
            sessionId: 'codex-cr-main',
            text: '已完成防守算账与落点筛选，14 项测试通过；但决策接入仍待合并，尚未开始训练。',
          };
        }
        // Attempt 3: Unattended auto-continuation wakes it up to finish the remaining phase!
        return {
          ok: true,
          sessionId: 'codex-cr-main',
          text: '已完成全部决策接入合并与新旧模型对照验收，全套长任务已全部完成！',
        };
      }

      agyExecAttempts += 1;
      return {
        ok: true,
        sessionId: 'agy-cr-main',
        text: 'Antigravity 已完成实机图像识别与短训对比，全部验收通过！',
      };
    },
    execCcccOverride: async () => ({ stdout: '{}', stderr: '' }),
    execJsonOverride: async (args) => {
      if (args[0] === 'groups') {
        return { groups: [{ group_id: groupId, title: '皇室战争ai', running: true }] };
      }
      if (args[0] === 'group' && args[1] === 'show') {
        return {
          effective_scope: { path: projDir },
          group: {
            group_id: groupId,
            title: '皇室战争ai',
            scopes: [{ scope_key: 's1', label: 'proj', url: projDir }],
            actors: [
              { id: 'codex', title: 'Codex', runtime: 'codex', command: ['codex'] },
              { id: 'antigravity', title: 'Antigravity', runtime: 'antigravity', command: ['agy'] },
            ],
          },
        };
      }
      if (args[0] === 'actor' && args[1] === 'list') {
        return {
          actors: [
            { id: 'codex', title: 'Codex', runtime: 'codex', running: true, enabled: true, command: ['codex'] },
            { id: 'antigravity', title: 'Antigravity', runtime: 'antigravity', running: true, enabled: true, command: ['agy'] },
          ],
        };
      }
      return {};
    },
  });

  try {
    await bridge.ensureFileHelperSeed();
    await bridge.readGroupLedger(groupId);

    await bridge.setGroupPrefs(groupId, {
      sessionRouting: {
        enabled: true,
        flow: 'discuss_then_exec',
        permission: 'workspace-write',
        autoWake: true,
        codex: { mode: 'existing', sessionId: 'codex-cr-main', sessionTitle: '皇室战争主会话', cwd: projDir },
        antigravity: { mode: 'existing', sessionId: 'agy-cr-main', sessionTitle: 'Clash Royale AI', cwd: projDir },
      },
    });

    await bridge.sendGroupMessage(groupId, {
      text: '我去睡觉了，接下来无人看管你们，把算水决策和训练验收全部跑完。',
      to: ['@all'],
    });

    // Wait for: 2 discuss calls + 1 agy exec + 3 codex exec attempts (1 idle disconnect -> auto-wake #1 -> partial completion -> auto-wake #2 -> full completion) = 6 calls
    for (let i = 0; i < 80 && extRunnerCalls.length < 6; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 40));

    assert.equal(
      codexExecAttempts,
      3,
      'Codex should be automatically woken up after idle disconnect (Attempt 2) AND automatically woken up to finish remaining phases after partial report (Attempt 3)'
    );
    assert.equal(agyExecAttempts, 1, 'Antigravity finished cleanly in 1 attempt and should not be over-woken');

    const allMsgs = await bridge.getMessages(groupId);
    const codexFinal = allMsgs.filter((m) => m.by === 'codex' && m.ok !== false).pop();
    assert.ok(codexFinal, 'Codex must have a final successful reply bubble');
    assert.match(codexFinal.text, /全套长任务已全部完成/);
  } finally {
    bridge.stop();
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  }
});

test('v2.0.6: Native Thought Trace & Live Intermediate Message Emission for Codex and Antigravity', async () => {
  const { executeExternalAgentTurn } = await import('../server/session-router.mjs');
  const appMjsSrc = await fsp.readFile(path.join(process.cwd(), 'public', 'app.mjs'), 'utf8');
  const stylesCssSrc = await fsp.readFile(path.join(process.cwd(), 'public', 'styles.css'), 'utf8');

  assert.match(
    appMjsSrc,
    /thoughtTrace/,
    'public/app.mjs must render thoughtTrace in both streaming and persisted message bubbles'
  );
  assert.match(
    stylesCssSrc,
    /\.thought-trace-panel/,
    'public/styles.css must define .thought-trace-panel styles for native thought & tool timelines'
  );

  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'achat-v206-test-'));
  try {
    const codexHome = path.join(tmpRoot, '.codex');
    const agyHome = path.join(tmpRoot, '.antigravity');
    const projDir = path.join(tmpRoot, 'proj');
    await fsp.mkdir(codexHome, { recursive: true });
    await fsp.mkdir(agyHome, { recursive: true });
    await fsp.mkdir(projDir, { recursive: true });

    // 1. Test Codex: emits reasoning + command_execution + intermediate agent_message #1 + reasoning #2 + final agent_message #2
    const codexTraceScript = path.join(tmpRoot, 'codex-trace-mock.mjs');
    await fsp.writeFile(
      codexTraceScript,
      `
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thr-trace-1' }));
      await sleep(20);
      console.log(JSON.stringify({
        type: 'item.completed',
        item: { type: 'reasoning', text: '先检查 defense_economics.py 里的旧版女武神聚怪残留逻辑。' }
      }));
      await sleep(20);
      console.log(JSON.stringify({
        type: 'item.started',
        item: { type: 'command_execution', command: 'pytest tests/test_defense_economics.py' }
      }));
      await sleep(20);
      console.log(JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: '我已定位到旧版女武神吸怪残留，现在开始清理并重跑 14 项点位测试。' }
      }));
      await sleep(25);
      console.log(JSON.stringify({
        type: 'item.completed',
        item: { type: 'reasoning', text: '14 项点位测试已全绿，现在汇总最终守塔省费对比结论。' }
      }));
      await sleep(20);
      console.log(JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: '防守算账与 14 项点位测试已全部通过，平均省水 1.2 费！' }
      }));
      `,
      'utf8'
    );

    const codexProgressFrames = [];
    const codexIntermediateMsgs = [];
    const codexRes = await executeExternalAgentTurn({
      agent: 'codex',
      mode: 'new',
      cwd: projDir,
      prompt: '修复防守算账并汇报进度',
      codexBin: process.execPath,
      codexExtraLeadArgs: [codexTraceScript],
      codexHomeDir: codexHome,
      onProgress: (frame) => codexProgressFrames.push(frame),
      onIntermediateMessage: (msg) => codexIntermediateMsgs.push(msg),
    });

    assert.equal(codexRes.ok, true);
    assert.match(codexRes.text, /平均省水 1\.2 费/);
    assert.ok(Array.isArray(codexRes.thoughtTrace), 'Codex result must include thoughtTrace array');
    assert.equal(
      codexIntermediateMsgs.length,
      1,
      'First Codex agent_message must be emitted live as an intermediate message when subsequent work continues'
    );
    assert.match(codexIntermediateMsgs[0].text, /我已定位到旧版女武神吸怪残留/);
    assert.equal(
      codexIntermediateMsgs[0].thoughtTrace.some(
        (t) => t.kind === 'thinking' && /女武神聚怪残留/.test(t.text)
      ),
      true,
      'Intermediate Codex message thoughtTrace must capture native reasoning text of segment 1'
    );
    assert.equal(
      codexIntermediateMsgs[0].thoughtTrace.some((t) => t.kind === 'tool' && /pytest/.test(t.text)),
      true,
      'Intermediate Codex message thoughtTrace must capture command_execution tool steps of segment 1'
    );
    assert.equal(
      codexRes.thoughtTrace.some((t) => t.kind === 'thinking' && /14 项点位测试已全绿/.test(t.text)),
      true,
      'Final Codex message thoughtTrace must capture native reasoning text of segment 2'
    );

    // 2. Test Antigravity: writes native thinking + tool_calls + intermediate planner response into transcript.jsonl while running
    const convId = 'conv-agy-trace-99';
    const transcriptDir = path.join(agyHome, 'brain', convId, '.system_generated', 'logs');
    await fsp.mkdir(transcriptDir, { recursive: true });
    const transcriptFile = path.join(transcriptDir, 'transcript.jsonl');
    await fsp.writeFile(transcriptFile, '', 'utf8');

    const agyTraceScript = path.join(tmpRoot, 'agy-trace-mock.mjs');
    await fsp.writeFile(
      agyTraceScript,
      `
      import fs from 'node:fs';
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const tFile = ${JSON.stringify(transcriptFile)};
      console.log(JSON.stringify({ event: 'init', conversation_id: '${convId}' }));
      await sleep(30);
      fs.appendFileSync(tFile, JSON.stringify({
        step_index: 1,
        type: 'USER_INPUT',
        source: 'USER_EXPLICIT',
        content: '校准实机 8 卡识别'
      }) + '\\n');
      console.log(JSON.stringify({
        event: 'step_update',
        step_update: { conversation_id: '${convId}', step_type: 'user_input' }
      }));
      await sleep(40);
      fs.appendFileSync(tFile, JSON.stringify({
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        thinking: '我需要先读取 tracked_perception.py 检查飞龙宝宝未觉醒卡面模板。',
        content: '我先读取感知模块代码，核对未觉醒飞龙宝宝的卡面特征。',
        tool_calls: [{ name: 'read_file', args: { Path: 'src/cr_openworld/tracked_perception.py' } }]
      }) + '\\n');
      console.log(JSON.stringify({
        event: 'step_update',
        step_update: { conversation_id: '${convId}', step_type: 'tool_call' }
      }));
      await sleep(90);
      fs.appendFileSync(tFile, JSON.stringify({
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        thinking: '已确认未觉醒卡面色阶偏差，现在写入修正并跑 79 项回归测试。',
        content: '实机 8 卡识别与 79 项回归测试已 100% 通过！',
        tool_calls: []
      }) + '\\n');
      await sleep(90);
      console.log(JSON.stringify({
        event: 'result',
        result: { conversation_id: '${convId}', status: 'DONE', response: '实机 8 卡识别与 79 项回归测试已 100% 通过！' }
      }));
      `,
      'utf8'
    );

    const agyIntermediateMsgs = [];
    const agyRes = await executeExternalAgentTurn({
      agent: 'antigravity',
      mode: 'existing',
      sessionId: convId,
      cwd: projDir,
      prompt: '校准实机 8 卡识别',
      agyBin: process.execPath,
      agyExtraLeadArgs: [agyTraceScript],
      antigravityDataDir: agyHome,
      onIntermediateMessage: (msg) => agyIntermediateMsgs.push(msg),
    });

    assert.equal(agyRes.ok, true);
    assert.ok(Array.isArray(agyRes.thoughtTrace), 'Antigravity result must include thoughtTrace array');
    assert.equal(
      agyIntermediateMsgs.length,
      1,
      'Intermediate PLANNER_RESPONSE content with tool_calls must be emitted live as an intermediate message'
    );
    assert.match(agyIntermediateMsgs[0].text, /我先读取感知模块代码/);
    assert.equal(
      agyIntermediateMsgs[0].thoughtTrace.some(
        (t) => t.kind === 'thinking' && /飞龙宝宝未觉醒卡面模板/.test(t.text)
      ),
      true,
      'Antigravity intermediate message thoughtTrace must extract native thinking from transcript.jsonl'
    );
    assert.equal(
      agyIntermediateMsgs[0].thoughtTrace.some(
        (t) => t.kind === 'tool' && /tracked_perception\.py/.test(t.text)
      ),
      true,
      'Antigravity intermediate message thoughtTrace must extract tool_calls with file/command summary from transcript.jsonl'
    );
    assert.equal(
      agyRes.thoughtTrace.some((t) => t.kind === 'thinking' && /已确认未觉醒卡面色阶偏差/.test(t.text)),
      true,
      'Antigravity final message thoughtTrace must extract final segment thinking from transcript.jsonl'
    );
  } finally {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  }
});



test('restoreAntigravityDesktopTrajectory & discoverLocalSessions permanently prevent CLI watcher from hiding Desktop sessions', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const {
    ensureAntigravityCliTrajectory,
    restoreAntigravityDesktopTrajectory,
    discoverLocalSessions,
  } = await import('../server/session-router.mjs');

  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'aw-agy-unhide-'));
  const deskDir = path.join(tmpRoot, 'antigravity');
  const cliDir = path.join(tmpRoot, 'antigravity-cli');
  const codexHome = path.join(tmpRoot, 'codex');
  await fsp.mkdir(path.join(deskDir, 'conversations'), { recursive: true });
  await fsp.mkdir(path.join(deskDir, 'annotations'), { recursive: true });
  await fsp.mkdir(path.join(cliDir, 'conversations'), { recursive: true });
  await fsp.mkdir(codexHome, { recursive: true });

  const sessionId = '7925c061-4a20-4bc9-9c42-637e7d03880a';
  const deskConvPath = path.join(deskDir, 'conversations', `${sessionId}.db`);
  const cliConvPath = path.join(cliDir, 'conversations', `${sessionId}.db`);

  // 1. Seed Desktop trajectory DB (step 10) and annotation pbtxt
  const deskTraj = new DatabaseSync(deskConvPath);
  deskTraj.exec('CREATE TABLE trajectory_steps (step_index INTEGER PRIMARY KEY, content TEXT)');
  deskTraj.prepare('INSERT INTO trajectory_steps VALUES (?, ?)').run(10, 'initial desktop step');
  deskTraj.close();

  await fsp.writeFile(
    path.join(deskDir, 'annotations', `${sessionId}.pbtxt`),
    'title: "Clash Royale AI Research Setup"\n',
    'utf8'
  );

  // 2. Seed Desktop conversation_summaries.db as if polluted by CLI watcher (source = CORTEX_TRAJECTORY_SOURCE_CLI, title = '')
  const summarySchema = `
    CREATE TABLE conversation_summaries (
      conversation_id text PRIMARY KEY,
      title text NOT NULL DEFAULT "",
      preview text NOT NULL DEFAULT "",
      step_count integer NOT NULL DEFAULT 0,
      last_modified_time datetime NOT NULL,
      workspace_uris text NOT NULL,
      status text NOT NULL DEFAULT "",
      source text NOT NULL DEFAULT "",
      project_id text NOT NULL DEFAULT "",
      agent_name text NOT NULL DEFAULT "",
      parent_conversation_id text NOT NULL DEFAULT "",
      nesting_depth integer NOT NULL DEFAULT 0,
      battle_id text NOT NULL DEFAULT "",
      winning_conversation_id text NOT NULL DEFAULT "",
      not_fully_idle numeric NOT NULL DEFAULT false,
      killed numeric NOT NULL DEFAULT false,
      last_user_input_time datetime NOT NULL,
      last_user_input_step_index integer NOT NULL DEFAULT -1,
      app_data_dir text NOT NULL DEFAULT "",
      raw_summary blob,
      group_id TEXT NOT NULL DEFAULT ''
    );
  `;
  const deskSumDb = new DatabaseSync(path.join(deskDir, 'conversation_summaries.db'));
  deskSumDb.exec(summarySchema);
  deskSumDb
    .prepare(
      `INSERT INTO conversation_summaries (
        conversation_id, title, preview, step_count, last_modified_time,
        workspace_uris, status, source, last_user_input_time, app_data_dir, raw_summary
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      sessionId,
      '',
      '',
      10,
      '2026-11-10 03:50:00+00:00',
      '["file:///g%3A/"]',
      'CASCADE_RUN_STATUS_IDLE',
      'CORTEX_TRAJECTORY_SOURCE_CLI',
      '2026-11-10 03:50:00+00:00',
      'antigravity',
      Buffer.from([0x10, 0x0a, 0xa0, 0x01, 0x11]) // f2=10, f20=17 (CLI)
    );
  deskSumDb.close();

  // 3. Bridge Desktop -> CLI and simulate CLI adding step 11
  const bridge1 = await ensureAntigravityCliTrajectory({
    sessionId,
    antigravityDataDir: deskDir,
    antigravityCliDataDir: cliDir,
  });
  assert.equal(bridge1.bridged, true);

  const cliTraj = new DatabaseSync(cliConvPath);
  cliTraj.prepare('INSERT INTO trajectory_steps VALUES (?, ?)').run(11, 'new step from AChat CLI');
  cliTraj.close();

  const cliSumDb = new DatabaseSync(path.join(cliDir, 'conversation_summaries.db'));
  cliSumDb.exec(summarySchema);
  cliSumDb
    .prepare(
      `INSERT INTO conversation_summaries (
        conversation_id, title, preview, step_count, last_modified_time,
        workspace_uris, status, source, last_user_input_time, app_data_dir, raw_summary
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      sessionId,
      'Clash Royale AI Research Setup',
      'Clash Royale AI Research Setup',
      11,
      '2026-11-10 04:00:00+00:00',
      '["file:///g%3A/"]',
      'CASCADE_RUN_STATUS_RUNNING',
      '',
      '2026-11-10 04:00:00+00:00',
      'antigravity-cli',
      Buffer.from([0x10, 0x0b, 0x28, 0x02, 0xa0, 0x01, 0x11, 0xa8, 0x01, 0x01])
    );
  cliSumDb.close();

  try {
    // 4. Restore Desktop trajectory after CLI turn finishes
    const res = await restoreAntigravityDesktopTrajectory({
      sessionId,
      antigravityDataDir: deskDir,
      antigravityCliDataDir: cliDir,
    });
    assert.equal(res.restored, true);
    assert.equal(res.syncedBack, true);
    assert.equal(res.truncatedCliStub, true);
    assert.equal(res.title, 'Clash Royale AI Research Setup');

    // CLI DB must exist as a 0-byte sentinel stub (not deleted, and not >0 bytes)
    assert.equal(fs.existsSync(cliConvPath), true);
    assert.equal(fs.statSync(cliConvPath).size, 0);

    // Desktop DB must now contain step 11 synced back from CLI
    const checkDeskTraj = new DatabaseSync(deskConvPath, { readOnly: true });
    const steps = checkDeskTraj.prepare('SELECT step_index, content FROM trajectory_steps ORDER BY step_index').all();
    checkDeskTraj.close();
    assert.equal(steps.length, 2);
    assert.equal(steps[1].step_index, 11);

    // Desktop conversation_summaries.db must have source='' and title='Clash Royale AI Research Setup'
    const checkDeskSum = new DatabaseSync(path.join(deskDir, 'conversation_summaries.db'), { readOnly: true });
    const row = checkDeskSum
      .prepare('SELECT title, step_count, status, source FROM conversation_summaries WHERE conversation_id = ?')
      .get(sessionId);
    checkDeskSum.close();
    assert.equal(row.title, 'Clash Royale AI Research Setup');
    assert.equal(row.step_count, 11);
    assert.equal(row.status, 'CASCADE_RUN_STATUS_IDLE');
    assert.equal(row.source, '');

    // 5. Next CLI turn must recognize the 0-byte stub and re-bridge Desktop -> CLI cleanly
    const bridge2 = await ensureAntigravityCliTrajectory({
      sessionId,
      antigravityDataDir: deskDir,
      antigravityCliDataDir: cliDir,
    });
    assert.equal(bridge2.bridged, true);
    assert.equal(fs.statSync(cliConvPath).size > 0, true);

    // 6. discoverLocalSessions must auto-heal any idle non-empty CLI copy back to 0-byte stub
    const discovered = await discoverLocalSessions({
      codexHomeDir: codexHome,
      antigravityDataDir: deskDir,
      antigravityCliDataDir: cliDir,
    });
    assert.equal(fs.statSync(cliConvPath).size, 0);
    assert.equal(
      discovered.antigravity.some((s) => s.id === sessionId && s.title === 'Clash Royale AI Research Setup'),
      true
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('v3.0.0: IDE Real-Time Task Progress Board, return-to-chat collaboration loop, and streamlined UI contracts', async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const {
    parseIdeStepsFromText,
    parseCollabSignal,
    stripIdeProtocolTags,
    extractActorSubtaskHint,
  } = await import('../server/ide-collab.mjs');

  // 1. Unit checks for protocol helpers
  const rawWithTags = [
    '我已经梳理完后端结构。',
    '<!--achat-steps:[{"title":"核对接口结构","status":"done"},{"title":"等待同伴确认字段","status":"active"}]-->',
    '<!--achat-collab:{"needCollab":true,"to":"antigravity","reason":"接口字段需确认","message":"返回体用 ideBoard 还是 board？"}-->',
  ].join('\n');

  const steps = parseIdeStepsFromText(rawWithTags);
  assert.equal(steps.length, 2);
  assert.equal(steps[0].status, 'done');
  assert.equal(steps[1].status, 'active');

  const sig = parseCollabSignal(rawWithTags, { fromActor: 'codex' });
  assert.ok(sig);
  assert.equal(sig.needCollab, true);
  assert.equal(sig.to, 'antigravity');
  assert.equal(sig.reason, '接口字段需确认');
  assert.match(sig.message, /ideBoard/);

  const stripped = stripIdeProtocolTags(`${rawWithTags}\n<!--achat-steps:[{"title":"流式未闭合`);
  assert.equal(stripped, '我已经梳理完后端结构。');
  assert.equal(
    extractActorSubtaskHint('- Codex 负责：搭建看板后端\n- Antigravity 负责：实现前端视图', 'codex'),
    '搭建看板后端'
  );

  // 2. End-to-end CcccBridge IDE Task Board & multi-round return-to-chat collaboration
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aw-v300-'));
  const groupsDir = path.join(tmpDir, 'groups');
  const dataDir = path.join(tmpDir, 'data');
  const gid = 'g_v300_collab';
  await fsp.mkdir(path.join(groupsDir, gid), { recursive: true });
  await fsp.writeFile(
    path.join(groupsDir, gid, 'group.yaml'),
    `group_id: ${gid}\ntitle: v3协作测试群\ntopic: test\n`,
    'utf8'
  );
  await fsp.writeFile(path.join(groupsDir, gid, 'ledger.jsonl'), '', 'utf8');

  const runnerCalls = [];
  let codexExecRound = 0;
  const bridge = new CcccBridge({
    dataDir,
    groupsDir,
    execCcccOverride: async () => '',
    execJsonOverride: async (args) => {
      if (args[0] === 'groups') {
        return { groups: [{ group_id: gid, title: 'v3协作测试群', running: true, state: 'active' }] };
      }
      if (args[0] === 'show') {
        return {
          group: { group_id: gid, title: 'v3协作测试群', scopes: [{ scope_key: 'main', label: 'main', url: tmpDir }] },
          effective_scope: { path: tmpDir },
          actors: [
            { id: 'codex', title: 'Codex', runtime: 'codex', running: true, enabled: true },
            { id: 'antigravity', title: 'Antigravity', runtime: 'antigravity', running: true, enabled: true },
          ],
        };
      }
      return {};
    },
    externalSessionRunnerOverride: async (params) => {
      runnerCalls.push({ agent: params.agent, phase: params.phase, permission: params.permission });

      if (params.phase === 'discuss_lead') {
        return {
          ok: true,
          sessionId: 'cx-ide-1',
          text: '- Codex 负责：完成后端协议解析\n- Antigravity 负责：渲染任务看板\n<!--achat-steps:[{"title":"梳理方案","status":"done"},{"title":"编码落地","status":"pending"}]-->',
        };
      }
      if (params.phase === 'discuss_peer') {
        return {
          ok: true,
          sessionId: 'ag-ide-1',
          text: '已确认分工：\n- Codex 负责：完成后端协议解析\n- Antigravity 负责：渲染任务看板\n<!--achat-steps:[{"title":"群内分工对齐","status":"done"},{"title":"进入IDE执行","status":"pending"}]-->',
        };
      }
      if (params.phase === 'collab_sync') {
        return {
          ok: true,
          sessionId: 'ag-ide-1',
          text: '@Codex 确认字段名统一使用 `ideBoard`，你可以直接按此继续写入！\n<!--achat-steps:[{"title":"回群确认接口字段","status":"done"},{"title":"完成前端联调","status":"active"}]-->',
        };
      }

      // IDE execution turns
      if (params.agent === 'codex') {
        codexExecRound += 1;
        params.onProgress?.({
          stepLabel: codexExecRound === 1 ? '⚙ 执行命令：检查 schema' : '⚙ 执行命令：node --test',
          text:
            codexExecRound === 1
              ? '正在核对数据结构。\n<!--achat-steps:[{"title":"读取现有结构","status":"done"},{"title":"等待同伴确认字段","status":"active"}]-->'
              : '测试已全过。\n<!--achat-steps:[{"title":"写入最终结构","status":"done"},{"title":"通过全部测试","status":"done"}]-->',
          thoughtTrace: [
            {
              kind: 'tool',
              text: codexExecRound === 1 ? '⚙ 执行命令：检查 schema' : '⚙ 执行命令：node --test',
            },
          ],
        });
        if (codexExecRound === 1) {
          return {
            ok: true,
            sessionId: 'cx-ide-1',
            thoughtTrace: [{ kind: 'tool', text: '⚙ 执行命令：检查 schema' }],
            text: '第 1 轮已检查完毕，需要跟 Antigravity 确认字段命名。\n<!--achat-steps:[{"title":"读取现有结构","status":"done"},{"title":"回群确认字段","status":"active"}]-->\n<!--achat-collab:{"needCollab":true,"to":"antigravity","reason":"字段命名对齐","message":"请问前端预期字段用 ideBoard 还是 board？"}-->',
          };
        }
        return {
          ok: true,
          sessionId: 'cx-ide-1',
          thoughtTrace: [{ kind: 'tool', text: '⚙ 执行命令：node --test' }],
          text: '后端已完成落地并自测通过。\n<!--achat-steps:[{"title":"写入最终结构","status":"done"},{"title":"通过全部测试","status":"done"}]-->',
        };
      }

      // Antigravity IDE execution turns
      params.onProgress?.({
        stepLabel: '📖 读取文件：app.mjs',
        text: '正在准备前端界面。\n<!--achat-steps:[{"title":"准备看板视图","status":"active"}]-->',
        thoughtTrace: [{ kind: 'tool', text: '📖 读取文件：app.mjs' }],
      });
      return {
        ok: true,
        sessionId: 'ag-ide-1',
        thoughtTrace: [{ kind: 'tool', text: '📖 读取文件：app.mjs' }],
        text: '前端看板适配完成。\n<!--achat-steps:[{"title":"准备看板视图","status":"done"}]-->',
      };
    },
  });

  const boardEvents = [];
  bridge.on('ideBoard', (ev) => boardEvents.push(ev));

  try {
    await bridge.listGroups({ force: true });
    await bridge.setGroupPrefs(gid, {
      sessionRouting: {
        enabled: true,
        flow: 'discuss_then_exec',
        permission: 'workspace-write',
        codex: { mode: 'existing', sessionId: 'cx-ide-1', sessionTitle: 'Codex IDE', cwd: tmpDir },
        antigravity: { mode: 'existing', sessionId: 'ag-ide-1', sessionTitle: 'Ag IDE', cwd: tmpDir },
      },
    });

    await bridge.sendGroupMessage(gid, {
      text: '请共同完成 IDE 进度看板联动',
      to: ['@all'],
      mode: 'send',
    });

    // Wait for workflow (1 alignment pair + wave 1 exec + 1 collab_sync + wave 2 exec = 7 runner calls)
    for (let i = 0; i < 60 && runnerCalls.length < 7; i += 1) {
      await sleep(35);
    }
    // Let final board/message flush
    for (let i = 0; i < 30; i += 1) {
      const b = bridge.getIdeBoardSnapshot(gid);
      if (b && /协同完成/.test(b.stageText)) break;
      await sleep(25);
    }

    assert.equal(runnerCalls.length, 7, 'Must run align(2) -> wave1(2) -> collab_sync(1) -> wave2(2)');
    assert.equal(
      runnerCalls.some((c) => c.phase === 'collab_sync' && c.agent === 'antigravity' && c.permission === 'read-only'),
      true,
      'Return-to-chat collaboration turn must dispatch addressed peer in read-only chat sync mode'
    );

    const msgs = await bridge.getMessages(gid);
    assert.equal(
      msgs.some((m) => /回群请求协作/.test(m.insight || '') && /ideBoard/.test(m.text || '')),
      true,
      'Chat history must display readable return-to-chat collaboration request'
    );
    assert.equal(
      msgs.some((m) => /回群协作回应/.test(m.insight || '') && /统一使用/.test(m.text || '')),
      true,
      'Chat history must display peer collaboration reply back in AChat'
    );
    assert.equal(
      msgs.some((m) => /<!--achat-collab:|<!--achat-steps:/.test(m.text || '')),
      false,
      'Internal protocol tags must be stripped from visible chat bubbles'
    );

    assert.ok(boardEvents.length >= 3, 'Live ideBoard SSE events must fire during workflow');
    const finalBoard = bridge.getIdeBoardSnapshot(gid);
    assert.ok(finalBoard);
    assert.equal(finalBoard.round, 2);
    assert.equal(finalBoard.actors.codex.phase, 'done');
    assert.equal(finalBoard.actors.codex.subtask, '完成后端协议解析');
    assert.equal(
      finalBoard.actors.codex.recentActions.some((a) => /node --test/.test(a.text)),
      true,
      'IDE board recentActions must capture live IDE commands'
    );
  } finally {
    bridge.stop();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }

  // 3. Frontend HTML / JS / CSS contracts for v3.0 IDE Task Board & streamlined composer
  const html = await fsp.readFile(path.join(process.cwd(), 'public', 'index.html'), 'utf8');
  const appJs = await fsp.readFile(path.join(process.cwd(), 'public', 'app.mjs'), 'utf8');
  const css = await fsp.readFile(path.join(process.cwd(), 'public', 'styles.css'), 'utf8');
  assert.match(html, /id="ideTaskBoard"/);
  assert.match(html, /id="itbGrid"/);
  assert.match(html, /id="sessionPresetPanel"/);
  assert.match(html, /id="toggleSessionPresetsBtn"/);
  assert.match(appJs, /function renderIdeTaskBoard/);
  assert.match(appJs, /es\.addEventListener\('ideBoard'/);
  assert.match(css, /\.ide-task-board\s*\{/);
  assert.match(css, /\.stb-preset-panel\s*\{/);
});

test('Standby Gateway & Watchdog guard: never auto-starts idle/missingBinary stopped actors, wakes on phone/client connect, and returns to standby when idle', async () => {
  // Part 1: Watchdog must NOT auto-start stopped actors (normal or missingBinary) without an unfinished pending turn
  const tmpWatch = await fsp.mkdtemp(path.join(os.tmpdir(), 'aw-watchdog-idle-'));
  const watchDataDir = path.join(tmpWatch, 'data');
  const watchGroupsDir = path.join(tmpWatch, 'groups');
  const gidWatch = 'g_idle_watch';
  await fsp.mkdir(path.join(watchGroupsDir, gidWatch), { recursive: true });
  await fsp.mkdir(watchDataDir, { recursive: true });
  await fsp.writeFile(path.join(watchGroupsDir, gidWatch, 'ledger.jsonl'), '', 'utf8');

  const watchCliCalls = [];
  let actorCmd = [path.join(tmpWatch, 'missing-codex-bin', 'codex.exe')];
  const watchBridge = new CcccBridge({
    dataDir: watchDataDir,
    groupsDir: watchGroupsDir,
    enableWatchdogInTests: true,
    execCcccOverride: async (args) => {
      watchCliCalls.push(args);
      return { stdout: '', stderr: '' };
    },
    execJsonOverride: async (args) => {
      if (args[0] === 'groups') {
        return {
          groups: [
            {
              group_id: gidWatch,
              title: 'Idle Watch Group',
              running: true,
              desired_running: true,
              state: 'active',
            },
          ],
        };
      }
      if (args[0] === 'group' && args[1] === 'show') {
        return { group: { group_id: gidWatch, title: 'Idle Watch Group', actors: [] } };
      }
      if (args[0] === 'actor' && args[1] === 'list') {
        return {
          actors: [
            {
              id: 'codex',
              title: 'Codex',
              runtime: 'codex',
              enabled: true,
              running: false,
              effective_working_state: 'idle',
              command: actorCmd,
            },
            {
              id: 'antigravity',
              title: 'Antigravity',
              runtime: 'antigravity',
              enabled: true,
              running: false,
              effective_working_state: 'idle',
              command: ['agy'],
            },
          ],
        };
      }
      return {};
    },
  });

  try {
    await watchBridge.primeAllLedgers();
    // Missing binary while stopped + no pendingMeta -> updates command config ONLY, ZERO actor start
    await watchBridge.listGroups({ force: true });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(
      watchCliCalls.some((c) => c[0] === 'actor' && c[1] === 'update' && c.includes('codex')),
      true,
      'missingBinary on stopped idle codex should still refresh its binary path in config'
    );
    assert.equal(
      watchCliCalls.some((c) => c[0] === 'actor' && c[1] === 'start'),
      false,
      'missingBinary without pendingMeta must NEVER start stopped codex actor'
    );

    // Normal binary path while stopped + no pendingMeta -> STILL zero actor start
    actorCmd = ['codex'];
    watchBridge.autoHealCooldown.clear();
    await watchBridge.listGroups({ force: true });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(
      watchCliCalls.some((c) => c[0] === 'actor' && c[1] === 'start'),
      false,
      'Idle group with stopped actors and no pendingMeta must NEVER call actor start'
    );
  } finally {
    watchBridge.stop();
    try {
      fs.rmSync(tmpWatch, { recursive: true, force: true });
    } catch {}
  }

  // Part 2: HTTP Standby Gateway -> Wake on /api/bootstrap -> Target-only message wake -> Auto-standby on idle
  const tmpSrv = await fsp.mkdtemp(path.join(os.tmpdir(), 'aw-standby-srv-'));
  const srvDataDir = path.join(tmpSrv, 'data');
  const srvGroupsDir = path.join(tmpSrv, 'groups');
  const srvUploadsDir = path.join(tmpSrv, 'uploads');
  const gidStandby = 'g_standby_test';
  await fsp.mkdir(path.join(srvGroupsDir, gidStandby), { recursive: true });
  await fsp.mkdir(srvDataDir, { recursive: true });
  await fsp.mkdir(srvUploadsDir, { recursive: true });
  await fsp.writeFile(path.join(srvGroupsDir, gidStandby, 'ledger.jsonl'), '', 'utf8');

  let daemonRunning = true;
  let groupRunning = true;
  let groupState = 'active';
  const runningActors = { codex: false, antigravity: false };
  const srvCliCalls = [];

  const srv = await startAgentWeChatServer({
    port: 0,
    host: '127.0.0.1',
    enableTunnel: false,
    dataDir: srvDataDir,
    uploadsDir: srvUploadsDir,
    startInStandby: true,
    idleStandbyMs: 380,
    bridgeOptions: {
      groupsDir: srvGroupsDir,
      composerMinWaitMs: 0,
      composerPollIntervalMs: 5,
      allowStandbyExecInTests: true,
      execCcccOverride: async (args) => {
        srvCliCalls.push(args);
        if (args[0] === 'status') {
          return {
            stdout: daemonRunning ? 'Daemon: running\n' : 'Daemon: stopped\n',
            stderr: '',
          };
        }
        if (args[0] === 'group' && args[1] === 'stop') {
          groupRunning = false;
          groupState = 'stopped';
          runningActors.codex = false;
          runningActors.antigravity = false;
          return { stdout: '', stderr: '' };
        }
        if (args[0] === 'group' && args[1] === 'set-state' && args[4] === 'active') {
          groupRunning = true;
          groupState = 'active';
          return { stdout: '', stderr: '' };
        }
        if (args[0] === 'daemon' && args[1] === 'stop') {
          daemonRunning = false;
          return { stdout: '', stderr: '' };
        }
        if (args[0] === 'actor' && args[1] === 'start') {
          daemonRunning = true;
          const actorId = args[4];
          if (actorId in runningActors) runningActors[actorId] = true;
          return { stdout: '', stderr: '' };
        }
        if (args[0] === 'send') {
          return { stdout: JSON.stringify({ ok: true, event_id: 'ev-wake-1' }), stderr: '' };
        }
        return { stdout: '', stderr: '' };
      },
      execJsonOverride: async (args) => {
        if (args[0] === 'groups') {
          return {
            groups: [
              {
                group_id: gidStandby,
                title: 'Standby Wake Group',
                running: groupRunning,
                desired_running: groupRunning,
                state: groupState,
              },
            ],
          };
        }
        if (args[0] === 'group' && args[1] === 'show') {
          return {
            group: { group_id: gidStandby, title: 'Standby Wake Group', actors: [] },
          };
        }
        if (args[0] === 'actor' && args[1] === 'list') {
          return {
            actors: [
              {
                id: 'codex',
                title: 'Codex',
                runtime: 'codex',
                enabled: true,
                running: runningActors.codex,
                effective_working_state: 'idle',
                command: ['codex'],
              },
              {
                id: 'antigravity',
                title: 'Antigravity',
                runtime: 'antigravity',
                enabled: true,
                running: runningActors.antigravity,
                effective_working_state: 'idle',
                command: ['agy'],
              },
            ],
          };
        }
        return {};
      },
    },
  });

  try {
    // 1. Initial standby stopped active groups & daemon cleanly
    assert.equal(srv.bridge.standbyMode, true, 'Server initialized with startInStandby must start in standby');
    assert.equal(daemonRunning, false, 'enterStandby on boot must stop active cccc daemon');
    assert.equal(groupState, 'stopped', 'enterStandby must mark groups stopped in group.yaml');

    // 2. GET /api/session does NOT wake Standby
    const sess1Res = await fetch(`${srv.url}/api/session`);
    assert.equal(sess1Res.status, 200);
    const sess1 = await sess1Res.json();
    assert.equal(sess1.standby, true, '/api/session must report standby without waking');
    assert.equal(srv.bridge.standbyMode, true);

    // 3. Simulated mobile/PC connect (/api/bootstrap) wakes gateway WITHOUT starting stopped actors
    const bootRes = await fetch(`${srv.url}/api/bootstrap`);
    assert.equal(bootRes.status, 200);
    const bootJson = await bootRes.json();
    assert.equal(srv.bridge.standbyMode, false, '/api/bootstrap must wake gateway from standby');
    const wokeGroup = bootJson.groups.find((g) => g.id === gidStandby);
    assert.ok(wokeGroup);
    assert.equal(wokeGroup.actors.every((a) => !a.running), true, 'Waking gateway must keep idle actors stopped');
    assert.equal(
      srvCliCalls.some((c) => c[0] === 'actor' && c[1] === 'start'),
      false,
      'Waking gateway to view chats must not spawn any actor PTYs'
    );

    // 4. Sending message to @codex reactivates group delivery state and starts ONLY codex
    const sendRes = await fetch(`${srv.url}/api/groups/${gidStandby}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '@codex help check build', to: ['codex'] }),
    });
    assert.equal(sendRes.status, 200);
    assert.equal(
      srvCliCalls.some((c) => c[0] === 'group' && c[1] === 'set-state' && c[3] === gidStandby && c[4] === 'active'),
      true,
      'sendGroupMessage on stopped group must reactivate group delivery state'
    );
    assert.equal(runningActors.codex, true, 'Addressed codex actor must wake on message send');
    assert.equal(runningActors.antigravity, false, 'Unaddressed antigravity actor must stay stopped');

    // 5. After idle timeout with 0 SSE clients and no pending work, server automatically returns to standby
    await new Promise((r) => setTimeout(r, 700));
    const sess2 = await (await fetch(`${srv.url}/api/session`)).json();
    assert.equal(sess2.standby, true, 'Server must auto-enter standby after idle timeout with 0 SSE clients');
    assert.equal(daemonRunning, false, 'Auto-standby must stop cccc daemon');
    assert.equal(groupState, 'stopped', 'Auto-standby must stop active groups');
  } finally {
    await srv.close();
    try {
      fs.rmSync(tmpSrv, { recursive: true, force: true });
    } catch {}
  }
});

test('33. Dual-skin UI system (workbench + editorial) preserves FOUC-free bootstrap, reactive tokens, and controls', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  const appMjs = fs.readFileSync(new URL('../public/app.mjs', import.meta.url), 'utf8');

  // HTML: FOUC-free head bootstrap for skin + color-scheme & accessible skin switch controls
  assert.match(html, /<meta\s+name="color-scheme"\s+content="light dark"/);
  assert.match(html, /documentElement\.dataset\.uiSkin\s*=/);
  assert.match(html, /id="skinToggleBtn"[^>]*aria-label=/);
  assert.match(html, /id="mobileSkinBtn"/);
  assert.match(html, /data-skin-choice="workbench"/);
  assert.match(html, /data-skin-choice="editorial"/);
  assert.doesNotMatch(html, /transition[^;]*scrollbar-color/i);

  // JS: dual-skin state, IDE board skin-aware default collapse, monogram avatars & Ctrl+K palette actions
  assert.match(appMjs, /UI_SKIN_STORAGE_KEY\s*=\s*'achat-ui-skin'/);
  assert.match(appMjs, /function applyUiSkin\(/);
  assert.match(appMjs, /function toggleUiSkin\(/);
  assert.match(appMjs, /function isIdeBoardCollapsedForGroup\(/);
  assert.match(appMjs, /function extractGroupMonogram\(/);
  assert.match(appMjs, /极简工作台/);
  assert.match(appMjs, /沉浸阅读/);
  assert.match(appMjs, /addEventListener\('storage'/);

  // CSS: root color-scheme light dark, light-dark(), Skin B editorial tokens & open canvas, high contrast, no scrollbar-color transition
  assert.match(css, /:root\s*\{\s*color-scheme:\s*light dark;/);
  assert.match(css, /:root:where\(\[data-ui-skin="editorial"\]\)/);
  assert.match(css, /:root\[data-ui-skin="editorial"\]\s+\.msg-row\.is-other\s+\.msg-bubble/);
  assert.match(css, /:root\[data-ui-skin="editorial"\]\s+\.ide-task-board\.is-collapsed/);
  assert.match(css, /light-dark\(/);
  assert.match(css, /@media\s*\(forced-colors:\s*active\)[\s\S]*\[data-skin-choice\]\.is-active/);
  assert.doesNotMatch(css, /transition\s*:[^;]*scrollbar-color/i);
});




