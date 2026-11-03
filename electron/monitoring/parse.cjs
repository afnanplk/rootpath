const { fail } = require('../connection-store.cjs');
const clean = value => String(value || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, 1024);
function sections(text) { const values = {}; let current; for (const line of text.split('\n')) { const match = line.match(/^__VPS_([A-Z]+)__$/); if (match) { current = match[1]; values[current] = []; } else if (current) values[current].push(line); } return values; }
function capabilities(text) {
  const data = sections(text); if (!data.SYSTEM || !data.TOOLS || !data.END) fail('INVALID_PROBE', 'The server returned an unrecognized capability response.');
  const [os, kernel, architecture, uid, hostname] = data.SYSTEM.map(clean), release = {};
  for (const line of data.RELEASE || []) { const match = line.match(/^([A-Z_]+)=(.*)$/); if (match) release[match[1]] = clean(match[2].replace(/^(["'])(.*)\1$/, '$2')); }
  const tools = Object.fromEntries(data.TOOLS.map(line => line.split('='))); const ids = [release.ID, ...(release.ID_LIKE || '').split(' ')];
  const family = ids.some(id => ['debian', 'ubuntu'].includes(id)) ? 'debian' : ids.some(id => ['rhel', 'rocky', 'almalinux', 'centos'].includes(id)) ? 'rhel' : 'other';
  return { os, kernel, architecture, uid: /^\d+$/.test(uid || '') ? Number(uid) : null, hostname, distribution: release.PRETTY_NAME || release.ID || os, distributionId: release.ID || '', family, linux: os === 'Linux', metrics: os === 'Linux' && tools.proc === '1', disks: tools.df === '1', processes: os === 'Linux' && tools.ps === '1', services: os === 'Linux' && tools.systemctl === '1' && tools.systemdBooted === '1', journal: tools.journalctl === '1', sudo: tools.sudo === '1', managed: os === 'Linux' && family !== 'other', fixture: release.VPS_EXPLORER_FIXTURE === '1' };
}
const number = value => { const result = Number(value); return Number.isFinite(result) && result >= 0 ? result : null; };
function metrics(text, previous, now) {
  const data = sections(text); if (!data.CPU || !data.MEMORY || !data.END) fail('INVALID_PROBE', 'The metric response was incomplete. Refresh to try again.');
  const ticks = data.CPU[0]?.trim().split(/\s+/).slice(1, 9).map(number);
  if (ticks?.length !== 8 || ticks.some(v => v === null)) fail('INVALID_PROBE', 'CPU counters are unavailable.');
  const cpu = { total: ticks.reduce((a, b) => a + b, 0), idle: ticks[3] + ticks[4] }, memory = {};
  for (const line of data.MEMORY) { const match = line.match(/^(\w+):\s+(\d+)\s+kB/); if (match) memory[match[1]] = Number(match[2]) * 1024; }
  if (!memory.MemTotal) fail('INVALID_PROBE', 'Memory counters are unavailable.');
  const available = memory.MemAvailable ?? Math.max(0, (memory.MemFree || 0) + (memory.Buffers || 0) + (memory.Cached || 0) + (memory.SReclaimable || 0) - (memory.Shmem || 0));
  const used = Math.max(0, memory.MemTotal - Math.min(memory.MemTotal, available));
  const network = (data.NETWORK || []).flatMap(line => { const match = line.match(/^\s*([^:]+):\s*(.*)$/); if (!match) return []; const counters = match[2].trim().split(/\s+/); if (counters.length < 16 || number(counters[0]) === null || number(counters[8]) === null) return []; return [{ name: clean(match[1]), rx: Number(counters[0]), tx: Number(counters[8]) }]; }).slice(0, 256);
  const elapsed = previous ? (now - previous.now) / 1000 : 0, validDelta = elapsed > 0 && elapsed < 60;
  let cpuPercent = null;
  if (validDelta && cpu.total > previous.cpu.total && cpu.idle >= previous.cpu.idle) cpuPercent = Math.max(0, Math.min(100, 100 * (1 - (cpu.idle - previous.cpu.idle) / (cpu.total - previous.cpu.total))));
  const interfaces = network.map(nic => { const before = previous?.network.find(old => old.name === nic.name); return { ...nic, rxPerSecond: validDelta && before && nic.rx >= before.rx ? (nic.rx - before.rx) / elapsed : null, txPerSecond: validDelta && before && nic.tx >= before.tx ? (nic.tx - before.tx) / elapsed : null }; });
  const disks = (data.DISKS || []).slice(1).flatMap(line => { const match = line.match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/); return match ? [{ device: clean(match[1]), total: Number(match[2]), used: Number(match[3]), available: Number(match[4]), percent: Number(match[5]), mount: clean(match[6]) }] : []; }).slice(0, 256);
  return { sample: { now, cpu, network }, view: { cpuPercent, memory: { total: memory.MemTotal, available: Math.min(memory.MemTotal, available), used, percent: used / memory.MemTotal * 100, estimatedAvailable: memory.MemAvailable === undefined, swapTotal: memory.SwapTotal || 0, swapUsed: Math.max(0, (memory.SwapTotal || 0) - (memory.SwapFree || 0)) }, uptime: number(data.UPTIME?.[0]?.split(' ')[0]), load: (data.LOAD?.[0]?.split(/\s+/).slice(0, 3) || []).map(number), interfaces, disks } };
}
function processes(text) { return text.split('\n').flatMap(line => { const match = line.trim().match(/^(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.+)$/); return match ? [{ pid: Number(match[1]), user: clean(match[2]), cpu: Number(match[3]), memoryPercent: Number(match[4]), rss: Number(match[5]) * 1024, state: clean(match[6]), name: clean(match[7]) }] : []; }).slice(0, 200); }
function services(text) {
  const data = sections(text), result = new Map();
  for (const line of data.LOADED || text.split('\n')) { const match = line.trim().match(/^(\S+\.service)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/); if (match) result.set(match[1], { unit: clean(match[1]), load: clean(match[2]), active: clean(match[3]), sub: clean(match[4]), description: clean(match[5]) }); }
  for (const line of data.INSTALLED || []) { const match = line.trim().match(/^(\S+\.service)\s+(\S+)/); if (match && !result.has(match[1])) result.set(match[1], { unit: clean(match[1]), load: 'installed', active: 'not loaded', sub: clean(match[2]), description: 'Installed unit · select to inspect' }); }
  return [...result.values()].sort((a, b) => a.unit.localeCompare(b.unit)).slice(0, 5000);
}
function status(text) { const result = {}; for (const line of text.split('\n')) { const match = line.match(/^(Id|LoadState|ActiveState|SubState|MainPID|Description|FragmentPath|UnitFileState)=(.*)$/); if (match) result[match[1]] = clean(match[2]); } return result; }
module.exports = { clean, capabilities, metrics, processes, services, status };
