import ScriptsPanel from './ScriptsPanel';
import WebsiteCatalog from './WebsiteCatalog';
import NewSite from './AddWebsite';
import ProjectTools from './ProjectTools';
import { useEffect, useRef, useState } from 'react';
import type { Session } from './connections';
import type { Project, Inventory, ImportPlan, DeploymentPlan, Job, GitPreview, StaticAction } from './projects';
import './projects.css';
import ApplicationReview from './ApplicationReview';
import Preview from './GitPreview';
export default function ProjectsPanel({ session, onFiles }: {
    session: Session;
    onFiles: (path: string) => void;
}) {
    const [scriptProject, setScriptProject] = useState<Project | null>(null);
    const [newSite, setNewSite] = useState(false), [tools, setTools] = useState<Project | null | undefined>(undefined);
    const api = window.vps!.projects, jobsAPI = window.vps!.jobs, [projects, setProjects] = useState<Project[]>([]), [inventory, setInventory] = useState<Inventory | null>(null), [jobs, setJobs] = useState<Job[]>([]), [review, setReview] = useState<ImportPlan | null>(null), [plan, setPlan] = useState<DeploymentPlan | null>(null), [name, setName] = useState(''), [accepted, setAccepted] = useState(false), [password, setPassword] = useState(''), [needsPassword, setNeedsPassword] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [staticProject, setStaticProject] = useState<Project | null>(null), [applicationProject, setApplicationProject] = useState<Project | null>(null);
    const alive = useRef(true), dialog = useRef<HTMLDivElement>(null), latest = useRef({ review, plan });
    latest.current = { review, plan };
    const connected = session.status === 'connected';
    async function load() { const a = await api.snapshot({ sessionId: session.id }), b = await jobsAPI.snapshot({ sessionId: session.id }); if (!alive.current)
        return; if (a.ok)
        setProjects(a.value); if (b.ok)
        setJobs(b.value); }
    useEffect(() => { alive.current = true; void load(); const t = setInterval(() => void load(), 3000); return () => { alive.current = false; clearInterval(t); if (latest.current.review)
        void api.cancel({ token: latest.current.review.token }); if (latest.current.plan)
        void jobsAPI.cancelReview({ token: latest.current.plan.token }); }; }, [session.id]);
    useEffect(() => { if (!review && !plan)
        return; const previous = document.activeElement as HTMLElement; dialog.current?.focus(); const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) {
        e.preventDefault();
        void closeReview();
    } if (e.key === 'Tab') {
        const nodes = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)');
        if (!nodes?.length)
            return;
        const a = nodes[0], z = nodes[nodes.length - 1];
        if (e.shiftKey && (document.activeElement === a || document.activeElement === dialog.current)) {
            e.preventDefault();
            z.focus();
        }
        else if (!e.shiftKey && document.activeElement === z) {
            e.preventDefault();
            a.focus();
        }
    } }; document.addEventListener('keydown', key); return () => { document.removeEventListener('keydown', key); previous?.focus(); }; }, [review?.token, plan?.token, busy]);
    async function discover() { setBusy(true); setError(''); const r = await api.discover({ sessionId: session.id }); setBusy(false); if (!alive.current)
        return; if (r.ok)
        setInventory(r.value);
    else
        setError(r.error.message); }
    useEffect(() => { if (connected)
        void discover(); }, [session.id, connected]);
    async function importReview(p: Project) { setBusy(true); setError(''); const r = await api.prepare({ sessionId: session.id, candidateId: p.candidateId! }); setBusy(false); if (r.ok) {
        setReview(r.value);
        setName('');
        setAccepted(false);
    }
    else
        setError(r.error.message); }
    async function closeReview() { if (busy)
        return; if (review)
        await api.cancel({ token: review.token }); if (plan)
        await jobsAPI.cancelReview({ token: plan.token }); setReview(null); setPlan(null); setPassword(''); setNeedsPassword(false); setError(''); void load(); }
    async function importProject() { if (!review)
        return; setBusy(true); setError(''); const r = await api.import({ token: review.token, confirmationName: name, acceptMappings: accepted }); setBusy(false); if (r.ok) {
        setReview(null);
        setNotice('Website settings saved. Server files were not changed. Review any remaining setup before deploying.');
        setProjects(old => [...old.filter(p => p.id !== r.value.id), r.value]);
        void load();
    }
    else
        setError(r.error.message); }
    async function prepare(projectId: string, job?: Job) { setBusy(true); setError(''); const r = await jobsAPI.prepare({ sessionId: session.id, projectId, id: job?.id, action: job ? 'cancel' : 'connection-check' }); setBusy(false); if (r.ok) {
        setPlan(r.value);
        setPassword('');
        setNeedsPassword(false);
    }
    else
        setError(r.error.message); }
    async function migrationReview(j: Job) { setBusy(true); setError(''); const r = await jobsAPI.prepare({ sessionId: session.id, id: j.id, action: 'approve-migrations' }); setBusy(false); if (r.ok) {
        setPlan(r.value);
        setName('');
        setPassword('');
        setNeedsPassword(false);
    }
    else
        setError(r.error.message); }
    async function perform() { if (!plan)
        return; setBusy(true); setError(''); const secret = password; setPassword(''); const r = await jobsAPI.perform({ token: plan.token, confirmationName: name, ...(needsPassword ? { password: secret } : {}) }); setBusy(false); if (r.ok) {
        setNotice(plan.action === 'cancel' ? 'Cancellation status recovered. No rollback is implied.' : 'Job accepted. You may close Rootpath; reconnect to recover its status.');
        setPlan(null);
        setNeedsPassword(false);
        void load();
    }
    else {
        if (['SUDO_PASSWORD_REQUIRED', 'SUDO_DENIED'].includes(r.error.code))
            setNeedsPassword(true);
        else {
            setPlan(null);
            setNeedsPassword(false);
        }
        setError(r.error.message);
        void load();
    } }
    function logs(jobId?: string) { window.dispatchEvent(new CustomEvent('rootpath:logs-open', { detail: { jobId } })); }
    const modal = Boolean(review || plan || staticProject || applicationProject);
    async function updateWebsite(p: Project) { const r = await window.vps!.scripts.snapshot({ sessionId: session.id, projectId: p.id }); if (r.ok && r.value.binding) {
        setScriptProject(p);
        return;
    } if (!r.ok) {
        setError(r.error.message);
        return;
    } p.type === 'static' ? setStaticProject(p) : setApplicationProject(p); }
    if (scriptProject)
        return <ScriptsPanel session={session} project={scriptProject} onClose={() => setScriptProject(null)}/>;
    if (newSite)
        return <NewSite session={session} onClose={() => setNewSite(false)} onPlan={p => { setNewSite(false); setPlan(p); setName(''); setNeedsPassword(false); setPassword(''); }}/>;
    if (tools !== undefined)
        return <ProjectTools session={session} project={tools} onClose={() => { setTools(undefined); void load(); }}/>;
    return <section className="projects-panel" aria-label="Websites workspace"><div inert={modal}><WebsiteCatalog projects={projects} inventory={inventory} jobs={jobs} busy={busy} connected={connected} onAdd={() => setNewSite(true)} onDiscover={() => void discover()} onReview={p => void importReview(p)} onFiles={onFiles} onTools={setTools} onUpdate={p => void updateWebsite(p)} onScripts={setScriptProject} onRecovery={p => p.type === 'static' ? setStaticProject(p) : setApplicationProject(p)} onCheck={id => void prepare(id)} onMigration={job => void migrationReview(job)} onLogs={p => window.dispatchEvent(new CustomEvent('rootpath:logs-open', { detail: { project: p.name, serverId: session.profile.id } }))}/>{!connected && <p className="connection-warning">Disconnected. Reconnect before making changes. Saved job status may be out of date.</p>}{notice && <p className="dashboard-notice" role="status">{notice}</p>}{!modal && error && <p className="form-error" role="alert">{error}</p>}
 <section aria-label="Durable server jobs"><details className="project-jobs" open={jobs.some(j => j.status === 'awaiting-review') ? true : undefined}><summary>Background jobs{jobs.length ? ` (${jobs.length})` : ''}</summary><div className="projects-heading"><h3>Background jobs</h3><button className="secondary-button" disabled={!connected || busy} onClick={async () => { setBusy(true); const r = await jobsAPI.refresh({ sessionId: session.id }); setBusy(false); if (r.ok)
        setJobs(r.value);
    else
        setError(r.error.message); }}>Recover status</button></div><p>Refresh checks existing jobs without running them again.</p>{jobs.slice().reverse().map(j => <article key={j.id}><div><strong>{j.project} · {j.status}</strong><small>{j.id}</small><p>{j.message}</p>{j.backupVerified && <small>Verified recovery archive · previous commit {j.previousCommit?.slice(0, 12)}</small>}{j.status === 'awaiting-review' && <small>Database backup verified · migrations have not started</small>}{j.totalSteps && <progress value={j.step || 0} max={j.totalSteps}/>}</div><button className="secondary-button" onClick={() => logs(j.id)}>View job logs</button>{j.backupDirectory && <button className="secondary-button" disabled={!connected} onClick={() => onFiles(j.backupDirectory!)}>Backup files</button>}{j.status === 'awaiting-review' && <button className="primary-button" disabled={!connected || busy} onClick={() => void migrationReview(j)}>Review migrations</button>}{(['running', 'queued', 'unknown'].includes(j.status) && j.action !== 'app-deploy' || j.status === 'awaiting-review') && !['site-create', 'host-packages'].includes(j.action) && !j.action.startsWith('static-') && <button className="secondary-button danger-text" disabled={!connected || busy} onClick={() => void prepare(j.projectId, j)}>Review cancellation</button>}</article>)}{!jobs.length && <p>No background jobs recorded for this server.</p>}</details></section></div>
 {applicationProject && <ApplicationReview project={applicationProject} sessionId={session.id} onClose={() => setApplicationProject(null)} onPlan={p => { setApplicationProject(null); setPlan(p); setName(''); setNeedsPassword(false); setPassword(''); }}/>}{staticProject && <StaticReview project={staticProject} sessionId={session.id} jobs={jobs} onClose={() => setStaticProject(null)} onPlan={p => { setStaticProject(null); setPlan(p); setName(''); setNeedsPassword(false); setPassword(''); }}/>}{(review || plan) && <div className="modal-backdrop project-modal-backdrop"><div className={`modal project-review ${plan && ['app-deploy', 'approve-migrations'].includes(plan.action) ? 'application-job-review' : ''}`} ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label={review ? 'Review website setup' : 'Review background job'}><div className="modal-header"><h2>{review ? 'Set up website' : 'Review background job'}</h2><button disabled={busy} aria-label="Close project review" onClick={() => void closeReview()}>×</button></div>{review ? <><Mappings p={review.project}/>{review.project.issues.length > 0 && <ul>{review.project.issues.map((x, i) => <li key={i}>{x}</li>)}</ul>}<p>This saves local project metadata. It does not change server files or enable deployments.</p><label className="field-label">Type {review.project.name} to confirm<input className="text-input" aria-label="Confirm project name" value={name} onChange={e => setName(e.target.value)}/></label><label className="credential-checkbox"><input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)}/>I reviewed these mappings and any unresolved issues.</label></> : plan && <><p><strong>{plan.project}</strong> · {plan.directory}</p><details className="project-details"><summary>Job identity and protected files</summary><p>Unit: <code>rootpath-job-{plan.id}.service</code></p><p>Protected coordination files: <code>/var/lib/rootpath/jobs-v1/&lt;account UID&gt;/{plan.id}</code></p></details><ol>{plan.steps.map(x => <li key={x}>{x}</li>)}</ol>{plan.preview ? <><Preview value={plan.preview}/><p>{plan.action === 'app-deploy' ? 'Application scripts and dependency lifecycle hooks run as the connected account. Migrations require a later review; service restart and HTTP health must pass. Dependencies/virtual environments are excluded from the archive.' : 'Tracked changes may be discarded by replacement or recovery.'} Nonconflicting untracked files remain. The archive excludes Git metadata; code recovery does not restore environment files or databases. {plan.action !== 'app-deploy' && 'No application scripts are run.'} Short Git write stages cannot be cancelled safely.</p>{plan.confirmation && <label className="field-label">Type {plan.confirmation} to confirm {plan.action === 'app-deploy' ? 'application deployment' : 'discarded tracked changes'}<input className="text-input" aria-label="Confirm replacement project name" value={name} onChange={e => setName(e.target.value)}/></label>}</> : plan.action === 'approve-migrations' ? <><p>A verified database backup is required. Review this exact pending plan; code/dependencies have already been updated. Migrations, collection, restart and health are still pending.</p><pre className="migration-preview">{plan.pendingMigrations?.join('\n')}</pre><p>Plan fingerprint: <code>{plan.migrationHash?.slice(0, 16)}</code></p><label className="field-label">Type {plan.confirmation} to approve migrations<input className="text-input" aria-label="Confirm replacement project name" value={name} onChange={e => setName(e.target.value)}/></label></> : ['site-create', 'host-packages'].includes(plan.action) ? <><p>Repository and package scripts can execute. A failed creation leaves its new directory for inspection. No existing project directory is reused.</p><label className="field-label">Type {plan.confirmation} to confirm<input className="text-input" aria-label="Confirm replacement project name" value={name} onChange={e => setName(e.target.value)}/></label></> : <p>This action does not update Git, install dependencies, run migrations, restart project services or change Nginx.</p>}{needsPassword ? <label className="field-label">Sudo password for {session.profile.username}<input type="password" autoComplete="off" className="text-input" aria-label="Sudo password" value={password} onChange={e => setPassword(e.target.value)}/><small>The password is used for this action and is not saved or logged.</small></label> : <p>Authentication will be requested only if sudo requires a password.</p>}</>}{error && <p className="form-error" role="alert">{error}</p>}<div className="modal-actions"><button className="secondary-button" disabled={busy} onClick={() => void closeReview()}>Cancel review</button><button className="primary-button" disabled={!connected || busy || Boolean(review && (name !== review.project.name || !accepted)) || Boolean(plan && needsPassword && !password) || Boolean(plan?.confirmation && name !== plan.confirmation)} onClick={() => void (review ? importProject() : perform())}>{busy ? 'Working…' : review ? 'Save website settings' : needsPassword ? 'Authorize reviewed action' : 'Start reviewed action'}</button></div></div></div>}</section>;
}
function Mappings({ p }: {
    p: Project;
}) { return <dl className="project-mappings"><dt>Directory</dt><dd>{p.directory}</dd><dt>Directory owner</dt><dd>{p.owner || 'Unknown · rediscover to check'}{p.uid !== undefined ? ` · UID ${p.uid}` : ''}</dd><dt>Repository</dt><dd>{p.repository || 'Unverified'}</dd><dt>Branch / commit</dt><dd>{p.branch || 'Unverified'} · {p.commit?.slice(0, 12) || 'Unknown'}</dd><dt>Domains</dt><dd>{p.domains.join(', ') || 'Unverified'}</dd><dt>Nginx</dt><dd>{p.nginx.join(', ') || 'No verified mapping'}</dd><dt>Service / socket</dt><dd>{[...p.services, ...p.sockets].join(', ') || 'No verified mapping'}</dd><dt>PM2</dt><dd>{p.pm2.map(x => x.name).join(', ') || 'No verified mapping'}</dd><dt>Environment files</dt><dd>{p.envFiles.join(', ') || 'Not detected'}</dd><dt>Database / backup</dt><dd>{p.database} · {p.backupStatus}</dd><dt>Health / deployment</dt><dd>{p.health} · {p.lastDeployment ? `Last code update ${p.lastDeployment.commit.slice(0, 12)} · ${p.lastDeployment.finishedAt || 'time unavailable'}` : 'No deployment recorded'}</dd></dl>; }
function StaticReview({ project: p, sessionId, jobs, onClose, onPlan }: {
    project: Project;
    sessionId: string;
    jobs: Job[];
    onClose: () => void;
    onPlan: (plan: DeploymentPlan) => void;
}) {
    const [remote, setRemote] = useState('origin'), [branch, setBranch] = useState(p.branch || 'main'), [output, setOutput] = useState(''), [recoveryId, setRecoveryId] = useState(''), [value, setValue] = useState<GitPreview | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
    const dialog = useRef<HTMLDivElement>(null);
    const choices = jobs.filter(j => j.projectId === p.id && j.backupVerified && j.previousCommit);
    useEffect(() => { const previous = document.activeElement as HTMLElement; dialog.current?.focus(); return () => previous?.focus(); }, []);
    const q = { sessionId, projectId: p.id, remote, branch, output, recoveryId };
    function change(fn: () => void) { fn(); setValue(null); setError(''); }
    async function preview() { setBusy(true); setError(''); const r = await window.vps!.jobs.preview({ ...q, action: recoveryId ? 'static-recover' : 'static-deploy' }); setBusy(false); if (r.ok)
        setValue(r.value);
    else
        setError(r.error.message); }
    async function prepare(action: StaticAction) { setBusy(true); setError(''); const r = await window.vps!.jobs.prepare({ ...q, action }); setBusy(false); if (r.ok)
        onPlan(r.value);
    else
        setError(r.error.message); }
    return <div className="modal-backdrop project-modal-backdrop"><div className="modal project-review" role="dialog" aria-modal="true" aria-label="Static deployment preview" tabIndex={-1} ref={dialog} onKeyDown={e => { if (e.key === 'Escape' && !busy)
        onClose(); if (e.key === 'Tab') {
        const nodes = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled)');
        if (!nodes?.length)
            return;
        const a = nodes[0], z = nodes[nodes.length - 1];
        if (e.shiftKey && (document.activeElement === a || document.activeElement === dialog.current)) {
            e.preventDefault();
            z.focus();
        }
        else if (!e.shiftKey && document.activeElement === z) {
            e.preventDefault();
            a.focus();
        }
    } }}><div className="modal-header"><h2>{p.name} · Static Git</h2><button disabled={busy} aria-label="Close static preview" onClick={onClose}>×</button></div><p>Fetch and preview prebuilt static content using the VPS account’s SSH key and trusted Git hosts. Preview updates Git objects only; working files stay unchanged.</p><div className="git-settings"><label className="field-label">SSH remote<input aria-label="Git remote" className="text-input" value={remote} onChange={e => change(() => setRemote(e.target.value))}/></label><label className="field-label">Checked-out branch<input aria-label="Git branch" className="text-input" value={branch} onChange={e => change(() => setBranch(e.target.value))}/></label><label className="field-label">Output folder (empty = root)<input aria-label="Static output folder" className="text-input" placeholder="e.g. dist" value={output} onChange={e => change(() => setOutput(e.target.value))}/></label><label className="field-label">Recovery source<select className="text-input" aria-label="Recovery source" value={recoveryId} onChange={e => change(() => setRecoveryId(e.target.value))}><option value="">Selected remote branch</option>{choices.map(j => <option key={j.id} value={j.id}>{j.previousCommit?.slice(0, 12)} · {j.status} · {j.id.slice(0, 8)}</option>)}</select></label></div>{error && <p role="alert" className="form-error">{error}</p>}{value && <Preview value={value}/>}<p>Symlinks, submodules, custom executable Git config and tracked private files require another recipe. Replacement preserves nonconflicting untracked files; it never runs git clean. Backups are protected server files and retained until explicitly removed.</p><div className="modal-actions"><button className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button><button className="secondary-button" disabled={busy} onClick={() => void preview()}>{busy ? 'Working…' : 'Preview changes'}</button>{value && (recoveryId ? <button className="primary-button" disabled={busy} onClick={() => void prepare('static-recover')}>Review code recovery</button> : <><button className="secondary-button danger-text" disabled={busy} onClick={() => void prepare('static-replace')}>Replace with remote version…</button><button className="primary-button" disabled={busy || value.dirty || !value.fastForward} onClick={() => void prepare('static-deploy')}>Review fast-forward deployment</button></>)}</div></div></div>;
}
