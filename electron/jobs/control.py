# Rootpath job-control v1: fixed operations only; invoked through reviewed sudo stdin.
import os,sys,json,stat,pwd,grp,subprocess,uuid,time,fcntl,hashlib,shutil,re
q=json.loads(sys.stdin.readline(1048577))
def fail(code,message):print(json.dumps({'ok':False,'code':code,'message':message}));sys.exit(1)
def result(v):print(json.dumps({'ok':True,'value':v}))
if os.geteuid()!=0:fail('SUDO_REQUIRED','Administrative permission is required to coordinate this job.')
uid=int(os.environ.get('SUDO_UID',0));u=pwd.getpwuid(uid)
if uid==0:fail('ACCOUNT_REQUIRED','Use the ordinary project-owning account for this workflow.')
# A private primary group lets the account read root-owned job files without
# granting write access or exposing output to other accounts.
members={p.pw_name for p in pwd.getpwall() if p.pw_gid==u.pw_gid}|set(grp.getgrgid(u.pw_gid).gr_mem)
if members-{u.pw_name}:fail('PRIVATE_GROUP_REQUIRED','This workflow requires a private primary group for the connected account to protect job output. Review the account configuration before enabling jobs.')
base='/var/lib/rootpath/jobs-v1';home=base+'/'+str(uid)
def directory(p,mode,gid=0):
 try:os.mkdir(p,mode)
 except FileExistsError:pass
 s=os.lstat(p)
 if not stat.S_ISDIR(s.st_mode) or s.st_uid!=0 or s.st_mode&0o022:fail('UNSAFE_JOB_PATH','A job coordination directory has unsafe ownership or permissions.')
 os.chmod(p,mode);os.chown(p,0,gid)
def write(p,value,mode=0o640):
 fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode);os.fchown(fd,0,u.pw_gid)
 with os.fdopen(fd,'w') as f:json.dump(value,f);f.flush();os.fsync(f.fileno())
def status(p):
 try:
  with open(p+'/status.json') as f:return json.load(f)
 except OSError:return {'status':'unknown'}
def active(i):
 r=subprocess.run(['/usr/bin/systemctl','show','rootpath-job-'+i+'.service','--property=ActiveState','--value'],capture_output=True,text=True,timeout=10)
 return r.returncode==0 and r.stdout.strip() in ['active','activating','deactivating','reloading']
def ident(i):
 try:
  if str(uuid.UUID(i))!=i:raise ValueError()
 except (ValueError,TypeError,AttributeError):fail('INVALID_JOB','Invalid job identity.')
 return i
def service_properties(service):
 if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.@-]{0,199}\.service',service):raise RuntimeError('Invalid reviewed service.')
 r=subprocess.run(['/usr/bin/systemctl','show','--property=User,WorkingDirectory,FragmentPath,DropInPaths','--',service],capture_output=True,text=True,timeout=15)
 if r.returncode:raise RuntimeError('Service mapping unavailable.')
 values=dict(x.split('=',1) for x in r.stdout.splitlines() if '=' in x);fragment=values.get('FragmentPath','')
 for path in [fragment]+values.get('DropInPaths','').split():
  st=os.lstat(path)
  if not stat.S_ISREG(st.st_mode) or st.st_uid!=0 or st.st_mode&0o022 or st.st_size>262144:raise RuntimeError('Service configuration ownership is unsafe.')
  with open(path) as f:text=f.read(262145)
  if re.search(r'^\s*Exec\w+\s*=\s*[^/\n]*[+!]',text,re.M) or re.search(r'^\s*PermissionsStartOnly\s*=\s*(?:yes|true|1)',text,re.M):raise RuntimeError('Service uses elevated command prefixes; automatic restart refused.')
 return values

