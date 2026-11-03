# Version 1: root-owned coordinator; only the fixed read-only check is enabled.
import os,sys,json,time,signal,subprocess,fcntl,hashlib,re,pwd,stat
from datetime import datetime,timezone
jobdir=sys.argv[1]
with open(jobdir+'/manifest.json') as f:m=json.load(f)
if m.get('version')!=1 or m.get('action') not in ['connection-check','static-deploy','static-replace','static-recover','app-deploy','site-create','site-deploy','host-packages','custom-deploy']:sys.exit(2)
def now():return datetime.now(timezone.utc).isoformat()
def write(name,value):
 p=jobdir+'/'+name;tmp=p+'.tmp';fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o640)
 with os.fdopen(fd,'w') as f:json.dump(value,f);f.flush();os.fsync(f.fileno())
 os.chown(tmp,0,m['gid']);os.replace(tmp,p)
state={'id':m['id'],'projectId':m['projectId'],'action':m['action'],'status':'running','step':0,'totalSteps':5,'startedAt':now(),'bootId':m['bootId'],'message':'Checking the project as '+m['username']}
seq=0;child=None;cancelled=False
redact=lambda s:re.sub(r'(?i)((?:password|secret|token|api[_-]?key)\s*[:=]\s*)([^\s]+)',r'\1[REDACTED]',str(s))
def emit(text,severity='info'):
 global seq
 seq+=1;p=jobdir+'/events.jsonl'
 if os.path.exists(p) and os.stat(p).st_size>50*1024*1024-8192:
  if state.get('truncated'):return
  state['truncated']=True;text='Verbose output reached the 50 MiB limit. Further output is omitted; final status is preserved.';severity='warn'
 fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_APPEND|os.O_NOFOLLOW,0o640);os.fchown(fd,0,m['gid'])
 with os.fdopen(fd,'a') as f:f.write(json.dumps({'seq':seq,'timestamp':now(),'severity':severity,'text':redact(text)[:4096]})+'\n')
def stopped(signum,frame):
 global cancelled
 cancelled=True
 if child and child.poll() is None:child.terminate()
