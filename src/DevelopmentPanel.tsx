import { useEffect, useState } from 'react';
import type { Session } from './connections';
import type { Project, ApplicationOptions } from './projects';
import type { LocalWorkspace, Repository, OperationProposal, PublicationReview, Detection, ReviewJob } from './development';
import GitHubPanel from './GitHubPanel';
import ReviewedJob from './ReviewedJob';
import './development.css';
export default function DevelopmentPanel({ session, onClose }: {
    session?: Session;
    onClose?: () => void;
}) {
    const api = window.vps!.development;
    const [workspaces, setWorkspaces] = useState<LocalWorkspace[]>([]), [selected, setSelected] = useState(''), [repos, setRepos] = useState<Repository[]>([]), [repo, setRepo] = useState(''), [branch, setBranch] = useState('main'), [files, setFiles] = useState<string[]>([]), [pending, setPending] = useState<{
        id: string;
        kind: string;
        path: string;
    }[]>([]), [file, setFile] = useState(''), [content, setContent] = useState(''), [original, setOriginal] = useState(''), [revision, setRevision] = useState(''), [kind, setKind] = useState('edit'), [newPath, setNewPath] = useState(''), [proposal, setProposal] = useState<OperationProposal | null>(null), [title, setTitle] = useState(''), [body, setBody] = useState(''), [publication, setPublication] = useState<PublicationReview | null>(null), [confirmation, setConfirmation] = useState(''), [detection, setDetection] = useState<Detection[]>([]), [projects, setProjects] = useState<Project[]>([]), [projectId, setProject] = useState(''), [options, setOptions] = useState<ApplicationOptions>({ healthUrl: '', installMode: 'locked', acceptScripts: false }), [plan, setPlan] = useState<ReviewJob | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
    const workspace = workspaces.find(w => w.id === selected), project = projects.find(p => p.id === projectId), dirty = content !== original;
    async function snapshot() { const r = await api.snapshot(); if (r.ok)
        setWorkspaces(r.value);
    else
        setError(r.error.message); }
    async function status(id = selected) { if (!id)
        return; const r = await api.status({ workspaceId: id }); if (r.ok) {
        setFiles(r.value.files);
        setPending(r.value.pending);
        setWorkspaces(all => all.map(w => w.id === id ? r.value : w));
    }
    else
        setError(r.error.message); }
    useEffect(() => { void snapshot(); if (session)
        void window.vps!.projects.snapshot({ sessionId: session.id }).then(r => { if (r.ok)
            setProjects(r.value); }); }, [session?.id]);
    async function run(fn: () => Promise<void>) { if (busy)
        return; setBusy(true); setError(''); try {
        await fn();
    }
    finally {
        setBusy(false);
    } }
    async function repositories() { const r = await window.vps!.github.repositories(); if (r.ok) {
        setRepos(r.value.repositories);
        setNotice(r.value.limited ? 'The repository list was limited. Narrow app access to the repositories you need.' : 'Repository access refreshed.');
    }
    else
        setError(r.error.message); }
    async function choose(id: string) { if (dirty && !confirm('Discard the unsaved local editor text?'))
        return; setSelected(id); setFile(''); setContent(''); setOriginal(''); setProposal(null); setDetection([]); await status(id); }
    async function read(p: string) { if (dirty && !confirm('Discard the unsaved local editor text?'))
        return; const r = await api.read({ workspaceId: selected, path: p }); if (r.ok) {
        setFile(p);
        setContent(r.value.content);
        setOriginal(r.value.content);
        setRevision(r.value.revision);
        setKind('edit');
    }
    else
        setError(r.error.message); }
    async function propose() { const r = await api.propose({ workspaceId: selected, kind, path: kind === 'edit' || kind === 'rename' ? file : newPath, to: kind === 'rename' ? newPath : undefined, content, revision }); if (r.ok) {
        setProposal(r.value);
        await status();
    }
    else
        setError(r.error.message); }
    async function approve() { if (!proposal)
        return; const r = await api.approve({ proposalId: proposal.id }); if (r.ok) {
        setNotice('Change saved to the local branch. Server files are unchanged.');
        setOriginal(content);
        setProposal(null);
        await status();
    }
    else
        setError(r.error.message); }
    async function preparePublication() { const r = await api.preparePublish({ workspaceId: selected, title, body }); if (r.ok) {
        setPublication(r.value);
        setConfirmation('');
    }
    else
        setError(r.error.message); }
    async function deploy() { if (!session || !project)
        return; const r = await window.vps!.delivery.prepare({ sessionId: session.id, workspaceId: selected, projectId: project.id, ...options, acceptScripts: options.acceptScripts }); if (r.ok)
        setPlan(r.value);
    else
        setError(r.error.message); }
    return <section className="development-panel" aria-label="GitHub and code workspace"><div className="projects-heading"><div><h2>GitHub &amp; code</h2><p>Edit locally, open a pull request and deploy after merging.</p></div>{onClose && <button className="secondary-button" disabled={busy} onClick={() => { if (!dirty || confirm('Discard the unsaved local editor text?'))
        onClose(); }}>Back</button>}</div><div inert={Boolean(plan || publication || proposal)}><GitHubPanel />{error && <p role="alert" className="form-error">{error}</p>}{notice && <p role="status" className="dashboard-notice">{notice}</p>}
 <section className="dashboard-card"><h3>Choose a repository</h3><div className="setup-buttons"><button className="secondary-button" disabled={busy} onClick={() => void run(repositories)}>Refresh selected repositories</button><select className="text-input" aria-label="GitHub repository" value={repo} disabled={busy} onChange={e => { setRepo(e.target.value); setBranch(repos.find(r => r.id === Number(e.target.value))?.defaultBranch || 'main'); }}><option value="">Choose repository…</option>{repos.map(r => <option key={r.id} value={r.id}>{r.fullName}{r.private ? ' · private' : ''}</option>)}</select><label>Branch<input className="text-input" aria-label="GitHub base branch" value={branch} onChange={e => setBranch(e.target.value)}/></label><button className="primary-button" disabled={busy || !repo} onClick={() => void run(async () => { const r = await api.create({ repositoryId: Number(repo), branch }); if (r.ok) {
        await snapshot();
        await choose(r.value.id);
        setNotice('Local workspace ready.');
    }
    else
        setError(r.error.message); })}>Create local workspace</button></div><p>Requires Git on this computer. Creating a workspace downloads code without running it.</p></section>
 <section className="dashboard-card"><h3>Local workspaces</h3><select className="text-input" aria-label="Local workspace" value={selected} disabled={busy} onChange={e => void run(() => choose(e.target.value))}><option value="">Choose workspace…</option>{workspaces.map(w => <option key={w.id} value={w.id}>{w.repository} · {w.branch}</option>)}</select>{workspace && <><p>Base: {workspace.baseBranch} · <code>{workspace.baseCommit.slice(0, 12)}</code> · private branch: <code>{workspace.branch}</code></p><div className="setup-buttons"><button className="secondary-button" disabled={busy} onClick={() => void run(() => status())}>Refresh files</button><button className="secondary-button" disabled={busy} onClick={() => void run(async () => { const r = await api.settings({ workspaceId: selected }); if (r.ok)
            setDetection(r.value.candidates);
        else
            setError(r.error.message); })}>Detect website settings</button></div>{detection.map((c, i) => <p key={i}><strong>{c.type}</strong> · folder {c.appDirectory || '/'} · {c.packageManager || 'no package manager'} · output {c.output || '/'} · entry {c.entry || 'confirm entry'} {c.notes.join(' ')}</p>)}<div className="development-editor"><div className="development-files" aria-label="Workspace files">{files.map(p => <button key={p} disabled={busy} className={file === p ? 'selected' : ''} onClick={() => void run(() => read(p))}>{p}</button>)}</div><div><label>Action<select className="text-input" aria-label="Local file action" value={kind} disabled={busy} onChange={e => setKind(e.target.value)}><option value="edit">Edit selected file</option><option value="create">Create file</option><option value="folder">Create folder (.gitkeep)</option><option value="rename">Rename selected file</option></select></label><p>{file || 'Select a file, or choose Create file.'}</p>{kind !== 'edit' && <label>New relative path<input className="text-input" aria-label="Proposed file path" value={newPath} onChange={e => setNewPath(e.target.value)}/></label>}{!['folder', 'rename'].includes(kind) && <textarea className="development-text" aria-label="Local file content" disabled={busy || kind === 'edit' && !file} spellCheck={false} value={content} onChange={e => setContent(e.target.value)}/>}<button className="primary-button" disabled={busy || (['edit', 'rename'].includes(kind) ? !file : !newPath)} onClick={() => void run(propose)}>Review local change</button></div></div>{pending.length > 0 && <details><summary>Pending change reviews ({pending.length})</summary>{pending.map(p => <button className="secondary-button" key={p.id} onClick={() => void run(async () => { const r = await api.proposal({ proposalId: p.id }); if (r.ok)
            setProposal(r.value);
        else
            setError(r.error.message); })}>{p.kind}: {p.path}</button>)}</details>}
 <h3>Publish a pull request</h3><label className="field-label">Title<input className="text-input" aria-label="Pull request title" value={title} onChange={e => setTitle(e.target.value)}/></label><label className="field-label">Description<textarea className="text-input" aria-label="Pull request description" value={body} onChange={e => setBody(e.target.value)}/></label><button className="primary-button" disabled={busy || !title.trim() || dirty} onClick={() => void run(preparePublication)}>Review commit and publication</button>{dirty && <p>Review and apply the editor change before publishing.</p>}{workspace.publications.map(p => <article className="publication" key={p.id}><strong>{p.title} · {p.state}</strong><p><code>{p.commit}</code>{p.mergeCommit ? ` · merged ${p.mergeCommit.slice(0, 12)}` : ''}</p>{p.error && <p role="alert">{p.error}</p>}{p.checks?.map((c, i) => <p key={i}>{c.name}: {c.conclusion || c.status}</p>)}<button className="secondary-button" disabled={busy} onClick={() => void run(async () => { const r = await api.refreshPublication({ workspaceId: selected, publicationId: p.id }); if (r.ok) {
            await snapshot();
            setNotice(r.value.message || 'Pull request status refreshed.');
        }
        else
            setError(r.error.message); })}>Refresh merge and checks</button>{p.state === 'needs-recovery' && <button className="secondary-button" disabled={busy} onClick={() => void run(async () => { const r = await api.prepareResume({ workspaceId: selected, publicationId: p.id }); if (r.ok) {
            setPublication(r.value);
            setConfirmation('');
        }
        else
            setError(r.error.message); })}>Review publication recovery</button>}<button className="secondary-button" disabled={!p.number} onClick={() => void api.openPublication({ workspaceId: selected, publicationId: p.id })}>Open pull request on GitHub</button></article>)}</>}</section>
 {workspace && session && <section className="dashboard-card"><h3>Deploy a reviewed GitHub revision</h3><p>Choose an existing website with a reviewed repository mapping. The VPS receives a verified bundle of the selected base branch. Dirty files or divergent history stop deployment.</p><select className="text-input" aria-label="Deployment website" value={projectId} onChange={e => { setProject(e.target.value); const p = projects.find(x => x.id === e.target.value); setOptions({ ...p?.deploymentSettings, healthUrl: p?.deploymentSettings?.healthUrl || (p?.domains[0] ? 'https://' + p.domains[0] + '/' : ''), service: p?.services[0], pm2Id: p?.pm2[0]?.id, envFile: p?.envFiles[0], installMode: 'locked', build: p?.type === 'react', acceptScripts: false }); }}><option value="">Choose website…</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name} · {p.type}</option>)}</select>{project && <><p>{project.directory} · {project.repository} · {project.branch}</p><label className="field-label">Health URL<input className="text-input" aria-label="Deployment health URL" value={options.healthUrl || ''} onChange={e => setOptions(o => ({ ...o, healthUrl: e.target.value }))}/></label><details><summary>Advanced deployment settings</summary>{(['output', 'runtimeBin', 'python', 'requirements', 'service', 'pm2Id', 'envFile', 'frontend', 'frontendOutput'] as const).map(k => <label className="field-label" key={k}>{k}<input className="text-input" value={String(options[k] || '')} onChange={e => setOptions(o => ({ ...o, [k]: e.target.value }))}/></label>)}<label><input type="checkbox" checked={options.build || false} onChange={e => setOptions(o => ({ ...o, build: e.target.checked }))}/>Run build</label><label><input type="checkbox" checked={options.installMode === 'install'} onChange={e => setOptions(o => ({ ...o, installMode: e.target.checked ? 'install' : 'locked' }))}/>Allow installation without a compatible lockfile</label></details><label className="credential-checkbox"><input type="checkbox" checked={options.acceptScripts || false} onChange={e => setOptions(o => ({ ...o, acceptScripts: e.target.checked }))}/>I trust the selected repository’s application and dependency scripts.</label><button className="primary-button" disabled={busy || !options.acceptScripts || session.status !== 'connected'} onClick={() => void run(deploy)}>Review deployment</button></>}</section>}
 </div>{busy && <p role="status">Working…</p>}{proposal && <div className="modal-backdrop project-modal-backdrop"><div className="modal project-review" role="dialog" aria-modal="true" aria-label="Review local code change"><h2>Review local change</h2><p>{proposal.kind} · {proposal.path}{proposal.to ? ' → ' + proposal.to : ''}</p><div className="development-diff-grid"><section><h3>Before</h3><pre className="development-diff">{proposal.before ?? '(new file)'}</pre></section><section><h3>After</h3><pre className="development-diff">{proposal.after || '(empty file)'}</pre></section></div><p>This changes the local workspace. The previous text is saved for recovery.</p>{error && <p className="form-error" role="alert">{error}</p>}<div className="modal-actions"><button className="secondary-button" disabled={busy} onClick={() => void run(async () => { const r = await api.reject({ proposalId: proposal.id }); if (r.ok) {
        setProposal(null);
        await status();
    }
    else
        setError(r.error.message); })}>Reject change</button><button className="primary-button" disabled={busy} onClick={() => void run(approve)}>Approve local change</button></div></div></div>}{publication && <div className="modal-backdrop project-modal-backdrop"><div className="modal project-review" role="dialog" aria-modal="true" aria-label="Review pull request publication"><h2>Review publication</h2><dl className="project-mappings"><dt>Repository</dt><dd>{publication.repository}</dd><dt>Branch → base</dt><dd>{publication.branch} → {publication.base}</dd><dt>Exact commit</dt><dd>{publication.commit}</dd><dt>Title</dt><dd>{publication.title}</dd><dt>Description</dt><dd>{publication.body}</dd></dl><pre className="development-diff" aria-label="Publication diff">{publication.diff}</pre><p>Approval commits these reviewed files, pushes this branch and opens a pull request. You merge on GitHub. Nothing is deployed by this approval.</p><label className="field-label">Type {publication.repository} to approve<input className="text-input" aria-label="Confirm publication repository" value={confirmation} onChange={e => setConfirmation(e.target.value)}/></label>{error && <p role="alert" className="form-error">{error}</p>}<div className="modal-actions"><button className="secondary-button" disabled={busy} onClick={() => setPublication(null)}>Cancel publication</button><button className="primary-button" disabled={busy || confirmation !== publication.repository} onClick={() => void run(async () => { const r = await api.publish({ token: publication.token, confirmation }); if (r.ok) {
        setPublication(null);
        await snapshot();
        await status();
        setNotice('Pull request published. Merge it on GitHub, then refresh its status.');
    }
    else
        setError(r.error.message); })}>Approve push and pull request</button></div></div></div>}{plan && <ReviewedJob plan={plan} delivery onClose={() => setPlan(null)} onDone={() => { setPlan(null); setNotice('Deployment job submitted. Follow its status and logs in Activity.'); }}/>}</section>;
}
