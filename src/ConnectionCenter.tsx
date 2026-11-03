import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, Fingerprint, KeyRound, LockKeyhole, Plus, RefreshCw, Server, ShieldAlert, ShieldCheck, Trash2, Unplug, X } from 'lucide-react';
import FileWorkspace from './FileWorkspace';
import ServerDashboard from './ServerDashboard';
import type { ConnectionSnapshot, ConnectInput, Profile, Session } from './connections';
const fresh = (): ConnectInput => ({ name: '', host: '', port: 22, username: '', authMethod: 'password', password: '', passphrase: '', useSavedSecret: false, rememberSecret: false });
const online = (s: Session) => ['connecting', 'verifying', 'connected'].includes(s.status);
const empty: ConnectionSnapshot = { profiles: [], sessions: [], secureStorageAvailable: false };
export default function ConnectionCenter() {
  const api = window.vps?.connections;
  const [dashboardSession, setDashboardSession] = useState<string | null>(null);
  const [projectPath,setProjectPath]=useState<string|undefined>();
  const [filesSession, setFilesSession] = useState<string | null>(null);
  const [state, setState] = useState<ConnectionSnapshot>(empty);
  const [form, setForm] = useState<ConnectInput>(fresh);
  const [active, setActive] = useState<string | null>(null);
  const [keyName, setKeyName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<Profile | null>(null);
  const [replace, setReplace] = useState(false);
  const [challengeBusy, setChallengeBusy] = useState(false);
  const hostDialog = useRef<HTMLDivElement>(null);
  const removalDialog = useRef<HTMLDivElement>(null);
  const activeSession = state.sessions.find(s => s.id === active);
  const pending = state.sessions.find(s => s.status === 'verifying' && s.challenge);
  const selectedProfile = state.profiles.find(p => p.id === form.profileId);
  const connected = state.sessions.filter(s => s.status === 'connected').length;
  useEffect(() => {
    if (!api) return;
    let mounted = true, received = false;
    const unsubscribe = api.subscribe(snapshot => { received = true; if (mounted) setState(snapshot); });
    void api.snapshot().then(result => { if (!mounted) return; if (result.ok) { if (!received) setState(result.value); } else setError(result.error.message); });
    return () => { mounted = false; unsubscribe(); };
  }, [api]);
  useEffect(() => { setReplace(false); setChallengeBusy(false); hostDialog.current?.focus(); }, [pending?.challenge?.id]);
  useEffect(() => { if (confirmation) removalDialog.current?.focus(); }, [confirmation?.id]);
  useEffect(() => {
    if (!pending && !confirmation) return;
    const element = pending ? hostDialog.current : removalDialog.current;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); if (pending) void decide(false); else setConfirmation(null); }
      if (event.key !== 'Tab') return;
      const nodes = element?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)');
      if (!nodes?.length) return;
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === element)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', handler); return () => document.removeEventListener('keydown', handler);
  });
  const update = (patch: Partial<ConnectInput>) => { setForm(f => ({ ...f, ...patch })); setError(''); };
  function loadProfile(profile: Profile) {
    setForm({ name: profile.name, host: profile.host, port: profile.port, username: profile.username, authMethod: profile.authMethod, profileId: profile.id, useSavedSecret: profile.hasSecret, rememberSecret: profile.hasSecret, password: '', passphrase: '' });
    setKeyName(''); setError(''); setActive(null);
  }
  async function connect() {
    if (!api || busy) return;
    if(/^[^:]+:[0-9]+$/.test(form.host.trim())){setError('Enter only the IP address or hostname. Put the SSH port in the separate Port field.');return;}
    setError(''); setBusy(true);
    try {
      const result = await api.connect(form);
      setForm(f => ({ ...f, password: '', passphrase: '' }));
      if (result.ok) { setActive(result.value.id); setForm(fresh()); setKeyName(''); }
      else setError(result.error.message);
    } catch { setError('The desktop connection service is unavailable. Restart the app and try again.'); }
    finally { setBusy(false); }
  }
  async function chooseKey() {
    if (!api) return;
    const result = await api.chooseKey();
    if (result.ok && result.value) { update({ keyId: result.value.id, useSavedSecret: false }); setKeyName(result.value.name); }
    else if (!result.ok) setError(result.error.message);
  }
  async function decide(accept: boolean) {
    if (!api || !pending?.challenge || challengeBusy) return;
    setChallengeBusy(true); setError('');
    try { const result = await api.decideHost({ sessionId: pending.id, challengeId: pending.challenge.id, accept, replace }); if (!result.ok) setError(result.error.message); }
    catch { setError('Host verification could not be completed. Disconnect and try again.'); }
    finally { setChallengeBusy(false); }
  }
  async function disconnect(session: Session) { const result = await api?.disconnect(session.id); if (result && !result.ok) setError(result.error.message); }
  async function forget(profile: Profile) {
    const result = await api?.forgetSecret(profile.id);
    if (result && !result.ok) setError(result.error.message);
    else update({ useSavedSecret: false, rememberSecret: false });
  }
  async function remove() {
    if (!confirmation) return;
    const result = await api?.removeProfile(confirmation.id);
    if (result && !result.ok) setError(result.error.message);
    else { if (form.profileId === confirmation.id) { setForm(fresh()); setActive(null); } setConfirmation(null); }
  }
  return <section className="connections-layer" data-view={dashboardSession?'dashboard':filesSession?'files':'connections'} aria-label="SSH connection workspace">
    <div className="connection-layout" inert={Boolean(filesSession || dashboardSession)}>
      <aside className="connection-sidebar"><div className="sidebar-label">SAVED SERVERS <span>{state.profiles.length}</span></div><button className="primary-button new-connection" onClick={() => { setForm(fresh()); setKeyName(''); setActive(null); setError(''); }}><Plus size={15}/>New connection</button>
        {!state.profiles.length && <p className="connection-empty">Your servers will appear here after a successful connection.</p>}
        <div className="saved-profiles">{state.profiles.map(profile => <button key={profile.id} className={form.profileId === profile.id && !active ? 'selected' : ''} onClick={() => loadProfile(profile)}><Server size={17}/><span><strong>{profile.name}</strong><small>{profile.username}@{profile.host}:{profile.port}</small><small>{profile.hasSecret ? 'Encrypted credential saved' : 'Credential not saved'}{profile.lastConnectedAt ? ` · ${new Date(profile.lastConnectedAt).toLocaleDateString()}` : ''}</small></span></button>)}</div>
        <div className="connection-sidebar-bottom"><LockKeyhole size={18}/><p>Credentials stay on this computer.<br/>{state.secureStorageAvailable ? 'OS-backed encryption available.' : 'Credential saving unavailable.'}</p></div>
      </aside>
      <div className="connection-main"><div className="connection-heading"><h1>{activeSession ? activeSession.profile.name : selectedProfile ? 'Reconnect to your server' : 'Connect to a server'}</h1><p>{activeSession ? `${activeSession.profile.username}@${activeSession.profile.host}:${activeSession.profile.port}` : 'Enter your server details to connect securely.'}</p><span className="connection-summary">{connected} connected · {state.sessions.filter(online).length} active / 8</span></div>
        {!api && <div className="connection-warning">Server access requires the Rootpath desktop app.</div>}
        {error && <div className="connection-error" role="alert">{error}<button aria-label="Dismiss connection error" onClick={() => setError('')}><X size={14}/></button></div>}
        <div className="connection-main-scroll">
        {state.sessions.length > 0 && <div className="session-tabs" role="tablist" aria-label="SSH sessions">{[...state.sessions].reverse().map(session => <button key={session.id} role="tab" aria-selected={session.id === active} onClick={() => { setActive(session.id); setError(''); }}><span className={`session-dot ${session.status}`}/>{session.profile.name}<small>{session.status}</small></button>)}</div>}
        {activeSession ? <article className="session-card"><div className={`session-status-icon ${activeSession.status}`}>{activeSession.status === 'connected' ? <ShieldCheck size={30}/> : activeSession.status === 'verifying' ? <Fingerprint size={30}/> : <Server size={30}/>}</div><span className={`connection-state ${activeSession.status}`}>{activeSession.status.toUpperCase()}</span><h2>{activeSession.message}</h2>{activeSession.warning && <div className="connection-warning">{activeSession.warning}</div>}
          <details className="session-details"><summary>Connection details</summary><dl className="properties-list">{Object.entries({ Host: activeSession.profile.host, Port: activeSession.profile.port, Username: activeSession.profile.username, Authentication: activeSession.profile.authMethod === 'key' ? 'SSH private key' : 'Password', Fingerprint: activeSession.fingerprint || 'Awaiting handshake', 'Connected at': activeSession.connectedAt ? new Date(activeSession.connectedAt).toLocaleString() : '—' }).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl></details>
          <div className="session-actions">{activeSession.status === 'connected' && <button className="primary-button" onClick={() => setFilesSession(activeSession.id)}>Browse server files</button>}{activeSession.status === 'connected' && <button className="secondary-button" onClick={() => setDashboardSession(activeSession.id)}>Server dashboard</button>}{online(activeSession) ? <button className="secondary-button" onClick={() => disconnect(activeSession)}><Unplug size={15}/>{activeSession.status === 'connected' ? 'Disconnect' : 'Cancel connection'}</button> : <button className="primary-button" onClick={() => { const saved = state.profiles.find(p => p.id === activeSession.profile.id); loadProfile(saved || activeSession.profile); if (!saved) setForm(f => ({ ...f, profileId: undefined })); }}><RefreshCw size={15}/>Reconnect</button>}<button className="secondary-button" onClick={() => { setActive(null); setForm(fresh()); setError(''); }}>Another server</button></div>

        </article> : <form className="ssh-form" onSubmit={event => { event.preventDefault(); void connect(); }}>
          <div className="connection-fields">
            <div><label className="field-label" htmlFor="server-name">Server name</label><input id="server-name" className="text-input" required maxLength={80} value={form.name} onChange={e=>update({name:e.target.value})} placeholder="My VPS" autoComplete="off"/></div>
            <div><label className="field-label" htmlFor="ssh-username">Username</label><input id="ssh-username" className="text-input" required maxLength={128} disabled={Boolean(selectedProfile)} value={form.username} onChange={e=>update({username:e.target.value})} autoComplete="off"/></div>
            <div className="connection-endpoint"><div><label className="field-label" htmlFor="ssh-host">IP address or hostname</label><input id="ssh-host" className="text-input" required disabled={Boolean(selectedProfile)} value={form.host} onChange={e=>update({host:e.target.value})} placeholder="203.0.113.10" autoComplete="off" aria-describedby="ssh-host-hint"/><small id="ssh-host-hint" className="field-hint">Address only. Set the SSH port separately.</small></div><div><label className="field-label" htmlFor="ssh-port">Port</label><input id="ssh-port" className="text-input" type="number" required min={1} max={65535} disabled={Boolean(selectedProfile)} value={form.port} onChange={e=>update({port:Number(e.target.value)})}/></div></div>
          </div>
          <fieldset className="auth-method"><legend>Authentication</legend><label><input type="radio" name="authentication" checked={form.authMethod === 'password'} disabled={Boolean(selectedProfile)} onChange={() => update({ authMethod: 'password', keyId: undefined, passphrase: '' })}/><LockKeyhole size={15}/>Password</label><label><input type="radio" name="authentication" checked={form.authMethod === 'key'} disabled={Boolean(selectedProfile)} onChange={() => update({ authMethod: 'key', password: '' })}/><KeyRound size={15}/>SSH key</label></fieldset>
          {selectedProfile?.hasSecret && <label className="credential-checkbox"><input type="checkbox" checked={form.useSavedSecret} onChange={e => update({ useSavedSecret: e.target.checked })}/>Use the encrypted saved credential</label>}
          {!form.useSavedSecret && (form.authMethod === 'password' ? <><label className="field-label" htmlFor="ssh-password">Password</label><input id="ssh-password" className="text-input" type="password" required value={form.password || ''} onChange={e => update({ password: e.target.value })} autoComplete="off"/></> : <><label className="field-label">Private-key file</label><button type="button" className="key-picker" disabled={!api} onClick={chooseKey}><KeyRound size={16}/>{keyName || 'Choose an OpenSSH or PEM private key…'}</button><label className="field-label" htmlFor="ssh-passphrase">Key passphrase (if encrypted)</label><input id="ssh-passphrase" className="text-input" type="password" value={form.passphrase || ''} onChange={e => update({ passphrase: e.target.value })} autoComplete="off"/></>)}
          <label className="credential-checkbox"><input type="checkbox" checked={form.rememberSecret} disabled={!state.secureStorageAvailable} onChange={e => update({ rememberSecret: e.target.checked })}/>Remember credential using OS-backed encryption</label><p className="field-hint">{state.secureStorageAvailable ? 'Optional. Connection details are saved after authentication. Credentials are never stored as plain text.' : 'You can connect without saving a credential. Secure storage must be available to remember one.'}</p>
          <div className="ssh-form-actions">{selectedProfile && <><button type="button" className="text-button danger-text" onClick={() => setConfirmation(selectedProfile)}><Trash2 size={14}/>Remove server</button>{selectedProfile.hasSecret && <button type="button" className="text-button" onClick={() => forget(selectedProfile)}>Forget credential</button>}</>}<button className="primary-button" type="submit" disabled={!api || busy}>{busy ? 'Connecting…' : selectedProfile ? 'Reconnect' : 'Connect'}<ArrowLeft size={14} style={{ transform: 'rotate(180deg)' }}/></button></div>
        </form>}
        </div>
      </div>
    </div>
    {filesSession && state.sessions.find(s => s.id === filesSession) && <FileWorkspace initialPath={projectPath} session={state.sessions.find(s => s.id === filesSession)!} covered={Boolean(dashboardSession)} onDashboard={() => setDashboardSession(filesSession)} onClose={() => setFilesSession(null)}/>}
    {dashboardSession && state.sessions.find(s => s.id === dashboardSession) && <ServerDashboard key={dashboardSession} session={state.sessions.find(s => s.id === dashboardSession)!} onClose={() => setDashboardSession(null)} onFiles={async path=>{const r=await window.vps!.workspace.confirmDiscard();if(r.ok&&r.value){setProjectPath(path);setFilesSession(dashboardSession);setDashboardSession(null);}}}/>}
    {pending?.challenge && <div className="modal-backdrop"><div className="modal host-dialog" role="dialog" aria-modal="true" aria-labelledby="host-title" tabIndex={-1} ref={hostDialog}><div className="host-icon">{pending.challenge.changed ? <ShieldAlert size={30}/> : <Fingerprint size={30}/>}</div><h2 id="host-title">{pending.challenge.changed ? 'Server fingerprint changed' : 'Verify this server’s identity'}</h2><p className="modal-description">{pending.profile.host}:{pending.profile.port} · {pending.profile.username}</p><p className="modal-description">{pending.challenge.changed ? 'The server presented a different host key. This can mean the server was rebuilt or the connection is being intercepted. Verify the new fingerprint through a trusted source before replacing the saved key.' : 'Compare this SHA-256 fingerprint with your server provider or administrator before trusting the host. Authentication waits for your decision.'}</p>{pending.challenge.previousFingerprint && <><label className="field-label">Previously trusted fingerprint</label><code className="fingerprint previous">{pending.challenge.previousFingerprint}</code></>}<label className="field-label">Presented fingerprint</label><code className="fingerprint">{pending.challenge.fingerprint}</code>{pending.challenge.changed && <label className="credential-checkbox"><input type="checkbox" checked={replace} onChange={e => setReplace(e.target.checked)}/>I verified the change and want to replace the saved host key.</label>}<p className="field-hint">This request expires after 60 seconds. Rejecting sends no password or key authentication.</p><div className="modal-actions"><button className="secondary-button" disabled={challengeBusy} onClick={() => decide(false)}>Reject connection</button><button className="primary-button" disabled={challengeBusy || (pending.challenge.changed && !replace)} onClick={() => decide(true)}>{challengeBusy ? 'Saving…' : pending.challenge.changed ? 'Replace key & connect' : 'Trust & connect'}</button></div></div></div>}
    {confirmation && <div className="modal-backdrop"><div className="modal" role="dialog" aria-modal="true" aria-labelledby="remove-title" tabIndex={-1} ref={removalDialog}><h2 id="remove-title">Remove {confirmation.name}?</h2><p className="modal-description">This removes the saved server and encrypted credential, and disconnects its active sessions. The trusted host fingerprint is retained. Nothing on the server is deleted.</p><div className="modal-actions"><button className="secondary-button" onClick={() => setConfirmation(null)}>Cancel</button><button className="danger-button" onClick={remove}>Remove saved server</button></div></div></div>}
  </section>;
}
function FolderMessage() { return <Check size={20}/>; }