signal.signal(signal.SIGTERM,stopped);signal.signal(signal.SIGINT,stopped)
# The lock name is derived from the canonical project, never a shell expression.
lockkey=hashlib.sha256((m['device']+':'+m['inode']).encode()).hexdigest();lock=os.open('/var/lib/rootpath/jobs-v1/locks/'+lockkey,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
# Inserted into the root coordinator. Project code is only run after dropping privileges.
def application_job():
 global child
 recipe=m['recipe'];user=pwd.getpwuid(m['uid']);state['totalSteps']=9;resources=[];creation=m['action']=='site-deploy'
 if recipe['kind']=='django':resources.append('venv:'+os.path.realpath(os.path.dirname(os.path.dirname(recipe['python']))))
 if recipe.get('frontend'):resources.append('path:'+m['directory']+'/'+recipe['frontend'])
 resourceLocks=[]
 for key in resources:
  fd=os.open('/var/lib/rootpath/jobs-v1/locks/'+hashlib.sha256(key.encode()).hexdigest(),os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);resourceLocks.append(fd)
 with open(jobdir+'/static-v1.py') as f:source=f.read()
 backup=os.open(jobdir+'/recovery.tar',os.O_RDWR|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o640);os.fchown(backup,0,m['gid'])
 database=None
 if recipe['kind']=='django':database=os.open(jobdir+'/database.backup',os.O_RDWR|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o640);os.fchown(database,0,m['gid'])
 def step(name,number):
  global child
  state.update(status='running',step=number,message=name+' stage');write('status.json',state);emit('Starting '+name+' stage as '+m['username']+'.')
  resultread,resultwrite=os.pipe();stageBackup=backup if name=='prepare' else None;stageDatabase=database if name=='prepare' else None
  tail="\ntry:\n q=json.loads(sys.stdin.read(65537));v="+("new_site_stage" if creation else "app_stage")+"(q,"+repr(name)+","+str(stageBackup)+","+str(stageDatabase)+",lambda s:print(s,flush=True));os.write("+str(resultwrite)+",json.dumps(v).encode())\nexcept Refused as e:print(e.code+': '+str(e),flush=True);sys.exit(1)\nexcept Exception:print('Application stage failed. Later stages stopped; no rollback is implied.',flush=True);sys.exit(1)"
  child=subprocess.Popen(['/usr/bin/python3','-I','-c',source+tail],cwd='/',env={'PATH':'/usr/bin:/bin','HOME':user.pw_dir,'LANG':'C.UTF-8'},user=user.pw_uid,group=user.pw_gid,extra_groups=os.getgrouplist(user.pw_name,user.pw_gid),pass_fds=tuple(x for x in [stageBackup,stageDatabase,resultwrite] if x is not None),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
  os.close(resultwrite);child.stdin.write(json.dumps(recipe));child.stdin.close()
  # Result pipe is deliberately small; application results are capped below PIPE_BUF.
  for line in child.stdout:emit(line.rstrip())
  code=child.wait();result=os.read(resultread,4097);os.close(resultread)
  if code:raise RuntimeError(name+' stage failed (exit '+str(code)+'). Later stages stopped; no rollback is implied.')
  if len(result)>4096:raise RuntimeError('Stage result exceeded the permitted size.')
  value=json.loads(result or '{}');emit(name+' stage completed.');return value
 def activate():
  if not creation:return
  emit('Creating only the reviewed new Nginx/systemd files; validate Nginx before enabling and reloading.')
  ns={'__name__':'rootpath_hosting'}
  with open(jobdir+'/hosting-v1.py') as f:exec(compile(f.read(),'<rootpath-hosting>','exec'),ns)
  old=os.environ.get('SUDO_UID');os.environ['SUDO_UID']=str(m['uid']);fd=None
  try:
   fd=ns['admin_lock']();ns['configure_site']({**recipe,'username':m['username']},user)
  finally:
   if fd is not None:os.close(fd)
   if old is None:os.environ.pop('SUDO_UID',None)
   else:os.environ['SUDO_UID']=old
 try:
  if creation:
   step('clone',0);state['cloneVerified']=True;write('status.json',state)
   target=m['directory']+'/.env';fd=os.open(target,os.O_WRONLY|os.O_TRUNC|os.O_NOFOLLOW)
   with open(jobdir+'/environment.input','rb') as envInput,os.fdopen(fd,'wb') as dest:dest.write(envInput.read(262145));dest.flush();os.fsync(dest.fileno())
   os.chown(target,m['uid'],m['gid']);os.chmod(target,0o600);os.unlink(jobdir+'/environment.input')
   if recipe['kind']=='django':step('install',2)
  value=step('prepare',1);state['backupVerified']=value.get('backupVerified') is True;state['databaseVerified']=value.get('databaseVerified') is True;write('status.json',state)
  if not creation or recipe['kind']!='django':step('install',2)
  value=step('validate',3)
  if creation and recipe['kind']!='django':activate()
  if recipe['kind']=='django':
   pending=value.get('pendingMigrations',[]);migrationHash=value.get('migrationHash')
   if pending:
    if not state['databaseVerified']:raise RuntimeError('Migrations require a verified database backup.')
    state.update(status='awaiting-review',pendingMigrations=pending,migrationHash=migrationHash,message='Awaiting explicit migration review. Existing code/dependencies have been updated; migrations and restart have not run.');write('status.json',state);emit(state['message'])
    deadline=time.monotonic()+86400
    while True:
     if cancelled:raise RuntimeError('Review cancelled; code/dependencies remain updated. No rollback was performed.')
     if time.monotonic()>deadline:raise RuntimeError('Migration review expired after 24 hours. No migrations or restart were performed.')
     try:
      with open(jobdir+'/migration-approval.json') as f:approval=json.load(f)
      if approval.get('hash')==migrationHash:break
     except FileNotFoundError:pass
     time.sleep(0.5)
   recipe['migrationHash']=migrationHash
   step('migrate',4);step('collect',5);activate()
   state.update(status='running',step=6,message='Restarting reviewed systemd service.');write('status.json',state)
   service=recipe['service'];properties=service_properties(service)
   if properties.get('User')!=m['username'] or properties.get('WorkingDirectory')!=m['directory']:raise RuntimeError('Service mapping changed; restart refused.')
   r=subprocess.run(['/usr/bin/systemctl','restart','--',service],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=60)
   if r.returncode:raise RuntimeError('Service restart failed. Health was not reported successful.')
   r=subprocess.run(['/usr/bin/systemctl','is-active','--quiet','--',service],timeout=15)
   if r.returncode:raise RuntimeError('Service is not active after restart.')
  elif recipe.get('service'):
   service=recipe['service'];properties=service_properties(service)
   if properties.get('User')!=m['username'] or properties.get('WorkingDirectory')!=m['directory']:raise RuntimeError('Service mapping changed; restart refused.')
   if subprocess.run(['/usr/bin/systemctl','restart','--',service],timeout=60).returncode or subprocess.run(['/usr/bin/systemctl','is-active','--quiet','--',service],timeout=15).returncode:raise RuntimeError('Node service restart failed.')
  else:step('restart',6)
  step('health',7);state.update(status='completed',step=9,message='Deployment completed: all required stages and HTTP health passed.',finishedAt=now(),exitCode=0)
 except Exception as e:state.update(status='cancelled' if cancelled else 'failed',message=str(e)[:2048],finishedAt=now())
 finally:
  if creation:
   try:os.unlink(jobdir+'/environment.input')
   except FileNotFoundError:pass
  os.close(backup)
  for fd in resourceLocks:os.close(fd)
  if database is not None:os.close(database)
  emit(state['message'],'error' if state['status']=='failed' else 'info');write('status.json',state)

def service_properties(service):
 if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.@-]{0,199}\.service',service):raise RuntimeError('Invalid reviewed service.')
 r=subprocess.run(['/usr/bin/systemctl','show','--property=User,WorkingDirectory,FragmentPath,DropInPaths','--',service],capture_output=True,text=True,timeout=15)
 if r.returncode:raise RuntimeError('Service mapping unavailable.')
 values=dict(x.split('=',1) for x in r.stdout.splitlines() if '=' in x);fragment=values.get('FragmentPath','')
 for path in [fragment]+values.get('DropInPaths','').split():
  st=os.lstat(path)
  if not stat.S_ISREG(st.st_mode) or st.st_uid!=0 or st.st_mode&0o022 or st.st_size>262144:raise RuntimeError('Service configuration ownership is unsafe.')
  with open(path) as f:text=f.read(262145).replace(chr(92)+chr(10),' ')
  if re.search(r'^\s*Exec\w+\s*=\s*[^/\n]*[+!]',text,re.M) or re.search(r'^\s*PermissionsStartOnly\s*=\s*(?:yes|true|1)',text,re.M):raise RuntimeError('Service uses elevated command prefixes; automatic restart refused.')
 return values

pathlock=None
try:
 fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 pathlock=os.open('/var/lib/rootpath/jobs-v1/locks/'+hashlib.sha256(('path:'+m['directory']).encode()).hexdigest(),os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600);fcntl.flock(pathlock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 if m['action']=='host-packages':
  packageLock=os.open('/var/lib/rootpath/jobs-v1/locks/packages',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600);fcntl.flock(packageLock,fcntl.LOCK_EX)
  recipe=m['recipe'];manager=recipe['manager'];packages=recipe['packages'];write('status.json',state);emit('Installing only the reviewed host dependencies. Package maintainer scripts run as root.')
  commands=[['/usr/bin/apt-get','update'],['/usr/bin/apt-get','install','-y','--no-install-recommends',*packages]] if manager=='apt' else [['/usr/bin/dnf','install','-y',*packages]]
  for args in commands:
   # Package output can contain arbitrary repository data: persist controlled stage summaries only.
   child=subprocess.Popen(args,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','DEBIAN_FRONTEND':'noninteractive'})
   try:code=child.wait(timeout=1800)
   except subprocess.TimeoutExpired:child.terminate();child.wait(timeout=20);raise RuntimeError('Package installation timed out; inspect the package manager before retrying.')
   if code:raise RuntimeError('Package manager failed; no automatic retry or rollback is claimed.')
   emit(os.path.basename(args[0])+' '+args[1]+' completed.')
  state.update(status='completed',message='Reviewed dependencies installed. Preview the new workspace again.',finishedAt=now(),exitCode=0);sys.exit(0)
 if m['action']=='site-create':
  user=pwd.getpwuid(m['uid'])
  with open(jobdir+'/static-v1.py') as f:source=f.read()
  tail="\ntry:\n q=json.loads(sys.stdin.read(65537));create_site(q,lambda s:print(s,flush=True))\nexcept Refused as e:print(e.code+': '+str(e),flush=True);sys.exit(1)\nexcept Exception:print('Creation failed; inspect the partial directory before retrying.',flush=True);sys.exit(1)"
  child=subprocess.Popen(['/usr/bin/python3','-I','-c',source+tail],cwd='/',env={'PATH':'/usr/bin:/bin','HOME':user.pw_dir,'LANG':'C.UTF-8'},user=user.pw_uid,group=user.pw_gid,extra_groups=os.getgrouplist(user.pw_name,user.pw_gid),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
  child.stdin.write(json.dumps(m['recipe']));child.stdin.close();write('status.json',state)
  for line in child.stdout:emit(line.rstrip())
  code=child.wait();state.update(status='completed' if code==0 else 'failed',message='Workspace created. Discover/import it, configure environment/database settings and review hosting activation.' if code==0 else 'Workspace creation failed. The partial new directory remains for inspection; existing projects were untouched.',finishedAt=now(),exitCode=code);sys.exit(0)
 if m['action'] in ['app-deploy','site-deploy']:
  application_job();sys.exit(0)
 write('status.json',state);emit('Reviewed '+m['action']+' job started.')
 probe="""import os,sys,json,time
p=sys.argv[1];expected=json.loads(sys.argv[2]);s=os.stat(p)
assert str(s.st_dev)==expected['device'] and str(s.st_ino)==expected['inode'] and os.path.realpath(p)==p,'Project identity changed'
assert os.access(p,os.R_OK|os.X_OK),'Project directory is not readable'
print('Directory identity and access verified.',flush=True)
v=os.statvfs(p);print('Available disk space: '+str(v.f_bavail*v.f_frsize)+' bytes',flush=True)
for i in range(3):time.sleep(5);print('Reconnect checkpoint '+str(i+1)+' of 3',flush=True)
"""
 user=pwd.getpwuid(m['uid'])
 backup=None
 if m['action'].startswith('static-') or m['action']=='custom-deploy':
  backup=os.open(jobdir+'/recovery.tar',os.O_RDWR|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o640);os.fchown(backup,0,m['gid'])
  with open(jobdir+'/static-v1.py') as f:source=f.read()
  tail="\ntry:\n q=json.loads(sys.stdin.read(65537));run_recipe(q,"+str(backup)+",lambda s:print(s,flush=True))\nexcept Refused as e:print(e.code+': '+str(e),flush=True);sys.exit(1)\nexcept Exception:print('Static deployment failed; inspect this job and its backup before recovery.',flush=True);sys.exit(1)"
  if m['action']=='custom-deploy':tail=tail.replace('run_recipe(q,','custom_run(q,')
  command=['/usr/bin/python3','-I','-c',"__name__='rootpath_recipe'\n"+source+tail];payload=json.dumps(m['recipe']);fds=(backup,)
 else:command=['/usr/bin/python3','-I','-c',probe,m['directory'],json.dumps({'device':m['device'],'inode':m['inode']})];payload='';fds=()
 child=subprocess.Popen(command,cwd='/',env={'PATH':'/usr/bin:/bin','HOME':user.pw_dir,'LANG':'C.UTF-8'},user=user.pw_uid,group=user.pw_gid,extra_groups=os.getgrouplist(user.pw_name,user.pw_gid),pass_fds=fds,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
 child.stdin.write(payload);child.stdin.close()
 for line in child.stdout:
  if line.startswith('Backup verified.'):
   state['backupVerified']=True
   if backup is not None:os.fsync(backup)
  emit(line.rstrip());state['step']=min(5,state['step']+1);write('status.json',state)
 if backup is not None:os.close(backup)
 code=child.wait();state.update(status='cancelled' if cancelled else 'completed' if code==0 else 'failed',message='Cancellation completed at a safe checkpoint.' if cancelled else ('Custom script completed and HTTP health verified.' if m['action']=='custom-deploy' else 'Static deployment completed; tracked code and output verified.' if m['action'].startswith('static-') else 'Read-only project check completed.') if code==0 else 'Job failed. Later stages stopped; inspect logs and any verified backup. No rollback is implied.',exitCode=code,finishedAt=now())
except BlockingIOError:state.update(status='failed',message='Another job holds this project lock.',finishedAt=now())
except Exception:state.update(status='cancelled' if cancelled else 'failed',message='The check stopped before successful completion.',finishedAt=now())
finally:
 if child and child.poll() is None:child.terminate();child.wait(timeout=5)
 emit(state['message'],'error' if state['status']=='failed' else 'info');write('status.json',state)
 os.close(lock)
 if pathlock is not None:os.close(pathlock)