try:
 op=q.get('operation');i=ident(q.get('id'));unit='rootpath-job-'+i+'.service'
 if op in ['cancel','approve-migrations']:
  p=home+'/'+i
  with open(p+'/manifest.json') as f:m=json.load(f)
  if m['uid']!=uid or m['id']!=i:fail('INVALID_JOB','This job belongs to another account.')
  if op=='approve-migrations':
   st=status(p)
   if st.get('status')!='awaiting-review' or not st.get('databaseVerified') or st.get('migrationHash')!=q.get('migrationHash'):fail('MIGRATION_REVIEW_REQUIRED','The pending migration review changed or its backup is not verified.')
   approval=p+'/migration-approval.json'
   if not os.path.exists(approval):write(approval,{'hash':st['migrationHash'],'approvedAt':time.time()})
   result(st);sys.exit()
  if m.get('action')=='app-deploy' and status(p).get('status')!='awaiting-review':fail('CANCEL_UNSAFE','Only an application job awaiting migration review can be safely stopped.')
  if m.get('action') in ['site-create','site-deploy','host-packages','custom-deploy'] or m.get('action','').startswith('static-'):fail('CANCEL_UNSAFE','Static jobs cannot be interrupted safely during Git writes. Wait for final status; no rollback is implied.')
  if status(p)['status'] not in ['queued','running','awaiting-review']:result(status(p));sys.exit()
  r=subprocess.run(['/usr/bin/systemctl','stop',unit],capture_output=True,timeout=20)
  if r.returncode:fail('CANCEL_UNKNOWN','Cancellation could not be verified. Refresh the existing job; do not submit it again.')
  result(status(p));sys.exit()
 if op!='start':fail('INVALID_ACTION','Unsupported job action.')
 if not os.path.isdir('/run/systemd/system') or not os.path.isfile('/usr/bin/systemd-run'):fail('SYSTEMD_REQUIRED','A running systemd manager and systemd-run are required.')
 for p,mode,gid in [('/var/lib/rootpath',0o711,0),(base,0o711,0),(base+'/locks',0o700,0),(home,0o750,u.pw_gid)]:directory(p,mode,gid)
 admission=os.open(base+'/admission.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600);fcntl.flock(admission,fcntl.LOCK_EX)
 p=home+'/'+i
 if os.path.exists(p):
  with open(p+'/manifest.json') as f:prior=json.load(f)
  if prior['uid']!=uid or prior['directory']!=q.get('directory') or prior['projectId']!=q.get('projectId'):fail('JOB_CONFLICT','This identity refers to a different job.')
  result(status(p));sys.exit()
 d=q.get('directory');action=q.get('action','connection-check');recipe=q.get('recipe')
 if action in ['site-create','site-deploy','host-packages']:
  parent='/var/www';rootstat=os.lstat(parent)
  if not stat.S_ISDIR(rootstat.st_mode) or rootstat.st_uid!=0 or rootstat.st_mode&0o022 or os.path.realpath(parent)!=parent:fail('UNSAFE_PARENT','/var/www must be a protected root-owned directory.')
  if not isinstance(recipe,dict) or recipe.get('action')!=action or recipe.get('directory')!=d:fail('INVALID_ACTION','Invalid workspace recipe.')
  if action in ['site-create','site-deploy']:
   name=recipe.get('site',{}).get('name','')
   if not re.fullmatch(r'[a-z][a-z0-9-]{1,47}',name) or d!=parent+'/'+name:fail('INVALID_PROJECT','Invalid new project directory.')
   # mkdir is exclusive; no recursive ownership changes and no existing directory reuse.
   # Public project directory only (/var/www/<new slug>): Nginx must traverse it.
   # Private .env is 0600 and .git is 0700; protected job directories remain 0750.
   try:os.mkdir(d,0o755)
   except FileExistsError:fail('DIRECTORY_EXISTS','Import the existing directory instead of creating over it.')
   os.chown(d,uid,u.pw_gid);os.chmod(d,0o755);s=os.stat(d)
  else:
   if d!=parent:fail('INVALID_PROJECT','Package jobs target this host, not a project path.')
   allowed={'git','nginx','python3-venv','nodejs','npm','certbot','python3-certbot-nginx'}
   if recipe.get('manager') not in ['apt','dnf'] or not isinstance(recipe.get('packages'),list) or not recipe['packages'] or any(x not in allowed for x in recipe['packages']):fail('INVALID_PACKAGES','Only reviewed predefined dependencies can be installed.')
   s=rootstat
 else:
  if not isinstance(d,str) or not d.startswith('/var/www/') or len(d)>4096 or any(ord(x)<32 for x in d):fail('INVALID_PROJECT','Invalid project directory.')
  s=os.stat(d)
  if os.path.realpath(d)!=d or not stat.S_ISDIR(s.st_mode) or str(s.st_dev)!=q.get('device') or str(s.st_ino)!=q.get('inode'):fail('PROJECT_CHANGED','The reviewed project directory identity changed.')
 projectId=ident(q.get('projectId'))
 for name in os.listdir(home)[:10000]:
  old=home+'/'+name
  if not os.path.isdir(old):continue
  try:
   with open(old+'/manifest.json') as f:previous=json.load(f)
   st=status(old)
   if previous.get('directory')==d and st.get('status') in ['queued','running','awaiting-review'] and active(previous['id']):fail('PROJECT_BUSY','Another job is already active for this project.')
   if not active(previous['id']) and time.time()-os.stat(old).st_mtime>7*86400:
    try:os.unlink(old+'/events.jsonl')
    except FileNotFoundError:pass
  except (OSError,ValueError,KeyError):continue
 directory(p,0o750,u.pw_gid)
 with open('/proc/sys/kernel/random/boot_id') as f:boot=f.read().strip()
 action=q.get('action','connection-check')
 if action not in ['connection-check','static-deploy','static-replace','static-recover','app-deploy','site-create','site-deploy','host-packages','custom-deploy']:fail('INVALID_ACTION','Unsupported job recipe.')
 recipe=q.get('recipe')
 if (action.startswith('static-') or action=='app-deploy') and (not isinstance(recipe,dict) or recipe.get('directory')!=d or recipe.get('action')!=action):fail('INVALID_ACTION','Invalid static recipe.')
 if action=='app-deploy' and (recipe.get('kind')=='django' or recipe.get('service')):
  try:
   properties=service_properties(recipe.get('service',''))
   if properties.get('User')!=u.pw_name or properties.get('WorkingDirectory')!=d:fail('SERVICE_REVIEW_REQUIRED','Service must run as this account in the reviewed directory.')
  except (OSError,RuntimeError,ValueError):fail('SERVICE_REVIEW_REQUIRED','Verify the root-owned service configuration and account before deployment.')
 if action=='app-deploy' and recipe and recipe.get('kind')=='django':
  venv=os.path.dirname(os.path.dirname(recipe.get('python','')));vstat=os.lstat(venv)
  if not os.path.isabs(venv) or os.path.realpath(venv)!=venv or not (venv.startswith('/var/www/') or venv.startswith(u.pw_dir+'/')) or not stat.S_ISDIR(vstat.st_mode) or vstat.st_uid!=uid or not stat.S_ISREG(os.lstat(venv+'/pyvenv.cfg').st_mode):fail('VENV_REQUIRED','Use an account-owned existing virtual environment under /var/www or the account home.')
 manifest={'version':1,'id':i,'uid':uid,'gid':u.pw_gid,'username':u.pw_name,'directory':d,'device':str(s.st_dev),'inode':str(s.st_ino),'projectId':projectId,'action':action,'bootId':boot}
 if action=='site-deploy':
  recipe['device']=str(s.st_dev);recipe['inode']=str(s.st_ino)
  values=recipe.pop('environment',{})
  if not isinstance(values,dict) or len(values)>200:fail('INVALID_ENV','Invalid protected environment settings.')
  lines=[]
  for key,value in values.items():
   if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,127}',key) or not isinstance(value,str) or len(value)>32768 or any(ord(c)<32 for c in value):fail('INVALID_ENV','Use single-line literal environment values.')
   lines.append(key+'='+json.dumps(value,ensure_ascii=False)+'\n')
  fd=os.open(p+'/environment.input',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
  with os.fdopen(fd,'w') as f:f.write(''.join(lines))
  lockfile='/var/lib/rootpath/configuration.lock'
  lockfd=os.open(lockfile,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600);lockstat=os.fstat(lockfd);os.close(lockfd)
  if not stat.S_ISREG(lockstat.st_mode) or lockstat.st_uid!=0 or lockstat.st_mode&0o077:fail('UNSAFE_LOCK','Administrative lock is unsafe.')
  source=q.get('hostingSource')
  if not isinstance(source,str) or len(source)>100000:fail('INVALID_RUNNER','Missing protected hosting adapter.')
  fd=os.open(p+'/hosting-v1.py',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o500)
  with os.fdopen(fd,'w') as f:f.write(source)
 if action=='custom-deploy':
  body=recipe.pop('scriptBody',None)
  if not isinstance(body,str) or len(body.encode())>65536 or hashlib.sha256(body.encode()).hexdigest()!=recipe.get('scriptRevision'):fail('SCRIPT_CHANGED','The reviewed script revision does not match.')
  script=p+'/approved-script.sh';fd=os.open(script,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o640);os.fchown(fd,0,u.pw_gid)
  with os.fdopen(fd,'w') as f:f.write(body)
  recipe['scriptPath']=script
 if recipe and recipe.get('artifact'):
  a=recipe['artifact'];incoming=a.get('path','')
  if os.path.dirname(incoming)!=u.pw_dir or not re.fullmatch(r'\.rootpath-bundle-[a-f0-9-]{36}',os.path.basename(incoming)) or not re.fullmatch(r'[a-f0-9]{64}',a.get('sha256','')) or not isinstance(a.get('size'),int) or not 0<a['size']<=512*1024*1024:fail('INVALID_ARTIFACT','Invalid reviewed bundle identity.')
  src=os.open(incoming,os.O_RDONLY|os.O_NOFOLLOW);st=os.fstat(src)
  if not stat.S_ISREG(st.st_mode) or st.st_uid!=uid or st.st_mode&0o077 or st.st_size!=a['size']:fail('INVALID_ARTIFACT','The incoming bundle has unsafe ownership or permissions.')
  dst=os.open(p+'/code.bundle',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o640);os.fchown(dst,0,u.pw_gid);h=hashlib.sha256();size=0
  with os.fdopen(src,'rb') as source,os.fdopen(dst,'wb') as target:
   for chunk in iter(lambda:source.read(262144),b''):
    size+=len(chunk)
    if size>a['size']:fail('ARTIFACT_CHANGED','The incoming bundle grew during admission.')
    h.update(chunk);target.write(chunk)
   target.flush();os.fsync(target.fileno())
  if size!=a['size'] or h.hexdigest()!=a['sha256']:fail('ARTIFACT_CHANGED','The transferred Git bundle failed verification.')
  recipe['artifact']={**a,'path':p+'/code.bundle'};os.unlink(incoming)
 if recipe:manifest['recipe']=recipe
 if recipe:
  source=q.get('recipeSource')
  if not isinstance(source,str) or len(source)>100000:fail('INVALID_RUNNER','Missing application recipe.')
  fd=os.open(p+'/static-v1.py',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o500)
  with os.fdopen(fd,'w') as f:f.write(source)
 write(p+'/manifest.json',manifest)
 write(p+'/status.json',{'id':i,'projectId':projectId,'action':'connection-check','status':'queued','step':0,'totalSteps':5,'bootId':boot,'message':'Job submitted.'})
 runner=q.get('runner')
 if not isinstance(runner,str) or hashlib.sha256(runner.encode()).hexdigest()!=q.get('runnerHash'):fail('INVALID_RUNNER','Runner verification failed.')
 # Runner text is supplied only by the application main process, never the UI.
 fd=os.open(p+'/runner-v1.py',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o500)
 with os.fdopen(fd,'w') as f:f.write(runner)
 command=['/usr/bin/systemd-run','--quiet','--collect','--unit='+unit,'--property=Type=exec','--property=Restart=no','--property=UMask=0027','--property=KillMode=control-group','--property=TimeoutStopSec=20','--property=NoNewPrivileges=yes','--property=PrivateTmp=yes','--property=ProtectSystem=strict','--property=ReadWritePaths='+p,'--property=ReadWritePaths='+base+'/locks','/usr/bin/python3','-I',p+'/runner-v1.py',p]
 if action=='site-deploy':
  for configPath in ['/etc/nginx','/etc/systemd/system','/var/lib/rootpath/configuration.lock','-/var/log/nginx']:command.insert(-4,'--property=ReadWritePaths='+configPath)
 if recipe and action!='host-packages':command.insert(-4,'--property=ReadWritePaths='+json.dumps(d.replace('%','%%'),ensure_ascii=False))
 if action=='app-deploy' and recipe and recipe.get('kind')=='django':command.insert(-4,'--property=ReadWritePaths='+json.dumps(venv.replace('%','%%'),ensure_ascii=False))
 if action=='host-packages':command=[x for x in command if x not in ['--property=ProtectSystem=strict']]
 r=subprocess.run(command,capture_output=True,timeout=20)
 if r.returncode:
  os.unlink(p+'/status.json');write(p+'/status.json',{'id':i,'projectId':projectId,'status':'failed','message':'Systemd rejected the job. No deployment was performed.'});fail('JOB_START_FAILED','Systemd rejected the reviewed background check.')
 result(status(p))
except (OSError,ValueError,KeyError,subprocess.SubprocessError):fail('JOB_CONTROL_FAILED','Job control could not be completed. Recover the existing job identity before retrying.')
