const { Client, utils } = require('ssh2');
const { createHash, randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const { ConnectionStore, fail, object, validateConnect, validateId, publicProfile } = require('./connection-store.cjs');
const activeStatuses = ['connecting', 'verifying', 'connected'];
class Connections extends EventEmitter {
  constructor({ root, vault, clientFactory = () => new Client(), hostTimeout = 60000 }) {
    super(); this.store = new ConnectionStore(root, vault); this.clients = new Map(); this.keys = new Map(); this.clientFactory = clientFactory; this.hostTimeout = hostTimeout; this.secureStorageAvailable = false; this.disposed = false;
  }
  async init() { await this.store.init(); this.secureStorageAvailable = await this.store.available(); }
  snapshot() { return { profiles: this.store.list(), sessions: [...this.clients.values()].map(record => structuredClone(record.session)), secureStorageAvailable: this.secureStorageAvailable }; }
  changed() { if (!this.disposed) this.emit('change', this.snapshot()); }
  async selectKey(file) {
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > 256000) fail('INVALID_KEY', 'Choose an SSH private-key file smaller than 256 KB.');
      const content = await fs.readFile(file, 'utf8');
      const parsed = utils.parseKey(content);
      if (parsed instanceof Error && !/encrypted|passphrase/i.test(parsed.message)) fail('INVALID_KEY', 'This file is not a supported SSH private key. Use an OpenSSH or PEM key.');
      if (!(parsed instanceof Error) && (Array.isArray(parsed) || !parsed.isPrivateKey())) fail('INVALID_KEY', 'Choose a private key, rather than a public key.');
      const id = randomUUID(); this.keys.set(id, { content, expires: Date.now() + 10 * 60 * 1000 });
      for (const [keyId, key] of this.keys) if (key.expires < Date.now() || this.keys.size > 10) this.keys.delete(keyId);
      return { id, name: require('node:path').basename(file) };
    } catch (error) { if (error.code === 'INVALID_KEY') throw error; fail('KEY_READ_FAILED', 'The selected key could not be read. Check its permissions.'); }
  }
  async connect(raw) {
    if (this.disposed) fail('CLOSED', 'The connection manager has closed.');
    const input = validateConnect(raw);
    if ([...this.clients.values()].filter(r => activeStatuses.includes(r.session.status)).length >= 8) fail('SESSION_LIMIT', 'Disconnect a server before opening more than eight SSH sessions.');
    const saved = input.profileId && this.store.data.profiles.find(p => p.id === input.profileId);
    if (input.profileId && !saved) fail('PROFILE_MISSING', 'This saved server no longer exists.');
    if (saved && (saved.host !== input.host || saved.port !== input.port || saved.username !== input.username || saved.authMethod !== input.authMethod)) fail('PROFILE_MISMATCH', 'Create a new connection when changing host, port, username, or authentication method.');
    let credential;
    if (input.useSavedSecret) { credential = await this.store.secret(saved); }
    else if (input.authMethod === 'password') {
      if (!input.password) fail('CREDENTIAL_REQUIRED', 'Enter the SSH password.');
      credential = { password: input.password };
    } else {
      const key = this.keys.get(input.keyId);
      if (!key || key.expires < Date.now()) fail('KEY_REQUIRED', 'Choose your SSH private-key file again.');
      const parsed = utils.parseKey(key.content, input.passphrase || undefined);
      if (parsed instanceof Error || Array.isArray(parsed) || !parsed.isPrivateKey()) fail('INVALID_KEY', 'The key could not be unlocked. Check its format and passphrase.');
      credential = { privateKey: key.content, passphrase: input.passphrase || '' };
    }
    delete input.password; delete input.passphrase; delete input.keyId;
    if (input.rememberSecret && !await this.store.available()) fail('VAULT_UNAVAILABLE', 'Secure storage is unavailable. Uncheck Remember credential to connect for this session.');
    // Recheck after asynchronous vault access; concurrent IPC calls cannot exceed the cap.
    if (this.disposed || [...this.clients.values()].filter(r => activeStatuses.includes(r.session.status)).length >= 8) fail('SESSION_LIMIT', 'No more SSH sessions can be opened right now.');
    const profile = { id: saved?.id || randomUUID(), name: input.name, host: input.host, port: input.port, username: input.username, authMethod: input.authMethod };
    const client = this.clientFactory();
    const session = { id: randomUUID(), profile: publicProfile(profile), status: 'connecting', message: 'Opening encrypted SSH connection…' };
    const record = { client, session, stopped: false, decision: null, timer: null };
    this.clients.set(session.id, record);
    // Bound historical sessions; live sockets are never evicted.
    for (const [id, old] of this.clients) if (this.clients.size > 40 && !activeStatuses.includes(old.session.status)) this.clients.delete(id);
    const endpoint = `${input.host}:${input.port}`;
    const cleanupChallenge = () => { clearTimeout(record.timer); record.timer = null; delete session.challenge; record.decision = null; };
    const stop = (status, message) => {
      if (record.stopped) return;
      record.stopped = true; credential = undefined; cleanupChallenge(); session.status = status; session.message = message; client.destroy(); this.changed();
    };
    record.stop = stop;
    client.on('error', error => {
      const message = error.level === 'client-authentication' ? 'Authentication failed. Check your username, password, or SSH key.' : error.code === 'ECONNREFUSED' ? 'Connection refused. Check the IP, port, and SSH service.' : error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN' ? 'Host could not be resolved. Check the address and DNS.' : error.code === 'ETIMEDOUT' || /timed out/i.test(error.message) ? 'Connection timed out. Check the network, firewall, and SSH port.' : 'SSH connection failed or was interrupted. Check the server and reconnect.';
      stop('error', message);
    });
    client.on('close', () => { if (!record.stopped) stop('disconnected', 'The server closed the connection. Reconnect when ready.'); });
    client.on('ready', async () => {
      if (record.stopped) return;
      cleanupChallenge(); session.status = 'connected'; session.message = 'SSH authentication succeeded. Browse server files over SFTP.'; session.connectedAt = new Date().toISOString(); this.changed();
      const saveCredential = credential; credential = undefined;
      try { session.profile = await this.store.save(profile, saveCredential, input.rememberSecret); }
      catch { session.warning = 'Connected, but local settings or credentials could not be saved. Check the system credential store and local app-data permissions.'; }
      credential = undefined;
      this.changed();
    });
    setImmediate(() => {
      if (record.stopped) { credential = undefined; return; }
      try {
        client.connect({
          host: input.host, port: input.port, username: input.username,
          ...(input.authMethod === 'password' ? { password: credential.password } : { privateKey: credential.privateKey, passphrase: credential.passphrase || undefined }),
          readyTimeout: this.hostTimeout + 20000, keepaliveInterval: 15000, keepaliveCountMax: 3,
          hostVerifier: (key, callback) => {
            if (record.stopped) { callback(false); return; }
            const fingerprint = 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
            const known = this.store.data.hosts[endpoint];
            session.fingerprint = fingerprint;
            if (known === fingerprint) { session.status = 'connecting'; session.message = 'Host fingerprint verified. Authenticating…'; this.changed(); callback(true); return; }
            session.status = 'verifying'; session.message = known ? 'Host fingerprint changed. Verify before replacing trust.' : 'Verify this server’s host fingerprint before connecting.';
            session.challenge = { id: randomUUID(), fingerprint, previousFingerprint: known, changed: Boolean(known) };
            record.decision = async (accept, replace) => {
              if (record.stopped) return;
              if (!accept) { stop('disconnected', 'Host fingerprint rejected. No authentication was attempted.'); callback(false); return; }
              if (known && !replace) fail('REPLACEMENT_REQUIRED', 'Explicitly confirm replacing the previous fingerprint.');
              record.decision = null; clearTimeout(record.timer);
              // Trust must be durably saved before credentials are sent.
              const previous = this.store.data.hosts[endpoint];
              this.store.data.hosts[endpoint] = fingerprint;
              try { await this.store.persist(); }
              catch { if (previous) this.store.data.hosts[endpoint] = previous; else delete this.store.data.hosts[endpoint]; stop('error', 'The host fingerprint could not be saved. Connection canceled.'); callback(false); return; }
              if (record.stopped) { callback(false); return; }
              cleanupChallenge(); session.status = 'connecting'; session.message = 'Host trusted. Authenticating…'; this.changed(); callback(true);
            };
            record.timer = setTimeout(() => { stop('error', 'Fingerprint confirmation timed out. Reconnect to try again.'); callback(false); }, this.hostTimeout);
            this.changed();
          }
        });
      } catch { credential = undefined; stop('error', 'Unable to start SSH. Check your connection details and key format.'); }
    });
    this.changed(); return structuredClone(session);
  }
  async decideHost(value) {
    if (!object(value) || typeof value.accept !== 'boolean' || typeof value.replace !== 'boolean') fail('INVALID_INPUT', 'Invalid host verification request.');
    validateId(value.sessionId); validateId(value.challengeId);
    const record = this.clients.get(value.sessionId);
    if (!record?.decision || record.session.challenge?.id !== value.challengeId) fail('STALE_CHALLENGE', 'This fingerprint request has expired. Reconnect to try again.');
    await record.decision(value.accept, value.replace);
  }
  disconnect(id) { validateId(id); const record = this.clients.get(id); if (record) record.stop('disconnected', 'Disconnected by you.'); }
  async removeProfile(id) { validateId(id); for (const record of this.clients.values()) if (record.session.profile.id === id) record.stop('disconnected', 'Saved server removed.'); await this.store.remove(id); this.changed(); }
  async forgetSecret(id) { validateId(id); await this.store.forget(id); this.changed(); }
  dispose() { this.disposed = true; for (const record of this.clients.values()) record.stop('disconnected', 'Application closed.'); this.keys.clear(); }
}
module.exports = { Connections };
