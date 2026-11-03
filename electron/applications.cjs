const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { object, validateId, fail, PublicError } = require('./connection-store.cjs');
const { execute } = require('./monitoring/execute.cjs');
const { call } = require('./files.cjs');
const { command, targetId } = require('./applications/commands.cjs');
const parse = require('./applications/parse.cjs');
class Applications extends EventEmitter {
  constructor(files, monitoring, { beforeDeploy = () => {} } = {}) {
    super(); this.files = files; this.monitoring = monitoring; this.beforeDeploy = beforeDeploy; this.plans = new Map(); this.reads = new Map(); this.history = []; this.busy = new Set();
    this.changed = state => { const connected = new Set(state.sessions.filter(s => s.status === 'connected').map(s => s.id)); for (const [token, plan] of this.plans) if (!connected.has(plan.sessionId)) this.plans.delete(token); }; files.manager.on('change', this.changed);
  }
  validate(input, target = false) { object(input); validateId(input.sessionId); this.files.record(input.sessionId); if (!['docker', 'compose', 'pm2'].includes(input.kind) || typeof input.sudo !== 'boolean') fail('INVALID_INPUT', 'Choose Docker, Compose or PM2 and an explicit permission scope.'); if (input.kind === 'pm2' && input.sudo) fail('INVALID_ELEVATION', 'PM2 uses the connected account’s daemon. No sudo switch is available.'); if (target) targetId(input.kind, input.id); }
  async read(key, operation) { if (this.reads.has(key)) return this.reads.get(key); if (this.reads.size >= 16) fail('APPLICATION_BUSY', 'Wait for current application requests to finish.'); const pending = operation(); this.reads.set(key, pending); try { return await pending; } finally { this.reads.delete(key); } }
  async run(sessionId, kind, action, target, sudo, options) {
    const result = await execute(this.files.record(sessionId), command(kind, action, target, sudo), options);
    if (result.code !== 0) {
      if (result.code === 75) fail('APPLICATION_CHANGED', 'The application identity changed. Refresh and review a new action.');
      if (result.code === 78) fail('PM2_VERSION_UNSUPPORTED', 'This adapter needs an existing PM2 5 or 6 installation with its bundled RPC modules. Use the terminal for this installation.');
      if (result.code === 80) fail('APPLICATION_TIMEOUT', 'PM2 did not finish the submitted action before the deadline. It may already have run. Inspect its state before retrying.');
      if (result.code === 79) fail('PM2_DAEMON_UNAVAILABLE', 'No accessible running PM2 daemon was found for this account and PM2_HOME. The app will not start one. Check the account, noninteractive PATH and daemon through the terminal.');
      if (result.code === 127) fail('TOOL_MISSING', 'The required application tool is not in the SSH command PATH. Existing installations only; nothing was installed.');
      if (/permission denied|access denied|password.*required|not in the sudoers|not allowed/i.test(result.stderr)) fail('PERMISSION_DENIED', 'Permission denied. For Docker, explicitly request noninteractive sudo or use an account with socket access. PM2 stays in the connected account.');
      if (/cannot connect|is the docker daemon running|connection refused/i.test(result.stderr)) fail('DOCKER_UNAVAILABLE', 'The local Docker daemon is unavailable at the detected Unix socket. Start/check your existing installation outside this app.');
      if (/not a docker command|unknown command.*compose/i.test(result.stderr)) fail('COMPOSE_UNAVAILABLE', 'Docker Compose v2 was not detected. The legacy docker-compose command is not supported.');
      fail('APPLICATION_COMMAND_FAILED', 'The application command failed. Check the installation/configuration and refresh its state before retrying.');
    }
    return result;
  }
  async capabilities(input) {
    object(input); validateId(input.sessionId); this.files.record(input.sessionId);
    return this.read(input.sessionId + ':capabilities', async () => { const linux = await this.monitoring.capabilities(input); const result = await this.run(input.sessionId, 'capabilities'); const values = Object.fromEntries(result.stdout.split('\n').filter(line => line.includes('=')).map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; })); return { linux: linux.linux, managed: linux.managed, fixture: linux.fixture, sudo: linux.sudo, docker: values.docker === '1', pm2: values.pm2 === '1' && values.node === '1', socket: values.socket || '/var/run/docker.sock' }; });
  }
  async require(input) { const caps = await this.capabilities(input); if (!caps.linux) fail('UNSUPPORTED_OS', 'Application management supports Linux servers.'); if (!caps[input.kind === 'compose' ? 'docker' : input.kind]) fail('TOOL_MISSING', input.kind === 'pm2' ? 'PM2 and Node were not found in the noninteractive SSH PATH. Connect as the owning account; this app does not install or start a daemon.' : 'Docker was not detected. This app manages existing installations and does not install Docker.'); if (input.sudo && !caps.sudo) fail('SUDO_UNAVAILABLE', 'sudo is not available for this account.'); return caps; }
  async list(input) {
    this.validate(input); return this.read([input.sessionId, input.kind, input.sudo, 'list'].join(':'), async () => {
      const caps = await this.require(input), target = { socket: caps.socket }; let entries;
      if (input.kind === 'pm2') entries = parse.pm2((await this.run(input.sessionId, 'pm2', 'list')).stdout);
      else { if (input.kind === 'compose') await this.run(input.sessionId, 'docker', 'compose-version', target, input.sudo); const rows = parse.containers((await this.run(input.sessionId, 'docker', 'list', target, input.sudo)).stdout); entries = input.kind === 'compose' ? parse.projects(rows) : rows; }
      return { entries, limit: 2000, scope: input.kind === 'pm2' ? 'Current SSH account and PM2_HOME · existing daemon only' : `${caps.socket} · ${input.sudo ? 'sudo explicitly requested' : 'connected account permissions'}` };
    });
  }
  async lookup(input) { const { entries } = await this.list(input); const target = entries.find(entry => entry.id === input.id); if (!target) fail('APPLICATION_NOT_FOUND', 'This application is no longer discovered in this permission scope. Refresh the list.'); return target; }
  async composeTarget(input, row) {
    if (row.issue) fail('COMPOSE_CONFIG_UNAVAILABLE', row.issue);
    const channel = await this.files.channel(input.sessionId);
    const directory = await call(channel, 'realpath', row.directory);
    if (directory !== row.directory) fail('COMPOSE_PATH_CHANGED', 'The project working directory resolves through an alias. Review its canonical configuration through the terminal.');
    for (const file of row.files) { if (await call(channel, 'realpath', file) !== file) fail('COMPOSE_PATH_CHANGED', 'A Compose configuration path changed or is a symbolic link. Review it through the terminal.'); const stat = await call(channel, 'lstat', file); if ((stat.mode & 0o170000) !== 0o100000 || stat.size > 2 * 1024 * 1024) fail('COMPOSE_CONFIG_UNAVAILABLE', 'Compose configuration files must be accessible regular files up to 2 MiB.'); }
    return { ...row, socket: (await this.capabilities(input)).socket };
  }
  async state(input) {
    this.validate(input, true); const row = await this.lookup(input), caps = await this.capabilities(input);
    if (input.kind === 'docker') { const raw = parse.json((await this.run(input.sessionId, 'docker', 'status', { id: row.id, socket: caps.socket }, input.sudo)).stdout); const view = { id: targetId('docker', raw.id), name: parse.text(raw.name), image: parse.text(raw.image), imageId: parse.text(raw.imageId), state: parse.text(raw.state), startedAt: parse.text(raw.startedAt), finishedAt: parse.text(raw.finishedAt), restarts: Number(raw.restarts) || 0 }; return { target: { ...row, socket: caps.socket }, revision: parse.hash({ socket: caps.socket, sudo: input.sudo, view }), details: view }; }
    if (input.kind === 'pm2') return { target: row, revision: row.revision, details: row };
    const target = await this.composeTarget(input, row), hashes = (await this.run(input.sessionId, 'compose', 'hash', target, input.sudo)).stdout.trim();
    if (!hashes || hashes.length > 128000) fail('COMPOSE_CONFIG_UNAVAILABLE', 'Compose did not return a bounded configuration hash. Check Compose v2 support.');
    const services = (await this.run(input.sessionId, 'compose', 'services', target, input.sudo)).stdout.trim().split('\n').filter(Boolean);
    if (services.length > 500 || services.some(name => !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name))) fail('COMPOSE_CONFIG_UNAVAILABLE', 'The project service list is unsupported or exceeds 500 services.');
    return { target, revision: parse.hash({ target, hashes, services }), details: { name: row.name, state: row.state, directory: row.directory, files: row.files, services, containers: row.members.length } };
  }
  async details(input) { this.validate(input, true); return this.read([input.sessionId, input.kind, input.id, input.sudo, 'details'].join(':'), async () => (await this.state(input)).details); }
  async logs(input) {
    this.validate(input, true); return this.read([input.sessionId, input.kind, input.id, input.sudo, 'logs'].join(':'), async () => { const row = await this.lookup(input), caps = await this.capabilities(input); const target = input.kind === 'compose' ? await this.composeTarget(input, row) : { ...row, socket: caps.socket }; const result = await this.run(input.sessionId, input.kind, 'logs', target, input.sudo, { limit: 512 * 1024 }); const value = input.kind === 'pm2' ? parse.json(result.stdout).text : result.stdout + result.stderr; return { text: String(value || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ''), note: input.kind === 'pm2' ? 'Last 64 KiB / 200 lines per configured stdout/stderr log. Application logs may contain sensitive data.' : 'Last 200 lines per container, bounded to 512 KiB. Application logs may contain sensitive data.' }; });
  }
  async prepare(input) {
    this.validate(input, true); if (!['start', 'stop', 'restart', 'redeploy'].includes(input.action) || (input.action === 'redeploy' && input.kind !== 'compose')) fail('INVALID_ACTION', 'Redeploy applies to Compose projects; existing containers and PM2 support start, stop and restart.');
    const caps = await this.require(input); if (!caps.managed) fail('UNSUPPORTED_DISTRIBUTION', 'Application mutations support the detected Debian and RHEL families.');
    if (input.action === 'redeploy') this.beforeDeploy(input.sessionId);
    const state = await this.state(input), record = this.files.record(input.sessionId);
    if (input.kind === 'pm2' && input.action === 'start' && state.target.state !== 'stopped' && state.target.state !== 'errored') fail('APPLICATION_STATE', 'PM2 Start applies to an existing stopped or errored application.');
    for (const [token, plan] of this.plans) if (plan.expiresAt < Date.now()) this.plans.delete(token);
    if (this.plans.size >= 64) fail('APPLICATION_BUSY', 'Close pending application reviews before opening more.');
    const plan = { token: randomUUID(), sessionId: input.sessionId, kind: input.kind, id: input.id, action: input.action, sudo: input.sudo, target: state.target, revision: state.revision, details: state.details, server: record.session.profile.name, host: record.session.profile.host, name: state.target.name, fixture: caps.fixture, expiresAt: Date.now() + 60000 };
    this.plans.set(plan.token, plan); const { target, revision, ...view } = plan; return view;
  }
  cancel(input) { object(input); validateId(input.token); this.plans.delete(input.token); }
  snapshot() { return this.history.map(row => ({ ...row })); }
  publish() { this.emit('change', this.snapshot()); }
  async perform(input) {
    object(input); validateId(input.token); const plan = this.plans.get(input.token); this.plans.delete(input.token);
    if (!plan || plan.expiresAt < Date.now()) fail('ACTION_EXPIRED', 'This application confirmation expired or was already used. Review again.');
    if (plan.action === 'redeploy' && input.confirmationName !== plan.name) fail('NAME_CONFIRMATION_REQUIRED', 'Type the project name exactly to confirm recreation.');
    this.files.record(plan.sessionId); if (this.monitoring.busy.has(plan.sessionId)) fail('APPLICATION_BUSY', 'Another reviewed server action is running.');
    this.monitoring.busy.add(plan.sessionId); this.busy.add(plan.sessionId);
    const history = { id: randomUUID(), sessionId: plan.sessionId, server: plan.server, host: plan.host, kind: plan.kind, action: plan.action, name: plan.name, sudo: plan.sudo, simulated: plan.fixture, startedAt: new Date().toISOString(), status: 'running', message: 'Running reviewed application action.' };
    this.history.push(history); this.history = this.history.slice(-200); this.publish();
    try {
      if (plan.action === 'redeploy') this.beforeDeploy(plan.sessionId);
      return await this.files.exclusive(plan.sessionId, async () => { const current = await this.state(plan); if (current.revision !== plan.revision) fail('APPLICATION_CHANGED', 'Application identity, state or Compose configuration changed after review. Refresh and review again.'); await this.run(plan.sessionId, plan.kind, plan.action, { ...current.target, revision: plan.revision }, plan.sudo, { timeout: plan.action === 'redeploy' ? 120000 : 45000, limit: 512 * 1024 }); history.status = 'completed'; history.message = 'Application command completed. Refresh and inspect its state and logs.'; return { message: history.message }; });
    } catch (error) { history.status = ['APPLICATION_TIMEOUT', 'PROBE_TIMEOUT', 'PROBE_DISCONNECTED', 'NO_EXIT_STATUS', 'OUTPUT_LIMIT'].includes(error.code) ? 'unknown' : 'failed'; history.code = error instanceof PublicError ? error.code : 'APPLICATION_FAILED'; history.message = error instanceof PublicError ? error.message : 'Application action failed. Inspect its state before retrying.'; throw error; }
    finally { history.finishedAt = new Date().toISOString(); this.monitoring.busy.delete(plan.sessionId); this.busy.delete(plan.sessionId); this.publish(); }
  }
  dispose() { this.files.manager.removeListener('change', this.changed); this.plans.clear(); }
}
module.exports = { Applications };
