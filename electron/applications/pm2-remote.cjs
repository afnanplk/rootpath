// Sent as an ephemeral Node -e program. Never writes files or starts a PM2 daemon.
function pm2Remote() {
  const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
  const [binary, action, id, expected] = process.argv.slice(1);
  const stop = code => { process.exit(code); };
  if (!['list', 'logs', 'start', 'stop', 'restart'].includes(action) || (action !== 'list' && !/^(0|[1-9][0-9]{0,8})$/.test(id))) stop(64);
  let root, home, daemonPid, req, rpc, mutationSubmitted = false;
  const timer = setTimeout(() => stop(mutationSubmitted ? 80 : 79), ['start', 'stop', 'restart'].includes(action) ? 40000 : 10000);
  function finish(value) { clearTimeout(timer); process.stdout.write(JSON.stringify(value), () => { try { req?.close(); } catch {} process.exit(0); }); }
  try {
    root = path.resolve(path.dirname(fs.realpathSync(binary)), '..');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (pkg.name !== 'pm2' || !/^[56]\./.test(pkg.version)) stop(78);
  } catch { stop(78); }
  try {
    home = fs.realpathSync(process.env.PM2_HOME || path.join(require('node:os').homedir(), '.pm2'));
    const pid = fs.readFileSync(path.join(home, 'pm2.pid'), 'utf8').trim();
    if (!/^[1-9][0-9]*$/.test(pid) || !fs.statSync(path.join(home, 'rpc.sock')).isSocket()) stop(79);
    daemonPid = Number(pid); process.kill(daemonPid, 0);
  } catch { stop(79); }
  try {
    const localRequire = require('node:module').createRequire(path.join(root, 'package.json'));
    req = localRequire('pm2-axon').socket('req'); rpc = new (localRequire('pm2-axon-rpc').Client)(req);
  } catch {
    try { req = require(path.join(root, 'modules/pm2-axon')).socket('req'); rpc = new (require(path.join(root, 'modules/pm2-axon-rpc')).Client)(req); } catch { stop(78); }
  }
  function rowView(row) {
    const env = row.pm2_env || {}, numeric = value => Number.isFinite(Number(value)) ? Number(value) : 0;
    const view = { id: String(row.pm_id), name: String(row.name || env.name || ''), namespace: String(env.namespace || 'default'), state: String(env.status || 'unknown'), pid: numeric(row.pid), restarts: numeric(env.restart_time), uptime: numeric(env.pm_uptime), createdAt: numeric(env.created_at), script: String(env.pm_exec_path || ''), cwd: String(env.pm_cwd || ''), uniqueId: String(env.unique_id || '') };
    view.revision = crypto.createHash('sha256').update(JSON.stringify({ home, daemonPid, ...view })).digest('hex');
    return { ...view, cpu: numeric(row.monit?.cpu), memory: numeric(row.monit?.memory) };
  }
  req.on('error', () => stop(79));
  req.once('connect', () => rpc.call('getMonitorData', {}, (error, rows) => {
    if (error || !Array.isArray(rows)) stop(79);
    rows = rows.filter(row => !row.pm2_env?.pmx_module);
    if (action === 'list') return finish({ entries: rows.map(rowView), scope: { home, daemonPid } });
    const raw = rows.find(row => String(row.pm_id) === id); if (!raw) stop(75);
    if (expected && rowView(raw).revision !== expected) stop(75);
    if (action === 'logs') {
      const parts = [];
      for (const name of ['pm_out_log_path', 'pm_err_log_path']) {
        const target = raw.pm2_env?.[name]; if (typeof target !== 'string' || !path.isAbsolute(target)) continue;
        let fd; try { fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK); const stat = fs.fstatSync(fd); if (!stat.isFile()) continue; const size = Math.min(stat.size, 65536), bytes = Buffer.alloc(size); fs.readSync(fd, bytes, 0, size, Math.max(0, stat.size - size)); parts.push((name === 'pm_out_log_path' ? 'STDOUT' : 'STDERR') + '\n' + bytes.toString('utf8').split('\n').slice(-200).join('\n')); } catch { parts.push('Log unavailable to this account.'); } finally { if (fd !== undefined) fs.closeSync(fd); }
      }
      return finish({ text: parts.join('\n\n') || 'No configured log files.' });
    }
    const method = { start: 'startProcessId', stop: 'stopProcessId', restart: 'restartProcessId' }[action];
    const operate = () => rpc.call(method, action === 'restart' ? { id: Number(id), env: {} } : Number(id), err => { if (err) stop(1); finish({ accepted: true }); });
    mutationSubmitted = true;
    if (action === 'stop') rpc.call('stopWatch', 'stopProcessId', Number(id), operate); else operate();
  }));
  req.connect(path.join(home, 'rpc.sock'));
}
module.exports = { pm2Remote };
