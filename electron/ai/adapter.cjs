const { fail } = require('../connection-store.cjs');
const { digest } = require('./service.cjs');
const { filePath } = require('../development/workspaces.cjs');
const repository = p => String(p.repository || '').replace(/^git@github.com:/, '').replace(/^https:\/\/github.com\//, '').replace(/\.git$/, '').toLowerCase();
class AIAdapter {
    constructor(services) { Object.assign(this, services); }
    clean(v) { if (typeof v === 'string')
        return this.logStore.redactor.clean(v); if (Array.isArray(v))
        return v.map(x => this.clean(x)); if (v && typeof v === 'object')
        return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, this.clean(x)])); return v ?? null; }
    catalog() { return { projects: this.projects.data.projects.map(p => ({ id: p.id, name: p.name, serverId: p.serverId, fingerprint: p.fingerprint, repository: p.repository })), workspaces: this.development.snapshot().map(w => ({ id: w.id, repository: w.repository, branch: w.branch })) }; }
    matches(p, w) { return repository(p) === w.repository.toLowerCase(); }
    context(g) { const session = this.manager.snapshot().sessions.find(s => s.status === 'connected' && s.profile.id === g.serverId && s.fingerprint === g.fingerprint); if (!session)
        fail('AI_DISCONNECTED', 'Connect the granted server with its trusted fingerprint in Rootpath.'); const p = this.projects.get(session.id, g.projectId), w = g.workspaceId ? this.development.store.data.workspaces.find(w => w.id === g.workspaceId) : null; if (g.workspaceId && (!w || !this.matches(p, w) || w.accountId !== this.development.github.store.data.auth?.userId))
        fail('AI_SCOPE', 'The selected workspace mapping changed.'); return { sessionId: session.id, p, w, g }; }
    revision(x) { return digest([x.p.id, x.p.serverId, x.p.fingerprint, x.p.directory, x.p.device, x.p.inode, x.p.repository, x.p.branch, x.p.services, x.p.deploymentSettings, x.w?.id, x.w?.baseCommit]); }
    project(x, g) { const p = x.p; return { id: p.id, name: p.name, type: p.type, directory: p.directory, repository: p.repository, branch: p.branch, commit: p.commit, domains: p.domains, services: p.services, health: p.health, lastDeployment: p.lastDeployment, permissions: g.permissions, workspaceId: g.workspaceId }; }
    workspace(x) { if (!x.w)
        fail('WORKSPACE_REQUIRED', 'In Rootpath, associate a managed local workspace with this project’s AI grant.'); return x.w.id; }
    async files(x) { const s = await this.development.status({ workspaceId: this.workspace(x) }); return { branch: s.branch, head: s.head, dirty: s.dirty, files: s.files }; }
    async read(x, q) { filePath(q.path); return this.development.read({ workspaceId: this.workspace(x), path: q.path }); }
    async branches(x) { this.workspace(x); return this.development.github.branches({ repositoryId: x.w.repositoryId }); }
    async publications(x, q) { const w = await this.development.get(this.workspace(x)); if (q.publicationId) {
        const p = this.development.store.data.publications.find(p => p.workspaceId === w.id && p.id === q.publicationId);
        if (!p)
            fail('AI_SCOPE', 'Publication unavailable.');
        return this.development.refreshPublication({ workspaceId: w.id, publicationId: p.id });
    } return this.development.view(w).publications; }
    async cancel(r) { if (r.kind === 'job') {
        if (r.route === 'delivery')
            await this.delivery.cancel({ token: r.plan.token });
        else if (r.route === 'setups')
            await this.setups.cancel({ token: r.plan.token });
        else
            await this.jobService.cancelReview({ token: r.plan.token });
    }
    else if (r.kind === 'restart')
        this.monitoring.cancel({ token: r.plan.token }); }
    async metrics(x) { const metrics = await this.monitoring.metrics({ sessionId: x.sessionId }), storage = await this.projects.storage({ sessionId: x.sessionId }); return { serverMetrics: metrics, projectStorage: storage.projects.filter(p => p.directory === x.p.directory), note: 'Metrics include server-wide totals. Storage rows are limited to this project.' }; }
    async logs(x, q) { const v = await this.logStore.query({ serverId: x.p.serverId, project: x.p.name, source: 'jobs', limit: Math.min(100, Number.isSafeInteger(q.limit) ? Math.max(1, q.limit) : 50), ...(Number.isSafeInteger(q.beforeSeq) ? { beforeSeq: q.beforeSeq } : {}) }); return { events: v.events.map(e => ({ timestamp: e.timestamp, severity: e.severity, text: e.text, jobId: e.jobId })), hasMore: v.hasMore, nextBefore: v.nextBefore, note: 'Only already-collected, redacted deployment job logs for this project are shared.' }; }
    async jobs(x, q) { const rows = this.jobService.snapshot({ sessionId: x.sessionId }).filter(j => j.projectId === x.p.id && j.fingerprint === x.p.fingerprint); if (q.jobId && !rows.some(j => j.id === q.jobId))
        fail('AI_SCOPE', 'Job unavailable.'); if (q.jobId) {
        const j = await this.jobService.detail({ sessionId: x.sessionId, id: q.jobId });
        return this.jobView(j);
    } return rows.map(j => this.jobView(j)); }
    jobView(j) { return { id: j.id, action: j.action, status: j.status, message: j.message, startedAt: j.startedAt, finishedAt: j.finishedAt, targetCommit: j.targetCommit, backupVerified: j.backupVerified, pendingMigrations: j.pendingMigrations }; }
    async propose(x, q) {
        const kind = q.kind, base = { workspaceId: x.w?.id };
        let payload, summary;
        if (kind === 'code') {
            if (!x.g.permissions.includes('code'))
                fail('AI_SCOPE', 'Code access is required to propose code changes.');
            const p = await this.development.propose({ ...base, kind: q.change, path: q.path, to: q.to, revision: q.revision, content: q.content });
            payload = { proposalId: p.id };
            summary = { description: p.kind + ' ' + p.path, paths: [p.path, ...(p.to ? [p.to] : [])], confirmation: x.p.name };
        }
        else if (kind === 'publish') {
            this.workspace(x);
            if (typeof q.title !== 'string' || !q.title.trim() || q.title.length > 200 || typeof q.body !== 'string' || q.body.length > 20000)
                fail('INVALID_PUBLICATION', 'Supply a pull-request title and body.');
            payload = { ...base, title: q.title, body: q.body, workspaceRevision: await this.development.fingerprint(x.w) };
            summary = { description: 'Publish a branch and pull request to ' + x.w.repository, repository: x.w.repository, branch: x.w.branch, confirmation: x.w.repository };
        }
        else if (kind === 'create_website') {
            this.workspace(x);
            if (!x.g.permissions.includes('code'))
                fail('AI_SCOPE', 'Code access is required.');
            if (!q.site || typeof q.site !== 'object' || JSON.stringify(q.site).length > 8192)
                fail('INVALID_SITE', 'Supply bounded website settings without secrets.');
            const keys = ['name', 'kind', 'domains', 'port', 'entry', 'output', 'requirements', 'staticDir', 'runtimeBin', 'installMode', 'build', 'https'];
            const site = Object.fromEntries(keys.filter(k => q.site[k] !== undefined).map(k => [k, q.site[k]]));
            payload = { ...base, site };
            summary = { description: 'Create a new ' + site.kind + ' website under /var/www/' + site.name, confirmation: site.name };
            if (typeof site.name !== 'string' || !/^[a-z][a-z0-9-]{1,62}$/.test(site.name) || !['static', 'django', 'node', 'react'].includes(site.kind))
                fail('INVALID_SITE', 'Choose a safe website name and supported template.');
        }
        else if (kind === 'deploy') {
            this.workspace(x);
            payload = { ...base, publicationId: typeof q.publicationId === 'string' ? q.publicationId : undefined, settingsRevision: digest(x.p.deploymentSettings || {}) };
            summary = { description: 'Deploy the reviewed merged code to ' + x.p.name, confirmation: x.p.name };
        }
        else if (kind === 'restart') {
            if (typeof q.unit !== 'string' || !x.p.services.includes(q.unit))
                fail('AI_SCOPE', 'Choose a service mapped to this project.');
            payload = { unit: q.unit };
            summary = { description: 'Restart mapped service ' + q.unit, confirmation: x.p.name };
        }
        else if (kind === 'recover') {
            if (x.p.type !== 'static' || typeof q.recoveryId !== 'string')
                fail('RECOVERY_UNAVAILABLE', 'Only verified static code recovery is supported here.');
            const j = this.projects.data.jobs.find(j => j.id === q.recoveryId && j.projectId === x.p.id && j.serverId === x.p.serverId && j.fingerprint === x.p.fingerprint && j.backupVerified);
            if (!j)
                fail('RECOVERY_UNAVAILABLE', 'Select this project’s job with a verified recovery backup.');
            payload = { recoveryId: j.id };
            summary = { description: 'Recover previous static code from ' + j.id, confirmation: x.p.name };
        }
        else
            fail('UNSUPPORTED_PROPOSAL', 'Use code, publish, deploy, mapped restart or static recovery. New websites require create_website settings and a separately reviewed setup.');
        if (this.logStore.redactor.clean(JSON.stringify(payload)) !== JSON.stringify(payload))
            fail('SECRET_IN_PROPOSAL', 'Do not include credentials or secret values in AI proposals.');
        return { kind, payload, summary };
    }
    async review(x, p) {
        const q = { sessionId: x.sessionId, projectId: x.p.id }, v = p.payload;
        if (p.kind === 'code') {
            const d = await this.development.proposal(v);
            if (d.state !== 'proposed')
                fail('PROPOSAL_CLOSED', 'The code proposal was already handled.');
            return { kind: 'code', change: d, steps: ['Apply only this exact text diff to the managed local branch.', 'Publishing and deployment each require a separate review.'] };
        }
        if (p.kind === 'publish') {
            if (await this.development.fingerprint(x.w) !== v.workspaceRevision)
                fail('STALE_DIFF', 'Workspace changed after the proposal. Request a new proposal.');
            return { kind: 'publish', publication: await this.development.preparePublish(v) };
        }
        if (p.kind === 'create_website') {
            const setup = p.setupId ? this.setups.get({ sessionId: x.sessionId, setupId: p.setupId }).s : await this.setups.save({ sessionId: x.sessionId, workspaceId: v.workspaceId, site: v.site, changes: [], database: v.site.kind === 'django' ? { engine: 'sqlite', file: 'db.sqlite3' } : null });
            p.setupId = setup.id;
            return { kind: 'job', route: 'setups', plan: await this.setups.prepare({ sessionId: x.sessionId, setupId: setup.id, acceptScripts: true, acceptDatabase: true }) };
        }
        if (p.kind === 'deploy') {
            if (this.scripts.snapshot(q).binding)
                fail('CUSTOM_SCRIPT_UI_ONLY', 'This website uses a custom script. Review and run it from the website’s Advanced controls.');
            const settings = x.p.deploymentSettings || {};
            if (!settings.healthUrl)
                fail('DEPLOYMENT_SETUP_REQUIRED', 'Configure and review this website’s deployment settings in Rootpath first.');
            return { kind: 'job', route: 'delivery', plan: await this.delivery.prepare({ ...q, ...settings, workspaceId: v.workspaceId, publicationId: v.publicationId, action: x.p.type === 'static' ? 'static-deploy' : 'app-deploy', acceptScripts: true }) };
        }
        if (p.kind === 'recover')
            return { kind: 'job', route: 'jobs', plan: await this.jobService.prepare({ ...q, ...x.p.deploymentSettings, action: 'static-recover', recoveryId: v.recoveryId }) };
        if (p.kind === 'restart') {
            const fresh = await this.projects.discover(q), current = fresh.projects.find(p => p.directory === x.p.directory);
            if (!current || current.device !== x.p.device || current.inode !== x.p.inode || !current.services.includes(v.unit))
                fail('SERVICE_CHANGED', 'Rediscover and review changed service mappings.');
            return { kind: 'restart', plan: await this.monitoring.prepare({ sessionId: x.sessionId, action: 'restart', unit: v.unit, sudo: true }), steps: ['Restart only the displayed mapped service using existing account permissions.', 'Verify the resulting service state. This action is not a detached deployment job.'] };
        }
    }
    async execute(x, p, r, q) {
        const v = p.payload;
        if (p.kind === 'code')
            return this.development.approve(v);
        if (p.kind === 'publish') {
            if (await this.development.fingerprint(x.w) !== v.workspaceRevision)
                fail('STALE_DIFF', 'Workspace changed. Request a new publication proposal.');
            const w = await this.development.publish({ token: r.publication.token, confirmation: q.confirmation });
            return { workspaceId: w.id, publications: w.publications };
        }
        if (r.kind === 'job') {
            const result = await (r.route === 'delivery' ? this.delivery : r.route === 'setups' ? this.setups : this.jobService).perform({ token: r.plan.token, confirmationName: q.confirmation, password: q.password });
            return this.jobView(result);
        }
        if (p.kind === 'restart') {
            if (r.plan.expiresAt < Date.now())
                fail('REVIEW_EXPIRED', 'Review the service restart again.');
            const record = this.projects.record({ sessionId: x.sessionId });
            const source = require('node:fs').readFileSync(require('node:path').join(__dirname, 'restart.py'), 'utf8');
            return require('../jobs/sudo.cjs').privilegedJSON(record, source, { unit: v.unit, username: record.session.profile.username, directory: x.p.directory, device: x.p.device, inode: x.p.inode, state: r.plan.state }, q.password, { sourceStdin: true, timeout: 60000 });
        }
    }
    audit(c, x, text) { this.logStore.add({ source: 'ai', serverId: x?.p.serverId, project: x?.p.name, action: 'ai-review', text: c.name + ' (' + c.id + '): ' + text }); }
}
module.exports = { AIAdapter };
