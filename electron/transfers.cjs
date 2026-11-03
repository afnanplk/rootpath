const fs = require('node:fs/promises');
const nativeFS = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { fail, object, validateId, PublicError } = require('./connection-store.cjs');
const { remotePath, fileName, friendly, call } = require('./files.cjs');
const active = ['queued', 'scanning', 'running', 'conflict'];
const kindOf = stat => (stat.mode & 0o170000) === 0o040000 ? 'folder' : (stat.mode & 0o170000) === 0o100000 ? 'file' : (stat.mode & 0o170000) === 0o120000 ? 'link' : 'other';
const signature = stat => [stat.mode, stat.size, stat.mtime instanceof Date ? stat.mtimeMs : stat.mtime, stat.uid, stat.gid].join(':');
const endpoint = record => JSON.stringify([record.session.profile.host, record.session.profile.port, record.session.profile.username]);
const within = (root, target) => { const rel = path.relative(root, target); return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep)); };
class Transport {
  constructor(channel, root) { this.channel = channel; this.root = root; this.posix = channel ? path.posix : path; }
  join(...parts) { return this.posix.join(...parts); }
  async check(target, writing = false) {
    if (this.channel) { const parent = this.posix.dirname(target), actual = await call(this.channel, 'realpath', parent); if (actual !== parent) fail('PATH_CHANGED', 'A remote parent folder changed or resolves through a symbolic link. Refresh before retrying.'); }
    else {
      if (!within(this.root, target)) fail('LOCAL_SCOPE', 'The transfer path is outside the folder selected for this transfer.');
      const parent = target === this.root && !writing ? this.root : this.posix.dirname(target);
      const canonical = await fs.realpath(parent);
      if (canonical !== parent || (writing && !within(this.root, canonical))) fail('PATH_CHANGED', 'A local parent folder changed or resolves through a symbolic link.');
    }
  }
  async stat(target) { await this.check(target); return this.channel ? call(this.channel, 'lstat', target) : fs.lstat(target); }
  async exists(target) { try { return await this.stat(target); } catch (error) { if (error.code === 'NOT_FOUND' || error.code === 'ENOENT') return null; throw error; } }
  async mkdir(target) { await this.check(target, true); return this.channel ? call(this.channel, 'mkdir', target, { mode: 0o755 }) : fs.mkdir(target, { mode: 0o755 }); }
  async rename(from, to) { await this.check(from, true); await this.check(to, true); if (this.channel) await call(this.channel, 'rename', from, to); else { if (await this.exists(to)) fail('DESTINATION_CHANGED', 'The destination appeared during the transfer; nothing was intentionally overwritten.'); await fs.link(from, to); await fs.unlink(from); } }
  async unlink(target) { await this.check(target, true); return this.channel ? call(this.channel, 'unlink', target) : fs.unlink(target); }
  async mode(target, mode) { return this.channel ? call(this.channel, 'chmod', target, mode & 0o777) : fs.chmod(target, mode & 0o777); }
  async *children(target) {
    await this.check(target);
    if (this.channel) {
      const handle = await call(this.channel, 'opendir', target);
      try { for (;;) { const batch = await call(this.channel, 'readdir', handle); if (!batch || !batch.length) return; for (const child of batch) if (!['.', '..'].includes(child.filename)) { fileName(child.filename); yield child.filename; } } }
      finally { await call(this.channel, 'close', handle).catch(() => {}); }
    } else { const dir = await fs.opendir(target); try { for await (const child of dir) { fileName(child.name); yield child.name; } } finally { await dir.close().catch(() => {}); } }
  }
  read(target) { return this.channel ? this.channel.createReadStream(target, { highWaterMark: 65536 }) : nativeFS.createReadStream(target, { highWaterMark: 65536, flags: nativeFS.constants.O_RDONLY | (nativeFS.constants.O_NOFOLLOW || 0) }); }
  write(target) { return this.channel ? this.channel.createWriteStream(target, { flags: 'wx', mode: 0o600, highWaterMark: 65536 }) : nativeFS.createWriteStream(target, { flags: 'wx', mode: 0o600, highWaterMark: 65536 }); }
}
class Transfers extends EventEmitter {
  constructor(files) {
    super(); this.files = files; this.manager = files.manager; this.jobs = new Map(); this.grants = new Map(); this.running = new Set(); this.disposed = false; this.tasks = new Set();
    this.connectionListener = () => { for (const record of this.jobs.values()) if (active.includes(record.job.status) && this.manager.clients.get(record.job.sessionId)?.session.status !== 'connected') { record.interrupted = true; record.abort.abort(); record.rejectConflict?.(); if (record.job.status === 'queued') { record.job.status = 'failed'; record.job.message = 'Connection closed before this job started. Reconnect and retry manually.'; record.job.endedAt = Date.now(); } } this.changed(); };
    this.manager.on('change', this.connectionListener);
  }
  snapshot() { return [...this.jobs.values()].map(record => structuredClone(record.job)); }
  changed() { if (!this.disposed) this.emit('change', this.snapshot()); }
  async grantUpload(paths) {
    if (!Array.isArray(paths) || !paths.length || paths.length > 1000) fail('INVALID_SELECTION', 'Choose between one and 1000 files or folders.');
    const resolved = [];
    for (const target of paths) { if (typeof target !== 'string' || !path.isAbsolute(target)) fail('INVALID_PATH', 'Select files with the native picker or drag them from your computer.'); const stat = await fs.lstat(target); if (stat.isSymbolicLink()) fail('SOURCE_LINK', 'Select the actual file or folder instead of a symbolic link.'); resolved.push(await fs.realpath(target)); }
    const unique = [...new Set(resolved)].filter(target => !resolved.some(parent => parent !== target && within(parent, target)));
    return this.makeGrant({ kind: 'source', paths: unique });
  }
  async grantDestination(folder) { const canonical = await fs.realpath(folder); if (!(await fs.stat(canonical)).isDirectory()) fail('NOT_DIRECTORY', 'Choose a destination folder.'); return this.makeGrant({ kind: 'destination', paths: [canonical] }); }
  makeGrant(spec) { for (const [id, grant] of this.grants) if (grant.expires < Date.now()) this.grants.delete(id); if (this.grants.size >= 30) fail('GRANT_LIMIT', 'Too many pending transfer selections. Wait a few minutes or restart the app.'); const id = randomUUID(); this.grants.set(id, { ...spec, expires: Date.now() + 10 * 60000 }); return { id, paths: spec.paths }; }
  discardSelections(ids) { if (!Array.isArray(ids) || ids.length > 4) fail('INVALID_INPUT', 'Invalid transfer selection.'); for (const id of ids) { validateId(id); this.grants.delete(id); } }
  grant(id, kind) { validateId(id); const grant = this.grants.get(id); if (!grant || grant.kind !== kind || grant.expires < Date.now()) fail('SELECTION_EXPIRED', 'This transfer selection expired. Choose the files or destination again.'); return grant; }
  async grantLocal(request, destination = false) {
    if (!object(request)) fail('INVALID_INPUT', 'Invalid local transfer selection.');
    if (destination) { const { target } = await this.files.localPath(request); return this.grantDestination(target); }
    if (!Array.isArray(request.paths) || !request.paths.length || request.paths.length > 1000) fail('INVALID_INPUT', 'Select local files or folders to upload.');
    const paths = []; for (const target of request.paths) paths.push((await this.files.localPath({ rootId: request.rootId, path: target }, false)).target);
    return this.grantUpload(paths);
  }
  async enqueue(request) {
    if (!object(request) || !['upload', 'download', 'copy', 'move'].includes(request.kind)) fail('INVALID_INPUT', 'Choose upload, download, copy, or move.');
    const record = this.files.record(request.sessionId); let sources, destination, sourceRoots;
    if (request.kind === 'upload') { const grant = this.grant(request.sourceGrant, 'source'); sources = [...grant.paths]; sourceRoots = [...grant.paths]; destination = remotePath(request.destination); }
    else {
      if (!Array.isArray(request.sources) || !request.sources.length || request.sources.length > 1000) fail('INVALID_INPUT', 'Select between one and 1000 server items.');
      const all = [...new Set(request.sources.map(remotePath))]; if (all.includes('/')) fail('ROOT_PROTECTED', 'Transfer selected items rather than the entire server root.');
      sources = all.filter(target => !all.some(parent => target !== parent && target.startsWith(parent + '/')));
      destination = request.kind === 'download' ? this.grant(request.destinationGrant, 'destination').paths[0] : remotePath(request.destination);
    }
    if (request.kind !== 'download') { const channel = await this.files.channel(request.sessionId); const actual = await call(channel, 'realpath', destination); if (actual !== destination) fail('PATH_CHANGED', 'Navigate to the destination folder’s real path before transferring.'); if (kindOf(await call(channel, 'stat', actual)) !== 'folder') fail('NOT_DIRECTORY', 'The destination must be an existing folder.'); }
    const spec = { kind: request.kind, sources, sourceRoots, destination, endpoint: endpoint(record) };
    const job = this.add(request.sessionId, spec);
    if (request.sourceGrant) this.grants.delete(request.sourceGrant); if (request.destinationGrant) this.grants.delete(request.destinationGrant);
    return job;
  }
  add(sessionId, spec) {
    if (this.disposed) fail('SHUTTING_DOWN', 'The app is shutting down.');
    if ([...this.jobs.values()].filter(r => active.includes(r.job.status)).length >= 20) fail('QUEUE_FULL', 'The queue already contains 20 pending transfers.');
    for (const [id, record] of this.jobs) if (this.jobs.size >= 100 && !active.includes(record.job.status)) this.jobs.delete(id);
    const profile = this.files.record(sessionId).session.profile;
    const job = { id: randomUUID(), sessionId, server: profile.name, kind: spec.kind, status: 'queued', sources: spec.sources, destination: spec.destination, bytesDone: 0, bytesTotal: 0, bytesSkipped: 0, filesDone: 0, filesTotal: 0, skipped: 0, current: '', message: 'Waiting in the transfer queue.', warnings: [] };
    const record = { job, spec, abort: new AbortController(), defaults: {}, finishedRoots: new Set(), lastProgress: 0 };
    this.jobs.set(job.id, record); this.changed(); setImmediate(() => this.pump()); return structuredClone(job);
  }
  pump() {
    if (this.disposed) return;
    for (const record of this.jobs.values()) {
      if (this.running.size >= 2) break;
      if (record.job.status !== 'queued' || this.running.has(record.job.sessionId) || this.files.locks.has(record.job.sessionId)) continue;
      this.running.add(record.job.sessionId);
      const task = this.run(record).finally(() => { this.running.delete(record.job.sessionId); this.tasks.delete(task); this.pump(); }); this.tasks.add(task);
    }
    if ([...this.jobs.values()].some(r => r.job.status === 'queued') && !this.timer) this.timer = setTimeout(() => { this.timer = null; this.pump(); }, 200);
  }
  check(record) { if (record.abort.signal.aborted || this.disposed) fail('CANCELLED', 'Transfer canceled. Completed files remain; incomplete staging files are cleaned up when possible.'); this.files.record(record.job.sessionId); }
  async run(record) {
    const { job, spec } = record; job.status = 'scanning'; job.startedAt = Date.now(); job.message = 'Inspecting source files…'; this.changed();
    try {
      await this.files.exclusive(job.sessionId, async () => {
        const channel = await this.files.channel(job.sessionId);
        const source = new Transport(spec.kind === 'upload' ? null : channel, null), dest = new Transport(spec.kind === 'download' ? null : channel, spec.kind === 'download' ? spec.destination : null);
        let count = 0;
        const scan = async (target, depth, root) => {
          this.check(record); job.current = target; if (Date.now() - record.lastProgress > 100) { record.lastProgress = Date.now(); this.changed(); } if (++count > 50000 || depth > 64) fail('TRANSFER_TOO_LARGE', 'Select smaller groups: a job supports 50,000 entries and 64 folder levels.');
          if (!source.channel) source.root = root;
          const attrs = await source.stat(target), kind = kindOf(attrs);
          const node = { path: target, name: source.posix.basename(target), kind, attrs, signature: signature(attrs), children: [] };
          fileName(node.name);
          if (spec.kind === 'move') job.filesTotal++; else if (kind === 'file') { job.bytesTotal += attrs.size; job.filesTotal++; }
          if (kind === 'folder' && spec.kind !== 'move') for await (const child of source.children(target)) node.children.push(await scan(source.join(target, child), depth + 1, root));
          return node;
        };
        const roots = []; for (const target of spec.sources) roots.push(await scan(target, 0, target));
        job.status = 'running'; job.message = 'Transferring…'; this.changed();
        for (const node of roots) {
          this.check(record); if (!source.channel) source.root = node.path;
          const target = dest.join(spec.destination, node.name);
          if (source.channel && dest.channel && (target === node.path || (node.kind === 'folder' && target.startsWith(node.path + '/')))) {
            if (target !== node.path || spec.kind === 'move') fail('INVALID_DESTINATION', 'Choose a different destination outside the selected source folder.');
          }
          await this.transferNode(record, source, dest, node, target); if (spec.kind === 'move') record.finishedRoots.add(node.path);
        }
      });
      job.status = 'completed'; job.message = job.skipped || job.warnings.length ? 'Finished. Review skipped items and warnings.' : 'Transfer completed.';
    } catch (error) {
      job.status = record.abort.signal.aborted && !record.interrupted ? 'cancelled' : 'failed';
      job.message = record.interrupted ? 'The SSH connection closed. Reconnect and retry manually; completed files remain.' : record.abort.signal.aborted ? 'Transfer canceled. Completed files remain; incomplete staging files are cleaned up when possible.' : error instanceof PublicError ? error.message : error?.name === 'AbortError' ? 'Transfer canceled. Completed files remain.' : friendly(error).message;
    } finally { delete job.conflict; job.current = ''; job.endedAt = Date.now(); this.changed(); }
  }
  async conflict(record, target, node, existing) {
    const sourceKind = node.kind, destinationKind = kindOf(existing), moving = record.spec.kind === 'move';
    const choices = ['skip', 'keep-both'];
    if (target !== node.path && sourceKind === 'file' && destinationKind === 'file') choices.unshift('replace');
    if (target !== node.path && !moving && sourceKind === 'folder' && destinationKind === 'folder') choices.unshift('merge');
    const category = `${sourceKind}:${destinationKind}:${moving}`;
    if (choices.includes(record.defaults[category])) return record.defaults[category];
    record.job.status = 'conflict'; record.job.conflict = { id: randomUUID(), path: target, sourceKind, destinationKind, choices }; record.job.message = 'Choose how to handle an existing item.'; this.changed();
    const choice = await new Promise((resolve, reject) => {
      const done = (error, value) => { clearTimeout(timer); record.abort.signal.removeEventListener('abort', cancelled); record.resolveConflict = null; record.rejectConflict = null; error ? reject(error) : resolve(value); };
      const cancelled = () => done(new PublicError('CANCELLED', 'Transfer canceled while waiting for an overwrite choice.'));
      const timer = setTimeout(() => done(new PublicError('CONFLICT_TIMEOUT', 'The overwrite prompt expired. Retry the job to choose again.')), 5 * 60000);
      record.abort.signal.addEventListener('abort', cancelled, { once: true }); record.rejectConflict = cancelled;
      record.resolveConflict = (value, all) => { if (all) record.defaults[category] = value; done(null, value); };
    });
    this.check(record); delete record.job.conflict; record.job.status = 'running'; record.job.message = 'Transferring…'; this.changed(); return choice;
  }
  resolve(request) {
    if (!object(request) || typeof request.applyAll !== 'boolean') fail('INVALID_INPUT', 'Invalid overwrite choice.'); validateId(request.id); validateId(request.conflictId);
    const record = this.jobs.get(request.id), conflict = record?.job.conflict;
    if (!record?.resolveConflict || !conflict || conflict.id !== request.conflictId || !conflict.choices.includes(request.choice)) fail('STALE_CONFLICT', 'This overwrite choice has expired. Refresh the queue.');
    record.resolveConflict(request.choice, request.applyAll);
  }
  skip(record, node) { record.job.skipped++; if (node.kind === 'file' && record.spec.kind !== 'move') record.job.bytesSkipped += node.attrs.size; for (const child of node.children) this.skip(record, child); }
  async transferNode(record, source, dest, node, originalTarget) {
    this.check(record); const { job, spec } = record;
    if (!['file', 'folder'].includes(node.kind) && spec.kind !== 'move') { this.skip(record, node); if (job.warnings.length < 20) job.warnings.push(`Skipped ${node.path}: symbolic links and special files are not followed.`); return; }
    let target = originalTarget, existing = await dest.exists(target), choice;
    if (existing) {
      choice = await this.conflict(record, target, node, existing);
      if (choice === 'skip') { this.skip(record, node); this.changed(); return; }
      if (choice === 'keep-both') {
        const ext = node.kind === 'file' ? dest.posix.extname(target) : '', stem = dest.posix.basename(target, ext), parent = dest.posix.dirname(target);
        let found = false;
        for (let i = 1; i <= 1000; i++) { const name = `${stem} (copy ${i})${ext}`; fileName(name); const candidate = dest.join(parent, name); if (!await dest.exists(candidate)) { target = candidate; existing = null; found = true; break; } }
        if (!found) fail('NAME_LIMIT', 'Too many duplicate names. Rename an item or choose another destination.');
      }
    }
    if (source.channel && dest.channel && node.kind === 'folder' && (target === node.path || target.startsWith(node.path + '/'))) fail('INVALID_DESTINATION', 'A folder cannot be copied or moved inside itself.');
    if (source.channel && dest.channel && target === node.path) fail('INVALID_DESTINATION', 'Choose Keep both or another destination when copying to the same folder.');
    this.check(record); job.current = node.path; this.changed();
    if (signature(await source.stat(node.path)) !== node.signature) fail('SOURCE_CHANGED', 'A source changed after scanning. Review and retry the job.');
    if (spec.kind === 'move') { await this.commit(record, dest, node.path, target, existing); job.filesDone++; return; }
    if (node.kind === 'folder') {
      if (!existing) await dest.mkdir(target);
      else if (choice !== 'merge' || kindOf(await dest.stat(target)) !== 'folder') fail('DESTINATION_CHANGED', 'The destination folder changed. Retry after refreshing.');
      for (const child of node.children) await this.transferNode(record, source, dest, child, dest.join(target, child.name));
      return;
    }
    const partial = dest.join(dest.posix.dirname(target), `.vps-explorer-${randomUUID()}.part`);
    let complete = false;
    try {
      await dest.check(partial, true); await source.check(node.path);
      const progress = new Transform({ transform: (chunk, _encoding, callback) => { job.bytesDone += chunk.length; if (Date.now() - record.lastProgress > 100) { record.lastProgress = Date.now(); this.changed(); } callback(null, chunk); } });
      await pipeline(source.read(node.path), progress, dest.write(partial), { signal: record.abort.signal });
      this.check(record);
      if (signature(await source.stat(node.path)) !== node.signature) fail('SOURCE_CHANGED', 'The source changed during transfer. The destination was not committed.');
      if ((await dest.stat(partial)).size !== node.attrs.size) fail('SIZE_MISMATCH', 'Transferred size did not match the source. The destination was not committed.');
      await dest.mode(partial, node.attrs.mode); this.check(record);
      await this.commit(record, dest, partial, target, existing); complete = true; job.filesDone++;
    } finally { if (!complete) { try { if (dest.channel && this.manager.clients.get(job.sessionId)?.session.status !== 'connected') fail('DISCONNECTED', 'Remote cleanup requires reconnecting.'); await dest.unlink(partial); } catch (error) { if (!['NOT_FOUND', 'ENOENT'].includes(error.code) && job.warnings.length < 20) job.warnings.push(`An incomplete staging file may remain: ${partial}`); } } }
  }
  async commit(record, dest, partial, target, expected) {
    this.check(record); const current = await dest.exists(target);
    if (Boolean(current) !== Boolean(expected) || (current && signature(current) !== signature(expected))) fail('DESTINATION_CHANGED', 'The destination changed after your overwrite choice. Nothing was intentionally overwritten.');
    if (!expected) { await dest.rename(partial, target); return; }
    if (kindOf(current) !== 'file') fail('DESTINATION_CHANGED', 'Only regular files can be replaced.');
    const backup = dest.join(dest.posix.dirname(target), `.vps-explorer-${randomUUID()}.backup`);
    await dest.rename(target, backup);
    try { await dest.rename(partial, target); }
    catch (error) {
      try { if (!await dest.exists(target)) await dest.rename(backup, target); else fail('ROLLBACK_BLOCKED', 'Destination changed.'); }
      catch { record.job.warnings.push(`Original file retained for recovery: ${backup}`); }
      throw error;
    }
    try { await dest.unlink(backup); } catch { record.job.warnings.push(`Replacement succeeded; old file retained: ${backup}`); }
  }
  cancel(id) {
    validateId(id); const record = this.jobs.get(id); if (!record || !active.includes(record.job.status)) return;
    record.abort.abort(); record.rejectConflict?.();
    if (record.job.status === 'queued') { record.job.status = 'cancelled'; record.job.message = 'Canceled before starting.'; record.job.endedAt = Date.now(); }
    this.changed();
  }
  retry(request) {
    if (!object(request)) fail('INVALID_INPUT', 'Choose a failed or canceled transfer to retry.'); validateId(request.id);
    const record = this.jobs.get(request.id), connection = this.files.record(request.sessionId);
    if (!record || !['failed', 'cancelled'].includes(record.job.status)) fail('NOT_RETRYABLE', 'Only failed or canceled jobs can be retried.');
    if (endpoint(connection) !== record.spec.endpoint) fail('WRONG_SERVER', 'Reconnect to the original host and account before retrying this job.');
    const sources = record.spec.kind === 'move' ? record.spec.sources.filter(source => !record.finishedRoots.has(source)) : record.spec.sources;
    if (!sources.length) fail('NOT_RETRYABLE', 'All selected moves already completed. Refresh the destination.');
    return this.add(request.sessionId, { ...record.spec, sources });
  }
  clearFinished() { for (const [id, record] of this.jobs) if (!active.includes(record.job.status)) this.jobs.delete(id); this.changed(); }
  async dispose() { if (this.disposed) return; this.disposed = true; clearTimeout(this.timer); this.manager.removeListener('change', this.connectionListener); for (const record of this.jobs.values()) { record.abort.abort(); record.rejectConflict?.(); } await Promise.allSettled([...this.tasks]); this.grants.clear(); }
}
module.exports = { Transfers, Transport };
