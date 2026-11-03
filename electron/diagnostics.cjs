// Deliberate allowlist: no logs, hosts, usernames, paths, configuration, credentials or raw errors.
function diagnostics({app,manager,transfers,monitoring,applications,hosting,databases}) {
 const sessions=manager.snapshot().sessions;
 const counts=rows=>rows.reduce((out,row)=>{const status=['running','completed','failed','unknown','queued','scanning','conflict','cancelled','canceling'].includes(row.status)?row.status:'other';out[status]=(out[status]||0)+1;return out;},{});
 return{format:1,generatedAt:new Date().toISOString(),version:app.getVersion(),platform:process.platform,architecture:process.arch,versions:{electron:process.versions.electron,node:process.versions.node,chrome:process.versions.chrome},security:{contextIsolation:true,sandbox:true,nodeIntegration:false},connections:{total:sessions.length,connected:sessions.filter(s=>s.status==='connected').length},transfers:counts(transfers.snapshot()),operations:{services:counts(monitoring.history),applications:counts(applications.history),hosting:counts(hosting.history),databases:counts(databases.history)},databaseJobs:counts([...databases.jobs.values()]),verification:{linuxHosting:'External acceptance required',windows:'Requires Windows smoke test',signing:'Unsigned test builds'}};
}
module.exports={diagnostics};
