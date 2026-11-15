import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const BEACON_FILE_NAME = 'agent-wechat-beacon.json';
const KEY_DOMAIN_PREFIX = 'agent-wechat-beacon-v1:';
const TUNNEL_ORIGIN_RE = /https:\/\/([a-z0-9-]+(?:\.lhr\.life|\.trycloudflare\.com))\b/gi;

const DEFAULT_SSH_WIN = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe';
const DEFAULT_GH_WIN = 'C:\\Program Files\\GitHub CLI\\gh.exe';

export function deriveBeaconKey(accessToken) {
  const clean = String(accessToken || '').trim();
  if (!clean) {
    throw new Error('accessToken is required for beacon encryption');
  }
  return crypto.createHash('sha256').update(`${KEY_DOMAIN_PREFIX}${clean}`, 'utf8').digest();
}

export function encryptBeaconPayload(payload, accessToken) {
  const key = deriveBeaconKey(accessToken);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plainBuf = Buffer.from(JSON.stringify(payload), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plainBuf), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const combined = Buffer.concat([encrypted, authTag]);
  return {
    v: 1,
    alg: 'AES-256-GCM',
    iv: iv.toString('base64'),
    ct: combined.toString('base64'),
    ts: Date.now(),
  };
}

export function decryptBeaconPayload(envelope, accessToken) {
  if (!envelope || envelope.alg !== 'AES-256-GCM') {
    throw new Error('Unsupported beacon envelope format');
  }
  const key = deriveBeaconKey(accessToken);
  const iv = Buffer.from(String(envelope.iv || ''), 'base64');
  const combined = Buffer.from(String(envelope.ct || ''), 'base64');
  if (iv.length !== 12 || combined.length < 17) {
    throw new Error('Invalid beacon IV or ciphertext length');
  }
  const encrypted = combined.subarray(0, combined.length - 16);
  const authTag = combined.subarray(combined.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  return JSON.parse(plain);
}

export function extractTunnelUrlFromChunk(text = '') {
  const raw = String(text || '');
  let lastUrl = '';
  for (const match of raw.matchAll(TUNNEL_ORIGIN_RE)) {
    if (match[1]) {
      lastUrl = `https://${match[1].toLowerCase()}`;
    }
  }
  return lastUrl;
}

function resolveBinary(preferredWinPath, fallbackCmd) {
  if (process.platform === 'win32' && fs.existsSync(preferredWinPath)) {
    return preferredWinPath;
  }
  return fallbackCmd;
}

function execWithJsonStdin(bin, args, inputObj, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        try {
          child.kill();
        } catch {
          // ignore
        }
        reject(new Error(`Command timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
    });
    child.on('error', (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error((stderr || stdout || `Exit code ${code}`).trim()));
      }
    });

    try {
      child.stdin.write(JSON.stringify(inputObj));
      child.stdin.end();
    } catch (err) {
      clearTimeout(timer);
      reject(err);
    }
  });
}

export class TunnelManager extends EventEmitter {
  constructor({ dataDir, localPort = 8866, accessToken, getLanUrl }) {
    super();
    this.dataDir = dataDir;
    this.localPort = localPort;
    this.accessToken = accessToken;
    this.getLanUrl = getLanUrl;

    this.beaconStateFile = path.join(dataDir, 'beacon-state.json');
    this.tunnelStateFile = path.join(dataDir, 'remote-tunnel.json');

    this.beaconId = '';
    this.publicUrl = '';
    this.status = 'starting';
    this.lastUpdatedAt = '';
    this.lastBeaconSyncedAt = '';
    this.lastError = '';

    this.stopped = false;
    this.sshProc = null;
    this.reconnectTimer = null;
    this.healthTimer = null;
    this.stabilityTimer = null;
    this.backoffMs = 2000;
    this.consecutiveProbeFailures = 0;
    this.syncQueue = Promise.resolve();
  }

  getSnapshot() {
    return {
      publicUrl: this.publicUrl,
      beaconId: this.beaconId,
      status: this.status,
      lastUpdatedAt: this.lastUpdatedAt,
      lastBeaconSyncedAt: this.lastBeaconSyncedAt,
      lastError: this.lastError,
    };
  }

  async loadSavedState() {
    await fsp.mkdir(this.dataDir, { recursive: true });
    try {
      if (fs.existsSync(this.beaconStateFile)) {
        const saved = JSON.parse(await fsp.readFile(this.beaconStateFile, 'utf8'));
        if (/^[a-f0-9]{20,40}$/i.test(String(saved?.beaconId || ''))) {
          this.beaconId = String(saved.beaconId).trim();
          this.lastBeaconSyncedAt = String(saved.lastBeaconSyncedAt || '');
        }
      }
    } catch {
      // ignore corrupted state file
    }
  }

  async saveTunnelState() {
    try {
      await fsp.mkdir(this.dataDir, { recursive: true });
      await fsp.writeFile(
        this.tunnelStateFile,
        JSON.stringify(
          {
            publicUrl: this.publicUrl,
            beaconId: this.beaconId,
            provider: 'localhost.run (OpenSSH)',
            status: this.status,
            updatedAt: this.lastUpdatedAt || new Date().toISOString(),
            lastBeaconSyncedAt: this.lastBeaconSyncedAt,
          },
          null,
          2
        ),
        { encoding: 'utf8', mode: 0o600 }
      );
    } catch {
      // ignore transient write error
    }
  }

  async saveBeaconState() {
    try {
      await fsp.mkdir(this.dataDir, { recursive: true });
      await fsp.writeFile(
        this.beaconStateFile,
        JSON.stringify(
          {
            beaconId: this.beaconId,
            lastSyncedUrl: this.publicUrl,
            lastBeaconSyncedAt: this.lastBeaconSyncedAt,
          },
          null,
          2
        ),
        { encoding: 'utf8', mode: 0o600 }
      );
    } catch {
      // ignore
    }
  }

  enqueueBeaconSync(targetUrl) {
    this.syncQueue = this.syncQueue
      .then(() => this.syncEncryptedBeacon(targetUrl))
      .catch((err) => {
        this.lastError = `信标同步异常: ${err.message}`;
      });
    return this.syncQueue;
  }

  async syncEncryptedBeacon(targetUrl = this.publicUrl) {
    const ghBin = resolveBinary(DEFAULT_GH_WIN, 'gh');
    const lanUrl = typeof this.getLanUrl === 'function' ? this.getLanUrl() || '' : '';
    const envelope = encryptBeaconPayload(
      {
        v: 1,
        url: targetUrl || '',
        lanUrl,
        updatedAt: new Date().toISOString(),
      },
      this.accessToken
    );

    const requestBody = {
      description: 'AgentWeChat Encrypted Rendezvous Beacon (AES-256-GCM)',
      files: {
        [BEACON_FILE_NAME]: {
          content: JSON.stringify(envelope, null, 2),
        },
      },
    };

    if (this.beaconId) {
      try {
        await execWithJsonStdin(
          ghBin,
          ['api', '--method', 'PATCH', `/gists/${this.beaconId}`, '--input', '-'],
          requestBody
        );
        this.lastBeaconSyncedAt = new Date().toISOString();
        await this.saveBeaconState();
        await this.saveTunnelState();
        this.emit('update', this.getSnapshot());
        return this.beaconId;
      } catch (err) {
        if (!/404|Not Found/i.test(String(err.message || ''))) {
          throw err;
        }
        // Gist was deleted externally -> recreate below
        this.beaconId = '';
      }
    }

    const { stdout } = await execWithJsonStdin(
      ghBin,
      ['api', '--method', 'POST', '/gists', '--input', '-'],
      { ...requestBody, public: false }
    );
    const created = JSON.parse(stdout);
    const newId = String(created?.id || '').trim();
    if (!/^[a-f0-9]{20,40}$/i.test(newId)) {
      throw new Error('Failed to parse created Gist ID');
    }
    this.beaconId = newId;
    this.lastBeaconSyncedAt = new Date().toISOString();
    await this.saveBeaconState();
    await this.saveTunnelState();
    this.emit('update', this.getSnapshot());
    return this.beaconId;
  }

  async start() {
    this.stopped = false;
    await this.loadSavedState();

    // Ensure secret Gist beacon exists immediately on startup so pairing QR always has beaconId
    if (!this.beaconId) {
      try {
        await this.enqueueBeaconSync('');
      } catch (err) {
        this.lastError = err.message || '初始化加密云信标失败';
      }
    }

    this.spawnTunnelProcess();
    this.healthTimer = setInterval(() => {
      this.runSelfHealthProbe().catch(() => {});
    }, 75000);
  }

  spawnTunnelProcess() {
    if (this.stopped) return;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.stabilityTimer);

    const sshBin = resolveBinary(DEFAULT_SSH_WIN, 'ssh');
    const args = [
      '-T',
      '-o',
      'StrictHostKeyChecking=no',
      '-o',
      'UserKnownHostsFile=NUL',
      '-o',
      'ServerAliveInterval=25',
      '-o',
      'ServerAliveCountMax=3',
      '-o',
      'ConnectTimeout=12',
      '-o',
      'ExitOnForwardFailure=yes',
      '-R',
      `80:127.0.0.1:${this.localPort}`,
      'nokey@localhost.run',
      '--',
      '--output',
      'json',
    ];

    this.status = this.publicUrl ? 'reconnecting' : 'starting';
    const proc = spawn(sshBin, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.sshProc = proc;

    let boundaryTail = '';
    const onChunk = (chunk) => {
      if (this.stopped || proc !== this.sshProc) return;
      const chunkStr = chunk.toString('utf8');
      const combined = `${boundaryTail}${chunkStr}`;
      boundaryTail = combined.slice(-512);
      const discovered = extractTunnelUrlFromChunk(combined);
      if (discovered && discovered !== this.publicUrl) {
        this.publicUrl = discovered;
        this.status = 'online';
        this.lastUpdatedAt = new Date().toISOString();
        this.lastError = '';
        this.consecutiveProbeFailures = 0;

        clearTimeout(this.stabilityTimer);
        this.stabilityTimer = setTimeout(() => {
          this.backoffMs = 2000;
        }, 30000);

        this.saveTunnelState().catch(() => {});
        this.emit('update', this.getSnapshot());
        this.enqueueBeaconSync(discovered);
      }
    };

    proc.stdout.on('data', onChunk);
    proc.stderr.on('data', onChunk);

    proc.on('error', (err) => {
      if (proc !== this.sshProc) return;
      this.lastError = err.message;
    });

    proc.on('close', () => {
      if (proc !== this.sshProc) return;
      this.sshProc = null;
      clearTimeout(this.stabilityTimer);
      if (this.stopped) return;

      this.status = 'reconnecting';
      this.emit('update', this.getSnapshot());
      const delay = this.backoffMs;
      this.backoffMs = Math.min(20000, Math.round(this.backoffMs * 1.7));
      this.reconnectTimer = setTimeout(() => {
        this.spawnTunnelProcess();
      }, delay);
    });
  }

  async runSelfHealthProbe() {
    if (this.stopped || !this.publicUrl || !this.sshProc) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(`${this.publicUrl}/api/session`, {
        headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      if (typeof data?.authorized !== 'boolean') {
        throw new Error('Unexpected tunnel response payload');
      }
      this.consecutiveProbeFailures = 0;
    } catch (err) {
      clearTimeout(timer);
      this.consecutiveProbeFailures += 1;
      if (this.consecutiveProbeFailures >= 2 && this.sshProc) {
        this.lastError = `隧道自检连续失败 (${err.message})，正在自动重连`;
        this.consecutiveProbeFailures = 0;
        try {
          this.sshProc.kill();
        } catch {
          // ignore
        }
      }
    }
  }

  stop() {
    this.stopped = true;
    this.status = 'stopped';
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.stabilityTimer);
    clearInterval(this.healthTimer);
    if (this.sshProc) {
      const proc = this.sshProc;
      this.sshProc = null;
      try {
        proc.kill();
      } catch {
        // ignore
      }
    }
  }
}
