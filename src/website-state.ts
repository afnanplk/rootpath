import type { Project, Job } from './projects';
export type WebsiteState = 'Discovered' | 'Setup needed' | 'Ready' | 'Deploying' | 'Healthy' | 'Needs attention';
export type WebsiteItem = { project: Project; candidate?: Project; imported: boolean; mappingChanged: boolean; missing: boolean };
export function websiteItems(saved: Project[], candidates: Project[] | null): WebsiteItem[] {
 const byPath = new Map(candidates?.map(p => [p.directory, p]) || []);
 const items: WebsiteItem[] = saved.map(project => ({ project, candidate: byPath.get(project.directory), imported: true, mappingChanged: Boolean(byPath.get(project.directory) && byPath.get(project.directory)!.revision !== project.revision), missing: candidates !== null && !byPath.has(project.directory) }));
 const known = new Set(saved.map(p => p.directory));
 for (const project of candidates || []) if (!known.has(project.directory)) items.push({ project, candidate: project, imported: false, mappingChanged: false, missing: false });
 return items.sort((a,b) => a.project.name.localeCompare(b.project.name));
}
const deployment = (job: Job) => ['app-deploy','site-create','site-deploy','custom-deploy'].includes(job.action) || job.action.startsWith('static-');
export function websiteState(item: WebsiteItem, jobs: Job[]): { label: WebsiteState; note: string } {
 const p = item.project;
 if (p.trustChanged) return { label: 'Needs attention', note: 'Server identity changed. Review the connection before managing this website.' };
 if (item.missing) return { label: 'Needs attention', note: 'This folder was not found in the latest discovery. Refresh before continuing.' };
 if (item.mappingChanged) return { label: 'Needs attention', note: 'Server mappings changed. Review the new settings before updating.' };
 if (!item.imported) return { label: 'Discovered', note: 'Set up this website to enable updates.' };
 const recent = [...jobs].reverse().find(j => j.projectId === p.id && deployment(j));
 if (recent && ['running','queued'].includes(recent.status)) return { label: 'Deploying', note: recent.message || 'Deployment is in progress. Follow each step in Activity.' };
 if (recent?.status === 'awaiting-review') return { label: 'Setup needed', note: 'Deployment is waiting for your migration review.' };
 if (recent && ['failed','unknown','interrupted','cancelled'].includes(recent.status)) return { label: 'Needs attention', note: recent.message || 'The last deployment did not finish successfully. Review its logs.' };
 if (p.issues.length || !p.repository || (p.type === 'django' && !p.databaseAssociation)) return { label: 'Setup needed', note: p.issues[0] || 'Review repository and database settings before deploying.' };
 if (p.lastDeployment && /HTTP 2xx verified/i.test(p.health)) return { label: 'Healthy', note: 'The last deployment passed its HTTP health check. This is not a live availability check.' };
 return { label: 'Ready', note: 'Review incoming changes before deploying.' };
}
