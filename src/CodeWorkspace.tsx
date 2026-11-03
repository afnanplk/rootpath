import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { Session } from './connections';
import type { RemoteDocument } from './workspace';
import './code-workspace.css';
const TextEditor = lazy(() => import('./TextEditor'));
const Shell = lazy(() => import('./Shell'));
type Draft = { document: RemoteDocument; value: string };
type ShellTab = { key: string; path: string };
export function useCodeWorkspace(session: Session, onDownload: (path: string) => void) {
  const [drafts, setDrafts] = useState<Draft[]>([]), [shells, setShells] = useState<ShellTab[]>([]), [active, setActive] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [downloadPath, setDownloadPath] = useState('');
  const mounted = useRef(true);
  const draftRef = useRef(drafts); draftRef.current = drafts;
  const api = window.vps!.editor;
  const dirty = drafts.some(d => d.value !== d.document.text);
  useEffect(() => { mounted.current = true; const guard = (event: BeforeUnloadEvent) => { if (draftRef.current.some(d => d.value !== d.document.text)) { event.preventDefault(); event.returnValue = ''; } }; window.addEventListener('beforeunload', guard); return () => { mounted.current = false; window.removeEventListener('beforeunload', guard); for (const draft of draftRef.current) void api.close({ id: draft.document.id }); }; }, []);
  function update(id: string, value: string) { const draft = draftRef.current.find(d => d.document.id === id); if (!draft) return; setDrafts(ds => ds.map(d => d.document.id === id ? { ...d, value } : d)); void api.dirty({ id, dirty: value !== draft.document.text }); }
  async function open(path: string) {
    setError(''); setDownloadPath(''); const existing = drafts.find(d => d.document.path === path); if (existing) { setActive(existing.document.id); return; }
    setBusy(true); const result = await api.open({ sessionId: session.id, path }); if (!mounted.current) { if (result.ok) void api.close({ id: result.value.id }); return; } setBusy(false);
    if (result.ok) { setDrafts(ds => ds.some(d => d.document.id === result.value.id) ? ds : [...ds, { document: result.value, value: result.value.text }]); setActive(result.value.id); } else { setError(result.error.message); if (result.error.code === 'DOWNLOAD_INSTEAD') setDownloadPath(path); }
  }
  function terminal(path: string) { if (shells.length >= 8) { setError('Close a terminal tab before opening another.'); return; } const tab = { key: crypto.randomUUID(), path }; setShells(s => [...s, tab]); setActive(tab.key); }
  async function close(id: string) {
    const draft = drafts.find(d => d.document.id === id);
    if (draft && draft.value !== draft.document.text) { const confirmation = await window.vps!.workspace.confirmAction('discard'); if (!confirmation.ok || !confirmation.value) return; }
    if (draft) { await api.close({ id }); setDrafts(ds => ds.filter(d => d.document.id !== id)); }
    else setShells(s => s.filter(t => t.key !== id));
    setActive('');
  }
  async function action(kind: 'save' | 'reload' | 'restore', draft: Draft) {
    if (busy) return;
    if (kind !== 'save') { const confirmation = await window.vps!.workspace.confirmAction(kind); if (!confirmation.ok || !confirmation.value) return; }
    setBusy(true); setError(''); setMessage(''); const doc = draft.document;
    const result = kind === 'save' ? await api.save({ id: doc.id, text: draft.value, revision: doc.revision }) : kind === 'reload' ? await api.reload({ id: doc.id }) : await api.restore({ id: doc.id, revision: doc.revision, backupId: doc.backups[0].id });
    setBusy(false);
    if (result.ok) { setDrafts(ds => ds.map(d => d.document.id === doc.id ? { document: result.value, value: result.value.text } : d)); setMessage(kind === 'reload' ? 'Remote version loaded.' : 'Saved. Recoverable backup: ' + result.value.backups[0]?.path); }
    else setError(result.error.message);
  }
  const current = drafts.find(d => d.document.id === active);
  const panel = <section className={'code-workspace' + (active ? ' expanded' : '')} aria-label="Editor and terminal workspace">
    <div className="code-tabs"><button className={!active ? 'active' : ''} onClick={() => setActive('')}>Files</button>{drafts.map(d => <div key={d.document.id} className={active === d.document.id ? 'active' : ''}><button title={d.document.path} onClick={() => setActive(d.document.id)}>{d.document.path.split('/').pop()}{d.value !== d.document.text ? ' ●' : ''}</button><button aria-label={'Close editor ' + d.document.path} onClick={() => void close(d.document.id)}>×</button></div>)}{shells.map((t, i) => <div key={t.key} className={active === t.key ? 'active' : ''}><button onClick={() => setActive(t.key)}>Terminal {i + 1}</button><button aria-label={'Close terminal ' + (i + 1)} onClick={() => void close(t.key)}>×</button></div>)}</div>
    {error && <div className="code-message connection-error" role="alert">{error}{downloadPath && <button className="secondary-button" onClick={() => onDownload(downloadPath)}>Download file instead</button>}<button aria-label="Dismiss workspace error" onClick={() => setError('')}>×</button></div>}
    {active && current && <div className="code-document"><div className="code-toolbar"><span title={current.document.path}>{current.document.path}</span><button className="primary-button" disabled={busy || session.status !== 'connected'} onClick={() => void action('save', current)}>Save</button><button className="secondary-button" disabled={busy || session.status !== 'connected'} onClick={() => void action('reload', current)}>Reload remote</button><button className="secondary-button" onClick={() => void window.vps!.workspace.copy(current.value).then(r => r.ok ? setMessage('Draft copied.') : setError(r.error.message))}>Copy draft</button><button className="secondary-button" disabled={busy || !current.document.backups.length || session.status !== 'connected'} onClick={() => void action('restore', current)}>Restore last backup</button></div><div className="code-editor"><Suspense fallback={<p>Loading editor…</p>}><TextEditor key={current.document.id} document={current.document} value={current.value} onChange={v => update(current.document.id, v)} onSave={() => void action('save', current)} disabled={busy || session.status !== 'connected'}/></Suspense></div><div className="code-status">UTF-8{current.document.bom ? ' BOM' : ''} · {current.document.eol} · {current.value !== current.document.text ? 'Unsaved changes' : 'Saved'} · Ctrl/Cmd+F: find · Use Replace in file for replacement · Ctrl/Cmd+S: save</div>{message && <div className="code-status" role="status">{message}</div>}</div>}
    {shells.map(t => <div className="code-shell" key={t.key} hidden={active !== t.key}><Suspense fallback={<p>Loading terminal…</p>}><Shell session={session} path={t.path} visible={active === t.key}/></Suspense></div>)}
  </section>;
  return { open, terminal, panel, active: Boolean(active), dirty };
}
