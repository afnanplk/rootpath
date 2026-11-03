const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { object, validateId, fail, PublicError } = require('./connection-store.cjs');
const { command, unitName } = require('./monitoring/commands.cjs');
const parse = require('./monitoring/parse.cjs');
const { execute } = require('./monitoring/execute.cjs');
class Monitoring extends EventEmitter {
  constructor(files, { beforePower = () => {} } = {}) {
    super(); this.files = files; this.beforePower = beforePower; this.caps = new Map(); this.samples = new Map(); this.catalog = new Map(); this.plans = new Map(); this.busy = new Set(); this.reads = new Map(); this.history = [];
    this.changed = state => { const connected = new Set(state.sessions.filter(s => s.status === 'connected').map(s => s.id)); for (const id of this.caps.keys()) if (!connected.has(id)) { this.caps.delete(id); this.samples.delete(id); this.catalog.delete(id); } for (const [id, plan] of this.plans) if (!connected.has(plan.sessionId)) this.plans.delete(id); };
    files.manager.on('change', this.changed);
  }
  session(input) { object(input); validateId(input.sessionId); return this.files.record(input.sessionId); }
  async read(input, kind, task) {
    this.session(input); const key = input.sessionId + ':' + kind;
    if (this.reads.has(key)) return this.reads.get(key);
    if (this.reads.size >= 24) fail('MONITOR_BUSY', 'Too many dashboard requests. Wait for current requests to finish.');
    const promise = task(); this.reads.set(key, promise); try { return await promise; } finally { this.reads.delete(key); }
  }
  async run(id, kind, unit, sudo = false, options) {
    const response = await execute(this.files.record(id), command(kind, unit, sudo), options);
    if (response.code !== 0) {
      if (/permission denied|access denied|authentication is required|interactive authentication|required.*password|password.*required|not allowed|not in the sudoers/i.test(response.stderr)) fail('PERMISSION_DENIED', 'Permission denied. Retry with the optional noninteractive sudo setting only if this account is allowed. Otherwise use the terminal for interactive elevation.');
      if (/not booted with systemd|failed to connect to bus/i.test(response.stderr)) fail('SYSTEMD_UNAVAILABLE', 'The systemd manager is unavailable on this server.');
      if (response.code === 127) fail('TOOL_UNAVAILABLE', 'A required server tool is unavailable. Refresh capabilities or use the terminal.');
      fail('REMOTE_COMMAND_FAILED', 'The server command reported a failure. Refresh the service state before trying another action.');
    }
    return response;
  }
  async capabilities(input) {
    return this.read(input, 'capabilities', async () => {
      if (this.caps.has(input.sessionId)) return this.caps.get(input.sessionId);
      const response = await this.run(input.sessionId, 'capabilities'); const result = { ...parse.capabilities(response.stdout), detectedAt: new Date().toISOString() }; this.files.record(input.sessionId); require('./production.cjs').realServer(result);this.caps.set(input.sessionId, result); return result;
    });
  }
  async require(input, feature, managed = false) {
    const caps = await this.capabilities(input);
    if (!caps.linux) fail('UNSUPPORTED_OS', 'This dashboard supports Linux servers. File browsing and terminal access remain available.');
    if (!caps[feature]) fail('CAPABILITY_UNAVAILABLE', feature === 'services' ? 'A running systemd manager was not detected. Service controls are unavailable.' : 'The required server capability was not detected.');
    if (managed && !caps.managed) fail('UNSUPPORTED_DISTRIBUTION', 'Service and power actions support Ubuntu/Debian and Rocky/Alma/RHEL families. This distribution is read only.');
    return caps;
  }
  async metrics(input) {
    return this.read(input, 'metrics', async () => { await this.require(input, 'metrics'); const response = await this.run(input.sessionId, 'metrics'); const now = performance.now(); const parsed = parse.metrics(response.stdout, this.samples.get(input.sessionId), now); this.files.record(input.sessionId); this.samples.set(input.sessionId, parsed.sample); return { ...parsed.view, sampledAt: new Date().toISOString(), probeMs: Math.round(response.duration), warnings: parsed.view.disks.length ? [] : ['Disk usage is unavailable. Check df support and mount permissions.'] }; });
  }
  async processes(input) { return this.read(input, 'processes', async () => { await this.require(input, 'processes'); const response = await this.run(input.sessionId, 'processes'); return { entries: parse.processes(response.stdout), limit: 200, sampledAt: new Date().toISOString() }; }); }
  async services(input) {
    return this.read(input, 'services', async () => { await this.require(input, 'services'); const response = await this.run(input.sessionId, 'services'); const entries = parse.services(response.stdout); this.files.record(input.sessionId); this.catalog.set(input.sessionId, { units: new Set(entries.map(entry => entry.unit)), at: Date.now() }); return { entries, limit: 5000, sampledAt: new Date().toISOString() }; });
  }
  async discovered(input) { unitName(input.unit); const catalog = this.catalog.get(input.sessionId); if (!catalog || Date.now() - catalog.at > 30000) await this.services(input); if (!this.catalog.get(input.sessionId)?.units.has(input.unit)) fail('SERVICE_NOT_DISCOVERED', 'Choose a service from the current discovered service list.'); }
  async status(input) { object(input); unitName(input.unit); return this.read(input, 'status:' + input.unit, async () => { await this.require(input, 'services'); await this.discovered(input); const response = await this.run(input.sessionId, 'status', input.unit); const result = parse.status(response.stdout); if (result.Id !== input.unit || result.LoadState !== 'loaded') fail('SERVICE_CHANGED', 'This service is no longer loaded. Refresh the list.'); return result; }); }
  async logs(input) { return this.read(input, 'logs:' + unitName(input.unit), async () => { await this.require(input, 'services'); await this.require(input, 'journal'); await this.discovered(input); const response = await this.run(input.sessionId, 'logs', input.unit, false, { limit: 512 * 1024 }); return { text: response.stdout.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ''), lines: 200, warning: 'The journal shows entries visible to this account. An empty log can mean restricted journal access.' }; }); }
  async prepare(input) {
    const record = this.session(input);
    if (!['start', 'stop', 'restart', 'reboot', 'shutdown'].includes(input.action) || typeof input.sudo !== 'boolean') fail('INVALID_ACTION', 'Choose a supported action and elevation setting.');
    const caps = await this.require(input, 'services', true);
    if (input.sudo && !caps.sudo && caps.uid !== 0) fail('SUDO_UNAVAILABLE', 'sudo was not detected. Use an account with the required permissions.');
    const power = ['reboot', 'shutdown'].includes(input.action);
    if (power) this.beforePower(input.sessionId);
    const state = power ? null : await this.status(input);
    for (const [id, plan] of this.plans) if (plan.expiresAt < Date.now()) this.plans.delete(id);
    if (this.plans.size >= 64) fail('MONITOR_BUSY', 'Close pending action confirmations before creating more.');
    const plan = { token: randomUUID(), sessionId: input.sessionId, action: input.action, unit: power ? null : input.unit, sudo: caps.uid !== 0 && input.sudo, state, host: record.session.profile.host, server: record.session.profile.name, username: record.session.profile.username, fixture: caps.fixture, expiresAt: Date.now() + 60000 };
    this.plans.set(plan.token, plan); return { ...plan };
  }
  cancel(input) { object(input); validateId(input.token); this.plans.delete(input.token); }
  snapshot() { return this.history.map(item => ({ ...item })); }
  publish() { this.emit('change', this.snapshot()); }
  async perform(input) {
    object(input); validateId(input.token); const plan = this.plans.get(input.token); this.plans.delete(input.token);
    if (!plan || plan.expiresAt < Date.now()) fail('ACTION_EXPIRED', 'This confirmation expired or was already used. Review the action again.');
    const record = this.files.record(plan.sessionId), power = ['reboot', 'shutdown'].includes(plan.action);
    if (power && input.confirmationHost !== plan.host) fail('HOST_CONFIRMATION_REQUIRED', 'Type the server host exactly to confirm this power action.');
    if (this.busy.has(plan.sessionId)) fail('MONITOR_BUSY', 'Another server action is still running. Wait and refresh.');
    this.busy.add(plan.sessionId);
    const item = { id: randomUUID(), sessionId: plan.sessionId, server: plan.server, host: plan.host, action: plan.action, unit: plan.unit, sudo: plan.sudo, simulated: plan.fixture, startedAt: new Date().toISOString(), status: 'running', message: 'Running reviewed action.' };
    this.history.push(item); this.history = this.history.slice(-200); this.publish();
    try {
      await this.require({ sessionId: plan.sessionId }, 'services', true);
      if (power) this.beforePower(plan.sessionId);
      else { const current = await this.status({ sessionId: plan.sessionId, unit: plan.unit }); if (['Id', 'LoadState', 'ActiveState', 'SubState', 'MainPID'].some(key => current[key] !== plan.state[key])) fail('SERVICE_CHANGED', 'The service changed since confirmation. Refresh and review a new action.'); }
      if (record !== this.files.record(plan.sessionId)) fail('DISCONNECTED', 'The original connection is no longer active. Review the action after reconnecting.');
      await this.run(plan.sessionId, plan.action, plan.unit, plan.sudo, { timeout: 30000, limit: 256 * 1024 });
      item.status = 'completed'; item.message = power ? 'Power request accepted. Verify server availability after reconnecting.' : 'Service action finished. Refresh to verify its current state.';
      return { message: item.message };
    } catch (error) {
      item.status = ['PROBE_TIMEOUT', 'PROBE_DISCONNECTED', 'NO_EXIT_STATUS', 'OUTPUT_LIMIT'].includes(error.code) ? 'unknown' : 'failed'; item.code = error instanceof PublicError ? error.code : 'ACTION_FAILED'; item.message = error instanceof PublicError ? error.message : 'The action failed. Refresh before trying it again.'; throw error;
    } finally { item.finishedAt = new Date().toISOString(); this.busy.delete(plan.sessionId); this.publish(); }
  }
  dispose() { this.files.manager.removeListener('change', this.changed); this.plans.clear(); this.caps.clear(); this.samples.clear(); this.catalog.clear(); }
}
module.exports = { Monitoring };
