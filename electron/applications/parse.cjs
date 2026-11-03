const { createHash } = require('node:crypto');
const { fail } = require('../connection-store.cjs');
const { targetId, absolute } = require('./commands.cjs');
const text = value => String(value ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, 4096);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function json(value) { try { return JSON.parse(value); } catch { fail('INVALID_RESPONSE', 'The application tool returned an unsupported response. Check its version and permissions.'); } }
function containers(value) {
  return value.trim().split('\n').filter(Boolean).slice(0, 2000).map(line => {
    const raw = json(line); targetId('docker', raw.id);
    return { id: raw.id, name: text(raw.name).replace(/^\//, ''), image: text(raw.image), state: text(raw.state), status: text(raw.status), ports: text(raw.ports), project: text(raw.project), directory: typeof raw.directory === 'string' ? raw.directory : '', configs: typeof raw.configs === 'string' ? raw.configs : '' };
  });
}
function projects(rows) {
  const groups = new Map();
  for (const row of rows.filter(r => r.project)) {
    try { targetId('compose', row.project); } catch { continue; }
    const group = groups.get(row.project) || { id: row.project, name: row.project, state: '', members: [], directory: row.directory, configs: row.configs, issue: '' };
    if (group.directory !== row.directory || group.configs !== row.configs) group.issue = 'Project containers disagree about their configuration paths. Use the terminal to review them.';
    group.members.push({ id: row.id, state: row.state }); groups.set(row.project, group);
  }
  return [...groups.values()].map(group => {
    let files = []; try { absolute(group.directory); files = group.configs.split(',').map(absolute); if (files.length > 16) throw new Error(); } catch { group.issue = 'Configuration paths are missing or unsupported. Manage this project through the terminal.'; }
    return { ...group, files, state: group.members.every(m => m.state === 'running') ? 'running' : group.members.every(m => m.state !== 'running') ? 'stopped' : 'mixed' };
  });
}
function pm2(value) {
  const data = json(value); if (!Array.isArray(data.entries)) fail('INVALID_RESPONSE', 'PM2 returned an unsupported application list.');
  return data.entries.slice(0, 2000).map(raw => {
    targetId('pm2', raw.id); if (!/^[a-f0-9]{64}$/.test(raw.revision)) fail('INVALID_RESPONSE', 'PM2 application identity is unavailable.');
    return { id: raw.id, name: text(raw.name), namespace: text(raw.namespace), state: text(raw.state), pid: Number(raw.pid) || 0, cpu: Number(raw.cpu) || 0, memory: Number(raw.memory) || 0, restarts: Number(raw.restarts) || 0, script: text(raw.script), cwd: text(raw.cwd), revision: raw.revision };
  });
}
module.exports = { text, hash, json, containers, projects, pm2 };
