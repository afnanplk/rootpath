# App-owned application stages. This source is appended to the Git/backup adapter.
import urllib.request,urllib.parse,sqlite3,tempfile,codecs

def app_installation(package,locks,load):
 managers=set('npm' if x.endswith('.json') else 'pnpm' if x.startswith('pnpm') else 'yarn' for x in locks)
 if len(managers)>1:refuse('LOCKFILE_CONFLICT','Multiple package-manager lockfiles require review.')
 declared=str(package.get('packageManager','')).split('@')[0];manager=next(iter(managers),declared or 'npm')
 if declared and declared!=manager:refuse('LOCKFILE_CONFLICT','Declared package manager conflicts with the lockfile.')
 if manager not in ['npm','pnpm','yarn']:refuse('PACKAGE_MANAGER_REQUIRED','Unsupported package manager.')
 compatible=bool(locks)
 if manager=='npm' and locks:
  try:
   lock=load('npm-shrinkwrap.json' if 'npm-shrinkwrap.json' in locks else 'package-lock.json');version=lock.get('lockfileVersion');compatible=version in [1,2,3]
   if version in [2,3]:
    root=lock.get('packages',{}).get('',{});compatible=compatible and all(package.get(k,{})==root.get(k,{}) for k in ['dependencies','devDependencies','optionalDependencies'])
  except (OSError,ValueError,TypeError,AttributeError):compatible=False
 return manager,compatible

def app_options(q):
 kind=q.get('kind');d=q['directory']
 if kind not in ['django','node','react']:refuse('INVALID_RECIPE','Choose Django, Node or React.')
 def relative(value,empty=False):
  if empty and value=='':return value
  if not isinstance(value,str) or not re.fullmatch(r'[A-Za-z0-9_./ -]{1,200}',value) or any(x in ['','..','.'] for x in value.split('/')) or value.startswith('/'):refuse('INVALID_PATH','Use a relative project path without parent traversal.')
  return value
 if q.get('pm2Id') is not None and not re.fullmatch(r'[0-9]{1,9}',q['pm2Id']):refuse('INVALID_PM2','Choose a numeric mapped PM2 application.')
 runtime=q.get('runtimeBin','')
 if runtime:
  if not os.path.isabs(runtime) or os.path.realpath(runtime)!=runtime or not os.path.isdir(runtime) or not os.access(runtime+'/node',os.X_OK) or not (runtime in ['/usr/bin','/usr/local/bin'] or runtime.startswith(os.path.expanduser('~')+'/') and os.stat(runtime).st_uid==os.getuid()):refuse('RUNTIME_REQUIRED','Choose an existing Node bin folder under the account home, /usr/bin or /usr/local/bin.')
 url=q.get('healthUrl','');u=urllib.parse.urlsplit(url)
 if u.scheme not in ['http','https'] or not u.hostname or u.username or u.password or u.fragment or len(url)>2048:refuse('INVALID_HEALTH','Enter an HTTP/HTTPS health URL without credentials or a fragment.')
 for key in ['requirements','frontend','frontendOutput']:
  if q.get(key):relative(q[key])
 if q.get('envFile'):
  if q['envFile'] not in q.get('allowedEnvFiles',[]) or not q['envFile'].startswith(d+'/') or os.path.realpath(q['envFile'])!=q['envFile']:refuse('INVALID_ENV','Select a discovered regular environment file.')
 if kind=='django':
  python=q.get('python','');venv=os.path.dirname(os.path.dirname(python))
  if not os.path.isabs(python) or os.path.basename(python) not in ['python','python3'] or os.path.basename(os.path.dirname(python))!='bin' or not os.path.isfile(venv+'/pyvenv.cfg') or not os.access(python,os.X_OK):refuse('VENV_REQUIRED','Choose the absolute bin/python executable of an existing virtual environment.')
  if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,63}',q.get('databaseAlias','default')):refuse('INVALID_DATABASE','Choose a named Django database alias.')
  relative(q.get('requirements','requirements.txt'))
 else:
  if kind=='react':relative(q.get('output','dist'))
 return q

def app_preview(q):
 app_options(q);v=run_recipe(q);v['kind']=q['kind'];v['warnings'].append('Approved application code, dependency lifecycle scripts and build scripts run as the connected account. Only deploy code you trust.');v['warnings'].append('Build dependencies, virtual environments and SQLite files are excluded from the code archive; recovery is not an environment or database rollback.')
 return v

