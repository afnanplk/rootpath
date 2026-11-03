// SSH protocol fixture only. No Docker or PM2 program is executed here.
const { parse } = require('shell-quote');
const { command } = require('../electron/applications/commands.cjs');
const { hash } = require('../electron/applications/parse.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
function createApplicationsFixture(root, options = {}) {
  const ids = ['a'.repeat(64), 'b'.repeat(64)];
  const state = { docker: true, pm2: true, compose: true, denied: false, dockerNeedsSudo: true, noDaemon: false, invalidConfig: false, configVersion: 1, noExit: false, actions: [], ...options, containers: new Map(ids.map((id, i) => [id, { id, name: i ? 'demo-worker' : 'demo-web', image: 'example/test:local', state: i ? 'exited' : 'running', status: i ? 'Exited (0)' : 'Up 5 minutes', ports: i ? '' : '127.0.0.1:8080->80/tcp', project: 'demo', directory: '/apps/demo', configs: '/apps/demo/compose.yaml', startedAt: '2026-10-31T10:00:00Z', finishedAt: '', restarts: 0, imageId: 'sha256:' + 'c'.repeat(64) }])), pm2Apps: new Map([['0', { id: '0', name: 'sample-api', namespace: 'default', state: 'online', pid: 321, restarts: 0, script: '/apps/sample-api.cjs', cwd: '/apps', cpu: 1.2, memory: 16777216 }]]) };
  async function seed() { await fs.mkdir(path.join(root, 'apps/demo'), { recursive: true }); await fs.writeFile(path.join(root, 'apps/demo/compose.yaml'), 'services:\n  web:\n    image: example/test:local\n  worker:\n    image: example/test:local\n', { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; }); }
  function pm2Rows() { return [...state.pm2Apps.values()].map(row => ({ ...row, revision: hash({ ...row, cpu: undefined, memory: undefined }) })); }
  function attach(accept, input) {
    let kind, action, target = { socket: '/var/run/docker.sock' }, sudo = false;
    if (input === command('capabilities')) kind = 'capabilities';
    else {
      const outer = parse(input), args = typeof outer[2] === 'string' ? parse(outer[2]) : [];
      const strings = args.filter(value => typeof value === 'string'); sudo = strings.includes('sudo');
      const nodeIndex = strings.indexOf('node');
      if (nodeIndex >= 0 && strings[nodeIndex + 1] === '-e') {
        const values = strings.slice(-3); action = values[0]; target = { id: values[1], revision: values[2] || undefined };
        try { if (input === command('pm2', action, target, false)) kind = 'pm2'; } catch {}
      } else {
        for (const candidate of ['list', 'compose-version', 'status', 'logs', 'start', 'stop', 'restart', 'hash', 'services', 'redeploy']) {
          const project = strings.includes('compose') && candidate !== 'compose-version';
          kind = project ? 'compose' : 'docker'; action = candidate;
          target = project ? { id: 'demo', socket: '/var/run/docker.sock', directory: '/apps/demo', files: ['/apps/demo/compose.yaml'] } : { id: strings.find(value => /^[a-f0-9]{64}$/.test(value)), socket: '/var/run/docker.sock' };
          try { if (input === command(kind, action, target, sudo)) break; } catch {}
          kind = undefined;
        }
      }
    }
    if (!kind) return false;
    const channel = accept(); channel.on('error', () => {}); let code = 0, stdout = '', stderr = '';
    if (kind === 'capabilities') stdout = `__VPS_APPLICATIONS__\n${state.docker ? 'docker=1\n' : ''}${state.pm2 ? 'pm2=1\nnode=1\n' : ''}socket=/var/run/docker.sock\n`;
    else if ((kind === 'docker' || kind === 'compose') && (!state.docker || state.denied || (state.dockerNeedsSudo && !sudo))) { code = state.docker ? 1 : 127; stderr = 'permission denied SYNTHETIC-SECRET-STDERR'; }
    else if (kind === 'docker' && action === 'compose-version') { if (state.compose) stdout = '2.39.0\n'; else { code = 1; stderr = 'compose is not a docker command'; } }
    else if (kind === 'pm2') {
      if (state.noDaemon) code = 79;
      else if (action === 'list') stdout = JSON.stringify({ entries: pm2Rows() });
      else { const row = state.pm2Apps.get(target.id), latest = pm2Rows().find(row => row.id === target.id); if (!row || (target.revision && target.revision !== latest.revision)) code = 75;
        else if (action === 'logs') stdout = JSON.stringify({ text: 'Simulated sample-api stdout: ready.\n' });
        else { state.actions.push({ kind, action, id: target.id, sudo }); row.state = action === 'stop' ? 'stopped' : 'online'; row.pid = action === 'stop' ? 0 : row.pid + 1 || 322; row.restarts++; stdout = '{"accepted":true}'; }
      }
    } else if (kind === 'docker' && action === 'list') stdout = [...state.containers.values()].map(row => JSON.stringify(row)).join('\n') + '\n';
    else if (kind === 'compose') {
      if (state.invalidConfig) { code = 1; stderr = 'invalid compose config with SECRET-ENV'; }
      else if (action === 'hash') stdout = 'web ' + hash({ version: state.configVersion, file: require('node:fs').readFileSync(path.join(root, 'apps/demo/compose.yaml'), 'utf8') }) + '\n';
      else if (action === 'services') stdout = 'web\nworker\n';
      else if (action === 'logs') stdout = 'demo-web | Simulated Compose logs: ready\n';
      else { state.actions.push({ kind, action, id: target.id, sudo }); for (const row of state.containers.values()) { row.state = action === 'stop' ? 'exited' : 'running'; row.restarts++; if (action === 'redeploy') row.startedAt = new Date().toISOString(); } stdout = 'Simulated Compose command completed.\n'; }
    } else { const row = state.containers.get(target.id); if (!row) { code = 1; stderr = 'No such container'; } else if (action === 'status') stdout = JSON.stringify(row); else if (action === 'logs') { stdout = 'Simulated Docker stdout: ready\n'; stderr = 'Simulated Docker stderr: health check\n'; } else { state.actions.push({ kind, action, id: target.id, sudo }); row.state = action === 'stop' ? 'exited' : 'running'; row.restarts++; stdout = row.id + '\n'; } }
    setImmediate(() => { if (stdout) channel.write(stdout); if (stderr) channel.stderr.write(stderr); if (!state.noExit && !(state.noExitActions && ['start', 'stop', 'restart', 'redeploy'].includes(action))) channel.exit(code); channel.end(); }); return true;
  }
  return { state, seed, attach };
}
module.exports = { createApplicationsFixture };
