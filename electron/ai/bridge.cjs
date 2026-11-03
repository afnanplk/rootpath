const net = require('node:net'), fs = require('node:fs/promises'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PublicError } = require('../connection-store.cjs');
class AIBridge {
    constructor(service) { this.service = service; this.sockets = new Set(); this.active = 0; }
    async start() { const root = this.service.root; await fs.mkdir(root, { recursive: true, mode: 0o700 }); await fs.chmod(root, 0o700); this.address = process.platform === 'win32' ? '\\\\.\\pipe\\rootpath-ai-' + randomUUID() : path.join(this.runtime = await fs.mkdtemp('/tmp/rp-ai-'), 'socket'); if (process.platform !== 'win32' && Buffer.byteLength(this.address) > 100)
        throw Error('AI socket path exceeds OS limit.'); this.server = net.createServer(s => this.accept(s)); await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.address, resolve); }); if (process.platform !== 'win32')
        await fs.chmod(this.address, 0o600); await fs.writeFile(path.join(root, 'bridge.json'), JSON.stringify({ address: this.address, pid: process.pid }), { mode: 0o600 }); }
    accept(s) { if (this.sockets.size >= 16) {
        s.destroy();
        return;
    } this.sockets.add(s); s.setTimeout(30000, () => s.destroy()); let bytes = Buffer.alloc(0), handled = false; s.on('error', () => { }); s.on('close', () => this.sockets.delete(s)); s.on('data', chunk => { if (handled)
        return; bytes = Buffer.concat([bytes, chunk]); if (bytes.length > 4 * 1024 * 1024) {
        s.destroy();
        return;
    } const n = bytes.indexOf(10); if (n < 0)
        return; handled = true; if (this.active >= 8) {
        s.end(JSON.stringify({ error: 'Rootpath is busy. Try again.' }) + '\n');
        return;
    } this.active++; void (async () => { try {
        const q = JSON.parse(bytes.subarray(0, n).toString('utf8')), c = this.service.authenticate(q.id, q.secret);
        const value = q.method === 'ping' ? { connected: true, projects: c.grants.length } : await this.service.call(c, q.method, q.arguments);
        const result = JSON.stringify({ value });
        if (Buffer.byteLength(result) > 4 * 1024 * 1024)
            throw Error('response limit');
        s.end(result + '\n');
    }
    catch (e) {
        s.end(JSON.stringify({ error: e instanceof PublicError ? e.message : 'AI request failed. Review Rootpath Activity.' }) + '\n');
    }
    finally {
        this.active--;
    } })(); }); }
    async dispose() { for (const s of this.sockets)
        s.destroy(); if (this.server)
        await new Promise(r => this.server.close(r)); await fs.rm(path.join(this.service.root, 'bridge.json'), { force: true }); if (process.platform !== 'win32' && this.runtime)
        await fs.rm(this.runtime, { recursive: true, force: true }); }
}
module.exports = { AIBridge };
