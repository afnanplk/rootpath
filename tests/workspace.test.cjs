const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Connections } = require('../electron/connections.cjs');
const { Files } = require('../electron/files.cjs');
const { Editor, MAX } = require('../electron/editor.cjs');
const { Terminals } = require('../electron/terminal.cjs');
const { startFixture } = require('../scripts/ssh-fixture.cjs');
const { seedFiles } = require('../scripts/sftp-fixture.cjs');
async function until(predicate) { for (let i = 0; i < 500; i++) { const value = predicate(); if (value) return value; await new Promise(r => setTimeout(r, 15)); } throw new Error('Timeout'); }
async function setup(t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vps-workspace-')), root = path.join(tmp, 'remote'); await seedFiles(root);
  const manager = new Connections({ root: path.join(tmp, 'settings'), vault: { isAsyncEncryptionAvailable: async () => false } }); await manager.init();
  const fixture = await startFixture({ fsRoot: root }), files = new Files(manager), editor = new Editor(files), terminals = new Terminals(files);
  t.after(async () => { terminals.dispose(); files.dispose(); manager.dispose(); await manager.store.queue.catch(() => {}); await fixture.close(); await fs.rm(tmp, { recursive: true, force: true }); });
  const session = await manager.connect({ name: 'Lab', host: '127.0.0.1', port: fixture.port, username: 'explorer', authMethod: 'password', password: 'explorer-test-only', useSavedSecret: false, rememberSecret: false });
  const pending = await until(() => manager.snapshot().sessions.find(s => s.id === session.id && s.challenge)); await manager.decideHost({ sessionId: session.id, challengeId: pending.challenge.id, accept: true, replace: false }); await until(() => manager.snapshot().sessions.find(s => s.id === session.id && s.status === 'connected'));
  return { tmp, root, files, manager, fixture, editor, terminals, sessionId: session.id, request: target => ({ sessionId: session.id, path: target }) };
}
test('edit, reopen, preserve BOM/CRLF and permissions, recover prior version with another backup', async t => {
  const { editor, root, request } = await setup(t); await fs.writeFile(path.join(root, 'config.ini'), '\ufefffirst=one\r\n'); await fs.chmod(path.join(root, 'config.ini'), 0o640);
  const doc = await editor.open(request('/config.ini')); assert.equal(doc.bom, true); assert.equal(doc.eol, 'CRLF'); assert.equal(doc.text, 'first=one\r\n');
  const saved = await editor.save({ id: doc.id, revision: doc.revision, text: 'first=two\r\n' });
  assert.equal(await fs.readFile(path.join(root, 'config.ini'), 'utf8'), '\ufefffirst=two\r\n'); assert.equal((await fs.stat(path.join(root, 'config.ini'))).mode & 0o777, 0o640);
  assert.equal(await fs.readFile(path.join(root, saved.backups[0].path), 'utf8'), '\ufefffirst=one\r\n');
  const restored = await editor.restore({ id: doc.id, backupId: saved.backups[0].id, revision: saved.revision }); assert.equal(restored.text, 'first=one\r\n'); assert.equal(restored.backups.length, 2);
  editor.close({ id: doc.id }); assert.equal((await editor.open(request('/config.ini'))).text, 'first=one\r\n');
});
test('content hashes detect same-size same-mtime conflicts and preserve drafts and remote bytes', async t => {
  const { editor, root, request } = await setup(t); const target = path.join(root, 'test.txt'); await fs.writeFile(target, 'aaaa'); const doc = await editor.open(request('/test.txt')); const stat = await fs.stat(target);
  editor.dirty({ id: doc.id, dirty: true }); await fs.writeFile(target, 'bbbb'); await fs.utimes(target, stat.atime, stat.mtime);
  await assert.rejects(editor.save({ id: doc.id, revision: doc.revision, text: 'cccc' }), error => error.code === 'EDITOR_CONFLICT'); assert.equal(await fs.readFile(target, 'utf8'), 'bbbb'); assert.equal(editor.hasDirty(), true);
  const loaded = await editor.reload({ id: doc.id }); assert.equal(loaded.text, 'bbbb'); assert.equal(editor.hasDirty(), false);
});
test('binary, invalid UTF-8, oversized files, symlinks, permissions and closed documents are rejected', async t => {
  const { editor, root, request } = await setup(t);
  for (const [name, data] of [['binary', Buffer.from([0, 1, 2])], ['invalid', Buffer.from([255])], ['large', Buffer.alloc(MAX + 1)]]) { await fs.writeFile(path.join(root, name), data); await assert.rejects(editor.open(request('/' + name)), error => error.code === 'DOWNLOAD_INSTEAD'); }
  await assert.rejects(editor.open(request('/docs-link')), error => error.code === 'DOWNLOAD_INSTEAD');
  await assert.rejects(editor.open(request('/restricted/no.txt')), error => error.code === 'PERMISSION_DENIED');
  const doc = await editor.open(request('/README.md')); editor.close({ id: doc.id }); await assert.rejects(editor.save({ id: doc.id, text: 'no', revision: doc.revision }), error => error.code === 'DOCUMENT_CLOSED');
});
test('save failure rolls original back and removes partial files', async t => {
  const { editor, files, root, request } = await setup(t); const doc = await editor.open(request('/README.md')), channel = await files.channel(doc.sessionId), rename = channel.rename.bind(channel);
  channel.rename = (from, to, callback) => from.endsWith('.part') ? callback({ code: 3 }) : rename(from, to, callback);
  await assert.rejects(editor.save({ id: doc.id, revision: doc.revision, text: 'replacement' }), error => error.code === 'PERMISSION_DENIED');
  assert.equal(await fs.readFile(path.join(root, 'README.md'), 'utf8'), doc.text); assert.equal((await fs.readdir(root)).some(name => name.endsWith('.part') || name.endsWith('.bak')), false);
});
test('PTY terminal quotes unusual directories, streams UTF-8, resizes, closes and never replays input', async t => {
  const { terminals, fixture, root, request } = await setup(t); const folder = "space ' quote; $(touch bad) مرحبا"; await fs.mkdir(path.join(root, folder));
  let output = ''; terminals.on('event', event => { if (event.type === 'data') { output += event.data; terminals.ack({ id: event.id, bytes: Buffer.byteLength(event.data) }); } });
  const tab = await terminals.open({ ...request('/' + folder), cols: 90, rows: 30 }); await until(() => output.includes('SIMULATED SHELL')); terminals.write({ id: tab.id, data: 'pwd\r' }); await until(() => output.includes('/' + folder));
  terminals.write({ id: tab.id, data: 'echo مرحبا\r' }); await until(() => output.includes('مرحبا\r\n')); terminals.resize({ id: tab.id, cols: 120, rows: 40 }); await until(() => fixture.stats.resizes.some(s => s.cols === 120 && s.rows === 40));
  assert.equal((await fs.readdir(root)).includes('bad'), false); terminals.write({ id: tab.id, data: 'exit\r' }); await until(() => terminals.tabs.get(tab.id).closed); assert.throws(() => terminals.write({ id: tab.id, data: 'no' }), error => error.code === 'TERMINAL_CLOSED'); terminals.close({ id: tab.id });
  output = ''; const next = await terminals.open({ ...request('/'), cols: 90, rows: 30 }); await until(() => output.includes('SIMULATED SHELL')); assert.equal(output.includes('echo مرحبا'), false); terminals.close({ id: next.id });
});
test('terminal input, dimensions, tab limits, output flow control and disconnect are bounded', async t => {
  const { terminals, fixture, request, sessionId } = await setup(t);
  await assert.rejects(terminals.open({ ...request('/'), cols: 900, rows: 30 }), error => error.code === 'INVALID_INPUT');
  const tab = await terminals.open({ ...request('/'), cols: 80, rows: 24 });
  assert.throws(() => terminals.write({ id: tab.id, data: 'a'.repeat(65537) }), error => error.code === 'INVALID_INPUT');
  assert.throws(() => terminals.resize({ id: tab.id, rows: -1, cols: 80 }));
  for (let i = 0; i < 7; i++) await terminals.open({ ...request('/'), cols: 80, rows: 24 });
  await assert.rejects(terminals.open({ ...request('/'), cols: 80, rows: 24 }), error => error.code === 'TERMINAL_LIMIT');
  const record = terminals.tabs.get(tab.id); record.unacked = 150000; record.channel.pause(); terminals.ack({ id: tab.id, bytes: 150000 }); assert.equal(record.unacked, 0); assert.equal(record.channel.isPaused(), false);
  await fixture.dropClients(); await until(() => record.closed); assert.throws(() => terminals.write({ id: tab.id, data: 'no' })); assert.ok(sessionId);
});
test('concurrent editor opens deduplicate and terminal reservations enforce resource limits', async t => {
  const { editor, terminals, request } = await setup(t);
  const docs = await Promise.all(Array.from({ length: 10 }, () => editor.open(request('/README.md')))); assert.equal(new Set(docs.map(d => d.id)).size, 1); assert.equal(editor.docs.size, 1);
  const results = await Promise.allSettled(Array.from({ length: 16 }, () => terminals.open({ ...request('/'), cols: 80, rows: 24 })));
  assert.ok(results.filter(result => result.status === 'fulfilled').length <= 8); assert.equal(terminals.tabs.size <= 8, true);
});
