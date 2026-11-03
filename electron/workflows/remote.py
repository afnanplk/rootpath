# Rootpath guided workflows. Inputs are data; commands use fixed programs and argument arrays.
import os,sys,json,re,stat,hashlib,subprocess,socket,shutil,pwd,uuid,time,fcntl,tempfile,difflib
class Refused(Exception):
 def __init__(self,code,message):self.code=code;super().__init__(message)
def no(code,message):raise Refused(code,message)
def sha(data):return hashlib.sha256(data).hexdigest()
def identity(q):
 d=q.get('directory','');s=os.lstat(d)
 if not d.startswith('/var/www/') or os.path.realpath(d)!=d or not stat.S_ISDIR(s.st_mode) or str(s.st_dev)!=q.get('device') or str(s.st_ino)!=q.get('inode'):no('PROJECT_CHANGED','The reviewed project directory identity changed.')
 return d
def account(q,admin=False):
 uid=int(os.environ.get('SUDO_UID','0')) if os.geteuid()==0 else os.getuid()
 if not uid:no('ACCOUNT_REQUIRED','Use an ordinary project account, with reviewed sudo only when needed.')
 u=pwd.getpwuid(uid)
 if q.get('username')!=u.pw_name:no('ACCOUNT_CHANGED','The connected account does not match this review.')
 if admin and os.geteuid()!=0:no('SUDO_REQUIRED','This reviewed action needs graphical sudo approval.')
 return u
def read(path,limit=262144):
 s=os.lstat(path)
 if not stat.S_ISREG(s.st_mode) or os.path.realpath(path)!=path or s.st_size>limit:no('UNSUPPORTED_FILE','Use a regular file without links, within the supported size limit.')
 with open(path,'rb') as f:return f.read(limit+1)
def execute(args,timeout=30):
 import selectors
 try:
  process=subprocess.Popen(args,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env={'PATH':'/usr/local/bin:/usr/bin:/bin','LANG':'C.UTF-8','HOME':os.path.expanduser('~')},start_new_session=True)
 except OSError:no('TOOL_FAILED','The selected tool is missing.')
 output={process.stdout:bytearray(),process.stderr:bytearray()};deadline=time.monotonic()+timeout;sel=selectors.DefaultSelector()
 try:
  for stream in output:sel.register(stream,selectors.EVENT_READ)
  while sel.get_map():
   if time.monotonic()>deadline:no('TOOL_TIMEOUT','The reviewed tool timed out. Inspect status before retrying a write.')
   for key,_ in sel.select(min(.25,max(0,deadline-time.monotonic()))):
    data=os.read(key.fileobj.fileno(),16384)
    if not data:sel.unregister(key.fileobj);continue
    output[key.fileobj].extend(data)
    if sum(len(x) for x in output.values())>1048576:no('OUTPUT_LIMIT','The tool response exceeded the bounded output limit. Inspect current state before retrying.')
  code=process.wait(timeout=max(1,deadline-time.monotonic()))
  return subprocess.CompletedProcess(args,code,bytes(output[process.stdout]),bytes(output[process.stderr]))
 finally:
  sel.close()
  if process.poll() is None:
   import signal
   os.killpg(process.pid,signal.SIGKILL);process.wait()
  process.stdout.close();process.stderr.close()
def private_dir(path):
 if os.path.lexists(path):
  s=os.lstat(path)
  if not stat.S_ISDIR(s.st_mode) or s.st_uid!=0 or s.st_mode&0o077:no('UNSAFE_BACKUP_PATH','The protected backup directory has unsafe ownership or permissions.')
 else:os.mkdir(path,0o700)
def store(q,u):
 # Config versions are outside every served project and readable only through reviewed sudo.
 for path in ['/var/lib/rootpath','/var/lib/rootpath/config-v1']:
  if not os.path.exists(path):os.mkdir(path,0o700)
  s=os.lstat(path)
  if not stat.S_ISDIR(s.st_mode) or s.st_uid!=0 or s.st_mode&0o022:no('UNSAFE_BACKUP_PATH','The backup parent is unsafe.')
 root='/var/lib/rootpath/config-v1/'+str(u.pw_uid);private_dir(root)
 if not re.fullmatch(r'[0-9a-f-]{36}',q.get('projectId','')):no('INVALID_PROJECT','Invalid project identity.')
 path=root+'/'+q['projectId'];private_dir(path);return path
def atomic(path,data,mode,uid,gid):
 parent=os.path.dirname(path);fd,name=tempfile.mkstemp(prefix='.rootpath-',dir=parent)
 try:
  os.fchmod(fd,mode);os.fchown(fd,uid,gid)
  with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
  os.replace(name,path)
 finally:
  if os.path.exists(name):os.unlink(name)
def env_path(q):
 d=identity(q);name=q.get('file','.env')
 if not re.fullmatch(r'\.env(?:\.[A-Za-z0-9_.-]{1,80})?',name):no('INVALID_FILE','Choose one project .env file, without a path.')
 path=d+'/'+name
 if os.path.realpath(path)!=path:no('UNSAFE_PATH','Environment links are not supported.')
 return path
