const fs = require('node:fs/promises');
const path = require('node:path');
const{isIP}=require('node:net');
class PublicError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new PublicError(code, message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function text(value, label, max = 255) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) fail('INVALID_INPUT', `${label} is missing or invalid.`);
  return value.trim();
}
function validateConnect(value) {
  if (!object(value)) fail('INVALID_INPUT', 'Invalid connection request.');
  const name = text(value.name, 'Server name', 80), host = text(value.host, 'Host', 253).toLowerCase();
  if (!/^[a-z0-9:._-]+$/i.test(host) || host.startsWith('-')) fail('INVALID_INPUT', 'Enter an IP address or hostname without a protocol or path.');
  if(host.includes(':')&&isIP(host)!==6)fail('INVALID_INPUT','Enter only the IP address or hostname in Address. Put the SSH port in the separate Port field (for example, address 203.0.113.10 and port 22).');
  if(/^(?:[0-9]+\.){3}[0-9]+$/.test(host)&&isIP(host)!==4)fail('INVALID_INPUT','Enter a valid IPv4 address; each number must be from 0 to 255.');
  const username = text(value.username, 'Username', 128);
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) fail('INVALID_INPUT', 'Port must be between 1 and 65535.');
  if (!['password', 'key'].includes(value.authMethod)) fail('INVALID_INPUT', 'Choose password or SSH key authentication.');
  if (typeof value.rememberSecret !== 'boolean' || typeof value.useSavedSecret !== 'boolean') fail('INVALID_INPUT', 'Invalid credential preference.');
  for (const key of ['password', 'passphrase']) if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length > 16384)) fail('INVALID_INPUT', 'Credential is too long or invalid.');
  if (value.profileId !== undefined) validateId(value.profileId);
  if (value.keyId !== undefined) validateId(value.keyId);
  return { ...value, name, host, username };
}
function validateId(value) { if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/.test(value)) fail('INVALID_INPUT', 'Invalid identifier.'); return value; }
function publicProfile(profile) {
  return { id: profile.id, name: profile.name, host: profile.host, port: profile.port, username: profile.username, authMethod: profile.authMethod, hasSecret: Boolean(profile.secret), lastConnectedAt: profile.lastConnectedAt };
}
class ConnectionStore {
  constructor(root, vault) { this.root = root; this.file = path.join(root, 'connections.json'); this.vault = vault; this.data = { version: 1, profiles: [], hosts: {} }; this.queue = Promise.resolve(); }
  async init() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (!object(parsed) || parsed.version !== 1 || !Array.isArray(parsed.profiles) || !object(parsed.hosts)) throw new Error('invalid');
      for (const profile of parsed.profiles) {
        validateId(profile.id); validateConnect({ ...profile, useSavedSecret: false, rememberSecret: false });
        if (profile.secret !== undefined && (typeof profile.secret !== 'string' || profile.secret.length > 1000000)) throw new Error('invalid');
      }
      for (const fingerprint of Object.values(parsed.hosts)) if (typeof fingerprint !== 'string' || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint)) throw new Error('invalid');
      this.data = parsed;
    } catch (error) { if (error.code !== 'ENOENT') fail('STORE_UNAVAILABLE', 'Saved connections could not be read. Your existing data has been preserved.'); }
  }
  async persist() {
    const body = JSON.stringify(this.data, null, 2);
    const task = this.queue.catch(() => {}).then(async () => {
      const temp = this.file + '.tmp';
      await fs.writeFile(temp, body, { mode: 0o600 });
      await fs.chmod(temp, 0o600);
      await fs.rename(temp, this.file);
    });
    this.queue = task;
    try { await task; } catch { fail('SAVE_FAILED', 'Unable to save connection settings. Check your local app-data permissions.'); }
  }
  list() { return this.data.profiles.map(publicProfile).sort((a, b) => (b.lastConnectedAt || '').localeCompare(a.lastConnectedAt || '')); }
  async available() { try { return ['darwin', 'win32'].includes(process.platform) && await this.vault.isAsyncEncryptionAvailable(); } catch { return false; } }
  async secret(profile) {
    if (!profile?.secret) fail('NO_SAVED_SECRET', 'No saved credential is available. Enter it again.');
    try {
      const decrypted = await this.vault.decryptStringAsync(Buffer.from(profile.secret, 'base64'));
      const value = JSON.parse(decrypted.result);
      require('./log-context.cjs').register(value);
      if (decrypted.shouldReEncrypt) { profile.secret = (await this.vault.encryptStringAsync(decrypted.result)).toString('base64'); await this.persist(); }
      return value;
    } catch { fail('SECRET_UNAVAILABLE', 'The saved credential could not be unlocked. Enter it again or unlock your system credential store.'); }
  }
  async save(profile, credential, remember) {
    let secret;
    if (remember) {
      if (!await this.available()) fail('VAULT_UNAVAILABLE', 'Secure credential storage is unavailable. Connect without saving the credential.');
      try { secret = (await this.vault.encryptStringAsync(JSON.stringify(credential))).toString('base64'); }
      catch { fail('VAULT_UNAVAILABLE', 'The connection succeeded, but its credential could not be encrypted.'); }
    }
    const next = { ...profile, secret, lastConnectedAt: new Date().toISOString() };
    const index = this.data.profiles.findIndex(p => p.id === profile.id);
    if (index < 0) this.data.profiles.push(next); else this.data.profiles[index] = next;
    await this.persist(); return publicProfile(next);
  }
  async remove(id) { this.data.profiles = this.data.profiles.filter(p => p.id !== id); await this.persist(); }
  async forget(id) { const profile = this.data.profiles.find(p => p.id === id); if (profile) { delete profile.secret; await this.persist(); } }
}
module.exports = { ConnectionStore, PublicError, fail, object, validateConnect, validateId, publicProfile };
