const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, createCipheriv, createDecipheriv } = require('node:crypto');
const { Connections } = require('../electron/connections.cjs');
const { validateConnect } = require('../electron/connection-store.cjs');
const { startFixture, makeKey } = require('../scripts/ssh-fixture.cjs');
const { allowedSender } = require('../electron/ipc-security.cjs');
function testVault() {
  const key = randomBytes(32);
  return { isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async value => { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]); },
    decryptStringAsync: async bytes => { const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(-16)); return { result: Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString(), shouldReEncrypt: false }; }
  };
}
const input = port => ({ name: 'Local test', host: '127.0.0.1', port, username: 'explorer', authMethod: 'password', password: 'explorer-test-only', useSavedSecret: false, rememberSecret: false });
async function waitFor(manager, predicate, timeout = 7000) {
  const started = Date.now();
  while (Date.now() - started < timeout) { const result = predicate(manager.snapshot()); if (result) return result; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Timed out waiting for connection state: ' + JSON.stringify(manager.snapshot()));
}
async function setup(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vps-explorer-test-'));
  const vault = testVault(), manager = new Connections({ root, vault, ...options }); await manager.init();
  t.after(async () => { manager.dispose(); await manager.store.queue.catch(() => {}); await fs.rm(root, { recursive: true, force: true }); });
  return { root, vault, manager };
}
async function trust(manager, id, replace = false) { const session = await waitFor(manager, s => s.sessions.find(s => s.id === id && s.challenge)); await manager.decideHost({ sessionId: id, challengeId: session.challenge.id, accept: true, replace }); }
test('endpoint validation rejects host-port mixtures before DNS and preserves IPv6 literals',()=>{
 for(const host of ['203.0.113.10:22','example.com:2222','127.0.0.1:22','2001:invalid::ip'])assert.throws(()=>validateConnect({...input(22),host}),/separate Port field/);
 for(const host of ['2001:db8::1','::1','::ffff:192.0.2.1'])assert.equal(validateConnect({...input(2222),host}).host,host);
 assert.equal(validateConnect({...input(2222),host:'example.com'}).port,2222);
 assert.throws(()=>validateConnect({...input(22),host:'999.1.1.1'}),/valid IPv4/);
});
test('connection validation rejects invalid ports, protocols, control characters and preference types', () => {
  assert.throws(() => validateConnect({ ...input(22), port: 0 }), /Port/);
  assert.throws(() => validateConnect({ ...input(22), host: 'ssh://example.com' }), /IP address/);
  assert.throws(() => validateConnect({ ...input(22), username: 'root\n' }), /Username/);
  assert.throws(() => validateConnect({ ...input(22), rememberSecret: 'yes' }), /preference/);
});
test('IPC sender checks reject subframes, other windows, untrusted URLs and closed windows', () => {
  const url = 'file:///trusted/index.html', frame = { url }, contents = { mainFrame: frame };
  const window = { webContents: contents, isDestroyed: () => false };
  assert.equal(allowedSender({ sender: contents, senderFrame: frame }, window, url), true);
  assert.equal(allowedSender({ sender: contents, senderFrame: { url } }, window, url), false);
  assert.equal(allowedSender({ sender: {}, senderFrame: frame }, window, url), false);
  assert.equal(allowedSender({ sender: contents, senderFrame: frame }, window, 'https://other.example'), false);
  assert.equal(allowedSender({ sender: contents, senderFrame: frame }, { ...window, isDestroyed: () => true }, url), false);
});
test('concurrent connects respect the eight-session cap and dispose closes every client', async t => {
  const { EventEmitter } = require('node:events');
  const clients = [];
  const { manager } = await setup(t, { clientFactory: () => { const client = new EventEmitter(); client.connect = () => {}; client.destroy = () => { client.closed = true; }; clients.push(client); return client; } });
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => manager.connect(input(22))));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 8);
  assert.equal(results.filter(r => r.status === 'rejected').length, 4);
  manager.dispose(); assert.equal(clients.every(c => c.closed), true);
});
test('first-use trust gates authentication; reject and stale decisions never authenticate', async t => {
  const { manager } = await setup(t); const fixture = await startFixture(); t.after(() => fixture.close());
  const session = await manager.connect(input(fixture.port));
  const pending = await waitFor(manager, s => s.sessions.find(s => s.id === session.id && s.challenge));
  assert.equal(pending.challenge.fingerprint, fixture.fingerprint); assert.equal(fixture.stats.authenticationAttempts, 0);
  await manager.decideHost({ sessionId: session.id, challengeId: pending.challenge.id, accept: false, replace: false });
  assert.equal(manager.snapshot().sessions[0].status, 'disconnected'); assert.equal(fixture.stats.authenticationAttempts, 0);
  await assert.rejects(manager.decideHost({ sessionId: session.id, challengeId: pending.challenge.id, accept: true, replace: false }), /expired/);
});
test('password login, encrypted persistence, reload, reconnect, disconnect and forget', async t => {
  const { manager, root, vault } = await setup(t); const fixture = await startFixture(); t.after(() => fixture.close());
  const session = await manager.connect({ ...input(fixture.port), rememberSecret: true }); await trust(manager, session.id);
  await waitFor(manager, s => s.profiles.find(p => p.hasSecret));
  const data = await fs.readFile(path.join(root, 'connections.json'), 'utf8');
  assert.equal(data.includes('explorer-test-only'), false); assert.equal(data.includes('privateKey'), false);
  assert.equal(JSON.stringify(manager.snapshot()).includes('explorer-test-only'), false);
  const permissions = await fs.stat(path.join(root, 'connections.json')); if (process.platform !== 'win32') assert.equal(permissions.mode & 0o777, 0o600);
  manager.disconnect(session.id);
  const reloaded = new Connections({ root, vault }); await reloaded.init(); t.after(() => reloaded.dispose());
  const profile = reloaded.snapshot().profiles[0];
  const next = await reloaded.connect({ ...input(fixture.port), password: undefined, profileId: profile.id, useSavedSecret: true, rememberSecret: true });
  await waitFor(reloaded, s => s.sessions.find(s => s.id === next.id && s.status === 'connected'));
  assert.equal(reloaded.snapshot().sessions[0].challenge, undefined);
  reloaded.disconnect(next.id); await reloaded.forgetSecret(profile.id);
  assert.equal(reloaded.snapshot().profiles[0].hasSecret, false);
  await reloaded.removeProfile(profile.id); assert.equal(reloaded.snapshot().profiles.length, 0);
});
test('wrong password yields sanitized authentication error, then a correct retry succeeds', async t => {
  const { manager } = await setup(t); const fixture = await startFixture(); t.after(() => fixture.close());
  const failed = await manager.connect({ ...input(fixture.port), password: 'secret-that-must-not-appear' }); await trust(manager, failed.id);
  const error = await waitFor(manager, s => s.sessions.find(s => s.id === failed.id && s.status === 'error'));
  assert.match(error.message, /Authentication failed/); assert.equal(JSON.stringify(manager.snapshot()).includes('secret-that-must-not-appear'), false);
  const retry = await manager.connect(input(fixture.port)); await waitFor(manager, s => s.sessions.find(s => s.id === retry.id && s.status === 'connected'));
});
test('SSH key and encrypted SSH key authentication; invalid and wrong-passphrase keys rejected', async t => {
  const { manager, root } = await setup(t);
  const encrypted = makeKey('key-passphrase');
  const fixture = await startFixture({ clientKey: encrypted, keyPassphrase: 'key-passphrase' }); t.after(() => fixture.close());
  const keyPath = path.join(root, 'client.pem'); await fs.writeFile(keyPath, encrypted);
  const selected = await manager.selectKey(keyPath);
  await assert.rejects(manager.connect({ ...input(fixture.port), authMethod: 'key', keyId: selected.id, passphrase: 'wrong' }), /unlocked/);
  const session = await manager.connect({ ...input(fixture.port), authMethod: 'key', keyId: selected.id, passphrase: 'key-passphrase', rememberSecret: true });
  await trust(manager, session.id); await waitFor(manager, s => s.profiles.find(p => p.hasSecret));
  const data = await fs.readFile(path.join(root, 'connections.json'), 'utf8'); assert.equal(data.includes('PRIVATE KEY'), false); assert.equal(data.includes('key-passphrase'), false);
  const plain = makeKey(); const plainServer = await startFixture({ clientKey: plain }); t.after(() => plainServer.close());
  await fs.writeFile(keyPath, plain); const selectedPlain = await manager.selectKey(keyPath);
  const plainSession = await manager.connect({ ...input(plainServer.port), authMethod: 'key', keyId: selectedPlain.id }); await trust(manager, plainSession.id);
  await waitFor(manager, s => s.sessions.find(s => s.id === plainSession.id && s.status === 'connected'));
  await fs.writeFile(keyPath, 'not a key'); await assert.rejects(manager.selectKey(keyPath), /not a supported/);
  const openSSH = require('ssh2').utils.generateKeyPairSync('ed25519', { passphrase: 'openssh-passphrase', cipher: 'aes256-cbc' });
  const edFixture = await startFixture({ clientKey: openSSH.private, keyPassphrase: 'openssh-passphrase' }); t.after(() => edFixture.close());
  await fs.writeFile(keyPath, openSSH.private); const selectedEd = await manager.selectKey(keyPath);
  const edSession = await manager.connect({ ...input(edFixture.port), authMethod: 'key', keyId: selectedEd.id, passphrase: 'openssh-passphrase' }); await trust(manager, edSession.id);
  await waitFor(manager, s => s.sessions.find(s => s.id === edSession.id && s.status === 'connected'));
  await fs.writeFile(keyPath, openSSH.public); await assert.rejects(manager.selectKey(keyPath), /private key/);
});
test('changed host key requires explicit replacement, and rejected replacement sends no credentials', async t => {
  const { manager } = await setup(t); let fixture = await startFixture(); t.after(() => fixture.close());
  const first = await manager.connect(input(fixture.port)); await trust(manager, first.id); await waitFor(manager, s => s.sessions.find(s => s.id === first.id && s.status === 'connected'));
  manager.disconnect(first.id); const port = fixture.port; await fixture.close(); fixture = await startFixture({ port });
  const changed = await manager.connect(input(port)); const pending = await waitFor(manager, s => s.sessions.find(s => s.id === changed.id && s.challenge));
  assert.equal(pending.challenge.changed, true); assert.notEqual(pending.challenge.fingerprint, pending.challenge.previousFingerprint);
  await assert.rejects(manager.decideHost({ sessionId: changed.id, challengeId: pending.challenge.id, accept: true, replace: false }), /Explicitly/);
  assert.equal(fixture.stats.authenticationAttempts, 0);
  await manager.decideHost({ sessionId: changed.id, challengeId: pending.challenge.id, accept: false, replace: false });
  assert.equal(fixture.stats.authenticationAttempts, 0);
  const accepted = await manager.connect(input(port)); await trust(manager, accepted.id, true);
  await waitFor(manager, s => s.sessions.find(s => s.id === accepted.id && s.status === 'connected'));
});
test('verification expires without authentication; cancellation closes a pending connection', async t => {
  const { manager } = await setup(t, { hostTimeout: 150 }); const fixture = await startFixture(); t.after(() => fixture.close());
  const first = await manager.connect(input(fixture.port)); const timed = await waitFor(manager, s => s.sessions.find(s => s.id === first.id && s.status === 'error'));
  assert.match(timed.message, /confirmation timed out/); assert.equal(fixture.stats.authenticationAttempts, 0);
  const second = await manager.connect(input(fixture.port)); manager.disconnect(second.id);
  assert.equal(manager.snapshot().sessions.find(s => s.id === second.id).status, 'disconnected');
});
test('dropped connection is reported and secure storage failure blocks remembering credentials', async t => {
  const { manager } = await setup(t); const fixture = await startFixture(); t.after(() => fixture.close());
  const first = await manager.connect(input(fixture.port)); await trust(manager, first.id); await waitFor(manager, s => s.sessions.find(s => s.id === first.id && s.status === 'connected'));
  fixture.dropClients(); await waitFor(manager, s => s.sessions.find(s => s.id === first.id && !['connected', 'connecting', 'verifying'].includes(s.status)));
  manager.store.vault.isAsyncEncryptionAvailable = async () => false;
  await assert.rejects(manager.connect({ ...input(fixture.port), rememberSecret: true }), /Secure storage/);
});
test('saved credentials cannot be redirected to a changed endpoint and corrupt data is preserved', async t => {
  const { manager, root, vault } = await setup(t); const fixture = await startFixture(); t.after(() => fixture.close());
  const first = await manager.connect({ ...input(fixture.port), rememberSecret: true }); await trust(manager, first.id); const profile = await waitFor(manager, s => s.profiles.find(p => p.hasSecret));
  await assert.rejects(manager.connect({ ...input(fixture.port), profileId: profile.id, host: 'example.com', useSavedSecret: true }), /new connection/);
  manager.disconnect(first.id); await manager.store.queue; await fs.writeFile(path.join(root, 'connections.json'), 'broken');
  const reload = new Connections({ root, vault }); await assert.rejects(reload.init(), /preserved/);
  assert.equal(await fs.readFile(path.join(root, 'connections.json'), 'utf8'), 'broken');
});