def project_fd(q):
 fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
 try:
  for part in q['directory'].split('/')[1:]:
   nxt=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);os.close(fd);fd=nxt
  st=os.fstat(fd)
  if str(st.st_dev)!=q['device'] or str(st.st_ino)!=q['inode']:no('PROJECT_CHANGED','The project directory identity changed.')
  return fd
 except Exception:os.close(fd);raise
def env_read(q):
 path=env_path(q);directory=project_fd(q)
 try:
  try:fd=os.open(os.path.basename(path),os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=directory)
  except FileNotFoundError:return b''
  with os.fdopen(fd,'rb') as f:
   st=os.fstat(f.fileno())
   if not stat.S_ISREG(st.st_mode) or st.st_size>262144:no('UNSUPPORTED_FILE','Use a regular environment file up to 256 KiB.')
   data=f.read(262145)
   if len(data)>262144:no('ENV_LIMIT','The environment file exceeds 256 KiB.')
   return data
 finally:os.close(directory)
def parse_env(data):
 text=data.decode('utf-8');values={}
 for line in text.splitlines():
  stripped=line.strip()
  if not stripped or stripped.startswith('#'):continue
  match=re.fullmatch(r'(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)',stripped)
  if not match:no('COMPLEX_ENV','This file needs the text editor: forms support single-line KEY=value entries only.')
  key,value=match.groups()
  if key in values:no('DUPLICATE_ENV','Duplicate environment keys require review in the text editor.')
  if value[:1] in ["'",'"']:
   if len(value)<2 or value[-1]!=value[0]:no('COMPLEX_ENV','Multiline environment values need the text editor.')
  values[key]=value
  if len(values)>500:no('ENV_LIMIT','Use the text editor for environment files with more than 500 keys.')
 return values
def env_inspect(q,u):
 path=env_path(q);data=env_read(q);values=parse_env(data);backups=[]
 if os.geteuid()==0:
  folder=store(q,u)
  for name in sorted(os.listdir(folder),reverse=True)[:200]:
   if not re.fullmatch(r'[0-9a-f-]{36}\.json',name):continue
   try:
    m=json.loads(read(folder+'/'+name));payload=read(folder+'/'+m['id']+'.env')
    if m['file']==q.get('file','.env') and m['hash']==sha(payload):backups.append({'id':m['id'],'time':m['time'],'keys':len(parse_env(payload))})
   except (OSError,ValueError,Refused):continue
 return {'file':q.get('file','.env'),'exists':os.path.exists(path),'revision':sha(data),'fields':[{'key':k,'hasValue':bool(v)} for k,v in values.items()],'backups':backups,'protectedBackups':os.geteuid()==0}
