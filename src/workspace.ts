import type { Result } from './connections';
export type RemoteDocument = { id: string; sessionId: string; path: string; text: string; revision: string; bom: boolean; eol: 'LF' | 'CRLF'; backups: { id: string; path: string }[] };
export type EditorAPI = {
  open: (input: { sessionId: string; path: string }) => Promise<Result<RemoteDocument>>;
  reload: (input: { id: string }) => Promise<Result<RemoteDocument>>;
  save: (input: { id: string; text: string; revision: string }) => Promise<Result<RemoteDocument>>;
  restore: (input: { id: string; backupId: string; revision: string }) => Promise<Result<RemoteDocument>>;
  dirty: (input: { id: string; dirty: boolean }) => Promise<Result<void>>;
  close: (input: { id: string }) => Promise<Result<void>>;
};
export type TerminalEvent = { id: string; type: 'data' | 'closed'; data: string };
export type TerminalAPI = {
  open: (input: { sessionId: string; path: string; cols: number; rows: number }) => Promise<Result<{ id: string; cwd: string }>>;
  write: (input: { id: string; data: string }) => Promise<Result<void>>;
  resize: (input: { id: string; cols: number; rows: number }) => Promise<Result<void>>;
  ack: (input: { id: string; bytes: number }) => Promise<Result<void>>;
  close: (input: { id: string }) => Promise<Result<void>>;
  subscribe: (listener: (event: TerminalEvent) => void) => () => void;
};
