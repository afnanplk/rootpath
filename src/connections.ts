import type{WorkflowsAPI}from'./workflows';
export type AuthMethod = 'password' | 'key';
export type Profile = { id: string; name: string; host: string; port: number; username: string; authMethod: AuthMethod; hasSecret: boolean; lastConnectedAt?: string };
export type HostChallenge = { id: string; fingerprint: string; previousFingerprint?: string; changed: boolean };
export type Session = { id: string; profile: Profile; status: 'connecting' | 'verifying' | 'connected' | 'disconnected' | 'error'; message: string; fingerprint?: string; challenge?: HostChallenge; connectedAt?: string; warning?: string };
export type ConnectionSnapshot = { profiles: Profile[]; sessions: Session[]; secureStorageAvailable: boolean };
export type ConnectInput = { profileId?: string; name: string; host: string; port: number; username: string; authMethod: AuthMethod; password?: string; keyId?: string; passphrase?: string; useSavedSecret: boolean; rememberSecret: boolean };
export type Result<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };
export type ConnectionsAPI = {
  snapshot: () => Promise<Result<ConnectionSnapshot>>;
  connect: (input: ConnectInput) => Promise<Result<Session>>;
  disconnect: (id: string) => Promise<Result<void>>;
  decideHost: (input: { sessionId: string; challengeId: string; accept: boolean; replace: boolean }) => Promise<Result<void>>;
  chooseKey: () => Promise<Result<{ id: string; name: string } | null>>;
  removeProfile: (id: string) => Promise<Result<void>>;
  forgetSecret: (id: string) => Promise<Result<void>>;
  subscribe: (listener: (state: ConnectionSnapshot) => void) => () => void;
};
declare global { interface Window { vps?: { ai:import('./ai').AIAPI; setups:import('./development').SetupsAPI; github:import('./development').GitHubAPI; development:import('./development').DevelopmentAPI; delivery:import('./development').DeliveryAPI; scripts:import('./development').ScriptsAPI; workflows:WorkflowsAPI; projects: import('./projects').ProjectsAPI; jobs: import('./projects').JobsAPI; logs: import('./logs').LogsAPI; hosting: import('./management').HostingAPI; databases: import('./management').DatabasesAPI; diagnostics: { export: () => Promise<Result<{ saved: boolean }>> }; applications: import('./applications').ApplicationsAPI; monitoring: import('./monitoring').MonitoringAPI; workspace: { copy: (text: string) => Promise<Result<void>>; paste: () => Promise<Result<string>>; confirmAction: (kind: 'discard' | 'reload' | 'restore') => Promise<Result<boolean>>; confirmDiscard: () => Promise<Result<boolean>> }; editor: import('./workspace').EditorAPI; terminal: import('./workspace').TerminalAPI; connections: ConnectionsAPI; files: import('./files').FilesAPI; transfers: import('./transfers').TransfersAPI } } }
