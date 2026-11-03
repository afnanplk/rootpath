const fs=require('node:fs/promises'),path=require('node:path');
const fingerprint='SHA256:tX552glwSshJr+BbJnb3Xng/bDM9eqmXz45vAIIVvzY';
// Match the previously shipped local lab identity, never every localhost profile.
async function retireTestData(manager,projects){const data=manager.store.data;const ids=new Set(data.profiles.filter(p=>['127.0.0.1','localhost'].includes(p.host)&&p.port===2222&&p.username==='explorer'&&data.hosts[p.host+':'+p.port]===fingerprint).map(p=>p.id));
 if(!ids.size){try{const saved=JSON.parse(await fs.readFile(path.join(projects.root,'retired-test-data.json'),'utf8'));return(saved.profiles||[]).map(p=>p.id);}catch(e){if(e.code==='ENOENT')return[];throw e;}}
 const previous={profiles:data.profiles,hosts:{...data.hosts},projects:projects.data.projects,jobs:projects.data.jobs};
 const archive=path.join(projects.root,'retired-test-data.json');try{await fs.writeFile(archive,JSON.stringify({version:1,profiles:data.profiles.filter(p=>ids.has(p.id)),projects:projects.data.projects.filter(p=>ids.has(p.serverId)),jobs:projects.data.jobs.filter(j=>ids.has(j.serverId))}),{mode:0o600,flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}
 data.profiles=data.profiles.filter(p=>!ids.has(p.id));for(const host of ['127.0.0.1:2222','localhost:2222'])if(data.hosts[host]===fingerprint)delete data.hosts[host];projects.data.projects=projects.data.projects.filter(p=>!ids.has(p.serverId));projects.data.jobs=projects.data.jobs.filter(j=>!ids.has(j.serverId));
 try{await manager.store.persist();await projects.persist();}catch(e){Object.assign(data,{profiles:previous.profiles,hosts:previous.hosts});Object.assign(projects.data,{projects:previous.projects,jobs:previous.jobs});throw e;}return[...ids];
}
module.exports={retireTestData};