def save_env(q,u):
 account(q,True);path=env_path(q);old=env_read(q)
 if sha(old)!=q.get('revision'):no('CONFIG_CHANGED','The environment changed after inspection. Reload masked keys before saving.')
 values=parse_env(old);originalKeys=set(values);changes=q.get('changes',[])
 if not isinstance(changes,list) or len(changes)>500:no('INVALID_ENV','Choose at most 500 key changes.')
 if q.get('operation')=='envRestore':
  backup=q.get('backup','')
  if not re.fullmatch(r'[0-9a-f-]{36}',backup):no('INVALID_BACKUP','Select a protected configuration version.')
  folder=store(q,u);meta=json.loads(read(folder+'/'+backup+'.json'));data=read(folder+'/'+backup+'.env')
  if meta.get('file')!=q.get('file','.env') or meta.get('hash')!=sha(data):no('BACKUP_CHANGED','The selected configuration version is invalid.')
  parse_env(data)
 else:
  for change in changes:
   key=change.get('key','')
   if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,127}',key):no('INVALID_KEY','Use ordinary environment variable names.')
   if change.get('remove') is True:values.pop(key,None)
   else:
    value=change.get('value')
    if not isinstance(value,str) or any(c in value for c in ['\n','\r','\0']) or len(value)>32768:no('INVALID_VALUE','Use a single-line value up to 32 KiB.')
    # Quote literal values; interpolation is never evaluated by this helper.
    if "'" in value or '`' in value or '$' in value:no('COMPLEX_ENV','Use resolved literal values without quotes, interpolation or command substitutions in this form.')
    values[key]="'"+value+"'"
  changed={x['key']:x for x in changes};lines=[]
  for line in old.decode('utf-8').splitlines():
   match=re.match(r'\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=',line);key=match.group(1) if match else None
   if key in changed:
    if not changed[key].get('remove'):lines.append(key+'='+values[key])
   else:lines.append(line)
  for change in changes:
   if change['key'] not in originalKeys and not change.get('remove'):lines.append(change['key']+'='+values[change['key']])
  data=('\n'.join(lines)+'\n').encode()
 if len(data)>262144:no('ENV_LIMIT','The environment file exceeds 256 KiB.')
 folder=store(q,u);i=str(uuid.uuid4());atomic(folder+'/'+i+'.env',old,0o600,0,0);atomic(folder+'/'+i+'.json',json.dumps({'id':i,'time':time.time(),'file':q.get('file','.env'),'hash':sha(old)}).encode(),0o600,0,0)
 # One reviewed file only: never recurse or change another project's ownership.
 fd=project_fd(q)
 try:
  if sha(env_read(q))!=q.get('revision'):no('CONFIG_CHANGED','The environment changed before save.')
  name='.rootpath-'+str(uuid.uuid4());out=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=fd)
  try:
   os.fchown(out,u.pw_uid,u.pw_gid)
   with os.fdopen(out,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
   os.replace(name,os.path.basename(path),src_dir_fd=fd,dst_dir_fd=fd)
  finally:
   try:os.unlink(name,dir_fd=fd)
   except FileNotFoundError:pass
 finally:os.close(fd)
 return {'message':'Configuration saved with a protected previous version. This file is private to the connected account; no service was restarted.','backup':i,'revision':sha(data)}
def site_validate(s):
 name=s.get('name','');kind=s.get('kind');repo=s.get('repository','');branch=s.get('branch','main')
 if not re.fullmatch(r'[a-z][a-z0-9-]{1,47}',name) or kind not in ['static','django','node','react']:no('INVALID_SITE','Choose a lowercase project name and supported template.')
 if not (re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]*@[A-Za-z0-9][A-Za-z0-9.-]*:[A-Za-z0-9_./-]+',repo) or re.fullmatch(r'ssh://[A-Za-z0-9_][A-Za-z0-9_.-]*@[A-Za-z0-9][A-Za-z0-9.-]*(?::[0-9]{1,5})?/[A-Za-z0-9_./-]+',repo)):no('SSH_REMOTE_REQUIRED','Use an SSH Git repository without passwords or custom transports.')
 if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_./-]{0,199}',branch) or '..' in branch or branch.endswith(('/','.')):no('INVALID_BRANCH','Choose a normal branch name.')
 domains=s.get('domains',[])
 if not isinstance(domains,list) or not 1<=len(domains)<=5 or any(not re.fullmatch(r'(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}',x) for x in domains):no('INVALID_DOMAIN','Enter up to five public DNS hostnames.')
 if not isinstance(s.get('port',8000),int) or not 1024<=s.get('port',8000)<=65535:no('INVALID_PORT','Choose an application port from 1024 to 65535.')
 for key in ['output','requirements','entry','staticDir']:
  value=s.get(key,'')
  if value and (not isinstance(value,str) or not re.fullmatch(r'[A-Za-z0-9_./:-]{1,200}',value) or any(x in ['..',''] for x in value.split('/')) or value.startswith('/')):no('INVALID_PATH','Use simple relative application paths or a Python module entry point.')
 if kind=='django' and not re.fullmatch(r'[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*:application',s.get('entry','')):no('INVALID_ENTRY','Use a WSGI entry such as config.wsgi:application.')
 runtime=s.get('runtimeBin','')
 if runtime:
  u=pwd.getpwuid(int(os.environ.get('SUDO_UID',os.getuid())))
  if not isinstance(runtime,str) or not re.fullmatch(r'/[A-Za-z0-9_./-]+',runtime) or os.path.realpath(runtime)!=runtime or not (runtime in ['/usr/bin','/usr/local/bin'] or runtime.startswith(u.pw_dir+'/')) or not os.path.isfile(runtime+'/node'):no('INVALID_RUNTIME','Select an existing canonical Node bin directory owned by this account or the system.')
  st=os.stat(runtime)
  if st.st_uid not in [0,u.pw_uid] or st.st_mode&0o022:no('INVALID_RUNTIME','The runtime directory permissions are unsafe.')
 return s
def git_host(site):
 import urllib.parse
 site_validate(site);repo=site['repository']
 if repo.startswith('ssh://'):v=urllib.parse.urlsplit(repo);return v.hostname,v.port or 22
 return repo.split('@',1)[1].split(':',1)[0],22
def known_hosts(u):
 folder=u.pw_dir+'/.ssh'
 if os.path.lexists(folder):
  st=os.lstat(folder)
  if not stat.S_ISDIR(st.st_mode) or st.st_uid!=u.pw_uid or st.st_mode&0o022 or os.path.realpath(folder)!=folder:no('UNSAFE_SSH_PATH','The account .ssh directory must be canonical and account-owned without shared write access.')
 path=folder+'/known_hosts'
 if os.path.lexists(path):
  st=os.lstat(path)
  if st.st_uid!=u.pw_uid or st.st_mode&0o022:no('UNSAFE_SSH_PATH','known_hosts must be account-owned without shared write access.')
  return path,read(path,1048576)
 return path,b''
