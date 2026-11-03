import { useEffect, useState } from 'react';
import type { AIClientGrant, AIReview, AISnapshot, Grant } from './ai';
import './ai.css';
export default function AIConnections({ onClose }: {
    onClose: () => void;
}) {
    const api = window.vps!.ai;
    const [state, setState] = useState<AISnapshot | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [name, setName] = useState('My AI assistant'), [kind, setKind] = useState('codex'), [selected, setSelected] = useState<AIClientGrant | null>(null), [grants, setGrants] = useState<Grant[]>([]), [consent, setConsent] = useState(false), [config, setConfig] = useState(''), [message, setMessage] = useState(''), [review, setReview] = useState<AIReview | null>(null), [confirmation, setConfirmation] = useState(''), [password, setPassword] = useState(''), [needsPassword, setNeedsPassword] = useState(false);
    async function refresh() { const r = await api.snapshot(); if (r.ok)
        setState(r.value);
    else
        setError(r.error.message); }
    useEffect(() => { const previous = document.activeElement as HTMLElement; const top = () => Array.from(document.querySelectorAll<HTMLElement>('[role=dialog]')).at(-1); top()?.querySelector<HTMLElement>('button')?.focus(); const key = (e: KeyboardEvent) => { const d = top(); if (!d || e.key !== 'Tab')
        return; const nodes = Array.from(d.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary')).filter(n => n.getClientRects().length); const first = nodes[0], last = nodes.at(-1); if (e.shiftKey && (document.activeElement === first || !d.contains(document.activeElement))) {
        e.preventDefault();
        last?.focus();
    }
    else if (!e.shiftKey && (document.activeElement === last || !d.contains(document.activeElement))) {
        e.preventDefault();
        first?.focus();
    } }; document.addEventListener('keydown', key); return () => { document.removeEventListener('keydown', key); previous?.focus(); }; }, [Boolean(review)]);
    useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 4000); return () => clearInterval(timer); }, []);
    async function run<T>(task: () => Promise<import('./connections').Result<T>>, done?: (v: T) => void) { setBusy(true); setError(''); try {
        const r = await task();
        if (r.ok) {
            done?.(r.value);
            await refresh();
        }
        else {
            setError(r.error.message);
            if (['SUDO_PASSWORD_REQUIRED', 'SUDO_DENIED'].includes(r.error.code))
                setNeedsPassword(true);
        }
    }
    finally {
        setBusy(false);
    } }
    function choose(c: AIClientGrant) { setSelected(c); setGrants(structuredClone(c.grants)); setConsent(false); setConfig(''); setMessage(''); }
    function update(id: string, change: Partial<Grant>) { setGrants(gs => gs.map(g => g.projectId === id ? { ...g, ...change } : g)); }
    return <><div className="modal-header"><h2>AI connections</h2><button autoFocus aria-label="Close AI connections" disabled={busy} onClick={onClose}>×</button></div><div className="ai-content"><p>Choose which websites your assistant can access. Review changes here before they run.</p><p className="info-text">Keep Rootpath open while connected.</p><details className="ai-permission-note"><summary>Permissions and compatibility</summary><p>These permissions apply to Rootpath only. Your assistant may have other tools with separate access. Test the connection in your chosen client before relying on it.</p></details>{error && <p role="alert" className="form-error">{error}</p>}{message && <p role="status">{message}</p>}{state && <><div className="ai-toolbar"><button disabled={busy} onClick={() => void run(() => api.control({ action: 'pause', paused: !state.paused }))}>{state.paused ? 'Resume AI access' : 'Pause AI access'}</button><button disabled={busy} onClick={() => void run(() => api.control({ action: 'all' }), () => { setSelected(null); setConfig(''); })}>Revoke all connections</button><strong>{state.paused ? 'AI access paused' : 'AI access enabled'}</strong></div><section><h3>Add an assistant</h3><div className="ai-toolbar"><select aria-label="AI client" value={kind} onChange={e => setKind(e.target.value)}><option value="codex">Codex</option><option value="claude">Claude Desktop</option><option value="antigravity">Antigravity</option><option value="other">Other local MCP client</option></select><input aria-label="Connection name" value={name} maxLength={80} onChange={e => setName(e.target.value)}/><button disabled={busy || !name.trim()} onClick={() => void run(() => api.create({ kind, name }), () => setMessage('Connection created with no project access. Select it below to review permissions.'))}>Create connection</button></div><div className="ai-toolbar">{state.clients.filter(c => !c.revoked).map(c => <button key={c.id} className={selected?.id === c.id ? 'active' : ''} onClick={() => choose(c)}>{c.name} · {c.grants.length} websites</button>)}</div></section>{selected && !state.clients.find(c => c.id === selected.id)?.revoked && <section><h3>Access for {selected.name}</h3><p>Choose websites and permissions below. Code access requires a matching local GitHub workspace. Metrics include server totals; logs include deployment output with known secrets removed.</p>{!state.catalog.projects.length && <p>No websites are set up yet. Open Websites and choose Set up website first.</p>}{state.catalog.projects.map(p => { const g = grants.find(g => g.projectId === p.id); return <fieldset key={p.id}><legend><label><input type="checkbox" checked={Boolean(g)} onChange={e => setGrants(gs => e.target.checked ? [...gs, { projectId: p.id, serverId: p.serverId, fingerprint: p.fingerprint, workspaceId: null, permissions: [] }] : gs.filter(g => g.projectId !== p.id))}/>{p.name}</label></legend><small>Trusted server: {p.fingerprint}</small>{g && <><div className="ai-toolbar">{['code', 'metrics', 'logs', 'propose'].map(v => <label key={v}><input type="checkbox" checked={g.permissions.includes(v)} onChange={e => update(p.id, { permissions: e.target.checked ? [...g.permissions, v] : g.permissions.filter(x => x !== v) })}/>{({ code: 'Repository files', metrics: 'Server metrics', logs: 'Deployment logs', propose: 'Propose changes' })[v]}</label>)}</div><label>Local workspace <select aria-label={'Workspace for ' + p.name} value={g.workspaceId || ''} onChange={e => update(p.id, { workspaceId: e.target.value || null })}><option value="">None</option>{state.catalog.workspaces.map(w => <option key={w.id} value={w.id}>{w.repository} · {w.branch}</option>)}</select></label></>}</fieldset>; })}<label><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)}/>I understand selected code and logs may be sent to my assistant’s provider.</label><div className="ai-toolbar"><button disabled={busy || !consent} onClick={() => void run(() => api.grant({ clientId: selected.id, grants, consent }), () => setMessage('Permissions saved.'))}>Save permissions</button><button disabled={busy} onClick={() => void run(() => api.configuration({ clientId: selected.id }), v => setConfig((selected.kind === 'codex' ? v.toml : v.json) + '\n' + v.note))}>Show client configuration</button><button disabled={busy} onClick={() => void run(() => api.test({ clientId: selected.id }), v => setMessage('Private bridge connected. ' + v.projects + ' website grants. This does not verify the external AI client.'))}>Test local connection</button><button disabled={busy} onClick={() => void run(() => api.control({ action: 'revoke', clientId: selected.id }), () => { setSelected(null); setConfig(''); })}>Revoke this connection</button></div>{config && <><pre className="development-diff">{config}</pre><button onClick={() => void window.vps!.workspace.copy(config.slice(0, config.lastIndexOf('\n')))}>Copy configuration</button></>}</section>}<section><h3>Requests awaiting your review</h3>{!state.proposals.some(p => p.state === 'pending') && <p>No requests waiting for review.</p>}{state.proposals.slice().reverse().map(p => <article className="ai-request" key={p.id}><strong>{p.summary.description}</strong><p>{p.client} · {({ pending: 'Awaiting review', executing: 'Running', submitted: 'Submitted', rejected: 'Rejected', 'needs-attention': 'Needs attention' })[p.state] || p.state}</p>{p.state === 'pending' && <div className="ai-toolbar"><button disabled={busy} onClick={() => void run(() => api.review({ proposalId: p.id }), v => { setReview(v); setConfirmation(''); setNeedsPassword(false); setPassword(''); })}>Review changes</button><button disabled={busy} onClick={() => void run(() => api.reject({ proposalId: p.id }))}>Reject request</button></div>}{p.result !== undefined && <RequestResult value={p.result}/>}</article>)}</section></>}</div>{review && <div className="modal-backdrop project-modal-backdrop"><div className="modal ai-review" role="dialog" aria-modal="true" aria-label="Review AI proposal"><div className="modal-header"><h2>{({ code: 'Review code change', publish: 'Review pull request', deploy: 'Review deployment', restart: 'Review service restart', recover: 'Review recovery', create_website: 'Review new website' })[review.proposal.kind] || 'Review request'}</h2><button disabled={busy} onClick={() => { void api.cancelReview({ token: review.token }); setReview(null); setPassword(''); }}>×</button></div><div className="ai-content"><p>Requested by {review.proposal.client}. Check the changes and target before approving.</p><p>{review.proposal.summary.description}</p><ProposalPreview value={review.preview}/><label>Type {review.proposal.summary.confirmation} to approve<input autoComplete="off" aria-label="Confirm AI proposal" value={confirmation} onChange={e => setConfirmation(e.target.value)}/></label>{needsPassword && <label>Sudo password<input type="password" autoComplete="off" value={password} onChange={e => setPassword(e.target.value)}/></label>}{error && <p role="alert" className="form-error">{error}</p>}<div className="ai-toolbar"><button disabled={busy} onClick={() => { void api.cancelReview({ token: review.token }); setReview(null); setPassword(''); }}>Cancel review</button><button disabled={busy || Date.now() >= review.expiresAt || confirmation !== review.proposal.summary.confirmation || needsPassword && !password} onClick={() => void run(() => api.approve({ token: review.token, confirmation, password }), () => { setReview(null); setPassword(''); setMessage('Request submitted. Check Activity for progress.'); })}>Approve request</button></div></div></div></div>}</>;
}
function ProposalPreview({ value }: {
    value: Record<string, unknown>;
}) {
    if (value.kind === 'code') {
        const c = value.change as import('./development').OperationProposal;
        return <><p><strong>{c.kind}: {c.path}{c.to ? ' → ' + c.to : ''}</strong></p><h3>Before</h3><pre className="development-diff">{c.before ?? '(new file)'}</pre><h3>After</h3><pre className="development-diff">{c.after}</pre><p>This saves the change locally. Publishing and deployment need separate approval.</p></>;
    }
    if (value.kind === 'publish') {
        const p = value.publication as import('./development').PublicationReview;
        return <><p>{p.repository} · {p.branch} → {p.base}</p><p><code>{p.commit}</code></p><h3>{p.title}</h3><p>{p.body}</p><pre className="development-diff">{p.diff}</pre><p>This publishes a branch and opens a pull request. Merge on GitHub before deploying.</p></>;
    }
    if (value.kind === 'job') {
        const p = value.plan as import('./development').ReviewJob;
        return <><p><strong>{p.project}</strong> · {p.directory}</p><ol>{p.steps.map((step, i) => <li key={i}>{step}</li>)}</ol><details><summary>Deployment details</summary><pre className="development-diff">{JSON.stringify(p, null, 2)}</pre></details><p>Dependency/build scripts run only after approval. Migrations require their separate backup and migration review. Deployment fails if the health check fails.</p></>;
    }
    if (value.kind === 'restart') {
        const p = value.plan as {
            unit: string;
            server: string;
            username: string;
            state: {
                ActiveState: string;
            };
        };
        return <><dl className="ai-summary"><dt>Server</dt><dd>{p.server}</dd><dt>Account</dt><dd>{p.username}</dd><dt>Service</dt><dd>{p.unit}</dd><dt>Current state</dt><dd>{p.state.ActiveState}</dd></dl><p>Rootpath will restart this service and check that it is active. If the connection drops, inspect its state before retrying.</p></>;
    }
    return <p>Review the target and changes before approving.</p>;
}
function RequestResult({ value }: {
    value: unknown;
}) { const r = value as {
    applied?: boolean;
    status?: string;
    id?: string;
    unit?: string;
    publications?: {
        title: string;
        number?: number;
        state: string;
    }[];
}; return <div className="ai-result">{r.applied && <p>Saved to the local branch.</p>}{r.status && <p>{r.unit ? r.unit + ': ' : ''}{r.status}</p>}{r.id && <small>Job: {r.id}</small>}{r.publications?.map((p, i) => <p key={i}>{p.number ? 'PR #' + p.number + ': ' : ''}{p.title} · {p.state}</p>)}</div>; }
