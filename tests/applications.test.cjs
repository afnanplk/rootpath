const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Connections } = require('../electron/connections.cjs');
const { Files } = require('../electron/files.cjs');
const { Monitoring } = require('../electron/monitoring.cjs');
const { Applications } = require('../electron/applications.cjs');
const { command, targetId } = require('../electron/applications/commands.cjs');
const parser = require('../electron/applications/parse.cjs');
const { startFixture } = require('../scripts/ssh-fixture.cjs');
async function until(fn) { for (let i = 0; i < 400; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 15)); } throw new Error('Timeout'); }
async function setup(t, options = {}, beforeDeploy) {
 const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vps-apps-')), root = path.join(tmp, 'remote'); await fs.mkdir(root);
 const manager = new Connections({ root: path.join(tmp, 'settings'), vault: { isAsyncEncryptionAvailable: async () => false } }); await manager.init();
 const fixture = await startFixture({ fsRoot: root, applicationsOptions: options }), files = new Files(manager), monitoring = new Monitoring(files), applications = new Applications(files, monitoring, { beforeDeploy });
 t.after(async () => { applications.dispose(); monitoring.dispose(); files.dispose(); manager.dispose(); await manager.store.queue.catch(() => {}); await fixture.close(); await fs.rm(tmp, { recursive: true, force: true }); });
 const session = await manager.connect({ name: 'Applications lab', host: '127.0.0.1', port: fixture.port, username: 'explorer', authMethod: 'password', password: 'explorer-test-only', useSavedSecret: false, rememberSecret: false });
 await until(() => manager.snapshot().sessions.find(s => s.id === session.id && s.challenge)); const pending = manager.snapshot().sessions.find(s => s.id === session.id); await manager.decideHost({ sessionId: session.id, challengeId: pending.challenge.id, accept: true, replace: false }); await until(() => manager.snapshot().sessions.find(s => s.id === session.id && s.status === 'connected'));
 return { applications, monitoring, fixture, files, root, request: (kind = 'docker', sudo = true) => ({ sessionId: session.id, kind, sudo }), dockerId: 'a'.repeat(64) };
}
test('capabilities and missing Docker, Compose, PM2 and daemon guidance', async t => {
 const { applications, fixture, request } = await setup(t); assert.equal((await applications.capabilities(request())).docker, true);
 fixture.applications.docker = false; await assert.rejects(applications.list(request()), error => error.code === 'TOOL_MISSING'); fixture.applications.docker = true;
 fixture.applications.compose = false; await assert.rejects(applications.list(request('compose')), error => error.code === 'COMPOSE_UNAVAILABLE');
 fixture.applications.pm2 = false; await assert.rejects(applications.list(request('pm2', false)), error => error.code === 'TOOL_MISSING'); fixture.applications.pm2 = true; fixture.applications.noDaemon = true; await assert.rejects(applications.list(request('pm2', false)), error => error.code === 'PM2_DAEMON_UNAVAILABLE'); assert.equal(fixture.applications.actions.length, 0);
});
test('Docker discovery has explicit permission scope, metadata and both log streams', async t => {
 const { applications, request, dockerId } = await setup(t); await assert.rejects(applications.list(request('docker', false)), error => error.code === 'PERMISSION_DENIED');
 const list = await applications.list(request()); assert.equal(list.entries.length, 2); assert.equal(list.entries[0].id.length, 64); const detail = await applications.details({ ...request(), id: dockerId }); assert.equal(detail.state, 'running'); assert.equal('Env' in detail, false);
 const logs = await applications.logs({ ...request(), id: dockerId }); assert.match(logs.text, /stdout/); assert.match(logs.text, /stderr/);
});
test('reviewed Docker actions are single-use, cancelable, expiring and bound to current state', async t => {
 const { applications, request, fixture, dockerId } = await setup(t); let plan = await applications.prepare({ ...request(), id: dockerId, action: 'restart' }); applications.cancel({ token: plan.token }); await assert.rejects(applications.perform({ token: plan.token }), error => error.code === 'ACTION_EXPIRED');
 plan = await applications.prepare({ ...request(), id: dockerId, action: 'restart' }); fixture.applications.containers.get(dockerId).restarts++; await assert.rejects(applications.perform({ token: plan.token }), error => error.code === 'APPLICATION_CHANGED'); assert.equal(fixture.applications.actions.length, 0);
 plan = await applications.prepare({ ...request(), id: dockerId, action: 'restart' }); await applications.perform({ token: plan.token }); assert.equal(fixture.applications.actions[0].action, 'restart'); await assert.rejects(applications.perform({ token: plan.token }));
 plan = await applications.prepare({ ...request(), id: dockerId, action: 'stop' }); applications.plans.get(plan.token).expiresAt = 0; await assert.rejects(applications.perform({ token: plan.token }), error => error.code === 'ACTION_EXPIRED');
});
test('Compose discovers config paths, validates local files and hashes, and recreates only after typed confirmation', async t => {
 const { applications, request, fixture } = await setup(t); const list = await applications.list(request('compose')); assert.deepEqual(list.entries[0].files, ['/apps/demo/compose.yaml']);
 let plan = await applications.prepare({ ...request('compose'), id: 'demo', action: 'redeploy' }); assert.deepEqual(plan.details.services, ['web', 'worker']); await assert.rejects(applications.perform({ token: plan.token, confirmationName: 'wrong' }), error => error.code === 'NAME_CONFIRMATION_REQUIRED'); assert.equal(fixture.applications.actions.length, 0);
 plan = await applications.prepare({ ...request('compose'), id: 'demo', action: 'redeploy' }); fixture.applications.configVersion++; await assert.rejects(applications.perform({ token: plan.token, confirmationName: 'demo' }), error => error.code === 'APPLICATION_CHANGED');
 plan = await applications.prepare({ ...request('compose'), id: 'demo', action: 'redeploy' }); await applications.perform({ token: plan.token, confirmationName: 'demo' }); assert.equal(fixture.applications.actions.at(-1).action, 'redeploy');
 const shell = command('compose', 'redeploy', { id: 'demo', directory: '/apps/demo', files: ['/apps/demo/compose.yaml'], socket: '/var/run/docker.sock' }, true); assert.match(shell, /--no-build --pull never/); assert.equal(shell.includes('--volumes'), false);
});
test('invalid Compose config and inaccessible or aliased paths cannot redeploy', async t => {
 const { applications, request, fixture, root } = await setup(t); fixture.applications.invalidConfig = true; await assert.rejects(applications.prepare({ ...request('compose'), id: 'demo', action: 'redeploy' }), error => error.code === 'APPLICATION_COMMAND_FAILED'); fixture.applications.invalidConfig = false;
 await fs.rename(path.join(root, 'apps/demo/compose.yaml'), path.join(root, 'apps/demo/real.yaml')); await fs.symlink('real.yaml', path.join(root, 'apps/demo/compose.yaml')); await assert.rejects(applications.prepare({ ...request('compose'), id: 'demo', action: 'redeploy' }), error => error.code === 'COMPOSE_PATH_CHANGED'); assert.equal(fixture.applications.actions.length, 0);
});
test('PM2 is account-bound, filtered, supports state/logs/start/stop and rejects stale identity', async t => {
 const { applications, request, fixture } = await setup(t); const req = request('pm2', false); const list = await applications.list(req); assert.equal(list.entries[0].name, 'sample-api'); assert.equal('pm2_env' in list.entries[0], false);
 await assert.rejects(applications.list(request('pm2', true)), error => error.code === 'INVALID_ELEVATION');
 let plan = await applications.prepare({ ...req, id: '0', action: 'stop' }); await applications.perform({ token: plan.token }); assert.equal(fixture.applications.pm2Apps.get('0').state, 'stopped');
 plan = await applications.prepare({ ...req, id: '0', action: 'start' }); await applications.perform({ token: plan.token }); assert.equal(fixture.applications.pm2Apps.get('0').state, 'online');
 plan = await applications.prepare({ ...req, id: '0', action: 'restart' }); fixture.applications.pm2Apps.get('0').pid++; await assert.rejects(applications.perform({ token: plan.token }), error => error.code === 'APPLICATION_CHANGED'); assert.match((await applications.logs({ ...req, id: '0' })).text, /stdout/);
});
test('injection, arbitrary targets, mismatched project metadata and dangerous paths are rejected', async t => {
 for (const [kind, id] of [['docker', '--help'], ['compose', '-danger'], ['compose', 'x; reboot'], ['pm2', 'all'], ['pm2', '0;rm'], ['docker', 'a'.repeat(64) + '\n']]) assert.throws(() => targetId(kind, id));
 assert.throws(() => command('compose', 'redeploy', { id: 'p', directory: '/x', files: ['https://evil/config.yml'], socket: '/var/run/docker.sock' }));
 const group = parser.projects([{ id: 'a'.repeat(64), project: 'demo', state: 'running', directory: '/x', configs: '/x/one.yaml' }, { id: 'b'.repeat(64), project: 'demo', state: 'running', directory: '/y', configs: '/y/two.yaml' }]); assert.ok(group[0].issue);
 const { applications, request } = await setup(t); await assert.rejects(applications.details({ ...request(), id: 'f'.repeat(64) }), error => error.code === 'APPLICATION_NOT_FOUND'); await assert.rejects(applications.prepare({ ...request(), id: 'a'.repeat(64), action: 'redeploy' }), error => error.code === 'INVALID_ACTION');
});
test('deployment work guard, server action serialization, static errors and disconnect prevent unsafe retries', async t => {
 let dirty = true; const { applications, monitoring, fixture, request, dockerId } = await setup(t, {}, () => { if (dirty) { const { fail } = require('../electron/connection-store.cjs'); fail('WORK_IN_PROGRESS', 'Finish drafts first.'); } });
 await assert.rejects(applications.prepare({ ...request('compose'), id: 'demo', action: 'redeploy' }), error => error.code === 'WORK_IN_PROGRESS'); dirty = false;
 let plan = await applications.prepare({ ...request(), id: dockerId, action: 'stop' }); monitoring.busy.add(request().sessionId); await assert.rejects(applications.perform({ token: plan.token }), error => error.code === 'APPLICATION_BUSY'); monitoring.busy.clear();
 plan = await applications.prepare({ ...request(), id: dockerId, action: 'restart' }); fixture.applications.denied = true; await assert.rejects(applications.perform({ token: plan.token })); assert.equal(JSON.stringify(applications.snapshot()).includes('SYNTHETIC-SECRET'), false); fixture.applications.denied = false;
 plan = await applications.prepare({ ...request(), id: dockerId, action: 'restart' }); await fixture.dropClients(); await until(() => !applications.plans.has(plan.token)); await assert.rejects(applications.perform({ token: plan.token })); assert.equal(fixture.applications.actions.length, 0);
});

test('uncertain mutation outcomes are recorded and never retried, and generated scripts use POSIX argument quoting', async t => {
 const { applications, fixture, request, dockerId } = await setup(t); const plan = await applications.prepare({ ...request(), id: dockerId, action: 'restart' }); fixture.applications.noExitActions = true;
 await assert.rejects(applications.perform({ token: plan.token }), error => error.code === 'NO_EXIT_STATUS'); assert.equal(applications.snapshot().at(-1).status, 'unknown'); assert.equal(fixture.applications.actions.length, 1); await assert.rejects(applications.perform({ token: plan.token }), error => error.code === 'ACTION_EXPIRED');
 const execFile = require('node:util').promisify(require('node:child_process').execFile);
 for (const [kind, action, target] of [['docker', 'restart', { id: dockerId, socket: '/var/run/docker.sock' }], ['compose', 'redeploy', { id: 'demo', directory: "/apps/a ' quote", files: ["/apps/a ' quote/cfg $(touch never).yml"], socket: '/var/run/docker.sock' }], ['pm2', 'list', {}]]) await execFile('/bin/sh', ['-n', '-c', command(kind, action, target)]);
});
