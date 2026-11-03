import { useEffect, useState } from 'react';
import type { Session } from './connections';
import type { DeploymentPlan } from './projects';
import type { LocalWorkspace, Repository, WebsiteSetup, ReviewJob } from './development';
import type { SitePreview } from './workflows';
import SiteForm, { initialSite } from './SiteForm';
import GitHubPanel from './GitHubPanel';
import ReviewedJob from './ReviewedJob';
import NewSite from './NewSite';
import './development.css';
export default function AddWebsite({ session, onClose, onPlan }: {
    session: Session;
    onClose: () => void;
    onPlan: (p: DeploymentPlan) => void;
}) {
    const [legacy, setLegacy] = useState(false), [workspaces, setWorkspaces] = useState<LocalWorkspace[]>([]), [workspaceId, setWorkspace] = useState(''), [repos, setRepos] = useState<Repository[]>([]), [repo, setRepo] = useState(''), [branch, setBranch] = useState('main'), [setups, setSetups] = useState<WebsiteSetup[]>([]), [saved, setSaved] = useState<WebsiteSetup | null>(null), [site, setSite] = useState(initialSite()), [environment, setEnvironment] = useState<{
        key: string;
        value: string;
        remove?: boolean;
    }[]>([]), [database, setDatabase] = useState<WebsiteSetup['database']>({ engine: 'sqlite', file: 'db.sqlite3' }), [preview, setPreview] = useState<SitePreview | null>(null), [plan, setPlan] = useState<ReviewJob | null>(null), [trusted, setTrusted] = useState(false), [acceptDB, setAcceptDB] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
    const api = window.vps!.setups, q = { sessionId: session.id }, workspace = workspaces.find(w => w.id === workspaceId);
    async function refresh() { const [w, s] = await Promise.all([window.vps!.development.snapshot(), api.snapshot(q)]); if (w.ok)
        setWorkspaces(w.value);
    else
        setError(w.error.message); if (s.ok)
        setSetups(s.value);
    else
        setError(s.error.message); }
    useEffect(() => { void refresh(); }, [session.id]);
    async function run(fn: () => Promise<void>) { if (busy)
        return; setBusy(true); setError(''); try {
        await fn();
    }
    finally {
        setBusy(false);
    } }
    function changed() { setPreview(null); setTrusted(false); setAcceptDB(false); }
    async function detect(id: string) { changed(); setWorkspace(id); setSaved(null); if (!id)
        return; const r = await window.vps!.development.settings({ workspaceId: id }); if (r.ok) {
        const root = r.value.candidates.find(c => c.appDirectory === '');
        if (root && ['static', 'django', 'node', 'react'].includes(root.type)) {
            setSite(s => ({ ...s, kind: root.type as typeof s.kind, repository: 'git@github.com:' + r.value.repository + '.git', branch: r.value.branch, entry: root.entry || s.entry, output: root.output || '', build: root.build || false }));
            setNotice('Detected ' + root.type + '. Confirm the suggested settings before deployment.');
        }
        else
            setError('This repository has no supported application at its root. Nested or ambiguous layouts need an Advanced custom deployment recipe. No repository code was executed.');
    }
    else
        setError(r.error.message); }
    async function save() { const r = await api.save({ ...q, id: saved?.id, workspaceId, site, database: site.kind === 'django' ? database : null, changes: environment }); if (!r.ok) {
        setError(r.error.message);
        return null;
    } setSaved(r.value); setEnvironment([]); await refresh(); return r.value; }
    if (legacy)
        return <NewSite session={session} onClose={() => setLegacy(false)} onPlan={onPlan}/>;
    return <section className="development-panel" aria-label="Guided GitHub website setup"><div className="projects-heading"><div><h2>Add website</h2><p>Connect a repository, add your domain and review the setup.</p></div><button className="secondary-button" disabled={busy} onClick={onClose}>Back to websites</button></div>{error && <p className="form-error" role="alert">{error}</p>}{notice && <p className="dashboard-notice" role="status">{notice}</p>}
 <div inert={Boolean(plan)}><section className="dashboard-card"><h3>Resume saved setup</h3><select className="text-input" aria-label="Saved website setup" value={saved?.id || ''} onChange={e => { const s = setups.find(s => s.id === e.target.value); setSaved(s || null); if (s) {
        setWorkspace(s.workspaceId);
        setSite(s.site);
        setDatabase(s.database);
        setEnvironment([]);
        changed();
    } }}><option value="">New website…</option>{setups.map(s => <option key={s.id} value={s.id}>{s.site.name || 'Unnamed'} · {s.status}</option>)}</select>{saved?.jobId && <p>Saved job: <code>{saved.jobId}</code> · {saved.status}. Return to Websites → Background jobs to recover status or review migrations. {saved.registrationError}</p>}</section>
 {!saved?.jobId && <><GitHubPanel /><section className="dashboard-card"><h3>1. Choose repository</h3><div className="setup-buttons"><button className="secondary-button" disabled={busy} onClick={() => void run(async () => { const r = await window.vps!.github.repositories(); if (r.ok)
            setRepos(r.value.repositories);
        else
            setError(r.error.message); })}>Refresh GitHub repositories</button><select className="text-input" aria-label="New website GitHub repository" value={repo} onChange={e => { setRepo(e.target.value); setBranch(repos.find(r => r.id === Number(e.target.value))?.defaultBranch || 'main'); }}><option value="">Choose repository…</option>{repos.map(r => <option key={r.id} value={r.id}>{r.fullName}</option>)}</select><label>Branch<input className="text-input" aria-label="New website GitHub branch" value={branch} onChange={e => setBranch(e.target.value)}/></label><button className="primary-button" disabled={busy || !repo} onClick={() => void run(async () => { const r = await window.vps!.development.create({ repositoryId: Number(repo), branch }); if (r.ok) {
            await refresh();
            await detect(r.value.id);
        }
        else
            setError(r.error.message); })}>Use this repository</button></div><label className="field-label">Or use a prepared local workspace<select className="text-input" aria-label="Setup local workspace" value={workspaceId} onChange={e => void run(() => detect(e.target.value))}><option value="">Choose workspace…</option>{workspaces.map(w => <option key={w.id} value={w.id}>{w.repository} · {w.baseBranch}</option>)}</select></label></section>
 {workspace && <><section className="dashboard-card"><h3>2. Website settings</h3><p>{workspace.repository} · {workspace.baseBranch}. GitHub credentials stay on this computer.</p><SiteForm progressive repositoryManaged value={site} onChange={s => { setSite(s); changed(); }}/><p>Repository and branch come from the selected workspace. Projects in subfolders need a custom deployment script.</p></section><section className="dashboard-card"><h3>3. Environment variables</h3><p>Values are encrypted on this computer and hidden after saving.</p>{saved?.environment.map(v => <div key={v.key}><span>{v.key}: ••••••••</span><button className="secondary-button" onClick={() => { setEnvironment(all => [...all.filter(c => c.key !== v.key), { key: v.key, value: '', remove: true }]); changed(); }}>Remove saved {v.key}</button></div>)}{environment.map((e, i) => <div className="setup-buttons" key={i}><input className="text-input" aria-label={'Environment key ' + (i + 1)} placeholder="SECRET_KEY" value={e.key} onChange={v => { setEnvironment(all => all.map((a, j) => j === i ? { ...a, key: v.target.value } : a)); changed(); }}/><input className="text-input" type="password" autoComplete="off" aria-label={'Environment value ' + (i + 1)} placeholder="value" value={e.value} disabled={e.remove} onChange={v => { setEnvironment(all => all.map((a, j) => j === i ? { ...a, value: v.target.value } : a)); changed(); }}/><button className="secondary-button" onClick={() => { setEnvironment(all => all.filter((_, j) => j !== i)); changed(); }}>Discard entry</button></div>)}<button className="secondary-button" onClick={() => setEnvironment(all => [...all, { key: '', value: '' }])}>Add environment value</button>{site.kind === 'django' && <><h3>Database association</h3><select className="text-input" aria-label="New Django database engine" value={database?.engine || 'sqlite'} onChange={e => { setDatabase(e.target.value === 'sqlite' ? { engine: 'sqlite', file: 'db.sqlite3' } : { engine: 'postgres', database: '', username: '', port: 5432 }); changed(); }}><option value="sqlite">Create a new SQLite database in this new directory</option><option value="postgres">Use a reviewed existing local PostgreSQL database</option></select>{database?.engine === 'sqlite' ? <label>SQLite filename<input className="text-input" value={database.file} onChange={e => { setDatabase({ engine: 'sqlite', file: e.target.value }); changed(); }}/></label> : database?.engine === 'postgres' && (['database', 'username', 'port'] as const).map(k => <label key={k}>{k}<input className="text-input" value={database[k]} onChange={e => { setDatabase({ ...database, [k]: k === 'port' ? Number(e.target.value) : e.target.value }); changed(); }}/></label>)}<p>Django’s configured database must match this association. PostgreSQL database/user creation remains in Databases &amp; backups. A verified backup and a separate migration review are required before migrations run.</p></>}</section><div className="setup-buttons"><button className="secondary-button" disabled={busy} onClick={() => void run(async () => { if (await save())
            setNotice('Setup saved. Secret values stay masked when reopened.'); })}>Save setup for later</button><button className="primary-button" disabled={busy || session.status !== 'connected'} onClick={() => void run(async () => { const s = await save(); if (!s)
            return; const r = await api.inspect({ ...q, setupId: s.id }); if (r.ok) {
            setPreview(r.value);
            setNotice('Server checks finished. Review the requirements below.');
        }
        else
            setError(r.error.message); })}>Check setup</button></div></>}
 {preview && saved && <section className="dashboard-card"><h3>4. Server requirements</h3><p>{preview.directory} · {preview.systemd ? 'systemd ready' : 'systemd missing'} · {preview.portOccupied ? 'port occupied' : 'port available'}</p><p>Missing dependencies: {preview.missing.join(', ') || 'none'}</p>{preview.dns.map(d => <p key={d.domain}>{d.domain}: {d.matches ? 'points to VPS' : 'DNS setup needed for public access/HTTPS'}</p>)}{preview.missing.length > 0 && <button className="secondary-button" disabled={busy} onClick={() => void run(async () => { const r = await window.vps!.workflows.prepare({ ...q, operation: 'installDependencies', site, acceptScripts: true }); if (r.ok && r.value.job)
            onPlan(r.value.job);
        else if (!r.ok)
            setError(r.error.message); })}>Review required package installation</button>}<label className="credential-checkbox"><input type="checkbox" checked={trusted} onChange={e => setTrusted(e.target.checked)}/>I trust the selected repository and allow its dependency/build scripts as {session.profile.username}.</label>{site.kind === 'django' && <label className="credential-checkbox"><input type="checkbox" checked={acceptDB} onChange={e => setAcceptDB(e.target.checked)}/>I reviewed the exact database association and allow preparation of its backup and migration plan.</label>}<button className="primary-button" disabled={busy || !trusted || site.kind === 'django' && !acceptDB || preview.missing.length > 0 || !preview.systemd || preview.portOccupied} onClick={() => void run(async () => { const r = await api.prepare({ ...q, setupId: saved.id, acceptScripts: trusted, acceptDatabase: acceptDB }); if (r.ok)
            setPlan(r.value);
        else
            setError(r.error.message); })}>Review and deploy website</button></section>}</>}
 <details className="website-setup-advanced"><summary>Advanced: clone using a server SSH key</summary><p>Use the existing creation tool when the VPS already has repository access. It creates a workspace; hosting activation is a separate review.</p><button className="secondary-button" disabled={busy} onClick={() => setLegacy(true)}>Open advanced SSH setup</button></details></div>{busy && <p role="status">Working…</p>}{plan && <ReviewedJob plan={plan} setup onClose={() => setPlan(null)} onDone={() => { setPlan(null); setNotice('Durable deployment submitted. Follow Background jobs for progress and any migration review.'); void refresh(); }}/>}</section>;
}