def git_trust(q,u,save=False):
 import base64
 host,port=git_host(q['site']);token=host if port==22 else '['+host+']:'+str(port);path,current=known_hosts(u)
 if save:
  if sha(current)!=q.get('revision'):no('GIT_TRUST_CHANGED','Git host trust changed after review. Inspect fingerprints again.')
  keys=q.get('keys',[])
 else:
  r=execute(['/usr/bin/ssh-keyscan','-T','5','-p',str(port),'-t','ed25519,rsa',host],12)
  if r.returncode or not r.stdout:no('GIT_HOST_UNAVAILABLE','The repository host did not return SSH keys. Check its host and port.')
  keys=r.stdout.decode('ascii').splitlines()
 values=[]
 for line in keys:
  if line.startswith('#'):continue
  parts=line.split()
  if len(parts)!=3 or parts[0]!=token or parts[1] not in ['ssh-ed25519','ssh-rsa']:no('INVALID_GIT_KEY','Unsupported Git host key response.')
  try:raw=base64.b64decode(parts[2],validate=True)
  except ValueError:no('INVALID_GIT_KEY','Invalid SSH public key.')
  if not 32<=len(raw)<=16384:no('INVALID_GIT_KEY','Invalid SSH key size.')
  values.append({'line':line,'type':parts[1],'fingerprint':'SHA256:'+base64.b64encode(hashlib.sha256(raw).digest()).decode().rstrip('=')})
 if not values or len(values)>8:no('INVALID_GIT_KEY','Review a bounded set of repository host keys.')
 if save:
  # ssh-keygen resolves hashed existing host entries; changed keys are never replaced by this action.
  if current:
   found=execute(['/usr/bin/ssh-keygen','-F',token,'-f',path],5).stdout.decode('utf-8','replace')
   for line in found.splitlines():
    if line.startswith('#'):continue
    parts=line.split()
    for v in values:
     if len(parts)>=3 and parts[1]==v['type'] and parts[2]!=v['line'].split()[2]:no('GIT_HOST_CHANGED','An existing key for this host changed. Investigate it before replacing trusted keys; Rootpath will not replace it automatically.')
  folder=os.path.dirname(path)
  if not os.path.exists(folder):os.mkdir(folder,0o700)
  addition=''.join(v['line']+'\n' for v in values if v['line'] not in current.decode('utf-8','replace').splitlines());data=current+(b'\n' if current and not current.endswith(b'\n') else b'')+addition.encode()
  if len(data)>1048576:no('GIT_TRUST_LIMIT','known_hosts exceeds the supported size limit.')
  atomic(path,data,0o600,u.pw_uid,u.pw_gid);return {'message':'Reviewed repository SSH host keys saved for this VPS account. Existing keys were preserved.'}
 return {'host':host,'port':port,'revision':sha(current),'keys':[v['line'] for v in values],'fingerprints':[{'type':v['type'],'fingerprint':v['fingerprint']} for v in values],'warning':'Key scanning is not proof of identity. Verify every fingerprint through the Git provider’s independent published channel before trusting it.'}
def site_preview(q,u):
 s=site_validate(q['site']);d='/var/www/'+s['name']
 if os.path.lexists(d):no('DIRECTORY_EXISTS','This directory already exists. Import it instead of creating over it.')
 parent=os.lstat('/var/www')
 if not stat.S_ISDIR(parent.st_mode) or os.path.realpath('/var/www')!='/var/www' or parent.st_uid!=0 or parent.st_mode&0o022:no('UNSAFE_PARENT','/var/www must be a protected root-owned directory before creating a site.')
 missing=[]
 for tool,package in [('git','git'),('nginx','nginx')]+([('certbot','certbot')] if s.get('https') else []):
  if not shutil.which(tool):missing.append(package)
 if s['kind']=='django' and not os.path.isfile('/usr/lib/python3.12/ensurepip/__init__.py'):
  r=execute(['/usr/bin/python3','-c','import ensurepip'],5)
  if r.returncode:missing.append('python3-venv')
 if s['kind'] in ['node','react'] and not shutil.which('node') and not s.get('runtimeBin'):missing.extend(['nodejs','npm'])
 target=set()
 try:target={x[4][0] for x in socket.getaddrinfo(q['serverHost'],None)}
 except OSError:pass
 dns=[]
 for domain in s['domains']:
  try:addresses=sorted({x[4][0] for x in socket.getaddrinfo(domain,None)})
  except OSError:addresses=[]
  dns.append({'domain':domain,'addresses':addresses,'matches':bool(target.intersection(addresses))})
 occupied=False
 if s['kind'] in ['django','node']:
  with socket.socket() as sock:sock.settimeout(.4);occupied=sock.connect_ex(('127.0.0.1',s.get('port',8000)))==0
 manager='apt' if os.path.isfile('/usr/bin/apt-get') else 'dnf' if os.path.isfile('/usr/bin/dnf') else None
 return {'directory':d,'dns':dns,'portOccupied':occupied,'missing':sorted(set(missing)),'packageManager':manager,'systemd':os.path.isdir('/run/systemd/system'),'nginx':shutil.which('nginx') is not None,'configs':templates(s,u.pw_name),'fixture':False,'steps':['Create only the new directory under /var/www, owned by '+u.pw_name+'.','Clone the reviewed SSH remote with strict Git-host trust.','Create an empty private .env; install/build trusted project dependencies as this account.','Complete environment/database configuration in project tools.','Review hosting files separately; validate Nginx before enabling or reloading.','Review HTTPS issuance only after DNS and HTTP prerequisites pass.']}
