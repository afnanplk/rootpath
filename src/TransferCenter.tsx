import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { ArrowDownToLine, Check, ChevronDown, LoaderCircle, RefreshCw, X } from 'lucide-react';
import type { Session } from './connections';
import type { FileEntry } from './files';
import { humanSize } from './files';
import type { TransferGrant, TransferJob, TransferKind, TransferRequest } from './transfers';
import './transfers.css';
export type TransferAction = 'upload-files' | 'upload-folder' | 'upload-selected' | 'download' | 'copy' | 'move';
export type PaneLocation = { path: string; rootId?: string };
type Review = { request: TransferRequest; sources: string[]; destination: string; editable: boolean };
const running = ['queued', 'scanning', 'running', 'conflict'];
const names: Record<TransferKind, string> = { upload: 'Upload', download: 'Download', copy: 'Copy on server', move: 'Move on server' };
export function useTransferCenter(session: Session, remote: PaneLocation | null) {
  const api = window.vps!.transfers;
  const [jobs, setJobs] = useState<TransferJob[]>([]), [review, setReview] = useState<Review | null>(null), [error, setError] = useState(''), [preparing, setPreparing] = useState(false), [expanded, setExpanded] = useState(false), [destination, setDestination] = useState(''), [busy, setBusy] = useState(false), [applyAll, setApplyAll] = useState(false), [refreshToken, setRefreshToken] = useState(0);
  const previous = useRef(new Map<string, string>());
  const conflictJob = jobs.find(job => job.status === 'conflict' && job.conflict);
  useEffect(() => {
    let mounted = true, received = false;
    const update = (next: TransferJob[]) => {
      if (!mounted) return;
      if (next.some(job => job.sessionId === session.id && previous.current.has(job.id) && running.includes(previous.current.get(job.id)!) && !running.includes(job.status))) setRefreshToken(v => v + 1);
      previous.current = new Map(next.map(job => [job.id, job.status])); setJobs(next);
    };
    const unsubscribe = api.subscribe(next => { received = true; update(next); });
    void api.snapshot().then(result => { if (!result.ok) setError(result.error.message); else if (!received) update(result.value); });
    return () => { mounted = false; unsubscribe(); };
  }, [api, session.id]);
  useEffect(() => { setApplyAll(false); if (conflictJob) setExpanded(true); }, [conflictJob?.conflict?.id]);
  useEffect(() => { const ids = [review?.request.sourceGrant, review?.request.destinationGrant].filter((id): id is string => Boolean(id)); return () => { if (ids.length) void api.discardSelections(ids); }; }, [review?.request.sourceGrant, review?.request.destinationGrant]);
  function propose(request: TransferRequest, sources: string[], target: string, editable = false) { setReview({ request, sources, destination: target, editable }); setDestination(target); setError(''); }
  async function checkedGrant(result: Awaited<ReturnType<typeof api.chooseUpload>>): Promise<TransferGrant | null> { if (!result.ok) { setError(result.error.message); return null; } return result.value; }
  async function action(kind: TransferAction, entries: FileEntry[], location: PaneLocation, explicitTarget?: PaneLocation) {
    if (preparing) return; setPreparing(true); setError('');
    try {
      if (kind === 'upload-files' || kind === 'upload-folder' || kind === 'upload-selected') {
        if (!remote) { setError('Wait for the remote folder to finish loading.'); return; }
        const grant = await checkedGrant(kind === 'upload-selected' ? await api.grantLocal({ rootId: location.rootId!, paths: entries.map(e => e.path) }) : await api.chooseUpload(kind === 'upload-folder' ? 'folder' : 'files'));
        if (grant) propose({ sessionId: session.id, kind: 'upload', sourceGrant: grant.id, destination: remote.path }, grant.paths, remote.path);
      } else if (kind === 'download') {
        const grant = await checkedGrant(explicitTarget ? await api.grantLocalDestination({ rootId: explicitTarget.rootId!, path: explicitTarget.path }) : await api.chooseDestination());
        if (grant) propose({ sessionId: session.id, kind, sources: entries.map(e => e.path), destinationGrant: grant.id, destination: grant.paths[0] }, entries.map(e => e.path), grant.paths[0]);
      } else propose({ sessionId: session.id, kind, sources: entries.map(e => e.path), destination: explicitTarget?.path || location.path }, entries.map(e => e.path), explicitTarget?.path || location.path, true);
    } catch { setError('The transfer selection could not be prepared. Check the connection and choose it again.'); }
    finally { setPreparing(false); }
  }
  async function drop(event: DragEvent, target: PaneLocation, isLocal: boolean) {
    event.preventDefault(); event.stopPropagation(); setError('');
    try {
      const payload = event.dataTransfer.getData('application/x-vps-explorer-entries');
      if (payload) {
        const source = JSON.parse(payload);
        if (!Array.isArray(source.paths) || source.paths.some((p: unknown) => typeof p !== 'string')) { setError('Invalid dropped selection.'); return; }
        if (source.sessionId !== session.id) { setError('Transfers between different servers are not supported yet.'); return; }
        const entries = source.paths.map((path: string) => ({ path })) as FileEntry[];
        if (isLocal && source.side === 'remote') await action('download', entries, { path: '' }, target);
        else if (!isLocal && source.side === 'local') {
          const grant = await checkedGrant(await api.grantLocal({ rootId: source.rootId, paths: source.paths }));
          if (grant) propose({ sessionId: session.id, kind: 'upload', sourceGrant: grant.id, destination: target.path }, grant.paths, target.path);
        } else if (!isLocal && source.side === 'remote') await action(event.shiftKey ? 'move' : 'copy', entries, { path: target.path }, target);
        else setError('Drop local files on the remote pane to upload them.');
      } else if (!isLocal && event.dataTransfer.files.length) {
        const grant = await checkedGrant(await api.dropFiles(Array.from(event.dataTransfer.files)));
        if (grant) propose({ sessionId: session.id, kind: 'upload', sourceGrant: grant.id, destination: target.path }, grant.paths, target.path);
      } else setError('Drop files from your computer on the remote pane, or server entries on the local pane.');
    } catch { setError('The dropped selection could not be prepared. Use the upload or download buttons.'); }
  }
  async function enqueue() {
    if (!review || busy) return; setBusy(true); setError('');
    try { const result = await api.enqueue({ ...review.request, destination }); if (!result.ok) setError(result.error.message); else { setReview(null); setExpanded(true); } }
    finally { setBusy(false); }
  }
  async function cancel(id: string) { const result = await api.cancel(id); if (!result.ok) setError(result.error.message); }
  async function retry(id: string) { const result = await api.retry({ id, sessionId: session.id }); if (!result.ok) setError(result.error.message); else setExpanded(true); }
  async function resolve(choice: string) { if (!conflictJob?.conflict || busy) return; setBusy(true); const result = await api.resolve({ id: conflictJob.id, conflictId: conflictJob.conflict.id, choice, applyAll }); if (!result.ok) setError(result.error.message); setBusy(false); }
  const activeCount = jobs.filter(job => running.includes(job.status)).length;
  const queue = <><div className="transfer-queue-bar" hidden={!jobs.length&&!preparing}><button onClick={() => setExpanded(v => !v)}><ArrowDownToLine size={14}/>Transfers<span className="count-badge">{activeCount} active · {jobs.length} total</span><ChevronDown size={13} style={{ transform: expanded ? 'rotate(180deg)' : '' }}/></button><span>{preparing ? 'Preparing selection…' : 'File data streams directly between this computer and your server.'}</span></div>
    {expanded && <section className="transfer-queue-drawer" aria-label="Transfer queue"><div className="transfer-drawer-title"><strong>Transfer queue</strong><span>Two jobs at once · one per server session</span><button onClick={() => api.clearFinished()}>Clear finished</button><button aria-label="Close transfer queue" onClick={() => setExpanded(false)}><X size={15}/></button></div>{!jobs.length && <p className="transfer-empty">Upload, download, or right-click a server item to copy or move it.</p>}{[...jobs].reverse().map(job => <article className="transfer-job" key={job.id} data-testid={`transfer-${job.id}`}><div className="transfer-job-heading"><strong>{names[job.kind]} <span>· {job.server}</span></strong><span className={`transfer-status ${job.status}`}>{job.status}</span>{running.includes(job.status) ? <button aria-label={`Cancel ${job.id}`} onClick={() => cancel(job.id)}>Cancel</button> : ['failed', 'cancelled'].includes(job.status) ? <button disabled={session.status !== 'connected'} aria-label={`Retry ${job.id}`} onClick={() => retry(job.id)}><RefreshCw size={12}/>Retry</button> : <Check size={13}/>}</div><div className="transfer-path" title={job.sources.join(', ')}>{job.sources.join(', ')} <span>→</span> {job.destination}</div><progress aria-label={`Progress ${job.id}`} max={100} value={job.status === 'completed' ? 100 : job.bytesTotal ? Math.min(100, (job.bytesDone + job.bytesSkipped) * 100 / job.bytesTotal) : 0}/><div className="transfer-job-stats"><span>{humanSize(job.bytesDone)} / {humanSize(job.bytesTotal)} · {job.filesDone}/{job.filesTotal} {job.kind === 'move' ? 'items' : 'files'} · {job.skipped} skipped</span><span>{job.status === 'running' && job.startedAt ? humanSize(job.bytesDone / Math.max(1, (Date.now() - job.startedAt) / 1000)) + '/s' : ''}</span></div><p className={job.status === 'failed' ? 'danger-text' : ''}>{job.message}</p>{job.current && <div className="transfer-path">{job.current}</div>}{job.warnings.length > 0 && <details><summary>{job.warnings.length} warning(s)</summary>{job.warnings.map((message, i) => <p key={i}>{message}</p>)}</details>}</article>)}</section>}
    {error && <div className="transfer-global-error" role="alert">{error}<button aria-label="Dismiss transfer error" onClick={() => setError('')}><X size={14}/></button></div>}
    {review && <TransferModal title={`${names[review.request.kind]} — review transfer`} onClose={() => { if (!busy) setReview(null); }}><div className="transfer-review-sources"><span className="field-label">Selected sources</span>{review.sources.map(source => <code key={source}>{source}</code>)}</div><label className="field-label" htmlFor="transfer-destination">Destination folder</label>{review.editable ? <input className="text-input" id="transfer-destination" value={destination} onChange={e => setDestination(e.target.value)}/> : <code className="modal-context">{review.destination}</code>}<p className="field-hint">{review.request.kind === 'move' ? 'Moves rename the selected items. Completed moves remain in the destination if a later item fails. Cross-filesystem moves may be unsupported.' : 'Folders transfer recursively. Symbolic links and special files are skipped and reported. Existing files wait for your overwrite choice. Completed files remain after cancellation.'}</p><div className="modal-actions"><button className="secondary-button" disabled={busy} onClick={() => setReview(null)}>Cancel</button><button className="primary-button" disabled={busy || !destination.startsWith('/') && review.editable || session.status !== 'connected'} onClick={enqueue}>{busy ? 'Queueing…' : 'Add to queue'}</button></div></TransferModal>}
    {conflictJob?.conflict && <TransferModal key={conflictJob.conflict.id} title="This destination already exists" onClose={() => cancel(conflictJob.id)}><span className="status-badge">OVERWRITE CHOICE</span><code className="modal-context">{conflictJob.conflict.path}</code><p className="modal-description">Source: {conflictJob.conflict.sourceKind} · Destination: {conflictJob.conflict.destinationKind}. Choose how to proceed. Folder merging combines contents and asks again about file collisions.</p><label className="credential-checkbox"><input type="checkbox" checked={applyAll} onChange={e => setApplyAll(e.target.checked)}/>Apply this choice to matching conflicts in this job</label><div className="modal-actions"><button className="secondary-button" disabled={busy} onClick={() => cancel(conflictJob.id)}>Cancel transfer</button>{conflictJob.conflict.choices.map(choice => <button className={choice === 'replace' || choice === 'merge' ? 'primary-button' : 'secondary-button'} disabled={busy} key={choice} onClick={() => resolve(choice)}>{choice === 'keep-both' ? 'Keep both' : choice === 'replace' ? 'Replace file' : choice === 'merge' ? 'Merge folders' : 'Skip'}</button>)}</div></TransferModal>}
  </>;
  return { jobs, queue, action, drop, refreshToken, preparing, mutationBusy: jobs.some(job => job.sessionId === session.id && ['running', 'scanning', 'conflict'].includes(job.status)) };
}
function TransferModal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose); onCloseRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement; ref.current?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onCloseRef.current(); }
      if (event.key !== 'Tab') return;
      const nodes = ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)'); if (!nodes?.length) return;
      if (event.shiftKey && (document.activeElement === nodes[0] || document.activeElement === ref.current)) { event.preventDefault(); nodes[nodes.length - 1].focus(); }
      if (!event.shiftKey && document.activeElement === nodes[nodes.length - 1]) { event.preventDefault(); nodes[0].focus(); }
    };
    document.addEventListener('keydown', handler); return () => { document.removeEventListener('keydown', handler); previous?.focus(); };
  }, []);
  return <div className="modal-backdrop transfer-backdrop"><div className="modal transfer-modal" ref={ref} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}><div className="modal-header"><h2>{title}</h2><button aria-label="Close transfer dialog" onClick={onClose}><X size={17}/></button></div>{children}</div></div>;
}
