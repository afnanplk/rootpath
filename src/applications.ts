import type { Result } from './connections';
export type AppKind = 'docker' | 'compose' | 'pm2';
export type AppAction = 'start' | 'stop' | 'restart' | 'redeploy';
export type Application = { id: string; name: string; state: string; image?: string; status?: string; ports?: string; project?: string; directory?: string; files?: string[]; issue?: string; pid?: number; cpu?: number; memory?: number; namespace?: string; script?: string; cwd?: string; restarts?: number };
export type AppCapabilities = { linux: boolean; managed: boolean; fixture: boolean; docker: boolean; pm2: boolean; sudo: boolean; socket: string };
export type AppRequest = { sessionId: string; kind: AppKind; sudo: boolean };
export type AppPlan = { token: string; sessionId: string; kind: AppKind; id: string; action: AppAction; sudo: boolean; details: Record<string, unknown>; server: string; host: string; name: string; fixture: boolean; expiresAt: number };
export type AppOperation = { id: string; sessionId: string; server: string; host: string; kind: AppKind; action: AppAction; name: string; sudo: boolean; simulated: boolean; startedAt: string; finishedAt?: string; status: 'running' | 'completed' | 'failed' | 'unknown'; message: string; code?: string };
export type ApplicationsAPI = {
 capabilities: (input: { sessionId: string }) => Promise<Result<AppCapabilities>>;
 list: (input: AppRequest) => Promise<Result<{ entries: Application[]; scope: string; limit: number }>>;
 details: (input: AppRequest & { id: string }) => Promise<Result<Record<string, unknown>>>;
 logs: (input: AppRequest & { id: string }) => Promise<Result<{ text: string; note: string }>>;
 prepare: (input: AppRequest & { id: string; action: AppAction }) => Promise<Result<AppPlan>>;
 perform: (input: { token: string; confirmationName?: string }) => Promise<Result<{ message: string }>>;
 cancel: (input: { token: string }) => Promise<Result<void>>;
 snapshot: () => Promise<Result<AppOperation[]>>;
 subscribe: (listener: (history: AppOperation[]) => void) => () => void;
};
