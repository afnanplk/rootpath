const fs = require('node:fs/promises'), path = require('node:path');
const { randomUUID, randomBytes, createHash, timingSafeEqual } = require('node:crypto');
const { SecureState } = require('../secure-state.cjs');
const { fail } = require('../connection-store.cjs');
const digest = v => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
const permissions = ['code', 'metrics', 'logs', 'propose'];
class AIService {
    constructor(root, vault, adapter) { Object.assign(this, { root, adapter }); this.store = new SecureState(path.join(root, 'connections.private'), vault, { version: 1, paused: false, clients: [], proposals: [], approvals: [] }); this.reviews = new Map(); this.busy = new Set(); this.epoch = 0; }
    async init() { await this.store.init(); if (this.store.data.version !== 1)
        fail('AI_STORE', 'Unsupported AI settings.'); for (const p of this.store.data.proposals)
        if (p.state === 'executing')
            p.state = 'needs-attention'; await this.store.persist(); }
    snapshot() { return { paused: this.store.data.paused, clients: this.store.data.clients.map(({ credentialHash, ...c }) => c), proposals: this.store.data.proposals.map(p => this.view(p)), catalog: this.adapter.catalog(), compatibility: { protocol: '2025-11-25 stdio', clients: 'Codex, Claude and Antigravity configurations supplied; live client acceptance pending' } }; }
    view(p) { return { id: p.id, clientId: p.clientId, client: p.client, projectId: p.projectId, workspaceId: p.workspaceId, kind: p.kind, state: p.state, createdAt: p.createdAt, expiresAt: p.expiresAt, summary: p.summary, result: p.result }; }
    async create(q) { if (!q || !['codex', 'claude', 'antigravity', 'other'].includes(q.kind) || typeof q.name !== 'string' || !q.name.trim() || q.name.length > 80)
        fail('INVALID_CLIENT', 'Choose and name an AI client.'); if (this.store.data.clients.filter(c => !c.revoked).length >= 32)
        fail('CLIENT_LIMIT', 'Revoke an unused AI connection first.'); const id = randomUUID(), secret = randomBytes(32).toString('hex'); const c = { id, name: q.name.trim(), kind: q.kind, credentialHash: digest(secret), grants: [], createdAt: new Date().toISOString(), revoked: false }; await fs.mkdir(path.join(this.root, 'clients'), { recursive: true, mode: 0o700 }); await fs.writeFile(path.join(this.root, 'clients', id + '.json'), JSON.stringify({ id, secret, discovery: path.join(this.root, 'bridge.json') }), { flag: 'wx', mode: 0o600 }); this.store.data.clients.push(c); await this.store.persist(); return { id }; }
    authenticate(id, secret) { const c = this.store.data.clients.find(c => c.id === id); const value = digest(typeof secret === 'string' ? secret : ''); if (!c || !timingSafeEqual(Buffer.from(value), Buffer.from(c.credentialHash)) || c.revoked || this.store.data.paused)
        fail('AI_DENIED', 'AI access is paused, revoked or unauthenticated.'); return c; }
    client(id) { const c = this.store.data.clients.find(c => c.id === id); if (!c || c.revoked || this.store.data.paused)
        fail('AI_DENIED', 'AI access is paused or revoked.'); return c; }
    async grant(q) { const c = this.store.data.clients.find(c => c.id === q?.clientId && !c.revoked); if (!c || q.consent !== true || !Array.isArray(q.grants) || q.grants.length > 100)
        fail('CONSENT_REQUIRED', 'Review project access and provider disclosure.'); const catalog = this.adapter.catalog(), grants = []; for (const g of q.grants) {
        const p = catalog.projects.find(p => p.id === g.projectId && p.serverId === g.serverId && p.fingerprint === g.fingerprint);
        if (!p || !Array.isArray(g.permissions) || g.permissions.some(v => !permissions.includes(v)))
            fail('INVALID_GRANT', 'Choose a verified project and supported permissions.');
        const w = g.workspaceId ? catalog.workspaces.find(w => w.id === g.workspaceId && this.adapter.matches(p, w)) : null;
        if (g.workspaceId && !w)
            fail('INVALID_GRANT', 'Workspace repository must match the selected website.');
        grants.push({ projectId: p.id, serverId: p.serverId, fingerprint: p.fingerprint, workspaceId: w?.id || null, permissions: [...new Set(g.permissions)] });
    } c.grants = grants; c.consentedAt = new Date().toISOString(); this.epoch++; this.reviews.clear(); await this.store.persist(); this.adapter.audit(c, null, 'Project grants updated'); return { saved: true }; }
    async control(q) { if (q?.action === 'pause')
        this.store.data.paused = q.paused !== false;
    else if (q?.action === 'revoke' || q?.action === 'all') {
        for (const c of this.store.data.clients)
            if (q.action === 'all' || c.id === q.clientId) {
                c.revoked = true;
                c.grants = [];
                await fs.rm(path.join(this.root, 'clients', c.id + '.json'), { force: true });
            }
    }
    else
        fail('INVALID_ACTION', 'Choose pause or revoke.'); this.epoch++; this.reviews.clear(); await this.store.persist(); return { saved: true }; }
    scope(c, q, permission) { this.client(c.id); const g = c.grants.find(g => g.projectId === q?.projectId); if (!g || permission && !g.permissions.includes(permission))
        fail('AI_SCOPE', 'This project or capability has not been granted.'); const x = this.adapter.context(g); if (q.workspaceId && q.workspaceId !== g.workspaceId)
        fail('AI_SCOPE', 'This workspace has not been granted.'); return { ...x, g }; }
    async call(c, name, q = {}) {
        this.client(c.id);
        if (!q || typeof q !== 'object' || Array.isArray(q) || Buffer.byteLength(JSON.stringify(q)) > 3 * 1024 * 1024)
            fail('INVALID_INPUT', 'Invalid bounded tool arguments.');
        const epoch = this.epoch;
        let value;
        if (name === 'rootpath_projects')
            value = c.grants.map(g => { try {
                const x = this.scope(c, { projectId: g.projectId });
                return this.adapter.project(x, g);
            }
            catch {
                return { id: g.projectId, status: 'Reconnect or review changed host identity' };
            } });
        else if (name === 'rootpath_proposal_status') {
            const p = this.store.data.proposals.find(p => p.id === q.proposalId && p.clientId === c.id);
            if (!p)
                fail('AI_SCOPE', 'Proposal unavailable.');
            this.scope(c, p, 'propose');
            value = this.view(p);
        }
        else {
            const permission = ['rootpath_files', 'rootpath_read_file', 'rootpath_branches', 'rootpath_publications'].includes(name) ? 'code' : name === 'rootpath_metrics' ? 'metrics' : name === 'rootpath_logs' ? 'logs' : name === 'rootpath_jobs' ? null : 'propose';
            const x = this.scope(c, q, permission);
            if (name === 'rootpath_files')
                value = await this.adapter.files(x);
            else if (name === 'rootpath_read_file')
                value = await this.adapter.read(x, q);
            else if (name === 'rootpath_branches')
                value = await this.adapter.branches(x);
            else if (name === 'rootpath_publications')
                value = await this.adapter.publications(x, q);
            else if (name === 'rootpath_metrics')
                value = await this.adapter.metrics(x);
            else if (name === 'rootpath_logs')
                value = await this.adapter.logs(x, q);
            else if (name === 'rootpath_jobs')
                value = await this.adapter.jobs(x, q);
            else if (name === 'rootpath_propose') {
                if (this.store.data.proposals.filter(p => p.clientId === c.id && p.state === 'pending').length >= 32)
                    fail('PROPOSAL_LIMIT', 'Review pending proposals first.');
                const prepared = await this.adapter.propose(x, q);
                this.scope(c, q, 'propose');
                if (epoch !== this.epoch)
                    fail('AI_SCOPE', 'Access changed during preparation.');
                const p = { id: randomUUID(), clientId: c.id, client: c.name, projectId: x.g.projectId, workspaceId: x.g.workspaceId, grantDigest: digest(x.g), target: this.adapter.revision(x), kind: prepared.kind, payload: prepared.payload, summary: prepared.summary, state: 'pending', createdAt: new Date().toISOString(), expiresAt: Date.now() + 30 * 60000 };
                p.revision = digest([p.payload, p.target, p.grantDigest]);
                this.store.data.proposals.push(p);
                await this.store.persist();
                this.adapter.audit(c, x, 'Proposal ' + p.id + ' prepared: ' + p.kind);
                value = this.view(p);
            }
            else
                fail('UNKNOWN_TOOL', 'Unsupported Rootpath tool.');
        }
        this.client(c.id);
        if (epoch !== this.epoch)
            fail('AI_SCOPE', 'Access changed during this request.');
        return this.adapter.clean(value);
    }
    async review(q) { for (const [t, r] of this.reviews)
        if (r.expiresAt < Date.now())
            this.reviews.delete(t); if (this.reviews.size >= 64)
        fail('REVIEW_LIMIT', 'Close or wait for existing reviews to expire.'); const p = this.store.data.proposals.find(p => p.id === q?.proposalId); if (!p || p.state !== 'pending' || p.expiresAt < Date.now())
        fail('PROPOSAL_EXPIRED', 'Prepare a new AI proposal.'); const c = this.client(p.clientId), x = this.scope(c, p, 'propose'); if (digest(x.g) !== p.grantDigest || this.adapter.revision(x) !== p.target)
        fail('STALE_PROPOSAL', 'Project, workspace or permission settings changed. Request a new proposal.'); for (const [t, r] of this.reviews)
        if (r.proposalId === p.id) {
            this.reviews.delete(t);
            await this.adapter.cancel?.(r.preview);
        } const preview = await this.adapter.review(x, p); await this.store.persist(); const token = randomUUID(); this.reviews.set(token, { proposalId: p.id, preview, epoch: this.epoch, expiresAt: Date.now() + 120000 }); return { token, proposal: this.view(p), preview, expiresAt: Date.now() + 120000 }; }
    async cancelReview(q) { const r = this.reviews.get(q?.token); this.reviews.delete(q?.token); if (r)
        await this.adapter.cancel?.(r.preview); return { cancelled: true }; }
    async reject(q) { const p = this.store.data.proposals.find(p => p.id === q?.proposalId); if (!p || p.state !== 'pending')
        fail('PROPOSAL_CLOSED', 'This proposal is already closed.'); p.state = 'rejected'; await this.store.persist(); return { rejected: true }; }
    async approve(q) { const r = this.reviews.get(q?.token), p = this.store.data.proposals.find(p => p.id === r?.proposalId); if (!r || !p || p.state !== 'pending' || r.expiresAt < Date.now() || r.epoch !== this.epoch)
        fail('REVIEW_EXPIRED', 'Review this proposal again.'); if (this.busy.has(p.id))
        fail('PROPOSAL_BUSY', 'This proposal is already executing.'); const c = this.client(p.clientId), x = this.scope(c, p, 'propose'); if (p.revision !== digest([p.payload, p.target, p.grantDigest]) || p.expiresAt < Date.now() || digest(x.g) !== p.grantDigest || this.adapter.revision(x) !== p.target)
        fail('STALE_PROPOSAL', 'Target changed. Prepare a new proposal.'); if (q.confirmation !== p.summary.confirmation)
        fail('CONFIRMATION_REQUIRED', 'Type the displayed confirmation exactly.'); this.busy.add(p.id); p.state = 'executing'; this.store.data.approvals.push({ id: randomUUID(), proposalId: p.id, revision: p.revision, clientId: c.id, approvedAt: new Date().toISOString() }); try {
        await this.store.persist();
        const result = await this.adapter.execute(x, p, r.preview, q);
        p.state = 'submitted';
        p.result = this.adapter.clean(result);
        this.reviews.delete(q.token);
        this.adapter.audit(c, x, 'Approved proposal ' + p.id + ' submitted');
        await this.store.persist();
        return this.view(p);
    }
    catch (e) {
        if (['SUDO_PASSWORD_REQUIRED', 'SUDO_DENIED', 'CONFIRMATION_REQUIRED'].includes(e.code))
            p.state = 'pending';
        else {
            p.state = 'needs-attention';
            this.reviews.delete(q.token);
        }
        await this.store.persist();
        throw e;
    }
    finally {
        this.busy.delete(p.id);
    } }
    async dispose() { this.epoch++; this.reviews.clear(); await this.store.queue.catch(() => { }); }
}
module.exports = { AIService, digest };
