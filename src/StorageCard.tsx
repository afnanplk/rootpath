import { useEffect, useRef, useState } from 'react';
import { HardDrive, ChevronDown } from 'lucide-react';
import type { Metrics } from './monitoring';
import type { ProjectStorage } from './projects';
import { humanSize } from './files';
export default function StorageCard({ sessionId, connected, disks, onFiles }: {
    sessionId: string;
    connected: boolean;
    disks: Metrics['disks'];
    onFiles: (path: string) => void;
}) {
    const [open, setOpen] = useState(false), [data, setData] = useState<ProjectStorage | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
    const alive = useRef(true), pending = useRef(false), loaded = useRef(false);
    useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
    async function scan() {
        if (pending.current || !connected)
            return;
        pending.current = true;
        setBusy(true);
        setError('');
        try {
            const r = await window.vps!.projects.storage({ sessionId });
            if (!alive.current)
                return;
            if (r.ok) {
                setData(r.value);
                loaded.current = true;
            }
            else
                setError(r.error.message);
        }
        catch {
            if (alive.current)
                setError('Could not read project storage. Reconnect and try again.');
        }
        finally {
            pending.current = false;
            if (alive.current)
                setBusy(false);
        }
    }
    function reveal() { setOpen(true); if (!loaded.current && !pending.current && !error)
        void scan(); }
    const root = disks.find(d => d.mount === '/') || disks[0];
    return <section className="dashboard-card storage-card" aria-label="Server storage">
  <h2><HardDrive size={16}/> Storage</h2>
  {root ? <><div className="storage-summary"><strong>{humanSize(root.used)} <small>used</small></strong><span>of {humanSize(root.total)} total</span></div><progress aria-label="Root disk usage" value={root.percent} max={100}/><p>{humanSize(root.available)} available · {root.percent}% used · {root.mount}</p></> : <p>Disk capacity is unavailable.</p>}
  <button className="secondary-button storage-trigger" aria-expanded={open} aria-controls="project-storage" onMouseEnter={reveal} onFocus={reveal} onClick={reveal}>Storage by project <ChevronDown size={14}/></button>
  {open && <div id="project-storage" className="project-storage"><div className="storage-actions"><strong>Project folders · /var/www</strong><button className="secondary-button" disabled={busy || !connected} onClick={() => void scan()}>{busy ? 'Scanning…' : 'Refresh sizes'}</button><button className="secondary-button" onClick={() => setOpen(false)}>Hide breakdown</button></div>
   <p>Includes dependencies, media and hidden files in each folder. Databases, containers and logs stored elsewhere are not included. Symlinks are skipped.</p>
   {busy && <p role="status">Scanning with your account’s permissions. Large scans may show partial results.</p>}
   {error && <p role="alert" className="form-error">{error}</p>}
   {data && <><p>{new Date(data.scannedAt).toLocaleString()} · account {data.account}{!connected ? ' · Disconnected; saved sample' : ''}</p>{data.warnings.map((w, i) => <p key={i}>{w}</p>)}<div className="dashboard-table-scroll"><table aria-label="Storage used by each project"><thead><tr><th>Project / owner</th><th>Storage used</th><th>Files</th></tr></thead><tbody>{data.projects.map(p => <tr key={p.directory}><td><strong>{p.name}</strong><small>{p.directory}<br />Owner: {p.owner} · UID {p.uid}</small></td><td>{p.bytes === null ? 'Unavailable' : `${p.partial ? 'At least ' : ''}${humanSize(p.bytes)}`}<small>{p.partial ? 'Partial · ' : ''}{p.warnings.join('; ')}</small></td><td><button className="secondary-button" disabled={!connected} onClick={() => onFiles(p.directory)}>Open files</button></td></tr>)}</tbody></table></div>{!data.projects.length && <p>No readable project directories found under /var/www. Check the discovery warnings; an empty list does not establish that the server has no projects.</p>}<p>Folder owners are shown below. A root-owned folder may still be readable by your account.</p></>}
  </div>}
  <details className="storage-mounts"><summary>Filesystems</summary>{disks.map(d => <div className="disk-row" key={d.device + d.mount}><div><strong>{d.mount}</strong><span>{d.device}</span><b>{d.percent}%</b></div><progress value={d.percent} max={100}/><small>{humanSize(d.used)} used / {humanSize(d.total)} total · {humanSize(d.available)} available</small></div>)}<p>Mount capacities are listed separately to avoid counting the same filesystem twice.</p></details>
 </section>;
}
