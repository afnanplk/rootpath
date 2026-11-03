import { useEffect, useState } from 'react';
import type { GitHubConnection } from './development';
export default function GitHubPanel() {
    const api = window.vps!.github;
    const [state, setState] = useState<GitHubConnection | null>(null), [token, setToken] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
    useEffect(() => { let live = true; void api.snapshot().then(r => { if (live) {
        if (r.ok)
            setState(r.value);
        else
            setError(r.error.message);
    } }); return () => { live = false; }; }, []);
    async function connect() { const value = token.trim(); setToken(''); setBusy(true); setError(''); const r = await api.connectToken({ token: value }); setBusy(false); if (r.ok)
        setState(r.value);
    else
        setError(r.error.message); }
    async function disconnect() { setBusy(true); setError(''); const r = await api.disconnect(); setBusy(false); if (r.ok)
        setState(r.value);
    else
        setError(r.error.message); }
    return <section className="dashboard-card github-connection" aria-label="GitHub connection"><h2>Connect GitHub</h2><p>{state?.connected ? `Connected as ${state.login}. Choose the repository you want to work on below.` : 'Use a fine-grained access token. No Rootpath GitHub App registration is needed.'}</p>{error && <p role="alert" className="form-error">{error}</p>}{state?.error && <p role="alert" className="form-error">{state.error}</p>}{state?.connected ? <div className="setup-buttons"><button className="secondary-button" onClick={() => void api.open({ kind: 'tokens' })}>Manage GitHub access</button><button className="secondary-button" disabled={busy} onClick={() => void disconnect()}>Disconnect GitHub on this computer</button></div> : <><label className="field-label">GitHub access token<input className="text-input" type="password" aria-label="GitHub access token" autoComplete="off" spellCheck={false} placeholder="github_pat_…" value={token} onChange={e => setToken(e.target.value)}/></label><button className="primary-button" disabled={busy || !token.trim()} onClick={() => void connect()}>{busy ? 'Connecting…' : 'Connect GitHub'}</button><p>Use a fine-grained access token, not your GitHub password. Rootpath encrypts it on this computer and never sends it to the VPS.</p><details className="website-setup-advanced"><summary>Get an access token · one-time setup</summary><p>Create a fine-grained token in your GitHub account. Set an expiry and choose only the repositories Rootpath should access. Repository permissions: Contents and Pull requests read/write; Checks and Commit statuses read; Metadata read. Organization repositories may need owner approval.</p><button className="secondary-button" disabled={busy} onClick={() => void api.open({ kind: 'token' })}>Open GitHub token settings</button><p>Paste the token into the masked field above. Rootpath never shows a saved token again. Reconnect with a new token if it expires or is revoked.</p></details></>}</section>;
}
