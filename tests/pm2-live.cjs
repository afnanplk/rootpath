const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const execFile = require('node:util').promisify(require('node:child_process').execFile);
const { pm2Remote } = require('../electron/applications/pm2-remote.cjs');
(async () => {
  if (!process.env.VPS_PM2_TEST_ROOT) throw new Error('Set VPS_PM2_TEST_ROOT to an isolated test folder containing node_modules/pm2 (5 or 6). Never point at a production daemon.');
  const binary = path.join(process.env.VPS_PM2_TEST_ROOT, 'node_modules/pm2/bin/pm2'); await fs.access(binary);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vps-pm2-live-')), home = path.join(tmp, 'pm2-home'), sample = path.join(tmp, 'sample.cjs');
  await fs.writeFile(sample, 'console.log("disposable-sample-ready"); setInterval(() => {}, 1000);');
  const env = { ...process.env, PM2_HOME: home, TEST_ENV_SECRET: 'SYNTHETIC-ENV-MUST-NOT-LEAK', PM2_DISABLE_VERSION_CHECK: 'true' };
  const cli = args => execFile(process.execPath, [binary, ...args], { env, timeout: 20000, maxBuffer: 1024 * 1024 });
  const helper = async (action, id = '', revision = '') => JSON.parse((await execFile(process.execPath, ['-e', '(' + pm2Remote.toString() + ')()', binary, action, id, revision], { env, timeout: 15000, maxBuffer: 1024 * 1024 })).stdout);
  try {
    await assert.rejects(helper('list'), error => error.code === 79); await assert.rejects(fs.stat(home), error => error.code === 'ENOENT');
    await cli(['start', sample, '--name', 'vps-explorer-disposable', '--no-autorestart']);
    const first = await helper('list'); assert.equal(first.entries.length, 1); assert.equal(JSON.stringify(first).includes(env.TEST_ENV_SECRET), false);
    let app = first.entries[0]; assert.equal(app.state, 'online'); assert.equal(app.name, 'vps-explorer-disposable');
    await helper('restart', app.id, app.revision); app = (await helper('list')).entries[0]; assert.ok(app.restarts > first.entries[0].restarts); assert.equal(JSON.parse((await cli(['jlist'])).stdout)[0].pm2_env.TEST_ENV_SECRET, env.TEST_ENV_SECRET);
    await assert.rejects(helper('restart', app.id, first.entries[0].revision), error => error.code === 75);
    const logs = await helper('logs', app.id); assert.match(logs.text, /disposable-sample-ready/);
    await helper('stop', app.id, app.revision); app = (await helper('list')).entries[0]; assert.equal(app.state, 'stopped');
    await helper('start', app.id, app.revision); app = (await helper('list')).entries[0]; assert.equal(app.state, 'online'); assert.equal(JSON.parse((await cli(['jlist'])).stdout)[0].pm2_env.TEST_ENV_SECRET, env.TEST_ENV_SECRET);
    console.log('Real PM2 test passed: no auto-daemon, list without environment secrets, restart/stale-revision refusal, bounded logs, stop/start in an isolated PM2_HOME. PM2 ' + require(path.join(process.env.VPS_PM2_TEST_ROOT, 'node_modules/pm2/package.json')).version);
  } finally { if (await fs.access(path.join(home, 'pm2.pid')).then(() => true, () => false)) await cli(['kill']).catch(() => {}); await fs.rm(tmp, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
