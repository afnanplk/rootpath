const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Connections } = require('../electron/connections.cjs');
const { Files, remotePath, fileName } = require('../electron/files.cjs');
const { startFixture } = require('../scripts/ssh-fixture.cjs');
const { seedFiles } = require('../scripts/sftp-fixture.cjs');
async function waitFor(manager, predicate) { const start = Date.now(); while (Date.now() - start < 6000) { const found = predicate(manager.snapshot()); if (found) return found; await new Promise(r => setTimeout(r, 15)); } throw new Error('SSH setup timeout'); }
async function setup(t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vps-files-')), root = path.join(tmp, 'remote'); await seedFiles(root);
  const manager = new Connections({ root: path.join(tmp, 'settings'), vault: { isAsyncEncryptionAvailable: async () => false } }); await manager.init();
  const fixture = await startFixture({ fsRoot: root }), files = new Files(manager);
  t.after(async () => { files.dispose(); manager.dispose(); await manager.store.queue.catch(() => {}); await fixture.close(); await fs.rm(tmp, { recursive: true, force: true }); });
  const session = await manager.connect({ name: 'File lab', host: '127.0.0.1', port: fixture.port, username: 'explorer', authMethod: 'password', password: 'explorer-test-only', useSavedSecret: false, rememberSecret: false });
  const pending = await waitFor(manager, s => s.sessions.find(v => v.id === session.id && v.challenge)); await manager.decideHost({ sessionId: session.id, challengeId: pending.challenge.id, accept: true, replace: false });
  await waitFor(manager, s => s.sessions.find(v => v.id === session.id && v.status === 'connected'));
  return { files, manager, fixture, root, tmp, sessionId: session.id, request: remote => ({ sessionId: session.id, path: remote }) };
}
test('remote paths and item names reject traversal names and support Unicode and spaces', () => {
  assert.equal(remotePath('/docs/../logs'), '/logs'); assert.equal(fileName('مرحبا world.txt'), 'مرحبا world.txt');
  for (const name of ['..', '.', 'a/b', '', 'a\0b', 'a\nb']) assert.throws(() => fileName(name));
  assert.throws(() => remotePath('relative')); assert.throws(() => remotePath('/a\0b'));
});
test('real SFTP browsing, metadata, hidden entries, symlinks and permission errors', async t => {
  const { files, request } = await setup(t);
  const page = await files.list(request('~')); assert.equal(page.home, '/'); assert.ok(page.entries.some(e => e.name === '.config'));
  assert.equal(page.entries.find(e => e.name === 'docs-link').kind, 'link');
  const link = await files.properties(request('/docs-link')); assert.equal(link.linkTarget, 'docs');
  const resolved = await files.list(request('/docs-link')); assert.equal(resolved.path, '/docs'); assert.ok(resolved.entries.some(e => e.name === 'مرحبا.txt'));
  await assert.rejects(files.list(request('/restricted')), error => error.code === 'PERMISSION_DENIED');
  await assert.rejects(files.list(request('/broken-link')), error => error.code === 'NOT_FOUND');
});
test('exclusive file/folder creation, collision-safe rename and chmod', async t => {
  const { files, request, root } = await setup(t);
  await files.create({ ...request('/'), name: 'A folder مرحبا', kind: 'folder' });
  await files.create({ ...request('/A folder مرحبا'), name: 'empty.txt', kind: 'file' });
  assert.equal((await fs.stat(path.join(root, 'A folder مرحبا/empty.txt'))).size, 0);
  await assert.rejects(files.create({ ...request('/A folder مرحبا'), name: 'empty.txt', kind: 'file' }), error => error.code === 'ALREADY_EXISTS');
  await files.rename({ ...request('/A folder مرحبا'), name: 'renamed' });
  await files.chmod({ ...request('/renamed/empty.txt'), mode: '600' });
  assert.equal((await files.properties(request('/renamed/empty.txt'))).mode & 0o777, 0o600);
  await assert.rejects(files.rename({ ...request('/renamed'), name: 'docs' }), error => error.code === 'ALREADY_EXISTS');
  await assert.rejects(files.chmod({ ...request('/docs-link'), mode: '777' }), error => error.code === 'LINK_PERMISSIONS');
  await assert.rejects(files.chmod({ ...request('/README.md'), mode: '4777' }), error => error.code === 'INVALID_MODE');
  await assert.rejects(files.rename({ ...request('/'), name: 'root' }), error => error.code === 'ROOT_PROTECTED');
});
test('paged directory listing is bounded, resumable, and owner-bound', async t => {
  const { files, request, root, sessionId } = await setup(t); await fs.mkdir(path.join(root, 'many'));
  await Promise.all(Array.from({ length: 710 }, (_, i) => fs.writeFile(path.join(root, 'many', `file-${String(i).padStart(4, '0')}.txt`), '')));
  let page = await files.list(request('/many')); assert.equal(page.entries.length, 250); const entries = [...page.entries];
  await assert.rejects(files.list({ ...request('/docs'), cursor: page.nextCursor }), error => error.code === 'EXPIRED_LISTING');
  while (page.nextCursor) { page = await files.list({ ...request('/many'), cursor: page.nextCursor }); entries.push(...page.entries); }
  assert.equal(entries.length, 710); assert.equal(new Set(entries.map(e => e.path)).size, 710);
  const canceled = await files.list(request('/many')); await files.releaseListing({ ownerId: sessionId, cursor: canceled.nextCursor });
  await assert.rejects(files.list({ ...request('/many'), cursor: canceled.nextCursor }), error => error.code === 'EXPIRED_LISTING');
});
test('recursive delete preview is explicit, cannot delete root, and never follows symbolic links', async t => {
  const { files, request, root, sessionId } = await setup(t);
  await files.create({ ...request('/'), name: 'delete-me', kind: 'folder' });
  await files.create({ ...request('/delete-me'), name: 'nested', kind: 'folder' });
  await files.create({ ...request('/delete-me/nested'), name: 'file.txt', kind: 'file' });
  await fs.symlink('../docs', path.join(root, 'delete-me', 'docs-alias'));
  const plan = await files.prepareDelete({ sessionId, paths: ['/delete-me', '/delete-me/nested'] });
  assert.deepEqual(plan.paths, ['/delete-me']); assert.equal(plan.folders, 2); assert.equal(plan.files, 1); assert.equal(plan.links, 1);
  assert.equal((await fs.stat(path.join(root, 'delete-me'))).isDirectory(), true);
  const canceled = await files.prepareDelete({ sessionId, paths: ['/delete-me'] }); files.cancelDelete({ sessionId, token: canceled.token });
  await assert.rejects(files.delete({ sessionId, token: canceled.token }), error => error.code === 'DELETE_EXPIRED');
  const result = await files.delete({ sessionId, token: plan.token }); assert.equal(result.removed, 4); assert.deepEqual(result.failed, []);
  assert.equal((await fs.stat(path.join(root, 'docs/hello world.txt'))).isFile(), true);
  await assert.rejects(files.prepareDelete({ sessionId, paths: ['/'] }), error => error.code === 'ROOT_PROTECTED');
  await assert.rejects(files.delete({ sessionId, token: plan.token }), error => error.code === 'DELETE_EXPIRED');
});
test('changed entries abort before deletion; expired confirmation and parent-link swaps are rejected', async t => {
  const { files, root, sessionId } = await setup(t);
  let plan = await files.prepareDelete({ sessionId, paths: ['/README.md'] }); await fs.appendFile(path.join(root, 'README.md'), 'Changed!');
  await assert.rejects(files.delete({ sessionId, token: plan.token }), error => error.code === 'DELETE_CHANGED');
  plan = await files.prepareDelete({ sessionId, paths: ['/README.md'] }); files.plans.get(plan.token).expiresAt = 0;
  await assert.rejects(files.delete({ sessionId, token: plan.token }), error => error.code === 'DELETE_EXPIRED');
  plan = await files.prepareDelete({ sessionId, paths: ['/docs/hello world.txt'] });
  await fs.rename(path.join(root, 'docs'), path.join(root, 'original-docs')); await fs.symlink('original-docs', path.join(root, 'docs'));
  await assert.rejects(files.delete({ sessionId, token: plan.token }), error => error.code === 'PATH_CHANGED');
  assert.equal((await fs.stat(path.join(root, 'original-docs/hello world.txt'))).isFile(), true);
});
test('partial deletion failures are reported without deleting new unpreviewed content', async t => {
  const { files, request, root, sessionId } = await setup(t);
  await files.create({ ...request('/'), name: 'partial', kind: 'folder' });
  const plan = await files.prepareDelete({ sessionId, paths: ['/partial'] });
  const original = files.canonicalParent.bind(files); let calls = 0;
  files.canonicalParent = async (...args) => { calls++; await original(...args); if (calls === 2) await fs.writeFile(path.join(root, 'partial/new-file.txt'), 'Do not delete'); };
  const result = await files.delete({ sessionId, token: plan.token }); assert.equal(result.removed, 0); assert.equal(result.failed.length, 1);
  assert.equal(await fs.readFile(path.join(root, 'partial/new-file.txt'), 'utf8'), 'Do not delete');
});
test('local browsing is read-only, selected-root scoped and denies escaping symlinks', async t => {
  const { files, tmp } = await setup(t); const local = path.join(tmp, 'local'); await fs.mkdir(local); await fs.writeFile(path.join(local, 'local.txt'), 'local');
  const root = await files.addLocalRoot(local), request = { rootId: root.rootId, path: root.path };
  const page = await files.listLocal(request); assert.equal(page.entries[0].name, 'local.txt'); assert.equal(page.home, root.path);
  const props = await files.localProperties({ ...request, path: path.join(root.path, 'local.txt') }); assert.equal(props.size, 5);
  await assert.rejects(files.listLocal({ ...request, path: path.dirname(root.path) }), error => error.code === 'LOCAL_SCOPE');
  await fs.symlink(path.dirname(root.path), path.join(root.path, 'escape'));
  await assert.rejects(files.listLocal({ ...request, path: path.join(root.path, 'escape') }), error => error.code === 'LOCAL_SCOPE');
  assert.equal((await files.localProperties({ ...request, path: path.join(root.path, 'escape') })).kind, 'link');
});
test('disconnected sessions reject browsing and mutation without retrying', async t => {
  const { files, manager, request, sessionId } = await setup(t); manager.disconnect(sessionId);
  await assert.rejects(files.list(request('/')), error => error.code === 'DISCONNECTED');
  await assert.rejects(files.create({ ...request('/'), name: 'never-created', kind: 'folder' }), error => error.code === 'DISCONNECTED');
});
