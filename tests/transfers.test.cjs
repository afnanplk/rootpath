const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');
const { Connections } = require('../electron/connections.cjs');
const { Files } = require('../electron/files.cjs');
const { Transfers, Transport } = require('../electron/transfers.cjs');
const { startFixture } = require('../scripts/ssh-fixture.cjs');
const { seedFiles } = require('../scripts/sftp-fixture.cjs');
async function wait(predicate, ms = 12000) { const start = Date.now(); while (Date.now() - start < ms) { const value = predicate(); if (value) return value; await new Promise(r => setTimeout(r, 15)); } throw new Error('Transfer test timed out'); }
async function setup(t, delay = 0) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vps-transfers-')), remote = path.join(tmp, 'remote'), local = path.join(tmp, 'local'), downloads = path.join(tmp, 'downloads');
  await seedFiles(remote); await fs.mkdir(local); await fs.mkdir(downloads);
  const fixture = await startFixture({ fsRoot: remote, ioDelayMs: delay });
  const manager = new Connections({ root: path.join(tmp, 'settings'), vault: { isAsyncEncryptionAvailable: async () => false } }); await manager.init();
  const files = new Files(manager), transfers = new Transfers(files);
  t.after(async () => { await transfers.dispose(); files.dispose(); manager.dispose(); await manager.store.queue.catch(() => {}); await fixture.close(); await fs.rm(tmp, { recursive: true, force: true }); });
  async function connect() {
    const session = await manager.connect({ name: 'Transfers lab', host: '127.0.0.1', port: fixture.port, username: 'explorer', authMethod: 'password', password: 'explorer-test-only', useSavedSecret: false, rememberSecret: false });
    await wait(() => { const current = manager.snapshot().sessions.find(s => s.id === session.id); return current?.challenge || current?.status === 'connected'; });
    const current = manager.snapshot().sessions.find(s => s.id === session.id); if (current.challenge) await manager.decideHost({ sessionId: session.id, challengeId: current.challenge.id, accept: true, replace: false });
    await wait(() => manager.snapshot().sessions.find(s => s.id === session.id && s.status === 'connected')); return session.id;
  }
  const sessionId = await connect();
  const finish = id => wait(() => transfers.snapshot().find(j => j.id === id && ['completed', 'failed', 'cancelled'].includes(j.status)));
  const job = id => transfers.snapshot().find(j => j.id === id);
  async function upload(sources, destination = '/') { const grant = await transfers.grantUpload(sources); return transfers.enqueue({ sessionId, kind: 'upload', sourceGrant: grant.id, destination }); }
  return { tmp, remote, local, downloads, fixture, manager, files, transfers, sessionId, upload, finish, job, connect };
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
test('binary and empty uploads/downloads preserve bytes; recursive folders skip links explicitly', async t => {
  const env = await setup(t); const { local, remote, downloads, transfers, sessionId } = env;
  const bytes = randomBytes(1024 * 1024 + 37); await fs.writeFile(path.join(local, 'binary.dat'), bytes); await fs.mkdir(path.join(local, 'folder')); await fs.writeFile(path.join(local, 'folder/empty.txt'), ''); await fs.writeFile(path.join(local, 'folder/مرحبا.txt'), 'Hello'); await fs.symlink('../binary.dat', path.join(local, 'folder/link'));
  const upload = await env.upload([path.join(local, 'binary.dat'), path.join(local, 'folder')]); const done = await env.finish(upload.id);
  assert.equal(done.status, 'completed', done.message); assert.equal(done.filesDone, 3); assert.equal(done.skipped, 1); assert.match(done.warnings[0], /Skipped/); assert.equal(hash(await fs.readFile(path.join(remote, 'binary.dat'))), hash(bytes));
  const destination = await transfers.grantDestination(downloads); const download = await transfers.enqueue({ sessionId, kind: 'download', sources: ['/binary.dat', '/folder'], destinationGrant: destination.id });
  const downloaded = await env.finish(download.id); assert.equal(downloaded.status, 'completed', downloaded.message); assert.equal(hash(await fs.readFile(path.join(downloads, 'binary.dat'))), hash(bytes)); assert.equal(await fs.readFile(path.join(downloads, 'folder/مرحبا.txt'), 'utf8'), 'Hello');
});
test('overwrite prompts support skip, replace and keep both without truncating destinations', async t => {
  const env = await setup(t); const { local, remote, transfers } = env;
  await fs.writeFile(path.join(local, 'same.txt'), 'New bytes'); await fs.writeFile(path.join(remote, 'same.txt'), 'Original bytes');
  for (const choice of ['skip', 'replace', 'keep-both']) {
    const queued = await env.upload([path.join(local, 'same.txt')]); const conflict = await wait(() => env.job(queued.id)?.conflict);
    assert.equal(await fs.readFile(path.join(remote, 'same.txt'), 'utf8'), choice === 'skip' || choice === 'replace' ? 'Original bytes' : 'New bytes');
    transfers.resolve({ id: queued.id, conflictId: conflict.id, choice, applyAll: false }); const done = await env.finish(queued.id); assert.equal(done.status, 'completed', done.message);
    if (choice === 'skip') assert.equal(await fs.readFile(path.join(remote, 'same.txt'), 'utf8'), 'Original bytes');
    if (choice === 'replace') assert.equal(await fs.readFile(path.join(remote, 'same.txt'), 'utf8'), 'New bytes');
  }
  assert.equal(await fs.readFile(path.join(remote, 'same (copy 1).txt'), 'utf8'), 'New bytes');
  assert.equal((await fs.readdir(remote)).some(name => /\.part$|\.backup$/.test(name)), false);
});
test('folder conflicts merge only on explicit choice and apply-all handles matching conflicts', async t => {
  const env = await setup(t); const { local, remote, transfers } = env;
  await fs.mkdir(path.join(local, 'docs')); await fs.writeFile(path.join(local, 'docs/hello world.txt'), 'Replace me'); await fs.writeFile(path.join(local, 'docs/مرحبا.txt'), 'Second replacement');
  const queued = await env.upload([path.join(local, 'docs')]); const folder = await wait(() => env.job(queued.id)?.conflict); assert.ok(folder.choices.includes('merge')); transfers.resolve({ id: queued.id, conflictId: folder.id, choice: 'merge', applyAll: true });
  const file = await wait(() => { const conflict = env.job(queued.id)?.conflict; return conflict?.id !== folder.id && conflict; }); transfers.resolve({ id: queued.id, conflictId: file.id, choice: 'replace', applyAll: true });
  const done = await env.finish(queued.id); assert.equal(done.status, 'completed', done.message); assert.equal(done.filesDone, 2); assert.equal(await fs.readFile(path.join(remote, 'docs/مرحبا.txt'), 'utf8'), 'Second replacement');
});
test('remote copy streams files; move renames files and folders; self-descendant copies fail safely', async t => {
  const env = await setup(t); const { remote, transfers, sessionId } = env; await fs.mkdir(path.join(remote, 'dest'));
  const copy = await transfers.enqueue({ sessionId, kind: 'copy', sources: ['/docs'], destination: '/dest' }); assert.equal((await env.finish(copy.id)).status, 'completed'); assert.equal(await fs.readFile(path.join(remote, 'dest/docs/hello world.txt'), 'utf8'), 'Hello from real SFTP.\n');
  const move = await transfers.enqueue({ sessionId, kind: 'move', sources: ['/dest/docs'], destination: '/' }); const conflict = await wait(() => env.job(move.id)?.conflict); transfers.resolve({ id: move.id, conflictId: conflict.id, choice: 'keep-both', applyAll: false }); const moved = await env.finish(move.id); assert.equal(moved.status, 'completed', moved.message); assert.equal(moved.filesTotal, 1); assert.equal(moved.filesDone, 1); await assert.rejects(fs.stat(path.join(remote, 'dest/docs'))); assert.ok(await fs.stat(path.join(remote, 'docs (copy 1)')));
  const invalid = await transfers.enqueue({ sessionId, kind: 'copy', sources: ['/docs'], destination: '/docs' }); const failed = await env.finish(invalid.id); assert.equal(failed.status, 'failed'); assert.match(failed.message, /outside|inside itself/);
});
test('cancellation cleans staging files and preserves original; retry is explicit and starts over', async t => {
  const env = await setup(t, 4); const { local, remote, transfers, sessionId } = env;
  await fs.writeFile(path.join(local, 'large.bin'), Buffer.alloc(8 * 1024 * 1024, 7)); await fs.writeFile(path.join(remote, 'large.bin'), 'Old');
  const queued = await env.upload([path.join(local, 'large.bin')]); const conflict = await wait(() => env.job(queued.id)?.conflict); transfers.resolve({ id: queued.id, conflictId: conflict.id, choice: 'replace', applyAll: false });
  await wait(() => env.job(queued.id)?.bytesDone > 0); transfers.cancel(queued.id); const canceled = await env.finish(queued.id); assert.equal(canceled.status, 'cancelled'); assert.match(canceled.message, /canceled/i); assert.equal(await fs.readFile(path.join(remote, 'large.bin'), 'utf8'), 'Old'); assert.equal((await fs.readdir(remote)).some(name => name.endsWith('.part')), false);
  const retry = transfers.retry({ id: queued.id, sessionId }); const second = await wait(() => env.job(retry.id)?.conflict); transfers.resolve({ id: retry.id, conflictId: second.id, choice: 'replace', applyAll: false }); const done = await env.finish(retry.id); assert.equal(done.status, 'completed', done.message); assert.equal((await fs.stat(path.join(remote, 'large.bin'))).size, 8 * 1024 * 1024);
});
test('queued jobs serialize by session; cancellation and disconnect never auto-retry', async t => {
  const env = await setup(t, 3); const { local, transfers, sessionId, manager } = env;
  await fs.writeFile(path.join(local, 'slow.bin'), Buffer.alloc(4 * 1024 * 1024)); await fs.writeFile(path.join(local, 'next.txt'), 'Next');
  const first = await env.upload([path.join(local, 'slow.bin')]); await wait(() => env.job(first.id)?.bytesDone > 0);
  const second = await env.upload([path.join(local, 'next.txt')]); assert.equal(env.job(second.id).status, 'queued'); transfers.cancel(second.id); assert.equal((await env.finish(second.id)).status, 'cancelled');
  manager.disconnect(sessionId); const failed = await env.finish(first.id); assert.equal(failed.status, 'failed'); assert.match(failed.message, /connection closed/i);
  const newSession = await env.connect(); const retried = transfers.retry({ id: first.id, sessionId: newSession }); assert.equal((await env.finish(retried.id)).status, 'completed');
});
test('source/destination changes and invalid grants are rejected; local source scope remains enforced', async t => {
  const env = await setup(t); const { local, remote, files, transfers, sessionId } = env;
  await fs.writeFile(path.join(local, 'file.txt'), 'Source'); await fs.writeFile(path.join(remote, 'file.txt'), 'Existing'); const queued = await env.upload([path.join(local, 'file.txt')]); const conflict = await wait(() => env.job(queued.id)?.conflict); await fs.writeFile(path.join(remote, 'file.txt'), 'Changed externally, longer'); transfers.resolve({ id: queued.id, conflictId: conflict.id, choice: 'replace', applyAll: false });
  assert.equal((await env.finish(queued.id)).status, 'failed'); assert.equal(await fs.readFile(path.join(remote, 'file.txt'), 'utf8'), 'Changed externally, longer');
  await assert.rejects(transfers.enqueue({ sessionId, kind: 'upload', sourceGrant: 'invalid', destination: '/' }));
  const discarded = await transfers.grantUpload([path.join(local, 'file.txt')]); transfers.discardSelections([discarded.id]);
  await assert.rejects(transfers.enqueue({ sessionId, kind: 'upload', sourceGrant: discarded.id, destination: '/' }), error => error.code === 'SELECTION_EXPIRED');
  const root = await files.addLocalRoot(local); await assert.rejects(transfers.grantLocal({ rootId: root.rootId, paths: [path.dirname(local)] }), error => error.code === 'LOCAL_SCOPE');
  await fs.symlink('../remote', path.join(local, 'escape')); await assert.rejects(transfers.grantLocal({ rootId: root.rootId, paths: [path.join(root.path, 'escape')] }), error => error.code === 'SOURCE_LINK');
});
test('failed replacement commit restores the original and removes temporary files', async t => {
  const env = await setup(t); const { local, remote, transfers } = env;
  await fs.writeFile(path.join(local, 'rollback.txt'), 'New bytes'); await fs.writeFile(path.join(remote, 'rollback.txt'), 'Original bytes');
  const original = Transport.prototype.rename; let injected = false;
  Transport.prototype.rename = async function(from, to) { if (!injected && to === '/rollback.txt' && from.endsWith('.part')) { injected = true; throw new Error('Injected commit failure'); } return original.call(this, from, to); };
  t.after(() => { Transport.prototype.rename = original; });
  const queued = await env.upload([path.join(local, 'rollback.txt')]); const conflict = await wait(() => env.job(queued.id)?.conflict); transfers.resolve({ id: queued.id, conflictId: conflict.id, choice: 'replace', applyAll: false });
  assert.equal((await env.finish(queued.id)).status, 'failed'); assert.equal(await fs.readFile(path.join(remote, 'rollback.txt'), 'utf8'), 'Original bytes'); assert.equal((await fs.readdir(remote)).some(name => /\.part$|\.backup$/.test(name)), false);
});
