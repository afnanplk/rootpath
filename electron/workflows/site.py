# Runs only as the ordinary account inside a durable protected job.
def create_site(q,emit):
 s=q['site'];d=q['directory'];app_options({'directory':d,'kind':'react','healthUrl':'http://127.0.0.1/','runtimeBin':s.get('runtimeBin','')})
 with os.scandir(d) as entries:nonempty=next(entries,None) is not None
 if nonempty:refuse('DIRECTORY_NOT_EMPTY','The new directory is no longer empty. Import it instead; no files were replaced.')
 env,secrets=app_environment({'directory':d,'runtimeBin':s.get('runtimeBin','')})
 env.update({'GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null','GIT_TERMINAL_PROMPT':'0','GIT_SSH_COMMAND':'/usr/bin/ssh -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=yes -o ClearAllForwardings=yes -o PermitLocalCommand=no -o ConnectTimeout=15'})
 git=shutil.which('git',path=env['PATH'])
 if not git:refuse('GIT_REQUIRED','Install the reviewed Git dependency first.')
 def command(args,timeout=1200):
  # No application output is persisted here; each bounded stage reports its result.
  with tempfile.TemporaryFile() as output:
   proc=subprocess.Popen(args,cwd=d,env=env,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
   try:code=proc.wait(timeout=timeout)
   except subprocess.TimeoutExpired:os.killpg(proc.pid,signal.SIGKILL);proc.wait();refuse('CREATE_TIMEOUT','Workspace creation timed out. Inspect the partial directory before importing or retrying.')
   if code:refuse('CREATE_STAGE_FAILED','Creation stopped at '+os.path.basename(args[0])+' (exit '+str(code)+'). Git hosts must already be trusted. No existing project was changed.')
 emit('Checking out the pinned Git bundle as the connected account.' if q.get('artifact') else 'Cloning the reviewed SSH repository as the connected account; no unknown Git key is accepted.')
 prefix=[git,'-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','protocol.allow=never','-c','protocol.ssh.allow=always']
 if q.get('artifact'):
  a=q['artifact'];p=a['path'];h=hashlib.sha256()
  with open(p,'rb') as f:
   for chunk in iter(lambda:f.read(262144),b''):h.update(chunk)
  if h.hexdigest()!=a['sha256']:refuse('ARTIFACT_CHANGED','The protected bundle failed verification.')
  prefix+=['-c','protocol.file.allow=always']
  command(prefix+['init','--initial-branch='+s['branch']],30);command(prefix+['remote','add','origin',s['repository']],30)
  command(prefix+['bundle','verify',p],30);command(prefix+['fetch','--no-tags','--',p,a['ref']],180)
  target=subprocess.run(prefix+['rev-parse','FETCH_HEAD'],cwd=d,env=env,capture_output=True,timeout=30)
  if target.returncode or target.stdout.decode().strip()!=a['commit']:refuse('ARTIFACT_CHANGED','The bundle commit differs from the reviewed revision.')
  command(prefix+['update-ref','refs/heads/'+s['branch'],a['commit']],30)
 else:
  command(prefix+['clone','--no-checkout','--single-branch','--no-tags','--branch',s['branch'],'--',s['repository'],d],180)
 tree=subprocess.run(prefix+['ls-tree','-r','-z','HEAD'],cwd=d,env=env,capture_output=True,timeout=30)
 if tree.returncode or len(tree.stdout)>1048576:refuse('REPOSITORY_LIMIT','Repository tree exceeds the supported review limit.')
 for row in tree.stdout.split(b'\0'):
  if not row:continue
  metadata,path=row.split(b'\t',1);name=path.decode('utf-8');parts=name.split('/')
  if metadata.split()[0] not in [b'100644',b'100755'] or any(x in ['node_modules','.venv','venv'] or x=='.env' or x.startswith('.env.') and x not in ['.env.example','.env.sample','.env.template'] or x.endswith(('.pem','.key','.sql','.sqlite3','.bak')) for x in parts):refuse('UNSAFE_REPOSITORY','Remove links, submodules, tracked dependencies and private files before creating this project.')
 command(prefix+['checkout','--force',s['branch']],60);os.chmod(d+'/.git',0o700)
 fd=os.open(d+'/.env',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600);os.close(fd)
 with open(d+'/.git/info/exclude','a') as f:f.write('\n/.env\n/.venv/\n/node_modules/\n')
 if q.get('cloneOnly'):
  if s['kind']=='django':command(['/usr/bin/python3','-m','venv',d+'/.venv'],180)
  emit('Pinned repository checkout ready. Dependency and hosting stages have not run.');return {}
 options={'directory':d,'kind':s['kind'],'healthUrl':'http://127.0.0.1/','runtimeBin':s.get('runtimeBin',''),'envFile':'','allowedEnvFiles':[],'output':s.get('output','dist'),'frontend':'','installMode':s.get('installMode','locked'),'build':s.get('build',False),'requirements':s.get('requirements','requirements.txt')}
 if s['kind']=='django':
  if not os.path.isfile(d+'/manage.py') or not os.path.isfile(d+'/'+options['requirements']):refuse('DJANGO_FILES_REQUIRED','The repository needs manage.py and the selected requirements file.')
  emit('Creating this new project’s virtual environment. Existing environments are untouched.')
  command(['/usr/bin/python3','-m','venv',d+'/.venv'],180);options['python']=d+'/.venv/bin/python';options['databaseAlias']='default';app_stage(options,'install',emit=emit)
  emit('Dependencies installed. Configure .env and the database through project tools before reviewing migrations or starting the service.')
 elif s['kind'] in ['node','react']:
  app_stage(options,'install',emit=emit);app_stage(options,'validate',emit=emit)
 else:
  output=d+('/'+s['output'] if s.get('output') else '')
  if os.path.realpath(output)!=output or not os.path.isfile(output+'/index.html'):refuse('OUTPUT_MISSING','The selected static output has no index.html.')
 emit('Workspace created. Review environment/database settings, then configure hosting and HTTPS in separate reviewed steps.')
 return {'message':'New workspace created; hosting activation and application/database setup require their own reviews.'}