def templates(s,username):
 s=site_validate(s);d='/var/www/'+s['name'];domains=' '.join(s['domains']);service='rootpath-'+s['name']+'.service';prefix='# Managed by Rootpath: '+s['name']+'\n'
 deny='    location ~ /\\.(?!well-known(?:/|$)) { deny all; }\n    location ~* \\.(?:env|bak|old|orig|sql|dump|sqlite3|pem|key|log|ini|conf|toml|yaml|yml|py|sh|tar|gz|zip|7z)$ { deny all; }\n'
 deny+='    location ~* ^/(?:backups?|node_modules|venv)(?:/|$) { deny all; }\n    location ~* ^/(?:package(?:-lock)?[.]json|yarn[.]lock|pnpm-lock[.]yaml|requirements[^/]*[.]txt)$ { deny all; }\n'
 if s['kind'] in ['static','react']:
  root=d+('/'+s['output'] if s.get('output') else '');body='    root '+root+';\n    index index.html;\n    location / { try_files $uri $uri/ '+('/index.html' if s['kind']=='react' else '=404')+'; }\n';unit=None
 else:
  body='    location / { proxy_pass http://127.0.0.1:'+str(s.get('port',8000))+'; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; proxy_set_header X-Forwarded-Proto $scheme; }\n'
  if s['kind']=='django' and s.get('staticDir'):body+='    location /static/ { alias '+d+'/'+s['staticDir']+'/; }\n'
  args=[d+'/.venv/bin/python','-m','gunicorn','--bind','127.0.0.1:'+str(s.get('port',8000)),s['entry']] if s['kind']=='django' else [(s.get('runtimeBin') or '/usr/bin')+'/node',d+'/'+s.get('entry','server.js')]
  # Quote systemd path tokens and escape specifiers, without a shell.
  command=' '.join(json.dumps(x.replace('%','%%')) for x in args)
  unit=prefix+'[Unit]\nDescription=Rootpath '+s['name']+'\nAfter=network.target\n[Service]\nType=simple\nUser='+username+'\nWorkingDirectory='+d+'\nEnvironmentFile=-'+d+'/.env\nExecStart='+command+'\nRestart=on-failure\nUMask=0027\nNoNewPrivileges=true\n[Install]\nWantedBy=multi-user.target\n'
 return {'nginx':prefix+'server {\n    listen 80;\n    disable_symlinks on;\n    server_name '+domains+';\n'+body+deny+'}\n','service':unit,'serviceName':service if unit else None,'siteName':'rootpath-'+s['name']+'.conf'}
def root_directory(path):
 s=os.lstat(path)
 if not stat.S_ISDIR(s.st_mode) or s.st_uid!=0 or s.st_mode&0o022 or os.path.realpath(path)!=path:no('UNSAFE_CONFIG_PATH','The system configuration directory is unsafe.')
