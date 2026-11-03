import { useEffect, useRef, useState } from 'react';
import { Activity, ArrowLeft, Cpu, HardDrive, History, List, Power, RefreshCw, Search, Server, ShieldCheck, FolderOpen, Globe, Settings, X } from 'lucide-react';
import type { Session } from './connections';
import type { ActionPlan, Capabilities, Metrics, Operation, ProcessEntry, ServerAction, ServiceEntry, ServiceStatus } from './monitoring';
import { humanSize } from './files';
import './dashboard.css';
import ApplicationsPanel from './ApplicationsPanel';
import HostingPanel from './HostingPanel';
import DatabasesPanel from './DatabasesPanel';
import ProjectsPanel from './ProjectsPanel';
import DevelopmentPanel from './DevelopmentPanel';
import StorageCard from './StorageCard';
type Tab = 'development' | 'projects' | 'overview' | 'processes' | 'services' | 'applications' | 'hosting' | 'databases' | 'history';
const percent = (value: number | null) => value === null ? 'Sampling…' : value.toFixed(1) + '%';
const rate = (value: number | null) => value === null ? 'Sampling…' : humanSize(value) + '/s';
function uptime(seconds: number | null) { if (seconds === null)
    return 'Unavailable'; return `${Math.floor(seconds / 86400)}d ${Math.floor(seconds / 3600) % 24}h ${Math.floor(seconds / 60) % 60}m`; }
