const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Connections } = require('../electron/connections.cjs');
const { Files } = require('../electron/files.cjs');
const { Monitoring } = require('../electron/monitoring.cjs');
const { execute } = require('../electron/monitoring/execute.cjs');
const { command, unitName } = require('../electron/monitoring/commands.cjs');
const parse = require('../electron/monitoring/parse.cjs');
const { startFixture } = require('../scripts/ssh-fixture.cjs');
async function until(fn) { for (let i = 0; i < 400; i++) { const value = fn(); if (value) return value; await new Promise(r => setTimeout(r, 15)); } throw new Error('Timeout'); }
async function setup(t, options = {}, beforePower) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vps-monitor-')), root = path.join(tmp, 'remote'); await fs.mkdir(root);
  const manager = new Connections({ root: path.join(tmp, 'settings'), vault: { isAsyncEncryptionAvailable: async () => false } }); await manager.init();
  const fixture = await startFixture({ fsRoot: root, monitoringOptions: options }), files = new Files(manager), monitoring = new Monitoring(files, { beforePower });
  t.after(async () => { monitoring.dispose(); files.dispose(); manager.dispose(); await manager.store.queue.catch(() => {}); await fixture.close(); await fs.rm(tmp, { recursive: true, force: true }); });
  const session = await manager.connect({ name: 'Monitoring lab', host: '127.0.0.1', port: fixture.port, username: 'explorer', authMethod: 'password', password: 'explorer-test-only', useSavedSecret: false, rememberSecret: false });
  const pending = await until(() => manager.snapshot().sessions.find(s => s.id === session.id && s.challenge)); await manager.decideHost({ sessionId: session.id, challengeId: pending.challenge.id, accept: true, replace: false }); await until(() => manager.snapshot().sessions.find(s => s.id === session.id && s.status === 'connected'));
  return { monitoring, files, fixture, manager, request: { sessionId: session.id }, unit: 'vps-explorer-test.service' };
}
test('capability detection distinguishes Debian, RHEL, unsupported OS and missing systemd', async t => {
  for (const [options, family, services] of [[{}, 'debian', true], [{ distro: 'almalinux', family: 'rhel' }, 'rhel', true], [{ os: 'Darwin', family: '', distro: '' }, 'other', false], [{ systemd: false }, 'debian', false]]) {
    const { monitoring, request } = await setup(t, options); const caps = await monitoring.capabilities(request); assert.equal(caps.family, family); assert.equal(caps.services, services); assert.equal(caps.fixture, true);
    if (!services) await assert.rejects(monitoring.services(request));
  }
});
test('metric deltas, memory, disk mounts, network counters and reset handling', async t => {
  const { monitoring, request } = await setup(t); const first = await monitoring.metrics(request); assert.equal(first.cpuPercent, null); assert.equal(first.memory.percent, 37.5); assert.equal(first.disks[0].mount, '/'); assert.equal(first.interfaces[0].rxPerSecond, null);
  await new Promise(r => setTimeout(r, 15)); const second = await monitoring.metrics(request); assert.ok(Math.abs(second.cpuPercent - 20) < 0.001); assert.ok(second.interfaces[0].rxPerSecond > 0); assert.equal(second.uptime, 86400.5);
  const response = await monitoring.run(request.sessionId, 'metrics'); const before = parse.metrics(response.stdout, null, 100); const reset = parse.metrics(response.stdout, { ...before.sample, cpu: { total: 1e9, idle: 1e9 }, network: [{ name: 'eth0', rx: 1e12, tx: 1e12 }] }, 200); assert.equal(reset.view.cpuPercent, null); assert.equal(reset.view.interfaces[0].rxPerSecond, null);
  await assert.rejects(Promise.resolve().then(() => parse.metrics('bad', null, 1)), error => error.code === 'INVALID_PROBE');
});
test('process list omits arguments, discovers service state and shows journal', async t => {
  const { monitoring, request, unit } = await setup(t); const processes = await monitoring.processes(request); assert.equal(processes.entries[0].name, 'test-worker'); assert.equal('args' in processes.entries[0], false);
  assert.equal((await monitoring.services(request)).entries.length, 2); const details = await monitoring.status({ ...request, unit }); assert.equal(details.ActiveState, 'active'); assert.match((await monitoring.logs({ ...request, unit })).text, /Simulated journal/);
  const installed = parse.services('__VPS_LOADED__\nssh.service loaded active running SSH\n__VPS_INSTALLED__\nssh.service enabled enabled\nnever-started.service disabled disabled\n'); assert.equal(installed.length, 2); assert.equal(installed.find(s => s.unit === 'never-started.service').load, 'installed');
});
test('injection, options, unknown services and arbitrary scripts never execute', async t => {
  for (const value of ['--help.service', 'x.service; reboot', 'x\n.service', '../x.service', '$(touch x).service', 'x.service\0']) assert.throws(() => unitName(value));
  assert.throws(() => command('exec', 'true')); const { monitoring, request, fixture } = await setup(t);
  await assert.rejects(monitoring.prepare({ ...request, action: 'restart', unit: 'unknown.service', sudo: false }), error => error.code === 'SERVICE_NOT_DISCOVERED');
  await assert.rejects(monitoring.prepare({ ...request, action: 'rm', sudo: false }), error => error.code === 'INVALID_ACTION'); assert.equal(fixture.monitoring.actions.length, 0);
});
test('reviewed actions support denial, explicit sudo, state checks, cancel, expiry and single use', async t => {
  const { monitoring, request, fixture, unit } = await setup(t);
  let plan = await monitoring.prepare({ ...request, action: 'restart', unit, sudo: false }); await assert.rejects(monitoring.perform({ token: plan.token }), error => error.code === 'PERMISSION_DENIED'); assert.equal(fixture.monitoring.actions.length, 0); assert.equal(JSON.stringify(monitoring.snapshot()).includes('PASSWORD-SHOULD-NOT-LEAK'), false);
  plan = await monitoring.prepare({ ...request, action: 'restart', unit, sudo: true }); await monitoring.perform({ token: plan.token }); assert.equal(fixture.monitoring.actions[0].kind, 'restart'); assert.equal(monitoring.snapshot().at(-1).status, 'completed'); await assert.rejects(monitoring.perform({ token: plan.token }), error => error.code === 'ACTION_EXPIRED');
  plan = await monitoring.prepare({ ...request, action: 'stop', unit, sudo: true }); fixture.monitoring.units.get(unit).pid = '999'; await assert.rejects(monitoring.perform({ token: plan.token }), error => error.code === 'SERVICE_CHANGED'); assert.equal(fixture.monitoring.actions.length, 1);
  plan = await monitoring.prepare({ ...request, action: 'stop', unit, sudo: true }); monitoring.cancel({ token: plan.token }); await assert.rejects(monitoring.perform({ token: plan.token }));
  plan = await monitoring.prepare({ ...request, action: 'stop', unit, sudo: true }); monitoring.plans.get(plan.token).expiresAt = 0; await assert.rejects(monitoring.perform({ token: plan.token }), error => error.code === 'ACTION_EXPIRED');
});
test('power requires exact host, explicit elevation, work guard and never retries after disconnect', async t => {
  let dirty = false; const { monitoring, request, fixture } = await setup(t, {}, () => { if (dirty) { const { fail } = require('../electron/connection-store.cjs'); fail('WORK_IN_PROGRESS', 'Finish work first.'); } });
  let plan = await monitoring.prepare({ ...request, action: 'reboot', sudo: true }); await assert.rejects(monitoring.perform({ token: plan.token, confirmationHost: 'wrong' }), error => error.code === 'HOST_CONFIRMATION_REQUIRED'); assert.equal(fixture.monitoring.actions.length, 0);
  dirty = true; await assert.rejects(monitoring.prepare({ ...request, action: 'shutdown', sudo: true }), error => error.code === 'WORK_IN_PROGRESS'); dirty = false;
  plan = await monitoring.prepare({ ...request, action: 'reboot', sudo: true }); await monitoring.perform({ token: plan.token, confirmationHost: '127.0.0.1' }); assert.equal(fixture.monitoring.actions[0].kind, 'reboot');
  plan = await monitoring.prepare({ ...request, action: 'shutdown', sudo: true }); await fixture.dropClients(); await until(() => !monitoring.caps.has(request.sessionId)); await assert.rejects(monitoring.perform({ token: plan.token, confirmationHost: '127.0.0.1' })); assert.equal(fixture.monitoring.actions.length, 1);
});
test('SSH execution bounds output, times out and treats missing exit status as uncertain', async t => {
  const { monitoring, files, request, fixture } = await setup(t); const record = files.record(request.sessionId);
  fixture.monitoring.huge = true; await assert.rejects(execute(record, command('metrics'), { limit: 1024 }), error => error.code === 'OUTPUT_LIMIT'); fixture.monitoring.huge = false;
  fixture.monitoring.hang = true; await assert.rejects(execute(record, command('metrics'), { timeout: 80 }), error => error.code === 'PROBE_TIMEOUT'); fixture.monitoring.hang = false;
  await monitoring.capabilities(request); const plan = await monitoring.prepare({ ...request, action: 'reboot', sudo: true }); fixture.monitoring.noExit = true;
  await assert.rejects(monitoring.perform({ token: plan.token, confirmationHost: '127.0.0.1' }), error => error.code === 'NO_EXIT_STATUS'); assert.equal(monitoring.snapshot().at(-1).status, 'unknown'); assert.equal(fixture.monitoring.actions.length, 1);
});
test('journal permissions and unsupported distributions give useful static errors', async t => {
  const { monitoring, request, unit, fixture } = await setup(t, { distro: 'arch', family: '' }); await monitoring.services(request);
  await assert.rejects(monitoring.prepare({ ...request, action: 'restart', unit, sudo: true }), error => error.code === 'UNSUPPORTED_DISTRIBUTION');
  fixture.monitoring.journalDenied = true; await assert.rejects(monitoring.logs({ ...request, unit }), error => error.code === 'PERMISSION_DENIED');
});

test('generated scripts pass POSIX syntax checks and real host capability parsing', async () => {
  const execFile = require('node:util').promisify(require('node:child_process').execFile);
  for (const kind of ['capabilities', 'metrics', 'services', 'processes', 'status', 'logs', 'restart', 'reboot', 'shutdown']) await execFile('/bin/sh', ['-n', '-c', command(kind, 'test.service', false)]);
  const response = await execFile('/bin/sh', ['-c', command('capabilities')]); const caps = parse.capabilities(response.stdout); assert.equal(caps.os, (await execFile('uname', ['-s'])).stdout.trim()); assert.equal(caps.fixture, false);
});
