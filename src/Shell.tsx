import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import type { Session } from './connections';
import type { TerminalEvent } from './workspace';
export default function Shell({ session, path, visible }: { session: Session; path: string; visible: boolean }) {
  const host = useRef<HTMLDivElement>(null), term = useRef<Terminal | null>(null), fit = useRef<FitAddon | null>(null), search = useRef<SearchAddon | null>(null), id = useRef('');
  const [status, setStatus] = useState('Opening terminal…'), [query, setQuery] = useState(''), [generation, setGeneration] = useState(0), [ready, setReady] = useState(false);
  useEffect(() => {
    const api = window.vps!.terminal, instance = new Terminal({ cursorBlink: true, scrollback: 3000, fontSize: 13, fontFamily: 'Menlo, Consolas, monospace', theme: { background: '#101419', foreground: '#dce5ee' }, allowProposedApi: false });
    const fitAddon = new FitAddon(), searchAddon = new SearchAddon(); instance.loadAddon(fitAddon); instance.loadAddon(searchAddon); instance.open(host.current!); term.current = instance; fit.current = fitAddon; search.current = searchAddon;
    let disposed = false, connectedId = '', pending: TerminalEvent[] = []; let pendingBytes = 0;
    setReady(false); setStatus('Opening terminal…'); id.current = '';
    function receive(event: TerminalEvent) {
      if (event.id !== connectedId) return;
      if (event.type === 'data') instance.write(event.data, () => { if (!disposed) void api.ack({ id: event.id, bytes: new TextEncoder().encode(event.data).length }); });
      else { setReady(false); setStatus(event.data); instance.writeln('\r\n[Terminal closed]'); }
    }
    const unsubscribe = api.subscribe(event => { if (!connectedId) { const bytes = new TextEncoder().encode(event.data).length; if (pendingBytes + bytes <= 1048576) { pending.push(event); pendingBytes += bytes; } } else receive(event); });
    const input = instance.onData(data => { if (connectedId) { for (let offset = 0; offset < data.length;) { let end = Math.min(offset + 16000, data.length); if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1])) end--; void api.write({ id: connectedId, data: data.slice(offset, end) }).then(result => { if (!result.ok && !disposed) { setReady(false); setStatus(result.error.message); } }); offset = end; } } });
    const resize = instance.onResize(size => { if (connectedId) void api.resize({ id: connectedId, ...size }); });
    const observer = new ResizeObserver(() => { if (host.current?.clientWidth) fitAddon.fit(); }); observer.observe(host.current!);
    void api.open({ sessionId: session.id, path, cols: Math.max(2, instance.cols), rows: Math.max(1, instance.rows) }).then(result => {
      if (disposed) { if (result.ok) void api.close({ id: result.value.id }); return; }
      if (!result.ok) { setStatus(result.error.message); pending = []; return; }
      connectedId = result.value.id; id.current = connectedId; setReady(true); setStatus('Connected · ' + result.value.cwd); for (const event of pending) receive(event); pending = []; if (host.current?.clientWidth) fitAddon.fit(); instance.focus();
    });
    return () => { disposed = true; unsubscribe(); observer.disconnect(); input.dispose(); resize.dispose(); if (connectedId) void api.close({ id: connectedId }); instance.dispose(); term.current = null; };
  }, [generation]);
  useEffect(() => { if (visible && host.current?.clientWidth) { fit.current?.fit(); term.current?.focus(); } }, [visible]);
  return <><div className="code-toolbar"><strong>SSH terminal</strong><span>{status}</span><input aria-label="Search terminal" placeholder="Find in terminal" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') search.current?.findNext(query); }}/><button className="secondary-button" onClick={() => search.current?.findPrevious(query)}>Previous</button><button className="secondary-button" onClick={() => search.current?.findNext(query)}>Next</button><button className="secondary-button" onClick={() => void window.vps!.workspace.copy(term.current?.getSelection() || '').then(r => { if (!r.ok) setStatus(r.error.message); })}>Copy selection</button><button className="secondary-button" disabled={!ready} onClick={() => void window.vps!.workspace.paste().then(r => { if (r.ok) { term.current?.paste(r.value); term.current?.focus(); } else setStatus(r.error.message); })}>Paste</button><button className="secondary-button" disabled={ready || session.status !== 'connected'} onClick={() => setGeneration(g => g + 1)}>Reconnect terminal</button></div><div className="terminal-host" ref={host}/><div className="code-status">Direct SSH shell · Closing this tab ends its shell · Commands are never replayed</div></>;
}