def app_environment(q):
 cache=tempfile.mkdtemp(prefix='rootpath-build-cache-');env={'npm_config_cache':cache+'/npm','PIP_CACHE_DIR':cache+'/pip','XDG_CACHE_HOME':cache+'/xdg','XDG_DATA_HOME':cache+'/data','YARN_CACHE_FOLDER':cache+'/yarn','YARN_GLOBAL_FOLDER':cache+'/yarn-global','npm_config_store_dir':cache+'/pnpm','PATH':(q.get('runtimeBin','')+':' if q.get('runtimeBin') else '')+'/usr/local/bin:/usr/bin:/bin','HOME':os.path.expanduser('~'),'LANG':'C.UTF-8','PYTHONUNBUFFERED':'1','PIP_NO_INPUT':'1','CI':'true','NODE_ENV':'production'};secrets=[]
 if q.get('envFile'):
  if os.path.getsize(q['envFile'])>262144:refuse('INVALID_ENV','Environment file exceeds the supported size.')
  with open(q['envFile']) as envInput:environmentLines=envInput.readlines()
  for line in environmentLines:
   line=line.strip()
   if not line or line.startswith('#'):continue
   if line.startswith('export '):line=line[7:]
   match=re.fullmatch(r'([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)',line)
   if not match:refuse('INVALID_ENV','Use single-line KEY=value environment entries. Complex environment parsing requires review.')
   key,value=match.groups()
   if value.startswith('"'):
    try:value=json.loads(value)
    except ValueError:refuse('INVALID_ENV','Use a valid quoted single-line literal environment value.')
    if not isinstance(value,str) or any(ord(c)<32 for c in value):refuse('INVALID_ENV','Use a single-line environment value without control characters.')
   elif value.startswith("'"):
    if value[-1:]!="'" or len(value)<2 or "'" in value[1:-1]:refuse('INVALID_ENV','Use a valid single-quoted literal value.')
    value=value[1:-1]
   elif '$' in value or '`' in value:refuse('INVALID_ENV','Quote literal dollar signs or backticks. Environment interpolation is not evaluated.')
   if key in ['PATH','HOME','PYTHONPATH','PYTHONHOME','LD_PRELOAD','LD_LIBRARY_PATH','NODE_OPTIONS','BASH_ENV','ENV','SHELLOPTS'] or key.startswith(('GIT_','SUDO_')):refuse('UNSAFE_ENV','Environment file contains executable runtime overrides. Review these separately.')
   env[key]=value
   if value and (len(value)>=4 or re.search(r'password|passphrase|secret|token|key|credential',key,re.I)):secrets.append(value)
 return env,secrets

