import { useState } from 'react';
import { FolderOpen, Globe, Plus, RefreshCw, Search } from 'lucide-react';
import type { Inventory, Job, Project } from './projects';
import { websiteItems, websiteState } from './website-state';
type Props = {
    projects: Project[];
    inventory: Inventory | null;
    jobs: Job[];
    busy: boolean;
    connected: boolean;
    onAdd: () => void;
    onDiscover: () => void;
    onReview: (p: Project) => void;
    onFiles: (path: string) => void;
    onTools: (p: Project | null) => void;
    onUpdate: (p: Project) => void;
    onScripts: (p: Project) => void;
    onRecovery: (p: Project) => void;
    onCheck: (id: string) => void;
    onMigration: (job: Job) => void;
    onLogs: (p: Project) => void;
};
export default function WebsiteCatalog(props: Props) {
    const { projects, inventory, jobs, busy, connected, onAdd, onDiscover, onReview, onFiles, onTools, onUpdate, onScripts, onRecovery, onCheck, onMigration, onLogs } = props;
    const [query, setQuery] = useState(''), [filter, setFilter] = useState('all');
    const items = websiteItems(projects, inventory?.projects ?? null);
    const visible = items.filter(i => `${i.project.name} ${i.project.directory} ${i.project.domains.join(' ')}`.toLowerCase().includes(query.toLowerCase()) && (filter === 'all' || websiteState(i, jobs).label === filter));
    return <><div className="websites-heading"><div><h1>Websites</h1></div><button className="primary-button" disabled={!connected || busy} onClick={onAdd}><Plus size={16}/>Add website</button></div>
 <div className="website-summary"><span><strong>{items.length}</strong> found</span><span><strong>{items.filter(i => i.imported).length}</strong> managed</span><span><strong>{items.filter(i => websiteState(i, jobs).label === 'Needs attention').length}</strong> need attention</span><button className="secondary-button" disabled={!connected || busy} onClick={onDiscover}><RefreshCw size={13}/>{busy ? 'Refreshing…' : 'Refresh websites'}</button></div>
 <div className="website-filters"><label><Search size={15}/><input aria-label="Search websites" placeholder="Search websites, domains or folders…" value={query} onChange={e => setQuery(e.target.value)}/></label><select aria-label="Filter website status" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">All websites</option>{['Discovered', 'Setup needed', 'Ready', 'Deploying', 'Healthy', 'Needs attention'].map(s => <option key={s}>{s}</option>)}</select></div>
 {inventory && <p className="website-location"><FolderOpen size={14}/>Found as {inventory.account.username}. Websites in /var/www are listed below.</p>}
 {inventory && inventory.warnings.length > 0 && <details className="website-discovery-notes"><summary>Discovery notes ({inventory.warnings.length})</summary>{inventory.warnings.map((w, i) => <p key={i}>{w}</p>)}</details>}
 <div className="project-grid website-grid" aria-label="Website cards">{visible.map(item => {
            const p = item.project, state = websiteState(item, jobs), migration = [...jobs].reverse().find(j => j.projectId === p.id && j.status === 'awaiting-review'), reviewMapping = item.mappingChanged || (!item.imported), locked = !connected || busy || Boolean(p.trustChanged) || item.missing;
            return <article className="project-card website-card" key={p.directory} aria-label={'Website ' + p.name}><header><div className="website-name"><Globe size={18}/><h2>{p.name}</h2></div><span className={'website-state state-' + state.label.toLowerCase().replaceAll(' ', '-')}>{state.label}</span></header><p className="website-domain">{p.domains.join(', ') || 'Domain not verified'}</p><p className="website-description">{state.note}</p><p className="website-meta">{({ static: 'Static site', django: 'Django', node: 'Node.js', react: 'React' } as const)[p.type]} · {p.branch || 'Branch not verified'}{p.lastDeployment && ` · Last update ${p.lastDeployment.method === 'script' ? 'script ' + p.lastDeployment.scriptRevision?.slice(0, 12) : p.lastDeployment.commit.slice(0, 12)}`}</p><p className="project-path">{p.directory}</p><div className="project-buttons website-actions"><button className="secondary-button" disabled={!connected} onClick={() => onFiles(p.directory)}>Files</button><button className="secondary-button" onClick={() => onLogs(p)}>Logs</button>{reviewMapping ? <button className="primary-button" disabled={locked || !item.candidate} onClick={() => item.candidate && onReview(item.candidate)}>{item.imported ? 'Review changed settings' : 'Set up website'}</button> : migration ? <button className="primary-button" disabled={locked} onClick={() => onMigration(migration)}>Review migrations</button> : state.label === 'Setup needed' ? <button className="primary-button" disabled={locked} onClick={() => onTools(p)}>Finish setup</button> : state.label === 'Needs attention' ? <button className="primary-button" disabled={locked} onClick={() => onLogs(p)}>Review problem</button> : <button className="primary-button" disabled={locked || state.label === 'Deploying'} onClick={() => onUpdate(p)}>{state.label === 'Deploying' ? 'Deploying…' : 'Update website'}</button>}</div>
 <details className="project-details"><summary>Details</summary><dl className="project-mappings"><dt>Owner</dt><dd>{p.owner || 'Not verified'}{p.uid !== undefined ? ` · UID ${p.uid}` : ''}</dd><dt>Repository</dt><dd>{p.repository || 'Not verified'}</dd><dt>Service</dt><dd>{p.services.join(', ') || 'Not mapped'}</dd><dt>Web server</dt><dd>{p.nginx.join(', ') || 'Not mapped'}</dd><dt>Deployment</dt><dd>See deployment settings</dd></dl>{p.issues.length > 0 && <ul>{p.issues.map((issue, i) => <li key={i}>{issue}</li>)}</ul>}{item.imported && <div className="project-buttons"><button className="secondary-button" disabled={locked} onClick={() => onTools(p)}>Settings &amp; tools</button><button className="secondary-button" disabled={locked} onClick={() => onScripts(p)}>Custom deployment scripts</button><button className="secondary-button" disabled={locked} onClick={() => onCheck(p.id)}>Background check</button><button className="secondary-button" disabled={locked || state.label === 'Deploying'} onClick={() => onUpdate(p)}>Review deployment settings</button><button className="secondary-button" disabled={locked || state.label === 'Deploying'} onClick={() => onRecovery(p)}>Recovery</button>{item.candidate && <button className="secondary-button" disabled={locked} onClick={() => onReview(item.candidate!)}>Review mappings</button>}</div>}</details></article>;
        })}</div>
 {!visible.length && <div className="dashboard-empty"><h2>{items.length ? 'No matching websites' : busy ? 'Finding your websites…' : 'No websites found yet'}</h2><p>{items.length ? 'Change your search or status filter.' : inventory ? 'Check discovery notes, refresh, or add a new website. No server folders were changed.' : 'Rootpath is reading your server folders. You can refresh to try again.'}</p></div>}
 <details className="website-server-tools"><summary>Advanced server checks</summary><p>Check platform support and export diagnostics.</p><button className="secondary-button" onClick={() => onTools(null)}>Release checks</button></details></>;
}
