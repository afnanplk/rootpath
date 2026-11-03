const fs = require('node:fs/promises');
const path = require('node:path');
const { utils } = require('ssh2');
const codes = utils.sftp.STATUS_CODE;
async function seedFiles(root) {
  await fs.mkdir(root, { recursive: true });
  for (const folder of ['docs', 'logs', '.config', 'restricted']) await fs.mkdir(path.join(root, folder), { recursive: true });
  const content = { 'README.md': '# SFTP test workspace\nThese are real files in the isolated local lab.\n', 'docs/hello world.txt': 'Hello from real SFTP.\n', 'docs/مرحبا.txt': 'Unicode filenames work.\n', '.config/settings.json': '{}\n', 'logs/app.log': 'Test log\n' };
  for (const [name, value] of Object.entries(content)) await fs.writeFile(path.join(root, name), value, { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  for (const [name, target] of [['docs-link', 'docs'], ['broken-link', 'missing-target']]) await fs.symlink(target, path.join(root, name)).catch(error => { if (!['EEXIST', 'EPERM'].includes(error.code)) throw error; });
}
function attachSFTP(stream, root, { ioDelayMs = 0 } = {}) {
  let next = 1; const handles = new Map();
  const inside = target => { const relative = path.relative(root, target); return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep); };
  async function translate(remote, follow = true, creating = false) {
    if (remote.includes('\0')) throw Object.assign(new Error(), { code: 'EACCES' });
    const virtual = path.posix.normalize('/' + remote);
    if (virtual === '/restricted' || virtual.startsWith('/restricted/')) throw Object.assign(new Error(), { code: 'EACCES' });
    const target = path.resolve(root, '.' + virtual);
    if (!inside(target)) throw Object.assign(new Error(), { code: 'EACCES' });
    let actual;
    if (target === root) actual = root;
    else if (!follow || creating) actual = path.join(await fs.realpath(path.dirname(target)), path.basename(target));
    else actual = await fs.realpath(target);
    if (!inside(actual)) throw Object.assign(new Error(), { code: 'EACCES' });
    return actual;
  }
  const attrs = stat => ({ mode: stat.mode, size: stat.size, uid: stat.uid, gid: stat.gid, atime: Math.floor(stat.atimeMs / 1000), mtime: Math.floor(stat.mtimeMs / 1000) });
  const status = (id, error) => { if (stream.destroyed) return; stream.status(id, !error ? codes.OK : ['EACCES', 'EPERM'].includes(error.code) ? codes.PERMISSION_DENIED : ['ENOENT', 'ENOTDIR'].includes(error.code) ? codes.NO_SUCH_FILE : codes.FAILURE); };
  const on = (event, handler) => stream.on(event, (id, ...args) => { Promise.resolve().then(() => handler(id, ...args)).catch(error => status(id, error)); });
  const putHandle = (id, value) => { const handle = Buffer.alloc(4); handle.writeUInt32BE(next++); handles.set(handle.toString('hex'), value); stream.handle(id, handle); };
  on('REALPATH', async (id, remote) => { const target = await translate(remote); const virtual = '/' + path.relative(root, target).split(path.sep).join('/'); stream.name(id, [{ filename: virtual, longname: virtual, attrs: {} }]); });
  for (const [event, follow] of [['STAT', true], ['LSTAT', false]]) on(event, async (id, remote) => stream.attrs(id, attrs(await fs[follow ? 'stat' : 'lstat'](await translate(remote, follow)))));
  on('READLINK', async (id, remote) => { const target = await fs.readlink(await translate(remote, false)); stream.name(id, [{ filename: target, longname: target, attrs: {} }]); });
  on('OPENDIR', async (id, remote) => { const target = await translate(remote); putHandle(id, { type: 'directory', directory: await fs.opendir(target), target }); });
  on('READDIR', async (id, handle) => {
    const record = handles.get(handle.toString('hex')); if (!record || record.type !== 'directory') return status(id, new Error());
    const entries = [];
    for (let i = 0; i < 100; i++) { const item = await record.directory.read(); if (!item) break; const stat = await fs.lstat(path.join(record.target, item.name)); entries.push({ filename: item.name, longname: item.name, attrs: attrs(stat) }); }
    if (!entries.length) stream.status(id, codes.EOF); else stream.name(id, entries);
  });
  on('CLOSE', async (id, handle) => { const key = handle.toString('hex'), record = handles.get(key); if (!record) return status(id, new Error()); handles.delete(key); await (record.type === 'directory' ? record.directory : record.file).close(); status(id); });
  on('MKDIR', async (id, remote, attributes) => { await fs.mkdir(await translate(remote, false, true), { mode: attributes.mode || 0o755 }); status(id); });
  on('OPEN', async (id, remote, flags, attributes) => {
    const openFlags = utils.sftp.flagsToString(flags);
    if (!['r', 'wx'].includes(openFlags)) return stream.status(id, codes.OP_UNSUPPORTED);
    putHandle(id, { type: 'file', file: await fs.open(await translate(remote, openFlags === 'r', openFlags === 'wx'), openFlags, attributes.mode || 0o644) });
  });
  on('FSTAT', async (id, handle) => { const record = handles.get(handle.toString('hex')); if (!record || record.type !== 'file') return status(id, new Error()); stream.attrs(id, attrs(await record.file.stat())); });
  on('READ', async (id, handle, offset, length) => {
    const record = handles.get(handle.toString('hex')); if (!record || record.type !== 'file') return status(id, new Error());
    if (ioDelayMs) await new Promise(resolve => setTimeout(resolve, ioDelayMs));
    const buffer = Buffer.alloc(Math.min(length, 65536)); const { bytesRead } = await record.file.read(buffer, 0, buffer.length, offset);
    if (!bytesRead) stream.status(id, codes.EOF); else stream.data(id, buffer.subarray(0, bytesRead));
  });
  on('WRITE', async (id, handle, offset, data) => {
    const record = handles.get(handle.toString('hex')); if (!record || record.type !== 'file') return status(id, new Error());
    if (ioDelayMs) await new Promise(resolve => setTimeout(resolve, ioDelayMs));
    let done = 0; while (done < data.length) { const { bytesWritten } = await record.file.write(data, done, data.length - done, offset + done); if (!bytesWritten) throw new Error(); done += bytesWritten; }
    status(id);
  });
  on('RENAME', async (id, oldPath, newPath) => {
    const old = await translate(oldPath, false), target = await translate(newPath, false, true);
    try { await fs.lstat(target); throw Object.assign(new Error(), { code: 'EEXIST' }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.rename(old, target); status(id);
  });
  on('REMOVE', async (id, remote) => { await fs.unlink(await translate(remote, false)); status(id); });
  on('RMDIR', async (id, remote) => { const target = await translate(remote, false); if (target === root) throw Object.assign(new Error(), { code: 'EACCES' }); await fs.rmdir(target); status(id); });
  on('SETSTAT', async (id, remote, attributes) => { const target = await translate(remote); if (attributes.mode !== undefined) await fs.chmod(target, attributes.mode & 0o7777); status(id); });
  stream.on('error', () => {});
  stream.once('close', () => { for (const record of handles.values()) void (record.type === 'directory' ? record.directory : record.file).close().catch(() => {}); handles.clear(); });
}
module.exports = { attachSFTP, seedFiles };
