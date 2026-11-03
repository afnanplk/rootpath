import { useEffect, useRef } from 'react';
import '../node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css';
import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/editor/contrib/find/browser/findController.js';
import 'monaco-editor/languages/definitions/javascript/register.js';
import 'monaco-editor/languages/definitions/typescript/register.js';
import 'monaco-editor/languages/definitions/python/register.js';
import 'monaco-editor/languages/definitions/shell/register.js';
import 'monaco-editor/languages/definitions/yaml/register.js';
import 'monaco-editor/languages/definitions/ini/register.js';
import 'monaco-editor/languages/definitions/xml/register.js';
import 'monaco-editor/languages/definitions/css/register.js';
import 'monaco-editor/languages/definitions/html/register.js';
import 'monaco-editor/languages/definitions/markdown/register.js';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import type { RemoteDocument } from './workspace';
(self as typeof self & { MonacoEnvironment: unknown }).MonacoEnvironment = { getWorker: () => new EditorWorker() };
monaco.languages.register({ id: 'json' });
monaco.languages.setMonarchTokensProvider('json', { tokenizer: { root: [[/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'key'], [/"(?:[^"\\]|\\.)*"/, 'string'], [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'], [/true|false|null/, 'keyword'], [/[{}\[\]:,]/, 'delimiter']] } });
const languages: Record<string, string> = { json: 'json', jsonc: 'json', js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'typescript', jsx: 'javascript', py: 'python', sh: 'shell', bash: 'shell', yaml: 'yaml', yml: 'yaml', conf: 'ini', ini: 'ini', toml: 'ini', xml: 'xml', html: 'html', css: 'css', md: 'markdown' };
export default function TextEditor({ document, value, onChange, onSave, disabled }: { document: RemoteDocument; value: string; onChange: (value: string) => void; onSave: () => void; disabled: boolean }) {
  const host = useRef<HTMLDivElement>(null), editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null), callbacks = useRef({ onChange, onSave }); callbacks.current = { onChange, onSave };
  useEffect(() => {
    const model = monaco.editor.createModel(value, languages[document.path.split('.').pop() || ''] || 'plaintext');
    model.setEOL(document.eol === 'CRLF' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
    const theme = () => window.document.documentElement.dataset.theme === 'light' ? 'vs' : 'vs-dark';
    const instance = monaco.editor.create(host.current!, { model, theme: theme(), automaticLayout: true, editContext: false, fontSize: 13, lineNumbers: 'on', minimap: { enabled: false }, scrollBeyondLastLine: false, readOnly: disabled, ariaLabel: 'Remote text editor', padding: { top: 16 }, wordWrap: 'off', unicodeHighlight: { ambiguousCharacters: false } });
    editor.current = instance;
    const change = instance.onDidChangeModelContent(() => callbacks.current.onChange(model.getValue()));
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => callbacks.current.onSave());
    const observer = new MutationObserver(() => monaco.editor.setTheme(theme())); observer.observe(window.document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => { observer.disconnect(); change.dispose(); instance.dispose(); model.dispose(); editor.current = null; };
  }, [document.id]);
  useEffect(() => { const model = editor.current?.getModel(); if (model && model.getValue() !== value) model.setValue(value); }, [value]);
  useEffect(() => { editor.current?.updateOptions({ readOnly: disabled }); }, [disabled]);
  return <><div className="editor-tools"><button onClick={() => editor.current?.getAction('actions.find')?.run()}>Find in file</button><button onClick={() => editor.current?.getAction('editor.action.startFindReplaceAction')?.run()}>Replace in file</button></div><div className="monaco-host" ref={host}/></>;
}
