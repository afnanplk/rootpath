const{PublicError}=require('../connection-store.cjs');const{quote}=require('../remote-json.cjs');
const READY='ROOTPATH_INPUT_READY_v1',PROMPT='ROOTPATH_SUDO_PROMPT_v1';
const SOURCE_BOOTSTRAP="import sys,json,io\ne=json.loads(sys.stdin.readline(1048577));sys.stdin=io.StringIO(json.dumps(e['input'])+'\\n');exec(compile(e['source'],'<rootpath-admin>','exec'),{'__name__':'__main__'})";
function privilegedJSON(record,source,input,password,{sourceStdin=false,timeout=45000}={}){
 if(password!==undefined&&(typeof password!=='string'||password.length>16384||/[\r\n\0]/.test(password)))return Promise.reject(new PublicError('INVALID_INPUT','Enter a valid single-line sudo password.'));
 return new Promise((resolve,reject)=>{let channel,done=false,stderr='',stdout='',sent=false,prompted=false,code=null;
 const finish=error=>{if(done)return;done=true;clearTimeout(timer);record.client.removeListener('close',closed);password=undefined;if(error){channel?.end();channel?.close();return reject(error);}try{const v=JSON.parse(stdout);if(code!==0||!v.ok)throw new PublicError(v.code||'ADMIN_FAILED',v.message||'The reviewed administrative action failed.');resolve(v.value);}catch(e){reject(e instanceof PublicError?e:new PublicError('ADMIN_FAILED','Administrative permission or the reviewed helper failed. Refresh the existing job before retrying.'));}};
 const closed=()=>finish(new PublicError('CONNECTION_LOST','Connection lost. Recover the saved job identity before retrying.'));
 const timer=setTimeout(()=>finish(new PublicError('REMOTE_TIMEOUT','Administration timed out. Inspect the saved job identity before retrying.')),timeout);record.client.once('close',closed);
 record.client.exec('sudo -S -p '+quote(PROMPT)+' -- /usr/bin/python3 -I -c '+quote("import sys\nsys.stderr.write('"+READY+"\\n');sys.stderr.flush()\n"+(sourceStdin?SOURCE_BOOTSTRAP:source)),(error,stream)=>{if(done){stream?.close();return;}if(error)return finish(new PublicError('ADMIN_UNAVAILABLE','The SSH administrative channel could not start.'));channel=stream;
 stream.on('data',b=>{stdout+=b.toString();if(Buffer.byteLength(stdout)>2*1024*1024)finish(new PublicError('OUTPUT_LIMIT','Administrative output exceeded its limit.'));});
 stream.stderr.on('data',b=>{stderr+=b.toString();if(stderr.length>32768)return finish(new PublicError('SUDO_DENIED','Sudo authentication failed or is unavailable.'));
 let at;while((at=stderr.indexOf(PROMPT))>=0){stderr=stderr.slice(at+PROMPT.length);if(prompted)return finish(new PublicError('SUDO_DENIED','The sudo password was rejected. Nothing was approved with that password.'));prompted=true;if(password===undefined)return finish(new PublicError('SUDO_PASSWORD_REQUIRED','Enter the sudo password for the connected account to authorize this reviewed action.'));stream.write(password+'\n');password=undefined;}
 if(!sent&&stderr.includes(READY)){sent=true;stream.end(JSON.stringify(sourceStdin?{source,input}:input)+'\n');}
 });
 stream.once('error',closed);stream.once('exit',c=>code=c);stream.once('close',c=>{if(Number.isInteger(c))code=c;if(!sent)return finish(new PublicError('SUDO_DENIED','Sudo denied this reviewed action or requires a terminal. No passwordless rule was added.'));finish();});
 });
 });
}
module.exports={privilegedJSON,READY,PROMPT,SOURCE_BOOTSTRAP};
