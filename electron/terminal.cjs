const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { object, validateId, fail, PublicError } = require('./connection-store.cjs');
const { remotePath, call } = require('./files.cjs');
const { StringDecoder } = require('node:string_decoder');
const quote = value => "'" + value.replace(/'/g, "'\"'\"'") + "'";
class Terminals extends EventEmitter {
  constructor(files) { super(); this.files = files; this.tabs = new Map(); this.opening = 0; }
  tab(input) { object(input); validateId(input.id); const tab = this.tabs.get(input.id); if (!tab || tab.closed) fail('TERMINAL_CLOSED', 'This terminal is closed. Open a new terminal or reconnect it.'); this.files.record(tab.sessionId); return tab; }
  dimensions(input) { if (!Number.isInteger(input.cols) || input.cols < 2 || input.cols > 500 || !Number.isInteger(input.rows) || input.rows < 1 || input.rows > 300) fail('INVALID_INPUT', 'Invalid terminal dimensions.'); }
  async open(input) {
    if (this.tabs.size + this.opening >= 8) fail('TERMINAL_LIMIT', 'Close a terminal tab before opening another (8 tab limit).');
    this.opening++; try { return await this.openInternal(input); } finally { this.opening--; }
  }
  async openInternal(input) {
    object(input); validateId(input.sessionId); this.dimensions(input);
    if (this.tabs.size >= 8) fail('TERMINAL_LIMIT', 'Close a terminal tab before opening another (8 tab limit).');
    const record = this.files.record(input.sessionId), sftp = await this.files.channel(input.sessionId);
    const cwd = await call(sftp, 'realpath', input.path === '~' ? '.' : remotePath(input.path));
    const attrs = await call(sftp, 'stat', cwd); if ((attrs.mode & 0o170000) !== 0o040000) fail('INVALID_PATH', 'Open a terminal in a folder.');
    const tab = { id: randomUUID(), sessionId: input.sessionId, cwd, closed: false, unacked: 0, channel: null };
    this.tabs.set(tab.id, tab);
    try {
      // Only this controlled script is executed. Paths are quoted as one POSIX argument.
      const script = 'cd -- ' + quote(cwd) + ' && exec "${SHELL:-/bin/sh}" -i';
      const command = '/bin/sh -c ' + quote(script);
      tab.channel = await new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => { settled = true; reject(new PublicError('TERMINAL_TIMEOUT', 'The server did not open a terminal in time.')); }, 20000);
        record.client.exec(command, { pty: { term: 'xterm-256color', cols: input.cols, rows: input.rows } }, (error, channel) => {
          if (settled) { channel?.close(); return; } settled = true; clearTimeout(timer); error ? reject(new PublicError('TERMINAL_UNAVAILABLE', 'The server refused a terminal. Check SSH shell and PTY access.')) : resolve(channel);
        });
      });
      const decoder = new StringDecoder('utf8');
      const output = chunk => { const data = decoder.write(chunk); if (!data) return; tab.unacked += Buffer.byteLength(data); this.emit('event', { id: tab.id, type: 'data', data }); if (tab.unacked > 131072) tab.channel.pause(); };
      tab.channel.on('data', output); tab.channel.stderr.on('data', output);
      tab.channel.on('error', () => {});
      tab.channel.once('close', () => { tab.closed = true; this.emit('event', { id: tab.id, type: 'closed', data: 'Terminal closed. Reconnect explicitly; commands are never replayed.' }); });
      return { id: tab.id, cwd };
    } catch (error) { this.tabs.delete(tab.id); throw error; }
  }
  write(input) { const tab = this.tab(input); if (typeof input.data !== 'string' || Buffer.byteLength(input.data) > 65536) fail('INVALID_INPUT', 'Terminal input exceeds the limit.'); tab.channel.write(input.data); }
  resize(input) { const tab = this.tab(input); this.dimensions(input); tab.channel.setWindow(input.rows, input.cols, 0, 0); }
  ack(input) { object(input); const tab = this.tabs.get(input.id); if (!tab || tab.closed) return; if (!Number.isInteger(input.bytes) || input.bytes < 0 || input.bytes > 1048576) fail('INVALID_INPUT', 'Invalid output acknowledgement.'); tab.unacked = Math.max(0, tab.unacked - input.bytes); if (tab.unacked < 65536) tab.channel.resume(); }
  close(input) { object(input); validateId(input.id); const tab = this.tabs.get(input.id); if (tab) { tab.closed = true; tab.channel?.close(); this.tabs.delete(input.id); } }
  dispose() { for (const id of this.tabs.keys()) this.close({ id }); }
}
module.exports = { Terminals, quote };