const labels: Record<ServerAction, string> = { start: 'Start service', stop: 'Stop service', restart: 'Restart service', reboot: 'Reboot server', shutdown: 'Shut down server' };
export default function ServerDashboard({ session, onClose, onFiles }: {
    session: Session;
    onClose: () => void;
    onFiles: (path: string) => void;
}) {
    const api = window.vps!.monitoring, [tab, setTab] = useState<Tab>('projects'), [caps, setCaps] = useState<Capabilities | null>(null), [metrics, setMetrics] = useState<Metrics | null>(null), [processes, setProcesses] = useState<ProcessEntry[]>([]), [services, setServices] = useState<ServiceEntry[]>([]), [history, setHistory] = useState<Operation[]>([]);
    const [probeError, setProbeError] = useState('');
    const [error, setError] = useState(''), [notice, setNotice] = useState(''), [loading, setLoading] = useState(false), [refresh, setRefresh] = useState(0), [auto, setAuto] = useState(true), [query, setQuery] = useState(''), [page, setPage] = useState(0), [allHistory, setAllHistory] = useState(false);
    const [selected, setSelected] = useState<string | null>(null), [details, setDetails] = useState<ServiceStatus | null>(null), [logs, setLogs] = useState(''), [logWarning, setLogWarning] = useState(''), [detailBusy, setDetailBusy] = useState(false);
    const [requestedSudo, setRequestedSudo] = useState(false);
    const [plan, setPlan] = useState<ActionPlan | null>(null), [actionBusy, setActionBusy] = useState(false), [actionError, setActionError] = useState(''), [confirmationHost, setConfirmationHost] = useState(''), [now, setNow] = useState(Date.now());
    const mounted = useRef(true), detailRequest = useRef(0), modal = useRef<HTMLDivElement>(null), planRef = useRef(plan);
    planRef.current = plan;
    const connected = session.status === 'connected', canManage = connected && Boolean(caps?.services && caps.managed);
    useEffect(() => { mounted.current = true; let received = false; const unsub = api.subscribe(next => { received = true; setHistory(next); }); void api.snapshot().then(r => { if (mounted.current && r.ok && !received)
        setHistory(r.value); }); return () => { mounted.current = false; detailRequest.current++; unsub(); if (planRef.current)
        void api.cancel({ token: planRef.current.token }); }; }, []);
    useEffect(() => { let live = true; setLoading(true); void api.capabilities({ sessionId: session.id }).then(r => { if (!live)
        return; setLoading(false); if (r.ok)
        setCaps(r.value);
    else
        setError(r.error.message); }); return () => { live = false; }; }, [session.id]);
    useEffect(() => { const clock = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(clock); }, []);
    useEffect(() => { setQuery(''); setPage(0); setError(''); setProbeError(''); }, [tab]);
    useEffect(() => { setPage(0); }, [query, allHistory]);
    useEffect(() => {
        if (!caps || !connected || (['history', 'applications', 'hosting', 'databases', 'projects', 'development'].includes(tab)))
            return;
        if ((tab === 'overview' && !caps.metrics) || (tab === 'processes' && !caps.processes) || (tab === 'services' && !caps.services))
            return;
        let live = true, timer: ReturnType<typeof setTimeout>;
        async function sample() {
            if (!live)
                return;
            if (document.visibilityState === 'hidden') {
                timer = setTimeout(sample, 5000);
                return;
            }
            setLoading(true);
            if (tab === 'overview') {
                const result = await api.metrics({ sessionId: session.id });
                if (live) {
                    if (result.ok) {
                        setMetrics(result.value);
                        setProbeError('');
                    }
                    else
                        setProbeError(result.error.message);
                }
            }
            if (tab === 'processes') {
                const result = await api.processes({ sessionId: session.id });
                if (live) {
                    if (result.ok) {
                        setProcesses(result.value.entries);
                        setProbeError('');
                    }
                    else
                        setProbeError(result.error.message);
                }
            }
            if (tab === 'services') {
                const result = await api.services({ sessionId: session.id });
                if (live) {
                    if (result.ok) {
                        setServices(result.value.entries);
                        setProbeError('');
                    }
                    else
                        setProbeError(result.error.message);
                }
            }
            if (live) {
                setLoading(false);
                if (auto && tab !== 'services')
                    timer = setTimeout(sample, 5000);
            }
        }
        void sample();
        return () => { live = false; clearTimeout(timer); };
    }, [caps, tab, connected, refresh, auto]);
    async function inspect(unit: string) {
        const ticket = ++detailRequest.current;
        setSelected(unit);
        setDetails(null);
        setLogs('');
        setLogWarning('');
        setDetailBusy(true);
        const [status, journal] = await Promise.all([api.status({ sessionId: session.id, unit }), caps?.journal ? api.logs({ sessionId: session.id, unit }) : Promise.resolve(null)]);
        if (!mounted.current || ticket !== detailRequest.current)
            return;
        setDetailBusy(false);
        if (status.ok)
            setDetails(status.value);
        else
            setLogWarning(status.error.message);
        if (journal?.ok) {
            setLogs(journal.value.text);
            setLogWarning(journal.value.warning);
        }
        else if (journal && !journal.ok)
            setLogWarning(journal.error.message);
        else
            setLogWarning('journalctl was not detected.');
    }
    async function prepare(action: ServerAction, unit?: string, sudo = false) {
        if (actionBusy)
            return;
        setRequestedSudo(sudo);
        setActionBusy(true);
        setActionError('');
        if (!plan)
            setError('');
        const previous = plan;
        const result = await api.prepare({ sessionId: session.id, action, unit, sudo });
        if (!mounted.current) {
            if (result.ok)
                void api.cancel({ token: result.value.token });
            return;
        }
        setActionBusy(false);
        if (result.ok) {
            if (previous)
                void api.cancel({ token: previous.token });
            setPlan(result.value);
            setRequestedSudo(result.value.sudo);
            setConfirmationHost('');
            setNow(Date.now());
        }
        else if (previous) {
            setRequestedSudo(previous.sudo);
            setActionError(result.error.message);
        }
        else
            setError(result.error.message);
    }
    async function closePlan() { if (actionBusy)
        return; if (plan)
        void api.cancel({ token: plan.token }); setPlan(null); setActionError(''); }
    async function perform() {
        if (!plan || actionBusy)
            return;
        setActionBusy(true);
        setActionError('');
        const result = await api.perform({ token: plan.token, confirmationHost });
        if (!mounted.current)
            return;
        setActionBusy(false);
        setPlan(null);
        setConfirmationHost('');
        setRefresh(v => v + 1);
        if (result.ok)
            setNotice(result.value.message);
        else
            setError(result.error.message);
        if (plan.unit && connected)
            void inspect(plan.unit);
    }
    useEffect(() => {
        if (!plan)
            return;
        const previous = document.activeElement as HTMLElement;
        modal.current?.focus();
        const handle = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && !actionBusy)
                void closePlan();
            if (event.key !== 'Tab')
                return;
            const nodes = modal.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)');
            if (!nodes?.length)
                return;
            const first = nodes[0], last = nodes[nodes.length - 1];
            if (event.shiftKey && (document.activeElement === first || document.activeElement === modal.current)) {
                event.preventDefault();
                last.focus();
            }
            else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };
        document.addEventListener('keydown', handle);
        return () => { document.removeEventListener('keydown', handle); previous?.focus(); };
    }, [plan?.token, actionBusy]);
    const visibleServices = services.filter(s => `${s.unit} ${s.description} ${s.active}`.toLowerCase().includes(query.toLowerCase()));
    const visibleProcesses = processes.filter(p => `${p.pid} ${p.user} ${p.name}`.toLowerCase().includes(query.toLowerCase()));
    const visibleHistory = [...history].reverse().filter(h => (allHistory || h.sessionId === session.id) && `${h.server} ${h.host} ${h.action} ${h.unit || ''} ${h.status} ${h.message}`.toLowerCase().includes(query.toLowerCase()));
    const power = plan && ['reboot', 'shutdown'].includes(plan.action), expired = plan && now >= plan.expiresAt;
    return <section className="server-dashboard" data-section={tab} aria-label="Server dashboard"><div className="dashboard-header"><div><Server size={19}/><strong>{session.profile.name}</strong><span className={`session-dot ${session.status}`}/><span>{session.profile.username}@{session.profile.host}</span></div><button className="secondary-button" onClick={() => void window.vps!.diagnostics.export().then(r => { if (!r.ok)
        setError(r.error.message);
    else if (r.value.saved)
        setNotice('Sanitized diagnostics exported.'); })} aria-label="Export diagnostics">Diagnostics</button><button className="secondary-button" onClick={onClose}><ArrowLeft size={14}/>Back to workspace</button></div>
    <div className="dashboard-layout" inert={Boolean(plan)}>    <nav className="dashboard-nav" aria-label="Server navigation"><div role="tablist" aria-orientation="vertical" aria-label="Main server sections"><button role="tab" aria-selected={tab === 'projects'} onClick={() => setTab('projects')}><Globe size={15}/>Websites</button><button onClick={() => onFiles('/var/www')}><FolderOpen size={15}/>Files</button><button role="tab" aria-selected={tab === 'overview'} onClick={() => setTab('overview')}><HardDrive size={15}/>Storage</button><button onClick={() => window.dispatchEvent(new Event('rootpath:logs-open'))}><History size={15}/>Activity</button></div><button className="secondary-button" onClick={() => setTab('development')}>GitHub &amp; code</button><details className="dashboard-advanced"><summary><Settings size={15}/>Advanced</summary><div role="tablist" aria-orientation="vertical" aria-label="Advanced server sections">{([['processes', 'Processes', List], ['services', 'Services & logs', Server], ['applications', 'Applications', Server], ['hosting', 'Nginx & HTTPS', Server], ['databases', 'Databases & backups', HardDrive], ['history', 'Operation history', History]] as const).map(([key, label, Icon]) => <button role="tab" aria-selected={tab === key} key={key} onClick={() => setTab(key)}><Icon size={15}/>{label}</button>)}</div></details></nav><div className="dashboard-body"><div className="dashboard-title"><div><h1>Server overview</h1><p>{caps ? `${caps.distribution} · ${caps.architecture} · ${caps.hostname}` : 'Detecting Linux capabilities…'}</p></div><div className="dashboard-power"><button className="secondary-button" disabled={!canManage || actionBusy} onClick={() => void prepare('reboot')}><RefreshCw size={14}/>Reboot</button><button className="secondary-button danger-text" disabled={!canManage || actionBusy} onClick={() => void prepare('shutdown')}><Power size={14}/>Shut down</button></div></div>

    {!connected && <div className="connection-warning" role="alert">Disconnected. Values are stale and actions are disabled. Return to connection details to reconnect.</div>}
    {caps && !caps.linux && <div className="connection-warning">This dashboard supports Linux. This server reports {caps.os}. File browsing and terminal access remain available.</div>}
    {caps?.linux && !caps.managed && <div className="connection-warning">This distribution is read only. Management supports Ubuntu/Debian and Rocky/Alma/RHEL families.</div>}
    {probeError && <div className="connection-error" role="alert">{probeError}<button aria-label="Dismiss monitoring error" onClick={() => setProbeError('')}><X size={14}/></button></div>}
    {error && <div className="connection-error" role="alert">{error}<button aria-label="Dismiss dashboard error" onClick={() => setError('')}><X size={14}/></button></div>}
    {notice && <div className="dashboard-notice" role="status">{notice}<button aria-label="Dismiss dashboard notice" onClick={() => setNotice('')}>×</button></div>}

    <div className="dashboard-toolbar" hidden={['applications', 'hosting', 'databases', 'projects', 'development'].includes(tab)}>{tab !== 'overview' && <label className="dashboard-filter"><Search size={14}/><input aria-label="Filter dashboard entries" placeholder={tab === 'services' ? 'Filter services…' : tab === 'history' ? 'Search operations…' : 'Filter processes…'} value={query} onChange={e => setQuery(e.target.value)}/></label>}{tab === 'history' ? <label><input type="checkbox" checked={allHistory} onChange={e => setAllHistory(e.target.checked)}/>All sessions</label> : <><button className="secondary-button" disabled={!connected || loading || !caps} onClick={() => setRefresh(v => v + 1)}><RefreshCw size={13} className={loading ? 'spinning' : ''}/>{loading ? 'Refreshing…' : 'Refresh'}</button>{tab !== 'services' && <label><input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)}/>Refresh every 5 seconds</label>}</>}<span>{connected ? 'SSH connected' : 'Disconnected'}{metrics && tab === 'overview' ? ` · Last sample ${new Date(metrics.sampledAt).toLocaleTimeString()} · Probe ${metrics.probeMs} ms` : ''}</span></div>
    {tab === 'overview' && metrics && now - new Date(metrics.sampledAt).getTime() > 15000 && <div className="connection-warning">Displayed metrics are stale. Refresh or reconnect before relying on them.</div>}
    {tab === 'development' && <DevelopmentPanel session={session} onClose={() => setTab('projects')}/>}
    {tab === 'overview' && <>{caps && !caps.metrics ? <div className="dashboard-empty">Linux /proc metrics are unavailable on this server.</div> : !metrics ? <div className="dashboard-empty">{loading ? 'Reading server metrics…' : 'Refresh to read metrics.'}</div> : <><div className="metric-cards"><Metric icon={<Cpu size={20}/>} label="CPU usage" value={percent(metrics.cpuPercent)} note="Counter delta · first sample warms up"/><Metric icon={<Activity size={20}/>} label="Memory used" value={percent(metrics.memory.percent)} note={`${humanSize(metrics.memory.used)} of ${humanSize(metrics.memory.total)}${metrics.memory.estimatedAvailable ? ' · estimated' : ''}`}/><Metric icon={<HardDrive size={20}/>} label="Swap used" value={humanSize(metrics.memory.swapUsed)} note={`${humanSize(metrics.memory.swapTotal)} total`}/><Metric icon={<ShieldCheck size={20}/>} label="Uptime" value={uptime(metrics.uptime)} note={`Load averages: ${metrics.load.map(v => v?.toFixed(2) ?? '—').join(' / ')}`}/></div>
      <div className="dashboard-grid"><StorageCard key={session.id} sessionId={session.id} connected={connected} disks={metrics.disks} onFiles={onFiles}/><section className="dashboard-card"><h2>Network activity</h2><table><thead><tr><th>Interface</th><th>Receive</th><th>Send</th></tr></thead><tbody>{metrics.interfaces.map(n => <tr key={n.name}><td>{n.name}</td><td>{rate(n.rxPerSecond)}</td><td>{rate(n.txPerSecond)}</td></tr>)}</tbody></table>{!metrics.interfaces.length && <p>Network counters are unavailable.</p>}</section></div><div className="dashboard-card system-info"><h2>System information</h2><dl><dt>Kernel</dt><dd>{caps?.kernel}</dd><dt>Connected account</dt><dd>{session.profile.username} · UID {caps?.uid ?? 'unknown'}</dd><dt>Systemd</dt><dd>{caps?.services ? 'Detected and booted' : 'Not available'}</dd><dt>Journal</dt><dd>{caps?.journal ? 'Detected · access depends on account' : 'Not detected'}</dd></dl></div></>}</>}
    {tab === 'processes' && <section className="dashboard-card"><h2>Processes <small>Top 200 processes by average CPU use</small></h2>{caps && !caps.processes ? <p>The server process tool is unavailable.</p> : <div className="dashboard-table-scroll"><table><thead><tr><th>PID</th><th>Process</th><th>User</th><th>CPU</th><th>Memory</th><th>Resident</th><th>State</th></tr></thead><tbody>{visibleProcesses.map(p => <tr key={p.pid}><td>{p.pid}</td><td>{p.name}</td><td>{p.user}</td><td>{p.cpu}%</td><td>{p.memoryPercent}%</td><td>{humanSize(p.rss)}</td><td>{p.state}</td></tr>)}</tbody></table>{!visibleProcesses.length && <p>No visible matching processes.</p>}</div>}</section>}
    {tab === 'services' && <>{!caps?.services ? <div className="dashboard-empty">A running systemd manager was not detected. File and terminal tools remain available.</div> : <div className="service-layout"><section className="dashboard-card service-list"><h2>Service units <small>{services.length} discovered · maximum 5,000</small></h2>{visibleServices.slice(page * 100, (page + 1) * 100).map(s => <button key={s.unit} className={selected === s.unit ? 'selected' : ''} onClick={() => void inspect(s.unit)}><span className={`service-dot ${s.active}`}/><span><strong>{s.unit}</strong><small>{s.description}</small></span><b>{s.active}</b></button>)}{!visibleServices.length && <p>No matching units. Refresh to discover services.</p>}<Pagination page={page} count={visibleServices.length} onPage={setPage}/></section><section className="dashboard-card service-detail"><h2>{selected || 'Select a service'}</h2>{detailBusy ? <p>Reading service details and recent journal…</p> : details ? <><dl>{Object.entries(details).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl><div className="service-buttons">{(['start', 'stop', 'restart'] as const).map(action => <button className="secondary-button" key={action} disabled={!canManage || actionBusy} onClick={() => void prepare(action, selected!)}>{labels[action]}</button>)}<button className="secondary-button" disabled={!connected} onClick={() => void inspect(selected!)}>Refresh details & logs</button></div></> : <p>Choose a unit to inspect its state, then review an action.</p>}<h3>Recent journal · last 200 entries</h3><p>{logWarning}</p><pre aria-label="Service journal">{logs || 'No journal entries to display.'}</pre></section></div>}</>}
    {tab === 'projects' && <ProjectsPanel session={session} onFiles={onFiles}/>}
    {tab === 'applications' && <ApplicationsPanel session={session}/>}
    {tab === 'hosting' && <HostingPanel session={session}/>}
    {tab === 'databases' && <DatabasesPanel session={session}/>}
    {tab === 'history' && <section className="dashboard-card"><h2>Service and power actions <small>Recent actions in this session</small></h2>{visibleHistory.slice(page * 100, (page + 1) * 100).map(h => <article className="operation-row" key={h.id}><span className={`operation-state ${h.status}`}>{h.status}</span><div><strong>{h.action} {h.unit || h.host}</strong><p>{h.message}</p><small>{new Date(h.startedAt).toLocaleString()} · {h.server}{h.sudo ? ' · sudo requested' : ''}{h.code ? ' · ' + h.code : ''}</small></div></article>)}{!visibleHistory.length && <p>No matching service or power actions in this app run.</p>}<Pagination page={page} count={visibleHistory.length} onPage={setPage}/></section>}
    </div></div>
    {plan && <div className="modal-backdrop dashboard-modal-backdrop"><div className="modal dashboard-action" ref={modal} role="dialog" aria-modal="true" aria-label="Review server action" tabIndex={-1}><div className="modal-header"><h2>{labels[plan.action]}?</h2><button aria-label="Cancel reviewed action" disabled={actionBusy} onClick={() => void closePlan()}><X size={17}/></button></div><p className="modal-description">{power ? 'This interrupts all sessions and workloads on the server. Unsaved work can be lost. The server may stay offline until you start it through your provider.' : 'This can interrupt applications and connections that depend on the selected service. Review the target and current state.'}</p><dl className="properties-list"><div><dt>Server</dt><dd>{plan.server} · {plan.host}</dd></div><div><dt>Account</dt><dd>{plan.username}</dd></div>{plan.unit && <><div><dt>Service</dt><dd>{plan.unit}</dd></div><div><dt>Current state</dt><dd>{plan.state?.ActiveState} / {plan.state?.SubState} · PID {plan.state?.MainPID}</dd></div></>}<div><dt>Elevation</dt><dd>{caps?.uid === 0 ? 'Already connected as root' : plan.sudo ? 'sudo requested for this action' : 'Connected account permissions'}</dd></div></dl>{caps?.uid !== 0 && caps?.sudo && <label className="credential-checkbox"><input type="checkbox" checked={requestedSudo} disabled={actionBusy} onChange={e => void prepare(plan.action, plan.unit || undefined, e.target.checked)}/>Use sudo (noninteractive) for this action</label>}<p className="field-hint">No password is stored or sent to sudo. If additional authentication is required, this action fails with guidance.</p>{power && <><label className="field-label" htmlFor="power-host">Type {plan.host} to confirm</label><input id="power-host" className="text-input" value={confirmationHost} autoComplete="off" onChange={e => setConfirmationHost(e.target.value)}/></>}{actionError && <p className="form-error" role="alert">{actionError}</p>}<p className="field-hint">{expired ? 'Confirmation expired. Cancel and review a new action.' : `Confirmation valid for ${Math.max(0, Math.ceil((plan.expiresAt - now) / 1000))} seconds.`} No automatic retry after a disconnect.</p><div className="modal-actions"><button className="secondary-button" disabled={actionBusy} onClick={() => void closePlan()}>Cancel</button><button className="danger-button" disabled={actionBusy || !connected || Boolean(expired) || Boolean(power && confirmationHost !== plan.host)} onClick={() => void perform()}>{actionBusy ? 'Working…' : 'Confirm ' + plan.action}</button></div></div></div>}
  </section>;
}
function Metric({ icon, label, value, note }: {
    icon: React.ReactNode;
    label: string;
    value: string;
    note: string;
}) { return <div className="metric-card"><span>{icon}{label}</span><strong>{value}</strong><small>{note}</small></div>; }
function Pagination({ page, count, onPage }: {
    page: number;
    count: number;
    onPage: (page: number) => void;
}) { if (count <= 100)
    return null; return <div className="dashboard-pagination"><button className="secondary-button" disabled={page <= 0} onClick={() => onPage(page - 1)}>Previous page</button><span>{page * 100 + 1}–{Math.min(count, (page + 1) * 100)} of {count}</span><button className="secondary-button" disabled={(page + 1) * 100 >= count} onClick={() => onPage(page + 1)}>Next page</button></div>; }
