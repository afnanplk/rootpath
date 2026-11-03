const {source}=require('../electron/hosting.cjs');const{quote}=require('../electron/remote-json.cjs');const{createHash}=require('node:crypto');
function createHostingFixture(){const sites=new Map([['example.conf',{text:'server { listen 80; server_name example.test; root /var/www/html; }\n',enabled:true}]]),backups=new Map(),state={actions:[],nginx:true,certbot:true,denied:false};
const revision=s=>createHash('sha256').update(JSON.stringify(s)).digest('hex');
return{state,attach(accept,command){if(!command.endsWith('/usr/bin/env python3 -c '+quote(source)))return false;const stream=accept();let data='';stream.on('data',b=>{data+=b;if(data.length>524288)stream.close();});stream.on('end',()=>{try{const q=JSON.parse(data);const error=(code,message)=>{throw{code,message};};if(state.denied&&!command.startsWith('sudo -n'))error('PERMISSION_DENIED','Permission denied. Review noninteractive sudo access.');let value;const site=sites.get(q.name);const view=()=>({name:q.name,text:site?.text||null,exists:!!site,enabled:site?.enabled||false,revision:revision(site||null)});
if(q.action==='capabilities')value={nginx:state.nginx,certbot:state.certbot,layout:'debian',fixture:true,python:true};
else if(q.action==='list')value={sites:[...sites].map(([name,s])=>({name,enabled:s.enabled})),layout:'debian',limit:2000};
else if(q.action==='inspect')value=view();
else if(q.action==='certificates')value={text:'SIMULATED certificate example.test · expiry 2099-01-01'};
else if(q.action==='validate')value={message:'Nginx configuration passed validation. No reload was requested.'};
else if(['issue','renew'].includes(q.action)){state.actions.push(q.action);value={message:'SIMULATED Certbot completed. No ACME request was sent.'};}
else{if(view().revision!==q.revision)error('REMOTE_CHANGED','The site changed after review.');let text=site?.text,enabled=site?.enabled||false,backup;
if(['save','restore'].includes(q.action)){if(site){backup=require('node:crypto').randomUUID().replace(/-/g,'');backups.set(backup,{name:q.name,text:site.text});}text=q.action==='save'?q.text:backups.get(q.backup)?.text;if(!text||text.includes('INVALID'))error('NGINX_INVALID','Nginx validation failed. Previous configuration was restored; no reload occurred.');}
if(q.action==='enable')enabled=true;if(q.action==='disable')enabled=false;sites.set(q.name,{text,enabled});state.actions.push(q.action);value={message:'Configuration validated and reload signal sent. Verify the site response.',backup,name:q.name};}
stream.write(JSON.stringify({ok:true,value}));stream.exit(0);stream.end();}catch(e){stream.write(JSON.stringify({ok:false,code:e.code||'HOSTING_FAILED',message:e.message||'Hosting fixture failed.'}));stream.exit(0);stream.end();}});return true;}};}
module.exports={createHostingFixture};