def configure_site(q,u):
 account(q,True);d=identity(q);s=site_validate(q['site'])
 if d!='/var/www/'+s['name']:no('INVALID_SITE','The hosting template does not match this project directory.')
 for root in ['/etc/nginx/sites-available','/etc/nginx/conf.d']:
  if not os.path.isdir(root):continue
  for name in os.listdir(root)[:2000]:
   try:text=read(root+'/'+name).decode('utf-8')
   except (OSError,Refused,UnicodeError):continue
   for names in re.findall(r'\bserver_name\s+([^;]+);',text):
    if set(names.split()).intersection(s['domains']):no('DOMAIN_CONFLICT','A domain already belongs to an existing Nginx configuration. Resolve the mapping before creating another site.')
 cfg=templates(s,u.pw_name);layout='/etc/nginx/sites-available' if os.path.isdir('/etc/nginx/sites-available') else '/etc/nginx/conf.d';root_directory(layout);path=layout+'/'+cfg['siteName'];paths=[path]
 if cfg['service']:root_directory('/etc/systemd/system');paths.append('/etc/systemd/system/'+cfg['serviceName'])
 if any(os.path.lexists(p) for p in paths):no('CONFIG_EXISTS','A generated configuration already exists. Use the hosting/configuration editor and reviewed backups instead of overwriting it.')
 if s['kind'] in ['static','react']:
  output=d+('/'+s['output'] if s.get('output') else '')
  if os.path.realpath(output)!=output or not os.path.isfile(output+'/index.html'):no('OUTPUT_MISSING','Build output/index.html must exist without links before hosting is enabled.')
 elif not os.path.isfile(d+'/'+('.venv/bin/python' if s['kind']=='django' else s.get('entry','server.js'))):no('ENTRY_MISSING','The configured application executable/entry is missing.')
 for p,data in [(path,cfg['nginx'])]+([('/etc/systemd/system/'+cfg['serviceName'],cfg['service'])] if cfg['service'] else []):atomic(p,data.encode(),0o644,0,0)
 link=None;createdLink=False
 try:
  if layout.endswith('sites-available'):
   root_directory('/etc/nginx/sites-enabled');link='/etc/nginx/sites-enabled/'+cfg['siteName']
   if os.path.lexists(link):no('CONFIG_EXISTS','An enabled site with this name already exists.')
   os.symlink(path,link);createdLink=True
  r=execute(['/usr/sbin/nginx','-t'])
  if r.returncode:no('NGINX_INVALID','Nginx validation failed; the new configuration was removed and no reload occurred.')
 except Exception:
  if createdLink and link and os.path.islink(link):os.unlink(link)
  for p in paths:
   if os.path.isfile(p):os.unlink(p)
  raise
 # Nginx is validated before any reload. Project service startup is a separate reviewed action.
 r=execute(['/usr/bin/systemctl','reload','nginx'])
 if r.returncode:no('RELOAD_FAILED','Nginx validated but reload failed. Generated files remain for inspection; no success is claimed.')
 if cfg['service']:
  r=execute(['/usr/bin/systemctl','daemon-reload'])
  if r.returncode:no('SERVICE_RELOAD_FAILED','Hosting files exist but systemd reload failed. Inspect them before starting the service.')
 return {'message':'Hosting files created and Nginx validated/reloaded. Application services were not started; configure the environment, then review deployment or startup.','configs':cfg}
def nginx_backup(q,u,path,data):
 folder=store(q,u);i=str(uuid.uuid4());atomic(folder+'/'+i+'.nginx',data,0o600,0,0);atomic(folder+'/'+i+'.nginx.json',json.dumps({'id':i,'time':time.time(),'file':path,'hash':sha(data)}).encode(),0o600,0,0);return i
def nginx_versions(q,u):
 account(q,True);identity(q);folder=store(q,u);versions=[]
 for name in os.listdir(folder)[:1000]:
  if not re.fullmatch(r'[0-9a-f-]{36}\.nginx.json',name):continue
  try:
   m=json.loads(read(folder+'/'+name));payload=read(folder+'/'+m['id']+'.nginx');path=m['file'];expected='rootpath-'+os.path.basename(q['directory'])+'.conf'
   if os.path.basename(path)!=expected or os.path.dirname(path) not in ['/etc/nginx/sites-available','/etc/nginx/conf.d'] or sha(payload)!=m['hash']:continue
   root_directory(os.path.dirname(path));current=read(path);versions.append({**m,'currentRevision':sha(current)})
  except (OSError,ValueError,KeyError,Refused):continue
 return {'versions':sorted(versions,key=lambda x:x['time'],reverse=True)}
def nginx_restore(q,u):
 account(q,True);version=next((x for x in nginx_versions(q,u)['versions'] if x['id']==q.get('backup')),None)
 if not version or version['currentRevision']!=q.get('revision'):no('CONFIG_CHANGED','Reload protected hosting versions; this configuration or backup changed.')
 path=version['file'];current=read(path);folder=store(q,u);data=read(folder+'/'+version['id']+'.nginx');backup=nginx_backup(q,u,path,current);atomic(path,data,0o644,0,0)
 try:
  if execute(['/usr/sbin/nginx','-t']).returncode:no('NGINX_INVALID','The restored configuration failed validation. The current file was preserved; no reload occurred.')
 except Exception:atomic(path,current,0o644,0,0);raise
 if execute(['/usr/bin/systemctl','reload','nginx']).returncode:no('RELOAD_FAILED','The configuration restored and validated but Nginx reload failed. Inspect current status before retrying.')
 return {'message':'Protected hosting version restored, validated and reloaded. The previously current version was saved first. Certificate files were not deleted.','backup':backup}
