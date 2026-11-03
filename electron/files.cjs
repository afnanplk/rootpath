const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PublicError, fail, object, validateId } = require('./connection-store.cjs');
const PAGE_SIZE = 250, MAX_DELETE = 10000, MAX_DEPTH = 64;
function remotePath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\0') || Buffer.byteLength(value) > 4096) fail('INVALID_PATH', 'Choose an absolute server path shorter than 4096 bytes.');
  return path.posix.normalize(value);
}
function fileName(value) {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[\/\x00-\x1f\x7f]/.test(value) || Buffer.byteLength(value) > 255) fail('INVALID_NAME', 'Enter a name without slashes or control characters, up to 255 bytes.');
  return value;
}
function friendly(error) {
  if (error instanceof PublicError) return error;
  if (error?.code === 2 || error?.code === 'ENOENT') return new PublicError('NOT_FOUND', 'The file or folder no longer exists. Refresh and try again.');
  if (error?.code === 3 || ['EACCES', 'EPERM'].includes(error?.code)) return new PublicError('PERMISSION_DENIED', 'Permission denied. The connected account does not have access to this item.');
  if (error?.code === 'EEXIST') return new PublicError('ALREADY_EXISTS', 'An item with that name already exists. Nothing was overwritten.');
  if (error?.code === 8) return new PublicError('UNSUPPORTED', 'This server does not support the requested SFTP operation.');
  return new PublicError('FILE_OPERATION_FAILED', 'The file operation failed. Refresh the folder and check the connection and permissions.');
}
function call(channel, method, ...args) {
  return new Promise((resolve, reject) => {
    if (channel._vpsClosed || channel.destroyed) { reject(new PublicError('DISCONNECTED', 'The SFTP channel is closed. Reconnect before trying again.')); return; }
    let done = false;
    const finish = (error, value) => { if (method === 'readdir' && error?.code === 1) { error = null; value = false; } if (done) return; done = true; clearTimeout(timer); channel.removeListener('close', closed); error ? reject(friendly(error)) : resolve(value); };
    const closed = () => finish(new PublicError('DISCONNECTED', 'The SFTP channel closed. Reconnect before trying again.'));
    const timer = setTimeout(() => finish(new PublicError('OPERATION_TIMEOUT', 'The server did not respond in time. The operation may have completed; refresh before retrying.')), 20000);
    channel.once('close', closed);
    try { channel[method](...args, finish); } catch (error) { finish(error); }
  });
}
function entry(name, fullPath, attrs) {
  const mode = attrs.mode || 0;
  const type = mode & 0o170000;
  return { name, path: fullPath, kind: type === 0o040000 ? 'folder' : type === 0o120000 ? 'link' : type === 0o100000 ? 'file' : 'other', size: Number(attrs.size || 0), modified: Number(attrs.mtime || 0) * 1000, mode, uid: attrs.uid, gid: attrs.gid };
}
function signature(attrs) { return [attrs.mode, attrs.size, attrs.mtime, attrs.uid, attrs.gid].join(':'); }
class Files {
  constructor(manager) { this.manager = manager; this.channels = new Map(); this.locals = new Map(); this.cursors = new Map(); this.plans = new Map(); this.locks = new Set(); }
  record(id) { validateId(id); const record = this.manager.clients.get(id); if (!record || record.stopped || record.session.status !== 'connected') fail('DISCONNECTED', 'This SSH session is disconnected. Reconnect before browsing or changing files.'); return record; }
  async channel(id) {
    const record = this.record(id);
    if (!this.channels.has(id)) {
      const pending = new Promise((resolve, reject) => {
        let settled = false;
        const done = (error, channel) => { if (settled) { channel?.end(); return; } settled = true; clearTimeout(timer); record.client.removeListener('close', closed); if (error) { this.channels.delete(id); reject(friendly(error)); } else {
          channel.on('error', () => {});
          channel.once('close', () => { channel._vpsClosed = true; this.channels.delete(id); this.invalidate(id); });
          resolve(channel);
        } };
        const closed = () => done(new PublicError('DISCONNECTED', 'The SSH session closed while starting SFTP.'));
        const timer = setTimeout(() => done(new PublicError('SFTP_UNAVAILABLE', 'SFTP is unavailable or did not respond. Check the server SFTP configuration.')), 20000);
        record.client.once('close', closed);
        try { record.client.sftp(done); } catch (error) { done(error); }
      });
      this.channels.set(id, pending);
    }
    return this.channels.get(id);
  }
  invalidate(id) { for (const [token, cursor] of this.cursors) if (cursor.owner === id) { this.cursors.delete(token); void cursor.close(); } for (const [token, plan] of this.plans) if (plan.sessionId === id) this.plans.delete(token); }
  prune() {
    for (const [token, cursor] of this.cursors) if (cursor.expires < Date.now()) { this.cursors.delete(token); void cursor.close(); }
    for (const [token, plan] of this.plans) if (plan.expiresAt < Date.now()) this.plans.delete(token);
  }
  async releaseListing(request) {
    if (!object(request)) fail('INVALID_INPUT', 'Invalid listing request.'); validateId(request.ownerId); validateId(request.cursor);
    const cursor = this.cursors.get(request.cursor); if (cursor?.owner === request.ownerId) { this.cursors.delete(request.cursor); await cursor.close(); }
  }
  async list(request) {
    if (!object(request)) fail('INVALID_INPUT', 'Invalid folder request.');
    const channel = await this.channel(request.sessionId); this.prune();
    const requested = request.path === '~' ? await call(channel, 'realpath', '.') : remotePath(request.path);
    let cursor;
    if (request.cursor) {
      validateId(request.cursor); cursor = this.cursors.get(request.cursor);
      if (!cursor || cursor.owner !== request.sessionId || cursor.path !== requested || cursor.busy) fail('EXPIRED_LISTING', 'This folder listing expired or is busy. Refresh to load it again.');
      this.cursors.delete(request.cursor);
    } else {
      if (this.cursors.size >= 20) fail('LISTING_LIMIT', 'Too many folders are loading. Wait a moment and refresh.');
      const canonical = await call(channel, 'realpath', requested);
      const handle = await call(channel, 'opendir', canonical);
      let home; try { home = await call(channel, 'realpath', '.'); } catch { home = '/'; }
      cursor = { owner: request.sessionId, path: canonical, home, handle, buffer: [], expires: Date.now() + 60000, close: async () => { try { await call(channel, 'close', handle); } catch {} } };
    }
    cursor.busy = true;
    const entries = [];
    try {
      while (entries.length < PAGE_SIZE) {
        if (!cursor.buffer.length) {
          const batch = await call(channel, 'readdir', cursor.handle);
          if (batch === false || !batch.length) { await cursor.close(); return { path: cursor.path, home: cursor.home, entries }; }
          cursor.buffer = batch.filter(item => item.filename !== '.' && item.filename !== '..' && !item.filename.includes('/') && !item.filename.includes('\0'));
        }
        while (cursor.buffer.length && entries.length < PAGE_SIZE) { const item = cursor.buffer.shift(); entries.push(entry(item.filename, path.posix.join(cursor.path, item.filename), item.attrs)); }
      }
      cursor.busy = false; cursor.expires = Date.now() + 60000;
      const token = randomUUID(); this.cursors.set(token, cursor);
      return { path: cursor.path, home: cursor.home, entries, nextCursor: token };
    } catch (error) { await cursor.close(); throw friendly(error); }
  }
  async properties(request) {
    if (!object(request)) fail('INVALID_INPUT', 'Invalid property request.');
    const channel = await this.channel(request.sessionId), target = remotePath(request.path);
    const attrs = await call(channel, 'lstat', target), item = entry(path.posix.basename(target) || '/', target, attrs);
    if (item.kind === 'link') { try { item.linkTarget = await call(channel, 'readlink', target); } catch { item.linkError = 'The symbolic-link target could not be read.'; } }
    return item;
  }
  async exclusive(id, operation) {
    this.record(id); if (this.locks.has(id)) fail('OPERATION_BUSY', 'Another file change is still running for this server. Wait for it to finish.');
    this.locks.add(id); try { return await operation(); } catch (error) { throw friendly(error); } finally { this.locks.delete(id); }
  }
  async canonicalParent(channel, target) {
    if (target === '/') fail('ROOT_PROTECTED', 'The filesystem root cannot be changed or deleted.');
    const parent = await call(channel, 'realpath', path.posix.dirname(target));
    if (parent !== path.posix.dirname(target)) fail('PATH_CHANGED', 'A parent folder resolves through a symbolic link or has changed. Navigate to its real path and try again.');
  }
  async create(request) {
    if (!object(request) || !['folder', 'file'].includes(request.kind)) fail('INVALID_INPUT', 'Choose a file or folder to create.');
    const parent = remotePath(request.path), name = fileName(request.name);
    return this.exclusive(request.sessionId, async () => {
      const channel = await this.channel(request.sessionId), canonical = await call(channel, 'realpath', parent);
      if (canonical !== parent) fail('PATH_CHANGED', 'The parent folder changed. Refresh before creating an item.');
      const target = path.posix.join(parent, name);
      try { await call(channel, 'lstat', target); fail('ALREADY_EXISTS', 'An item with that name already exists. Nothing was overwritten.'); } catch (error) { if (error.code !== 'NOT_FOUND') throw error; }
      if (request.kind === 'folder') await call(channel, 'mkdir', target, { mode: 0o755 });
      else { const handle = await call(channel, 'open', target, 'wx', { mode: 0o644 }); await call(channel, 'close', handle); }
    });
  }
  async rename(request) {
    if (!object(request)) fail('INVALID_INPUT', 'Invalid rename request.');
    const source = remotePath(request.path), name = fileName(request.name), target = path.posix.join(path.posix.dirname(source), name);
    return this.exclusive(request.sessionId, async () => {
      const channel = await this.channel(request.sessionId); await this.canonicalParent(channel, source);
      if (target === source) return;
      await call(channel, 'lstat', source);
      try { await call(channel, 'lstat', target); fail('ALREADY_EXISTS', 'An item with that name already exists. Nothing was overwritten.'); } catch (error) { if (error.code !== 'NOT_FOUND') throw error; }
      await call(channel, 'rename', source, target);
    });
  }
  async chmod(request) {
    if (!object(request) || typeof request.mode !== 'string' || !/^[0-7]{3}$/.test(request.mode)) fail('INVALID_MODE', 'Enter three octal digits, such as 644 or 755. Special permission bits are not changed here.');
    const target = remotePath(request.path);
    return this.exclusive(request.sessionId, async () => {
      const channel = await this.channel(request.sessionId); await this.canonicalParent(channel, target);
      const attrs = await call(channel, 'lstat', target);
      if ((attrs.mode & 0o170000) === 0o120000) fail('LINK_PERMISSIONS', 'Permission changes on symbolic links are disabled to avoid changing their targets.');
      await call(channel, 'chmod', target, (attrs.mode & 0o7000) | parseInt(request.mode, 8));
    });
  }
  async prepareDelete(request) {
    if (!object(request) || !Array.isArray(request.paths) || request.paths.length < 1 || request.paths.length > 1000) fail('INVALID_INPUT', 'Select between one and 1000 items to delete.');
    const roots = [...new Set(request.paths.map(remotePath))].sort();
    if (roots.includes('/')) fail('ROOT_PROTECTED', 'The filesystem root cannot be deleted.');
    const paths = roots.filter(target => !roots.some(parent => target !== parent && target.startsWith(parent + '/')));
    return this.exclusive(request.sessionId, async () => {
      this.prune(); const channel = await this.channel(request.sessionId), inventory = [];
      const walk = async (target, depth) => {
        if (depth > MAX_DEPTH || inventory.length >= MAX_DELETE) fail('DELETE_TOO_LARGE', 'This deletion exceeds 10,000 entries or 64 nested folders. Delete smaller groups.');
        await this.canonicalParent(channel, target);
        const attrs = await call(channel, 'lstat', target), kind = entry('', target, attrs).kind;
        inventory.push({ path: target, signature: signature(attrs), kind });
        if (kind === 'folder') {
          const handle = await call(channel, 'opendir', target);
          try {
            for (;;) {
              const batch = await call(channel, 'readdir', handle); if (!batch || !batch.length) break;
              for (const child of batch) if (!['.', '..'].includes(child.filename)) { fileName(child.filename); await walk(path.posix.join(target, child.filename), depth + 1); }
            }
          } finally { await call(channel, 'close', handle).catch(() => {}); }
        }
      };
      for (const target of paths) await walk(target, 0);
      if (this.plans.size >= 20) fail('DELETE_PLAN_LIMIT', 'Too many pending delete confirmations. Wait two minutes before trying again.');
      const plan = { token: randomUUID(), sessionId: request.sessionId, paths, inventory, files: inventory.filter(i => !['folder', 'link'].includes(i.kind)).length, folders: inventory.filter(i => i.kind === 'folder').length, links: inventory.filter(i => i.kind === 'link').length, expiresAt: Date.now() + 120000 };
      this.plans.set(plan.token, plan);
      const { inventory: _inventory, sessionId: _id, ...summary } = plan; return summary;
    });
  }
  async delete(request) {
    if (!object(request)) fail('INVALID_INPUT', 'Invalid delete request.'); validateId(request.token);
    return this.exclusive(request.sessionId, async () => {
      const plan = this.plans.get(request.token);
      if (!plan || plan.sessionId !== request.sessionId || plan.expiresAt < Date.now()) fail('DELETE_EXPIRED', 'The delete confirmation expired. Select the items and confirm again.');
      this.plans.delete(request.token); const channel = await this.channel(request.sessionId);
      for (const item of plan.inventory) { await this.canonicalParent(channel, item.path); if (signature(await call(channel, 'lstat', item.path)) !== item.signature) fail('DELETE_CHANGED', 'An item changed after the preview. Nothing was deleted; review and confirm again.'); }
      let removed = 0; const failed = [];
      for (const item of [...plan.inventory].reverse()) {
        try {
          await this.canonicalParent(channel, item.path);
          const attrs = await call(channel, 'lstat', item.path);
          // Directory timestamps change as their own children are removed.
          if (item.kind !== 'folder' && signature(attrs) !== item.signature) fail('DELETE_CHANGED', 'This item changed after confirmation and was not deleted.');
          if (entry('', item.path, attrs).kind !== item.kind) fail('DELETE_CHANGED', 'This item changed type and was not deleted.');
          await call(channel, item.kind === 'folder' ? 'rmdir' : 'unlink', item.path); removed++;
        } catch (error) { failed.push({ path: item.path, message: friendly(error).message }); if (!['connected'].includes(this.manager.clients.get(request.sessionId)?.session.status)) break; }
      }
      return { removed, failed };
    });
  }
  cancelDelete(request) {
    if (!object(request)) fail('INVALID_INPUT', 'Invalid delete preview request.'); validateId(request.sessionId); validateId(request.token);
    if (this.plans.get(request.token)?.sessionId === request.sessionId) this.plans.delete(request.token);
  }
  async addLocalRoot(directory) {
    const canonical = await fs.realpath(directory); if (!(await fs.stat(canonical)).isDirectory()) fail('NOT_DIRECTORY', 'Choose a local folder.');
    if (this.locals.size >= 10) { const oldest = this.locals.keys().next().value; this.locals.delete(oldest); this.invalidate(oldest); }
    const rootId = randomUUID(); this.locals.set(rootId, canonical); return { rootId, path: canonical };
  }
  async localPath(request, follow = true) {
    if (!object(request)) fail('INVALID_INPUT', 'Invalid local folder request.'); validateId(request.rootId);
    const root = this.locals.get(request.rootId); if (!root) fail('LOCAL_ROOT_EXPIRED', 'Choose the local folder again.');
    if (typeof request.path !== 'string' || request.path.includes('\0') || !path.isAbsolute(request.path)) fail('INVALID_PATH', 'Choose an absolute local path.');
    const target = path.resolve(request.path);
    const inside = item => { const relative = path.relative(root, item); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); };
    if (!inside(target)) fail('LOCAL_SCOPE', 'This path is outside the local folder you selected. Choose another folder to browse it.');
    const canonical = follow ? await fs.realpath(target) : path.join(await fs.realpath(path.dirname(target)), path.basename(target));
    if (!(target === root && !follow) && !inside(canonical)) fail('LOCAL_SCOPE', 'This link points outside your selected local folder. Choose that folder explicitly to browse it.');
    return { root, target: canonical };
  }
  async listLocal(request) {
    try {
      this.prune(); const { root, target } = await this.localPath(request); let cursor;
      if (request.cursor) { validateId(request.cursor); cursor = this.cursors.get(request.cursor); if (!cursor || cursor.owner !== request.rootId || cursor.path !== target || cursor.busy) fail('EXPIRED_LISTING', 'Refresh this local folder to restart the listing.'); this.cursors.delete(request.cursor); }
      else { if (this.cursors.size >= 20) fail('LISTING_LIMIT', 'Too many folders are loading. Refresh after a moment.'); const handle = await fs.opendir(target); cursor = { owner: request.rootId, path: target, handle, expires: Date.now() + 60000, close: async () => { await handle.close().catch(() => {}); } }; }
      cursor.busy = true; const entries = [];
      try {
        while (entries.length < PAGE_SIZE) {
          const child = await cursor.handle.read(); if (!child) { await cursor.close(); return { path: target, home: root, entries }; }
          const full = path.join(target, child.name);
          try { const stat = await fs.lstat(full); entries.push(entry(child.name, full, { mode: stat.mode, size: stat.size, mtime: stat.mtimeMs / 1000, uid: stat.uid, gid: stat.gid })); } catch { entries.push({ name: child.name, path: full, kind: 'other', size: 0, modified: 0, mode: 0 }); }
        }
        cursor.busy = false; cursor.expires = Date.now() + 60000; const token = randomUUID(); this.cursors.set(token, cursor); return { path: target, home: root, entries, nextCursor: token };
      } catch (error) { await cursor.close(); throw error; }
    } catch (error) { throw friendly(error); }
  }
  async localProperties(request) {
    try { const { target } = await this.localPath(request, false), stat = await fs.lstat(target); const item = entry(path.basename(target), target, { mode: stat.mode, size: stat.size, mtime: stat.mtimeMs / 1000, uid: stat.uid, gid: stat.gid }); if (item.kind === 'link') item.linkTarget = await fs.readlink(target); return item; } catch (error) { throw friendly(error); }
  }
  dispose() { for (const cursor of this.cursors.values()) void cursor.close(); this.cursors.clear(); this.plans.clear(); this.locals.clear(); }
}
module.exports = { Files, remotePath, fileName, friendly, call };