def app_stage(q,stage,backup_fd=None,database_fd=None,emit=lambda s:None):
 if sys.platform.startswith('linux'):
  import ctypes
  if ctypes.CDLL(None).prctl(4,0,0,0,0)!=0:refuse('PROCESS_PROTECTION_REQUIRED','Could not protect the recipe process from same-account tracing.')
 app_options(q);d=q['directory'];env,secrets=app_environment(q)
 def clean(s):
  for secret in sorted(secrets,key=len,reverse=True):s=s.replace(secret,'[REDACTED]')
  s=re.sub(r'(?i)((?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*)[^\s]+',r'\1[REDACTED]',s)
  return re.sub(r'([a-z]+://[^\s:/]+:)[^\s@]+@',r'\1[REDACTED]@',s)
 def command(argv,cwd=d,capture=False,timeout=1200,out=None,extra_env=None):
  # Never use a shell. Bound both collected output and each displayed line.
  proc=subprocess.Popen(argv,cwd=cwd,env=extra_env or env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True);sel=selectors.DefaultSelector();streams={};result=bytearray();started=time.monotonic()
  for stream in [proc.stderr,proc.stdout]:sel.register(stream,selectors.EVENT_READ);streams[stream]=[codecs.getincrementaldecoder('utf-8')('replace'),'',False]
  try:
   while sel.get_map():
    if time.monotonic()-started>timeout:refuse('STAGE_TIMEOUT',stage+' exceeded its time limit. Later stages stopped.')
    for key,_ in sel.select(1):
     data=os.read(key.fileobj.fileno(),16384);decoder,pending,dropping=streams[key.fileobj]
     if out is not None and key.fileobj is proc.stdout:
      if os.fstat(out.fileno()).st_size+len(data)>512*1024*1024:refuse('BACKUP_LIMIT','Database backup exceeds 512 MiB; deployment stopped before code changes.')
      out.write(data);out.flush()
      if not data:sel.unregister(key.fileobj)
      continue
     if capture and key.fileobj is proc.stdout:
      result.extend(data)
      if len(result)>262144:refuse('OUTPUT_LIMIT','Stage output exceeds the review limit.')
     text=decoder.decode(data,final=not data);pending+=text
     while '\n' in pending:
      line,pending=pending.split('\n',1)
      if not capture and not dropping:emit(clean(line)[:4096])
      dropping=False
     if len(pending)>65536:pending='';dropping=True;emit('Oversized output line omitted.')
     streams[key.fileobj]=[decoder,pending,dropping]
     if not data:
      if pending and not capture and not dropping:emit(clean(pending)[:4096])
      sel.unregister(key.fileobj)
   code=proc.wait(timeout=5)
   if code:refuse('STAGE_FAILED',stage+' failed (exit '+str(code)+'). Later stages stopped; no rollback is implied.')
   return result.decode('utf-8','replace')
  finally:
   sel.close()
   if proc.poll() is None:os.killpg(proc.pid,signal.SIGKILL);proc.wait()
   if proc.stdout:proc.stdout.close()
   proc.stderr.close()
 def manage(*args,capture=False):return command([q['python'],d+'/manage.py',*args],capture=capture)
 def database_backup():
  if q['kind']!='django':return
  if database_fd is None:refuse('BACKUP_REQUIRED','A protected database backup descriptor is required.')
  if os.fstatvfs(database_fd).f_bavail*os.fstatvfs(database_fd).f_frsize<528*1024*1024:refuse('DISK_SPACE','At least 528 MiB must be available for the bounded database backup.')
  emit('Checking the selected database connection and creating a database recovery backup before updating code.')
  # The settings dictionary stays in this ordinary process and is never emitted or stored in a manifest.
  probe="import json,os;from django.db import connections;c=connections["+repr(q.get('databaseAlias','default'))+"];assert not c.settings_dict.get('ENGINE','').endswith('sqlite3') or os.path.isfile(str(c.settings_dict.get('NAME',''))),'Existing SQLite database required';c.ensure_connection();print('ROOTPATH_DB:'+json.dumps({k:c.settings_dict.get(k) for k in ['ENGINE','NAME','USER','PASSWORD','HOST','PORT','OPTIONS']},default=str))"
  if q.get('newSQLite'):
   # A fresh SQLite database is permitted only at the exact reviewed new-project path.
   initial="import os,sqlite3;from django.db import connections;c=connections["+repr(q.get('databaseAlias','default'))+"];p=str(c.settings_dict.get('NAME',''));assert c.settings_dict.get('ENGINE','').endswith('sqlite3') and p=="+repr(q['newSQLite'])+",'Reviewed SQLite path differs';assert not os.path.lexists(p),'Existing SQLite database requires import';db=sqlite3.connect(p);db.execute('PRAGMA user_version=0');db.close()"
   manage('shell','-c',initial)
  raw=manage('shell','-c',probe,capture=True);lines=[x[len('ROOTPATH_DB:'):] for x in raw.splitlines() if x.startswith('ROOTPATH_DB:')]
  if len(lines)!=1:refuse('DATABASE_UNVERIFIED','Database association could not be verified from live Django settings.')
  db=json.loads(lines[0]);engine=db.get('ENGINE','')
  for k in ['PASSWORD','NAME','USER','HOST']:
   if isinstance(db.get(k),str) and db[k] and (len(db[k])>=4 or k=='PASSWORD'):secrets.append(db[k])
  name=str(db.get('NAME',''));expected=q.get('expectedDatabase')
  if expected:
   actual='postgres' if engine.endswith(('postgresql','postgresql_psycopg2')) else 'mysql' if engine.endswith('mysql') else 'sqlite'
   host=str(db.get('HOST') or '')
   if actual!=expected.get('engine') or name!=expected.get('database') or actual!='sqlite' and (str(db.get('USER') or '')!=expected.get('username') or str(db.get('PORT') or (5432 if actual=='postgres' else 3306))!=str(expected.get('port')) or host not in ['','localhost','127.0.0.1','::1']):refuse('DATABASE_ASSOCIATION_CONFLICT','Live Django database settings do not match this project’s reviewed association. No code update was performed.')
  if engine.endswith('sqlite3'):
   if not os.path.isfile(name):refuse('DATABASE_UNVERIFIED','The configured SQLite database does not exist.')
   connection=sqlite3.connect(name,timeout=20)
   if connection.execute('PRAGMA page_count').fetchone()[0]*connection.execute('PRAGMA page_size').fetchone()[0]>512*1024*1024:refuse('BACKUP_LIMIT','SQLite database exceeds the 512 MiB recipe limit.')
   # SQLite writes through a temporary file owned by this account, then streams into the protected descriptor.
   with tempfile.TemporaryDirectory(prefix='rootpath-db-') as tmp:
    target=tmp+'/backup.sqlite3';dest=sqlite3.connect(target);deadline=time.monotonic()+120
    def progress(status,remaining,total):
     if time.monotonic()>deadline:refuse('BACKUP_TIMEOUT','SQLite backup timed out before any code update.')
    connection.backup(dest,pages=256,progress=progress);ok=dest.execute('PRAGMA quick_check').fetchone()[0];dest.close();connection.close()
    if ok!='ok':refuse('BACKUP_FAILED','SQLite backup verification failed.')
    with open(target,'rb') as f:
     for data in iter(lambda:f.read(262144),b''):os.write(database_fd,data)
   format='sqlite3'
  elif engine.endswith('postgresql') or engine.endswith('postgresql_psycopg2'):
   tool=shutil.which('pg_dump',path=env['PATH']);verify=shutil.which('pg_restore',path=env['PATH'])
   if not tool or not verify:refuse('BACKUP_TOOL_REQUIRED','pg_dump and pg_restore are required before a PostgreSQL deployment.')
   options=db.get('OPTIONS') or {};mapping={'sslmode':'PGSSLMODE','sslcert':'PGSSLCERT','sslkey':'PGSSLKEY','sslrootcert':'PGSSLROOTCERT','sslcrl':'PGSSLCRL','connect_timeout':'PGCONNECT_TIMEOUT','options':'PGOPTIONS','application_name':'PGAPPNAME'}
   if not isinstance(options,dict) or any(k not in mapping for k in options):refuse('DATABASE_OPTIONS_UNSUPPORTED','Review unsupported PostgreSQL connection options before automated backup.')
   pe=dict(env,PGPASSWORD=str(db.get('PASSWORD') or ''),PGDATABASE=name,PGUSER=str(db.get('USER') or ''),PGHOST=str(db.get('HOST') or ''),PGPORT=str(db.get('PORT') or '5432'))
   pe.update({mapping[k]:str(v) for k,v in options.items()})
   with os.fdopen(os.dup(database_fd),'wb') as f:command([tool,'--format=custom','--no-password'],out=f,extra_env=pe)
   # Use stdin to avoid passwords or protected path permissions in command arguments.
   os.lseek(database_fd,0,os.SEEK_SET)
   verify_proc=subprocess.run([verify,'--list'],stdin=database_fd,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,env=env,timeout=120)
   if verify_proc.returncode:refuse('BACKUP_FAILED','PostgreSQL archive verification failed.')
   format='postgresql-custom'
  else:refuse('DATABASE_UNSUPPORTED','This Django recipe currently verifies SQLite and PostgreSQL backups. Other engines require a separately verified backup adapter.')
  os.fsync(database_fd)
  if os.fstat(database_fd).st_size==0:refuse('BACKUP_FAILED','Database backup is empty.')
  emit('Database backup verified ('+format+'). No database credentials were recorded.');return format
 if stage=='custom':
  command(['/bin/bash','-e','-o','pipefail',q['scriptPath']],timeout=1800);return {}
 if stage=='prepare':
  result={}
  def before():result['databaseFormat']=database_backup()
  v=run_recipe(q,backup_fd,emit,before_update=before)
  return {'backupVerified':True,'databaseVerified':q['kind']=='django',**result}
 if stage=='install':
  if q['kind']=='django':command([q['python'],'-m','pip','install','-r',d+'/'+q.get('requirements','requirements.txt')])
  else:
   for folder in ['']+([q['frontend']] if q.get('frontend') else []):
    cwd=d+('/'+folder if folder else '');package=json.load(open(cwd+'/package.json'));locks=[x for x in ['package-lock.json','npm-shrinkwrap.json','pnpm-lock.yaml','yarn.lock'] if os.path.isfile(cwd+'/'+x)]
    manager,locked=app_installation(package,locks,lambda name:json.load(open(cwd+'/'+name)));tool=shutil.which(manager,path=env['PATH'])
    if not tool:refuse('PACKAGE_MANAGER_REQUIRED','Install the detected npm, pnpm or Yarn before deploying.')
    if not locked and q.get('installMode')!='install':refuse('INSTALL_CHOICE_REQUIRED','A compatible lockfile is missing. Explicitly review installation without a compatible lockfile.')
    if manager=='npm':args=['ci','--include=dev'] if locked else ['install','--include=dev']
    elif manager=='pnpm':args=['install','--frozen-lockfile','--prod=false'] if locked else ['install','--no-frozen-lockfile','--prod=false']
    else:
     version=command([tool,'--version'],capture=True,cwd=cwd).strip();args=['install','--frozen-lockfile','--production=false'] if version.startswith('1.') else ['install','--immutable'];args=args if locked else ['install']
    emit('Installing dependencies in '+(folder or 'project root')+' using '+manager+'. Approved lifecycle scripts may execute.')
    command([tool,*args],cwd=cwd)
  return {}
 if stage=='validate':
  if q['kind']=='django':
   manage('check','--deploy','--fail-level','WARNING','--database',q.get('databaseAlias','default'));plan=manage('migrate','--plan','--database',q.get('databaseAlias','default'),'--no-color',capture=True);pending='No planned migration operations.' not in plan
   if len(clean(plan).encode())>2400:refuse('MIGRATION_PLAN_LIMIT','The migration plan exceeds the single-review limit. Split deployment into reviewed revisions.')
   return {'pendingMigrations':clean(plan).splitlines() if pending else [],'migrationHash':hashlib.sha256(plan.encode()).hexdigest()}
  for folder in ['']+([q['frontend']] if q.get('frontend') else []):
   cwd=d+('/'+folder if folder else '');package=json.load(open(cwd+'/package.json'));build=(q['kind']=='react' or bool(folder) or q.get('build',False))
   if build:
    if not isinstance(package.get('scripts'),dict) or not isinstance(package['scripts'].get('build'),str):refuse('BUILD_SCRIPT_REQUIRED','The configured project has no build script.')
    manager='pnpm' if os.path.isfile(cwd+'/pnpm-lock.yaml') else 'yarn' if os.path.isfile(cwd+'/yarn.lock') else 'npm';command([shutil.which(manager,path=env['PATH']),'run','build'],cwd=cwd)
   output=q.get('frontendOutput','dist') if folder else q.get('output','dist')
   if (folder or q['kind']=='react') and not os.path.isfile(cwd+'/'+output+'/index.html'):refuse('BUILD_OUTPUT_MISSING','Build completed without the configured output/index.html. Restart was not performed.')
  return {}
 if stage=='migrate':
  plan=manage('migrate','--plan','--database',q.get('databaseAlias','default'),'--no-color',capture=True)
  if hashlib.sha256(plan.encode()).hexdigest()!=q.get('migrationHash'):refuse('MIGRATION_PLAN_CHANGED','Pending migrations changed since approval. No migration was started.')
  manage('migrate','--noinput','--database',q.get('databaseAlias','default'));return {}
 if stage=='collect':manage('collectstatic','--noinput');return {}
 if stage=='restart':
  if q.get('pm2Id') is not None:
   tool=shutil.which('pm2',path=env['PATH'])
   if not tool:refuse('PM2_REQUIRED','PM2 is unavailable in the connected account’s supported PATH.')
   pmhome=env['HOME']+'/.pm2'
   try:
    pid=int(open(pmhome+'/pm2.pid').read());os.kill(pid,0)
   except (OSError,ValueError):refuse('PM2_NOT_RUNNING','The existing PM2 daemon must be running; Rootpath will not provision one.')
   rows=json.loads(command([tool,'jlist'],capture=True));matches=[x for x in rows if str(x.get('pm_id'))==q['pm2Id'] and os.path.realpath(x.get('pm2_env',{}).get('pm_cwd',''))==d]
   if len(matches)!=1:refuse('PM2_MAPPING_CHANGED','The PM2 application no longer matches this project directory.')
   command([tool,'restart',q['pm2Id']]);rows=json.loads(command([tool,'jlist'],capture=True))
   if not any(str(x.get('pm_id'))==q['pm2Id'] and x.get('pm2_env',{}).get('status')=='online' for x in rows):refuse('RESTART_FAILED','PM2 did not report the application online.')
  return {}
 if stage=='health':
  class NoRedirect(urllib.request.HTTPRedirectHandler):
   def redirect_request(self,*args,**kwargs):return None
  opener=urllib.request.build_opener(NoRedirect)
  for attempt in range(5):
   try:
    with opener.open(urllib.request.Request(q['healthUrl'],headers={'User-Agent':'Rootpath-health/1'}),timeout=10) as response:
     if 200<=response.status<300:return {'health':'HTTP 2xx verified'}
   except Exception:pass
   if attempt<4:time.sleep(3)
  refuse('HEALTH_FAILED','The configured health endpoint did not return HTTP 2xx. Deployment failed; no rollback is implied.')
 refuse('INVALID_STAGE','Unsupported application stage.')