def https_issue(q,u):
 account(q,True);d=identity(q);s=site_validate(q['site']);cfg=templates(s,u.pw_name)
 if d!='/var/www/'+s['name']:no('INVALID_SITE','The generated site must match this directory.')
 email=q.get('email','')
 if not re.fullmatch(r'[A-Za-z0-9_.+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}',email):no('INVALID_EMAIL','Enter a certificate contact email.')
 tool=shutil.which('certbot')
 if not tool:no('CERTBOT_REQUIRED','Install the reviewed Certbot Nginx plugin dependency first.')
 target={x[4][0] for x in socket.getaddrinfo(q['serverHost'],None)}
 for domain in s['domains']:
  addresses={x[4][0] for x in socket.getaddrinfo(domain,None)}
  if not addresses or not addresses.issubset(target):no('DNS_REQUIRED','Every A/AAAA address must resolve to this VPS before certificate issuance.')
 path=('/etc/nginx/sites-available/' if os.path.isdir('/etc/nginx/sites-available') else '/etc/nginx/conf.d/')+cfg['siteName'];data=read(path)
 if data!=cfg['nginx'].encode():no('CONFIG_CHANGED','The site configuration changed. Inspect HTTPS through the existing hosting controls instead.')
 if execute(['/usr/sbin/nginx','-t']).returncode:no('NGINX_INVALID','Nginx must validate before certificate issuance.')
 # Preserve the exact prior configuration outside the served tree before Certbot edits it.
 i=nginx_backup(q,u,path,data)
 r=execute([tool,'--nginx','--non-interactive','--agree-tos','--redirect','--email',email,*sum((['-d',x] for x in s['domains']),[])],180)
 if r.returncode:no('CERTIFICATE_FAILED','Certificate issuance failed. Inspect Nginx and certificate status; the previous configuration is protected in the configuration backup directory.')
 if execute(['/usr/sbin/nginx','-t']).returncode:no('NGINX_INVALID','Certificate action returned but Nginx validation failed. Inspect the protected previous configuration before recovery.')
 return {'message':'Certificate issuance completed and Nginx validated. Verify public HTTPS before marking production acceptance.','backup':i}
def unit_info(name):
 if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.@-]{0,199}\.(?:service|timer)',name):no('INVALID_UNIT','Choose a discovered systemd unit.')
 r=execute(['/usr/bin/systemctl','show','--property=Id,User,WorkingDirectory,ActiveState,UnitFileState,NextElapseUSecRealtime,LastTriggerUSec,Triggers,FragmentPath,DropInPaths,Result,ExecMainStatus','--',name])
 if r.returncode:no('UNIT_UNAVAILABLE','The selected unit is unavailable.')
 values=dict(line.split('=',1) for line in r.stdout.decode('utf-8','replace').splitlines() if '=' in line)
 return values
def unit_revision(info):
 files=[]
 for path in [info.get('FragmentPath','')]+info.get('DropInPaths','').split():
  if not path:continue
  data=read(path);s=os.lstat(path)
  if s.st_uid!=0 or s.st_mode&0o022:no('UNSAFE_UNIT','Unit files must be protected and root-owned.')
  text=data.decode('utf-8').replace(chr(92)+chr(10),' ')
  if re.search(r'^\s*Exec\w+\s*=\s*[^/\n]*[+!]',text,re.M) or re.search(r'^\s*PermissionsStartOnly\s*=\s*(?:yes|true|1)',text,re.M):no('UNSAFE_UNIT','Elevated execution prefixes require a separate administrative review.')
  files.append([path,sha(data)])
 if not files:no('UNIT_UNAVAILABLE','No protected unit configuration was found.')
 return sha(json.dumps([info.get('Id'),info.get('User'),info.get('WorkingDirectory'),info.get('Triggers'),files],sort_keys=True).encode())
def timers(q,u):
 d=identity(q)
 if not os.path.isdir('/run/systemd/system'):return {'timers':[],'warning':'A running systemd manager is required.'}
 r=execute(['/usr/bin/systemctl','list-units','--all','--type=timer','--no-legend','--plain'])
 if r.returncode:no('TIMERS_UNAVAILABLE','Timer discovery is unavailable.')
 rows=[]
 for line in r.stdout.decode('utf-8','replace').splitlines()[:500]:
  parts=line.split()
  if not parts:continue
  name=parts[0]
  if not name.endswith('.timer'):continue
  try:
   timer=unit_info(name);targets=timer.get('Triggers','').split();service=next((x for x in targets if x.endswith('.service')),None)
   if not service:continue
   info=unit_info(service)
   if info.get('WorkingDirectory')!=d and service not in q.get('services',[]):continue
   revision=sha((unit_revision(timer)+unit_revision(info)).encode());safe=info.get('User')==u.pw_name and info.get('WorkingDirectory')==d
   rows.append({'name':name,'service':service,'active':timer.get('ActiveState'),'enabled':timer.get('UnitFileState'),'next':timer.get('NextElapseUSecRealtime'),'last':timer.get('LastTriggerUSec'),'revision':revision,'manageable':safe})
  except (OSError,Refused):continue
  if len(rows)>=64:break
 return {'timers':rows,'warning':''}
def timer_action(q,u):
 account(q,True);current=next((x for x in timers(q,u)['timers'] if x['name']==q.get('unit')),None)
 if not current or current['revision']!=q.get('revision') or not current['manageable']:no('TIMER_CHANGED','The reviewed timer/service mapping changed or does not run as this project account.')
 op=q['operation'];args=['enable','--now',current['name']] if op=='timerEnable' else ['disable','--now',current['name']] if op=='timerDisable' else ['start',current['service']]
 r=execute(['/usr/bin/systemctl',*args],30)
 if r.returncode:no('TIMER_ACTION_FAILED','The timer action failed. Inspect its service logs before retrying.')
 info=unit_info(current['service'] if op=='timerRun' else current['name'])
 if op=='timerRun' and (info.get('Result') not in ['success',''] or info.get('ExecMainStatus') not in ['0','']):no('SERVICE_FAILED','The triggered service reported failure; inspect Logs.')
 return {'message':'Reviewed timer action completed.','status':info.get('ActiveState'),'service':current['service']}
