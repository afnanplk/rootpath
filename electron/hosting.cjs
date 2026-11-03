const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { remoteJSON } = require('./remote-json.cjs');
const { PublicError, object, validateId, fail } = require('./connection-store.cjs');
const source = fs.readFileSync(path.join(__dirname, 'hosting-remote.py'), 'utf8');
function siteName(s) { if (typeof s !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(s)) fail('INVALID_INPUT', 'Use a simple site name without paths.'); return s; }
class Hosting {
 constructor(files, monitoring) { this.files = files; this.monitoring = monitoring; this.plans = new Map(); this.history = []; }
 async run(q) { if (!object(q)) fail('INVALID_INPUT', 'Invalid hosting request.'); validateId(q.sessionId); if (typeof q.sudo !== 'boolean') fail('INVALID_INPUT', 'Choose an elevation setting.'); const caps = await this.monitoring.capabilities(q); if (!caps.linux || !caps.managed) fail('UNSUPPORTED_OS', 'Hosting controls support Debian/Ubuntu and Rocky/Alma/RHEL Linux.'); return require('./production.cjs').realServer(await remoteJSON(this.files.record(q.sessionId), source, q, { sudo: q.sudo, timeout: ['issue', 'renew'].includes(q.action) ? 210000 : 35000 })); }
 async inspect(q) { return this.run({ ...q, action: 'inspect', name: siteName(q.name) }); }
 async list(q) { const caps = await this.run({ ...q, action: 'capabilities' }); if (!caps.nginx) return { ...caps, sites: [] }; return { ...caps, ...await this.run({ ...q, action: 'list' }) }; }
 async certificates(q) { return this.run({ ...q, action: 'certificates' }); }
 async validate(q) { return this.run({ ...q, action: 'validate' }); }
 async prepare(input) {
  if (!object(input) || !['save','restore','enable','disable','reload','issue','renew'].includes(input.action)) fail('INVALID_INPUT', 'Choose a supported hosting action.');
  const q = { sessionId: input.sessionId, sudo: input.sudo, action: input.action };
  if (['issue','renew'].includes(q.action)) {
   if (typeof input.domain !== 'string' || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(input.domain)) fail('INVALID_INPUT', 'Enter one public DNS hostname.');
   Object.assign(q, { domain: input.domain });
   if (q.action === 'issue') { if (typeof input.webroot !== 'string' || !/^\/[A-Za-z0-9_./-]+$/.test(input.webroot) || input.webroot.length > 4096 || typeof input.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email) || input.email.length > 254) fail('INVALID_INPUT', 'Enter a canonical webroot and ACME email.'); Object.assign(q, { webroot: input.webroot, email: input.email }); }
   const caps = await this.run({ ...q, action: 'capabilities' }); if (!caps.certbot) fail('MISSING_TOOL', 'Certbot is not installed.');
  } else {
   q.name = siteName(input.name); const current = await this.inspect(q); q.revision = current.revision;
   if(q.action === 'save' && current.exists && input.revision !== current.revision) fail('REMOTE_CHANGED','Inspect the existing site again before replacing it; it may have changed.');
   if (q.action === 'save') { if (typeof input.text !== 'string' || Buffer.byteLength(input.text) > 262144 || input.text.includes('\0')) fail('INVALID_INPUT', 'Configuration must be text up to 256 KiB.'); q.text = input.text; }
   if (q.action === 'restore') { if (typeof input.backup !== 'string' || !/^[a-f0-9]{32}$/.test(input.backup)) fail('INVALID_INPUT', 'Choose a recoverable backup.'); q.backup = input.backup; }
   if (q.action !== 'save' && !current.exists) fail('NOT_FOUND', 'Choose an existing site.');
  }
  for (const [id,p] of this.plans) if (p.expiresAt < Date.now()) this.plans.delete(id);
  if (this.plans.size >= 32) fail('BUSY','Close pending reviews first.');
  const token = randomUUID(), expiresAt = Date.now()+60000; this.plans.set(token,{q,expiresAt});
  return { token, expiresAt, action:q.action, name:q.name || q.domain, sudo:q.sudo, text:q.text, fixture:(await this.monitoring.capabilities(q)).fixture };
 }
 cancel(q) { validateId(q.token); this.plans.delete(q.token); }
 async perform(q) {
  validateId(q.token); const p = this.plans.get(q.token); this.plans.delete(q.token);
  if (!p || p.expiresAt < Date.now()) fail('EXPIRED','Review this action again.');
  if (q.confirmation !== (p.q.name || p.q.domain)) fail('CONFIRMATION_REQUIRED','Type the exact site or certificate name.');
  const id=p.q.sessionId; if (this.monitoring.busy.has(id)) fail('BUSY','Another server action is running.');
  this.monitoring.busy.add(id); const item={id:randomUUID(), action:p.q.action, name:p.q.name || p.q.domain, sessionId:id, startedAt:new Date().toISOString(),status:'running',message:'Hosting action submitted.'}; this.history.push(item); this.history=this.history.slice(-200);
  try { const result=await this.files.exclusive(id,()=>this.run(p.q)); Object.assign(item,{status:'completed',message:result.message}); return result; }
  catch(e) { Object.assign(item,{status:['CONNECTION_LOST','REMOTE_TIMEOUT'].includes(e.code)?'unknown':'failed',message:e instanceof PublicError?e.message:'Hosting operation failed.'}); throw e; }
  finally { item.finishedAt=new Date().toISOString(); this.monitoring.busy.delete(id); }
 }
 snapshot() { return this.history.map(x=>({...x})); }
 dispose() { this.plans.clear(); }
}
module.exports={Hosting,siteName,source};
