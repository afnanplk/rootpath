const { randomUUID, createHash } = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const path = require('node:path').posix;
const { fail, object, validateId } = require('./connection-store.cjs');
const { remotePath, call } = require('./files.cjs');
const MAX = 2 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
class Editor {
  constructor(files) { this.files = files; this.docs = new Map(); this.opening = new Map(); }
  view(doc) { return { id: doc.id, sessionId: doc.sessionId, path: doc.path, text: doc.text, revision: doc.revision, bom: doc.bom, eol: doc.eol, backups: doc.backups.map(b => ({ id: b.id, path: b.path })) }; }
  document(input) { object(input); validateId(input.id); const doc = this.docs.get(input.id); if (!doc) fail('DOCUMENT_CLOSED', 'This editor tab has been closed.'); this.files.record(doc.sessionId); return doc; }
  async read(channel, target) {
    await this.files.canonicalParent(channel, target);
    const before = await call(channel, 'lstat', target);
    if ((before.mode & 0o170000) !== 0o100000) fail('DOWNLOAD_INSTEAD', 'Only regular text files can be edited. Inspect symbolic links or download this item instead.');
    if (before.size > MAX) fail('DOWNLOAD_INSTEAD', 'This file exceeds the 2 MiB editor limit. Use Download selected instead.');
    const chunks = []; let size = 0;
    // Bounded streaming also catches files that grow after the metadata check.
    const stream = channel.createReadStream(target, { highWaterMark: 65536 });
    const timeout = setTimeout(() => stream.destroy(new Error('timeout')), 20000);
    try { for await (const chunk of stream) { size += chunk.length; if (size > MAX) { stream.destroy(); fail('DOWNLOAD_INSTEAD', 'This file grew beyond the 2 MiB editor limit. Download it instead.'); } chunks.push(chunk); } } finally { clearTimeout(timeout); }
    const bytes = Buffer.concat(chunks), after = await call(channel, 'lstat', target);
    if (before.size !== after.size || before.mtime !== after.mtime || before.mode !== after.mode || bytes.length !== after.size) fail('FILE_CHANGED', 'The file changed while being read. Try opening it again.');
    let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('DOWNLOAD_INSTEAD', 'This file is binary or is not UTF-8 text. Download it instead.'); }
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) fail('DOWNLOAD_INSTEAD', 'This file contains binary data. Download it instead.');
    return { bytes, text, attrs: after, revision: hash(bytes), bom: bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191])), eol: text.includes('\r\n') ? 'CRLF' : 'LF' };
  }
  async open(input) {
    object(input); validateId(input.sessionId); const target = remotePath(input.path), key = input.sessionId + ':' + target;
    const existing = [...this.docs.values()].find(d => d.sessionId === input.sessionId && d.path === target);
    if (existing) { this.files.record(input.sessionId); return this.view(existing); }
    if (this.opening.has(key)) return this.opening.get(key);
    if (this.docs.size + this.opening.size >= 16) fail('EDITOR_LIMIT', 'Close an editor tab before opening another (16 tab limit).');
    const pending = this.openInternal({ sessionId: input.sessionId, path: target }); this.opening.set(key, pending);
    try { return await pending; } finally { this.opening.delete(key); }
  }
  async openInternal(input) {
    object(input); validateId(input.sessionId); const target = remotePath(input.path);
    const existing = [...this.docs.values()].find(d => d.sessionId === input.sessionId && d.path === target);
    if (existing) return this.view(existing);
    if (this.docs.size >= 16) fail('EDITOR_LIMIT', 'Close an editor tab before opening another (16 tab limit).');
    const result = await this.read(await this.files.channel(input.sessionId), target);
    const doc = { id: randomUUID(), sessionId: input.sessionId, path: target, text: result.text, revision: result.revision, bom: result.bom, eol: result.eol, dirty: false, backups: [] };
    this.docs.set(doc.id, doc); return this.view(doc);
  }
  async reload(input) { const doc = this.document(input), result = await this.read(await this.files.channel(doc.sessionId), doc.path); Object.assign(doc, { text: result.text, revision: result.revision, bom: result.bom, eol: result.eol, dirty: false }); return this.view(doc); }
  dirty(input) { object(input); validateId(input.id); const doc = this.docs.get(input.id); if (!doc || typeof input.dirty !== 'boolean') fail('INVALID_INPUT', 'Invalid editor state.'); doc.dirty = input.dirty; }
  close(input) { object(input); validateId(input.id); this.docs.delete(input.id); }
  hasDirty() { return [...this.docs.values()].some(d => d.dirty); }
  async save(input) {
    const doc = this.document(input);
    if (typeof input.text !== 'string' || Buffer.byteLength(input.text) > MAX - 3 || typeof input.revision !== 'string') fail('INVALID_INPUT', 'Save UTF-8 text up to 2 MiB.');
    return this.files.exclusive(doc.sessionId, async () => {
      const channel = await this.files.channel(doc.sessionId), current = await this.read(channel, doc.path);
      if (current.revision !== input.revision || doc.revision !== input.revision) fail('EDITOR_CONFLICT', 'The remote file changed. Your draft is kept. Copy your draft, then reload the remote version before saving again.');
      const bytes = Buffer.from((doc.bom ? '\ufeff' : '') + input.text, 'utf8');
      const stage = path.join(path.dirname(doc.path), '.vps-explorer-' + randomUUID() + '.part');
      const backup = path.join(path.dirname(doc.path), '.vps-explorer-' + randomUUID() + '.bak');
      let staged = false, moved = false, committed = false;
      try {
        staged = true;
        await pipeline(Readable.from([bytes]), channel.createWriteStream(stage, { flags: 'wx', mode: 0o600 }));
        await call(channel, 'chmod', stage, current.attrs.mode & 0o777);
        const latest = await this.read(channel, doc.path);
        if (latest.revision !== current.revision || latest.attrs.mode !== current.attrs.mode) fail('EDITOR_CONFLICT', 'The remote file changed during save. Your draft is kept; reload before trying again.');
        await this.files.canonicalParent(channel, doc.path);
        await call(channel, 'rename', doc.path, backup); moved = true;
        await call(channel, 'rename', stage, doc.path); committed = true;
        doc.backups.unshift({ id: randomUUID(), path: backup }); doc.backups = doc.backups.slice(0, 20);
        Object.assign(doc, { text: input.text, revision: hash(bytes), dirty: false }); return this.view(doc);
      } catch (error) {
        if (moved && !committed) {
          try { await call(channel, 'rename', backup, doc.path); } catch { fail('RECOVERY_NEEDED', 'Save could not finish or roll back. The previous file is preserved at ' + backup + '. Reconnect and inspect it before retrying.'); }
        }
        throw error;
      } finally { if (staged && !committed) { try { await call(channel, 'unlink', stage); } catch { /* A disconnect may leave a hidden .part file for manual cleanup. */ } } }
    });
  }
  async restore(input) {
    const doc = this.document(input), backup = doc.backups.find(b => b.id === input.backupId);
    if (!backup) fail('BACKUP_UNAVAILABLE', 'This backup is not available in the current editor session.');
    const data = await this.read(await this.files.channel(doc.sessionId), backup.path);
    return this.save({ id: doc.id, text: data.text, revision: input.revision });
  }
}
module.exports = { Editor, MAX };