def log_snapshot(q,u):
 identity(q);source=q.get('source');target=q.get('target','')
 if source in ['service','journal']:
  allowed=set(q.get('services',[]));allowed.update(x['name'] for x in timers(q,u)['timers']);allowed.update(x['service'] for x in timers(q,u)['timers'])
  if target not in allowed:no('LOG_MAPPING_REQUIRED','Select a project-linked service or timer.')
  r=execute(['/usr/bin/journalctl','--no-pager','--output=short-iso','-n','200','--unit',target])
 elif source=='nginx':
  # Only logs actually referenced in the imported project's Nginx files are eligible.
  allowed=set()
  for config in q.get('nginx',[]):
   if not (config.startswith('/etc/nginx/sites-available/') or config.startswith('/etc/nginx/conf.d/')):continue
   try:
    text=read(config).decode('utf-8')
    for path in re.findall(r'\b(?:access_log|error_log)\s+(/var/log/nginx/[^;\s]+)',text):
     if os.path.realpath(path)==path:allowed.add(path)
   except (OSError,Refused):continue
  if target not in allowed:no('LOG_MAPPING_REQUIRED','Only exact log files referenced by this project configuration are eligible.')
  s=os.lstat(target)
  if not stat.S_ISREG(s.st_mode):no('UNSUPPORTED_LOG','Choose a regular mapped log file.')
  with open(target,'rb') as f:f.seek(max(0,s.st_size-65536));data=f.read(65536)
  return {'text':data.decode('utf-8','replace'),'message':'Recent project log snapshot collected; live collection remains connection-bound.'}
 else:no('INVALID_LOG','Choose a supported log source.')
 if r.returncode:no('LOG_PERMISSION','Journal access was denied or unavailable. Use the graphical elevated log review if authorized.')
 return {'text':r.stdout.decode('utf-8','replace')[-65536:],'message':'Recent project journal snapshot collected.'}
def admin_lock():
 parent='/var/lib/rootpath'
 try:os.mkdir(parent,0o711)
 except FileExistsError:pass
 root_directory(parent);path=parent+'/configuration.lock';fd=os.open(path,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600);st=os.fstat(fd)
 if not stat.S_ISREG(st.st_mode) or st.st_uid!=0 or st.st_mode&0o077:os.close(fd);no('UNSAFE_LOCK','The administrative coordination lock is unsafe.')
 try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
 except BlockingIOError:os.close(fd);no('CONFIG_BUSY','Another Rootpath configuration action is active. Inspect its status before retrying.')
 return fd
def main(q):
 op=q.get('operation');u=account(q,op in ['envSave','envRestore','siteConfigure','timerEnable','timerDisable','timerRun','httpsIssue','siteVersions','siteRestore'])
 if op in ['gitTrustInspect','gitTrustSave']:return git_trust(q,u,op=='gitTrustSave')
 if op=='sitePreview':return site_preview(q,u)
 if op=='siteConfigs':
  identity(q);site=site_validate(q['site'])
  if q['directory']!='/var/www/'+site['name']:no('INVALID_SITE','The site name must match this directory.')
  return templates(site,u.pw_name)
 if op=='envInspect':return env_inspect(q,u)
 if op in ['envSave','envRestore']:return save_env(q,u)
 if op=='siteConfigure':return configure_site(q,u)
 if op=='siteVersions':return nginx_versions(q,u)
 if op=='siteRestore':return nginx_restore(q,u)
 if op=='httpsIssue':return https_issue(q,u)
 if op=='timers':return timers(q,u)
 if op in ['timerEnable','timerDisable','timerRun']:return timer_action(q,u)
 if op=='logs':return log_snapshot(q,u)
 no('INVALID_OPERATION','Unsupported project workflow.')
try:
 q=json.loads(sys.stdin.readline(1048577));lock=admin_lock() if os.geteuid()==0 and q.get('operation') in ['envInspect','envSave','envRestore','siteConfigure','httpsIssue','siteVersions','siteRestore','timerEnable','timerDisable','timerRun'] else None
 try:value=main(q)
 finally:
  if lock is not None:os.close(lock)
 print(json.dumps({'ok':True,'value':value}))
except Refused as e:print(json.dumps({'ok':False,'code':e.code,'message':str(e)}));sys.exit(1)
except PermissionError:print(json.dumps({'ok':False,'code':'PERMISSION_DENIED','message':'Permission denied. Use the reviewed graphical sudo action if this account is authorized.'}));sys.exit(1)
except Exception:print(json.dumps({'ok':False,'code':'WORKFLOW_FAILED','message':'The workflow stopped. Check the target, prerequisites and current state before retrying; no rollback is implied.'}));sys.exit(1)
